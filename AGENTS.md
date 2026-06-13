# AGENTS.md — UartNode

> 项目专属 agent 记忆。**只写读代码 / README 发现不了的事**。每条都问：
> "如果删掉，下次 agent 会重蹈覆辙吗？" — 答否就删。

## 鉴权（PR #20 — uart-server feat(node-auth)）

- 启动从 `NODE_TOKEN` env 读明文。**没设时只 warn 不中断**（server PR #20 部署前留过渡期）。

## 部署约束

- **NODE_TOKEN 绝对不能写进 Dockerfile ARG/ENV** — 会进镜像层泄漏到 registry。
  必须运行时注入：`docker run -e NODE_TOKEN=...` 或 k8s secret。

## 未回归的运行时风险

- `TcpServer.ts` / `socket.ts` / `client.ts` 整套 net 逻辑（Bun runtime）**没在生产跑过**。
  改这几个文件后必须 staging 真机回归 24h+，确认 DTU 注册包解析 / AT 指令收发 /
  长连接 keepalive / 被动断开 + 主动重启（`Z` 指令）路径。
- `bun --check` 之前对 `socket.io-client` 报循环引用卡住过，实际运行没问题。
  **typecheck 不要卡死就当通过**。

## 跨项目 reference

- **跟 `uart-pesiv-node` 完全对齐**：鉴权三通道、NODE_TOKEN 语义、Bun 升级路径、
  Docker 两阶段构建都同构。改 UartNode 之前先看那边有没有先例。
- 跟 `midwayuartserver`（server 端 midway 项目，agent-ae682922673b 在管）走 Socket.IO 协议。
  server 端事件名 / payload 格式变更会反向影响这里。

## GitHub

- `wgcairui/UartNode` 是 org 仓库，**gh 默认账号 `ruicaiext-1m` 已废弃**（READ-only），
  push / 开 PR 必须切 `wgcairui` 账号（`gh auth switch --user wgcairui`）。

## 已废弃代码

- `Cache.ts` 顶部那段 `ProxyQueryColletion` 批传代码是注释掉的死代码。
  现在 `pushColletion` 直传 `fetch.queryData(data)`，**不要"优化"成批传** —
  server 端有 5s 最小查询间隔 + 30s 去重，客户端批传反而会丢数据。

## 测试

- **没有测试**。`bun test` 装上了但 0 个 spec。
  **不要凭空加单测框架 / jest 配置** — 加之前先问 cairui。
