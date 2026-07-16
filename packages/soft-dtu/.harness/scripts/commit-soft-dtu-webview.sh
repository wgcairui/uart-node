#!/usr/bin/env bash
# 2026-07-15 软 DTU webview framework commit
# 跑完 commit-soft-dtu-skeleton.sh 后再跑这个
# cairui session mvs_ee8e2927968b4aa6b51e7b5fc03442b8 起的，bash tool 之前因
# session workspace 快照锁的 /Users/cairui/Code/UartNode (大写) 被 trash 失灵。
#
# 用法：新 session 起来后，cd 到 /Users/cairui/Code/uart-node，跑：
#   bash packages/soft-dtu/.harness/scripts/commit-soft-dtu-skeleton.sh  # 先跑这个
#   bash packages/soft-dtu/.harness/scripts/commit-soft-dtu-webview.sh    # 再跑这个
#
# 拆 1 个 commit：
# feat(soft-dtu): webview framework + HTTP API stub (Phase 1 Day 4-5)
#
# 文件清单：
#   新增 15 个文件（14 webview/ + 1 src/server/http-api.ts）
#   修改 4 个文件（main.ts + deno.json + README.md + AGENTS.md）
#   + 这个 commit script 自己

set -euo pipefail

REPO="/Users/cairui/Code/uart-node"
cd "$REPO" || { echo "❌ cd failed: $REPO"; exit 1; }

# 前置检查：skeleton commit 必须先做
if ! git log --oneline | grep -q "feat(soft-dtu): scaffold Deno Desktop skeleton"; then
  echo "❌ 错误：skeleton commit 不存在"
  echo "   先跑: bash packages/soft-dtu/.harness/scripts/commit-soft-dtu-skeleton.sh"
  exit 1
fi

echo "📍 repo: $REPO"
echo "🌿 branch: $(git branch --show-current)"
echo "📊 status:"
git status --short
echo ""

# 检查 webview/ 范围文件（这个 commit 只关心 webview/ 框架 + HTTP stub + 相关配置）
WEBVIEW_FILES=(
  # 新增 15 个 webview/（含 .gitignore 防止 node_modules 被 commit）
  "?? packages/soft-dtu/webview/.gitignore"
  "?? packages/soft-dtu/webview/README.md"
  "?? packages/soft-dtu/webview/index.html"
  "?? packages/soft-dtu/webview/package.json"
  "?? packages/soft-dtu/webview/src/api.ts"
  "?? packages/soft-dtu/webview/src/App.tsx"
  "?? packages/soft-dtu/webview/src/bindings.ts"
  "?? packages/soft-dtu/webview/src/main.tsx"
  "?? packages/soft-dtu/webview/src/panels/ATConsole.tsx"
  "?? packages/soft-dtu/webview/src/panels/HexView.tsx"
  "?? packages/soft-dtu/webview/src/panels/ProtocolViewer.tsx"
  "?? packages/soft-dtu/webview/src/panels/SerialConfig.tsx"
  "?? packages/soft-dtu/webview/src/styles.css"
  "?? packages/soft-dtu/webview/tsconfig.json"
  "?? packages/soft-dtu/webview/vite.config.ts"
  # 新增 HTTP API stub
  "?? packages/soft-dtu/src/server/http-api.ts"
  # commit script 自己
  "?? packages/soft-dtu/.harness/scripts/commit-soft-dtu-webview.sh"
)
MODIFIED_FILES=(
  " M packages/soft-dtu/AGENTS.md"
  " M packages/soft-dtu/README.md"
  " M packages/soft-dtu/deno.json"
  " M packages/soft-dtu/main.ts"
)

# 拼成完整预期（untracked + modified）
ALL_EXPECTED=("${WEBVIEW_FILES[@]}" "${MODIFIED_FILES[@]}")
EXPECTED_SORTED=$(printf '%s\n' "${ALL_EXPECTED[@]}" | sort)
ACTUAL=$(git status --short | grep -E 'packages/soft-dtu/(\.harness/scripts/commit-soft-dtu-webview|webview/|src/server/http-api|AGENTS|README|deno\.json|main\.ts)' | sort)
# 宽松检查：所有 EXPECTED 必须在 ACTUAL 里（ACTUAL 可以更多，未来加文件不影响）
MISSING=$(comm -23 <(echo "$EXPECTED_SORTED") <(echo "$ACTUAL"))
if [ -n "$MISSING" ]; then
  echo "❌ 缺少预期文件（webview 范围）："
  echo "$MISSING" | sed 's/^/  /'
  echo ""
  echo "实际 ACTUAL（仅 webview 范围）："
  echo "$ACTUAL" | sed 's/^/  /'
  echo ""
  echo "如果上面列出的 'missing' 文件其实存在但 git status 没显示，可能在 .gitignore 里"
  echo "（如 webview/node_modules/），这种情况可以忽略。"
  echo ""
  read -rp "Continue? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "❌ aborted"; exit 1; }
fi

# ---- Commit 1: webview framework + HTTP API stub ----
echo ""
echo "📝 [1/1] packages/soft-dtu/ webview framework + HTTP API stub"

# 加 webview/ 全部文件
git add packages/soft-dtu/webview/
# 加 HTTP API stub
git add packages/soft-dtu/src/server/http-api.ts
# 加修改的 4 个配置/文档文件
git add packages/soft-dtu/AGENTS.md \
        packages/soft-dtu/README.md \
        packages/soft-dtu/deno.json \
        packages/soft-dtu/main.ts
# 加这个 commit script
git add packages/soft-dtu/.harness/scripts/commit-soft-dtu-webview.sh

git commit -m "feat(soft-dtu): webview framework + HTTP API stub (Phase 1 Day 4-5)

新增 webview/ 子项目 — 软 DTU 控制台 UI 层（Vite + Preact + TypeScript）：

- 4 个面板：
  1. 串口配置：选串口 + 波特率/数据位/停止位/校验 + open/close
  2. AT 指令控制台：发 +++AT+XXX + Tab 自动补全 + 解析响应
  3. HEX/ASCII 实时数据视图：HEX / ASCII / 双视图切换 + 暂停 + 清空
  4. 协议定义浏览器：浏览 server 拉来的协议 + 手动选 + AT/寄存器表

- HTTP API 端点（src/server/http-api.ts，Phase 1 stub）：
  - GET  /api/serial/list
  - POST /api/serial/open
  - POST /api/serial/close
  - POST /api/serial/write
  - GET  /api/serial/status
  - GET  /api/serial/stream?channel=data|error|close (SSE)
  - GET  /api/protocols
  - GET  /api/protocols/refresh
  - GET  /api/health

- 字段契约（webview/src/bindings.ts）1:1 跟 Deno 端
  src/bindings/{serial,protocol}.ts 对齐 —— 改字段名必 ping sibling
  （user memory '跨 worker 字段名约定'）

设计原则：
- 双进程 dev 工作流：Deno 后端 (8080) + Vite dev server (5173)，Vite proxy /api → 8080
- WebView 走 HTTP fetch（Phase 1），Phase 2 切 Deno Desktop official bindings SDK
  （window.bindings.* 直接 IPC 调 Deno runtime，无 HTTP）
- 协议让用户手动选（UI 启动不预选，Cairui 2026-07-14 16:35 拍板）
- 类型契约 1:1 跟 server-api-contract.md 对齐（server 端待 ping sibling）

修改文件：
- main.ts          # 启动 HTTP API server（包装 bindings 给 WebView fetch）
- deno.json        # 加 webview:install / webview:dev / webview:build 任务
- README.md        # 更新开发工作流 + 文件结构
- AGENTS.md        # 加 WebView 双进程 dev 工作流 + HTTP API 端点表

待办（不在本次 commit 范围）：
- protocol/cellular-dtu.ts 跟 UartNode TCP 握手 + 8 条 AT 响应跑通
- server 端 GET /api/v2/protocols 端点（已落地 dev，prod 待 push）
- Modbus RTU 协议实现（485 设备用）— Phase 1 Day 6
- 端到端集成测试 — Phase 2
- 切 Deno Desktop bindings SDK（删 http-api.ts）— Phase 2"

echo ""
echo "✅ 1 commit created"
echo ""
echo "📜 Recent commits:"
git log --oneline -5
echo ""
echo "🚀 Push:"
echo "   git push origin main"
echo ""
echo "⚠️  dev 机 github 直连 2026-07-14 起失败（user memory），push 走代理或 Tailscale 中转："
echo "   HTTPS_PROXY=http://100.76.101.62:7890 git push origin main    # gost proxy（已下线）"
echo "   # 或 Tailscale SSH 中转（生产端 clone -> tar 回传 -> rsync merge）"
