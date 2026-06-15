/**
 * HTTP 上传器（替换 src/fetch.ts 单点 fetch + console.log）
 *
 * 跟 uart-pesiv-node src/services/uploader.ts 同构——同样队列 + 背压 + 重试 + drain 模式。
 *
 * 设计要点：
 *   1. 队列 + 并发 worker 池：背压可控
 *   2. 单次超时 + 指数退避重试
 *   3. 失败打到 console.error，不抛异常影响主循环
 *   4. 5min 去重（cairui 拍板）—— dtuAlert 路径
 *   5. 测试钩子：__setNodeTokenForTest / __setServerUrlForTest / __resetUploaderForTest
 *
 * 跟 fetch.ts 行为**兼容性**：
 *   - 旧 fetch.dtuInfo / nodeInfo / queryData 3 个方法**保留 API 表面**（继续 default export 单例）
 *   - 内部从"打一次 log 一次"变成"入队即返 + 异步上传"
 *   - 这意味着**调用方拿不到 HTTP 状态**——但旧代码也没人 check status（直接 return err）
 *
 * 注意：server 端已经有 5s 最小查询间隔和 30s 同 mac+pid 去重，
 * 客户端不必自己做请求去重。
 */

import { NODE_TOKEN, SERVER_URL } from '../config'

interface QueueItem {
  path: string
  body: unknown
  attempt: number
  enqueuedAt: number
}

const queue: QueueItem[] = []
let inflight = 0
let closed = false
let drainResolvers: Array<() => void> = []

/** 测试钩子：覆盖 NODE_TOKEN（生产代码不调） */
let _tokenOverride: string | null = null
let _serverUrlOverride: string | null = null

export function __setNodeTokenForTest(token: string | null): void {
  _tokenOverride = token
}
export function __setServerUrlForTest(url: string | null): void {
  _serverUrlOverride = url
}

/** 队列水位（用于监控 / debug） */
export function queueStats(): { queued: number; inflight: number; capacity: number } {
  return { queued: queue.length, inflight, capacity: UPLOAD_QUEUE_MAX }
}

/** 等待队列清空（关闭时用） */
export function drainQueue(timeoutMs = 10_000): Promise<void> {
  if (queue.length === 0 && inflight === 0) return Promise.resolve()
  return new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      drainResolvers = drainResolvers.filter(r => r !== resolve)
      resolve()
    }, timeoutMs)
    drainResolvers.push(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function resolveDrain(): void {
  if (queue.length === 0 && inflight === 0) {
    const resolvers = drainResolvers
    drainResolvers = []
    for (const r of resolvers) r()
  }
}

/**
 * 入队一个上传任务。
 * 队列满时丢弃最老的（server 有去重，最新数据更值钱）。
 */
export function enqueue(path: string, body: unknown): boolean {
  if (closed) return false
  if (queue.length >= UPLOAD_QUEUE_MAX) {
    queue.shift() // drop oldest
    console.warn(`[uploader] queue full (${UPLOAD_QUEUE_MAX}), dropped oldest`)
  }
  queue.push({ path, body, attempt: 0, enqueuedAt: Date.now() })
  pump()
  return true
}

function pump(): void {
  while (inflight < UPLOAD_CONCURRENCY && queue.length > 0) {
    const item = queue.shift()!
    inflight++
    void runItem(item).finally(() => {
      inflight--
      if (queue.length > 0) pump()
      else resolveDrain()
    })
  }
}

async function runItem(item: QueueItem): Promise<void> {
  const baseUrl = _serverUrlOverride !== null ? _serverUrlOverride : SERVER_URL
  const url = baseUrl + item.path
  const age = Date.now() - item.enqueuedAt

  // PR #20 鉴权：HTTP /api/node/* 必须带 x-node-token
  // server 端从 header 优先取，其次 body.nodeToken
  const token = _tokenOverride !== null ? _tokenOverride : NODE_TOKEN
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['x-node-token'] = token

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(item.body),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    // 成功：不读取 body（节省 CPU/内存），204/200 都算 OK
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (item.attempt < UPLOAD_RETRY_MAX) {
      const backoffMs = 200 * 2 ** item.attempt + Math.random() * 100
      console.warn(`[uploader] ${item.path} failed (${msg}); retry ${item.attempt + 1}/${UPLOAD_RETRY_MAX} in ${backoffMs.toFixed(0)}ms (age=${age}ms)`)
      item.attempt++
      setTimeout(() => {
        queue.push(item)
        pump()
      }, backoffMs)
    } else {
      console.error(`[uploader] ${item.path} gave up after ${UPLOAD_RETRY_MAX + 1} attempts: ${msg} (age=${age}ms)`)
    }
  }
}

export function closeUploader(): void {
  closed = true
}

/** 测试钩子：重置 closed + 清空队列 */
export function __resetUploaderForTest(): void {
  closed = false
  queue.length = 0
  inflight = 0
  drainResolvers = []
}

// ======================== 内部 config（避免 import 循环） ========================

/** HTTP 上传并发上限 */
const UPLOAD_CONCURRENCY = 4
/** HTTP 上传队列上限（背压） */
const UPLOAD_QUEUE_MAX = 1000
/** HTTP 单次请求超时 */
const UPLOAD_TIMEOUT_MS = 5_000
/** HTTP 重试最大次数 */
const UPLOAD_RETRY_MAX = 2
