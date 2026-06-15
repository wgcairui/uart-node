# Staging 真机回归 Checklist

> **AGENTS.md 强约束**：
> > `TcpServer.ts` / `socket.ts` / `client.ts` 整套 net 逻辑（Bun runtime）没在生产跑过。
> > 改这几个文件后必须 staging 真机回归 24h+，确认 DTU 注册包解析 / AT 指令收发 /
> > 长连接 keepalive / 被动断开 + 主动重启（`Z` 指令）路径。

**改以下任何文件，必须走这份 checklist**：

- `src/TcpServer.ts`
- `src/socket.ts`
- `src/client.ts`
- `src/tool.ts`（AT 解析）
- 新建 `src/adapters/*`（一旦走完 RFC 001）
- 任何动到 `MacSocketMaps` / `ProxyClient` / `socketsb.write` 的文件

## 1. 24h 回归硬要求

| 维度 | 要求 |
|---|---|
| 持续时间 | **≥ 24h 连续运行** |
| 设备数 | 至少 1 台 4G + 1 台 LAN（RFC 001 落地后）|
| 流量 | 正常生产流量节奏（不要全静默）|
| 网络 | 真实运营商网络（不要全程内网穿透）|

## 2. 必过的功能路径

### 2.1 DTU 注册解析

- [ ] 4G DTU 首次连接 → 10s 推 AT 仪式 → DTU 回注册包 → `terminalOn` 上报 server
- [ ] 4G DTU 重连 → 不重新走 10s 仪式（直接命中 `MacSocketMaps` 已有 Client）→ `reConnectSocket` 路径
- [ ] LAN TCP Client 设备（RFC 001 后）→ 预注册白名单匹配 → `terminalOn`
- [ ] LAN TCP Server 设备（RFC 001 后）→ UartNode 出站 connect → 预注册匹配 → `terminalOn`
- [ ] **非法连接**（不发注册包 / 不在白名单）→ `socket.end('please register DTU IMEI')` → 立即销毁

### 2.2 AT 指令收发

- [ ] `client.run()` 8 条 AT 指令全过：PID/VER/GVER/IOTEN/ICCID/LOCATE/UART/GSLQ
- [ ] Server 下发 `DTUoprate` 走 `ATInstruct` → 队列 unshift 优先 → DTU 收到 → 响应 → `tool.ATParse` 解析成功
- [ ] **错误响应**（`+ERR=-1` 等）不被 `ATParse` 误判为成功

### 2.3 长连接 keepalive

- [ ] DTU 端 5min 内无活动 → **不**被 `setTimeout` 误断（看 `socket.ts:40-42` 实际行为）
- [ ] 24h 内连接不异常断开
- [ ] `setKeepAlive(100s)` 生效，TCP 层 keepalive 探针正常

### 2.4 被动断开 + 主动重启

- [ ] DTU 端拔 SIM / 断电 → UartNode 收到 socket close → `terminalOff` 上报 → `socket.destroy()`
- [ ] 设备查询全部超时 10 次 → 触发 `AT+Z` 硬重启 → 60s 内重连走 `reboot=true` 分支
- [ ] 重连成功后 `terminalOn(mac, true)`（**force report = true**）上报 server

### 2.5 缓存队列

- [ ] 普通查询 FIFO 顺序
- [ ] AT / Operate 指令 unshift 优先
- [ ] 队列堆积 > 3 触发 `busy` 事件

### 2.6 数据上行

- [ ] DTU 串口数据 → UartNode 透传到 server
- [ ] `fetch.queryData` 200/204 都算 OK（`fetch.ts:57-58` 注释：不读 body）
- [ ] HTTP 5xx → 走 catch 路径打 log（**不会**重试当前代码）

## 3. 必看的日志关键字

| 关键字 | 含义 | 期望 |
|---|---|---|
| `WebSocketServer listening` | TcpServer 启动 | 出现一次 |
| `新的socket连接` | 新 DTU 连接 | 数量 = 实际设备数 |
| `上线` | DTU 注册成功 | 设备首次连接时出现 |
| `离线告警` | DTU 断开 | 重连/掉电时出现 |
| `查询指令超时` | 某 pid 全部超时 | 偶发正常，持续出现要查 |
| `硬重启` | 触发 `AT+Z` | 真机出问题时**期望**出现 |
| `connect_error` | Socket.IO 鉴权失败 | **不该**出现（PR #20 鉴权有问题时出现）|
| `token=MISSING` | NODE_TOKEN 注入失败 | **不该**出现（部署时已注入） |

## 4. 性能基线（**跑出来再说，没跑别写**）

> 暂未实测，先空着。等 24h 回归跑出数据再回填。

- [ ] 单 node 支持设备数（`MaxConnections=2000` 是配置值，实际能跑多少？）
- [ ] 单 node 峰值查询 QPS
- [ ] 单 DTU 掉线重连耗时
- [ ] UartNode 进程 RSS / CPU（24h 内稳态）

## 5. 回归失败处理

如果 24h 跑出问题：

1. **回滚代码** —— `git revert` 到上一个稳定 commit
2. **保留日志** —— `docker logs uartnode` 输出 + `journalctl`（如果是 systemd）
3. **写 issue / doc 记录** —— 这次失败原因、现象、规避方案
4. **更新本 checklist** —— 把新发现的坑加到 §2 / §3

**别** "再改一版试试" 直接上生产 —— 24h 没过的 PR 就要重新走一遍。
