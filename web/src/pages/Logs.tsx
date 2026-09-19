import { useEffect, useMemo, useState } from 'react';
import { api, fmtTs } from '../api';
import type { LogEntry, LogSummary } from '../types';
import { Card, Button, EmptyState, Badge, PageHeader, Modal, Note } from '../components/ui';

type Attempt = { channel?: string; status?: number | null; error?: string };
type UsageInfo = { input_tokens?: number; output_tokens?: number; total_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

function usageOf(log: LogEntry): UsageInfo | null {
  const u = (log.detail as Record<string, unknown> | null)?.usage as UsageInfo | undefined;
  return u && (u.input_tokens != null || u.output_tokens != null) ? u : null;
}

function fmtInt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US');
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtSec(ms: number | null): string {
  return ms == null ? '—' : (ms / 1000).toFixed(1) + 's';
}

function StatusNum({ status }: { status: number | null }) {
  return (
    <span className={'font-medium tabular-nums ' + (status == null ? 'text-zinc-400' : status >= 200 && status < 300 ? 'text-emerald-600' : 'text-rose-600')}>
      {status ?? '—'}
    </span>
  );
}

function InputTokensCell({ u }: { u: UsageInfo | null }) {
  return (
    <div className="text-center">
      <div className="tabular-nums">{u?.input_tokens != null ? fmtInt(u.input_tokens) : '—'}</div>
      {(u?.cache_read_input_tokens ?? 0) > 0 || (u?.cache_creation_input_tokens ?? 0) > 0 ? (
        <div className="whitespace-nowrap text-[10px] text-zinc-400">
          {[
            (u?.cache_read_input_tokens ?? 0) > 0 ? 'R' + fmtInt(u?.cache_read_input_tokens) : '',
            (u?.cache_creation_input_tokens ?? 0) > 0 ? 'W' + fmtInt(u?.cache_creation_input_tokens) : '',
          ].filter(Boolean).join('·')}
        </div>
      ) : null}
    </div>
  );
}

function DetailDialog({ log, onClose }: { log: LogEntry; onClose: () => void }) {
  const detail = (log.detail ?? {}) as Record<string, unknown>;
  const attempts = Array.isArray(detail.attempts) ? (detail.attempts as Attempt[]) : [];
  const clientError = typeof detail.clientError === 'string' ? detail.clientError : '';
  const usage = detail.usage as UsageInfo | undefined;
  const upstreamModel = typeof detail.upstream_model === 'string' ? detail.upstream_model : '';
  const mapped = upstreamModel && upstreamModel !== log.model;
  return (
    <Modal title="请求详情" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="rounded-xl border border-black/[0.06] p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">基本信息</div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            <div><dt className="text-xs text-zinc-400">请求 ID</dt><dd className="font-mono text-xs">#{log.id}</dd></div>
            <div><dt className="text-xs text-zinc-400">时间</dt><dd>{new Date(log.ts).toLocaleString()}</dd></div>
            <div><dt className="text-xs text-zinc-400">路径</dt><dd className="break-all font-mono text-xs">{log.method} {log.path}</dd></div>
            <div><dt className="text-xs text-zinc-400">渠道</dt><dd>{log.channel_name || '—'}</dd></div>
            <div><dt className="text-xs text-zinc-400">模型</dt><dd className="font-mono text-xs">
              {log.model || '—'}
              {mapped && <span className="text-zinc-400"> → {upstreamModel}</span>}
            </dd></div>
            <div><dt className="text-xs text-zinc-400">状态 / 耗时</dt><dd><StatusNum status={log.status} /> <span className="text-zinc-400">· {fmtSec(log.ms)}</span></dd></div>
          </dl>
        </div>
        {(usage?.input_tokens != null || usage?.output_tokens != null) && (
          <div className="rounded-xl border border-black/[0.06] p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Tokens 用量</div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-zinc-400">输入</dt><dd className="tabular-nums">{fmtInt(usage?.input_tokens)}</dd></div>
              <div><dt className="text-xs text-zinc-400">输出</dt><dd className="tabular-nums">{fmtInt(usage?.output_tokens)}</dd></div>
              <div><dt className="text-xs text-zinc-400">总计</dt><dd className="tabular-nums">{fmtInt(usage?.total_tokens)}</dd></div>
              <div><dt className="text-xs text-zinc-400">缓存 读/写</dt><dd className="tabular-nums">{(usage?.cache_read_input_tokens ?? 0) + '/' + (usage?.cache_creation_input_tokens ?? 0)}</dd></div>
            </dl>
          </div>
        )}
        {log.error && (
          <div className="rounded-xl border border-rose-100 bg-rose-50/60 p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-rose-500">错误</div>
            <div className="break-all font-mono text-xs text-rose-700">{log.error}</div>
          </div>
        )}
        {clientError && (
          <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-600">转换失败（未转发上游）</div>
            <div className="break-all font-mono text-xs text-amber-800">{clientError}</div>
          </div>
        )}
        {attempts.length > 0 && (
          <div className="rounded-xl border border-black/[0.06] p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">上游尝试（{attempts.length} 次）</div>
            <div className="space-y-2">
              {attempts.map((a, i) => (
                <div key={i} className="rounded-lg bg-zinc-50 px-3 py-2">
                  <div className="flex items-center gap-2.5 text-xs">
                    <span className="tabular-nums text-zinc-400">#{i + 1}</span>
                    <span className="font-medium text-zinc-700">{a.channel || '—'}</span>
                    <StatusNum status={a.status ?? null} />
                  </div>
                  {a.error && <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-[11px] leading-relaxed text-zinc-600 ring-1 ring-black/[0.05]">{a.error}</pre>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

const PAGE_SIZE = 20;

const CLEANUP_OPTIONS: { value: number; label: string }[] = [
  { value: 7, label: '保留最近 7 天' },
  { value: 30, label: '保留最近 30 天' },
  { value: 90, label: '保留最近 90 天' },
  { value: 180, label: '保留最近 180 天' },
  { value: 365, label: '保留最近 1 年' },
  { value: 0, label: '清空全部日志' },
];

// 手动清理：日志默认永久保存，只有在这里按"保留天数"主动删
function CleanupDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [summary, setSummary] = useState<LogSummary | null>(null);
  const [days, setDays] = useState(30);
  const [estimate, setEstimate] = useState<LogSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  useEffect(() => {
    api.getLogsSummary().then(setSummary).catch(() => {});
  }, []);

  useEffect(() => {
    setEstimate(null);
    api.getLogsSummary(days).then(setEstimate).catch(() => {});
  }, [days]);

  const run = async () => {
    if (busy) return;
    const cutoff = Date.now() - days * 86400000;
    const scope = days === 0 ? '全部日志' : fmtTs(cutoff) + ' 之前的日志';
    if (!window.confirm('确认删除' + scope + '（约 ' + (estimate?.older ?? '?') + ' 条）？此操作不可撤销。')) return;
    setBusy(true);
    try {
      const r = await api.cleanupLogs(days);
      setResult('已删除 ' + r.deleted.toLocaleString() + ' 条，剩余 ' + r.remaining.toLocaleString() + ' 条。');
      api.getLogsSummary().then(setSummary).catch(() => {});
      onDone();
    } catch (e) {
      setResult('清理失败：' + String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="清理日志"
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" onClick={onClose}>关闭</Button>
          <Button variant="danger" onClick={run} disabled={busy || (estimate?.older ?? 0) === 0}>
            {busy ? '清理中…' : '确认清理'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="rounded-xl border border-black/[0.06] p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">当前存档</div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            <div><dt className="text-xs text-zinc-400">总条数</dt><dd className="tabular-nums">{(summary?.total ?? 0).toLocaleString()}</dd></div>
            <div><dt className="text-xs text-zinc-400">转发 / 捕获</dt><dd className="tabular-nums">{(summary?.relay ?? 0).toLocaleString()} / {(summary?.capture ?? 0).toLocaleString()}</dd></div>
            <div className="col-span-2"><dt className="text-xs text-zinc-400">最早一条</dt><dd>{summary?.oldest_ts ? fmtTs(summary.oldest_ts) : '—'}</dd></div>
          </dl>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-600">清理范围</span>
          <select
            className="w-full cursor-pointer rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {CLEANUP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <Note tone="warn">
          将删除 {fmtTs(Date.now() - days * 86400000)} 之前的 <b>{(estimate?.older ?? 0).toLocaleString()}</b> 条记录（含转发与捕获）。删除不可撤销，概览看板的统计也会随之回落。
        </Note>
        {result && <div className="text-xs text-zinc-500">{result}</div>}
      </div>
    </Modal>
  );
}

export default function Logs() {
  const [logs, setLogsging] = useState<LogEntry[]>([]);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [page, setPage] = useState(0);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const refresh = () => api.listLogs(200).then(setLogsging).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const totalPages = Math.max(1, Math.ceil(logs.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageLogs = useMemo(() => logs.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE), [logs, safePage]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="日志"
        desc="中继请求记录（点击行查看详情：用量、上游尝试与错误）· 默认永久保存"
        actions={
          <>
            <Button variant="subtle" onClick={() => setCleanupOpen(true)}>清理…</Button>
            <Button variant="subtle" onClick={refresh}>刷新</Button>
          </>
        }
      />
      <Card title={'中继日志（' + logs.length + '）'}>
        {logs.length === 0 ? (
          <EmptyState text="暂无日志。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-black/[0.06] text-[11px] uppercase tracking-wider text-zinc-400">
                  <th className="pb-2.5 pr-3 text-center font-medium">时间</th>
                  <th className="pb-2.5 pr-3 text-center font-medium">渠道</th>
                  <th className="pb-2.5 pr-3 text-center font-medium">模型</th>
                  <th className="pb-2.5 pr-3 text-center font-medium">输入</th>
                  <th className="pb-2.5 pr-3 text-center font-medium">输出</th>
                  <th className="pb-2.5 pr-3 text-center font-medium">状态</th>
                  <th className="pb-2.5 text-center font-medium">耗时</th>
                </tr>
              </thead>
              <tbody>
                {pageLogs.map((l) => {
                  const u = usageOf(l);
                  const rawUp = (l.detail as Record<string, unknown> | null)?.upstream_model;
                  const upstreamModel = typeof rawUp === 'string' ? rawUp : '';
                  const mapped = upstreamModel && upstreamModel !== l.model;
                  return (
                    <tr
                      key={l.id}
                      className="cursor-pointer border-t border-black/[0.05] align-top transition-colors hover:bg-zinc-50/80"
                      onClick={() => setSelected(l)}
                    >
                      <td className="whitespace-nowrap px-1.5 py-2.5 text-center text-xs tabular-nums text-zinc-400">{fmtTime(l.ts)}</td>
                      <td className="px-1.5 py-2.5 text-center"><Badge tone={l.kind === 'capture' ? 'amber' : 'neutral'}>{l.channel_name || l.kind}</Badge></td>
                      <td className="max-w-[200px] px-1.5 py-2.5 text-center font-mono text-xs">
                        <div className="truncate" title={mapped ? l.model + ' → ' + upstreamModel : l.model}>
                          {mapped ? <span>{l.model}<span className="text-zinc-400"> → {upstreamModel}</span></span> : (l.model || '—')}
                        </div>
                      </td>
                      <td className="px-1.5 py-2.5 text-center"><InputTokensCell u={u} /></td>
                      <td className="px-1.5 py-2.5 text-center tabular-nums">{u?.output_tokens != null ? fmtInt(u.output_tokens) : '—'}</td>
                      <td className="px-1.5 py-2.5 text-center"><StatusNum status={l.status} /></td>
                      <td className="whitespace-nowrap px-1.5 py-2.5 text-center text-xs tabular-nums text-zinc-500">{fmtSec(l.ms)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {logs.length > PAGE_SIZE && (
          <div className="mt-3 flex items-center justify-between text-xs text-zinc-400">
            <span>共 {logs.length} 条</span>
            <div className="flex items-center gap-2">
              <Button variant="subtle" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>‹</Button>
              <span className="tabular-nums">{safePage + 1} / {totalPages}</span>
              <Button variant="subtle" disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)}>›</Button>
            </div>
          </div>
        )}
      </Card>
      {selected && <DetailDialog log={selected} onClose={() => setSelected(null)} />}
      {cleanupOpen && <CleanupDialog onClose={() => setCleanupOpen(false)} onDone={refresh} />}
    </div>
  );
}
