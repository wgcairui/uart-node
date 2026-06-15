/**
 * Uploader 单元测试
 *
 * 测的不变量：
 *   1. 队列：入队 / 排出顺序
 *   2. 背压：满队后 enqueue 丢最老的
 *   3. 并发：inflight <= UPLOAD_CONCURRENCY (4, 跟 pesiv 16 不同，UartNode 单进程流量小)
 *   4. 重试：失败后 attempt++，重排队
 *   5. 重试上限：超过 UPLOAD_RETRY_MAX 后放弃
 *   6. drain：能等队列清空
 *   7. close：closed=true 后 enqueue 返回 false
 *   8. 鉴权头：NODE_TOKEN 有时带 x-node-token
 *
 * 通过 uploader 暴露的 __setNodeTokenForTest / __setServerUrlForTest 钩子注入测试值。
 * 协议层（HTTP 真实发包）不在这测。
 *
 * 跟 src/services/uploader.test.ts (pesiv) 同构，但 UPLOAD_CONCURRENCY 4 (单进程流量)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as uploader from '../../src/services/uploader'
import type { queryOkUp } from 'uart'

const realFetch = globalThis.fetch

type FetchBehavior = 'ok' | '500' | 'network-error'
let fetchCalls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = []
let fetchBehavior: FetchBehavior = 'ok'
let fetchDelayMs = 0

function installFetchMock() {
  fetchCalls = []
  fetchBehavior = 'ok'
  fetchDelayMs = 0
  ;(globalThis as { fetch: typeof fetch }).fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    if (init?.headers) Object.assign(headers, init.headers as Record<string, string>)
    const body = typeof init?.body === 'string' ? init.body : ''
    fetchCalls.push({ url, method, headers, body })

    if (fetchDelayMs > 0) await new Promise(r => setTimeout(r, fetchDelayMs))

    if (fetchBehavior === 'network-error') throw new Error('ECONNREFUSED')
    if (fetchBehavior === '500') return new Response('boom', { status: 500 })
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  uploader.__setServerUrlForTest('http://test.local:1/')
  uploader.__setNodeTokenForTest('')
  uploader.__resetUploaderForTest()
})

afterEach(async () => {
  uploader.__setServerUrlForTest(null)
  uploader.__setNodeTokenForTest(null)
  ;(globalThis as { fetch: typeof fetch }).fetch = realFetch
  mock.restore()
  uploader.__resetUploaderForTest()
})

/** 等队列排空（包括重试 backoff 完成的最终态） */
async function waitDrain(timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const s = uploader.queueStats()
    if (s.queued === 0 && s.inflight === 0) {
      await new Promise(r => setTimeout(r, 20))
      const s2 = uploader.queueStats()
      if (s2.queued === 0 && s2.inflight === 0) return
    }
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`drain timeout: ${JSON.stringify(uploader.queueStats())}`)
}

/** 等 fetch 被调用到 expected 次（或超时） */
async function waitFetchCalls(expected: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fetchCalls.length >= expected) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`fetchCalls expected ${expected}, got ${fetchCalls.length}`)
}

describe('Uploader.enqueue / pump', () => {
  test('enqueue 一次会调一次 fetch', async () => {
    installFetchMock()
    uploader.enqueue('queryData', { hello: 'world' })
    await waitDrain()
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe('http://test.local:1/queryData')
    expect(fetchCalls[0]!.method).toBe('POST')
    expect(fetchCalls[0]!.body).toBe('{"hello":"world"}')
    expect(fetchCalls[0]!.headers['content-type']).toBe('application/json')
  })

  test('HTTP 5xx 会被当作失败重试', async () => {
    installFetchMock()
    fetchBehavior = '500'
    uploader.enqueue('dtuinfo', { x: 1 })
    // 1 + 2 = 3 次（1 初始 + 2 重试），因为 UPLOAD_RETRY_MAX = 2
    await waitFetchCalls(3, 5000)
    await waitDrain(5000)
    expect(fetchCalls.length).toBe(3)
  })

  test('网络错误（throw）也会重试 2 次（1 + 2）', async () => {
    installFetchMock()
    fetchBehavior = 'network-error'
    uploader.enqueue('nodeInfo', { x: 1 })
    await waitFetchCalls(3, 5000)
    await waitDrain(5000)
    expect(fetchCalls.length).toBe(3)
  })

  test('204 No Content 也算成功', async () => {
    installFetchMock()
    uploader.enqueue('queryData', {})
    await waitDrain()
    expect(fetchCalls).toHaveLength(1)
  })
})

describe('Uploader — 并发控制', () => {
  test('inflight 不会超过 UPLOAD_CONCURRENCY (4)', async () => {
    installFetchMock()
    fetchDelayMs = 30
    for (let i = 0; i < 50; i++) uploader.enqueue('queryData', { i })

    await new Promise(r => setTimeout(r, 5))
    const mid = uploader.queueStats()
    expect(mid.inflight).toBeLessThanOrEqual(4)
    expect(mid.inflight).toBeGreaterThan(0)

    await waitDrain(5000)
    expect(fetchCalls.length).toBe(50)
    const final = uploader.queueStats()
    expect(final.queued).toBe(0)
    expect(final.inflight).toBe(0)
  })
})

describe('Uploader — 背压', () => {
  test('队列满后 enqueue 会丢最老的 (drop oldest)', async () => {
    installFetchMock()
    fetchDelayMs = 50
    // UPLOAD_QUEUE_MAX 默认 1000；灌 1100 个
    for (let i = 0; i < 1100; i++) uploader.enqueue('queryData', { i })
    const s = uploader.queueStats()
    expect(s.queued).toBeLessThanOrEqual(1000)
    await waitFetchCalls(1000, 30_000)
    await waitDrain(30_000)
    // 总被 fetch 调用的 <= cap + concurrency (4)
    expect(fetchCalls.length).toBeLessThanOrEqual(1000 + 4)
    // 但一定 < 1100（确实丢了）
    expect(fetchCalls.length).toBeLessThan(1100)
  }, 30_000)
})

describe('Uploader.closeUploader()', () => {
  test('closed 之后 enqueue 返回 false，不调 fetch', async () => {
    installFetchMock()
    uploader.closeUploader()
    const r = uploader.enqueue('queryData', { x: 1 })
    expect(r).toBe(false)
    await new Promise(r => setTimeout(r, 20))
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('Uploader.drainQueue()', () => {
  test('空队列 + 无 inflight 时立即 resolve', async () => {
    installFetchMock()
    const start = Date.now()
    await uploader.drainQueue(1000)
    expect(Date.now() - start).toBeLessThan(50)
  })

  test('有任务时等所有都完成', async () => {
    installFetchMock()
    fetchDelayMs = 50
    for (let i = 0; i < 10; i++) uploader.enqueue('queryData', { i })
    await uploader.drainQueue(5000)
    expect(fetchCalls.length).toBe(10)
    expect(uploader.queueStats().queued).toBe(0)
    expect(uploader.queueStats().inflight).toBe(0)
  })

  test('超时（队列还有东西）也会 resolve', async () => {
    installFetchMock()
    fetchDelayMs = 1000
    for (let i = 0; i < 5; i++) uploader.enqueue('queryData', { i })
    const start = Date.now()
    await uploader.drainQueue(50)
    expect(Date.now() - start).toBeLessThan(200)
  })
})

describe('Uploader — 鉴权头', () => {
  test('NODE_TOKEN 有时会带 x-node-token header', async () => {
    installFetchMock()
    uploader.__setNodeTokenForTest('my-secret')
    uploader.enqueue('queryData', { x: 1 })
    await waitDrain()
    expect(fetchCalls[0]!.headers['x-node-token']).toBe('my-secret')
  })

  test('NODE_TOKEN 空时没有 x-node-token header', async () => {
    installFetchMock()
    uploader.__setNodeTokenForTest('')
    uploader.enqueue('queryData', { x: 1 })
    await waitDrain()
    expect(fetchCalls[0]!.headers['x-node-token']).toBeUndefined()
  })
})

describe('Uploader 便捷方法（来自 fetch.ts 包装）', () => {
  test('Fetch.dtuInfo 走 /dtuinfo + 包装 { info }', async () => {
    installFetchMock()
    const fetch = (await import('../../src/fetch')).default
    const fakeDtu: { mac: string; ip: string; port: number } = {
      mac: 'AABBCC000000',
      ip: '1.2.3.4',
      port: 5000
    }
    fetch.dtuInfo(fakeDtu)
    await waitDrain()
    expect(fetchCalls[0]!.url).toBe('http://test.local:1/dtuinfo')
    const body = JSON.parse(fetchCalls[0]!.body)
    expect(body.info).toEqual({ mac: 'AABBCC000000', ip: '1.2.3.4', port: 5000, DevMac: 'AABBCC000000' })
  })

  test('Fetch.queryData 走 /queryData + 包装 { data }', async () => {
    installFetchMock()
    const fetch = (await import('../../src/fetch')).default
    const fakeQuery: queryOkUp = {
      mac: 'AABBCC',
      pid: 0,
      type: 232,
      protocol: 'Pesiv卡',
      content: 'pesiv',
      mountDev: 'peisv',
      timeStamp: 1,
      time: 't',
      useBytes: 0,
      useTime: 600_000
    }
    fetch.queryData(fakeQuery)
    await waitDrain()
    expect(fetchCalls[0]!.url).toBe('http://test.local:1/queryData')
    expect(JSON.parse(fetchCalls[0]!.body)).toEqual({ data: fakeQuery })
  })

  test('Fetch.nodeInfo 走 /nodeInfo + payload = { name, node, tcp }', async () => {
    installFetchMock()
    const fetch = (await import('../../src/fetch')).default
    fetch.nodeInfo('pwsiv', { hostname: 'h1' }, 2)
    await waitDrain()
    expect(fetchCalls[0]!.url).toBe('http://test.local:1/nodeInfo')
    expect(JSON.parse(fetchCalls[0]!.body)).toEqual({ name: 'pwsiv', node: { hostname: 'h1' }, tcp: 2 })
  })
})
