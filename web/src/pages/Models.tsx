import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ModelsCatalogEntry } from '../types';
import { Card, EmptyState, Badge, PageHeader, inputCls } from '../components/ui';

export default function Models() {
  const [items, setItems] = useState<ModelsCatalogEntry[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.getModelsCatalog().then(setItems).catch((e) => setErr(String(e)));
  }, []);

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((e) => e.model.toLowerCase().includes(s) || e.channels.some((c) => c.name.toLowerCase().includes(s))) : items;
  }, [items, q]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="模型"
        desc="各渠道声明的模型全集（含映射别名）——对外 /v1/models 广告的就是这份清单"
      />
      <Card
        title={'模型清单（' + items.length + '）'}
        actions={<input className={inputCls + ' max-w-xs'} placeholder="搜索模型或渠道…" value={q} onChange={(e) => setQ(e.target.value)} />}
      >
        {err ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>
        ) : items.length === 0 ? (
          <EmptyState text="还没有任何模型。去「渠道」编辑渠道的模型列表，或用「拉取模型」选填。" />
        ) : visible.length === 0 ? (
          <EmptyState text="没有匹配的模型。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-black/[0.06] text-[11px] uppercase tracking-wider text-zinc-400">
                  <th className="pb-2.5 pr-3 font-medium">模型</th>
                  <th className="pb-2.5 font-medium">声明渠道</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((e) => (
                  <tr key={e.model} className="border-t border-black/[0.05] transition-colors hover:bg-zinc-50/80">
                    <td className="py-2.5 pr-3 font-mono text-xs text-zinc-800">{e.model}</td>
                    <td className="py-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        {e.channels.map((c, i) => (
                          <Badge key={i} tone={c.enabled ? 'neutral' : 'neutral'}>
                            <span className={c.enabled ? '' : 'text-zinc-400 line-through'}>
                              {c.name}
                              {c.via === 'alias' && <span className="ml-1 text-[10px] text-indigo-500">别名</span>}
                              {!c.enabled && <span className="ml-1 text-[10px]">停用</span>}
                            </span>
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
