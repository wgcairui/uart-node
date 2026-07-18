# reins/ —— 仓库内 agent 角色

> **当前状态**: **空**。**故意不写**。
>
> 原因: `AGENTS.md` 写得很清楚："不要凭空加单测框架 / jest 配置 —— 加之前先问 cairui"。
> agent 角色也是同性质的东西——写了不用就是死代码，不如不写。

## 什么时候该开

`mavis team plan` 给出 plan 时如果出现"这个 repo 需要一个专门 worker"，
**先用现有 agent 看能不能 cover**（优先 `general` / `explore`）。
**确实 cover 不了**再开 reins/ 下的角色。

### 候选角色（**草案，未启用**）

- `net-regression-runner` — 跑 RFC 001 落地后的 24h staging 回归
- `lan-protocol-impl` — 实施 RFC 001 的 LanClient / LanOutbound / HTTP API 适配
- `doc-keeper` — 知识库维护（基于 source-map diff 自动建议更新 docs）

> 这三个是 **脑子里转过**，**没开**。等 cairui 拍板 RFC 001 后再评估。

## 怎么开（参考）

```bash
# 1. 用 mavis 加载 create-agent skill
mavis skill load create-agent

# 2. 在 .harness/reins/ 下创建
# 路径: <repo>/.harness/reins/<role-name>/
# 文件: agent.md + skills/ 目录

# 3. commit .harness/reins/<role-name>/ 到 git
```

**创建前先回答三个问题**：

1. 这个角色做的事，现有 `general` / `explore` agent 真的 cover 不了吗？
2. 这个角色会**反复**被需要吗？（一次性的不需要开 reins）
3. 这个角色的 prompt / skill 内容**已经写出来**了吗？没写就别开

## 跟全局 `~/.mavis/agents/` 的边界

| 维度 | 放哪 |
|---|---|
| "跨项目 helper"（比如个人记忆管理 / 通用 lint 跑）| **全局** `~/.mavis/agents/<name>/` |
| "UartNode 专属 worker"（比如 LAN 协议实施 / staging 回归）| **本仓库** `.harness/reins/<name>/` |

UartNode 这个项目**没有跨项目 helper 需求**——所有任务都跟 DTU 接入相关，应该在仓库 reins 下。
