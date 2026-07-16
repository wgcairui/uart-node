/**
 * 串口 Transport — USB 转 485 设备通信
 *
 * 用 npm:serialport（Deno 1.4+ 支持 npm specifier）
 *
 * 行为：
 *   - list(): 列出本机可用串口（/dev/tty.usbserial-* on macOS, /dev/ttyUSB* on Linux, COM* on Windows）
 *   - open(path, options): 打开串口
 *   - write(data): 发数据到 RS485 设备
 *   - on("data", ...): 收 RS485 设备响应
 *   - close(): 关闭串口
 *
 * macOS 上常见 USB 转串口芯片：
 *   - CH340 / CH341（最常见，便宜）
 *   - CP2102 / CP2104（Silicon Labs）
 *   - FT232（FTDI）
 *   - PL2303（Prolific）
 *
 * macOS 13+ 内置 CH340/CH343/CH9102/CP210x/FTDI 驱动，旧版需要装：
 *   - CH340: https://www.wch-ic.com/downloads/CH341SER_MAC_V1.7.html
 *   - CP2102: 内置（macOS 10.9+）
 *   - FT232: 内置
 *
 * 485 设备最常见是 Modbus RTU 协议：
 *   - npm:modbus-serial（Phase 2 加）
 *   - 软 DTU 当 master，485 设备当 slave
 *   - 软 DTU 同时连 UartNode（4G 协议）+ 串口（modbus RTU）
 *   - UartNode ←→ 软 DTU ←→ 485 设备
 */

import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";

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
  /** 软 DTU 独占还是共享（macOS 不支持共享，Linux/Mac 都 true）*/
  lock?: boolean;
}

export class SerialTransport extends EventEmitter {
  private port: SerialPort | null = null;

  /**
   * 列出本机可用串口
   */
  static async list(): Promise<SerialPortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      productId: p.productId,
      vendorId: p.vendorId,
    }));
  }

  /**
   * 打开串口
   */
  async open(path: string, options: SerialOptions): Promise<void> {
    if (this.port) {
      throw new Error("serial port already open");
    }
    this.port = new SerialPort({
      path,
      baudRate: options.baudRate,
      dataBits: options.dataBits ?? 8,
      stopBits: options.stopBits ?? 1,
      parity: options.parity ?? "none",
      lock: options.lock ?? true,
      autoOpen: false,
    });

    return new Promise<void>((resolve, reject) => {
      this.port!.open((err) => {
        if (err) {
          reject(err);
          return;
        }
        this.emit("log", `serial opened: ${path} @ ${options.baudRate} 8${options.parity?.[0]?.toUpperCase() ?? "N"}${options.stopBits ?? 1}`);
        this.port!.on("data", (data: Buffer) => {
          this.emit("data", new Uint8Array(data));
        });
        this.port!.on("error", (err: Error) => {
          this.emit("error", err);
        });
        this.port!.on("close", () => {
          this.emit("close");
        });
        resolve();
      });
    });
  }

  /**
   * 写数据到 485 设备
   */
  async write(data: Uint8Array): Promise<void> {
    if (!this.port || !this.port.isOpen) {
      throw new Error("serial port not open");
    }
    return new Promise<void>((resolve, reject) => {
      this.port!.write(Buffer.from(data), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * 关闭串口
   */
  close(): void {
    if (this.port) {
      this.port.close();
      this.port = null;
    }
  }

  /**
   * 当前是否打开
   */
  get isOpen(): boolean {
    return this.port?.isOpen ?? false;
  }
}

/**
 * 顶层 list 函数（main.ts 直接调）
 */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  return SerialTransport.list();
}
