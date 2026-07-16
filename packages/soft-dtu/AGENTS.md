# AGENTS.md — 软 DTU (`@uart-node/soft-dtu`)

> 项目专属 agent 记忆。**只写读代码 / README 发现不了的事**。每条都问：
> "如果删掉，下次 agent 会重蹈覆辙吗？" — 答否就删。

## 跟 server 端的关系：HTTP API 拉协议（不鉴权，不连 Socket.IO）

**Cairui 2026-07-14 16:29 + 16:35 拍板**：
- 软 DTU 走 **HTTP API** `GET /api/v2/protocols` 从 server 拉协议定义
- **HTTP API 不鉴权**（dev/内网，生产要加 Bearer token，保留 `apiToken` 字段兼容未来）
- **不连 Socket.IO**（`src/transport/socketio.ts` 整个废弃，commit 时自动 git rm）
- 数据通道跟普通硬件 DTU 一样（TCP 9000 + 4G 协议），UartNode 代理上行到 server
- **协议让用户手动选**（UI 启动不预选，Cairui 2026-07-14 16:35 拍板）
- server 端**必须加** `GET /api/v2/protocols` 端点 —— **必 ping `agent-ae682922673b`**

**为什么走 HTTP 不走 Socket.IO**：
- HTTP API 简单，curl 就能调
- 协议定义是低频操作（启动拉一次 + 5min 缓存），不需要 Socket.IO 的长连接
- HTTP 端点容易鉴权（Bearer token），生产好扩展

**协议定义响应 schema**（server 端必须 1:1 兼容）：

```ts
interface ProtocolDefinition {
  id: string;            // "hanfeng-4g-hf2411"
  name: string;          // "汉枫 4G HF2411"
  type: "cellular-4g-dtu" | "modbus-rtu" | "lan-gateway" | "uart-direct";
  manufacturer?: string;
  model?: string;
  version?: string;      // 协议定义版本，Phase 2 加
  atCommands?: AtCommandDefinition[];  // 4G 协议用
  registers?: RegisterDef[];            // modbus 用
  register?: RegisterDefinition;        // 4G 注册包定义
  defaultSerial?: SerialOptions;        // 485 串口参数
  transport?: "tcp:9000" | "serial" | "tcp:custom";
}
```

**离线 fallback**（server 不可达时）：
- 只放 modbus RTU（公开标准）
- 不放汉枫 4G（专有协议，hardcode 可能跟 server 不一致）

> ⚠️ **不要私自起新 server 端表 / 改 schema**：user memory "跨 worker 字段名约定" 那条——拍板落地前必 ping sibling，错位会**静默失败**（HTTP 拉不到 → 走 offline fallback → UI 显示协议少）。

## 协议边界（device.protocols vs soft_dtu.protocols）

uart-server（sibling agent `agent-ae682922673b`）跟软 DTU 端**完全两个独立 collection**，不要混淆。

| 维度 | `device.protocols` (existing) | `soft_dtu.protocols` (new) |
|---|---|---|
| **总数 (2026-07-16)** | 30 条 | 2 条 |
| **Type / type** | `485`(19) / `232`(11) | `cellular-4g-dtu` / `modbus-rtu` |
| **ProtocolType / type** | `ups`(16) / `air`(8) / `em`(2) / `th`(2) / `io`(2) | (按 DTU 传输层分类, 不按设备品类) |
| **业务定位** | DTU 后面的 485/232 设备 modbus 指令表 | 软 DTU 自身传输层协议目录 |
| **AI 协议生成器** | ✅ admin web `/admin/ai` LLM 生成 (决策 16/19/20) | ❌ server seed 静态 + 软 DTU 端 schema 校验 |
| **instruct 字段** | ✅ modbus 寄存器读/写 hex (0300000002) | ❌ 用 atCommands[] + registers[] |
| **AT 指令** | ❌ 不存 | ✅ hanfeng-4g-hf2411.atCommands[13] |
| **source** | `admin` / `ai-generate` / `ai-chat` | `bootstrap` (built-in seed) |
| **典型条目** | `温湿度1` / `卡乐控制器` / `ZL-U09D2` / `HW-UPS5000` | `汉枫 4G HF2411` / `Modbus RTU RS485 默认` |

**两者正交, 不存在 1:1 映射**:
- `device.protocols.ProtocolType` 描述"485/232 总线下挂的设备品类"（UPS / 空调 / 电力监测 / 温湿度 / 开关量）
- `soft_dtu.protocols.type` 描述"软 DTU 自身传输层"（4G / modbus）
- 一个 4G cellular-4g-dtu 软 DTU 后面可以挂 1 个 ups 设备 + 1 个 th 设备（叠加关系）

**WebView 截图里看到的 "13 条 AT 指令"**（`+++AT+PID` 等）**存 `soft_dtu.protocols.atCommands[]`, 跟 `device.protocols.instruct[]` 完全无关**. 后者是 modbus 寄存器指令 hex (0300000002), 不是 AT 指令.

**加新协议分工**:

| 任务 | 改 collection | 改 uart-server 端 | 改软 DTU 端 |
|---|---|---|---|
| 加新 4G DTU 品牌 (非汉枫) | `soft_dtu.protocols` | `src/module/soft-dtu/dto/built-in-protocols.ts` 加 seed | `src/dtus/cellular.ts` 加分支适配 |
| 加新 485/232 设备 | `device.protocols` | admin web `/admin/ai` 或手填 | (不涉及) |
| 改 AT 指令格式 (汉枫 4G) | `soft_dtu.protocols.atCommands[]` | `built-in-protocols.ts` 同步 | `src/dtus/cellular.ts` 同步 |
| 改 modbus 寄存器表 (modbus-rtu-default 那种) | `soft_dtu.protocols.registers[]` | `built-in-protocols.ts` 同步 | (用 server 拉的) |

**改协议 schema 必 ping sibling agent**（`agent-ae682922673b`):
- uart-server 拥有 `device.protocols` + `soft_dtu.protocols` 两个 collection 的定义权
- 软 DTU 是实现层, 改字段名 / 加新字段 → 必 ping sibling 拍板
- 错位会**静默失败**（HTTP 拉不到 → 走 offline fallback → UI 只显示 modbus RTU, 用户以为 bug 实际是协议目录不全）
- 这条跟 user memory "跨 worker 字段名约定" 强化绑定

## 跟 UartNode 4G 协议契约（行为 1:1 兼容）

- 软 DTU 是 device，UartNode 是 server —— 软 DTU 主动 connect `UartNode:9000`
- 注册包格式：`register&mac=<IMEI>&host=<hostname>&softdtu=1\r\n`
  - `&softdtu=1` 标记是软 DTU（UartNode 端**不感知**，只当普通 DTU 处理）
  - IMEI 15 位，UartNode `slice(-12)` 当 mac 主键
- 8 条 AT 响应（跟 `src/dtus/cellular.ts:queryAT` 1:1）：
  - `+++AT+PID` → `+ok=HF2411`
  - `+++AT+VER` → `+ok=V3.0.0`
  - `+++AT+GVER` → `+ok=G4`
  - `+++AT+IOTEN` → `+ok=on`
  - `+++AT+ICCID` → `+ok=89860117851000012345`
  - `+++AT+LOCATE=1` → `+ok=31.2049,121.5986`（dev 坐标，cairui 办公室）
  - `+++AT+UART=1` → `+ok=115200,8,N,1`
  - `+++AT+GSLQ` → `+ok=20`
- 特殊指令：
  - `+++AT+IOTEN=off` → `+ok=`（UartNode 关流量，软 DTU 模拟 ack 不真做）
  - `+++AT+Z` → `+ok=`（硬重启，UartNode 走 60s 重连路径，软 DTU 不真重启）
  - `+++AT+NREGEN/NREGDT/IOTUID` → `+ok=\r\n`（UartNode 推的仪式，冗余但要 ack）
  - 未知指令 → `+err=unknown command: <cmd>`

完整汉枫 AT 指令集定义见 UartNode 端 `src/dtus/cellular.ts`（软 DTU 跟它 1:1 镜像响应）。

## 跨项目 reference

- **跟 UartNode 4G 协议契约**：完全兼容，UartNode 不知道软 DTU 是真的还是假的
- **跟 `uart-pesiv-node` 完全独立**：不共享配置 / socket.io 封装
- **跟 `uart-server` 通过 HTTP API（不鉴权）**：server 端 1 个端点（GET /api/v2/protocols），必须 ping sibling

## 部署约束

- **本机 macOS**（cairuimacbook-pro）：CH340/CP2102/FT232 驱动 macOS 13+ 内置
- **USB 转 485 设备**：插上后 `/dev/tty.usbserial-*` 自动出现
- **不要硬编码串口路径**：用 `SerialTransport.list()` 动态拿
- **不要硬编码 IMEI**：用 env / `~/.config/soft-dtu/config.json` 覆盖默认虚拟 IMEI
- **485 设备最常见是 Modbus RTU**：Phase 1 不实现，Phase 2 加 `npm:modbus-serial`
- **不要在软 DTU 端 hardcode 汉枫 4G 协议定义**：跟 server 拉的协议不一致会出 bug，UI 显示协议 A 但 server 实际支持 B
- **不要加 `defaultProtocolId` 配置项**：UI 启动不预选协议，用户手动选

## Runtime 风险

- **Deno Desktop 还在 canary**（Deno 2.9 2026-06-25 发）：bindings API 可能变
  - Phase 1 stub 用 globalThis + HTTP fetch（main.ts 启 deno serve，webview fetch）
  - Phase 2 切 Deno Desktop official bindings SDK
- **macOS 上 npm:serialport 兼容性**：未实测（user memory 里 cairui 装过 Bun 但没装 Deno），装 Deno 时先 `deno --version` 验证
- **github 直连失败**（user memory 2026-07-14 那条）：Deno / npm 下载可能受影响，先走代理
- **server 端 API 不可达**：软 DTU 走 offline fallback（modbus RTU only），UI 显示警告"协议目录是离线模式"

## 测试

- **还没有 test**。`deno test` 装上了但 0 个 spec（跟 UartNode PR #12 之前一样）
- Phase 2 落地时加：
  - `src/protocol/at-handler.test.ts`（8 条 AT 响应单元测试）
  - `src/protocol/protocol-catalog.test.ts`（HTTP fetch + 缓存 + offline fallback 流程）
  - `src/transport/tcp.test.ts`（TCP client mock UartNode 行为）
  - `src/transport/serial.test.ts`（串口读写，需要真硬件或 mock）
- **不要凭空加 jest / vitest 配置** —— Deno 内置 `deno test`，加之前先问 cairui

## 已废弃代码

- **`src/transport/socketio.ts`** —— 软 DTU 走 HTTP API 不连 Socket.IO（Cairui 2026-07-14 16:29 拍板）
  - 保留 deprecated stub 是为了让 commit 脚本自动 git rm（不交互）
  - **新 session 跑 commit 脚本时脚本会处理**，不要手动 git rm
  - 不要"修复"或"复活"这个文件
- **本地 hardcode 汉枫 4G 协议定义** —— 不要做这个！协议定义要从 server 拉，跟硬件 DTU 固件等价物保持单一信息源
- **`defaultProtocolId` 配置项** —— 已删除（Cairui 2026-07-14 16:35 拍板），不要加回来

## WebView 双进程 dev 工作流（Phase 1）

**软 DTU 后端 + Vite dev server 是两个独立进程**，跟 UartNode 主项目是同一套思路。

```bash
# 终端 1：Deno runtime 启 HTTP API on 8080
cd packages/soft-dtu
deno task dev

# 终端 2：Vite dev server on 5173，proxy /api → 8080
cd packages/soft-dtu
deno task webview:install   # 第一次
deno task webview:dev
```

浏览器开 `http://127.0.0.1:5173`。

**HTTP API 端点**（`src/server/http-api.ts`，**Phase 1 stub**）：

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/serial/list` | 列本机串口 |
| POST | `/api/serial/open` | `{ path, options }` |
| POST | `/api/serial/close` | 关串口 |
| POST | `/api/serial/write` | `{ data: string \| base64 }` |
| GET | `/api/serial/status` | `{ isOpen, currentPort }` |
| GET | `/api/serial/stream?channel=data\|error\|close` | SSE 事件流 |
| GET | `/api/protocols` | `{ protocols: ProtocolDefinition[] }` |
| GET | `/api/protocols/refresh` | 强制刷新（忽略 5min 缓存）|
| GET | `/api/health` | health check |

**Phase 2 切 Deno Desktop official bindings SDK**：
- `webview/src/api.ts` 改用 `window.bindings.*` 替代 fetch
- `src/server/http-api.ts` 整个文件可以删
- `deno desktop .` 启动原生窗口（macOS / Windows / Linux），bundle 内嵌 `webview/dist`

**WebView 类型契约 1:1 跟 Deno 端对齐**（`webview/src/bindings.ts` ↔ `src/bindings/{serial,protocol}.ts`）：
- 改字段名 / 加新字段 → **必 ping sibling 拍板**（user memory "跨 worker 字段名约定"）
- 错位会**静默失败**（HTTP 拉不到 → fallback 走错 → UI 行为异常）

## 仓库知识库

- 复杂资料（协议速查、调试指南、跟 server 端对接）放 `.harness/docs/`
- 起步走 `.harness/docs/INDEX.md`（待写）
- 改 4G 协议契约（`src/protocol/*`）之前**先读** UartNode 端 `src/dtus/cellular.ts` + `src/server/register-handler.ts`（行为 1:1 兼容，不能破坏）
- 改 HTTP API 拉协议（`src/protocol/protocol-catalog.ts`）之前**必读** server 端协议定义表 schema（等 `agent-ae682922673b` 拍板后写 `.harness/docs/server-alignment.md`）
