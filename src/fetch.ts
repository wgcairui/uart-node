/**
 * 上传网关（替代 axios，调用方用 fetch.dtuInfo / nodeInfo / queryData）
 *
 * 内部**调用 src/services/uploader.ts**（队列 + 背压 + 重试），不再是"打一次 log 一次"。
 *
 * 行为兼容性：
 *   - 3 个方法 (dtuInfo / nodeInfo / queryData) **API 表面 1:1 保持**
 *   - 返回 undefined（跟旧 fetch 行为一致：旧 fetch 也返回 undefined，调用方从不 check status）
 *   - 调用方在 main.ts / client.ts 里用法不变
 *
 * 行为改善（PR #2 新增）：
 *   - HTTP 失败重试 2 次（指数退避 + jitter）
 *   - 并发 4，队列上限 1000（满了 drop oldest）
 *   - 失败不再 console.log（console.error 在 uploader 里）
 *   - 优雅关闭时 drainQueue（main.ts 兜底，PR #2 不接 main.ts 改 — 等 PR #5 TcpServer 重构时一起动）
 *
 * 兼容 v3.3.0 老代码：
 *   - types/uart.d.ts 里没有 Uart namespace alias（注释保留历史）
 *   - queryOkUp / nodeInfo / DTUoprate / instructQuery 类型从 "uart" 引入
 *   - dtuInfo 上报字段 DevMac = mac（老代码就是这样）
 */

import { type queryOkUp, type nodeInfo } from 'uart'
import * as uploader from './services/uploader'

// 兼容旧代码 namespace Uart.Terminal 写法（types-uart 包里是 namespace）
// 项目自带的 types/uart.d.ts 没有 Uart namespace alias，
// 直接用 interface 写法更稳。
interface Terminal {
  mac: string
  ip: string
  port: number
  [key: string]: unknown
}

class Fetch {

  /**
   * 上传 dtu 信息（老 fetch.dtuInfo 行为 1:1 保持）
   * @param info dtu 设备信息
   */
  dtuInfo(info: Partial<Terminal & { mac: string }>): boolean {
    info.DevMac = info.mac
    return uploader.enqueue('dtuinfo', { info })
  }

  /**
   * 上传节点运行状态
   * @param name 节点名（server 端用来识别 node）
   * @param node 节点运行时信息
   * @param tcp TCP 连接数
   */
  nodeInfo(name: string, node: nodeInfo, tcp: number): boolean {
    return uploader.enqueue('nodeInfo', { name, node, tcp })
  }

  /**
   * 上传查询数据
   * @param data 查询结果
   */
  queryData(data: queryOkUp): boolean {
    return uploader.enqueue('queryData', { data })
  }
}

export default new Fetch()
