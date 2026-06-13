import { queryOkUp, type nodeInfo } from "uart"
import { NODE_TOKEN, SERVER_URL } from "./config"

// 兼容旧代码 namespace Uart.Terminal 写法（types-uart 包里是 namespace）
// 项目自带的 types/uart.d.ts 没有 Uart namespace alias，
// 直接用 interface 写法更稳。
interface Terminal {
  mac: string;
  ip: string;
  port: number;
  [key: string]: unknown;
}

class Fetch {

    /**
     * 上传dtu信息
     * @param info
     */
    dtuInfo(info: Partial<Terminal & { mac: string }>) {
        info.DevMac = info.mac
        return this.fetch("dtuinfo", { info })
    }

    /**
     * 上传节点运行状态
     * @param node
     * @param tcp
     */
    nodeInfo(name: string, node: nodeInfo, tcp: number) {
        return this.fetch('nodeInfo', { name, node, tcp })
    }

    /**
     * 上传查询数据
     * @param data
     */
    queryData(data: queryOkUp) {
        return this.fetch("queryData", { data })
    }

    async fetch<T>(path: string, data: any = {}) {
        // PR #20 鉴权：HTTP /api/node/* 必须带 x-node-token
        // server 端从 header 优先取，其次 body.nodeToken
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (NODE_TOKEN) headers['x-node-token'] = NODE_TOKEN

        try {
            const res = await fetch(SERVER_URL + path, {
                method: 'POST',
                headers,
                body: JSON.stringify(data),
                // Node 18+ 原生支持 AbortSignal.timeout
                signal: AbortSignal.timeout(5000)
            })
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
            // 200/204 都算 OK，body 不读（节省 CPU/内存，与 uart-pesiv-node uploader 对齐）
            return undefined as unknown as T
        } catch (err) {
            console.log({ fectherr: err })
            return err
        }
    }
}

export default new Fetch()