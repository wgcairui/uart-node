#!/usr/bin/env bash
# 2026-07-14 软 DTU skeleton commit
# cairui session mvs_ee8e2927968b4aa6b51e7b5fc03442b8 起的，bash tool 之前因
# session workspace 快照锁的 /Users/cairui/Code/UartNode (大写) 被 trash 失灵，
# 写完第一波代码后无法 commit。
#
# 用法：新 session 起来后，cd 到 /Users/cairui/Code/uart-node，跑：
#   bash packages/soft-dtu/.harness/scripts/commit-soft-dtu-skeleton.sh
#
# 拆 1 个 commit：
# feat(soft-dtu): scaffold Deno Desktop skeleton (Phase 1 Day 1)
#
# 自动处理（无交互）：
#   1. git rm src/transport/socketio.ts（Cairui 2026-07-14 16:29 拍板不连 Socket.IO）
#   2. git add 剩余 13 个新文件
#   3. git commit

set -euo pipefail

REPO="/Users/cairui/Code/uart-node"
cd "$REPO" || { echo "❌ cd failed: $REPO"; exit 1; }

echo "📍 repo: $REPO"
echo "🌿 branch: $(git branch --show-current)"
echo "📊 status:"
git status --short
echo ""

# 检查工作区 — 这次只检查 Day 1 skeleton 14 个文件
# （webview/ 框架由 commit-soft-dtu-webview.sh 单独 commit）
SKELETON_UNTRACKED=(
  "?? packages/soft-dtu/.harness/scripts/commit-soft-dtu-skeleton.sh"
  "?? packages/soft-dtu/AGENTS.md"
  "?? packages/soft-dtu/README.md"
  "?? packages/soft-dtu/deno.json"
  "?? packages/soft-dtu/main.ts"
  "?? packages/soft-dtu/src/bindings/protocol.ts"
  "?? packages/soft-dtu/src/bindings/serial.ts"
  "?? packages/soft-dtu/src/protocol/at-handler.ts"
  "?? packages/soft-dtu/src/protocol/cellular-dtu.ts"
  "?? packages/soft-dtu/src/protocol/config.ts"
  "?? packages/soft-dtu/src/protocol/protocol-catalog.ts"
  "?? packages/soft-dtu/src/transport/serial.ts"
  "?? packages/soft-dtu/src/transport/socketio.ts"
  "?? packages/soft-dtu/src/transport/tcp.ts"
)
ACTUAL=$(git status --short | grep -E 'packages/soft-dtu/(AGENTS|README|deno\.json|main\.ts|\.harness|src/(protocol|transport|bindings)/)' | sort)
EXPECTED_SORTED=$(printf '%s\n' "${SKELETON_UNTRACKED[@]}" | sort)
# 宽松检查：所有 EXPECTED 必须在 ACTUAL 里（ACTUAL 可以更多，webview/ 等未来文件不影响）
MISSING=$(comm -23 <(echo "$EXPECTED_SORTED") <(echo "$ACTUAL"))
if [ -n "$MISSING" ]; then
  echo "❌ 缺少预期文件（skeleton 范围）："
  echo "$MISSING" | sed 's/^/  /'
  echo ""
  echo "实际 ACTUAL（仅 skeleton 范围）："
  echo "$ACTUAL" | sed 's/^/  /'
  echo ""
  read -rp "Continue? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "❌ aborted"; exit 1; }
fi

# 自动 git rm socketio.ts（Cairui 2026-07-14 16:29 拍板不连 Socket.IO）
echo "🗑️  自动 git rm src/transport/socketio.ts（已废弃）"
git rm -f packages/soft-dtu/src/transport/socketio.ts

# ---- Commit 1: 软 DTU skeleton ----
# 只 add Day 1 的 13 个新文件（去掉 webview/，那个走单独 commit）
echo ""
echo "📝 [1/1] packages/soft-dtu/ Day 1 skeleton"
git add \
  packages/soft-dtu/.harness/scripts/commit-soft-dtu-skeleton.sh \
  packages/soft-dtu/AGENTS.md \
  packages/soft-dtu/README.md \
  packages/soft-dtu/deno.json \
  packages/soft-dtu/main.ts \
  packages/soft-dtu/src/bindings/protocol.ts \
  packages/soft-dtu/src/bindings/serial.ts \
  packages/soft-dtu/src/protocol/at-handler.ts \
  packages/soft-dtu/src/protocol/cellular-dtu.ts \
  packages/soft-dtu/src/protocol/config.ts \
  packages/soft-dtu/src/protocol/protocol-catalog.ts \
  packages/soft-dtu/src/transport/serial.ts \
  packages/soft-dtu/src/transport/tcp.ts
git commit -m "feat(soft-dtu): scaffold Deno Desktop skeleton (Phase 1 Day 1)

新增 packages/soft-dtu/ 软 DTU 子项目（Cairui 2026-07-14 拍板）：

- Deno 2.9 desktop runtime（vs UartNode 主项目 Bun runtime）
- 伪装汉枫 4G DTU 走 TCP 9000 + 注册包 + +++AT+ 协议，UartNode 0 改动
- 8 条 AT 响应（PID/VER/GVER/IOTEN/ICCID/LOCATE/UART/GSLQ）跟 UartNode 端
  cellular.ts:queryAT 1:1 兼容
- USB 转 485 串口（npm:serialport，Phase 1 Day 4-5 接入 UI）
- 协议定义走 HTTP API 从 server 拉（GET /api/v2/protocols，5min 缓存 + offline fallback）
- bindings 暴露 IPC API 给 WebView 前端（Preact + Vite，Phase 1 Day 4-5）

设计原则（Cairui 2026-07-14 16:29 + 16:35 拍板）：
- 数据通道：软 DTU 跟普通硬件 DTU 一样，TCP 9000 + 4G 协议，UartNode 代理上行
- 元数据通道：软 DTU 走 HTTP API 从 server 拉协议定义，硬件 DTU 固件内固化
- HTTP API 不鉴权（dev/内网），生产要加 Bearer token
- 不连 Socket.IO（src/transport/socketio.ts 已 git rm）
- 协议让用户手动选，UI 启动不预选
- 协议响应 schema 必须 ping agent-ae682922673b 拍板（见 ProtocolDefinition）

项目结构（packages/soft-dtu/）：
- deno.json              # Deno workspace config + tasks
- main.ts                # Deno runtime 入口
- README.md              # 项目说明 + 跟 server 端对接
- AGENTS.md              # agent 记忆（项目级约束）
- src/protocol/          # 4G DTU 协议模拟 + 协议仓库
  - cellular-dtu.ts      # 4G DTU 行为（注册 + 8 条 AT 响应）
  - at-handler.ts        # AT 指令响应生成
  - config.ts            # 虚拟 IMEI / PID / VER / 串口配置 / server URL
  - protocol-catalog.ts  # ProtocolRepository（HTTP fetch + 缓存 + offline fallback）
- src/transport/         # 底层 transport
  - tcp.ts               # TCP client 连 UartNode:9000
  - serial.ts            # 串口（npm:serialport）
- src/bindings/          # IPC bindings（WebView → Deno）
  - serial.ts            # 串口操作 IPC
  - protocol.ts          # 协议目录 IPC（走 HTTP API）

server 端必须改（待 ping agent-ae682922673b）：
- GET /api/v2/protocols 端点（返回 ProtocolDefinition[]）
- 不鉴权（dev/内网）
- 不需要 Socket.IO namespace 放行

待办（不在本次 commit 范围，由 commit-soft-dtu-webview.sh 单独 commit）：
- webview/ 骨架（Vite + Preact + 4 面板 + HTTP API stub）— Phase 1 Day 4-5
- Modbus RTU 协议实现（485 设备用）— Phase 1 Day 6
- server 端 GET /api/v2/protocols 端点 — 待 ping agent-ae682922673b
- 端到端集成测试 — Phase 2"

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
echo "   HTTPS_PROXY=http://100.76.101.62:7890 git push origin main    # gost proxy"
echo "   # 或 Tailscale SSH 中转（生产端 clone -> tar 回传 -> rsync merge）"
