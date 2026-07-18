# 软 DTU WebView

软 DTU 控制台 UI 层 — **Vite + Preact + TypeScript**

## 4 个面板

| 面板 | 功能 |
|------|------|
| **串口配置** | 列本机串口、设波特率/数据位/停止位/校验、open/close |
| **AT 指令** | 发 `+++AT+XXX`、自动补全、解析响应（按选中协议的 `parse` 正则）|
| **HEX/ASCII** | 实时订阅串口数据，HEX / ASCII / 双视图切换 |
| **协议定义** | 浏览 server `/api/v2/protocols`、手动选协议、看 AT 指令 + 寄存器表 |

## Dev 工作流（Phase 1）

**双进程** — 软 DTU 后端（Deno）+ Vite dev server（Vite/Preact）：

```bash
# 终端 1：启动软 DTU 后端（Deno，HTTP serve on 127.0.0.1:8080）
cd packages/soft-dtu
deno task dev

# 终端 2：启动 WebView（Vite dev server on 127.0.0.1:5173，代理 /api → 8080）
cd packages/soft-dtu/webview
npm install   # 第一次需要装依赖
npm run dev
```

浏览器开 http://127.0.0.1:5173

### Vite proxy 流程

```
浏览器 127.0.0.1:5173
  ↓ fetch('/api/serial/list')
Vite dev server (proxy /api/* → 8080)
  ↓ http://127.0.0.1:8080/api/serial/list
Deno main.ts (deno serve)
  ↓ 调 __serialBindings.list()
SerialTransport.list() → SerialPort.list()
  ↓ 返回 SerialPortInfo[]
```

## Phase 2 切换

Deno 2.9 稳定后，bindings 切到 Deno Desktop official SDK（直接 IPC，无 HTTP）：

- `src/api.ts` 改用 `window.bindings.serial.*` 替代 fetch
- Vite proxy 配置可以删（WebView 直接调 Deno runtime）
- `deno desktop .` 启动原生窗口（macOS / Windows / Linux），bundle 内嵌 webview/dist 静态文件

## 字段名约束 ⚠️

`src/bindings.ts` 类型契约必须 **1:1 跟 Deno 端对齐**：

- `src/bindings/serial.ts`（Deno 端）
- `src/bindings/protocol.ts`（Deno 端）

参考契约文档：`../.harness/docs/server-api-contract.md`

**改字段名必 ping sibling**（user memory "跨 worker 字段名约定"）—— 错位会**静默失败**。

## 文件结构

```
webview/
├── package.json          # Vite + Preact + TS 依赖
├── vite.config.ts        # dev proxy + preact preset
├── tsconfig.json         # Preact JSX 配置
├── index.html            # SPA 入口
└── src/
    ├── main.tsx          # Preact mount
    ├── App.tsx           # Tab 路由
    ├── bindings.ts       # 类型契约（1:1 跟 Deno 端对齐）
    ├── api.ts            # HTTP fetch wrapper
    ├── styles.css        # 暗色主题
    └── panels/
        ├── SerialConfig.tsx
        ├── ATConsole.tsx
        ├── HexView.tsx
        └── ProtocolViewer.tsx
```

## 已知限制

- **HTTP stub 模式**：Phase 1 webview 走 fetch（Vite proxy → Deno serve），不是原生 IPC
- **SSE 单通道**：`onData` / `onError` / `onClose` 各开一个 EventSource，Phase 2 合并成单 IPC channel
- **无单元测试**：跟 UartNode 一样，Phase 2 落地时加 vitest
- **不预选协议**（Cairui 2026-07-14 16:35 拍板）：用户手动选
