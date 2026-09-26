// End-to-end: starts fake upstream (in-process) and the real lapi server (child， temp DB)，
// seeds test channels, then asserts routing / header rewrite / failover / capture / models list。

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const root = join(import.meta.dirname, '..');
let childOutput = '';
let childErr = '';
const tmpDb = join(root, 'data', 'e2e.db');

process.env.LAPI_DB = tmpDb;
process.env.LAPI_NO_WAL = '1';

const fake = await import('./fake-upstream.mjs');

function ok(cond, msg) {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('seed/api failed ' + r.status + ' ' + url);
  return r;
}

async function seedChannels(base) {
  await postJson(base + '/api/channels', {
    name: 'anthropic-e2e',
    protocol: 'anthropic',
    base_url: 'http://127.0.0.1:8999',
    models: 'claude-sonnet-4-5,tool-msg,unauthorized',
    api_key: 'sk-up-12345',
    auth_mode: 'bearer',
    user_agent_override: 'e2e-ua',
    enabled: true,
  });
 await postJson(base + '/api/channels', {
    name: 'openai-e2e',
    protocol: 'openai',
    base_url: 'http://127.0.0.1:8999',
    models: 'gpt-4o,img-echo,sse-chat,slow-sse,sse-tools-chat,tool-chat',
    api_key: 'sk-up-67890',
    auth_mode: 'x-api-key',
    enabled: true,
  });
 await postJson(base + '/api/channels', {
    name: 'responses-e2e',
    protocol: 'openai',
    openai_endpoint: 'responses',
    base_url: 'http://127.0.0.1:8999',
    models: 'gpt-4o-r,sse-resp,sse-tools-resp,trunc-resp',
    api_key: 'sk-resp-111',
    auth_mode: 'bearer',
    enabled: true,
  });
 await postJson(base + '/api/channels', {
    name: 'sse-e2e',
    protocol: 'anthropic',
    base_url: 'http://127.0.0.1:8999',
    models: 'sse-x,flaky-*,sse-tools-msg',
    api_key: 'sk-flaky',
    auth_mode: 'bearer',
    enabled: true,
  });
}


function removeDbFiles() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(tmpDb + suffix, { force: true });
  }
}
async function startServer() {
  const child = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: root,
    env: { ...process.env, LAPI_DB: tmpDb },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
let out = '';
let portFound = Number.NaN;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { const e = new Error("start timeout"); reject(e); }, 10000);
    child.stdout.on('data', (c) => {
      childOutput += String(c);
      const pm = childOutput.match(/listening on http:\/\/[^:]+:(\d+)/);
      if (pm) {
        portFound = Number(pm[1]);
        clearTimeout(t);
        resolve();
      }
    });
    child.stderr.on('data', (c) => { childErr += String(c); });
    child.on('exit', (code) => {
      clearTimeout(t);
      reject(new Error('server exited early: ' + code));
    });
  });
  return { child, port: portFound };
}

function lastHit(model) {
  return fake.hits.filter((h) => h.model === model).at(-1) ?? null;
}

async function main() {
  removeDbFiles();
  const { child, port: basePort } = await startServer();
  const base0 = 'http://127.0.0.1:' + basePort;
 await seedChannels(base0);
console.log('[e2e] server up, port ' + basePort);
// 端口稳定性：冲突顺延只影响本次（active_port），优先端口设置不被覆盖
{
  const cfg0 = await (await fetch('http://127.0.0.1:' + basePort + '/api/config')).json();
  ok(cfg0.resolved_port === String(basePort), 'resolved_port reflects the bound port, got ' + cfg0.resolved_port);
  ok(cfg0.port === '8787', 'preferred port setting stays 8787, got ' + cfg0.port);
}
child.on('exit', (code) => console.log('[e2e][child-exit] code ' + code));
try {
      const probe = await fetch('http://127.0.0.1:' + basePort + '/');
      console.log('[e2e][probe] root GET status ' + probe.status + ' body ' + JSON.stringify(await probe.text()));
    } catch (e) {
      console.log('[e2e][probe] root GET FAILED ' + e.message);
    }

try {
    const base = base0;
    const headers = { 'content-type': 'application/json' };

// A: anthropic routing + header rewriting
    {
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer sk-client-whatever' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r.status === 200, 'anthropic status ' + r.status);
      const j = await r.json();
      const h = lastHit('claude-sonnet-4-5');
      ok(h,'upstream saw the request');
      ok(j.type === 'message', 'anthropic payload type');
      ok(h.host === '127.0.0.1:8999', 'host rewritten to upstream, got ' + h.host);
      ok(h.auth === 'Bearer sk-up-12345', 'channel key injected, got ' + h.auth);
      ok(h.ua === 'e2e-ua', 'UA override applied');
      ok(h.acceptEncoding === 'identity', 'accept-encoding identity');
      ok(h.anthropicVersion === '2023-06-01', 'anthropic-version default injected');
    }

    // B: openai routing, x-api-key injection, UA passthrough
    {
      const r2 = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer client-token', 'user-agent': 'client-e2e-ua' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r2.status === 200, 'openai status ' + r2.status);
      const h = lastHit('gpt-4o');
      ok(h.xkey === 'sk-up-67890', 'x-api-key injected');
      ok(h.ua === 'client-e2e-ua', 'UA passthrough when no override');
      ok(h.anthropicVersion == null, 'no anthropic-version for openai');
    }

    // C: SSE anthropic stream relay
    {
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'sse-x', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r.status === 200, 'sse status');
      const text = await r.text();
      ok(text.includes('content_block_delta'), 'sse chunks relayed');
      ok(text.includes('[DONE]'), 'sse terminator relayed');
    }

    // D: 429 with retry-after -> one retry -> success
    {
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'flaky-429', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r.status === 200, '429 retry then success, got ' + r.status);
      ok(fake.counts['flaky-429'] === 2, 'upstream saw 2 attempts');
    }

    // E: persistent 5xx -> two attempts then 502 w/ error， unending hang guard
    {
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'flaky-500', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r.status === 502, '5xx exhausted -> 2, got ' + r.status);
      ok(fake.counts['flaky-500'] === 2, '5xx saw exactly 2 attempts');
      const j = await r.json().catch(() => ({}));
      ok(String(j?.error?.message ?? j?.message ?? '').includes('relay failed'), '502 payload explains failure');
    }

    // F: mid-stream drop -> exactly 1 attempt, partial body still delivered
    {
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'flaky-drop', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r.status === 200, 'drop: client got headers');
      const text = await r.text();
      ok(text.includes('message_start'), 'drop: partial bytes relayed');
      ok(fake.counts['flaky-drop'] === 1, 'drop: never retried after bytes');
    }

// G: capture mode -> not forwarded, RAW headers logged (preset source material)
    {
      await postJson(base + '/api/capture/toggle', { enabled: true });
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer sk-secret-client' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r.status === 400, 'capture mode returns 400');
      const text = await r.text();
      ok(text.includes('INCOMING HEADERS'), 'capture payload shows incoming headers');
      ok(text.includes('sk-secret-client'), 'capture echoes raw headers verbatim (by design)');
      ok(fake.counts['claude-sonnet-4-5'] === 1, 'capture never forwards (count unchanged');
      const caps = (await (await fetch(base + '/api/capture')).json()).entries;
      ok(caps.length === 1, 'capture entry logged');
      ok(caps[0].detail?.inHeaders, 'capture entry keeps inHeaders');
      ok(caps[0].detail.inHeaders.authorization === 'Bearer sk-secret-client', 'capture stores raw credential (no masking)');
      await postJson(base + '/api/capture/toggle', { enabled: false });
    }

// H: models list shape varies by protocol header
    {
      const r1 = await fetch(base + '/v1/models', { headers: { 'anthropic-version': '2023-06-01' } });
      const j1 = await r1.json();
      ok(j1.data.some((m) => m.id === 'claude-sonnet-4-5'), 'anthropic models list contains routed model');
      ok(j1.data.every((m) => m.type === 'model'), 'anthropic list uses model type');
      const r2 = await fetch(base + '/v1/models');
      const j2 = await r2.json();
      ok(j2.object === 'list', 'openai list shape');
      ok(j2.data.some((m) => m.id === 'gpt-4o'), 'openai models list contains gpt-4o');
      ok(j2.data.some((m) => m.id === 'gpt-4o-r'), 'openai models list contains responses-endpoint model');
    }

    // I: channel-declared /v1/responses endpoint routing (上游按渠道声明端点转发
    {
      const r = await fetch(base + '/v1/responses', {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer client-token-2' },
        body: JSON.stringify({ model: 'gpt-4o-r', input: 'hi' }),
      });
      ok(r.status === 200, 'responses status ' + r.status);
      const h = lastHit('gpt-4o-r');
      ok(h != null, 'responses hit recorded');
      ok(h.url === '/v1/responses', 'responses forwarded to /v1/responses, got ' + h.url);
      ok(h.auth === 'Bearer sk-resp-111', 'responses channel key injected, got ' + h.auth);
      ok(h.anthropicVersion == null, 'no anthropic-versionfor openai responses');

    }

    // J: endpoint mismatch is now auto-converted (v1 converts text dialogues between the three formats
    {
      const r1 = await fetch(base + '/v1/responses', {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer client-token-3' },
        body: JSON.stringify({ model: 'gpt-4o', input: 'hi' }),
      });
      ok(r1.status === 200, 'responses-client to chat-upstream status ' + r1.status);
      const j1 = await r1.json();
      ok(j1.object === 'response', 'responses envelope preserved, got ' + j1.object);
      ok(j1.output[0].content[0].text === 'pong', 'responses text converted from upstream chat');
      ok(lastHit('gpt-4o').url === '/v1/chat/completions', 'responses request forwarded to chat endpoint');
    }
    {
      const r2 = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer client-token-3' },
        body: JSON.stringify({ model: 'gpt-4o-r', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r2.status === 200, 'chat-client to responses-upstream status ' + r2.status);
      const j2 = await r2.json();
      ok(j2.object === 'chat.completion', 'chat envelope preserved, got ' + j2.object);
      ok(j2.choices[0].message.content === 'pong', 'chat text converted from upstream responses');
      ok(lastHit('gpt-4o-r').url === '/v1/responses', 'chat request forwarded to responses endpoint');
    }
    {
      const r3 = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer client-token-3' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }),
      });
      ok(r3.status === 200, 'messages-client to chat-upstream status ' + r3.status);
      const j3 = await r3.json();
      ok(j3.type === 'message', 'anthropic envelope preserved, got ' + j3.type);
      ok(j3.content[0].text === 'pong', 'messages text converted from upstream chat');
      ok(lastHit('gpt-4o').url === '/v1/chat/completions', 'messages request forwarded to chat endpoint');
    }
    {
      const r4 = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer client-token-3' },
        body: JSON.stringify({ model: 'sse-x', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      });
      ok(r4.status === 200, 'SSE chat-client to messages-upstream status ' + r4.status);
      const t4 = await r4.text();
      const deltas = (t4.match(/"content":"hi/g) ?? []).length;
      ok(deltas === 4, 'SSE converted back to chat deltas, got ' + deltas);
      ok(t4.includes('data: [DONE]'), 'SSE chat stream ends with [DONE]');
      ok(lastHit('sse-x').url === '/v1/messages', 'SSE chat request forwarded to messages endpoint');
    }

    // K: tools round trip — chat client -> anthropic upstream (non-stream)
    {
      const r = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'tool-msg',
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
          tool_choice: 'auto',
        }),
      });
      ok(r.status === 200, 'K status ' + r.status);
      const j = await r.json();
      const h = lastHit('tool-msg');
      ok(h != null, 'K upstream hit recorded');
      ok(h.url === '/v1/messages', 'K forwarded to /v1/messages, got ' + h.url);
      ok(Array.isArray(h.body?.tools) && h.body.tools[0]?.name === 'get_weather', 'K upstream tools[0].name converted to anthropic shape, got ' + JSON.stringify(h.body?.tools));
      ok(h.body.tools[0]?.input_schema?.type === 'object', 'K upstream tools[0].input_schema.type is object, got ' + JSON.stringify(h.body?.tools?.[0]?.input_schema));
      const tc = j.choices?.[0]?.message?.tool_calls?.[0];
      ok(tc?.function?.name === 'get_weather', 'K client tool_calls[0].function.name get_weather, got ' + JSON.stringify(tc));
      let args = null;
      try { args = JSON.parse(tc.function.arguments); } catch { /* covered by assert below */ }
      ok(args && args.city === 'Paris', 'K tool arguments parse to {city:Paris}, got ' + JSON.stringify(tc?.function?.arguments));
      ok(j.choices[0].finish_reason === 'tool_calls', 'K finish_reason tool_calls, got ' + j.choices[0].finish_reason);
      ok(h.anthropicVersion === '2023-06-01', 'Q openai-format client -> anthropic channel carries anthropic-version, got ' + h.anthropicVersion);
    }

    // L: images — messages client -> openai chat upstream (non-stream)
    {
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'img-echo',
          max_tokens: 64,
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
          ] }],
        }),
      });
      ok(r.status === 200, 'L status ' + r.status);
      const j = await r.json();
      const h = lastHit('img-echo');
      ok(h != null, 'L upstream hit recorded');
      ok(h.url === '/v1/chat/completions', 'L forwarded to /v1/chat/completions, got ' + h.url);
      const content = h.body?.messages?.[0]?.content;
      ok(Array.isArray(content), 'L upstream messages[0].content is an array, got ' + JSON.stringify(content));
      const img = content.find((p) => p && p.type === 'image_url');
      ok(img?.image_url?.url === 'data:image/png;base64,aGVsbG8=', 'L image converted to chat image_url data url, got ' + JSON.stringify(img));
      ok(content.some((p) => p && p.type === 'text'), 'L text part preserved alongside image');
      ok(j.type === 'message', 'L anthropic envelope preserved, got ' + j.type);
      ok(j.content?.[0]?.text === 'image-ok', 'L client content[0].text image-ok, got ' + JSON.stringify(j.content));
      ok(h.anthropicVersion == null, 'Q messages client -> openai channel carries NO anthropic-version, got ' + h.anthropicVersion);
    }

    // M: SSE tools — chat client stream -> anthropic upstream
    {
      const r = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'sse-tools-msg', stream: true, messages: [{ role: 'user', content: 'weather?' }] }),
      });
      ok(r.status === 200, 'M status ' + r.status);
      const t = await r.text();
      ok(t.includes('"tool_calls"'), 'M stream contains tool_calls fragments');
      ok(t.includes('get_weather'), 'M stream carries tool name get_weather');
      ok(t.includes('{\\"city\\"'), 'M stream carries partial arguments {"city": escaped, got ' + JSON.stringify(t.slice(0, 400)));
      ok(t.includes('"finish_reason":"tool_calls"'), 'M stream carries finish_reason tool_calls');
      ok(t.includes('data: [DONE]'), 'M stream ends with [DONE]');
      ok(lastHit('sse-tools-msg')?.url === '/v1/messages', 'M upstream hit on /v1/messages, got ' + lastHit('sse-tools-msg')?.url);
    }

    // N: responses SSE -> messages client (text + usage mapping)
    {
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'sse-resp', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r.status === 200, 'N status ' + r.status);
      const t = await r.text();
      ok(t.includes('event: message_start'), 'N stream has message_start');
      ok(t.includes('"model":"sse-resp"'), 'N message_start echoes model, got ' + JSON.stringify(t.slice(0, 300)));
      const deltas = (t.match(/"type":"text_delta"/g) ?? []).length;
      ok(deltas === 3, 'N exactly 3 text_delta content_block_delta events, got ' + deltas);
      ok(t.includes('"hi0"') && t.includes('"hi1"') && t.includes('"hi2"'), 'N deltas hi0/hi1/hi2 present');
      ok(t.includes('"stop_reason":"end_turn"'), 'N message_delta stop_reason end_turn');
      ok(t.includes('message_stop'), 'N stream ends with message_stop');
      const mdLine = t.split('\n').find((l) => l.startsWith('data: ') && l.includes('"message_delta"'));
      ok(mdLine, 'N message_delta data line present');
      const md = JSON.parse(mdLine.slice('data: '.length));
      ok(md.usage?.output_tokens === 34, 'N message_delta usage output_tokens 34 mapped from responses usage, got ' + JSON.stringify(md.usage));
    }

    // O: stop/usage mapping via non-stream conversion — chat client -> responses upstream
    {
      const r = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'gpt-4o-r', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r.status === 200, 'O status ' + r.status);
      const j = await r.json();
      ok(j.object === 'chat.completion', 'O chat envelope preserved, got ' + j.object);
      ok(j.usage?.prompt_tokens === 12, 'O usage.prompt_tokens 12 from responses input_tokens, got ' + JSON.stringify(j.usage));
      ok(j.usage?.completion_tokens === 34, 'O usage.completion_tokens 34 from responses output_tokens, got ' + JSON.stringify(j.usage));
      ok(j.choices?.[0]?.finish_reason === 'stop', 'O finish_reason stop from responses completed status, got ' + j.choices?.[0]?.finish_reason);
      ok(lastHit('gpt-4o-r')?.url === '/v1/responses', 'O forwarded to /v1/responses');
    }

    // P: truncation fail-closed — messages client stream -> responses upstream (socket cut)
    {
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'trunc-resp', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r.status === 200, 'P status ' + r.status);
      let hung = false;
      const t = await Promise.race([
        r.text(),
        sleep(10000).then(() => { hung = true; return ''; }),
      ]);
      ok(!hung, 'P client stream read did not hang');
      ok(t.includes('event: error'), 'P stream carries an error event');
      ok(t.includes('stream_truncated'), 'P error type stream_truncated (fail-closed)');
      ok(!t.includes('message_stop'), 'P has no fabricated message_stop');
      ok(fake.counts['trunc-resp'] === 1, 'P never retried after bytes, got ' + fake.counts['trunc-resp']);
    }

    // R: exposed bind — user key guards the relay, admin password guards the panel,
    //    and neither credential can be swapped for the other.
    {
      const putCfg = (body, auth) =>
        fetch(base + '/api/config', {
          method: 'PUT',
          headers: auth ? { ...headers, authorization: auth } : headers,
          body: JSON.stringify(body),
        });
      await putCfg({ bind: '0.0.0.0', gateway_token: 'sk-user-e2e', admin_password: 'admin-e2e-pw' });

      const relayNoKey = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(relayNoKey.status === 401, 'R relay without key -> 401, got ' + relayNoKey.status);
      const j401 = await relayNoKey.json();
      ok(j401?.error?.type === 'authentication_error', 'R anthropic-shaped auth error');
      ok(!String(j401?.error?.message ?? '').includes('sk-user-e2e'), 'R error never echoes the key');

      const relayBadKey = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: { ...headers, 'x-api-key': 'sk-wrong' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(relayBadKey.status === 401, 'R relay with wrong key -> 401, got ' + relayBadKey.status);

      const relayOk = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: { ...headers, 'x-api-key': 'sk-user-e2e' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(relayOk.status === 200, 'R relay with the user key succeeds, got ' + relayOk.status);

      ok((await fetch(base + '/v1/models')).status === 401, 'R /v1/models is guarded too');
      const modelsOk = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer sk-user-e2e' } });
      ok(modelsOk.status === 200, 'R /v1/models accepts the user key');

      const asUser = await fetch(base + '/api/channels', { headers: { authorization: 'Bearer sk-user-e2e' } });
      ok(asUser.status === 401, 'R user key cannot open the admin API, got ' + asUser.status);

      const badLogin = await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'wrong' }) });
      ok(badLogin.status === 401, 'R wrong panel password -> 401');

      const login = await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'admin-e2e-pw' }) });
      ok(login.status === 200, 'R panel login accepted');
      const { session } = await login.json();
      ok(typeof session === 'string' && session.length === 64, 'R session token issued');

      const adminCall = await fetch(base + '/api/channels', { headers: { authorization: 'Bearer ' + session } });
      ok(adminCall.status === 200, 'R session opens the admin API');

      const cfgAuthed = await (await fetch(base + '/api/config', { headers: { authorization: 'Bearer ' + session } })).json();
      ok(cfgAuthed.admin_password === undefined, 'R admin password is never returned');
      ok(cfgAuthed.has_admin_password === true, 'R panel learns only that a password exists');
      ok(cfgAuthed.gateway_token === 'sk-user-e2e', 'R relay key stays readable for the admin');

      const sessProbe = await (await fetch(base + '/api/session', { headers: { authorization: 'Bearer ' + session } })).json();
      ok(sessProbe.auth_required === true && sessProbe.authed === true, 'R session probe reports an authed admin');

      const logout = await fetch(base + '/api/logout', { method: 'POST', headers: { authorization: 'Bearer ' + session } });
      ok(logout.status === 200, 'R logout accepted');
      const sessAfter = await (await fetch(base + '/api/session', { headers: { authorization: 'Bearer ' + session } })).json();
      ok(sessAfter.authed === false, 'R session is dead after logout');
      ok((await fetch(base + '/api/channels', { headers: { authorization: 'Bearer ' + session } })).status === 401, 'R revoked session closes the admin API');

      // Re-login to put the bind back, then confirm the owner's local workflow stays
      // credential-free exactly as before.
      const login2 = await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'admin-e2e-pw' }) });
      const { session: session2 } = await login2.json();
      await putCfg({ bind: '127.0.0.1' }, 'Bearer ' + session2);

      const localRelay = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(localRelay.status === 200, 'R loopback bind needs no key, got ' + localRelay.status);
      ok((await fetch(base + '/api/channels')).status === 200, 'R loopback panel needs no login');
    }

    // S: playground — panel-only chat through the relay pipeline (no user key),
    //    capture bypass, and a mid-stream client abort that keeps the server healthy.
    {
      const pg = (body) => fetch(base + '/api/playground/chat', { method: 'POST', headers, body: JSON.stringify(body) });

      const r1 = await pg({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: false });
      ok(r1.status === 200, 'S playground non-stream status ' + r1.status);
      const j1 = await r1.json();
      ok(String(j1?.choices?.[0]?.message?.content ?? '').length > 0, 'S playground non-stream has content');
      ok(j1?.model === 'gpt-4o', 'S playground echoes the model');

      const r2 = await pg({ model: 'sse-chat', messages: [{ role: 'user', content: 'hi' }], stream: true });
      ok(r2.status === 200, 'S playground stream status ' + r2.status);
      ok((r2.headers.get('content-type') ?? '').includes('text/event-stream'), 'S playground stream content-type');
      const t2 = await r2.text();
      ok(t2.includes('delta'), 'S playground stream carries deltas');
      ok(t2.includes('[DONE]'), 'S playground stream terminates');

      // capture mode must swallow /v1 but not the playground
      await postJson(base + '/api/capture/toggle', { enabled: true });
      const r3 = await pg({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: false });
      ok(r3.status === 200, 'S playground bypasses capture, got ' + r3.status);
      const r4 = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
      });
      ok(r4.status === 400, 'S capture still intercepts /v1, got ' + r4.status);
      await postJson(base + '/api/capture/toggle', { enabled: false });
      await fetch(base + '/api/capture', { method: 'DELETE' });

      // client abort mid-stream: upstream call stops, server stays healthy
      const ac = new AbortController();
      const r5 = await fetch(base + '/api/playground/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'slow-sse', messages: [{ role: 'user', content: 'hi' }], stream: true }),
        signal: ac.signal,
      });
      ok(r5.status === 200, 'S abort: stream started, got ' + r5.status);
      const reader = r5.body.getReader();
      await reader.read(); // first drip arrived
      ac.abort();
      try {
        for (let i = 0; i < 30; i++) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        /* expected: the aborted request rejects the reader */
      }
      const probe = await fetch(base + '/api/config');
      ok(probe.ok, 'S server healthy after client abort');

      // unknown model -> a clear protocol error, not a hang
      const r6 = await pg({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] });
      ok(r6.status === 400, 'S unknown model -> 400, got ' + r6.status);
      const j6 = await r6.json();
      ok(String(j6?.error?.message ?? '').includes('no enabled channel'), 'S unknown model explains why');
    }

    // U: client presets — classify a capture into a draft, then verify the three
    //    modes end-to-end on the relay path (fixed 覆盖 / fill 补位透传 / drop 剔除).
    {
      // 抓一条带 session 的请求作为预设原料
      await postJson(base + '/api/capture/toggle', { enabled: true });
      await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: { ...headers, 'user-agent': 'opencode/9.9.9 test', 'x-session-id': 'ses_capture_1' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
      });
      await postJson(base + '/api/capture/toggle', { enabled: false });
      const caps = (await (await fetch(base + '/api/capture')).json()).entries;
      const cap = caps.find((c) => c.detail?.inHeaders?.['x-session-id'] === 'ses_capture_1');
      ok(cap, 'U capture with session header exists');

      const draft = await (await fetch(base + '/api/client-presets/draft', {
        method: 'POST', headers, body: JSON.stringify({ inHeaders: cap.detail.inHeaders }),
      })).json();
      ok(draft.name === 'opencode', 'U draft name guessed from UA, got ' + draft.name);
      const byName = Object.fromEntries(draft.headers.map((h) => [h.name, h]));
      ok(byName['user-agent']?.mode === 'fixed', 'U identity headers default to fixed');
      ok(byName['x-session-id']?.mode === 'fill' && byName['x-session-id']?.value === 'ses_capture_1', 'U session header classified fill with captured value');
      ok(!draft.headers.some((h) => ['authorization', 'host', 'content-length', 'anthropic-beta'].includes(h.name)), 'U gateway-managed/auth/excluded headers are absent');

      const created = await (await fetch(base + '/api/client-presets', {
        method: 'POST', headers,
        body: JSON.stringify({ name: draft.name, headers: [...draft.headers, { name: 'x-session-affinity', value: 'aff_pinned', mode: 'drop' }] }),
      })).json();
      ok(created.ok === true, 'U preset created');

      // 渠道引用档案（并清掉 UA override，二选一）
      const channels = await (await fetch(base + '/api/channels')).json();
      const ch = channels.find((c) => c.name === 'anthropic-e2e');
      const putCh = await fetch(base + '/api/channels/' + ch.id, {
        method: 'PUT', headers,
        body: JSON.stringify({ ...ch, client_preset: 'opencode', user_agent_override: '' }),
      });
      ok(putCh.ok, 'U channel now references the preset');

      const relayReq = (extra, session) => fetch(base + '/v1/messages', {
        method: 'POST',
        headers: { ...headers, 'user-agent': 'some-other-client/1.0', ...(session ? { 'x-session-id': session } : {}), ...extra },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
      });

      const r1 = await relayReq({ 'x-session-affinity': 'aff_should_die' }, 'ses_live_1');
      ok(r1.status === 200, 'U relay with preset ok, got ' + r1.status);
      let hit = lastHit('claude-sonnet-4-5');
      ok(hit.ua === 'opencode/9.9.9 test', 'U fixed UA overrides client UA, got ' + hit.ua);
      ok(hit.headers['x-session-id'] === 'ses_live_1', 'U fill passes the live session through');
      ok(hit.headers['x-session-affinity'] == null, 'U drop removes the header entirely');
      ok(hit.host === '127.0.0.1:8999' && hit.auth === 'Bearer sk-up-12345', 'U host/auth stay channel-owned');

      const r2 = await relayReq({}, '');
      ok(r2.status === 200, 'U relay without session ok');
      hit = lastHit('claude-sonnet-4-5');
      ok(hit.headers['x-session-id'] === 'ses_capture_1', 'U fill backfills the pinned session, got ' + hit.headers['x-session-id']);

      // 出站头记录：失败必记（含档案三态的效果）；开关打开后成功也记
      await fetch(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'flaky-500', messages: [{ role: 'user', content: 'hi' }] }) });
      const failResp = await fetch(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'flaky-500', messages: [{ role: 'user', content: 'hi' }] }) });
      const sum = await (await fetch(base + '/api/logs/summary')).json();
      const failLogs = (await (await fetch(base + '/api/logs?limit=10')).json());
      const failLog = failLogs.find((l) => l.model === 'flaky-500');
      ok(failLog && Array.isArray(failLog.detail?.attempts) && failLog.detail.attempts.length >= 1, 'U fail log carries attempts');
      ok(failLog.detail.attempts.some((a) => a.out_headers && a.out_headers['user-agent']), 'U failed attempts carry outbound headers');
      ok(failLog.detail.out_headers && failLog.detail.out_headers['user-agent'], 'U failed log carries final outbound headers');
      ok(failLog.detail.out_headers.authorization === 'Bearer sk-flaky', 'U outbound headers show the channel key (plaintext by design)');

      await fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify({ log_out_headers: '1' }) });
      await fetch(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }) });
      const okLogs = (await (await fetch(base + '/api/logs?limit=5')).json());
      const okLog = okLogs.find((l) => l.model === 'claude-sonnet-4-5' && !l.error);
      ok(okLog && okLog.detail?.out_headers && okLog.detail.out_headers['user-agent'], 'U success log records outbound headers when toggled');
      await fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify({ log_out_headers: '0' }) });

      // 4xx 且 error 字段为空的分支（如上游 401/403）也要记出站头——回归 403 排障场景
      const r401 = await fetch(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'unauthorized', messages: [{ role: 'user', content: 'hi' }] }) });
      ok(r401.status === 401, 'U upstream 401 passes through, got ' + r401.status);
      const log401 = (await (await fetch(base + '/api/logs?limit=5')).json()).find((l) => l.model === 'unauthorized');
      ok(log401 && log401.status === 401, 'U 401 log exists');
      ok(log401.detail?.out_headers && log401.detail.out_headers['user-agent'], 'U 401 (empty error field) still records outbound headers');

      // 收尾：恢复渠道 UA override，删除预设
      await fetch(base + '/api/channels/' + ch.id, {
        method: 'PUT', headers,
        body: JSON.stringify({ ...ch, client_preset: '', user_agent_override: 'e2e-ua' }),
      });
      const dup = await fetch(base + '/api/client-presets', { method: 'POST', headers, body: JSON.stringify({ name: 'opencode', headers: [] }) });
      ok(dup.status === 400, 'U duplicate preset name -> 400');
      const del = await fetch(base + '/api/client-presets/opencode', { method: 'DELETE' });
      ok(del.ok, 'U preset deleted');
    }

    // T: log retention — nothing evicts automatically; manual cleanup by age works
    {
      // 造一条捕获记录，验证它与转发日志共存（旧的 1000 条全局滚动池会把捕获挤掉）
      await postJson(base + '/api/capture/toggle', { enabled: true });
      await fetch(base + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
      });
      await postJson(base + '/api/capture/toggle', { enabled: false });

      const sum0 = await (await fetch(base + '/api/logs/summary')).json();
      ok(sum0.total > 0 && sum0.relay > 0, 'T relay logs counted, got ' + JSON.stringify(sum0));
      ok(sum0.capture >= 1, 'T capture entries coexist with relay logs');
      ok(typeof sum0.oldest_ts === 'number', 'T summary carries oldest timestamp');

      const est = await (await fetch(base + '/api/logs/summary?before_days=0&kind=capture')).json();
      ok(est.older === sum0.capture, 'T capture-scoped estimate covers all capture rows, got ' + est.older + ' vs ' + sum0.capture);

      const bad = await fetch(base + '/api/logs/cleanup', { method: 'POST', headers, body: JSON.stringify({ before_days: -1 }) });
      ok(bad.status === 400, 'T invalid before_days -> 400');
      const badKind = await fetch(base + '/api/logs/cleanup', { method: 'POST', headers, body: JSON.stringify({ before_days: 1, kind: 'nope' }) });
      ok(badKind.status === 400, 'T invalid kind -> 400, got ' + badKind.status);

      // 分类清理：只清捕获，转发日志必须原封不动
      const delCap = await (await fetch(base + '/api/logs/cleanup', { method: 'POST', headers, body: JSON.stringify({ before_days: 0, kind: 'capture' }) })).json();
      ok(delCap.ok === true && delCap.deleted === sum0.capture, 'T capture-only cleanup removed capture rows, got ' + JSON.stringify(delCap));
      const sum1 = await (await fetch(base + '/api/logs/summary')).json();
      ok(sum1.capture === 0, 'T capture empty after scoped cleanup');
      ok(sum1.relay === sum0.relay, 'T relay logs untouched by capture cleanup, got ' + sum1.relay + ' vs ' + sum0.relay);

      // 再单独清转发
      const delRelay = await (await fetch(base + '/api/logs/cleanup', { method: 'POST', headers, body: JSON.stringify({ before_days: 0, kind: 'relay' }) })).json();
      ok(delRelay.ok === true && delRelay.deleted === sum0.relay, 'T relay-only cleanup removed relay rows, got ' + JSON.stringify(delRelay));
      const sum2 = await (await fetch(base + '/api/logs/summary')).json();
      ok(sum2.total === 0, 'T archive empty after both scoped cleanups, got ' + sum2.total);
      ok((await (await fetch(base + '/api/logs?limit=10')).json()).length === 0, 'T log list empty after cleanup');
    }

    console.log('[e2e] scenarios: A B C D E F G H I J K L M N O P Q R S T U');
    console.log('[e2e] ALL ASSERTIONS PASSED');
  } finally {
    console.log('[e2e][child-out]\n' + childOutput);
    console.log('[e2e][child-err]\n' + childErr);
    child.kill('SIGTERM');
    await sleep(500);
    if (child.exitCode == null) child.kill('SIGKILL');
    fake.server.close();
    await sleep(200);
    for (let attempt=0; attempt<4; attempt++) {
      try {
        removeDbFiles();
        break;
      } catch { await sleep(300); }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[e2e] FAILED:', e.message, 'cause-code:', e.cause?.code);
  console.error('[e2e] STACK:', e.stack);
  process.exit(1);
});