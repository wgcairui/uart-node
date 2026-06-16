import os from "os";
import { type nodeInfo } from "uart";

/**
 * 节点运行时信息（CPU/内存/启动时间/hostname）
 *
 * 历史：原 tool.ATParse() 静态方法在 PR #3 拆到 src/services/at-parse.ts（看 §6.5 PR #3）
 *       原 tool.NodeInfo() 保留——PR #3 RFC 字面「tool.ts 留下 NodeInfo」。
 *       dtu-info.ts (PR #2) 拆出的 nodeInfo() 函数是新实现，未接管 main.ts 调用方，
 *       留到后续 PR（PR #4 Dtu 抽象或 PR #5 TcpServer 重构时一起做迁移）。
 */
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
}
