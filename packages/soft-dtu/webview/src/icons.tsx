/**
 * Inline SVG icons — Apple SF Symbols 风格 (1.75px stroke, 20x20 viewBox)
 *
 * 用 currentColor 让父级 color 控制（sidebar active 暖橙, 平时 secondary）
 * 22-26px 容器, stroke 1.75px, linecap/linejoin round（跟 SF 一致, 加粗增强可见性）
 *
 * 用法:
 *   <IconSerial />                  — sidebar nav icon (22px 容器)
 *   <span class="nav-icon"><IconSerial /></span>
 *
 * v2 接力: 加 9 个新 icon (Logo/Refresh/Send/Close/Trash/Play/Pause/Copy/Warning/Info),
 * stroke 1.5 → 1.75px 增强可见性, 配套新暖橙调色板.
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
  "stroke-width": 1.75,
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
    <svg {...base} stroke-width="2.25">
      <path d="M4 10 L8 14 L16 6" />
    </svg>
  );
}

/* ─── v2 接力: 9 个新 icon (cairui 反馈) ─── */

/** 品牌 logo: 节点 + 4 圈 radio wave (软 DTU 模块意象) */
export function IconLogo(): JSX.Element {
  return (
    <svg {...base}>
      <circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none" />
      <path d="M7 7 a4.24 4.24 0 0 1 6 0" />
      <path d="M13 13 a4.24 4.24 0 0 1 -6 0" />
      <path d="M4.5 4.5 a7.78 7.78 0 0 1 11 0" />
      <path d="M15.5 15.5 a7.78 7.78 0 0 1 -11 0" />
    </svg>
  );
}

/** 强制刷新 — 圆弧 + 末端箭头 */
export function IconRefresh(): JSX.Element {
  return (
    <svg {...base}>
      <path d="M3.5 10 a6.5 6.5 0 0 1 11.5 -4" />
      <path d="M16.5 10 a6.5 6.5 0 0 1 -11.5 4" />
      <polyline points="15 2 15 6 11 6" />
      <polyline points="5 18 5 14 9 14" />
    </svg>
  );
}

/** 发送 — 纸飞机 */
export function IconSend(): JSX.Element {
  return (
    <svg {...base}>
      <path d="M2.5 10 L17.5 3 L13 17.5 L10 11 Z" />
      <path d="M10 11 L17.5 3" />
    </svg>
  );
}

/** 关闭 — × 形 */
export function IconClose(): JSX.Element {
  return (
    <svg {...base}>
      <line x1="5" y1="5" x2="15" y2="15" />
      <line x1="15" y1="5" x2="5" y2="15" />
    </svg>
  );
}

/** 清空 — 垃圾桶 */
export function IconTrash(): JSX.Element {
  return (
    <svg {...base}>
      <line x1="3" y1="6" x2="17" y2="6" />
      <path d="M8 6 V4 a1 1 0 0 1 1 -1 h2 a1 1 0 0 1 1 1 V6" />
      <path d="M5 6 l1 11 a1 1 0 0 0 1 1 h6 a1 1 0 0 0 1 -1 l1 -11" />
      <line x1="9" y1="9" x2="9" y2="15" />
      <line x1="11" y1="9" x2="11" y2="15" />
    </svg>
  );
}

/** 播放 — 实心三角 (streaming 启动) */
export function IconPlay(): JSX.Element {
  return (
    <svg {...base} fill="currentColor" stroke="none">
      <path d="M6 4 L16 10 L6 16 Z" />
    </svg>
  );
}

/** 暂停 — 双竖条 (streaming 暂停) */
export function IconPause(): JSX.Element {
  return (
    <svg {...base} fill="currentColor" stroke="none">
      <rect x="5" y="4" width="3.5" height="12" rx="0.75" />
      <rect x="11.5" y="4" width="3.5" height="12" rx="0.75" />
    </svg>
  );
}

/** 复制 — 双叠方块 */
export function IconCopy(): JSX.Element {
  return (
    <svg {...base}>
      <rect x="7" y="7" width="11" height="11" rx="1.5" />
      <path d="M14 7 V4 a1 1 0 0 0 -1 -1 H4 a1 1 0 0 0 -1 1 v9 a1 1 0 0 0 1 1 h3" />
    </svg>
  );
}

/** 警告 — 三角 + 叹号 */
export function IconWarning(): JSX.Element {
  return (
    <svg {...base}>
      <path d="M10 2.5 L18 17.5 H2 Z" />
      <line x1="10" y1="8" x2="10" y2="12.5" />
      <circle cx="10" cy="15" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 信息 — 蓝 i 圆 */
export function IconInfo(): JSX.Element {
  return (
    <svg {...base}>
      <circle cx="10" cy="10" r="7.5" />
      <line x1="10" y1="9.5" x2="10" y2="14" />
      <circle cx="10" cy="6.75" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
