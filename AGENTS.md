# AGENTS.md — UartNode

> 项目专属 agent 记忆。**只写读代码 / README 发现不了的事**。每条都问：
> "如果删掉，下次 agent 会重蹈覆辙吗？" — 答否就删。

## 鉴权（PR #20 — uart-server feat(node-auth)）

- 启动从 `NODE_TOKEN` env 读明文。**没设时只 warn 不中断**（server PR #20 部署前留过渡期）。

## 部署约束

- **NODE_TOKEN 绝对不能写进 Dockerfile ARG/ENV** — 会进镜像层泄漏到 registry。
  必须运行时注入：`docker run -e NODE_TOKEN=...` 或 k8s secret。
- **全 env 驱动**（与 `uart-pesiv-node` 对齐）：`IO_URI` / `IO_PATH` / `SERVER_URL` / `NODE_TOKEN`
  都从 `process.env` 读，**不要**在 config.ts 里加 `isProd` / `NODE_ENV` 模式判断 —
  bun build --minify 会 DCE 掉被求值的 prod 分支，运行时永远走 dev fallback。
  容器里跑 prod host 一定要 `IO_URI=...` 显式注入。

## 未回归的运行时风险

- `TcpServer.ts` / `socket.ts` / `client.ts` 整套 net 逻辑（Bun runtime）**没在生产跑过**。
  改这几个文件后必须 staging 真机回归 24h+，确认 DTU 注册包解析 / AT 指令收发 /
  长连接 keepalive / 被动断开 + 主动重启（`Z` 指令）路径。
  完整 checklist 见 `.harness/docs/workflow/staging-regression.md`。
- `bun --check` 之前对 `socket.io-client` 报循环引用卡住过，实际运行没问题。
  **typecheck 不要卡死就当通过**。
- **`socket.ts:40-42` 的 socket timeout 没 destroy** —— `setTimeout(5min)` 触发后**只打 log**，
  不主动断开。设计上是给 keepalive 探针兜底，**但要意识到长静默连接不会被回收**。
  长跑场景下 MacSocketMaps 可能会堆积"僵尸" Client。
- **`TcpServer.ts:37, 49` 还有 2 处 `NODE_ENV` 模式判断残留** —— commit 6fa4359 修了
  `config.ts` 但漏了这里。bun build --minify 后 DCE 掉 prod 分支，**`NODE_ENV=production`
  容器永远走 `config.localport = 9000`，不会走 server 下发的 `conf.Port`**。
  下次动 `TcpServer.ts` 时**顺手清掉**，改成全 env（参考 `config.ts:1-11`）。

## 当前协议支持范围

- **100% 4G/2G/NB DTU only**（汉枫 HF2411 / HF2111A / HF2611 等）—— `TcpServer` 推 `+++AT+` 仪式、
  `URLSearchParams` 解析注册包、`client.run()` 批量查 `AT+PID/VER/GVER/ICCID/LOCATE/UART/GSLQ/IOTEN`、
  `tool.ATParse` 匹配 `+ok` 响应——**4 处硬编码绑死 4G**。
- **不支持汉枫 LAN 网关**（HF5111 / EE1X / PE1X / Eport 等）—— 没有注册包机制、不响应
  `+++AT+` 透传穿指令、需要走不同拓扑。
- **LAN 接入设计在 `.harness/docs/rfcs/001-lan-gateway-support.md`**，等拍板后开工。
- 协议速查：`.harness/docs/protocols/cellular-4g-dtu.md` + `lan-gateway.md`。

## 跨项目 reference

- **跟 `uart-pesiv-node` 完全对齐**：鉴权三通道、NODE_TOKEN 语义、Bun 升级路径、
  Docker 两阶段构建都同构。改 UartNode 之前先看那边有没有先例。
- 跟 `midwayuartserver`（server 端 midway 项目，agent-ae682922673b 在管）走 Socket.IO 协议。
  server 端事件名 / payload 格式变更会反向影响这里。

## GitHub

- `wgcairui/UartNode` 是 org 仓库，**gh 默认账号 `ruicaiext-1m` 已废弃**（READ-only），
  push / 开 PR 必须切 `wgcairui` 账号（`gh auth switch --user wgcairui`）。

## 已废弃代码

- `Cache.ts` 整文件是**死代码**（没人 import，`pushColletion` 没人调）。
  顶部 `ProxyQueryColletion` 批传是注释掉的死代码；
  `pushColletion` 即便被调也只走 `fetch.queryData(data)`，**不会批传**。
  —— 看到有人想"优化"成批传要拦住：server 端有 5s 最小查询间隔 + 30s 去重，
  客户端批传反而会丢数据。**真要清理就直接删 `Cache.ts`**，不要"补批传逻辑"。
- **别把 `client.ts:39` 的实例字段 `private Cache: ...[]` 跟 `src/Cache.ts` 搞混**——
  前者是单 DTU 内部的 FIFO 指令队列（**实际在跑**），后者是文件级死代码。

## 测试

- **没有测试**。`bun test` 装上了但 0 个 spec。
  **不要凭空加单测框架 / jest 配置** — 加之前先问 cairui。

## 仓库知识库

- 复杂资料（协议速查、代码地图、RFC 草稿、回归 checklist）放 `.harness/docs/`。
- 起步走 `.harness/docs/INDEX.md`；改 `src/TcpServer.ts` / `socket.ts` / `client.ts` /
  `tool.ts` 之前**先读** `.harness/docs/workflow/staging-regression.md`。
