/**
 * 软 DTU WebView 主组件 — Tab 路由
 *
 * 4 个面板：
 *   1. SerialConfig  — 串口配置（选串口 + 波特率/数据位/停止位/校验）
 *   2. ATConsole    — AT 指令控制台（发 +++AT+XXX + 自动补全）
 *   3. HexView      — HEX/ASCII 实时数据视图
 *   4. ProtocolViewer — 协议定义浏览器（手动选协议，看 AT 指令 + 寄存器表）
 */

import { useState } from "preact/hooks";
import { SerialConfig } from "./panels/SerialConfig.tsx";
import { ATConsole } from "./panels/ATConsole.tsx";
import { HexView } from "./panels/HexView.tsx";
import { ProtocolViewer } from "./panels/ProtocolViewer.tsx";

type Tab = "serial" | "at" | "hex" | "protocol";

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: "serial", label: "串口配置", hint: "选串口 + 波特率/数据位/停止位/校验" },
  { id: "at", label: "AT 指令", hint: "发 +++AT+XXX + 自动补全" },
  { id: "hex", label: "HEX/ASCII", hint: "实时数据流 HEX/ASCII 切换" },
  { id: "protocol", label: "协议定义", hint: "从 server 拉的协议目录" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("serial");

  return (
    <div class="app">
      <header class="app-header">
        <h1>软 DTU 控制台</h1>
        <span class="subtitle">UartNode · Deno Desktop · Phase 1</span>
      </header>

      <nav class="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            class={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main class="panel">
        {tab === "serial" && <SerialConfig />}
        {tab === "at" && <ATConsole />}
        {tab === "hex" && <HexView />}
        {tab === "protocol" && <ProtocolViewer />}
      </main>
    </div>
  );
}
