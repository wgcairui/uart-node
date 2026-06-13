import config from "./config"
import { registerConfig, queryObjectServer, instructQuery, DTUoprate } from "uart"
import IOClient from "./IO"
import TcpServer from "./TcpServer"
import tool from "./tool"
import fetch from "./fetch"

let tcpServer: TcpServer

IOClient
    // 连接成功,触发node注册,发送node信息
    .on("connect", () => {
        console.log(`${new Date().toLocaleString()}:已连接到UartServer:${config.ServerHost},socketID:${IOClient.id},`);
        console.log(`已连接到UartServer:${config.ServerHost},socketID:${IOClient.id},`);
    })
    .on("accont", () => {
        IOClient.emit("register", tool.NodeInfo());
    })
    // 注册成功,初始化TcpServer
    .on(config.EVENT_SOCKET.registerSuccess, (data: registerConfig) => {
        console.log({ registerConfig: data });

        register(data)
    })
    //断开连接时触发    
    .on("disconnect", (reason: string) => {
        /* tcpServer.close()
        tcpServer. */
    })
    // 接受查询指令
    .on(config.EVENT_SOCKET.query, (Query: queryObjectServer) => {
        Query.DevMac = Query.mac
        tcpServer.Bus('QueryInstruct', Query)
    })

    // 终端设备操作指令
    .on(config.EVENT_SERVER.instructQuery, (Query: instructQuery) => {
        tcpServer.Bus('OprateInstruct', Query)
    })

    // 发送终端设备AT指令
    .on(config.EVENT_SERVER.DTUoprate, async (Query: DTUoprate) => {
        tcpServer.Bus("ATInstruct", Query as DTUoprate)
    })

    // 服务器要求发送查询节点运行状态
    .on("nodeInfo", async (name: string) => {
        const node = tool.NodeInfo()
        const tcp = await tcpServer.getConnectionsAsync()
        fetch.nodeInfo(name, node, tcp)
    })

/**
 * 注册dtu
 * @param data dtu注册信息
 */
function register(data: registerConfig) {
    console.log('进入TcpServer start流程');
    if (tcpServer) {
        console.log('TcpServer实例已存在');
        // 重新注册终端
        IOClient.emit(config.EVENT_TCP.terminalOn, tcpServer.getOnlineDtu(), false)
    } else {
        // 根据节点注册信息启动TcpServer
        tcpServer = new TcpServer(data);
    }
    // 等待10秒,等待终端连接节点,然后告诉服务器节点已准备就绪
    setTimeout(() => {
        IOClient.emit(config.EVENT_SOCKET.ready)
    }, 10000)
}

