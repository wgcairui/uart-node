# UartNode v4 ↔ uart-server 接口对齐文档

| 字段 | 值 |
|---|---|
| **目标读者** | uart-server 端 agent（agent-ae682922673b）|
| **来源** | UartNode RFC 002 v1.3 |
| **日期** | 2026-06-15 |
| **状态** | **draft**——server 端拍板前不落地 |

## 0. 摘要

UartNode v4 重构会**新增** 3 个 HTTP 接口 + **扩展** 4 个现有接口的 payload + **新增** 3 个 Socket.IO 事件。
这份文档是给 server 端 agent 看的**接口契约**——所有字段、错误码、行为约定都在这里。

**当前状态**（2026-06-15）：
- ❌ `/api/node/dtuinfo` / `queryData` / `nodeInfo` — server 端新架构（`uartserver-ng` Fastify 重构）**还没迁过去**——见 §6
- ✅ Socket.IO 事件名 — 已稳定，沿用老 midway 契约
- ✅ PR #20 鉴权三通道 — 已落地（`auth.token` / `query.token` / `x-node-token` header）

## 1. 现有契约（**不破坏**）

### 1.1 Socket.IO 事件（**保持稳定**）

| 方向 | 事件 | Payload | 备注 |
|---|---|---|---|
| Server → Node | `accont` | （空）| 首次连接鉴权通过 |
| Server → Node | `registerSuccess` | `RegisterConfig` | 含 Port / MaxConnections / UserID |
| Server → Node | `query` | `QueryObject` | 周期查询指令 |
| Server → Node | `instructQuery` | `InstructQuery` | 操作指令 |
| Server → Node | `DTUoprate` | `DTUoprate` | AT 指令 |
| Server → Node | `nodeInfo` | `name: string` | server 主动要 node 状态 |
| Node → Server | `register` | `NodeInfo` | node 上线 |
| Node → Server | `ready` | — | TCP/UDP 起来了 |
| Node → Server | `terminalOn` | `(mac: string, reline: boolean)` | 设备上线 |
| Node → Server | `terminalOff` | `(mac: string, force: boolean)` | 设备离线 |
| Node → Server | `busy` | `(mac: string, busy: boolean, count: number)` | 设备忙 |
| Node → Server | `deviceopratesuccess` | `(events: string, result: ApolloMongoResult)` | 操作指令完成 |
| Node → Server | `dtuopratesuccess` | `(events: string, result: ApolloMongoResult)` | AT 指令完成 |
| Node → Server | `terminalMountDevTimeOut` | `(mac: string, pid: number, num: number)` | 查询超时告警 |
| Node → Server | `instructTimeOut` | `(mac: string, pid: number, contents: string[])` | 指令超时 |
| Node → Server | `result` | `(eventName: string, data: unknown)` | 响应 server 的 ioOnResult 触发 |

**新事件**（UartNode v4 §12.4 拍板，需 server 端支持）：

| 方向 | 事件 | Payload | 触发条件 |
|---|---|---|---|
| Node → Server | `dtuState` | `{ mac, from: DtuState, to: DtuState, score: number, reason: string }` | 每次状态转换 |
| Node → Server | `dtuHealth` | `{ mac, score, health: DtuHealth }` | 每 60s |
| Node → Server | `dtuAlert` | `{ mac, type: 'AT_TIMEOUT' \| 'INVALID_REGISTER' \| 'PROFILE_CACHE_FAIL', message: string }` | 严重降级 / 病危 |

### 1.2 现有 HTTP 接口（**保持稳定**）

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| `POST` | `/api/node/dtuinfo` | 上报设备参数 | `x-node-token` |
| `POST` | `/api/node/queryData` | 上报查询结果 | `x-node-token` |
| `POST` | `/api/node/RunData` | （**未启用**）| `x-node-token` |
| `POST` | `/api/node/nodeInfo` | 上报 node 状态 | `x-node-token` |
| `POST` | `/api/node/UartData` | （**已废弃** — Cache.ts 死代码，UartNode v4 删）| — |

**Payload 演进**（v4 **不破坏**，全 optional 加字段）：

```ts
// dtuinfo payload（v4 增量）
interface dtuinfoV4 {
  info: {
    // —— 现有 8 字段保持不变 ——
    mac: string; AT: boolean; PID: string; ver: string; Gver: string;
    iotStat: string; jw: string; uart: string; ICCID: string; signal: string;
    // —— v4 新增 6 字段（全 optional）——
    imei?: string
    imsi?: string
    apn?: { name: string; user: string; password: string }
    network?: { status: 'Disconnect' | 'Connect' | 'SIMNotExist'; strength: number }
    clock?: { second: number; runTime: number; time: string }
    traffic?: { sockA?: { tx: number; rx: number }; sockB?: { tx: number; rx: number }; sockC?: { tx: number; rx: number } }
    heartbeat?: { time: number; mode: string; type: string; value: string }
    // —— v4 新增生命周期字段 ——
    state?: DtuState
    health?: { score: number; lastCommAt: number; consecutiveSuccesses: number; consecutiveFailures: number; queryTimeoutCount: number; totalRestarts: number; totalReconnects: number }
    version?: number           // profile cache 版本号（§2.4）
  }
}
```

### 1.3 鉴权（**保持稳定**）

**PR #20 三通道**：

| 通道 | 何时生效 |
|---|---|
| `auth.token` | websocket 握手（推荐）|
| `query.token` | `?token=` URL 参数（备选）|
| `x-node-token` header | HTTP + polling 握手 |

**优先级**：server 端 `auth → query → header` 顺序取。

**没设 `NODE_TOKEN`**：UartNode 只 warn 不中断（PR #20 部署前过渡期），**server 端可拒绝**（PR #20 部署后）。

## 2. 新增 HTTP 接口（**server 端需实现**）

> 触发背景：UartNode 进程重启时，DTU 重连 register 路径上**应该复用**之前查过的 profile，
> 避免每次重启都重查 15 条 AT。设计见 RFC 002 §11.6。

### 2.1 `GET /api/node/dtu-info-cache`

**用途**：UartNode 启动 / DTU 重连时**拉取** profile cache。

**请求**：

```http
GET /api/node/dtu-info-cache?mac=98D863CC870D
Headers:
  x-node-token: <plainToken>
```

**响应**（**200 + 命中**）：

```json
{
  "hit": true,
  "version": 7,
  "profile": {
    "mac": "98D863CC870D",
    "imei": "862285030465284",
    "imsi": "460011352509105",
    "iccid": "89860115831007091458",
    "pid": "HF2411",
    "ver": "1.0.03",
    "gver": "1.575",
    "host": "Eport-HF2411",
    "signal": 18,
    "network": { "status": "Connect", "strength": 18 },
    "apn": { "name": "CMNET", "user": "", "password": "" },
    "jw": "121.623046,31.221429",
    "uart": "1,115200,8,1,NONE,NFC",
    "iotStat": "on",
    "heartbeat": { "time": 30, "mode": "NET", "type": "MAC", "value": "98D863CC870D" },
    "clock": { "second": 1750000000, "runTime": 12345, "time": "2025-06-15 18:00:00" },
    "traffic": { "sockA": { "tx": 1024, "rx": 2048 } }
  },
  "updatedAt": 1750000000000
}
```

**响应**（**200 + 未命中**）：

```json
{
  "hit": false
}
```

**错误响应**：

| 状态码 | 含义 |
|---|---|
| `401` | NODE_TOKEN 缺失 / 错误 |
| `500` | server 端 mongo 异常 |

**Zod schema**（server 端用 Zod 验证，**必填**）：

```ts
import { z } from 'zod'

export const DtuProfileSchema = z.object({
  mac: z.string().min(1),
  imei: z.string().length(15).optional(),
  imsi: z.string().length(15).optional(),
  iccid: z.string().length(20).optional(),
  pid: z.string().optional(),
  ver: z.string().optional(),
  gver: z.string().optional(),
  host: z.string().max(30).optional(),
  signal: z.number().min(0).max(31).optional(),
  network: z.object({
    status: z.enum(['Disconnect', 'Connect', 'SIMNotExist']),
    strength: z.number().min(0).max(31)
  }).optional(),
  apn: z.object({
    name: z.string().max(27),
    user: z.string().max(21),
    password: z.string().max(21)
  }).optional(),
  jw: z.string().optional(),
  uart: z.string().optional(),
  iotStat: z.string().optional(),
  heartbeat: z.object({
    time: z.number().int().min(0).max(65535),
    mode: z.string(),
    type: z.string(),
    value: z.string().max(38)
  }).optional(),
  clock: z.object({
    second: z.number().int(),
    runTime: z.number().int(),
    time: z.string()
  }).optional(),
  traffic: z.object({
    sockA: z.object({ tx: z.number().int().nonnegative(), rx: z.number().int().nonnegative() }).optional(),
    sockB: z.object({ tx: z.number().int().nonnegative(), rx: z.number().int().nonnegative() }).optional(),
    sockC: z.object({ tx: z.number().int().nonnegative(), rx: z.number().int().nonnegative() }).optional()
  }).optional()
})

export const GetCacheResponse = z.union([
  z.object({ hit: z.literal(true), version: z.number().int().positive(), profile: DtuProfileSchema, updatedAt: z.number().int() }),
  z.object({ hit: z.literal(false) })
])
```

### 2.2 `POST /api/node/dtu-info-cache`

**用途**：UartNode 全量查完后**写回** server。

**请求**：

```http
POST /api/node/dtu-info-cache
Headers:
  x-node-token: <plainToken>
  content-type: application/json
Body:
{
  "mac": "98D863CC870D",
  "profile": { /* 完整 DtuProfile (14 字段)，同上 schema */ },
  "version": 1
}
```

**响应**（**200**）：

```json
{ "ok": 1, "version": 2 }
```

**行为约定**：
- `version` 单调递增：server 端如果收到 `version` 比当前小，**拒绝**（返回 409 Conflict）
- 如果 mac 已存在：覆盖 + `version = 当前 version + 1`
- 如果 mac 不存在：插入 + `version = 1`
- `updatedAt` 字段 server 端写（不用 Node 传）

**错误响应**：

| 状态码 | 含义 |
|---|---|
| `400` | Zod 验证失败（缺字段 / 类型错）|
| `401` | NODE_TOKEN 缺失 / 错误 |
| `409` | version 冲突（旧版本覆盖尝试）|
| `500` | server 端 mongo 异常 |

### 2.3 `POST /api/node/dtu-info-cache/invalidate`

**用途**：UartNode 检测到 DTU 主动触发 profile 变更（AT+FCLR / AT+RELD / AT+UART=1）时**主动通知** server 失效 cache。

**请求**：

```http
POST /api/node/dtu-info-cache/invalidate
Headers:
  x-node-token: <plainToken>
  content-type: application/json
Body:
{
  "mac": "98D863CC870D",
  "reason": "AT+FCLR"   // 或 "AT+RELD" / "AT+UART=1"
}
```

**响应**（**200**）：

```json
{ "ok": 1, "version": 8 }
```

**行为约定**：
- server 端**不删** cache，**只让 cache "失效"**——下次 GET 返回 `hit: false`
- 或者 server 端可以保留旧 cache 但**`version` 自增**——两种实现都行
- **`reason` 字段**：审计用，建议存到 cache entry 的 `invalidateHook` 字段（RFC 002 §11.6.2）

**错误响应**：

| 状态码 | 含义 |
|---|---|
| `401` | NODE_TOKEN 缺失 / 错误 |
| `404` | mac 不存在（**不报错**——已经失效的也允许调）|
| `500` | server 端 mongo 异常 |

## 3. server 端 MongoDB Collection Schema

> 跟现有 `terminals` / `nodeMap` 等 collection 一起规划。

### 3.1 `dtuProfileCache` collection（**新增**）

```ts
// server 端 mongoose schema
import { Schema } from 'mongoose'

const DtuProfileCacheSchema = new Schema({
  mac: { type: String, required: true, unique: true, index: true },
  nodeName: { type: String, required: true },
  profile: { type: Schema.Types.Mixed, required: true },  // 完整 DtuProfile
  version: { type: Number, required: true, default: 1, min: 1 },
  updatedAt: { type: Number, required: true },
  updatedBy: { 
    type: String, 
    enum: ['initial_query', 'background_refresh', 'cache_reuse', 'dtu_invalidate'],
    required: true 
  },
  invalidateHook: {
    expectedEvent: { type: String, enum: ['AT+FCLR', 'AT+RELD', 'AT+UART=1', 'user_manual'] },
    ackAt: { type: Number }
  }
}, { collection: 'dtuProfileCache', versionKey: false })
```

**索引**：
- `mac` — unique（主键）
- `nodeName` — 便于按 node 查
- `updatedAt` — 便于 audit / debug（**不用于过期判断**——cache 不带 TTL）

**TTL 决策**：
- ✅ **不带 TTL**——cache 永真，直到 DTU 主动 invalidate
- 理由：IMEI/IMSI/ICCID 出厂定，写一次就是永真；时间过期会让 Node 没事找事重查

### 3.2 跟现有 collection 的关系

| Collection | 用途 | 跟 dtuProfileCache 的关系 |
|---|---|---|
| `terminals` | 设备元信息（绑定用户、在线状态）| **独立**——terminals 是"业务实体"，dtuProfileCache 是"profile 缓存" |
| `nodeMap`（socket.io.service.ts）| node↔socket 映射 | **独立**——Node 进程状态，dtuProfileCache 是设备 profile |
| `queryData`（待迁移）| 查询结果时序数据 | **独立**——查询结果 vs profile |
| `dtuProfileCache`（**新增**）| 设备 profile 缓存（versioned）| — |

**设计原则**：**`dtuProfileCache` 跟 `terminals` 冗余但解耦**——
- `terminals` 存"用户视角的设备"（含绑定关系、权限）
- `dtuProfileCache` 存"Node 视角的设备 profile"（纯设备数据）
- **更新时机不同**：`terminals` 由用户/管理端更新；`dtuProfileCache` 由 Node 上报

## 4. 新增 Socket.IO 事件（**server 端需支持**）

> 已在 RFC 002 §12.4 拍板。事件名 `dtuState` / `dtuHealth` / `dtuAlert`。

### 4.1 `dtuState` — 状态转换事件

**Payload**：

```ts
interface DtuStateEvent {
  mac: string                      // 设备 MAC
  from: DtuState                   // 转换前状态
  to: DtuState                     // 转换后状态
  score: number                    // 当前健康度评分
  reason: string                   // 转换原因（如 'AT_TIMEOUT' / 'reconnect_attempt_3' / 'health_below_40'）
  timestamp: number                // ms timestamp
}

enum DtuState {
  CONNECTING = 'CONNECTING',
  HANDSHAKING = 'HANDSHAKING',
  INITIALIZING = 'INITIALIZING',
  ONLINE = 'ONLINE',
  DEGRADED = 'DEGRADED',
  RECONNECTING = 'RECONNECTING',
  RESTARTING = 'RESTARTING',
  OFFLINE = 'OFFLINE'
}
```

**触发频率**：每个状态转换 1 次（**不重复**——同状态不重复 emit）

**server 端作用**：
- 更新 `terminals.online` 字段（`OFFLINE` → false，其它 → true）
- 写 audit log
- 推送到前端（WebSocket push 给运维 dashboard）

### 4.2 `dtuHealth` — 健康度上报（周期）

**Payload**：

```ts
interface DtuHealthEvent {
  mac: string
  score: number                    // 0-100
  health: {
    lastCommAt: number             // 最后一次成功通信时间戳
    consecutiveSuccesses: number
    consecutiveFailures: number
    queryTimeoutCount: number
    totalRestarts: number
    totalReconnects: number
    signal: number                 // 当前 GPRS 信号强度 0-31
  }
  timestamp: number
}
```

**触发频率**：每 60s 1 次（**仅 ONLINE / DEGRADED 状态发**，其它状态不发）

**server 端作用**：
- 存到 `terminals.healthScore` 字段（新增）
- Grafana / Prometheus 抓取（如果有 metric endpoint）

### 4.3 `dtuAlert` — 告警事件

**Payload**：

```ts
interface DtuAlertEvent {
  mac: string | null               // INVALID_REGISTER 时 mac 未知 → null
  type: 'AT_TIMEOUT' | 'INVALID_REGISTER' | 'PROFILE_CACHE_FAIL' | 'FATAL'
  message: string                  // 错误信息
  timestamp: number
  context?: Record<string, unknown>  // 额外上下文（remoteAddr / firstPacket 等）
}
```

**触发条件**：
- `AT_TIMEOUT` 连续 3 次（避免单次告警刷屏）
- `INVALID_REGISTER` 任何时候（非法连接尝试）
- `PROFILE_CACHE_FAIL` 连续 5 次
- `FATAL` 任何时候（main 兜底 fatal）

**server 端作用**：
- 推送到告警系统（邮件 / 钉钉 / 飞书）
- audit log

## 5. 跨项目协调 checklist

UartNode RFC 002 Phase 1-3 落地**之前**，cairui 跟 server 端 agent 同步：

- [ ] server 端确认 §1.1 现有 Socket.IO 事件不破坏
- [ ] server 端确认 §1.2 现有 HTTP 接口 dtuinfoV4 payload 全 optional 加字段
- [ ] server 端实现 §2.1 `GET /api/node/dtu-info-cache?mac=`
- [ ] server 端实现 §2.2 `POST /api/node/dtu-info-cache`
- [ ] server 端实现 §2.3 `POST /api/node/dtu-info-cache/invalidate`
- [ ] server 端 mongo 新增 §3.1 `dtuProfileCache` collection
- [ ] server 端确认 §4.1 `dtuState` 事件名 + payload
- [ ] server 端确认 §4.2 `dtuHealth` 事件名 + payload
- [ ] server 端确认 §4.3 `dtuAlert` 事件名 + payload
- [ ] server 端确认 zod schema（§2.1 末）
- [ ] server 端确认 cache 不带 TTL（§3.1 TTL 决策）
- [ ] server 端确认 `terminals` collection 是否需要新字段 `healthScore`（§4.2）

## 6. 现状 gap（**UartNode 已知**）

> 这部分给 server 端 agent 看的**当前现状**——UartNode 期望的接口有些 server 端还没实现。

| 期望接口 | server 端现状 | 影响 |
|---|---|---|
| `POST /api/node/dtuinfo` | ⚠️ **新架构（uartserver-ng Fastify）还没迁**——老 midway 项目有 | UartNode v3.3.0 跑老 midway server 时正常；切到 uartserver-ng 后**会 404**——需要 server 端 agent 同步迁移 |
| `POST /api/node/queryData` | 同上 | 同上 |
| `POST /api/node/nodeInfo` | 同上 | 同上 |
| `POST /api/node/UartData` | 同上 | UartNode v3.3.0 已废弃（Cache.ts 死代码）；v4 删 |
| `GET /api/node/dtu-info-cache` | ❌ **没实现**（UartNode v4 新增）| RFC 002 Phase 3 落地前需要 server 端实现 |
| `POST /api/node/dtu-info-cache` | ❌ **没实现** | 同上 |
| `POST /api/node/dtu-info-cache/invalidate` | ❌ **没实现** | 同上 |
| `dtuState` / `dtuHealth` / `dtuAlert` 事件 | ❌ **没实现** | RFC 002 Phase 2 落地前需要 server 端支持 |

**建议 server 端 agent 优先级**：
1. **最高**：迁移老 `/api/node/*` 到 Fastify（**UartNode v3.3.0 当前就在调这些**——切 server 端架构会断）
2. **高**：实现新增 3 个 dtu-info-cache 接口 + dtuProfileCache collection
3. **中**：实现 3 个新 Socket.IO 事件
4. **低**：优化 cache 策略（TTL / 压缩 / 持久化）

## 7. 决策记录

- **2026-06-15** — 草案创建。给 server 端 agent-ae682922673b 看的接口契约。
- 后续 server 端拍板后更新：✅ accepted / ❌ rejected / 🔄 modified
