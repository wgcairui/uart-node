/**
 * Socket.IO 事件名 + payload 类型（UartNode ↔ uart-server 契约）
 *
 * 现有 13 个事件名**保持稳定**——server 端契约不能破坏。
 * v4 新增 3 个事件（dtuState / dtuHealth / dtuAlert）需 server 端实现。
 *
 * payload 类型**优先**用 types/uart.d.ts 已有定义（queryObjectServer / registerConfig 等），
 * v4 新增字段在文件末尾独立定义。
 *
 * 跟 uart-pesiv-node 风格对齐（EVENT 常量 + EventName union + 集中类型），
 * 但保留 UartNode 独有的 3 个分桶语义（EVENT_TCP / EVENT_SOCKET / EVENT_SERVER）——
 * 分桶对当前业务有明确意义（区分"node↔server 通信"vs"TCP 路径派发"），
 * 暂时保留分桶**和**新平铺 EVENT 同时存在（PR #5 重构时再统一）。
 */

// ======================== 现有 13 个事件（保持稳定）========================

/** Node -> Server: 设备上线 */
export const EVENT_NODE_TERMINAL_ON = 'terminalOn' as const
/** Node -> Server: 设备下线 */
export const EVENT_NODE_TERMINAL_OFF = 'terminalOff' as const
/** Node -> Server: 设备挂载节点查询超时 */
export const EVENT_NODE_TERMINAL_MOUNT_DEV_TIMEOUT = 'terminalMountDevTimeOut' as const
/** Node -> Server: 设备指令超时 */
export const EVENT_NODE_INSTRUCT_TIMEOUT = 'instructTimeOut' as const

/** Node -> Server: 节点注册 */
export const EVENT_NODE_REGISTER = 'register' as const
/** Node -> Server: 操作设备状态指令 ack */
export const EVENT_NODE_INSTRUCT_QUERY = 'instructQuery' as const
/** Node -> Server: DTU AT 指令 ack */
export const EVENT_NODE_DTUOPRATE = 'DTUoprate' as const

/** Server -> Node: 鉴权通过（首次连接时） */
export const EVENT_SERVER_ACCONT = 'accont' as const
/** Server -> Node: 节点注册成功 */
export const EVENT_SERVER_REGISTER_SUCCESS = 'registerSuccess' as const
/** Server -> Node: TCP 服务就绪 */
export const EVENT_SERVER_READY = 'ready' as const
/** Server -> Node: 设备数据查询（server 周期下发） */
export const EVENT_SERVER_QUERY = 'query' as const
/** Server -> Node: 每分钟心跳（server 拉 nodeInfo） */
export const EVENT_SERVER_NODE_INFO = 'nodeInfo' as const

/** Node -> Server: ioOnResult 响应（带回包的事件） */
export const EVENT_NODE_RESULT = 'result' as const

// ======================== v4 新增 3 个事件（cairui 拍板 2026-06-15）========================

/** Node -> Server: 每次状态转换（UartNode RFC 002 §12.4） */
export const EVENT_NODE_DTU_STATE = 'dtuState' as const
/** Node -> Server: 每 60s 健康度上报（ONLINE / DEGRADED 状态才发） */
export const EVENT_NODE_DTU_HEALTH = 'dtuHealth' as const
/** Node -> Server: 4 类错误告警（AT_TIMEOUT / INVALID_REGISTER / PROFILE_CACHE_FAIL / FATAL） */
export const EVENT_NODE_DTU_ALERT = 'dtuAlert' as const

// ======================== 全部事件名 union type（TypeScript 强类型）========================

/** 所有 Node -> Server 事件名 */
export type NodeEventName =
  | typeof EVENT_NODE_TERMINAL_ON
  | typeof EVENT_NODE_TERMINAL_OFF
  | typeof EVENT_NODE_TERMINAL_MOUNT_DEV_TIMEOUT
  | typeof EVENT_NODE_INSTRUCT_TIMEOUT
  | typeof EVENT_NODE_REGISTER
  | typeof EVENT_NODE_INSTRUCT_QUERY
  | typeof EVENT_NODE_DTUOPRATE
  | typeof EVENT_NODE_RESULT
  | typeof EVENT_NODE_DTU_STATE
  | typeof EVENT_NODE_DTU_HEALTH
  | typeof EVENT_NODE_DTU_ALERT

/** 所有 Server -> Node 事件名 */
export type ServerEventName =
  | typeof EVENT_SERVER_ACCONT
  | typeof EVENT_SERVER_REGISTER_SUCCESS
  | typeof EVENT_SERVER_READY
  | typeof EVENT_SERVER_QUERY
  | typeof EVENT_SERVER_NODE_INFO

/** 所有事件名（双向） */
export type EventName = NodeEventName | ServerEventName

// ======================== 向后兼容的旧分桶（PR #5 之前保留）========================

/** @deprecated 旧分桶——保留是因为 config.ts 还引用，PR #5 重命名时一起动 */
export const EVENT_TCP = {
  terminalOn: EVENT_NODE_TERMINAL_ON,
  terminalOff: EVENT_NODE_TERMINAL_OFF,
  terminalMountDevTimeOut: EVENT_NODE_TERMINAL_MOUNT_DEV_TIMEOUT,
  instructOprate: 'instructOprate' as const,    // 已废弃——server 端不接
  terminalMountDevTimeOutRestore: 'terminalMountDevTimeOutRestore' as const,  // 同上
  instructTimeOut: EVENT_NODE_INSTRUCT_TIMEOUT
} as const

/** @deprecated 旧分桶——保留是因为 config.ts 还引用 */
export const EVENT_SOCKET = {
  register: EVENT_NODE_REGISTER,
  registerSuccess: EVENT_SERVER_REGISTER_SUCCESS,
  query: EVENT_SERVER_QUERY,
  ready: EVENT_SERVER_READY,
  startError: 'startError' as const,   // server 端暂未 emit
  alarm: 'alarm' as const               // server 端暂未 emit
} as const

/** @deprecated 旧分桶——保留是因为 config.ts 还引用 */
export const EVENT_SERVER = {
  instructQuery: EVENT_NODE_INSTRUCT_QUERY,
  DTUoprate: EVENT_NODE_DTUOPRATE
} as const

// ======================== v4 新增 payload 类型（cairui 拍板 2026-06-15）========================

/** 8 个生命周期状态（UartNode RFC 002 §12.1） */
export type DtuState =
  | 'CONNECTING'
  | 'HANDSHAKING'
  | 'INITIALIZING'
  | 'ONLINE'
  | 'DEGRADED'
  | 'RECONNECTING'
  | 'RESTARTING'
  | 'OFFLINE'

/** dtuState 事件 payload（latest-wins 覆盖，cairui 拍板） */
export interface DtuStateEvent {
  mac: string
  from: DtuState
  to: DtuState
  score: number
  reason: string           // free string, ≤ 64 字符, 不能为空（cairui 拍板）
  timestamp: number
}

/** dtuHealth 事件 payload（每 60s, ONLINE/DEGRADED 状态才发） */
export interface DtuHealthEvent {
  mac: string
  score: number
  health: {
    lastCommAt: number
    consecutiveSuccesses: number
    consecutiveFailures: number
    queryTimeoutCount: number
    totalRestarts: number
    totalReconnects: number
    signal: number          // 0-31
  }
  timestamp: number
}

/** dtuAlert 事件 4 类枚举（cairui 拍板 2026-06-15） */
export type AlertType =
  | 'AT_TIMEOUT'         // §3.7.4: AT 连续 3 次超时
  | 'INVALID_REGISTER'   // §3.7.4: 非注册包连接（mac: null）
  | 'PROFILE_CACHE_FAIL' // §3.7.4: profile cache 拉/写连续 5 次失败
  | 'FATAL'              // §3.7.4: 进程级 fatal（main 兜底, mac: null）

/** dtuAlert 事件 payload（FATAL 走 dtuAlert 不抽 alarm, 5min 去重, cairui 拍板） */
export interface DtuAlertEvent {
  mac: string | null       // INVALID_REGISTER / FATAL 时为 null
  type: AlertType
  message: string          // Node 端拼好（RFC 002 §3.7.3 格式）
  context?: Record<string, unknown>  // 额外上下文（remoteAddr / firstPacket / stack）
  timestamp: number
}

// ======================== ioOnResult 兼容（保留 src/IO.ts:63 已用接口）========================

/** ioOnResult 触发事件 wrapper（server -> node 通过 event 包一层 {eventName, data}） */
export interface EventData {
  eventName: string
  data?: unknown
}
