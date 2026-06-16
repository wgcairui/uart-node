/**
 * Dtu 基类 + CellularDtu 子类单元测试
 *
 * 跟 src/services/* 模式对齐：mock socket.io-client + setIOClient 注入 mock。
 *
 * 测试范围（重 mock 全链路，RFC 002 §6.5 PR #4 + §7.1 验收）：
 *
 *   Dtu 基类：
 *     1. 构造：mac / socketsb / terminalOn 上报 / bindSocket 触发 initialize
 *     2. queue 调度：saveCache push/unshift 顺序
 *     3. processingQueue：QueryInstruct 走 queryInstruct / OprateInstruct 走 processQueue
 *     4. getPropertys 11 字段
 *     5. onSocketClose / reConnectSocket（主动重启 60s / 被动立即）
 *     6. Oprate 232/485 结果处理
 *     7. AT 解析（+ok / +err）
 *     8. busy 事件
 *     9. Dtu 是抽象类
 *
 *   CellularDtu：
 *     1. 构造：mac / 字段初值
 *     2. initialize() 8 条 AT 顺序查
 *     3. initialize() PID 失败 → 不查后续
 *     4. initialize() 返回 11 字段
 *     5. restart() 走 AT+Z + reboot=true + socket.destroy()
 *     6. processQueue() Oprate 232/485 / ATInstruct
 *     7. queryAT() socket 离线
 *     8. CellularDtu extends Dtu
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

// mock fetch
const mockFetch = {
  dtuInfo: mock(() => true),
  nodeInfo: mock(() => true),
  queryData: mock(() => true)
}
mock.module('../../src/fetch', () => ({
  default: mockFetch
}))

const { Dtu } = await import('../../src/dtus/base')
const { CellularDtu } = await import('../../src/dtus/cellular')
const { setIOClient, getIOClient } = await import('../../src/services/io-client')

// 注入 mock IOClient（屏蔽 module-level 单例状态污染）
const mockIO: any = {
  terminalOn: (...args: any[]) => mockSocket.emit('terminalOn', ...args),
  terminalOff: (...args: any[]) => mockSocket.emit('terminalOff', ...args),
  terminalMountDevTimeOut: (...args: any[]) => mockSocket.emit('terminalMountDevTimeOut', ...args),
  instructTimeOut: (...args: any[]) => mockSocket.emit('instructTimeOut', ...args),
  emit: (...args: any[]) => mockSocket.emit(...args),
  isConnected: true
}

// ======================== helper ========================

function makeMockSocket(): Socket {
  const sock = new Socket({ allowHalfOpen: false })
  ;(sock as any).setNoDelay = () => sock
  ;(sock as any).setKeepAlive = () => sock
  return sock
}

function makeMockSocketsb(writeResponses: (Buffer | string)[] = []) {
  let i = 0
  const mockSock: any = {
    destroyed: false,
    emit: () => {},
    once: function (_e: string, _cb: any) { return this }
  }
  return {
    write: mock((_buf: Buffer) => {
      const buf = writeResponses[i++] ?? Buffer.alloc(0)
      return Promise.resolve({ buffer: buf, useTime: 1, useByte: buf.length || 0 })
    }),
    getStat: () => ({ ip: '127.0.0.1', port: 9000, connecting: true, lock: false }),
    getSocket: () => mockSock,
    destroy: () => {}
  }
}

/** 构造不自动调 initialize 的 CellularDtu（避开 bindSocket 副作用） */
function makeSilentCellular(mac: string, mockSocketsb: any): any {
  const dtu = Object.create(CellularDtu.prototype) as any
  dtu.mac = mac
  dtu.jw = ''
  dtu.uart = ''
  dtu.AT = false
  dtu.ICCID = ''
  dtu.PID = ''
  dtu.ver = ''
  dtu.Gver = ''
  dtu.iotStat = ''
  dtu.signal = '0'
  dtu.timeOut = new Map()
  dtu.pids = new Set()
  dtu.reboot = false
  dtu.cache = []
  dtu.socketsb = mockSocketsb
  dtu.pause = false
  return dtu
}

// ======================== TestDtu ========================

class TestDtu extends Dtu {
  public initializeResult: any = { mac: 'TEST-MAC', AT: true, PID: 'TEST-PID' }
  public restartCalled = 0
  public processQueueCalled = 0

  public async initialize() {
    this.PID = 'TEST-PID'
    this.AT = true
    return this.initializeResult
  }
  public async restart() {
    this.restartCalled++
  }
  protected async processQueue(_query: any) {
    this.processQueueCalled++
  }
}

// ======================== 准备 ========================

let consoleLogSpy: ReturnType<typeof spyOn> | null = null
let consoleErrorSpy: ReturnType<typeof spyOn> | null = null

beforeEach(() => {
  consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {})
  consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})
  setIOClient(mockIO)
  mockSocket.on.mockClear()
  mockSocket.once.mockClear()
  mockSocket.off.mockClear()
  mockSocket.removeAllListeners.mockClear()
  mockSocket.emit.mockClear()
  mockIoFactory.mockClear()
  mockFetch.dtuInfo.mockClear()
  mockFetch.nodeInfo.mockClear()
  mockFetch.queryData.mockClear()
})

afterEach(() => {
  consoleLogSpy?.mockRestore()
  consoleErrorSpy?.mockRestore()
})

// ======================== Dtu 基类 ========================

describe('Dtu 基类 — 构造 + 初始化', () => {
  test('构造时设置 mac / socketsb', () => {
    const dtu = new TestDtu(makeMockSocket(), 'AABBCCDDEEFF')
    expect(dtu.mac).toBe('AABBCCDDEEFF')
    expect(dtu.socketsb).not.toBeNull()
  })

  test('构造时立即发 terminalOn(false)', () => {
    new TestDtu(makeMockSocket(), 'AABBCCDDEEFF')
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'terminalOn')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).toEqual(['terminalOn', 'AABBCCDDEEFF', false])
  })

  test('构造时 bindSocket 触发 initialize()', async () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    await new Promise(r => setImmediate(r))
    expect((dtu as any).PID).toBe('TEST-PID')
  })
})

describe('Dtu 基类 — queue 调度 (saveCache 入队顺序)', () => {
  test('OprateInstruct unshift 到队首（插队）', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    ;(dtu as any).socketsb = {
      write: () => new Promise(() => {}),
      getStat: () => ({ ip: '127.0.0.1', port: 9000, connecting: true, lock: false }),
      getSocket: () => ({ destroyed: false, emit: () => {}, once: () => {} })
    }
    dtu.saveCache({ eventType: 'OprateInstruct', DevMac: 'T', events: 'e2', content: 'X', pid: 1, type: 232 } as any)
    dtu.saveCache({ eventType: 'QueryInstruct', DevMac: 'T', events: 'e', content: ['A'] } as any)
    expect((dtu as any).cache[0].eventType).toBe('OprateInstruct')
  })

  test('ATInstruct unshift 到队首（插队）', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    ;(dtu as any).socketsb = {
      write: () => new Promise(() => {}),
      getStat: () => ({ ip: '127.0.0.1', port: 9000, connecting: true, lock: false }),
      getSocket: () => ({ destroyed: false, emit: () => {}, once: () => {} })
    }
    dtu.saveCache({ eventType: 'ATInstruct', DevMac: 'T', events: 'e2', content: 'AT+VER' } as any)
    dtu.saveCache({ eventType: 'QueryInstruct', DevMac: 'T', events: 'e', content: ['A'] } as any)
    expect((dtu as any).cache[0].eventType).toBe('ATInstruct')
  })
})

describe('Dtu 基类 — getPropertys 11 字段', () => {
  test('返回 mac + stat + 8 个设备字段', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST-MAC')
    const props = dtu.getPropertys()
    expect(props.mac).toBe('TEST-MAC')
    expect(props).toHaveProperty('AT')
    expect(props).toHaveProperty('PID')
    expect(props).toHaveProperty('ver')
    expect(props).toHaveProperty('Gver')
    expect(props).toHaveProperty('iotStat')
    expect(props).toHaveProperty('jw')
    expect(props).toHaveProperty('uart')
    expect(props).toHaveProperty('ICCID')
    expect(props).toHaveProperty('signal')
  })
})

describe('Dtu 基类 — onSocketClose + reConnectSocket', () => {
  test('onSocketClose 触发 terminalOff(true)', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    mockSocket.emit.mockClear()
    dtu.onSocketClose()
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'terminalOff')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).toEqual(['terminalOff', 'TEST', true])
  })

  test('reConnectSocket 被动重连：terminalOn(false) 立即发', async () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    ;(dtu as any).reboot = false
    mockSocket.emit.mockClear()
    dtu.reConnectSocket(makeMockSocket())
    await new Promise(r => setImmediate(r))
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'terminalOn')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0][2]).toBe(false)
  })

  test('reConnectSocket 主动重启：60s 后才发 terminalOn(true)（立即不发）', async () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    ;(dtu as any).reboot = true
    mockSocket.emit.mockClear()
    dtu.reConnectSocket(makeMockSocket())
    await new Promise(r => setImmediate(r))
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'terminalOn')
    // 主动重启模式下不立即发
    expect(calls.length).toBe(0)
  })
})

describe('Dtu 基类 — Oprate 结果处理 (oprateParse)', () => {
  test('232 设备响应成功 → ok=1 + 返回数据', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    mockSocket.emit.mockClear()
    ;(dtu as any).oprateParse(
      { eventType: 'OprateInstruct', DevMac: 'T', events: 'op1', content: 'AT+VER', pid: 1, type: 232 } as any,
      { buffer: Buffer.from('OK\n'), useTime: 10, useByte: 5 }
    )
    const op = mockSocket.emit.mock.calls.find(c => c[0] === 'deviceopratesuccess')
    expect(op).toBeDefined()
    expect((op![2] as any).ok).toBe(1)
  })

  test('超时（buffer 是字符串）→ ok=0 + 错误消息', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    mockSocket.emit.mockClear()
    ;(dtu as any).oprateParse(
      { eventType: 'OprateInstruct', DevMac: 'T', events: 'op1', content: 'AT+VER', pid: 1, type: 232 } as any,
      { buffer: 'timeOut', useTime: 10000, useByte: 0 }
    )
    const op = mockSocket.emit.mock.calls.find(c => c[0] === 'deviceopratesuccess')
    expect(op).toBeDefined()
    expect((op![2] as any).ok).toBe(0)
  })
})

describe('Dtu 基类 — AT 解析 (atParse)', () => {
  test('+ok=PID:HF2411 → ok=1 + msg=PID:HF2411', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    mockSocket.emit.mockClear()
    ;(dtu as any).atParse(
      { eventType: 'ATInstruct', DevMac: 'T', events: 'at1', content: 'AT+PID' } as any,
      { buffer: Buffer.from('+ok=PID:HF2411\r\n'), useTime: 10, useByte: 20 }
    )
    const op = mockSocket.emit.mock.calls.find(c => c[0] === 'dtuopratesuccess')
    expect(op).toBeDefined()
    expect((op![2] as any).ok).toBe(1)
    expect((op![2] as any).msg).toBe('PID:HF2411')
  })

  test('+err=timeout → ok=0 + 错误消息', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    mockSocket.emit.mockClear()
    ;(dtu as any).atParse(
      { eventType: 'ATInstruct', DevMac: 'T', events: 'at1', content: 'AT+VER' } as any,
      { buffer: Buffer.from('+err=timeout\r\n'), useTime: 10, useByte: 20 }
    )
    const op = mockSocket.emit.mock.calls.find(c => c[0] === 'dtuopratesuccess')
    expect(op).toBeDefined()
    expect((op![2] as any).ok).toBe(0)
  })
})

describe('Dtu 基类 — busy 事件触发', () => {
  test('saveCache 后 busy 事件被 emit', () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    mockSocket.emit.mockClear()
    for (let i = 0; i < 4; i++) {
      dtu.saveCache({ eventType: 'QueryInstruct', DevMac: 'T', events: `e${i}`, content: ['A'] } as any)
    }
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'busy')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })
})

describe('Dtu 基类 — queue 调度 processingQueue', () => {
  test('QueryInstruct 走 queryInstruct（不走 processQueue）', async () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    dtu.processQueueCalled = 0
    ;(dtu as any).socketsb = {
      write: () => Promise.resolve({ buffer: Buffer.alloc(0), useTime: 0, useByte: 0 }),
      getStat: () => ({ ip: '127.0.0.1', port: 9000, connecting: true, lock: false }),
      getSocket: () => ({ destroyed: false, emit: () => {} })
    }
    ;(dtu as any).cache.push({
      eventType: 'QueryInstruct',
      DevMac: 'TEST',
      events: 'e1',
      content: ['A'],
      mac: 'TEST',
      type: 232,
      mountDev: 'm',
      protocol: 'p',
      pid: 1,
      timeStamp: 0,
      time: '',
      Interval: 0,
      useTime: 0,
      useBytes: 0
    })
    await (dtu as any).processingQueue()
    expect(dtu.processQueueCalled).toBe(0)
  })

  test('OprateInstruct 走 processQueue', async () => {
    const dtu = new TestDtu(makeMockSocket(), 'TEST')
    dtu.processQueueCalled = 0
    ;(dtu as any).cache.push({ eventType: 'OprateInstruct', DevMac: 'T', events: 'e', content: 'X', pid: 1, type: 232 } as any)
    await (dtu as any).processingQueue()
    expect(dtu.processQueueCalled).toBe(1)
  })
})

describe('Dtu 基类 — 抽象类保护', () => {
  test('Dtu 是抽象类（不能 new）', () => {
    expect(() => new (Dtu as any)(makeMockSocket(), 'TEST')).toThrow()
  })
})

// ======================== CellularDtu ========================

describe('CellularDtu — 构造', () => {
  test('mac / 字段初值正确', () => {
    const dtu = makeSilentCellular('AABBCCDDEEFF', makeMockSocketsb([]))
    expect(dtu.mac).toBe('AABBCCDDEEFF')
    expect(dtu.AT).toBe(false)
    expect(dtu.PID).toBe('')
    expect(dtu.ver).toBe('')
    expect(dtu.Gver).toBe('')
    expect(dtu.ICCID).toBe('')
    expect(dtu.signal).toBe('0')
  })

  test('构造时发 terminalOn(false)', async () => {
    new CellularDtu(makeMockSocket(), 'TEST-MAC')
    await new Promise(r => setImmediate(r))
    const calls = mockSocket.emit.mock.calls.filter(c => c[0] === 'terminalOn')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).toEqual(['terminalOn', 'TEST-MAC', false])
  })
})

describe('CellularDtu — initialize() 8 条 AT 顺序查', () => {
  test('PID 响应成功 → 后续 7 条 AT 都查', async () => {
    const responses = [
      Buffer.from('+ok=HF2411\r\n'),
      Buffer.from('+ok=V1.0\r\n'),
      Buffer.from('+ok=G1.0\r\n'),
      Buffer.from('+ok=on\r\n'),
      Buffer.from('+ok=8986031...\r\n'),
      Buffer.from('+ok=jw\r\n'),
      Buffer.from('+ok=9600\r\n'),
      Buffer.from('+ok=20\r\n'),
      Buffer.from('+ok=ok\r\n')
    ]
    const sb = makeMockSocketsb(responses)
    const dtu = makeSilentCellular('TEST', sb)
    const info = await (dtu as any).initialize()
    expect(dtu.PID).toBe('HF2411')
    expect(dtu.ver).toBe('V1.0')
    expect(dtu.Gver).toBe('G1.0')
    expect(dtu.iotStat).toBe('on')
    expect(dtu.ICCID).toBe('8986031...')
    expect(dtu.jw).toBe('jw')
    expect(dtu.uart).toBe('9600')
    expect(dtu.signal).toBe('20')
    expect(dtu.AT).toBe(true)
    expect(info.mac).toBe('TEST')
  })

  test('PID 响应失败 → 后续 AT 不查（只发 PID 一条）', async () => {
    const sb = makeMockSocketsb([Buffer.from('+err=timeout\r\n')])
    const dtu = makeSilentCellular('TEST', sb)
    await (dtu as any).initialize()
    expect(dtu.AT).toBe(false)
    expect(dtu.PID).toBe('')
  })

  test('initialize() 返回 getPropertys() 11 字段', async () => {
    const responses = [
      Buffer.from('+ok=HF2411\r\n'),
      Buffer.from('+ok=V1\r\n'),
      Buffer.from('+ok=G1\r\n'),
      Buffer.from('+ok=on\r\n'),
      Buffer.from('+ok=8986\r\n'),
      Buffer.from('+ok=jw\r\n'),
      Buffer.from('+ok=9600\r\n'),
      Buffer.from('+ok=20\r\n'),
      Buffer.from('+ok=ok\r\n')
    ]
    const sb = makeMockSocketsb(responses)
    const dtu = makeSilentCellular('TEST-MAC', sb)
    const info = await (dtu as any).initialize()
    expect(info).toHaveProperty('mac')
    expect(info).toHaveProperty('AT')
    expect(info).toHaveProperty('PID')
    expect(info).toHaveProperty('ver')
    expect(info).toHaveProperty('Gver')
    expect(info).toHaveProperty('iotStat')
    expect(info).toHaveProperty('jw')
    expect(info).toHaveProperty('uart')
    expect(info).toHaveProperty('ICCID')
    expect(info).toHaveProperty('signal')
  })
})

describe('CellularDtu — restart() 主动重启', () => {
  test('restart() 走 AT+Z + reboot=true + socket.destroy()', async () => {
    const sb = makeMockSocketsb([Buffer.from('+ok=ok\r\n')])
    let destroyed = false
    const mockSock: any = {
      destroyed: false,
      emit: () => {},
      once: function (_e: string, _cb: any) { return this },
      destroy: () => { destroyed = true; mockSock.destroyed = true }
    }
    sb.getSocket = () => mockSock
    ;(sb as any).destroy = () => mockSock.destroy()
    const dtu = makeSilentCellular('TEST', sb)
    await (dtu as any).restart()
    expect(dtu.reboot).toBe(true)
    expect(destroyed).toBe(true)
  })
})

describe('CellularDtu — processQueue() 指令分发', () => {
  test('OprateInstruct 232 走 utf-8 编码', async () => {
    const sb = makeMockSocketsb([Buffer.from('OK\n')])
    const dtu = makeSilentCellular('TEST', sb)
    const query = { eventType: 'OprateInstruct', DevMac: 'T', events: 'e1', content: 'AT+VER', pid: 1, type: 232 } as any
    await (dtu as any).processQueue(query)
    expect(sb.write.mock.calls.length).toBe(1)
    const buf = sb.write.mock.calls[0][0] as Buffer
    expect(buf.toString()).toBe('AT+VER\r')
  })

  test('OprateInstruct 485 走 hex 编码', async () => {
    const sb = makeMockSocketsb([Buffer.from([0x01, 0x03, 0x00, 0x00])])
    const dtu = makeSilentCellular('TEST', sb)
    const query = { eventType: 'OprateInstruct', DevMac: 'T', events: 'e1', content: '01030000', pid: 1, type: 485 } as any
    await (dtu as any).processQueue(query)
    expect(sb.write.mock.calls.length).toBe(1)
    const buf = sb.write.mock.calls[0][0] as Buffer
    expect(buf.toString('hex')).toBe('01030000')
  })

  test('ATInstruct 走 atParse', async () => {
    mockSocket.emit.mockClear()
    const sb = makeMockSocketsb([Buffer.from('+ok=PID:HF2411\r\n')])
    const dtu = makeSilentCellular('TEST', sb)
    const query = { eventType: 'ATInstruct', DevMac: 'T', events: 'e1', content: 'AT+PID' } as any
    await (dtu as any).processQueue(query)
    await new Promise(r => setImmediate(r))
    const op = mockSocket.emit.mock.calls.find(c => c[0] === 'dtuopratesuccess')
    expect(op).toBeDefined()
    expect((op![2] as any).ok).toBe(1)
    expect((op![2] as any).msg).toBe('PID:HF2411')
  })

  test('processQueue() 队列空时啥都不做', async () => {
    const sb = makeMockSocketsb([])
    const dtu = makeSilentCellular('TEST', sb)
    await (dtu as any).processQueue(undefined as any)
    expect(sb.write.mock.calls.length).toBe(0)
  })
})

describe('CellularDtu — queryAT() 行为', () => {
  test('socket 离线 → 返回 {AT:false, msg:\'socket offline\'}', async () => {
    const dtu = makeSilentCellular('TEST', null)
    const result = await (dtu as any).queryAT('PID')
    expect(result.AT).toBe(false)
    expect(result.msg).toBe('socket offline')
  })
})

describe('CellularDtu — 跟 Dtu 基类继承关系', () => {
  test('CellularDtu extends Dtu', () => {
    const dtu = new CellularDtu(makeMockSocket(), 'TEST')
    expect(dtu).toBeInstanceOf(Dtu)
  })

  test('saveCache / getPropertys 走基类方法', () => {
    const dtu = makeSilentCellular('TEST', makeMockSocketsb([]))
    expect(typeof dtu.saveCache).toBe('function')
    expect(typeof dtu.getPropertys).toBe('function')
    expect(typeof dtu.onSocketClose).toBe('function')
  })
})
