// Proxy mode: a second local listener (always 127.0.0.1) that forwards ALL /v1/*
// traffic to the currently-selected channel — tools keep one base URL while the
// target channel is switched in the admin UI. Reuses the full relay pipeline
// (header rewrite, cross-protocol conversion, capture mode, retry guard).
import express from 'express';
import { getSetting, getChannel } from './db.js';
import { handleRelayRequest } from './relay.js';
import { fetchModelsList } from './model-fetch.js';

let server = null;
let lastSig = '';
let lastError = '';

export function proxyStatus() {
  const enabled = getSetting('proxy_enabled') === '1';
  const port = Number(getSetting('proxy_port') ?? 8790);
  const channelId = Number(getSetting('proxy_channel_id') ?? 0);
  const channel = channelId ? getChannel(channelId) : null;
  return {
    enabled,
    port,
    channel_id: channelId,
    channel_name: channel ? channel.name : '',
    running: Boolean(server),
    error: lastError,
    url: 'http://127.0.0.1:' + port,
  };
}

// Start/stop/restart the proxy listener so runtime config matches settings.
export function applyProxySettings() {
  const enabled = getSetting('proxy_enabled') === '1';
  const port = Number(getSetting('proxy_port') ?? 8790);
  const sig = (enabled ? '1' : '0') + ':' + port;
  if (sig === lastSig) return proxyStatus();
  lastSig = sig;
  if (server) {
    try { server.close(); } catch { /* already gone */ }
    server = null;
  }
  lastError = '';
  if (!enabled) return proxyStatus();

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  // The target channel is read per request, so switching channels in the UI
  // takes effect immediately without touching the listener.
  const relay = (protocol, kind) => (req, res) => {
    const channelId = Number(getSetting('proxy_channel_id') ?? 0);
    handleRelayRequest(req, res, protocol, kind, { forceChannelId: channelId });
  };
  app.post('/v1/messages', relay('anthropic', 'messages'));
  app.post('/v1/chat/completions', relay('openai', 'chat'));
  app.post('/v1/responses', relay('openai', 'responses'));
  app.get('/v1/models', async (req, res) => {
    const channelId = Number(getSetting('proxy_channel_id') ?? 0);
    const c = channelId ? getChannel(channelId) : null;
    if (!c) {
      res.status(400).json({ error: { message: '代理未选择转发渠道' } });
      return;
    }
    const r = await fetchModelsList(c);
    if (r.error && !r.models.length) {
      res.status(502).json({ error: { message: r.error } });
      return;
    }
    res.json({ object: 'list', data: r.models.map((id) => ({ id, object: 'model', owned_by: 'lapi-proxy' })) });
  });
  app.use((req, res) => {
    res.status(404).json({ error: { message: 'lapi proxy: /v1/* only（管理面板在主端口）' } });
  });

  try {
    // 本机代理端口：始终绑 loopback，不随主服务 bind 地址走。
    server = app.listen(port, '127.0.0.1');
    server.on('error', (e) => {
      lastError = '代理端口 ' + port + ' 监听失败: ' + String((e && e.message) || e);
      try { server.close(); } catch { /* noop */ }
      server = null;
    });
  } catch (e) {
    lastError = String((e && e.message) || e);
    server = null;
  }
  return proxyStatus();
}
