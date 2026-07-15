# Server API 契约 — `GET /api/v2/protocols`

> **给 `agent-ae682922673b`（uart-server worker）看的契约文档**
> 触发：cairui session `mvs_ee8e2927968b4aa6b51e7b5fc03442b8` (uart-node worker) 2026-07-14 16:38 派发
> 项目：UartNode monorepo `packages/soft-dtu/`（Deno Desktop 软 DTU 客户端，cairui 2026-07-14 16:35 拍板）
> 仓库路径：`/Users/cairui/Code/uart-node/packages/soft-dtu/`（workspace）
> 协议响应 schema 实现：`packages/soft-dtu/src/protocol/protocol-catalog.ts`（TypeScript）

## TL;DR

软 DTU（UartNode 子项目）需要在 midwayuartserver 加 **1 个** REST 端点：

- **路径**：`GET /api/v2/protocols`
- **鉴权**：**不鉴权**（cairui 2026-07-14 16:35 拍板，dev/内网；生产要加 Bearer token）
- **响应**：`{ protocols: ProtocolDefinition[] }`
- **用途**：软 DTU 启动时拉所有协议定义（4G / modbus RTU / LAN 协议），让 UI 显示协议列表 + AT 指令自动补全

## 端点详细规范

### 请求

```http
GET /api/v2/protocols HTTP/1.1
Host: uart.ladishb.com:9010
Accept: application/json
```

**无 query params，无 body**。

### 响应（200 OK）

```json
{
  "protocols": [
    {
      "id": "hanfeng-4g-hf2411",
      "name": "汉枫 4G HF2411",
      "type": "cellular-4g-dtu",
      "manufacturer": "Hanfeng",
      "model": "HF2411",
      "category": "4G/2G/NB DTU",
      "version": "1.0.0",
      "metadata": {
        "note": "跟 UartNode 端 src/dtus/cellular.ts:initialize 1:1 兼容"
      },
      "atCommands": [
        {
          "name": "PID",
          "cmd": "+++AT+PID",
          "parse": "/^\\+ok=(.+)$/",
          "description": "设备型号"
        },
        {
          "name": "VER",
          "cmd": "+++AT+VER",
          "parse": "/^\\+ok=(.+)$/",
          "description": "固件版本"
        }
      ],
      "register": {
        "format": "register&mac=%MAC&host=%HOST",
        "imeiLength": 15,
        "triggerOnInvite": true
      },
      "transport": "tcp:9000"
    },
    {
      "id": "modbus-rtu-default",
      "name": "Modbus RTU RS485 默认",
      "type": "modbus-rtu",
      "category": "工业总线",
      "version": "1.0.0",
      "metadata": {
        "note": "公开标准协议"
      },
      "registers": [
        {
          "address": 0,
          "name": "电压",
          "type": "input",
          "dataType": "uint16",
          "unit": "V",
          "scale": 0.1,
          "description": "电网电压"
        }
      ],
      "defaultSerial": {
        "baudRate": 9600,
        "dataBits": 8,
        "stopBits": 1,
        "parity": "even"
      },
      "transport": "serial"
    }
  ]
}
```

### 错误响应

- **401 Unauthorized**（生产模式启用鉴权时）：`{ "error": "unauthorized", "message": "..." }`
- **500 Internal Server Error**：`{ "error": "internal_error", "message": "..." }`
- **503 Service Unavailable**（协议定义表初始化失败）：`{ "error": "service_unavailable", "message": "..." }`

软 DTU 端**不鉴权**模式下只关心 200 / 5xx（5xx 走 offline fallback）。

## ProtocolDefinition schema 详细

完整 TypeScript 定义在 `packages/soft-dtu/src/protocol/protocol-catalog.ts`，下面是字段表：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 协议唯一 ID（如 `hanfeng-4g-hf2411`），UI 用这个做 key |
| `name` | string | ✅ | 协议显示名（如 `汉枫 4G HF2411`），UI 显示 |
| `type` | enum | ✅ | 协议类型：`cellular-4g-dtu` / `modbus-rtu` / `lan-gateway` / `uart-direct` |
| `manufacturer` | string | ❌ | 厂商名（如 `Hanfeng`）|
| `model` | string | ❌ | 设备型号（如 `HF2411`）|
| `category` | string | ❌ | 分类（如 `4G/2G/NB DTU`）|
| `version` | string | ❌ | 协议定义版本，Phase 2 用于 OTA 更新 |
| `metadata` | object | ❌ | 额外元数据（自由 key-value）|
| `atCommands` | array | ❌ | 4G 协议用，AT 指令列表 |
| `atCommands[].name` | string | ✅ | AT 指令名（如 `PID`）|
| `atCommands[].cmd` | string | ✅ | 完整指令（如 `+++AT+PID`）|
| `atCommands[].parse` | string | ✅ | 响应解析正则字符串（如 `/^\+ok=(.+)$/`）|
| `atCommands[].description` | string | ❌ | UI 显示说明 |
| `registers` | array | ❌ | modbus 协议用，寄存器表 |
| `registers[].address` | number | ✅ | 寄存器地址（0-65535）|
| `registers[].name` | string | ✅ | 寄存器名 |
| `registers[].type` | enum | ✅ | `coil` / `discrete` / `holding` / `input` |
| `registers[].dataType` | enum | ✅ | `uint16` / `int16` / `uint32` / `int32` / `float` / `double` |
| `registers[].unit` | string | ❌ | 显示单位（`V` / `A` / `W` 等）|
| `registers[].scale` | number | ❌ | 换算系数（如 `0.1` 表示原始值 ×0.1 = 真实值）|
| `registers[].description` | string | ❌ | UI 显示说明 |
| `register` | object | ❌ | 4G 注册包定义 |
| `register.format` | string | ✅ | 注册包格式（带 `%MAC` / `%HOST` 占位符）|
| `register.imeiLength` | number | ✅ | IMEI 位数（汉枫 15 位）|
| `register.triggerOnInvite` | boolean | ✅ | 是否在 UartNode 推 +++AT+ 仪式后才发注册包 |
| `defaultSerial` | object | ❌ | modbus 协议用，默认串口参数 |
| `defaultSerial.baudRate` | number | ✅ | 波特率（9600 / 115200 等）|
| `defaultSerial.dataBits` | 5\|6\|7\|8 | ✅ | 数据位 |
| `defaultSerial.stopBits` | 1\|2 | ✅ | 停止位 |
| `defaultSerial.parity` | enum | ✅ | `none` / `even` / `odd` / `mark` / `space` |
| `transport` | enum | ❌ | 传输层：`tcp:9000` / `serial` / `tcp:custom` |

## 初始数据建议

server 端**至少**要内置 2 个协议（跟软 DTU 端 OFFLINE_FALLBACK 对齐）：

1. **`hanfeng-4g-hf2411`**（4G DTU，13 条 AT 指令）
   - 跟 UartNode 端 `src/dtus/cellular.ts:initialize` 8 条核心 AT + 5 条仪式指令 1:1
   - 完整 AT 列表见上方响应示例
2. **`modbus-rtu-default`**（485 设备，4 个示例寄存器）
   - 公开标准协议，软 DTU 离线时也支持

**Phase 2 扩展**（cairui 拍板后落地）：
- `hanfeng-4g-hf2111a` / `hanfeng-4g-hf2611`（其他汉枫型号）
- `lan-gateway-*`（RFC 001 落地后）

## curl 测试用例

### 成功用例

```bash
# 本地 dev
curl -sS --max-time 10 http://127.0.0.1:9010/api/v2/protocols | jq .

# 生产（不鉴权，cairui 2026-07-14 16:35 拍板）
curl -sS --max-time 10 https://uart.ladishb.com:9010/api/v2/protocols | jq .

# 验证 schema
curl -sS --max-time 10 http://127.0.0.1:9010/api/v2/protocols | \
  jq '.protocols | length'                    # 至少 2
curl -sS --max-time 10 http://127.0.0.1:9010/api/v2/protocols | \
  jq '.protocols[] | select(.id == "hanfeng-4g-hf2411") | .atCommands | length'  # 至少 13
```

### 错误用例

```bash
# server 端没启动（5xx）
curl -sS --max-time 5 http://127.0.0.1:9010/api/v2/protocols
# 软 DTU 端会走 offline fallback（modbus RTU only）
```

## 跟现有 midwayuartserver 整合点

### 路由位置

建议放在 `src/controller/api/v2/` 下（**复数** protocols，跟 cairui 之前 `server-errors/list` 教训一致 —— 单数会 404）：

```
src/controller/api/v2/
├── protocols.controller.ts          # 新增
├── protocols.service.ts              # 新增
├── protocols.repository.ts           # 新增（数据库读写）
└── ...
```

### 鉴权（暂不启用）

**Phase 1（不鉴权）**：

```typescript
// protocols.controller.ts
@Controller('/api/v2')
export class ProtocolsController {
  @Get('/protocols')
  async list() {
    return this.protocolsService.findAll();
  }
}
```

**Phase 2（生产鉴权）** —— 加 `@UseGuards(AuthGuard)` 跟 NODE_TOKEN / API Token 走：

```typescript
@Controller('/api/v2')
@UseGuards(AuthGuard)  // Phase 2
export class ProtocolsController {
  @Get('/protocols')
  async list() {
    return this.protocolsService.findAll();
  }
}
```

### 数据库表（如果用 mongo）

```typescript
// protocols.schema.ts
@Schema({ collection: 'protocols', timestamps: true })
export class Protocol {
  @Prop({ required: true, unique: true }) id: string;        // "hanfeng-4g-hf2411"
  @Prop({ required: true }) name: string;                    // "汉枫 4G HF2411"
  @Prop({ required: true, enum: ['cellular-4g-dtu', 'modbus-rtu', 'lan-gateway', 'uart-direct'] })
  type: string;
  @Prop() manufacturer?: string;
  @Prop() model?: string;
  @Prop() category?: string;
  @Prop({ default: '1.0.0' }) version?: string;
  @Prop({ type: Object }) metadata?: Record<string, any>;
  @Prop({ type: [Object] }) atCommands?: AtCommand[];
  @Prop({ type: [Object] }) registers?: Register[];
  @Prop({ type: Object }) register?: RegisterDefinition;
  @Prop({ type: Object }) defaultSerial?: SerialOptions;
  @Prop({ enum: ['tcp:9000', 'serial', 'tcp:custom'] }) transport?: string;
}
```

**TTL 注意**（user memory 那条 staging 7d+ sweep 教训）：**别加 `@Prop({ expires: N })` TTL 字段**，协议定义要持久。

### 初始数据 seed

建表时 seed 2 个内置协议（hanfeng + modbus），用 migration 脚本：

```typescript
// seed-protocols.ts
const PROTOCOLS = [
  HANFENG_HF2411,
  MODBUS_RTU_DEFAULT,
];
```

## 软 DTU 端处理

软 DTU 端**已经写好** HTTP client（`packages/soft-dtu/src/protocol/protocol-catalog.ts:ProtocolRepository`）：

- 启动时 fire-and-forget 拉一次
- 5min 缓存（避免每个 UI 操作都打 server）
- 防并发 fetch（多个 UI 组件同时调 `list()` 只触发一次）
- schema 校验（缺 `id/name/type` 字段直接抛错，不用脏数据）
- 离线 fallback：server 不可达时用本地 `OFFLINE_FALLBACK`（modbus RTU only）

**字段名 / 必填项 必 1:1 跟上面 schema 对齐** —— 错位会**静默失败**（HTTP 拉不到 schema 校验 → 走 offline fallback → UI 显示协议少）。

## 软 DTU 端使用方式

UI 用这个端点做：
1. **协议列表浏览器**（select 框："汉枫 4G HF2411" / "Modbus RTU" 等，让用户手动选）
2. **AT 指令自动补全面板**（按 PID/VER 推荐 AT 序列）
3. **串口参数预设**（XCOM 115200/8/N/1, Modbus RTU 9600/8/N/1 等）

软 DTU 的数据通道跟普通硬件 DTU **完全对等**（TCP 9000 + 4G 协议，UartNode 代理上行到 server），server 端不感知"软 DTU"。

## 跨项目 reference

- 软 DTU 仓库：`/Users/cairui/Code/uart-node/packages/soft-dtu/`
- 软 DTU AGENTS.md：`/Users/cairui/Code/uart-node/packages/soft-dtu/AGENTS.md`
- UartNode 端 4G 协议契约：`/Users/cairui/Code/uart-node/src/dtus/cellular.ts`
- UartNode 端 4G 注册包解析：`/Users/cairui/Code/uart-node/src/server/register-handler.ts`
- 软 DTU 端 HTTP client：`/Users/cairui/Code/uart-node/packages/soft-dtu/src/protocol/protocol-catalog.ts`
- 软 DTU agent：`agent-a1afa567aa0d`（session `mvs_ee8e2927968b4aa6b51e7b5fc03442b8`）
- 软 DTU 端 type：完整 schema 跟上面表 1:1

## 实施 checklist

- [ ] `src/controller/api/v2/protocols.controller.ts` 新增
- [ ] `src/controller/api/v2/protocols.service.ts` 新增
- [ ] `src/controller/api/v2/protocols.repository.ts` 新增
- [ ] `src/schema/protocols.schema.ts` 新增（mongo schema）
- [ ] 初始 seed 2 个协议（hanfeng-4g-hf2411 + modbus-rtu-default）
- [ ] 不鉴权（Phase 1，cairui 拍板）
- [ ] curl 测试 200 + schema 校验
- [ ] commit（仓库 `wgcairui/midwayuartserver`）
- [ ] **通知软 DTU agent**（`agent-a1afa567aa0d`）：在 commit message 里 `@soft-dtu` 引用 / 跨项目 changelog

## 拍板前后注意点

**ping 软 DTU agent（agent-a1afa567aa0d）** —— 软 DTU 端 `ProtocolRepository.fetchFromServer` 的 schema 校验是**硬约束**：
- 缺 `id/name/type` 字段 → 抛错
- 字段类型不对 → 抛错
- `protocols` 不是 array → 抛错

server 端**必须**保证响应 schema 1:1 兼容上面表格的字段名和类型。**错位会**：
1. 软 DTU 端 schema 校验抛错
2. 走 offline fallback（modbus RTU only）
3. UI 显示协议少，cairui 发现 "为啥只有 modbus RTU？"

按 user memory "跨 worker 字段名约定" 那条 —— **拍板落地前必 ping sibling**。如果 server 端 schema 跟上面表格不一致，**先跟软 DTU agent 同步**（通过 mavis cron 任务 / sibling 互相发任务）。
