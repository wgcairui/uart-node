# RFC 001: LAN 网关支持（HF5111 / EE1X / PE1X / Eport）

| 字段 | 值 |
|---|---|
| **状态** | **draft**（等 cairui 拍板） |
| **作者** | agent-a1afa567aa0d (uart-node) |
| **日期** | 2026-06-15 |
| **目标版本** | UartNode v4.0.0 |
| **前置文档** | [`../protocols/cellular-4g-dtu.md`](../protocols/cellular-4g-dtu.md) / [`../protocols/lan-gateway.md`](../protocols/lan-gateway.md) |

## 0. 摘要

UartNode 当前架构 100% 面向汉枫 4G/2G/NB DTU（`TcpServer.ts` 推 `+++AT+` 仪式 + `URLSearchParams` 解析注册包）。
本文提**抽 IProtocolAdapter 接口 + 新增 LanGatewayAdapter** 方案，让 UartNode 同时支持：

- **拓扑 A**：LAN 设备当 TCP Server（默认 8899），UartNode 当 TCP Client
- **拓扑 B**：LAN 设备当 TCP Client 来连 UartNode

拓扑 C（MQTT/HTTP）放二期。

## 1. 目标 / 非目标

### 目标

1. UartNode 能接入 HF5111 / HF5111S / HF5122 / EE1X / PE1X / Eport-E10/20/30 等 LAN 网关
2. **不破坏**现有 4G/2G/NB DTU 接入路径
3. 一个 UartNode 进程**同时**接 4G 设备和 LAN 设备
4. LAN 设备的 deviceId 上报到 server 用 **MAC 地址**（跟 4G 的 IMEI 区分命名空间）

### 非目标（二期）

- MQTT / HTTP / WebSocket 客户端
- LAN 设备的 `+++\r` CLI 模式（**不在数据通道上**推）
- LAN 设备的固件升级（走汉枫 IotMaster / Web）
- TLS / AES 加密透传

## 2. 设计原则

1. **不破坏 4G 路径**——adapter 模式下，老 4G DTU 行为 1:1 不变
2. **协议嗅探放在 socket 层**——`TcpServer.connection` 第一个包就分派
3. **mac 命名空间分桶**——4G 用 `imei:<后 12>` 前缀，LAN 用 `mac:<12 字符>` 前缀，**0 碰撞**
4. **基础设施层不动**——`IO.ts` / `fetch.ts` / `Cache.ts` / `socket.ts` / `config.ts` / `main.ts` 不动
5. **client.ts 拆 BaseClient + CellularClient + LanClient**——具体方法下放到 adapter

## 3. 架构总览

```
                                  ┌──────────────────────┐
   [4G DTU] ──── TCP ────────────►│  TcpServer :9000     │
                                  │  protocol-sniffer    │──► CellularAdapter (现有)
                                  │  (第一个包特征)        │      ↓
                                  │                      │   CellularClient
                                  └──────────────────────┘
                                                      
   [LAN Device] ──── TCP ───┐                          
                            ├──► sniff → LanAdapter  
   [LAN Device :8899] ◄───►  │                          
       (UartNode Client)    │  ┌──────────────────────┐
                            └──┤  LanOutbound (新)     │
                               │  net.connect(<lan-ip>)│
                               │  per-device 出站连接   │
                               └──────────────────────┘
                                          ↓
                                       LanClient
```

## 4. IProtocolAdapter 接口设计（**草案**）

```typescript
// src/adapters/types.ts (新)

export interface ProtocolContext {
  socket: net.Socket
  mac: string                  // 已归一化（带前缀 'imei:' 或 'mac:'）
  rawIdentifier: string        // 原始 IMEI 后 12 位 / MAC
  adapterType: 'cellular' | 'lan'
  remoteAddress: string
  remotePort: number
  registerArgs?: URLSearchParams  // 仅 cellular 有
  preRegisterInfo?: PreRegisterInfo  // 仅 lan 有
}

export interface PreRegisterInfo {
  // UartNode 启动时从 uart-server 拉的预注册白名单
  deviceId: string
  expectedMac: string
  topology: 'lan_tcp_client' | 'lan_tcp_server'
  lanAddress?: { host: string; port: number }  // 拓扑 A 用
  serialParams?: { baudRate: number; dataBits: number; ... }
}

export interface IProtocolAdapter {
  /** 在 _Connection 里决定要不要接管这个 socket */
  sniff(firstPacket: Buffer, socket: net.Socket): boolean | Promise<boolean>

  /** 接管后建 Client 包装 */
  buildClient(ctx: ProtocolContext, registerArgs?: URLSearchParams): BaseClient

  /** 是否需要 server 主动推 10s AT 仪式（仅 cellular 是 true）*/
  needsHandshakePush(): boolean

  /** 握手完成后的回调（cellular 是收到注册包；lan 是预注册表校验通过）*/
  onHandshake(ctx: ProtocolContext): Promise<void>
}
```

## 5. CellularAdapter（**封装现有行为**）

```typescript
// src/adapters/cellular.ts (新)
export class CellularAdapter implements IProtocolAdapter {
  sniff(firstPacket: Buffer): boolean {
    // sniff 规则: 包以 'register&' 开头
    return firstPacket.toString('utf-8', 0, 9).startsWith('register&')
  }

  needsHandshakePush() { return true }

  buildClient(ctx: ProtocolContext, registerArgs: URLSearchParams) {
    // 完全复刻 TcpServer.ts:106 现有逻辑
    return new CellularClient(ctx.socket, ctx.mac, registerArgs)
  }
}
```

**注意**：现有 10s 推 AT 仪式在 CellularAdapter 内部完成，**TcpServer 的连接入口**只
做 sniff 转发。

## 6. LanAdapter（**新设计**）

### 6.1 sniff 规则

LAN 设备**不会主动发注册包**，所以 sniff 规则是**反过来的**：

```typescript
// src/adapters/lan.ts (新)
export class LanAdapter implements IProtocolAdapter {
  sniff(firstPacket: Buffer): boolean {
    // 不以 'register&' 开头 + 不是 +ok 响应 → 当 LAN
    // （注意：必须保证 cellular sniff 的规则互斥）
    const head = firstPacket.toString('utf-8', 0, 16)
    return !head.startsWith('register&') && !head.startsWith('+ok=')
  }
}
```

**但 LAN 设备如果当 TCP Client 主动来连 UartNode**：sniff 看到的第一个包是 UART
透传数据，特征**完全无法跟 4G 区分**。两种处理思路：

- **方案 X**：双端口隔离（`9000` 走 4G 兼容、`9001` 走 LAN TCP Client）
- **方案 Y**：靠**预注册表 + 主动查询**——UartNode 启动时拉白名单，收到任意连接时
  按 `socket.remoteAddress` 查白名单匹配哪个预注册 device

**推荐方案 Y**（更通用），详见 §7。

### 6.2 注册机制 —— **白名单查表**

UartNode 启动时（或 server 推送）拉一份预注册表：

```typescript
// src/adapters/registered-devices.ts (新)
interface RegisteredDevice {
  deviceId: string              // server 侧 deviceId
  type: 'cellular' | 'lan'
  identifier: string            // 4G: IMEI 后 12; LAN: MAC 12
  topology?: 'lan_tcp_client' | 'lan_tcp_server'  // 仅 LAN
  lanAddress?: { host: string; port: number }     // 仅拓扑 A
  serialParams?: { ... }
  createdAt: number
  lastSeenAt?: number
}
```

`RegisteredDevices` 模块从 uart-server 拉白名单（HTTP 接口，PR #20 鉴权）。

### 6.3 标识命名空间

为了**避免 LAN MAC `98D863xxxxxx` 跟某 4G IMEI 后 12 位碰撞**：

```typescript
// 统一用带前缀的 mac key
const macKey4G = `imei:${IMEI.slice(-12)}`   // "imei:98D863CC870D"
const macKeyLAN = `mac:${mac.toUpperCase()}` // "mac:98D863000002"
```

`MacSocketMaps: Map<string, Client>` 用**带前缀的 key**，**0 碰撞**。

### 6.4 Client 类

```typescript
// src/adapters/lan.ts
export class LanClient extends BaseClient {
  // 跟 CellularClient 的差异:
  // - run() 不批量查 AT 指令，改为通过 HTTP API 拉 LAN 设备参数
  //   (HF5111 的 Web API 文档在《物联设备系列产品软件功能》里, 还需查)
  // - QueryAT() 改为走 CLI 协议: send '+++', 收 'a', 发 'a', 进 EPORT>, 发 AT
  //   **或者**直接走 HTTP API: GET /system_info
  // - resatrtSocket() 改走 HTTP API 或 web POST /reboot
}
```

**HTTP API 优先**——CLI `+++` 太脆弱，HTTP 是标准做法。但汉枫 Web API 的具体
endpoint **还没确认**（需要查《物联设备系列产品软件功能》那份文档）。

### 6.5 拓扑分发

```typescript
// src/TcpServer.ts (重构后)

class TcpServer extends net.Server {
  private cellular: CellularAdapter
  private lan: LanAdapter
  private registeredDevices: RegisteredDevices
  private lanOutbound: LanOutbound        // 拓扑 A: UartNode 当 Client

  on('connection', socket => {
    socket.once('data', async (firstPacket) => {
      const ctx: ProtocolContext = { ... }

      if (this.cellular.sniff(firstPacket)) {
        return this.cellular.handle(ctx, firstPacket)
      }

      // LAN 路径:
      // 1. 拓扑 A: UartNode 是 Client, 不应该收到入站 (除非 LAN 设备主动来, 用拓扑 B 路径)
      // 2. 拓扑 B: LAN 设备当 Client 来连, 走预注册白名单校验
      const match = this.registeredDevices.findByRemoteAddr(socket.remoteAddress)
      if (!match) return socket.destroy()
      return this.lan.handle(ctx, match)
    })
  })

  // 启动时:
  async start() {
    await this.registeredDevices.load()
    // 拓扑 A: 给每个预注册的 LAN 设备建出站连接
    for (const dev of this.registeredDevices.lanServerMode()) {
      this.lanOutbound.connect(dev)
    }
  }
}
```

**`LanOutbound`**（拓扑 A 的关键）：

```typescript
// src/adapters/lan-outbound.ts (新)
class LanOutbound {
  // 给每台 LAN 设备 (设备当 Server 模式) 起一条出站 net.connect
  connect(device: RegisteredDevice) {
    const socket = net.connect(device.lanAddress!.port, device.lanAddress!.host)
    // ... setTimeout/setKeepAlive 跟 socketsb 一样
    // 第一个包发 'identify <mac>\r' (待定 RFC §9)
    // 或者: 预注册表里直接绑定 mac, 不需要 identify
  }
}
```

## 7. 协议嗅探的具体规则（**待拍板**）

| 选项 | 描述 | 推荐度 |
|---|---|---|
| **A. 第一个包特征** | 4G 第一个包是 `register&...`；LAN 第一个包是裸数据 / JSON | ⭐⭐ 简单但**有歧义**（LAN 设备当 Client 来连时第一个包就是 UART 透传） |
| **B. 双端口** | 9000 = 4G 兼容 / 9001 = LAN TCP Client | ⭐⭐ 简单清晰，**运维要改端口** |
| **C. 预注册表 + 远端地址** | UartNode 启动拉白名单，连接时按 `remoteAddress` 匹配 | ⭐⭐⭐ 通用，**支持所有拓扑** |
| **D. 设备类型主动声明** | LAN 设备发个 `HF5111` 之类的型号字符串首包 | ❌ LAN 设备不会发 |

**推荐 A + C 组合**：
- 入站 TCP：第一个包是 `register&` → Cellular
- 入站 TCP：第一个包是别的 + `remoteAddress` 在白名单 → LAN TCP Client
- 出站 TCP（UartNode 主动连 LAN）→ 一定是 LAN TCP Server

## 8. 配置变更

```typescript
// config.ts 新增
export const LAN_TOPOLOGY = process.env.LAN_TOPOLOGY ?? 'disabled'
// 'disabled' | 'lan_tcp_client' | 'lan_tcp_server' | 'both'

export const LAN_KNOWN_DEVICES_URL =
  process.env.LAN_KNOWN_DEVICES_URL ?? ''
// 预注册表拉取地址（指向 uart-server 的 /api/node/lan-devices）
```

`AGENTS.md` 里已经强调过：**`NODE_TOKEN` 不能进 Dockerfile**——`LAN_TOPOLOGY` /
`LAN_KNOWN_DEVICES_URL` 同理**只走 env**。

## 9. 待补 / 未决项（**RFC 拍板前要回答**）

1. ❓ **LAN 设备的 HTTP API 文档**——需要从汉枫官网下载《物联设备系列产品软件功能》，
   拿到 `/system_info` / `/reboot` 等 endpoint。**这个查不到 LanClient 没法写**
2. ❓ **预注册表从 uart-server 哪个接口拉**——需要跟 server 端 agent 对齐（PR 依赖）
3. ❓ **`Client` 类拆 Base + Cellular + Lan 的具体方法下放表**——4G 那 8 个 AT 查询哪些保留、哪些删
4. ❓ **拓扑 C（MQTT/HTTP）要不要进一期**——产品/客户需求决定
5. ❓ **mac 命名空间前缀（`imei:` / `mac:`）跟 server 端 deviceId 怎么映射**——server 端要同步改造

## 10. 替代方案（**没选**的）

### 10.1 一进程两端口（不选）

- 启 `TcpServer` 9000 走 4G，启 `TcpServer` 9001 走 LAN
- 简单，但 MacSocketMaps 跨端口要共享，server 端要加 deviceId-port 映射
- 拓扑 A 出站连接没法挂到 TcpServer 上

### 10.2 拆 uart-node-cellular / uart-node-lan 两个独立进程（不选）

- cairui 明确说"UartNode 同时支持 4G 和 LAN"，**一个进程**是需求
- 拆进程会让 uart-server 那边管理面变复杂（要管两套 nodeToken / 设备表）

## 11. 风险与回退

| 风险 | 影响 | 回退 |
|---|---|---|
| CellularAdapter 行为 1:1 复刻失败 | 4G 设备掉线 | RFC 落地后必须**24h+ 真机回归**（AGENTS.md 强约束）|
| mac 命名空间不兼容老 server | 4G 设备 deviceId 找不到 | 老数据用 `imei:` 前缀做迁移，server 端同步更新 |
| LanClient HTTP API 拿不到 | LAN 设备参数缺失 | 降级到 CLI 协议或留空 |
| 拓扑 A 出站 net.connect 阻塞 | 进程级卡住 | 异步 connect + 超时重试 + 错误日志 |

## 12. 实施步骤（**草案**）

| Step | 内容 | 估时 | 验证 |
|---|---|---|---|
| 1 | 新建 `RegisteredDevices` 模块 + uart-server 拉白名单接口 | 2h | 单测：拉白名单正常 / 401 / 网络失败 |
| 2 | 抽 `IProtocolAdapter` 接口 + CellularAdapter 封装现有行为 | 4h | **staging 24h+ 真机回归**（4G HF2411 + 2G HF2111A + NB HF2611）|
| 3 | TcpServer 加 sniff 入口，预注册表查 remoteAddress | 2h | 4G 路径 1:1 行为不变 |
| 4 | LanOutbound 拓扑 A 出站连接 | 2h | staging 24h+ 真机（HF5111 当 Server）|
| 5 | LanClient（先走 HTTP API 查参数）| 4h | 真机过 |
| 6 | CLI 协议降级路径（HTTP API 拿不到时 fallback）| 2h | 真机过 |
| 7 | docs 更新（source-map / protocol / workflow）| 2h | 文档 review |

**总计估时 ~18h**（不含 24h 回归观察时间）。

## 13. 决策记录

- **2026-06-15** — 草案创建，cairui 拍板中
