/**
 * Dtu 抽象基类（UartNode RFC 002 §3.4 + §6.5 PR #4）
 *
 * 把 src/client.ts 的"单 DTU 状态机"从"具体 4G 实现"剥成"通用基类"——
 * 4G/2G/NB DTU 走 CellularDtu（PR #4 落地），未来 LAN 网关走 LanDtu（RFC 001）。
 *
 * 行为契约（跟 src/client.ts 1:1 对齐）：
 *   1. 通用：FIFO 队列 + AT/Oprate 插队到队首 + socket 锁 + 超时 10 次硬重启
 *   2. 通用：pause / resume（等待当前 socket 操作完成）
 *   3. 通用：onSocketClose → terminalOff(true) 上报 server
 *   4. 抽象：initialize() —— 4G 批量查 AT；LAN HTTP API
 *   5. 抽象：restart() —— 4G AT+Z；LAN HTTP /reboot
 *   6. 抽象：processQueue() —— 处理逻辑
 *
 * 设计要点：
 *   - 字段保持跟老 Client 一样的可访问性（protected 子类用，public 测试用）
 *   - IOClient 用 PR #1 class 版本（src/services/io-client.ts），不是顶层单例
 *   - socketsb 用 src/socket.ts 现成 class（不重写，staging 24h 行为兜底）
 *   - getPropertys() 保留老 11 字段形状，server 端契约不破坏
 *
 * 跟 uart-pesiv-node 暂无同构（pesiv 是单设备 UPS 卡，不需要 Dtu 抽象）。
 */

import { Socket } from 'net'
import { URLSearchParams } from 'url'
import { type queryObjectServer, type instructQuery, type DTUoprate, type socketResult, type IntructQueryResult, type ApolloMongoResult } from 'uart'
import socketsb from '../socket'
import { getIOClient } from '../services/io-client'
import { EVENT_NODE_TERMINAL_OFF } from '../protocol/events'
import { parseATResponse } from '../services/at-parse'
import fetch from '../fetch'
import config from '../config'
import {
  DtuState,
  type DtuHealth,
  type AlertType,
  type DtuAlert,
  computeHealth,
  isValidTransition,
  shouldReportHealth,
  HEALTH_REPORT_INTERVAL_MS
} from './state'

/** Dtu 队列中的指令项（QueryInstruct / OprateInstruct / ATInstruct） */
export type DtuQueryItem = queryObjectServer | instructQuery | DTUoprate

/**
 * Dtu 抽象基类
 *
 * 子类必须实现：initialize() / restart() / processQueue()
 * 子类可重写：handleATResponse()（默认 1:1 抄老 client.ts ATParse 行为）
 */
export abstract class Dtu {
  /** 设备主键（v4 改 15 位 IMEI；v3.3.0 用 IMEI 后 12 位，PR #4 暂保持 slice(12)） */
  readonly mac: string

  /** 设备属性（4G: AT=bool, PID/ver/Gver/iotStat/jw/uart/ICCID/signal；子类按需初始化） */
  protected jw = ''
  protected uart = ''
  protected AT = false
  protected ICCID = ''
  protected PID = ''
  protected ver = ''
  protected Gver = ''
  protected iotStat = ''
  protected signal = '0'

  /** 设备超时列表：pid -> 超时次数（10 次硬重启） */
  protected timeOut: Map<number, number> = new Map()
  /** 已查询过的 pid 集合（用于全 pid 超时判断） */
  protected pids: Set<number> = new Set()
  /** 主动重启状态：true 时 reConnectSocket 会延迟 60s 发 terminalOn(reline=true) */
  protected reboot = false
  /** 指令缓存（FIFO + AT/Oprate 插队） */
  protected cache: DtuQueryItem[] = []
  /** socket 封装（socketsb = 写锁 + 字节统计 + ProxySocket） */
  socketsb: socketsb | null = null
  /** 暂停传输模式标志（initialize 期间置 true） */
  protected pause = false

  // ======================== 状态机字段 (PR #6 落地, RFC 002 §12) ========================

  /** 当前 DtuState（PR #6 落地） */
  protected state: DtuState = DtuState.HANDSHAKING
  /** DtuHealth 健康度指标（不存 score，按需 computeHealth() 派生） */
  protected health: DtuHealth = {
    score: 100,
    lastCommAt: Date.now(),
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    queryTimeoutCount: 0,
    totalRestarts: 0,
    totalReconnects: 0,
    signal: 0
  }
  /** dtuHealth 周期上报 timer (only ONLINE/DEGRADED, RFC §12.4) */
  private healthReportTimer: ReturnType<typeof setInterval> | null = null

  constructor(socket: Socket, mac: string) {
    this.mac = mac
    // 代理 socket 跟老 client.ts 保持一致（ProxySocketsb 暂未启用，但 socketsb 内部已用 ProxySocket）
    this.socketsb = new socketsb(socket, mac)

    // 老 client.ts:76 行为 1:1：构造时立即发 terminalOn
    getIOClient().terminalOn(this.mac, false)

    // 老 client.ts:80 行为 1:1：构造时绑定 socket 监听
    this.bindSocket(this.socketsb.getSocket())
  }

  // ======================== 状态机 API (PR #6 落地, RFC 002 §12) ========================

  /**
   * 状态转换（RFC §12.2 转换表 + §12.4 dtuState 事件）
   *
   * 行为契约：
   *   1. 查 VALID_TRANSITIONS 转换表（不合法静默忽略, 避免破坏老 client.ts 隐式行为）
   *   2. 幂等: 同状态不重复触发
   *   3. emit dtuState 事件 ({mac, from, to, score, reason, timestamp})
   *   4. 启停 dtuHealth 60s 周期上报（ONLINE/DEGRADED 启, 其它停）
   *
   * @param to 目标状态
   * @param reason 触发原因（free string, ≤ 64 字符, 不能为空, cairui 拍板）
   */
  protected transition(to: DtuState, reason: string): void {
    const from = this.state
    // 幂等检查
    if (from === to) return
    // 合法性检查（不合法静默忽略, 老 client.ts 没显式状态机，宽松行为）
    if (!isValidTransition(from, to)) {
      console.warn(`[Dtu ${this.mac}] invalid transition: ${from} -> ${to} (reason: ${reason})`)
      return
    }
    // 更新 state
    this.state = to
    // 重新计算 score（health 字段已被外部更新过）
    this.health.score = computeHealth(this.health)
    // emit dtuState 事件
    getIOClient().dtuState({
      mac: this.mac,
      from,
      to,
      score: this.health.score,
      reason: reason.slice(0, 64),
      timestamp: Date.now()
    })
    console.log(`[Dtu ${this.mac}] state: ${from} -> ${to} (score=${this.health.score}, reason: ${reason})`)
    // 启停 dtuHealth 60s 周期上报
    if (shouldReportHealth(to)) {
      this.startHealthReport()
    } else {
      this.stopHealthReport()
    }
  }

  /**
   * 启动 dtuHealth 60s 周期上报（RFC §12.4）
   * 重复调用幂等（已有 timer 不重建）
   */
  private startHealthReport(): void {
    if (this.healthReportTimer) return
    this.healthReportTimer = setInterval(() => this.emitHealth(), HEALTH_REPORT_INTERVAL_MS)
  }

  /**
   * 停止 dtuHealth 60s 周期上报
   */
  private stopHealthReport(): void {
    if (this.healthReportTimer) {
      clearInterval(this.healthReportTimer)
      this.healthReportTimer = null
    }
  }

  /**
   * emit dtuHealth 事件（RFC §12.4）
   * 60s 周期调用一次, 仅 ONLINE/DEGRADED 状态
   */
  protected emitHealth(): void {
    if (!shouldReportHealth(this.state)) return
    // 重新计算 score
    this.health.score = computeHealth(this.health)
    getIOClient().dtuHealth({
      mac: this.mac,
      score: this.health.score,
      health: {
        lastCommAt: this.health.lastCommAt,
        consecutiveSuccesses: this.health.consecutiveSuccesses,
        consecutiveFailures: this.health.consecutiveFailures,
        queryTimeoutCount: this.health.queryTimeoutCount,
        totalRestarts: this.health.totalRestarts,
        totalReconnects: this.health.totalReconnects,
        signal: this.health.signal
      },
      timestamp: Date.now()
    })
  }

  /**
   * emit dtuAlert 事件（RFC §12.4 + §12.4.2）
   * 4 类: AT_TIMEOUT / INVALID_REGISTER / PROFILE_CACHE_FAIL / FATAL
   *
   * @param alert 完整 alert payload (mac 可为 null for INVALID_REGISTER/FATAL)
   */
  protected emitAlert(alert: DtuAlert): void {
    getIOClient().dtuAlert(alert)
    console.log(`[Dtu ${alert.mac ?? '<null>'}] alert: ${alert.type} - ${alert.message}`)
  }

  // ======================== 抽象方法（子类必须实现）========================

  /**
   * 设备上线后异步初始化
   * - CellularDtu: 批量查 AT (PID/VER/GVER/IOTEN/ICCID/LOCATE/UART/GSLQ) + 关 IOTEN + 上报 dtuInfo
   * - LanDtu (未来): HTTP /api/devices/:mac/profile
   */
  abstract initialize(): Promise<void>

  /**
   * 主动重启设备
   * - CellularDtu: AT+Z（跟老 client.ts:272-281 resatrtSocket 行为 1:1）
   * - LanDtu (未来): HTTP POST /api/devices/:mac/reboot
   */
  abstract restart(): Promise<void>

  /**
   * 处理缓存中的指令（4G: AT 命令 / Oprate 命令 / QueryInstruct）
   * 队列调度 + 写锁释放走基类通用逻辑，子类实现具体指令执行
   */
  protected abstract processQueue(query: DtuQueryItem): Promise<void>

  // ======================== 通用行为（基类实现，行为 1:1 抄老 client.ts）========================

  /**
   * 加载 socket 监听事件
   * 跟老 client.ts:89-122 socketOn 行为 1:1
   */
  protected bindSocket(socket: Socket): void {
    this.resume('connect')
    // 上传设备信息：先跑 initialize（异步），完成后再 fetch.dtuInfo
    this.initialize()
      .then(info => {
        fetch.dtuInfo(info as any)
        // PR #6: initialize() 成功 → transition ONLINE
        this.transition(DtuState.ONLINE, 'initialize_ok')
        this.health.lastCommAt = Date.now()
        this.health.consecutiveSuccesses++
        this.health.consecutiveFailures = 0
      })
      .catch(err => {
        // 老 client.ts 用 promise 没 catch，错误会被 unhandledRejection 兜底
        // 这里加 console.error 方便 staging 24h 观察
        console.error(`[Dtu ${this.mac}] initialize failed:`, err)
        // PR #6: initialize() 失败 → emit AT_TIMEOUT alert (mac 已知, 完整设备层)
        this.emitAlert({
          mac: this.mac,
          type: 'AT_TIMEOUT',
          message: `[dtu] initialize: AT queries failed: ${(err as Error).message}`,
          timestamp: Date.now()
        })
        this.transition(DtuState.OFFLINE, 'initialize_failed')
      })

    socket
      // 监听 socket 通道释放 → 触发队列处理
      .on('free', () => {
        this.processingQueue()
      })
      // 监听 socket 关闭事件 → 上报 terminalOff
      .on('close', () => {
        console.log(`${new Date().toLocaleTimeString()} ##发送DTU:${this.mac} 离线告警`)
        getIOClient().terminalOff(this.mac, true)
        this.setPause('close')
        socket.destroy()
        this.socketsb = null
        // PR #6: socket close → transition OFFLINE + 停 60s 上报
        this.transition(DtuState.OFFLINE, 'socket_close')
        this.stopHealthReport()
      })
      // 监听新指令入队 → 触发队列处理
      .on('Queue', () => {
        getIOClient().emit('busy', this.mac, this.cache.length > 3, this.cache.length)
        if (this.socketsb && !this.socketsb.getStat().lock) {
          this.processingQueue()
        }
      })
  }

  /**
   * 设备断开重新连接后重新绑定代理 socket
   * 跟老 client.ts:153-170 reConnectSocket 行为 1:1
   */
  public reConnectSocket(socket: Socket): void {
    this.socketsb = new socketsb(socket, this.mac)
    this.bindSocket(this.socketsb.getSocket())
    // 判断是否是主动断开
    if (this.reboot) {
      setTimeout(() => {
        this.reboot = false
        getIOClient().terminalOn(this.mac, true)
      }, 60000)
    } else {
      getIOClient().terminalOn(this.mac, false)
    }
    console.log({
      time: new Date().toLocaleString(),
      event: `DTU:${this.mac}恢复连接,模式:${this.reboot ? '主动断开' : '被动断开'}`
    })
  }

  /**
   * 暴露 dtu 对象属性（11 字段，server 端契约）
   * 跟老 client.ts:175-189 getPropertys 行为 1:1
   */
  public getPropertys(): Record<string, unknown> {
    return {
      mac: this.mac,
      ...(this.socketsb ? this.socketsb.getStat() : {}),
      AT: this.AT,
      PID: this.PID,
      ver: this.ver,
      Gver: this.Gver,
      iotStat: this.iotStat,
      jw: this.jw,
      uart: this.uart,
      ICCID: this.ICCID,
      signal: this.signal
    }
  }

  /**
   * 处理查询请求（外部入口，TcpServer.Bus 调用）
   * 跟老 client.ts:292-303 saveCache 行为 1:1
   */
  public saveCache(query: DtuQueryItem): void {
    switch (query.eventType) {
      case 'QueryInstruct':
        this.cache.push(query)
        break
      case 'ATInstruct':
      case 'OprateInstruct':
        this.cache.unshift(query)
        break
    }
    this.socketsb?.getSocket().emit('Queue')
  }

  /**
   * 通用：socket close 时通知 server
   * （RFC 002 §3.4 字面方法，子类可重写；默认 1:1 抄老 client.ts bindSocket close 行为）
   */
  public onSocketClose(): void {
    getIOClient().terminalOff(this.mac, true)
  }

  // ======================== 内部：pause / resume / 队列调度 ========================

  /**
   * 暂停整个处理流程，并等待 socket 处理未完成的查询操作
   * 跟老 client.ts:214-237 setPause 行为 1:1
   */
  protected setPause(tag: string = 'null'): Promise<boolean> {
    this.pause = true
    return new Promise<boolean>(resolve => {
      if (this.socketsb) {
        if (!this.socketsb.getStat().lock) {
          resolve(true)
        } else {
          this.socketsb.getSocket().once('free', () => {
            resolve(true)
          })
        }
      } else {
        resolve(true)
      }
    })
  }

  /**
   * 恢复整个处理流程
   * 跟老 client.ts:243-267 resume 行为 1:1
   */
  protected resume(tag: string = 'null'): this {
    this.pause = false
    if (this.socketsb) {
      this.socketsb.getSocket()
        .once('free', () => { })
        .emit('free', 'resume')
    }
    return this
  }

  /**
   * 处理缓存中的指令（基类通用调度）
   * 跟老 client.ts:312-347 ProcessingQueue 行为 1:1（调度逻辑）
   *
   * 1. 先发 busy 事件（堆积 > 3 上报）
   * 2. 取队首 → 根据 eventType 分发：
   *    - QueryInstruct → queryInstruct()（基类实现）
   *    - OprateInstruct / ATInstruct → 子类 processQueue() 处理
   */
  protected async processingQueue(): Promise<void> {
    getIOClient().emit('busy', this.mac, this.cache.length > 3, this.cache.length)
    if (this.socketsb && !this.pause && this.cache.length > 0) {
      const query = this.cache.shift()
      if (query) {
        switch (query.eventType) {
          case 'QueryInstruct':
            await this.queryInstruct(query as queryObjectServer)
            break
          case 'OprateInstruct':
          case 'ATInstruct':
            await this.processQueue(query as DtuQueryItem)
            break
        }
      }
    }
  }

  // ======================== 内部：QueryInstruct 通用实现（4G/LAN 行为相同）========================

  /**
   * 数据查询指令（跟老 client.ts:353-414 QueryInstruct 行为 1:1）
   *
   * 关键不变量：
   *   - 设备在超时列表中 → 简化指令为最后一条（避免离线查询阻塞）
   *   - 每条 content 写一次 socket，type=485 走 hex 编码
   *   - 全部超时 → 触发 terminalMountDevTimeOut + 10 次硬重启
   *   - 部分超时 → 上报 instructTimeOut + 成功的合成 queryOkUp
   *   - socket 断开 → 不做任何事
   */
  protected async queryInstruct(query: queryObjectServer): Promise<void> {
    this.pids.add(query.pid)
    const results: IntructQueryResult[] = []
    if (this.timeOut.has(query.pid)) {
      query.content = [query.content.pop()!]
    }
    let len = query.content.length
    for (const content of query.content) {
      const queryString = query.type === 485
        ? Buffer.from(content, 'hex')
        : Buffer.from(content + '\r', 'utf-8')
      const data: socketResult = this.socketsb
        ? await this.socketsb.write(queryString, 10000, --len !== 0)
        : { useByte: 0, useTime: 0, buffer: 'unSocket' }
      results.push({ content, ...data })
    }
    query.useBytes = results.map(el => el.useByte).reduce((pre, cu) => pre + cu)
    query.useTime = results.map(el => el.useTime).reduce((pre, cu) => pre + cu)
    if (this.socketsb && this.socketsb.getStat().connecting) {
      // 全部超时
      if (results.every(el => !Buffer.isBuffer(el.buffer))) {
        const num = this.timeOut.get(query.pid) || 1
        getIOClient().terminalMountDevTimeOut(query.mac, query.pid, num)
        console.log(`${new Date().toLocaleString()}###DTU ${query.mac}/${query.pid}/${query.mountDev}/${query.protocol} 查询指令超时 [${num}]次,pids:${Array.from(this.pids)},interval:${query.Interval}`)
        if (
          num === 10 &&
          !this.socketsb.getSocket().destroyed &&
          this.timeOut.size >= this.pids.size &&
          Array.from(this.timeOut.values()).every(n => n >= 10)
        ) {
          console.log(`###DTU ${query.mac}/pids:${Array.from(this.pids)} 查询指令全部超时十次,硬重启,断开DTU连接`)
          await this.restart()
        }
        this.timeOut.set(query.pid, num + 1)
      } else {
        // 部分超时或全部成功
        this.timeOut.delete(query.pid)
        const contents = results.filter(el => Buffer.isBuffer(el.buffer))
        const okContents = new Set(contents.map(el => el.content))
        const timeOutContents = query.content.filter(el => !okContents.has(el))
        if (timeOutContents.length > 0) {
          getIOClient().instructTimeOut(query.mac, query.pid, timeOutContents)
          console.log(`###DTU ${query.mac}/${query.pid}/${query.mountDev}/${query.protocol}/${query.Interval}指令:[${timeOutContents.join(',')}] 超时`)
        }
        const successResult = Object.assign(query, { contents, time: new Date().toString() })
        fetch.queryData(successResult as any)
      }
    } else {
      console.log('socket is disconnect,QuertInstruct is nothing')
    }
  }

  // ======================== 内部：Oprate / AT 结果处理（4G/LAN 行为不同，子类可重写）========================

  /**
   * Oprate 指令结果处理
   * 跟老 client.ts:421-442 OprateParse 行为 1:1
   */
  protected oprateParse(query: instructQuery, res: socketResult): void {
    const { buffer } = res
    const result: Partial<ApolloMongoResult> = {
      ok: 0,
      msg: '挂载设备响应超时，请检查指令是否正确或设备是否在线/' + buffer,
      upserted: buffer
    }
    if (Buffer.isBuffer(buffer)) {
      result.ok = 1
      switch (query.type) {
        case 232:
          result.msg = '设备已响应,返回数据：' + buffer.toString('utf8').replace(/(\(|\n|\r)/g, '')
          break
        case 485:
          const str = (buffer.readIntBE(1, 1) !== parseInt((query.content as string).slice(2, 4)))
            ? '设备已响应，但操作失败,返回字节：'
            : '设备已响应,返回字节：'
          result.msg = str + buffer.toString('hex')
      }
    }
    console.log({ Query: query, result, res })
    getIOClient().emit('deviceopratesuccess' as any, query.events, result)
  }

  /**
   * AT 指令结果处理（默认 4G 行为，子类可重写）
   * 跟老 client.ts:449-463 ATParse 行为 1:1
   *
   * 关键不变量：
   *   - 解析成功且 msg 为空（如 IOTEN=off）→ 触发 run() 重查全部属性
   *   - 解析失败 → ok=0 + "挂载设备响应超时" 提示
   */
  protected atParse(query: DTUoprate, res: socketResult): void {
    const { buffer } = res
    const parse = parseATResponse(buffer)
    if (parse.AT && !parse.msg) {
      // 老 client.ts:453 行为：重查 + 上报 dtuInfo
      this.initialize()
        .then(info => fetch.dtuInfo(info as any))
        .catch(err => console.error(`[Dtu ${this.mac}] re-initialize failed:`, err))
    }
    const result: Partial<ApolloMongoResult> = {
      ok: parse.AT ? 1 : 0,
      msg: parse.AT ? parse.msg : '挂载设备响应超时，请检查指令是否正确或设备是否在线',
      upserted: buffer
    }
    console.log({ Query: query, result, res })
    getIOClient().emit('dtuopratesuccess' as any, query.events, result)
  }
}
