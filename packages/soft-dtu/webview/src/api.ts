/**
 * HTTP API wrapper — 软 DTU WebView → Deno 后端
 *
 * Phase 1 走 fetch (Vite dev server proxy /api/* → Deno serve on 127.0.0.1:8080)
 * Phase 2 切 Deno Desktop bindings SDK（直接 IPC，无 HTTP）
 *
 * 端点：
 *   - GET  /api/serial/list          → SerialPortInfo[]
 *   - POST /api/serial/open          → { path, options }
 *   - POST /api/serial/close         → void
 *   - POST /api/serial/write         → { data: string (utf8) | base64 }
 *   - GET  /api/serial/status        → { isOpen, currentPort }
 *   - GET  /api/serial/stream        → SSE (data/error/close 事件)
 *   - GET  /api/protocols            → ProtocolDefinition[]
 *   - GET  /api/protocols/refresh    → ProtocolDefinition[] (强制刷新)
 *
 * ⚠️ 字段名必须跟 Deno 端 src/bindings/serial.ts + protocol.ts 1:1
 */

import type {
  SerialBindings,
  ProtocolBindings,
  SerialPortInfo,
  SerialOptions,
  CurrentPort,
  ProtocolDefinition,
} from "./bindings.ts";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    throw new HttpError(res.status, body, `${init?.method ?? "GET"} ${path} → ${res.status}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

/** Uint8Array → base64 (写串口用) */
function uint8ToBase64(arr: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

/** Uint8Array → hex 字符串 (HEX 视图用) */
export function uint8ToHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

export const serial: SerialBindings = {
  async list(): Promise<SerialPortInfo[]> {
    return http<SerialPortInfo[]>("/serial/list");
  },

  async open(path: string, options: SerialOptions): Promise<void> {
    await http<void>("/serial/open", {
      method: "POST",
      body: JSON.stringify({ path, options }),
    });
  },

  async close(): Promise<void> {
    await http<void>("/serial/close", { method: "POST" });
  },

  async write(data: string | Uint8Array): Promise<void> {
    const payload = typeof data === "string" ? { data } : { data: uint8ToBase64(data) };
    await http<void>("/serial/write", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  isOpen(): boolean {
    // 同步读不到后端状态 — UI 拿 status 后再判断
    // 这里给 false 让 UI 必须先调 status
    return false;
  },

  currentPort(): CurrentPort | null {
    return null;
  },

  onData(handler: (data: Uint8Array) => void): () => void {
    // Phase 1: 用 EventSource (SSE) 订阅数据流
    const es = new EventSource(`${API_BASE}/serial/stream?channel=data`);
    const onMsg = (ev: MessageEvent) => {
      try {
        // SSE payload: { bytes: base64 }
        const payload = JSON.parse(ev.data) as { bytes: string };
        const bin = atob(payload.bytes);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        handler(arr);
      } catch (err) {
        console.warn("[api.serial] bad data event:", err);
      }
    };
    es.addEventListener("data", onMsg as EventListener);
    es.onerror = (err) => {
      console.warn("[api.serial] SSE error:", err);
    };
    return () => es.close();
  },

  onError(handler: (err: Error) => void): () => void {
    const es = new EventSource(`${API_BASE}/serial/stream?channel=error`);
    const onMsg = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as { message: string };
        handler(new Error(payload.message));
      } catch (err) {
        handler(err as Error);
      }
    };
    es.addEventListener("error", onMsg as EventListener);
    return () => es.close();
  },

  onClose(handler: () => void): () => void {
    const es = new EventSource(`${API_BASE}/serial/stream?channel=close`);
    es.addEventListener("close", handler as EventListener);
    return () => es.close();
  },
};

export const protocol: ProtocolBindings = {
  async list(): Promise<ProtocolDefinition[]> {
    const res = await http<{ protocols: ProtocolDefinition[] }>("/protocols");
    return res.protocols;
  },

  get(id: string): ProtocolDefinition | undefined {
    // HTTP 不能同步读 — 改成异步缓存（组件用 useProtocols() hook 拿）
    void id;
    return undefined;
  },

  async refresh(): Promise<ProtocolDefinition[]> {
    const res = await http<{ protocols: ProtocolDefinition[] }>("/protocols/refresh");
    return res.protocols;
  },

  isOffline(): boolean {
    return false; // 异步状态，组件用 useProtocols() hook 拿
  },

  onUpdate(_handler: (protocols: ProtocolDefinition[]) => void): () => void {
    // Phase 1 不实现 push，等 Phase 2 Deno Desktop bindings
    return () => {};
  },
};

export async function getSerialStatus(): Promise<{ isOpen: boolean; currentPort: CurrentPort | null }> {
  return http<{ isOpen: boolean; currentPort: CurrentPort | null }>("/serial/status");
}

export { HttpError };
