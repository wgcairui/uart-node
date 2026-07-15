/**
 * CellularDtu — 软 DTU 4G 协议模拟
 *
 * 行为契约：跟 UartNode 端 src/dtus/cellular.ts 1:1 兼容
 *   1. 启动连 UartNode:9000（TCP）
 *   2. 等 UartNode 推 '+++AT+NREGEN=...' 仪式
 *   3. 主动发注册包 'register&mac=<虚拟IMEI>&host=...\r\n'
 *   4. 响应 8 条 AT 指令（PID/VER/GVER/IOTEN/ICCID/LOCATE/UART/GSLQ）
 *   5. 持续监听 socket，处理下行指令（+++AT+ 透传穿）
 *   6. socket 断开时按 reboot 模式决定重连策略
 *
 * 跟 UartNode 对接关键点：
 *   - TcpServer.ts:onConnection 嗅探 'register&' 前缀
 *   - CellularRegisterHandler.handle URLSearchParams 解析
 *   - IMEI.slice(-12) 当 mac 主键
 *   - 8 条 AT 在 CellularDtu.initialize() 顺序查
 *
 * 软 DTU 不知道 UartNode 长啥样，只知道"4G 协议"那套契约
 * UartNode 不知道软 DTU 是真的还是假的，只当普通 DTU
 *
 * 跟 server 端的关系：完全无关（Cairui 2026-07-14 16:21 拍板）
 *   - 跟普通硬件 DTU 完全对等
 *   - server 端零改动，零端点
 *   - 协议定义本地 hardcode（src/protocol/protocol-catalog.ts）
 */

import { EventEmitter } from "node:events";
import type { TcpTransport } from "../transport/tcp.ts";
import type { SoftDtuConfig } from "./config.ts";
import { atResponse, isAtCommand, extractAtCommand } from "./at-handler.ts";

export interface CellularDtuOptions {
  config: SoftDtuConfig;
  tcp: TcpTransport;
}

export class CellularDtu extends EventEmitter {
  private readonly config: SoftDtuConfig;
  private readonly tcp: TcpTransport;
  private connected = false;
  private registered = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: number | null = null;

  constructor(opts: CellularDtuOptions) {
    super();
    this.config = opts.config;
    this.tcp = opts.tcp;
  }

  /**
   * 启动 DTU（连 UartNode + 发注册包 + 响应 AT）
   */
  async start(): Promise<void> {
    this.tcp.on("data", (data) => this.onTcpData(data));
    this.tcp.on("close", () => this.onTcpClose());
    this.tcp.on("error", (err) => this.emit("log", `tcp error: ${err.message}`));

    await this.connect();
  }

  /**
   * 停止 DTU
   */
  stop(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.tcp.close();
    this.connected = false;
    this.registered = false;
  }

  /**
   * TCP 连接 UartNode
   */
  private async connect(): Promise<void> {
    const mac = this.config.virtualImei.slice(-12);
    this.emit("log", `connecting to UartNode ${this.config.uartNode.host}:${this.config.uartNode.port} as mac=${mac}`);

    try {
      await this.tcp.connect();
      this.connected = true;
      this.reconnectAttempts = 0;
      this.emit("log", "tcp connected");

      // 主动发注册包（不等 UartNode 推 +++AT+ 仪式，直接发）
      // 协议：register&mac=<IMEI>&host=<hostname>
      // 跟 UartNode 端 src/server/register-handler.ts:CellularRegisterHandler.handle 1:1
      const hostname = (await this.getHostname()) ?? "soft-dtu";
      const registerPacket =
        `register&mac=${this.config.virtualImei}&host=${hostname}&softdtu=1\r\n`;
      await this.tcp.send(new TextEncoder().encode(registerPacket));
      this.registered = true;
      this.emit("log", `register sent: ${registerPacket.trim()}`);
    } catch (err) {
      this.emit("log", `connect failed: ${(err as Error).message}`);
      this.scheduleReconnect();
    }
  }

  /**
   * TCP 数据接收（UartNode → 软 DTU）
   * 处理两类：
   *   1. UartNode 推的 +++AT+NREGEN/NREGDT/IOTUID 仪式（连接握手时）
   *   2. UartNode 发的 +++AT+XXX 查询（8 条 AT 批量查）
   *   3. UartNode 下发的 +++AT+XXX 操作指令（透传穿到硬件设备 — Phase 2）
   */
  private async onTcpData(data: Uint8Array): Promise<void> {
    const str = new TextDecoder().decode(data);
    this.emit("log", `tcp <<< ${str.trim()}`);

    if (isAtCommand(str)) {
      const cmd = extractAtCommand(str);
      this.emit("log", `at cmd: ${cmd}`);

      // 特殊处理 UartNode 推的 NREGEN/NREGDT 仪式（不响应，让 UartNode 知道我们 ok）
      if (cmd.startsWith("NREGEN") || cmd.startsWith("NREGDT") || cmd.startsWith("IOTUID")) {
        // 软 DTU 已经主动发了 register 包，NREGEN/NREGDT 仪式是冗余的
        // 但要 ack 让 UartNode 不 destroy socket
        await this.tcp.send(new TextEncoder().encode("+ok=\r\n"));
        return;
      }

      // 8 条核心 AT 查询 — 走 atResponse 生成响应
      const response = atResponse(str, this.config);
      await this.tcp.send(new TextEncoder().encode(response + "\r\n"));
      this.emit("log", `at resp: ${response}`);
    } else {
      // 透传数据（Phase 2 走硬件设备）
      this.emit("log", `passthrough: ${str.trim()}`);
    }
  }

  /**
   * TCP 关闭
   */
  private onTcpClose(): void {
    this.connected = false;
    this.registered = false;
    this.emit("log", "tcp closed");
    this.scheduleReconnect();
  }

  /**
   * 退避重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit("log", "max reconnect attempts reached, giving up");
      return;
    }
    this.reconnectAttempts++;
    // 跟 UartNode 端 src/dtus/state.ts:computeReconnectBackoff 1:1
    // baseMs = min(16_000, 1000 * 2^(attempt-1)) + jitter
    const baseMs = Math.min(16_000, 1000 * 2 ** (this.reconnectAttempts - 1));
    const jitter = Math.random() * 500;
    const waitMs = Math.round(baseMs + jitter);
    this.emit("log", `reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${waitMs}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), waitMs);
  }

  /**
   * 获取本机 hostname
   */
  private async getHostname(): Promise<string | null> {
    try {
      // Deno 没有直接 os.hostname()，用 hostname 命令
      const cmd = new Deno.Command("hostname", { stdout: "piped" });
      const { stdout } = await cmd.output();
      return new TextDecoder().decode(stdout).trim();
    } catch {
      return null;
    }
  }
}
