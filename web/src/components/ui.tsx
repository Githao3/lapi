import { ReactNode, useEffect, useRef, useState } from 'react';

const btnBase =
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500';

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const v = props.variant ?? 'ghost';
  const styles: Record<string, string> = {
    primary: 'bg-zinc-900 text-white shadow-sm hover:bg-zinc-700',
    ghost: 'text-zinc-600 hover:bg-black/[0.05] hover:text-zinc-900',
    subtle:
      'border border-black/[0.08] bg-white text-zinc-700 shadow-xs hover:border-zinc-300 hover:text-zinc-900',
    danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-500',
  };
  return (
    <button
      type={props.type ?? 'button'}
      disabled={props.disabled}
      onClick={props.onClick}
      className={btnBase + ' ' + styles[v] + (props.className ? ' ' + props.className : '')}
    >
      {props.children}
    </button>
  );
}

const cardCls =
  'rounded-2xl border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_16px_40px_-24px_rgba(16,24,40,0.14)]';

export function Card(props: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cardCls + (props.className ? ' ' + props.className : '')}>
      {(props.title || props.actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-black/[0.05] px-5 py-3.5">
          <h3 className="text-sm font-semibold tracking-tight text-zinc-900">{props.title}</h3>
          <div className="flex items-center gap-2">{props.actions}</div>
        </div>
      )}
      <div className="p-5">{props.children}</div>
    </div>
  );
}

export function PageHeader(props: { title: string; desc?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold leading-7 tracking-tight text-zinc-900">
          {props.title}
        </h1>
        {props.desc && <p className="mt-1 text-[13px] leading-5 text-zinc-500">{props.desc}</p>}
      </div>
      {props.actions && <div className="flex items-center gap-2">{props.actions}</div>}
    </div>
  );
}

export function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-xs font-medium text-zinc-600">{props.label}</span>
      {props.children}
      {props.hint && (
        <span className="mt-1.5 block text-xs leading-relaxed text-zinc-400">{props.hint}</span>
      )}
    </label>
  );
}

export const inputCls =
  'w-full rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs outline-none transition placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10';

// ---------- 自研下拉（替代原生 select：弹层样式与整体 UI 一致） ----------

export interface DropdownOption {
  value: string;
  label: string;
}

const dropdownBtnBase =
  'flex w-full items-center justify-between gap-2 rounded-lg border bg-white text-left text-sm shadow-xs outline-none transition disabled:pointer-events-none disabled:opacity-45';
const dropdownBtnIdle = 'border-black/[0.08] text-zinc-900 hover:border-zinc-300';
const dropdownBtnOpen = 'border-indigo-500 ring-4 ring-indigo-500/10';

export function Dropdown(props: {
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  disabled?: boolean;
  /** 覆盖按钮默认样式（如测试场的胶囊形）；宽度仍由外层容器控制 */
  buttonClassName?: string;
  /** 附加到弹层（如 w-max） */
  popupClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      const n = props.options.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHi((h) => (h < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : e.key === 'ArrowDown' ? (h + 1) % n : (h - 1 + n) % n));
      }
      if (e.key === 'Enter' && hi >= 0 && props.options[hi]) {
        props.onChange(props.options[hi].value);
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, hi, props.options, props.onChange]);

  const current = props.options.find((o) => o.value === props.value);
  const label = current ? current.label : (props.placeholder ?? '请选择…');

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => {
          setOpen(!open);
          setHi(-1);
        }}
        className={
          (props.buttonClassName ?? dropdownBtnBase + ' px-3 py-2') +
          ' ' +
          (open ? dropdownBtnOpen : dropdownBtnIdle)
        }
      >
        <span className={'min-w-0 flex-1 truncate ' + (current ? '' : 'text-zinc-400')}>{label}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={'shrink-0 text-zinc-400 transition-transform duration-150' + (open ? ' rotate-180' : '')}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          className={
            'absolute left-0 z-50 mt-1 max-h-60 w-full overflow-auto rounded-xl border border-black/[0.08] bg-white py-1 shadow-[0_12px_32px_-8px_rgba(16,24,40,0.18)] ' +
            (props.popupClassName ?? '')
          }
        >
          {props.options.length === 0 && <div className="px-3 py-2 text-xs text-zinc-400">暂无选项</div>}
          {props.options.map((o, i) => (
            <button
              type="button"
              key={o.value}
              onMouseEnter={() => setHi(i)}
              onClick={() => {
                props.onChange(o.value);
                setOpen(false);
              }}
              className={
                'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors ' +
                (i === hi ? 'bg-zinc-100 ' : '') +
                (o.value === props.value ? 'font-medium text-indigo-600' : 'text-zinc-700')
              }
            >
              <span className="min-w-0 flex-1 truncate" title={o.label}>
                {o.label}
              </span>
              {o.value === props.value && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 保留原 API：内部换成自研下拉
export function Select(props: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return <Dropdown value={props.value} onChange={props.onChange} options={props.options} />;
}

export function Badge(props: { children: ReactNode; tone?: 'neutral' | 'cyan' | 'green' | 'amber' }) {
  const tones: Record<string, string> = {
    neutral: 'bg-zinc-100 text-zinc-600 ring-black/[0.06]',
    cyan: 'bg-indigo-50 text-indigo-700 ring-indigo-600/15',
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
    amber: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  };
  const t = props.tone ?? 'neutral';
  const basic =
    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ring-1 ring-inset ' +
    tones[t];
  return <span className={basic}>{props.children}</span>;
}

export function Note(props: { tone?: 'info' | 'warn'; children: ReactNode }) {
  const tones: Record<string, string> = {
    info: 'border-indigo-200/70 bg-indigo-50/70 text-indigo-900',
    warn: 'border-amber-200/80 bg-amber-50/80 text-amber-900',
  };
  return (
    <div
      className={
        'rounded-xl border px-4 py-3 text-[13px] leading-relaxed ' + tones[props.tone ?? 'info']
      }
    >
      {props.children}
    </div>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <div className="animate-fade-in fixed inset-0 z-50 overflow-y-auto bg-zinc-950/30 p-6 backdrop-blur-[2px]">
      <div className={'animate-pop-in mx-auto mt-[4vh] w-full rounded-2xl bg-white shadow-2xl ring-1 ring-black/[0.06] ' + (props.wide ? 'max-w-4xl' : 'max-w-2xl')}>
        <div className="flex items-center justify-between border-b border-black/[0.05] px-6 pb-4 pt-5">
          <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900">{props.title}</h2>
          <button
            onClick={props.onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-700"
          >
            ✕
          </button>
        </div>
        <div className="max-h-[72vh] overflow-y-auto p-6">{props.children}</div>
        {props.footer && (
          <div className="flex items-center justify-end gap-3 border-t border-black/[0.05] px-6 py-4">{props.footer}</div>
        )}
      </div>
    </div>
  );
}

export function EmptyState(props: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 ring-1 ring-black/[0.05]">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 12h-6l-2 3h-4l-2-3H2" />
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>
      </div>
      <div className="text-sm text-zinc-500">{props.text}</div>
    </div>
  );
}
