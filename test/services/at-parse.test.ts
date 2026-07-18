/**
 * AT 指令响应解析 — 单元测试
 * 纯函数 0 mock
 */

import { describe, test, expect } from 'bun:test'
import { parseATResponse, ATParse, type ATParseResult, type ATParseStatus } from '../../src/services/at-parse'

describe('at-parse / parseATResponse — 基础解析', () => {
  test('解析 +ok= 响应', () => {
    const r = parseATResponse(Buffer.from('+ok=PID:HF2411\r\n'))
    expect(r.status).toBe('ok')
    expect(r.AT).toBe(true)
    expect(r.msg).toBe('PID:HF2411')
  })

  test('解析 +err= 响应', () => {
    const r = parseATResponse(Buffer.from('+err=timeout\r\n'))
    expect(r.status).toBe('error')
    expect(r.AT).toBe(false)
    expect(r.msg).toBe('timeout')
  })

  test('解析不识别格式（透传 msg）', () => {
    const r = parseATResponse(Buffer.from('unknown response'))
    expect(r.status).toBe('invalid')
    expect(r.AT).toBe(false)
    expect(r.msg).toBe('unknown response')
  })

  test('支持 string 输入（兼容老调用）', () => {
    const r = parseATResponse('+ok=hello world')
    expect(r.status).toBe('ok')
    expect(r.AT).toBe(true)
    expect(r.msg).toBe('hello world')
  })

  test('null / undefined 输入 → invalid', () => {
    expect(parseATResponse(null).status).toBe('invalid')
    expect(parseATResponse(undefined).status).toBe('invalid')
    expect(parseATResponse(null).msg).toBe('')
  })
})

describe('at-parse / parseATResponse — 大小写 + 空格处理', () => {
  test('+OK= 大写也识别', () => {
    const r = parseATResponse(Buffer.from('+OK=PID:HF2411'))
    expect(r.status).toBe('ok')
    expect(r.AT).toBe(true)
  })

  test('+Err= 大写也识别', () => {
    const r = parseATResponse(Buffer.from('+Err=timeout'))
    expect(r.status).toBe('error')
    expect(r.AT).toBe(false)
  })

  test('前后空白 trim', () => {
    const r = parseATResponse(Buffer.from('  \r\n+ok=clean\r\n  '))
    expect(r.status).toBe('ok')
    expect(r.msg).toBe('clean')
  })

  test('msg 内容中间空格保留', () => {
    const r = parseATResponse(Buffer.from('+ok=hello world foo'))
    expect(r.msg).toBe('hello world foo')
  })
})

describe('at-parse / parseATResponse — 边界', () => {
  test('空 Buffer', () => {
    const r = parseATResponse(Buffer.from(''))
    expect(r.status).toBe('invalid')
    expect(r.msg).toBe('')
    expect(r.AT).toBe(false)
  })

  test('空字符串', () => {
    const r = parseATResponse('')
    expect(r.status).toBe('invalid')
    expect(r.AT).toBe(false)
  })

  test('只有 +ok 没有 =', () => {
    const r = parseATResponse(Buffer.from('+ok'))
    // 匹配 ^\+ok= 不匹配（无 =），但 ^\+ok= 还是匹配（== 可选?）—— 实际是不匹配
    // 期待 invalid（透传）
    expect(r.status).toBe('invalid')
    expect(r.AT).toBe(false)
  })

  test('+ok= 紧跟空内容（设备 ack 但无 payload）', () => {
    const r = parseATResponse(Buffer.from('+ok='))
    expect(r.status).toBe('ok')
    expect(r.AT).toBe(true)
    expect(r.msg).toBe('')
  })

  test('+ok 不带等号 单独 +ok 字符', () => {
    const r = parseATResponse(Buffer.from('+ok'))
    expect(r.status).toBe('invalid')
    expect(r.AT).toBe(false)
    expect(r.msg).toBe('+ok')
  })
})

describe('at-parse / ATParse 兼容垫片', () => {
  test('ATParse 返回 {AT, msg} 形状（跟老 tool.ATParse 一致）', () => {
    expect(ATParse(Buffer.from('+ok=PID:HF2411'))).toEqual({ AT: true, msg: 'PID:HF2411' })
    expect(ATParse(Buffer.from('+err=timeout'))).toEqual({ AT: false, msg: 'timeout' })
    expect(ATParse(Buffer.from('unknown'))).toEqual({ AT: false, msg: 'unknown' })
  })

  test('ATParse(null) 跟老 tool.ATParse(null) 行为一致', () => {
    // 老 tool.ATParse(null) 走 else 分支返回 {AT: false, msg: ''}
    expect(ATParse(null)).toEqual({ AT: false, msg: '' })
  })

  test('@deprecated 标记存在', () => {
    // JSDoc 警告提示在 IDE 里看，不在这里做断言（@deprecated 是 JSDoc 关键字）
    // 本测试只是占位
    expect(typeof ATParse).toBe('function')
  })
})

describe('at-parse / 类型导出', () => {
  test('ATParseStatus 联合类型枚举值', () => {
    const statuses: ATParseStatus[] = ['ok', 'error', 'invalid']
    expect(statuses).toContain(parseATResponse('+ok=x').status)
    expect(statuses).toContain(parseATResponse('+err=x').status)
    expect(statuses).toContain(parseATResponse('x').status)
  })

  test('ATParseResult shape', () => {
    const r: ATParseResult = parseATResponse(Buffer.from('+ok=test'))
    expect(Object.keys(r).sort()).toEqual(['AT', 'msg', 'status'])
  })
})
