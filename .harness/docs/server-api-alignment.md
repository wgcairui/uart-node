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

> **状态更新**（2026-06-15 19:43）：cairui 已拍**部署路径 = C**（两套都放，先老 midway 让 v3.3.0 不掉线，uartserver-ng 同步）。
> **待 cairui 补 3 项**：mac 主键 12/15 位 / dtuAlert type 3/4 个 / 拍板日期（详见 §7）。

UartNode RFC 002 Phase 1-3 落地**之前**，cairui 跟 server 端 agent 同步：

- [x] **§1.1 现有 Socket.IO 事件不破坏** — server 端 ✅ accept（2026-06-15）
- [x] **§1.2 现有 HTTP 接口 dtuinfoV4 payload 全 optional 加字段** — server 端 ✅ accept（2026-06-15）
- [x] **§2.1 `GET /api/node/dtu-info-cache?mac=`** — server 端 🔄 modified（具体方案待 server 端提供，**C 路径下 3.0-4.5 人天**）
- [x] **§2.2 `POST /api/node/dtu-info-cache`** — server 端 🔄 modified（同上）
- [x] **§2.3 `POST /api/node/dtu-info-cache/invalidate`** — server 端 ✅ accept（2026-06-15）
- [x] **§3.1 `dtuProfileCache` collection** — server 端 🔄 modified（集成点细节待 server 端提供）
- [x] **§4.1 `dtuState` 事件名 + payload** — server 端 ✅ accept（2026-06-15） + `latest-wins` 覆盖（cairui 拍）
- [x] **§4.2 `dtuHealth` 事件名 + payload** — server 端 🔄 modified（`terminals.healthScore` 字段）
- [ ] **§4.3 `dtuAlert` 事件名 + payload** — server 端 ❌ reject（**§4.3 漏写 FATAL**——RFC 002 §12.4 是 4 个值，跟 §4.3 不冲突，**修 §4.3**；cairui 拍 4 个还是 3 个）
- [x] **Zod schema（§2.1 末）** — server 端 🔄 modified（**server 端是否直接抄**待确认）
- [x] **cache 不带 TTL（§3.1 TTL 决策）** — server 端 ✅ accept（2026-06-15）
- [x] **`terminals` collection 加 `healthScore` 字段** — server 端 🔄 modified（**字段定义 / 索引**待 server 端提供）

**额外接受项**（cairui 拍）：

- [x] **alert 去重策略**（5min 内同 mac+type+message 不重推）— server 端接受，已加进 §4.3

## 6. 现状 gap（**UartNode 已知**）

> **v2 更新**（2026-06-15）—— server 端 agent 现场验证，gap 比初版**严重**：
> - **老 midway + uartserver-ng (Fastify) 两套架构并存**
> - 老 midway 走 **Node token** 鉴权（PR #20）
> - uartserver-ng 走 **JWT + role** 鉴权
> - UartNode v3.3.0 `src/fetch.ts:49` 默认 `SERVER_URL=http://localhost:9010/api/node/`，**今天只能打老 midway**

### 6.1 接口 gap 表

| 期望接口 | server 端现状 | 影响 |
|---|---|---|
| `POST /api/node/dtuinfo` | ✅ 老 midway 有 | v3.3.0 正常 |
| `POST /api/node/queryData` | ✅ 老 midway 有 | v3.3.0 正常 |
| `POST /api/node/nodeInfo` | ✅ 老 midway 有 | v3.3.0 正常 |
| `POST /api/node/UartData` | ✅ 老 midway 有 | UartNode v3.3.0 已废弃（Cache.ts 死代码）；v4 删 |
| ❌ 上述 `/api/node/*` 在 uartserver-ng (Fastify) | **完全没迁** | **切 server 端架构 = 404**，需同步迁移 |
| `GET /api/node/dtu-info-cache` | ❌ 两套都没实现（UartNode v4 新增）| RFC 002 Phase 3 落地前需 server 端实现 |
| `POST /api/node/dtu-info-cache` | ❌ 同上 | 同上 |
| `POST /api/node/dtu-info-cache/invalidate` | ❌ 同上 | 同上 |
| `dtuState` / `dtuHealth` / `dtuAlert` 事件 | ❌ 两套都没实现 | RFC 002 Phase 2 落地前需 server 端支持 |

### 6.2 部署目标（cairui 拍 = **C**）

> **C 路径** = 两套都放，**先老 midway 让 v3.3.0 不掉线**，**uartserver-ng 同步迁移**

| 阶段 | 任务 | 估时 |
|---|---|---|
| **server 端（老 midway）** | 迁移 `/api/node/*` 4 个老接口 + 新增 3 个 `dtu-info-cache` + 1 个 mongo collection + 3 个 Socket.IO 事件 | **3.0-4.5 人天**（server 端 agent） |
| **server 端（uartserver-ng）** | 同上 + 适配 JWT+role 鉴权 | cairui 排期（待估）|
| **UartNode v4** | RFC 002 Phase 1-3 落地 | 11-17 天（已估） |

**好处**：
- v3.3.0 不掉线（继续打老 midway）
- uartserver-ng 重构方向保持（C 路径不"为了快就妥协方向"）
- 风险最低（两套都通，**v3.3.0 / v4 可以灰度切换**）

**坏处**：
- 维护成本翻倍（短期）
- 鉴权体系**两套并存**期间要明确文档

### 6.3 建议 server 端 agent 优先级

1. **最高**：老 midway 迁移 `/api/node/*` + 新增 3 个 dtu-info-cache 接口
2. **高**：老 midway mongo 加 `dtuProfileCache` collection（**不带 TTL**）
3. **中**：老 midway 实现 3 个新 Socket.IO 事件（`dtuState` / `dtuHealth` / `dtuAlert`）
4. **中**：老 midway 适配 `terminals.healthScore` 字段
5. **中**：uartserver-ng 同步迁移以上（cairui 排期）
6. **低**：优化 cache 策略（压缩 / 持久化）

## 7. 决策记录

- **2026-06-15 19:00** — 草案创建。给 server 端 agent-ae682922673b 看的接口契约。
- **2026-06-15 19:10** — server 端 agent 现场验证 §6 gap，发现两套架构并存、鉴权体系不同。
- **2026-06-15 19:25** — server 端 agent 给 §5 12 条初步状态（8 ✅ + 4 🔄 + 1 ❌ = 13 实际是 12 条 + 1 修正）。
- **2026-06-15 19:43** — **cairui 拍板：部署路径 = C**（两套都放，先老 midway 让 v3.3.0 不掉线，uartserver-ng 同步）。
  - 3.0-4.5 人天 server 端老 midway + uartserver-ng cairui 排期
  - §5 checklist 已标 ✅/🔄/❌
  - §6 改写为 v2（gap v2 + 部署目标 + 估时表）

### 待 cairui 补 3 项（**收到后 commit + 回 server 端**）

| # | 项 | 我推 | 状态 |
|---|---|---|---|
| 1 | mac 主键 12 位 vs 15 位 IMEI | 15 位（避免 LAN MAC 命名空间冲突）| ⚠️ 待拍 |
| 2 | dtuAlert type 3 vs 4 个 | 4 个（跟 RFC 002 §12.4 对齐；FATAL 留 dtuAlert，不抽到 alarm）| ⚠️ 待拍 |
| 3 | 拍板日期 YYYY-MM-DD | `2026-06-15`（今天——server 端 agent 写 MR 描述用）| ⚠️ 待确认 |

> **cairui 拍完这 3 项**后我立刻：
> 1. 更新 §5/§6 状态
> 2. 微调 RFC 002 §11.6.6（接口 12 条 modified 项的最终方案）
> 3. 微调 RFC 002 §12.4（dtuAlert type 枚举最终 3/4）
> 4. commit + 删 cron + **一次性回 server 端 agent 拍板结果 + 4 个 metadata 数字**
> 5. 推 PR #1（**不依赖**这 3 项）
