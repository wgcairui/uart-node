const isProd = process.env.NODE_ENV === "production";

const server = process.env.TEST_SERVER_HOST || "http://localhost:9010"

/**
 * Node 身份令牌（明文）
 *
 * 对应 uart-server PR #20 (feat(node-auth)) 鉴权：
 * - Socket.IO 握手走 auth.token / query.token / x-node-token header 三通道
 * - HTTP /api/node/* 走 x-node-token header（axios 改原生 fetch 后注入）
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
  /**
   * uartServer地址,用于socket连接
   */
  ServerHost: isProd ? "http://uart.ladishb.com:9010" : server,
  /**
   * uartServerApi地址,用于发送查询结果数据和节点运行数据
   */
  ServerApi: isProd ? "https://uart.ladishb.com/api/node/" : server+"/api/node/",
  ApiPath: {
    uart: "/UartData",
    runNode: "/RunData",
  },
  EVENT_TCP: {
    terminalOn: "terminalOn", // 终端设备上线
    terminalOff: "terminalOff", // 终端设备下线
    terminalMountDevTimeOut: "terminalMountDevTimeOut", // 设备挂载节点查询超时
    terminalMountDevTimeOutRestore: "terminalMountDevTimeOutRestore", // 设备挂载节点查询超时
    instructOprate: 'instructOprate', // 协议操作指令
    instructTimeOut: 'instructTimeOut', // 设备指令超时

  },
  EVENT_SOCKET: {
    register: "register", // 节点注册
    registerSuccess: "registerSuccess", // 节点注册成功
    query: "query", // 服务器查询请求
    ready: "ready", // 启动Tcp服务成功
    startError: "startError", // 启动Tcp服务出错
    alarm: "alarm", // 节点告警事件
  },
  EVENT_SERVER: {
    instructQuery: "instructQuery", // 操作设备状态指令
    'DTUoprate': 'DTUoprate' // DTU AT指令
  },
  /**
   * 监听ip
   */
  localhost: "0.0.0.0",
  /**
   * 监听端口
   */
  localport: 9000,
  /**
   * dtu连接超时
   */
  timeOut: 1000 * 60 * 5,
  /**
   * dtu查询超时
   */
  queryTimeOut: 1500,
  /**
   * dtu查询超时次数
   */
  queryTimeOutNum: 10,
  /**
   * dtu查询超时重启时间
   */
  queryTimeOutReload: 1000 * 60,
  // 记录在线设备数
  count: 0
};
