import { useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts';
import { api, fmtTs, fmtUptime } from '../api';
import type { SystemInfo, SettingsPayload, LogEntry, UsageStats, UsageStatName } from '../types';
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

type Metric = 'requests' | 'tokens';

/** Value of a usage row under the active metric: request counts or total tokens. */
const metricVal = (r: { requests: number; input_tokens: number; output_tokens: number }, m: Metric) =>
  m === 'tokens' ? r.input_tokens + r.output_tokens : r.requests;

/** Segmented 请求/用量 control for the chart card heads (Token Atlas style). */
function MetricSeg(props: { value: Metric; onChange: (m: Metric) => void }) {
  const opts: [Metric, string][] = [['tokens', '用量'], ['requests', '请求']];
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-black/[0.06] bg-zinc-100/70 p-0.5">
      {opts.map(([k, label]) => (
        <button
          key={k}
          onClick={() => props.onChange(k)}
          className={'rounded-md px-2 py-[3px] text-[11px] font-medium transition-all ' + (props.value === k ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-400 transition-colors hover:text-zinc-600')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** A distribution row: donut slice + legend list entry share color and value. */
interface DistRow {
  name: string;
  value: number;
  color: string;
  isOthers: boolean;
  tkIn: number;
  tkOut: number;
}

export default function Dashboard() {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [cfg, setCfg] = useState<SettingsPayload | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [range, setRange] = useState('7d');
  const [stamp, setStamp] = useState(0);
  const [distMetric, setDistMetric] = useState<Metric>('tokens');
  const [rankMetric, setRankMetric] = useState<Metric>('tokens');

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

  // Per-model palette keyed off the requests-desc order (server order), so a
  // model keeps its color across donut, list and rankings in either metric.
  const modelColor = useMemo(() => new Map((stats?.by_model ?? []).map((r, i) => [r.name, colorForIndex(i)])), [stats]);

  // ---- distribution rows: top 5 models by the active metric + grey Others ----
  const dist = useMemo<{ rows: DistRow[]; grand: number }>(() => {
    if (!stats || stats.by_model.length === 0) return { rows: [], grand: 0 };
    const val = (r: UsageStatName) => metricVal(r, distMetric);
    const sorted = [...stats.by_model].sort((a, b) => val(b) - val(a));
    const top = sorted.slice(0, 5);
    const tail = sorted.slice(5);
    const grand = sorted.reduce((s, r) => s + val(r), 0);
    const rows: DistRow[] = top.map((r) => ({ name: r.name, value: val(r), color: modelColor.get(r.name) ?? OTHERS_COLOR, isOthers: false, tkIn: r.input_tokens, tkOut: r.output_tokens }));
    if (tail.length > 0) {
      rows.push({
        name: '其他（' + tail.length + ' 个模型）',
        value: tail.reduce((s, r) => s + val(r), 0),
        color: OTHERS_COLOR,
        isOthers: true,
        tkIn: tail.reduce((s, r) => s + r.input_tokens, 0),
        tkOut: tail.reduce((s, r) => s + r.output_tokens, 0),
      });
    }
    return { rows, grand };
  }, [stats, distMetric, modelColor]);

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
          let html = '<b>' + p.name + '</b><br>' + fmtCompact(p.value) + (distMetric === 'tokens' ? ' tokens' : ' 次') + ' · ' + p.percent + '%';
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
  }, [dist, stats, distMetric]);

  const donutCenter = useMemo(() => splitValue(dist.grand), [dist]);

  // ---- ranking horizontal bars; models reuse the per-model palette, channels the indigo gradient ----
  const rankOption = (rows: UsageStatName[], metric: Metric, colorOf?: (name: string) => string | undefined) => {
    if (rows.length === 0) return null;
    const top = [...rows].sort((a, b) => metricVal(b, metric) - metricVal(a, metric)).slice(0, 6);
    const max = Math.max(1, ...top.map((r) => metricVal(r, metric)));
    const rev = [...top].reverse();
    const colorAt = (i: number) => colorOf?.(rev[i].name);
    return {
      tooltip: {
        trigger: 'item' as const,
        appendToBody: true,
        confine: true,
        ...tooltipBase,
        formatter: (p: { name: string; value: number }) => {
          const r = top.find((x) => x.name === p.name);
          if (!r) return p.name;
          const primary = '<b>' + p.name + '</b><br>' + fmtCompact(metricVal(r, metric)) + (metric === 'tokens' ? ' tokens' : ' 次');
          const second = metric === 'tokens'
            ? '请求 ' + fmtCompact(r.requests) + ' 次'
            : 'tokens ' + fmtCompact(r.input_tokens) + ' / ' + fmtCompact(r.output_tokens);
          return primary + '<br>' + second;
        },
      },
      grid: { top: 6, bottom: 4, left: 8, right: 42, containLabel: true },
      xAxis: { type: 'value' as const, show: false, max },
      yAxis: {
        type: 'category' as const,
        data: rev.map((r) => r.name),
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#52525b', fontSize: 11, fontFamily: 'ui-monospace, monospace', width: 150, overflow: 'truncate' as const },
      },
      series: [
        {
          type: 'bar' as const,
          data: rev.map((r, i) => ({
            value: metricVal(r, metric),
            itemStyle: colorAt(i)
              ? { borderRadius: 5, color: colorAt(i) }
              : {
                  borderRadius: 5,
                  color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                    { offset: 0, color: '#818cf8' },
                    { offset: 1, color: '#4f46e5' },
                  ]),
                },
          })),
          barWidth: 12,
          emphasis: { itemStyle: { color: colorOf ? undefined : '#4338ca' } },
          label: { show: true, position: 'right' as const, color: '#71717a', fontSize: 10, fontFamily: 'ui-monospace, monospace', formatter: (p: { value: number }) => fmtCompact(p.value) },
        },
      ],
    };
  };

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

      <Card title="模型调用分布" actions={<MetricSeg value={distMetric} onChange={setDistMetric} />}>
        {donutOption ? (
          <div className="flex flex-col gap-4 lg:h-[260px] lg:flex-row lg:items-center lg:gap-6">
            <div className="relative h-[220px] w-full shrink-0 lg:h-full lg:w-[270px]">
              <EChart option={donutOption} className="h-full w-full" />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[22px] font-semibold tabular-nums leading-none tracking-tight text-zinc-900">
                  {donutCenter.v}
                  <span className="ml-0.5 text-[13px] font-medium text-zinc-400">{donutCenter.unit}</span>
                </span>
                <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-400">{distMetric === 'tokens' ? '总 Tokens' : '总请求'}</span>
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-col justify-center">
                <div className="flex items-center gap-2 border-b border-black/[0.06] px-1.5 pb-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-400">
                  <span className="w-2 shrink-0" />
                  <span className="min-w-0 flex-1">模型</span>
                  <span className="w-12 shrink-0 text-right">占比</span>
                  <span className="w-14 shrink-0 text-right">{distMetric === 'tokens' ? 'Tokens' : '请求'}</span>
                  <span className="hidden w-44 shrink-0 text-right sm:block">Tokens 入 / 出</span>
                </div>
                {dist.rows.map((r) => (
                  <div key={r.name} className="flex items-center gap-2 rounded-md px-1.5 py-[7px] transition-colors hover:bg-zinc-50" title={r.name}>
                    <span className="w-2 shrink-0">
                      <span className="block h-2 w-2 rounded-full" style={{ background: r.color }} />
                    </span>
                    <span className={'min-w-0 flex-1 truncate text-xs ' + (r.isOthers ? 'text-zinc-400' : 'text-zinc-700')}>{r.name}</span>
                    <span className="w-12 shrink-0 text-right text-[11.5px] tabular-nums text-zinc-400">{dist.grand > 0 && r.value > 0 ? ((r.value / dist.grand) * 100).toFixed(1) : '0.0'}%</span>
                    <span className="w-14 shrink-0 text-right text-[11.5px] tabular-nums text-zinc-600">{fmtCompact(r.value)}</span>
                    <span className="hidden w-44 shrink-0 text-right text-[11.5px] tabular-nums text-zinc-500 sm:block">{fmtCompact(r.tkIn)} / {fmtCompact(r.tkOut)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState text="无数据" />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="模型排行" actions={<MetricSeg value={rankMetric} onChange={setRankMetric} />}>
          {rankOption(stats?.by_model ?? [], rankMetric, (n) => modelColor.get(n)) ? <EChart option={rankOption(stats?.by_model ?? [], rankMetric, (n) => modelColor.get(n))!} className="h-[240px] w-full" /> : <EmptyState text="无数据" />}
        </Card>
        <Card title="渠道排行" actions={<MetricSeg value={rankMetric} onChange={setRankMetric} />}>
          {rankOption(stats?.by_channel ?? [], rankMetric) ? <EChart option={rankOption(stats?.by_channel ?? [], rankMetric)!} className="h-[240px] w-full" /> : <EmptyState text="无数据" />}
        </Card>
      </div>

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
