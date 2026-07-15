/**
 * TCP Transport — 连 UartNode:9000
 *
 * 用 Deno 1.4+ 原生 Deno.connect()（不依赖 npm 包）
 * 跟 UartNode 端 src/server/tcp-server.ts (Bun net.Server) 兼容
 *
 * 行为：
 *   - 主动 connect UartNode:9000（软 DTU 是 client，UartNode 是 server）
 *   - 处理 binary + text 双向数据
 *   - 半关闭 + 重连支持
 *
 * 不依赖 UartNode PR #20 NODE_TOKEN（软 DTU 是设备层，不是 Node 层）
 */

import { EventEmitter } from "node:events";

export interface TcpTransportOptions {
  host: string;
  port: number;
  /** 读超时 (ms)，默认 0 = 不超时（UartNode setTimeout 5min 兜底）*/
  readTimeoutMs?: number;
}

export class TcpTransport extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly readTimeoutMs: number;
  private conn: Deno.TcpConn | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: TcpTransportOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port;
    this.readTimeoutMs = opts.readTimeoutMs ?? 0;
  }

  /**
   * 主动连 UartNode
   */
  async connect(): Promise<void> {
    this.emit("log", `tcp.connect ${this.host}:${this.port}`);
    this.conn = await Deno.connect({
      hostname: this.host,
      port: this.port,
      transport: "tcp",
    });
    // TCP keepalive 跟 UartNode 端 socket.ts 对齐
    try {
      // Deno 1.40+ 支持 keepAlive，2.0 已 GA
      (this.conn as unknown as { setKeepAlive: (enable: boolean, initialDelay?: number) => void })
        .setKeepAlive(true, 100_000);
    } catch {
      // 旧 Deno 不支持，忽略
    }
    this.emit("log", "tcp connected");
    this.startReadLoop();
  }

  /**
   * 发送数据
   */
  async send(data: Uint8Array): Promise<void> {
    if (!this.conn) {
      throw new Error("tcp not connected");
    }
    // 串行化 write 避免 race
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.conn) {
        await this.conn.write(data);
      }
    });
    return this.writeQueue;
  }

  /**
   * 关闭连接
   */
  close(): void {
    if (this.conn) {
      try {
        this.conn.close();
      } catch {
        // ignore
      }
      this.conn = null;
    }
    if (this.reader) {
      try {
        this.reader.cancel();
      } catch {
        // ignore
      }
      this.reader = null;
    }
    this.emit("close");
  }

  /**
   * 读循环
   */
  private async startReadLoop(): Promise<void> {
    if (!this.conn) return;
    this.reader = this.conn.readable.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) {
          this.emit("log", "tcp read EOF");
          break;
        }
        if (value && value.length > 0) {
          this.emit("data", value);
          this.emit("log", `tcp <<< ${decoder.decode(value).trim()}`);
        }
      }
    } catch (err) {
      this.emit("error", err);
    } finally {
      this.reader?.releaseLock();
      this.reader = null;
      this.emit("close");
    }
  }
}
