import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SettingsPayload } from '../types';
import { Card, Field, Button, Note, Badge, PageHeader, inputCls } from '../components/ui';

const BIND_HINT = '绑定 127.0.0.1（仅本机）时面板与转发都免鉴权；绑定其他地址（如 0.0.0.0 对外提供）时，两套凭据都必须设置。';
const PORT_HINT = '端口改动需重启服务后生效。';

export default function Settings() {
  const [cfg, setCfg] = useState<SettingsPayload | null>(null);
  const [port, setPort] = useState('');
  const [bind, setBind] = useState('');
  const [token, setToken] = useState('');
  const [adminPw, setAdminPw] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [clearAdmin, setClearAdmin] = useState(false);
  const [logging, setLogging] = useState(true);
  const [showToken, setShowToken] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [msg, setMsg] = useState('');
  const [credMsg, setCredMsg] = useState('');
  const [upstreamProxy, setUpstreamProxy] = useState('');
  const [upstreamBypass, setUpstreamBypass] = useState('');
  const [egressMsg, setEgressMsg] = useState('');

  const load = () => {
    api.getConfig().then((c) => {
      setCfg(c);
      setPort(c.port ?? '8787');
      setBind(c.bind ?? '127.0.0.1');
      setToken(c.gateway_token ?? '');
      setLogging(c.logging_enabled === '1');
      setUpstreamProxy(c.upstream_proxy ?? '');
      setUpstreamBypass(c.upstream_proxy_bypass ?? '');
    }).catch(() => {});
  };

  useEffect(load, []);

  const save = async () => {
    try {
      await api.putConfig({ port, bind, logging_enabled: logging ? '1' : '0' });
      const nonLocal = bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1';
      const missing = !token.trim() || !(cfg?.has_admin_password || adminPw.trim());
      setMsg('已保存。' + (nonLocal && missing ? '（注意：对外绑定还缺凭据，详见下方「访问凭据」。）' : '') + (port !== (cfg?.port ?? '8787') ? ' 端口改动需重启。' : ''));
      load();
    } catch (e) {
      setMsg('保存失败：' + String(e));
    }
  };

  const saveCreds = async () => {
    const body: Record<string, unknown> = {};
    if (token.trim()) body.gateway_token = token.trim();
    else if (clearToken) body.gateway_token_clear = true;
    if (adminPw.trim()) body.admin_password = adminPw.trim();
    else if (clearAdmin) body.admin_password_clear = true;
    if (!Object.keys(body).length) {
      setCredMsg('没有改动。');
      return;
    }
    if (clearAdmin && !window.confirm('清空管理密码后，非本机绑定的面板将无法登录（可用服务器上的 LAPI_ADMIN_PASSWORD 环境变量恢复）。确认清空？')) return;
    if (clearToken && !window.confirm('清空用户 key 后，非本机绑定的所有转发请求都会被拒绝。确认清空？')) return;
    try {
      await api.putConfig(body);
      setClearToken(false);
      setClearAdmin(false);
      setAdminPw('');
      setCredMsg('已保存。');
      load();
    } catch (e) {
      setCredMsg('保存失败：' + String(e));
    }
  };

  const saveEgress = async () => {
    setEgressMsg('保存中…');
    try {
      await api.putConfig({ upstream_proxy: upstreamProxy.trim(), upstream_proxy_bypass: upstreamBypass.trim() });
      setEgressMsg('已生效。' + (upstreamProxy.trim() ? '上游请求经 ' + upstreamProxy.trim() + ' 转发' + (upstreamBypass.trim() ? '（绕过：' + upstreamBypass.trim() + '）' : '') + '。' : '当前全部直连。'));
    } catch (e) {
      setEgressMsg('保存失败：' + String(e));
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

      <Card
        title="访问凭据"
        actions={
          <>
            <Button variant="subtle" onClick={() => setShowToken(!showToken)}>{showToken ? '隐藏' : '显示'}</Button>
            <Button variant="primary" onClick={saveCreds}>保存凭据</Button>
          </>
        }
      >
        <div className="max-w-xl">
          <p className="mb-4 text-xs leading-relaxed text-zinc-500">
            两套凭据互相独立：用户 key 只用于调用转发，拿到它的人打不开本面板；管理密码只用于登录本面板。
          </p>
          <Field
            label="用户 key（转发鉴权）"
            hint="发给使用者，填在工具的 key 位置（Anthropic 的 x-api-key、OpenAI 的 Authorization 均可）。它只能转发，不能查看渠道与上游 key。"
          >
            <div className="flex items-center gap-2">
              <input className={inputCls} type={showToken ? 'text' : 'password'} value={token} onChange={(e) => setToken(e.target.value)} placeholder="留空并点右侧「清除」可删除" />
              <Button variant="subtle" onClick={() => { setToken(''); setClearToken(true); }}>清除</Button>
            </div>
          </Field>
          <Field
            label="管理密码（面板登录）"
            hint="只有你自己知道。留空保存 = 不修改；忘记后可在服务器上用 LAPI_ADMIN_PASSWORD 环境变量恢复。"
          >
            <div className="flex items-center gap-2">
              <input className={inputCls} type={showAdmin ? 'text' : 'password'} value={adminPw} onChange={(e) => setAdminPw(e.target.value)} placeholder={cfg?.has_admin_password ? '已设置（留空不修改）' : '尚未设置'} />
              <Button variant="subtle" onClick={() => { setAdminPw(''); setClearAdmin(true); }}>清除</Button>
            </div>
          </Field>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span>当前状态：</span>
            <Badge tone={cfg?.has_gateway_token ? 'green' : 'amber'}>用户 key {cfg?.has_gateway_token ? '已设置' : '未设置'}</Badge>
            <Badge tone={cfg?.has_admin_password ? 'green' : 'amber'}>管理密码 {cfg?.has_admin_password ? '已设置' : '未设置'}</Badge>
            {credMsg && <span>{credMsg}</span>}
          </div>
        </div>
      </Card>

      <Card title="上游代理（访问被墙渠道）">
        <div className="max-w-xl">
          <p className="mb-3 text-xs leading-relaxed text-zinc-500">
            网关访问上游时走你本机的代理工具（Clash / v2rayN 等），让国内直连不了的渠道可达。保存即生效，无需重启；模型拉取同样走此代理。
          </p>
          <Field label="代理地址" hint="如 Clash 的 http://127.0.0.1:7897；留空 = 全部直连。部署在服务器上时填服务器本机的代理端口，不是家里电脑的。">
            <input className={inputCls} value={upstreamProxy} onChange={(e) => setUpstreamProxy(e.target.value)} placeholder="http://127.0.0.1:7897" />
          </Field>
          <Field label="直连绕过关键词（可选）" hint="逗号分隔；上游地址包含任一关键词即不走代理——用于国内可达的渠道（如 opencode.ai）。">
            <input className={inputCls} value={upstreamBypass} onChange={(e) => setUpstreamBypass(e.target.value)} placeholder="opencode.ai, 99442200" />
          </Field>
          <div className="flex items-center gap-3">
            <Button variant="primary" onClick={saveEgress}>保存并生效</Button>
            {egressMsg && <span className="text-xs text-zinc-500">{egressMsg}</span>}
          </div>
        </div>
      </Card>
      <Note tone="warn">诚实边界：lapi 仅改写 HTTP 层请求头（host/认证/UA/额外头）；若上游按 TLS 指纹风控（如 claude.ai 官方），换 UA 亦无效——那是 v2 的方向。</Note>
    </div>
  );
}
