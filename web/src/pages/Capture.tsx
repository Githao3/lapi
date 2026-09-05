import { useEffect, useState } from 'react';
import { api, fmtTs } from '../api';
import type { LogEntry } from '../types';
import { Card, Button, Badge, EmptyState, PageHeader, Modal } from '../components/ui';

function KVList({ title, obj, empty }: { title: string; obj: Record<string, unknown> | null | undefined; empty: string }) {
  const keys = obj ? Object.keys(obj) : [];
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400">{title}</div>
      {!obj || keys.length === 0 ? (
        <div className="text-xs text-zinc-400">{empty}</div>
      ) : (
        <div className="overflow-hidden rounded-lg bg-white ring-1 ring-black/[0.06]">
          {keys.map((k) => (
            <div key={k} className="flex gap-3 border-b border-black/[0.04] px-3 py-1.5 last:border-b-0">
              <span className="w-44 shrink-0 truncate font-mono text-[11px] text-zinc-400" title={k}>{k}</span>
              <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-zinc-700">{String(obj[k])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CaptureDialog({ log, onClose }: { log: LogEntry; onClose: () => void }) {
  const detail = (log.detail ?? {}) as Record<string, unknown>;
  const inHeaders = (detail.inHeaders ?? null) as Record<string, unknown> | null;
  const outHeaders = (detail.outHeaders ?? null) as Record<string, unknown> | null;
  const bodyPreview = typeof detail.bodyPreview === 'string' ? detail.bodyPreview : '';
  const uaKey = Object.keys(inHeaders ?? {}).find((x) => x.toLowerCase() === 'user-agent');
  const ua = uaKey ? String(inHeaders?.[uaKey] ?? '').trim() : '';
  const [uaMsg, setUaMsg] = useState<string | null>(null);

  const saveUa = async () => {
    if (!ua) return;
    try {
      const r = await api.saveUaPreset(ua);
      setUaMsg(r.added === false ? '该 UA 已在预设里了' : '已存为 UA 预设——渠道编辑的「UA 伪装预设」下拉里可选');
    } catch {
      setUaMsg('保存失败，稍后再试');
    }
    setTimeout(() => setUaMsg(null), 4000);
  };

  const copyDetail = () => {
    navigator.clipboard.writeText(JSON.stringify(log.detail ?? {}, null, 2)).catch(() => {});
  };

  return (
    <Modal title={'捕获详情 #' + log.id} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="rounded-xl border border-black/[0.06] p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">基本信息</div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            <div><dt className="text-xs text-zinc-400">时间</dt><dd>{fmtTs(log.ts)}</dd></div>
            <div><dt className="text-xs text-zinc-400">方法</dt><dd><Badge tone="amber">{log.method}</Badge></dd></div>
            <div className="col-span-2"><dt className="text-xs text-zinc-400">路径</dt><dd className="break-all font-mono text-xs">{log.path}</dd></div>
          </dl>
        </div>
        {ua && (
          <div className="flex items-center gap-2.5 rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-3">
            <span className="shrink-0 text-xs font-medium text-indigo-900">User-Agent</span>
            <span className="min-w-0 flex-1 break-all font-mono text-xs text-indigo-700" title={ua}>{ua}</span>
            <Button variant="subtle" onClick={saveUa}>存为 UA 预设</Button>
          </div>
        )}
        {uaMsg && <div className="text-xs font-medium text-emerald-700">{uaMsg}</div>}
        <KVList title="入站请求头（已打码）" obj={inHeaders} empty="无" />
        <KVList
          title="出站请求头（将发往上游，已打码）"
          obj={outHeaders}
          empty="未构造出站头（无匹配渠道）"
        />
        {bodyPreview && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400">Body 预览（截断 4KB）</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-zinc-50 p-3 font-mono text-[11px] leading-relaxed text-zinc-600 ring-1 ring-black/[0.05]">{bodyPreview}</pre>
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="subtle" onClick={copyDetail}>复制详情 JSON</Button>
        </div>
      </div>
    </Modal>
  );
}

export default function Capture() {
  const [enabled, setEnabled] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = async () => {
    try {
      const c = await api.getCapture();
      setEnabled(c.enabled === true || c.enabled === '1' || c.enabled === 1);
      setEntries(c.entries ?? []);
    } catch {}
  };

  useEffect(() => { reload(); }, []);

  const toggle = async () => {
    setLoading(true);
    try {
      await api.toggleCapture(!enabled);
      await reload();
    } finally {
      setLoading(false);
    }
  };

  const clearAll = async () => {
    if (!confirm('清空全部捕获记录？')) return;
    await api.clearCapture();
    await reload();
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="捕获"
        desc="开启后请求不转发，直接回显入站/出站两份请求头（凭证打码）"
      />
      <Card title="请求头捕获" actions={
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-[13px] text-zinc-500">
            <span className={'h-2 w-2 rounded-full ' + (enabled ? 'bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.18)]' : 'bg-zinc-300')} />
            {enabled ? '捕获中' : '已停用'}
          </span>
          <Button variant={enabled ? 'danger' : 'primary'} onClick={toggle} disabled={loading}>
            {enabled ? '停用捕获' : '启用捕获'}
          </Button>
        </div>
      }>
        <div className="space-y-2 text-xs leading-relaxed text-zinc-500">
          <div>用法：</div>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>打开上方捕获开关。</li>
            <li>把工具的 base URL 指向本网关：<code className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-indigo-700 ring-1 ring-black/[0.05]">http://127.0.0.1:8787</code></li>
            <li>工具发请求后，工具终端会直接收到 400，里面内嵌「入站 + 出站」两份头（凭证已打码）；这里同时留档。</li>
            <li>点击任意记录查看结构化的两份头与 body 预览；遇到好用的 agent UA 可一键存为预设。</li>
          </ol>
        </div>
      </Card>

      <Card
        title={'捕获记录（' + entries.length + '）'}
        actions={entries.length > 0 && <Button variant="danger" onClick={clearAll}>清空</Button>}
      >
        {entries.length === 0 ? (
          <EmptyState text="暂无捕获记录。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-black/[0.06] text-[11px] uppercase tracking-wider text-zinc-400">
                  <th className="pb-2.5 pr-3 text-center font-medium">时间</th>
                  <th className="pb-2.5 pr-3 text-center font-medium">方法</th>
                  <th className="pb-2.5 pr-3 text-center font-medium">路径</th>
                  <th className="pb-2.5 text-center font-medium">User-Agent</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((l) => {
                  const h = (l.detail ?? {}) as Record<string, unknown>;
                  const ih = (h.inHeaders ?? {}) as Record<string, unknown>;
                  const uaKey = Object.keys(ih).find((x) => x.toLowerCase() === 'user-agent');
                  const ua = uaKey ? String(ih[uaKey] ?? '') : '';
                  return (
                    <tr
                      key={l.id}
                      className="cursor-pointer border-t border-black/[0.05] align-top transition-colors hover:bg-zinc-50/80"
                      onClick={() => setSelected(l)}
                    >
                      <td className="whitespace-nowrap px-1.5 py-2.5 text-center text-xs tabular-nums text-zinc-400">{fmtTs(l.ts)}</td>
                      <td className="px-1.5 py-2.5 text-center"><Badge tone="amber">{l.method}</Badge></td>
                      <td className="max-w-[280px] px-1.5 py-2.5 text-center font-mono text-xs">
                        <div className="truncate text-zinc-700" title={l.path}>{l.path}</div>
                      </td>
                      <td className="max-w-[240px] px-1.5 py-2.5 text-center font-mono text-xs">
                        <div className="truncate text-zinc-500" title={ua}>{ua || '—'}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {selected && <CaptureDialog log={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
