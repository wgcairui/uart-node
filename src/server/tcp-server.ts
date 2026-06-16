/**
 * TcpServer class（UartNode RFC 002 §3.5 + §6.5 PR #5）
 *
 * 把 src/TcpServer.ts（extends net.Server）重构为：
 *   - 不再 extends net.Server，自己 net.createServer() 包裹
 *   - sniffers / registerHandlers 数组化（未来 LanDtu 直接 push 一个新 sniffer）
 *   - listen() 返 Promise，restart() 返 Promise
 *   - Bus() 保留（main.ts 调用）
 *   - 全 env 驱动（PR #9 顺手：清掉 NODE_ENV DCE bug）
 *
 * 行为契约：跟老 src/TcpServer.ts 1:1 兼容
 *   - 首次连 / 重连 / 注册包错 / 拒连 路径完全保留
 *   - 重启时清 MacSocketMaps 所有 dtu 然后重新 listen
 *   - listen 默认 0.0.0.0:9000（dev fallback），conf.Port / LISTEN_PORT 优先
 *
 * 跟 uart-pesiv-node 不直接同构（pesiv 是单设备 UPS 卡，不需要 TCP server），
 * 但设计模式（class + factory + listen 返 Promise）一致。
 */

import net, { Server, Socket } from 'net'
import config from '../config'
import { queryObjectServer, instructQuery, DTUoprate, eventType, registerConfig } from 'uart'
import { getIOClient } from '../services/io-client'
import { Dtu } from '../dtus/base'
import {
  CellularSniffer,
  pushCellularRegisterInvite,
  type ProtocolSniffer,
  type RegisterHandler
} from './register-handler'

/**
 * 注册 4G DTU 邀请延迟（10s 没发注册包 → 推 AT 仪式）
 * 跟老 src/TcpServer.ts:71-81 setTimeout 10000 行为 1:1
 */
const REGISTER_INVITE_DELAY_MS = 10_000

/**
 * 监听端口解析（PR #9 顺手清掉的 NODE_ENV DCE bug 修复）：
 *   - LISTEN_PORT env 优先（部署期灵活覆盖）
 *   - conf.Port 次之（server 端 registerSuccess 下发）
 *   - config.localport (9000) 最后兜底（dev 默认）
 *
 * 老 src/TcpServer.ts:37,49 走 `process.env.NODE_ENV === 'production' ? conf.Port : config.localport`，
 * bun build --minify DCE 掉 prod 分支，NODE_ENV=production 容器永远走 9000 fallback，不会走 server 下发的 Port。
 */
function resolveListenPort(conf: registerConfig): number {
  const envPort = process.env.LISTEN_PORT
  if (envPort && !Number.isNaN(Number(envPort))) {
    return Number(envPort)
  }
  return conf.Port ?? config.localport
}

export class TcpServer {
  /** mac -> Dtu 映射（老 src/TcpServer.ts:16 MacSocketMaps 行为 1:1） */
  readonly macSocketMaps: Map<string, Dtu> = new Map()
  /** 注册配置 */
  private readonly conf: registerConfig
  /** net.Server 实例（构造时不 listen，由 listen() 触发） */
  private server: Server
  /** 协议嗅探器数组（老代码硬编码 4G，这里数组化未来 LanDtu push 一个） */
  private sniffers: ProtocolSniffer[] = [new CellularSniffer()]
  /** 注册处理器数组（跟 sniffers 一一对应） */
  private registerHandlers: RegisterHandler[]
  /** 当前 active 的 server 数量（getConnections 替代，老代码用 super.getConnections） */
  private activeConnectionCount = 0
  /** listen 是否已触发（防止重复 listen） */
  private listening = false

  constructor(conf: registerConfig) {
    this.conf = Object.assign({ Port: 9000, MaxConnections: 2000, IP: '0.0.0.0' }, conf)
    this.registerHandlers = this.sniffers.map(s => s.handler())
    this.server = net.createServer(socket => this.onConnection(socket))
    this.server.on('error', err => console.log('Server error: %s.', err))
    this.server.setMaxListeners(this.conf.MaxConnections || 2000)
  }

  /**
   * 启动监听（返 Promise，async/await 自然）
   * 行为跟老 src/TcpServer.ts:37-40 1:1，但用 conf.Port + LISTEN_PORT 全 env 驱动
   */
  listen(port?: number, host: string = '0.0.0.0'): Promise<{ port: number; host: string }> {
    const finalPort = port ?? resolveListenPort(this.conf)
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(finalPort, host, () => {
        this.listening = true
        const addr = this.server.address() as net.AddressInfo
        console.log(`### WebSocketServer listening: ${this.conf.IP}:${addr.port}`)
        resolve({ port: addr.port, host })
      })
    })
  }

  /**
   * 重启（IOClient.on('restart') 触发，server 端重启 TCP server 指令）
   * 行为跟老 src/TcpServer.ts:42-61 ioOnResult('restart') 1:1
   *
   * 关键不变量：
   *   1. close server
   *   2. destroy 所有 dtu（让它们走 socket.close → terminalOff）
   *   3. 清 MacSocketMaps
   *   4. 重新 listen
   */
  async restart(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close(err => {
        if (err) {
          console.log({ err })
        }
        console.log(`server已成功关闭,当前连接数:${this.macSocketMaps.size}`)
        // destroy 所有 dtu
        this.macSocketMaps.forEach(dtu => {
          dtu.socketsb?.destroy()
        })
        this.macSocketMaps.clear()
        // 重新 listen
        this.listen().then(() => resolve()).catch(reject)
      })
    })
  }

  /**
   * 给 server 下行指令（query / AT / operate）派发
   * 行为跟老 src/TcpServer.ts:145-151 Bus() 1:1
   */
  bus<T extends queryObjectServer | instructQuery | DTUoprate>(eventType: eventType, query: T): void {
    const dtu = this.macSocketMaps.get(query.DevMac)
    if (dtu && dtu.socketsb) {
      query.eventType = eventType
      dtu.saveCache(query)
    }
  }

  /**
   * 统计所有在线的终端
   * 行为跟老 src/TcpServer.ts:135-137 getOnlineDtu() 1:1
   */
  getOnlineDtu(): string[] {
    return [...this.macSocketMaps.values()]
      .filter(dtu => dtu.socketsb)
      .filter(dtu => dtu.getPropertys().connecting)
      .map(dtu => dtu.mac)
  }

  /**
   * 统计 TCP 连接数（返 Promise，main.ts / nodeInfo handler 用）
   * 老 src/TcpServer.ts:123-129 getConnectionsAsync() 行为 1:1
   */
  getConnectionsAsync(): Promise<number> {
    return new Promise<number>((resolve) => {
      this.server.getConnections((_err, nb) => {
        resolve(nb)
      })
    })
  }

  /** 关闭 server（main.ts 兜底 / process.on('SIGTERM')） */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close(err => err ? reject(err) : resolve())
    })
  }

  /** 当前是否在监听 */
  get isListening(): boolean {
    return this.listening
  }

  // ======================== 内部：新连接处理 ========================

  /**
   * 新 socket 连接处理
   * 跟老 src/TcpServer.ts:68-116 _Connection 行为 1:1
   *
   * 流程：
   *   1. 基本校验（socket / remoteAddress / writable）
   *   2. 启动 10s 推 AT 邀请定时器
   *   3. 配置 socket error handler
   *   4. 监听第一个 data 包：
   *      - 用 sniffers 嗅探协议
   *      - 命中 → 调对应 RegisterHandler.handle() 接管
   *      - 不命中 → destroy
   */
  private onConnection(socket: Socket): void {
    if (!socket || !socket.remoteAddress || !socket.writable) return
    this.activeConnectionCount++
    console.log(`${new Date().toLocaleString()}==新的socket连接,连接参数: ${socket.remoteAddress}:${socket.remotePort}`)

    // 10s 推 AT 仪式定时器
    const inviteTimer = setTimeout(() => {
      console.log(socket.remoteAddress, '无消息,尝试发送注册信息')
      pushCellularRegisterInvite(socket, this.conf)
    }, REGISTER_INVITE_DELAY_MS)

    socket.on('error', () => {
      socket?.destroy()
    })

    socket.once('data', (data: Buffer) => {
      clearTimeout(inviteTimer)
      // 嗅探协议
      const sniffer = this.sniffers.find(s => s.match(data))
      if (!sniffer) {
        // 没有任何 sniffer 命中 → destroy
        socket.destroy()
        return
      }
      // 命中 → 调 handler 接管（handler 内部决定 register / reConnect / 非法销毁）
      const handler = sniffer.handler()
      handler.handle(socket, data, this.macSocketMaps, this.conf)
    })

    socket.on('close', () => {
      this.activeConnectionCount--
    })
  }
}

// ======================== 默认导出（兼容老 main.ts） ========================

export default TcpServer
