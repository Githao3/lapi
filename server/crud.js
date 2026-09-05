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
} from './db.js';
import { listPresets, presetToChannel } from './presets.js';
import { captureIsEnabled } from './capture.js';
import { normalizeUpstreamUrl } from './relay-lib.js';

const SETTING_KEYS = ['port', 'bind', 'gateway_token', 'logging_enabled'];

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
    s.resolved_port = getSetting('port');
    res.json(s);
  });

  app.put('/api/config', (req, res) => {
    const body = req.body ?? {};
    for (const k of Object.keys(body)) {
      if (SETTING_KEYS.includes(k)) setSetting(k, body[k]);
    }
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

  app.delete('/api/channels/:id', (req, res) => {
    deleteChannel(Number(req.params.id));
    res.json({ ok: true });
  });

  // Fetch a channel's upstream model list (cc-switch style): plain GET /v1/models with a
  // candidate chain. No "test" semantics — this is the model picker's data source.
  // Works both by id (/api/channels/:id/fetch-models) and for an unsaved draft
  // (/api/channels/fetch-models with the draft as body).
  const KNOWN_COMPAT_SUFFIXES = ['/api/claudecode', '/api/anthropic', '/apps/anthropic', '/api/coding', '/claudecode', '/anthropic', '/step_plan', '/coding', '/claude'];

  function endsWithVersionSegment(url) {
    const last = url.split('/').pop() ?? '';
    return /^v\d+$/.test(last);
  }

  function stripCompatSuffix(base) {
    for (const s of KNOWN_COMPAT_SUFFIXES) {
      if (base.endsWith(s)) return base.slice(0, base.length - s.length);
    }
    return null;
  }

  function buildModelsUrlCandidates(rawBase) {
    const base = String(rawBase ?? '').trim().replace(/\/+$/, '');
    if (!base) return [];
    const candidates = [];
    if (endsWithVersionSegment(base)) {
      // base already ends with a version segment (/v1, zhipu /api/coding/paas/v4 ...):
      // the models endpoint is {base}/models; appending /v1 would 404.
      candidates.push(base + '/models');
      if (!base.endsWith('/v1')) candidates.push(base + '/v1/models');
    } else {
      candidates.push(base + '/v1/models');
    }
    const stripped = stripCompatSuffix(base);
    if (stripped) {
      const root = stripped.replace(/\/+$/, '');
      if (root) {
        candidates.push(root + '/v1/models');
        candidates.push(root + '/models');
      }
    }
    return [...new Set(candidates)];
  }

  async function fetchChannelModels(c, res) {
    const base = String(c.base_url ?? '').trim();
    if (!base) {
      res.json({ models: [], error: 'base_url 为空' });
      return;
    }
    const candidates = buildModelsUrlCandidates(base);
    const headers = {};
    const firstKey = String(c.api_key ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
    if (firstKey) {
      if (c.auth_mode === 'bearer') headers['authorization'] = 'Bearer ' + firstKey;
      else if (c.auth_mode === 'x-api-key') headers['x-api-key'] = firstKey;
      else if (c.auth_mode === 'x-goog-api-key') headers['x-goog-api-key'] = firstKey;
    }
    headers['accept-encoding'] = 'identity';
    let models = [];
    let error = candidates.length ? '' : '无法从 base_url 推导模型列表端点';
    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
        if (r.ok) {
          const j = await r.json().catch(() => null);
          const seen = new Set();
          const got = [];
          for (const m of (j?.data ?? [])) {
            const id = String(m?.id ?? m?.name ?? '').trim();
            if (id && !seen.has(id) && seen.size < 400) {
              seen.add(id);
              got.push(id);
            }
          }
          if (got.length) {
            models = got.sort();
            break;
          }
          error = '上游 ' + url + ' 未返回有效模型列表';
        } else if (r.status === 404 || r.status === 405) {
          // cc-switch rule: only 404/405 move on to the next candidate.
          error = '上游 ' + url + ' 返回 ' + r.status;
          continue;
        } else {
          error = '上游 ' + url + ' 返回 ' + r.status;
          break;
        }
      } catch (e) {
        error = String(e?.message ?? e);
        break;
      }
    }
    res.json({ models, error });
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
      entries: listLogs('capture', 50),
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