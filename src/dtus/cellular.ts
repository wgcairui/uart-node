/**
 * CellularDtu — 4G/2G/NB DTU 实现（UartNode RFC 002 §3.4 + §6.5 PR #4）
 *
 * 继承 Dtu 基类，实现 4G 专属逻辑：
 *   1. initialize() 批量查 8 条 AT (PID/VER/GVER/IOTEN/ICCID/LOCATE/UART/GSLQ) + 关 IOTEN
 *   2. restart() 走 AT+Z（基类 restart 行为由老 client.ts:272-281 移植）
 *   3. processQueue() 处理 OprateInstruct / ATInstruct 两种指令
 *
 * 行为契约：跟老 src/client.ts Client class **1:1 兼容**——
 * 重构后任何 staging 24h 行为差异都是 bug。
 *
 * 命名冲突注意：基类有 `atParse` 方法（默认 4G 行为），
 * 跟老 client.ts:449 `private ATParse(Query, res)` 行为一致，不重写。
 */

import { Dtu, type DtuQueryItem } from './base'
import { type queryObjectServer, type instructQuery, type DTUoprate, type socketResult } from 'uart'
import { EVENT_NODE_TERMINAL_ON } from '../protocol/events'

export class CellularDtu extends Dtu {
  /** 上报 server 的 terminalOn 兼容垫片（老 client.ts:76 用的顶层 IOClient.emit） */
  // 基类 constructor 已经调 IOClient.terminalOn 了，CellularDtu 不再额外发

  /**
   * 设备初始化（4G 批量查 AT）
   * 跟老 client.ts:127-147 run() 行为 1:1
   *
   * 关键不变量：
   *   - 先 setPause('getPropertys') 等 socket 空闲
   *   - 8 条 AT 顺序查：PID / VER / GVER / IOTEN / ICCID / LOCATE=1 / UART=1 / GSLQ
   *   - 最后发 IOTEN=off 关闭 iot 功能省流量
   *   - resume('getPropertys') 恢复
   *   - 返回 getPropertys() 给 fetch.dtuInfo 上报
   */
  public async initialize(): Promise<Record<string, unknown>> {
    await this.setPause('getPropertys')
    const { AT, msg } = await this.queryAT('PID')
    if (AT) {
      this.AT = AT
      this.PID = msg
      this.ver = (await this.queryAT('VER')).msg
      this.Gver = (await this.queryAT('GVER')).msg
      this.iotStat = (await this.queryAT('IOTEN')).msg
      this.ICCID = (await this.queryAT('ICCID')).msg
      this.jw = (await this.queryAT('LOCATE=1')).msg
      this.uart = (await this.queryAT('UART=1')).msg
      this.signal = (await this.queryAT('GSLQ')).msg
      // 关 IOTEN 省流量
      await this.queryAT('IOTEN=off')
    }
    this.resume('getPropertys')
    return this.getPropertys()
  }

  /**
   * 主动重启（4G: AT+Z）
   * 跟老 client.ts:272-282 resatrtSocket 行为 1:1
   *
   * 关键不变量：
   *   - 先 setPause 等 socket 空闲
   *   - 发 AT+Z，置 reboot=true
   *   - socket.once('connecting') 监听到后 destroy（实际不做事，老代码只是占位）
   *   - resume 恢复（实际 resume 也没用，socket 已 destroy）
   */
  public async restart(): Promise<void> {
    await this.setPause('restartSocket')
    const result = await this.queryAT('Z')
    this.reboot = true
    if (this.socketsb) {
      this.socketsb.getSocket()
        .once('connecting', (_stat: boolean) => {
          // 老代码占位，没实际逻辑
        })
        .destroy()
    }
    this.resume()
  }

  /**
   * 处理 OprateInstruct / ATInstruct 两种指令
   * 跟老 client.ts:312-347 ProcessingQueue 的 Oprate/AT 分支 1:1
   *
   * query 来自基类 processingQueue shift 出来的队首元素。
   */
  protected async processQueue(query: DtuQueryItem): Promise<void> {
    if (!query || !this.socketsb) return
    if (query.eventType === 'OprateInstruct') {
      const op = query as instructQuery
      const queryString = op.type === 485
        ? Buffer.from(op.content as string, 'hex')
        : Buffer.from(op.content as string + '\r', 'utf-8')
      const result = await this.socketsb.write(queryString)
      this.oprateParse(op, result)
    } else if (query.eventType === 'ATInstruct') {
      const at = query as DTUoprate
      const queryString = Buffer.from(at.content + '\r', 'utf-8')
      const result = await this.socketsb.write(queryString)
      this.atParse(at, result)
    }
  }

  /**
   * 4G AT 指令查询
   * 跟老 client.ts:195-208 QueryAT 行为 1:1
   *
   * 关键不变量：
   *   - 拼装 '+++AT+<content>\r' 写 socket
   *   - parseATResponse 解析响应
   *   - socket offline 返回 {AT: false, msg: 'socket offline'}
   */
  private async queryAT(content: string): Promise<{ AT: boolean; msg: string }> {
    const queryString = Buffer.from('+++AT+' + content + '\r', 'utf-8')
    if (this.socketsb) {
      const { buffer } = await this.socketsb.write(queryString)
      return parseATResponseLite(buffer)
    } else {
      return { AT: false, msg: 'socket offline' }
    }
  }
}

/**
 * parseATResponse 的简化版（CellularDtu.queryAT 用）
 * 跟老 client.ts 行为 1:1：只关心 AT: bool + msg: string
 * 不抛异常（输入无效时返回 invalid）
 */
function parseATResponseLite(buffer: any): { AT: boolean; msg: string } {
  if (!buffer) return { AT: false, msg: '' }
  const str = typeof buffer === 'string' ? buffer : buffer.toString('utf8').trim()
  if (/^\+err=/i.test(str)) {
    return { AT: false, msg: str.replace(/^\+err=/i, '').trim() }
  }
  if (/^\+ok=/i.test(str)) {
    return { AT: true, msg: str.replace(/^\+ok=/i, '').trim() }
  }
  return { AT: false, msg: str }
}
