#!/usr/bin/env bash
# 2026-07-14 docs sync with v4 refactor (PR #1-#12)
# cairui session mvs_ee8e2927968b4aa6b51e7b5fc03442b8 起的，由于 session workspace
# 快照锁的 /Users/cairui/Code/UartNode (大写) 在 commit 前被我 trash 掉了，
# bash tool 全部 "Working directory does not exist" 失灵（user memory 2026-07-14 那条
# 坑），写完文档 + changelog 后无法 commit。
#
# 用法：新 session 起来后，cd 到 /Users/cairui/Code/uart-node，跑：
#   bash .harness/scripts/commit-docs-sync-2026-07-14.sh
#
# 拆 4 个 commit（每个 commit 一个主题，PR review 友好）：
#   1. docs(AGENTS): sync with v4 refactor
#   2. docs(README): sync with v4 refactor + add test section
#   3. docs(architecture): sync source-map + data-flow with v4 paths
#   4. docs(changelogs): record 2026-07-14 docs sync
# 然后 push。

set -euo pipefail

REPO="/Users/cairui/Code/uart-node"
cd "$REPO" || { echo "❌ cd failed: $REPO"; exit 1; }

echo "📍 repo: $REPO"
echo "🌿 branch: $(git branch --show-current)"
echo "📊 status:"
git status --short
echo ""

# 检查工作区干净（除了我们要 commit 的 5 个文件）
EXPECTED_CHANGES=(
  "M AGENTS.md"
  "M README.md"
  "M .harness/docs/architecture/source-map.md"
  "M .harness/docs/architecture/data-flow.md"
  "?? .harness/docs/changelogs/2026-07-14-docs-sync-v4.md"
  "?? .harness/scripts/commit-docs-sync-2026-07-14.sh"
)
ACTUAL=$(git status --short | sort)
EXPECTED_SORTED=$(printf '%s\n' "${EXPECTED_CHANGES[@]}" | sort)
if [ "$ACTUAL" != "$EXPECTED_SORTED" ]; then
  echo "⚠️  git status 跟预期不符，请人工检查："
  echo "Expected:"
  printf '  %s\n' "${EXPECTED_CHANGES[@]}"
  echo "Actual:"
  echo "$ACTUAL" | sed 's/^/  /'
  echo ""
  echo "如果只是多了/少了其他文件（比如 .harness/docs/changelogs/ 目录创建痕迹），"
  echo "继续 commit 也安全，但确认前先 abort。"
  read -rp "Continue? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "❌ aborted"; exit 1; }
fi

# ---- Commit 1: AGENTS.md ----
echo "📝 [1/4] AGENTS.md"
git add AGENTS.md
git commit -m "docs(AGENTS): sync with v4 refactor (PR #1-#12)

- 鉴权段加 src/IO.ts 顶层单例 vs src/services/io-client.ts class 化并存说明
- 未回归的运行时风险段文件路径从老 TcpServer.ts 改成 src/server/tcp-server.ts +
  src/server/register-handler.ts + src/dtus/cellular.ts
- 标 TcpServer.ts:37,49 NODE_ENV DCE bug 已被 PR #5 重构时修复（resolveListenPort 全 env 驱动）
- 当前协议支持范围段更新 8 条 AT 批量查顺序（PID/VER/GVER/IOTEN/ICCID/LOCATE/UART/GSLQ
  + IOTEN=off 关流量）+ 加 8 态状态机 + 5 类 alert 引用
- 已废弃代码段加 src/tool.ts 空占位说明
- 测试段从'没有测试'改成'201 tests / 198 pass / 3 fail / 10 files' + 3 fail 根因分析
- GitHub 段 repo 名 wgcairui/UartNode 大写 -> wgcairui/uart-node 小写 + gh CLI GH_TOKEN 踩坑提醒
- 仓库知识库引用路径从 src/TcpServer.ts 改成 src/server/tcp-server.ts 等"

# ---- Commit 2: README.md ----
echo ""
echo "📝 [2/4] README.md"
git add README.md
git commit -m "docs(README): sync with v4 refactor + add test section

- 架构图段 src/ 顶层 8 个文件 -> 14 个文件 + 4 个子目录（server/ dtus/ services/ protocol/）
- 4G 硬编码点表行号从老 client.ts:196 / TcpServer.ts:71-81 / tool.ts:35 等
  改成 v4 新路径（server/tcp-server.ts / server/register-handler.ts / dtus/cellular.ts
  / services/at-parse.ts 等）
- 已知 bug 残留段标 TcpServer.ts:37,49 NODE_ENV DCE 已被 PR #5 重构时清掉
- 加 '## 测试' 段：bun test 命令 + 10 spec 文件清单 + 3 fail 警示"

# ---- Commit 3: architecture/source-map.md + data-flow.md ----
echo ""
echo "📝 [3/4] architecture/source-map.md + data-flow.md"
git add .harness/docs/architecture/source-map.md
git add .harness/docs/architecture/data-flow.md
git commit -m "docs(architecture): sync source-map + data-flow with v4 paths

- 整文件重写，跟 v4 重构（RFC 002 PR #1-#12）落地后文件路径同步
- source-map.md 14 个 src/ 文件职责速查表（含行数 + 协议相关性 + 改 LAN 时动它）
- source-map.md 一图流更新到 v4 路径，关键调用链 2.1-2.4 改成 v4 新文件
- source-map.md 4G 硬编码点表改成 v4 新位置，5 段可复用层表加 dtus/base.ts / dtus/state.ts
  / protocol/events.ts / services/io-client.ts
- data-flow.md 端到端时序图更新 v4 路径
- data-flow.md §3 Node 主动事件加 v4 新 3 事件（dtuState / dtuHealth / dtuAlert）+ 5 类 alert
- data-flow.md §4 上行 HTTP 路径表 + 实现链路说明（src/fetch.ts API surface +
  src/services/uploader.ts 队列实现）
- data-flow.md §5 下行指令优先级代码块 this.Cache.push -> this.cache.push（小写，v4 base.ts）
- data-flow.md §6 加 'Dtu state 非法转换 -> PR #12 console.error + emit alert' +
  'Uploader 失败 -> 指数退避重试 2 次'
- data-flow.md 加 §7 鉴权链路 + §8 DTU ↔ Node 数据流 + §9 v3.3.0 vs v4 差异表"

# ---- Commit 4: changelogs + scripts ----
echo ""
echo "📝 [4/4] changelogs/ + scripts/"
git add .harness/docs/changelogs/2026-07-14-docs-sync-v4.md
git add .harness/scripts/commit-docs-sync-2026-07-14.sh
git commit -m "docs(changelogs): record 2026-07-14 docs sync with v4 refactor

- AGENTS.md / README.md / source-map.md / data-flow.md 各自改了啥
- 已知 3 fail 状态（test 顺序依赖，独立 PR 待修）
- PR #1 vs PR #5 双版本并存（src/IO.ts 顶层单例 vs src/services/io-client.ts class）
- LAN 接入 RFC 001 还在 draft，等 cairui 拍板
- commit 拆 4 个主题的决策记录
- 加 .harness/scripts/commit-docs-sync-2026-07-14.sh 解决 session workspace 快照坑"

echo ""
echo "✅ 4 commits created"
echo ""
echo "📜 Recent commits:"
git log --oneline -5
echo ""
echo "🚀 Push:"
echo "   git push origin main"
echo ""
echo "⚠️  注意：dev 机 github 直连 2026-07-14 起失败（user memory），push 走代理或 Tailscale SSH 中转："
echo "   HTTPS_PROXY=http://100.76.101.62:7890 git push origin main    # gost proxy"
echo "   # 或 Tailscale SSH 中转（生产端 clone -> tar 回传 -> rsync merge）"
