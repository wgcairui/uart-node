/**
 * 事件名常量测试（契约锁定）
 *
 * EVENT 里的字符串是 server <-> node 的契约，**改了就要同步改 uart-server**。
 * 锁定这些字符串防止有人无脑 typo。
 *
 * 测试范围：
 *   1. 所有事件名都是非空字符串
 *   2. 没有任何重复
 *   3. 关键事件名未变（防止有人手抖改 typo）
 *   4. v4 新增 3 个事件已存在 + payload 类型字段完整
 *
 * Mock 策略: 0 mock（直接 import 常量）
 */

import { describe, expect, test } from 'bun:test'
import {
  EVENT_NODE_TERMINAL_ON,
  EVENT_NODE_TERMINAL_OFF,
  EVENT_NODE_TERMINAL_MOUNT_DEV_TIMEOUT,
  EVENT_NODE_INSTRUCT_TIMEOUT,
  EVENT_NODE_REGISTER,
  EVENT_NODE_INSTRUCT_QUERY,
  EVENT_NODE_DTUOPRATE,
  EVENT_NODE_RESULT,
  EVENT_NODE_DTU_STATE,
  EVENT_NODE_DTU_HEALTH,
  EVENT_NODE_DTU_ALERT,
  EVENT_SERVER_ACCONT,
  EVENT_SERVER_REGISTER_SUCCESS,
  EVENT_SERVER_READY,
  EVENT_SERVER_QUERY,
  EVENT_SERVER_NODE_INFO,
  type NodeEventName,
  type ServerEventName,
  type EventName,
  type DtuState,
  type AlertType,
  type DtuStateEvent,
  type DtuHealthEvent,
  type DtuAlertEvent
} from '../../src/protocol/events'

/** 所有 Node 事件名 + 所有 Server 事件名 = 16 个（13 旧 + 3 新） */
const ALL_EVENTS = {
  // 现有 13 个
  EVENT_NODE_TERMINAL_ON,
  EVENT_NODE_TERMINAL_OFF,
  EVENT_NODE_TERMINAL_MOUNT_DEV_TIMEOUT,
  EVENT_NODE_INSTRUCT_TIMEOUT,
  EVENT_NODE_REGISTER,
  EVENT_NODE_INSTRUCT_QUERY,
  EVENT_NODE_DTUOPRATE,
  EVENT_NODE_RESULT,
  EVENT_SERVER_ACCONT,
  EVENT_SERVER_REGISTER_SUCCESS,
  EVENT_SERVER_READY,
  EVENT_SERVER_QUERY,
  EVENT_SERVER_NODE_INFO,
  // v4 新增 3 个
  EVENT_NODE_DTU_STATE,
  EVENT_NODE_DTU_HEALTH,
  EVENT_NODE_DTU_ALERT
} as const

describe('EVENT 常量值（契约锁定）', () => {
  test('所有 16 个事件名都是非空字符串', () => {
    for (const [key, value] of Object.entries(ALL_EVENTS)) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
      expect(key.length).toBeGreaterThan(0)
    }
  })

  test('没有任何重复', () => {
    const values = Object.values(ALL_EVENTS)
    const uniqueValues = new Set(values)
    expect(uniqueValues.size).toBe(values.length)
  })

  test('总数 = 16（13 旧 + 3 新）', () => {
    expect(Object.keys(ALL_EVENTS).length).toBe(16)
  })

  test('关键事件名未变（防止 typo）', () => {
    // 改这些值前要确认 server 端没受影响
    expect(EVENT_NODE_TERMINAL_ON).toBe('terminalOn')
    expect(EVENT_NODE_TERMINAL_OFF).toBe('terminalOff')
    expect(EVENT_NODE_TERMINAL_MOUNT_DEV_TIMEOUT).toBe('terminalMountDevTimeOut')
    expect(EVENT_NODE_INSTRUCT_TIMEOUT).toBe('instructTimeOut')
    expect(EVENT_NODE_REGISTER).toBe('register')
    expect(EVENT_NODE_INSTRUCT_QUERY).toBe('instructQuery')
    expect(EVENT_NODE_DTUOPRATE).toBe('DTUoprate')     // 注意大小写
    expect(EVENT_NODE_RESULT).toBe('result')
    expect(EVENT_SERVER_ACCONT).toBe('accont')            // 注意拼写 (accont, 不是 account)
    expect(EVENT_SERVER_REGISTER_SUCCESS).toBe('registerSuccess')
    expect(EVENT_SERVER_READY).toBe('ready')
    expect(EVENT_SERVER_QUERY).toBe('query')
    expect(EVENT_SERVER_NODE_INFO).toBe('nodeInfo')
  })

  test('v4 新增 3 个事件名已存在', () => {
    expect(EVENT_NODE_DTU_STATE).toBe('dtuState')
    expect(EVENT_NODE_DTU_HEALTH).toBe('dtuHealth')
    expect(EVENT_NODE_DTU_ALERT).toBe('dtuAlert')
  })
})

describe('EventName 类型', () => {
  test('NodeEventName 可以取到 11 个 Node 事件', () => {
    const samples: NodeEventName[] = [
      EVENT_NODE_TERMINAL_ON,
      EVENT_NODE_TERMINAL_OFF,
      EVENT_NODE_TERMINAL_MOUNT_DEV_TIMEOUT,
      EVENT_NODE_INSTRUCT_TIMEOUT,
      EVENT_NODE_REGISTER,
      EVENT_NODE_INSTRUCT_QUERY,
      EVENT_NODE_DTUOPRATE,
      EVENT_NODE_RESULT,
      EVENT_NODE_DTU_STATE,
      EVENT_NODE_DTU_HEALTH,
      EVENT_NODE_DTU_ALERT
    ]
    expect(samples.length).toBe(11)
  })

  test('ServerEventName 可以取到 5 个 Server 事件', () => {
    const samples: ServerEventName[] = [
      EVENT_SERVER_ACCONT,
      EVENT_SERVER_REGISTER_SUCCESS,
      EVENT_SERVER_READY,
      EVENT_SERVER_QUERY,
      EVENT_SERVER_NODE_INFO
    ]
    expect(samples.length).toBe(5)
  })

  test('EventName = NodeEventName | ServerEventName (16 个)', () => {
    const all: EventName = EVENT_NODE_TERMINAL_ON
    expect(typeof all).toBe('string')
  })
})

describe('v4 payload 类型（cairui 拍板 2026-06-15）', () => {
  test('DtuState 8 个值', () => {
    const states: DtuState[] = [
      'CONNECTING',
      'HANDSHAKING',
      'INITIALIZING',
      'ONLINE',
      'DEGRADED',
      'RECONNECTING',
      'RESTARTING',
      'OFFLINE'
    ]
    expect(states.length).toBe(8)
  })

  test('AlertType 4 个值（cairui 拍板）', () => {
    const types: AlertType[] = [
      'AT_TIMEOUT',
      'INVALID_REGISTER',
      'PROFILE_CACHE_FAIL',
      'FATAL'
    ]
    expect(types.length).toBe(4)
  })

  test('DtuStateEvent payload 完整（latest-wins 覆盖）', () => {
    const event: DtuStateEvent = {
      mac: '98D863CC870D',
      from: 'ONLINE',
      to: 'RECONNECTING',
      score: 72,
      reason: 'AT timeout: AT+IMEI: 5000ms',
      timestamp: 1750000000000
    }
    expect(event.mac.length).toBe(12)   // 主键 12 位（兼容旧）—— 实际 v4 改 15 位
    expect(typeof event.score).toBe('number')
    expect(event.reason.length).toBeGreaterThan(0)
  })

  test('DtuHealthEvent payload 完整', () => {
    const event: DtuHealthEvent = {
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
    expect(event.health.signal).toBeGreaterThanOrEqual(0)
    expect(event.health.signal).toBeLessThanOrEqual(31)
  })

  test('DtuAlertEvent 4 个 type 都接受（FATAL 走 dtuAlert）', () => {
    const events: DtuAlertEvent[] = [
      { mac: '98D863CC870D', type: 'AT_TIMEOUT', message: '[dtu 98D863CC870D] AT timeout: AT+IMEI: 5000ms', timestamp: 1750000000000 },
      { mac: null,            type: 'INVALID_REGISTER', message: '[tcp-server] sniff fail: 1.2.3.4: "GET / HTTP"', context: { remoteAddr: '1.2.3.4', firstPacket: 'GET / HTTP' }, timestamp: 1750000000000 },
      { mac: '98D863CC870D', type: 'PROFILE_CACHE_FAIL', message: '[profile-cache] fetch failed: ECONNREFUSED', timestamp: 1750000000000 },
      { mac: null,            type: 'FATAL', message: '[main] fatal: Error: out of memory', context: { stack: 'Error: out of memory\n  at ...' }, timestamp: 1750000000000 }
    ]
    expect(events.length).toBe(4)
    // FATAL 和 INVALID_REGISTER 允许 mac: null
    expect(events[1]!.mac).toBeNull()
    expect(events[3]!.mac).toBeNull()
    // AT_TIMEOUT 和 PROFILE_CACHE_FAIL 必须有 mac
    expect(events[0]!.mac).toBe('98D863CC870D')
    expect(events[2]!.mac).toBe('98D863CC870D')
  })

  test('DtuAlertEvent 5min 去重 key 模式（cairui 拍板）', () => {
    // server 端去重 key = mac + type + message (完整 message)
    // 这里只验证 message 格式不解析: server 端只做字符串比较
    const event: DtuAlertEvent = {
      mac: '98D863CC870D',
      type: 'AT_TIMEOUT',
      message: '[dtu 98D863CC870D] AT timeout: AT+IMEI: 5000ms',
      timestamp: 1750000000000
    }
    const dedupKey = `${event.mac}|${event.type}|${event.message}`
    expect(dedupKey).toBe('98D863CC870D|AT_TIMEOUT|[dtu 98D863CC870D] AT timeout: AT+IMEI: 5000ms')
  })
})
