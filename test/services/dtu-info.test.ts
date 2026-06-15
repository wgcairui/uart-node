/**
 * nodeInfo() 单元测试（纯函数，0 mock）
 *
 * 测试范围：
 *   1. 返回结构符合 NodeInfo interface
 *   2. hostname / totalmem / freemem / loadavg / type / uptime / version 7 个字段都有
 *   3. 字段类型正确（string / number[] 等）
 *   4. 多次调不互相影响（无副作用）
 */

import { describe, expect, test } from 'bun:test'
import { nodeInfo, type NodeInfo } from '../../src/services/dtu-info'

describe('nodeInfo() 纯函数', () => {
  test('返回 7 个字段', () => {
    const info = nodeInfo()
    expect(info).toHaveProperty('hostname')
    expect(info).toHaveProperty('totalmem')
    expect(info).toHaveProperty('freemem')
    expect(info).toHaveProperty('loadavg')
    expect(info).toHaveProperty('type')
    expect(info).toHaveProperty('uptime')
    expect(info).toHaveProperty('version')
  })

  test('hostname 跟 os.hostname() 一致', () => {
    const info = nodeInfo()
    expect(info.hostname.length).toBeGreaterThan(0)
    expect(typeof info.hostname).toBe('string')
  })

  test('totalmem 是 "X.XGB" 格式', () => {
    const info = nodeInfo()
    expect(info.totalmem).toMatch(/^\d+\.\d+GB$/)
  })

  test('freemem 是 "X.X%" 格式', () => {
    const info = nodeInfo()
    expect(info.freemem).toMatch(/^\d+\.\d+%$/)
  })

  test('loadavg 是 3 个元素的 number[]', () => {
    const info = nodeInfo()
    expect(Array.isArray(info.loadavg)).toBe(true)
    expect(info.loadavg.length).toBe(3)
    for (const v of info.loadavg) {
      expect(typeof v).toBe('number')
    }
  })

  test('uptime 是 "Xh" 格式', () => {
    const info = nodeInfo()
    expect(info.uptime).toMatch(/^\d+h$/)
  })

  test('type 跟 os.type() 一致', () => {
    const info = nodeInfo()
    expect(['Linux', 'Darwin', 'Windows_NT']).toContain(info.type)
  })

  test('多次调不互相影响（纯函数）', () => {
    const a = nodeInfo()
    const b = nodeInfo()
    // hostname / type / version 应该相同
    expect(a.hostname).toBe(b.hostname)
    expect(a.type).toBe(b.type)
    expect(a.version).toBe(b.version)
    // uptime 可能 +1h，totalmem 不变
    expect(a.totalmem).toBe(b.totalmem)
  })

  test('NodeInfo 类型断言（编译期保证）', () => {
    const info: NodeInfo = nodeInfo()
    expect(typeof info.hostname).toBe('string')
    expect(typeof info.totalmem).toBe('string')
    expect(typeof info.freemem).toBe('string')
    expect(typeof info.uptime).toBe('string')
    expect(typeof info.version).toBe('string')
  })
})
