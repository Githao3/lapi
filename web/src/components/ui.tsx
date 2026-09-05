import { ReactNode } from 'react';

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

export function Select(props: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      className={inputCls + ' cursor-pointer'}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
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
