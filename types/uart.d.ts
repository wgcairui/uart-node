// 注：此文件全 type-only，必须用 import type，否则在 module: ESNext 下
// 整个文件不再是 ambient，declare namespace Uart 不会变全局可见，
// 调用方 Uart.Terminal / Uart.nodeInfo 会报 "Cannot find namespace 'Uart'"。
import type { Socket } from "net";
type eventType = 'QueryInstruct' | 'OprateInstruct' | 'ATInstruct'

interface socketResult { buffer: Buffer | string, useTime: number, useByte: number }

interface Query {
  DevMac: string
  events: string
  content: string | string[]
  result?: string
  eventType: eventType
  //listener: (buffer: Buffer | any) => void
}
// apollo server result
interface ApolloMongoResult {
  msg: string
  ok: number
  n: number
  nModified: number
  upserted: any
}
interface registerConfig {
  clients: string;
  IP: string;
  Name: string;
  MaxConnections: number;
  Port: number;
  UserID: string
}
interface queryObject {
  mac: string;
  type: number;
  protocol: string,
  pid: number,
  timeStamp: number
  content: string,
  time: string
}
interface queryObjectServer extends Query {
  mac: string;
  type: number;
  mountDev: string
  protocol: string,
  pid: number,
  timeStamp: number
  content: string[],
  time: string
  Interval: number
  useTime: number
  useBytes: number
}
interface queryOkUp extends queryObject {
  contents: IntructQueryResult[]
}
interface IntructQueryResult {
  content: string
  buffer: Buffer | string;
  useTime: number
  useByte: number
}
interface socketNetInfo {
  readonly ip: string;
  readonly port: number;
  mac: string;
  jw: string;
}
interface client extends socketNetInfo {
  uart: string
  AT: boolean
  socket: Socket;
  CacheQueryInstruct: queryObjectServer[];
  CacheOprateInstruct: instructQuery[];
  CacheATInstruct: DTUoprate[],
  timeOut: Map<number, number>,
  TickClose: boolean,
  pids: Set<number>
}

interface allSocketInfo {
  NodeName: string;
  Connections: number | Error;
  SocketMaps: socketNetInfo[];
}

interface nodeInfo {
  hostname: string;
  totalmem: string;
  freemem: string;
  loadavg: number[];
  type: string;
  uptime: string;
  version: string;
  userInfo?: any;
}


interface timelog {
  content: string,
  num: number
}

interface instructQuery extends Query {
  pid: number
  type: number
  Interval?: number
}
type AT = 'Z' | 'VER' | 'UART=1' | 'LOCATE=1' | 'IMEI' | 'ICCID' | 'IMSI' | string
// 操作指令请求对象
interface DTUoprate extends Query {
}