/**
 * 串口配置面板 — Apple SF card layout
 *
 * 字段：串口 / 波特率 / 数据位 / 停止位 / 校验
 * 按钮：打开串口（primary）/ 关闭串口（danger）
 * 状态：状态 pill（已打开：path @ baudRate / 未打开）
 *
 * 用 http api 而非直接 bindings（Phase 1 走 HTTP）
 */

import { useEffect, useState } from "preact/hooks";
import { serial, getSerialStatus } from "../api.ts";
import type { SerialPortInfo, SerialOptions } from "../bindings.ts";

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DATA_BITS: Array<5 | 6 | 7 | 8> = [5, 6, 7, 8];
const STOP_BITS: Array<1 | 2> = [1, 2];
const PARITIES: Array<NonNullable<SerialOptions["parity"]>> = ["none", "even", "odd", "mark", "space"];

export function SerialConfig() {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [baudRate, setBaudRate] = useState(115200);
  const [dataBits, setDataBits] = useState<5 | 6 | 7 | 8>(8);
  const [stopBits, setStopBits] = useState<1 | 2>(1);
  const [parity, setParity] = useState<SerialOptions["parity"]>("none");
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refreshPorts() {
    setLoading(true);
    setError(null);
    try {
      const list = await serial.list();
      setPorts(list);
      if (list.length > 0 && !selected) {
        setSelected(list[0].path);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshStatus() {
    try {
      const s = await getSerialStatus();
      setIsOpen(s.isOpen);
    } catch (err) {
      // 后端没起 / 路径不存在 — ignore
      void err;
    }
  }

  useEffect(() => {
    refreshPorts();
    refreshStatus();
  }, []);

  async function handleOpen() {
    if (!selected) {
      setError("请先选串口");
      return;
    }
    setError(null);
    try {
      await serial.open(selected, { baudRate, dataBits, stopBits, parity });
      setIsOpen(true);
    } catch (err) {
      setError(`open 失败: ${(err as Error).message}`);
    }
  }

  async function handleClose() {
    setError(null);
    try {
      await serial.close();
      setIsOpen(false);
    } catch (err) {
      setError(`close 失败: ${(err as Error).message}`);
    }
  }

  return (
    <div class="serial-config">
      <div class="panel-header">
        <h2 class="panel-title">串口配置</h2>
        <p class="panel-subtitle">选择并打开设备的串口</p>
      </div>

      <section class="card">
        <div class="card-title">设备</div>

        <div class="field">
          <span class="field-label">串口</span>
          <div class="field-row">
            <select
              value={selected}
              onChange={(e) => setSelected((e.target as HTMLSelectElement).value)}
              disabled={isOpen}
              style={{ flex: 1, minWidth: "180px" }}
            >
              {ports.length === 0 && <option value="">（无可用串口）</option>}
              {ports.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.path}
                  {p.manufacturer ? ` (${p.manufacturer})` : ""}
                </option>
              ))}
            </select>
            <button onClick={refreshPorts} disabled={loading || isOpen}>
              {loading ? "刷新中…" : "刷新"}
            </button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-title">参数</div>

        <div class="field">
          <span class="field-label">波特率</span>
          <select
            value={baudRate}
            onChange={(e) => setBaudRate(Number((e.target as HTMLSelectElement).value))}
            disabled={isOpen}
            style={{ maxWidth: "160px" }}
          >
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>

        <div class="field-row">
          <div class="field">
            <span class="field-label">数据位</span>
            <select
              value={dataBits}
              onChange={(e) => setDataBits(Number((e.target as HTMLSelectElement).value) as 5 | 6 | 7 | 8)}
              disabled={isOpen}
            >
              {DATA_BITS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          <div class="field">
            <span class="field-label">停止位</span>
            <select
              value={stopBits}
              onChange={(e) => setStopBits(Number((e.target as HTMLSelectElement).value) as 1 | 2)}
              disabled={isOpen}
            >
              {STOP_BITS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          <div class="field">
            <span class="field-label">校验</span>
            <select
              value={parity}
              onChange={(e) => setParity((e.target as HTMLSelectElement).value as SerialOptions["parity"])}
              disabled={isOpen}
            >
              {PARITIES.map((p) => (
                <option key={p} value={p}>
                  {p === "none" ? "N" : p.charAt(0).toUpperCase()}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-title">连接</div>

        <div class="btn-row">
          {!isOpen ? (
            <button class="primary large" onClick={handleOpen} disabled={!selected}>
              打开串口
            </button>
          ) : (
            <button class="danger large" onClick={handleClose}>
              关闭串口
            </button>
          )}
          <span class={`status-tag ${isOpen ? "open" : "closed"}`}>
            {isOpen ? `已打开: ${selected} @ ${baudRate}` : "未打开"}
          </span>
        </div>
      </section>

      {error && <div class="error">{error}</div>}
    </div>
  );
}
