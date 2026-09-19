import { useEffect, useState } from 'react';
import { api, fmtTs } from '../api';
import type { LogSummary } from '../types';
import { Button, Modal, Note } from './ui';

export type CleanupKind = 'relay' | 'capture';

const LABELS: Record<CleanupKind, { title: string; noun: string }> = {
  relay: { title: '清理日志', noun: '转发日志' },
  capture: { title: '清理捕获记录', noun: '捕获记录' },
};

const OPTIONS: { value: number; label: string }[] = [
  { value: 7, label: '保留最近 7 天' },
  { value: 30, label: '保留最近 30 天' },
  { value: 90, label: '保留最近 90 天' },
  { value: 180, label: '保留最近 180 天' },
  { value: 365, label: '保留最近 1 年' },
  { value: 0, label: '清空全部' },
];

// 手动清理弹窗：kind 决定只清哪一类（日志页清转发，捕获页清捕获），互不波及。
export function CleanupDialog({ kind, onClose, onDone }: { kind: CleanupKind; onClose: () => void; onDone: () => void }) {
  const [summary, setSummary] = useState<LogSummary | null>(null);
  const [days, setDays] = useState(30);
  const [estimate, setEstimate] = useState<LogSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const label = LABELS[kind];

  useEffect(() => {
    api.getLogsSummary(undefined, kind).then(setSummary).catch(() => {});
  }, [kind]);

  useEffect(() => {
    setEstimate(null);
    api.getLogsSummary(days, kind).then(setEstimate).catch(() => {});
  }, [days, kind]);

  const run = async () => {
    if (busy) return;
    const cutoff = Date.now() - days * 86400000;
    const scope = days === 0 ? '全部' + label.noun : fmtTs(cutoff) + ' 之前的' + label.noun;
    if (!window.confirm('确认删除' + scope + '（约 ' + (estimate?.older ?? '?') + ' 条）？此操作不可撤销。')) return;
    setBusy(true);
    try {
      const r = await api.cleanupLogs(days, kind);
      setResult('已删除 ' + r.deleted.toLocaleString() + ' 条，' + label.noun + '剩余 ' + r.remaining.toLocaleString() + ' 条。');
      api.getLogsSummary(undefined, kind).then(setSummary).catch(() => {});
      onDone();
    } catch (e) {
      setResult('清理失败：' + String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={label.title}
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
            <div><dt className="text-xs text-zinc-400">{label.noun}条数</dt><dd className="tabular-nums">{(summary?.total ?? 0).toLocaleString()}</dd></div>
            <div><dt className="text-xs text-zinc-400">最早一条</dt><dd>{summary?.oldest_ts ? fmtTs(summary.oldest_ts) : '—'}</dd></div>
          </dl>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-600">清理范围</span>
          <select
            className="w-full cursor-pointer rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <Note tone="warn">
          将删除 {fmtTs(Date.now() - days * 86400000)} 之前的 <b>{(estimate?.older ?? 0).toLocaleString()}</b> 条{label.noun}
          {kind === 'capture' ? '。另一类（转发日志）不受影响。' : '。另一类（捕获记录）不受影响。'}
        </Note>
        {result && <div className="text-xs text-zinc-500">{result}</div>}
      </div>
    </Modal>
  );
}
