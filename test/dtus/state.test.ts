/**
 * DtuState 状态机 + 健康度 + 重连退避 纯函数单测
 *
 * 跟老 RFC §12.6 测试矩阵 1:1 对齐
 *   - DtuStateMachine: 8 个状态转换测试
 *   - DtuHealth: 4 个健康度场景
 *   - Reconnect Backoff: 3 个退避场景
 *
 * 0 mock，纯函数测试。
 */

import { describe, expect, test } from 'bun:test'
import {
  DtuState,
  type DtuHealth,
  computeHealth,
  healthTier,
  isValidTransition,
  computeReconnectBackoff,
  shouldReportHealth,
  HEALTH_THRESHOLD_HEALTHY,
  HEALTH_THRESHOLD_DEGRADED
} from '../../src/dtus/state'

// ======================== DtuStateMachine ========================

describe('DtuState 转换合法性', () => {
  test('初始 → CONNECTING 合法（用空字符串 from 表示初始）', () => {
    expect(isValidTransition('' as any, DtuState.CONNECTING)).toBe(true)
  })

  test('CONNECTING → HANDSHAKING 合法（注册包解析成功）', () => {
    expect(isValidTransition(DtuState.CONNECTING, DtuState.HANDSHAKING)).toBe(true)
  })

  test('CONNECTING → OFFLINE 合法（10s 无注册包）', () => {
    expect(isValidTransition(DtuState.CONNECTING, DtuState.OFFLINE)).toBe(true)
  })

  test('HANDSHAKING → INITIALIZING 合法（5 条必查 AT 全过）', () => {
    expect(isValidTransition(DtuState.HANDSHAKING, DtuState.INITIALIZING)).toBe(true)
  })

  test('HANDSHAKING → OFFLINE 合法（AT 查询超时）', () => {
    expect(isValidTransition(DtuState.HANDSHAKING, DtuState.OFFLINE)).toBe(true)
  })

  test('INITIALIZING → ONLINE 合法', () => {
    expect(isValidTransition(DtuState.INITIALIZING, DtuState.ONLINE)).toBe(true)
  })

  test('ONLINE → DEGRADED 合法（连续 3 次查询失败）', () => {
    expect(isValidTransition(DtuState.ONLINE, DtuState.DEGRADED)).toBe(true)
  })

  test('DEGRADED → ONLINE 合法（连续 5 次查询成功）', () => {
    expect(isValidTransition(DtuState.DEGRADED, DtuState.ONLINE)).toBe(true)
  })

  test('DEGRADED → DEGRADED 合法（连续失败但还没恢复，幂等）', () => {
    expect(isValidTransition(DtuState.DEGRADED, DtuState.DEGRADED)).toBe(true)
  })

  test('ONLINE → RECONNECTING 合法（被动断开）', () => {
    expect(isValidTransition(DtuState.ONLINE, DtuState.RECONNECTING)).toBe(true)
  })

  test('RECONNECTING → OFFLINE 合法（重试 5 次失败）', () => {
    expect(isValidTransition(DtuState.RECONNECTING, DtuState.OFFLINE)).toBe(true)
  })

  test('ONLINE → RESTARTING 合法（AT+Z 触发）', () => {
    expect(isValidTransition(DtuState.ONLINE, DtuState.RESTARTING)).toBe(true)
  })

  test('OFFLINE → ONLINE 不合法（不可恢复）', () => {
    expect(isValidTransition(DtuState.OFFLINE, DtuState.ONLINE)).toBe(false)
  })

  test('CONNECTING → ONLINE 不合法（必须经 HANDSHAKING + INITIALIZING）', () => {
    expect(isValidTransition(DtuState.CONNECTING, DtuState.ONLINE)).toBe(false)
  })

  test('8 个状态值都是 string', () => {
    expect(Object.values(DtuState).length).toBe(8)
    for (const v of Object.values(DtuState)) {
      expect(typeof v).toBe('string')
    }
  })
})

// ======================== DtuHealth computeHealth ========================

describe('computeHealth 纯函数', () => {
  const now = 1_700_000_000_000  // 固定时间戳
  const baseHealth: Omit<DtuHealth, 'score'> = {
    lastCommAt: now,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    queryTimeoutCount: 0,
    totalRestarts: 0,
    totalReconnects: 0,
    signal: 20  // 强信号
  }

  test('初始 score = 100（最近通信 + 强信号 + 无失败 + 无重启）', () => {
    expect(computeHealth(baseHealth, now)).toBe(100)
  })

  test('signal < 5 扣 20', () => {
    const h = { ...baseHealth, signal: 3 }
    expect(computeHealth(h, now)).toBe(80)
  })

  test('signal < 10 扣 10', () => {
    const h = { ...baseHealth, signal: 8 }
    expect(computeHealth(h, now)).toBe(90)
  })

  test('signal < 15 扣 5', () => {
    const h = { ...baseHealth, signal: 12 }
    expect(computeHealth(h, now)).toBe(95)
  })

  test('signal 0 扣 20（跟 < 5 一样）', () => {
    const h = { ...baseHealth, signal: 0 }
    expect(computeHealth(h, now)).toBe(80)
  })

  test('连续失败 1 次扣 10', () => {
    const h = { ...baseHealth, consecutiveFailures: 1 }
    expect(computeHealth(h, now)).toBe(90)
  })

  test('连续失败 4 次扣 40（max）', () => {
    const h = { ...baseHealth, consecutiveFailures: 4 }
    expect(computeHealth(h, now)).toBe(60)
  })

  test('连续失败 10 次还是 max -40（不重复扣）', () => {
    const h = { ...baseHealth, consecutiveFailures: 10 }
    expect(computeHealth(h, now)).toBe(60)
  })

  test('重启 1 次扣 5', () => {
    const h = { ...baseHealth, totalRestarts: 1 }
    expect(computeHealth(h, now)).toBe(95)
  })

  test('重启 4 次扣 20（max）', () => {
    const h = { ...baseHealth, totalRestarts: 4 }
    expect(computeHealth(h, now)).toBe(80)
  })

  test('60 分钟无通信扣 30（max -30, score 70）', () => {
    // RFC §12.3: 每分钟无通信 -5, max -30 → 30 分钟后封顶扣 30
    const h = { ...baseHealth, lastCommAt: now - 60 * 60 * 1000 }
    expect(computeHealth(h, now)).toBe(70)
  })

  test('30 分钟无通信扣 30（max -30 封顶）', () => {
    const h = { ...baseHealth, lastCommAt: now - 30 * 60 * 1000 }
    expect(computeHealth(h, now)).toBe(70)
  })

  test('6 分钟无通信扣 30（封顶）', () => {
    const h = { ...baseHealth, lastCommAt: now - 6 * 60 * 1000 }
    expect(computeHealth(h, now)).toBe(70)
  })

  test('5 分钟无通信扣 25', () => {
    const h = { ...baseHealth, lastCommAt: now - 5 * 60 * 1000 }
    expect(computeHealth(h, now)).toBe(75)
  })

  test('复合扣分：弱信号 + 失败 + 重启 不会 < 0', () => {
    const h = {
      ...baseHealth,
      lastCommAt: now - 60 * 60 * 1000,  // -30
      signal: 0,                            // -20
      consecutiveFailures: 10,              // -40
      totalRestarts: 10                     // -20
    }
    expect(computeHealth(h, now)).toBe(0)
  })

  test('复合扣分：满 100 但不溢出', () => {
    // 起点 100，扣 0 → 100
    const h = {
      ...baseHealth,
      lastCommAt: now,
      signal: 20,
      consecutiveSuccesses: 5
    }
    expect(computeHealth(h, now)).toBe(100)
  })
})

// ======================== healthTier ========================

describe('healthTier 区间判定', () => {
  test('score >= 80 → HEALTHY', () => {
    expect(healthTier(80)).toBe('HEALTHY')
    expect(healthTier(100)).toBe('HEALTHY')
    expect(healthTier(95)).toBe('HEALTHY')
  })

  test('60-79 → MILD_DEGRADED', () => {
    expect(healthTier(60)).toBe('MILD_DEGRADED')
    expect(healthTier(75)).toBe('MILD_DEGRADED')
    expect(healthTier(79)).toBe('MILD_DEGRADED')
  })

  test('40-59 → SEVERE_DEGRADED', () => {
    expect(healthTier(40)).toBe('SEVERE_DEGRADED')
    expect(healthTier(50)).toBe('SEVERE_DEGRADED')
    expect(healthTier(59)).toBe('SEVERE_DEGRADED')
  })

  test('1-39 → CRITICAL', () => {
    expect(healthTier(1)).toBe('CRITICAL')
    expect(healthTier(20)).toBe('CRITICAL')
    expect(healthTier(39)).toBe('CRITICAL')
  })

  test('0 → DEAD', () => {
    expect(healthTier(0)).toBe('DEAD')
  })

  test('阈值常量：HEALTHY=80, DEGRADED=40', () => {
    expect(HEALTH_THRESHOLD_HEALTHY).toBe(80)
    expect(HEALTH_THRESHOLD_DEGRADED).toBe(40)
  })
})

// ======================== Reconnect Backoff ========================

describe('computeReconnectBackoff 退避算法', () => {
  // 注入固定 random 让测试稳定
  const fixedRandom = () => 0  // jitter = 0

  test('第 1 次退避 1000ms (1s) + jitter', () => {
    const r = computeReconnectBackoff({ attempt: 1, random: fixedRandom })
    expect(r.shouldRetry).toBe(true)
    expect(r.waitMs).toBe(1000)
  })

  test('第 2 次退避 2000ms (2s) + jitter', () => {
    const r = computeReconnectBackoff({ attempt: 2, random: fixedRandom })
    expect(r.waitMs).toBe(2000)
  })

  test('第 3 次退避 4000ms (4s) + jitter', () => {
    const r = computeReconnectBackoff({ attempt: 3, random: fixedRandom })
    expect(r.waitMs).toBe(4000)
  })

  test('第 4 次退避 8000ms (8s) + jitter', () => {
    const r = computeReconnectBackoff({ attempt: 4, random: fixedRandom })
    expect(r.waitMs).toBe(8000)
  })

  test('第 5 次退避 16000ms (16s) + jitter（max）', () => {
    const r = computeReconnectBackoff({ attempt: 5, random: fixedRandom })
    expect(r.waitMs).toBe(16000)
  })

  test('第 6 次 attempt > max(5) → shouldRetry=false', () => {
    const r = computeReconnectBackoff({ attempt: 6, random: fixedRandom })
    expect(r.shouldRetry).toBe(false)
    expect(r.waitMs).toBe(0)
  })

  test('jitter 范围 [0, 500ms)', () => {
    // random()=0.5 → jitter=250
    const r = computeReconnectBackoff({ attempt: 1, random: () => 0.5 })
    expect(r.waitMs).toBe(1250)
  })

  test('随机源 0.99 → 接近 max jitter', () => {
    const r = computeReconnectBackoff({ attempt: 1, random: () => 0.99 })
    // 1000 + 0.99 * 500 = 1000 + 495 = 1495
    expect(r.waitMs).toBe(1495)
  })

  test('自定义 maxBackoffMs 截断（10s）', () => {
    const r = computeReconnectBackoff({
      attempt: 5,
      maxBackoffMs: 10_000,
      random: fixedRandom
    })
    // 16s 截到 10s
    expect(r.waitMs).toBe(10_000)
  })

  test('自定义 maxAttempts（3）', () => {
    const r1 = computeReconnectBackoff({ attempt: 3, maxAttempts: 3, random: fixedRandom })
    expect(r1.shouldRetry).toBe(true)
    const r2 = computeReconnectBackoff({ attempt: 4, maxAttempts: 3, random: fixedRandom })
    expect(r2.shouldRetry).toBe(false)
  })
})

// ======================== shouldReportHealth ========================

describe('shouldReportHealth 60s 周期上报触发', () => {
  test('ONLINE → true', () => {
    expect(shouldReportHealth(DtuState.ONLINE)).toBe(true)
  })

  test('DEGRADED → true', () => {
    expect(shouldReportHealth(DtuState.DEGRADED)).toBe(true)
  })

  test('CONNECTING → false', () => {
    expect(shouldReportHealth(DtuState.CONNECTING)).toBe(false)
  })

  test('HANDSHAKING → false', () => {
    expect(shouldReportHealth(DtuState.HANDSHAKING)).toBe(false)
  })

  test('INITIALIZING → false', () => {
    expect(shouldReportHealth(DtuState.INITIALIZING)).toBe(false)
  })

  test('RECONNECTING → false', () => {
    expect(shouldReportHealth(DtuState.RECONNECTING)).toBe(false)
  })

  test('RESTARTING → false', () => {
    expect(shouldReportHealth(DtuState.RESTARTING)).toBe(false)
  })

  test('OFFLINE → false', () => {
    expect(shouldReportHealth(DtuState.OFFLINE)).toBe(false)
  })
})
