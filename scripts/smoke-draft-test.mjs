// Smoke: POST /api/channels/fetch-models (unsaved draft) should hit upstream /v1/models and return the model list.
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const tmpDb = join(root, 'data', 'smoke-test.db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fake = await import('./fake-upstream.mjs');

process.env.LAPI_DB = tmpDb;
process.env.LAPI_NO_WAL = '1';
await rm(tmpDb, { force: true }).catch(() => {});
await rm(tmpDb + '-wal', { force: true }).catch(() => {});
await rm(tmpDb + '-shm', { force: true }).catch(() => {});

const child = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: root,
  env: { ...process.env, LAPI_DB: tmpDb, LAPI_NO_WAL: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += String(d); });
let port = null;
for (let i=0; i<50; i++) {
  if (fake.ready) break;
  await sleep(100);
}
for (let i=0; i<50; i++) {
  const m = out.match(/listening on http:\/\/[^:]+:(\d+)/);
  if (m) { port = Number(m[1]); break; }
  await sleep(100);
}
if (!port) throw new Error('server did not come up; output: ' + out);

const r = await fetch('http://127.0.0.1:' + port + '/api/channels/fetch-models', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    base_url: 'http://127.0.0.1:8999',
    api_key: 'sk-smoke',
    auth_mode: 'bearer',
  }),
});
const j = await r.json();
console.log('draft fetch-models status', r.status, 'error', j.error || '-', 'models', (j.models ?? []).slice(0, 6).join(', '), 'count', (j.models ?? []).length);
if (j.error) throw new Error('draft fetch-models failed: ' + j.error);
const gotModels = j.models ?? [];
if (!gotModels.length) throw new Error('expected a non-empty model list from fake upstream');
console.log('SMOKE PASS');

child.kill('SIGTERM');
await sleep(300);
if (child.exitCode == null) child.kill('SIGKILL');
fake.server.close();
await sleep(100);
await rm(tmpDb, { force: true }).catch(() => {});
await rm(tmpDb + '-wal', { force: true }).catch(() => {});
await rm(tmpDb + '-shm', { force: true }).catch(() => {});
process.exit(0);