# 软 DTU (`@uart-node/soft-dtu`)

UartNode 的**软 DTU 客户端**（Deno Desktop 应用）。

## 它是什么

**软 DTU = 伪装成汉枫 4G 硬件 DTU 的 USB 转 485 串口调试工具**

跟普通硬件 DTU 的关系（Cairui 2026-07-14 16:29 + 16:35 拍板）：

| 通道 | 软 DTU 走法 | 硬件 DTU 走法 |
|---|---|---|
| **数据通道** | TCP 9000 + 4G 协议（跟硬件 DTU 一样）| TCP 9000 + 4G 协议 |
| **元数据通道** | HTTP API `GET /api/v2/protocols` 拉协议定义 | 固件内固化（无通道）|

软 DTU 的核心价值：**协议可热更新，不用刷固件**。

```
┌──────────────────────────────────────────────────────────────┐
│ 软 DTU (Deno Desktop)                                        │
│ ┌──────────────────────┐   bindings   ┌────────────────────┐ │
│ │ WebView 前端 (Preact) │◄────────────►│  Deno runtime 后端 │ │
│ │  - 串口参数配置      │               │  - 串口 (serialport)│ │
│ │  - HEX/ASCII 切换    │               │  - TCP 9000 客户端 │ │
│ │  - AT 指令面板       │               │  - 4G 协议模拟      │ │
│ │  - 协议定义浏览器    │               │  - HTTP 协议拉取    │ │
│ │    (用户手动选)      │               │                    │ │
│ └──────────────────────┘               └────────────────────┘ │
└────────────────┬────────────────────┬──────────────┬─────────┘
                 │ TCP 9000           │ HTTP API     │ 串口 (RS485)
                 │ (伪装 4G 协议)     │ (拉协议,    │
                 │                    │  不鉴权)    │
                 │                    │
                 ▼                    ▼              ▼
         ┌──────────────┐    ┌──────────────┐  ┌──────────┐
         │  UartNode    │    │ uart-server  │  │ 485 设备 │
         │  (Bun)       │    │  (midway)    │  │ 现场     │
         │  0 改动      │    │  待加 API    │  │          │
         └──────┬───────┘    └──────────────┘  └──────────┘
                │ Socket.IO
                ▼
         ┌──────────────┐
         │ (server 端    │
         │ 继续收到 DTU  │
         │  数据，不知道  │
         │ 是软是硬)     │
         └──────────────┘
```

## 关键能力

1. **伪装 4G DTU** —— 软 DTU 走 TCP 9000 + 注册包 + `+++AT+` 协议，UartNode 不知道它是软的，0 改动
2. **串口调试工具** —— 跟 XCOM / sscom 兼容，配置 baudRate / dataBits / stopBits / parity
3. **协议可热更新** —— 走 HTTP API 从 server 拉协议定义，加新协议不动软 DTU
4. **协议让用户手动选** —— UI 启动不预选，避免猜错协议类型（4G / modbus / LAN 等）
5. **离线 fallback** —— server 不可达时用本地 stub（modbus RTU 公开标准）
6. **HTTP API 不鉴权**（dev/内网，生产要加 Bearer token）

## 跟 server 端对接（待 ping agent-ae682922673b）

server 端 (`midwayuartserver`, `agent-ae682922673b` 管) 需要加：

1. **REST 端点 `GET /api/v2/protocols`**（**必加**）：
   - 鉴权：**不鉴权**（Cairui 2026-07-14 16:35 拍板，dev/内网）
   - 响应 schema：`{ protocols: ProtocolDefinition[] }`
   - 协议定义见 `src/protocol/protocol-catalog.ts:ProtocolDefinition`

2. **不连 Socket.IO**（Cairui 2026-07-14 16:29 拍板）：
   - `src/transport/socketio.ts` 整个文件**已废弃**（commit 时自动 git rm）
   - 不需要 namespace 放行 / 握手鉴权

## 部署

本地电脑：cairuimacbook-pro
- macOS 13+ 内置 CH340/CH343/CH9102/CP210x/FTDI 驱动
- 旧版需要装 WCH 驱动：https://www.wch-ic.com/downloads/CH341SER_MAC_V1.7.html
- USB 转 485 设备插上后 `/dev/tty.usbserial-*` 自动出现

## 命令

```bash
cd packages/soft-dtu

# 安装 Deno 2.9 canary（首次）
deno upgrade canary

# === Deno 后端（软 DTU runtime）===
# dev 模式（watch + hot reload，启 HTTP API on 127.0.0.1:8080）
deno task dev
# 生产模式
deno task start
# 打包桌面应用（macOS .app/.dmg, Windows .msi, Linux .AppImage）
deno task desktop:all
# 跑测试
deno task test

# === WebView 前端（Vite + Preact）===
# 第一次需要装依赖
deno task webview:install
# dev 模式（Vite dev server on 127.0.0.1:5173，proxy /api → 8080）
deno task webview:dev
# 生产构建
deno task webview:build
# 类型检查
deno task webview:typecheck
```

## 完整 dev 工作流（Phase 1）

**双进程** — 软 DTU 后端（Deno）+ Vite dev server（Vite/Preact）：

```bash
# 终端 1：启动软 DTU 后端
cd packages/soft-dtu
deno task dev
# → http://127.0.0.1:8080/api/health

# 终端 2：启动 WebView
cd packages/soft-dtu
deno task webview:install  # 第一次
deno task webview:dev
# → http://127.0.0.1:5173
```

Vite dev server proxy `/api/*` → 8080，浏览器开 `http://127.0.0.1:5173` 即可。

Phase 2 切 Deno Desktop bindings SDK 后可以合并成单进程（`deno desktop`）。

## 项目结构

```
packages/soft-dtu/
├── deno.json                    # Deno 配置 + tasks（含 webview:* 子任务）
├── main.ts                      # Deno runtime 入口（含 HTTP API server 启动）
├── README.md                    # 本文件
├── AGENTS.md                    # agent 记忆（项目级约束）
├── .harness/
│   ├── docs/                    # 知识库（独立于 UartNode 根 .harness/）
│   └── scripts/                 # commit helper
├── src/
│   ├── protocol/                # 4G DTU 协议模拟 + 协议目录
│   │   ├── cellular-dtu.ts      # 4G DTU 行为（注册 + 8 条 AT 响应）
│   │   ├── at-handler.ts        # AT 指令响应生成
│   │   ├── config.ts            # 虚拟 IMEI / PID / VER / 串口配置 / server URL
│   │   └── protocol-catalog.ts  # 协议仓库（HTTP fetch + 缓存 + offline fallback）
│   ├── transport/               # 底层 transport
│   │   ├── tcp.ts               # TCP client 连 UartNode:9000
│   │   └── serial.ts            # 串口（npm:serialport）
│   ├── bindings/                # IPC bindings（WebView → Deno）
│   │   ├── serial.ts            # 串口操作 IPC
│   │   └── protocol.ts          # 协议目录 IPC（走 HTTP API）
│   └── server/
│       └── http-api.ts          # Phase 1: bindings → HTTP wrapper
└── webview/                     # Vite + Preact + TypeScript 前端
    ├── package.json
    ├── vite.config.ts           # dev proxy /api → 8080
    ├── tsconfig.json            # Preact JSX
    ├── index.html               # SPA 入口
    ├── README.md                # webview 独立说明
    └── src/
        ├── main.tsx             # Preact mount
        ├── App.tsx              # Tab 路由（4 个面板）
        ├── bindings.ts          # 类型契约（1:1 跟 Deno 端对齐）
        ├── api.ts               # HTTP fetch wrapper
        ├── styles.css           # 暗色主题
        └── panels/
            ├── SerialConfig.tsx     # 串口参数 + open/close
            ├── ATConsole.tsx        # AT 指令控制台 + 自动补全
            ├── HexView.tsx          # HEX/ASCII 实时数据视图
            └── ProtocolViewer.tsx   # 协议定义浏览器
```

## 跟姊妹项目关系

| 项目 | Runtime | 角色 | 跟软 DTU 关系 |
|---|---|---|---|
| `UartNode` (root) | Bun | DTU 网关 | 软 DTU 伪装 4G DTU 跟它通信（数据通道）|
| `uart-pesiv-node` | Bun | PESIV UPS 卡专用 | 完全独立，不共享配置 |
| `uart-server` (midwayuartserver) | Node/Midway | Server | 待加 `GET /api/v2/protocols` 端点（元数据通道，不鉴权）|
| `软 DTU` (本项目) | Deno | 设备代理 + 串口调试 | — |

## 配置

`~/.config/soft-dtu/config.json`（不存在时用默认 + env 覆盖）：

```json
{
  "virtualImei": "358700000000123",
  "pid": "HF2411",
  "ver": "V3.0.0",
  "gver": "G4",
  "iccid": "89860117851000012345",
  "iotStat": "on",
  "signal": 20,
  "uartNode": {
    "host": "127.0.0.1",
    "port": 9000
  },
  "uartServer": {
    "url": "http://127.0.0.1:9010",
    "apiPath": "/api/v2",
    "apiToken": "",
    "timeoutMs": 10000
  },
  "defaultSerial": {
    "baudRate": 115200,
    "dataBits": 8,
    "stopBits": 1,
    "parity": "none"
  }
}
```

env 变量优先：
- `SOFT_DTU_IMEI` / `SOFT_DTU_PID` / `SOFT_DTU_VER` / `SOFT_DTU_GVER` / `SOFT_DTU_ICCID` / `SOFT_DTU_IOTSTAT` / `SOFT_DTU_SIGNAL`
- `UART_NODE_HOST` / `UART_NODE_PORT`
- `UART_SERVER_URL` / `UART_SERVER_API_PATH` / `UART_SERVER_API_TOKEN` / `UART_SERVER_TIMEOUT_MS`

**协议选择**（`defaultProtocolId`）已删除（Cairui 2026-07-14 16:35 拍板）—— UI 启动不预选，用户手动选。

## 开发状态

**2026-07-15 15:20**：第二波代码（WebView 骨架 + 4 面板 + HTTP API stub）

- ✅ webview/ 骨架（Vite + Preact + TypeScript）
- ✅ 4 个面板（串口配置 / AT 指令 / HEX-ASCII / 协议定义）
- ✅ HTTP API server（包装 bindings，WebView 走 fetch 调）
- ⏳ protocol/cellular-dtu.ts 跟 UartNode TCP 握手 + 8 条 AT 响应跑通
- ⏳ 端到端集成测试
- ⏳ B-level review issues 清理（5 个 minor）

## 已知坑

- **bash tool 之前因 workspace 快照失灵**（跟 user memory 2026-07-14 那条 `defaultWorkspaceDir` 坑一致），本文件用 write 工具绝对路径写，**未 commit**，等新 session 跑 `.harness/scripts/commit-soft-dtu-skeleton.sh`
- **Deno Desktop 还在 canary**（Deno 2.9 2026-06-25 发），bindings API 可能变，Phase 1 stub + Phase 2 跟进
- **macOS 旧版要装 CH340 驱动**：https://www.wch-ic.com/downloads/CH341SER_MAC_V1.7.html
- **github 直连失败**（user memory 2026-07-14 那条），Deno 安装 / npm 下载可能受影响，先验证 `deno --version`
- **`src/transport/socketio.ts` 已废弃**（Cairui 2026-07-14 16:29 拍板），保留 deprecated stub 是为了让 commit 脚本自动 git rm（不交互）
- **server 端 `GET /api/v2/protocols` 端点要加** —— 必须 ping `agent-ae682922673b`（user memory "跨 worker 字段名约定" 那条：拍板落地前必 ping sibling）
- **HTTP API 不鉴权**（Cairui 2026-07-14 16:35 拍板），仅 dev/内网用，生产要加 Bearer token
