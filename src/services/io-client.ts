/**
 * Socket.IO 客户端（替代 src/IO.ts 顶层副作用单例）
 *
 * 跟 uart-pesiv-node src/services/io-client.ts 同构——同样的 class + factory + lifecycle 模式。
 *
 * 设计要点：
 *   - class 封装：可注入（setIOClient(mock)），可测
 *   - 单例：getIOClient() 拿默认实例
 *   - lifecycle：bindLifecycle() 集中管理 connect/disconnect/error
 *   - 业务方法：terminalOn(mac, reline) / terminalOff(mac) / ackResult(events, result) 等
 *     避免业务代码直接 IOClient.emit('terminalOn', mac, false)（魔法字符串）
 *
 * PR #20 鉴权三通道（保持稳定）：
 *   - auth.token（推荐，websocket 握手）
 *   - query.token（备选，?token=）
 *   - x-node-token header（extraHeaders + transportOptions）
 *
 * 跟 src/IO.ts 行为**完全一致**（事件名、payload、reconnect 行为）—— PR #1 纯重写
 */

import { io as ioClient, type Socket } from 'socket.io-client'
import { IO_CONFIG, NODE_TOKEN } from '../config'
import {
  EVENT_NODE_TERMINAL_ON,
  EVENT_NODE_TERMINAL_OFF,
  EVENT_NODE_TERMINAL_MOUNT_DEV_TIMEOUT,
  EVENT_NODE_INSTRUCT_TIMEOUT,
  EVENT_NODE_REGISTER,
  EVENT_SERVER_REGISTER_SUCCESS,
  EVENT_SERVER_READY,
  type EventName,
  type NodeEventName,
  type ServerEventName,
  type DtuStateEvent,
  type DtuHealthEvent,
  type DtuAlertEvent
} from '../protocol/events'

export interface IOClientOptions {
  uri: string
  path?: string
  name?: string  // 节点名（UartNode: 暂未用，保留扩展）
}

export class IOClient {
  private socket: Socket
  private connected = false

  constructor(opts: IOClientOptions) {
    this.socket = ioClient(opts.uri, {
      path: opts.path ?? IO_CONFIG.path,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
      timeout: 10_000,
      transports: ['websocket', 'polling'],
      // PR #20 鉴权三通道
      auth: NODE_TOKEN ? { token: NODE_TOKEN } : undefined,
      query: NODE_TOKEN ? { token: NODE_TOKEN } : undefined,
      extraHeaders: NODE_TOKEN ? { 'x-node-token': NODE_TOKEN } : undefined,
      transportOptions: {
        polling: { extraHeaders: { 'x-node-token': NODE_TOKEN } },
        websocket: { extraHeaders: { 'x-node-token': NODE_TOKEN } }
      }
    })
    this.bindLifecycle()
  }

  /**
   * 绑定 lifecycle handlers（connect / disconnect / connect_error / reconnect 等）
   * —— 集中管理，不在 constructor 里散开
   */
  private bindLifecycle() {
    this.socket.on('connect', () => {
      this.connected = true
      // token 是否带上去了一目了然，方便对账 server 端 nodeTokenHash
      const opts = this.socket.io.opts as { auth?: { token?: string }; query?: { token?: string } }
      const hasToken = Boolean(opts.auth?.token) || Boolean(opts.query?.token)
      console.log(`[io] connected: id=${this.socket.id} token=${hasToken ? 'present' : 'MISSING'}`)
    })
    this.socket.on('disconnect', reason => {
      this.connected = false
      // 'io server disconnect' / 'io client disconnect' / 'ping timeout' / 'transport close' / 'transport error'
      console.log(`[io] disconnected: ${reason}`)
    })
    this.socket.on('connect_error', err => {
      // err.data 是 server 端 ack 里 reject 时带回来的原因（如果 server 用了 callback）
      // err.message 是 socket.io-client 包装的描述
      const detail = (err as Error & { data?: unknown }).data
      console.log(`connect_error: ${err.message}${detail !== undefined ? ` (data=${JSON.stringify(detail)})` : ''}`)
    })
    this.socket.on('reconnect', n => console.log({ 'reconnect': n }))
    this.socket.on('reconnect_error', err => console.log('reconnect_error:', err.message))
    this.socket.on('reconnect_failed', () => console.log('reconnect_failed'))
    this.socket.on('connect_timeout', (timeout: number) => console.log({ 'connect_timeout': timeout }))
    this.socket.on('reconnecting', (attemptNumber: number) => console.log({ 'reconnecting': attemptNumber }))
    this.socket.on('error', (error: Error) => { console.log('error:', error.message) })
  }

  // ======================== 状态查询 ========================

  get isConnected(): boolean {
    return this.connected
  }

  get raw(): Socket {
    return this.socket
  }

  // ======================== 通用事件 API ========================

  /**
   * 订阅 server -> node 事件
   * @param event 事件名（类型化为 EventName，编译器提示）
   * @param handler 处理函数
   */
  on<T = unknown>(event: EventName, handler: (payload: T) => void): void {
    this.socket.on(event, handler as (...args: unknown[]) => void)
  }

  /**
   * 订阅 server -> node 事件（带 ack 回调）
   * @param event 事件名
   * @param handler 处理函数 + ack 回包
   */
  onAck<T = unknown, R = unknown>(
    event: EventName,
    handler: (payload: T, ack: (resp: R) => void) => void
  ): void {
    this.socket.on(event, ((payload: T, ack?: (resp: R) => void) => {
      handler(payload, ack ?? (() => {}))
    }) as (...args: unknown[]) => void)
  }

  /**
   * node -> server 事件发送（通用）
   * @param event 事件名
   * @param args 参数列表
   */
  emit(event: NodeEventName, ...args: unknown[]): void {
    this.socket.emit(event, ...args)
  }

  /**
   * 关掉底层连接（main 兜底用，PR #2 之后改用 lifecycle manager）
   */
  close(): void {
    this.socket.removeAllListeners()
    this.socket.close()
  }

  // ======================== 业务方法（避免业务代码用魔法字符串）========================

  /**
   * 设备上线（重连后必须重发，reline=true）
   *
   * @param mac 设备 MAC（v4 改 15 位 IMEI 主键；v3.3.0 用 IMEI 后 12 位）
   * @param reline 是否重连（reline=true 时 server 端做 latest-wins 覆盖）
   */
  terminalOn(mac: string, reline = false): void {
    this.socket.emit(EVENT_NODE_TERMINAL_ON, mac, reline)
  }

  /**
   * 设备下线
   */
  terminalOff(mac: string, force = false): void {
    this.socket.emit(EVENT_NODE_TERMINAL_OFF, mac, force)
  }

  /**
   * 设备挂载节点查询超时
   */
  terminalMountDevTimeOut(mac: string, pid: number, num: number): void {
    this.socket.emit(EVENT_NODE_TERMINAL_MOUNT_DEV_TIMEOUT, mac, pid, num)
  }

  /**
   * 设备指令超时
   */
  instructTimeOut(mac: string, pid: number, contents: string[]): void {
    this.socket.emit(EVENT_NODE_INSTRUCT_TIMEOUT, mac, pid, contents)
  }

  /**
   * 节点注册（main.ts:17 触发，payload = NodeInfo）
   */
  register(payload: unknown): void {
    this.socket.emit(EVENT_NODE_REGISTER, payload)
  }

  /**
   * 节点就绪（main.ts:69 setTimeout 10s 后触发，server 端告诉设备已就绪）
   */
  ready(): void {
    this.socket.emit(EVENT_SERVER_READY)
  }

  /**
   * 告警事件（v4 新增，cairui 拍板 4 个 type）
   */
  dtuAlert(event: DtuAlertEvent): void {
    this.socket.emit('dtuAlert', event)
  }

  /**
   * 状态转换事件（v4 新增，cairui 拍板 latest-wins 覆盖）
   */
  dtuState(event: DtuStateEvent): void {
    this.socket.emit('dtuState', event)
  }

  /**
   * 健康度上报（v4 新增，每 60s 一次）
   */
  dtuHealth(event: DtuHealthEvent): void {
    this.socket.emit('dtuHealth', event)
  }

  /**
   * ack 回包（用在 server -> node 事件的 handler 里）
   * —— src/IO.ts:63 ioOnResult 模式
   */
  ackResult(events: string, result: unknown): void {
    this.socket.emit(events, result)
  }
}

// ======================== 单例（main.ts 里 getIOClient() 直接拿）========================

let _instance: IOClient | null = null

export function getIOClient(): IOClient {
  if (!_instance) {
    _instance = new IOClient({ uri: IO_CONFIG.uri, path: IO_CONFIG.path })
  }
  return _instance
}

export function setIOClient(client: IOClient): void {
  _instance = client
}
