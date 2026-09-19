import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { LogEntry } from '../types';
import { Card, Button, EmptyState, Badge, PageHeader, Modal } from '../components/ui';
import { CleanupDialog } from '../components/CleanupDialog';

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
      {cleanupOpen && <CleanupDialog kind="relay" onClose={() => setCleanupOpen(false)} onDone={refresh} />}
    </div>
  );
}
