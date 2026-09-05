import { useEffect, useMemo, useState } from 'react';
import { api, fmtTs, fmtUptime } from '../api';
import type { SystemInfo, SettingsPayload, LogEntry, UsageStats } from '../types';
import { Card, Badge, EmptyState, Button, PageHeader } from '../components/ui';

function fmtCompact(n: number): string {
  if (n == null) return '—';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('en-US');
}

const RANGES: { key: string; label: string }[] = [
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
];

const C_INPUT = '#3b82f6';
const C_OUTPUT = '#10b981';

// Lightweight stacked-bar trend chart (no chart lib): input + output tokens per bucket.
function TrendChart({ stats }: { stats: UsageStats }) {
  const W = 640;
  const H = 170;
  const PAD_L = 44;
  const PAD_B = 20;
  const PAD_T = 8;
  const buckets = stats.trend;
  const maxVal = Math.max(1, ...buckets.map((b) => b.input_tokens + b.output_tokens));
  const iw = (W - PAD_L - 8) / Math.max(1, buckets.length);
  const bars = buckets.map((b, i) => {
    const total = b.input_tokens + b.output_tokens;
    const hIn = (b.input_tokens / maxVal) * (H - PAD_B - PAD_T);
    const hOut = (b.output_tokens / maxVal) * (H - PAD_B - PAD_T);
    const x = PAD_L + i * iw + iw * 0.14;
    const w = Math.max(2, iw * 0.72);
    const yOut = H - PAD_B - hIn - hOut;
    const yIn = H - PAD_B - hIn;
    return { x, w, yIn, hIn, yOut, hOut, total, bucket: b.bucket };
  });
  const maxLabel = fmtCompact(maxVal);
  const labelStep = Math.ceil(buckets.length / 8);
  return (
    <svg viewBox={'0 0 ' + W + ' ' + H} className="w-full" role="img">
      <line x1={PAD_L} y1={H - PAD_B} x2={W - 4} y2={H - PAD_B} stroke="#e4e4e7" />
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} stroke="#e4e4e7" />
      <text x={4} y={PAD_T + 8} fontSize="9" fill="#a1a1aa">{maxLabel}</text>
      <text x={4} y={H - PAD_B} fontSize="9" fill="#a1a1aa">0</text>
      {bars.map((b, i) => (
        <g key={i}>
          {b.total > 0 && (
            <>
              <rect x={b.x} y={b.yOut} width={b.w} height={Math.max(b.hOut, 0.5)} fill={C_OUTPUT} opacity="0.9" rx="1.5" />
              <rect x={b.x} y={b.yIn} width={b.w} height={Math.max(b.hIn, 0.5)} fill={C_INPUT} opacity="0.9" rx="1.5" />
            </>
          )}
          {i % labelStep === 0 && (
            <text x={b.x + b.w / 2} y={H - 6} fontSize="9" fill="#a1a1aa" textAnchor="middle">
              {new Date(b.bucket).getMonth() + 1}/{new Date(b.bucket).getDate()}
              {stats.bucket_ms < 86400000 ? ' ' + String(new Date(b.bucket).getHours()).padStart(2, '0') + '时' : ''}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

function RankBars({ rows }: { rows: { name: string; requests: number; input_tokens: number; output_tokens: number }[] }) {
  const top = rows.slice(0, 6);
  const max = Math.max(1, ...top.map((r) => r.requests));
  const rest = rows.slice(6);
  const restTokens = rest.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0);
  const restReq = rest.reduce((s, r) => s + r.requests, 0);
  if (top.length === 0) return <div className="text-xs text-zinc-400">无数据</div>;
  return (
    <div className="space-y-2">
      {top.map((r) => (
        <div key={r.name}>
          <div className="mb-0.5 flex items-baseline justify-between gap-2 text-xs">
            <span className="min-w-0 truncate font-mono text-zinc-700" title={r.name}>{r.name}</span>
            <span className="whitespace-nowrap tabular-nums text-zinc-400">{fmtCompact(r.requests)} 次 · {fmtCompact(r.input_tokens + r.output_tokens)} tk</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100">
            <div className="h-full rounded-full bg-indigo-500/80" style={{ width: Math.max(3, (r.requests / max) * 100) + '%' }} />
          </div>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="pt-1 text-[11px] text-zinc-400">其他 {rest.length} 项：{fmtCompact(restReq)} 次 · {fmtCompact(restTokens)} tk</div>
      )}
    </div>
  );
}

function KpiCard(props: { label: string; value: string; sub?: string; dot?: string }) {
  return (
    <div className="rounded-xl border border-black/[0.05] bg-gradient-to-b from-white to-zinc-50/70 p-3.5 transition-shadow hover:shadow-md">
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-zinc-400">
        {props.dot && <span className={'h-1.5 w-1.5 rounded-full ' + props.dot} />}
        {props.label}
      </div>
      <div className="mt-1.5 text-lg font-semibold tabular-nums tracking-tight text-zinc-900">{props.value}</div>
      {props.sub && <div className="mt-0.5 text-[11px] tabular-nums text-zinc-400">{props.sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [cfg, setCfg] = useState<SettingsPayload | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [range, setRange] = useState('7d');
  const [stamp, setStamp] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getSystem(), api.getConfig(), api.listLogs(5), api.getStats(range)])
      .then(([s, c, l, st]) => {
        if (!alive) return;
        setSys(s);
        setCfg(c);
        setLogs(l);
        setStats(st);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [stamp, range]);

  const mode = sys?.mode ?? 'relay';
  const t = stats?.totals;
  const hitRate = useMemo(() => {
    const denom = (t?.input_tokens ?? 0) + (t?.cache_read ?? 0) + (t?.cache_creation ?? 0);
    return denom > 0 ? Math.round(((t?.cache_read ?? 0) / denom) * 1000) / 10 : null;
  }, [t]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="概览"
        desc="网关运行状态与用量总览"
        actions={
          <div className="flex items-center gap-2">
            {RANGES.map((r) => (
              <Button key={r.key} variant={range === r.key ? 'primary' : 'ghost'} onClick={() => setRange(r.key)}>{r.label}</Button>
            ))}
            <Button variant="subtle" onClick={() => setStamp(Date.now())}>刷新</Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="请求次数" value={fmtCompact(t?.requests ?? 0)} sub={'成功率 ' + (t?.success_rate ?? 0) + '% · 失败 ' + (t?.fail ?? 0)} dot="bg-indigo-500" />
        <KpiCard label="Tokens 输入" value={fmtCompact(t?.input_tokens ?? 0)} sub={'缓存 R ' + fmtCompact(t?.cache_read ?? 0) + ' · W ' + fmtCompact(t?.cache_creation ?? 0) + (hitRate != null ? ' · 命中 ' + hitRate + '%' : '')} dot="bg-blue-500" />
        <KpiCard label="Tokens 输出" value={fmtCompact(t?.output_tokens ?? 0)} sub={'入/出比 ' + ((t?.output_tokens ?? 0) > 0 && (t?.input_tokens ?? 0) > 0 ? ((t!.input_tokens / t!.output_tokens).toFixed(1) + ' : 1') : '—')} dot="bg-emerald-500" />
        <KpiCard label="RPM / TPM" value={String(stats?.rpm ?? 0) + ' / ' + fmtCompact(stats?.tpm ?? 0)} sub="近 5 分钟均值" dot="bg-amber-500" />
        <KpiCard label="平均耗时" value={fmtSec(stats?.totals?.avg_ms ?? 0)} sub={'时间范围：' + (RANGES.find((r) => r.key === range)?.label ?? range)} dot="bg-zinc-400" />
      </div>

      <Card title="用量趋势" actions={
        <div className="flex items-center gap-3 text-[11px] text-zinc-400">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: C_INPUT }} />输入</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: C_OUTPUT }} />输出</span>
        </div>
      }>
        {!stats || stats.trend.every((b) => b.requests === 0) ? (
          <EmptyState text="所选范围内暂无请求。" />
        ) : (
          <TrendChart stats={stats} />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="模型排行（按调用次数）">
          <RankBars rows={stats?.by_model ?? []} />
        </Card>
        <Card title="渠道排行（按调用次数）">
          <RankBars rows={stats?.by_channel ?? []} />
        </Card>
      </div>

      <Card title="运行状态">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="模式" value={mode} badge={<Badge tone={mode === 'capture' ? 'amber' : 'cyan'}>{mode === 'capture' ? '捕获中' : '中继'}</Badge>} />
          <Stat label="监听地址" value={cfg?.bind ?? '…'} />
          <Stat label="端口" value={String(cfg?.resolved_port ?? cfg?.port ?? '…')} />
          <Stat label="渠道数" value={String(sys?.channels ?? '…')} />
          <Stat label="运行时长" value={fmtUptime(sys?.uptime ?? 0)} />
          <Stat label="请求日志" value={cfg?.logging_enabled === '1' ? '开启' : '关闭'} />
        </div>
      </Card>

      <Card title="最近日志">
        {logs.length === 0 ? (
          <EmptyState text={'暂无日志。先让某个工具指向本网关地址发个请求吧。'} />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-black/[0.06] text-[11px] uppercase tracking-wider text-zinc-400">
                <th className="pb-2.5 font-medium">时间</th>
                <th className="pb-2.5 font-medium">路径</th>
                <th className="pb-2.5 font-medium">渠道</th>
                <th className="pb-2.5 font-medium">模型</th>
                <th className="pb-2.5 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-t border-black/[0.05] transition-colors first:border-t-0 hover:bg-zinc-50/80">
                  <td className="py-2 pr-4 whitespace-nowrap tabular-nums text-zinc-400">{fmtTs(l.ts)}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-zinc-700">{l.path}</td>
                  <td className="py-2 pr-4 text-zinc-700">{l.channel_name || '—'}</td>
                  <td className="py-2 pr-4 text-zinc-700">{l.model || '—'}</td>
                  <td className="py-2">
                    <span className={'inline-flex items-center gap-1.5 font-medium tabular-nums ' + (l.status == null ? 'text-zinc-400' : l.status < 400 ? 'text-emerald-600' : 'text-rose-600')}>
                      <span className={'h-1.5 w-1.5 rounded-full ' + (l.status == null ? 'bg-zinc-300' : l.status < 400 ? 'bg-emerald-500' : 'bg-rose-500')} />
                      {l.status ?? '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function fmtSec(ms: number): string {
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(2) + 's';
}

function Stat(props: { label: string; value: string; badge?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-black/[0.05] bg-gradient-to-b from-white to-zinc-50/70 p-3.5 transition-shadow hover:shadow-md">
      <div className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-zinc-400">{props.label}</div>
      <div className="mt-1.5 flex items-center gap-2 text-lg font-semibold tabular-nums tracking-tight text-zinc-900">
        {props.badge ?? props.value}
      </div>
    </div>
  );
}
