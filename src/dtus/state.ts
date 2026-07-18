/**
 * DTU 生命周期状态机 + 健康度评分（UartNode RFC 002 §12）
 *
 * 跟 src/protocol/events.ts 的 DtuState / DtuStateEvent / DtuHealthEvent / DtuAlertEvent / AlertType
 * 类型对齐，但本文件是 **纯逻辑层**（纯函数 + enum），不依赖 socket.io / net / fetch。
 *
 * 设计要点（cairui 2026-06-15 拍板）：
 *   - 8 个显式状态（CONNECTING / HANDSHAKING / INITIALIZING / ONLINE / DEGRADED
 *     / RECONNECTING / RESTARTING / OFFLINE）
 *   - 健康度 0-100，computeHealth(h) 纯函数
 *   - 4 类 alert（AT_TIMEOUT / INVALID_REGISTER / PROFILE_CACHE_FAIL / FATAL）
 *   - dtuState 事件 latest-wins 覆盖（server 端按 mac 覆盖，不维护事件流）
 *   - dtubusy 跟 dtuState 是两条独立链路（dtubusy 是审计层不 emit socket 推前端）
 *   - server 端 5min 去重（同 mac+type+message 不重推）
 *
 * 集成：
 *   - src/dtus/base.ts 集成 DtuState 字段 + transition() + 3 个新事件 emit
 *   - src/services/io-client.ts 已有 dtuState / dtuHealth / dtuAlert 业务方法
 *   - 60s 周期上报：只在 ONLINE / DEGRADED 状态触发
 */

// ======================== DtuState enum ========================

/**
 * 8 个生命周期状态（RFC §12.1）
 *
 * 转换规则（RFC §12.2 转换表）：
 *   - 初始 → CONNECTING（TCP socket accepted）
 *   - CONNECTING → HANDSHAKING（注册包解析成功）
 *   - CONNECTING → OFFLINE（10s 无注册包）
 *   - HANDSHAKING → INITIALIZING（5 条必查 AT 全部返回）
 *   - HANDSHAKING → OFFLINE（AT 查询超时 > 30s）
 *   - INITIALIZING → ONLINE（第二层定时器启动成功）
 *   - ONLINE → DEGRADED（连续 3 次查询失败 / signal < 5）
 *   - DEGRADED → ONLINE（连续 5 次查询成功 / signal > 10）
 *   - ONLINE/DEGRADED → RECONNECTING（socket close + 非 ECONNRESET）
 *   - RECONNECTING → ONLINE（重连成功）
 *   - RECONNECTING → OFFLINE（重试 5 次失败 / 总等待 > 60s）
 *   - 任何状态 → RESTARTING（resatrtSocket / server 下发 AT+Z）
 *   - RESTARTING → ONLINE（60s 内收到注册包）
 *   - RESTARTING → OFFLINE（60s 内未重连）
 *   - 任何状态 → OFFLINE（socket.on('error') 且非断连重试）
 */
export enum DtuState {
  /** TCP socket accepted，等 10s 内注册包 */
  CONNECTING = 'CONNECTING',
  /** 注册包解析成功，等首次 AT 查询完成 */
  HANDSHAKING = 'HANDSHAKING',
  /** 第一层 AT 完成，terminalOn 上报，timer 启动 */
  INITIALIZING = 'INITIALIZING',
  /** 在线，缓存队列处理中（没有 query 堆积 / timeout）*/
  ONLINE = 'ONLINE',
  /** 在线但有 N 次连续失败（查询超时 / socket 抖动），还没掉线 */
  DEGRADED = 'DEGRADED',
  /** 重连中（被动断开后）*/
  RECONNECTING = 'RECONNECTING',
  /** 主动重启中（AT+Z 触发）*/
  RESTARTING = 'RESTARTING',
  /** 永久离线（放弃重连 / 重启失败 / server 主动踢）*/
  OFFLINE = 'OFFLINE'
}

// ======================== DtuHealth ========================

/**
 * DTU 健康度指标（RFC §12.3）
 * - score 由 computeHealth(h) 派生，0-100
 * - 其余字段是原始指标，用于 computeHealth 输入
 */
export interface DtuHealth {
  /** 0-100 健康度分数（computeHealth 派生） */
  score: number
  /** 最后一次成功通信时间戳（ms） */
  lastCommAt: number
  /** 连续成功计数 */
  consecutiveSuccesses: number
  /** 连续失败计数 */
  consecutiveFailures: number
  /** 累计查询超时次数 */
  queryTimeoutCount: number
  /** 累计硬重启次数 */
  totalRestarts: number
  /** 累计重连次数 */
  totalReconnects: number
  /** 当前 GPRS 信号强度（0-31） */
  signal: number
}

// ======================== computeHealth 纯函数 ========================

/**
 * 计算 DTU 健康度分数（RFC §12.3 算法）
 *
 * 起点 100
 *   - 最近通信时间扣分：每分钟无通信 -5，max -30
 *   - 信号弱扣分：< 5 扣 20 / < 10 扣 10 / < 15 扣 5
 *   - 连续失败扣分：每 +1 连续失败 -10，max -40
 *   - 重启次数扣分：每 +1 重启 -5，max -20
 *   - 范围 [0, 100]
 *
 * @param h 健康度原始指标（不含 score 字段）
 * @param now 当前时间戳（默认 Date.now()，可注入用于测试）
 * @returns 0-100 整数
 */
export function computeHealth(
  h: Omit<DtuHealth, 'score'>,
  now: number = Date.now()
): number {
  let score = 100
  // 最近通信时间扣分
  const minutesSinceComm = Math.floor((now - h.lastCommAt) / 60_000)
  score -= Math.min(30, minutesSinceComm * 5)
  // 信号弱扣分
  if (h.signal < 5) score -= 20
  else if (h.signal < 10) score -= 10
  else if (h.signal < 15) score -= 5
  // 连续失败扣分
  score -= Math.min(40, h.consecutiveFailures * 10)
  // 重启次数扣分
  score -= Math.min(20, h.totalRestarts * 5)
  return Math.max(0, Math.min(100, Math.round(score)))
}

// ======================== 健康度阈值 ========================

export const HEALTH_THRESHOLD_HEALTHY = 80
export const HEALTH_THRESHOLD_DEGRADED = 40

/**
 * 健康度区间（RFC §12.3 关键阈值）
 *   - score >= 80: 健康
 *   - 60-79:      轻度降级（打 log，不打 alarm）
 *   - 40-59:      严重降级（DEGRADED 状态 + 打 alarm）
 *   - < 40:       病危（触发 RESTARTING）
 *   - 0:          死亡（OFFLINE + 从 MacSocketMaps 删除）
 */
export type HealthTier = 'HEALTHY' | 'MILD_DEGRADED' | 'SEVERE_DEGRADED' | 'CRITICAL' | 'DEAD'

export function healthTier(score: number): HealthTier {
  if (score >= HEALTH_THRESHOLD_HEALTHY) return 'HEALTHY'
  if (score >= 60) return 'MILD_DEGRADED'
  if (score >= HEALTH_THRESHOLD_DEGRADED) return 'SEVERE_DEGRADED'
  if (score > 0) return 'CRITICAL'
  return 'DEAD'
}

// ======================== 状态转换表 ========================

/**
 * 合法转换集合（RFC §12.2 转换表，幂等：同状态不重复触发）
 *
 * 用 Set<string> 存储 `${from}->${to}` 字符串，比 nested Map 易读。
 */
const VALID_TRANSITIONS = new Set<string>([
  // 初始 → CONNECTING
  '->CONNECTING',
  // 注册路径
  'CONNECTING->HANDSHAKING',
  'CONNECTING->OFFLINE',
  // 初始化路径
  'HANDSHAKING->INITIALIZING',
  'HANDSHAKING->OFFLINE',
  'INITIALIZING->ONLINE',
  // PR #6: CellularDtu 一次性 8 条 AT 全查, HANDSHAKING → ONLINE 直转
  // (RFC §12.2 写的是 INITIALIZING → ONLINE, 但 §11.7 分层落地前一次性查完)
  // 留 INITIALIZING → ONLINE 给未来分层用
  'HANDSHAKING->ONLINE',
  // 健康度摆动
  'ONLINE->DEGRADED',
  'DEGRADED->ONLINE',
  'DEGRADED->DEGRADED',  // 允许 DEGRADED → DEGRADED（连续失败但还没恢复）
  // 重连路径
  'ONLINE->RECONNECTING',
  'DEGRADED->RECONNECTING',
  'RECONNECTING->ONLINE',
  'RECONNECTING->OFFLINE',
  // 重启路径
  'ONLINE->RESTARTING',
  'DEGRADED->RESTARTING',
  'RECONNECTING->RESTARTING',
  'RESTARTING->ONLINE',
  'RESTARTING->OFFLINE',
  // 任何状态 → OFFLINE（错误兜底）
  'CONNECTING->OFFLINE',
  'HANDSHAKING->OFFLINE',
  'INITIALIZING->OFFLINE',
  'ONLINE->OFFLINE',
  'DEGRADED->OFFLINE',
  'RECONNECTING->OFFLINE',
  'RESTARTING->OFFLINE',
  // 任何状态 → RESTARTING（AT+Z 触发）
  'INITIALIZING->RESTARTING',
  // PR #12 hotfix: OFFLINE 是 terminal state, 但 reConnectSocket 需要 recovery 路径
  // 之前漏: OFFLINE 不在 VALID_TRANSITIONS, transition(OFFLINE → ONLINE) 静默忽略
  // 8 天 staging 回归暴露 dtuStateLatest = 0 根因之一
  // OFFLINE → HANDSHAKING 跳过 CONNECTING (reConnectSocket 不重跑 sniffer, 直接进注册)
  'OFFLINE->HANDSHAKING'
])

/**
 * 检查状态转换是否合法（RFC §12.2 转换表）
 * 同状态转换允许（幂等），用于"已经 ONLINE 还想转 ONLINE"场景
 */
export function isValidTransition(from: DtuState, to: DtuState): boolean {
  return VALID_TRANSITIONS.has(`${from}->${to}`)
}

// ======================== 5 类 AlertType (PR #12 hotfix) ========================

/**
 * 5 个告警类型（cairui 2026-06-15 拍板 4 类 + 2026-06-26 hotfix 增 INVALID_STATE_TRANSITION）
 *
 * 触发位置（RFC §12.4.2）：
 *   - AT_TIMEOUT: client.run() 连续 3 次 AT 查询超时（src/dtus/base.ts:queryInstruct）
 *   - INVALID_REGISTER: sniff register 包解析失败（src/server/tcp-server.ts:onConnection）
 *   - PROFILE_CACHE_FAIL: /api/node/dtu-info-cache GET/POST 连续 5 次失败（PR #7 落地）
 *   - FATAL: 进程级 fatal（main.ts catch，mac: null）
 *   - INVALID_STATE_TRANSITION: state machine 非法转换（src/dtus/base.ts:transition, PR #12 hotfix）
 *
 * PR #12 hotfix 背景: 8 天 staging 回归暴露 dtuStateLatest = 0 (TTL 7d 自然过期 + Node bug 叠加),
 *   transition() 静默忽略 invalid + console.warn 导致 observability 断。
 *   升级到 console.error + emit alert, 让 server 下个 sprint PR A 落库可见。
 */
export type AlertType =
  | 'AT_TIMEOUT'
  | 'INVALID_REGISTER'
  | 'PROFILE_CACHE_FAIL'
  | 'FATAL'
  | 'INVALID_STATE_TRANSITION'

/**
 * DtuAlert payload（RFC §12.4）
 * - mac: string | null（INVALID_REGISTER / FATAL 时为 null）
 * - type: 4 类之一
 * - message: Node 端拼（RFC §3.7.3 格式 `[<layer>] <context>: <what>: <why>`）
 * - context?: 额外上下文（remoteAddr / firstPacket / stack）
 * - timestamp: ms
 */
export interface DtuAlert {
  mac: string | null
  type: AlertType
  message: string
  context?: Record<string, unknown>
  timestamp: number
}

// ======================== 重连退避 ========================

/**
 * 重连退避算法（RFC §12.5）
 *
 * 关键：UartNode 不能主动 dial DTU（DTU 在 NAT 后），
 * 所以退避是"server 侧等待"，不是 socket 主动重拨。
 *
 * 算法：baseMs = min(16_000, 1000 * 2^(attempt-1)) + jitter(0-500ms)
 *   - 第 1 次：1s + jitter
 *   - 第 2 次：2s + jitter
 *   - 第 3 次：4s + jitter
 *   - 第 4 次：8s + jitter
 *   - 第 5 次：16s + jitter (max)
 */
export const MAX_RECONNECT_ATTEMPTS = 5
export const MAX_RECONNECT_WAIT_MS = 60_000
export const MAX_RECONNECT_BACKOFF_MS = 16_000

export interface ReconnectBackoffParams {
  attempt: number          // 1-based
  maxAttempts?: number
  maxBackoffMs?: number
  random?: () => number     // 注入用于测试（默认 Math.random）
}

export function computeReconnectBackoff({
  attempt,
  maxAttempts = MAX_RECONNECT_ATTEMPTS,
  maxBackoffMs = MAX_RECONNECT_BACKOFF_MS,
  random = Math.random
}: ReconnectBackoffParams): { waitMs: number; shouldRetry: boolean } {
  if (attempt > maxAttempts) {
    return { waitMs: 0, shouldRetry: false }
  }
  const baseMs = Math.min(maxBackoffMs, 1000 * 2 ** (attempt - 1))
  const jitter = random() * 500
  return { waitMs: Math.round(baseMs + jitter), shouldRetry: true }
}

// ======================== 上报间隔 ========================

/** dtuHealth 周期上报间隔（RFC §12.4：每 60s 一次，ONLINE/DEGRADED 才发） */
export const HEALTH_REPORT_INTERVAL_MS = 60_000

/**
 * 判断 dtuHealth 周期上报是否应该触发
 * - ONLINE / DEGRADED：true
 * - 其它状态：false
 */
export function shouldReportHealth(state: DtuState): boolean {
  return state === DtuState.ONLINE || state === DtuState.DEGRADED
}
