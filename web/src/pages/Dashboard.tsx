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

const RANGES: { key: string; label: string }[] = [
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
];

const C_INPUT = '#3b82f6';
const C_OUTPUT = '#10b981';
const C_BAR = '#c7d2fe';

function fmtBucketLabel(ts: number, hourly: boolean): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  const day = (d.getMonth() + 1) + '/' + p(d.getDate());
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

  // ---- trend chart option: gradient area (tokens) + bars (requests, right axis) ----
  const trendOption = useMemo(() => {
    if (!stats) return null;
    const labels = stats.trend.map((b) => fmtBucketLabel(b.bucket, hourly));
    const grad = (hex: string) => new echarts.graphic.LinearGradient(0, 0, 0, 1, [
      { offset: 0, color: hex + '59' },
      { offset: 1, color: hex + '0a' },
    ]);
    return {
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'cross' as const, crossStyle: { color: '#a1a1aa' }, label: { backgroundColor: '#3f3f46' } },
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#e4e4e7',
        textStyle: { color: '#18181b', fontSize: 11, fontFamily: 'ui-monospace, monospace' },
        extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,0.12); border-radius: 10px;',
      },
      legend: { data: ['输入 tokens', '输出 tokens', '请求次数'], top: 0, right: 0, textStyle: { color: '#71717a', fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
      grid: { top: 34, bottom: 26, left: 56, right: 52 },
      xAxis: {
        type: 'category' as const,
        data: labels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: '#e4e4e7' } },
        axisLabel: { color: '#a1a1aa', fontSize: 10, fontFamily: 'ui-monospace, monospace', interval: Math.ceil(labels.length / 8) - 1 },
        axisTick: { show: false },
      },
      yAxis: [
        { type: 'value' as const, name: 'tokens', nameTextStyle: { color: '#a1a1aa', fontSize: 10 }, splitLine: { lineStyle: { color: '#f4f4f5' } }, axisLabel: { color: '#a1a1aa', fontSize: 10, formatter: (v: number) => fmtCompact(v) } },
        { type: 'value' as const, name: '次数', nameTextStyle: { color: '#a1a1aa', fontSize: 10 }, splitLine: { show: false }, axisLabel: { color: '#a1a1aa', fontSize: 10 }, splitNumber: 3 },
      ],
      series: [
        {
          name: '请求次数', type: 'bar' as const, yAxisIndex: 1, data: stats.trend.map((b) => b.requests),
          itemStyle: { color: C_BAR, borderRadius: [3, 3, 0, 0] }, barWidth: '40%', z: 1,
        },
        {
          name: '输入 tokens', type: 'line' as const, smooth: true, symbol: 'none', z: 3,
          data: stats.trend.map((b) => b.input_tokens),
          lineStyle: { width: 2.5, color: C_INPUT }, itemStyle: { color: C_INPUT },
          areaStyle: { color: grad(C_INPUT) }, emphasis: { focus: 'series' as const },
        },
        {
          name: '输出 tokens', type: 'line' as const, smooth: true, symbol: 'none', z: 3,
          data: stats.trend.map((b) => b.output_tokens),
          lineStyle: { width: 2.5, color: C_OUTPUT }, itemStyle: { color: C_OUTPUT },
          areaStyle: { color: grad(C_OUTPUT) }, emphasis: { focus: 'series' as const },
        },
      ],
    };
  }, [stats, hourly]);

  // ---- model distribution donut ----
  const donutOption = useMemo(() => {
    if (!stats || stats.by_model.length === 0) return null;
    const top = stats.by_model.slice(0, 7);
    const restReq = stats.by_model.slice(7).reduce((s, r) => s + r.requests, 0);
    const data = top.map((r) => ({ name: r.name, value: r.requests }));
    if (restReq > 0) data.push({ name: '其他', value: restReq });
    const palette = ['#3b82f6', '#10b981', '#f59e0b', '#06b6d4', '#8b5cf6', '#ef4444', '#64748b', '#d4d4d8'];
    return {
      tooltip: {
        trigger: 'item' as const, confine: true,
        backgroundColor: 'rgba(255,255,255,0.96)', borderColor: '#e4e4e7',
        textStyle: { color: '#18181b', fontSize: 11, fontFamily: 'ui-monospace, monospace' },
        extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,0.12); border-radius: 10px;',
        formatter: (p: { name: string; value: number; percent: number }) => '<b>' + p.name + '</b><br>' + fmtCompact(p.value) + ' 次 · ' + p.percent + '%',
      },
      legend: { bottom: 0, type: 'scroll' as const, textStyle: { color: '#71717a', fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
      series: [{
        type: 'pie' as const, radius: ['52%', '74%'], center: ['50%', '44%'],
        itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
        label: { show: false }, emphasis: { scale: true, scaleSize: 6, focus: 'self' as const },
        data: data.map((d, i) => ({ ...d, itemStyle: { color: palette[i % palette.length] } })),
      }],
    };
  }, [stats]);

  // ---- ranking horizontal bars ----
  const rankOption = (rows: { name: string; requests: number; input_tokens: number; output_tokens: number }[]) => {
    if (rows.length === 0) return null;
    const top = rows.slice(0, 6);
    const max = Math.max(1, ...top.map((r) => r.requests));
    return {
      tooltip: {
        trigger: 'item' as const, confine: true,
        backgroundColor: 'rgba(255,255,255,0.96)', borderColor: '#e4e4e7',
        textStyle: { color: '#18181b', fontSize: 11, fontFamily: 'ui-monospace, monospace' },
        extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,0.12); border-radius: 10px;',
        formatter: (p: { name: string; value: number }) => {
          const r = top.find((x) => x.name === p.name);
          if (!r) return p.name;
          return '<b>' + p.name + '</b><br>' + fmtCompact(r.requests) + ' 次 · tk ' + fmtCompact(r.input_tokens) + ' / ' + fmtCompact(r.output_tokens);
        },
      },
      grid: { top: 6, bottom: 4, left: 8, right: 40, containLabel: true },
      xAxis: { type: 'value' as const, show: false, max },
      yAxis: {
        type: 'category' as const, data: top.map((r) => r.name).reverse(),
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#52525b', fontSize: 10, fontFamily: 'ui-monospace, monospace', width: 120, overflow: 'truncate' as const },
      },
      series: [{
        type: 'bar' as const, data: top.map((r) => r.requests).reverse(), barWidth: 10,
        itemStyle: { borderRadius: 5, color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: '#818cf8' }, { offset: 1, color: '#4f46e5' }]) },
        emphasis: { itemStyle: { color: '#4338ca' } },
        label: { show: true, position: 'right' as const, color: '#71717a', fontSize: 10, fontFamily: 'ui-monospace, monospace', formatter: (p: { value: number }) => fmtCompact(p.value) },
      }],
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="请求次数" value={fmtCompact(t?.requests ?? 0)} delta={delta(t?.requests ?? 0, pt?.requests)} sub={'成功率 ' + (t?.success_rate ?? 0) + '% · 失败 ' + (t?.fail ?? 0)} dot="bg-indigo-500" />
        <KpiCard label="Tokens 输入" value={fmtCompact(t?.input_tokens ?? 0)} delta={delta(t?.input_tokens ?? 0, pt?.input_tokens)} sub={'缓存 R ' + fmtCompact(t?.cache_read ?? 0) + ' · W ' + fmtCompact(t?.cache_creation ?? 0)} dot="bg-blue-500" />
        <KpiCard label="Tokens 输出" value={fmtCompact(t?.output_tokens ?? 0)} delta={delta(t?.output_tokens ?? 0, pt?.output_tokens)} sub={'缓存命中 ' + (hitRate != null ? hitRate + '%' : '—')} dot="bg-emerald-500" />
        <KpiCard label="RPM / TPM" value={String(stats?.rpm ?? 0) + ' / ' + fmtCompact(stats?.tpm ?? 0)} sub="近 5 分钟均值" dot="bg-amber-500" />
        <KpiCard label="平均耗时" value={fmtLatency(t?.avg_ms ?? 0)} sub={'范围：' + (RANGES.find((r) => r.key === range)?.label ?? range)} dot="bg-zinc-400" />
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
          <EChart option={trendOption!} className="h-[260px] w-full" />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card title="模型调用分布">
          {donutOption ? <EChart option={donutOption} className="h-[220px] w-full" /> : <EmptyState text="无数据" />}
        </Card>
        <Card title="模型排行">
          {rankOption(stats?.by_model ?? []) ? <EChart option={rankOption(stats?.by_model ?? [])!} className="h-[220px] w-full" /> : <EmptyState text="无数据" />}
        </Card>
        <Card title="渠道排行">
          {rankOption(stats?.by_channel ?? []) ? <EChart option={rankOption(stats?.by_channel ?? [])!} className="h-[220px] w-full" /> : <EmptyState text="无数据" />}
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
