/**
 * HEX/ASCII 实时数据视图
 *
 * 功能：
 *   - 订阅串口数据流（serial.onData）
 *   - 实时切换 HEX / ASCII / 双视图
 *   - 自动滚动到最新（可暂停）
 *   - 缓冲最大 500 条记录
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
  const [error, setError] = useState<string | null>(null);
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
      <section class="row toolbar">
        <label>视图</label>
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

        <label class="spacer">
          <input
            type="checkbox"
            checked={paused}
            onChange={(e) => setPaused((e.target as HTMLInputElement).checked)}
          />
          暂停
        </label>
        <button onClick={clear}>清空</button>
        <span class="count">{frames.length} 帧</span>
      </section>

      <div class="hex-log" ref={containerRef}>
        {frames.length === 0 && <div class="empty">等待数据…</div>}
        {frames.map((f, idx) => {
          const hex = uint8ToHex(f.bytes);
          const ascii = bytesToAscii(f.bytes);
          return (
            <div key={`${f.ts}-${idx}`} class="hex-row">
              <span class="ts">{new Date(f.ts).toLocaleTimeString()}</span>
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
