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
`);

// Migrate pre-2026-09 databases: add openai_endpoint (default 'chat', so existing OpenAI channels keep working).
try {
  const cols = db.prepare('PRAGMA table_info(channels)').all();
  if (!cols.some((c) => c.name === 'openai_endpoint')) {
    db.exec("ALTER TABLE channels ADD COLUMN openai_endpoint TEXT NOT NULL DEFAULT 'chat'");
  }
} catch {}

// ---------- settings ----------

const DEFAULTS = {
  port: '8787',
  bind: '127.0.0.1',
  gateway_token: '',
  capture_enabled: '0',
  logging_enabled: '1',
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (DEFAULTS[key] ?? '');
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(String(key), String(value));
}

export function allSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) {
    out[r.key] = r.value;
  }
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in out)) out[k] = DEFAULTS[k];
  }
  return out;
}

// ---------- channels ----------

function rowToChannel(r) {
  const c = { ...r };
  c.enabled = !!c.enabled;
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
    'weight, enabled, notes, created_at, updated_at) VALUES ' +
    '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
    String(data.notes ?? ''), now, now
  );
  return Number(r.lastInsertRowid);
}

export function updateChannel(id, data) {
  const now = Date.now();
db.prepare(
    'UPDATE channels SET name = ?, protocol = ?, openai_endpoint = ?, base_url = ?, api_key = ?,' +
    'auth_mode = ?, user_agent_override = ?, header_overrides = ?,' +
    'model_mapping = ?, models = ?, weight = ?, enabled = ?, notes = ?,' +
    'updated_at = ? WHERE id = ?'
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
    String(data.notes ?? ''), now, Number(id)
  );
}

export function deleteChannel(id) {
  db.prepare('DELETE FROM channels WHERE id = ?').run(id);
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
  // keep last 1000 rows
  db.exec('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 1000)');
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

export function countChannels() {
  const r = db.prepare('SELECT COUNT(*) AS n FROM channels WHERE enabled = 1').get();
return Number(r.n);
}

export default db;