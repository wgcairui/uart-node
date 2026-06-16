/**
 * TcpServer 单元测试（RFC 002 §6.5 PR #5 + §7.1 验收）
 *
 * 行为契约：跟老 src/TcpServer.ts 1:1 兼容（extends net.Server → class 包裹 net.createServer）
 *
 * 测试范围（10 test, mock net.createServer）：
 *   1. 构造不自动 listen（PR #5 显式 listen，老 TcpServer 构造隐式 listen）
 *   2. listen() 返 Promise，调用 net.server.listen
 *   3. listen() 默认 port = config.localport (9000)，host = '0.0.0.0'
 *   4. listen(port) 用传入 port
 *   5. 监听时 isListening = true
 *   6. onConnection 嗅探 register& 前缀 → 调 CellularRegisterHandler.handle → 创建 CellularDtu
 *   7. onConnection 嗅探失败 → socket.destroy
 *   8. getOnlineDtu 返在线 mac 列表
 *   9. bus('QueryInstruct', Query) 派发到对应 Dtu
 *   10. restart() close + 清空 + 重新 listen
 *
 * Mock 策略：
 *   - mock net.createServer 返 mock server
 *   - mock socket.io-client（避免真连接）
 *   - listen 触发 mock server.listen
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

// ======================== mock net ========================

interface MockNetServer {
  listen: any
  close: any
  on: any
  once: any
  setMaxListeners: any
  address: any
  getConnections: any
  _connectionHandlers: ((socket: any) => void)[]
}

let mockNetServer: MockNetServer

const mockNet: any = {
  createServer: mock((handler: (socket: any) => void) => {
    mockNetServer._connectionHandlers.push(handler)
    return mockNetServer
  })
}

mock.module('net', () => ({
  ...mockNet,
  default: mockNet
}))

const { TcpServer } = await import('../../src/server/tcp-server')
const { Dtu } = await import('../../src/dtus/base')
const { CellularDtu } = await import('../../src/dtus/cellular')
const config = await import('../../src/config')

// ======================== helper ========================

function makeMockSocket(remoteAddr: string = '1.2.3.4', remotePort: number = 9000): any {
  const writtenData: Buffer[] = []
  const listeners: Record<string, ((...args: any[]) => void)[]> = {}
  const onceListeners: Record<string, ((...args: any[]) => void)[]> = {}
  const sock: any = {
    remoteAddress: remoteAddr,
    remotePort: remotePort,
    destroyed: false,
    writable: true,
    write: mock((data: any) => {
      writtenData.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
      return true
    }),
    end: mock((_data?: any, cb?: () => void) => {
      if (cb) cb()
      sock.destroyed = true
      sock.writable = false
    }),
    destroy: mock(() => {
      sock.destroyed = true
      sock.writable = false
    }),
    setTimeout: mock(() => sock),
    setKeepAlive: mock(() => sock),
    setNoDelay: mock(() => sock),
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
    emit: mock(() => true),
    _getWrittenData: () => writtenData,
    _fireOnce: (event: string, ...args: any[]) => {
      const cbs = onceListeners[event] || []
      for (const cb of cbs) cb(...args)
    },
    _fireOn: (event: string, ...args: any[]) => {
      const cbs = listeners[event] || []
      for (const cb of cbs) cb(...args)
    }
  }
  return sock
}

function resetMockNetServer() {
  mockNetServer = {
    listen: mock((port: number, host: string, cb?: () => void) => {
      if (cb) cb()
      return mockNetServer
    }),
    close: mock((cb?: (err?: Error) => void) => {
      if (cb) cb()
      return mockNetServer
    }),
    on: mock(function (this: any) { return this }),
    once: mock(function (this: any) { return this }),
    setMaxListeners: mock(function (this: any) { return this }),
    address: mock(() => ({ port: 9000, address: '0.0.0.0', family: 'IPv4' })),
    getConnections: mock((cb: (err: Error | null, nb: number) => void) => cb(null, 0)),
    _connectionHandlers: [] as ((socket: any) => void)[]
  }
  mockNet.createServer.mockClear()
}

// ======================== 准备 ========================

let consoleLogSpy: ReturnType<typeof spyOn> | null = null
let consoleErrorSpy: ReturnType<typeof spyOn> | null = null

beforeEach(() => {
  consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {})
  consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})
  resetMockNetServer()
  mockSocket.on.mockClear()
  mockSocket.once.mockClear()
  mockSocket.off.mockClear()
  mockSocket.removeAllListeners.mockClear()
  mockSocket.emit.mockClear()
  mockIoFactory.mockClear()
})

afterEach(() => {
  consoleLogSpy?.mockRestore()
  consoleErrorSpy?.mockRestore()
})

// ======================== 测试 ========================

describe('TcpServer — 构造', () => {
  test('构造时不自动 listen（PR #5 显式 listen 语义）', () => {
    new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    expect(mockNet.createServer).toHaveBeenCalled()
    expect(mockNetServer.listen).not.toHaveBeenCalled()
  })

  test('构造时 macSocketMaps 是空 Map', () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    expect(server.macSocketMaps).toBeInstanceOf(Map)
    expect(server.macSocketMaps.size).toBe(0)
  })

  test('构造时 sniffing 数组包含 CellularSniffer', () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    expect(server.isListening).toBe(false)
  })
})

describe('TcpServer — listen()', () => {
  test('listen() 返 Promise，调用 net.server.listen', async () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    await server.listen()
    expect(mockNetServer.listen).toHaveBeenCalled()
    expect(server.isListening).toBe(true)
  })

  test('listen() 默认 port = config.localport (9000), host = 0.0.0.0', async () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    await server.listen()
    const args = mockNetServer.listen.mock.calls[0]
    expect(args[0]).toBe(config.default.localport)
    expect(args[1]).toBe('0.0.0.0')
  })

  test('listen(port) 用传入 port', async () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    await server.listen(7000)
    const args = mockNetServer.listen.mock.calls[0]
    expect(args[0]).toBe(7000)
  })
})

describe('TcpServer — onConnection 嗅探 + 派发', () => {
  test('嗅探 register& 前缀 → 调 CellularRegisterHandler.handle → 创建 CellularDtu', async () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    await server.listen()
    // 触发新连接
    const sock = makeMockSocket()
    for (const handler of mockNetServer._connectionHandlers) {
      handler(sock)
    }
    // 触发第一个 data 包（register 包）
    sock._fireOnce('data', Buffer.from('register&mac=1234567890ABCDEF&jw=1111'))
    expect(server.macSocketMaps.size).toBe(1)
    expect(server.macSocketMaps.has('567890ABCDEF')).toBe(true)
  })

  test('嗅探失败 → socket.destroy', async () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    await server.listen()
    const sock = makeMockSocket()
    for (const handler of mockNetServer._connectionHandlers) {
      handler(sock)
    }
    sock._fireOnce('data', Buffer.from('hello world'))
    expect(sock.destroy).toHaveBeenCalled()
    expect(server.macSocketMaps.size).toBe(0)
  })
})

describe('TcpServer — 设备查询', () => {
  test('getOnlineDtu 返在线 mac 列表', async () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    await server.listen()
    // 模拟两个注册
    const sock1 = makeMockSocket()
    const sock2 = makeMockSocket()
    for (const handler of mockNetServer._connectionHandlers) {
      handler(sock1)
      handler(sock2)
    }
    sock1._fireOnce('data', Buffer.from('register&mac=111111111111111'))
    sock2._fireOnce('data', Buffer.from('register&mac=222222222222222'))
    expect(server.macSocketMaps.size).toBe(2)
    // getOnlineDtu 返 mac 列表（filter socketsb + connecting 真值）
    const online = server.getOnlineDtu()
    expect(Array.isArray(online)).toBe(true)
  })

  test('bus(QueryInstruct, Query) 派发到对应 Dtu', async () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    await server.listen()
    const sock = makeMockSocket()
    for (const handler of mockNetServer._connectionHandlers) {
      handler(sock)
    }
    sock._fireOnce('data', Buffer.from('register&mac=111111111111111'))
    const dtu = server.macSocketMaps.get('111111111111')
    const saveCacheSpy = spyOn(dtu as any, 'saveCache')
    server.bus('QueryInstruct', {
      DevMac: '111111111111',
      events: 'e1',
      content: ['A'],
      eventType: 'QueryInstruct' as any
    } as any)
    expect(saveCacheSpy).toHaveBeenCalled()
  })
})

describe('TcpServer — restart()', () => {
  test('restart() close + 清空 macSocketMaps + 重新 listen', async () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    await server.listen()
    // 先注册一个 dtu
    const sock = makeMockSocket()
    for (const handler of mockNetServer._connectionHandlers) {
      handler(sock)
    }
    sock._fireOnce('data', Buffer.from('register&mac=111111111111111'))
    expect(server.macSocketMaps.size).toBe(1)
    // restart
    await server.restart()
    expect(mockNetServer.close).toHaveBeenCalled()
    expect(server.macSocketMaps.size).toBe(0)
  })
})

describe('TcpServer — getConnectionsAsync', () => {
  test('返 mock getConnections 调用的 nb', async () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' })
    await server.listen()
    mockNetServer.getConnections = mock((cb: (err: Error | null, nb: number) => void) => cb(null, 42))
    const nb = await server.getConnectionsAsync()
    expect(nb).toBe(42)
  })
})
