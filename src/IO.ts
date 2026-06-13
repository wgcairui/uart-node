import socketClient from "socket.io-client";
import { IO_CONFIG, NODE_TOKEN } from "./config";

/**
 * 连接到uartServer的IO对象
 */
console.log(`连接socket服务器:${IO_CONFIG.uri}`);

// PR #20 鉴权：Socket.IO 握手三通道（与 uart-pesiv-node io-client.ts 对齐）
// - auth.token:    推荐通道，websocket 握手也能用
// - query.token:   备选通道，server 端 ?token= 也认
// - extraHeaders:  polling 通道用，握手阶段的 x-node-token header
// - transportOptions: 4.5+ 修复了 websocket 阶段 extraHeaders 失效的 bug，4.7.5 已经默认带
const IOClient = socketClient(IO_CONFIG.uri, {
    path: IO_CONFIG.path,
    auth: NODE_TOKEN ? { token: NODE_TOKEN } : undefined,
    query: NODE_TOKEN ? { token: NODE_TOKEN } : undefined,
    extraHeaders: NODE_TOKEN ? { 'x-node-token': NODE_TOKEN } : undefined,
    transportOptions: {
        polling: { extraHeaders: { 'x-node-token': NODE_TOKEN } },
        websocket: { extraHeaders: { 'x-node-token': NODE_TOKEN } }
    }
});
IOClient
    //断开连接时触发
    .on("disconnect", (reason: string) => console.log(`${reason},socket连接已丢失，取消发送运行数据`))
    // 发生错误时触发
    .on("error", (error: Error) => { console.log("error:", error.message) })
    // 无法在内部重新连接时触发
    .on('reconnect_failed', () => { console.log('reconnect_failed') })
    // 重新连接尝试错误时触发
    .on('reconnect_error', (error: Error) => { console.log("reconnect_error:", error.message) })
    // 尝试重新连接时触发
    .on('reconnecting', (attemptNumber: number) => console.log({ 'reconnecting': attemptNumber }))
    // 重新连接成功后触发
    .on('reconnect', (attemptNumber: number) => {
        console.log({ 'reconnect': attemptNumber });
        // 重连后要把 NODE_TOKEN 状态打出来，方便对账 server 端
        const opts = (IOClient.io as any).opts as { auth?: { token?: string }; query?: { token?: string } };
        const hasToken = Boolean(opts.auth?.token) || Boolean(opts.query?.token);
        console.log(`[io] reconnected: token=${hasToken ? 'present' : 'MISSING'}`);
    })
    // 连接超时
    .on('connect_timeout', (timeout: number) => console.log({ 'connect_timeout': timeout }))
    // 连接出错（PR #20: server 端握手失败会 reject，错误原因从 err.data 拿）
    .on('connect_error', (error: Error) => {
        const detail = (error as Error & { data?: unknown }).data;
        console.log("connect_error:", error.message, detail !== undefined ? `(data=${JSON.stringify(detail)})` : '');
    })

export default IOClient

interface eventData {
    eventName: string
    data?: any
}

/**
 * 监听事件,返回数据
 * @param event 
 * @param fn 
 */
export const ioOnResult = async (event: string, fn: (data?: any) => Promise<any>) => {
    IOClient.on(event, ({ eventName, data }: eventData) => {
        fn(data).then(r => {
            IOClient.emit("result", eventName, r)
        })
    })
}
