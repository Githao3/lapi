// SQLite persistence layer. Uses built-in node:sqlite, zero native deps.
// Tables: channels, logs, settings. Sync API, fine for personal use.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });

export const DB_PATH = process.env.LAPI_DB ? process.env.LAPI_DB : join(dataDir, 'lapi.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = ${process.env.LAPI_NO_WAL === '1' ? 'DELETE' : 'WAL'};
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'anthropic',
    openai_endpoint TEXT NOT NULL DEFAULT 'chat',
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    auth_mode TEXT NOT NULL DEFAULT 'bearer',
    user_agent_override TEXT NOT NULL DEFAULT '',
    header_overrides TEXT NOT NULL DEFAULT '{}',
    model_mapping TEXT NOT NULL DEFAULT '{}',
    models TEXT NOT NULL DEFAULT '',
    weight INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    client_preset TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT '',
    channel_id INTEGER,
    channel_name TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    status INTEGER,
    ms INTEGER,
    error TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_logs_kind_ts ON logs(kind, ts);
`);
// Migrate pre-2026-09 databases: add openai_endpoint (default 'chat', so existing OpenAI channels keep working);
// add client_preset (client impersonation profile reference; empty = UA-only impersonation).
try {
  const cols = db.prepare('PRAGMA table_info(channels)').all();
  if (!cols.some((c) => c.name === 'openai_endpoint')) {
    db.exec("ALTER TABLE channels ADD COLUMN openai_endpoint TEXT NOT NULL DEFAULT 'chat'");
  }
  if (!cols.some((c) => c.name === 'client_preset')) {
    db.exec("ALTER TABLE channels ADD COLUMN client_preset TEXT NOT NULL DEFAULT ''");
  }
} catch {}

// ---------- settings ----------

const DEFAULTS = {
  port: '8787',
  bind: '127.0.0.1',
  gateway_token: '',
  admin_password: '',
  capture_enabled: '0',
  logging_enabled: '1',
  upstream_proxy: '',
  upstream_proxy_bypass: '',
};

// Deployment bootstrap: a container/host has no way to use the settings UI before
// it can reach it, so these four may be seeded from the environment. A DB row
// written by the Settings page always wins; env only fills the gap before that.
const ENV_DEFAULTS = {
  bind: 'LAPI_BIND',
  port: 'LAPI_PORT',
  gateway_token: 'LAPI_GATEWAY_TOKEN',
  admin_password: 'LAPI_ADMIN_PASSWORD',
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  const envName = ENV_DEFAULTS[key];
  const env = envName ? process.env[envName] : undefined;
  if (env != null && String(env) !== '') return String(env);
  return DEFAULTS[key] ?? '';
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(String(key), String(value));
}

export function allSettings() {
  const keys = new Set(Object.keys(DEFAULTS));
  for (const r of db.prepare('SELECT key FROM settings').all()) keys.add(r.key);
  const out = {};
  for (const k of keys) {
    if (k === 'admin_password') continue; // never leaves the server
    out[k] = getSetting(k);
  }
  return out;
}

// ---------- channels ----------

function rowToChannel(r) {
  const c = { ...r };
  c.enabled = !!c.enabled;
  c.client_preset = String(c.client_preset ?? '');
  c.header_overrides = JSON.parse(c.header_overrides ?? '{}');
  c.model_mapping = JSON.parse(c.model_mapping ?? '{}');
  return c;
}

export function listChannels() {
  const rows = db.prepare('SELECT * FROM channels ORDER BY id DESC').all();
  return rows.map(rowToChannel);
}

export function getChannel(id) {
  const r = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  return r ? rowToChannel(r) : null;
}

export function insertChannel(data) {
  const now = Date.now();
  const r = db.prepare(
    'INSERT INTO channels (name, protocol, openai_endpoint, base_url, api_key, auth_mode,' +
    'user_agent_override, header_overrides, model_mapping, models,' +
    'weight, enabled, notes, client_preset, created_at, updated_at) VALUES ' +
    '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    String(data.name ?? ''), String(data.protocol ?? 'anthropic'),
    String(data.openai_endpoint ?? 'chat'),
    String(data.base_url ?? ''), String(data.api_key ?? ''),
    String(data.auth_mode ?? 'bearer'),
    String(data.user_agent_override ?? ''),
    JSON.stringify(data.header_overrides ?? {}),
    JSON.stringify(data.model_mapping ?? {}),
    String(data.models ?? ''), Number(data.weight ?? 0),
    data.enabled ? 1:  0,
    String(data.notes ?? ''), String(data.client_preset ?? ''), now, now
  );
  return Number(r.lastInsertRowid);
}

export function updateChannel(id, data) {
  const now = Date.now();
db.prepare(
    'UPDATE channels SET name = ?, protocol = ?, openai_endpoint = ?, base_url = ?, api_key = ?,' +
    'auth_mode = ?, user_agent_override = ?, header_overrides = ?,' +
    'model_mapping = ?, models = ?, weight = ?, enabled = ?, notes = ?,' +
    'client_preset = ?, updated_at = ? WHERE id = ?'
  ).run(
    String(data.name ?? ''), String(data.protocol ?? 'anthropic'),
    String(data.openai_endpoint ?? 'chat'),
    String(data.base_url ?? ''), String(data.api_key ?? ''),
    String(data.auth_mode ?? 'bearer'),
    String(data.user_agent_override ?? ''),
    JSON.stringify(data.header_overrides ?? {}),
    JSON.stringify(data.model_mapping ?? {}),
    String(data.models ?? ''), Number(data.weight ?? 0),
    data.enabled ? 1:  0,
    String(data.notes ?? ''), String(data.client_preset ?? ''), now, Number(id)
  );
}

export function deleteChannel(id) {
  db.prepare('DELETE FROM channels WHERE id = ?').run(id);
}

// ---------- client preset references ----------

// Deleting a preset must not leave channels pointing at a ghost: clear refs.
export function clearChannelPresetRefs(name) {
  const r = db.prepare("UPDATE channels SET client_preset = '' WHERE client_preset = ?").run(String(name));
  return Number(r.changes);
}

// Renaming a preset keeps every channel reference pointing at the new name.
export function renameChannelPresetRefs(oldName, newName) {
  const r = db.prepare('UPDATE channels SET client_preset = ? WHERE client_preset = ?').run(String(newName), String(oldName));
  return Number(r.changes);
}

// ---------- logs ----------

export function insertLog(entry) {
  db.prepare(
    'INSERT INTO logs (ts, kind, path, method, channel_id, channel_name,' +
    'model, status, ms, error, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    Date.now(), String(entry.kind ?? ''), String(entry.path ?? ''),
    String(entry.method ?? ''), entry.channel_id ?? null,
    String(entry.channel_name ?? ''), String(entry.model ?? ''),
    entry.status ?? null, entry.ms ?? null,
    String(entry.error ?? String.fromCharCode(39,39)), JSON.stringify(entry.detail ?? {}),
  );
  // No eviction here: relay logs and capture records persist until the owner
  // cleans them up explicitly (Logs page -> 清理). The two kinds must not
  // evict each other — agent traffic once wiped every capture record.
}

export function listLogs(kind = null, limit = 100) {
  // kind = NULL would make "kind = ?" never match; omit the WHERE for "all logs".
  const rows = kind
    ? db.prepare('SELECT * FROM logs WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, Number(limit)) || 100
    : db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(Number(limit)) || 100;
  return rows.map((r) => {
    const o = { ...r };
    o.detail = JSON.parse(o.detail ?? '{}');
    return o;
  });
}

export function clearLogs(kind) {
  if (kind) {
    db.prepare('DELETE FROM logs WHERE kind = ?').run(kind);
  } else {
    db.exec('DELETE FROM logs');
  }
}

// ---------- retention (manual cleanup; nothing is deleted automatically) ----------

// kind = 'relay' | 'capture' scopes every number to that kind; omitted = whole table.
function scopeOf(kind) {
  return kind === 'relay' || kind === 'capture' ? kind : null;
}

export function logsSummary(kind) {
  const k = scopeOf(kind);
  const scoped = k ? ' WHERE kind = ?' : '';
  const args = k ? [k] : [];
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM logs' + scoped).get(...args).n);
  const relay = Number(db.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind = 'relay'").get().n);
  const capture = Number(db.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind = 'capture'").get().n);
  const range = db.prepare('SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM logs' + scoped).get(...args);
  return {
    total,
    relay,
    capture,
    oldest_ts: range.oldest == null ? null : Number(range.oldest),
    newest_ts: range.newest == null ? null : Number(range.newest),
  };
}

export function countLogsBefore(ts, kind) {
  const k = scopeOf(kind);
  const r = db.prepare('SELECT COUNT(*) AS n FROM logs WHERE ts < ?' + (k ? ' AND kind = ?' : '')).get(...(k ? [Number(ts), k] : [Number(ts)]));
  return Number(r.n);
}

// Deletes log rows older than the given timestamp, scoped to a kind when given.
// Returns how many rows were removed.
export function deleteLogsBefore(ts, kind) {
  const k = scopeOf(kind);
  const r = db.prepare('DELETE FROM logs WHERE ts < ?' + (k ? ' AND kind = ?' : '')).run(...(k ? [Number(ts), k] : [Number(ts)]));
  return Number(r.changes);
}

export function countChannels() {
  const r = db.prepare('SELECT COUNT(*) AS n FROM channels WHERE enabled = 1').get();
return Number(r.n);
}

export default db;
// ---------- usage stats (new-api/sub2api style, live aggregation) ----------

// Aggregate relay logs over a range into KPIs + bucketed trend + rankings.
// Buckets: 24h -> hourly, 7d/30d -> daily. Integer-truncated ms buckets.
export function collectStats(range) {
  const days = range === '24h' ? 1 : range === '7d' ? 7 : 30;
  const bucketMs = range === '24h' ? 3600000 : 86400000;
  const since = Date.now() - days * 86400000;
  const rows = db.prepare("SELECT ts, model, channel_name, status, ms, detail FROM logs WHERE kind = 'relay' AND ts >= ?").all(since);
  const rowsPrev = db.prepare("SELECT ts, model, channel_name, status, ms, detail FROM logs WHERE kind = 'relay' AND ts >= ? AND ts < ?").all(since - days * 86400000, since);

  const bucketCount = range === '24h' ? 24 : days;
  const nowBucket = Math.floor(Date.now() / bucketMs);
  const trend = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    const b = (nowBucket - i) * bucketMs;
    trend.push({ bucket: b, requests: 0, input_tokens: 0, output_tokens: 0 });
  }
  const byIndex = new Map(trend.map((t, i) => [t.bucket, i]));

  const totals = { requests: 0, ok: 0, fail: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: 0 };
  let totalMs = 0;
  let rpmCount = 0;
  let rpmTokens = 0;
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const byModel = new Map();
  const seriesMap = new Map();
  const byChannel = new Map();
  const bump = (map, key, input, output) => {
    if (!key) return;
    const e = map.get(key) ?? { name: key, requests: 0, input_tokens: 0, output_tokens: 0 };
    e.requests++;
    e.input_tokens += input;
    e.output_tokens += output;
    map.set(key, e);
  };
  for (const r of rows) {
    const st = Number(r.status) || 0;
    if (st >= 200 && st < 400) totals.ok++;
    else if (st >= 400) totals.fail++;
    let u = null;
    try { u = JSON.parse(r.detail || '{}').usage ?? null; } catch { /* malformed detail */ }
    const input = Number(u?.input_tokens ?? 0);
    const output = Number(u?.output_tokens ?? 0);
    totals.input_tokens += input;
    totals.output_tokens += output;
    totals.cache_read += Number(u?.cache_read_input_tokens ?? 0);
    totals.cache_creation += Number(u?.cache_creation_input_tokens ?? 0);
    totalMs += Number(r.ms ?? 0);
    if (r.ts >= fiveMinAgo) { rpmCount++; rpmTokens += input + output; }
    const bi = byIndex.get(Math.floor(r.ts / bucketMs) * bucketMs);
    if (bi != null) { trend[bi].requests++; trend[bi].input_tokens += input; trend[bi].output_tokens += output; }
    bump(byModel, r.model, input, output);
    const bi2 = byIndex.get(Math.floor(r.ts / bucketMs) * bucketMs);
    if (bi2 != null && r.model) {
      const key = bi2 + '|' + r.model;
      const e2 = seriesMap.get(key) ?? { bucket: trend[bi2].bucket, model: r.model, requests: 0, input_tokens: 0, output_tokens: 0 };
      e2.requests++; e2.input_tokens += input; e2.output_tokens += output;
      seriesMap.set(key, e2);
    }
    bump(byChannel, r.channel_name, input, output);
  }
  const rank = (map) => [...map.values()].sort((a, b) => b.requests - a.requests || b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
  totals.requests = rows.length;
  const prev = { requests: 0, input_tokens: 0, output_tokens: 0 };
  for (const r of rowsPrev) {
    prev.requests++;
    let u2 = null;
    try { u2 = JSON.parse(r.detail || '{}').usage ?? null; } catch { /* ignore */ }
    prev.input_tokens += Number(u2?.input_tokens ?? 0);
    prev.output_tokens += Number(u2?.output_tokens ?? 0);
  }
  return {
    prev_totals: prev,
    range,
    bucket_ms: bucketMs,
    totals: {
      ...totals,
      success_rate: rows.length ? Math.round((totals.ok / rows.length) * 1000) / 10 : 0,
      avg_ms: rows.length ? Math.round(totalMs / rows.length) : 0,
    },
    rpm: Math.round((rpmCount / 5) * 10) / 10,
    tpm: Math.round(rpmTokens / 5),
    trend,
    trend_by_model: [...seriesMap.values()].sort((x, y) => x.bucket - y.bucket),
    by_model: rank(byModel),
    by_channel: rank(byChannel),
  };
}
