import { useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts';
import { api, fmtTs, fmtUptime } from '../api';
import type { SystemInfo, SettingsPayload, LogEntry, UsageStats } from '../types';
import { Card, Badge, EmptyState, Button, PageHeader } from '../components/ui';
import { EChart } from '../components/EChart';

function fmtCompact(n: number): string {
  if (n == null) return '—';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('en-US');
}

/** Split a compact value into digits + unit for large typographic display. */
function splitValue(n: number): { v: string; unit: string } {
  if (Math.abs(n) >= 1e6) return { v: (n / 1e6).toFixed(1), unit: 'M' };
  if (Math.abs(n) >= 1e4) return { v: (n / 1e3).toFixed(1), unit: 'K' };
  return { v: String(Math.round(n)), unit: '' };
}

const RANGES: { key: string; label: string }[] = [
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
];

/** Model accent colors, cycled by index — shared by donut, stacked bars and rankings. */
const MODEL_COLORS = ['#5b8cff', '#22c39a', '#b07cff', '#ff5d6c', '#f5a524', '#16c0d8', '#f78ac0', '#8de24f', '#9aa7ff', '#ffd166'];
/** Neutral grey for the Others bucket so it never competes with a real model. */
const OTHERS_COLOR = '#d4d4d8';
const colorForIndex = (i: number) => MODEL_COLORS[i % MODEL_COLORS.length];

/**
 * Keep the leading n rows sorted desc by value, collapse the tail into one
 * bucket — a long tail of sub-1% models turns into slivers too thin to read.
 */
function topWithOthers<T>(items: T[], value: (t: T) => number, n: number) {
  const sorted = [...items].sort((a, b) => value(b) - value(a));
  const rest = sorted.slice(n);
  return {
    top: sorted.slice(0, n),
    othersValue: rest.reduce((s, x) => s + value(x), 0),
    othersCount: rest.length,
    grand: sorted.reduce((s, x) => s + value(x), 0),
  };
}

const C_INPUT = '#3b82f6';
const C_OUTPUT = '#10b981';

function fmtBucketLabel(ts: number, hourly: boolean): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  const day = p(d.getMonth() + 1) + '/' + p(d.getDate());
  return hourly ? day + ' ' + p(d.getHours()) + '时' : day;
}

function delta(cur: number, prev: number | undefined): { text: string; cls: string } | null {
  if (prev == null || prev === 0) return null;
  const pct = Math.round(((cur - prev) / prev) * 1000) / 10;
  if (!isFinite(pct) || pct === 0) return null;
  return { text: (pct > 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '%', cls: pct > 0 ? 'text-emerald-600' : 'text-rose-500' };
}

function KpiCard(props: { label: string; value: string; sub?: string; dot?: string; delta?: { text: string; cls: string } | null }) {
  return (
    <div className="rounded-xl border border-black/[0.05] bg-gradient-to-b from-white to-zinc-50/70 p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-center justify-between gap-2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-zinc-400">
        <span className="flex items-center gap-1.5">
          {props.dot && <span className={'h-1.5 w-1.5 rounded-full ' + props.dot} />}
          {props.label}
        </span>
        {props.delta && <span className={'text-[11px] font-semibold normal-case tracking-normal ' + props.delta.cls}>{props.delta.text}</span>}
      </div>
      <div className="mt-1.5 text-lg font-semibold tabular-nums tracking-tight text-zinc-900">{props.value}</div>
      {props.sub && <div className="mt-0.5 text-[11px] tabular-nums text-zinc-400">{props.sub}</div>}
    </div>
  );
}

const tooltipBase = {
  backgroundColor: 'rgba(255,255,255,0.97)',
  borderColor: '#e4e4e7',
  textStyle: { color: '#18181b', fontSize: 11, fontFamily: 'ui-monospace, monospace' },
  extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,0.12); border-radius: 10px;',
};

/** A distribution row: donut slice + legend list entry share color and value. */
interface DistRow {
  name: string;
  value: number;
  color: string;
  isOthers: boolean;
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
  const pt = stats?.prev_totals;
  const hourly = (stats?.bucket_ms ?? 86400000) < 86400000;
  const hitRate = useMemo(() => {
    const denom = (t?.input_tokens ?? 0) + (t?.cache_read ?? 0) + (t?.cache_creation ?? 0);
    return denom > 0 ? Math.round(((t?.cache_read ?? 0) / denom) * 1000) / 10 : null;
  }, [t]);

  // ---- distribution rows: top 5 models by requests + grey Others (shared by donut & list) ----
  const dist = useMemo<{ rows: DistRow[]; grand: number }>(() => {
    if (!stats || stats.by_model.length === 0) return { rows: [], grand: 0 };
    const { top, othersValue, othersCount, grand } = topWithOthers(stats.by_model, (r) => r.requests, 5);
    const rows: DistRow[] = top.map((r, i) => ({ name: r.name, value: r.requests, color: colorForIndex(i), isOthers: false }));
    if (othersCount > 0) rows.push({ name: '其他' + (othersCount > 1 ? `（${othersCount} 个模型）` : ''), value: othersValue, color: OTHERS_COLOR, isOthers: true });
    return { rows, grand };
  }, [stats]);

  // ---- usage trend: stacked tokens per model per bucket ----
  const stackedModels = useMemo(() => {
    if (!stats) return [] as { model: string; total: number; color: string }[];
    const totals = new Map<string, number>();
    for (const r of stats.trend_by_model) totals.set(r.model, (totals.get(r.model) ?? 0) + r.input_tokens + r.output_tokens);
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const out = top.map(([model], i) => ({ model, total: totals.get(model) ?? 0, color: colorForIndex(i) }));
    const restTotal = [...totals.entries()].slice(5).reduce((s, [, v]) => s + v, 0);
    if (restTotal > 0) out.push({ model: '其他', total: restTotal, color: OTHERS_COLOR });
    return out;
  }, [stats]);

  const trendOption = useMemo(() => {
    if (!stats || stats.trend.length === 0) return null;
    const labels = stats.trend.map((b) => fmtBucketLabel(b.bucket, hourly));
    const series = stackedModels.map((m) => {
      const dmap = new Map(
        stats.trend_by_model.filter((r) => r.model === m.model).map((r) => [r.bucket, r.input_tokens + r.output_tokens]),
      );
      return {
        name: m.model,
        type: 'bar' as const,
        stack: 'total',
        data: stats.trend.map((b) => dmap.get(b.bucket) ?? 0),
        barMaxWidth: 26,
        itemStyle: { color: m.color, borderRadius: [2, 2, 0, 0] },
        emphasis: { focus: 'series' as const },
      };
    });
    return {
      tooltip: {
        trigger: 'axis' as const,
        appendToBody: true,
        confine: true,
        ...tooltipBase,
        axisPointer: { type: 'shadow' as const, shadowStyle: { color: 'rgba(0,0,0,0.035)' } },
        formatter: (ps: { seriesName: string; value: number; color: string; dataIndex: number }[]) => {
          const idx = ps[0]?.dataIndex ?? 0;
          const b = stats?.trend[idx];
          if (!b) return '';
          let html = '<b>' + fmtBucketLabel(b.bucket, hourly) + '</b>';
          let total = 0;
          for (const p of ps) {
            if (p.value > 0) {
              html += '<br><span style="color:' + p.color + '">●</span> ' + p.seriesName + ': ' + fmtCompact(p.value);
              total += p.value;
            }
          }
          html += '<br><br>合计 tokens: ' + fmtCompact(total) + ' · 请求 ' + b.requests + ' 次';
          return html;
        },
      },
      grid: { top: 18, bottom: 2, left: 8, right: 8, containLabel: true },
      xAxis: {
        type: 'category' as const,
        data: labels,
        axisLine: { lineStyle: { color: '#e4e4e7' } },
        axisTick: { show: false },
        axisLabel: { color: '#a1a1aa', fontSize: 10, fontFamily: 'ui-monospace, monospace', interval: Math.ceil(labels.length / 8) - 1 },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: '#a1a1aa', fontSize: 10, fontFamily: 'ui-monospace, monospace', formatter: (v: number) => fmtCompact(v) },
        splitLine: { lineStyle: { color: '#f4f4f5' } },
      },
      series,
    };
  }, [stats, hourly, stackedModels]);

  // ---- model distribution: silent donut + HTML list + HTML center (labels never collide) ----
  const donutOption = useMemo(() => {
    if (dist.rows.length === 0) return null;
    return {
      tooltip: {
        trigger: 'item' as const,
        appendToBody: true,
        confine: true,
        ...tooltipBase,
        formatter: (p: { name: string; value: number; percent: number }) => {
          const row = stats?.by_model.find((r) => r.name === p.name);
          let html = '<b>' + p.name + '</b><br>' + fmtCompact(p.value) + ' 次 · ' + p.percent + '%';
          if (row) html += '<br>tokens ' + fmtCompact(row.input_tokens) + ' / ' + fmtCompact(row.output_tokens);
          return html;
        },
      },
      series: [
        {
          type: 'pie' as const,
          radius: ['58%', '86%'],
          center: ['50%', '50%'],
          avoidLabelOverlap: false,
          label: { show: false },
          labelLine: { show: false },
          emphasis: { label: { show: false }, scale: true, scaleSize: 5, focus: 'self' as const },
          data: dist.rows.map((r) => ({
            name: r.name,
            value: r.value,
            itemStyle: { color: r.color, borderColor: '#fff', borderWidth: 2 },
          })),
        },
      ],
    };
  }, [dist, stats]);

  const donutCenter = useMemo(() => {
    const totalReq = stats?.by_model.reduce((s, r) => s + r.requests, 0) ?? 0;
    return splitValue(totalReq);
  }, [stats]);

  // ---- ranking horizontal bars; models reuse the distribution palette ----
  const rankOption = (rows: { name: string; requests: number; input_tokens: number; output_tokens: number }[], colors?: string[]) => {
    if (rows.length === 0) return null;
    const top = rows.slice(0, 6);
    const max = Math.max(1, ...top.map((r) => r.requests));
    const rev = [...top].reverse();
    const barColor = (i: number) => (colors ? colors[top.length - 1 - i] : undefined);
    return {
      tooltip: {
        trigger: 'item' as const,
        appendToBody: true,
        confine: true,
        ...tooltipBase,
        formatter: (p: { name: string; value: number }) => {
          const r = top.find((x) => x.name === p.name);
          if (!r) return p.name;
          return '<b>' + p.name + '</b><br>' + fmtCompact(r.requests) + ' 次 · tokens ' + fmtCompact(r.input_tokens) + ' / ' + fmtCompact(r.output_tokens);
        },
      },
      grid: { top: 6, bottom: 4, left: 8, right: 42, containLabel: true },
      xAxis: { type: 'value' as const, show: false, max },
      yAxis: {
        type: 'category' as const,
        data: rev.map((r) => r.name),
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#52525b', fontSize: 10, fontFamily: 'ui-monospace, monospace', width: 118, overflow: 'truncate' as const },
      },
      series: [
        {
          type: 'bar' as const,
          data: rev.map((r, i) => ({
            value: r.requests,
            itemStyle: barColor(i)
              ? { borderRadius: 5, color: barColor(i) }
              : {
                  borderRadius: 5,
                  color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                    { offset: 0, color: '#818cf8' },
                    { offset: 1, color: '#4f46e5' },
                  ]),
                },
          })),
          barWidth: 10,
          emphasis: { itemStyle: { color: barColor(0) ? undefined : '#4338ca' } },
          label: { show: true, position: 'right' as const, color: '#71717a', fontSize: 10, fontFamily: 'ui-monospace, monospace', formatter: (p: { value: number }) => fmtCompact(p.value) },
        },
      ],
    };
  };

  const modelRankColors = (stats?.by_model ?? []).slice(0, 6).map((_, i) => colorForIndex(i));

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
        <KpiCard label="请求次数" value={fmtCompact(t?.requests ?? 0)} delta={delta(t?.requests ?? 0, pt?.requests)} sub={'成功率 ' + (t?.success_rate ?? 0) + '% · 失败 ' + (t?.fail ?? 0)} dot="bg-indigo-500" />
        <KpiCard label="Tokens 输入" value={fmtCompact(t?.input_tokens ?? 0)} delta={delta(t?.input_tokens ?? 0, pt?.input_tokens)} sub={'缓存 R ' + fmtCompact(t?.cache_read ?? 0) + ' · W ' + fmtCompact(t?.cache_creation ?? 0)} dot="bg-blue-500" />
        <KpiCard label="Tokens 输出" value={fmtCompact(t?.output_tokens ?? 0)} delta={delta(t?.output_tokens ?? 0, pt?.output_tokens)} sub={'缓存命中 ' + (hitRate != null ? hitRate + '%' : '—')} dot="bg-emerald-500" />
        <KpiCard label="RPM / TPM" value={String(stats?.rpm ?? 0) + ' / ' + fmtCompact(stats?.tpm ?? 0)} sub="近 5 分钟均值" dot="bg-amber-500" />
        <KpiCard label="平均耗时" value={fmtLatency(t?.avg_ms ?? 0)} sub={'全渠道均值 · ' + (RANGES.find((r) => r.key === range)?.label ?? range)} dot="bg-zinc-400" />
      </div>

      <Card title="用量趋势" actions={<span className="text-[11px] tabular-nums text-zinc-400">按模型分色 · tokens</span>}>
        {!stats || stackedModels.length === 0 ? (
          <EmptyState text="所选范围内暂无请求。" />
        ) : (
          <div>
            <EChart option={trendOption!} className="h-[260px] w-full" />
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
              {stackedModels.map((m) => (
                <span key={m.model} className="flex items-center gap-1.5 text-[11px] text-zinc-500" title={m.model}>
                  <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
                  <span className="max-w-[180px] truncate">{m.model}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
        <Card title="模型调用分布" className="md:col-span-2">
          {donutOption ? (
            <div className="flex h-[230px] items-center gap-4">
              <div className="relative h-full w-[46%] shrink-0">
                <EChart option={donutOption} className="h-full w-full" />
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[22px] font-semibold tabular-nums leading-none tracking-tight text-zinc-900">
                    {donutCenter.v}
                    <span className="ml-0.5 text-[13px] font-medium text-zinc-400">{donutCenter.unit}</span>
                  </span>
                  <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-400">总请求</span>
                </div>
              </div>
              <div className="flex h-full min-w-0 flex-1 flex-col justify-center gap-0.5">
                {dist.rows.map((r) => (
                  <div key={r.name} className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-zinc-50" title={r.name}>
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
                    <span className={'min-w-0 flex-1 truncate text-[11.5px] ' + (r.isOthers ? 'text-zinc-400' : 'text-zinc-700')}>{r.name}</span>
                    <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-zinc-400">{dist.grand > 0 && r.value > 0 ? ((r.value / dist.grand) * 100).toFixed(1) : '0.0'}%</span>
                    <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-zinc-600">{fmtCompact(r.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <EmptyState text="无数据" />
          )}
        </Card>
        <Card title="模型排行">
          {rankOption(stats?.by_model ?? [], modelRankColors) ? <EChart option={rankOption(stats?.by_model ?? [], modelRankColors)!} className="h-[230px] w-full" /> : <EmptyState text="无数据" />}
        </Card>
        <Card title="渠道排行">
          {rankOption(stats?.by_channel ?? []) ? <EChart option={rankOption(stats?.by_channel ?? [])!} className="h-[230px] w-full" /> : <EmptyState text="无数据" />}
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

function fmtLatency(ms: number): string {
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
