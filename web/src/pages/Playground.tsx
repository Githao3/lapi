import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ModelsCatalogEntry } from '../types';
import { Button, Card, Note, PageHeader, Select, inputCls } from '../components/ui';

type ChatRole = 'user' | 'assistant' | 'error';
interface ChatItem {
  role: ChatRole;
  content: string;
}

const STORE_KEY = 'lapi_playground_v1';

function loadStore(): Partial<{ items: ChatItem[]; model: string; system: string; temperature: string; maxTokens: string }> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// A converted reply may carry content as a string or as a list of parts.
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('');
  }
  return '';
}

export default function Playground() {
  const saved = useRef(loadStore()).current;
  const [models, setModels] = useState<ModelsCatalogEntry[]>([]);
  const [model, setModel] = useState(saved.model ?? '');
  const [system, setSystem] = useState(saved.system ?? '');
  const [temperature, setTemperature] = useState(saved.temperature ?? '0.7');
  const [maxTokens, setMaxTokens] = useState(saved.maxTokens ?? '');
  const [items, setItems] = useState<ChatItem[]>(Array.isArray(saved.items) ? saved.items : []);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api
      .getModelsCatalog()
      .then((list) => {
        setModels(list);
        setModel((cur) => cur || (list[0]?.model ?? ''));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ items, model, system, temperature, maxTokens }));
    } catch {
      /* 存储不可用时仅在刷新后丢对话 */
    }
  }, [items, model, system, temperature, maxTokens]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const setLast = (content: string) =>
    setItems((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice();
      next[next.length - 1] = { ...next[next.length - 1], content };
      return next;
    });

  const noteLast = (note: string) =>
    setItems((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last.role !== 'assistant') return prev;
      next[next.length - 1] = { ...last, content: (last.content ? last.content + '\n\n' : '') + note };
      return next;
    });

  const send = async () => {
    const text = input.trim();
    if (!text || streaming || !model) return;
    const history: ChatItem[] = [...items.filter((m) => m.role !== 'error'), { role: 'user', content: text }];
    setItems([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;

    const wire = [
      ...(system.trim() ? [{ role: 'system', content: system.trim() }] : []),
      ...history.map((m) => ({ role: m.role === 'error' ? 'user' : m.role, content: m.content })),
    ];
    const body: Record<string, unknown> = { model, messages: wire, stream: true };
    const t = Number(temperature);
    if (temperature.trim() !== '' && Number.isFinite(t)) body.temperature = t;
    const mt = Number(maxTokens);
    if (maxTokens.trim() !== '' && Number.isFinite(mt)) body.max_tokens = mt;

    try {
      const res = await api.playgroundChat(body, ac.signal);
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const j = await res.json();
          if (typeof j?.error?.message === 'string') msg = j.error.message;
          else if (typeof j?.error === 'string') msg = j.error;
        } catch {
          /* 非 JSON 错误体：保留状态码文案 */
        }
        throw new Error(msg);
      }
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/event-stream')) {
        if (!res.body) throw new Error('响应没有内容');
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let acc = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              const delta = j?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta) {
                acc += delta;
                setLast(acc);
              }
            } catch {
              /* 流里偶发的坏块直接跳过 */
            }
          }
        }
        if (!acc) setLast('（空响应——检查所选模型的渠道是否可用）');
      } else {
        const j = await res.json();
        const text2 = contentToText(j?.choices?.[0]?.message?.content);
        setLast(text2 || '（空响应——检查所选模型的渠道是否可用）');
      }
    } catch (e) {
      const err = e as Error;
      if (err?.name === 'AbortError') {
        noteLast('⏹ 已停止');
      } else {
        const msg = String(err?.message ?? e);
        setItems((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && !last.content) next.pop();
          next.push({ role: 'error', content: msg });
          return next;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const clear = () => {
    if (streaming) abortRef.current?.abort();
    setItems([]);
  };

  const current = models.find((m) => m.model === model);
  const viaChannels = (current?.channels ?? []).map((c) => c.name);

  return (
    <div className="space-y-5">
      <PageHeader title="测试场" desc="选一个已配置的模型直接对话——走完整转发管道，日志与用量照常记录" />

      <Card title="参数">
        <div className="grid grid-cols-1 gap-x-5 md:grid-cols-3">
          <div className="mb-4 md:col-span-3">
            <div className="mb-1.5 block text-xs font-medium text-zinc-600">系统提示词（可选）</div>
            <textarea
              className={inputCls + ' min-h-[56px] resize-y'}
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              placeholder="例如：你是一个简洁的技术助手，回答尽量短。"
            />
          </div>
          <div className="mb-1 md:col-span-3">
            <div className="mb-1.5 block text-xs font-medium text-zinc-600">模型</div>
            {models.length ? (
              <Select
                value={model}
                onChange={setModel}
                options={models.map((m) => ({ value: m.model, label: m.model + (m.channels.length ? `（${m.channels.length} 个渠道可路由）` : '') }))}
              />
            ) : (
              <Note tone="warn">还没有可路由的模型——先到「渠道」页配置渠道并声明模型，再回来刷新。</Note>
            )}
            {viaChannels.length > 0 && (
              <div className="mt-1.5 text-xs text-zinc-400">命中渠道：{viaChannels.join('、')}</div>
            )}
          </div>
          <div className="mb-1">
            <div className="mb-1.5 block text-xs font-medium text-zinc-600">温度 temperature</div>
            <input className={inputCls} value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="0.7" />
          </div>
          <div className="mb-1">
            <div className="mb-1.5 block text-xs font-medium text-zinc-600">最大 tokens（可选）</div>
            <input className={inputCls} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="留空 = 不限制" />
          </div>
        </div>
      </Card>

      <Card
        title="对话"
        actions={
          <Button variant="subtle" onClick={clear} disabled={!items.length}>
            清空对话
          </Button>
        }
      >
        <div ref={scrollRef} className="max-h-[52vh] min-h-[220px] space-y-3 overflow-y-auto rounded-xl bg-zinc-50/80 p-4 ring-1 ring-black/[0.05]">
          {items.length === 0 && (
            <div className="flex h-[180px] flex-col items-center justify-center gap-2 text-center">
              <div className="text-sm text-zinc-400">选好模型，随便问点什么</div>
              <div className="text-xs text-zinc-300">Enter 发送 · Shift+Enter 换行 · 回答可随时停止</div>
            </div>
          )}
          {items.map((m, i) => {
            const isLast = i === items.length - 1;
            const pending = isLast && streaming && m.role === 'assistant' && !m.content;
            const tone =
              m.role === 'user'
                ? 'ml-auto max-w-[85%] bg-zinc-900 text-white'
                : m.role === 'error'
                  ? 'mr-auto max-w-[92%] border border-rose-200 bg-rose-50 text-rose-900'
                  : 'mr-auto max-w-[92%] bg-white text-zinc-800 ring-1 ring-black/[0.05]';
            return (
              <div key={i} className={'rounded-xl px-3.5 py-2.5 shadow-sm ' + tone}>
                <div className={'mb-1 text-[11px] font-medium ' + (m.role === 'user' ? 'text-zinc-400' : m.role === 'error' ? 'text-rose-500' : 'text-zinc-400')}>
                  {m.role === 'user' ? '你' : m.role === 'error' ? '出错了' : model || 'assistant'}
                </div>
                <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {m.content || (pending ? <span className="inline-block h-4 w-2 animate-pulse rounded-sm bg-zinc-400" /> : '')}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex items-end gap-2">
          <textarea
            className={inputCls + ' min-h-[64px] resize-y'}
            value={input}
            disabled={streaming}
            placeholder={model ? '给 ' + model + ' 发消息…（Enter 发送，Shift+Enter 换行）' : '先在上方选择模型'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          {streaming ? (
            <Button variant="danger" onClick={() => abortRef.current?.abort()}>
              停止
            </Button>
          ) : (
            <Button variant="primary" onClick={send} disabled={!input.trim() || !model}>
              发送
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
