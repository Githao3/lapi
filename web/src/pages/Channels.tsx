import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Channel, AuthMode } from '../types';
import { Card, Button, Badge, Field, Select, Modal, Note, EmptyState, PageHeader, inputCls } from '../components/ui';

const DRAFT_KEY = 'lapi-draft';

function emptyChannel(): Channel {
  return {
    name: '',
    protocol: 'anthropic',
    openai_endpoint: 'chat',
    base_url: '',
    api_key: '',
    auth_mode: 'bearer',
    user_agent_override: '',
    header_overrides: {},
    model_mapping: {},
    models: '',
    weight: 0,
    enabled: true,
    notes: '',
  };
}

function TagEditor(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const tags = props.value.split(',').map((s) => s.trim()).filter(Boolean);
  const addTag = (raw: string) => {
    const pieces = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!pieces.length) return;
    const merged = [...new Set([...tags, ...pieces])];
    props.onChange(merged.join(','));
  };
  const removeTag = (t: string) => {
    props.onChange(tags.filter((x) => x !== t).join(','));
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md border border-black/[0.06] bg-zinc-100 px-2 py-0.5 font-mono text-xs text-zinc-700">
            {t}
            <button type="button" className="text-zinc-400 transition-colors hover:text-rose-600" onClick={() => removeTag(t)}>×</button>
          </span>
        ))}
        {tags.length === 0 && <span className="text-xs text-zinc-400">（空；填 * 可全收）</span>}
      </div>
      <input
        className={inputCls}
        placeholder={props.placeholder ?? '输入后回车或逗号添加'}
        onKeyDown={(e) => {
          const el = e.target as HTMLInputElement;
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTag(el.value);
            el.value = '';
          } else if (e.key === 'Backspace' && el.value === '' && tags.length) {
            props.onChange(tags.slice(0, -1).join(','));
          }
        }}
      />
    </div>
  );
}

function KeyValueEditor(props: { value: Record<string, string>; onChange: (o: Record<string, string>) => void; keyPlaceholder: string; valuePlaceholder: string }) {
  // Local mutable rows: so a freshly added empty row shows immediately,
  // while outbound values still drop entries whose key is still empty.
  const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries(props.value));
  useEffect(() => {
    setRows(Object.entries(props.value));
  }, [props.value]);
  const emit = (next: Array<[string, string]>) => {
    const o: Record<string, string> = {};
    for (const [k, v] of next) {
      if (k.trim()) o[k.trim()] = v;
    }
    props.onChange(o);
  };
  const setRow = (i: number, k: string, v: string) => {
    const n = rows.slice();
    n[i] = [k, v];
    setRows(n);
    emit(n);
  };
  const removeRow = (i: number) => {
    const n = rows.filter((_, j) => j !== i);
    setRows(n);
    emit(n);
  };
  const addRow = () => {
    const next = rows.slice();
    next.push(["", ""]);
    setRows(next);
  };
  return (
    <div className="space-y-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-2">
          <input className={inputCls + ' min-w-0 flex-1 font-mono'} value={k} placeholder={props.keyPlaceholder} onChange={(e) => setRow(i, e.target.value, v)} />
          <input className={inputCls + ' min-w-0 flex-1 font-mono'} value={v} placeholder={props.valuePlaceholder} onChange={(e) => setRow(i, k, e.target.value)} />
          <Button variant="subtle" onClick={() => removeRow(i)}>×</Button>
        </div>
      ))}
      <Button variant="ghost" onClick={addRow}>+ 添加一行</Button>
    </div>
  );
}

export default function Channels() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [uaPresets, setUaPresets] = useState<string[]>([]);
  const [fetched, setFetched] = useState<{ models: string[]; error: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => api.listChannels().then(setChannels).catch(() => {});
  useEffect(() => {
    reload();
    api.listPresets().then((p) => setUaPresets(p.uaPresets ?? [])).catch(() => {});
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      try {
        const d = JSON.parse(raw);
        setEditing({ ...emptyChannel(), ...(d.draft ?? {}) });
        localStorage.removeItem(DRAFT_KEY);
        window.setTimeout(() => { document.getElementById('ch-editor')?.scrollIntoView({ behavior: 'smooth' }); }, 50);
      } catch {}
    }
  }, []);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      if (editing.id != null) {
        await api.updateChannel(editing.id, editing);
      } else {
        await api.createChannel(editing);
      }
      setEditing(null);
      await reload();
    } catch (e) {
      alert('保存失败：' + String(e));
    } finally {
      setBusy(false);
    }
  };

  const runFetch = async () => {
    setBusy(true);
    try {
      const r = editing?.id != null
        ? await api.fetchModels(editing.id)
        : await api.fetchModelsDraft(editing as unknown as Record<string, unknown>);
      if (r.error) {
        setFetched({ models: [], error: r.error || '拉取失败。' });
      } else {
        setFetched({ models: r.models ?? [], error: '' });
      }
    } catch (e) {
      setFetched({ models: [], error: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: Channel) => {
    if (!confirm('删除渠道「' + c.name + '」？')) return;
    try {
      await api.deleteChannel(c.id!);
      await reload();
    } catch (e) {
      alert('删除失败：' + String(e));
    }
  };

  const toggleEnabled = async (c: Channel) => {
    try {
      await api.toggleChannel(c.id!);
      await reload();
    } catch (e) {
      alert('切换失败：' + String(e));
    }
  };

  const set = (patch: Partial<Channel>) => setEditing((e) => (e ? { ...e, ...patch } : e));

  const fmt = !editing ? 'messages' : (editing.protocol === 'anthropic' ? 'messages' : (editing.openai_endpoint === 'responses' ? 'responses' : 'chat'));
  const setFormat = (v: string) => {
    if (v === 'messages') set({ protocol: 'anthropic', openai_endpoint: 'chat' });
    else if (v === 'responses') set({ protocol: 'openai', openai_endpoint: 'responses' });
    else set({ protocol: 'openai', openai_endpoint: 'chat' });
  };
  const currentModels = editing ? editing.models.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const toggleModel = (m: string) => {
    const next = currentModels.includes(m) ? currentModels.filter((x) => x !== m) : [...currentModels, m];
    set({ models: next.join(',') });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="渠道"
        desc="每个渠道声明一个上游格式；客户端三条端点任达，异格式自动转换"
        actions={<Button variant="primary" onClick={() => { setEditing(emptyChannel()); setFetched(null); }}>+ 新建渠道</Button>}
      />
      <Card title={'渠道（' + channels.length + '）'}>
        {channels.length === 0 ? (
          <EmptyState text="还没有渠道。去「预设库」一键套用，或点右上角新建。" />
        ) : (
          <div className="space-y-2">
            {channels.map((c) => (
              <div key={c.id} className="group flex items-center gap-3 rounded-xl border border-black/[0.06] bg-white px-4 py-3 shadow-xs transition-all hover:border-zinc-300 hover:shadow-md">
                <Badge tone={c.enabled ? 'green' : 'neutral'}>
                  {c.protocol === 'anthropic' ? 'messages' : (c.openai_endpoint === 'responses' ? 'responses' : 'chat/completions')}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-zinc-900">{c.name}</span>
                    {!c.enabled && <span className="text-xs text-zinc-400">已停用</span>}
                  </div>
                  <div className="truncate font-mono text-xs text-zinc-500">{c.base_url}</div>
                </div>
                <div className="hidden max-w-xs truncate font-mono text-xs text-zinc-500 sm:block">{c.models}</div>
                <button
                  onClick={() => toggleEnabled(c)}
                  title="点击启用/停用此渠道"
                  className={'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ' + (c.enabled ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-400' : 'border-zinc-200 bg-zinc-50 text-zinc-400 hover:border-zinc-400')}
                >
                  <span className={'h-1.5 w-1.5 rounded-full ' + (c.enabled ? 'bg-emerald-500' : 'bg-zinc-300')} />
                  {c.enabled ? '启用中' : '已停用'}
                </button>
                <Button variant="subtle" onClick={() => { setEditing({ ...c }); setFetched(null); }}>编辑</Button>
                <Button variant="danger" onClick={() => remove(c)}>删除</Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.id != null ? '编辑渠道' : '新建渠道'}
          onClose={() => setEditing(null)}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
              <Button variant="primary" onClick={save} disabled={busy}>保存</Button>
            </>
          }
        >
          <div id="ch-editor" className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
            <Field label="名称">
              <input className={inputCls} value={editing.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="上游格式" hint="本渠道声明上游格式（三选一）。客户端走任一条本地端点都可：同格式直发直回；异格式自动转换——文本、工具调用、图片均支持（含流式增量与 stop/usage 映射），个别长尾块会报 400 并说明原因。">
              <Select
                value={fmt}
                onChange={setFormat}
                options={[
                  { value: 'messages', label: 'messages（Anthropic /v1/messages）' },
                  { value: 'chat', label: 'chat/completions（OpenAI /v1/chat/completions）' },
                  { value: 'responses', label: 'responses（OpenAI /v1/responses）' },
                ]}
              />
            </Field>
            <div className="md:col-span-2">
              <Field label="上游 Base URL" hint="例如 https://api.anthropic.com 或 https://api.deepseek.com/v1">
                <input className={inputCls} value={editing.base_url} onChange={(e) => set({ base_url: e.target.value })} placeholder="https://…" />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="API Key" hint="多 key 用换行分隔，轮到使用。">
                <textarea className={inputCls + ' h-20 font-mono'} value={editing.api_key} onChange={(e) => set({ api_key: e.target.value })} />
              </Field>
            </div>
            <Field label="认证方式">
              <Select
                value={editing.auth_mode}
                onChange={(v) => set({ auth_mode: v as AuthMode })}
                options={[
                  { value: 'bearer', label: 'bearer（Authorization: Bearer <key>）' },
                  { value: 'x-api-key', label: 'x-api-key（Anthropic 风格）' },
                  { value: 'x-goog-api-key', label: 'x-goog-api-key（Gemini 风格）' },
                  { value: 'none', label: 'none（无认证头注入）' },
                ]}
              />
            </Field>
            <Field label="User-Agent 覆盖">
              <input className={inputCls} value={editing.user_agent_override} onChange={(e) => set({ user_agent_override: e.target.value })} placeholder="留空则透传客户端值" />
            </Field>
            <div className="md:col-span-2">
              <Field label="UA 伪装预设" hint="内置 cc-switch 预设 + 捕获页保存的 agent UA；是否使用由你显式选择。">
                <div className="flex gap-2">
                  <select
                    className={inputCls}
                    value=""
                    onChange={(e) => { if (e.target.value) set({ user_agent_override: e.target.value }); }}
                  >
                    <option value="">选择预设…</option>
                    {uaPresets.map((u) => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                  {editing.user_agent_override && <Button variant="subtle" onClick={() => set({ user_agent_override: '' })}>清除</Button>}
                </div>
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="模型列表" hint="填 * 表示全收；支持 sonnet* 前缀通配。">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-zinc-500">点「拉取模型」从上游拉列表，点选即填入。</span>
                  <Button variant="subtle" onClick={runFetch} disabled={busy}>{busy ? '拉取中…' : '拉取模型'}</Button>
                </div>
                <TagEditor value={editing.models} onChange={(v) => set({ models: v })} placeholder="claude-sonnet-4-5 或 *，回车/逗号添加" />
                {fetched && fetched.error && (
                  <div className="mt-2 rounded-md border border-rose-200 px-3 py-2 text-xs text-rose-700">{fetched.error}</div>
                )}
                {fetched && !fetched.error && fetched.models.length > 0 && (
                  <div className="mt-2 rounded-xl border border-black/[0.06] bg-zinc-50/70 p-3">
                    <div className="mb-1.5 text-xs text-zinc-500">上游模型 {fetched.models.length} 个，点选填入 / 再点移除：</div>
                    <div className="flex max-h-44 flex-wrap gap-1 overflow-auto">
                      {fetched.models.map((m) => {
                        const on = currentModels.includes(m);
                        return (
                          <button
                            key={m}
                            type="button"
                            onClick={() => toggleModel(m)}
                            className={'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs ' + (on ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-zinc-300 bg-zinc-50 text-zinc-700 hover:border-emerald-400')}
                          >
                            {on ? '✓ ' : '+ '}{m}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-2">
                      <Button variant="subtle" onClick={() => set({ models: fetched.models.join(',') })}>全部填入（{fetched.models.length} 个）</Button>
                    </div>
                  </div>
                )}
                {fetched && !fetched.error && fetched.models.length === 0 && (
                  <div className="mt-2 rounded-md border border-zinc-200 px-3 py-2 text-xs text-zinc-500">拉取成功，但上游未返回模型列表。</div>
                )}
              </Field>
            </div>
            <Field label="权重（仅同分候选内随机加权）">
              <input className={inputCls} type="number" min="0" max="100" value={String(editing.weight)} onChange={(e) => set({ weight: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="启用">
              <label className="flex items-center gap-2 py-2 text-sm text-zinc-700">
                <input type="checkbox" checked={editing.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                此渠道参与路由
              </label>
            </Field>
            <div className="md:col-span-2">
              <Field label="额外头覆盖" hint="每行一个头；受保护名单（host、认证类、cookie、content-length、accept-encoding 等）不可覆盖。">
                <KeyValueEditor value={editing.header_overrides} onChange={(o) => set({ header_overrides: o })} keyPlaceholder="头名称" valuePlaceholder="值" />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="模型映射" hint="客户端请求用左侧名，转发前改写为右侧上游名；每行一组。">
                <KeyValueEditor value={editing.model_mapping} onChange={(o) => set({ model_mapping: o })} keyPlaceholder="客户端模型名" valuePlaceholder="上游模型名" />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="备注">
                <input className={inputCls} value={editing.notes} onChange={(e) => set({ notes: e.target.value })} />
              </Field>
            </div>
          </div>
          <Note tone="warn">
            诚实边界：仅改写 HTTP 层请求头；若上游按 TLS 指纹风控（如 claude.ai 官方），换 UA 无效——那是 v2 的事。
          </Note>
        </Modal>
      )}
    </div>
  );
}