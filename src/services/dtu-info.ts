/**
 * 节点运行时信息（CPU/内存/启动时间/hostname）
 * 替代 src/tool.ts NodeInfo() 静态方法
 *
 * 跟 uart-pesiv-node src/util/node-info.ts 同构——纯函数，无副作用
 */

import * as os from 'node:os'

export interface NodeInfo {
  hostname: string
  totalmem: string
  freemem: string
  loadavg: number[]
  type: string
  uptime: string
  version: string
}

export function nodeInfo(): NodeInfo {
  const hostname: string = os.hostname()
  const totalmem: number = os.totalmem() / 1024 / 1024 / 1024
  const freeRatio = os.freemem() / os.totalmem()
  const freememPct = (freeRatio * 100).toFixed(1) + '%'
  const loadavg: number[] = os.loadavg().map(el => parseFloat(el.toFixed(1)))
  const type: string = os.type()
  const uptime: number = os.uptime() / 60 / 60

  return {
    hostname,
    totalmem: totalmem.toFixed(1) + 'GB',
    freemem: freememPct,
    loadavg,
    type,
    uptime: uptime.toFixed(0) + 'h',
    version: os.version()
  }
}
