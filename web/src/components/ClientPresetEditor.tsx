import { useState } from 'react';
import { api } from '../api';
import type { ClientPreset, ClientPresetHeader } from '../types';
import { Button, Modal, Note, inputCls } from './ui';

type Row = ClientPresetHeader;

const MODE_LABELS: Record<Row['mode'], string> = {
  fixed: 'fixed · 总是覆盖',
  fill: 'fill · 缺了才补',
  drop: 'drop · 不发送',
};

// 客户端伪装档案编辑器：捕获页"存为客户端预设"与预设库"编辑"共用。
// isNew = 创建（走 POST）；否则按 initialName 更新（走 PUT，可改名）。
export function ClientPresetEditor(props: {
  isNew: boolean;
  initialName: string;
  initialStrict?: boolean;
  initialHeaders: ClientPresetHeader[];
  onClose: () => void;
  onSaved: (preset: ClientPreset) => void;
}) {
  const [name, setName] = useState(props.initialName);
  const [strict, setStrict] = useState(props.initialStrict !== false);
  const [rows, setRows] = useState<Row[]>(props.initialHeaders.map((h) => ({ ...h })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], ...patch };
      return next;
    });

  const save = async () => {
    if (busy) return;
    const clean = rows
      .map((r) => ({ name: r.name.trim().toLowerCase(), value: r.value, mode: r.mode }))
      .filter((r) => r.name);
    if (!name.trim()) {
      setErr('预设名必填');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const payload = { name: name.trim(), strict, headers: clean };
      const r = props.isNew
        ? await api.createClientPreset(payload)
        : await api.updateClientPreset(props.initialName, payload);
      props.onSaved(r.preset);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={props.isNew ? '存为客户端预设' : '编辑客户端预设'}
      onClose={props.onClose}
      wide
      footer={
        <>
          <Button variant="subtle" onClick={props.onClose}>取消</Button>
          <Button variant="primary" onClick={save} disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存预设'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Note tone="info">
          三种模式：<b>fixed</b> 总是用这里的值覆盖请求（适合 UA 等身份头）；<b>fill</b> 客户端自带就透传、没带才补这里的值（适合
          session 类）；<b>drop</b> 强制不发送。host 与认证头由渠道管辖，不在档案内。
        </Note>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-600">预设名</span>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="如 opencode" />
        </label>
        <label className="flex items-start gap-2.5 rounded-xl border border-black/[0.06] bg-zinc-50/70 px-3.5 py-3">
          <input type="checkbox" className="mt-0.5" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
          <span className="text-xs leading-relaxed text-zinc-600">
            <b className="text-zinc-800">严格模式（建议开启）</b>
            <br />
            出站只保留档案内的头 + 网关管辖头（host/认证/长度/编码），客户端带来的其他指纹头
            （如 sec-fetch-*、accept-language）全部剔除；关闭则档案叠加在客户端头上。
          </span>
        </label>
        <div className="overflow-hidden rounded-xl ring-1 ring-black/[0.06]">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-black/[0.06] bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-400">
                <th className="px-3 py-2 font-medium">请求头</th>
                <th className="px-3 py-2 font-medium">值</th>
                <th className="px-3 py-2 font-medium">模式</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-black/[0.04] last:border-b-0">
                  <td className="px-2 py-1.5">
                    <input className="w-full rounded-md border border-black/[0.08] px-2 py-1 font-mono text-[11px] outline-none focus:border-indigo-500" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <input className="w-full rounded-md border border-black/[0.08] px-2 py-1 font-mono text-[11px] outline-none focus:border-indigo-500" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      className="w-full cursor-pointer rounded-md border border-black/[0.08] bg-white px-2 py-1 text-[11px] outline-none focus:border-indigo-500"
                      value={r.mode}
                      onChange={(e) => setRow(i, { mode: e.target.value as Row['mode'] })}
                    >
                      {(Object.keys(MODE_LABELS) as Row['mode'][]).map((m) => (
                        <option key={m} value={m}>{MODE_LABELS[m]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <button onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))} className="text-zinc-400 transition hover:text-rose-600" title="删除行">✕</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-4 text-center text-zinc-400">暂无头，点下方添加</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between">
          <Button variant="subtle" onClick={() => setRows((prev) => [...prev, { name: '', value: '', mode: 'fixed' }])}>+ 添加头</Button>
          {err && <span className="text-xs text-rose-600">{err}</span>}
        </div>
      </div>
    </Modal>
  );
}
