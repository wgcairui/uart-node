/**
 * Empty state 组件 — Apple SF 风格空状态
 *
 * 用法:
 *   <EmptyState
 *     icon={<IconProtocol />}
 *     title="选择一个协议"
 *     hint="从上方下拉菜单选择软 DTU 协议, 查看 AT 指令和寄存器表"
 *   />
 *
 * 视觉:
 *   - 56px 灰色 icon, opacity 0.7
 *   - 17px semi-bold 标题
 *   - 13px secondary hint, max-width 360px
 *   - 80px 上下 padding, 居中
 */

import type { ComponentChildren, JSX } from "preact";

export interface EmptyStateProps {
  icon: JSX.Element;
  title: string;
  hint: string;
  action?: ComponentChildren;
}

export function EmptyState(
  { icon, title, hint, action }: EmptyStateProps,
): JSX.Element {
  return (
    <div class="empty-state" role="status">
      <div class="empty-state-icon" aria-hidden="true">{icon}</div>
      <h3 class="empty-state-title">{title}</h3>
      <p class="empty-state-hint">{hint}</p>
      {action && <div class="empty-state-action">{action}</div>}
    </div>
  );
}
