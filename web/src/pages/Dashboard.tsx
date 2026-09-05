import { useEffect, useState } from 'react';
import { api, fmtTs, fmtUptime } from '../api';
import type { SystemInfo, SettingsPayload, LogEntry } from '../types';
import { Card, Badge, EmptyState, Button, PageHeader } from '../components/ui';

export default function Dashboard() {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [cfg, setCfg] = useState<SettingsPayload | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stamp, setStamp] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getSystem(), api.getConfig(), api.listLogs(5)])
      .then(([s, c, l]) => {
        if (!alive) return;
        setSys(s);
        setCfg(c);
        setLogs(l);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [stamp]);

  const mode = sys?.mode ?? 'relay';
 return (
    <div className="space-y-5">
      <PageHeader
        title="概览"
        desc="网关运行状态与最近请求"
        actions={<Button variant="subtle" onClick={() => setStamp(Date.now())}>刷新</Button>}
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