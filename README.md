# UartNode

Ladis 厂区 DTU 网关节点。监听 TCP 9000 接收 **汉枫 4G/2G/NB DTU**（HF2411 / HF2111A / HF2611 等）
设备注册、采集数据，通过 Socket.IO 把数据上行到 `uart-server`，并接收 server 下行指令
（查询 / 操作 / AT）。

> **当前协议支持范围**：**100% 4G/2G/NB DTU only**。
> LAN 网关（HF5111 / EE1X / PE1X / Eport）的接入设计在
> [`.harness/docs/rfcs/001-lan-gateway-support.md`](.harness/docs/rfcs/001-lan-gateway-support.md)
> （draft，等拍板）。改 LAN 相关代码前先看 RFC 001。

## Runtime

Bun 1.x（从 Node 16 + tsc + ncc + nodemon 升级）。**Bun 升级路径**跟 `uart-pesiv-node` 完全对齐。

## 启动

```bash
# dev (auto-reload, 默认连 localhost:9010)
bun run dev

# prod 本地跑
bun start                   # = NODE_ENV=production bun src/main.ts

# typecheck（注意：socket.io-client 循环引用可能让 bun --check 卡住，
#          卡死就当通过，AGENTS.md 已记）
bun run typecheck

# 产出 JS bundle (dist/main.js, 需要 Bun runtime 解释执行)
bun run build

# Docker 镜像（runtime 镜像复用 oven/bun:1，不重复装）
bun run build:docker
bun run run:docker          # = docker run -itd -p 9000:9000 -e NODE_TOKEN=$NODE_TOKEN uartnode
```

## 鉴权（PR #20 — uart-server feat(node-auth)）

Node 必须在环境变量里带 `NODE_TOKEN`（明文）。该 token 由 server 端 admin 接口
`POST /api/v2/admin/dashboard/nodes/:name/rotate-token` 颁发，存 SHA-256 哈希在
server 端 mongo。

### 三通道注入（Socket.IO 握手）

Node 端在连接 server 时同时把 token 放在三个握手通道（与 `uart-pesiv-node` 对齐）：

1. `auth.token` — 推荐通道，websocket / polling 都吃
2. `query.token` — 备选通道
3. `x-node-token` header — `extraHeaders` + `transportOptions` 双保险（4.5+ websocket
   阶段 extraHeaders 失效已修）

### HTTP /api/node/* 上传

`fetch.ts` 走原生 `fetch` + `AbortSignal.timeout(30000)` (默认 30s,
可由 `UPLOAD_TIMEOUT_MS` 环境变量覆盖)，POST 时把 token 塞在
`x-node-token` header。

> ⚠️ **2026-06-22 hotfix**: 默认超时从 5s 调到 30s, 修复 ECONNRESET 雪崩。
> 5s 太接近 server 端 `terminal.parse` 高峰耗时 (4.7s), server 略慢就触发
> AbortSignal timeout → RST。server 端同步把 `/api/node/queryData` 改成
> fire-and-forget, 30s 留 6× 余量。详见 server commit。

### 部署示例

```bash
# 1. server 端先合 PR #20 并部署
# 2. server 端调 admin 接口拿明文 token
PLAIN_TOKEN=$(curl -X POST http://uart.ladishb.com:9010/api/v2/admin/dashboard/nodes/$(hostname)/rotate-token \
  -H "Authorization: Bearer $ADMIN_JWT" | jq -r .token)

# 3. Node 端注入
export NODE_TOKEN=$PLAIN_TOKEN
bun start

# Docker
docker run -d --name uartnode --restart always --init \
  -p 9000:9000 \
  -e NODE_TOKEN=$PLAIN_TOKEN \
  uartnode
```

> **未设 NODE_TOKEN 时只 warn 不中断**（与 uart-pesiv-node 行为一致），
> 给 server 端 PR #20 部署留过渡期。
>
> ⚠️ **NODE_TOKEN 绝对不能进 Dockerfile ARG/ENV** —— 会进镜像层泄漏到 registry。
> 必须 `docker run -e` 或 k8s secret 注入。

## 配置项（环境变量）

> `config.ts` 全 env 驱动，**没有任何 `isProd` / `NODE_ENV` 模式判断**
> （bun build --minify 会 DCE 掉被求值的 prod 分支，跑 prod host 必须**显式注入** env）。

| 变量 | 默认 | 说明 |
|------|------|------|
| `IO_URI` | `http://localhost:9010/node` | Socket.IO server URL |
| `IO_PATH` | `/client` | socket.io endpoint path |
| `SERVER_URL` | `http://localhost:9010/api/node/` | HTTP 上行 base URL |
| `NODE_TOKEN` | (空) | PR #20 鉴权令牌，未设会 warn |

> 容器里跑 prod host（如 `uart.ladishb.com:9010`）**必须** `IO_URI=...` / `SERVER_URL=...` 显式注入。

## 架构

```
src/
├── main.ts          入口：装配 IOClient + TcpServer
├── IO.ts            Socket.IO 客户端（三通道 token）
├── config.ts        常量 + 全 env 读取（IO_URI / IO_PATH / SERVER_URL / NODE_TOKEN）
├── TcpServer.ts     net.Server 监听 9000，处理 DTU 注册包 (4G 专属: 10s 推 +++AT+ 仪式)
├── client.ts        DTU 客户端（一个 DTU 一个 Client）— 4G 专属（+++AT+ 前缀、批量查 4G 字段）
├── socket.ts        DTU 串口代理（Buffer 读写 + lock/free 事件）
├── fetch.ts         HTTP 上传（queryData / dtuInfo / nodeInfo）— PR #20 鉴权 header
├── Cache.ts         死代码（已废弃，不要"优化"批传）
└── tool.ts          工具（NodeInfo / AT 解析 — 4G 专属，匹配 +ok 响应）
```

**4G 专属硬编码点**（改 LAN 接入时要动）：

| 点 | 文件:行 | 改法 |
|---|---|---|
| 10s 推 `+++AT+` 仪式 | `TcpServer.ts:71-81` | LAN 不推 |
| `URLSearchParams` 解析注册包 | `TcpServer.ts:92-115` | 改成白名单查 mac |
| IMEI 后 12 位当 mac | `TcpServer.ts:96-100` | LAN 用 MAC 12 字符 |
| `+++AT+` 前缀 | `client.ts:196` | LAN 改 CLI / HTTP API |
| 批量查 4G 字段 | `client.ts:126-146` | LAN 大半无意义 |
| `+ok` 解析 | `tool.ts:35` | LAN 改 EPORT> 提示符或 HTTP |
| `AT+Z` 硬重启 | `client.ts:273` | LAN 走 Web/REST API |

**已知 bug 残留**（`AGENTS.md` 已记，下次动 `TcpServer.ts` 时顺手清掉）：

- `TcpServer.ts:37, 49` 还有 2 处 `process.env.NODE_ENV === 'production' ? conf.Port : config.localport`。
  bun build --minify 后 DCE 掉 prod 分支，**`NODE_ENV=production` 容器永远走 `config.localport = 9000`，
  不会走 server 下发的 `conf.Port`**。

完整代码地图见 [`.harness/docs/architecture/source-map.md`](.harness/docs/architecture/source-map.md)。

## 仓库知识库

复杂资料放 [`.harness/`](.harness/)：

- [`AGENTS.md`](AGENTS.md) — 极简规则（鉴权、部署、回归、gh 账号、废弃代码、测试）
- [`.harness/docs/INDEX.md`](.harness/docs/INDEX.md) — 5 分钟起步导航
- [`.harness/docs/protocols/`](.harness/docs/protocols/) — 4G/LAN 协议速查
- [`.harness/docs/architecture/`](.harness/docs/architecture/) — 代码地图、数据流
- [`.harness/docs/rfcs/001-lan-gateway-support.md`](.harness/docs/rfcs/001-lan-gateway-support.md) — LAN 接入 RFC
- [`.harness/docs/workflow/`](.harness/docs/workflow/) — 部署、回归、跨项目对齐

## 与 uart-pesiv-node 的差异

UartNode 是 in-production 跑着的通用 DTU 网关（多个 DTU 通过 TCP 长连注册上来），
uart-pesiv-node 是 PESIV UPS 卡专用的单设备 agent（UDP 上行 + TCP debug）。
两者鉴权逻辑、配置项、Bun runtime 升级完全对齐。
