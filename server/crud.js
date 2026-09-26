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
  clearChannelPresetRefs,
  renameChannelPresetRefs,
} from './db.js';
import { listPresets, presetToChannel } from './presets.js';
import { captureIsEnabled } from './capture.js';
import { normalizeUpstreamUrl } from './relay-lib.js';
import { fetchModelsList } from './model-fetch.js';
import { handleRelayRequest } from './relay.js';
import { loadPresets, getPreset, savePresets, classifyCaptureHeaders } from './client-presets.js';

const SETTING_KEYS = ['port', 'bind', 'gateway_token', 'admin_password', 'logging_enabled', 'log_out_headers', 'upstream_proxy', 'upstream_proxy_bypass'];

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
    const body = { ...(req.body ?? {}) };
    // UA 伪装与客户端档案二选一：引用档案时清掉独立 UA
    if (body.client_preset) body.user_agent_override = '';
    const id = insertChannel(body);
    res.json({ ok: true, id });
  });

  app.put('/api/channels/:id', (req, res) => {
    const body = { ...(req.body ?? {}) };
    if (body.client_preset) body.user_agent_override = '';
    updateChannel(Number(req.params.id), body);
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

  // Log retention: nothing is deleted automatically; each page cleans its own kind.
  function kindOf(v) {
    return v === 'relay' || v === 'capture' ? v : null;
  }

  function sanitizeClientHeaders(headers) {
    if (!Array.isArray(headers)) return [];
    const seen = new Map();
    for (const h of headers) {
      const name = String(h?.name ?? '').toLowerCase().trim();
      if (!name || name.length > 128) continue;
      const mode = ['fixed', 'fill', 'drop'].includes(h?.mode) ? h.mode : 'fixed';
      seen.set(name, { name, value: String(h?.value ?? ''), mode });
    }
    return [...seen.values()];
  }

  app.get('/api/logs/summary', (req, res) => {
    const kind = kindOf(req.query.kind);
    if (req.query.kind != null && req.query.kind !== '' && !kind) {
      res.status(400).json({ ok: false, error: "kind 只能是 'relay' 或 'capture'" });
      return;
    }
    const s = logsSummary(kind);
    const days = Number(req.query.before_days ?? '');
    if (Number.isFinite(days) && days >= 0) {
      s.older = countLogsBefore(Date.now() - days * 86400000, kind);
    }
    res.json(s);
  });

  app.post('/api/logs/cleanup', (req, res) => {
    const days = Number(req.body?.before_days ?? '');
    const kind = kindOf(req.body?.kind);
    if (req.body?.kind != null && req.body.kind !== '' && !kind) {
      res.status(400).json({ ok: false, error: "kind 只能是 'relay' 或 'capture'" });
      return;
    }
    if (!Number.isFinite(days) || days < 0) {
      res.status(400).json({ ok: false, error: 'before_days 必须是 >= 0 的数字' });
      return;
    }
    const deleted = deleteLogsBefore(Date.now() - days * 86400000, kind);
    res.json({ ok: true, deleted, remaining: logsSummary(kind).total });
  });

  // Client impersonation presets: named header profiles a channel can reference.
  app.get('/api/client-presets', (req, res) => {
    res.json(loadPresets());
  });

  app.post('/api/client-presets/draft', (req, res) => {
    res.json(classifyCaptureHeaders(req.body?.inHeaders));
  });

  app.post('/api/client-presets', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 60) {
      res.status(400).json({ ok: false, error: '预设名必填且不超过 60 字符' });
      return;
    }
    const list = loadPresets();
    if (list.some((p) => p.name === name)) {
      res.status(400).json({ ok: false, error: '同名客户端预设已存在' });
      return;
    }
    const preset = { name, created_at: Date.now(), strict: req.body?.strict !== false, headers: sanitizeClientHeaders(req.body?.headers) };
    list.push(preset);
    savePresets(list);
    res.json({ ok: true, preset });
  });

  app.put('/api/client-presets/:name', (req, res) => {
    const target = String(req.params.name ?? '');
    const list = loadPresets();
    const preset = list.find((p) => p.name === target);
    if (!preset) {
      res.status(404).json({ ok: false, error: '客户端预设不存在' });
      return;
    }
    const name = String(req.body?.name ?? target).trim();
    if (!name || name.length > 60 || list.some((p) => p.name === name && p !== preset)) {
      res.status(400).json({ ok: false, error: '新名称为空、超长或已存在' });
      return;
    }
    preset.name = name;
    preset.strict = req.body?.strict !== false;
    preset.headers = sanitizeClientHeaders(req.body?.headers);
    savePresets(list);
    if (name !== target) renameChannelPresetRefs(target, name);
    res.json({ ok: true, preset });
  });

  app.delete('/api/client-presets/:name', (req, res) => {
    const target = String(req.params.name ?? '');
    const list = loadPresets();
    const next = list.filter((p) => p.name !== target);
    savePresets(next);
    // 引用该预设的渠道同步清空，避免留下幽灵引用
    const cleared = clearChannelPresetRefs(target);
    res.json({ ok: true, removed: next.length !== list.length, cleared_channels: cleared });
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