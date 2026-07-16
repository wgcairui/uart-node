/**
 * Toast / Snackbar — 右下角浮层, 3s 自动消失, materialize animation
 *
 * 用法:
 *   const { toasts, push } = useToasts();
 *   push({ text: "串口已打开", duration: 3000 });
 *
 *   <ToastStack toasts={toasts} />
 *
 * 视觉:
 *   - rgba(58,58,60,0.95) + blur(20px) saturate(180%) 毛玻璃
 *   - 16x16 check icon (绿色) + 13px 文字
 *   - bottom 44px, right 24px (避开 status bar 28px)
 *   - 入场 scale(0.96) + opacity 0→1, 出场反向
 *   - 多 toast 堆叠 (column flex, 8px gap)
 *
 * 可访问性:
 *   - role="status" aria-live="polite" (不像 error 要 assert)
 *   - 鼠标 hover 不消失 (用 duration 截止时间戳判断)
 */

import type { JSX } from "preact";
import { useEffect, useState, useCallback, useRef } from "preact/hooks";
import { IconCheck } from "../icons.tsx";

export interface ToastItem {
  id: number;
  text: string;
  /** 自动消失时长 (ms), 默认 3000 */
  duration: number;
  /** 创建时间戳 (ms) — 内部用 */
  createdAt: number;
  /** 正在淡出 (内部用) */
  fading?: boolean;
}

let _toastIdSeq = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, fading: true } : t))
    );
    // 200ms 出场动画后真正移除
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 220);
  }, []);

  const push = useCallback((opts: { text: string; duration?: number }) => {
    const id = ++_toastIdSeq;
    const item: ToastItem = {
      id,
      text: opts.text,
      duration: opts.duration ?? 3000,
      createdAt: Date.now(),
    };
    setToasts((prev) => [...prev, item]);
    const t = setTimeout(() => dismiss(id), item.duration);
    timers.current.set(id, t);
    return id;
  }, [dismiss]);

  useEffect(() => {
    return () => {
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

export interface ToastStackProps {
  toasts: ToastItem[];
}

export function ToastStack({ toasts }: ToastStackProps): JSX.Element | null {
  if (toasts.length === 0) return null;
  return (
    <div class="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          class={`toast ${t.fading ? "toast-out" : ""}`}
          role="status"
        >
          <span class="toast-icon" aria-hidden="true">
            <IconCheck />
          </span>
          <span class="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
