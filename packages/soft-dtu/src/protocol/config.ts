/**
 * 软 DTU 配置
 *
 * 启动时读：
 *   - 虚拟 IMEI（dev 用，避免跟真硬件 IMEI 冲突；server 端按 mac 查 device profile）
 *   - 设备 PID / VER / ICCID（伪装成汉枫 HF2411 4G DTU）
 *   - UartNode host:port（数据通道，跟普通硬件 DTU 一样）
 *   - uart-server URL（元数据通道，HTTP API 拉协议定义）
 *   - 默认串口参数（baudRate / dataBits / stopBits / parity）
 *
 * 配置来源（优先级从高到低）：
 *   1. 环境变量（container / shell 注入）
 *   2. ~/.config/soft-dtu/config.json（用户 home 目录持久化）
 *   3. 默认值（dev fallback）
 *
 * 全 env 驱动模式（跟 UartNode config.ts 风格对齐）：
 *   - 避免 NODE_ENV / isProd 模式判断
 *   - bun build / deno compile 静态分析时不会 DCE 掉 prod 分支
 *
 * 跟 server 端的关系（Cairui 2026-07-14 16:29 + 16:35 拍板）：
 *   - 软 DTU 走 HTTP API 从 server 拉协议定义
 *   - HTTP API 不鉴权（dev/内网）
 *   - 不连 Socket.IO（src/transport/socketio.ts 废弃，commit 时 git rm）
 *   - 跟普通硬件 DTU 一样走 TCP 9000 + 4G 协议（数据通道）
 *   - server 端 0 改动需要 ping agent-ae682922673b 加 GET /api/v2/protocols 端点
 *   - 协议让用户手动选，UI 启动不预选（cairui 2026-07-14 16:35 拍板）
 */

import { exists } from "jsr:@std/fs@^1.0.0/exists";
import { join } from "jsr:@std/path@^1.0.0/join";

export interface SoftDtuConfig {
  /** 虚拟 IMEI（15 位，跟硬件 DTU 一样）*/
  virtualImei: string;
  /** DTU 设备型号（汉枫 HF2411）*/
  pid: string;
  /** 固件版本 */
  ver: string;
  /** GPRS 版本 */
  gver: string;
  /** ICCID（SIM 卡号，软 DTU 随便填）*/
  iccid: string;
  /** IOT 平台状态（on / off）*/
  iotStat: string;
  /** 初始信号强度（0-31）*/
  signal: number;
  /** UartNode 接入点（数据通道）*/
  uartNode: {
    host: string;
    port: number;
  };
  /** uart-server 接入点（元数据通道，HTTP API 拉协议，不鉴权）*/
  uartServer: {
    url: string;
    /** API 路径前缀，默认 /api/v2 */
    apiPath: string;
    /** 鉴权 token（dev 空，生产可填，但当前契约是不鉴权）*/
    apiToken: string;
    /** HTTP 请求超时（ms）*/
    timeoutMs: number;
  };
  /** 默认串口参数（跟 XCOM / sscom 默认值对齐：115200/8/N/1）*/
  defaultSerial: {
    baudRate: number;
    dataBits: 5 | 6 | 7 | 8;
    stopBits: 1 | 2;
    parity: "none" | "even" | "odd" | "mark" | "space";
  };
}

const DEFAULT_CONFIG: SoftDtuConfig = {
  virtualImei: Deno.env.get("SOFT_DTU_IMEI") ?? "358700000000123",
  pid: Deno.env.get("SOFT_DTU_PID") ?? "HF2411",
  ver: Deno.env.get("SOFT_DTU_VER") ?? "V3.0.0",
  gver: Deno.env.get("SOFT_DTU_GVER") ?? "G4",
  iccid: Deno.env.get("SOFT_DTU_ICCID") ?? "89860117851000012345",
  iotStat: Deno.env.get("SOFT_DTU_IOTSTAT") ?? "on",
  signal: Deno.env.get("SOFT_DTU_SIGNAL") ? Number(Deno.env.get("SOFT_DTU_SIGNAL")) : 20,
  uartNode: {
    host: Deno.env.get("UART_NODE_HOST") ?? "127.0.0.1",
    port: Number(Deno.env.get("UART_NODE_PORT") ?? 9000),
  },
  uartServer: {
    url: Deno.env.get("UART_SERVER_URL") ?? "http://127.0.0.1:9010",
    apiPath: Deno.env.get("UART_SERVER_API_PATH") ?? "/api/v2",
    apiToken: Deno.env.get("UART_SERVER_API_TOKEN") ?? "", // 当前契约不鉴权，保留字段兼容未来
    timeoutMs: Number(Deno.env.get("UART_SERVER_TIMEOUT_MS") ?? 10_000),
  },
  defaultSerial: {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
  },
};

/**
 * 加载配置（env > home config > default）
 */
export async function loadConfig(): Promise<SoftDtuConfig> {
  // 1. env 覆盖
  const fromEnv: Partial<SoftDtuConfig> = {
    virtualImei: Deno.env.get("SOFT_DTU_IMEI"),
    pid: Deno.env.get("SOFT_DTU_PID"),
    ver: Deno.env.get("SOFT_DTU_VER"),
    gver: Deno.env.get("SOFT_DTU_GVER"),
    iccid: Deno.env.get("SOFT_DTU_ICCID"),
    iotStat: Deno.env.get("SOFT_DTU_IOTSTAT"),
    signal: Deno.env.get("SOFT_DTU_SIGNAL") ? Number(Deno.env.get("SOFT_DTU_SIGNAL")) : undefined,
  };

  // 2. home config
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "/tmp";
  const configPath = join(home, ".config", "soft-dtu", "config.json");
  let fromHome: Partial<SoftDtuConfig> = {};
  if (await exists(configPath)) {
    try {
      const text = await Deno.readTextFile(configPath);
      fromHome = JSON.parse(text);
      console.log(`[config] loaded from ${configPath}`);
    } catch (err) {
      console.warn(`[config] failed to parse ${configPath}:`, err);
    }
  }

  // 3. merge (env > home > default)
  return {
    ...DEFAULT_CONFIG,
    ...fromHome,
    ...Object.fromEntries(Object.entries(fromEnv).filter(([_, v]) => v !== undefined)),
  };
}
