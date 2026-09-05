import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SettingsPayload } from '../types';
import { Card, Field, Button, Note, PageHeader, inputCls } from '../components/ui';

const BIND_HINT = '绑定非 loopback 地址时，必须设置网关 token，且该 token 同时保护管理端 /api。';
const PORT_HINT = '端口改动需重启服务后生效。';

export default function Settings() {
  const [cfg, setCfg] = useState<SettingsPayload | null>(null);
  const [port, setPort] = useState('');
  const [bind, setBind] = useState('');
  const [token, setToken] = useState('');
  const [logging, setLogging] = useState(true);
  const [showToken, setShowToken] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.getConfig().then((c) => {
      setCfg(c);
      setPort(c.port ?? '8787');
      setBind(c.bind ?? '127.0.0.1');
      setToken(c.gateway_token ?? '');
      setLogging(c.logging_enabled === '1');
    }).catch(() => {});
  }, []);

  const save = async () => {
    try {
      await api.putConfig({ port, bind, gateway_token: token, logging_enabled: logging ? '1' : '0' });
      setMsg(bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1' && !token ? '已保存。（注意：非本机绑定当前无网关 token。）' : '已保存。' + (port !== (cfg?.port ?? '8787')) ? ' 端口改动需重启。' : '');
    } catch (e) {
      setMsg('保存失败：' + String(e));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="设置" desc="端口、绑定地址与安全" />
      <Card title="基本设置">
        <div className="max-w-xl">
          <Field label="端口" hint={PORT_HINT}>
            <input className={inputCls} value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
          <Field label="绑定地址" hint={BIND_HINT}>
            <input className={inputCls} value={bind} onChange={(e) => setBind(e.target.value)} placeholder="127.0.0.1" />
          </Field>
          <Field label="网关 token（可选）" hint="网关转发本身不校验 key；token 只用于局域网暴露时保护管理端。">
            <div className="flex gap-2">
              <input className={inputCls} type={showToken ? 'text' : 'password'} value={token} onChange={(e) => setToken(e.target.value)} />
              <Button variant="subtle" onClick={() => setShowToken(!showToken)}>{showToken ? '隐藏' : '显示'}</Button>
            </div>
          </Field>
          <label className="mb-4 flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" checked={logging} onChange={(e) => setLogging(e.target.checked)} />
            记录中继日志
          </label>
          <div className="flex items-center gap-3">
            <Button variant="primary" onClick={save}>保存</Button>
            {msg && <span className="text-xs text-zinc-500">{msg}</span>}
          </div>
        </div>
      </Card>
      <Note tone="warn">诚实边界：lapi 仅改写 HTTP 层请求头（host/认证/UA/额外头）；若上游按 TLS 指纹风控（如 claude.ai 官方），换 UA 亦无效——那是 v2 的方向。</Note>
    </div>
  );
}