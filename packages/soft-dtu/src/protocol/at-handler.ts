/**
 * 4G DTU AT 指令响应
 *
 * 实现汉枫 HF2411 的 8 条核心 AT 指令（跟 UartNode 端 cellular.ts:initialize() 1:1 对齐）：
 *   - PID    → +ok=HF2411
 *   - VER    → +ok=V3.0.0
 *   - GVER   → +ok=G4
 *   - IOTEN  → +ok=on / +ok=off
 *   - ICCID  → +ok=89860117851000012345
 *   - LOCATE → +ok=<lat>,<lon>
 *   - UART   → +ok=115200,8,N,1
 *   - GSLQ   → +ok=20
 *
 * 跟 src/dtus/cellular.ts:queryAT() 行为 1:1 兼容
 *   - UartNode 发 '+++AT+PID\r' → 软 DTU 返回 '+ok=HF2411'
 *   - UartNode 解析 '/^\+ok=/i' 匹配，存进 dtu.PID 字段
 *
 * Phase 1 实现：8 条硬编码响应
 * Phase 2 实现：跟 uart-server 拉协议定义动态生成
 *
 * 不实现 LOCATE 真实定位（软 DTU 在 dev 电脑上，没 GPS 模组）— 返回 dev 坐标
 * 不实现 GSLQ 真实信号（软 DTU 没蜂窝模组）— 返回 config.signal 默认值
 */

import type { SoftDtuConfig } from "./config.ts";

/**
 * AT 指令响应生成器
 *
 * 输入: '+++AT+PID\r' (Buffer)
 * 输出: '+ok=HF2411\r' (Buffer)
 */
export function atResponse(
  command: string,
  config: SoftDtuConfig,
): string {
  // 去掉 '+++AT+' 前缀和 '\r' 后缀
  const cmd = command.replace(/^\+{3}AT\+/, "").replace(/\r$/, "").trim();

  switch (cmd) {
    case "PID":
      return `+ok=${config.pid}`;

    case "VER":
      return `+ok=${config.ver}`;

    case "GVER":
      return `+ok=${config.gver}`;

    case "IOTEN":
      // 软 DTU 总是返回 on（UartNode 端 CellularDtu.initialize() 会再发 IOTEN=off 关流量）
      return `+ok=${config.iotStat}`;

    case "ICCID":
      return `+ok=${config.iccid}`;

    case "LOCATE=1":
      // dev 坐标（上海张江，cairui 办公室附近）
      return `+ok=31.2049,121.5986`;

    case "UART=1":
      // 报告当前串口参数
      return `+ok=${config.defaultSerial.baudRate},${config.defaultSerial.dataBits},${config.defaultSerial.parity[0]?.toUpperCase() ?? "N"},${config.defaultSerial.stopBits}`;

    case "GSLQ":
      return `+ok=${config.signal}`;

    case "IOTEN=off":
      // UartNode 关流量指令，软 DTU 模拟 ack（不实际做啥）
      return `+ok=`;

    case "Z":
      // 硬重启（UartNode 端 10 次超时硬重启走这条）
      // 软 DTU 不真重启（保持 dev 状态），返回 ack 让 UartNode 走 60s 重连路径
      return `+ok=`;

    default:
      // 未知指令 — 返回 +err 让 UartNode 知道（保持跟真硬件 DTU 一致的行为）
      return `+err=unknown command: ${cmd}`;
  }
}

/**
 * 检查是否是 AT 指令（前缀 +++AT+）
 */
export function isAtCommand(data: Uint8Array | string): boolean {
  const str = typeof data === "string" ? data : new TextDecoder().decode(data);
  return str.startsWith("+++AT+");
}

/**
 * 提取 AT 指令内容（去掉前缀 + 后缀）
 */
export function extractAtCommand(data: Uint8Array | string): string {
  const str = typeof data === "string" ? data : new TextDecoder().decode(data);
  return str.replace(/^\+{3}AT\+/, "").replace(/\r$/, "").trim();
}
