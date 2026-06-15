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

## 4. 类型与 lint 收紧

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
  mac: string             // IMEI 后 12 位（现有 key）
  imei: string            // 15 位完整 IMEI（新增）
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
AT+IMEI      ← 完整 IMEI（**取代后 12 位当主键**？还是保留 IMEI 后 12 位 + 完整 IMEI 都上报？）
AT+ICCID     ← SIM 卡
AT+IMSI      ← SIM 卡
AT+GSLQ      ← 信号强度（基础健康检查）
```

**5 条**，耗时 ~1-2s。**register 路径上必须完成**才能上报 `terminalOn(mac, forceReport=true)`。

> **关键决策点**：完整 IMEI 15 位要不要取代 IMEI 后 12 位当主键？
> - **保留 12 位当主键**：最小改动，向后兼容
> - **改 15 位当主键**：消除 LAN MAC `98D863xxxxxx` 跟某 4G IMEI 后 12 位的潜在碰撞（RFC 001 §6 提到的）
> - **两个都保留**：后 12 位向后兼容 + 完整 15 位上报字段

#### 第二层：后台动态刷新（**非 register 路径**）

**配置类 / 状态类 / 流量类**——这些不阻塞 register，但 server 端要定时刷新：

```
AT+VER       AT+GVER       AT+IOTEN      AT+UART=1
AT+APN       AT+GSMST      AT+LOCATE=1   AT+HEART
AT+NTIME     AT+DATA=A     AT+DATA=B     AT+DATA=C
```

**~10 条**，分**两批**在 register 后异步跑：

| 批 | AT 指令 | 频率 | 触发条件 |
|---|---|---|---|
| **批 1**（**30s 后跑**）| VER / GVER / IOTEN / UART / APN / GSMST / LOCATE / HEART | register 后 30s 一次（**只跑一次**——配置类不变）| register 完成后 30s |
| **批 2**（**周期性 60s**）| NTIME / DATA / DATA=A,B,C | 每 60s 跑一次 | 持续运行 |

**实现机制**：

```ts
// src/dtus/cellular.ts（伪代码）
class CellularDtu extends Dtu {
  async initialize() {
    // 1) 第一层：初始化必查（register 路径，~1-2s）
    await this.refreshIdentity()           // PID/IMEI/ICCID/IMSI/GSLQ
    this.io.terminalOn(this.mac, false)   // 上报 terminalOn
    this.io.uploadDtuInfo(this.profile)

    // 2) 第二层：后台动态刷新（不阻塞）
    this.scheduleBackgroundRefresh()
  }

  private async refreshIdentity() {
    const results = await this.queryAT(['PID', 'IMEI', 'ICCID', 'IMSI', 'GSLQ'])
    Object.assign(this.profile, results)
  }

  private scheduleBackgroundRefresh() {
    // 批 1: 30s 后跑配置类（只跑一次）
    setTimeout(async () => {
      const r = await this.queryAT(['VER', 'GVER', 'IOTEN', 'UART=1', 'APN',
                                    'GSMST', 'LOCATE=1', 'HEART'])
      Object.assign(this.profile, r)
      this.io.uploadDtuInfo(this.profile)
    }, 30_000).unref()

    // 批 2: 每 60s 跑运行时类（持续）
    const refreshRuntime = async () => {
      const r = await this.queryAT(['NTIME', 'DATA=A', 'DATA=B', 'DATA=C'])
      Object.assign(this.profile, r)
      this.io.uploadDtuInfo(this.profile)
    }
    setInterval(refreshRuntime, 60_000).unref()
  }
}
```

### 11.4 上报 schema 演进（**不破坏 server 端**）

server 端 `/api/node/dtuinfo` 当前 payload 是：

```ts
interface dtuinfoRequest {
  info: Partial<Terminal & { mac: string; AT; PID; ver; Gver; iotStat; jw; uart; ICCID; signal }>
}
```

**演进策略**：新字段**全部 optional**，server 端向前兼容：

```ts
// v4 payload（增量，不删除）
interface dtuinfoRequestV4 {
  info: Partial<Terminal & {
    // —— 现有 8 字段保持不变 ——
    mac: string; AT: boolean; PID: string; ver: string; Gver: string;
    iotStat: string; jw: string; uart: string; ICCID: string; signal: string;
    // —— 新增 6 字段（全 optional）——
    imei: string; imsi: string; apn: { name: string; user: string; password: string };
    network: { status: string; strength: number };
    clock: { second: number; runTime: number; time: string };
    traffic: { sockA?: { tx: number; rx: number }; sockB?: { tx: number; rx: number }; sockC?: { tx: number; rx: number } };
    heartbeat: { time: number; mode: string; type: string; value: string };
  }>
}
```

### 11.5 测试矩阵（**单测 + 集成**）

**单测**（不依赖真实 DTU）：
- `queryAT` 解析每条 AT 的响应格式
- `refreshIdentity` 调度逻辑（mock queryAT）
- `scheduleBackgroundRefresh` timer / unref 行为

**集成**（依赖真实 DTU，staging 24h 回归）：
- 初始化必查 5 条在 ~1-2s 内完成
- 30s 后批 1 配置类刷新成功
- 60s 后批 2 运行时类刷新成功
- `traffic` 字段的发送/接收字节数随时间增长
- 重连后第二层 timer 重启（**不能泄漏**）

### 11.6 Profile Cache 复用机制（**新增**——cairui 拍板 `cache-version` + `api-pull`）

> 现状问题（**cairui 反馈**）：
> > 有些参数如果已经拿到过一次就不需要再拿了，所以需要先向 server 获取一个设备数据详情来看
>
> 场景：
> - DTU 5 分钟前刚 register 过，profile 完整（IMEI/IMSI/APN/...）
> - **UartNode 进程重启**（bugfix / OOM / k8s 滚动升级）
> - DTU 重新 TCP 连上来 → 走 register 路径 → 又查 15 条 AT
> - **5 分钟前查过的字段没必要重查**——server 端有 cache，Node 拉下来复用即可
>
> 这跟 `uart-pesiv-node` 设计哲学反着——pesiv 是**单设备**，没有这种"重连"问题。UartNode 是**多设备长跑**，这个能力**必须**。

#### 11.6.1 设计原则（**两项拍板**）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 缓存有效期 | **按设备版本号**（`cache-version`）| 不靠时间，靠 DTU 主动通知"profile 变了"——IMEI/IMSI/ICCID/PID/VER 这些**永不变**，cache 一旦写就是权威，**直到 DTU 自己触发失效** |
| Node 拿 cache 方式 | **主动 GET 拉取**（`api-pull`）| Node 启动 / DTU 重连时 GET，简单可控；**不走 Socket.IO push**（不跟 server 端 registerSuccess 流程耦合）|
| Cache 存储位置 | **server 端**（`uart-server` mongo）| 单点权威，Node 进程重启不丢；多 node 共享 |
| Cache 失效触发 | **DTU 主动上报** profile 变更事件 | AT+FCLR / AT+RELD / AT+UART=1 写操作 → Node 立刻 POST 通知 server invalidate |

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
  mac: string                  // IMEI 后 12 位（保留主键）/ 或 15 位（决策见 §11.4）
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

**新增 3 个 Socket.IO 事件**（跟 cairui / server 端 agent 对齐）：

| 事件 | 触发 | Payload |
|---|---|---|
| `dtuState` | 每次状态转换 | `{ mac, from, to, score, reason }` |
| `dtuHealth` | 每 60s | `{ mac, score, health }` |
| `dtuAlert` | 严重降级 / 病危 | `{ mac, score, reason }` |

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
