import config, { IO_CONFIG } from "./config"
import { type registerConfig, type queryObjectServer, type instructQuery, type DTUoprate, type ApolloMongoResult } from "uart"
import { getIOClient } from "./services/io-client"
import TcpServer from "./server/tcp-server"
import { nodeInfo } from "./services/dtu-info"
import fetch from "./fetch"
import {
  EVENT_SERVER_ACCONT,
  EVENT_SERVER_REGISTER_SUCCESS,
  EVENT_SERVER_QUERY,
  EVENT_SERVER_NODE_INFO,
  EVENT_NODE_TERMINAL_ON,
  EVENT_NODE_REGISTER,
  EVENT_SERVER_READY,
  EVENT_NODE_INSTRUCT_QUERY,
  EVENT_NODE_DTUOPRATE,
  EVENT_SERVER_GET_SOCKET_MAPS,
} from "./protocol/events"

let tcpServer: TcpServer

// PR #1: 删 src/IO.ts, main.ts 改用 getIOClient() (新 IOClient class + factory)
// 老 IOClient (src/IO.ts) 跟新 IOClient (src/services/io-client.ts) 双重实例共存导致
// server 端同 room 2 个 socket, 1 响应 1 不响应. 删 src/IO.ts 根除.
// 跨仓 ship 协调见 midwayuartserver 仓库 docs/architecture/v3-node-authority.md
const io = getIOClient()

// 老 .on("connect") / .on("disconnect") 不再需要 - 新 IOClient.bindLifecycle() 自动处理
// (uart-pesiv-node src/main.ts 同模式, 详见 CLAUDE.md "v3 跨仓 ship 协调")

io.on(EVENT_SERVER_ACCONT, () => {
    // server 端 accont 通知: 发送 register 触发注册流程
    io.register(nodeInfo())
})

// 注册成功,初始化TcpServer
io.on(EVENT_SERVER_REGISTER_SUCCESS, (data: registerConfig) => {
    console.log({ registerConfig: data });

    register(data)
})

// 接受查询指令
io.on(EVENT_SERVER_QUERY, (Query: queryObjectServer) => {
    Query.DevMac = Query.mac
    tcpServer.bus('QueryInstruct', Query)
})

// 终端设备操作指令
io.on(EVENT_NODE_INSTRUCT_QUERY, (Query: instructQuery) => {
    tcpServer.bus('OprateInstruct', Query)
})

// 发送终端设备AT指令
// 2026-07-14: server 端 OprateDTU 走 emit-with-ack 新协议,期望 Node 端
// 在 AT 响应后调 ack(result) 第三参数,否则 server 10s timeout 兜底报
// "Node 端在 10000ms 内未响应 (operation has timed out)".
// 老协议 `dtuopratesuccess` 事件仍保留 (server event.once 路径) 做向后兼容
io.onAck<DTUoprate, Partial<ApolloMongoResult>>(
    EVENT_NODE_DTUOPRATE,
    async (Query: DTUoprate, ack?: (result: Partial<ApolloMongoResult>) => void) => {
        tcpServer.bus("ATInstruct", Query as DTUoprate, ack)
    }
)

// 服务器要求发送查询节点运行状态
io.on(EVENT_SERVER_NODE_INFO, async (name: string) => {
    const node = nodeInfo()
    const tcp = await tcpServer.getConnectionsAsync()
    fetch.nodeInfo(name, node, tcp)
})

// v3 架构 (2026-07-18): server 端 5min cron 主动 query Node 端 device list
// 跟现有 DTUoprate onAck 模式完全一致, ack 响应 { ok, socketMaps: [...] }
// server 端 NodeSyncReconciler 5min cron emit 'getSocketMaps', 10s timeout per node
// 失败/timeout 节点 server 端会跳过 (留兜底 staleness 处理, 跟 980612c ship 兼容)
// 跟 server 端 `socket.timeout(10000).emit('getSocketMaps', {}, ack)` 配对
// - nodeName 字段不返 (server 端从 mongo node.clients 拿, 不需要 Node 端告知)
io.onAck<unknown, { ok: number; msg?: string; socketMaps: Array<{ mac: string; port: number; ip: string }> }>(
    EVENT_SERVER_GET_SOCKET_MAPS,
    (_payload: unknown, ack?: (result: { ok: number; msg?: string; socketMaps: Array<{ mac: string; port: number; ip: string }> }) => void) => {
        try {
            const socketMaps = tcpServer.getActiveDevices()
            if (ack) ack({ ok: 1, socketMaps })
        } catch (err) {
            if (ack) ack({ ok: 0, msg: (err as Error).message, socketMaps: [] })
        }
    }
)

/**
 * 注册dtu
 * @param data dtu注册信息
 */
function register(data: registerConfig) {
    console.log('进入TcpServer start流程');
    if (tcpServer) {
        console.log('TcpServer实例已存在');
        // 重新注册终端
        io.terminalOn(tcpServer.getOnlineDtu() as unknown as string, false)
    } else {
        // 根据节点注册信息启动TcpServer
        tcpServer = new TcpServer(data);
        // PR #5 class 化的 TcpServer 需要显式 listen()（老 TcpServer 构造里隐式 listen）
        tcpServer.listen().catch(err => console.error('TcpServer listen failed:', err));
    }
    // 等待10秒,等待终端连接节点,然后告诉服务器节点已准备就绪
    setTimeout(() => {
        io.ready()
    }, 10000)
}
