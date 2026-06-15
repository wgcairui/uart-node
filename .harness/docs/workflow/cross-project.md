# 跨项目对齐

> UartNode 跟 `uart-pesiv-node` / `midwayuartserver`（server 端）的同构点 / 差异点

## 1. `uart-pesiv-node`（**强对齐**）

`AGENTS.md` 写得很明确：

> 跟 `uart-pesiv-node` 完全对齐：鉴权三通道、NODE_TOKEN 语义、Bun 升级路径、
> Docker 两阶段构建都同构。改 UartNode 之前先看那边有没有先例。

### 1.1 鉴权三通道

`IO.ts:14-23` 已经按 `uart-pesiv-node` 那边风格实现：

```ts
auth: NODE_TOKEN ? { token: NODE_TOKEN } : undefined,
query: NODE_TOKEN ? { token: NODE_TOKEN } : undefined,
extraHeaders: NODE_TOKEN ? { 'x-node-token': NODE_TOKEN } : undefined,
transportOptions: {
  polling: { extraHeaders: { 'x-node-token': NODE_TOKEN } },
  websocket: { extraHeaders: { 'x-node-token': NODE_TOKEN } }
}
```

如果那边升级到 socket.io-client 5.x 或 4.8，**UartNode 这边要同步升**（`bun.lock` / `package.json`）。

### 1.2 NODE_TOKEN 语义

- "**没设时只 warn 不中断**"（`config.ts:41`）—— 跟 `uart-pesiv-node` 一致
- "**不能进 Dockerfile**" —— 跟 `uart-pesiv-node` 一致

### 1.3 全 env 驱动 + DCE 避坑

`config.ts` 文件头注释（`config.ts:1-11`）直接引用 `uart-pesiv-node/src/config.ts` 风格。
**DCE bug 修复**（commit 6fa4359）也是两边一起修的——**改之前看那边先例**。

### 1.4 Docker 两阶段构建

`Dockerfile` 根目录，**本地不展开**（AGENTS.md 强调过别自己改）。
**UartNode 跟 uart-pesiv-node 是同构**——一个改了另一个要同步 review。

### 1.5 bun 版本

`bun.lock` / `package.json` 锁的 bun 版本要跟 `uart-pesiv-node` 对齐。
**升级路径**两个项目一起升，先在 pesiv 那边过回归，UartNode 再跟。

## 2. `midwayuartserver`（**协议层对齐**）

> 跟 `midwayuartserver`（server 端 midway 项目，agent-ae682922673b 在管）走 Socket.IO 协议。
> server 端事件名 / payload 格式变更会反向影响这里。

### 2.1 事件名 / payload 格式

UartNode 期望的 server 端事件：

| 事件 | 来源 | UartNode 入口 | Payload 类型 |
|---|---|---|---|
| `accont` | server 主动 | `IOClient.on('accont')` `main.ts:16` | （空）|
| `registerSuccess` | server 响应 register | `main.ts:20` | `registerConfig` |
| `query` | server 下行 | `main.ts:31` | `queryObjectServer` |
| `instructQuery` | server 下行 | `main.ts:37` | `instructQuery` |
| `DTUoprate` | server 下行 | `main.ts:42` | `DTUoprate` |
| `nodeInfo` | server 拉 | `main.ts:47` | `name: string` |

UartNode 上报给 server 的事件：

| 事件 | 含义 | Payload |
|---|---|---|
| `register` | node 注册 | `nodeInfo` |
| `ready` | 节点就绪 | — |
| `terminalOn` | 设备上线 | `(mac, forceReport: boolean)` |
| `terminalOff` | 设备离线 | `(mac, forceReport: boolean)` |
| `busy` | 设备忙 | `(mac, busy, count)` |
| `deviceopratesuccess` | 操作指令完成 | `(Query.events, result)` |
| `dtuopratesuccess` | AT 指令完成 | `(Query.events, result)` |
| `result` | ioOnResult 响应 | `(eventName, data)` |

**这些事件名和 payload shape 在 server 端 agent-ae682922673b 那边有定义**——
**改 UartNode 这边时先跟 server 端对一遍**，不要自顾自改。

### 2.2 `registerConfig` 字段

`TcpServer.ts:17-24` 期望的字段：

```ts
{
  Port: number,         // TCP 监听端口
  MaxConnections: number,
  IP: string,
  UserID?: string       // 用于 AT+IOTUID
}
```

`registerConfig` 类型在 `uart` 包（外部依赖，见 `package.json` / `types/`）里。

### 2.3 HTTP `/api/node/*` 接口

UartNode 走的 HTTP 接口：

| 路径 | 方法 | 用途 | 来源 |
|---|---|---|---|
| `/api/node/dtuinfo` | POST | 设备参数 | `fetch.dtuInfo` |
| `/api/node/queryData` | POST | 查询结果 | `fetch.queryData` |
| `/api/node/RunData` | POST | 运行数据 | （未在 src 使用）|
| `/api/node/nodeInfo` | POST | node 机器信息 | `fetch.nodeInfo` |
| `/api/node/UartData` | POST | （Cache.ts 用，未启用）| 已废弃 |

**鉴权**：header `x-node-token: <NODE_TOKEN>`。

**server 端变更这些接口时要通知 cairui / UartNode 同步改**。

## 3. 跨项目 sync checklist

改 UartNode 时，看一眼相关项目：

- [ ] 鉴权 / env 改动 → 同步 `uart-pesiv-node`（`config.ts` / `IO.ts` / `fetch.ts`）
- [ ] 事件名 / payload 改动 → 同步 `midwayuartserver`（跟 `agent-ae682922673b` 对齐）
- [ ] bun / Node 升级 → 先在 `uart-pesiv-node` 跑回归，过了再动 UartNode
- [ ] Dockerfile 改动 → 同步 review 两个项目

**改 UartNode 之前 grep 一下 `uart-pesiv-node` 那边有没有同款改动**——避免分歧。

## 4. 当前待对齐的 backlog

- ❓ RFC 001 落地后，**server 端需要新增 `GET /api/node/lan-devices` 接口**（白名单拉取）—— 跟 `agent-ae682922673b` 对齐
- ❓ RFC 001 落地后，**server 端需要接受 `mac:` 前缀的 deviceId**（mac 命名空间）—— 同样要对齐
- ❓ socket.io-client 版本同步：`uart-pesiv-node` 升 4.7.5+ 后 UartNode 这边要 verify
- ❓ bun 版本对齐：UartNode 当前 `bun.lock` 锁的版本跟 `uart-pesiv-node` 是否一致——需要时再对

## 5. 跨项目沟通通道

- `uart-pesiv-node` —— **cairui 自己管**，没有独立 agent
- `midwayuartserver` —— `agent-ae682922673b`（server 端 worker）
- 跨项目协调走 cairui 拍板
