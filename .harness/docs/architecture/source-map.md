# src/ 代码地图

> **Source**: 实读 UartNode v3.3.0 + v4 重构（RFC 002）落地后 main 分支（commit `aee7eea`）
> **Sync**: 2026-07-14 sync with PR #1-#12 落地（dev 机 13:44 session，cairui 拍板 "都修"）
> **重构前快照**：本文件 v1 写的是 PR #1 之前 8 个 src/ 文件 + 老 `TcpServer.ts` extends `net.Server` 路径。
> v4 落地后 src/ 拆成 14 个文件 + 4 个子目录，老 source-map.md 内容已 stale。

## 0. 一图流

```
┌──────────────────────────────────────────────────────────────────┐
│                   uart-server (socket.io + http)                 │
│  ↑ Socket.IO 事件              ↑ HTTP POST /api/node/*           │
│  │                              │                                │
└──┼──────────────────────────────┼────────────────────────────────┘
   │ IO.ts / services/io-client  │ fetch.ts → services/uploader
   ↓                              ↓
┌──────────────────────────────────────────────────────────────────┐
│  main.ts — 事件路由                                              │
│  • IOClient.on('registerSuccess') → 启动 TcpServer                │
│  • IOClient.on('query')         → tcpServer.bus('QueryInstruct')  │
│  • IOClient.on('instructQuery') → tcpServer.bus('OprateInstruct')│
│  • IOClient.on('DTUoprate')     → tcpServer.bus('ATInstruct')    │
│  • IOClient.on('nodeInfo')      → fetch.nodeInfo(...)             │
└──┬───────────────────────────────────────────────────────────────┘
   │
   ↓
┌──────────────────────────────────────────────────────────────────┐
│  server/tcp-server.ts — TCP Server :9000 (PR #5 class 化)        │
│  • sniffers: ProtocolSniffer[]     ← 数组化，未来 LanDtu push 一个│
│  • registerHandlers: RegisterHandler[]  ← 跟 sniffers 一一对应     │
│  • macSocketMaps: Map<mac, Dtu>    ← 设备身份 (老 MacSocketMaps)  │
│  • bus() 派发下行指令（query / AT / operate）                     │
│  • resolveListenPort() 全 env 驱动（PR #5 顺手清掉 NODE_ENV DCE） │
└──┬───────────────────────────────────────────────────────────────┘
   │
   ↓ 1 个 DTU 1 个 Dtu
┌──────────────────────────────────────────────────────────────────┐
│  dtus/base.ts — Dtu 抽象基类 (PR #4 + #6)                        │
│  • 8 态状态机: CONNECTING / HANDSHAKING / INITIALIZING /          │
│    ONLINE / DEGRADED / RECONNECTING / RESTARTING / OFFLINE       │
│  • 健康度 0-100 + computeHealth() 纯函数                          │
│  • 5 类 alert: AT_TIMEOUT / INVALID_REGISTER /                  │
│    PROFILE_CACHE_FAIL / FATAL / INVALID_STATE_TRANSITION (PR #12)│
│  • 60s 周期 dtuHealth 上报（ONLINE/DEGRADED 才发）                │
│  • FIFO 队列 + AT/Oprate 插队到队首 + socket 锁 + 10 次硬重启    │
│  • 抽象: initialize() / restart() / processQueue()               │
└──┬───────────────────────────────────────────────────────────────┘
   │
   ↓ extends
┌──────────────────────────────────────────────────────────────────┐
│  dtus/cellular.ts — 4G/2G/NB 实现 (PR #4)                        │
│  • initialize() 批量查 8 条 AT (4G 专属)                          │
│    PID / VER / GVER / IOTEN / ICCID / LOCATE=1 / UART=1 / GSLQ    │
│    + IOTEN=off 关流量                                            │
│  • restart() 走 AT+Z（4G 专属）                                  │
│  • processQueue() 处理 OprateInstruct / ATInstruct                │
│  • queryAT() 拼 '+++AT+<content>\r'（4G 专属前缀）                │
└──┬───────────────────────────────────────────────────────────────┘
   │
   ↓
┌──────────────────────────────────────────────────────────────────┐
│  socket.ts — 纯 TCP socket 抽象 (与协议无关)                     │
│  • setTimeout(5min) / setKeepAlive(100s) / setNoDelay(true)      │
│  • write() 返回 Promise<socketResult>, lock/free 事件机制        │
│  • ProxySocket 拦截状态变更 emit 业务事件                         │
└──┬───────────────────────────────────────────────────────────────┘
   │
   ↓ net.Socket
   ╳ DTU 端
```

## 1. 文件职责速查（v4 重构后，2026-07-14 sync）

| 文件 | 行数 | 职责 | 协议相关 | 改 LAN 时动它？ |
|---|---|---|---|---|
| `main.ts` | ~70 | 事件路由：IO ↔ TcpServer | **否** | 不动 |
| `config.ts` | ~95 | 全 env 配置 + 事件名常量 | **否** | 加 LAN topology enum |
| `IO.ts` | ~70 | Socket.IO 客户端（顶层单例）+ PR #20 鉴权 | **否** | 不动（待 PR #1 class 化版本完全替换） |
| `services/io-client.ts` | ~230 | Socket.IO client class 化（PR #1）| **否** | 不动 |
| `fetch.ts` | ~70 | HTTP 上行 API surface（dtuInfo/nodeInfo/queryData）| **否** | 不动 |
| `services/uploader.ts` | ~170 | HTTP 上行队列+背压+重试实现（PR #2）| **否** | 不动 |
| `services/at-parse.ts` | ~90 | AT 响应解析纯函数（PR #3）| **是，4G 专属** | 加 LanParse |
| `services/dtu-info.ts` | ~35 | nodeInfo 纯函数 | **否** | 不动 |
| `server/tcp-server.ts` | ~190 | TCP Server，class 化 + sniffers 数组化（PR #5）| **是，4G 专属** | **重构**（sniffers 已数组化）|
| `server/register-handler.ts` | ~110 | 协议嗅探 + 注册包解析 | **是，4G 专属** | **重构** |
| `dtus/base.ts` | ~470 | Dtu 抽象基类（状态机+健康度+alert+队列）| **否** | 通用基类，不动 |
| `dtus/cellular.ts` | ~155 | 4G/2G/NB DTU 实现 | **是，4G 绑死** | **拆 + 新增 LanDtu 类** |
| `dtus/state.ts` | ~290 | 状态机纯函数层（8 态 + computeHealth + 5 类 alert）| **否** | 通用，不动 |
| `protocol/events.ts` | ~200 | Socket.IO 事件名常量 + payload 类型 | **部分**（3 个 v4 新事件）| 不动（LAN 复用）|
| `Cache.ts` | ~55 | **死代码**（没人 import）| **否** | 不动 / 真清就删 |
| `tool.ts` | ~10 | **空占位**（PR #3/#4 拆完后留的 import 占位）| — | 不动 |

**关键结论**：LAN 改造**只动** `dtus/cellular.ts` / `services/at-parse.ts` / `server/register-handler.ts` 三个文件 + 新增 1-2 个 adapter（`dtus/lan.ts` / `services/lan-parse.ts`）+ `server/tcp-server.ts` 的 sniffers push 一个新 sniffer（不用动嗅探/注册处理逻辑）。

**已修的 bug**（PR #5 重构顺手清掉）：

- ~~`TcpServer.ts:37, 49` 还有 2 处 `process.env.NODE_ENV === 'production' ? conf.Port : config.localport`~~
  → 改用 `src/server/tcp-server.ts:resolveListenPort()` 全 env 驱动
  （`LISTEN_PORT` env → `conf.Port` → `config.localport = 9000`）。不再有 DCE bug。

## 2. 关键调用链（v4 重构后）

### 2.1 DTU 上线（4G 当前路径）

```
server/tcp-server.ts:onConnection(socket)
  ├── setTimeout(10s, pushCellularRegisterInvite)
  │     └── socket.write('+++AT+NREGEN=A,on\r') × 3
  ├── socket.once('data', firstPacket)
  │     ├── sniffers.find(s => s.match(firstPacket))
  │     │     ├── CellularSniffer.match() → startsWith('register&')
  │     │     └── handler.handle(socket, firstPacket, macSocketMaps, conf)
  │     │           ├── URLSearchParams(firstPacket).has('register') + has('mac')
  │     │           ├── IMEI.slice(-12)  ←  mac 主键（v4 改 15 位前保持）
  │     │           ├── 已有 mac → existing.reConnectSocket(socket)
  │     │           └── 新 mac → new CellularDtu(socket, mac, getIOClient())
  │     │                 ├── new socketsb(socket, mac)  // socket.ts
  │     │                 ├── getIOClient().terminalOn(mac, false)
  │     │                 └── bindSocket → initialize()  // 8 条 AT 批量查
  │     │                       └── queryAT(...) × 8
  │     └── 不命中: socket.end('please register DTU IMEI') + destroy
  └── macSocketMaps.set(mac, dtu)
```

### 2.2 Server 下发查询（来自 uart-server 的指令）

```
IOClient.on('query', Query)            // main.ts
  └── tcpServer.bus('QueryInstruct', Query)
        └── dtus/base.ts:Dtu.saveCache(Query)  // 塞 cache 队列
              └── processingQueue()  // 基类通用调度
                    └── queryInstruct(query)  // 基类通用实现
                          ├── for (content of query.content)
                          │     └── socketsb.write(queryString, 10000, --len !== 0)
                          ├── 全部超时 → terminalMountDevTimeOut + 10 次硬重启
                          ├── 部分超时 → instructTimeOut + 上报成功部分
                          └── fetch.queryData(successResult)  // 上行
```

### 2.3 Server 下发 AT 指令

```
IOClient.on('DTUoprate', Query)        // main.ts
  └── tcpServer.bus('ATInstruct', Query)
        └── Dtu.saveCache(Query)  // ATInstruct 走 unshift 优先
              └── processingQueue()
                    └── case 'ATInstruct':
                          ├── cellular.ts:processQueue
                          ├── Buffer.from(query.content + '\r', 'utf-8')
                          ├── socketsb.write(queryString)
                          └── atParse(query, result)  // base.ts atParse → parseATResponse
                                └── /^\+ok=/ 匹配 (services/at-parse.ts)
```

### 2.4 DTU 查询超时硬重启

```
QueryInstruct → all timeout (10 次)  // dtus/base.ts:queryInstruct
  └── Dtu.restart()  // cellular.ts:restart
        ├── setPause 等 socket 空闲
        ├── queryAT('Z')  // 拼 '+++AT+Z\r'
        ├── this.reboot = true
        └── socketsb.getSocket().destroy()  // 触发 terminalOff + 60s 后重发 terminalOn(reline=true)
              └── 60s 内重连走 reConnectSocket(socket)
                    └── bindSocket → initialize()  // 重跑 8 条 AT
```

## 3. 关键状态/常量

| 名称 | 文件:行（v4） | 含义 |
|---|---|---|
| `macSocketMaps` | `server/tcp-server.ts:TcpServer.macSocketMaps` | `Map<mac, Dtu>` 设备身份表 |
| `config.timeOut` | `config.ts` | 5 分钟 socket 超时（socket.ts:40-42 没主动 destroy）|
| `config.queryTimeOut` | `config.ts` | 1.5s 单条查询超时 |
| `config.queryTimeOutNum` | `config.ts` | 10 次超时触发硬重启 |
| `config.queryTimeOutReload` | `config.ts` | 60s 重启时间（未使用）|
| `config.count` | `config.ts` | 在线设备数（运行时累加）|
| `config.localport` | `config.ts` | 9000 TCP 监听端口（dev fallback）|
| `conf.Port` | server registerSuccess 下发 | TCP 监听端口（prod 优先）|
| `process.env.LISTEN_PORT` | env | 部署期灵活覆盖（PR #5 新增）|
| `REGISTER_INVITE_DELAY_MS` | `server/tcp-server.ts` | 10s 推 AT 仪式的等待时间 |
| `MaxConnections` | `server/tcp-server.ts` | 2000（setMaxListeners + 并发上限）|
| `UPLOAD_TIMEOUT_MS` | `services/uploader.ts` | 30s（2026-06-22 hotfix 5s → 30s）|
| `UPLOAD_CONCURRENCY` | `services/uploader.ts` | 4（UartNode 单进程流量小，pesiv 是 16）|
| `UPLOAD_QUEUE_MAX` | `services/uploader.ts` | 1000（满队 drop oldest）|
| `HEALTH_REPORT_INTERVAL_MS` | `dtus/state.ts` | 60s 周期 dtuHealth 上报（ONLINE/DEGRADED 才发）|
| `MAX_RECONNECT_ATTEMPTS` | `dtus/state.ts` | 5 次重连 |

## 4. 跟协议相关的硬编码点（**改 LAN 时要碰**）

| 点 | 文件:行（v4）| 硬编码什么 | LAN 怎么办 |
|---|---|---|---|
| 10s 推 AT | `server/tcp-server.ts:onConnection` + `server/register-handler.ts:pushCellularRegisterInvite` | `+++AT+NREGEN/A,on\r` 等汉枫 4G 指令 | 拓扑 A/B 不推 |
| 注册包解析 | `server/register-handler.ts:CellularRegisterHandler.handle` | `URLSearchParams` + 判 `register+mac` | 改成白名单查 mac |
| IMEI 后 12 位当 mac | `server/register-handler.ts:CellularRegisterHandler.handle` | `IMEI.slice(maclen-12, maclen)` | LAN 用 MAC 12 字符 |
| `+++AT+` 前缀 | `dtus/cellular.ts:queryAT` | `'+++AT+${content}\r'` | LAN 改 CLI / HTTP API |
| 批量查 4G 字段 | `dtus/cellular.ts:initialize` | PID/VER/GVER/IOTEN/ICCID/LOCATE/UART/GSLQ | LAN 大半无意义 |
| `+ok=` 解析 | `services/at-parse.ts:parseATResponse` | `/^\+ok=/i.test(str)` | LAN 改 `EPORT>` 提示符或 HTTP |
| `AT+Z` 硬重启 | `dtus/cellular.ts:restart` | `queryAT('Z')` | LAN 走 Web/REST API |
| 10s timeout 写死 | `server/tcp-server.ts:REGISTER_INVITE_DELAY_MS` | `10_000` ms | LAN 拓扑要可配 |
| 8 条 AT 批量查顺序 | `dtus/cellular.ts:initialize` | 固定 PID → VER → GVER → IOTEN → ICCID → LOCATE → UART → GSLQ | LAN 大半无意义 |

## 5. 跟协议**无关**的可复用层

| 层 | 文件 | 为什么无关 |
|---|---|---|
| Socket.IO 客户端 | `IO.ts` + `services/io-client.ts` | 只跟 server 通信，不碰 DTU |
| HTTP fetch | `fetch.ts` + `services/uploader.ts` | 同上 |
| Dtu 基类 | `dtus/base.ts` | 状态机/健康度/alert/队列/超时重启都通用 |
| 状态机纯函数 | `dtus/state.ts` | 8 态 + computeHealth + 5 类 alert 通用 |
| 事件名常量 | `protocol/events.ts` | 13 老事件 + 3 新事件，4G/LAN 通用 |
| Config env | `config.ts` | 全 env 驱动，IO_URI/SERVER_URL/NODE_TOKEN |
| nodeInfo | `services/dtu-info.ts` | 节点机器信息，与协议无关 |
| socket 抽象 | `socket.ts` | 纯 TCP 封装，setKeepAlive/setNoDelay 等可复用 |
| main.ts 路由 | `main.ts` | 单纯事件分发 |

**这意味着**：LAN 改造时这些文件**完全不动**。改动集中在 4G 专属层 + 新增 LanDtu 类 + sniffers push。
