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

import type { SerialBindings, ProtocolBindings } from "../bindings/serial.ts";

interface HttpApiOptions {
  port: number;
  host: string;
}

export function startHttpApi(
  opts: HttpApiOptions,
  serial: SerialBindings,
  protocol: ProtocolBindings,
): Deno.HttpServer {
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

  /** JSON 响应 */
  function jsonResponse(data: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(data), {
      ...init,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*", // dev only
        ...(init?.headers ?? {}),
      },
    });
  }

  /** 错误响应 */
  function errorResponse(status: number, message: string): Response {
    return jsonResponse({ error: message }, { status });
  }

  /** CORS preflight */
  function corsPreflight(): Response {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });
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
        const body = (await readJson(req)) as { data?: string } | null;
        if (!body?.data) {
          return errorResponse(400, "missing data");
        }
        // 启发式判断：纯 ASCII 文本 → string；否则 → base64
        const isLikelyBase64 = /^[A-Za-z0-9+/]+=*$/.test(body.data) && body.data.length % 4 === 0;
        const data = isLikelyBase64 && body.data.length > 0
          ? base64ToBytes(body.data)
          : body.data; // 字符串直接传
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
        let set = sseClients.get(channel);
        if (!set) {
          set = new Set();
          sseClients.set(channel, set);
        }
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            set!.add(ctrl);
            // 立刻推一个 connected 事件让客户端知道 SSE 通了
            ctrl.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ channel })}\n\n`));
          },
          cancel() {
            set!.delete(ctrl);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
            "access-control-allow-origin": "*",
          },
        });
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
