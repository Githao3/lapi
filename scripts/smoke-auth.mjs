// One-off smoke test: boot the real server the way the container does — every
// credential supplied by environment only, bound to a non-loopback address —
// and confirm the two-credential split holds over real HTTP.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const root = join(import.meta.dirname, '..');
const tmpDb = join(root, 'data', 'smoke-auth.db');
for (const s of ['', '-wal', '-shm', '-journal']) rmSync(tmpDb + s, { force: true });

function ok(cond, msg) {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

const child = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    LAPI_DB: tmpDb,
    LAPI_NO_WAL: '1',
    LAPI_BIND: '0.0.0.0',
    LAPI_PORT: '8891',
    LAPI_ADMIN_PASSWORD: 'pw-smoke',
    LAPI_GATEWAY_TOKEN: 'key-smoke',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('start timeout')), 10000);
  child.stdout.on('data', (c) => {
    out += String(c);
    const m = out.match(/listening on http:\/\/[^:]+:(\d+)/);
    if (m) {
      clearTimeout(t);
      resolve(Number(m[1]));
    }
  });
  child.on('exit', (code) => reject(new Error('exited early ' + code)));
});

const base = 'http://127.0.0.1:' + port;
const json = { 'content-type': 'application/json' };

try {
  const sess = await (await fetch(base + '/api/session')).json();
  ok(sess.auth_required === true, 'env bind 0.0.0.0 -> panel requires login');
  ok(sess.configured === true, 'env admin password is picked up');
  ok(sess.authed === false, 'no session yet');

  ok((await fetch(base + '/api/channels')).status === 401, 'panel closed without a session');
  ok((await fetch(base + '/v1/models')).status === 401, 'relay closed without the user key');

  const asUser = await fetch(base + '/api/config', { headers: { 'x-api-key': 'key-smoke' } });
  ok(asUser.status === 401, 'user key cannot read panel config, got ' + asUser.status);

  const relay = await fetch(base + '/v1/models', { headers: { 'x-api-key': 'key-smoke' } });
  ok(relay.status === 200, 'user key reaches the relay, got ' + relay.status);

  const bad = await fetch(base + '/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'nope' }) });
  ok(bad.status === 401, 'wrong password rejected');

  const login = await fetch(base + '/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'pw-smoke' }) });
  ok(login.status === 200, 'env password logs in, got ' + login.status);
  const { session } = await login.json();

  const cfg = await (await fetch(base + '/api/config', { headers: { authorization: 'Bearer ' + session } })).json();
  ok(cfg.bind === '0.0.0.0', 'bind comes from LAPI_BIND, got ' + cfg.bind);
  ok(cfg.admin_password === undefined, 'admin password never serialized');
  ok(cfg.has_admin_password === true && cfg.has_gateway_token === true, 'flags report both credentials set');

  const html = await (await fetch(base + '/')).text();
  ok(html.includes('<div id="root">'), 'console shell is served');

  console.log('[smoke-auth] ALL ASSERTIONS PASSED (port ' + port + ')');
} catch (e) {
  console.error('[smoke-auth] FAILED:', e.message);
  console.error(out);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await sleep(400);
  if (child.exitCode == null) child.kill('SIGKILL');
  for (const s of ['', '-wal', '-shm', '-journal']) rmSync(tmpDb + s, { force: true });
}
