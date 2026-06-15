# UartNode v4 重构设计

| 字段 | 值 |
|---|---|
| **状态** | **draft**（等 cairui 拍板） |
| **作者** | agent-a1afa567aa0d (uart-node) |
| **日期** | 2026-06-15 |
| **目标版本** | UartNode v4.0.0 |
| **前置文档** | `AGENTS.md` / `.harness/docs/architecture/source-map.md` / `.harness/docs/rfcs/001-lan-gateway-support.md` / [uart-pesiv-node](file:///Users/cairui/Code/uart-pesiv-node) |

## 0. 摘要

把 UartNode 从"入门作品"重构到"生产级质量"，**完全参考 `uart-pesiv-node` 已验证的架构**——两者共享 node↔server 通路（Socket.IO + HTTP），区别只在 DTU 接入侧。

核心改动：
1. **按层分包**：`config` / `protocol` / `services` / `dtus` / `server`
2. **class 化基础设施**：`IOClient` / `Uploader` / `TcpServer` 全部从"顶层副作用单例"变成"可注入 class"
3. **类型化事件 + payload**：`events.ts` 集中所有 Socket.IO 事件名和数据结构
4. **队列化 HTTP 上传**：从"打一次 log 一次"变成"队列 + 背压 + 重试 + 优雅关闭"
5. **配套 bun test 单测**：从 0 个 spec 起步，跟随每个重构 commit 增加
6. **依赖收紧**：只新增 `pino`（结构化日志，可选）

**不动的**：跟 server 端的协议契约（Socket.IO 事件名 / payload shape / HTTP path）、PR #20 鉴权、NODE_TOKEN 部署流程、Dockerfile。

## 1. 设计原则

### 1.1 复用 pesiv 的架构

`uart-pesiv-node` 已经在生产跑通了这套架构——同一个 cairui、同一个 uart-server、同一个 PR #20。**直接抄**：

| 设计模式 | pesiv 体现 | UartNode 重构体现 |
|---|---|---|
| **class + factory 单例** | `getIOClient() / setIOClient(mock)` | 同 |
| **类型化事件常量** | `EVENT.terminalOn` 不写魔法字符串 | 同 |
| **payload 类型集中** | `services/events.ts` 集中 `RegisterConfig` / `QueryObject` / `InstructQueryResult` | 同 |
| **service 显式 bindLifecycle** | `io-client.ts:bindLifecycle()` | 同 |
| **队列 + 背压 + 重试 + drain** | `services/uploader.ts` | 同 |
| **protocol 纯函数** | `protocol/pesiv.ts` JSON 表 + 纯函数解析 | `protocol/hanfong-cellular.ts` |
| **service 拆开** | `services/` 7 个文件 | 同 |

### 1.2 不抄的部分

pesiv 是 **UPS 卡**（UDP 上行 + TCP debug + 单设备），UartNode 是 **多 DTU**（TCP Server + 多设备）。区别决定：

- pesiv 用 `PesivSessionTable`（mac → session）管理**多设备**——UartNode 是 `MacSocketMaps: Map<mac, Client>`，**同样的模式**
- pesiv 用 UDP——UartNode 用 TCP——协议层不同，但**封装模式可以一样**
- pesiv 用 Bun `--compile` 单文件二进制——UartNode 用 Docker 两阶段 + JS bundle。**这个保留**（UartNode 跑在容器里，单文件 binary 没意义）

### 1.3 入门作品 → 生产级：什么变了

| 维度 | 入门作品（v3.3.0）| 生产级（v4.0.0）|
|---|---|---|
| **入口副作用** | 顶层 `IOClient = socketClient(...)` | `main.ts` 显式 `const io = new IOClient(...)` |
| **单例管理** | 顶层 `export default` | factory `getIOClient() + setIOClient(mock)` |
| **错误处理** | catch + console.log | try/catch + 分类 + 队列 + 重试 |
| **测试** | 0 个 spec | 每个 service 配 1 个 test file |
| **类型** | `strict: true` 但 many sub-flags 注释掉 | 显式开 `noUnusedLocals` / `strictNullChecks` / `noImplicitReturns` |
| **日志** | console.log 散落 | pino logger（或保留 console + 后面再换）|
| **优雅关闭** | 完全无 | SIGINT/SIGTERM → drain → close |
| **Socket 类型** | net.Socket 直接用 | 抽象 `SocketLike` 接口（net + ws 都能套） |

## 2. 目标目录结构

```
src/
├── main.ts                          ← 装配入口（明显小于现在 72 行）
├── config.ts                        ← 全 env 驱动（同 pesiv config.ts）
├── protocol/
│   ├── events.ts                    ← 事件名 + payload 类型（从 pesiv 抄 + 加 cellular 专属）
│   ├── dtu-frame.ts                 ← 串口成帧（200ms 切帧规则 + 512 byte buffer）
│   ├── hanfong-cellular.ts          ← 4G DTU 协议（注册包解析、AT 响应解析）
│   └── index.ts                     ← barrel
├── services/
│   ├── io-client.ts                 ← Socket.IO 客户端（class + factory，几乎直接抄 pesiv）
│   ├── uploader.ts                  ← HTTP 上传（队列 + 背压 + 重试，几乎直接抄 pesiv）
│   ├── dtu-info.ts                  ← nodeInfo()（同 pesiv util/node-info.ts）
│   ├── at-parse.ts                  ← AT 响应解析（从 tool.ts 抽）
│   └── index.ts
├── dtus/
│   ├── base.ts                      ← 抽象基类 Dtu（mac / lifecycle / send / restart）
│   ├── cellular.ts                  ← CellularDtu extends Dtu（4G/2G/NB 实现）
│   └── index.ts
└── server/
    ├── tcp-server.ts                ← TcpServer（class + factory，extends net.Server）
    ├── register-handler.ts          ← 注册包嗅探 + 解析
    └── index.ts

test/
├── config.test.ts
├── protocol/
│   ├── dtu-frame.test.ts
│   └── hanfong-cellular.test.ts
├── services/
│   ├── io-client.test.ts            ← mock socket.io-client
│   ├── uploader.test.ts             ← 直接抄 pesiv 的 8 个 describe
│   ├── dtu-info.test.ts
│   └── at-parse.test.ts
├── dtus/
│   └── cellular.test.ts             ← mock net.Socket
└── server/
    ├── tcp-server.test.ts
    └── register-handler.test.ts

types/
└── uart.d.ts                        ← 现有保持（types 是 project root，不是 src/）
```

## 3. 关键架构决策

### 3.1 IOClient class 化（直接抄 pesiv）

```ts
// src/services/io-client.ts
export class IOClient {
  private socket: Socket
  private connected = false

  constructor(opts: IOClientOptions) {
    this.socket = ioClient(opts.uri, { /* PR #20 三通道 */ })
    this.bindLifecycle()
  }

  on<T>(event: EventName, handler: (payload: T) => void): void
  onAck<T, R>(event: EventName, handler: (payload: T, ack: (resp: R) => void) => void): void
  emit(event: EventName, ...args: unknown[]): void
  terminalOn(mac: string, reline?: boolean): void
  terminalOff(mac: string): void
  close(): void
}

let _instance: IOClient | null = null
export function getIOClient(): IOClient { ... }
export function setIOClient(client: IOClient) { _instance = client }
```

**好处**：
- 测试可以 `setIOClient(mockIOClient)` 注入
- lifecycle handler 集中管理
- 业务代码用 `io.terminalOn(mac, true)` 而不是 `IOClient.emit('terminalOn', mac, false)`

### 3.2 Uploader 队列化（直接抄 pesiv）

把 `fetch.ts`（66 行打一次 log）替换成完整 uploader（165 行）：

```ts
// src/services/uploader.ts（结构照抄 pesiv）
const queue: QueueItem[] = []
let inflight = 0
let closed = false

export function enqueue(path: string, body: unknown): boolean { ... }
export function uploadQueryData(data: QueryResult): boolean { ... }
export function uploadDtuInfo(info: DtuInfo): boolean { ... }
export function uploadNodeInfo(name: string, node: NodeInfo, tcp: number): boolean { ... }
export function drainQueue(timeoutMs: number): Promise<void> { ... }
export function closeUploader(): void { ... }

// 测试钩子
export function __setNodeTokenForTest(token: string | null) { ... }
export function __setServerUrlForTest(url: string | null) { ... }
export function __resetUploaderForTest() { ... }
```

**关键不变量**（每条都对应一个 test）：
1. 入队顺序 = fetch 调用顺序
2. HTTP 5xx 和网络错误都重试
3. `UPLOAD_RETRY_MAX` 后放弃
4. `inflight <= UPLOAD_CONCURRENCY`
5. 队列满 → drop oldest
6. `closed` 后 `enqueue` 返回 false
7. `drainQueue` 等队列清空
8. NODE_TOKEN 注入 header

### 3.3 events.ts 集中类型化（直接抄 pesiv）

```ts
// src/protocol/events.ts
export const EVENT = {
  terminalOn: 'terminalOn',
  terminalOff: 'terminalOff',
  terminalMountDevTimeOut: 'terminalMountDevTimeOut',
  instructTimeOut: 'instructTimeOut',
  register: 'register',
  instructQuery: 'instructQuery',
  DTUoprate: 'DTUoprate',
  registerSuccess: 'registerSuccess',
  ready: 'ready',
  startError: 'startError',
  query: 'query',
  accont: 'accont',
  nodeInfo: 'nodeInfo',
  deviceopratesuccess: 'deviceopratesuccess',
  dtuopratesuccess: 'dtuopratesuccess',
  alarm: 'alarm'
} as const

export type EventName = typeof EVENT[keyof typeof EVENT]

export interface RegisterConfig { /* 现有 types/uart.d.ts 的字段 */ }
export interface QueryObject { /* ... */ }
// ... 其他 payload 类型
```

**好处**：
- magic string `'terminalOn'` → `EVENT.terminalOn`（编译器提示）
- payload 类型跟事件名在同一文件
- 跟 pesiv 同构 → **将来可以从 `uart-pesiv-node` 提公共包**

### 3.4 Dtu 抽象基类

```ts
// src/dtus/base.ts
export abstract class Dtu {
  readonly mac: string
  protected socket: net.Socket
  protected io: IOClient
  protected cache: QueryItem[] = []
  protected timeOut = new Map<number, number>()
  protected pids = new Set<number>()

  constructor(socket: net.Socket, mac: string, io: IOClient) {
    this.socket = socket
    this.mac = mac
    this.io = io
  }

  /** 设备上线后异步初始化（4G: 批量查 AT；LAN: HTTP API） */
  abstract initialize(): Promise<void>

  /** 重启设备（4G: AT+Z; LAN: HTTP /reboot） */
  abstract restart(): Promise<void>

  /** 处理查询请求 */
  async handleQuery(query: queryObjectServer): Promise<void> {
    // 通用 FIFO 队列 + 超时 10 次硬重启
    this.cache.push(query)
    await this.processQueue()
  }

  protected abstract processQueue(): Promise<void>

  /** 通用：socket close 时通知 server */
  onSocketClose(): void {
    this.io.terminalOff(this.mac, true)
  }
}

// src/dtus/cellular.ts
export class CellularDtu extends Dtu {
  async initialize() {
    // 批量查 PID/VER/GVER/IOTEN/ICCID/LOCATE/UART/GSLQ
    // 关 IOTEN 省流量
    // 上报 dtuInfo
  }
  async restart() {
    // AT+Z
    // 等 60s 重连
  }
  protected async processQueue() { /* ... */ }
}
```

**好处**：
- 4G 和 LAN 都继承同一个基类，**queue / timeout / restart 策略通用**
- 未来 RFC 001 落地时直接 `LanDtu extends Dtu`，不用重写队列逻辑
- 基类可测（mock socket + mock io）

### 3.5 TcpServer class 化（不再 `extends net.Server`）

```ts
// src/server/tcp-server.ts
export class TcpServer {
  private server: net.Server
  private macSocketMaps = new Map<string, Dtu>()
  private sniffers: ProtocolSniffer[] = [new CellularSniffer(), new LanSniffer()]
  private registerHandlers: RegisterHandler[] = [new CellularRegisterHandler()]

  constructor(private conf: RegisterConfig, private io: IOClient) {
    this.server = net.createServer(socket => this.onConnection(socket))
  }

  listen(port = config.localport, host = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => resolve())
    })
  }

  /** IOClient.on('restart') 触发（server 端重启 TCP server 指令） */
  async restart(): Promise<void> {
    for (const dtu of this.macSocketMaps.values()) dtu.destroy()
    this.macSocketMaps.clear()
    await new Promise(r => this.server.close(() => r(undefined)))
    await this.listen()
  }

  /** 给 server 下行指令（query / AT / operate） */
  bus<T>(eventType: eventType, query: T): void {
    const dtu = this.macSocketMaps.get(query.DevMac)
    dtu?.handleQuery(query as any)
  }

  private onConnection(socket: net.Socket): void {
    // 1) sniff 第一个包
    socket.once('data', firstPacket => {
      const sniffer = this.sniffers.find(s => s.match(firstPacket))
      if (!sniffer) return socket.destroy()
      // 2) 调对应 handler 接管
      const handler = sniffer.handler()
      handler.handle(socket, firstPacket, this.macSocketMaps, this.io)
    })
  }
}

interface ProtocolSniffer {
  match(firstPacket: Buffer): boolean
  handler(): RegisterHandler
}

interface RegisterHandler {
  handle(socket: net.Socket, firstPacket: Buffer, map: Map<string, Dtu>, io: IOClient): void
}
```

**好处**：
- **不再 `extends net.Server`**——TcpServer 自己 `net.createServer()`，避免继承冲突
- sniffers / handlers 都是 interface + 数组，**未来加 LAN 直接 push 一个 `LanSniffer`**
- 4G 行为**完全保留**（CellularSniffer + CellularRegisterHandler 是现有逻辑的封装）
- listen / restart 返回 Promise，`async/await` 自然

### 3.6 register-handler.ts 拆分

把现在 `TcpServer._Connection`（`TcpServer.ts:68-116`）里 50 行的"10s 推 AT + URLSearchParams 解析"抽出来：

```ts
// src/server/register-handler.ts
export class CellularRegisterHandler implements RegisterHandler {
  handle(socket, firstPacket, macMap, io) {
    // 1) 注册包解析
    const args = new URLSearchParams(firstPacket.toString())
    if (!args.has('register') || !args.has('mac')) {
      socket.end('please register DTU IMEI')
      return socket.destroy()
    }
    const mac = args.get('mac')!.slice(-12)

    // 2) 已存在 -> reConnect；不存在 -> 新建
    let dtu = macMap.get(mac)
    if (dtu) dtu.reconnect(socket)
    else {
      dtu = new CellularDtu(socket, mac, io)
      macMap.set(mac, dtu)
      io.terminalOn(mac, false)
    }
  }
}

export class CellularSniffer implements ProtocolSniffer {
  match(firstPacket) {
    return firstPacket.toString('utf8', 0, 9).startsWith('register&')
  }
  handler() { return new CellularRegisterHandler() }
}
```

**好处**：
- `TcpServer._Connection` 从 50 行缩到 10 行
- `CellularSniffer.match` 单独可测（不用起 net.Server）
- `CellularRegisterHandler.handle` 单独可测（mock socket）

### 3.7 错误处理模型（**cairui 拍板**）

> 现状问题：
> - `client.ts:282-285` query 失败直接 `console.log` 走人，**不重试、不上报**——上层完全不知道
> - `client.ts:435` `OprateParse` 错误响应**只在 message 里写"操作失败"**——server 端拿到 msg 字符串才能判断
> - `fetch.ts:60` HTTP 失败**catch 完就 return err**——调用方不区分是网络错还是 5xx
> - `TcpServer.ts:73-79` 推 AT 失败**没有反馈**——DTU 收没收到完全黑盒
>
> 跟 `uart-pesiv-node` 对齐的策略：**业务层 throw + 边界层 catch + console 分级**——**不引** neverthrow / fp-ts。

#### 3.7.1 错误分类（**所有 service / dtus 共享**）

```ts
// src/util/errors.ts（新文件）
/** 错误分类 —— 用 instanceof + 类型守卫，**不**用枚举/字符串码 */
export class DTUError extends Error {
  constructor(
    message: string,
    public readonly code: 'AT_TIMEOUT' | 'AT_PARSE_FAIL' | 'SOCKET_CLOSED' | 'INVALID_REGISTER' | 'PROFILE_CACHE_FAIL',
    public readonly cause?: unknown
  ) { super(message); this.name = 'DTUError' }
}

export class NetworkError extends Error {
  constructor(
    message: string,
    public readonly code: 'HTTP_5XX' | 'HTTP_4XX' | 'FETCH_TIMEOUT' | 'CONN_REFUSED',
    public readonly status?: number,
    public readonly cause?: unknown
  ) { super(message); this.name = 'NetworkError' }
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: 'BAD_REGISTER_PACKET' | 'BAD_AT_RESPONSE' | 'BAD_SOCKET_FRAME' | 'WRONG_SNIFF',
    public readonly cause?: unknown
  ) { super(message); this.name = 'ProtocolError' }
}
```

**为什么不引 neverthrow / fp-ts**：
- 跟 pesiv 完全一致（pesiv 也是纯 throw + console）
- 不引新依赖
- 业务代码不复杂到需要 Result 链式调用
- catch 边界明确（uploader / main），不会"异常飘到不该去的地方"

#### 3.7.2 错误处理策略（**三级**）

| 层级 | 策略 | 日志级别 | 例子 |
|---|---|---|---|
| **业务层**（service / dtus）| **throw**（不 catch，让调用方决定）| — | `if (!res.ok) throw new NetworkError('HTTP ${res.status}', 'HTTP_5XX', res.status)` |
| **边界层**（uploader / io-client / dtu.handleQuery）| **catch + 重试 / 降级 / 上报** | `console.warn`（可恢复） / `console.error`（不可恢复）| `uploader.ts` catch → 指数退避重试 → 超过 max 改 console.error |
| **顶层**（main.ts）| `main().catch(err => { console.error; process.exit(1) })` | `console.error` | 启动失败立即退出（fail fast）|

**关键模式**：

```ts
// src/dtus/cellular.ts（伪代码）
class CellularDtu extends Dtu {
  async queryAT(content: string, timeoutMs = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DTUError(`AT timeout: ${content}`, 'AT_TIMEOUT'))
      }, timeoutMs)
      this.socketsb!.write(Buffer.from(`+++AT+${content}\r`), /* lock */ true)
        .then(({ buffer }) => {
          clearTimeout(timer)
          const parsed = tool.ATParse(buffer)
          if (!parsed.AT) {
            return reject(new DTUError(`AT failed: ${content}`, 'AT_PARSE_FAIL', parsed))
          }
          resolve(parsed.msg)
        })
        .catch(err => {
          clearTimeout(timer)
          reject(new DTUError(`AT write failed: ${content}`, 'SOCKET_CLOSED', err))
        })
    })
  }

  // 上层批量调用 —— 业务层不 catch，让一个失败**记录**不阻塞其它
  async refreshIdentity() {
    const queries = ['PID', 'IMEI', 'ICCID', 'IMSI', 'GSLQ']
    const results = await Promise.allSettled(queries.map(q => this.queryAT(q)))
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        Object.assign(this.profile, { [queries[i]!]: r.value })
      } else {
        // 边界层 catch: 记录 + 继续
        console.warn(`[dtu ${this.mac}] ${queries[i]} failed: ${r.reason.message}`)
        this.health.consecutiveFailures++
      }
    })
  }
}
```

#### 3.7.3 错误信息规范化

**所有错误信息格式**：

```
[<layer>] <context>: <what>: <why>
```

例子：
- `[dtu 98D863CC870D] AT timeout: AT+IMEI: 5000ms`
- `[uploader] /queryData failed: HTTP 500: 1st attempt, retrying`
- `[io] connect_error: server rejected: NODE_TOKEN invalid`
- `[tcp-server] sniff fail: first 9 bytes = "GET / HTTP", not register&`

**好处**：
- `grep` 容易（`<layer>]` 开头）
- 包含 context（mac / path / event）便于排查
- 包含 why（不只说"失败"）

#### 3.7.4 错误上报到 server

**4 类错误主动上报**（**cairui 拍板 2026-06-15：4 个值跟 §12.4 对齐**）：

| 错误 | 上报事件 | Payload |
|---|---|---|
| `AT_TIMEOUT`（连续 3 次）| `EVENT.dtuAlert` | `{ mac, type: 'AT_TIMEOUT', code, message }` |
| `INVALID_REGISTER`（非注册包连接）| `EVENT.dtuAlert` | `{ mac: null, type: 'INVALID_REGISTER', remoteAddr, firstPacket }` |
| `PROFILE_CACHE_FAIL`（连续 5 次拉失败）| `EVENT.dtuAlert` | `{ mac, type: 'PROFILE_CACHE_FAIL' }` |
| **FATAL**（main.ts 兜底）| `EVENT.dtuAlert` | `{ mac: null, type: 'FATAL', message, stack }` |

**为什么 FATAL 也走 `dtuAlert`**（**cairui 拍板**：不抽到 `alarm`）：
- **统一告警通道**——server 端告警系统一个 dtuAlert 事件全接
- **语义不绝对**——`alarm` 在 server 端是"全 Node 告警"（不是设备），会触发 server-admin 介入；`FATAL` 是**进程级**，但本质上也是"这台 Node 出问题了"，**用 dtuAlert 合理**
- **5 分钟内同 mac+type+message 去重**（**cairui 拍板**）——server 端加去重，避免 FATAL 重启循环刷屏

**`EVENT.alarm` 留给什么**：**Node 进程级非设备告警**（如启动失败 / 配置错误 / 鉴权拒绝 / 内存 / CPU 异常）——独立通道，不跟设备 dtuAlert 混。RFC 002 **暂不实现** `EVENT.alarm` 上报，留二期。

**为什么用 `EVENT.dtuAlert` 而不是 HTTP**：跟现有 `dtuAlert` 事件对齐（§12.4）—— server 端已经规划。

### 3.8 测试 mock 架构（**cairui 拍板**）

> 现状问题：
> - UartNode 0 个 spec（AGENTS.md 已记）
> - `TcpServer.ts` / `socket.ts` / `client.ts` 整套 net 逻辑**没在生产跑过**——必须靠单测保护
> - 但 `net.Socket` 不容易 mock（事件多、状态异步）
>
> 跟 `uart-pesiv-node` 对齐的策略：**真实 socket + 0 端口**（用于测试 server）+ **`mock()` 覆盖 globalThis.fetch**（用于测试 HTTP）——**不引** sinon / nock / msw。

#### 3.8.1 三层 mock 工具

```ts
// test/util/wait-for.ts（公用）
/** 等到 predicate 为 true，或超时抛错 */
export async function waitFor(predicate: () => boolean, timeoutMs = 1000, intervalMs = 5): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`)
}

// test/util/fetch-mock.ts（公用 —— 直接抄 pesiv uploader.test.ts）
import { mock } from 'bun:test'

type FetchBehavior = 'ok' | (status: number) => Response

export function installFetchMock(opts: {
  behavior?: FetchBehavior
  delayMs?: number
  onCall?: (url: string, init?: RequestInit) => void
} = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const realFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = mock(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    opts.onCall?.(url, init)
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
    if (typeof opts.behavior === 'function') return opts.behavior(0)
    if (opts.behavior === undefined || opts.behavior === 'ok') {
      return new Response(null, { status: 204 })
    }
    return new Response('boom', { status: 500 })
  }) as unknown as typeof fetch

  return {
    calls,
    restore: () => {
      ;(globalThis as { fetch: typeof fetch }).fetch = realFetch
    }
  }
}

// test/util/tcp-client.ts（公用 —— 直接抄 pesiv tcp-debug.test.ts）
import { connect, type Socket } from 'node:net'

/** 客户端连 0 端口（OS 自动分配），Nagle 关闭 */
export function connectAndNoDelay(port: number, host = '127.0.0.1'): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, host)
    sock.once('connect', () => {
      sock.setNoDelay(true)
      resolve(sock)
    })
    sock.once('error', reject)
  })
}
```

#### 3.8.2 三类 mock 用法

| 测试对象 | 策略 | 为什么 |
|---|---|---|
| **uploader** | `installFetchMock()` 覆盖 `globalThis.fetch` | HTTP 是外部 IO，**真实起 server 测会拖慢 + 不可移植** |
| **io-client** | **真实 socket.io-client 起 0 端口** mock server | Socket.IO 协议复杂，自己 mock 等于重写；0 端口真实 server 跑几 ms 就退出 |
| **tcp-server / dtus** | **真实 net.Socket 连 0 端口** | 跟 pesiv 一致；TCP 流协议 chunk 边界只有真实 socket 才能测 |
| **events / uploader / dtu-info / at-parse** | **直接 import + 调纯函数** | 纯函数，0 mock |

#### 3.8.3 测试组织约定

每个 test file 头部注释**必填**：

```ts
/**
 * <service> 单元测试
 *
 * 测试范围：
 *   1. <不变量 1>
 *   2. <不变量 2>
 *
 * Mock 策略：
 *   - fetch: installFetchMock()（覆盖 globalThis.fetch）
 *   - Socket: 真实 net.Socket 连 0 端口
 *   - 纯函数: 直接 import
 *
 * 注意事项：
 *   - <任何非显然的坑>
 */
```

#### 3.8.4 覆盖率门槛

**Phase 1 起步**（cairui 拍板 60%）：
- `config.ts` / `events.ts` / `at-parse.ts` / `dtu-info.ts` 100%
- `IOClient` / `Uploader` / `Dtu base` 80%+
- `TcpServer` / `CellularDtu` 60%+（剩余 40% 留给集成测试）

**Phase 2 末尾**：提升到 80%。

**Phase 3 末尾**：稳定在 80%，**剩下的 20% 留给 staging 真机回归**（AGENTS.md 强约束）。

#### 3.8.5 不引的依赖（**cairui 拍板**）

- ❌ `sinon` — bun test 自带 `mock()`
- ❌ `nock` — 用 `installFetchMock` 就够
- ❌ `msw` — 跟 `sinon` 一样理由
- ❌ `jest-mock-extended` — bun test 自带
- ❌ `testcontainers` — staging 24h 真机回归更直接



### 4.1 tsconfig 严格化

`tsconfig.json` 现在 `strict: true` 但 `strictNullChecks` / `noUnusedLocals` / `noImplicitReturns` 注释掉。把这些**显式打开**：

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,          // 客户端.ts 里的 unused 变量会被编译器抓住
    "noUnusedParameters": true,
    "noImplicitReturns": true,       // 避免 ProcessingQueue 这种 if 漏 return
    "noFallthroughCasesInSwitch": true,
    "strictNullChecks": true,        // 显式（虽然 strict: true 默认开了）
    "exactOptionalPropertyTypes": true  // 强制区分 ? 和 undefined
  }
}
```

**这会强制改写**：
- `client.ts:39` 的 `private Cache: ...[]` + `this.Cache = []` 写法 → 拆基类
- `client.ts` 里大量 `this.X!.do()` 非空断言 → 类型化后不用断言
- `client.ts:194` 的 `QueryAT` 返回 `{ AT: boolean, msg: string }` 不一致 → 统一 Result 类型

### 4.2 新增依赖（最少化）

```jsonc
{
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^6.0.0"
  }
}
```

**不引**：
- ❌ pino / winston（先用 console.log + `bun test --watch` 验证；引日志框架要看实际需求）
- ❌ zod / io-ts（运行时校验太重，先靠 TypeScript 静态校验）
- ❌ ts-node / tsx（Bun 已经能跑 TS）

**可能要引**（决策点）：
- ⚠️ **pino**：日志结构化。如果 cairui 想要"日志能 grep 业务字段"，再引

### 4.3 单测依赖：bun test 自带

`bun test` 已经在 `package.json` 里有 `test` / `test:watch` / `test:coverage` 脚本——但 UartNode 那边没有，需要加：

```jsonc
{
  "scripts": {
    "test": "bun test",
    "test:watch": "bun test --watch",
    "test:coverage": "bun test --coverage"
  }
}
```

**不引** jest / vitest —— bun test 够用。

## 5. 不破坏现有行为

下面这些 **AGENTS.md 已声明的生产纪律**，重构时**严格保持**：

| 纪律 | 重构后对应实现 |
|---|---|
| NODE_TOKEN 不能进 Dockerfile | config.ts 走 `process.env.NODE_TOKEN ?? ''`（保持）|
| 全 env 驱动，**不要** `isProd` / `NODE_ENV` 模式判断 | config.ts 不动，**新增** `LAN_TOPOLOGY` / `LAN_KNOWN_DEVICES_URL` env |
| TCP server 默认端口 9000 | `config.localport` 不动 |
| PR #20 鉴权三通道 | IOClient class 内部仍走三个通道 |
| 跟 `uart-pesiv-node` 对齐 | **本次重构就是跟 pesiv 对齐** |
| 不动 Socket.IO 事件名 / payload shape | `protocol/events.ts` **字段照抄** pesiv + UartNode 已有 |
| 不动 HTTP `/api/node/*` 路径 | `services/uploader.ts` 路径不变 |

## 6. 阶段划分（**草案**）

> 每阶段**一个独立 PR**，**独立可合并**。每阶段结束：
> 1. CI 全绿
> 2. 类型检查无错
> 3. 单测覆盖率 ≥ 50%（目标）
> 4. 24h staging 回归（如改了 net 那一层）

### Phase 1：基础设施层（**约 1-2 天**）

- 加 `test` / `test:watch` / `test:coverage` 脚本
- 写 `src/protocol/events.ts`（直接抄 pesiv）
- 写 `src/services/io-client.ts`（直接抄 pesiv，加 Cellular 专属事件）
- 写 `src/services/uploader.ts`（直接抄 pesiv）
- 写 `src/services/dtu-info.ts`（直接抄 pesiv util/node-info.ts）
- 配套 8 个 test file
- `main.ts` 暂不动（仍是顶层副作用），**但所有 import 走新路径**

**验收**：8 个 test file 通过；现有功能**0 变化**；`bun run start` 起来后行为跟重构前完全一致

### Phase 2：TcpServer / Dtu 抽象（**约 2-3 天**）

- 写 `src/dtus/base.ts` + `src/dtus/cellular.ts`
- 写 `src/server/tcp-server.ts` + `src/server/register-handler.ts`
- 改 `main.ts` 用新的 TcpServer class
- 配套 3 个 test file

**验收**：staging 24h 回归（这条**AGENTS.md 强约束**，必须走）

### Phase 3：类型收紧 + tool.ts 拆 at-parse（**约 1 天**）

- tsconfig 开 `noUnusedLocals` 等
- 修新代码里冒出来的 unused 变量
- 拆 `tool.ts` 的 `ATParse` 到 `services/at-parse.ts`
- 配套 1 个 test file

**验收**：所有现有 test 通过；`bun --check` 无错

### Phase 4（**可选，二期**）：LAN 支持

- RFC 001 落地
- `src/protocol/hanfong-cellular.ts` 拆出 `src/protocol/lan-gateway.ts`
- `dtus/lan.ts` extends Dtu
- `server/lan-sniffer.ts` + `register-handler.ts`
- 配套 N 个 test file

**不在本次范围**——cairui 没明确说要现在做 LAN。

### 6.5 PR 顺序（**草案**——每个 PR 独立可合并）

> 原则：**PR 之间无强依赖**——前一个 PR 不合，下一个也能开。
> 这样 cairui review 累的时候可以**先合简单的**（Phase 1），**复杂的留 staging 24h 回归**（Phase 2）。

#### PR #1：`test` 骨架 + `events.ts` + `io-client.ts`（cairui 拍板）

- 加 `test` / `test:watch` / `test:coverage` 脚本
- 新建 `src/protocol/events.ts`（直接抄 pesiv + UartNode 已有事件名）
- 新建 `src/services/io-client.ts`（class + factory + lifecycle）
- 改 `src/IO.ts` **import 路径**（行为不变，**纯重命名**）
- 新建 `test/protocol/events.test.ts` + `test/services/io-client.test.ts`
- 不动 `src/TcpServer.ts` / `src/client.ts` / `src/socket.ts`

**验收**：单测过；`bun start` 起来行为 1:1 不变；没改 `package.json` 依赖。

**估时**：1 天。

#### PR #2：`uploader.ts` + `dtu-info.ts` + 配套测试

- 新建 `src/services/uploader.ts`（直接抄 pesiv）
- 新建 `src/services/dtu-info.ts`（直接抄 pesiv util/node-info.ts）
- 改 `src/fetch.ts` **复用 uploader**（保留 `fetch.dtuInfo` / `fetch.queryData` / `fetch.nodeInfo` API 表面）
- 新建 `test/services/uploader.test.ts` + `test/services/dtu-info.test.ts`

**验收**：8 个 describe block 14 个 test 全过；现有行为 1:1；HTTP 行为有重试 + 背压（**改善**）。

**估时**：1-2 天。

#### PR #3：`at-parse.ts` 拆 + `tool.ts` 瘦身

- 新建 `src/services/at-parse.ts`（`tool.ATParse` 拆出来 + 加 Result 类型 + 错误信息规范化）
- `src/tool.ts` 留下 `NodeInfo`（准备 PR #2 的 dtu-info.ts 拆了之后清空 `tool.ts`）
- 新建 `test/services/at-parse.test.ts`

**验收**：单测过；`ATParse` 行为 1:1；`tool.ts` 行数 -30%。

**估时**：0.5 天。

#### PR #4：`Dtu` 抽象 + `CellularDtu` 实现（**staging 24h 回归必须**）

- 新建 `src/dtus/base.ts`（抽象基类，queue / timeout / restart 通用）
- 新建 `src/dtus/cellular.ts`（现状 8 条 AT 查 + 重启策略 + 重连）
- 改 `src/client.ts` → 改成 `CellularDtu` 继承 `Dtu`（行为 1:1，**纯重写**）
- 新建 `test/dtus/base.test.ts` + `test/dtus/cellular.test.ts`（mock socket）

**验收**：
- 单测过
- **staging 24h 真机回归**（AGENTS.md 强约束）—— DTU 注册包解析 / AT 收发 / 长连接 / 被动断开 / 主动重启
- 重构后行为 1:1

**估时**：2-3 天（含 24h 回归观察）。

#### PR #5：`TcpServer` class 化 + `register-handler.ts` 拆分（**staging 24h 回归必须**）

- 新建 `src/server/tcp-server.ts`（class + factory + sniffers 数组）
- 新建 `src/server/register-handler.ts`（`CellularSniffer` + `CellularRegisterHandler`）
- 改 `src/TcpServer.ts` → 改名 `server/tcp-server.ts`，行为 1:1
- 新建 `test/server/tcp-server.test.ts` + `test/server/register-handler.test.ts`

**验收**：staging 24h 真机回归（DTU 首次连 / 重连 / 注册包错 / 拒连）。

**估时**：2-3 天（含 24h 回归观察）。

#### PR #6：状态机 + 健康度评分（**staging 24h 回归必须**）

- 新建 `src/dtus/state.ts`（`DtuState` enum + 健康度计算函数 + 转换函数）
- 集成到 `Dtu` 基类
- 3 个新 Socket.IO 事件（`dtuState` / `dtuHealth` / `dtuAlert`）—— **需 server 端 agent 协调**
- 新建 `test/dtus/state.test.ts`（**纯函数**，0 mock）

**验收**：单测过；staging 24h；server 端能收到 `dtuState` / `dtuHealth` 事件。

**估时**：2-3 天（含 24h 回归 + 跨项目协调）。

#### PR #7：AT 采集分层（**server 端接口已就绪**）

- 新建 `src/dtus/profile-cache.ts`（`fetchProfileCache` / `writeProfileCache` / `invalidateProfileCache`）
- 改 `CellularDtu.initialize`：register 路径上 `GET cache → 命中则只查动态/未命中则全量查 → 写回 server`
- 加 5 个新单测
- 改 `src/services/uploader.ts` 加 `invalidateDtuProfileCache` 便捷方法
- 改 `CellularDtu.onATResponse` 检测 FCLR/RELD/UART=1 响应特征字 → 触发 invalidate

**前置**：server 端 3 个新 HTTP 接口已实现（**§11.6.9 checklist**）。

**验收**：staging 24h；cache 命中时 register 耗时从 ~2s 降到 ~1.5s；version 自增正确。

**估时**：1-2 天。

#### PR #8：tsconfig 严格化 + 类型清理（**重头戏**）

- 打开 `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `noFallthroughCasesInSwitch` / `exactOptionalPropertyTypes`
- 修复新代码里冒出来的 unused 变量 + 不一致 return
- **不修老代码**——保持向后兼容

**验收**：`bun --check` 全绿；老代码（`Cache.ts` / `client.ts` 老部分）保持现状。

**估时**：0.5-1 天。

#### PR #9：清掉 `TcpServer.ts:37, 49` 的 `NODE_ENV` 残留（独立小清理）

- 改成全 env：`process.env.LISTEN_PORT ?? conf.Port ?? config.localport`
- 配套 1 个 test

**前置**：PR #5（`TcpServer` 已 class 化）后做更顺。

**验收**：单测过；staging 24h（AGENTS.md 强约束这条 net 相关）。

**估时**：0.5 天。

#### PR #10：删 `Cache.ts` 死代码（独立小清理）

- 整文件删
- 检查没人 import（rg 确认）

**验收**：`bun --check` 全绿；bundle 体积 -55 行。

**估时**：0.1 天。

#### PR #11：README + AGENTS + `.harness/` 同步（**RFC 落地后**）

- README 重写架构图（9 个文件 → 5 层分包）
- AGENTS.md 加「v4 已落地」状态 + 移除已修掉的"NODE_ENV 残留 / Cache.ts 死代码"
- `.harness/docs/architecture/source-map.md` 改按 5 层写
- `.harness/docs/INDEX.md` 同步
- `.harness/docs/rfcs/002-v4-refactor.md` 状态改 `implemented`

**估时**：0.5 天。

#### PR 合并顺序建议

| 批次 | PR | 估时 | 阻塞 |
|---|---|---|---|
| **第一批**（基础设施）| #1 #2 #3 | 3-4 天 | 无 |
| **第二批**（核心重构）| #4 #5 | 4-6 天 | 需 staging 24h |
| **第三批**（增强）| #6 #7 | 3-5 天 | 需 server 端协调 |
| **第四批**（清理）| #8 #9 #10 #11 | 1-2 天 | 无 |

**总估时 11-17 天**（含 staging 24h 回归观察）。

### 6.6 合并 checklist（**每个 PR 必过**）

- [ ] `bun run typecheck` 全绿
- [ ] `bun run test` 全绿
- [ ] `bun run test:coverage` 覆盖率 ≥ 60%（Phase 1 末），≥ 80%（Phase 2 末）
- [ ] 改动文件清单跟 PR 描述一致（**不夹带**——独立小清理单独 PR）
- [ ] **不引新 npm 依赖**（除 cairui 拍板）
- [ ] **不动** `Dockerfile` / `package.json scripts` / tsconfig 的 `module` `moduleResolution` `target` 这几个**会触发 bun build DCE 的字段**
- [ ] 改 net 那一层（`tcp-server.ts` / `dtus/*.ts` / `socket.ts`）→ 24h staging 真机回归
- [ ] PR 描述里**明列**改动的 4G 专属行为（如有）+ 验证步骤

## 7. 验收标准

### 7.1 每个 PR 必过

- [ ] `bun run typecheck` 全绿
- [ ] `bun run test` 全绿
- [ ] `bun run test:coverage` 单测覆盖率 ≥ 60%（基类 / 工具类 ≥ 80%）
- [ ] 改动文件清单跟 RFC 描述一致
- [ ] 不动 `package.json` 的 dep（除非新增，且经过 cairui 拍板）

### 7.2 完整 v4 必过

- [ ] 8 个 test file + 14+ test cases
- [ ] `bun run start` 起来后**所有现有行为不变**
- [ ] 4G DTU 注册包解析、AT 指令收发、长连接 keepalive、被动断开、主动重启（AT+Z）— **24h staging 真机回归**
- [ ] README.md / AGENTS.md / `.harness/docs/` 同步更新
- [ ] 没引入新 npm dep（除可选 pino）

## 8. 风险与回退

| 风险 | 影响 | 回退 |
|---|---|---|
| IOClient class 化引入 bug | 所有下行事件失败 | 走 PR review + 24h staging |
| Uploader 队列行为跟旧 fetch.ts 不一致 | server 端压力变化 | 保留 fetch.ts 作为 v3 fallback |
| Dtu 抽象基类抽象错了 | 4G 行为 1:1 复刻失败 | 基类**保持最小**，4G 专属方法下放 CellularDtu |
| 类型收紧导致一堆编译错 | 进度拖延 | 收紧**新文件**，老文件**逐步迁移** |

## 9. 决策记录

- **2026-06-15** — 草案创建。基于：
  - 跟 pesiv 架构对齐（cairui 拍板）
  - 生产级代码质量目标（cairui 拍板）
  - 允许拆 src/ + 加测试 + 加依赖（cairui 拍板）
  - 只出设计、不写代码（cairui 拍板）
- **2026-06-15** — v1.1 增量：补 §11 AT 设备信息采集 + §12 生命周期状态机。
  - AT 查询范围：现状 8 条 + 7 条高频补充 = 15 条（cairui 拍板 `at-medium`）
  - 生命周期：8 状态 + health score（cairui 拍板 `sm-medium`）
- **2026-06-15** — v1.2 增量：补 §11.6 Profile Cache 复用机制。
  - cache 有效期：按设备版本号 `cache-version`（cairui 拍板）
  - Node 拉取方式：主动 GET `api-pull`（cairui 拍板）
  - 触发原因（cairui 反馈）：进程重启时 profile 字段被无意义重查

## 10. 待 cairui 拍板的细节

1. ⚠️ **依赖新增**：要 pino（结构化日志）还是先 console.log？
2. ⚠️ **类型收紧节奏**：Phase 3 一次性收紧？还是每改一个文件就收紧一点？
3. ⚠️ **测试覆盖率门槛**：60% 还是 80%？这个数字决定了 Phase 2 的工作量
4. ⚠️ **错误处理风格**：throw 异常 vs Result 类型（neverthrow / fp-ts / 自造 `Result<T, E>`）？
5. ⚠️ **`bun.lock` 同步升级**：pesiv 锁的 bun 版本跟 UartNode 是否一致？要不要顺便对齐？

---

## 11. AT 设备信息采集（cairui 拍板 `at-medium`：现状 8 条 + 7 条高频）

> 现状：`client.run()` 串行查 8 条（PID/VER/GVER/IOTEN/ICCID/LOCATE/UART/GSLQ），
> 上报字段少，server 端只能看到 "这是个 DTU + 一堆空字段"。
> 目标：分**两层采集**（初始化必查 + 后台动态刷新），把"设备画像"做厚。

### 11.1 现状 8 条（**保留**）

| AT | 返回 | 上报字段（现在） | 备注 |
|---|---|---|---|
| `AT+PID` | `id` | `PID` | 设备型号 |
| `AT+VER` | `ver` | `ver` | 应用软件版本 |
| `AT+GVER` | `ver` | `Gver` | GPRS 软件版本（**仅 4G**）|
| `AT+IOTEN` | `status[,start,end]` | `iotStat` | IOTBridge 远程管理状态 |
| `AT+ICCID` | `code` | `ICCID` | SIM 卡 ICCID |
| `AT+LOCATE=1` | `type,longitude,latitude` | `jw` | 基站定位 |
| `AT+UART=1` | `id,baudrate,data_bits,stop_bit,parity,flowctrl[,flag]` | `uart` | 串口参数 |
| `AT+GSLQ` | `status,ret` | `signal` | GPRS 信号强度 |

### 11.2 新增 7 条（**高频有价值**）

| AT | 返回 | 上报字段（新增） | 业务价值 |
|---|---|---|---|
| `AT+IMEI` | 15 字节 IMEI | `imei` | **完整 15 位 IMEI**，跟后 12 位 mac 对账 |
| `AT+IMSI` | 15 字节 IMSI | `imsi` | **运营商识别**（460=移动/01=联通/03=电信）|
| `AT+APN` | `apn,user,password` | `apn { name, user, password }` | 反映运营商网络环境是否正确 |
| `AT+GSMST` | `status,strength` | `network { status, strength }` | 模块状态：`Disconnect` / `Connect` / `SIMNotExist` + 0-31 信号强度 |
| `AT+NTIME` | `second,run_time,time` | `clock { second, runTime, time }` | NTP 时间，**对账设备时钟漂移** |
| `AT+DATA` | `id,send_num,recv_num` | `traffic { sockA: { tx, rx }, ... }` | 收发字节统计，**算吞吐量** |
| `AT+HEART` | `id,time,mode,type,value` | `heartbeat { time, mode, type, value }` | 心跳包配置，**验证 DTU 是否按预期发心跳** |

**新增后总字段**（从现在 ~8 字段 → 14 字段）：

```ts
interface DtuProfile {
  // —— 身份 ——
  mac: string             // **cairui 拍板 2026-06-15：15 位 IMEI 主键**（4G/2G/NB 设备）；LAN 设备是 `mac:98D863000002`（加前缀）
                            // ⚠️ 部署期兼容：当前 mongo 1.45M 条 queryData 仍是 12 位混存（4G IMEI 数字 / LAN MAC hex），
                            //    Node 端 client.run() 阶段 12→15 位 pad 兼容（v4 上报统一 15 位）
                            //    +0.5 人天 data migration（server 端估时）
                            //    详细：.harness/docs/discovery/2026-06-15-server-contract-audit.md §1.1
  imei: string            // 15 位完整 IMEI（新增，主键来源；跟 mac 字段值相同 4G/2G/NB 设备）
  imsi: string            // SIM 卡 IMSI（新增）
  iccid: string           // SIM 卡 ICCID（现有）
  pid: string             // 设备型号（现有）
  host: string            // 主机名（注册包 host 字段）
  // —— 版本 ——
  ver: string             // 应用软件版本（现有）
  gver: string            // GPRS 软件版本（现有）
  appver?: string         // 定制软件版本（**AT+APPVER**——暂不查，先不动）
  // —— 网络 ——
  signal: number          // GPRS 信号强度 0-31（现有）
  network: {              // 模块网络状态（新增）
    status: 'Disconnect' | 'Connect' | 'SIMNotExist'
    strength: number      // 0-31
  }
  apn: {                  // 运营商 APN（新增）
    name: string
    user: string
    password: string
  }
  jw: string              // 经纬度（现有）
  // —— 配置 ——
  uart: string            // 串口参数（现有）
  iotStat: string         // IOTBridge 状态（现有）
  heartbeat: {            // 心跳包配置（新增）
    time: number
    mode: string
    type: string
    value: string
  }
  // —— 运行时 ——
  clock: {                // 设备时钟（新增）
    second: number        // UTC 时间戳
    runTime: number       // 启动至今秒数
    time: string          // 北京时间
  }
  traffic: {              // 流量统计（新增）
    sockA?: { tx: number; rx: number }
    sockB?: { tx: number; rx: number }
    sockC?: { tx: number; rx: number }
  }
}
```

### 11.3 两层采集策略（**关键**）

**问题**：15 条 AT 串行查，初始化耗时从现在的 ~1s 涨到 ~5-10s。每次 DTU 重连都得重跑一遍，**初始化期间所有查询指令都在排队**。

**解决**：分两层。

#### 第一层：初始化必查（**register 路径**）

`client.run()` 阶段必须有的——**身份识别**类，server 端靠这个把 DTU 跟 deviceId 绑定：

```
AT+PID       ← 型号
AT+IMEI      ← 完整 15 位 IMEI（**主键**——cairui 拍板 2026-06-15）
AT+ICCID     ← SIM 卡
AT+IMSI      ← SIM 卡
AT+GSLQ      ← 信号强度（基础健康检查）
```

**5 条**，耗时 ~1-2s。**register 路径上必须完成**才能上报 `terminalOn(mac, forceReport=true)`。

> **关键决策点（已拍板 2026-06-15）**：完整 IMEI **15 位**当主键。
> - **理由**：消除 LAN MAC `98D863xxxxxx` 跟某 4G IMEI 后 12 位的潜在碰撞（RFC 001 §6 提到的）
> - **代价**：老数据需要 data migration（server 端 agent 估时 **+0.5 人天**）——mac 字段从 12 位扩展到 15 位
> - **不保留后 12 位当主键**——`imei` 字段（15 位）和 `macShort` 字段（12 位）都上报，但**主键统一用 15 位**
> - **LAN 设备主键**：MAC 地址 12 字符（hex 大写），加前缀 `mac:`（`98D863000002` → `mac:98D863000002`）——**两套命名空间不撞**（RFC 001 §6 已定）

> 场景：
> - DTU 5 分钟前刚 register 过，profile 完整（IMEI/IMSI/APN/...）
> - **UartNode 进程重启**（bugfix / OOM / k8s 滚动升级）
> - DTU 重新 TCP 连上来 → 走 register 路径 → 又查 15 条 AT
> - **5 分钟前查过的字段没必要重查**——server 端有 cache，Node 拉下来复用即可
>
> 这跟 `uart-pesiv-node` 设计哲学反着——pesiv 是**单设备**，没有这种"重连"问题。UartNode 是**多设备长跑**，这个能力**必须**。

### 11.4 queryData payload 设计（**v1.5 新增 — MongoDB schema 校准**）

> **来源**：进 `mongodb://uart-server.taile0f311.ts.net:27017/UartServer` 采样 1.45M 条 `log.queryData`（2026-06-08 ~ 2026-06-15），
> 配合 server 端 agent (`mvs_56d1e88710c04497a9ec70b8a95fa52b`) 5 答 v1 + 5 答 v2 全 ✅ 验证。
> 完整 audit：`.harness/docs/discovery/2026-06-15-server-contract-audit.md`（620 行 + 12 条约束锁 + grep 行号索引）

#### 11.4.1 一次完整查询周期的 payload 结构（**1 queryResult = 1 queryData**）

```
server 端: 生成 queryObject(content: N 个指令名) → emit('query') 给 node
node 端:   顺序执行 N 条指令（写设备 + 等响应）
           合并 N 个 IntructQueryResult → 1 个 queryResult 上报
server:    INSERT log.queryData 1 条 (TTL 7 天)
```

#### 11.4.2 字段语义（**v1.5 校准 — 跟 server 真实数据对齐**）

| 字段 | 类型 | 语义 | 验证 |
|---|---|---|---|
| `timeStamp` | number (ms) | server emit queryObject 时 `Date.now()`（`socket-io.service.ts:445`） | ✅ |
| `mac` | string (12→15 位) | 设备主键（v4 上报统一 15 位，部署期兼容 12 位混存） | ✅ |
| `type` | number | **物理层接口**（232=RS232 / 485=RS485），**不是协议名** | ✅ |
| `protocol` | string | **协议层协议名**（Pesiv卡 / SL6200-TH-LDS / ...），跟 type 维度正交 | ✅ |
| `mountDev` | string | 挂载设备名 | ✅ |
| `pid` | number | 设备地址，跟 type 强相关 | ✅ |
| `content` | `string \| string[]` | **server→node 协议指令名**（不是 modbus 帧 / 设备业务数据），Pesiv 协议只配 1 条指令退化成单 string | ✅ |
| `Interval` | number (ms) | **下次查询间隔** = server `Math.max(Interval, mountDev.minQueryLimit ?? 0)`（`socket-io.service.ts:254/279`）| ✅ |
| `useTime` | number (ms) | **本次查询总耗时** = N 条子指令 `useTime.reduce(sum)`（`client.ts:375`） | ✅ |
| `useBytes` | number | **本次查询总字节数** = N 条子指令 `useByte.reduce(sum)`（`client.ts:376`）| ✅ |
| `time` | string | **人类可读格式**（`"Mon Jun 08 2026 20:12:39 GMT+0800..."`），**不是 ISO 8601**，原样透传 | ✅ |
| `contents` | `Array<{ content, buffer, useTime, useByte }>` | **设备响应字节**（`buffer.data: number[]`）+ 每条指令 echo content + 单条统计 | ✅ Mixed 兜底 |

#### 11.4.3 content / contents 字段语义（**v1.5 关键纠正**）

**之前猜测（错）**：
- `content`（顶层 array of hex）= modbus RTU 请求帧 / 设备业务数据
- `contents[].buffer.data` = 设备响应字节

**server 端答（对）**：
- **`queryData.content` = server 端生成的「协议指令名」**（`socket-io.service.ts:439` emit 给 node；`uart.d.ts:603` 注释「查询指令」）
- **`queryData.contents[].buffer.data` = 设备响应的真实业务字节**（`dev.parse.processor.ts:595` 落库）
- UartNode 端 `client.ts:375-406` 把每条响应的 buffer 收集起来组 `contents[]` 上报

**Pesiv 卡特例**（`content: 'pesiv'` string 形式）：
- **非 modbus 路径**——`node.controller.ts:213` 触发 Pesiv 分支
- **仍走 queryData 上报**——`node.controller.ts:186` 在 Pesiv 判断前 INSERT `log.queryData`（mongo 26 万条占 19%）
- 解析走 `dev.parse.processor.ts:480` `isPesivProtocol` 分支
- v4 RFC §11.4 **无需 Pesiv 分支设计**（payload 完全通用）

#### 11.4.4 contents[] 是 Mixed 兜底写入（**非 schema 权威**）

**关键事实**（server 端答 v2 Q2）：
- `QueryDataLog` schema（`log.ts:600-654`）**没有** `contents[]` 字段
- 但 `result?: Schema.Types.Mixed` 兜底 + mongoose 全局 `strict: true` 默认 + typegoose `allowMixed: 0`（`log.ts:602`）→ **`contents[]` 整条透传进 create() 落库**
- `globalThis.fetch` 全局 strict 不影响 Mixed 字段

**v4 RFC §11.4 设计原则**：
- ✅ Node 端 v4 上报时**显式带** `contents[]`（server 端继续 Mixed 兜底存）
- ❌ **别假设** server 端类型/校验（schema 没声明）
- 📝 **长期**：RFC 002 实施时把 `contents[]` 加到 `QueryDataLog` schema 显式字段（10 commit 拆解的第 2 个）
- 📝 **命名细节**：顶层 `useBytes`（**复数**）/ `contents[].useByte`（**单数**）—— 命名不一致原样透传，不规范化

#### 11.4.5 完整约束锁（**12 条 ✅ 验证**）

| # | 约束 | 权威代码位置 |
|---|---|---|
| 1 | `queryData.content` = server→node 协议指令名 | `socket-io.service.ts:439` |
| 2 | `queryData.contents[].buffer.data` = 设备响应字节 | `dev.parse.processor.ts:595` |
| 3 | `queryData.useBytes/useTime` = N 条累加 | `client.ts:375-376` |
| 4 | `queryData.Interval` = server Math.max 算的下次间隔 | `socket-io.service.ts:254` |
| 5 | `queryData.timeStamp` = server emit 时 Date.now() | `socket-io.service.ts:445` |
| 6 | `contents[]` Mixed 兜底写入 | `log.ts:602` typegoose allowMixed:0 |
| 7 | `log.queryData` TTL 7 天 | `log.ts:608` |
| 8 | `type` = 物理接口, `protocol` = 协议名, 维度正交 | `node.controller.ts:213` + `socket.controller.ts:245` |
| 9 | `log.dtubusy` = 审计持久化层（**不**主动 emit socket） | `node.socket.controller.ts:432-444` |
| 10 | `Node.minQueryLimit` = interval floor (Math.max) | `socket-io.service.ts:254/279` |
| 11 | `dev.register.minQueryLimit` 字段**不存在**（是 NodeRegister 字段） | `mongo_entity/node.ts:302-303` |
| 12 | Pesiv 卡走 queryData 同一上报路径 | `node.controller.ts:186` 写库在 Pesiv 判断前 |

#### 11.4.6 设计决策（**v4 RFC 必落实**）

1. **TypeScript 类型定义**：`src/protocol/events.ts` 新增 `queryObject` / `queryResult` / `IntructQueryResult` 三个类型，从 `uart` namespace 镜像过来（保持跟 server 端 uart.d.ts 字段名一致）
2. **payload 兼容**：Node 端 v4 上报 payload 跟 §11.4.2 字段表**完全对齐**——14 字段（含 createdAt / __v 不上报）全 optional 加新字段，老字段保留
3. **content 多态**：`string | string[]` 都要支持，Pesiv 卡 string 路径跟 4G array 路径**同一上传函数**
4. **contents[] Mixed 兜底**：v4 上报时**显式带** contents[]，但**别假设** server 端 schema 校验
5. **5min dtuAlert 去重**：§12.4 dtuAlert 上报 5 分钟内同 mac+type+message 不重推（**跟 server 端对齐**——server 端 `socket-io.service.ts` 已经有 30s 同 mac+pid 去重 + 5s 最小查询间隔）
6. **Pesiv 自动注册**：保留 server 端 `socket.controller.ts:235-250` 自动注册路径，Node 端**不**做特殊处理

#### 11.6.1 设计原则（**两项拍板**）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 缓存有效期 | **按设备版本号**（`cache-version`）| 不靠时间，靠 DTU 主动通知"profile 变了"——IMEI/IMSI/ICCID/PID/VER 这些**永不变**，cache 一旦写就是权威，**直到 DTU 自己触发失效** |
| Node 拿 cache 方式 | **主动 GET 拉取**（`api-pull`）| Node 启动 / DTU 重连时 GET，简单可控；**不走 Socket.IO push**（不跟 server 端 registerSuccess 流程耦合）|
| Cache 存储位置 | **server 端**（`uart-server` mongo）| 单点权威，Node 进程重启不丢；多 node 共享 |
| Cache 失效触发 | **DTU 主动上报** profile 变更事件 | AT+FCLR / AT+RELD / AT+UART=1 写操作 → Node 立刻 POST 通知 server invalidate |

**server 端 query 调度 floor**（**2026-06-15 v1.5 校准**）：
- `Node.minQueryLimit`（`mongo_entity/node.ts:302-303`，**default 1000ms**）是 server 端 `Math.max(Interval, mountDev.minQueryLimit ?? 0)` 的 floor（`socket-io.service.ts:254/279`）
- **Node 端 `client.run()` 任意间隔都可以**，server Math.max 兜底，**不强制** ≥15s
- v4 建议 Node 端**尊重这个 floor**——频繁 AT 查询触发 DTU 卡顿
- ⚠️ **不要假设 `dev.register.minQueryLimit` 字段存在**——我之前看错 collection，**该字段在 NodeRegister 不在 dev.register**
- 详细：`.harness/docs/discovery/2026-06-15-server-contract-audit.md` §3.2 Q4

**为什么不用时间过期（`cache-timestamp`）？**

- **IMEI/IMSI/ICCID 出厂定**，写一次就是永真；时间过期会让 Node 没事找事重查
- **配置类（UART/HEART/APN）** 改的频率低（几天/几周一次），按时间过期会"过度查"
- **动态类（signal/traffic）** 本来就要重查，**跟 cache 无关**——cache 只解决"静态/配置类不重查"

**为什么不走 Socket.IO push？**

- push 跟 `registerSuccess` 事件耦合，server 端要保证 push 时机（先查再 push）——容易出 race condition
- GET 拉是**同步可重试**的，Node 失败就降级到全量查，**逻辑简单**

#### 11.6.2 Cache 数据模型

```ts
// server 端 mongo collection: dtuProfileCache
interface DtuProfileCache {
  mac: string                  // **cairui 拍板 2026-06-15：15 位 IMEI 主键**（4G/2G/NB 设备）；LAN 设备是 `mac:98D863000002`（加前缀）
  nodeName: string             // 上报的 node 名称
  profile: DtuProfile          // 完整 DtuProfile（14 字段）
  version: number              // 单调递增版本号（每次 invalidate / 更新 +1）
  updatedAt: number            // ms timestamp（用于 audit / debug，**不用于过期判断**）
  updatedBy: 'initial_query' | 'background_refresh' | 'cache_reuse' | 'dtu_invalidate'
  invalidateHook: {
    // DTU 主动通知时由 Node 写入，server 端保存
    expectedEvent: 'AT+FCLR' | 'AT+RELD' | 'AT+UART=1' | 'user_manual'
    ackAt: number
  } | null
}
```

**`version` 字段的作用**：
- 每次 invalidate / 更新 +1
- Node 上报 dtuInfo 时带 `version`，server 端可以**丢弃旧版本的并发更新**
- debug 友好：日志里看到 "v1 → v2" 一眼就知道"profile 改过一次"

#### 11.6.3 三步流程（**register 路径**）

```
DTU TCP 连上
  ↓
[TcpServer] sniff register&mac=... → CellularRegisterHandler.handle()
  ↓
[1] GET /api/node/dtu-info-cache?mac=98D863CC870D
     ↓
     Server 返回:
       a) 200 + { hit: true, version: 7, profile: {...}, updatedAt: ... }  ← 命中
       b) 200 + { hit: false }                                              ← 没缓存
       c) 404 / 500 / 超时                                                  ← server 异常（**降级到全量重查**）
  ↓
[2] 按结果分支:
     命中: profile = response.profile, version = 7
            重查"动态字段"（GSLQ/GSMST/NTIME/DATA=A,B,C，~6 条, ~1.5s）
            合并 → 上报 dtuInfo (含 version=7)
     未命中: 全量查 5 条必查 (PID/IMEI/ICCID/IMSI/GSLQ, ~1.5s)
            全部完成后 POST /api/node/dtu-info-cache 写入 server (version=1)
  ↓
[3] 启动第二层定时器（同 §11.3）
```

**关键**：**命中** ≠ **完全跳过 AT 查询**，至少查**动态字段**（GSLQ/GSMST/NTIME/DATA）——这些 5 分钟前查的已经过期了。

#### 11.6.4 三种时效性分类（**这是 cache-version 的核心**）

不是所有字段都需要每次重查，按"变化频率"分三类：

| 类别 | 字段 | 频率 | Cache 命中时是否重查 |
|---|---|---|---|
| **静态**（**永不变或极少变**）| `imei` / `imsi` / `iccid` / `pid` / `ver` / `gver` / `appver` | 设备出厂定 | ❌ **跳过**（cache 命中 → 直接用）|
| **配置**（**人/系统改了会变**）| `host` / `uart` / `iotStat` / `apn` / `heartbeat` / `jw` | 偶尔（几天/几周）| ⚠️ **推荐全重查**（~400ms 总开销，换"profile 永远最新"）|
| **动态**（**实时变**）| `signal` / `network` / `clock` / `traffic` | 实时 | ✅ **必须重查** |

**配置类策略选择**：RFC 002 推荐**全重查**——AT+UART=1 / AT+HEART 这种 AT 查询开销小（~100ms 一条），**重查成本低**，换取"profile 永远是最新的"，**避免"上次查的配置跟现在不一致"导致 server 端数据漂移**。

#### 11.6.5 DTU 主动通知 profile 失效

**3 个 AT 操作**会触发 Node 主动通知 server 让 cache 失效：

| 触发 | AT 指令 | Node 检测方式 | 副作用 |
|---|---|---|---|
| **恢复出厂** | `AT+FCLR` | Node 收到 `+ok=rebooting...`（FCLR 响应特征）| Node → `POST /api/node/dtu-info-cache/invalidate` |
| **恢复默认参数** | `AT+RELD` | Node 收到 `+ok`（RELD 响应特征）| 同上 |
| **修改串口参数** | `AT+UART=1,...` | Node 收到 `+ok`（UART 响应特征）| 同上 |
| **人工标记** | （server 端 admin 手动 invalidate）| **暂无接口，未来加** | — |

> **关键**：Node 通过 **AT 响应的特征字**判断是哪个指令，**不需要额外标记**——
> 因为 `+ok=rebooting...` 这种字符串**只可能是 FCLR 产生的**。

```ts
// src/services/uploader.ts（扩展）
export function invalidateDtuProfileCache(mac: string, reason: string): boolean {
  return enqueue('dtu-info-cache/invalidate', { mac, reason })
}
```

#### 11.6.6 Server 端新接口（**需 server 端 agent 协调**）

> ⚠️ **跨项目约束**：这 3 个接口在 `uart-server`（agent-ae682922673b）那侧新建，
> RFC 002 Phase 3 落地前需要跟他们同步、不能擅自假设。

| 方法 | 路径 | 用途 | 请求 | 响应 |
|---|---|---|---|---|
| `GET` | `/api/node/dtu-info-cache` | Node 启动 / 重连时拉 | `?mac=98D863CC870D` | `{ hit: bool, version?: number, profile?: DtuProfile, updatedAt?: number }` |
| `POST` | `/api/node/dtu-info-cache` | Node 全量查完后写 | `{ mac, profile, version }` | `{ ok: 1, version }` |
| `POST` | `/api/node/dtu-info-cache/invalidate` | DTU 主动通知失效 | `{ mac, reason }` | `{ ok: 1, version }` |

**鉴权**：跟现有 `/api/node/*` 一样走 `x-node-token` header（PR #20）。

**`GET` 路径冲突注意**：现有 `/api/node/dtuinfo`（POST）是**上报**接口，新 `GET /api/node/dtu-info-cache` 是**拉取**接口——**方法不同路径不同**，不冲突。

#### 11.6.7 实现伪代码

```ts
// src/dtus/profile-cache.ts（新文件）
export interface ProfileCacheResult {
  hit: boolean
  version?: number
  profile?: DtuProfile
  updatedAt?: number
}

export async function fetchProfileCache(mac: string): Promise<ProfileCacheResult> {
  try {
    const res = await fetch(
      `${SERVER_URL}dtu-info-cache?mac=${encodeURIComponent(mac)}`,
      { method: 'GET', headers: authHeaders(), signal: AbortSignal.timeout(3000) }
    )
    if (res.status === 404) return { hit: false }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    console.warn(`[profile-cache] fetch failed for ${mac}, fall back to full query:`, err)
    return { hit: false }  // **降级：拉失败 → 当作没缓存**
  }
}

export async function writeProfileCache(mac: string, profile: DtuProfile, version: number): Promise<void> {
  // 走 Uploader 队列（带重试 + 背压）
  enqueue('dtu-info-cache', { mac, profile, version })
}

export function invalidateProfileCache(mac: string, reason: string): void {
  enqueue('dtu-info-cache/invalidate', { mac, reason })
}
```

```ts
// src/dtus/cellular.ts（register 路径集成）
class CellularDtu extends Dtu {
  async initialize() {
    // 1) 拉 cache
    const cache = await fetchProfileCache(this.mac)
    let queryPlan: ATCommand[]

    if (cache.hit && cache.profile) {
      // 命中：profile 字段直接用
      Object.assign(this.profile, cache.profile)
      this.profile.version = cache.version!
      // 重查动态字段 + 配置字段（~9 条，~1.5s）
      queryPlan = ['GSLQ', 'GSMST', 'UART=1', 'APN', 'HEART', 'NTIME',
                   'DATA=A', 'DATA=B', 'DATA=C']
    } else {
      // 未命中：全量查 5 条必查（~1s）
      queryPlan = ['PID', 'IMEI', 'ICCID', 'IMSI', 'GSLQ']
    }

    // 2) 执行查询
    const results = await this.queryAT(queryPlan)
    Object.assign(this.profile, results)

    // 3) 上报 server
    this.io.uploadDtuInfo(this.profile)
    if (!cache.hit) {
      // 第一次拿全量，**写回 server** 让别的 node 复用
      await writeProfileCache(this.mac, this.profile, this.profile.version ?? 1)
    }

    // 4) 启动第二层定时器（同 §11.3）
    this.scheduleBackgroundRefresh()
  }

  // 当 server 下发 DTUoprate 内容是 FCLR/RELD/UART=1 时
  // ATParse 解析完 → 检测响应特征字 → 触发 cache invalidate
  private onATResponse(query: DTUoprate, response: Buffer): void {
    // ... 现有 ATParse 逻辑 ...
    if (this.isProfileMutating(query.content, response)) {
      invalidateProfileCache(this.mac, query.content)
    }
  }
}
```

#### 11.6.8 测试矩阵（**新增**）

**单测**（mock server fetch）：

```ts
describe('ProfileCache.fetchProfileCache', () => {
  test('200 + hit=true 返回 profile + version', () => { ... })
  test('200 + hit=false 返回 { hit: false }', () => { ... })
  test('404 返回 { hit: false }', () => { ... })
  test('5xx 抛错 → 降级返回 { hit: false }', () => { ... })
  test('网络超时 3s → 降级', () => { ... })
})

describe('CellularDtu.initialize with cache', () => {
  test('命中 cache：重查动态+配置字段 (9 条)，不上报 full version', () => { ... })
  test('未命中：全量查必查 5 条 + 写回 cache', () => { ... })
  test('cache 拉失败（5xx）：降级到全量查，不影响 register 流程', () => { ... })
  test('profile.version 自增：第一次=1, 写回 server, 第二次读 v=1+1=2', () => { ... })
})

describe('ProfileCache.invalidateProfileCache', () => {
  test('DTUoprate = FCLR 触发 invalidate（识别 +ok=rebooting...）', () => { ... })
  test('DTUoprate = RELD 触发 invalidate（识别 +ok）', () => { ... })
  test('DTUoprate = UART=1,... 触发 invalidate（识别 +ok）', () => { ... })
  test('invalidate 后下次 register 必查 IMEI/PID/ICCID', () => { ... })
  test('invalidate 失败时只打 log（不影响 AT 响应回包）', () => { ... })
})
```

**集成**（staging 24h 回归）：

- Node 启动 → DTU 第一次 register → 写 cache（version=1）
- Node 重启 → DTU 重连 register → 命中 cache → 重查动态+配置字段（耗时从 ~2s 降到 ~1.5s）
- AT+FCLR 下行指令 → 触发 invalidate → 下次 register 必查必查 IMEI（**version 自增**）
- AT+UART=1 改串口参数 → invalidate → 下次 register 查到新串口参数
- server 端 mongo `dtuProfileCache` collection 实际数据验证

#### 11.6.9 跟 server 端协调的 checklist（**跨项目约束**）

> **AGENTS.md 写过的纪律**：跟 `midwayuartserver`（agent-ae682922673b）走 Socket.IO 协议，
> server 端事件名 / payload 格式变更会反向影响这里。**HTTP 接口同样要同步**。

落地 RFC 002 Phase 3 之前，cairui 需要跟 server 端 agent 同步：

- [ ] server 端实现 `GET /api/node/dtu-info-cache?mac=`
- [ ] server 端实现 `POST /api/node/dtu-info-cache`
- [ ] server 端实现 `POST /api/node/dtu-info-cache/invalidate`
- [ ] server 端 mongo 加 `dtuProfileCache` collection（带 TTL / 不带 TTL？建议**不带**，靠 DTU 主动 invalidate 触发）
- [ ] 三方约定 cache 响应 schema（`{ hit, version, profile, updatedAt }`）
- [ ] server 端是否需要新事件通知 Node "你的 cache 被 server 主动 invalid 了"？（可选，**先不做**）

---

## 12. 生命周期状态机（cairui 拍板 `sm-medium`：8 状态 + 健康度评分）

> 现状：`client` 类的状态机是隐式的，靠 `this.socketsb: socketsb | null`、`this.reboot: boolean`、
> `this.pause: boolean` 三个布尔字段拼出来。问题是：
> 1. **状态不可见**——server 端、运维、日志看不出 DTU 现在在哪个阶段
> 2. **状态不互斥**——reconnect + restart + close 可能同时触发
> 3. **没"放弃"机制**——查询超时 10 次触发硬重启，重启后又开始超时，**无限循环**
> 4. **重连无感知**——server 端不知道 DTU 正在尝试重连，**误判离线**
>
> 目标：8 个**显式状态** + **健康度评分**（0-100），所有转换打 log，让 server 端能实时画像。

### 12.1 8 个状态

```ts
// src/dtus/state.ts
export enum DtuState {
  /** 接受 socket 连接，等 10s 内注册包 */
  CONNECTING = 'CONNECTING',
  /** 注册包解析成功，等首次 AT 查询完成 */
  HANDSHAKING = 'HANDSHAKING',
  /** 第一层 AT 完成，terminalOn 上报，timer 启动 */
  INITIALIZING = 'INITIALIZING',
  /** 在线，缓存队列处理中（没有 query 堆积 / timeout）*/
  ONLINE = 'ONLINE',
  /** 在线但有 N 次连续失败（查询超时 / socket 抖动），还没掉线 */
  DEGRADED = 'DEGRADED',
  /** 重连中（被动断开后）*/
  RECONNECTING = 'RECONNECTING',
  /** 主动重启中（AT+Z 触发）*/
  RESTARTING = 'RESTARTING',
  /** 永久离线（放弃重连 / 重启失败 / server 主动踢）*/
  OFFLINE = 'OFFLINE'
}
```

### 12.2 状态转换表（**核心**）

| From | To | 触发 | 副作用 |
|---|---|---|---|
| (初始) | `CONNECTING` | TCP socket accepted | `stateTimer = setTimeout(10s)`，超时进 `OFFLINE` |
| `CONNECTING` | `HANDSHAKING` | 注册包解析成功，命中白名单 | `clearTimeout(stateTimer)`；建 `Dtu` 对象；`io.terminalOn(mac, false)` |
| `CONNECTING` | `OFFLINE` | 10s 无注册包 / 注册包解析失败 | `socket.end('please register')` |
| `HANDSHAKING` | `INITIALIZING` | 5 条初始化必查 AT 全部返回 | 上传 dtuInfo（含 profile 第一层）|
| `HANDSHAKING` | `OFFLINE` | 某条 AT 查询超时 > 30s | `socket.destroy()` |
| `INITIALIZING` | `ONLINE` | 第二层定时器启动成功 | 30s 跑批 1，60s 跑批 2 |
| `ONLINE` | `DEGRADED` | 连续 3 次查询失败 / signal < 5 | health score 下降 |
| `DEGRADED` | `ONLINE` | 连续 5 次查询成功 / signal > 10 | health score 回升 |
| `ONLINE` / `DEGRADED` | `RECONNECTING` | socket `close` 事件 + `error.name !== 'ECONNRESET'` | 启动退避重连：1s → 2s → 4s → 8s → 16s（max）|
| `RECONNECTING` | `ONLINE` | 重连成功（注册包再次收到）| `io.terminalOn(mac, true)`（**forceReport=true**）|
| `RECONNECTING` | `OFFLINE` | 重试 5 次失败 / 总等待 > 60s | 从 `MacSocketMaps` 删除；`io.terminalOff(mac, true)` |
| 任何状态 | `RESTARTING` | `resatrtSocket()` 调用 / server 下发 AT+Z | `queryAT('Z')` + 等 `+ok` + `socket.destroy()` |
| `RESTARTING` | `ONLINE` | 60s 内收到注册包 | `io.terminalOn(mac, true)` |
| `RESTARTING` | `OFFLINE` | 60s 内未重连 | 同 RECONNECTING 失败路径 |
| 任何状态 | `OFFLINE` | `socket.on('error')` 且非断连重试 | 立即从 MacSocketMaps 删除 |

### 12.3 健康度评分（**0-100**）

```ts
interface DtuHealth {
  score: number           // 0-100
  lastCommAt: number      // 最后一次成功通信时间戳
  consecutiveSuccesses: number   // 连续成功计数
  consecutiveFailures: number   // 连续失败计数
  queryTimeoutCount: number     // 累计查询超时
  totalRestarts: number         // 累计硬重启次数
  totalReconnects: number       // 累计重连次数
  signal: number                // 当前 GPRS 信号强度
}

function computeHealth(h: DtuHealth): number {
  // 起点 100
  let score = 100
  // 最近通信时间扣分（每分钟无通信 -5，max -30）
  score -= Math.min(30, Math.floor((Date.now() - h.lastCommAt) / 60_000) * 5)
  // 信号弱扣分（signal < 5 扣 20）
  if (h.signal < 5) score -= 20
  else if (h.signal < 10) score -= 10
  else if (h.signal < 15) score -= 5
  // 连续失败扣分（每 +1 连续失败 -10，max -40）
  score -= Math.min(40, h.consecutiveFailures * 10)
  // 重启次数扣分（每 +1 重启 -5，max -20）
  score -= Math.min(20, h.totalRestarts * 5)
  return Math.max(0, Math.min(100, score))
}
```

**关键阈值**：

| 阈值 | 含义 | 触发动作 |
|---|---|---|
| `score >= 80` | 健康 | 不变 |
| `60 <= score < 80` | 轻度降级 | 打 log（不打 alarm）|
| `40 <= score < 60` | 严重降级 | `DEGRADED` 状态 + 打 alarm |
| `score < 40` | 病危 | 触发 `RESTARTING` |
| `score = 0` | 死亡 | `OFFLINE` + 从 MacSocketMaps 删除 |

### 12.4 上报字段（**全增量**）

server 端 `terminalOn` / `terminalOff` / `dtuInfo` payload 全 optional 加新字段：

```ts
interface dtuInfoV4 {
  // 现有字段保持...
  state: DtuState            // 当前状态（8 选 1）
  health: {
    score: number            // 0-100
    lastCommAt: number       // ms timestamp
    consecutiveSuccesses: number
    consecutiveFailures: number
    queryTimeoutCount: number
    totalRestarts: number
    totalReconnects: number
  }
}
```

**新增 3 个 Socket.IO 事件**（跟 cairui / server 端 agent 对齐，**cairui 拍板 2026-06-15**）：

| 事件 | 触发 | Payload | 类型 |
|---|---|---|---|
| `dtuState` | 每次状态转换 | `{ mac, from: DtuState, to: DtuState, score: number, reason: string, timestamp: number }` | 状态机 |
| `dtuHealth` | 每 60s（ONLINE / DEGRADED 才发）| `{ mac, score, health: DtuHealth, timestamp: number }` | 周期上报 |
| `dtuAlert` | 4 类错误触发（**cairui 拍板 2026-06-15**）| `{ mac: string \| null, type: AlertType, message: string, context?: Record<string, unknown>, timestamp: number }` | 告警 |

**`AlertType` 枚举**（**cairui 拍板 4 个值**）：

```ts
type AlertType =
  | 'AT_TIMEOUT'         // §3.7.4: AT 连续 3 次超时
  | 'INVALID_REGISTER'   // §3.7.4: 非注册包连接（mac: null）
  | 'PROFILE_CACHE_FAIL' // §3.7.4: profile cache 拉/写连续 5 次失败
  | 'FATAL'              // §3.7.4: 进程级 fatal（main 兜底，mac: null）
```

**server 端去重**（**cairui 拍板**）：5 分钟内同 `mac + type + message` 不重推——避免 FATAL 重启循环刷屏。

**`dtuState` 乱序事件处理**（**cairui 拍板**）：server 端按 `mac` 做 **latest-wins 覆盖写**——同一 mac 后到的状态覆盖前到的，不维护事件流。

#### 12.4.1 dtuState 链路（**v1.5 校准 — dtubusy 审计层**）

> **来源**：server 端 agent v2 答 Q3 + MongoDB `log.dtubusy` 515,702 docs 采样。
> 详细：`.harness/docs/discovery/2026-06-15-server-contract-audit.md` §1.2 + §3 Q3

**两条独立链路**（**不冲突不重用**）：

| 链路 | 数据源 | 用途 | server 端行为 |
|---|---|---|---|
| **dtubusy**（审计层）| `log.dtubusy` collection | node 端发 `busy(mac, busy, n)` Socket.IO 事件 → server 落库 | **不**主动 emit socket 推前端；前端走 `getDtuBusy(mac, start, end)` **主动 query** |
| **dtuState**（v4 新增）| server 状态机 | 状态转换实时事件 | server 端 latest-wins 覆盖写 + Socket.IO emit `dtuState` |

**链路流程**（`node.socket.controller.ts:432-444`）：

```
node 端: busy(mac, busy, n) Socket.IO 事件
   ↓
server 端（两个并发）:
  ├── 控制层: redisService.addDtuWorkBus/delDtuWorkBus(mac)  ← 影响 query 调度
  └── 审计层: logDevBusyService.save({mac, stat, n, timeStamp})  ← batch.write.service.ts:346 addLogDtuBusy
                                                              （**批量写**）
```

**v4 设计原则**：
- ✅ Node 端 `dtuState` 事件**仅**走状态机维度（不读 `log.dtubusy`）
- ✅ Node 端上报 dtuInfo 时**不**带 dtubusy 字段（不耦合）
- ✅ server 端前端要拿 dtubusy 数据**主动 query**，不依赖 v4 dtuState 事件
- ❌ **不要**把 dtubusy 当 dtuState 数据源（语义错配：dtubusy 是「我忙」，dtuState 是「我活了/死了」）

#### 12.4.2 dtuAlert payload 内容来源（**v1.5 校准 — 触发位置明确**）

| 4 个 AlertType | 触发位置 | v4 RFC 章节 |
|---|---|---|
| `AT_TIMEOUT` | `client.run()` 连续 3 次 AT 查询超时 | §3.7.4 + §11.3 |
| `INVALID_REGISTER` | sniff register 包解析失败（mac: null） | §3.7.4 |
| `PROFILE_CACHE_FAIL` | `/api/node/dtu-info-cache` GET/POST 连续 5 次失败 | §11.6 + §3.7.4 |
| `FATAL` | 进程级 fatal（main.ts catch，mac: null） | §3.7.4 + main 兜底 |

**`mac: null` 语义**：server 端收到 `mac: null` 时**不**做 dtuState latest-wins 覆盖（DTU 还没识别），仅落审计日志。

#### 12.4.3 FATAL 走 dtuAlert（**v1.4 拍板保留**）

> cairui 2026-06-15 拍板：FATAL 走 dtuAlert（`type: 'FATAL'`），**不**抽 alarm 模块——避免引入额外鉴权 / 通知通道依赖
> server 端 agent 反馈：4 个 alert 值锁，message 字段 Node 端拼 `[<layer>] <context>: <what>: <why>`，server 端**不**解析 message（仅审计）
> 详细：`.harness/docs/server-api-alignment.md` §4.3

### 12.5 重连退避（**新机制**）

现状：socket 断了之后**立即**等下一个 socket，**没有退避**——对端恢复后会**瞬间打过来 N 条 SYN**。

v4 加**指数退避 + jitter**：

```ts
// src/dtus/cellular.ts
class CellularDtu extends Dtu {
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private maxReconnectWaitMs = 60_000

  private async attemptReconnect() {
    this.reconnectAttempts++
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.transition(DtuState.OFFLINE, 'reconnect_exhausted')
      return
    }
    const baseMs = Math.min(16_000, 1000 * 2 ** (this.reconnectAttempts - 1))
    const jitter = Math.random() * 500
    const wait = baseMs + jitter
    console.log(`[dtu ${this.mac}] reconnect attempt ${this.reconnectAttempts}/5 in ${wait.toFixed(0)}ms`)
    await new Promise(r => setTimeout(r, wait))
    // 触发 IoClient.net.dial(...)? — 实际上 socket 是被动接受的，
    // 所以这里只是等 DTU 主动重连。UartNode 不主动 reconnect socket。
    // **真正"重连"在 DTU 侧**，UartNode 侧只需要等。
  }
}
```

> **关键修正**：4G DTU 重连是 **DTU 主动**（DTU 触发 AT+Z 或断电重启后重新发起 TCP），
> UartNode **不能主动去 dial DTU**（不知道 DTU 是不是还在 NAT 后），
> 所以 v4 的"重连退避"是 **server 侧等待**，不是 socket 主动重拨。

### 12.6 测试矩阵（**单测**）

**状态机单测**（纯函数，mock socket）：

```ts
describe('DtuStateMachine', () => {
  test('CONNECTING → HANDSHAKING：注册包解析成功', () => { ... })
  test('CONNECTING → OFFLINE：10s 无注册包', () => { ... })
  test('HANDSHAKING → OFFLINE：AT 查询超时', () => { ... })
  test('ONLINE → DEGRADED：连续 3 次查询失败', () => { ... })
  test('DEGRADED → ONLINE：连续 5 次查询成功', () => { ... })
  test('ONLINE → RESTARTING：health < 40', () => { ... })
  test('RECONNECTING → OFFLINE：60s 内未重连', () => { ... })
  test('state transition 函数幂等性：同状态不重复触发', () => { ... })
})

describe('DtuHealth', () => {
  test('初始 score = 100', () => { ... })
  test('signal < 5 扣 20', () => { ... })
  test('连续失败 4 次扣 40', () => { ... })
  test('60 分钟无通信 score 归零', () => { ... })
})

describe('Dtu Reconnect Backoff', () => {
  test('第 1 次退避 1s + jitter', () => { ... })
  test('第 5 次退避 16s 上限', () => { ... })
  test('5 次后转 OFFLINE', () => { ... })
})
```

**集成**（staging 24h）：
- 状态转换 log 出现顺序符合转换表
- `dtuState` / `dtuHealth` 事件按预期触发
- DEGRADED → ONLINE 真实恢复
- RESTARTING 60s 后回到 ONLINE

### 12.7 跟现有代码的兼容

- `this.socketsb: socketsb | null` → 拆成 `state: DtuState` + `socket: Socket | null`
- `this.reboot: boolean` → `state === DtuState.RESTARTING`
- `this.pause: boolean` → `state === DtuState.HANDSHAKING`（不允许查询入队）

**关键不变量**（**AGENTS.md 不能破坏的纪律**）：
- IOClient 行为 1:1（事件名 / payload 字段名不变）
- 现有 8 条 AT 行为不变
- 24h staging 回归强制

---

## 13. 整体调整后的 Phase 划分（**v2**）

| Phase | 内容 | 估时 | 关键产出 |
|---|---|---|---|
| 1 | 基础设施层 | 1-2 天 | events.ts / IOClient / Uploader / dtu-info / 8 个 test |
| 2 | TcpServer + Dtu 抽象 + 状态机（§12）| 3-4 天 | TcpServer class / Dtu base / DtuState enum / health score / 6 个 test |
| 3 | AT 采集分层（§11）+ 类型收紧 | 2 天 | CellularDtu 两层采集 / profile schema / 4 个 test |
| 4（可选）| LAN 支持 | 4-5 天 | RFC 001 落地 |

**总估时**（Phase 1-3）：**6-8 天**，覆盖"生产级代码质量 + 丰满设备画像 + 细致生命周期"三个目标。

---

## 14. 完整 CHANGELOG（v1.0 → v1.3）

> 增量更新追踪——给后续 reviewer / 自己一个「v4 演进路径」。

| 版本 | 日期 | 增量 | 拍板项 | commit |
|---|---|---|---|---|
| **v1.0** | 2026-06-15 | 草案：5 层分包 + class 化 + 队列化 + 跟 pesiv 对齐 | refactor-goal=`production-grade` / scope=`move-src-only`+`add-tests`+`add-deps` | (本 RFC 起点) |
| **v1.1** | 2026-06-15 | §11 AT 采集（15 条 / 两层）+ §12 状态机（8 状态 + health score）| at-medium / sm-medium | `53d2ebb` |
| **v1.2** | 2026-06-15 | §11.6 Profile Cache 复用机制（cache-version + api-pull）| cache-version / api-pull | `a280fac` |
| **v1.3** | 2026-06-15 | §3.7 错误处理模型（throw + 三级边界）+ §3.8 测试 mock 架构（真实 socket + fetch mock）+ §6.5/6.6 11 个 PR 顺序 + 合并 checklist | error-handling=throw+3-tiers / mock-arch=real-socket+fetch-mock / PR-plan=11-PRs | (本次) |
| **v1.4** | 2026-06-15 | **cairui 全拍板**——微调 §3.7.4（FATAL 走 dtuAlert 不抽 alarm）+ §12.4（dtuAlert 4 个值 + AlertType 枚举）+ §11.6（mac 主键 = 15 位 IMEI + LAN `mac:` 前缀）| deployment-path=C / mac-primary=15 / alert-types=4 / decision-date=2026-06-15 | (本次) |
| **v1.5** | 2026-06-15 | **MongoDB schema 真实校准**——进 `mongodb://uart-server.taile0f311.ts.net:27017/UartServer` 采样 1.45M 条 + server agent 5 答 v1+v2 锁 12 条约束。§11.2 DtuProfile `mac` 字段修注释（12→15 位 + 部署期兼容说明）/ §11.3 加 server query 调度 floor 标注（minQueryLimit 是 floor 不是硬节流）/ **§11.4 queryData payload 设计** 新增章节（content 是协议指令名 / contents[].buffer.data 是设备响应字节 / Mixed 兜底标注 / 12 条约束锁）/ §12.4 加 dtuState 链路明确（dtubusy 是审计层不是 socket 推源 / 两条独立链路）/ §12.4.1 + §12.4.2 + §12.4.3 子节补完 | mongodb-reality-check / queryData-payload-aligned / dtubusy-audit-only / FATAL-dtuAlert-retained | (本次) |

**v1.3 增量**：
- **错误处理**：业务层 throw（`DTUError` / `NetworkError` / `ProtocolError` 三类），边界层 catch + console 分级，顶层 main 兜底。**不引** neverthrow / fp-ts，跟 pesiv 一致
- **测试 mock**：真实 socket.io-client / 真实 net.Socket（0 端口）+ `installFetchMock` 覆盖 `globalThis.fetch`。**不引** sinon / nock / msw
- **11 个 PR 顺序**：第一批基础设施（3-4 天）→ 第二批核心重构（4-6 天，staging 24h）→ 第三批增强（3-5 天，跨项目协调）→ 第四批清理（1-2 天）

---

## 15. 状态同步（**RFC 002 落地后**）

PR #11 完成后，本 RFC 状态从 `draft` → `implemented`。同步：

- [ ] 顶部状态表 `状态` 字段改为 `implemented`
- [ ] 顶部状态表 `日期` 字段保留为 v1.0 日期
- [ ] §14 CHANGELOG 加 v1.5 行（`status: implemented` + PR #11 commit hash）
- [ ] `.harness/docs/INDEX.md` 把"待 review"标改成"已落地"
- [ ] 根 `AGENTS.md` 移除已修掉的"NODE_ENV 残留 / Cache.ts 死代码"两条
- [ ] 根 `README.md` 架构表改成 5 层分包版

## 16. v1.5 落地 action items（**cairui D 拍板后**）

| # | 事项 | 状态 | 备注 |
|---|---|---|---|
| 1 | §11.2 DtuProfile `mac` 字段注释修（12→15 位 + 部署期兼容）| ✅ done | 本次 commit |
| 2 | §11.3 minQueryLimit floor 标注 | ✅ done | 本次 commit |
| 3 | §11.4 queryData payload 设计新增章节（6 子节）| ✅ done | 本次 commit |
| 4 | §12.4 dtuState 链路明确（dtubusy 审计层 + 两条独立链路）| ✅ done | 本次 commit |
| 5 | §12.4.1 / §12.4.2 / §12.4.3 子节补完 | ✅ done | 本次 commit |
| 6 | §14 CHANGELOG 加 v1.5 行 | ✅ done | 本次 commit |
| 7 | §15 §16 状态同步 + 落地清单 | ✅ done | 本次 commit |
| 8 | server agent 同步 v1.5 增删 | ⏸️ 待发 | v1.5 是 UartNode RFC 文档，**server 不直接读**，server agent 只需知道对齐点（`content` 字段 / `minQueryLimit` 字段位置）|
| 9 | server repo audit 镜像（C 拍板后）| ⏸️ 等 cairui 答 server agent | 不阻塞 v1.5 commit |
