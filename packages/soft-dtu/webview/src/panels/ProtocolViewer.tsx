/**
 * 协议定义浏览器
 *
 * 功能：
 *   - 拉 server `/api/v2/protocols` 列协议
 *   - 点开看 AT 指令 / 寄存器表 / 默认串口参数
 *   - 手动选协议（不预选，Cairui 2026-07-14 16:35 拍板）
 *   - 刷新按钮强制 re-fetch（忽略 5min 缓存）
 *
 * 离线 fallback 显示提示（server 不可达时只有 modbus RTU）
 */

import { useEffect, useState } from "preact/hooks";
import { protocol } from "../api.ts";
import type { ProtocolDefinition } from "../bindings.ts";

export function ProtocolViewer() {
  const [protocols, setProtocols] = useState<ProtocolDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(force = false) {
    setLoading(true);
    setError(null);
    try {
      const list = force ? await protocol.refresh() : await protocol.list();
      setProtocols(list);
    } catch (err) {
      setError(`协议拉取失败: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(false);
  }, []);

  const selected = protocols.find((p) => p.id === selectedId);

  return (
    <div class="protocol-viewer">
      <section class="row toolbar">
        <label>协议</label>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId((e.target as HTMLSelectElement).value)}
        >
          <option value="">（不选）</option>
          {protocols.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} [{p.type}]
            </option>
          ))}
        </select>
        <button onClick={() => load(true)} disabled={loading}>
          {loading ? "刷新中…" : "强制刷新"}
        </button>
        <span class="count">{protocols.length} 个协议</span>
      </section>

      {!selected && protocols.length === 1 && protocols[0].id === "modbus-rtu-default" && (
        <div class="warn">
          ⚠️ 协议目录是离线模式（server 不可达），只显示 modbus RTU fallback。
        </div>
      )}

      {selected && (
        <div class="protocol-detail">
          <h2>{selected.name}</h2>
          <dl class="meta">
            <dt>ID</dt><dd><code>{selected.id}</code></dd>
            <dt>类型</dt><dd>{selected.type}</dd>
            {selected.manufacturer && <><dt>厂商</dt><dd>{selected.manufacturer}</dd></>}
            {selected.model && <><dt>型号</dt><dd>{selected.model}</dd></>}
            {selected.category && <><dt>分类</dt><dd>{selected.category}</dd></>}
            {selected.version && <><dt>版本</dt><dd>{selected.version}</dd></>}
            {selected.transport && <><dt>传输</dt><dd><code>{selected.transport}</code></dd></>}
          </dl>

          {selected.register && (
            <section>
              <h3>注册包</h3>
              <dl class="meta">
                <dt>格式</dt><dd><code>{selected.register.format}</code></dd>
                <dt>IMEI 位数</dt><dd>{selected.register.imeiLength}</dd>
                <dt>触发仪式</dt>
                <dd>{selected.register.triggerOnInvite ? "是（+++AT+ 后）" : "否"}</dd>
              </dl>
            </section>
          )}

          {selected.atCommands && selected.atCommands.length > 0 && (
            <section>
              <h3>AT 指令 ({selected.atCommands.length})</h3>
              <table class="at-table">
                <thead>
                  <tr>
                    <th>名</th>
                    <th>指令</th>
                    <th>解析正则</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.atCommands.map((c) => (
                    <tr key={c.name}>
                      <td><code>{c.name}</code></td>
                      <td><code>{c.cmd}</code></td>
                      <td><code class="regex">{c.parse}</code></td>
                      <td>{c.description ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {selected.registers && selected.registers.length > 0 && (
            <section>
              <h3>Modbus 寄存器 ({selected.registers.length})</h3>
              <table class="reg-table">
                <thead>
                  <tr>
                    <th>地址</th>
                    <th>名</th>
                    <th>类型</th>
                    <th>数据类型</th>
                    <th>单位</th>
                    <th>系数</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.registers.map((r, idx) => (
                    <tr key={`${r.address}-${idx}`}>
                      <td><code>{r.address}</code></td>
                      <td>{r.name}</td>
                      <td>{r.type}</td>
                      <td>{r.dataType}</td>
                      <td>{r.unit ?? ""}</td>
                      <td>{r.scale ?? ""}</td>
                      <td>{r.description ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {selected.defaultSerial && (
            <section>
              <h3>默认串口参数</h3>
              <dl class="meta">
                <dt>波特率</dt><dd>{selected.defaultSerial.baudRate}</dd>
                <dt>数据位</dt><dd>{selected.defaultSerial.dataBits}</dd>
                <dt>停止位</dt><dd>{selected.defaultSerial.stopBits}</dd>
                <dt>校验</dt><dd>{selected.defaultSerial.parity}</dd>
              </dl>
            </section>
          )}

          {selected.metadata && Object.keys(selected.metadata).length > 0 && (
            <section>
              <h3>元数据</h3>
              <dl class="meta">
                {Object.entries(selected.metadata).flatMap(([k, v]) => [
                  <dt key={`${k}-dt`}>{k}</dt>,
                  <dd key={`${k}-dd`}>{v}</dd>,
                ])}
              </dl>
            </section>
          )}
        </div>
      )}

      {error && <div class="error">{error}</div>}
    </div>
  );
}
