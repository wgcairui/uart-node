import net, { Socket } from "net";
import config from "./config";
import { queryObjectServer, instructQuery, registerConfig, DTUoprate, eventType } from "uart";
import Client, { ProxyClient } from "./client";
import { URLSearchParams } from "url";
import IOClient, { ioOnResult } from "./IO";


/**
 * tcpServer实例,用于管理所有dtu连接
 */
export default class TcpServer extends net.Server {
  /**
   * 缓存mac->client
   */
  private MacSocketMaps: Map<string, Client>;
  private conf: registerConfig;
  /**
   * 
   * @param conf dtu注册信息
   */
  constructor(conf: registerConfig) {
    super();
    this.conf = Object.assign({Port: 9000, MaxConnections: 2000,IP: '0.0.0.0'},conf)
    // net.Server 运行参数配置
    this.setMaxListeners(conf.MaxConnections || 2000);
    this.MacSocketMaps = new Map();
    this
      // connection
      .on("connection", async socket => {
        this._Connection(socket)

      })
      // error
      .on("error", (err) => console.log("Server error: %s.", err))
      // start listen
      .listen(process.env.NODE_ENV === 'production' ? conf.Port : config.localport, "0.0.0.0", () => {
        const ad = this.address() as net.AddressInfo;
        console.log(`### WebSocketServer listening: ${conf.IP}:${ad.port}`);
      });

    ioOnResult('restart', () => {
      return new Promise(resolve => {
        this.close(err => {
          if (err) console.log({ err });

          console.log(`server已成功关闭,当前连接数:${this.MacSocketMaps.size}`);

          this.listen(process.env.NODE_ENV === 'production' ? conf.Port : config.localport, "0.0.0.0", () => {
            const ad = this.address() as net.AddressInfo;
            console.log(`### WebSocketServer listening: ${conf.IP}:${ad.port}`);
            resolve('restart ok')
          });
        })

        this.MacSocketMaps.forEach((client, key) => {
          client.socketsb?.destroy()
          this.MacSocketMaps.delete(key)
        })
      })
    })
  }

  /**
   * 处理新连接的socket对象
   * @param socket 
   */
  private async _Connection(socket: Socket) {
    if (!socket || !socket.remoteAddress || !socket.writable) return
    console.log(`${new Date().toLocaleString()}==新的socket连接,连接参数: ${socket.remoteAddress}:${socket.remotePort}`);
    const timeOut = setTimeout(() => {
      console.log(socket.remoteAddress, '无消息,尝试发送注册信息');
      if (socket && !socket.destroyed && socket.writable) {
        socket.write(Buffer.from('+++AT+NREGEN=A,on\r', "utf-8"))
        socket.write(Buffer.from('+++AT+NREGDT=A,register&mac=%MAC&host=%HOST\r', "utf-8"))
        if (this.conf.UserID) {
          socket.write(Buffer.from(`+++AT+IOTUID=${this.conf.UserID}\r`, "utf-8"))
        }

      }
    }, 10000);

    // 配置socket参数
    socket
      .on("error", err => {
        //  console.error(`socket error:${err.message}`, err);
        socket?.destroy()
      })
      // 监听第一个包是否是注册包'register&mac=98D863CC870D&jw=1111,3333'
      .once("data", async (data: Buffer) => {
        clearTimeout(timeOut)
        const registerArguments = new URLSearchParams(data.toString())
        //判断是否是注册包
        if (registerArguments.has('register') && registerArguments.has('mac')) {
          this.getConnectionsAsync().then(el => config.count = el)
          const IMEI = registerArguments.get('mac')!
          // 是注册包之后监听正常的数据
          // mac地址为后12位
          const maclen = IMEI.length;
          const mac = IMEI.slice(maclen - 12, maclen);
          const client = this.MacSocketMaps.get(mac)
          if (client) {
            client.reConnectSocket(socket)
          } else {
            // 使用proxy代理dtu对象
            this.MacSocketMaps.set(mac, new Proxy(new Client(socket, mac, registerArguments), ProxyClient))
            console.log(`${new Date().toLocaleString()} ## ${mac}  上线,连接参数: ${socket.remoteAddress}:${socket.remotePort},Tcp Server连接数: ${await this.getConnectionsAsync()}`);
          }
        } else {
          socket.end('please register DTU IMEI', () => {
            console.log(`###${socket.remoteAddress}:${socket.remotePort} 配置错误或非法连接,销毁连接,[${data.toString().slice(0, 10)}]`);
            socket.destroy();
          })
        }
      });
  }
  /**
   *  统计TCP连接数（Promise 包装，调用方用 await）
   *  父类 net.Server.getConnections 是 callback 风格，
   *  这里不能 override 它的签名（会跟父类签名冲突），
   *  所以叫 getConnectionsAsync。
   */
  getConnectionsAsync(): Promise<number> {
    return new Promise<number>((resolve) => {
      super.getConnections((err, nb) => {
        resolve(nb)
      })
    })
  }

  /**
   * 统计所有在线的终端
   * @returns 
   */
  getOnlineDtu() {
    return [...this.MacSocketMaps.values()].filter(el => el.socketsb).filter(el => el.getPropertys().connecting).map(el => el.mac)
  }


  /**
   * 处理uartServer下发的查询和操作指令
   * @param EventType 指令类型
   * @param Query 指令内容
   */
  public Bus<T extends queryObjectServer | instructQuery | DTUoprate>(EventType: eventType, Query: T) {
    const client = this.MacSocketMaps.get(Query.DevMac)
    if (client && client.socketsb) {
      Query.eventType = EventType
      client.saveCache(Query)
    }
  }
}
