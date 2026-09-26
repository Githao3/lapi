// Fake upstream for e2e tests. Default port 8999, override with PORT env.
// Per-model behaviors: normal success; sse-x (SSE anthropic); flaky-500 (always 500);
// flaky-429 (first 429 with retry-after, then success); flaky-drop (SSE then socket destroy mid-stream).
// Cross-protocol additions: sse-resp / sse-tools-resp / trunc-resp (responses SSE),
// sse-tools-msg / tool-msg / img-echo (anthropic side), sse-tools-chat / tool-chat / img-echo (chat side).

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8999);
const counts = {};
const hits = [];
let ready = false;

function logHit(req, body) {
  const h = req.headers;
  hits.push({
    method: req.method,
    url: req.url,
    host: h.host,
    auth: h.authorization,
    xkey: h['x-api-key'],
    ua: h['user-agent'],
    acceptEncoding: h['accept-encoding'],
    anthropicVersion: h['anthropic-version'],
    headers: h,
    model: body?.model ?? null,
    body,
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// New-behavior helpers: single-line JSON frames so the SSE bytes are always
// exactly parseable by server/conversion/sse-common.mjs (block ends \n\n).
function sseData(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}
function sseEvent(name, obj) {
  return 'event: ' + name + '\ndata: ' + JSON.stringify(obj) + '\n\n';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function anthropicOk(model) {
  return {
    type: 'message',
    id: 'msg_fake_1',
    model,
    role: 'assistant',
    content: [{ type: 'text', text: 'pong' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function openaiOk(model) {
  return {
    id: 'chatcmpl_fake_1',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}

// --- new cross-protocol fixtures (added for e2e scenarios K-Q) ---

// img-echo: plain text on both openai and anthropic shapes (e2e asserts the
// CONVERTED REQUEST at the fake, response is just a recognizable text reply).
function imgEchoOpenai(model) {
  return {
    id: 'chatcmpl_fake_img',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'image-ok' }, finish_reason: 'stop' }],
  };
}
function imgEchoAnthropic(model) {
  return {
    type: 'message',
    id: 'msg_fake_img',
    model,
    role: 'assistant',
    content: [{ type: 'text', text: 'image-ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

// tool-msg: non-stream anthropic tool_use reply.
function anthropicToolMsg(model) {
  return {
    type: 'message',
    id: 'msg_fake_9',
    model,
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: { city: 'Paris' } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 5, output_tokens: 7 },
  };
}

// tool-chat: non-stream openai tool_calls reply.
function openaiToolChat(model) {
  return {
    id: 'chatcmpl_fake_9',
    object: 'chat.completion',
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  };
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
  let body = {};
  if (req.method === 'POST') body = (await readBody(req)) || {};
  logHit(req, body);
  const m = String(body.model ?? (u.searchParams.get('model') ?? ''));
  counts[m] = (counts[m] ?? 0) + 1;

  if (m.includes('flaky-500')) {
    json(res, 500, { error: 'boom500' });
    return;
  }
  if (m.includes('flaky-429')) {
    if (counts[m] >= 2) {
      json(res, 200, anthropicOk(m));
    } else {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'throttled' }));
    }
    return;
  }
  if (m.includes('flaky-drop')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"message_start","message":{"role":"assistant"}}\n\n');
    res.write('data: {"type":"content_block_start","index":0}\n\n');
    setTimeout(() => req.socket.destroy(), 30);
    return;
  }
  if (u.pathname === '/v1/messages' || u.pathname === '/v1beta/messages' || u.pathname === '/messages') {
    if (m.includes('sse-x')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i=0; i<4; i++) {
        res.write('data: {"type":"content_block_delta","index":0,"delta":{"text":"hi' + i + '"}}\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (m.includes('sse-tools-msg')) {
      // Anthropic SSE tool_use: tool name first, arguments streamed as input_json_delta fragments.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseData({ type: 'message_start', message: { type: 'message', id: 'msg_fake_t', role: 'assistant', model: m, usage: { input_tokens: 10, output_tokens: 1 } } }));
      res.write(sseData({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } }));
      res.write(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":' } }));
      res.write(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } }));
      res.write(sseData({ type: 'content_block_stop', index: 0 }));
      res.write(sseData({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 17 } }));
      res.write(sseData({ type: 'message_stop' }));
      res.end();
      return;
    }
    if (m.includes('unauthorized')) {
      json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      return;
    }
    if (m.includes('tool-msg')) {
      json(res, 200, anthropicToolMsg(m));
      return;
    }
    if (m.includes('img-echo')) {
      json(res, 200, imgEchoAnthropic(m));
      return;
    }
    json(res, 200, anthropicOk(m));
    return;
  }
  if (u.pathname === '/v1/chat/completions') {
    if (m.includes('slow-sse')) {
      // Slow drip so a client abort lands mid-stream; stops dripping when the client leaves.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const timer = setInterval(() => {
        i += 1;
        if (i > 6) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write('data: {"choices":[{"index":0,"delta":{"content":"tick' + i + '"}}]}\n\n');
      }, 120);
      req.on('close', () => clearInterval(timer));
      return;
    }
    if (m.includes('sse-chat')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i=0; i<3; i++) {
        res.write('data: {"choices":[{"index":0,"delta":{"content":"hi' + i + '"}}]}\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (m.includes('sse-tools-chat')) {
      // Chat SSE tool_calls: id+name chunk, argument fragments, terminal finish_reason + usage.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] }));
      res.write(sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] }));
      res.write(sseData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }] } }] }));
      res.write(sseData({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 21, total_tokens: 30 } }));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (m.includes('tool-chat')) {
      json(res, 200, openaiToolChat(m));
      return;
    }
    if (m.includes('img-echo')) {
      json(res, 200, imgEchoOpenai(m));
      return;
    }
    json(res, 200, openaiOk(m));
    return;
  }
  if (u.pathname === '/v1/responses') {
    if (m.includes('sse-resp')) {
      // Responses SSE text stream: created -> 3 output_text deltas -> completed (usage 12/34/46).
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseEvent('response.created', { type: 'response.created', response: { id: 'resp_fake_sse1', object: 'response', status: 'in_progress', model: m } }));
      for (let i=0; i<3; i++) {
        res.write(sseEvent('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'hi' + i }));
      }
      res.write(sseEvent('response.completed', { type: 'response.completed', response: { id: 'resp_fake_sse1', object: 'response', status: 'completed', model: m, usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 } } }));
      res.end();
      return;
    }
    if (m.includes('sse-tools-resp')) {
      // Responses SSE function_call: item added -> argument fragments -> done -> item done -> completed.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseEvent('response.created', { type: 'response.created', response: { id: 'resp_fake_t1', object: 'response', status: 'in_progress', model: m } }));
      res.write(sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '', status: 'in_progress' } }));
      res.write(sseEvent('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"city":' }));
      res.write(sseEvent('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"Paris"}' }));
      res.write(sseEvent('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{"city":"Paris"}' }));
      res.write(sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '{"city":"Paris"}', status: 'completed' } }));
      res.write(sseEvent('response.completed', { type: 'response.completed', response: { id: 'resp_fake_t1', object: 'response', status: 'completed', model: m, usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 } } }));
      res.end();
      return;
    }
    if (m.includes('trunc-resp')) {
      // Responses SSE cut mid-stream: one argument fragment, then the socket dies.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseEvent('response.created', { type: 'response.created', response: { id: 'resp_fake_tr', object: 'response', status: 'in_progress', model: m } }));
      res.write(sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '', status: 'in_progress' } }));
      res.write(sseEvent('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"city":' }));
      setTimeout(() => req.socket.destroy(), 30);
      return;
    }
    json(res, 200, {
      id: 'resp_fake_1',
      object: 'response',
      status: 'completed',
      model: m,
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }],
      usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
    });
    return;
  }
  if (u.pathname === '/v1/models') {
    json(res, 200, { object: 'list', data: [{ id: 'fake-model-1', object: 'model', owned_by: 'fake' }] });
    return;
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  ready = true;
  console.log('FAKE_UPSTREAM_READY ' + PORT);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

export { counts, hits, ready, server };