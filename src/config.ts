/**
 * 全局配置 — 全 env 驱动
 *
 * 跟 uart-pesiv-node/src/config.ts 风格对齐：
 *   - process.env.X ?? 'default'  模式
 *   - 不引入 isProd / NODE_ENV 等"环境模式"判断（那是 bun build DCE 的雷区）
 *   - dev fallback 是 localhost:9010
 *
 * Bun 会自动注入 process.env，container 启动时通过 -e 或 docker-compose env 注入即可。
 * Dockerfile 不写 ARG/ENV 注入任何敏感值（如 NODE_TOKEN），会进镜像层。
 */

/**
 * Socket.IO 客户端配置
 * - uri:  完整 ws url（含 namespace）
 * - path: socket.io endpoint path（server 端挂在 /client）
 */
export const IO_CONFIG = {
  uri: process.env.IO_URI ?? 'http://localhost:9010/node',
  path: process.env.IO_PATH ?? '/client'
} as const

/**
 * HTTP /api/node/* 上传基础 URL（fetch.ts 用）
 */
export const SERVER_URL: string = process.env.SERVER_URL ?? 'http://localhost:9010/api/node/'

/**
 * Node 身份令牌（明文）
 *
 * 对应 uart-server PR #20 (feat(node-auth)) 鉴权：
 * - Socket.IO 握手走 auth.token / query.token / x-node-token header 三通道
 * - HTTP /api/node/* 走 x-node-token header（fetch.ts 注入）
 * - 部署流程：server 端先合 PR #20 -> admin rotate-token 拿明文 -> 写进 Node 的 NODE_TOKEN env
 *
 * 没设 NODE_TOKEN 时只 warn 不中断（与 uart-pesiv-node 行为一致），
 * 等 server 端 PR #20 部署后再强制。
 */
export const NODE_TOKEN: string = (process.env.NODE_TOKEN ?? '').trim()

if (!NODE_TOKEN) {
  console.warn(
    '[config] NODE_TOKEN not set. ' +
      'If server has merged PR #20, this node will be rejected. ' +
      'Get a token via POST /api/v2/admin/dashboard/nodes/:name/rotate-token'
  )
}

export default {
  /** Socket.IO 配置 */
  IO: IO_CONFIG,
  /** HTTP 上行基础 URL */
  ServerApi: SERVER_URL,
  ApiPath: {
    uart: '/UartData',
    runNode: '/RunData'
  },
  EVENT_TCP: {
    terminalOn: 'terminalOn',
    terminalOff: 'terminalOff',
    terminalMountDevTimeOut: 'terminalMountDevTimeOut',
    terminalMountDevTimeOutRestore: 'terminalMountDevTimeOutRestore',
    instructOprate: 'instructOprate',
    instructTimeOut: 'instructTimeOut'
  },
  EVENT_SOCKET: {
    register: 'register',
    registerSuccess: 'registerSuccess',
    query: 'query',
    ready: 'ready',
    startError: 'startError',
    alarm: 'alarm'
  },
  EVENT_SERVER: {
    instructQuery: 'instructQuery',
    DTUoprate: 'DTUoprate'
  },
  /** 监听 ip */
  localhost: '0.0.0.0',
  /** 监听端口 */
  localport: 9000,
  /** dtu 连接超时 */
  timeOut: 1000 * 60 * 5,
  /** dtu 查询超时 */
  queryTimeOut: 1500,
  /** dtu 查询超时次数 */
  queryTimeOutNum: 10,
  /** dtu 查询超时重启时间 */
  queryTimeOutReload: 1000 * 60,
  /** 在线设备数（运行时累加） */
  count: 0
}
