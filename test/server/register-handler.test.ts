/**
 * CellularSniffer + CellularRegisterHandler 单元测试
 *
 * 行为契约：跟老 src/TcpServer.ts:68-116 _Connection 1:1
 *
 * 测试范围（12 test, mock socket + CellularDtu）：
 *
 *   CellularSniffer.match：
 *     1. 'register&mac=...' 开头 → true
 *     2. 非法包 → false
 *     3. 空 buffer → false
 *     4. handler() 返 CellularRegisterHandler 实例
 *
 *   CellularRegisterHandler.handle：
 *     5. 合法注册包（带 register + mac）→ 创建 CellularDtu + macMap.set
 *     6. mac 已存在 → 走 reConnectSocket（不新建）
 *     7. IMEI slice(-12)：15 位 → 12 位
 *     8. 缺 register 或 mac 字段 → socket.end + destroy
 *     9. 空 firstPacket → 销毁路径
 *
 *   pushCellularRegisterInvite：
 *     10. socket alive → 写 2 条基础 AT 指令
 *     11. UserID 提供 → 加第 3 条 IOTUID
 *     12. socket destroyed → 不写
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

const { CellularSniffer, CellularRegisterHandler, pushCellularRegisterInvite } = await import('../../src/server/register-handler')
const { CellularDtu } = await import('../../src/dtus/cellular')

// ======================== helper ========================

/**
 * Mock Socket（避免真 net.Socket readonly 字段）
 * 只实现 register-handler / TcpServer 用到的字段 + 方法
 */
interface MockSocket extends Socket {
  _getWrittenData(): Buffer[]
  _resetWrittenData(): void
  write: any
  end: any
  destroy: any
  destroyed: boolean
  writable: boolean
  on: any
  once: any
  emit: any
  remoteAddress: string
  remotePort: number
}

function makeMockSocket(remoteAddr: string = '1.2.3.4', remotePort: number = 9000): MockSocket {
  const writtenData: Buffer[] = []
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
    // socketsb (src/socket.ts) 构造需要这些 net.Socket 方法
    setTimeout: mock(() => sock),
    setKeepAlive: mock(() => sock),
    setNoDelay: mock(() => sock),
    on: mock(() => sock),
    once: mock(() => sock),
    emit: mock(() => true),
    _getWrittenData: () => writtenData,
    _resetWrittenData: () => { writtenData.length = 0 }
  }
  return sock as MockSocket
}

// ======================== 准备 ========================

let consoleLogSpy: ReturnType<typeof spyOn> | null = null

beforeEach(() => {
  consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {})
  mockSocket.on.mockClear()
  mockSocket.once.mockClear()
  mockSocket.off.mockClear()
  mockSocket.removeAllListeners.mockClear()
  mockSocket.emit.mockClear()
  mockIoFactory.mockClear()
})

afterEach(() => {
  consoleLogSpy?.mockRestore()
})

// ======================== CellularSniffer 测试 ========================

describe('CellularSniffer.match', () => {
  const sniffer = new CellularSniffer()

  test('register&mac=... 开头 → true', () => {
    expect(sniffer.match(Buffer.from('register&mac=1234567890ABCDE&jw=1111,3333'))).toBe(true)
  })

  test('非法包（不 register 开头） → false', () => {
    expect(sniffer.match(Buffer.from('hello world'))).toBe(false)
    expect(sniffer.match(Buffer.from('+++AT+PING\r'))).toBe(false)
  })

  test('空 buffer → false', () => {
    expect(sniffer.match(Buffer.alloc(0))).toBe(false)
  })

  test('handler() 返 CellularRegisterHandler 实例', () => {
    const handler = sniffer.handler()
    expect(handler).toBeInstanceOf(CellularRegisterHandler)
  })
})

// ======================== CellularRegisterHandler.handle 测试 ========================

describe('CellularRegisterHandler.handle', () => {
  const handler = new CellularRegisterHandler()

  test('合法注册包（带 register + mac）→ 创建 CellularDtu + macMap.set', () => {
    const sock = makeMockSocket()
    const macMap = new Map()
    const packet = Buffer.from('register&mac=1234567890ABCDEF&jw=1111,3333')
    handler.handle(sock, packet, macMap, {})
    expect(macMap.size).toBe(1)
    const dtu = macMap.get('567890ABCDEF') // '1234567890ABCDEF'.slice(-12) = '567890ABCDEF'
    expect(dtu).toBeDefined()
    expect(dtu).toBeInstanceOf(CellularDtu)
  })

  test('mac 已存在 → 走 reConnectSocket（不新建）', () => {
    const sock1 = makeMockSocket()
    const sock2 = makeMockSocket()
    const macMap = new Map()
    // 第一次注册
    handler.handle(sock1, Buffer.from('register&mac=ABCDEF1234567890'), macMap, {})
    expect(macMap.size).toBe(1)
    const firstDtu = macMap.get('34567890')
    // 第二次注册（重连）
    handler.handle(sock2, Buffer.from('register&mac=ABCDEF1234567890'), macMap, {})
    expect(macMap.size).toBe(1) // 没有增加
    expect(macMap.get('34567890')).toBe(firstDtu) // 还是同一个 dtu
  })

  test('IMEI slice(-12)：15 位 IMEI 取后 12 位', () => {
    const sock = makeMockSocket()
    const macMap = new Map()
    // 15 位 IMEI = 123456789012345 → slice(-12) = '678901234567'...等等是 13 位
    // 实际 15 位 IMEI slice(-12) = 后 12 位 = '890123456789'（14位）...不对
    // 让我数：'123456789012345'.length = 15
    // slice(-12) = '456789012345' = 12 位（最后 12 个字符）
    handler.handle(sock, Buffer.from('register&mac=123456789012345'), macMap, {})
    expect(macMap.size).toBe(1)
    expect(macMap.has('456789012345')).toBe(true)
  })

  test('IMEI 12 位 IMEI slice(-12) = 全部 12 位', () => {
    const sock = makeMockSocket()
    const macMap = new Map()
    handler.handle(sock, Buffer.from('register&mac=123456789012'), macMap, {})
    expect(macMap.size).toBe(1)
    expect(macMap.has('123456789012')).toBe(true)
  })

  test('缺 register 字段 → socket.end + destroy', () => {
    const sock = makeMockSocket()
    const macMap = new Map()
    handler.handle(sock, Buffer.from('mac=123456789012345'), macMap, {})
    expect(macMap.size).toBe(0)
    expect((sock as any).end).toHaveBeenCalled()
    expect((sock as any).destroy).toHaveBeenCalled()
  })

  test('缺 mac 字段 → socket.end + destroy', () => {
    const sock = makeMockSocket()
    const macMap = new Map()
    handler.handle(sock, Buffer.from('register=ok&host=10.0.0.1'), macMap, {})
    expect(macMap.size).toBe(0)
    expect((sock as any).end).toHaveBeenCalled()
    expect((sock as any).destroy).toHaveBeenCalled()
  })

  test('空 firstPacket → 销毁路径', () => {
    const sock = makeMockSocket()
    const macMap = new Map()
    handler.handle(sock, Buffer.alloc(0), macMap, {})
    expect(macMap.size).toBe(0)
    expect((sock as any).end).toHaveBeenCalled()
  })
})

// ======================== pushCellularRegisterInvite 测试 ========================

describe('pushCellularRegisterInvite', () => {
  test('socket alive → 写 2 条基础 AT 指令', () => {
    const sock = makeMockSocket()
    pushCellularRegisterInvite(sock, {})
    const data = (sock as any)._getWrittenData()
    expect(data.length).toBe(2)
    expect(data[0].toString()).toBe('+++AT+NREGEN=A,on\r')
    expect(data[1].toString()).toBe('+++AT+NREGDT=A,register&mac=%MAC&host=%HOST\r')
  })

  test('UserID 提供 → 加第 3 条 IOTUID', () => {
    const sock = makeMockSocket()
    pushCellularRegisterInvite(sock, { UserID: 'user123' })
    const data = (sock as any)._getWrittenData()
    expect(data.length).toBe(3)
    expect(data[2].toString()).toBe('+++AT+IOTUID=user123\r')
  })

  test('socket destroyed → 不写', () => {
    const sock = makeMockSocket()
    ;(sock as any).destroyed = true
    ;(sock as any).writable = false
    pushCellularRegisterInvite(sock, {})
    const data = (sock as any)._getWrittenData()
    expect(data.length).toBe(0)
  })
})
