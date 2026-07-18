/**
 * IOClient 单元测试
 *
 * 测试范围：
 *   1. 单例工厂（getIOClient / setIOClient）
 *   2. 业务方法 emit 正确事件名 + payload（防 typo，跟 EVENT 常量对齐）
 *   3. lifecycle handlers 注册（connect / disconnect / reconnect）
 *   4. close 移除 listeners
 *
 * Mock 策略：
 *   - 用 bun:test 的 mock() 覆盖 socket.io-client 的 io 工厂函数
 *   - 不真起 Socket.IO server（避免测试时拉端口、依赖运行时）
 *
 * 注意事项：
 *   - mock() 在每个 test 前用 mock.module() 重置
 *   - console.log 副作用用 spyOn 抑制
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { IO_CONFIG, NODE_TOKEN } from '../../src/config'

// mock socket.io-client 整个 module
const mockSocket = {
  id: 'mock-socket-id',
  io: { opts: { auth: NODE_TOKEN ? { token: NODE_TOKEN } : undefined, query: NODE_TOKEN ? { token: NODE_TOKEN } : undefined } },
  on: mock(() => mockSocket),
  once: mock(() => mockSocket),
  off: mock(() => mockSocket),
  removeAllListeners: mock(() => mockSocket),
  emit: mock(() => mockSocket),
  close: mock(() => mockSocket)
}

const mockIoFactory = mock(() => mockSocket)

// 用 mock.module 替换 socket.io-client
mock.module('socket.io-client', () => ({
  io: mockIoFactory,
  // Socket type 实际不用，导出占位即可
  Socket: class {}
}))

const { IOClient, getIOClient, setIOClient } = await import('../../src/services/io-client')

// ======================== 准备 ========================

let consoleLogSpy: ReturnType<typeof spyOn> | null = null

beforeEach(() => {
  // 每个 test 抑制 console.log（lifecycle handler 副作用）
  consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {})
  // 重置所有 mock 调用记录
  ;(mockIoFactory as ReturnType<typeof mock>).mockClear()
  mockSocket.on.mockClear()
  mockSocket.once.mockClear()
  mockSocket.off.mockClear()
  mockSocket.removeAllListeners.mockClear()
  mockSocket.emit.mockClear()
  mockSocket.close.mockClear()
})

afterEach(() => {
  consoleLogSpy?.mockRestore()
})

// ======================== 测试 ========================

describe('IOClient 工厂 + 单例', () => {
  test('new IOClient 调一次 io 工厂（带 PR #20 鉴权三通道）', () => {
    new IOClient({ uri: IO_CONFIG.uri, path: IO_CONFIG.path })
    expect(mockIoFactory).toHaveBeenCalledTimes(1)
    const call = mockIoFactory.mock.calls[0]!
    const opts = call[1] as Record<string, unknown>
    expect(call[0]).toBe(IO_CONFIG.uri)
    expect(opts.path).toBe(IO_CONFIG.path)
    // PR #20 三通道
    if (NODE_TOKEN) {
      expect(opts.auth).toEqual({ token: NODE_TOKEN })
      expect(opts.query).toEqual({ token: NODE_TOKEN })
      expect(opts.extraHeaders).toEqual({ 'x-node-token': NODE_TOKEN })
    } else {
      expect(opts.auth).toBeUndefined()
      expect(opts.query).toBeUndefined()
      expect(opts.extraHeaders).toBeUndefined()
    }
  })

  test('lifecycle handlers 注册（connect/disconnect/reconnect 等 9 个）', () => {
    new IOClient({ uri: IO_CONFIG.uri, path: IO_CONFIG.path })
    // on() 被调用 9 次（connect / disconnect / connect_error / reconnect / reconnect_error / reconnect_failed / connect_timeout / reconnecting / error）
    expect(mockSocket.on).toHaveBeenCalledTimes(9)
    const eventNames = mockSocket.on.mock.calls.map(c => c[0])
    expect(eventNames).toContain('connect')
    expect(eventNames).toContain('disconnect')
    expect(eventNames).toContain('connect_error')
    expect(eventNames).toContain('reconnect')
    expect(eventNames).toContain('reconnect_error')
    expect(eventNames).toContain('reconnect_failed')
    expect(eventNames).toContain('connect_timeout')
    expect(eventNames).toContain('reconnecting')
    expect(eventNames).toContain('error')
  })

  test('getIOClient() 单例（多次调返回同一实例）', () => {
    // 重置单例（通过 setIOClient(null) 不行，setIOClient 必须传实例）
    // 改用直接构造 + setIOClient
    const a = new IOClient({ uri: IO_CONFIG.uri, path: IO_CONFIG.path })
    setIOClient(a)
    const b = getIOClient()
    const c = getIOClient()
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  test('setIOClient(mockInstance) 注入测试用 mock', () => {
    const mockInstance = { terminalOn: mock(() => mockInstance), terminalOff: mock(() => mockInstance) } as unknown as IOClient
    setIOClient(mockInstance)
    const got = getIOClient()
    expect(got).toBe(mockInstance)
  })
})

describe('IOClient 业务方法（防事件名 typo）', () => {
  let client: IOClient

  beforeEach(() => {
    client = new IOClient({ uri: IO_CONFIG.uri, path: IO_CONFIG.path })
  })

  test('terminalOn(mac, reline) emit 正确事件 + payload', () => {
    client.terminalOn('98D863CC870D', true)
    expect(mockSocket.emit).toHaveBeenCalledWith('terminalOn', '98D863CC870D', true)
  })

  test('terminalOn 默认 reline=false', () => {
    client.terminalOn('98D863CC870D')
    expect(mockSocket.emit).toHaveBeenCalledWith('terminalOn', '98D863CC870D', false)
  })

  test('terminalOff(mac, force) emit 正确事件', () => {
    client.terminalOff('98D863CC870D', true)
    expect(mockSocket.emit).toHaveBeenCalledWith('terminalOff', '98D863CC870D', true)
  })

  test('terminalMountDevTimeOut(mac, pid, num)', () => {
    client.terminalMountDevTimeOut('98D863CC870D', 1, 3)
    expect(mockSocket.emit).toHaveBeenCalledWith('terminalMountDevTimeOut', '98D863CC870D', 1, 3)
  })

  test('instructTimeOut(mac, pid, contents)', () => {
    client.instructTimeOut('98D863CC870D', 1, ['cmd1', 'cmd2'])
    expect(mockSocket.emit).toHaveBeenCalledWith('instructTimeOut', '98D863CC870D', 1, ['cmd1', 'cmd2'])
  })

  test('register(payload) emit "register" + NodeInfo', () => {
    const nodeInfo = { hostname: 'h1', totalmem: '16GB' }
    client.register(nodeInfo)
    expect(mockSocket.emit).toHaveBeenCalledWith('register', nodeInfo)
  })

  test('ready() emit "ready"', () => {
    client.ready()
    expect(mockSocket.emit).toHaveBeenCalledWith('ready')
  })

  test('dtuAlert(event) emit "dtuAlert" + 完整 payload', () => {
    const event = {
      mac: '98D863CC870D',
      type: 'AT_TIMEOUT' as const,
      message: '[dtu 98D863CC870D] AT timeout: AT+IMEI: 5000ms',
      timestamp: 1750000000000
    }
    client.dtuAlert(event)
    expect(mockSocket.emit).toHaveBeenCalledWith('dtuAlert', event)
  })

  test('dtuState(event) emit "dtuState" + 完整 payload', () => {
    const event = {
      mac: '98D863CC870D',
      from: 'ONLINE' as const,
      to: 'RECONNECTING' as const,
      score: 72,
      reason: 'AT timeout: AT+IMEI: 5000ms',
      timestamp: 1750000000000
    }
    client.dtuState(event)
    expect(mockSocket.emit).toHaveBeenCalledWith('dtuState', event)
  })

  test('dtuHealth(event) emit "dtuHealth" + 完整 payload', () => {
    const event = {
      mac: '98D863CC870D',
      score: 85,
      health: {
        lastCommAt: 1750000000000,
        consecutiveSuccesses: 5,
        consecutiveFailures: 0,
        queryTimeoutCount: 1,
        totalRestarts: 0,
        totalReconnects: 2,
        signal: 18
      },
      timestamp: 1750000000000
    }
    client.dtuHealth(event)
    expect(mockSocket.emit).toHaveBeenCalledWith('dtuHealth', event)
  })

  test('ackResult(events, result) emit events (无前缀 "result")', () => {
    client.ackResult('instructQuery', { ok: 1, msg: 'success' })
    expect(mockSocket.emit).toHaveBeenCalledWith('instructQuery', { ok: 1, msg: 'success' })
  })
})

describe('IOClient.close() 优雅关闭', () => {
  test('close() 调 removeAllListeners + close', () => {
    const client = new IOClient({ uri: IO_CONFIG.uri, path: IO_CONFIG.path })
    client.close()
    expect(mockSocket.removeAllListeners).toHaveBeenCalledTimes(1)
    expect(mockSocket.close).toHaveBeenCalledTimes(1)
  })
})

describe('IOClient isConnected getter', () => {
  test('初始 false', () => {
    const client = new IOClient({ uri: IO_CONFIG.uri, path: IO_CONFIG.path })
    expect(client.isConnected).toBe(false)
  })

  test('connect 后变 true', () => {
    const client = new IOClient({ uri: IO_CONFIG.uri, path: IO_CONFIG.path })
    // 找到 connect 的 handler 并触发
    const connectCall = mockSocket.on.mock.calls.find(c => c[0] === 'connect')!
    const connectHandler = connectCall[1] as () => void
    connectHandler()
    expect(client.isConnected).toBe(true)
  })

  test('disconnect 后变 false', () => {
    const client = new IOClient({ uri: IO_CONFIG.uri, path: IO_CONFIG.path })
    const connectCall = mockSocket.on.mock.calls.find(c => c[0] === 'connect')!
    const disconnectCall = mockSocket.on.mock.calls.find(c => c[0] === 'disconnect')!
    ;(connectCall[1] as () => void)()  // connect 先触发
    ;(disconnectCall[1] as (reason: string) => void)('transport close')
    expect(client.isConnected).toBe(false)
  })
})
