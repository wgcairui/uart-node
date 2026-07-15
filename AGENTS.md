# AGENTS.md — UartNode

> 项目专属 agent 记忆。**只写读代码 / README 发现不了的事**。每条都问：
> "如果删掉，下次 agent 会重蹈覆辙吗？" — 答否就删。

## 鉴权（PR #20 — uart-server feat(node-auth)）

- 启动从 `NODE_TOKEN` env 读明文。**没设时只 warn 不中断**（server PR #20 部署前留过渡期）。
- Socket.IO 握手三通道（`auth.token` / `query.token` / `x-node-token` header）+ HTTP `/api/node/*` `x-node-token` header
  实现都在 `src/IO.ts`（顶层单例）+ `src/services/io-client.ts`（PR #1 落地的 class 化版本）+ `src/fetch.ts` + `src/services/uploader.ts`。
  PR #1 之后两个版本**并存**，`main.ts` 还在用 `src/IO.ts` 顶层单例（`src/services/io-client.ts` 的 `getIOClient()` 主要是给 `dtus/base.ts` + `services/*` 内部用）。
  下次动 `main.ts` 时切到 `getIOClient()`，然后删 `src/IO.ts`。

## 部署约束

- **NODE_TOKEN 绝对不能写进 Dockerfile ARG/ENV** — 会进镜像层泄漏到 registry。
  必须运行时注入：`docker run -e NODE_TOKEN=...` 或 k8s secret。
- **全 env 驱动**（与 `uart-pesiv-node` 对齐）：`IO_URI` / `IO_PATH` / `SERVER_URL` / `NODE_TOKEN`
  都从 `process.env` 读，**不要**在 config.ts 里加 `isProd` / `NODE_ENV` 模式判断 —
  bun build --minify 会 DCE 掉被求值的 prod 分支，运行时永远走 dev fallback。
  容器里跑 prod host 一定要 `IO_URI=...` 显式注入。

## 未回归的运行时风险

- `src/server/tcp-server.ts` + `src/server/register-handler.ts` + `src/socket.ts` + `src/dtus/cellular.ts`
  整套 net 逻辑（Bun runtime）**没在生产跑过**。
  改这几个文件后必须 staging 真机回归 24h+，确认 DTU 注册包解析 / AT 指令收发 /
  长连接 keepalive / 被动断开 + 主动重启（`Z` 指令）路径。
  完整 checklist 见 `.harness/docs/workflow/staging-regression.md`。
- `bun --check` 之前对 `socket.io-client` 报循环引用卡住过，实际运行没问题。
  **typecheck 不要卡死就当通过**。
- **`src/socket.ts:40-42` 的 socket timeout 没 destroy** —— `setTimeout(5min)` 触发后**只打 log**，
  不主动断开。设计上是给 keepalive 探针兜底，**但要意识到长静默连接不会被回收**。
  长跑场景下 MacSocketMaps 可能会堆积"僵尸" Client。
- ~~**`TcpServer.ts:37, 49` 残留 `NODE_ENV` 模式判断**~~ —— **PR #5 重构时已修**，
  改用 `src/server/tcp-server.ts` 的 `resolveListenPort()` 全 env 驱动
  （`LISTEN_PORT` env → `conf.Port` → `config.localport = 9000`）。不再有 DCE bug。
  不要再回退。

## 当前协议支持范围

- **100% 4G/2G/NB DTU only**（汉枫 HF2411 / HF2111A / HF2611 等）——
  `tcp-server.ts` 推 `+++AT+` 仪式、`register-handler.ts` 的 `URLSearchParams` 解析注册包 +
  IMEI 后 12 位当 mac、`cellular.ts:initialize()` 批量查 8 条 AT（`PID/VER/GVER/IOTEN/ICCID/LOCATE/UART/GSLQ`
  + `IOTEN=off` 关流量）、`services/at-parse.ts` 匹配 `+ok=...` 响应、基类 `Dtu` 的 8 态状态机
  + 5 类 alert（`src/dtus/state.ts`）——**6 处硬编码绑死 4G**（详见 README）。
- **不支持汉枫 LAN 网关**（HF5111 / EE1X / PE1X / Eport 等）—— 没有注册包机制、不响应
  `+++AT+` 透传穿指令、需要走不同拓扑。
- **LAN 接入设计在 `.harness/docs/rfcs/001-lan-gateway-support.md`**，等拍板后开工。
- 协议速查：`.harness/docs/protocols/cellular-4g-dtu.md` + `lan-gateway.md`。

## 跨项目 reference

- **跟 `uart-pesiv-node` 完全对齐**：鉴权三通道、NODE_TOKEN 语义、Bun 升级路径、
  Docker 两阶段构建都同构。改 UartNode 之前先看那边有没有先例。
- 跟 `midwayuartserver`（server 端 midway 项目，`agent-ae682922673b` 在管）走 Socket.IO 协议。
  server 端事件名 / payload 格式变更会反向影响这里。

## GitHub

- Repo: `wgcairui/uart-node`（**小写连字符**，跟 `wgcairui/UartNode` 大写不一样）
- `gh auth switch --user wgcairui`，或直接走 `~/.config/credentials/.env.local` 里的 `GH_TOKEN` + curl 调 REST API
  （gh CLI 不读 `GH_TOKEN` env，cairui 机器踩过坑）。

## 已废弃代码

- **`src/Cache.ts` 整文件是死代码**（没人 import，`pushColletion` 没人调）。
  顶部 `ProxyQueryColletion` 批传是注释掉的死代码；
  `pushColletion` 即便被调也只走 `fetch.queryData(data)`，**不会批传**。
  —— 看到有人想"优化"成批传要拦住：server 端有 5s 最小查询间隔 + 30s 去重，
  客户端批传反而会丢数据。**真要清理就直接删 `Cache.ts`**，不要"补批传逻辑"。
- **别把 `src/dtus/base.ts` 里的实例字段 `protected cache: DtuQueryItem[]` 跟 `src/Cache.ts` 搞混**——
  前者是单 DTU 内部的 FIFO 指令队列（**实际在跑**），后者是文件级死代码。
- **`src/tool.ts` 是空占位文件**（PR #3 / #4 把 `ATParse` / `NodeInfo` 拆到 `services/` 后留下的空 class）。
  保留是为 import 路径不破坏，新代码**不要** import `src/tool.ts`。
  需要 AT 解析用 `services/at-parse`，需要 nodeInfo 用 `services/dtu-info`。

## 测试

- **201 tests / 198 pass / 3 fail / 10 files**（2026-07-14 实测 `bun test`）。
- 10 个 spec 文件在 `test/{dtus,services,server,protocol}/`，覆盖：
  - 状态机纯函数（`test/dtus/state.test.ts`）
  - CellularDtu 集成（`test/dtus/integration.test.ts` + `test/dtus/index.test.ts`）
  - TCP server 注册 + sniffers（`test/server/tcp-server.test.ts` + `test/server/register-handler.test.ts`）
  - Socket.IO client class（`test/services/io-client.test.ts`）
  - Uploader 队列/背压/重试（`test/services/uploader.test.ts`）
  - AT 解析 + 节点信息 + 事件名常量（`test/services/at-parse.test.ts` / `dtu-info.test.ts` / `test/protocol/events.test.ts`）
- **3 fail 根因**（已知 test 顺序依赖，独立 PR 待修）：
  `Uploader — 背压` 段 1100 个 enqueue + `fetchDelayMs=50` 拉长
  → `setTimeout(retry backoff, ...)` 跨 test 边界残留
  → `afterEach` 里 `mock.restore()` 把 fetch mock 撤了
  → retry callback 用真实 fetch 调 `http://test.local:1/` → ECONNREFUSED（**不进 `fetchCalls` 数组**）。
  单独跑 `uploader.test.ts` 全 pass（0 fail / 15 pass / 31 expect），跑 `uploader + tcp-server` 也全 pass。
  修法：给 retry 加测试钩子禁用 / `afterEach` 加 `await waitDrain(retry_backoff_window)` / 拆 `Uploader — 背压` 进独立 spec 文件。
  详见过渡 `changelogs/2026-07-14-test-isolation.md`（待写）。

## 仓库知识库

- 复杂资料（协议速查、代码地图、RFC 草稿、回归 checklist）放 `.harness/docs/`。
- 起步走 `.harness/docs/INDEX.md`；改 net 那一坨（`src/server/tcp-server.ts` /
  `src/server/register-handler.ts` / `src/socket.ts` / `src/dtus/`）之前**先读**
  `.harness/docs/workflow/staging-regression.md`。
- v4 重构后代码地图见 `.harness/docs/architecture/source-map.md`（v4 落地后已 sync 2026-07-14）。
