// Demo seeder: creates a small demo database with 3 channels pointing at
// the local fake upstream (scripts/fake-upstream.mjs, port 8999) for UI walkthroughs.
// Run from project root:  node scripts/seed-demo.mjs
// (File-based UTF-8 write; avoid shell heredocs so Chinese names survive.)

import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dbPath = process.env.LAPI_DB || join(root, 'data', 'demo.db');

for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });

const db = new DatabaseSync(dbPath);
db.exec(`
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
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
`);

const now = Date.now();
const seed = db.prepare(
  'INSERT INTO channels (name, protocol, openai_endpoint, base_url, api_key, auth_mode,' +
  'user_agent_override, header_overrides, model_mapping, models,' +
  'weight, enabled, notes, created_at, updated_at) VALUES ' +
  '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const rows = [
  {
    name: 'Kimi 官方（messages 协议）',
    protocol: 'anthropic', openai_endpoint: 'messages',
    base_url: 'http://127.0.0.1:8999', api_key: 'sk-demo-kimi',
    auth_mode: 'bearer', user_agent_override: '', header_overrides: {},
    model_mapping: {}, models: 'claude-sonnet-4-5,kimi-k2',
    weight: 1, enabled: 1,
    notes: '演示：上游格式 messages；请求 /v1/messages 直达，走 chat 自动转换。',
  },
  {
    name: 'DeepSeek（chat 协议）',
    protocol: 'openai', openai_endpoint: 'chat',
    base_url: 'http://127.0.0.1:8999', api_key: 'sk-demo-deepseek',
    auth_mode: 'bearer', user_agent_override: '', header_overrides: {},
    model_mapping: {}, models: 'gpt-4o,gpt-4o-mini',
    weight: 1, enabled: 1,
    notes: '演示：上游格式 chat；请求 /v1/chat/completions 直达。',
  },
  {
    name: 'OpenRouter（responses 协议，停用示例）',
    protocol: 'openai', openai_endpoint: 'responses',
    base_url: 'http://127.0.0.1:8999', api_key: 'sk-demo-openrouter',
    auth_mode: 'x-api-key', user_agent_override: '', header_overrides: {},
    model_mapping: {}, models: 'gpt-4o-mini',
    weight: 1, enabled: 0,
    notes: '演示：停用渠道不出现在候选池；请求 /v1/responses 需要启用后才有路由。',
  },
];
for (const r of rows) {
  seed.run(
    r.name, r.protocol, r.openai_endpoint,
    r.base_url, r.api_key, r.auth_mode,
    r.user_agent_override, JSON.stringify(r.header_overrides),
    JSON.stringify(r.model_mapping), r.models,
    r.weight, r.enabled ? 1 : 0, r.notes, now, now
  );
}
db.exec("INSERT INTO settings (key, value) VALUES ('port', '8787') ON CONFLICT(key) DO NOTHING");
db.close();
console.log('seeded demo db:', dbPath, '—', rows.length, 'channels');