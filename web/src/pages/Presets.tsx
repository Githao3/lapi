import { useEffect, useMemo, useState } from 'react';
import { api, fmtTs } from '../api';
import type { ClientPreset, ClientPresetHeader, PresetEntry, PresetsPayload } from '../types';
import { Card, Button, Badge, EmptyState, Note, PageHeader, inputCls } from '../components/ui';
import { ClientPresetEditor } from '../components/ClientPresetEditor';

const DRAFT_KEY = 'lapi-draft';

type Tab = 'featured' | 'all' | 'openai' | 'unsupported';

export default function Presets() {
  const [data, setData] = useState<PresetsPayload | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('featured');
  const [copied, setCopied] = useState('');
  const [clientPresets, setClientPresets] = useState<ClientPreset[]>([]);
  const [editing, setEditing] = useState<{ isNew: boolean; name: string; headers: ClientPresetHeader[] } | null>(null);

  const loadClientPresets = () => {
    api.listClientPresets().then(setClientPresets).catch(() => {});
  };

  const load = () => {
    setErr('');
    api.listPresets().then(setData).catch((e) => setErr(String(e)));
    loadClientPresets();
  };
  useEffect(() => { load(); }, []);

  const removeUa = async (u: string) => {
    try {
      await api.deleteUaPreset(u);
      load();
    } catch (e) { setErr(String(e)); }
  };

  const removeClientPreset = async (name: string) => {
    if (!window.confirm(`删除客户端预设「${name}」？引用它的渠道将回落为不伪装。`)) return;
    try {
      await api.deleteClientPreset(name);
      loadClientPresets();
    } catch (e) { setErr(String(e)); }
  };

  const COLLAPSE_N = 12;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [tab, q]);

  const list = useMemo(() => {
    if (!data) return [];
    let base: PresetEntry[] = [];
    if (tab === 'featured') base = data.featured ?? [];
    if (tab === 'all') base = [...(data.anthropic ?? []), ...(data.openai ?? [])];
    if (tab === 'openai') base = data.openai ?? [];
    if (tab === 'unsupported') return (data.unsupported ?? []) as PresetEntry[];
    const s = q.trim().toLowerCase();
    return s ? base.filter((p) => (p.name ?? '').toLowerCase().includes(s) || (p.baseUrl ?? '').toLowerCase().includes(s)) : base;
  }, [data, q, tab]);

  const searching = q.trim().length > 0;
  const visible = searching || expanded ? list : list.slice(0, COLLAPSE_N);

  const apply = (p: PresetEntry) => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: p.name, draft: {
      name: p.name,
      protocol: p.protocol ?? 'anthropic',
      base_url: p.baseUrl ?? '',
      auth_mode: p.authMode ?? 'bearer',
      models: (p.defaultModels ?? []).join(','),
      notes: p.verified ? '来自预设（已核实）：' + p.name : '来自预设：' + p.name,
    } }));
    window.dispatchEvent(new CustomEvent('lapi-goto', { detail: 'channels' }));
  };

  const copyUa = (u: string) => {
    navigator.clipboard.writeText(u).then(() => { setCopied(u); setTimeout(() => setCopied(''), 1200); }).catch(() => {});
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'featured', label: '精选' },
    { key: 'all', label: '全部' },
    { key: 'openai', label: 'OpenAI 协议' },
    { key: 'unsupported', label: '暂不支持' },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="预设库"
        desc="数据提取自开源 cc-switch（MIT）· 截至 2026-08，上游地址可能失效"
        actions={<Button variant="subtle" onClick={() => { localStorage.removeItem(DRAFT_KEY); window.dispatchEvent(new CustomEvent('lapi-goto', { detail: 'channels' })); }}>自定义渠道</Button>}
      />
      <Card title="渠道预设">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input className={inputCls + ' max-w-xs'} placeholder="搜索名称或地址…" value={q} onChange={(e) => setQ(e.target.value)} />
          {tabs.map((t) => (
            <Button key={t.key} variant={tab === t.key ? 'primary' : 'ghost'} onClick={() => setTab(t.key)}>{t.label}</Button>
          ))}
        </div>
        {err ? (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            预设库加载失败：{err}
            <Button variant="subtle" className="ml-2" onClick={load}>重试</Button>
          </div>
        ) : !data ? (
          <div className="mb-3 text-xs text-zinc-400">加载中…</div>
        ) : list.length === 0 ? (
          <EmptyState text="没有匹配的预设。" />
        ) : (<>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((p) => (
              <div key={p.name} className="group flex flex-col rounded-xl border border-black/[0.06] bg-white p-4 shadow-xs transition-all hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium leading-5 text-zinc-900">{p.name}</span>
                  {p.verified ? <Badge tone="green">已核实</Badge> : <Badge tone="neutral">未逐一核实</Badge>}
                </div>
                <div className="mt-1 truncate font-mono text-xs text-zinc-500">{p.baseUrl}</div>
                {(p.defaultModels ?? []).length > 0 && (
                  <div className="mt-2 line-clamp-2 text-xs leading-relaxed text-zinc-400">
                    默认模型：{(p.defaultModels ?? []).join(', ')}
                  </div>
                )}
                <div className="mt-3.5 flex items-center justify-between border-t border-black/[0.05] pt-3">
                  <Badge>{p.authMode}</Badge>
                  {p.websiteUrl && (
                    <a href={p.websiteUrl} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 transition-colors hover:text-indigo-500">官网 ↗</a>
                  )}
                  <Button variant="primary" onClick={() => apply(p)}>使用此预设</Button>
                </div>
              </div>
            ))}
          </div>
          {list.length > COLLAPSE_N && !searching && (
            <div className="mt-3 text-center">
              <Button variant="subtle" onClick={() => setExpanded(!expanded)}>
                {expanded ? '收起' : '展开其余 ' + (list.length - COLLAPSE_N) + ' 个预设（共 ' + list.length + ' 个）'}
              </Button>
            </div>
          )}
        </>)}
      </Card>

      <Card title="客户端伪装档案（整组请求头）">
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-zinc-500">
            一条捕获 = 一个客户端的完整身份：渠道引用档案后，出站请求按 fixed 覆盖 / fill 补位 / drop 剔除套用整组头，比只伪装 UA 完整得多。
            在「捕获」页打开任意记录点「存为客户端预设」即可新建。与渠道的 UA 伪装二选一，档案优先。
          </p>
          {clientPresets.length === 0 ? (
            <EmptyState text="还没有客户端档案——去捕获页从真实请求生成一条。" />
          ) : (
            <div className="overflow-hidden rounded-xl ring-1 ring-black/[0.06]">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-400">
                    <th className="px-3 py-2 font-medium">名称</th>
                    <th className="px-3 py-2 font-medium">头数量</th>
                    <th className="px-3 py-2 font-medium">创建时间</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {clientPresets.map((p) => (
                    <tr key={p.name} className="border-b border-black/[0.04] last:border-b-0">
                      <td className="px-3 py-2 font-medium text-zinc-800">{p.name}</td>
                      <td className="px-3 py-2 tabular-nums text-zinc-500">{p.headers.length}</td>
                      <td className="px-3 py-2 text-zinc-500">{fmtTs(p.created_at)}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-2">
                          <Button variant="subtle" onClick={() => setEditing({ isNew: false, name: p.name, headers: p.headers })}>编辑</Button>
                          <Button variant="subtle" onClick={() => removeClientPreset(p.name)}>删除</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="subtle" onClick={() => setEditing({ isNew: true, name: '', headers: [] })}>+ 新建空档案</Button>
          </div>
        </div>
      </Card>

      <Card title="User-Agent 伪装预设（点击复制；捕获页可保存新的）">
        <div className="flex flex-wrap gap-2">
          {(data?.uaPresets ?? []).map((u) => {
            const custom = (data?.uaPresetsCustom ?? []).includes(u);
            return (
              <span
                key={u}
                className="group relative inline-flex items-center rounded-lg border border-black/[0.07] bg-zinc-50 transition-colors hover:border-indigo-400 hover:bg-white"
              >
                <button
                  onClick={() => copyUa(u)}
                  className="px-3 py-1.5 font-mono text-xs text-zinc-600 transition-colors hover:text-indigo-600"
                >
                  {u}
                  {copied === u && ' ✓'}
                </button>
                {custom && (
                  <button
                    title="删除此自定义预设"
                    onClick={() => removeUa(u)}
                    className="border-l border-black/[0.06] px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:text-rose-600"
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
      </Card>

      <Note tone="info">
        「使用此预设」会把渠道草稿带到「渠道」页面的编辑弹窗里（预填后仍需保存），然后你补上自己的 API key 即可。「自定义渠道」直接打开空表单。
        同一条目若出现在精选层，是人工核对过的（打过快的）；全部层为原样搬运，未逐一核实—保存后在渠道表单点「拉取模型」即可核对连通并顺带填好模型列表。
      </Note>
      {editing && (
        <ClientPresetEditor
          isNew={editing.isNew}
          initialName={editing.name}
          initialHeaders={editing.headers}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadClientPresets();
          }}
        />
      )}
    </div>
  );
}