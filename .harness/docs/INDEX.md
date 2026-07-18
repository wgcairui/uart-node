# 知识库索引

按"先读哪个 / 啥时候读 / 读完之后该会啥"组织。

## 0. 起步（10 分钟必读）

| 顺序 | 文档 | 何时读 | 读完应该会啥 |
|---|---|---|---|
| 1 | 根 `AGENTS.md` | 任何 UartNode 任务前 | 鉴权、部署、回归、gh 账号、废弃代码 |
| 2 | [`architecture/source-map.md`](architecture/source-map.md) | 改 src/ 任何文件前 | 8 个文件职责、调用关系、改哪几个点 |
| 3 | [`architecture/data-flow.md`](architecture/data-flow.md) | 排查数据丢失 / 鉴权失败 / 重连问题时 | DTU ↔ UartNode ↔ server 完整数据通路 |

## 1. 协议层（按需深读）

| 任务 | 文档 |
|---|---|
| 改 `TcpServer._Connection` / 加新协议支持 | [`protocols/cellular-4g-dtu.md`](protocols/cellular-4g-dtu.md) + [`protocols/lan-gateway.md`](protocols/lan-gateway.md) + [`rfcs/001-lan-gateway-support.md`](rfcs/001-lan-gateway-support.md) |
| 改 `client.ts` 的 `QueryAT` / `run()` | [`protocols/cellular-4g-dtu.md`](protocols/cellular-4g-dtu.md) §AT 指令集 |
| 改 `tool.ATParse` 解析器 | [`protocols/cellular-4g-dtu.md`](protocols/cellular-4g-dtu.md) §响应格式 |
| LAN 设备接入 | [`protocols/lan-gateway.md`](protocols/lan-gateway.md) + [`rfcs/001-lan-gateway-support.md`](rfcs/001-lan-gateway-support.md) |

## 2. 工作流（执行类）

| 任务 | 文档 |
|---|---|
| 改 net 那一坨（`TcpServer.ts` / `socket.ts` / `client.ts`）| [`workflow/staging-regression.md`](workflow/staging-regression.md) — **必读 24h+ 真机回归** |
| 部署到 staging / 生产 | [`workflow/deployment.md`](workflow/deployment.md) — env 注入、Dockerfile 边界 |
| 跟其他 uart 节点项目对账 | [`workflow/cross-project.md`](workflow/cross-project.md) — 跟 uart-pesiv-node / midwayuartserver 同步约束 |

## 3. 设计与 RFC（规划类）

| 文档 | 状态 | 说明 |
|---|---|---|
| [`rfcs/001-lan-gateway-support.md`](rfcs/001-lan-gateway-support.md) | **draft** | LAN 网关（HF5111/EE1X/PE1X/Eport）支持的协议适配 RFC，等 cairui 拍板 |

## 4. 怎么更新本知识库

写新文档前先看 [`README.md` 编写原则](../README.md) 第五节。**别忘了**：

- RFC 进入"实施"状态后，相关的 source-map / workflow 文档要同步更新
- 代码改了但 source-map 没改 → **stale**，下次 agent 会走错路
- 实测出反例（比如发现 LAN 设备其实响应 `+++AT+`）→ 立刻更新协议速查

## 5. 暂未覆盖的话题（占位）

- 测试 —— AGENTS.md 明确写了"没有测试"，本知识库**不写**测试相关内容
- 性能调优 —— 没在生产跑过，没有可写的经验
- 安全审计 —— 同上

这三个话题有内容可写了，单独开文档。
