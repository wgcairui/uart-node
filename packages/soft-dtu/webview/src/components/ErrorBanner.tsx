/**
 * Error banner — 红色 12% bg + 1px border + dismiss 按钮
 *
 * 用法:
 *   {error && <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner>}
 *
 * 比前 worker 的 .error (仅文字 + 边框) 多:
 *   - inline error icon (16x16 SVG)
 *   - dismiss × 按钮 (右对齐, hover 加深)
 *   - 入场动画 (translateY -4px + opacity)
 */

import type { ComponentChildren, JSX } from "preact";
import { IconError } from "../icons.tsx";

export interface ErrorBannerProps {
  onDismiss: () => void;
  children: ComponentChildren;
  /** aria-live 默认 "assertive"（error 重要） */
  ariaLive?: "polite" | "assertive";
}

export function ErrorBanner(
  { onDismiss, children, ariaLive = "assertive" }: ErrorBannerProps,
): JSX.Element {
  return (
    <div class="error-banner" role="alert" aria-live={ariaLive}>
      <span class="error-banner-icon" aria-hidden="true">
        <IconError />
      </span>
      <span class="error-banner-text">{children}</span>
      <button
        type="button"
        class="error-banner-dismiss"
        onClick={onDismiss}
        aria-label="关闭错误提示"
      >
        ×
      </button>
    </div>
  );
}
