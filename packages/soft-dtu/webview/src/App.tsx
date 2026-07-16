/**
 * 软 DTU WebView 主组件 — Sidebar + Header + Status bar 布局
 *
 * 布局（Apple SF dark mode）：
 *   ┌─Sidebar(200px)─┐ ┌─Header(56px)────────────────────┐
 *   │  透色 blur       │ │  软 DTU 控制台    [连接状态 pill]│
 *   │  ⚙ 软 DTU        │ ├─────────────────────────────────┤
 *   │  • 串口配置 ⌘1   │ │                                 │
 *   │  • AT 指令  ⌘2   │ │  [Current panel content]        │
 *   │  • HEX/ASCII⌘3   │ │   - 24px padding                │
 *   │  • 协议定义 ⌘4   │ │   - 卡片化表单                  │
 *   │  ⚙ 设置          │ │   - 表格 / 列表                  │
 *   │  ? 帮助          │ │                                 │
 *   └──────────────────┘ ├─Status bar(28px)────────────────┤
 *                       │ Server URL · protocols · last sync│
 *                       └─────────────────────────────────┘
 *
 * 4 个面板：
 *   1. SerialConfig   — 串口配置（选串口 + 波特率/数据位/停止位/校验）
 *   2. ATConsole      — AT 指令控制台（发 +++AT+XXX + 自动补全 + 历史 + Tab）
 *   3. HexView        — HEX/ASCII 实时数据视图（三栏 16B/行）
 *   4. ProtocolViewer — 协议定义浏览器（empty state + meta-grid + AT 表 + 寄存器表）
 *
 * 接力补的 12 项细化（在 cronId 02760e66 worker 基础上）：
 *   1. SVG icons (替换 emoji) — src/icons.tsx
 *   2. Status pill pulse 动画 — status-pill.connected::before animation
 *   3. Focus ring (button/input) — :focus-visible outline
 *   4. Empty state 组件 — src/components/EmptyState.tsx
 *   5. Error banner (icon + dismiss) — src/components/ErrorBanner.tsx
 *   6. Toast (右下角, 3s 消失) — src/components/Toast.tsx
 *   7. Keyboard shortcut (Cmd+1/2/3/4) — 本文件 useEffect
 *   8. AT console history (↑↓) + Cmd+Enter + Clear log + auto-scroll
 *   9. HEX view 三栏对齐 (offset/hex/ascii, 16B/行) — HexView.tsx
 *  10. ProtocolViewer meta-grid SF card 风格 — ProtocolViewer.tsx
 *  11. Status bar "last sync" 指示 — 本文件 + Health check 5s 轮询
 *  12. Segmented control pill SF 风格 — styles.css .seg 微调
 *
 * Health check 走 /api/health（5s 轮询），protocol count 从 /api/protocols 拿。
 * last sync: health 200 时更新时间, 显示"已同步 HH:MM:SS" / "从未同步"。
 */

import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { SerialConfig } from "./panels/SerialConfig.tsx";
import { ATConsole } from "./panels/ATConsole.tsx";
import { HexView } from "./panels/HexView.tsx";
import { ProtocolViewer } from "./panels/ProtocolViewer.tsx";
import {
  IconSerial,
  IconAT,
  IconHex,
  IconProtocol,
  IconSettings,
  IconHelp,
} from "./icons.tsx";
import { ToastStack, useToasts } from "./components/Toast.tsx";

type Tab = "serial" | "at" | "hex" | "protocol";
type Health = "connected" | "offline" | "error";

const NAV: Array<{
  id: Tab;
  label: string;
  Icon: () => JSX.Element;
  hint: string;
  shortcut: string;
}> = [
  { id: "serial",   label: "串口配置", Icon: IconSerial,   hint: "选择并打开设备的串口",  shortcut: "⌘1" },
  { id: "at",       label: "AT 指令",  Icon: IconAT,       hint: "跟软 DTU 收发 4G AT 指令", shortcut: "⌘2" },
  { id: "hex",      label: "HEX/ASCII", Icon: IconHex,     hint: "实时数据流 HEX/ASCII 切换", shortcut: "⌘3" },
  { id: "protocol", label: "协议定义", Icon: IconProtocol, hint: "从 server 拉的协议目录",  shortcut: "⌘4" },
];

const SERVER_URL = "https://uart.ladishb.com";

export function App() {
  const [tab, setTab] = useState<Tab>("serial");
  const [health, setHealth] = useState<Health>("offline");
  const [protocolCount, setProtocolCount] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const { toasts, push } = useToasts();

  // Health check 5s 轮询 — 成功时更新 lastSync
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (!cancelled) {
          if (r.ok) {
            setHealth("connected");
            setLastSync(new Date());
          } else {
            setHealth("error");
          }
        }
      } catch {
        if (!cancelled) setHealth("offline");
      }
    };
    check();
    const t = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Protocol count: 切到 protocol tab 时刷新, 其它时间后台静默
  useEffect(() => {
    let cancelled = false;
    fetch("/api/protocols")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          const n = Array.isArray(d?.protocols) ? d.protocols.length : 0;
          setProtocolCount(n);
        }
      })
      .catch(() => {
        if (!cancelled) setProtocolCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  // 时钟（status bar 显示用）
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // 键盘快捷键: Cmd+1/2/3/4 切面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        const next = NAV[idx]?.id;
        if (next && next !== tab) {
          setTab(next);
          push({ text: `切换到 ${NAV[idx].label}`, duration: 1800 });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, push]);

  const current = NAV.find((n) => n.id === tab)!;
  const healthLabel = health === "connected" ? "已连接" : health === "offline" ? "离线" : "异常";

  // last sync 文案 + freshness 状态
  const lastSyncClass = !lastSync
    ? "never"
    : Date.now() - lastSync.getTime() < 30_000
    ? "fresh"
    : "";
  const lastSyncText = !lastSync
    ? "从未同步"
    : `已同步 ${lastSync.toLocaleTimeString("zh-CN", { hour12: false })}`;

  return (
    <div class="app">
      <aside class="sidebar" aria-label="主导航">
        <div class="sidebar-brand">
          <span class="sidebar-brand-mark" aria-hidden="true">
            <IconSettings />
          </span>
          <span>软 DTU</span>
        </div>
        <nav class="sidebar-nav">
          {NAV.map((n) => {
            const Icon = n.Icon;
            return (
              <button
                key={n.id}
                class={`nav-item ${tab === n.id ? "active" : ""}`}
                onClick={() => setTab(n.id)}
                title={n.hint}
                aria-current={tab === n.id ? "page" : undefined}
              >
                <span class="nav-icon" aria-hidden="true"><Icon /></span>
                <span class="nav-label">{n.label}</span>
                <span class="nav-shortcut" aria-label={`快捷键 ${n.shortcut}`}>
                  {n.shortcut}
                </span>
              </button>
            );
          })}
        </nav>
        <div class="sidebar-footer">
          <button class="nav-item" disabled title="Phase 2">
            <span class="nav-icon" aria-hidden="true"><IconSettings /></span>
            <span class="nav-label">设置</span>
          </button>
          <button class="nav-item" disabled title="Phase 2">
            <span class="nav-icon" aria-hidden="true"><IconHelp /></span>
            <span class="nav-label">帮助</span>
          </button>
        </div>
      </aside>

      <div class="main">
        <header class="app-header">
          <div class="header-text">
            <h1 class="header-title">{current.label}</h1>
            <p class="header-subtitle">{current.hint}</p>
          </div>
          <span class={`status-pill ${health}`} title={`Server: ${SERVER_URL}`}>
            {healthLabel}
          </span>
        </header>

        <main class="panel" key={tab}>
          {tab === "serial"   && <SerialConfig onSuccess={(msg) => push({ text: msg })} />}
          {tab === "at"       && <ATConsole onSuccess={(msg) => push({ text: msg })} />}
          {tab === "hex"      && <HexView />}
          {tab === "protocol" && <ProtocolViewer />}
        </main>

        <footer class="status-bar">
          <span>
            <span class={`indicator ${health}`}></span>
            {healthLabel}
          </span>
          <span class="sep">·</span>
          <span>Server: {SERVER_URL}</span>
          <span class="sep">·</span>
          <span>
            {protocolCount !== null ? `${protocolCount} protocols` : "— protocols"}
          </span>
          <span class="spacer"></span>
          <span class={`last-sync ${lastSyncClass}`}>{lastSyncText}</span>
          <span class="sep">·</span>
          <span>UartNode · Deno Desktop · Phase 1</span>
          <span class="sep">·</span>
          <span>{new Date(now).toLocaleTimeString("zh-CN", { hour12: false })}</span>
        </footer>
      </div>

      <ToastStack toasts={toasts} />
    </div>
  );
}
