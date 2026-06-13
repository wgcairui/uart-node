import os from "os";
import { type nodeInfo } from "uart";
export default class tool {

  /**
   * 节点信息
   */
  static NodeInfo(): nodeInfo {
    const hostname: string = os.hostname();
    const totalmem: number = os.totalmem() / 1024 / 1024 / 1024;
    const freemem: number = (os.freemem() / os.totalmem()) * 100;
    const loadavg: number[] = os.loadavg();
    const type: string = os.type();
    const uptime: number = os.uptime() / 60 / 60;

    return {
      hostname,
      totalmem: totalmem.toFixed(1) + "GB",
      freemem: freemem.toFixed(1) + "%",
      loadavg: loadavg.map(el => parseFloat(el.toFixed(1))),
      type,
      uptime: uptime.toFixed(0) + "h",
      version: os.version()
    };
  }

  /**
   * 处理AT指令结果
   * @param buffer 
   */
  static ATParse(buffer: Buffer | string) {
    if (Buffer.isBuffer(buffer)) {
      const str = buffer.toString('utf8')
      return {
        AT: /(^\+ok)/.test(str),
        msg: str.replace(/(^\+ok)/, '').replace(/^\=/, '').replace(/^[0-9]\,/, '')
      }
    } else {
      return {
        AT: false,
        msg: ''
      }
    }
  }
}
