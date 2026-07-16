/**
 * 软 DTU WebView 主组件 — Sidebar + Header + Status bar 布局
 *
 * 布局（Apple SF dark mode）：
 *   ┌─Sidebar(200px)─┐ ┌─Header(56px)────────────────────┐
 *   │  透色 blur       │ │  软 DTU 控制台    [连接状态 pill]│
 *   │  ⚙ 软 DTU        │ ├─────────────────────────────────┤
 *   │  • 串口配置      │ │                                 │
 *   │  • AT 指令       │ │  [Current panel content]        │
 *   │  • HEX/ASCII     │ │   - 24px padding                │
 *   │  • 协议定义      │ │   - 卡片化表单                  │
 *   │  ⚙ 设置         │ │   - 表格 / 列表                 │
 *   │  ? 帮助          │ │                                 │
 *   └──────────────────┘ ├─Status bar(28px)────────────────┤
 *                       │ Server URL · 2 protocols · 状态  │
 *                       └─────────────────────────────────┘
 *
 * 4 个面板：
 *   1. SerialConfig   — 串口配置（选串口 + 波特率/数据位/停止位/校验）
 *   2. ATConsole      — AT 指令控制台（发 +++AT+XXX + 自动补全）
 *   3. HexView        — HEX/ASCII 实时数据视图
 *   4. ProtocolViewer — 协议定义浏览器（手动选协议，看 AT 指令 + 寄存器表）
 *
 * Health check 走 /api/health（5s 轮询），protocol count 从 /api/protocols 拿。
 */

import { useEffect, useState } from "preact/hooks";
import { SerialConfig } from "./panels/SerialConfig.tsx";
import { ATConsole } from "./panels/ATConsole.tsx";
import { HexView } from "./panels/HexView.tsx";
import { ProtocolViewer } from "./panels/ProtocolViewer.tsx";

type Tab = "serial" | "at" | "hex" | "protocol";
type Health = "connected" | "offline" | "error";

const NAV: Array<{ id: Tab; label: string; icon: string; hint: string }> = [
  { id: "serial",   label: "串口配置", icon: "🔌", hint: "选择并打开设备的串口" },
  { id: "at",       label: "AT 指令",  icon: "📡", hint: "跟软 DTU 收发 4G AT 指令" },
  { id: "hex",      label: "HEX/ASCII", icon: "📊", hint: "实时数据流 HEX/ASCII 切换" },
  { id: "protocol", label: "协议定义", icon: "📋", hint: "从 server 拉的协议目录" },
];

const SERVER_URL = "https://uart.ladishb.com";

export function App() {
  const [tab, setTab] = useState<Tab>("serial");
  const [health, setHealth] = useState<Health>("offline");
  const [protocolCount, setProtocolCount] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // Health check 5s 轮询
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (!cancelled) setHealth(r.ok ? "connected" : "error");
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

  const current = NAV.find((n) => n.id === tab)!;
  const healthLabel = health === "connected" ? "已连接" : health === "offline" ? "离线" : "异常";

  return (
    <div class="app">
      <aside class="sidebar" aria-label="主导航">
        <div class="sidebar-brand">⚙ 软 DTU</div>
        <nav class="sidebar-nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              class={`nav-item ${tab === n.id ? "active" : ""}`}
              onClick={() => setTab(n.id)}
              title={n.hint}
            >
              <span class="nav-icon" aria-hidden="true">{n.icon}</span>
              <span class="nav-label">{n.label}</span>
            </button>
          ))}
        </nav>
        <div class="sidebar-footer">
          <button class="nav-item" disabled title="Phase 2">
            <span class="nav-icon" aria-hidden="true">⚙</span>
            <span class="nav-label">设置</span>
          </button>
          <button class="nav-item" disabled title="Phase 2">
            <span class="nav-icon" aria-hidden="true">?</span>
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
          {tab === "serial"   && <SerialConfig />}
          {tab === "at"       && <ATConsole />}
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
          <span>UartNode · Deno Desktop · Phase 1</span>
          <span class="sep">·</span>
          <span>{new Date(now).toLocaleTimeString("zh-CN", { hour12: false })}</span>
        </footer>
      </div>
    </div>
  );
}
