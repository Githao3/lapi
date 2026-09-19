import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import { api } from '../api';
import type { ModelsCatalogEntry } from '../types';
import { Button, Note } from '../components/ui';

type ChatRole = 'user' | 'assistant' | 'error';
interface ChatItem {
  role: ChatRole;
  content: string;
  model?: string;
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

// 转换层的回复里 content 可能是字符串，也可能是分段数组
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('');
  }
  return '';
}

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).catch(() => {});
}

// ---------- markdown 代码块：语言标签 + 复制 ----------

function PreBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);
  const lang = (() => {
    const child: unknown = Array.isArray(children) ? children[0] : children;
    const cls = child && typeof child === 'object' && 'props' in child ? String((child as { props?: { className?: string } }).props?.className ?? '') : '';
    return /language-([\w+-]+)/.exec(cls)?.[1] ?? '代码';
  })();
  const copy = () => {
    copyToClipboard(preRef.current?.innerText ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang}</span>
        <button onClick={copy}>{copied ? '已复制' : '复制'}</button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: PreBlock }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

// ---------- 图标 ----------

const IconSend = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

const IconStop = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <rect x="5.5" y="5.5" width="13" height="13" rx="2.5" />
  </svg>
);

const IconSliders = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
  </svg>
);

const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);

const IconCopy = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const IconDelete = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);

const IconRefresh = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
  </svg>
);

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
  const [showParams, setShowParams] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

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

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 192) + 'px';
  }, [input]);

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

  // 一轮补全：给定历史（不含本轮回答），发出请求并把流写进最后一条 assistant
  const runCompletion = async (history: ChatItem[]) => {
    setItems([...history, { role: 'assistant', content: '', model }]);
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
      taRef.current?.focus();
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text || streaming || !model) return;
    const history: ChatItem[] = [...items.filter((m) => m.role !== 'error'), { role: 'user', content: text }];
    setInput('');
    void runCompletion(history);
  };

  // 消息管理
  const deleteAt = (i: number) => {
    if (streaming) return;
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  };
  const clearAll = () => {
    if (!items.length) return;
    if (!window.confirm('清空全部对话？此操作不可撤销。')) return;
    if (streaming) abortRef.current?.abort();
    setItems([]);
  };
  const regenerate = (i: number) => {
    if (streaming) return;
    const history = items.slice(0, i).filter((m) => m.role !== 'error');
    if (!history.length || history[history.length - 1].role !== 'user') return;
    void runCompletion(history);
  };

  const current = models.find((m) => m.model === model);
  const viaChannels = (current?.channels ?? []).map((c) => c.name);
  const lastAssistantIdx = streaming ? -1 : items.length - 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏：模型选择 + 清空 + 参数开关 */}
      <div className="flex items-center justify-between gap-3 pb-3">
        <div className="relative">
          <select
            className="appearance-none rounded-full border border-black/[0.08] bg-white py-1.5 pl-4 pr-8 text-[13px] font-medium text-zinc-700 shadow-xs outline-none transition hover:border-zinc-300 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {models.length === 0 && <option value="">暂无可用模型</option>}
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.model}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-zinc-400">▾</span>
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button
              onClick={clearAll}
              title="清空全部对话"
              className="inline-flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white px-3 py-1.5 text-[12px] font-medium text-zinc-600 shadow-xs transition hover:border-rose-300 hover:text-rose-600"
            >
              <IconTrash />
              清空
            </button>
          )}
          <button
            onClick={() => setShowParams((v) => !v)}
            className={
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition ' +
              (showParams ? 'bg-zinc-900 text-white shadow-sm' : 'border border-black/[0.08] bg-white text-zinc-600 shadow-xs hover:border-zinc-300 hover:text-zinc-900')
            }
          >
            <IconSliders />
            参数
          </button>
        </div>
      </div>

      {/* 参数面板：默认收起 */}
      {showParams && (
        <div className="mb-3 space-y-3.5 rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_16px_40px_-24px_rgba(16,24,40,0.14)]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-600">系统提示词（可选）</span>
            <textarea
              className="w-full resize-y rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs outline-none transition placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
              rows={2}
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              placeholder="例如：你是一个简洁的技术助手，回答尽量短。"
            />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-600">温度 temperature</span>
              <input
                className="w-full rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs outline-none transition placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="0.7"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-600">最大 tokens（可选）</span>
              <input
                className="w-full rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs outline-none transition placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder="留空 = 不限制"
              />
            </label>
          </div>
          {viaChannels.length > 0 && (
            <div className="text-xs text-zinc-400">「{model}」命中渠道：{viaChannels.join('、')}</div>
          )}
          <div className="flex justify-end">
            <Button variant="subtle" onClick={() => setShowParams(false)}>
              收起
            </Button>
          </div>
        </div>
      )}

      {/* 消息区 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5">
            <div className="text-2xl font-semibold tracking-tight text-zinc-800">有什么可以帮忙的？</div>
            <div className="text-sm text-zinc-400">选择一个模型，直接开始对话</div>
            {models.length === 0 && (
              <div className="mt-2 w-full max-w-md">
                <Note tone="warn">还没有可路由的模型——先到「渠道」页配置渠道并声明模型。</Note>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-5 py-4">
            {items.map((m, i) => {
              const isLast = i === items.length - 1;
              const pending = isLast && streaming && m.role === 'assistant' && !m.content;
              const canRegenerate = i === lastAssistantIdx && !streaming;
              const alignRight = m.role === 'user';
              return (
                <div key={i} className={'group flex flex-col ' + (alignRight ? 'items-end' : 'items-start')}>
                  <div
                    className={
                      'max-w-[92%] rounded-2xl px-4 py-2.5 text-[15px] leading-7 shadow-sm ' +
                      (alignRight
                        ? 'bg-zinc-900 text-white'
                        : m.role === 'error'
                          ? 'border border-rose-200 bg-rose-50 text-rose-900'
                          : 'bg-white text-zinc-800 ring-1 ring-black/[0.05]')
                    }
                  >
                    {!alignRight && m.role === 'assistant' && (
                      <div className="mb-1 text-[11px] font-medium text-zinc-400">{m.model || model || 'assistant'}</div>
                    )}
                    {m.role === 'user' ? (
                      <div className="whitespace-pre-wrap break-words">{m.content}</div>
                    ) : m.role === 'error' ? (
                      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{m.content}</div>
                    ) : (
                      <>
                        <Md text={m.content} />
                        {pending && <span className="inline-block h-4 w-2 animate-pulse rounded-sm bg-zinc-400" />}
                      </>
                    )}
                  </div>
                  {/* 悬停工具条 */}
                  {!pending && (
                    <div
                      className={
                        'mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 ' +
                        (alignRight ? 'flex-row-reverse' : '')
                      }
                    >
                      <button
                        title="复制"
                        onClick={() => copyToClipboard(m.content)}
                        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-zinc-400 transition hover:bg-black/[0.05] hover:text-zinc-700"
                      >
                        <IconCopy />
                        复制
                      </button>
                      <button
                        title="删除这条消息"
                        onClick={() => deleteAt(i)}
                        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-zinc-400 transition hover:bg-rose-50 hover:text-rose-600"
                      >
                        <IconDelete />
                        删除
                      </button>
                      {canRegenerate && (
                        <button
                          title="重新生成这条回答"
                          onClick={() => regenerate(i)}
                          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-zinc-400 transition hover:bg-black/[0.05] hover:text-zinc-700"
                        >
                          <IconRefresh />
                          重新生成
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="pb-1 pt-2">
        <div className="rounded-2xl border border-black/[0.08] bg-white p-3 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_32px_-20px_rgba(16,24,40,0.18)] transition focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-500/10">
          <textarea
            ref={taRef}
            rows={1}
            className="block max-h-48 w-full resize-none bg-transparent text-sm leading-6 text-zinc-900 outline-none placeholder:text-zinc-400"
            value={input}
            disabled={streaming}
            placeholder={model ? '给 ' + model + ' 发消息…' : '先选择模型'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[11px] text-zinc-300">Enter 发送 · Shift+Enter 换行 · 回答可随时停止</span>
            {streaming ? (
              <button
                onClick={() => abortRef.current?.abort()}
                title="停止生成"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-600 text-white transition hover:bg-rose-500"
              >
                <IconStop />
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!input.trim() || !model}
                title="发送"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 disabled:pointer-events-none disabled:opacity-25"
              >
                <IconSend />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
