/**
 * TcpServer.getActiveDevices 单元测试（v3 架构, 2026-07-18）
 *
 * 行为契约：
 *   - getActiveDevices() 返 [{mac, port, ip}] (从 macSocketMaps + socketsb 拿)
 *   - 只返 socketsb 存在 + connecting 真值的设备
 *   - 跟 getOnlineDtu() (返 string[]) 互补
 */

import { describe, expect, test } from 'bun:test'
import TcpServer from '../../src/server/tcp-server'

// ======================== mock socket.io-client ========================

const mockSocket: any = {
  id: 'mock-socket-id',
  io: { opts: { auth: undefined, query: undefined } },
  on: function () { return mockSocket },
  once: function () { return mockSocket },
  off: function () { return mockSocket },
  removeAllListeners: function () { return mockSocket },
  emit: function () { return mockSocket },
  close: function () { return mockSocket }
}

const mockIoFactory = () => mockSocket

;(globalThis as any).require && ((globalThis as any).require.cache || ({} as any))
// 简化: 直接 mock module
const moduleCache: Record<string, any> = {}
const originalResolve = (require as any).resolve
;(require as any).resolve = function (id: string) {
  if (id === 'socket.io-client') return 'socket.io-client'
  return originalResolve?.(id) ?? id
}

describe('TcpServer.getActiveDevices (v3 架构, server getSocketMaps onAck)', () => {
  test('空: 0 设备 → []', () => {
    // 不实际 listen, 跳过 listen 流程
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' } as any)
    expect(server.getActiveDevices()).toEqual([])
  })

  test('1 在线设备 (socketsb+connecting) → 返 [{mac, port, ip}]', () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' } as any)
    // mock 1 个 Dtu, 注入到 macSocketMaps
    const mockDtu: any = {
      mac: 'AABBCC112233',
      socketsb: { ip: '192.168.1.100', port: 9001 },
      getPropertys: () => ({ connecting: true }),
    }
    server.macSocketMaps.set('AABBCC112233', mockDtu)

    const devices = server.getActiveDevices()
    expect(devices).toEqual([
      { mac: 'AABBCC112233', port: 9001, ip: '192.168.1.100' },
    ])
  })

  test('多设备 → 返全部', () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' } as any)
    server.macSocketMaps.set('MAC_001', {
      mac: 'MAC_001',
      socketsb: { ip: '10.0.0.1', port: 5001 },
      getPropertys: () => ({ connecting: true }),
    })
    server.macSocketMaps.set('MAC_002', {
      mac: 'MAC_002',
      socketsb: { ip: '10.0.0.2', port: 5002 },
      getPropertys: () => ({ connecting: true }),
    })
    server.macSocketMaps.set('MAC_003', {
      mac: 'MAC_003',
      socketsb: { ip: '10.0.0.3', port: 5003 },
      getPropertys: () => ({ connecting: true }),
    })

    const devices = server.getActiveDevices()
    expect(devices).toHaveLength(3)
    expect(devices).toContainEqual({ mac: 'MAC_001', port: 5001, ip: '10.0.0.1' })
    expect(devices).toContainEqual({ mac: 'MAC_002', port: 5002, ip: '10.0.0.2' })
    expect(devices).toContainEqual({ mac: 'MAC_003', port: 5003, ip: '10.0.0.3' })
  })

  test('设备 socketsb=null → 不返', () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' } as any)
    server.macSocketMaps.set('MAC_ONLINE', {
      mac: 'MAC_ONLINE',
      socketsb: { ip: '10.0.0.1', port: 5001 },
      getPropertys: () => ({ connecting: true }),
    })
    server.macSocketMaps.set('MAC_NO_SOCKETSB', {
      mac: 'MAC_NO_SOCKETSB',
      socketsb: null,
      getPropertys: () => ({ connecting: true }),
    })

    const devices = server.getActiveDevices()
    expect(devices).toEqual([
      { mac: 'MAC_ONLINE', port: 5001, ip: '10.0.0.1' },
    ])
  })

  test('设备 connecting=false → 不返', () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' } as any)
    server.macSocketMaps.set('MAC_CONNECTING', {
      mac: 'MAC_CONNECTING',
      socketsb: { ip: '10.0.0.1', port: 5001 },
      getPropertys: () => ({ connecting: true }),
    })
    server.macSocketMaps.set('MAC_DISCONNECTED', {
      mac: 'MAC_DISCONNECTED',
      socketsb: { ip: '10.0.0.2', port: 5002 },
      getPropertys: () => ({ connecting: false }),
    })

    const devices = server.getActiveDevices()
    expect(devices).toEqual([
      { mac: 'MAC_CONNECTING', port: 5001, ip: '10.0.0.1' },
    ])
  })

  test('socketsb 没 port/ip 字段 → 用 0/"" 兜底', () => {
    const server = new TcpServer({ Port: 9000, IP: '0.0.0.0', MaxConnections: 2000, Name: 'test', UserID: '', clients: '' } as any)
    server.macSocketMaps.set('MAC_NO_FIELD', {
      mac: 'MAC_NO_FIELD',
      socketsb: {}, // 啥都没有
      getPropertys: () => ({ connecting: true }),
    })

    const devices = server.getActiveDevices()
    expect(devices).toEqual([
      { mac: 'MAC_NO_FIELD', port: 0, ip: '' },
    ])
  })
})
