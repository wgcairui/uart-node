# UartNode 知识库

> 仓库级（**project memory**）知识库。**只写读代码 / README 发现不了的事**——
> 每条都问："如果删掉，下次 agent 会重蹈覆辙吗？" 答否就删。

跟根目录 `AGENTS.md` 的关系：

- `AGENTS.md` — **极简**规则（鉴权约束、部署约束、未回归风险、废弃代码、测试、gh 账号）
- `.harness/` — **展开**资料（协议速查、代码地图、RFC 草稿、dev workflow）

新加入 UartNode 的 agent / 子会话，**先读 `AGENTS.md`**，再扫 `.harness/docs/INDEX.md`，
再按需深读具体子文档。

## 目录

```
.harness/
├── README.md                         ← 你在这
├── docs/
│   ├── INDEX.md                      ← 知识库索引
│   ├── protocols/
│   │   ├── cellular-4g-dtu.md        ← 汉枫 4G/2G/NB DTU 协议速查（HF2411 等）
│   │   └── lan-gateway.md            ← 汉枫 LAN 网关协议速查（HF5111/EE1X/PE1X/Eport）
│   ├── architecture/
│   │   ├── source-map.md             ← src/ 8 个文件职责 + 调用关系
│   │   └── data-flow.md              ← 数据流（DTU ↔ UartNode ↔ server）
│   ├── rfcs/
│   │   └── 001-lan-gateway-support.md  ← LAN 网关支持 RFC 草稿
│   └── workflow/
│       ├── deployment.md             ← 部署约束、env 注入、staging 回归
│       ├── staging-regression.md     ← 改 net/socket 相关代码的回归 checklist
│       └── cross-project.md          ← 跟 uart-pesiv-node / midwayuartserver 的对齐点
└── reins/                            ← agent 角色（按需创建，不写空架子）
```

## 编写原则

1. **不写读代码就知道的东西**——比如"src/main.ts 是入口"这种
2. **不写还没发生的事**——RFC 草稿是"待办设计"，不是"已完成设计"
3. **不写未经真机验证的"经验"**——AGENTS.md 已经强调过，net 那几层没在生产跑过
4. **每条信息标注 source**——是来自代码 / 文档 / 实测 / 推断
5. **定期 prune**——文档与代码脱节是最常见的老化，AGENTS.md 里也提醒过

## 跟全局 `~/.mavis/memory/` 的边界

| 维度 | 放哪 |
|---|---|
| "UartNode 这次改 TcpServer.ts 要 staging 24h 回归" | **本仓库** `.harness/docs/workflow/staging-regression.md` |
| "cairui 是 Node.js 后端，习惯用 bun" | **全局** `~/.mavis/memory/user.md` |
| "Socket.IO 4.7.5 的 transportOptions 用法" | **全局 agent** `~/.mavis/memory/agent-a1afa567aa0d.md` |
| "汉枫 HF2411 默认波特率 115200" | **本仓库** `.harness/docs/protocols/cellular-4g-dtu.md` |
