# 汉枫 4G/2G/NB DTU 协议速查

> **Source**: 汉枫电子《4G_2G_NB DTU 产品功能_V2.1_20231010》产品功能手册（57 页）
> 配套《HF2411 用户手册 V1.3》硬件手册
> **覆盖设备**: HF2411（4G 主推）/ HF2111A（2G）/ HF2611（NB-IoT）/ Protoss-PG41 / Elfin-EG41 / Meta-MG41 / Gport-G43 等

## 1. 物理形态

| 型号 | 网络 | 串口 | 关键特征 |
|---|---|---|---|
| **HF2411** | 全网通 LTE-TDD/LTE-FDD | 1 路 RS232 或 RS485 二选一 | 默认波特率 115200，9-36V 宽压 |
| HF2111A | 移动/联通 2G | 同上 | 不支持电信 |
| HF2611 | NB-IoT Band3/5/8 | 同上 | 必须 NB-IoT SIM 卡，手机卡不行 |
| EG41 / MG41 / G43 | 4G/3G/2G 多模 | 1-2 路 | 多 socket，多协议 |

> **HF2411 串口** = RS232（DB9 沉金公头）**或** RS485（5.08 接线端子），**两者不能同时用**

## 2. 接入网络后的默认行为

DTU 上电 → 自动注册蜂窝网络 → 默认进入**透明传输模式** → 通过 `AT+NETP` 配置的目标 server 建立 TCP 长连接。

**关键时序**（UartNode 这边要等的事）：

1. DTU 启动 → 串口打印 `WEL` 欢迎信息（如 `Eport-HF2411`）
2. DTU 按 `AT+NETP` 配置连 UartNode
3. 第一次建连时，DTU 按 `AT+NREGDT` 配置的注册包模板发第一个包
4. 进入透传：DTU 把 server → UART 的数据当裸数据流

## 3. 注册包（**UartNode 解析的第一包**）

```text
register&mac=98D863CC870D&jw=1111,3333
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `register` | 固定字面量 | 标记这是注册包 |
| `mac` | `%MAC` 通配符展开 = IMEI 后 12 位 | UartNode 用这个当 deviceId key |
| `jw` | `AT+LOCATE` 经纬度（可选） | 经度,纬度 |

> **UartNode 侧解析**：`TcpServer.ts:92` 用 `new URLSearchParams(data.toString())`
> 必须同时有 `register` + `mac` 两个 key 才认。

注册包模板通过 `+++AT+NREGDT=A,register&mac=%MAC&host=%HOST\r` 推给 DTU（**`TcpServer.ts:75` 主动推**）。

## 4. AT 指令集（汉枫 4G 透传穿 AT 约定）

> 透传模式下用 `+++` + 确认码 `a` 切到命令模式（**TcpServer 没走这条路**）。
> TcpServer 用 `+++AT+...` 前导**直接穿 AT 指令**（不需要切模式），
> DTU 收到后透传给内部 MCU 执行并把响应原路返回。

### 4.1 常用指令（UartNode 实际会用的）

| 指令 | 用途 | 备注 |
|---|---|---|
| `AT+PID` | 查设备型号 | client.run() 第一个查 |
| `AT+VER` | 应用软件版本 | |
| `AT+GVER` | GPRS 软件版本（**仅 4G**）| LAN 设备无此指令 |
| `AT+IOTEN` | IOTBridge 远程管理 | 启动时关掉省流量 |
| `AT+ICCID` | SIM 卡 ICCID | 4G/2G/NB 才有，LAN 没 |
| `AT+LOCATE=1` | GPRS 基站定位 | |
| `AT+UART=1` | 串口 1 参数 | |
| `AT+GSLQ` | GPRS 信号强度 | |
| `AT+IMEI` | 15 字节 IMEI | |
| `AT+IMSI` | 15 字节 IMSI | |
| `AT+Z` | **硬重启** | IO 状态初始化 |
| `AT+SRST` | 软重启 | IO 状态保持 |
| `AT+RELD` | 恢复用户默认 + 重启 | |
| `AT+FCLR` | 恢复出厂 + 重启 | |

### 4.2 响应格式（**`tool.ATParse` 解析规则**）

```text
+ok=<rsp>\r\n\r\n
```

`tool.ATParse` 匹配 `^\+ok` 开头即认为成功，`<rsp>` 去掉 `=` 和前导数字逗号后返回。

**错误响应**：

```text
+ERR=<code>\r\n\r\n
```

错误码 `-1 ~ -5`（无效格式/命令/操作符/参数/操作不允许），**当前代码不解析错误码**。

### 4.3 LAN 设备**不会**响应 `+++AT+`

这是协议层最大差异点——见 [`lan-gateway.md`](lan-gateway.md) §3。

## 5. 串口数据成帧

DTU 接收 UART 字节流时，**默认 200ms 间隔切帧**（可调 `AT+UARTTM`，范围 10-1000ms）：

- 2 字节间隔 > 200ms → 一帧结束 → 转发到 socket
- 一直 < 200ms → 攒到 512 字节 buffer 强制结束

> **UartNode 侧影响**：UartNode 收到的"数据"是 DTU 已经成帧好的包，
> 不会再做切帧。所以 `client.QueryInstruct` 里每条 content 是一次完整帧。

## 6. 多 socket（SOCKA/B/C）

DTU 内置 3 路 socket，可独立配置：

```text
AT+NETP=A,1,TCP,nat2.iotworkshop.com,3006,long
AT+NETP=B,1,UDP,nat2.iotworkshop.com,3008
AT+NETP=C,1,TCP,nat2.iotworkshop.com,3007,short,3
```

**到 UartNode 这边就是 3 条独立的 TCP 连接**（同一个 device 三条 socket），
`TcpServer.MacSocketMaps` 用 mac key 共享同一个 `Client` 实例。

如果启用 `AT+NETPIDEN=A,on`，DTU 在收到的数据头部加 `#SOCKA#` 标记，**UartNode 当前未解析**。

## 7. 心跳包

DTU 自发，**UartNode 不参与**：

```text
AT+HEART=A,30,NET,MAC,<mac>\r
```

- `time`: 间隔秒数，0 = 关闭
- `mode`: NET（向网络发）/ UART（向串口发）/ UartNet
- `type`: MAC / IMEI / ICCID / 自定义
- `value`: 自定义内容，最长 38 字节，支持 `%IMEI` `%ICCID` 等通配符

## 8. 加密（UartNode 暂未启用）

`AT+NETPENC=A,AES,<16字节 key>`，LAN 设备（HF5111）走 TLS v1.2 + AES128/DES3 另一套。

**当前 UartNode 透传的是明文**，加密要改 `TcpServer` 那条 socket 流的处理。

## 9. Modbus 网关

`AT+MODBUS=1,on` 开启 Modbus RTU ↔ Modbus TCP 转换。

**UartNode 侧**：`client.QueryInstruct` 根据 `Query.type === 485` 走 hex 编码，其他走 `\r` 结尾的 ASCII 文本。

## 10. 已知坑（**踩过再说，没踩别写**）

> 此节只列**已确认**的坑，未确认的放 RFC 草稿里。

- DTU 启动后第一个包必须是注册包，**`TcpServer` 在 10s 超时后会主动推 AT 仪式**
  （`TcpServer.ts:71-81`）。LAN 设备会被这个仪式**卡死**——见
  [`lan-gateway.md`](lan-gateway.md) §3
- 4G/2G/NB 设备 IMEI 是 15 字节，取后 12 位当 mac key；LAN 设备是 MAC 地址（`98D863xxxxxx`）。
  **两套 mac 命名空间可能撞**——LAN MAC 的 `98D863xxxxxx` 跟某个 4G IMEI 后 12 位
  完全可能相同（理论 12^16 vs 12^24，碰撞概率低但**不为零**），RFC 001 §6 要处理

## 11. 真机回归 checklist

见 [`../workflow/staging-regression.md`](../workflow/staging-regression.md)
