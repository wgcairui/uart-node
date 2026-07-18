/**
 * Dtu 基类状态机集成测试（RFC 002 §12 集成落地）
 *
 * 跟 test/dtus/state.test.ts 互补：state.test.ts 测纯函数（DtuState enum + computeHealth + 转换表），
 * 本文件测集成到 Dtu 基类后的行为（transition / emit dtuState / emit dtuHealth / emit dtuAlert / 60s 上报）。
 *
 * 测试范围（10 test, mock socket + IOClient）：
 *   1. 初始 state = HANDSHAKING
 *   2. transition(ONLINE) → emit dtuState 事件 (HANDSHAKING → ONLINE)
 *   3. transition 幂等：同状态不重复 emit
 *   4. transition 不合法 → 静默忽略，不 emit
 *   5. initialize 成功 → transition ONLINE + 启 60s 上报
 *   6. initialize 失败 → emit AT_TIMEOUT alert + transition OFFLINE
 *   7. socket close → transition OFFLINE + 停 60s 上报
 *   8. emit dtuHealth 内容（ONLINE 状态）
 *   9. emit dtuAlert 4 类 payload 正确
 *   10. reason 字符串超 64 字符截断
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Socket } from 'net'

// ======================== mock socket.io-client ========================

const mockSocket: any = {
  id: 'mock-socket-id',
  io: { opts: { auth: undefined, query: undefined } },
  on: mock(function () { return mockSocket }),
  once: mock(function () { return mockSocket }),
  off: mock(function () { return mockSocket }),
  removeAllListeners: mock(function () { return mockSocket }),
  emit: mock(function () { return mockSocket }),
  close: mock(function () { return mockSocket })
}

const mockIoFactory = mock(() => mockSocket)

mock.module('socket.io-client', () => ({
  io: mockIoFactory,
  Socket: class {}
}))

const mockFetch = {
  dtuInfo: mock(() => true),
  nodeInfo: mock(() => true),
  queryData: mock(() => true)
}
mock.module('../../src/fetch', () => ({
  default: mockFetch
}))

const { Dtu } = await import('../../src/dtus/base')
const { DtuState, HEALTH_REPORT_INTERVAL_MS } = await import('../../src/dtus/state')
const { setIOClient, getIOClient } = await import('../../src/services/io-client')

const mockIO: any = {
  terminalOn: (...args: any[]) => mockSocket.emit('terminalOn', ...args),
  terminalOff: (...args: any[]) => mockSocket.emit('terminalOff', ...args),
  terminalMountDevTimeOut: (...args: any[]) => mockSocket.emit('terminalMountDevTimeOut', ...args),
  instructTimeOut: (...args: any[]) => mockSocket.emit('instructTimeOut', ...args),
  emit: (...args: any[]) => mockSocket.emit(...args),
  dtuState: (event: any) => mockSocket.emit('dtuState', event),
  dtuHealth: (event: any) => mockSocket.emit('dtuHealth', event),
  dtuAlert: (event: any) => mockSocket.emit('dtuAlert', event),
  isConnected: true
}

// ======================== helper ========================

function makeMockSocket(): any {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {}
  const onceListeners: Record<string, ((...args: any[]) => void)[]> = {}
  const sock: any = {
    remoteAddress: '1.2.3.4',
    remotePort: 9000,
    destroyed: false,
    writable: true,
    setNoDelay: () => sock,
    setKeepAlive: () => sock,
    setTimeout: () => sock,
    write: () => true,
    end: () => sock,
    destroy: () => { sock.destroyed = true },
    on: mock((event: string, cb: (...args: any[]) => void) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
      return sock
    }),
    once: mock((event: string, cb: (...args: any[]) => void) => {
      if (!onceListeners[event]) onceListeners[event] = []
      onceListeners[event].push(cb)
      return sock
    }),
    emit: mock((event: string, ...args: any[]) => {
      const cbs = listeners[event] || []
      for (const cb of cbs) cb(...args)
      const onceCbs = onceListeners[event] || []
      onceListeners[event] = []
      for (const cb of onceCbs) cb(...args)
      return true
    })
  }
  return sock
}

class TestDtu extends Dtu {
  public initializeResult: any = { mac: 'TEST-MAC', AT: true }
  public async initialize() {
    return this.initializeResult
  }
  public async restart() {}
  protected async processQueue(_query: any) {}
}

// ======================== 准备 ========================

let consoleLogSpy: ReturnType<typeof spyOn> | null = null
let consoleErrorSpy: ReturnType<typeof spyOn> | null = null
let consoleWarnSpy: ReturnType<typeof spyOn> | null = null

beforeEach(() => {
  consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {})
  consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})
  consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  setIOClient(mockIO)
  mockSocket.on.mockClear()
  mockSocket.once.mockClear()
  mockSocket.off.mockClear()
  mockSocket.removeAllListeners.mockClear()
  mockSocket.emit.mockClear()
  mockIoFactory.mockClear()
  mockFetch.dtuInfo.mockClear()
})

afterEach(() => {
  consoleLogSpy?.mockRestore()
  consoleErrorSpy?.mockRestore()
  consoleWarnSpy?.mockRestore()
})

// ======================== 测试 ========================

describe('Dtu 基类 — 状态机集成', () => {
  test('初始 state = HANDSHAKING（构造时）', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    expect((dtu as any).state).toBe(DtuState.HANDSHAKING)
  })

  test('transition(ONLINE) → emit dtuState 事件 (HANDSHAKING → ONLINE)', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    mockSocket.emit.mockClear()
    ;(dtu as any).transition(DtuState.ONLINE, 'test_ok')
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'dtuState')
    expect(calls.length).toBe(1)
    const event = calls[0][1] as any
    expect(event.mac).toBe('TEST')
    expect(event.from).toBe(DtuState.HANDSHAKING)
    expect(event.to).toBe(DtuState.ONLINE)
    expect(typeof event.score).toBe('number')
    expect(event.reason).toBe('test_ok')
    expect(typeof event.timestamp).toBe('number')
  })

  test('transition 幂等：同状态不重复 emit', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    ;(dtu as any).transition(DtuState.ONLINE, 'first')
    mockSocket.emit.mockClear()
    ;(dtu as any).transition(DtuState.ONLINE, 'second')
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'dtuState')
    expect(calls.length).toBe(0)
  })

  test('transition 不合法 → console.error + emit INVALID_STATE_TRANSITION alert (PR #12 hotfix)', () => {
    // PR #12 hotfix: invalid transition 不再静默忽略, 升级到 console.error + emit alert
    //   8 天 staging 回归暴露根因之一. server 端 PR A 下个 sprint 接 log.terminalEvents
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    // spy console.error
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {})
    // 初始 HANDSHAKING → ONLINE 是合法的，转一次
    ;(dtu as any).transition(DtuState.ONLINE, 'init')
    mockSocket.emit.mockClear()
    // OFFLINE → ONLINE 不合法（OFFLINE 是终态）
    ;(dtu as any).transition(DtuState.OFFLINE, 'force')  // OFFLINE 合法
    ;(dtu as any).transition(DtuState.ONLINE, 'invalid_back')  // OFFLINE → ONLINE 不合法
    // dtuState 仍只 emit ONLINE → OFFLINE 一次（OFFLINE → ONLINE 不合法不 emit dtuState）
    const stateCalls = mockSocket.emit.mock.calls.filter(c => c[0] === 'dtuState')
    expect(stateCalls.length).toBe(1)
    expect(stateCalls[0][1].to).toBe(DtuState.OFFLINE)
    // 但 emit INVALID_STATE_TRANSITION dtuAlert 一次
    const alertCalls = mockSocket.emit.mock.calls.filter(c => c[0] === 'dtuAlert')
    expect(alertCalls.length).toBe(1)
    const alert = alertCalls[0][1] as any
    expect(alert.type).toBe('INVALID_STATE_TRANSITION')
    expect(alert.mac).toBe('TEST')
    expect(alert.message).toContain('OFFLINE -> ONLINE')
    expect(alert.message).toContain('invalid_back')
    // console.error 被调一次
    expect(consoleSpy).toHaveBeenCalled()
    const errMsg = String(consoleSpy.mock.calls[0][0])
    expect(errMsg).toContain('invalid transition')
    consoleSpy.mockRestore()
  })

  test('initialize 成功 → transition ONLINE', async () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    await new Promise(r => setImmediate(r))
    expect((dtu as any).state).toBe(DtuState.ONLINE)
  })

  test('initialize 失败 → emit AT_TIMEOUT alert + transition OFFLINE', async () => {
    class FailDtu extends Dtu {
      public async initialize() {
        throw new Error('AT queries failed')
      }
      public async restart() {}
      protected async processQueue(_query: any) {}
    }
    new FailDtu(makeMockSocket(), 'FAIL-MAC')
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    const alertCalls = mockSocket.emit.mock.calls.filter(c => c[0] === 'dtuAlert')
    expect(alertCalls.length).toBeGreaterThanOrEqual(1)
    const alert = alertCalls[0][1] as any
    expect(alert.type).toBe('AT_TIMEOUT')
    expect(alert.mac).toBe('FAIL-MAC')
    const stateCalls = mockSocket.emit.mock.calls.filter(c => c[0] === 'dtuState')
    const offlineCall = stateCalls.find(c => (c[1] as any).to === DtuState.OFFLINE)
    expect(offlineCall).toBeDefined()
  })

  test('socket close → transition OFFLINE + 停 60s 上报', async () => {
    const sock = makeMockSocket()
    const dtu = new TestDtu(sock, 'TEST')
    await new Promise(r => setImmediate(r))
    // 先转 ONLINE 启 60s 上报
    expect((dtu as any).state).toBe(DtuState.ONLINE)
    expect((dtu as any).healthReportTimer).not.toBeNull()
    mockSocket.emit.mockClear()
    // 触发 close
    sock.emit('close')
    await new Promise(r => setImmediate(r))
    // state 应转 OFFLINE，60s 上报停
    expect((dtu as any).state).toBe(DtuState.OFFLINE)
    expect((dtu as any).healthReportTimer).toBeNull()
    const stateCalls = mockSocket.emit.mock.calls.filter(c => c[0] === 'dtuState')
    const offlineCall = stateCalls.find(c => (c[1] as any).to === DtuState.OFFLINE)
    expect(offlineCall).toBeDefined()
  })

  test('reConnectSocket 3 步 recovery: OFFLINE → HANDSHAKING → INITIALIZING → ONLINE (PR #12 hotfix)', async () => {
    // PR #12 hotfix: 之前 reConnectSocket 不重置 state, OFFLINE → ONLINE invalid 静默忽略,
    //   dtuState 事件不 emit, server 端 dtuStateLatest 永远不更新 (8 天 staging 回归暴露)
    // 现在走 3 步 recovery (OFFLINE → HANDSHAKING → INITIALIZING → ONLINE),
    // 跳过 CONNECTING (reConnectSocket 不重跑 sniffer, 直接进注册路径)
    const sock = makeMockSocket()
    const dtu = new TestDtu(sock, 'TEST')
    await new Promise(r => setImmediate(r))
    // 初始连接 HANDSHAKING → ONLINE
    expect((dtu as any).state).toBe(DtuState.ONLINE)
    // 触发 socket close → OFFLINE
    sock.emit('close')
    await new Promise(r => setImmediate(r))
    expect((dtu as any).state).toBe(DtuState.OFFLINE)
    mockSocket.emit.mockClear()
    // 模拟重连: 调 reConnectSocket
    const newSock = makeMockSocket()
    dtu.reConnectSocket(newSock)
    await new Promise(r => setImmediate(r))
    // 3 步 recovery 全 emit: HANDSHAKING / INITIALIZING / ONLINE
    // (OFFLINE → HANDSHAKING 由 reConnectSocket 触发, HANDSHAKING → INITIALIZING 跟 INITIALIZING → ONLINE 由 bindSocket 内部触发)
    const stateCalls = mockSocket.emit.mock.calls
      .filter(c => c[0] === 'dtuState')
      .map(c => (c[1] as any).to as DtuState)
    expect(stateCalls).toEqual([
      DtuState.HANDSHAKING,
      DtuState.INITIALIZING,
      DtuState.ONLINE
    ])
    // 终态 ONLINE
    expect((dtu as any).state).toBe(DtuState.ONLINE)
  })
})

describe('Dtu 基类 — emitHealth / emitAlert', () => {
  test('emitHealth 仅在 ONLINE/DEGRADED 状态触发', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    ;(dtu as any).transition(DtuState.ONLINE, 'test')
    mockSocket.emit.mockClear()
    ;(dtu as any).emitHealth()
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'dtuHealth')
    expect(calls.length).toBe(1)
    const event = calls[0][1] as any
    expect(event.mac).toBe('TEST')
    expect(event.score).toBeGreaterThanOrEqual(0)
    expect(event.score).toBeLessThanOrEqual(100)
    expect(event.health).toBeDefined()
    expect(typeof event.health.lastCommAt).toBe('number')
    expect(typeof event.health.signal).toBe('number')
  })

  test('emitAlert 4 类 payload 正确', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    mockSocket.emit.mockClear()
    ;(dtu as any).emitAlert({
      mac: 'TEST',
      type: 'AT_TIMEOUT',
      message: '[dtu] test: AT failed',
      timestamp: Date.now()
    })
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'dtuAlert')
    expect(calls.length).toBe(1)
    const event = calls[0][1] as any
    expect(event.type).toBe('AT_TIMEOUT')
    expect(event.mac).toBe('TEST')
  })

  test('emitAlert FATAL 走 mac=null', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    mockSocket.emit.mockClear()
    ;(dtu as any).emitAlert({
      mac: null,
      type: 'FATAL',
      message: '[process] startup: bind failed',
      timestamp: Date.now()
    })
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'dtuAlert')
    expect(calls.length).toBe(1)
    const event = calls[0][1] as any
    expect(event.mac).toBeNull()
    expect(event.type).toBe('FATAL')
  })

  test('reason 字符串超 64 字符截断', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    const longReason = 'a'.repeat(100)
    ;(dtu as any).transition(DtuState.ONLINE, longReason)
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'dtuState')
    const event = calls[0][1] as any
    expect(event.reason.length).toBe(64)
  })
})
