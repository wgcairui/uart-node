/**
 * Register handler + Protocol sniffer（UartNode RFC 002 §3.5 + §3.6）
 *
 * 拆分 src/TcpServer.ts:68-116 _Connection 的注册包嗅探 + 解析逻辑：
 *   - ProtocolSniffer: 嗅探协议类型（4G / 未来 LAN）
 *   - RegisterHandler: 接管连接，构建设备实例
 *
 * 行为契约：跟老 src/TcpServer.ts _Connection 1:1 兼容
 *   - 10s 推 AT 仪式（如果 DTU 10s 内不发注册包）
 *   - URLSearchParams 解析 'register&mac=...' & 'mac=...'
 *   - IMEI 取后 12 位作为 mac 主键（v4 改 15 位前保持）
 *   - 已有 Dtu 走 reConnectSocket；新建 CellularDtu
 *   - 非法连接：socket.end('please register DTU IMEI') + destroy
 *
 * 设计要点：
 *   - sniffers / handlers 数组化（PR #5 落地，未来 LanDtu 直接 push 一个新 sniffer）
 *   - CellularDtu / Dtu 来自 src/dtus/（PR #4 已 commit）
 *   - IOClient 走 getIOClient()（跟 PR #4 dtus/base.ts 一致）
 *
 * 不在 register-handler 范围：
 *   - 真正的指令派发（query / AT / operate）—— TcpServer.Bus() 走
 *   - 长连接 keepalive / timeout —— CellularDtu 内部管（socket.ts）
 */

import { Socket } from 'net'
import { URLSearchParams } from 'url'
import { CellularDtu } from '../dtus/cellular'
import { Dtu } from '../dtus/base'
import { getIOClient } from '../services/io-client'

// ======================== 接口 ========================

/**
 * 协议嗅探器（第一个包决定协议类型）
 * 老 src/TcpServer.ts:90-115 行为 1:1
 */
export interface ProtocolSniffer {
  /** 嗅探第一个包，返回 true 表示这个 sniffer 能处理 */
  match(firstPacket: Buffer): boolean
  /** 返回对应的 RegisterHandler 实例 */
  handler(): RegisterHandler
}

/**
 * 注册处理器（接管 socket + 创建设备实例）
 * 老 src/TcpServer.ts:68-116 行为 1:1
 */
export interface RegisterHandler {
  /**
   * 处理注册包，构建设备实例
   * @param socket DTU 连接
   * @param firstPacket 嗅探阶段收到的第一个包
   * @param macMap 已有的 mac -> Dtu 映射
   * @param config TcpServer 注册配置（UserID 等）
   */
  handle(socket: Socket, firstPacket: Buffer, macMap: Map<string, Dtu>, config: { UserID?: string }): void
}

// ======================== 4G DTU 实现 ========================

/**
 * 4G DTU 注册处理器
 * 跟老 src/TcpServer.ts:68-116 _Connection 行为 1:1
 *
 * 关键不变量：
 *   - 注册包解析：URLSearchParams，has('register') && has('mac')
 *   - IMEI slice(-12)：mac 主键（v4 改 15 位前保持向后兼容）
 *   - 已有 mac → reConnectSocket；没有 → new CellularDtu + MacSocketMaps.set
 *   - 非法连接 → socket.end('please register DTU IMEI') + destroy
 *   - 4G DTU 首次连接 → 10s 没发注册包 → 推 AT 仪式（+++AT+NREGEN + NREGDT + IOTUID）
 */
export class CellularRegisterHandler implements RegisterHandler {
  handle(socket: Socket, firstPacket: Buffer, macMap: Map<string, Dtu>, config: { UserID?: string }): void {
    const registerArguments = new URLSearchParams(firstPacket.toString())
    if (registerArguments.has('register') && registerArguments.has('mac')) {
      const IMEI = registerArguments.get('mac')!
      const maclen = IMEI.length
      const mac = IMEI.slice(maclen - 12, maclen)
      const existing = macMap.get(mac)
      if (existing) {
        // 已有设备 → 走基类 reConnectSocket
        existing.reConnectSocket(socket)
      } else {
        // 新设备 → 创建 CellularDtu
        const dtu = new CellularDtu(socket, mac, getIOClient())
        macMap.set(mac, dtu)
        console.log(`${new Date().toLocaleString()} ## ${mac}  上线,连接参数: ${socket.remoteAddress}:${socket.remotePort},Tcp Server连接数: ${macMap.size}`)
      }
    } else {
      // 非法连接 → end + destroy
      socket.end('please register DTU IMEI', () => {
        console.log(`###${socket.remoteAddress}:${socket.remotePort} 配置错误或非法连接,销毁连接,[${firstPacket.toString().slice(0, 10)}]`)
        socket.destroy()
      })
    }
  }
}

/**
 * 4G DTU 协议嗅探器
 * 老 src/TcpServer.ts:90-94 行为 1:1
 *
 * 嗅探规则：第一个包以 'register&' 开头
 * （老 TcpServer 用 URLSearchParams.has('register') + has('mac') 双判，
 *  这里只嗅探前缀 sniffer match，handler 内部再做 has('register') 校验，
 *  保留老代码的宽容行为）
 */
export class CellularSniffer implements ProtocolSniffer {
  match(firstPacket: Buffer): boolean {
    // 'register&' 是 9 字节 ASCII
    const head = firstPacket.toString('utf8', 0, 9)
    return head.startsWith('register&')
  }
  handler(): RegisterHandler {
    return new CellularRegisterHandler()
  }
}

/**
 * 推 4G AT 仪式（10s 内没发注册包时）
 * 老 src/TcpServer.ts:71-81 行为 1:1
 *
 * 推 3 条 AT 指令让 DTU 主动发注册包：
 *   - +++AT+NREGEN=A,on
 *   - +++AT+NREGDT=A,register&mac=%MAC&host=%HOST
 *   - +++AT+IOTUID=<UserID>（如果 conf 有）
 */
export function pushCellularRegisterInvite(socket: Socket, config: { UserID?: string }): void {
  if (socket && !socket.destroyed && socket.writable) {
    socket.write(Buffer.from('+++AT+NREGEN=A,on\r', 'utf-8'))
    socket.write(Buffer.from('+++AT+NREGDT=A,register&mac=%MAC&host=%HOST\r', 'utf-8'))
    if (config.UserID) {
      socket.write(Buffer.from(`+++AT+IOTUID=${config.UserID}\r`, 'utf-8'))
    }
  }
}
