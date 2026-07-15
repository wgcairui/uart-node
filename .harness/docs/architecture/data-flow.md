# 数据流

> 三个外部世界之间的数据通路：DTU ↔ UartNode ↔ uart-server
>
> **v4 sync 2026-07-14**：v4 重构（RFC 002 PR #1-#12）落地后文件路径变了，本文件 v1 引用老 `client.ts:75` 等
> 行号已 stale。下表用 v4 新路径（`dtus/cellular.ts` / `dtus/base.ts` / `server/tcp-server.ts` 等）。

## 1. 端到端时序

```
[DTU 设备]               [UartNode]                       [uart-server]
   │                        │                                    │
   │                        │◄────── Socket.IO connect ──────────┤
   │                        │◄────── 'accont' (server 认账) ────┤
   │                        │───────── 'register' (NodeInfo) ────►
   │                        │◄────── 'registerSuccess' (config) ─┤
   │                        │   → new TcpServer(conf)            │
   │                        │   → tcpServer.listen()             │
   │                        │                                    │
   │ TCP connect            │                                    │
   ├───────────────────────►│                                    │
   │                        │ 10s 推 AT 仪式 (4G 专属)            │
   │                        │   server/register-handler.ts       │
   │                        │   :pushCellularRegisterInvite     │
   │◄──── +++AT+NREGEN=... ─┤                                    │
   │◄──── +++AT+NREGDT=... ─┤                                    │
   │                        │                                    │
   │ 注册包 (4G 专属)        │                                    │
   ├──── register&... ─────►│                                    │
   │                        │ server/tcp-server.ts:onConnection  │
   │                        │   → CellularSniffer.match          │
   │                        │   → CellularRegisterHandler.handle │
   │                        │   → new CellularDtu(socket, mac)  │
   │                        │     = new Dtu extends CellularDtu │
   │                        │   → macSocketMaps.set(mac, dtu)   │
   │                        │                                    │
   │                        │ 'terminalOn' (mac, false)          │
   │                        ├──────────────── 'terminalOn' ──────►
   │                        │                                    │
   │                        │ CellularDtu.initialize()           │
   │                        │  → 8 条 AT 批量查 (4G 专属)         │
   │◄─── +++AT+PID ────────┤                                    │
   │──── +ok=... ──────────►│                                    │
   │   ... × 8 ...          │                                    │
   │                        │ 'dtuinfo' (设备信息)                 │
   │                        ├──────────────── 'dtuinfo' ─────────►
   │                        │                                    │
   │◄═══════════════════════╪════════════════════════════════════ │
   │       透传数据          │                                    │
   │◄═══════════════════════╪════════════════════════════════════ │
   │                        │                                    │
   │                        │           server 主动查询            │
   │                        │◄──── 'query' (QueryInstruct) ───────┤
   │                        │ tcpServer.bus('QueryInstruct', Q)  │
   │                        │   ↓                                │
   │                        │ dtus/base.ts:Dtu.saveCache(Q)      │
   │                        │ socketsb.write('指令\r')            │
   │◄──── 指令 ─────────────┤                                    │
   │──── 响应 ─────────────►│                                    │
   │                        │ services/uploader.ts:enqueue       │
   │                        │  → 'queryData'                     │
   │                        ├──────────────── 'queryData' ───────►
   │                        │                                    │
   │                        │                                    │
```

## 2. 五个外部事件（v4 不变）

| 方向 | 事件 | 触发方 | UartNode 入口 | 出口 |
|---|---|---|---|---|
| **Server → Node** | `registerSuccess` | server | `IOClient.on('registerSuccess')` (`main.ts`) | 启 TcpServer |
| **Server → Node** | `query` | server | `IOClient.on('query')` (`main.ts`) | 派发到 Dtu 缓存 |
| **Server → Node** | `instructQuery` | server | `IOClient.on('instructQuery')` (`main.ts`) | 同上 |
| **Server → Node** | `DTUoprate` | server | `IOClient.on('DTUoprate')` (`main.ts`) | 同上 |
| **Server → Node** | `nodeInfo` | server | `IOClient.on('nodeInfo')` (`main.ts`) | `fetch.nodeInfo` |

## 3. Node 主动事件（v4 新增 3 个）

| 事件 | 触发点（v4）| 数据 | 用途 |
|---|---|---|---|
| `register` | `main.ts` | `services/dtu-info.ts:nodeInfo()` | node 上线注册 |
| `ready` | `main.ts` (10s 后) | — | 告知 server 设备已就绪 |
| `terminalOn` | `dtus/base.ts:Dtu` constructor / `reConnectSocket` | `(mac, reline)` | 设备上线 / 重连（reline=true 主动断开）|
| `terminalOff` | `dtus/base.ts:Dtu.bindSocket` close | `(mac, force)` | 设备离线 |
| `busy` | `dtus/base.ts:Dtu.processingQueue` | `(mac, busy, count)` | 设备查询堆积状态 |
| `result` | `IO.ts:ioOnResult` 模式 | `(eventName, data)` | 响应 server 的 `ioOnResult` 触发 |
| `deviceopratesuccess` | `dtus/base.ts:Dtu.oprateParse` | `(query.events, result)` | 操作指令完成 |
| `dtuopratesuccess` | `dtus/base.ts:Dtu.atParse` | `(query.events, result)` | AT 指令完成 |
| **`dtuState`** (v4 新) | `dtus/base.ts:Dtu.transition` | `{mac, from, to, score, reason, timestamp}` | 状态转换，latest-wins 覆盖 |
| **`dtuHealth`** (v4 新) | `dtus/base.ts:Dtu.emitHealth` 60s 周期 | `{mac, score, health, timestamp}` | 健康度上报，ONLINE/DEGRADED 才发 |
| **`dtuAlert`** (v4 新) | `dtus/base.ts:Dtu.emitAlert` | `{mac, type, message, context?, timestamp}` | 4 类告警（+INVALID_STATE_TRANSITION）|

外加 `terminalMountDevTimeOut` / `instructTimeOut` —— 异常/告警事件。

## 4. 上行 HTTP 路径（**与 Socket.IO 平行**）

| 路径 | 触发（v4）| 数据 |
|---|---|---|
| `POST /api/node/dtuinfo` | `dtus/cellular.ts:CellularDtu.initialize()` 完成后 | DTU 设备参数 |
| `POST /api/node/queryData` | `dtus/base.ts:Dtu.queryInstruct` 成功后 | 单条查询结果 |
| `POST /api/node/nodeInfo` | `main.ts:on('nodeInfo')` | Node 机器信息 + tcp 连接数 |
| `POST /api/node/UartData` | (未在 src 中使用) | 节点运行数据 |
| `POST /api/node/RunData` | (未在 src 中使用) | 节点运行数据（重复 UartData）|

**`/api/node/*` 鉴权**：header `x-node-token: <NODE_TOKEN>`（`services/uploader.ts:runItem`），
对应 server 端 PR #20 鉴权。

**实现链路**：
- `src/fetch.ts` 是 API surface（3 个方法 default export 单例）
- `src/services/uploader.ts` 是队列 + 背压 + 重试实现（PR #2）
- `src/fetch.ts` 内部 `import * as uploader from './services/uploader'`，3 个方法走 `uploader.enqueue('path', body)`

## 5. 下行指令优先级（`dtus/base.ts:Dtu.saveCache` 排队列）

```ts
// dtus/base.ts:Dtu.saveCache (基类通用, 跟 v3.3.0 1:1 兼容)
switch (query.eventType) {
  case 'QueryInstruct':  this.cache.push(query)              // 普通查询，FIFO
  case 'ATInstruct':     this.cache.unshift(query)           // AT 指令，插队最前
  case 'OprateInstruct': this.cache.unshift(query)           // 操作指令，插队最前
}
```

**`unshift` 是关键的优先机制**——server 下发一条 AT 改 DTU 配置时，不能被前面排队的
普通查询堵住。改 LAN 适配时这个优先级策略**保持不变**。

## 6. 死循环 / 异常路径

- **设备查询堆积 > 3** → `busy` 事件给 server（`dtus/base.ts:Dtu.processingQueue`），业务侧可告警
- **某个 pid 全部超时 10 次** → 触发 `CellularDtu.restart()`（基类约定）走 `AT+Z` 硬重启
  （`dtus/base.ts:Dtu.queryInstruct` + `dtus/cellular.ts:CellularDtu.restart`）
- **IOClient 断开** → 仅打印日志，**不自动 close TcpServer**（`main.ts` 的 disconnect handler
  注释里说 "tcpServer.close()" 已注释掉）
  - 风险：server 短暂断连，DTU 这边连接全保留，重连后可能状态不一致
- **DTU socket timeout** → 5 分钟无活动（`config.timeOut`）→ `setTimeout` 触发但**没 destroy**
  - `src/socket.ts:40-42` 仅打 log，没主动断开。**这是 bug**
- **Dtu state 非法转换** → PR #12 升级到 `console.error` + emit `dtuAlert` `INVALID_STATE_TRANSITION`
  （不再静默忽略，8 天 staging 回归暴露 dtuStateLatest=0 根因之一已修）
- **Uploader 失败** → 指数退避重试 2 次（`services/uploader.ts:runItem`），最终放弃 console.error

## 7. 鉴权链路（PR #20）

### 7.1 Socket.IO 握手（Node → Server 连接时）

Node 端把 `NODE_TOKEN` 同时放在 3 个握手通道（`src/IO.ts:21-29` + `src/services/io-client.ts:43-50`）：

1. `auth.token` — 推荐通道，websocket / polling 都吃
2. `query.token` — 备选通道
3. `x-node-token` header（`extraHeaders` + `transportOptions` 双保险）— 4.5+ websocket 阶段
   extraHeaders 失效已修（4.7.5 默认带 transportOptions）

### 7.2 HTTP `/api/node/*`（Node → Server 上行时）

`src/services/uploader.ts:runItem` 在每次 fetch POST 时把 `NODE_TOKEN` 塞在 `x-node-token` header。

### 7.3 双版本并存

PR #1 落地了 `src/services/io-client.ts`（class 版本），但 `main.ts` 还在用 `src/IO.ts`（顶层单例），
两个版本都设置 PR #20 三通道。`src/services/io-client.ts` 给 `dtus/base.ts` + `services/*` 内部用。
下次动 `main.ts` 时切到 `getIOClient()`，然后删 `src/IO.ts`。

## 8. DTU ↔ Node 数据流（设备层协议，4G 当前路径）

### 8.1 DTU → Node 上行（`server/tcp-server.ts:onConnection`）

```
socket.on('data', firstPacket)             // DTU 发的注册包
  ├── CellularSniffer.match(firstPacket)   // 嗅探 'register&' 前缀
  ├── CellularRegisterHandler.handle(socket, firstPacket, macSocketMaps, conf)
  │     ├── URLSearchParams(firstPacket).has('register') + has('mac')
  │     ├── IMEI.slice(-12)  ←  mac 主键
  │     ├── 已有 mac → existing.reConnectSocket(socket)
  │     └── 新 mac → new CellularDtu(socket, mac, getIOClient())
  │           ├── new socketsb(socket, mac)
  │           ├── getIOClient().terminalOn(mac, false)
  │           ├── Dtu.constructor  → bindSocket
  │           └── Dtu.bindSocket    → initialize()  // 8 条 AT 批量查
  └── (后续 socket.data 直接走 socketsb.write() 反向响应)
```

### 8.2 Node → DTU 下行（`dtus/base.ts:Dtu.saveCache` + `processingQueue`）

```
Dtu.saveCache(query)  // 由 tcpServer.bus() 调用
  ├── switch eventType
  │     ├── QueryInstruct:  cache.push(query)
  │     ├── ATInstruct:     cache.unshift(query)
  │     └── OprateInstruct: cache.unshift(query)
  └── socketsb.getSocket().emit('Queue')
        → Dtu.processingQueue()
              ├── case QueryInstruct:  queryInstruct(query)  // 基类通用
              └── case Oprate/AT:      processQueue(query)    // 子类实现
```

## 9. 与 v3.3.0 老代码的差异（RFC 002 落地带来的）

| 维度 | v3.3.0 | v4 (当前) |
|---|---|---|
| TCP server | `TcpServer extends net.Server` | `TcpServer` class + `net.createServer()` 包裹（PR #5）|
| 设备抽象 | `Client` 单一类（绑死 4G）| `Dtu` 抽象基类 + `CellularDtu` 实现（PR #4）|
| 协议嗅探 | 硬编码 4G | `ProtocolSniffer[]` 数组化，未来 LAN push 一个（PR #5）|
| Socket.IO client | 顶层单例副作用 | class + factory + `getIOClient()`（PR #1）|
| HTTP 上行 | `fetch` 单点 + console.log | 队列 + 背压 + 重试（PR #2）|
| AT 解析 | `tool.ATParse()` 静态方法 | `parseATResponse()` 纯函数 + Result 类型（PR #3）|
| nodeInfo | `tool.NodeInfo()` 静态方法 | `nodeInfo()` 纯函数（PR #4 拆出）|
| 状态机 | 无 | 8 态 + 转换表 + computeHealth + 5 类 alert（PR #6 + #12）|
| 健康度上报 | 无 | 60s 周期 dtuHealth（ONLINE/DEGRADED 才发）|
| Listen port | `NODE_ENV` 模式判断（DCE bug）| `resolveListenPort()` 全 env 驱动（PR #5 顺手修）|

**不变量**（v3.3.0 → v4 行为契约 1:1）：
- DTU 注册包解析（URLSearchParams + IMEI.slice(12) + 已有 mac 走 reConnectSocket）
- 10s 推 `+++AT+` 仪式
- 队列调度（QueryInstruct FIFO + AT/Oprate unshift）
- 10 次超时硬重启
- IOClient 三通道 token
- HTTP `x-node-token` header 鉴权
