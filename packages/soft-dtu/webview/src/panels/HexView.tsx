/**
 * HEX/ASCII 实时数据视图 — Apple SF card layout
 *
 * 顶部：segmented control (HEX / ASCII / 双向) + 暂停开关 (SF toggle) + 清空 + 计数
 * 中部：hex log (3 栏对齐: offset / hex / ascii, 16B/行)
 *
 * 接力补的细节:
 *   - 三栏 hex view (offset / hex / ascii, 16B/行) — 跟 XCOM 主流 hex viewer 一致
 *   - 不可打印字符 (0x00-0x1F 除 0x09/0x0A/0x0D) 显示 .
 *   - Hex 栏内字节间空格, 每 8 字节多空一格 (visual 分组)
 *   - Offset 灰底, hex 蓝色, ascii 正常色
 *   - ErrorBanner 替换 .error
 *   - Auto-scroll (跟 AT 一致, 用户滚上去时停)
 *
 * 跟 XCOM / sscom 的"显示"面板等价，但走软 DTU 通道
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { serial } from "../api.ts";
import { ErrorBanner } from "../components/ErrorBanner.tsx";

type ViewMode = "hex" | "ascii" | "both";

interface Frame {
  ts: number;
  bytes: Uint8Array;
}

const BUFFER_MAX = 500;
const ROW_BYTES = 16;

/** 不可打印字符 (除 \t \n \r) 显示 `.` */
function bytesToAscii(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) =>
      (b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d
        ? String.fromCharCode(b)
        : "."
    )
    .join("");
}

/** 16 字节一行的 hex 字符串 (字节间空格, 每 8 字节多空一格 visual 分组) */
function formatHexRow(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < bytes.length; i += 8) {
    const chunk = bytes.slice(i, Math.min(i + 8, bytes.length));
    groups.push(
      Array.from(chunk)
        .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
        .join(" "),
    );
  }
  // 末尾补齐 16 字节的短行（让 hex 列和 ascii 列对齐）
  const missing = ROW_BYTES - bytes.length;
  if (missing > 0 && bytes.length < ROW_BYTES) {
    // 把最后一段补齐: 补 2 空格/字节
    const tail = " ".repeat(missing * 3);
    groups[groups.length - 1] = (groups[groups.length - 1] ?? "") + tail;
  }
  return groups.join("  "); // 组间多 1 空格
}

/** 16 字节一行的 ascii 字符串 */
function formatAsciiRow(bytes: Uint8Array): string {
  return bytesToAscii(bytes);
}

export function HexView() {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [mode, setMode] = useState<ViewMode>("both");
  const [paused, setPaused] = useState(false);
  const [error] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

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

  // Auto-scroll: 仅当用户接近底部时跟随
  useEffect(() => {
    const el = logEndRef.current?.parentElement;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 80) {
      logEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [frames.length]);

  function clear() {
    setFrames([]);
  }

  return (
    <div class="hex-view">
      <div class="panel-header">
        <h2 class="panel-title">HEX/ASCII</h2>
        <p class="panel-subtitle">
          实时数据流 · 三栏 hex 视图 (offset / hex / ascii) · 16 字节/行 · 缓冲 500 帧
        </p>
      </div>

      {error && (
        <ErrorBanner onDismiss={() => undefined}>{error}</ErrorBanner>
      )}

      <section class="card" style={{ flexShrink: 0 }}>
        <div class="card-title">视图</div>

        <div class="field-row" style={{ alignItems: "center" }}>
          <div class="seg" role="tablist" aria-label="HEX/ASCII 视图切换">
            {(["hex", "ascii", "both"] as ViewMode[]).map((m) => (
              <button
                key={m}
                class={`seg-btn ${mode === m ? "active" : ""}`}
                onClick={() => setMode(m)}
                role="tab"
                aria-selected={mode === m}
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

          <button onClick={clear} disabled={frames.length === 0}>
            清空
          </button>
          <span class="count">{frames.length} 帧</span>
        </div>
      </section>

      <div class="hex-log" role="log" aria-live="polite" aria-label="HEX/ASCII 数据日志">
        {frames.length === 0 && (
          <div class="empty" role="status">等待数据…</div>
        )}
        {frames.map((f, idx) => {
          // 每帧切成 ROW_BYTES (16) 行
          const rows: Uint8Array[] = [];
          for (let i = 0; i < f.bytes.length; i += ROW_BYTES) {
            rows.push(f.bytes.slice(i, Math.min(i + ROW_BYTES, f.bytes.length)));
          }
          const ts = new Date(f.ts).toLocaleTimeString("zh-CN", { hour12: false });
          return (
            <div key={`${f.ts}-${idx}`} class="hex-frame">
              <div class="hex-row hex-row-header">
                <span class="ts">{ts}</span>
              </div>
              {rows.map((row, ridx) => {
                const offset = (idx * ROW_BYTES + ridx * ROW_BYTES) & 0xffffff;
                return (
                  <div key={`${f.ts}-${idx}-${ridx}`} class="hex-row">
                    <span class="hex-offset">
                      {offset.toString(16).padStart(6, "0").toUpperCase()}
                    </span>
                    {(mode === "hex" || mode === "both") && (
                      <span class="hex-bytes">{formatHexRow(row)}</span>
                    )}
                    {(mode === "ascii" || mode === "both") && (
                      <span class="hex-ascii">{formatAsciiRow(row)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
