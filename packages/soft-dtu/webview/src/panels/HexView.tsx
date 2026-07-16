/**
 * HEX/ASCII 实时数据视图 — Apple SF card layout
 *
 * 顶部：segmented control (HEX / ASCII / 双向) + 暂停开关 (SF toggle) + 清空 + 计数
 * 中部：hex log (ts + hex + ascii 三栏)
 *
 * 跟 XCOM / sscom 的"显示"面板等价，但走软 DTU 通道
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { serial, uint8ToHex } from "../api.ts";

type ViewMode = "hex" | "ascii" | "both";

interface Frame {
  ts: number;
  bytes: Uint8Array;
}

const BUFFER_MAX = 500;

function bytesToAscii(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
    .join("");
}

export function HexView() {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [mode, setMode] = useState<ViewMode>("both");
  const [paused, setPaused] = useState(false);
  const [error] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = serial.onData((data) => {
      if (paused) return;
      setFrames((prev) => {
        const next = [...prev, { ts: Date.now(), bytes: data }];
        return next.length > BUFFER_MAX ? next.slice(-BUFFER_MAX) : next;
      });
    });
    return unsub;
  }, [paused]);

  // 自动滚动
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [frames.length]);

  function clear() {
    setFrames([]);
  }

  return (
    <div class="hex-view">
      <div class="panel-header">
        <h2 class="panel-title">HEX/ASCII</h2>
        <p class="panel-subtitle">实时数据流 HEX / ASCII 切换 · 缓冲 500 帧</p>
      </div>

      <section class="card" style={{ flexShrink: 0 }}>
        <div class="card-title">视图</div>

        <div class="field-row" style={{ alignItems: "center" }}>
          <div class="seg">
            {(["hex", "ascii", "both"] as ViewMode[]).map((m) => (
              <button
                key={m}
                class={`seg-btn ${mode === m ? "active" : ""}`}
                onClick={() => setMode(m)}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>

          <label class="toggle">
            <input
              type="checkbox"
              checked={paused}
              onChange={(e) => setPaused((e.target as HTMLInputElement).checked)}
            />
            暂停
          </label>

          <button onClick={clear}>清空</button>
          <span class="count">{frames.length} 帧</span>
        </div>
      </section>

      <div class="hex-log" ref={containerRef}>
        {frames.length === 0 && <div class="empty">等待数据…</div>}
        {frames.map((f, idx) => {
          const hex = uint8ToHex(f.bytes);
          const ascii = bytesToAscii(f.bytes);
          return (
            <div key={`${f.ts}-${idx}`} class="hex-row">
              <span class="ts">{new Date(f.ts).toLocaleTimeString("zh-CN", { hour12: false })}</span>
              {(mode === "hex" || mode === "both") && (
                <span class="hex">{hex || "(空)"}</span>
              )}
              {(mode === "ascii" || mode === "both") && (
                <span class="ascii">{ascii || "(空)"}</span>
              )}
            </div>
          );
        })}
      </div>

      {error && <div class="error">{error}</div>}
    </div>
  );
}
