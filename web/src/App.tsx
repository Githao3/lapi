import { useEffect, useState } from 'react';
import Dashboard from './pages/Dashboard';
import Channels from './pages/Channels';
import Presets from './pages/Presets';
import Capture from './pages/Capture';
import Settings from './pages/Settings';
import Logs from './pages/Logs';
import Models from './pages/Models';
import Login from './pages/Login';
import { api, onUnauthorized, setSessionToken } from './api';
import type { SessionInfo } from './types';

type Page = 'dashboard' | 'channels' | 'models' | 'presets' | 'capture' | 'settings' | 'logs';

function Icon(props: { d: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d={props.d} />
    </svg>
  );
}

const ICONS: Record<Page, string> = {
  models: 'm12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z M22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65 M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65',
  dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  channels: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.3 7 12 12l8.7-5 M12 22V12',
  presets: 'M12 3l1.9 5.7L19.6 10l-5.7 1.9L12 17.6l-1.9-5.7L4.4 10l5.7-1.3zM19 15l.9 2.6L22.5 18l-2.6.9L19 21.5l-.9-2.6L15.5 18l2.6-.4z',
  capture: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  logs: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
};

const NAV: { key: Page; label: string; desc: string }[] = [
  { key: 'dashboard', label: '概览', desc: '运行状态' },
  { key: 'channels', label: '渠道', desc: '上游与路由' },
  { key: 'models', label: '模型', desc: '上游模型库' },
  { key: 'presets', label: '预设库', desc: 'cc-switch 预设' },
  { key: 'capture', label: '捕获', desc: '请求头对照' },
  { key: 'settings', label: '设置', desc: '端口与安全' },
  { key: 'logs', label: '日志', desc: '中继记录' },
];

export default function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [sess, setSess] = useState<SessionInfo | null>(null);

  const refreshSession = () => {
    api
      .getSession()
      .then(setSess)
      .catch(() =>
        // Backend unreachable: fall through to the login screen, which reports the error.
        setSess({ ok: false, local: false, auth_required: true, configured: true, authed: false })
      );
  };

  useEffect(refreshSession, []);
  useEffect(() => onUnauthorized(() => setSess((s) => (s ? { ...s, authed: false } : s))), []);

  useEffect(() => {
    const onGo = (e: Event) => {
      const p = (e as CustomEvent).detail;
      if (typeof p === 'string') setPage(p as Page);
    };
    window.addEventListener('lapi-goto', onGo);
    return () => window.removeEventListener('lapi-goto', onGo);
  }, []);

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      /* session may already be gone */
    }
    setSessionToken('');
    setSess((s) => (s ? { ...s, authed: false } : s));
  };

  const current = NAV.find((n) => n.key === page);

  if (!sess) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-400">连接中…</div>
    );
  }
  if (sess.auth_required && !sess.authed) {
    return <Login configured={sess.configured} onSuccess={refreshSession} />;
  }

  return (
    <div className="flex h-full min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-black/[0.05] bg-white/60 p-4 backdrop-blur-xl">
        <div className="flex items-center gap-2.5 px-2 pb-6 pt-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-zinc-700 to-zinc-950 text-sm font-bold tracking-tight text-white shadow-md">
            La
          </div>
          <div>
            <div className="text-[15px] font-semibold leading-4 tracking-tight text-zinc-900">
              lapi
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-400">本地个人版 API 网关</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => {
            const active = page === n.key;
            return (
              <button
                key={n.key}
                onClick={() => setPage(n.key)}
                className={
                  'group flex items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-all duration-150 ' +
                  (active
                    ? 'bg-zinc-900 text-white shadow-md'
                    : 'text-zinc-600 hover:bg-black/[0.045] hover:text-zinc-900')
                }
              >
                <Icon d={ICONS[n.key]} />
                <span className="flex-1">
                  <span className="block text-[13px] font-medium leading-4">{n.label}</span>
                  <span
                    className={
                      'block text-[10.5px] leading-3.5 ' +
                      (active ? 'text-zinc-400' : 'text-zinc-400 group-hover:text-zinc-500')
                    }
                  >
                    {n.desc}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>
        <div className="mt-auto px-3 pb-1">
          <div className="rounded-xl bg-zinc-100/70 px-3 py-2.5 ring-1 ring-black/[0.04]">
            <div className="text-[11px] leading-4 text-zinc-500">
              使用者只拿到「用户 key」，只能调用转发；上游渠道与 key 需管理密码登录才能查看。
            </div>
            {sess.auth_required && (
              <button
                onClick={logout}
                className="mt-2 text-[11px] font-medium text-zinc-500 underline decoration-zinc-300 underline-offset-2 transition-colors hover:text-zinc-800"
              >
                退出登录
              </button>
            )}
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-9">
          <div className="mb-6 flex items-baseline gap-3">
            <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400">
              lapi console
            </span>
            <span className="h-px flex-1 bg-gradient-to-r from-black/[0.08] to-transparent" />
            <span className="text-[11px] text-zinc-400">{current?.desc}</span>
          </div>
          {page === 'dashboard' && <Dashboard />}
          {page === 'channels' && <Channels />}
          {page === 'models' && <Models />}
          {page === 'presets' && <Presets />}
          {page === 'capture' && <Capture />}
          {page === 'settings' && <Settings />}
          {page === 'logs' && <Logs />}
        </div>
      </main>
    </div>
  );
}
