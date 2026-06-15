# src/ 代码地图

> **Source**: 实读 UartNode v3.3.0 分支 `fix/dce-config-env-driven`（commit 6fa4359）8 个源文件

## 0. 一图流

```
┌──────────────────────────────────────────────────────────────────┐
│                   uart-server (socket.io + http)                 │
│  ↑ Socket.IO 事件              ↑ HTTP POST /api/node/*           │
│  │                              │                                │
└──┼──────────────────────────────┼────────────────────────────────┘
   │ IO.ts (client)               │ fetch.ts (http)
   ↓                              ↓
┌──────────────────────────────────────────────────────────────────┐
│  main.ts — 事件路由                                              │
│  • IOClient.on('registerSuccess') → 启动 TcpServer                │
│  • IOClient.on('query')         → tcpServer.Bus('QueryInstruct')  │
│  • IOClient.on('instructQuery') → tcpServer.Bus('OprateInstruct')│
│  • IOClient.on('DTUoprate')     → tcpServer.Bus('ATInstruct')    │
│  • IOClient.on('nodeInfo')      → fetch.nodeInfo(...)             │
└──┬───────────────────────────────────────────────────────────────┘
   │
   ↓
┌──────────────────────────────────────────────────────────────────┐
│  TcpServer.ts — net.Server :9000                                 │
│  • 10s 推 AT 仪式 (4G 专属)                                      │
│  • URLSearchParams 解析注册包 (4G 专属)                           │
│  • MacSocketMaps: Map<mac, Client>  ← 设备身份                    │
│  • Bus() 派发下行指令                                            │
└──┬───────────────────────────────────────────────────────────────┘
   │
   ↓ 1 个 DTU 1 个 Client
┌──────────────────────────────────────────────────────────────────┐
│  client.ts — 单 DTU 运行时抽象                                   │
│  • 状态: mac/jw/uart/AT/ICCID/PID/ver/Gver/iotStat/signal        │
│  • run() 批量查 AT 指令 (4G 专属)                                 │
│  • QueryAT() 拼 '+++AT+' 前缀 (4G 专属)                          │
│  • Cache 队列: QueryInstruct/OprateInstruct/ATInstruct            │
│  • 超时 10 次硬重启策略 (AT+Z)                                   │
└──┬───────────────────────────────────────────────────────────────┘
   │
   ↓
┌──────────────────────────────────────────────────────────────────┐
│  socket.ts — 纯 TCP socket 封装 (与协议无关)                     │
│  • setTimeout(5min) / setKeepAlive(100s) / setNoDelay(true)      │
│  • write() 返回 Promise<socketResult>, lock/free 事件机制        │
│  • ProxySocket 拦截状态变更 emit 业务事件                         │
└──┬───────────────────────────────────────────────────────────────┘
   │
   ↓ net.Socket
   ╳ DTU 端
```

## 1. 文件职责速查

| 文件 | 行数 | 职责 | 协议相关 | 改 LAN 时动它？ |
|---|---|---|---|---|
| `main.ts` | 72 | 事件路由：IO ↔ TcpServer | **否** | 不动 |
| `config.ts` | 92 | 全 env 配置 + 事件名常量 | **否** | 加 LAN topology enum |
| `IO.ts` | 69 | Socket.IO 客户端 + PR #20 鉴权 | **否** | 不动 |
| `fetch.ts` | 66 | HTTP 上行 + PR #20 鉴权 | **否** | 不动 |
| `TcpServer.ts` | 152 | TCP Server，10s 推 AT + 注册包解析 | **是，4G 专属** | **重构** |
| `client.ts` | 475 | 单 DTU 抽象，AT 指令 + 缓存队列 | **是，4G 绑死** | **拆 + 新增 LAN 类** |
| `socket.ts` | 150 | 纯 socket 抽象 | **否** | 不动（Client 模式可复用） |
| `tool.ts` | 45 | AT 响应解析 + 节点信息 | **是，4G 专属** | 加 LanCliParse |
| `Cache.ts` | 55 | （已废弃）直传 fetch | **否** | 不动 |

**关键结论**：LAN 改造**只动** `TcpServer.ts` / `client.ts` / `tool.ts` 三个文件 + 新增 1-2 个 adapter 文件。

**已知 bug 残留**（commit 6fa4359 修了 `config.ts`，**没修** `TcpServer.ts`）：

- `TcpServer.ts:37, 49` 还在用 `process.env.NODE_ENV === 'production' ? conf.Port : config.localport`
- bun build --minify 后 DCE 掉 prod 分支，**容器跑 prod host 永远走 `config.localport = 9000`**
- 如果将来 `conf.Port` 不是 9000（server 端下发非默认 port），`NODE_ENV=production` 的容器会**连错端口**
- 改 TcpServer 时**顺手清掉这俩**，改成全 env：`process.env.LISTEN_PORT ?? conf.Port ?? config.localport`

## 2. 关键调用链

### 2.1 DTU 上线（4G 当前路径）

```
TcpServer._Connection(socket)
  ├── setTimeout(10s, 推 AT 仪式)
  ├── socket.once('data', parseRegister)
  │     ├── 命中: new Client(socket, mac, registerArgs)
  │     │     ├── new socketsb(socket, mac)  // socket.ts
  │     │     ├── IOClient.emit('terminalOn', mac, false)
  │     │     └── socketOn → run()  // 批量查 AT
  │     │           └── QueryAT(...) × 8 次
  │     └── 不命中: socket.end('please register DTU IMEI')
  └── (MacSocketMaps.set(mac, Proxy(client, ProxyClient)))
```

### 2.2 Server 下发查询（来自 uart-server 的指令）

```
IOClient.on('query', Query)
  └── tcpServer.Bus('QueryInstruct', Query)
        └── client.saveCache(Query)  // 塞队列
              └── ProcessingQueue()
                    └── QueryInstruct(Query)
                          ├── for (content of Query.content)
                          │     └── socketsb.write(queryString, 10000, --len !== 0)
                          └── fetch.queryData(result)  // 上行
```

### 2.3 Server 下发 AT 指令

```
IOClient.on('DTUoprate', Query)
  └── tcpServer.Bus('ATInstruct', Query)
        └── client.saveCache(Query)  // ATInstruct 走 unshift 优先
              └── ProcessingQueue()
                    └── case 'ATInstruct':
                          ├── Buffer.from(query.content + '\r', 'utf-8')
                          ├── socketsb.write(queryString)
                          └── ATParse(query, result)
                                └── tool.ATParse(buffer)  // 匹配 ^\+ok
```

### 2.4 DTU 查询超时硬重启

```
QueryInstruct → all timeout (10 次)
  └── resatrtSocket()
        └── QueryAT('Z')  // 硬重启 AT 指令
              └── this.reboot = true
                    └── socket.destroy()
                          └── 60s 内重连走 reConnectSocket()
```

## 3. 关键状态/常量

| 名称 | 文件:行 | 含义 |
|---|---|---|
| `MacSocketMaps` | `TcpServer.ts:16` | `Map<mac, Client>` 设备身份表 |
| `config.timeOut` | `config.ts:83` | 5 分钟 socket 超时 |
| `config.queryTimeOut` | `config.ts:85` | 1.5s 单条查询超时 |
| `config.queryTimeOutNum` | `config.ts:87` | 10 次超时触发硬重启 |
| `config.queryTimeOutReload` | `config.ts:89` | 60s 重启时间（未使用）|
| `config.count` | `config.ts:91` | 在线设备数（运行时累加）|
| `config.localport` | `config.ts:81` | 9000 TCP 监听端口 |
| `TcpServer.MaxConnections` | `TcpServer.ts:24` | 2000（注意：setMaxListeners 是 2000，但 net.Server 实际并发可达系统限制）|
| `_Connection.timeOut` | `TcpServer.ts:71` | **10s** —— 推 AT 仪式的等待时间 |

## 4. 跟协议相关的硬编码点（**改 LAN 时要碰**）

| 点 | 文件:行 | 硬编码什么 | LAN 怎么办 |
|---|---|---|---|
| 10s 推 AT | `TcpServer.ts:71-81` | `+++AT+NREGEN/A,on\r` 等汉枫 4G 指令 | 拓扑 A/B 不推 |
| 注册包解析 | `TcpServer.ts:92-115` | `URLSearchParams` + 判 `register+mac` | 改成白名单查 mac |
| IMEI 后 12 位当 mac | `TcpServer.ts:96-100` | `IMEI.slice(maclen-12, maclen)` | LAN 用 MAC 12 字符 |
| `+++AT+` 前缀 | `client.ts:196` | `'+++AT+${content}\r'` | LAN 改 CLI / HTTP API |
| 批量查 4G 字段 | `client.ts:126-146` | PID/VER/GVER/ICCID/LOCATE/UART/GSLQ/IOTEN | LAN 大半无意义 |
| `+ok` 解析 | `tool.ts:35` | `/(^\+ok)/.test(str)` | LAN 改 EPORT> 提示符或 HTTP |
| `AT+Z` 硬重启 | `client.ts:273` | `'Z'` | LAN 走 Web/REST API |
| 10s timeout 写死 | `TcpServer.ts:71` | `setTimeout(..., 10000)` | LAN 拓扑要可配 |
| **残留 `NODE_ENV` 模式判断** | `TcpServer.ts:37, 49` | `process.env.NODE_ENV === 'production' ? conf.Port : config.localport` | bun build --minify 会 DCE 掉，**prod 容器跑不到 prod 端口**——必须**全 env 改写**（commit 6fa4359 修了 config.ts，没修 TcpServer）|

## 5. 跟协议**无关**的可复用层

| 层 | 文件 | 为什么无关 |
|---|---|---|
| Socket.IO 客户端 | `IO.ts` | 只跟 server 通信，不碰 DTU |
| HTTP fetch | `fetch.ts` | 同上 |
| Cache | `Cache.ts` | 已废弃成直通 |
| 事件名常量 | `config.ts` EVENT_* | 业务事件命名，4G/LAN 通用 |
| Config env | `config.ts` | 全 env 驱动，IO_URI/SERVER_URL/NODE_TOKEN |
| nodeInfo | `tool.ts` NodeInfo | 节点机器信息，与协议无关 |
| socket 抽象 | `socket.ts` | 纯 TCP 封装，setKeepAlive/setNoDelay 等可复用 |
| main.ts 路由 | `main.ts` | 单纯事件分发 |
| ProxyClient | `client.ts:471-475` | no-op 透传 Proxy，与协议无关 |

**这意味着**：LAN 改造时这些文件**完全不动**。改动集中在 4G 专属层。
