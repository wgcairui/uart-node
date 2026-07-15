/**
 * 协议 IPC Bindings — 暴露给 WebView 前端
 *
 * 软 DTU 走 HTTP API 从 server 拉协议定义（GET /api/v2/protocols）
 * 跟之前规划的 Socket.IO 模式不同（Cairui 2026-07-14 16:29 拍板）
 *
 * 暴露给前端的 API：
 *   - protocol.list(): Promise<ProtocolDefinition[]>  // 走 HTTP，5min 缓存
 *   - protocol.get(id): ProtocolDefinition | undefined  // 同步，从缓存查
 *   - protocol.refresh(): Promise<ProtocolDefinition[]>  // 强制刷新
 *   - protocol.isOffline(): boolean  // 是否离线模式
 *   - protocol.onUpdate(handler): unsubscribe  // server 返回新协议时回调
 *
 * Phase 1 范围：从 server 拉汉枫 4G / Modbus RTU 等协议
 * server 端 agent-ae682922673b 待加 GET /api/v2/protocols 端点
 */

import {
  ProtocolRepository,
  type ProtocolDefinition,
  type AtCommandDefinition,
} from "../protocol/protocol-catalog.ts";

export interface ProtocolBindings {
  list(): Promise<ProtocolDefinition[]>;
  get(id: string): ProtocolDefinition | undefined;
  refresh(): Promise<ProtocolDefinition[]>;
  isOffline(): boolean;
  onUpdate(handler: (protocols: ProtocolDefinition[]) => void): () => void;
}

export function createProtocolBindings(repo: ProtocolRepository): ProtocolBindings {
  return {
    list: () => repo.list(),
    get: (id) => repo.get(id),
    refresh: () => repo.refresh(),
    isOffline: () => repo.isOffline(),
    onUpdate: (handler) => repo.onUpdate(handler),
  };
}

export function registerProtocolBindings(repo: ProtocolRepository): ProtocolBindings {
  const bindings = createProtocolBindings(repo);

  // 暴露到 globalThis 让 HTTP handler 能访问
  (globalThis as Record<string, unknown>).__protocolBindings = bindings;

  // 启动时拉一次（fire-and-forget，失败走 offline fallback）
  bindings.list().catch((err) => {
    console.warn("[bindings] initial protocol fetch failed:", err);
  });

  console.log("[bindings] protocol bindings registered (HTTP API, 5min cache)");
  return bindings;
}
