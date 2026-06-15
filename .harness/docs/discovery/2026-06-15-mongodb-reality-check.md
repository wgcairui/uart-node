# MongoDB 真实数据发现 — 2026-06-15

> **目的**：校准 RFC 002 §11 DtuProfile 字段 schema，确保跟 server 端真实数据匹配。
> **源**：`mongodb://uart-server.taile0f311.ts.net:27017/UartServer`
> **采样**：2026-06-15 20:13-20:18 Asia/Shanghai
> **Server 端 QA**：2026-06-15 20:26（`agent-ae682922673b` mvs_56d1e88710c04497a9ec70b8a95fa52b）

---

## ⚠️ 关键纠正 — content / contents 字段语义（2026-06-15 20:26 server 回信）

**之前猜测（错）**：
- `queryData.content`（顶层 array of hex）= modbus RTU 请求帧 / 设备业务数据
- `queryData.contents[].buffer.data` = 设备响应字节

**server 端答（对）**：
- **`queryData.content`（顶层 `string | string[]`）= server 端生成的「协议指令名」**
  - `socket-io.service.ts:439` `emit('query', sendQuery)` → node 端
  - `socket-io.service.ts:430-436` 按 `ProtocolInstruct` 配置拼指令名 hex 字符串
  - 19% `'pesiv'` = Pesiv 协议只配了 1 条指令，content 退化成单 string
- **`queryData.contents[].buffer.data` (`number[]`) = 设备响应的真实业务字节**
  - `dev.parse.processor.ts:595-598` 落库的就是这个（`data: content.buffer.data`）
  - UartNode 端 `client.ts:375-406` 把每条响应的 buffer 收集起来组 `contents[]` 上报
- **1 条 queryData = 1 个完整查询周期**：
  1. server 生成 queryObject（`content: N 个指令名`） → emit('query') 给 node
  2. node **顺序执行** N 条指令（写设备 → 等响应）
  3. node 合并 N 个 `IntructQueryResult` → 1 个 `queryResult` → `fetch.queryData()` 上报
  4. server 落库 1 条 `log.queryData`
- **TTL 7 天** (`log.ts:608`) → 1.45M 条是 7 天窗口累计

**对 RFC 002 §11.5 payload 设计的影响**：

| 草案 | 现状 | 修正 |
|---|---|---|
| DtuProfile 顶层 `content: string[]` = 设备业务数据 | ❌ **错** | 顶层 `content` = **server→node 协议指令名**，**设备数据在 `contents[].buffer.data`** |
| `contents[]` 是「设备响应包」 | ⚠️ 部分对 | `contents[]` 是**指令名 + 响应字节**配对（每项含 echo content + buffer） |
| `useBytes/useTime` 是统计字段 | ✅ 对 | **顶层是 N 条累加，子项是单条**（确认） |
| `timeStamp` = server 端 emit 时间 | ✅ 对 | 精确：`socket-io.service.ts:445` `timeStamp: Date.now()` |

**Pesiv 卡路径**（`content: 'pesiv'` string 形式）：
- ✅ **非 modbus 路径**：3 条证据
  1. `node.controller.ts:213` 触发 `data.protocol === 'Pesiv卡'` 分支
  2. `socket.controller.ts:235-250` Pesiv 卡自动注册（PID='pesiv'）
  3. `terminal.service.ts:101` Pesiv 卡强制 `online=true`
- ✅ **仍走 queryData 上报**（mongo 26 万条 = 19%）

**typegoose Mixed 兜底**：
- `log.ts:600-654` `QueryDataLog` schema 顶层**没有** `contents[]` 字段
- 但 `result?: Schema.Types.Mixed` 兜底 + mongoose `strict: false` → `contents[]` **真实落库**
- 影响：RFC 002 §11.5 payload 设计时 `contents[]` **不能当 schema 权威**，要当成「node 端 supplementary 字段」

**type 字段 vs Pesiv**：
- mongo 看到 `type` 只有 2 个值：232 (pid=0, 71.9%) / 485 (pid=1, 28.1%)
- Pesiv 卡的 `type` 是 232 还是 485？还是另起？—— **未答，待 follow up**

---

## Open follow up（已发 server，5 个问题）

1. Pesiv `type` 字段是 232/485 还是另起
2. `strict: false` 是全局还是仅 log.queryData
3. `log.dtubusy` 是不是 server 推 dtuState 的数据源
4. `dev.register.minQueryLimit: 15` 硬节流还是建议
5. Pesiv 卡 queryData 是不是跟 type=232/485 同一上报路径

预计回信窗口：下周内。

---

## ✅ Follow up 全答齐（2026-06-15 20:29 server 回信）

### Q1: Pesiv `type` 字段是 232/485 还是另起？

**type = 物理层接口，Pesiv = 协议层协议名，两者维度不同，正交不冲突。**

- Pesiv 卡可以走 232 或 485 任意物理接口
- `node.controller.ts:213` 改的**只有** `data.protocol`，**不动** `data.type`
- `socket.controller.ts:245` 自动注册设的是 `Type: 'UPS'`（设备类型），跟 `type`（接口）**不同字段**
- mongo 71.9%/28.1% 分布 = **物理接口分布**，跟 Pesiv 协议名**正交**

**对 RFC 002 §11 字段表的影响**：
- 加一行维度说明：「`type`=物理接口 (RS232/RS485)，`protocol`=协议名 (Pesiv卡/SL6200-TH-LDS)，维度正交」
- DtuProfile 上报**两者都要带**，不能合并

### Q2: `contents[]` Mixed 兜底写入 — strict: false 全局还是仅此 collection？

**mongoose 7.x 默认 strict: true，但 Mixed 字段绕过 strict。**

- `config.default.ts:55-68` `mongoose.options` **没设** strict → 走默认 true
- **全局 strict: true**（drop unknown fields silently）
- **仅 Mixed 字段**（如 `result: Schema.Types.Mixed`）可存任意 sub-document
- `contents[]` **不是**显式声明字段，是**整条 queryResult 当 Mixed 透传进 create()**
- 依赖 typegoose `allowMixed: 0` 选项（`log.ts:602` 禁用了 strict 检查）

**对 RFC 002 §11.5 payload 设计的影响**：
- ✅ v4 Node 端上报时**显式带** `contents[]`（server Mixed 兜底继续存）
- ❌ **别假设** server 端类型/校验（schema 没声明）
- 📝 **长期**：RFC 002 实施时把 `contents[]` 加到 `QueryDataLog` schema 显式字段（10 commit 拆解的第 2 个）

### Q3: `log.dtubusy` 是不是 server 推 dtuState 的数据源？

**不是'推'的数据源，是'查'的数据源** —— dtubusy 是审计持久化层，server 端**不**主动 emit socket 推给前端。

完整链路（`node.socket.controller.ts:432-444`）：

```
node 端: busy(mac, busy, n) Socket.IO 事件
   ↓
server 端（两个并发）:
  ├── 控制层: redisService.addDtuWorkBus/delDtuWorkBus(mac)
  │           → 影响 server 是否对该 DTU 发查询（**这个会**影响 query 调度）
  └── 审计层: logDevBusyService.save({mac, stat, n, timeStamp})
              → log.dtubusy collection 落库（batch.write.service.ts:346 addLogDtuBusy，**批量写**）
```

**前端拿 dtubusy 数据**：走 `logDevBusyService.getDtuBusy(mac, start, end)`（line 29-36）**主动 query**。

**对 RFC 002 §4.1 dtuState 的影响**：
- ✅ **dtuState 事件**（`{mac, from, to, score, reason}`）跟 dtubusy **不冲突也不重用**
- ✅ dtubusy = node 端报我忙（redis 控制 + log 审计）
- ✅ dtuState = v4 新增的状态机转换
- 📝 **两条独立链路**，RFC §4.1 标注清楚

### Q4: `dev.register.minQueryLimit: 15` 硬节流还是建议值？

**不是硬节流，是 server 端 interval floor** —— `Math.max(Interval, mountDev.minQueryLimit ?? 0)` 把 Interval 抬高到不小于 minQueryLimit。

代码证据（`socket-io.service.ts:254` + `socket-io.service.ts:279`）：

```ts
Interval: Math.max(Interval, mountDev.minQueryLimit ?? 0)
```

字段位置：`mongo_entity/node.ts:302-303` `@prop({ default: 1000 }) public minQueryLimit: number`
- 是 **NodeRegister 实体字段**（不是 dev.register）
- **default 1000ms**

你们看到的 15：
- 可能是某 Node 配置的具体值（不是默认值）
- 单位是 **ms** —— 15 意思可能是 **15ms**（基本无效）或 **15000ms**（15s 强 floor）

**对 RFC 002 §11 AT 采集的影响**：
- ✅ Node 端 `client.run()` **不需要** ≥15s 间隔
- ✅ server 端 Math.max 兜底，**Node 端任意间隔都被 clamp**
- 📝 v4 建议 Node 端尊重这个 floor（避免频繁 AT 触发 DTU 卡顿）

### Q5: Pesiv 卡是不是完全 bypass queryData 走别的链路？

**不是 bypass，是同一路径走 Pesiv 解析分支。**

完整路径（`node.controller.ts:182-222`）：

```
1. await this.queryDataLogModel.create(data)  ← line 186，在 Pesiv 判断之前
2. if (data.protocol === 'Pesiv卡')             ← line 213，改 protocol 名
3. await this.parseService.queryData(data)      ← line 216，走正常解析
4. dev.parse.processor.ts:480 isPesivProtocol    ← Pesiv 走独立解析分支
5. 5 阶段流水线跑完
```

Pesiv 卡 26 万条占 19% = 正常写入 `log.queryData`（line 186 不分 Pesiv / 非 Pesiv）。

**Pesiv vs non-Pesiv 区别**：
- 写入路径：**完全一样**（`log.queryData` 同一 collection）
- 解析路径：Pesiv 走 `isPesivProtocol` 分支（`dev.parse.processor.ts:480`）
- 协议名：Pesiv 自动注册时挂 `Pesiv卡`，后续改写为实际协议（line 213）

**对 RFC 002 §11.5 payload 设计的影响**：
- ✅ **无需** Pesiv 分支（payload 设计完全通用）
- ✅ RFC §11.5 只描述「一次完整查询周期的 payload 结构」，Pesiv 自然适配

---

## 跨项目约束锁（2026-06-15 20:29 终版）

| 约束 | 权威 | 验证状态 |
|---|---|---|
| `queryData.content` = server→node 协议指令名 | server `socket-io.service.ts:439` | ✅ |
| `queryData.contents[].buffer.data` = 设备响应字节 | server `dev.parse.processor.ts:595` | ✅ |
| `queryData.useBytes/useTime` = N 条累加 | node `client.ts:375-376` | ✅ |
| `queryData.Interval` = server 算的下次间隔 | server `socket-io.service.ts:254` Math.max | ✅ |
| `queryData.timeStamp` = server emit 时 Date.now() | server `socket-io.service.ts:445` | ✅ |
| `contents[]` Mixed 兜底写入 | server `log.ts:602` typegoose allowMixed:0 | ✅ |
| `log.queryData` TTL 7 天 | server `log.ts:608` | ✅ |
| `type` = 物理接口, `protocol` = 协议名, 维度正交 | server `node.controller.ts:213` + `socket.controller.ts:245` | ✅ |
| `log.dtubusy` = 审计持久化层（非 socket 推） | server `node.socket.controller.ts:432-444` | ✅ |
| `Node.minQueryLimit` = interval floor (Math.max) | server `socket-io.service.ts:254/279` | ✅ |
| `dev.register.minQueryLimit` 字段**不存在**（是 NodeRegister 字段） | server `mongo_entity/node.ts:302-303` | ✅ 修正 |
| Pesiv 卡走 queryData 同一上报路径 | server `node.controller.ts:186` 写库在 Pesiv 判断前 | ✅ |

下一步：RFC 002 v1.5 字段表更新（§11 + §11.5 + §4.1），同步给 server agent。

---

## TL;DR

| 发现 | 影响 |
|---|---|
| **`queryData.mac` 全是 12 位**（4G IMEI 数字 / LAN MAC hex 混存） | ⚠️ RFC 002 §11 v4 拍板的「15 位 IMEI」**没在 server 端落地**，是 Node 端规划目标 |
| `content` 字段**多态**：81% array (modbus) / 19% string (Pesiv卡=`"pesiv"`) | ⚠️ Node 端 queryData payload 必须支持两种 schema |
| `log.dtubusy.stat` (boolean) + `log.dtubusy.n` (number) **就是真实 dtuState** | ✅ server 端**没单独 dtuState collection**，复用 dtubusy |
| `dev.register` 是**设备静态注册表**（240 台），无 v4 字段（imei/imsi/apn） | ❌ server 端**没存**这些字段，RFC 002 §11.6 profile cache 设计不变 |
| **`queryData.useBytes`（复数）vs `contents[].useByte`（单数）** 命名不一致 | 📝 跟 RFC 002 §11 同步标注，原样透传不规范化 |
| `queryData` **TTL 索引** (`timeStamp: 8d`) — 历史数据会过期 | 📝 Node 端 v4 dtuProfile 同步策略要明确 |
| mac 字符集：80% 数字-only，20% 含 hex (A-F) | ✅ 「混存」结论验证，跟 type=232 / type=485 相关 |

---

## 1. log.queryData (1,448,961 docs, 2026-06-08 ~ 2026-06-15)

### 字段全集（14 个，100% 覆盖率）

```
_id         ObjectId
timeStamp   number (ms, e.g. 1780920758037)
mac         string (12位, 数字或hex混存)
type        number (232=modbus RTU / 485=modbus ASCII 或其他协议)
mountDev    string (e.g. "LADS 25KW基站")
protocol    string (e.g. "SL6200-TH-LDS" / "Pesiv卡")
pid         number (0 / 1, 跟 type 强相关)
content     array<string> | string  ← 多态
Interval    number (ms, e.g. 8000)
useTime     number (ms, 整次查询耗时)
time        string (e.g. "Mon Jun 08 2026 20:12:39 GMT+0800 (Central Standard Time)")
useBytes    number (整次查询字节数)
contents    array<{ content, buffer, useTime, useByte }>  ← 子项细节
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
| `content` | array \| string | **多态**：81% array (hex string)，19% string（Pesiv卡=`"pesiv"`） |
| `contents[].buffer` | `{type:'Buffer', data: number[]}` | **Node JSON 序列化形式**，不是真 Buffer |
| `contents[].useByte` | number | 子项**单数** |
| `contents[].content` | string | hex string |

### type / pid 分布

```
type=232: 1,041,335 (71.9%)  pid=0
type=485:   407,514 (28.1%)  pid=1
```

只有 2 种 type，跟 pid 一一对应。RFC 002 §11 提到的「485 / 232 协议」在 server 端就是这么区分的。

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

97% 是 4-5 条，跟"一次查询返回 5 个寄存器块"的 modbus 模式吻合。

### mac 字符集分析（200 样本）

```
字符集全集: 0123456789ABCDEF
数字-only mac: 160 / 200  (80%, 像 4G IMEI 数字格式)
含 A-F mac:    40 / 200  (20%, 像 LAN MAC hex)
```

12 位数字（`542055213790`）可能就是 IMEI 12 位（标准 14 位裁剪），需要 server 端 agent 确认。

### content 多态（关键）

```
type=array: 1,179,130  (81%)
type=string: 269,725    (19%)

string 样例：
  mac=28559BBCF789 protocol=Pesiv卡 content="pesiv"
  mac=286B2DF1D6F5 protocol=Pesiv卡 content="pesiv"
```

**Pesiv 设备上报的 content 就是字符串 `"pesiv"`**，不是 hex 数组。Node 端 v4 payload 必须支持 `string | string[]`。

### 索引

```
{_id: 1}                       _id_              unique
{timeStamp: 1}                 ttl_timeStamp     ← **TTL 索引！** 8天过期
{createdAt: 1}                 createdAt_1
```

`ttl_timeStamp` 暗示历史只保留 ~8 天（实际数据 2026-06-08 ~ 2026-06-15，7 天窗口）。

---

## 2. log.dtubusy (515,702 docs)

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

- **`stat: true` (66,539) vs `stat: false` (449,259)** — 87% 是离线记录，13% 在线
- **`n` 取值**：1 (29.8%) / 0 (29%) / 3-13 (各 0.03-0.2%)
- **同一 mac 高频更新**：`542055024676` 在 12 秒内出现 5 条
- mac 字段全是 12 位数字（`542055024676` 是 IMEI，不是 LAN MAC hex）

### 这就是 v4 想要的 `dtuState`

```javascript
{
  mac: '542055024676',     // 12 位 IMEI
  stat: true,              // 在线状态
  n: 4,                    // 序号/重试
  timeStamp: 1776680011022 // 最近心跳
}
```

**Node 端 v4 规划**：dtuState 事件从 server 端 `log.dtubusy` 推过来（Socket.IO `dtuState` 事件），不需要 Node 端额外生成。

---

## 3. dev.register (240 docs, 设备静态注册表)

### 字段全集

```
_id             ObjectId
pid             number
online          boolean
timeStamp       number
id              string (e.g. "*0008-202107071130000137*")
Type            string (大写 T, e.g. "空调")
mountDev        string
protocol        string
minQueryLimit   number (15)
__v             number
```

### 关键发现

- **`Type` 大写 T** —— 命名风格跟 RFC 002 §11 DtuProfile 的 `type` (小写) 不一样
- **`id` 格式 `*0008-202107071130000137*`** —— `0008` 是节点 ID（4 位），后面是 18 位时间戳？需要 server agent 确认
- **`minQueryLimit: 15`** —— server 端强制 15 秒最小查询间隔！这正是 v1.4 alignment §4.3「5min 去重 + 30s」的**实际服务端依据**——server 用 `minQueryLimit` 做了硬性节流
- ❌ **完全没看到 imei / imsi / apn / network / clock / traffic / heartbeat** —— RFC 002 v1.4 拍板的 v4 新字段**server 端一个都没存**
- ✅ **NFC**: v4 字段需要 Node 端自己通过 AT 采集（RFC 002 §11.1），不在 server 端落库

---

## 4. log.nodes (173 docs)

```
_id         ObjectId
ID          string (e.g. "i1x1RrFeiE_mRC5DAAAD")
IP          string
Name        string (e.g. "pwsiv" — typo? pesiv?)
type        string ("上线" / 其他)
timeStamp   number
createdAt   ISODate
__v         number
```

Node 实例上下线日志，跟设备无关，是 server 节点注册记录。

---

## 5. 对 RFC 002 §11 DtuProfile 的修正建议

### 5.1 字段命名标准化

| RFC 002 v4 草案 | server 真实数据 | 修正 |
|---|---|---|
| `useBytes` (复数) | ✅ 一致 | 保留 |
| `useByte` (单数, contents 内) | ✅ 一致 | 保留 |
| `timeStamp` | ✅ 一致 | 保留 |
| `time` (string) | ✅ 一致 | 保留，但标注「人类可读，非 ISO」 |
| `content` (array) | ❌ 多态 | 加 `@oneOf string \| string[]` 标注 |
| `mac` (12位 hex / 15位 IMEI) | ❌ 当前 12 位数字+hex 混存 | **临时兼容 12 位混存**，v4 仍推 15 位 |

### 5.2 mac 主键决策 (cairui 2026-06-15 拍板)

- **拍板**：15 位 IMEI
- **现实**：server 端当前 12 位混存 (4G IMEI 数字 + LAN MAC hex)
- **影响**：
  - v4 Node 端采集上报用 15 位（消歧）
  - v4 部署期**旧设备仍 12 位**，RFC §11 需要写兼容逻辑（12 → 15 pad）
  - +0.5 人天 migration 已在 v1.4 拍板里估进

### 5.3 dtuState 来源确认

- server 端 `log.dtubusy` = v4 dtuState 数据源
- Node 端**不**生成 dtuState，从 server 推 Socket.IO 事件接收
- `dev.register.online` 字段冗余，**不作为权威**（dtubusy 是权威）

### 5.4 v4 新字段是否需要 server 端配合

RFC 002 v1.4 §11 列了 v4 新增字段：imei / imsi / apn / network / clock / traffic / heartbeat。

**真实情况**：server 端 `dev.register` 一个都没存。

**结论**：
- 这些字段**必须 Node 端通过 AT 指令采集**（PR #5/#6/#7 范围）
- **不需要** server 端做 schema 变更
- **不需要**等 server agent 配合开发
- RFC 002 §11.6 profile cache 设计**不变**

### 5.5 `minQueryLimit: 15` 的影响

server 端 dev.register 有 `minQueryLimit: 15`，含义是**每个设备 15 秒最多查 1 次**。

- 这跟 alignment §4.3「5min 去重 + 30s」**不冲突**——15s 是 server 硬节流，30s 是 Node 端软去重
- RFC 002 §11 v4 文档需要标注：「server 端 dev.register.minQueryLimit 默认 15s，Node 端 client.run() 批量查必须 ≥ 15s 间隔」
- 实测：Node 端 `run()` 一次性发 8 条 AT 指令只算 1 次「查询周期」，server 端按 mac 维度节流

---

## 6. 立即 action items

### 跟 server 端 agent (`mvs_56d1e88710c04497a9ec70b8a95fa52b`) 同步

1. 确认 `log.dtubusy` 是不是 server 端推 dtuState 的数据源（应该就是）
2. 确认 dev.register 的 `id` 格式（`*0008-202107071130000137*`）含义
3. 确认 `Type` (大写 T) 是历史遗留还是有意设计
4. 确认 `minQueryLimit` 默认 15s 是不是硬节流

### 跟 RFC 002 v1.4 同步

1. §11 DtuProfile 字段表更新：标 ✅/⚠️/❌ 跟真实数据对账
2. §11 加「mac 12→15 位兼容」段
3. §11 加「content 多态」段（`string | string[]`）
4. §11 加「time 字段是 string 非 ISO」段
5. §11.1 AT 采集强调「v4 新字段 server 端没存，必须 Node 端采集」

### 跟 cairui 同步

1. 「12 位混存」现状 — **不影响** 15 位 IMEI 拍板（v4 是目标，旧数据兼容）
2. 「server 端没存 v4 字段」 — **不影响** Node 端 v4 实现
3. `minQueryLimit: 15` — 跟 alignment §4.3 不冲突，但要在 RFC §11 显式标注

---

## 7. 采样脚本（可复用）

```bash
# 字段分布
mongosh "$MONGO_URI" --quiet --eval '
const coll = db.getCollection("log.queryData");
coll.aggregate([
  { $project: { kv: { $objectToArray: "$$ROOT" } } },
  { $unwind: "$kv" },
  { $group: { _id: "$kv.k", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
]).forEach(r => print(`${r._id}: ${r.count}`));
'

# 单条原始
mongosh "$MONGO_URI" --quiet --eval '
printjson(db.getCollection("log.queryData").findOne({}));
'

# 索引
mongosh "$MONGO_URI" --quiet --eval '
db.getCollection("log.queryData").getIndexes().forEach(i => printjson(i));
'
```

---

## 8. 不在本次范围的 collection（暂不动）

| Collection | 用途 | RFC 002 关联 |
|---|---|---|
| `terminals` / `ec.terminals` / `terminal.registers` | 终端配置 | §3 lifecycle |
| `instructs` / `log.instructquerys` | 指令下发日志 | §9 fetch 迁移 |
| `linkfrends` / `user.binddevices` | 用户-设备绑定 | 不在 RFC 002 |
| `device.protocols` / `device.types` / `device.constants` | 协议字典 | §11 |
| `user.*` / `users` | 用户 | 不在 RFC 002 |
| `secret.apps` | 第三方 app key | §13 鉴权 |
| `aggregations` / `user.aggregations` | 聚合数据 | §11 dtuState 衍生 |
| `system.views` | MongoDB 系统视图 | 不动 |
