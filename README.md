# UartNode

Ladis 厂区 DTU 网关节点。监听 TCP 9000 接收 DTU 设备注册、采集数据，通过 Socket.IO 把
数据上行到 `uart-server`，并接收 server 下行指令（查询 / 操作 / AT）。

## Runtime

Bun 1.x（从 Node 16 + tsc + ncc + nodemon 升级）。

## 启动

```bash
# dev (auto-reload, NODE_ENV=development, localhost:9010)
bun run dev

# dev production server
bun run dev:p

# prod 本地跑
bun start

# 产出 JS bundle（dist/main.js，需要 Bun runtime 解释执行）
bun run build

# Docker 镜像（runtime 镜像复用 oven/bun:1 的 Bun runtime，不重复装）
bun run build:docker
bun run run:docker
```

## 鉴权（PR #20，uart-server feat(node-auth)）

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

`fetch.ts` 走原生 `fetch` + `AbortSignal.timeout(5000)`，POST 时把 token 塞在
`x-node-token` header。

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

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `NODE_ENV` | `development` | `production` 切 prod server (`uart.ladishb.com:9010`) |
| `TEST_SERVER_HOST` | `http://localhost:9010` | dev 模式 server 地址 |
| `NODE_TOKEN` | (空) | PR #20 鉴权令牌，未设会 warn |

## 架构

```
src/
├── main.ts          入口：装配 IOClient + TcpServer
├── IO.ts            Socket.IO 客户端（三通道 token）
├── config.ts        常量 + NODE_TOKEN env 读取
├── client.ts        DTU 客户端（一个 DTU 一个 Client）
├── TcpServer.ts     net.Server 监听 9000，处理 DTU 注册包
├── socket.ts        DTU 串口代理（Buffer 读写 + lock）
├── fetch.ts         HTTP 上传（queryData / dtuInfo / nodeInfo）
├── Cache.ts         查询结果缓存
└── tool.ts          工具（NodeInfo / AT 解析）
```

## 与 uart-pesiv-node 的差异

UartNode 是 in-production 跑着的通用 DTU 网关（多个 DTU 通过 TCP 长连注册上来），
uart-pesiv-node 是 PESIV UPS 卡专用的单设备 agent（UDP 上行 + TCP debug）。
两者鉴权逻辑、配置项、Bun runtime 升级完全对齐。
