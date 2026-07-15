/**
 * 协议目录 — 软 DTU 走 HTTP API 从 server 拉协议定义
 *
 * 数据通道：软 DTU 跟普通硬件 DTU 一样走 TCP 9000 4G 协议，UartNode 代理上行
 * 元数据通道：软 DTU 走 HTTP API GET /api/v2/protocols 拉协议定义（硬件 DTU 固件内固化）
 *
 * 优势：
 *   - 协议定义 server 端集中管理，加新协议不动软 DTU
 *   - 软 DTU 启动拉一次，5min 缓存 + offline fallback
 *   - 不用刷固件就能支持新协议
 *
 * 跟 server 端对接（待 ping agent-ae682922673b 加）：
 *   - 端点：GET {uartServer.url}/api/v2/protocols
 *   - 鉴权：D1=i 沿用不鉴权（dev/内网），生产要加 Bearer token
 *   - 响应 schema：{ protocols: ProtocolDefinition[] }
 *
 * Phase 1 范围：从 server 拉汉枫 4G / Modbus RTU 等协议
 * Phase 2 扩展：协议定义可以加 version 字段，server 端按 version 下发，软 DTU 按需升级
 *
 * 离线 fallback（server 不可达时）：
 *   - Modbus RTU 默认（公开标准，hardcode 安全）
 *   - 警告用户"协议目录是离线模式，新协议不可用"
 */

export interface AtCommandDefinition {
  name: string;
  cmd: string;
  parse: string; // 正则字符串
  description?: string;
}

export interface RegisterDefinition {
  /** 注册包格式（带 %MAC / %HOST 占位符）*/
  format: string;
  /** IMEI 位数（汉枫 15 位）*/
  imeiLength: number;
  /** 是否在 UartNode 推 +++AT+ 仪式后才发 */
  triggerOnInvite: boolean;
}

export interface ProtocolDefinition {
  id: string;
  name: string;
  type: "cellular-4g-dtu" | "modbus-rtu" | "lan-gateway" | "uart-direct";
  manufacturer?: string;
  model?: string;
  category?: string;
  version?: string; // 协议定义版本，server 端可加
  metadata?: Record<string, string>;
  atCommands?: AtCommandDefinition[];
  /** modbus 寄存器表（485 协议用，Phase 2）*/
  registers?: Array<{
    address: number;
    name: string;
    type: "coil" | "discrete" | "holding" | "input";
    dataType: "uint16" | "int16" | "uint32" | "int32" | "float" | "double";
    unit?: string;
    scale?: number;
    description?: string;
  }>;
  /** 注册包定义（4G 协议用）*/
  register?: RegisterDefinition;
  /** 默认串口参数（485 协议用）*/
  defaultSerial?: {
    baudRate: number;
    dataBits: 5 | 6 | 7 | 8;
    stopBits: 1 | 2;
    parity: "none" | "even" | "odd" | "mark" | "space";
  };
  /** 传输层配置 */
  transport?: "tcp:9000" | "serial" | "tcp:custom";
}

/**
 * 离线 fallback — server 不可达时使用
 *
 * 只放公开标准的协议（modbus RTU），不放专有协议（汉枫 4G）
 * 避免 server 不可达时假装支持汉枫协议
 */
export const OFFLINE_FALLBACK: ProtocolDefinition[] = [
  {
    id: "modbus-rtu-default",
    name: "Modbus RTU RS485 默认 (离线 fallback)",
    type: "modbus-rtu",
    category: "工业总线",
    metadata: {
      note: "server 不可达时的 fallback，公开标准协议",
    },
    registers: [
      { address: 0, name: "电压", type: "input", dataType: "uint16", unit: "V", scale: 0.1, description: "电网电压" },
      { address: 1, name: "电流", type: "input", dataType: "uint16", unit: "A", scale: 0.01, description: "负载电流" },
      { address: 2, name: "功率", type: "input", dataType: "uint32", unit: "W", description: "有功功率" },
      { address: 100, name: "设备地址", type: "holding", dataType: "uint16", description: "从站地址 (1-247)" },
    ],
    defaultSerial: {
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: "even", // modbus RTU 标准
    },
    transport: "serial",
  },
];

/**
 * 协议仓库 — HTTP fetch + 缓存 + offline fallback
 *
 * 不依赖 socket.io-client，纯 HTTP fetch
 * 5min 缓存避免每个 UI 操作都打 server
 */
export class ProtocolRepository {
  private cache: ProtocolDefinition[] = [];
  private lastFetch = 0;
  private readonly cacheTtlMs: number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private fetching: Promise<ProtocolDefinition[]> | null = null;
  private readonly updateHandlers = new Set<(p: ProtocolDefinition[]) => void>();

  constructor(opts: { baseUrl: string; cacheTtlMs?: number; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /**
   * 获取协议列表（带缓存）
   */
  async list(): Promise<ProtocolDefinition[]> {
    const now = Date.now();
    if (this.cache.length > 0 && now - this.lastFetch < this.cacheTtlMs) {
      return this.cache;
    }
    // 防止并发 fetch
    if (this.fetching) {
      return this.fetching;
    }
    this.fetching = this.fetchFromServer().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  /**
   * 强制刷新（忽略缓存）
   */
  async refresh(): Promise<ProtocolDefinition[]> {
    this.lastFetch = 0;
    return this.list();
  }

  /**
   * 按 ID 查询（从缓存）
   */
  get(id: string): ProtocolDefinition | undefined {
    return this.cache.find((p) => p.id === id);
  }

  /**
   * 协议更新回调（WebView 订阅）
   */
  onUpdate(handler: (protocols: ProtocolDefinition[]) => void): () => void {
    this.updateHandlers.add(handler);
    return () => this.updateHandlers.delete(handler);
  }

  /**
   * 当前是否处于离线模式
   */
  isOffline(): boolean {
    return this.cache.length === 0 || this.cache === OFFLINE_FALLBACK;
  }

  /**
   * 实际从 server 拉协议定义
   *
   * 端点：GET {baseUrl}/api/v2/protocols
   * 响应：{ protocols: ProtocolDefinition[] }
   * 鉴权：D1=i 不鉴权（dev/内网），生产要加 Bearer token
   */
  private async fetchFromServer(): Promise<ProtocolDefinition[]> {
    const url = `${this.baseUrl}/api/v2/protocols`;
    console.log(`[protocol-catalog] fetching ${url}`);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      if (!data || !Array.isArray(data.protocols)) {
        throw new Error(`invalid response: protocols field not found`);
      }
      // schema 校验（轻量）
      const protocols: ProtocolDefinition[] = data.protocols.map((p: any, idx: number) => {
        if (!p.id || !p.name || !p.type) {
          throw new Error(`protocol[${idx}] missing required fields: id/name/type`);
        }
        return p as ProtocolDefinition;
      });
      this.cache = protocols;
      this.lastFetch = Date.now();
      console.log(`[protocol-catalog] loaded ${protocols.length} protocols from server`);
      // 通知订阅者
      for (const h of this.updateHandlers) {
        try {
          h(this.cache);
        } catch (err) {
          console.warn(`[protocol-catalog] update handler error:`, err);
        }
      }
      return this.cache;
    } catch (err) {
      const msg = (err as Error).message;
      console.warn(`[protocol-catalog] fetch failed (${msg}), using ${this.cache.length > 0 ? "stale cache" : "offline fallback"}`);
      if (this.cache.length === 0) {
        this.cache = OFFLINE_FALLBACK;
        this.lastFetch = Date.now(); // 避免重试
      }
      return this.cache;
    }
  }
}
