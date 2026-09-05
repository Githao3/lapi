import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Channel, SettingsPayload } from '../types';
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

  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyPort, setProxyPort] = useState('8790');
  const [proxyChannel, setProxyChannel] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [proxyMsg, setProxyMsg] = useState('');
  const [proxyStatus, setProxyStatus] = useState<SettingsPayload['proxy'] | null>(null);

  useEffect(() => {
    api.getConfig().then((c) => {
      setCfg(c);
      setPort(c.port ?? '8787');
      setBind(c.bind ?? '127.0.0.1');
      setToken(c.gateway_token ?? '');
      setLogging(c.logging_enabled === '1');
      if (c.proxy) {
        setProxyEnabled(c.proxy.enabled);
        setProxyPort(String(c.proxy.port ?? '8790'));
        setProxyChannel(c.proxy.channel_id ? String(c.proxy.channel_id) : '');
        setProxyStatus(c.proxy);
      }
    }).catch(() => {});
    api.listChannels().then(setChannels).catch(() => {});
  }, []);

  const save = async () => {
    try {
      await api.putConfig({ port, bind, gateway_token: token, logging_enabled: logging ? '1' : '0' });
      setMsg(bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1' && !token ? '已保存。（注意：非本机绑定当前无网关 token。）' : '已保存。' + (port !== (cfg?.port ?? '8787')) ? ' 端口改动需重启。' : '');
    } catch (e) {
      setMsg('保存失败：' + String(e));
    }
  };

  const saveProxy = async () => {
    setProxyMsg('保存中…');
    try {
      const r = await api.putConfig({
        proxy_enabled: proxyEnabled ? '1' : '0',
        proxy_port: proxyPort,
        proxy_channel_id: proxyChannel,
      }) as { ok: boolean; proxy?: SettingsPayload['proxy'] };
      setProxyStatus(r.proxy ?? null);
      setProxyMsg(r.proxy?.running
        ? '已生效：代理运行中，工具 base_url 填 ' + r.proxy.url + '（当前转发：' + (r.proxy.channel_name || '未选择') + '）'
        : r.proxy?.error ? '已保存，但代理未运行：' + r.proxy.error : '已保存，代理未启用。');
    } catch (e) {
      setProxyMsg('保存失败：' + String(e));
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

      <Card title="本机代理（cc-switch 式转发）">
        <div className="max-w-xl">
          <p className="mb-3 text-xs leading-relaxed text-zinc-500">
            开启后网关额外监听一个本机端口：工具把 base_url 指到代理端口，流量一律转发到下面选定的渠道——在渠道间切换时工具配置不用动。复用完整转发管线（头改写、跨协议转换、捕获模式）。
          </p>
          <label className="mb-3 flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" checked={proxyEnabled} onChange={(e) => setProxyEnabled(e.target.checked)} />
            启用本机代理端口
          </label>
          <Field label="代理端口" hint="始终绑定 127.0.0.1（仅本机可用）；改动保存即生效，无需重启。">
            <input className={inputCls} value={proxyPort} onChange={(e) => setProxyPort(e.target.value)} />
          </Field>
          <Field label="转发渠道" hint="当前所有 /v1/* 流量都转发到这个渠道（按其声明的上游格式决定是否转换）。">
            <select className={inputCls} value={proxyChannel} onChange={(e) => setProxyChannel(e.target.value)}>
              <option value="">选择渠道…</option>
              {channels.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name}（{c.enabled ? '启用中' : '停用'}）</option>
              ))}
            </select>
          </Field>
          {proxyStatus && (
            <div className="mb-3 text-xs text-zinc-500">
              状态：{proxyStatus.running ? <span className="font-medium text-emerald-600">运行中</span> : <span className="text-zinc-400">未运行</span>}
              {proxyStatus.error ? <span className="text-rose-600">（{proxyStatus.error}）</span> : null}
              {proxyStatus.running ? ' · ' + proxyStatus.url : ''}
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button variant="primary" onClick={saveProxy}>保存并生效</Button>
            {proxyMsg && <span className="text-xs text-zinc-500">{proxyMsg}</span>}
          </div>
        </div>
      </Card>
      <Note tone="warn">诚实边界：lapi 仅改写 HTTP 层请求头（host/认证/UA/额外头）；若上游按 TLS 指纹风控（如 claude.ai 官方），换 UA 亦无效——那是 v2 的方向。</Note>
    </div>
  );
}
