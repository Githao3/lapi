import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertRequestBody,
  convertResponseBody,
  createLineConverter,
  convertUpstreamError,
  ConversionError,
} from '../conversion.js';

test('request chat -> responses', () => {
  const r = convertRequestBody(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens:  50 },
    'chat',
    'responses'
  );
  assert.equal(r.input[0].content[0].text,'hi');
  assert.equal(r.max_output_tokens, 50);
});

test('request responses -> chat', () => {
  const r = convertRequestBody(
    { model: 'm', input: 'hi2', instructions: 'sys' },
    'responses',
    'chat'
  );
  assert.equal(r.messages[0].role,'system');
  assert.equal(r.messages[0].content,'sys');
  assert.equal(r.messages[1].content,'hi2');
  assert.equal(r.messages.length, 2);
});

test('request messages -> chat keeps stream', () => {
  const r = convertRequestBody(
    { model: 'm', system: 'S', stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] },
    'messages',
    'chat'
  );
  assert.equal(r.messages[1].content,'x');
  assert.equal(r.stream, true);
});

test('request chat -> messages prepends system', () => {
  const r = convertRequestBody(
    { model: 'm', messages: [{ role: 'user', content: 'a' }], system: 'S' },
    'chat',
    'messages'
  );
  assert.equal(r.messages[0].role,'system');
  assert.equal(r.messages[1].content,'a');
});

test('request responses -> messages', () => {
  const r = convertRequestBody(
    { model: 'm', input: [{ type: 'message', role: 'user', content: 'q' }] },
    'responses',
    'messages'
  );
  assert.equal(r.messages[0].content,'q');
});

test('request messages -> responses', () => {
  const r = convertRequestBody(
    { model: 'm', messages: [{ role: 'user', content: 'q' }] },
    'messages',
    'responses'
  );
  assert.equal(r.input[0].content[0].text,'q');
});

test('response chat -> messages', () => {
  const r = convertResponseBody(
    { id: 'x', object: 'chat.completion', model: 'm',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] },
    'chat',
    'messages'
  );
  assert.equal(r.type,'message');
  assert.equal(r.content[0].text,'hello');
  assert.equal(r.stop_reason,'end_turn');
});

test('response messages -> chat', () => {
  const r = convertResponseBody(
    { type: 'message', model: 'm',
      content: [{ type: 'text', text: 'yo' }], stop_reason: 'end_turn' },
    'messages',
    'chat'
  );
  assert.equal(r.object,'chat.completion');
  assert.equal(r.choices[0].message.content,'yo');
});

test('response chat -> responses', () => {
  const r = convertResponseBody(
    { model: 'm', choices: [{ message: { content: 'c' }, finish_reason: 'stop' }] },
    'chat',
    'responses'
  );
  assert.equal(r.object,'response');
  assert.equal(r.output[0].content[0].text,'c');
});

test('response responses -> chat', () => {
  const r = convertResponseBody(
    { id: 'r', object: 'response', model: 'm',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 't' }] }] },
    'responses',
    'chat'
  );
  assert.equal(r.choices[0].message.content,'t');
});

test('response messages -> responses', () => {
  const r = convertResponseBody(
    { type: 'message', model: 'm', content: [{ type: 'text', text: 'n' }] },
    'messages',
    'responses'
  );
  assert.equal(r.output[0].content[0].text,'n');
});

test('response responses -> messages', () => {
  const r = convertResponseBody(
    { id: 'r', object: 'response', model: 'm',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'k' }] }] },
    'responses',
    'messages'
  );
  assert.equal(r.type,'message');
  assert.equal(r.content[0].text,'k');
});

// ---------- SSE line conversion ----------

function dataLine(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

test('SSE chat stream -> messages lines', () => {
  const conv = createLineConverter('chat', 'messages');
  let out = '';
  out += conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'a' } }] } ));
  out += conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'b' } }] } ));
  out += conv.push('data: [DONE]\n\n');
  assert.ok(out.includes('message_start'));
  assert.ok(out.includes('content_block_start'));
  assert.ok(out.includes('content_block_delta'));
  assert.ok(out.includes('"a"'));
  assert.ok(out.includes('"b"'));
  assert.ok(out.includes('message_stop'));
  assert.ok(!out.includes('"choices"'));
  assert.equal(conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'late' } }] })), '');
  assert.equal(conv.end(), '');
});

test('SSE messages stream -> chat lines', () => {
  const conv = createLineConverter('messages', 'chat');
  let out = '';
  out += conv.push(dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } }));
  out += conv.push(dataLine({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
  assert.ok(out.startsWith('data: {"choices"'));
  assert.ok(out.includes('"b"'));
  assert.ok(out.includes('[DONE]'));
  assert.ok(!out.includes('content_block_delta'));
  assert.equal(conv.end(), '');
});

test('SSE responses stream -> chat lines', () => {
  const conv = createLineConverter('responses', 'chat');
  let out = conv.push(dataLine({ type: 'response.output_text.delta', delta: 'z' } ));
  assert.ok(out.startsWith('data: {"choices"'));
  assert.ok(out.includes('"z"'));
  out += conv.push(dataLine({ type: 'response.completed' } ));
  assert.ok(out.includes('[DONE]'));
  assert.equal(conv.end(), '');
});

test('SSE chat stream -> responses lines', () => {
  const conv = createLineConverter('chat', 'responses');
  let out = conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'q' } }] } ));
  assert.ok(out.startsWith('data: {"type":"response.created"'));
  assert.ok(out.includes('response.output_text.delta'));
  assert.ok(out.includes('"q"'));
  out += conv.push('data: [DONE]\n\n');
  assert.ok(out.includes('"type":"response.completed"'));
  assert.equal(conv.end(), '');
});

test('SSE messages stream -> responses lines', () => {
  const conv = createLineConverter('messages', 'responses');
  let out = conv.push(dataLine({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'w' } } ));
  assert.ok(out.startsWith('data: {"type":"response.created"'));
  assert.ok(out.includes('response.output_text.delta'));
  assert.ok(out.includes('"w"'));
  out += conv.push(dataLine({ type: 'message_stop' } ));
  assert.ok(out.includes('"type":"response.completed"'));
  assert.equal(conv.end(), '');
});

test('SSE converter .end() flushes completion if upstream never sent done', () => {
  const conv = createLineConverter('chat', 'messages');
  let out = conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'x' } }] } ));
  assert.ok(out.includes('"x"'));
  assert.ok(!out.includes('message_stop'));
  out += conv.end();
  assert.ok(out.includes('message_stop'));
  assert.equal(conv.end(), '');
});

test('passthrough: same-format request and response return originals', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
assert.equal(convertRequestBody(body, 'chat', 'chat'), body);
const resp = { choices: [] };
assert.equal(convertResponseBody(resp, 'messages', 'messages'), resp);
});

// ---------- guards: v1 converts text chat only ----------

test('guard: tools in request throw ConversionError', () => {
  assert.throws(
    () => convertRequestBody({ model: 'm', messages: [], tools: [{}] }, 'chat', 'responses'),
    ConversionError
  );
});

test('guard: tool_use content block in request throws', () => {
  assert.throws(
    () => convertRequestBody(
      { model: 'm', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't' }] }] },
      'messages',
      'chat'
    ),
    ConversionError
  );
});

test('guard: non-text output block in responses response throws', () => {
  assert.throws(
    () => convertResponseBody(
      { id: 'r', object: 'response', model: 'm',
        output: [{ type: 'file', content: [] }] },
      'responses',
      'chat'
    ),
    ConversionError
  );
});

test('guard: image block in messages response throws', () => {
  assert.throws(
    () => convertResponseBody(
      { type: 'message', content: [{ type: 'image', source: {} }] },
      'messages',
      'chat'
    ),
    ConversionError
  );
});


// ---------- upstream error envelope ----------

test('convertUpstreamError: anthropic envelope', () => {
  const e = convertUpstreamError(
    { error: { type: 'invalid_request_error', message: 'bad' } },
    'messages',
    'fallback'
  );
  assert.equal(e.type, 'error');
  assert.equal(e.error.type, 'invalid_request_error');
  assert.equal(e.error.message,'bad');
});

test('convertUpstreamError: openai envelope and fallback', () => {
  const e = convertUpstreamError({ message: 'boom' }, 'chat', 'fallback');
  assert.equal(e.error.message,'boom');
  assert.equal(e.error.type,'upstream_error');
  const fb = convertUpstreamError(null, 'chat', 'fb');
  assert.equal(fb.error.message,'fb');
  assert.equal(fb.error.type,'upstream_error');
});
