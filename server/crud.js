// Admin REST API surface for the web UI. No auth here; index.js guards /api when bound to LAN.

import {
  listChannels,
  getChannel,
  insertChannel,
  updateChannel,
  deleteChannel,
  getSetting,
  setSetting,
  allSettings,
  listLogs,
  clearLogs,
  collectStats,
  logsSummary,
  countLogsBefore,
  deleteLogsBefore,
} from './db.js';
import { listPresets, presetToChannel } from './presets.js';
import { captureIsEnabled } from './capture.js';
import { normalizeUpstreamUrl } from './relay-lib.js';
import { fetchModelsList } from './model-fetch.js';
import { handleRelayRequest } from './relay.js';

const SETTING_KEYS = ['port', 'bind', 'gateway_token', 'admin_password', 'logging_enabled', 'upstream_proxy', 'upstream_proxy_bypass'];

// Custom UA presets saved from the capture page (built-ins stay in presets-data.mjs).
const CUSTOM_UA_KEY = 'custom_ua_presets';
const CUSTOM_UA_MAX = 50;

function readCustomUaPresets() {
  try {
    const raw = getSetting(CUSTOM_UA_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
  } catch {
    return [];
  }
}

function presetsPayloadWithCustom() {
  const base = listPresets();
  const custom = readCustomUaPresets();
  base.uaPresets = [...base.uaPresets, ...custom];
  base.uaPresetsCustom = custom;
  return base;
}

export function attachCrud(app) {
  app.get('/api/config', (req, res) => {
    const s = allSettings();
    // What's actually listening right now (may differ from the preferred port when
    // it was taken at startup — the preferred port itself never gets overwritten).
    s.resolved_port = getSetting('active_port') || getSetting('port');
    // admin_password never leaves the server; the panel only learns whether one exists.
    s.has_admin_password = !!getSetting('admin_password');
    s.has_gateway_token = !!getSetting('gateway_token');
    res.json(s);
  });

  app.put('/api/config', (req, res) => {
    const body = req.body ?? {};
    for (const k of Object.keys(body)) {
      if (!SETTING_KEYS.includes(k)) continue;
      const v = String(body[k]);
      // Secrets: an empty field means "leave as is" so saving the form cannot
      // silently wipe the credential that protects a public deployment.
      if ((k === 'admin_password' || k === 'gateway_token') && v === '') continue;
      setSetting(k, v);
    }
    if (body.admin_password_clear) setSetting('admin_password', '');
    if (body.gateway_token_clear) setSetting('gateway_token', '');
    res.json({ ok: true });
  });

  app.get('/api/channels', (req, res) => {
    res.json(listChannels());
  });

  app.post('/api/channels', (req, res) => {
    const id = insertChannel(req.body ?? {});
    res.json({ ok: true, id });
  });

  app.put('/api/channels/:id', (req, res) => {
    updateChannel(Number(req.params.id), req.body ?? {});
    res.json({ ok: true });
  });

  app.post('/api/channels/:id/toggle', (req, res) => {
    const c = getChannel(Number(req.params.id));
    if (!c) {
      res.status(404).json({ ok: false, error: 'channel not found' });
      return;
    }
    updateChannel(c.id, { ...c, enabled: !c.enabled });
    res.json({ ok: true, enabled: !c.enabled });
  });

  app.delete('/api/channels/:id', (req, res) => {
    deleteChannel(Number(req.params.id));
    res.json({ ok: true });
  });

  // Fetch a channel's upstream model list (cc-switch style): plain GET /v1/models with a
  // candidate chain. No "test" semantics — this is the model picker's data source.
  // Works both by id (/api/channels/:id/fetch-models) and for an unsaved draft
  // (/api/channels/fetch-models with the draft as body).

  async function fetchChannelModels(c, res) {
    const r = await fetchModelsList(c);
    res.json(r);
  }

  app.post('/api/channels/:id/fetch-models', async (req, res) => {
    const c = getChannel(Number(req.params.id));
    if (!c) {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    await fetchChannelModels(c, res);
  });
  app.post('/api/channels/fetch-models', async (req, res) => {
    await fetchChannelModels(req.body ?? {}, res);
  });


  app.get('/api/presets', (req, res) => {
    res.json(presetsPayloadWithCustom());
  });

  app.post('/api/ua-presets', (req, res) => {
    const ua = String(req.body?.ua ?? '').trim();
    if (!ua || ua.length > 512) {
      res.status(400).json({ ok: false, error: 'invalid user-agent' });
      return;
    }
    const custom = readCustomUaPresets();
    if (listPresets().uaPresets.includes(ua) || custom.includes(ua)) {
      res.json({ ok: true, added: false, ...presetsPayloadWithCustom() });
      return;
    }
    const next = [...custom, ua].slice(-CUSTOM_UA_MAX);
    setSetting(CUSTOM_UA_KEY, JSON.stringify(next));
    res.json({ ok: true, added: true, ...presetsPayloadWithCustom() });
  });

  app.delete('/api/ua-presets', (req, res) => {
    const ua = String(req.query.ua ?? '').trim();
    const custom = readCustomUaPresets();
    const next = custom.filter((x) => x !== ua);
    setSetting(CUSTOM_UA_KEY, JSON.stringify(next));
    res.json({ ok: true, removed: next.length !== custom.length, ...presetsPayloadWithCustom() });
  });

  app.post('/api/presets/apply', (req, res) => {
    const name = String(req.body?.name ?? '');
    const draft = presetToChannel(name);
    if (!draft) {
      res.status(404).json({ ok: false, error: 'preset not found' });
      return;
    }
    res.json({ ok: true, draft, name });
  });

  app.get('/api/capture', (req, res) => {
    res.json({
      enabled: captureIsEnabled(),
      entries: listLogs('capture', 200),
    });
  });

  app.post('/api/capture/toggle', (req, res) => {
    setSetting('capture_enabled', req.body?.enabled ? '1' : '0');
    res.json({ ok: true });
  });

  app.delete('/api/capture', (req, res) => {
    clearLogs('capture');
    res.json({ ok: true });
  });

  // Log retention: nothing is deleted automatically; the panel cleans up on demand.
  app.get('/api/logs/summary', (req, res) => {
    const s = logsSummary();
    const days = Number(req.query.before_days ?? '');
    if (Number.isFinite(days) && days >= 0) {
      s.older = countLogsBefore(Date.now() - days * 86400000);
    }
    res.json(s);
  });

  app.post('/api/logs/cleanup', (req, res) => {
    const days = Number(req.body?.before_days ?? '');
    if (!Number.isFinite(days) || days < 0) {
      res.status(400).json({ ok: false, error: 'before_days 必须是 >= 0 的数字' });
      return;
    }
    const deleted = deleteLogsBefore(Date.now() - days * 86400000);
    res.json({ ok: true, deleted, remaining: logsSummary().total });
  });

  app.get('/api/stats', (req, res) => {
    res.json(collectStats(String(req.query.range ?? '7d')));
  });

  // Playground: the panel chats through the full relay pipeline (channel pick,
  // header rewrite, cross-format conversion, usage logging) without needing the
  // user key. Capture mode is bypassed — this page wants answers, not a header
  // inspection, and its requests would otherwise be swallowed while capturing.
  app.post('/api/playground/chat', (req, res) => {
    const body = req.body ?? {};
    const model = String(body.model ?? '').trim();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!model) {
      res.status(400).json({ ok: false, error: '缺少 model' });
      return;
    }
    if (!messages.length) {
      res.status(400).json({ ok: false, error: 'messages 为空' });
      return;
    }
    const payload = { model, messages, stream: body.stream !== false };
    if (body.temperature != null && Number.isFinite(Number(body.temperature))) payload.temperature = Number(body.temperature);
    if (body.max_tokens != null && Number.isFinite(Number(body.max_tokens))) payload.max_tokens = Number(body.max_tokens);
    req.body = payload;
    handleRelayRequest(req, res, 'openai', 'chat', { skipCapture: true });
  });

  app.get('/api/models-catalog', (req, res) => {
    const map = new Map();
    for (const c of listChannels()) {
      const declared = String(c.models ?? '').split(',').map((s) => s.trim()).filter((s) => s && s !== '*');
      for (const m of declared) {
        if (!map.has(m)) map.set(m, { model: m, channels: [] });
        map.get(m).channels.push({ name: c.name, via: 'declared', enabled: !!c.enabled });
      }
      for (const k of Object.keys(c.model_mapping ?? {})) {
        if (!k) continue;
        if (!map.has(k)) map.set(k, { model: k, channels: [] });
        const e = map.get(k);
        if (!e.channels.some((ch) => ch.name === c.name)) e.channels.push({ name: c.name, via: 'alias', enabled: !!c.enabled });
      }
    }
    res.json([...map.values()].sort((a, b) => a.model.localeCompare(b.model)));
  });
  app.get('/api/logs', (req, res) => {
    res.json(listLogs(null, Number(req.query.limit ?? 100)));
  });

  app.get('/api/system', (req, res) => {
    res.json({
      uptime: process.uptime(),
      mode: captureIsEnabled() ? 'capture' : 'relay',
      channels: getChannelCount(),
    });
  });
}

function getChannelCount() {
  return listChannels().length;
}