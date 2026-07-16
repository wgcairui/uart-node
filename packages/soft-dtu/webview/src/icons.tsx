/**
 * Inline SVG icons — Apple SF Symbols 风格 (1.5px stroke, 20x20 viewBox)
 *
 * 用 currentColor 让父级 color 控制（sidebar active 蓝色, 平时 secondary）
 * 18-20px 大小, stroke 1.5px, linecap/linejoin round（跟 SF 一致）
 *
 * 用法:
 *   <IconSerial />  — sidebar nav icon
 *   <span class="nav-icon"><IconSerial /></span>
 *
 * 跟前 worker 用的 emoji 替换（"🔌📡📊📋"）.
 * 理由: emoji 字体在 macOS/Windows/Linux 渲染不一致, 颜色用不了,
 * Apple 风格 sidebar 不混 emoji.
 */

import type { JSX } from "preact";

const base = {
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1.5,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  "aria-hidden": "true",
} as const;

export function IconSerial(): JSX.Element {
  return (
    <svg {...base}>
      <rect x="3" y="6" width="14" height="8" rx="1.5" />
      <line x1="3" y1="9" x2="17" y2="9" />
      <line x1="3" y1="12" x2="17" y2="12" />
      <circle cx="6" cy="7.5" r="0.5" fill="currentColor" />
      <circle cx="6" cy="13.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

export function IconAT(): JSX.Element {
  return (
    <svg {...base}>
      <path d="M2 10 L7 10 M5 7 L7 10 L5 13" />
      <path d="M9 10 H15" />
      <circle cx="17" cy="10" r="1" fill="currentColor" />
    </svg>
  );
}

export function IconHex(): JSX.Element {
  return (
    <svg {...base}>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="11" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="11" width="6" height="6" rx="1" />
      <rect x="11" y="11" width="6" height="6" rx="1" />
    </svg>
  );
}

export function IconProtocol(): JSX.Element {
  return (
    <svg {...base}>
      <path d="M5 4 H13 a2 2 0 0 1 2 2 v8 a2 2 0 0 1 -2 2 H7 a2 2 0 0 1 -2 -2 v-2" />
      <path d="M5 8 a2 2 0 0 1 2 -2 H13" />
      <line x1="8" y1="11" x2="12" y2="11" />
      <line x1="8" y1="14" x2="11" y2="14" />
    </svg>
  );
}

export function IconSettings(): JSX.Element {
  return (
    <svg {...base}>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 1.5 v2 M10 16.5 v2 M18.5 10 h-2 M3.5 10 h-2 M16 4 l-1.4 1.4 M5.4 14.6 L4 16 M16 16 l-1.4 -1.4 M5.4 5.4 L4 4" />
    </svg>
  );
}

export function IconHelp(): JSX.Element {
  return (
    <svg {...base}>
      <circle cx="10" cy="10" r="7" />
      <path d="M7.5 7.5 a2.5 2.5 0 0 1 5 0 c0 1.5 -2.5 2 -2.5 3.5" />
      <circle cx="10" cy="13.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

export function IconError(): JSX.Element {
  return (
    <svg {...base}>
      <circle cx="10" cy="10" r="7" />
      <line x1="10" y1="7" x2="10" y2="11" />
      <circle cx="10" cy="13.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

export function IconCheck(): JSX.Element {
  return (
    <svg {...base} stroke-width="2">
      <path d="M4 10 L8 14 L16 6" />
    </svg>
  );
}
