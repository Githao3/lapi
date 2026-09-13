import { useState } from 'react';
import { api, setSessionToken } from '../api';
import { Button, Note, inputCls } from '../components/ui';

export default function Login(props: { configured: boolean; onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.login(password);
      setSessionToken(r.session);
      props.onSuccess();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-zinc-700 to-zinc-950 text-sm font-bold tracking-tight text-white shadow-md">
            La
          </div>
          <div>
            <div className="text-[15px] font-semibold leading-4 tracking-tight text-zinc-900">lapi</div>
            <div className="mt-0.5 text-[11px] text-zinc-400">管理面板登录</div>
          </div>
        </div>

        <form
          className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_16px_40px_-24px_rgba(16,24,40,0.14)]"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {!props.configured ? (
            <Note tone="warn">
              服务端还没设置管理密码：先在服务器上设置环境变量 <code className="font-mono">LAPI_ADMIN_PASSWORD</code>{' '}
              并重启容器，然后回来登录。
            </Note>
          ) : (
            <>
              <label className="mb-4 block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-600">管理密码</span>
                <input
                  className={inputCls}
                  type="password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="只有管理员自己知道"
                />
              </label>
              <Button variant="primary" type="submit" disabled={busy || !password} className="w-full">
                {busy ? '登录中…' : '登录'}
              </Button>
            </>
          )}
          {err && <div className="mt-3 text-xs leading-relaxed text-rose-600">{err}</div>}
        </form>

        <p className="mt-4 px-1 text-[11px] leading-4 text-zinc-400">
          面板可以查看上游渠道与 key，因此只对管理员开放。使用者只需要「用户 key」调用转发，无需登录。
        </p>
      </div>
    </div>
  );
}
