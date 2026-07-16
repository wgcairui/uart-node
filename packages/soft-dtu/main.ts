/**
 * 软 DTU 主入口（Deno Desktop）
 *
 * 启动顺序：
 *   1. 加载配置（虚拟 IMEI / PID / VER / 串口参数 / server URL）
 *   2. 启动 transport 层（TCP 连 UartNode + 串口 + HTTP client 拉协议）
 *   3. 启动 protocol 层（4G DTU 行为模拟）
 *   4. 注册 bindings（暴露给 WebView 前端）
 *   5. 启动 WebView（deno desktop 命令会接管这一步，本文件提供 main 逻辑）
 *
 * 跟 UartNode 对接（数据通道，跟普通硬件 DTU 一样）：
 *   - 软 DTU 不知道 UartNode 长啥样，只知道"4G 协议"那套契约
 *   - UartNode 不知道软 DTU 是真的还是假的，只当普通 DTU
 *   - 走 TCP 9000 + 'register&mac=<虚拟IMEI>&host=...' + '+++AT+' 协议
 *   - IMEI 后 12 位当 mac（跟硬件 DTU 完全一样）
 *
 * 跟 uart-server 对接（元数据通道，HTTP API，不鉴权）：
 *   - 走 GET /api/v2/protocols 拉协议定义
 *   - 不连 Socket.IO（Cairui 2026-07-14 16:29 拍板）
 *   - server 端 agent-ae682922673b 待加 API 端点
 *
 * 跟姊妹项目 uart-pesiv-node 关系：
 *   - 完全独立
 *   - 不共享配置 / socket.io 封装
 *   - UartNode=Bun, 软 DTU=Deno, pesiv=Bun 三者 runtime 都不同
 *
 * Phase 1 任务：
 *   Day 1: 本文件 + 协议层 + transport 层 + bindings 层（已写）
 *   Day 2-3: protocol/cellular-dtu.ts 跟 UartNode TCP 握手 + 8 条 AT 响应跑通
 *   Day 4-5: webview/ 骨架（Vite + Preact）+ 4 个面板 + HTTP API stub（已写）
 *   Day 6: 集成测试（端到端跑通 8 条 AT + 串口 + WebView UI）
 *   Day 7: 修 B-level issues + 补单元测试
 */

import { loadConfig, type SoftDtuConfig } from "./src/protocol/config.ts";
import { CellularDtu } from "./src/protocol/cellular-dtu.ts";
import { TcpTransport } from "./src/transport/tcp.ts";
import { SerialTransport, listSerialPorts } from "./src/transport/serial.ts";
import { registerSerialBindings } from "./src/bindings/serial.ts";
import { ProtocolRepository } from "./src/protocol/protocol-catalog.ts";
import { registerProtocolBindings } from "./src/bindings/protocol.ts";
import { startHttpApi } from "./src/server/http-api.ts";

console.log("[soft-dtu] starting...");
console.log(`[soft-dtu] deno: ${Deno.version.deno}`);
console.log(`[soft-dtu] v8: ${Deno.version.v8}`);
console.log(`[soft-dtu] typescript: ${Deno.version.typescript}`);

const config: SoftDtuConfig = await loadConfig();
console.log(`[soft-dtu] config: mac=${config.virtualImei.slice(-12)} pid=${config.pid} ver=${config.ver}`);

// 1. 串口 transport（dev 上不一定插了，先 list 一遍看）
try {
  const ports = await listSerialPorts();
  console.log(`[soft-dtu] serial ports available: ${ports.length}`);
  for (const p of ports) {
    console.log(`  - ${p.path} (${p.manufacturer ?? "?"} ${p.productId ?? ""})`);
  }
} catch (err) {
  console.warn(`[soft-dtu] serial list failed:`, err);
}

// 2. TCP transport 连 UartNode（数据通道，跟普通硬件 DTU 一样）
const tcp = new TcpTransport({
  host: config.uartNode.host,
  port: config.uartNode.port,
});
tcp.on("log", (msg) => console.log(`[tcp] ${msg}`));

// 3. 串口 transport（默认不开，等 UI 触发）
const serial = new SerialTransport();

// 4. 协议仓库（HTTP API 拉协议定义，元数据通道，不鉴权）
//    baseUrl 只放 origin，path `/api/v2/protocols` 在 ProtocolRepository 内部拼
//    （之前 `${url}${apiPath}` + 内部 `/api/v2/protocols` 会拼成 `/api/v2/api/v2/protocols`）
const protocolRepo = new ProtocolRepository({
  baseUrl: config.uartServer.url,
  apiPath: config.uartServer.apiPath,
  timeoutMs: config.uartServer.timeoutMs,
});

// 5. 4G DTU 协议模拟
const dtu = new CellularDtu({
  config,
  tcp,
});
dtu.on("log", (msg) => console.log(`[dtu] ${msg}`));

// 6. 注册 IPC bindings（暴露给 WebView 前端）
const serialBindings = registerSerialBindings(serial);
const protocolBindings = registerProtocolBindings(protocolRepo);

// 6.5 Phase 1: 启动 HTTP API server（包装 bindings，WebView 走 fetch 调过来）
//   Phase 2 切 Deno Desktop bindings SDK 后可以删
//   默认 127.0.0.1:8080，env 覆盖：SOFT_DTU_HTTP_HOST / SOFT_DTU_HTTP_PORT
const httpHost = Deno.env.get("SOFT_DTU_HTTP_HOST") ?? "127.0.0.1";
const httpPort = Number(Deno.env.get("SOFT_DTU_HTTP_PORT") ?? 8080);
startHttpApi({ host: httpHost, port: httpPort }, serialBindings, protocolBindings);

// 7. 启动时拉协议（fire-and-forget，失败走 offline fallback）
//    UI 启动不预选协议（Cairui 2026-07-14 16:35 拍板），让用户手动选
try {
  const protocols = await protocolRepo.list();
  console.log(`[soft-dtu] protocol catalog: ${protocols.length} protocols (${protocolRepo.isOffline() ? "offline fallback" : "from server"})`);
  for (const p of protocols) {
    console.log(`  - ${p.id}: ${p.name} (${p.type})`);
  }
  console.log(`[soft-dtu] protocol selection: user picks manually in UI`);
} catch (err) {
  console.warn(`[soft-dtu] initial protocol fetch failed:`, err);
}

// 8. 启动 DTU 协议（连 UartNode + 发注册包 + 响应 8 条 AT）
await dtu.start();

// 9. 优雅关闭
globalThis.addEventListener("unload", () => {
  console.log("[soft-dtu] shutting down...");
  dtu.stop();
  tcp.close();
  serial.close();
});

console.log("[soft-dtu] ready. mac=" + config.virtualImei.slice(-12));
