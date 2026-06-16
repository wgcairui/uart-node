/**
 * CellularDtu factory + 旧 Client 兼容 shim
 *
 * 跟 uart-pesiv-node 同类做法——PR #4 拆出 CellularDtu，
 * 但保留 src/client.ts 旧入口给 TcpServer 过渡用（PR #5 改 TcpServer 时一起删）。
 *
 * 不要新代码用这个 shim——直接 import { CellularDtu } from './dtus/cellular'
 */

import { Socket } from 'net'
import { URLSearchParams } from 'url'
import { CellularDtu } from './dtus/cellular'

export { CellularDtu } from './dtus/cellular'
export { Dtu, type DtuQueryItem } from './dtus/base'

/**
 * 旧 Client class 兼容垫片
 *
 * 老 src/client.ts 行为 1:1 移植到 CellularDtu。
 * 保留 Client 类名 + ProxyClient 给 TcpServer 过渡用——
 * 内部委托给 CellularDtu，外部 API 表面不变。
 *
 * @deprecated 直接 import CellularDtu
 */
export default class Client {
  readonly mac: string
  readonly dtus: CellularDtu
  // 老 client.ts:40 Cache 字段保留（外部可能访问，虽然 AGENTS.md 说不要用）
  private Cache: any[] = []
  // 老 client.ts:44 socketsb 字段
  socketsb: any
  // 主动重启状态（老 client.ts:36 reboot）
  private reboot = false

  constructor(socket: Socket, mac: string, _registerArguments: URLSearchParams) {
    this.mac = mac
    this.dtus = new CellularDtu(socket, mac)
    this.socketsb = this.dtus.socketsb
  }

  // ======================== 老 Client API 兼容（委托给 CellularDtu）========================

  /** 旧 reConnectSocket 行为 1:1（@deprecated） */
  public async reConnectSocket(socket: Socket): Promise<void> {
    this.dtus.reConnectSocket(socket)
    this.socketsb = this.dtus.socketsb
  }

  /** 旧 getPropertys 行为 1:1（@deprecated） */
  public getPropertys(): Record<string, unknown> {
    return this.dtus.getPropertys()
  }

  /** 旧 saveCache 行为 1:1（@deprecated） */
  public saveCache(query: any): void {
    this.dtus.saveCache(query)
  }
}

/**
 * 旧 ProxyClient 兼容垫片
 *
 * 老 client.ts:472 ProxyClient 是个 ProxyHandler，对 set 做代理。
 * 实际行为只放行（return Reflect.set），等于不过滤。
 *
 * @deprecated PR #5 改 TcpServer 时一起删
 */
export const ProxyClient: ProxyHandler<Client> = {
  set(target, p, value) {
    return Reflect.set(target, p, value)
  }
}
