/**
 * 软 DTU WebView bindings 类型契约
 *
 * 必须 1:1 跟 Deno 端 `packages/soft-dtu/src/bindings/serial.ts` 和
 * `packages/soft-dtu/src/bindings/protocol.ts` 保持一致。
 *
 * Phase 1 走 HTTP（前端 fetch /api/* → Deno main.ts 启 deno serve 包装 bindings）
 * Phase 2 切 Deno Desktop official bindings SDK（window.bindings.* 直接 IPC）
 *
 * ⚠️ 改这里之前先看 server-api-contract.md 和 AGENTS.md 字段名约定：
 * 跨 worker 字段错位会**静默失败**（HTTP 拉不到 → 走 offline fallback → UI 缺协议）。
 */

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  productId?: string;
  vendorId?: string;
}

export interface SerialOptions {
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd" | "mark" | "space";
  lock?: boolean;
}

export interface CurrentPort {
  path: string;
  options: SerialOptions;
}

export interface AtCommandDefinition {
  name: string;
  cmd: string;
  parse: string;
  description?: string;
}

export interface RegisterDefinition {
  format: string;
  imeiLength: number;
  triggerOnInvite: boolean;
}

export interface ModbusRegister {
  address: number;
  name: string;
  type: "coil" | "discrete" | "holding" | "input";
  dataType: "uint16" | "int16" | "uint32" | "int32" | "float" | "double";
  unit?: string;
  scale?: number;
  description?: string;
}

export interface ProtocolDefinition {
  id: string;
  name: string;
  type: "cellular-4g-dtu" | "modbus-rtu" | "lan-gateway" | "uart-direct";
  manufacturer?: string;
  model?: string;
  category?: string;
  version?: string;
  metadata?: Record<string, string>;
  atCommands?: AtCommandDefinition[];
  registers?: ModbusRegister[];
  register?: RegisterDefinition;
  defaultSerial?: {
    baudRate: number;
    dataBits: 5 | 6 | 7 | 8;
    stopBits: 1 | 2;
    parity: "none" | "even" | "odd" | "mark" | "space";
  };
  transport?: "tcp:9000" | "serial" | "tcp:custom";
}

export interface SerialBindings {
  list(): Promise<SerialPortInfo[]>;
  open(path: string, options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  write(data: string | Uint8Array): Promise<void>;
  isOpen(): boolean;
  currentPort(): CurrentPort | null;
  onData(handler: (data: Uint8Array) => void): () => void;
  onError(handler: (err: Error) => void): () => void;
  onClose(handler: () => void): () => void;
}

export interface ProtocolBindings {
  list(): Promise<ProtocolDefinition[]>;
  get(id: string): ProtocolDefinition | undefined;
  refresh(): Promise<ProtocolDefinition[]>;
  isOffline(): boolean;
  onUpdate(handler: (protocols: ProtocolDefinition[]) => void): () => void;
}

export interface SoftDtuBindings {
  serial: SerialBindings;
  protocol: ProtocolBindings;
}
