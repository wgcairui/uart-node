/**
 * 软 DTU HTTP API server (Phase 1 stub)
 *
 * 把 bindings 包装成 HTTP 端点，WebView 走 fetch 调过来
 * Vite dev server proxy /api/* → 这个 serve
 *
 * 端点：
 *   - GET  /api/serial/list          → SerialPortInfo[]
 *   - POST /api/serial/open          → { path, options } → { ok: true }
 *   - POST /api/serial/close         → { ok: true }
 *   - POST /api/serial/write         → { data: string | base64 } → { ok: true }
 *   - GET  /api/serial/status        → { isOpen, currentPort }
 *   - GET  /api/serial/stream?channel=data|error|close → SSE
 *   - GET  /api/protocols            → { protocols: ProtocolDefinition[] }
 *   - GET  /api/protocols/refresh    → { protocols: ProtocolDefinition[] }
 *
 * Phase 2 切 Deno Desktop official bindings SDK 后可以删这个文件
 * （WebView 直接 IPC 调 bindings，不走 HTTP）
 */

import type { SerialBindings } from "../bindings/serial.ts";
import type { ProtocolBindings } from "../bindings/protocol.ts";

interface HttpApiOptions {
  port: number;
  host: string;
}

/** I5: SSE 连接上限 + idle timeout, 防恶意跨域页 + 资源耗尽 */
const SSE_MAX_PER_CHANNEL = 16;
/** I5: SSE idle timeout (10min), 没活动就断 */
const SSE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function startHttpApi(
  opts: HttpApiOptions,
  serial: SerialBindings,
  protocol: ProtocolBindings,
): Deno.HttpServer {
  // I5: CORS env gate — loopback (dev) 放开, 非 loopback (生产) 走同源代理
  const isLoopback = (opts.host === "127.0.0.1" || opts.host === "localhost" || opts.host === "::1");
  /** JSON 响应 (根据 isLoopback 决定 CORS *) */
  function jsonResponse(data: unknown, init?: ResponseInit): Response {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
    };
    if (isLoopback) {
      headers["access-control-allow-origin"] = "*";
    } else {
      // 生产模式: 走 Vite proxy 同源, 不开 CORS *
      // 如果真的需要跨域, 显式加 origin 白名单
      headers["vary"] = "origin";
    }
    return new Response(JSON.stringify(data), {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
  }

  const sseClients: Map<string, Set<ReadableStreamDefaultController<Uint8Array>>> = new Map();

  /** 广播 SSE 事件到对应 channel 的所有客户端 */
  function sseBroadcast(channel: string, eventName: string, payload: unknown) {
    const clients = sseClients.get(channel);
    if (!clients || clients.size === 0) return;
    const encoder = new TextEncoder();
    const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    const bytes = encoder.encode(data);
    for (const ctrl of clients) {
      try {
        ctrl.enqueue(bytes);
      } catch {
        // 客户端已断开 — 从集合里移除
        clients.delete(ctrl);
      }
    }
  }

  // 订阅 serial 事件 → SSE 广播
  serial.onData((data) => {
    // Uint8Array → base64
    let bin = "";
    for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
    sseBroadcast("data", "data", { bytes: btoa(bin) });
  });
  serial.onError((err) => {
    sseBroadcast("error", "error", { message: err.message });
  });
  serial.onClose(() => {
    sseBroadcast("close", "close", {});
  });

  /** 错误响应 */
  function errorResponse(status: number, message: string): Response {
    return jsonResponse({ error: message }, { status });
  }

  /** CORS preflight (I5: loopback 才开 *) */
  function corsPreflight(): Response {
    const headers: Record<string, string> = {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    };
    if (isLoopback) {
      headers["access-control-allow-origin"] = "*";
    } else {
      headers["vary"] = "origin";
    }
    return new Response(null, { status: 204, headers });
  }

  /** 读 JSON body */
  async function readJson(req: Request): Promise<unknown> {
    try {
      return await req.json();
    } catch {
      return null;
    }
  }

  /** base64 → Uint8Array */
  function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") return corsPreflight();

    try {
      // ── Serial ──
      if (path === "/api/serial/list" && method === "GET") {
        const list = await serial.list();
        return jsonResponse(list);
      }

      if (path === "/api/serial/open" && method === "POST") {
        const body = (await readJson(req)) as { path?: string; options?: unknown } | null;
        if (!body?.path || !body.options) {
          return errorResponse(400, "missing path or options");
        }
        await serial.open(body.path, body.options as Parameters<typeof serial.open>[1]);
        return jsonResponse({ ok: true });
      }

      if (path === "/api/serial/close" && method === "POST") {
        await serial.close();
        return jsonResponse({ ok: true });
      }

      if (path === "/api/serial/write" && method === "POST") {
        // I4: 显式 encoding — 不再启发式猜 base64, 4 字符 ASCII ("ATEN"/"INFO"/"1234") 会被误判
        // 默认 utf8, 跟 webview api.ts:serial.write 同步
        const body = (await readJson(req)) as
          | { data?: string; encoding?: "utf8" | "base64" }
          | null;
        if (!body?.data) {
          return errorResponse(400, "missing data");
        }
        const encoding = body.encoding ?? "utf8";
        let data: string | Uint8Array;
        if (encoding === "base64") {
          data = base64ToBytes(body.data);
        } else if (encoding === "utf8") {
          data = body.data; // 直接传 string, serial.write 会 TextEncoder.encode
        } else {
          return errorResponse(400, `unsupported encoding: ${encoding}`);
        }
        await serial.write(data);
        return jsonResponse({ ok: true });
      }

      if (path === "/api/serial/status" && method === "GET") {
        return jsonResponse({
          isOpen: serial.isOpen(),
          currentPort: serial.currentPort(),
        });
      }

      if (path === "/api/serial/stream" && method === "GET") {
        const channel = url.searchParams.get("channel") ?? "data";
        if (!["data", "error", "close"].includes(channel)) {
          return errorResponse(400, "invalid channel (data|error|close)");
        }
        // I5: SSE 连接上限 — 防止恶意跨域页 / 资源耗尽
        let set = sseClients.get(channel);
        if (!set) {
          set = new Set();
          sseClients.set(channel, set);
        }
        if (set.size >= SSE_MAX_PER_CHANNEL) {
          return errorResponse(429, `SSE channel ${channel} full (${set.size}/${SSE_MAX_PER_CHANNEL})`);
        }
        const encoder = new TextEncoder();
        // C2: hoist ctrl 到外层, 让 cancel() 能拿到
        let myController: ReadableStreamDefaultController<Uint8Array> | null = null;
        // I5: idle timeout — 10min 无活动自动 close
        // I2 兼容: 跟 cellular-dtu.ts 一样, ReturnType<typeof setTimeout> 自动跟随当前 runtime
        let idleTimeout: ReturnType<typeof setTimeout> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            myController = ctrl;
            set!.add(ctrl);
            // 立刻推一个 connected 事件让客户端知道 SSE 通了
            ctrl.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ channel })}\n\n`));
            // I5: idle timeout
            idleTimeout = setTimeout(() => {
              try {
                ctrl.close();
              } catch { /* 已被 close */ }
              if (myController) {
                set!.delete(myController);
                myController = null;
              }
            }, SSE_IDLE_TIMEOUT_MS);
          },
          cancel() {
            // C2 修: 用外层 hoisted 引用, 不再 ReferenceError
            if (idleTimeout !== null) {
              clearTimeout(idleTimeout);
              idleTimeout = null;
            }
            if (myController) {
              set!.delete(myController);
              myController = null;
            }
          },
        });
        const sseHeaders: Record<string, string> = {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
        };
        if (isLoopback) {
          sseHeaders["access-control-allow-origin"] = "*";
        } else {
          sseHeaders["vary"] = "origin";
        }
        return new Response(stream, { headers: sseHeaders });
      }

      // ── Protocol ──
      if (path === "/api/protocols" && method === "GET") {
        const list = await protocol.list();
        return jsonResponse({ protocols: list, offline: protocol.isOffline() });
      }

      if (path === "/api/protocols/refresh" && method === "GET") {
        const list = await protocol.refresh();
        return jsonResponse({ protocols: list, offline: protocol.isOffline() });
      }

      // ── Health ──
      if (path === "/api/health" && method === "GET") {
        return jsonResponse({ ok: true, ts: Date.now() });
      }

      return errorResponse(404, `not found: ${method} ${path}`);
    } catch (err) {
      return errorResponse(500, (err as Error).message);
    }
  };

  const server = Deno.serve({ port: opts.port, hostname: opts.host, onListen: ({ port, hostname }) => {
    console.log(`[http-api] listening on http://${hostname}:${port}/api/*`);
  } }, handler);

  return server;
}
