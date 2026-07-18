# Server 端契约 Audit — 2026-06-15

> **目的**：固化 server 端 (`midwayuartserver`) 代码现状的 audit，给 RFC 002 §11 DtuProfile 字段表 + §11.5 payload 设计 + §4.1 dtuState 链路提供权威依据。
>
> **源**：MongoDB `mongodb://uart-server.taile0f311.ts.net:27017/UartServer` 1.45M 条采样 + server agent (`mvs_56d1e88710c04497a9ec70b8a95fa52b`) 5 答 v1 + 5 答 v2 + 代码 grep 行号
>
> **当前状态**：本文档在 UartNode 仓库 `.harness/docs/discovery/`（UartNode 端不丢）。Server repo (`midwayuartserver`) 是否镜像由 cairui 拍板。
>
> **Server 端原始 QA**（v1）：`/tmp/uart-node-qa.md`（7.5KB，143 行）— session ephemeral storage，worker 重建会丢

---

## 目录

1. MongoDB 真实 schema（4 个 collection）
2. content / contents 字段语义（v1 答）
3. 5 个 follow up（v2 答）
4. 跨项目约束锁（12 条）
5. 关键代码位置（grep 行号索引）

---

# 1. MongoDB 真实 schema

## 1.1 log.queryData（1,448,961 docs，2026-06-08 ~ 2026-06-15）

### 字段全集（14 个，100% 覆盖率）

```
_id         ObjectId
timeStamp   number (ms, e.g. 1780920758037)
mac         string (12位, 数字或hex混存)
type        number (232=RS232 / 485=RS485, 物理接口)
mountDev    string (e.g. "LADS 25KW基站")
protocol    string (e.g. "SL6200-TH-LDS" / "Pesiv卡" — 协议名)
pid         number (0 / 1, 跟 type 强相关)
content     array<string> | string  ← 多态（协议指令名）
Interval    number (ms, 下次查询间隔 = Math.max(server 算的 Interval, minQueryLimit))
useTime     number (ms, 本次查询总耗时 = N 条子指令累加)
time        string (e.g. "Mon Jun 08 2026 20:12:39 GMT+0800 (Central Standard Time)")
useBytes    number (本次查询总字节数 = N 条子指令累加)
contents    array<{ content, buffer, useTime, useByte }>  ← Mixed 兜底写入
createdAt   ISODate
__v         number (mongoose 版本锁)
```

### 字段类型

| 字段 | 类型 | 备注 |
|---|---|---|
| `timeStamp` | number (ms) | `Date(1780920758037).toISOString() = 2026-06-08T12:12:38.037Z` |
| `time` | string | **人类可读格式**，带时区 `(Central Standard Time)`——不是 ISO 8601 |
| `useBytes` | number | 顶层**复数** |
| `useTime` | number | ms |
| `content` | array \| string | **多态**：81% array (协议指令名 hex)，19% string（Pesiv卡=`"pesiv"`） |
| `contents[].buffer` | `{type:'Buffer', data: number[]}` | **设备响应字节**（真实业务数据） |
| `contents[].useByte` | number | 子项**单数** |
| `contents[].content` | string | 协议指令名 echo |

### type / pid 分布

```
type=232: 1,041,335 (71.9%)  pid=0   → RS232 接口
type=485:   407,514 (28.1%)  pid=1   → RS485 接口
```

只有 2 种 type，**物理接口维度**，跟 protocol（协议名）正交。

### contents[] 长度分布

```
len=5: 1,000,243  (68.8%)
len=4:   419,730  (28.9%)
len=7:    12,022
len=6:     5,978
len=3:     5,027
len=1:     3,275
len=2:     2,580
len=0:         2  (基本无效)
```

### mac 字符集分析（200 样本）

```
字符集全集: 0123456789ABCDEF
数字-only mac: 160 / 200  (80%, 像 4G IMEI 数字格式)
含 A-F mac:    40 / 200  (20%, 像 LAN MAC hex)
```

### content 多态（关键）

```
type=array: 1,179,130  (81%)
type=string: 269,725   (19%)

string 样例：
  mac=28559BBCF789 protocol=Pesiv卡 content="pesiv"
```

Pesiv 卡 content 退化成单 string（协议只配了 1 条指令）。

### 索引

```
{_id: 1}                       _id_              unique
{timeStamp: 1}                 ttl_timeStamp     ← TTL 7 天
{createdAt: 1}                 createdAt_1
```

## 1.2 log.dtubusy（515,702 docs）

### 字段全集

```
_id         ObjectId
timeStamp   number (ms)
mac         string (12位)
stat        boolean (true=在线 / false=离线)
n           number (0-13, 查询序号/重试次数)
createdAt   ISODate
__v         number
```

### 关键发现

- **`stat: true` (66,539) vs `stat: false` (449,259)** — 87% 离线，13% 在线
- **`n` 取值**：1 (29.8%) / 0 (29%) / 3-13 (各 0.03-0.2%)
- mac 字段全是 12 位数字（IMEI 短格式）

### 写入路径

**审计持久化层**，不是 socket 推送源：

```
node 端: busy(mac, busy, n) Socket.IO 事件
   ↓
server 端（两个并发）:
  ├── 控制层: redisService.addDtuWorkBus/delDtuWorkBus(mac)
  │           → 影响 server 是否对该 DTU 发查询
  └── 审计层: logDevBusyService.save({mac, stat, n, timeStamp})
              → log.dtubusy collection 落库
              → batch.write.service.ts:346 addLogDtuBusy（**批量写**）
```

**前端拿 dtubusy 数据**：走 `logDevBusyService.getDtuBusy(mac, start, end)` **主动 query**。

## 1.3 dev.register（240 docs，设备静态注册表）

### 字段全集

```
_id             ObjectId
pid             number
online          boolean
timeStamp       number
id              string (e.g. "*0008-202107071130000137*")
Type            string (大写 T, e.g. "空调" — **设备类型**)
mountDev        string
protocol        string
__v             number
```

### 关键发现

- **`Type` 大写 T** = **设备类型**（不是 type 物理接口）
- **`id` 格式 `*0008-202107071130000137*`** —— `0008` 是节点 ID（4 位）
- ⚠️ **没有 `minQueryLimit` 字段**（我之前认错 collection！minQueryLimit 在 NodeRegister，不是 dev.register）

## 1.4 log.nodes（173 docs，server 节点上下线）

```
_id         ObjectId
ID          string (e.g. "i1x1RrFeiE_mRC5DAAAD")
IP          string
Name        string (e.g. "pwsiv" / "pesiv" — typo?)
type        string ("上线" / 其他)
timeStamp   number
createdAt   ISODate
__v         number
```

### NodeRegister.minQueryLimit（关键修正）

`mongo_entity/node.ts:302-303`：

```ts
@prop({ default: 1000 }) public minQueryLimit: number
```

- **default 1000ms**
- 是 **NodeRegister 实体字段**（不是 dev.register）
- 某 Node 配置的具体值可能是 15（15ms 或 15000ms）

---

# 2. content / contents 字段语义（v1 答）

## 核心结论

**`queryData.content` 是 server 端生成的「协议指令名」，不是设备业务数据。真实业务数据在 `queryData.contents[].buffer.data`。**

## Q1: queryData.content（顶层 string | string[]）语义是什么？

**不是 modbus RTU 请求帧，也不是设备业务数据。** 是 **server 端生成的"协议指令名"**（Uart.queryObject.content，类型 `string | string[]`）。

### 生成路径

- `socket-io.service.ts:430-436`：按 ProtocolInstruct 体系，把指令名 → 字节内容 → hex 字符串
- `socket-io.service.ts:439-449`：构造 sendQuery: Uart.queryObject（顶层 `content: string[]`）
- `socket-io.service.ts:459`：`this.getCtx(query.mountNode).emit('query', sendQuery)` —— emit 给 node

### 字段名直译

`uart.d.ts:603` 中文注释就是 "查询指令"。UartNode 端 `client.ts:400` 拿它做 `okContents` 比对（`Query.content.filter(el => !okContents.has(el))` —— 超时指令检测），说明 content 确实是 server→node 的**协议指令标识**。

### 你们看到的 81% hex string 数组

= 协议指令的字节 hex 字符串（按 ProtocolInstruct 配置生成，**不是 modbus 帧**）。

### 19% string "pesiv"

= Pesiv 协议只有 1 条指令，content 退化成单 string。

## Q2: Pesiv 卡 content="pesiv" 怎么解析？非 modbus 路径对吗？

**对，Pesiv 卡是非 modbus 路径。** 三条证据：

1. **`node.controller.ts:213`**：`if (data.protocol === 'Pesiv卡')` —— 触发 Pesiv 处理分支（`data.protocol = terminal?.mountDevs[0]?.protocol || data.protocol`，把协议名替换为挂载设备实际协议）
2. **`socket.controller.ts:235-250`**：自动注册路径。节点名是 `'pwsiv' | 'besiv-1'` + 设备未注册时，**自动 addRegisterTerminal + addTerminalMountDev(protocol: 'Pesiv卡') + modifyTerminal(PID: 'pesiv')**
3. **`terminal.service.ts:101`**：Pesiv 卡强制所有挂载设备 `online = true`（`PID === 'pesiv' && ...`）

**"pesiv" 字符串语义** = server 端按 Pesiv 协议生成的**唯一查询指令名**（Pesiv 协议配置只有 1 条指令），node 端收到后去查 `Pesiv卡` 协议定义生成实际字节去问设备。

## Q3: queryData.contents[]（子数组）是什么？

`Uart.IntructQueryResult` 定义（`uart.d.ts:671-677`）：

```ts
interface IntructQueryResult {
  content: string;        // 协议指令名（server 端 echo）
  buffer: {
    data: number[];       // 设备响应的字节数组（真实业务数据在这）
    type: string;         // 缓冲区类型标记（"unSocket" = 异常）
  };
  useByte?: number;       // 单条指令字节数
  useTime?: number;       // 单条指令耗时
}
```

**content 字段**：server 端协议指令名 echo（方便 server 关联回 `queryObject.content[]`）

**buffer.data 才是真实业务数据**（设备响应字节）。

**证据**：`dev.parse.processor.ts:595-598`：

```ts
const rawContents = queryData.contents.map(content => ({
  content: content.content,
  data: content.buffer.data,  // ← 业务数据落库的字段
}));
```

**UartNode 端构造**（`client.ts:375-406`）：

```ts
Query.useBytes = IntructQueryResults.map(el => el.useByte).reduce(...)
Query.useTime = IntructQueryResults.map(el => el.useTime).reduce(...)
const contents = IntructQueryResults.filter(el => Buffer.isBuffer(el.buffer))
const SuccessResult = Object.assign<queryObjectServer, Partial<queryOkUp>>(
  Query, { contents, time: new Date().toString() }
) as queryOkUp
fetch.queryData(SuccessResult)  // 上报
```

## Q4: 整体 queryData collection 是"每次查询周期记一条"？

**是，1 个 queryResult = 1 个完整查询周期。** 周期定义：

1. server 端生成 1 个 queryObject（`content: string[]` = N 个查询指令名）
2. server 端 `emit('query', sendQuery)` 一次性发给 node
3. node 端**顺序执行** N 条指令（`client.ts:367` 写设备 + 等响应）
4. node 端**合并 N 个 IntructQueryResult → 1 个 queryResult** 上报

**写入**：`node.controller.ts:186` `await this.queryDataLogModel.create(data)` —— 整条入库，**1.45M 条 = 1.45M 个查询周期**。

**TTL**：`log.queryData` collection 配了 `expires: 7 * 24 * 60 * 60`（`log.ts:608`）——**7 天自动过期**。所以 1.45M 条是 7 天窗口内的累积。

---

# 3. 5 个 follow up（v2 答）

## Q1: Pesiv 'pesiv' 跟 type=232/485 是什么关系？

**type 是物理层接口（232=RS232 / 485=RS485），Pesiv 是协议层协议名。两者维度不同，不冲突。** Pesiv 卡可以走 232 或 485 任意一种物理接口，Pesiv 是协议名（`PID='pesiv'` / `protocol='Pesiv卡'`）。

代码证据：
- `node.controller.ts:213` 改的**只有** `data.protocol`，**不动** `data.type`
- `socket.controller.ts:245` 自动注册时设 `Type: 'UPS'`（**设备类型**），不是 `type`（接口类型）
- mongo 71.9% type=232 / 28.1% type=485 分布 = 物理接口分布，跟 Pesiv 协议名**正交**

## Q2: contents[] Mixed 兜底写入 — strict: false 全局还是仅此 collection？

**mongoose 7.x 默认 strict: true**（drop unknown fields silently），**但 Mixed 字段绕过 strict 接受任何子结构**。

代码证据：`config.default.ts:55-68` `mongoose.options` **没设** strict 字段——走 mongoose 默认 true。所以：
- **全局**：strict: true（默认）
- **仅 Mixed 字段**（如 `result: Schema.Types.Mixed`）可以存任意 sub-document
- `contents[]` **不是**显式声明字段，是**整条 queryResult 当 Mixed 透传进 create()**——这依赖 mongoose 的 strict 行为 + typegoose `allowMixed: 0` 选项（`log.ts:602` 禁用了这个选项的 strict 检查）

**对 RFC 002 §11.5 的影响**：contents[] 不是 schema 权威字段，**是 Mixed 兜底**——建议：
- v4 上报时**显式带** contents[]（server 端继续 Mixed 兜底存）
- 但**别假设** server 端类型/校验——因为 schema 没声明
- 长期：RFC 002 实施时（10 个 commit 拆解的第 2 个）把 contents[] 加到 `QueryDataLog` schema 显式字段

## Q3: log.dtubusy 是不是 server 推 dtuState 的数据源？

**不是'推'的数据源，是'查'的数据源**——dtubusy 是**审计持久化层**，server 端不主动 emit socket 推给前端。

完整链路（`node.socket.controller.ts:432-444`）：

1. node 端发 `busy(mac, busy, n)` Socket.IO 事件
2. server 端**两个并发**：
   - **控制层**：`redisService.addDtuWorkBus/delDtuWorkBus(mac)` —— 影响 server 是否对该 DTU 发查询（**这个会**影响 query 调度）
   - **审计层**：`logDevBusyService.save({mac, stat, n, timeStamp})` —— `log.dtubusy` collection 落库（`batch.write.service.ts:346 addLogDtuBusy`，**批量写**）
3. **没有** emit socket 推前端

前端拿 dtubusy 数据走 `logDevBusyService.getDtuBusy(mac, start, end)`（line 29-36）**主动 query**。

**对 RFC 002 §4.1 dtuState 的影响**：dtuState 事件 (`{mac, from, to, score, reason}`) **跟** dtubusy **不冲突也不重用**——dtubusy 是 node 端报我忙，dtuState 是 v4 新增的状态机转换。**两条独立链路**。

## Q4: dev.register.minQueryLimit: 15 是硬节流还是建议值？

**不是硬节流，是 server 端 interval floor** —— `Math.max(Interval, mountDev.minQueryLimit ?? 0)` 把 Interval 抬高到不小于 minQueryLimit。

代码证据（`socket-io.service.ts:254` + `socket-io.service.ts:279`）：

```ts
Interval: Math.max(Interval, mountDev.minQueryLimit ?? 0)
```

字段位置：`mongo_entity/node.ts:302-303` `@prop({ default: 1000 }) public minQueryLimit: number` —— **default 1000ms**，是 NodeRegister 实体字段（不是 dev.register）。

你们看到的 15：可能是某 Node 配置的具体值（不是默认值）。**单位是 ms**——15 意思是 **15ms**（基本无效）或 **15000ms**（15s 强 floor）。

**对 RFC 002 §11 AT 采集的影响**：Node 端 `client.run()` **不需要** ≥15s 间隔——server 端 Math.max 兜底，**Node 端任意间隔都会被 clamp 到 minQueryLimit**。但 v4 建议 Node 端尊重这个 floor（避免频繁 AT 触发 DTU 卡顿）。

## Q5: Pesiv 卡是不是完全 bypass queryData 走别的链路？

**不是 bypass，是同一路径走 Pesiv 解析分支**。

完整路径（`node.controller.ts:182-222`）：

1. `await this.queryDataLogModel.create(data)`（line 186）—— **在 Pesiv 判断之前**——Pesiv 跟非 Pesiv 都写 `log.queryData`
2. `if (data.protocol === 'Pesiv卡')`（line 213）—— 改 protocol 名为挂载设备实际协议
3. `await this.parseService.queryData(data)`（line 216）—— 走正常解析
4. `dev.parse.processor.ts:480` `isPesivProtocol = /^Pesiv卡/.test(queryData.protocol)` —— Pesiv 走独立解析分支
5. 5 阶段流水线（CLAUDE.md parse pipeline）跑完

Pesiv 卡 26 万条占 19% = 正常写入 `log.queryData`（line 186 不分 Pesiv / 非 Pesiv）。

Pesiv vs non-Pesiv 区别：
- 写入路径：**完全一样**（`log.queryData` 同一 collection）
- 解析路径：Pesiv 走 `isPesivProtocol` 分支（`dev.parse.processor.ts:480`）
- 协议名：Pesiv 自动注册时挂 `Pesiv卡`，后续改写为实际协议（line 213）

---

# 4. 跨项目约束锁（12 条 ✅ 验证）

| # | 约束 | 权威 | 验证状态 |
|---|---|---|---|
| 1 | `queryData.content` = server→node 协议指令名 | server `socket-io.service.ts:439` | ✅ |
| 2 | `queryData.contents[].buffer.data` = 设备响应字节 | server `dev.parse.processor.ts:595` | ✅ |
| 3 | `queryData.useBytes/useTime` = N 条累加 | node `client.ts:375-376` | ✅ |
| 4 | `queryData.Interval` = server 算的下次间隔 | server `socket-io.service.ts:254` Math.max | ✅ |
| 5 | `queryData.timeStamp` = server emit 时 Date.now() | server `socket-io.service.ts:445` | ✅ |
| 6 | `contents[]` Mixed 兜底写入 | server `log.ts:602` typegoose allowMixed:0 | ✅ |
| 7 | `log.queryData` TTL 7 天 | server `log.ts:608` | ✅ |
| 8 | `type` = 物理接口, `protocol` = 协议名, 维度正交 | server `node.controller.ts:213` + `socket.controller.ts:245` | ✅ |
| 9 | `log.dtubusy` = 审计持久化层（非 socket 推） | server `node.socket.controller.ts:432-444` | ✅ |
| 10 | `Node.minQueryLimit` = interval floor (Math.max) | server `socket-io.service.ts:254/279` | ✅ |
| 11 | `dev.register.minQueryLimit` 字段**不存在**（是 NodeRegister 字段） | server `mongo_entity/node.ts:302-303` | ✅ 修正 |
| 12 | Pesiv 卡走 queryData 同一上报路径 | server `node.controller.ts:186` 写库在 Pesiv 判断前 | ✅ |

---

# 5. 关键代码位置（grep 行号索引）

## QueryDataLog schema

- `mongo_entity/log.ts:600-654` — QueryDataLog schema（含 Mixed 字段 line 644-645）
- `mongo_entity/log.ts:608` — TTL `expires: 7 * 24 * 60 * 60`
- `mongo_entity/log.ts:602` — typegoose allowMixed:0

## 类型定义

- `common/types/uart.d.ts:576` — queryObject.content 注释「对节点发出的协议查询指令」
- `common/types/uart.d.ts:603` — 中文注释「查询指令」
- `common/types/uart.d.ts:671-677` — IntructQueryResult 类型
- `common/config/config.default.ts:55-68` — mongoose options（**没设** strict）

## Server 端生成 query + emit

- `module/realtime/service/socket-io.service.ts:430-436` — 协议指令字节拼装
- `module/realtime/service/socket-io.service.ts:439-449` — sendQuery: Uart.queryObject 构造
- `module/realtime/service/socket-io.service.ts:254/279` — `Math.max(Interval, mountDev.minQueryLimit ?? 0)`
- `module/realtime/service/socket-io.service.ts:445` — `timeStamp: Date.now()`
- `module/realtime/service/socket-io.service.ts:459` — `emit('query', sendQuery)`

## Server 端 queryData HTTP 入口

- `module/realtime/controller/node.controller.ts:182-222` — queryData HTTP 入口（含 Pesiv 分支 line 213）
- `module/realtime/controller/node.controller.ts:186` — `await this.queryDataLogModel.create(data)`（Pesiv 判断前）
- `module/realtime/controller/node.controller.ts:213` — `if (data.protocol === 'Pesiv卡')` 改 protocol
- `module/realtime/controller/node.controller.ts:216` — `await this.parseService.queryData(data)` 走解析
- `module/realtime/controller/node.controller.ts:238-...` — queryData/batch 批量版

## Pesiv 路径

- `module/realtime/socket/node.socket.controller.ts:235-250` — Pesiv 卡自动注册（PID='pesiv'）
- `module/realtime/socket/node.socket.controller.ts:245` — `Type: 'UPS'`（设备类型）
- `module/realtime/socket/node.socket.controller.ts:432-444` — busy 事件双链路（redis + log）
- `module/log/service/log-dev-busy.service.ts:9-36` — dtuBusy save + getDtuBusy（**没有 emit**）
- `module/log/service/log-dev-busy.service.ts:29-36` — getDtuBusy（前端主动 query）

## NodeRegister.minQueryLimit

- `mongo_entity/node.ts:298-303` — minQueryLimit 字段（default 1000）
- `mongo_entity/node.ts:302-303` — `@prop({ default: 1000 }) public minQueryLimit: number`

## 解析流水线

- `module/data/processor/dev.parse.processor.ts:480` — Pesiv 协议检测 `isPesivProtocol`
- `module/data/processor/dev.parse.processor.ts:480-613` — 解析流水线（含 Pesiv 协议检测 line 480 + saveResultHistory 落库 line 588）
- `module/data/processor/dev.parse.processor.ts:595-598` — `rawContents` 落库（`data: content.buffer.data`）

## 终端服务

- `module/terminal/.../terminal.service.ts:101` — Pesiv 卡强制 `online = true`

## Batch write

- `module/log/.../batch.write.service.ts:346` — `addLogDtuBusy`（**批量写**）

---

# 附录 A: 给 cairui 的拍板点（持久化决策）

## 问题

server agent (`mvs_56d1e88710c04497a9ec70b8a95fa52b`) workspace 是 `midwayuartserver`，**项目根目前没有 `.harness/` 目录**。

如果要在 server repo 镜像这份 audit，需要：
1. cairui 在 server repo 创建 `.harness/docs/contracts/` 目录（或者同意 server agent 自己创建）
2. server agent 把 `/tmp/uart-node-qa.md` + `/tmp/uart-node-qa-followup.md` 内容复制过去
3. 后续 server 端代码改动同步更新 audit

## server agent 的建议（待 cairui 拍）

> 是 **server 端代码现状的 audit**（含 grep 行号、controller 行为、parse pipeline 5 阶段），**不是** server agent 自己的 skill 描述。
> 建议放 server repo 的 `.harness/docs/contracts/uart-node-queryData-audit.md` 或类似位置。

## 替代方案

- **方案 A**：cairui 在 server repo 建 `.harness/docs/contracts/`（**推荐**）
- **方案 B**：audit 文档只存在 UartNode repo 的 `.harness/docs/discovery/`（**现状**），server 端改动时 server agent 来 UartNode repo 找参考
- **方案 C**：放共享位置（cairui 机器的 `~/Code/_shared_contracts/` 或类似），两边都引用

---

# 附录 B: 时间线

- 2026-06-15 20:13 — 接 handoff，开始 MongoDB 探查
- 2026-06-15 20:18 — 完成 schema 字段枚举，发现 5 个 RFC 不一致
- 2026-06-15 20:21 — cairui 提示 `content` 是协议查询指令，让找 server 确认
- 2026-06-15 20:26 — server agent v1 答：方向猜反，content 是 server 端生成的协议指令名
- 2026-06-15 20:29 — server agent v2 答：5 个 follow up 全答齐
- 2026-06-15 20:31 — server agent 反馈「持久化不是他能拍的，需要 cairui 拍」
- 2026-06-15 20:32 — UartNode 端 audit 文档定稿（本文）
