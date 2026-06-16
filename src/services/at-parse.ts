/**
 * AT 指令响应解析
 * 替代 src/tool.ts ATParse() 静态方法（PR #3 拆出）
 *
 * 跟 uart-pesiv-node src/util/at-parse.ts 同构——纯函数，无副作用
 *
 * 设计要点：
 *   1. 显式 Result 类型（替代原来的 `{AT: boolean, msg: string}` 隐式约定）
 *   2. 三种结果状态：ok / error / invalid（替代原来只有 AT true/false 二态）
 *   3. 错误信息规范化：trim + 去前缀（+ok= / +err=）+ 空字符串处理
 *   4. 不抛异常（输入校验返回 invalid）—— 跟 §3.7 错误处理「边界层不抛」原则一致
 */

export type ATParseStatus = 'ok' | 'error' | 'invalid'

export interface ATParseResult {
  /** 解析状态：ok=设备正常响应, error=设备返回错误, invalid=输入无效 */
  status: ATParseStatus
  /** 原始响应字符串（去 +ok= / +err= 前缀，trim 后） */
  msg: string
  /** 旧字段保留：status === 'ok' 时为 true（兼容 client.ts 现有逻辑） */
  AT: boolean
}

/**
 * 解析 DTU 返回的 AT 指令响应
 *
 * @param buffer 设备响应（Buffer 或 string）
 * @returns 解析结果
 *
 * @example
 *   parseATResponse(Buffer.from('+ok=PID:HF2411\r\n'))
 *   // => { status: 'ok', msg: 'PID:HF2411', AT: true }
 *
 *   parseATResponse(Buffer.from('+err=timeout\r\n'))
 *   // => { status: 'error', msg: 'timeout', AT: false }
 *
 *   parseATResponse(Buffer.from('unknown response'))
 *   // => { status: 'invalid', msg: 'unknown response', AT: false }
 *
 *   parseATResponse(null)
 *   // => { status: 'invalid', msg: '', AT: false }
 */
export function parseATResponse(buffer: Buffer | string | null | undefined): ATParseResult {
  if (!buffer) {
    return { status: 'invalid', msg: '', AT: false }
  }

  const str = typeof buffer === 'string'
    ? buffer
    : buffer.toString('utf8').trim()

  // 设备返回错误：+err=... 或 +ERR=...
  if (/^\+err=/i.test(str)) {
    return {
      status: 'error',
      msg: str.replace(/^\+err=/i, '').trim(),
      AT: false
    }
  }

  // 设备正常响应：+ok=... 或 +OK=...
  if (/^\+ok=/i.test(str)) {
    return {
      status: 'ok',
      msg: str.replace(/^\+ok=/i, '').trim(),
      AT: true
    }
  }

  // 不识别格式：原样透传（不报错，给上层处理）
  return {
    status: 'invalid',
    msg: str,
    AT: false
  }
}

/**
 * 旧 tool.ATParse 兼容垫片
 *
 * @deprecated 直接用 parseATResponse()。本函数保留是为老调用方平滑迁移，
 *             行为跟 v3.3.0 旧 tool.ATParse 1:1 等价。
 */
export function ATParse(buffer: Buffer | string | null | undefined): { AT: boolean; msg: string } {
  const result = parseATResponse(buffer)
  return { AT: result.AT, msg: result.msg }
}
