/**
 * AT 指令控制台 — Apple SF card layout
 *
 * 顶部：协议选择（parse 正则匹配用）
 * 中部：suggestion chips + command input + Send
 * 底部：log (TX/RX 双向, ts + ascii + hex + parsed 注释)
 *
 * 跟 UartNode 端 src/dtus/cellular.ts:queryAT 1:1 兼容（响应 +ok=xxx / +err=xxx）
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { serial, protocol, uint8ToHex } from "../api.ts";
import type { ProtocolDefinition } from "../bindings.ts";

interface LogEntry {
  ts: number;
  dir: "tx" | "rx";
  ascii: string;
  hex: string;
  parsed?: string;
}

const HISTORY_MAX = 200;

export function ATConsole() {
  const [input, setInput] = useState("+++AT+");
  const [history, setHistory] = useState<LogEntry[]>([]);
  const [protocols, setProtocols] = useState<ProtocolDefinition[]>([]);
  const [activeProtoId, setActiveProtoId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 用 ref 跟踪最近一条 tx 的指令名（rx 来时回查 parse 正则）*/
  const lastTxCmdRef = useRef<string>("");

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

  /** 自动补全：按 PID/VER/GVER 等关键字推荐 */
  const suggestions = (() => {
    if (!activeProto?.atCommands) return [];
    const trimmed = input.replace(/^\+{3}AT\+/, "").toUpperCase();
    if (!trimmed) return activeProto.atCommands.map((c) => c.name);
    return activeProto.atCommands
      .filter((c) => c.name.toUpperCase().includes(trimmed))
      .map((c) => c.name);
  })();

  async function send() {
    setError(null);
    const cmd = input.endsWith("\r") ? input : input + "\r";
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
    } catch (err) {
      setError(`send 失败: ${(err as Error).message}`);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    } else if (e.key === "Tab" && suggestions.length > 0) {
      e.preventDefault();
      setInput(`+++AT+${suggestions[0]}`);
    }
  }

  return (
    <div class="at-console">
      <div class="panel-header">
        <h2 class="panel-title">AT 指令</h2>
        <p class="panel-subtitle">跟软 DTU 收发 4G AT 指令 · Tab 自动补全 · Enter 发送</p>
      </div>

      <section class="card">
        <div class="card-title">协议 (用于解析响应)</div>
        <div class="field">
          <select
            value={activeProtoId}
            onChange={(e) => setActiveProtoId((e.target as HTMLSelectElement).value)}
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
          <div class="suggestions">
            {suggestions.slice(0, 12).map((s) => (
              <button key={s} class="suggestion" onClick={() => setInput(`+++AT+${s}`)}>
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
          />
          <button class="primary large" onClick={send}>
            发送
          </button>
        </div>
      </section>

      <div class="log">
        {history.slice().reverse().map((e, idx) => (
          <div key={`${e.ts}-${idx}`} class={`log-entry log-${e.dir}`}>
            <span class="ts">{new Date(e.ts).toLocaleTimeString("zh-CN", { hour12: false })}</span>
            <span class="dir">{e.dir === "tx" ? "→" : "←"}</span>
            <span class="ascii">{e.ascii || "(空)"}</span>
            <span class="hex">{e.hex}</span>
            {e.parsed && <span class="parsed"> · {e.parsed}</span>}
          </div>
        ))}
      </div>

      {error && <div class="error">{error}</div>}
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
