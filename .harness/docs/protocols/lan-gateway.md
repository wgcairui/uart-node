# 汉枫 LAN 网关协议速查

> **Source**: 汉枫电子《PE1X_EE1X_HF51XX_Eport 操作指南_20260302》（43 页）
> 配套《HF5111 串口服务器用户手册 V1.0》
> **覆盖设备**: HF5111 / HF5111S / HF5122（双串口）/ HF5142（四串口）/ PE1X / EE1X / Eport-E10/20/30/50C / Eport Pro EP20

> **重要**：UartNode 当前**未实现** LAN 设备接入。本文档是 RFC 001 的协议层背景。
> 实现方案见 [`../rfcs/001-lan-gateway-support.md`](../rfcs/001-lan-gateway-support.md)

## 1. 设备形态

| 型号 | 网口 | 串口 | 核心特性 |
|---|---|---|---|
| **HF5111** | 1× RJ45 (10/100M) | 1× RS232/RS485/RS422 三选一 | TLS v1.2 + AES128 + DES3 |
| HF5111S | 1 | 1× RS485 | 同上 |
| **HF5122** | 2× RJ45 | 2× RS232/RS485/RS422 | LAN+WAN 双网口可组网 |
| HF5142 | 4 | 4 串口 | 4 个独立 E10 核心 |
| **PE10 / PE11** | 1 | PE10=RS232, PE11=RS485 | 小封装 |
| **EE10 / EE11** | 1 | EE10=RS232, EE11=RS485 | 小精灵形态 |
| Eport-E10/E20/E30 | 1 | 1× 3.3V TTL | 经典 Eport 形态 |
| Eport Pro EP20 | 1 | Linux 嵌入式 | 高端应用 |
| **ME20/21/22** | 1 | RS232/RS485/3.3TTL | Elfin 大精灵 |

**LAN 设备** vs 4G DTU **核心差异**：

- 4G DTU 永远在 NAT 后，**DTU 来连 server**
- LAN 设备有 IP，**配置灵活**——可以当 TCP Server（默认 8899），也可以当 TCP Client

## 2. 三种接入拓扑

LAN 网关**不限于一种接入方式**，这是跟 4G DTU 最大的设计分歧：

### 拓扑 A：LAN 设备当 TCP Server（默认）

```
[UartNode Client] --TCP connect--> [LAN Device TCP Server :8899]
```

- LAN 设备默认开启 TCP Server，端口 **8899**（可改）
- UartNode 当 TCP Client **主动**去连
- 适合：UartNode 在公网/机房，LAN 设备在内网有公网 IP 或端口映射

### 拓扑 B：LAN 设备当 TCP Client

```
[LAN Device TCP Client] --TCP connect--> [UartNode TCP Server :9000]
```

- LAN 设备配 netp=TCP Client，目标 IP=UartNode
- 适合：LAN 设备在客户内网主动出门连 UartNode（UartNode 在公网）
- 跟 4G DTU 走法几乎一样，**但没有注册包约定**

### 拓扑 C：LAN 设备走 MQTT / HTTP

```
[LAN Device] --MQTT/HTTP--> [Cloud Broker / HTTP Server]
                   ↑
              UartNode 这边? 
```

- LAN 设备配 netp=MQTT（默认 1883）或 HTTP
- 适合：客户要把 LAN 设备接现成云平台（EMQX / 阿里 IoT / OneNET）
- **UartNode 当前架构下要走这条路得加 MQTT/HTTP 客户端**（RFC 001 列为二期）

> **UartNode 选哪种？** RFC 001 建议一期做拓扑 A+B，C 放二期。

## 3. 注册机制 —— **跟 4G 完全不同的关键差异**

### 4G DTU 的注册（参考）

4G DTU 内置注册包机制：
- DTU 主动发 `register&mac=98D863CC870D&jw=...`
- UartNode 解析后建 Client
- 标识取 IMEI 后 12 位

### LAN 设备**没有**这套机制

LAN 设备是**透明 TCP 桥**——socket 那头发的任何字节，原样转发到 UART；UART 收的字节原样发到 socket。

**没有**任何"注册包"概念。设备上电后你从 socket 发什么它就发什么给 UART。

**这意味着**：UartNode 收到 TCP 连接时，**不知道**这是哪台设备。

### 三种补救方案（RFC 001 评估）

| 方案 | 复杂度 | 安全性 | 适用 |
|---|---|---|---|
| **白名单查表** | 低 | 中（MAC 可伪造） | 内网受控环境 |
| **Challenge-Response** | 中 | 高 | 公网/不可信环境 |
| **依赖应用层（UART 侧自己上报 MAC）** | 高 | 视应用而定 | 复杂系统 |

**建议**：一期走白名单 + 预注册，二期看需求加 challenge。

## 4. CLI 指令模式（**仅配置阶段**）

> 跟 4G 的 `+++AT+` 前导**不是一回事**。

LAN 设备进入 CLI 模式：

- **串口方式**：连续整包发 `+++`（前后不能有其他字符），设备返回 `a` 确认码，
  再发 `a`，进入 `EPORT>` 提示符。**只在配置阶段**用，数据传输时不进 CLI
- **Telnet 方式**：连 TCP 23 端口，用户名密码 `admin/admin`，进 `EPORT>`

**`+++\r` 在数据通道上会被当成 3 字节透传数据**——UartNode 不能在 TCP 通道上推 `+++`
让 LAN 设备进 CLI（除非 100% 确认是配置场景）。

> **TCP 数据通道上**要走配置，**走 HTTP API**（HF5111 文档提到有 HTTP server）
> 或**Telnet 端口 23**——不在 raw TCP 8899 上做

## 5. 设备身份：MAC 地址

- 汉枫 OUI 前缀：**`98D863`**（MQTT 测试案例里 ClientID `98D863000002` 就是 MAC）
- MAC 长度 12 字符（hex）

**标识空间冲突**：

| 设备类型 | 标识 |
|---|---|
| 4G/2G/NB DTU | IMEI 后 12 位（15 字节 IMEI 取后 12） |
| LAN 网关 | MAC 地址 12 字符 |

`98D863xxxxxx`（LAN MAC）和某段 4G IMEI 后 12 位**理论可能撞**。RFC 001 §6 要处理。

## 6. 多 socket / 多串口

| 型号 | 串口数 | 最多 socket 数 |
|---|---|---|
| HF5111 | 1 | 3 路（可配到不同 netp） |
| HF5122 | 2 | 每串口独立配 socket，HF5122 案例里两个串口配两个独立 socket |
| HF5142 | 4 | 4 个独立的核心 E10-PCBA，每路 1+ socket |

> UartNode 这边要么按 mac 共享 Client（**默认方案**，一个 Client 管多 socket），
> 要么按 mac+串口号分（复杂但能区分数据来源）。RFC 001 §5 评估。

## 7. 工作模式 netp 设定

跟 4G DTU **同样的 `AT+NETP=` 语法**（CLI 下用）：

```text
netp=A,1,TCP,115.29.164.59,40432,long
netp=A,1,MQTT,112.124.43.15,1883
netp=A,1,HTTP,115.29.164.59,8432
netp=A,1,WEBSOCKET,<host>,<port>
netp=A,1,UDP,<host>,<port>
```

**跟 4G 不同**：LAN 设备额外支持 **TCP Server**（设备监听，UartNode 来连）。

## 8. MQTT 测试参数（来自操作指南 §4.6）

```text
ClientID: 98D863000002   ← MAC 地址
User:     98D863000002   ← 默认跟 ClientID 一样
Password: 98D863000002   ← 默认跟 ClientID 一样
Subscribe Topic: %MAC/down
Publish Topic:   %MAC/up
QOS: 0
Ping: 60s
```

**ClientID 默认 = MAC**——所以 LAN 设备走 MQTT 时天然有 deviceId。

## 9. HTTP 模式（来自操作指南 §4.5）

GET：

```http
GET /iot?msg=AAA HTTP/1.1
Host: 115.29.164.59:8432
Connection: keep-alive
```

POST：

```http
POST /iot HTTP/1.1
Host: 115.29.164.59:8432
Connection: keep-alive
Content-Length: 7
msg=AAA
```

**数据长度从串口字节数自动算**——UartNode 侧不需要特殊处理。

## 10. 加密

HF5111 列了 **TLS v1.2 + AES128 + DES3**。具体怎么启用、跟 raw TCP 怎么配，
**操作指南和用户手册都没详写**——需要查汉枫《物联设备系列产品软件功能》那份文档。
RFC 001 二期评估。

## 11. 固件升级

- **本地 Web**：`IP/hide.html`（直连时 `169.254.173.207/hide.html`）
- **远程**：IotMaster + IOTBridge 云平台
- **不走 `AT+UPGRADE` / `AT+GOTA`**（那是 4G 专属）

UartNode 这边**不需要参与**固件升级，运维走汉枫自己的工具链。

## 12. 跟 4G 协议对照表

| 维度 | 4G DTU | LAN 网关 |
|---|---|---|
| 接入介质 | 蜂窝 4G/2G/NB | 网线 / WiFi |
| UartNode 默认角色 | TCP Server | **TCP Server 或 Client 都要支持** |
| 设备身份标识 | IMEI 后 12 位 | MAC 地址（前缀 98D863） |
| 设备主动注册 | **有**（`register&mac=...`）| **无**——UartNode 侧要自己实现 |
| `+++AT+` 透传穿 AT | 支持（`TcpServer.ts:74` 推的）| **不支持**——raw TCP 通道不响应 |
| CLI 模式 `+++ → EPORT>` | 不适用 | 配置阶段可用，数据通道不要用 |
| 多 socket | SOCKA/B/C（DTU 内置） | 1-4 串口对应 1+ socket/串口 |
| 默认 TCP Server 端口 | 不适用 | **8899** |
| Web 配置 | 不支持 | **`http://设备 IP`**（admin/admin） |
| Telnet 配置 | 不支持 | **TCP 23 端口** |
| 加密 | AES / DES3（`AT+NETPENC`）| TLS v1.2 / AES128 / DES3 |
| 固件升级 | `AT+UPGRADE` / `AT+GOTA` | Web `/hide.html` / IotMaster |
| 配置工具 | IOTService | **IotMaster**（注意命名换了） |
| Modbus 网关 | RTU↔TCP | ModbusTCP（HF5111 协议栈列了） |

## 13. 真机回归 checklist

走 RFC 001 实施后，参考 [`../workflow/staging-regression.md`](../workflow/staging-regression.md) 走
**24h+ 真机回归**，覆盖：

- HF5111（TCP Server 拓扑 A + TCP Client 拓扑 B）
- EE10 / EE11（小封装 LAN）
- Eport-E10C（经典 Eport）
- HF5122（双串口双 socket 案例）
