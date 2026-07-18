# 部署约束

> 来源：根 `AGENTS.md`、根 `Dockerfile`、`config.ts` (v3.3.0)
> 这份是**展开**资料，根 `AGENTS.md` 的极简规则还是要先读

## 1. 鉴权三通道（PR #20 feat(node-auth)）

UartNode 跟 uart-server 通信走两条路，**两边都加 NODE_TOKEN 鉴权**：

### 1.1 Socket.IO 通道

`src/IO.ts:14-23` 一次性把三个握手通道都开上：

```ts
const IOClient = socketClient(IO_CONFIG.uri, {
  path: IO_CONFIG.path,
  auth: NODE_TOKEN ? { token: NODE_TOKEN } : undefined,
  query: NODE_TOKEN ? { token: NODE_TOKEN } : undefined,
  extraHeaders: NODE_TOKEN ? { 'x-node-token': NODE_TOKEN } : undefined,
  transportOptions: {
    polling: { extraHeaders: { 'x-node-token': NODE_TOKEN } },
    websocket: { extraHeaders: { 'x-node-token': NODE_TOKEN } }
  }
})
```

| 通道 | 何时生效 | 备注 |
|---|---|---|
| `auth.token` | websocket 握手 | **推荐通道**（4.7.5 默认）|
| `query.token` | `?token=` URL 参数 | 备选，server 端可识别 |
| `extraHeaders['x-node-token']` | polling 握手 | HTTP polling fallback |
| `transportOptions.polling/websocket.extraHeaders` | 4.5+ 修复后 | websocket 阶段 header 不丢 |

**server 端优先顺序**（跟 uart-pesiv-node 注释里说的一致）：

> socket 端 auth → query → header

### 1.2 HTTP 通道

`src/fetch.ts:45-46` 注入 header：

```ts
const headers = { 'content-type': 'application/json' }
if (NODE_TOKEN) headers['x-node-token'] = NODE_TOKEN
```

**server 端** 从 header 优先取，body 兜底（注释写在 fetch.ts:44）。

## 2. NODE_TOKEN 部署约束

**绝对规则**（`AGENTS.md` 已强调）：

- ✅ **运行时注入**：`docker run -e NODE_TOKEN=...` 或 k8s secret / compose env
- ❌ **不能写进 Dockerfile ARG/ENV** —— 会进镜像层泄漏到 registry
- ❌ **不能进 git** —— `.env` 加 `.gitignore`，CI 走 secret manager

**没设 NODE_TOKEN 的行为**（`config.ts:41-47`）：

```ts
if (!NODE_TOKEN) {
  console.warn('[config] NODE_TOKEN not set. ...')
}
```

**只 warn 不中断** —— 这是给 server PR #20 部署前留的过渡期。
**server 端 PR #20 部署后**，没设 NODE_TOKEN 的 node 会被 reject，**必须**修。

## 3. 全 env 驱动

`config.ts` **不引入 `isProd` / `NODE_ENV` 等环境模式判断**。
注释里写了原因：

> bun build --minify 会 DCE 掉被求值的 prod 分支，
> 运行时永远走 dev fallback

**踩过的 bug**（commit 6fa4359 已修）：之前 `process.env.NODE_ENV === 'production'` 这种判断会被 bun DCE 砍掉。

**当前 env 列表**：

| env | 默认 | 说明 |
|---|---|---|
| `IO_URI` | `http://localhost:9010/node` | Socket.IO server URL |
| `IO_PATH` | `/client` | socket.io endpoint path |
| `SERVER_URL` | `http://localhost:9010/api/node/` | HTTP 上行 base URL |
| `NODE_TOKEN` | （空）| 见 §1，**不能进 Dockerfile** |

容器里跑 prod host **必须** `IO_URI=...` / `SERVER_URL=...` **显式注入**。

## 4. Docker 部署

`Dockerfile`（根目录）—— **本地不展开**（AGENTS.md 强调过别自己改），需要时再看。

**package.json 里给的运行命令**（`package.json:9-10`）：

```json
"start": "NODE_ENV=production bun src/main.ts",
"run:docker": "docker stop uartnode 2>/dev/null; ... -e NODE_TOKEN=$NODE_TOKEN uartnode"
```

`NODE_ENV=production` 走 `bun src/main.ts`（不 watch），
`run:docker` 模板里 `NODE_TOKEN=$NODE_TOKEN` 提醒**必须**有 env。

## 5. build 注意事项

- `bun build --minify` 会做 DCE —— 见 §3
- `bun --check src/main.ts` 跑 typecheck —— **AGENTS.md 警告**：
  > 之前对 `socket.io-client` 报循环引用卡住过，实际运行没问题。
  > typecheck 不要卡死就当通过。

## 6. 部署后验收 checklist

部署到 staging / 生产前必过：

- [ ] `NODE_TOKEN` 走运行时注入（**不**进镜像）
- [ ] `IO_URI` / `SERVER_URL` 走运行时注入（指向实际 server）
- [ ] 容器起来后日志有 `WebSocketServer listening: <ip>:<port>`（TcpServer 启动标志）
- [ ] Socket.IO connect 成功 + 收到 `accont` + 发 `register`
- [ ] server 端能看到 node + 在线设备数 > 0
- [ ] 第一条 DTU 注册包被解析 + `terminalOn` 上报 server
