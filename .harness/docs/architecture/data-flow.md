# 数据流

> 三个外部世界之间的数据通路：DTU ↔ UartNode ↔ uart-server

## 1. 端到端时序

```
[DTU 设备]               [UartNode]                       [uart-server]
   │                        │                                    │
   │                        │◄────── Socket.IO connect ──────────┤
   │                        │◄────── 'accont' (server 认账) ────┤
   │                        │───────── 'register' (NodeInfo) ────►
   │                        │◄────── 'registerSuccess' (config) ─┤
   │                        │   → new TcpServer(conf)            │
   │                        │                                    │
   │ TCP connect            │                                    │
   ├───────────────────────►│                                    │
   │                        │ 10s 推 AT 仪式 (4G 专属)            │
   │◄────── +++AT+... ─────┤                                    │
   │                        │                                    │
   │ 注册包 (4G 专属)        │                                    │
   ├────── register&... ───►│                                    │
   │                        │ new Client / 监听 socket           │
   │                        │ 'terminalOn' (mac, false)          │
   │                        ├──────────────── 'terminalOn' ──────►
   │                        │                                    │
   │                        │ run() → 批量查 AT (4G 专属)        │
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
   │                        │                                    │
   │                        │           server 主动查询            │
   │                        │◄──── 'query' (QueryInstruct) ───────┤
   │                        │ tcpServer.Bus()                    │
   │                        │   ↓                                │
   │                        │ socketsb.write('指令\r')            │
   │◄──── 指令 ─────────────┤                                    │
   │──── 响应 ─────────────►│                                    │
   │                        │ fetch.queryData(result)             │
   │                        ├──────────────── 'queryData' ───────►
   │                        │                                    │
   │                        │                                    │
```

## 2. 五个外部事件

| 方向 | 事件 | 触发方 | UartNode 入口 | 出口 |
|---|---|---|---|---|
| **Server → Node** | `registerSuccess` | server | `IOClient.on('registerSuccess')` (`main.ts:20`) | 启 TcpServer |
| **Server → Node** | `query` | server | `IOClient.on('query')` (`main.ts:31`) | 派发到 Client 缓存 |
| **Server → Node** | `instructQuery` | server | `IOClient.on('instructQuery')` (`main.ts:37`) | 同上 |
| **Server → Node** | `DTUoprate` | server | `IOClient.on('DTUoprate')` (`main.ts:42`) | 同上 |
| **Server → Node** | `nodeInfo` | server | `IOClient.on('nodeInfo')` (`main.ts:47`) | `fetch.nodeInfo` |

## 3. 六个 Node 主动事件

| 事件 | 触发点 | 数据 | 用途 |
|---|---|---|---|
| `register` | `main.ts:17` | `tool.NodeInfo()` | node 上线注册 |
| `ready` | `main.ts:69` (10s 后) | — | 告知 server 设备已就绪 |
| `terminalOn` | `client.ts:75` 等 | `(mac, forceReport)` | 设备上线 |
| `terminalOff` | `client.ts:108` | `(mac, forceReport)` | 设备离线 |
| `busy` | `client.ts:312, 115` | `(mac, busy, count)` | 设备查询堆积状态 |
| `result` | `IO.ts:66` | `(eventName, data)` | 响应 server 的 `ioOnResult` 触发 |
| `deviceopratesuccess` | `client.ts:440` | `(Query.events, result)` | 操作指令完成 |
| `dtuopratesuccess` | `client.ts:461` | `(Query.events, result)` | AT 指令完成 |

外加 `terminalMountDevTimeOut` / `terminalMountDevTimeOutRestore` / `instructTimeOut` /
`instructOprate` —— 异常/告警事件。

## 4. 上行 HTTP 路径（**与 Socket.IO 平行**）

| 路径 | 触发 | 数据 |
|---|---|---|
| `POST /api/node/dtuinfo` | `client.run()` 完成后 | DTU 设备参数 |
| `POST /api/node/UartData` | `fetch.queryData(result)` | 查询结果集 |
| `POST /api/node/RunData` | (未在 src 中使用) | 节点运行数据 |
| `POST /api/node/nodeInfo` | `IOClient.on('nodeInfo')` | Node 机器信息 + tcp 连接数 |
| `POST /api/node/queryData` | `fetch.queryData(SuccessResult)` | 单条查询结果 |

**`/api/node/*` 鉴权**：header `x-node-token: <NODE_TOKEN>`（`fetch.ts:46`），
对应 server 端 PR #20 鉴权。

## 5. 下行指令优先级（`client.saveCache` 排队列）

```ts
switch (Query.eventType) {
  case "QueryInstruct":  this.Cache.push(Query)              // 普通查询，FIFO
  case "ATInstruct":     this.Cache.unshift(Query)           // AT 指令，插队最前
  case "OprateInstruct": this.Cache.unshift(Query)           // 操作指令，插队最前
}
```

**`unshift` 是关键的优先机制**——server 下发一条 AT 改 DTU 配置时，不能被前面排队的
普通查询堵住。改 LAN 适配时这个优先级策略**保持不变**。

## 6. 死循环 / 异常路径

- **设备查询堆积 > 3** → `busy` 事件给 server（`client.ts:312`），业务侧可告警
- **某个 pid 全部超时 10 次** → 触发 `AT+Z` 硬重启（`client.ts:387-390`）
- **IOClient 断开** → 仅打印日志，**不自动 close TcpServer**（`main.ts:26-29` 注释里说"tcpServer.close()" 已注释掉）
  - 风险：server 短暂断连，DTU 这边连接全保留，重连后可能状态不一致
- **DTU socket timeout** → 5 分钟无活动（`config.timeOut`）→ `setTimeout` 触发但**没 destroy**
  - `socket.ts:40-42` 仅打 log，没主动断开。**这是 bug**
