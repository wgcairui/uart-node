/**
 * AT 指令控制台 — Apple SF card layout
 *
 * 顶部：协议选择（parse 正则匹配用）
 * 中部：suggestion chips + command input + Send
 * 底部：log (TX/RX 双向, ts + ascii + hex + parsed 注释)
 *
 * 接力补的细节:
 *   - 命令历史 (↑↓ 翻历史, in-memory 数组)
 *   - Tab 自动补全 (前 worker 已加)
 *   - Cmd+Enter / Ctrl+Enter 触发发送
 *   - Clear log 按钮 (顶部 toolbar 右侧)
 *   - Auto-scroll (新 log 进来自动滚到底)
 *   - ErrorBanner 替换简单 .error
 *   - 底部 toolbar 显示快捷键 kbd hints
 *   - onSuccess 回调 (发送成功 toast)
 *
 * 跟 UartNode 端 src/dtus/cellular.ts:queryAT 1:1 兼容（响应 +ok=xxx / +err=xxx）
 */

import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { serial, protocol, uint8ToHex } from "../api.ts";
import type { ProtocolDefinition } from "../bindings.ts";
import { ErrorBanner } from "../components/ErrorBanner.tsx";
import { IconSend, IconTrash } from "../icons.tsx";

interface LogEntry {
  ts: number;
  dir: "tx" | "rx";
  ascii: string;
  hex: string;
  parsed?: string;
}

const HISTORY_MAX = 200;
const CMD_HISTORY_MAX = 50;

export interface ATConsoleProps {
  /** AT 发送成功时的 toast 提示 */
  onSuccess?: (msg: string) => void;
}

export function ATConsole({ onSuccess }: ATConsoleProps = {}) {
  const [input, setInput] = useState("+++AT+");
  const [history, setHistory] = useState<LogEntry[]>([]);
  const [protocols, setProtocols] = useState<ProtocolDefinition[]>([]);
  const [activeProtoId, setActiveProtoId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  /** 用 ref 跟踪最近一条 tx 的指令名（rx 来时回查 parse 正则）*/
  const lastTxCmdRef = useRef<string>("");
  /** 命令历史: ↑↓ 翻历史, 不持久化 */
  const cmdHistoryRef = useRef<string[]>([]);
  /** 历史指针 (-1 表示当前 input) */
  const histIdxRef = useRef<number>(-1);
  /** 在浏览历史时暂存当前 input (返回时还原) */
  const histDraftRef = useRef<string>("");

  const activeProto = protocols.find((p) => p.id === activeProtoId);

  // 拉协议目录（自动补全用）
  useEffect(() => {
    protocol.list()
      .then((list) => {
        setProtocols(list);
        // 默认选第一个 4G DTU 协议（手动选 phase 1 留 todo）
        const first4G = list.find((p) => p.type === "cellular-4g-dtu");
        if (first4G) setActiveProtoId(first4G.id);
      })
      .catch((err) => setError(`协议拉取失败: ${(err as Error).message}`));
  }, []);

  // 订阅串口数据（activeProto 变化时重新订阅，让 parseResponse 拿到最新协议）
  useEffect(() => {
    const unsub = serial.onData((data) => {
      const ascii = new TextDecoder("utf-8", { fatal: false }).decode(data);
      const hex = uint8ToHex(data);
      const parsed = parseResponse(ascii, lastTxCmdRef.current, activeProto);
      const entry: LogEntry = { ts: Date.now(), dir: "rx", ascii, hex, parsed };
      setHistory((h) => [...h, entry].slice(-HISTORY_MAX));
    });
    return unsub;
  }, [activeProto]);

  // Auto-scroll: 新 log 时滚到底（如果用户没手动滚上去）
  useEffect(() => {
    const el = logEndRef.current?.parentElement;
    if (!el) return;
    // 阈值: 距离底部 ≤ 60px 算"在底部", 跟着滚
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 60) {
      logEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [history.length]);

  /** 自动补全：按 PID/VER/GVER 等关键字推荐 */
  const suggestions = (() => {
    if (!activeProto?.atCommands) return [];
    const trimmed = input.replace(/^\+{3}AT\+/, "").toUpperCase();
    if (!trimmed) return activeProto.atCommands.map((c) => c.name);
    return activeProto.atCommands
      .filter((c) => c.name.toUpperCase().includes(trimmed))
      .map((c) => c.name);
  })();

  const send = useCallback(async () => {
    setError(null);
    const cmd = input.endsWith("\r") ? input : input + "\r";
    if (cmd.replace(/\r/g, "").trim() === "") return;
    const data = new TextEncoder().encode(cmd);
    try {
      await serial.write(data);
      // 记录最近一条 tx 的指令名（rx 来时回查 parse）
      const cmdName = cmd.replace(/^\+{3}AT\+/, "").replace(/\r$/, "").trim().split("=")[0];
      lastTxCmdRef.current = cmdName;
      setHistory((h) => [
        ...h,
        {
          ts: Date.now(),
          dir: "tx" as const,
          ascii: cmd.replace(/\r$/, ""),
          hex: uint8ToHex(data),
        },
      ].slice(-HISTORY_MAX));
      // 记录到命令历史（去重, push 到末尾）
      const trimmed = cmd.replace(/\r$/, "").trim();
      const h = cmdHistoryRef.current;
      if (trimmed && h[h.length - 1] !== trimmed) {
        h.push(trimmed);
        if (h.length > CMD_HISTORY_MAX) h.shift();
      }
      histIdxRef.current = -1;
      onSuccess?.(`已发送: ${trimmed}`);
    } catch (err) {
      setError(`send 失败: ${(err as Error).message}`);
    }
  }, [input, onSuccess]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      // Cmd+Enter / Ctrl+Enter 也走 send（普通 Enter 走 send + 阻止默认）
      e.preventDefault();
      send();
    } else if (e.key === "Tab" && suggestions.length > 0) {
      e.preventDefault();
      setInput(`+++AT+${suggestions[0]}`);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const h = cmdHistoryRef.current;
      if (h.length === 0) return;
      if (histIdxRef.current === -1) {
        histDraftRef.current = input;
        histIdxRef.current = h.length - 1;
      } else if (histIdxRef.current > 0) {
        histIdxRef.current -= 1;
      }
      setInput(h[histIdxRef.current]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const h = cmdHistoryRef.current;
      if (histIdxRef.current === -1) return;
      if (histIdxRef.current < h.length - 1) {
        histIdxRef.current += 1;
        setInput(h[histIdxRef.current]);
      } else {
        // 回到当前 draft
        histIdxRef.current = -1;
        setInput(histDraftRef.current);
      }
    }
  }

  function clearLog() {
    setHistory([]);
  }

  return (
    <div class="at-console">
      <div class="panel-header">
        <h2 class="panel-title">AT 指令</h2>
        <p class="panel-subtitle">
          跟软 DTU 收发 4G AT 指令 · Tab 自动补全 · ↑↓ 命令历史 · Enter 发送
        </p>
      </div>

      {error && (
        <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner>
      )}

      <section class="card">
        <div class="card-title">协议 (用于解析响应)</div>
        <div class="field">
          <select
            value={activeProtoId}
            onChange={(e) => setActiveProtoId((e.target as HTMLSelectElement).value)}
            aria-label="选择协议 (用于解析响应)"
          >
            <option value="">（不解析）</option>
            {protocols.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.atCommands?.length ?? 0} AT)
              </option>
            ))}
          </select>
        </div>
      </section>

      <section class="card" style={{ flexShrink: 0 }}>
        <div class="card-title">命令</div>

        {suggestions.length > 0 && (
          <div class="suggestions" role="listbox" aria-label="AT 指令建议">
            {suggestions.slice(0, 12).map((s) => (
              <button
                key={s}
                class="suggestion"
                onClick={() => setInput(`+++AT+${s}`)}
                role="option"
                aria-selected="false"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <div class="field-row" style={{ alignItems: "stretch" }}>
          <input
            ref={inputRef}
            type="text"
            class="cmd-input"
            value={input}
            onInput={(e) => setInput((e.target as HTMLInputElement).value)}
            onKeyDown={onKeyDown}
            spellcheck={false}
            placeholder="+++AT+PID"
            aria-label="AT 指令输入"
            autoComplete="off"
          />
          <button class="primary large" onClick={send}>
            <IconSend />
            发送
          </button>
        </div>

        <div class="cmd-toolbar">
          <span><span class="kbd">Tab</span> 补全</span>
          <span><span class="kbd">↑</span><span class="kbd">↓</span> 历史</span>
          <span><span class="kbd">⌘</span><span class="kbd">⏎</span> 发送</span>
          <span style={{ marginLeft: "auto" }}>
            {cmdHistoryRef.current.length} 条历史
          </span>
        </div>
      </section>

      <div class="log" role="log" aria-live="polite" aria-label="AT 指令日志">
        <div class="log-toolbar">
          <span class="label">日志 · {history.length} 条</span>
          <button onClick={clearLog} disabled={history.length === 0}>
            <IconTrash />
            清空
          </button>
        </div>
        {history.slice().reverse().map((e, idx) => (
          <div key={`${e.ts}-${idx}`} class={`log-entry log-${e.dir}`}>
            <span class="ts">
              {new Date(e.ts).toLocaleTimeString("zh-CN", { hour12: false })}
            </span>
            <span class="dir">{e.dir === "tx" ? "→" : "←"}</span>
            <span class="ascii">{e.ascii || "(空)"}</span>
            <span class="hex">{e.hex}</span>
            {e.parsed && <span class="parsed"> · {e.parsed}</span>}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}

/** 解析响应：按协议定义里的 parse 正则匹配 */
function parseResponse(
  ascii: string,
  cmdName: string,
  proto: ProtocolDefinition | undefined,
): string | undefined {
  if (!proto?.atCommands || !cmdName) return undefined;
  const at = proto.atCommands.find((c) => c.name === cmdName);
  if (!at) return undefined;
  try {
    const re = new RegExp(at.parse);
    const m = ascii.match(re);
    return m ? `${at.name} → ${m[1] ?? m[0]}` : "不匹配";
  } catch {
    return undefined;
  }
}
