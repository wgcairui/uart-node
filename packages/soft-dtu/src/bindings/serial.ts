/**
 * 串口 IPC Bindings — 暴露给 WebView 前端
 *
 * Deno Desktop 模式：WebView → bindings → Deno runtime
 * - 用 Deno 2.9 desktop 的 IPC channel（具体 API 等 Deno 2.9 stable 后确认）
 * - Phase 1 stub：定义 API surface
 * - Phase 2 实现：调 Deno Desktop bindings SDK
 *
 * 暴露给前端的 API：
 *   - serial.list(): Promise<SerialPortInfo[]>
 *   - serial.open(path, options): Promise<void>
 *   - serial.close(): Promise<void>
 *   - serial.write(data: string | Uint8Array): Promise<void>
 *   - serial.onData(callback): unsubscribe
 *   - serial.onError(callback): unsubscribe
 *
 * Phase 1 用 localStorage + 自定义事件 stub（deno serve 起 HTTP，前端 fetch）
 * Phase 2 切 Deno Desktop bindings（避免 HTTP 跨进程）
 */

// SerialTransport 是 class (value + type) — 不能 import type, 不然 .list() 报 ReferenceError
// SerialPortInfo / SerialOptions 是 interface, type-only 即可
import { SerialTransport, type SerialPortInfo, type SerialOptions } from "../transport/serial.ts";

export interface SerialBindings {
  list(): Promise<SerialPortInfo[]>;
  open(path: string, options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  write(data: string | Uint8Array): Promise<void>;
  isOpen(): boolean;
  /** 当前打开的串口信息 */
  currentPort(): { path: string; options: SerialOptions } | null;
  /** 串口数据回调（WebView 订阅）*/
  onData(handler: (data: Uint8Array) => void): () => void;
  /** 串口错误回调 */
  onError(handler: (err: Error) => void): () => void;
  /** 串口关闭回调 */
  onClose(handler: () => void): () => void;
}

export function createSerialBindings(serial: SerialTransport): SerialBindings {
  let current: { path: string; options: SerialOptions } | null = null;
  const dataHandlers = new Set<(data: Uint8Array) => void>();
  const errorHandlers = new Set<(err: Error) => void>();
  const closeHandlers = new Set<() => void>();

  serial.on("data", (data) => {
    for (const h of dataHandlers) {
      try {
        h(data);
      } catch (err) {
        console.warn("[serial bindings] data handler error:", err);
      }
    }
  });
  serial.on("error", (err) => {
    for (const h of errorHandlers) {
      try {
        h(err);
      } catch (e) {
        console.warn("[serial bindings] error handler error:", e);
      }
    }
  });
  serial.on("close", () => {
    current = null;
    for (const h of closeHandlers) {
      try {
        h();
      } catch (err) {
        console.warn("[serial bindings] close handler error:", err);
      }
    }
  });

  return {
    async list() {
      return SerialTransport.list();
    },
    async open(path, options) {
      await serial.open(path, options);
      current = { path, options };
    },
    async close() {
      serial.close();
      current = null;
    },
    async write(data) {
      if (typeof data === "string") {
        await serial.write(new TextEncoder().encode(data));
      } else {
        await serial.write(data);
      }
    },
    isOpen() {
      return serial.isOpen;
    },
    currentPort() {
      return current;
    },
    onData(handler) {
      dataHandlers.add(handler);
      return () => dataHandlers.delete(handler);
    },
    onError(handler) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
  };
}

/**
 * 注册到全局（Deno Desktop bindings 模式）
 * Phase 1 stub：通过 Deno.core.ops 注册自定义 op
 * Phase 2 切 Deno Desktop official bindings SDK
 */
export function registerSerialBindings(serial: SerialTransport): SerialBindings {
  const bindings = createSerialBindings(serial);

  // Phase 1: 暴露到 globalThis 让 deno serve HTTP handler 能访问
  // 前端 fetch('/api/serial/list') 走 HTTP，main.ts HTTP handler 调 bindings.list()
  (globalThis as Record<string, unknown>).__serialBindings = bindings;

  console.log("[bindings] serial bindings registered");
  return bindings;
}
