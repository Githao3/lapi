// node:test suite for the anthropic ⇄ responses mirror-pair converter.
// Text-path shapes are kept equivalent to the legacy server/conversion.js suite
// (input_text requests, {object:'response', output:[…]} envelopes, SSE
// response.created / output_text.delta / response.completed presence, .end() flush).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, response, createSse } from '../conversion/anthropic-responses.mjs';
import { ConversionError } from '../conversion/errors.mjs';

function sse(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data ?? {}) + '\n\n';
}

function events(out) {
  return out.split('\n\n').filter((b) => b.trim() !== '');
}

function dataOf(block) {
  const line = block.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line.slice(6));
}

function types(out) {
  return events(out).map((b) => {
    const d = dataOf(b);
    return d.type ?? d.delta?.type ?? '';
  });
}

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('export surface: unsupported pair throws ConversionError', () => {
  assert.throws(() => request('chat', 'responses', {}), ConversionError);
  assert.throws(() => response('chat', 'messages', {}), ConversionError);
  assert.throws(() => createSse('chat', 'responses'), ConversionError);
});

// ---------------------------------------------------------------------------
// request: messages → responses
// ---------------------------------------------------------------------------

test('request messages->responses: simple text passthrough params', () => {
  const r = request('messages', 'responses', {
    model: 'm',
    system: 'be nice',
    max_tokens: 50,
    temperature: 0.4,
    top_p: 0.9,
    stream: true,
    stop_sequences: ['END'],
    messages: [{ role: 'user', content: 'q' }],
  });
  assert.equal(r.model, 'm');
  assert.equal(r.instructions, 'be nice');
  assert.equal(r.max_output_tokens, 50);
  assert.equal(r.temperature, 0.4);
  assert.equal(r.top_p, 0.9);
  assert.equal(r.stream, true);
  assert.ok(!('stop_sequences' in r));
  assert.equal(r.input.length, 1);
  assert.equal(r.input[0].role, 'user');
  assert.deepEqual(r.input[0].content, [{ type: 'input_text', text: 'q' }]);
});

test('request messages->responses: system array joins and strips billing header', () => {
  const r = request('messages', 'responses', {
    model: 'm',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cch=1\nreal prompt' },
      { type: 'text', text: 'second part' },
    ],
    messages: [{ role: 'user', content: 'q' }],
  });
  assert.equal(r.instructions, 'real prompt\n\nsecond part');
});

test('request messages->responses: assistant text becomes output_text', () => {
  const r = request('messages', 'responses', {
    model: 'm',
    messages: [{ role: 'assistant', content: 'answer' }],
  });
  assert.deepEqual(r.input[0].content, [{ type: 'output_text', text: 'answer' }]);
});

test('request messages->responses: thinking to reasoning.effort table', () => {
  const mk = (model, thinking) => request('messages', 'responses', { model, thinking, messages: [{ role: 'user', content: 'q' }] });
  assert.deepEqual(mk('gpt-5', { type: 'enabled', budget_tokens: 3000 }).reasoning, { effort: 'low' });
  assert.deepEqual(mk('gpt-5', { type: 'enabled', budget_tokens: 10000 }).reasoning, { effort: 'medium' });
  assert.deepEqual(mk('gpt-5', { type: 'enabled', budget_tokens: 20000 }).reasoning, { effort: 'high' });
  assert.deepEqual(mk('gpt-5', { type: 'adaptive' }).reasoning, { effort: 'xhigh' });
  assert.deepEqual(
    request('messages', 'responses', {
      model: 'gpt-5',
      thinking: { type: 'enabled', budget_tokens: 100 },
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'q' }],
    }).reasoning,
    { effort: 'xhigh' }
  );
  assert.ok(!('reasoning' in mk('claude-3-5-sonnet', { type: 'enabled', budget_tokens: 10000 })));
  assert.ok(!('reasoning' in mk('gpt-4o', { type: 'enabled', budget_tokens: 10000 })));
  assert.ok(!('reasoning' in mk('gpt-5', { type: 'disabled' })));
  assert.deepEqual(mk('o3', { type: 'enabled' }).reasoning, { effort: 'high' });
});

test('request messages->responses: tool_use flushes message then becomes function_call', () => {
  const r = request('messages', 'responses', {
    model: 'm',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'using tool' },
          { type: 'tool_use', id: 'tu1', name: 'f', input: { b: 2, a: 1 } },
        ],
      },
    ],
  });
  assert.equal(r.input.length, 3);
  assert.deepEqual(r.input[0].content, [{ type: 'input_text', text: 'hi' }]);
  assert.deepEqual(r.input[1], { role: 'assistant', content: [{ type: 'output_text', text: 'using tool' }] });
  assert.deepEqual(r.input[2], { type: 'function_call', call_id: 'tu1', name: 'f', arguments: '{"a":1,"b":2}' });
});

test('request messages->responses: tool_result becomes function_call_output', () => {
  const r = request('messages', 'responses', {
    model: 'm',
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'result text' }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'boom' }],
      },
    ],
  });
  assert.deepEqual(r.input[0], {
    type: 'function_call_output',
    call_id: 'tu1',
    output: [{ type: 'input_text', text: 'result text' }],
  });
  const errOut = r.input[1].output;
  assert.equal(errOut[0].text, '[cc-switch:tool-result-error]');
  assert.equal(errOut[1].text, 'boom');
});

test('request messages->responses: images in messages and tool results', () => {
  const r = request('messages', 'responses', {
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
          { type: 'image', source: { type: 'url', url: 'ftp://x/y.png' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(r.input[0].content[0], { type: 'input_image', image_url: 'data:image/png;base64,AAA' });
  assert.deepEqual(r.input[0].content[1], { type: 'input_image', image_url: 'https://x/y.png' });
  assert.equal(r.input[0].content.length, 2); // non-http url image dropped
  assert.deepEqual(r.input[1].output[0], { type: 'input_image', image_url: 'data:image/jpeg;base64,BBB' });
});

test('request messages->responses: tools flattened and schema cleaned', () => {
  const r = request('messages', 'responses', {
    model: 'm',
    tools: [
      {
        name: 'f',
        description: 'd',
        input_schema: { properties: { u: { type: 'string', format: 'uri' } } },
      },
    ],
    tool_choice: { type: 'tool', name: 'f' },
    messages: [{ role: 'user', content: 'q' }],
  });
  assert.deepEqual(r.tools, [
    {
      type: 'function',
      name: 'f',
      description: 'd',
      parameters: { type: 'object', properties: { u: { type: 'string' } } },
    },
  ]);
  assert.deepEqual(r.tool_choice, { type: 'function', name: 'f' });
});

test('request messages->responses: tool_choice table', () => {
  const mk = (tool_choice) => request('messages', 'responses', { model: 'm', tool_choice, messages: [{ role: 'user', content: 'q' }] });
  assert.equal(mk({ type: 'any' }).tool_choice, 'required');
  assert.equal(mk({ type: 'auto' }).tool_choice, 'auto');
  assert.equal(mk({ type: 'none' }).tool_choice, 'none');
  // plain strings pass through verbatim (cc-switch semantics)
  assert.equal(mk('auto').tool_choice, 'auto');
  assert.equal(mk('none').tool_choice, 'none');
});

test('request messages->responses: fail-closed on hosted web search and unknown tool types', () => {
  assert.throws(
    () => request('messages', 'responses', { model: 'm', tools: [{ type: 'web_search', name: 'ws' }], messages: [] }),
    ConversionError
  );
  assert.throws(
    () => request('messages', 'responses', { model: 'm', tools: [{ type: 'web_search_20250305', name: 'ws' }], messages: [] }),
    ConversionError
  );
  assert.throws(
    () => request('messages', 'responses', { model: 'm', tools: [{ type: 'computer_20250124', name: 'c' }], messages: [] }),
    ConversionError
  );
  assert.throws(
    () =>
      request('messages', 'responses', {
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'server_tool_use', id: 's1', name: 'ws', input: {} }] }],
      }),
    ConversionError
  );
});

test('request messages->responses: reasoning envelope round-trips through thinking signature', () => {
  const item = {
    id: 'rs_1',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Need a tool.' }],
    encrypted_content: 'opaque',
  };
  const envelope = 'ccswitch-openai-reasoning-v1:' + Buffer.from(JSON.stringify(item), 'utf8').toString('base64url');
  const r = request('messages', 'responses', {
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need a tool.', signature: envelope },
          { type: 'text', text: 'calling' },
        ],
      },
    ],
  });
  assert.deepEqual(r.input[0], item);
  // Undecodable thinking blocks are dropped (and the reasoning-only turn is pruned).
  const r2 = request('messages', 'responses', {
    model: 'm',
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'plain', signature: 'sig' }] }],
  });
  assert.deepEqual(r2.input, []);
});

test('request messages->responses: trailing reasoning-only assistant turn pruned', () => {
  const item = { type: 'reasoning', summary: [], encrypted_content: 'opaque' };
  const envelope = 'ccswitch-openai-reasoning-v1:' + Buffer.from(JSON.stringify(item), 'utf8').toString('base64url');
  const pruned = request('messages', 'responses', {
    model: 'm',
    messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: envelope }] }],
  });
  assert.deepEqual(pruned.input, []);
  const kept = request('messages', 'responses', {
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: envelope },
          { type: 'text', text: 'visible' },
        ],
      },
    ],
  });
  assert.equal(kept.input.length, 2);
  assert.equal(kept.input[0].type, 'reasoning');
});

// ---------------------------------------------------------------------------
// request: responses → messages
// ---------------------------------------------------------------------------

test('request responses->messages: simple text and default max_tokens', () => {
  const r = request('responses', 'messages', { model: 'm', input: 'hi2' });
  assert.equal(r.model, 'm');
  assert.deepEqual(r.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi2' }] }]);
  assert.equal(r.max_tokens, 4096);
  const r2 = request('responses', 'messages', { model: 'm', input: 'hi', max_output_tokens: 100 });
  assert.equal(r2.max_tokens, 100);
});

test('request responses->messages: instructions and system/developer hoisted to system', () => {
  const r = request('responses', 'messages', {
    model: 'm',
    instructions: 'base',
    input: [
      { role: 'system', content: 'sys history' },
      { role: 'developer', content: [{ type: 'input_text', text: 'dev history' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
    ],
  });
  assert.equal(r.system, 'base\n\nsys history\n\ndev history');
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, 'user');
});

test('request responses->messages: message items to user/assistant text blocks', () => {
  const r = request('responses', 'messages', {
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
    ],
  });
  assert.deepEqual(r.messages[0], { role: 'user', content: [{ type: 'text', text: 'q' }] });
  assert.deepEqual(r.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'a' }] });
});

test('request responses->messages: function_call to tool_use with arg validation', () => {
  const r = request('responses', 'messages', {
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  });
  // leading user is synthesized because the history starts with an assistant turn
  assert.equal(r.messages[0].content[0].text, '(continuing the conversation)');
  assert.deepEqual(r.messages[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }],
  });
  assert.deepEqual(r.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] });
  assert.throws(
    () =>
      request('responses', 'messages', {
        model: 'm',
        input: [{ type: 'function_call', call_id: 'c1', name: 'f', arguments: '{bad' }],
      }),
    ConversionError
  );
  assert.throws(
    () =>
      request('responses', 'messages', {
        model: 'm',
        input: [{ type: 'function_call', call_id: 'c1', name: 'f', arguments: '[1]' }],
      }),
    ConversionError
  );
});

test('request responses->messages: incomplete function_call dropped, output becomes tool_result', () => {
  const r = request('responses', 'messages', {
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}', status: 'incomplete' },
      { type: 'function_call', call_id: 'c2', name: 'g', arguments: '{"x":1}' },
      { type: 'function_call_output', call_id: 'c2', output: 'ok' },
    ],
  });
  // incomplete c1 dropped; leading assistant turn gains a synthesized user preface
  assert.equal(r.messages.length, 3);
  assert.deepEqual(r.messages[1].content, [{ type: 'tool_use', id: 'c2', name: 'g', input: { x: 1 } }]);
  assert.deepEqual(r.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'ok' }] });
});

test('request responses->messages: tool-result error marker flips is_error', () => {
  const r = request('responses', 'messages', {
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: [{ type: 'input_text', text: '[cc-switch:tool-result-error]' }, { type: 'input_text', text: 'boom' }],
      },
    ],
  });
  assert.deepEqual(r.messages[2].content, [
    { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'boom' }], is_error: true },
  ]);
});

test('request responses->messages: input_image to image block', () => {
  const r = request('responses', 'messages', {
    model: 'm',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          { type: 'input_image', image_url: 'https://x/y.png' },
          { type: 'input_image', image_url: 'ftp://x/y.png' },
        ],
      },
    ],
  });
  assert.deepEqual(r.messages[0].content[0], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
  });
  assert.deepEqual(r.messages[0].content[1], { type: 'image', source: { type: 'url', url: 'https://x/y.png' } });
  assert.equal(r.messages[0].content.length, 2);
});

test('request responses->messages: history normalization drops incomplete tool turns', () => {
  // assistant function_call with no matching output → whole turn dropped
  const r = request('responses', 'messages', {
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { role: 'user', content: 'q' },
    ],
  });
  assert.equal(r.messages.length, 1);
  assert.deepEqual(r.messages[0], { role: 'user', content: [{ type: 'text', text: 'q' }] });

  // complete pair survives intact
  const r2 = request('responses', 'messages', {
    model: 'm',
    input: [
      { role: 'user', content: 'q' },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  });
  assert.equal(r2.messages.length, 3);
  assert.equal(r2.messages[1].content[0].type, 'tool_use');
  assert.equal(r2.messages[2].content[0].type, 'tool_result');
});

test('request responses->messages: leading user ensured, trailing assistant prefill trimmed', () => {
  const r = request('responses', 'messages', {
    model: 'm',
    input: [{ role: 'assistant', content: 'prefill' }, { role: 'user', content: 'q' }],
  });
  assert.equal(r.messages[0].role, 'user');
  assert.equal(r.messages[0].content[0].text, '(continuing the conversation)');

  const r2 = request('responses', 'messages', {
    model: 'm',
    input: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '   ' }],
  });
  assert.equal(r2.messages.length, 1);

  const r3 = request('responses', 'messages', {
    model: 'm',
    input: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'go ' }],
  });
  assert.equal(r3.messages[1].content[0].text, 'go');
});

test('request responses->messages: empty converted history throws', () => {
  assert.throws(() => request('responses', 'messages', { model: 'm', input: '   ' }), ConversionError);
  assert.throws(
    () => request('responses', 'messages', { model: 'm', input: [{ type: 'reasoning', encrypted_content: 'junk' }] }),
    ConversionError
  );
});

test('request responses->messages: effort to thinking budget table', () => {
  // 65536 keeps every budget below the max_tokens/2 ceiling (see clamp test below).
  const mk = (effort, max) => request('responses', 'messages', { model: 'm', reasoning: { effort }, max_output_tokens: max, input: 'q' });
  assert.deepEqual(mk('minimal', 65536).thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.deepEqual(mk('low', 65536).thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.deepEqual(mk('medium', 65536).thinking, { type: 'enabled', budget_tokens: 8192 });
  assert.deepEqual(mk('high', 65536).thinking, { type: 'enabled', budget_tokens: 16384 });
  assert.deepEqual(mk('xhigh', 65536).thinking, { type: 'enabled', budget_tokens: 24576 });
  assert.deepEqual(mk('max', 65536).thinking, { type: 'enabled', budget_tokens: 24576 });
  assert.deepEqual(mk('none', 8192).thinking, { type: 'disabled' });
  assert.deepEqual(mk('off', 8192).thinking, { type: 'disabled' });
  assert.deepEqual(mk('disabled', 8192).thinking, { type: 'disabled' });
  assert.ok(!('thinking' in mk('mystery', 8192)));
});

test('request responses->messages: thinking budget clamped to max_tokens/2, floor disables', () => {
  const clamped = request('responses', 'messages', {
    model: 'm',
    reasoning: { effort: 'high' },
    max_output_tokens: 4000,
    input: 'q',
  });
  assert.deepEqual(clamped.thinking, { type: 'enabled', budget_tokens: 2000 });
  const disabled = request('responses', 'messages', {
    model: 'm',
    reasoning: { effort: 'low' },
    max_output_tokens: 1600,
    temperature: 0.5,
    input: 'q',
  });
  assert.ok(!('thinking' in disabled));
  assert.equal(disabled.temperature, 0.5);
});

test('request responses->messages: temperature/top_p only when thinking disabled', () => {
  const on = request('responses', 'messages', {
    model: 'm',
    reasoning: { effort: 'medium' },
    temperature: 0.5,
    top_p: 0.9,
    input: 'q',
  });
  assert.ok(!('temperature' in on));
  assert.ok(!('top_p' in on));
  const off = request('responses', 'messages', {
    model: 'm',
    reasoning: { effort: 'none' },
    temperature: 0.5,
    top_p: 0.9,
    input: 'q',
  });
  assert.equal(off.temperature, 0.5);
  assert.equal(off.top_p, 0.9);
});

test('request responses->messages: tools, tool_choice, parallel_tool_calls', () => {
  const r = request('responses', 'messages', {
    model: 'm',
    input: 'q',
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }],
    tool_choice: 'required',
    parallel_tool_calls: false,
  });
  assert.deepEqual(r.tools, [{ name: 'f', description: 'd', input_schema: { type: 'object' } }]);
  assert.deepEqual(r.tool_choice, { type: 'any', disable_parallel_tool_use: true });

  const r2 = request('responses', 'messages', {
    model: 'm',
    input: 'q',
    tools: [{ type: 'function', name: 'f', parameters: {} }],
  });
  assert.ok(!('tool_choice' in r2));

  const auto = request('responses', 'messages', {
    model: 'm',
    input: 'q',
    tools: [{ type: 'function', name: 'f', parameters: {} }],
    parallel_tool_calls: false,
  });
  assert.deepEqual(auto.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
});

test('request responses->messages: forced tool disables thinking', () => {
  const r = request('responses', 'messages', {
    model: 'm',
    input: 'q',
    reasoning: { effort: 'medium' },
    temperature: 0.5,
    tools: [{ type: 'function', name: 'f', parameters: {} }],
    tool_choice: { type: 'function', name: 'f' },
  });
  assert.deepEqual(r.thinking, { type: 'disabled' });
  assert.deepEqual(r.tool_choice, { type: 'tool', name: 'f' });
  assert.equal(r.temperature, 0.5);
});

test('request responses->messages: fail-closed on web_search tools', () => {
  assert.throws(
    () => request('responses', 'messages', { model: 'm', input: 'q', tools: [{ type: 'web_search' }] }),
    ConversionError
  );
  assert.throws(
    () => request('responses', 'messages', { model: 'm', input: [{ type: 'web_search_call', id: 'w1', action: {} }] }),
    (e) => {
      // web_search_call items are not valid history input; must not silently pass through
      return e instanceof ConversionError || e instanceof TypeError;
    }
  );
});

test('request responses->messages: reasoning envelope decodes to thinking block', () => {
  const block = { type: 'thinking', thinking: 'hmm', signature: 'sig_x' };
  const envelope = 'ccswitch-anthropic-thinking-v1:' + Buffer.from(JSON.stringify(block), 'utf8').toString('base64url');
  const r = request('responses', 'messages', {
    model: 'm',
    input: [{ type: 'reasoning', encrypted_content: envelope }, { role: 'user', content: 'q' }],
  });
  // leading assistant thinking turn gains a synthesized user preface
  assert.deepEqual(r.messages[1], { role: 'assistant', content: [block] });
  // foreign reasoning envelope is dropped
  const r2 = request('responses', 'messages', {
    model: 'm',
    input: [{ type: 'reasoning', encrypted_content: 'ccswitch-openai-reasoning-v1:AAAA' }, { role: 'user', content: 'q' }],
  });
  assert.equal(r2.messages.length, 1);
});

// ---------------------------------------------------------------------------
// response: responses → messages
// ---------------------------------------------------------------------------

test('response responses->messages: text envelope', () => {
  const r = response('responses', 'messages', {
    id: 'resp_1',
    object: 'response',
    model: 'm',
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'k' }] }],
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  assert.equal(r.type, 'message');
  assert.equal(r.role, 'assistant');
  assert.equal(r.id, 'resp_1');
  assert.deepEqual(r.content, [{ type: 'text', text: 'k' }]);
  assert.equal(r.stop_reason, 'end_turn');
  assert.equal(r.stop_sequence, null);
  assert.deepEqual(r.usage, { input_tokens: 5, output_tokens: 2 });
});

test('response responses->messages: function_call to tool_use and stop_reason tool_use', () => {
  const r = response('responses', 'messages', {
    id: 'resp_2',
    model: 'm',
    status: 'completed',
    output: [
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' },
      { type: 'message', content: [{ type: 'output_text', text: '' }] },
    ],
  });
  assert.deepEqual(r.content, [{ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }]);
  assert.equal(r.stop_reason, 'tool_use');
  // unparseable args on a completed response throw
  assert.throws(
    () =>
      response('responses', 'messages', {
        model: 'm',
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'c1', name: 'f', arguments: '{bad' }],
      }),
    ConversionError
  );
  // incomplete responses degrade to empty input
  const r2 = response('responses', 'messages', {
    model: 'm',
    status: 'incomplete',
    output: [{ type: 'function_call', call_id: 'c1', name: 'f', arguments: '{bad' }],
  });
  assert.deepEqual(r2.content, [{ type: 'tool_use', id: 'c1', name: 'f', input: {} }]);
});

test('response responses->messages: stop_reason table', () => {
  const mk = (status, reason) =>
    response('responses', 'messages', {
      model: 'm',
      status,
      incomplete_details: reason ? { reason } : undefined,
      output: [],
    });
  assert.equal(mk('completed').stop_reason, 'end_turn');
  assert.equal(mk('incomplete', 'max_output_tokens').stop_reason, 'max_tokens');
  assert.equal(mk('incomplete', 'max_tokens').stop_reason, 'max_tokens');
  assert.equal(mk('incomplete').stop_reason, 'max_tokens');
  assert.equal(mk('incomplete', 'content_filter').stop_reason, 'end_turn');
});

test('response responses->messages: failed/cancelled/error 2xx envelopes throw', () => {
  assert.throws(
    () => response('responses', 'messages', { model: 'm', status: 'failed', output: [] }),
    ConversionError
  );
  assert.throws(
    () => response('responses', 'messages', { model: 'm', status: 'cancelled', output: [] }),
    ConversionError
  );
  assert.throws(
    () => response('responses', 'messages', { model: 'm', status: 'completed', error: { message: 'boom' }, output: [] }),
    ConversionError
  );
  assert.throws(() => response('responses', 'messages', { model: 'm' }), ConversionError);
});

test('response responses->messages: usage fallback ladder and cache subtraction', () => {
  const r = response('responses', 'messages', {
    model: 'm',
    status: 'completed',
    output: [],
    usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 30 } },
  });
  assert.equal(r.usage.input_tokens, 70); // 100 - 30 (saturating)
  assert.equal(r.usage.output_tokens, 10);
  assert.equal(r.usage.cache_read_input_tokens, 30);

  const r2 = response('responses', 'messages', {
    model: 'm',
    status: 'completed',
    output: [],
    usage: {
      input_tokens: 50,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
    },
  });
  assert.equal(r2.usage.input_tokens, 25); // 50 - 20 - 5
  assert.equal(r2.usage.cache_read_input_tokens, 20);
  assert.equal(r2.usage.cache_creation_input_tokens, 5);
});

test('response responses->messages: reasoning item to thinking block (round trip)', () => {
  const item = {
    id: 'rs_1',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Need a tool.' }],
    encrypted_content: 'opaque',
  };
  const r = response('responses', 'messages', { model: 'm', status: 'completed', output: [item] });
  assert.equal(r.content[0].type, 'thinking');
  assert.equal(r.content[0].thinking, 'Need a tool.');
  // The signature envelope replays through the next Anthropic -> Responses request
  // (reasoning_bridge round trip: item -> thinking.signature -> item).
  const decoded = request('messages', 'responses', {
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need a tool.', signature: r.content[0].signature },
          { type: 'text', text: 'go' },
        ],
      },
    ],
  });
  assert.deepEqual(decoded.input[0], item);
  // encrypted content without summary → redacted_thinking
  const r2 = response('responses', 'messages', {
    model: 'm',
    status: 'completed',
    output: [{ id: 'rs_2', type: 'reasoning', summary: [], encrypted_content: 'opaque' }],
  });
  assert.equal(r2.content[0].type, 'redacted_thinking');
});

test('response responses->messages: web_search_call fails closed, refusal becomes text', () => {
  assert.throws(
    () => response('responses', 'messages', { model: 'm', status: 'completed', output: [{ type: 'web_search_call', id: 'w' }] }),
    ConversionError
  );
  const r = response('responses', 'messages', {
    model: 'm',
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
  });
  assert.deepEqual(r.content, [{ type: 'text', text: 'no' }]);
});

test('response responses->messages: url citations rendered as simplified Sources block', () => {
  const r = response('responses', 'messages', {
    model: 'm',
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'answer',
            annotations: [
              { type: 'url_citation', url: 'https://a.example/x(1)', title: 'A [doc]' },
              { type: 'url_citation', url: 'https://b.example/', title: 'B' },
              { type: 'other_annotation' },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(r.content.length, 2);
  assert.equal(r.content[0].text, 'answer');
  // Simplified rendering: brackets in titles are neutralized, parens in URLs escaped.
  const sources = r.content[1].text;
  assert.ok(sources.startsWith('Sources: '));
  assert.ok(sources.includes('[A  doc](https://a.example/x%281%29)'));
  assert.ok(sources.includes('[B](https://b.example/)'));
  assert.ok(!sources.includes('[doc]('));
});

// ---------------------------------------------------------------------------
// response: messages → responses
// ---------------------------------------------------------------------------

test('response messages->responses: text envelope', () => {
  const r = response('messages', 'responses', {
    id: 'msg_1',
    type: 'message',
    model: 'm',
    content: [{ type: 'text', text: 'n' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 4, output_tokens: 2 },
  });
  assert.equal(r.id, 'resp_msg_1');
  assert.equal(r.object, 'response');
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.output, [
    {
      id: 'resp_msg_1_msg_0',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'n', annotations: [] }],
    },
  ]);
  assert.deepEqual(r.usage, {
    input_tokens: 4,
    output_tokens: 2,
    total_tokens: 6,
    output_tokens_details: { reasoning_tokens: 0 },
  });
});

test('response messages->responses: tool_use to function_call with canonical args', () => {
  const r = response('messages', 'responses', {
    type: 'message',
    model: 'm',
    content: [
      { type: 'text', text: 'using' },
      { type: 'tool_use', id: 't1', name: 'f', input: { b: 2, a: 1 } },
    ],
    stop_reason: 'tool_use',
  });
  assert.equal(r.output.length, 2);
  assert.deepEqual(r.output[0], {
    id: 'resp_ccswitch_msg_0',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'using', annotations: [] }],
  });
  assert.deepEqual(r.output[1], {
    id: 'fc_t1',
    type: 'function_call',
    status: 'completed',
    call_id: 't1',
    name: 'f',
    arguments: '{"a":1,"b":2}',
  });
});

test('response messages->responses: thinking block round-trips through encrypted_content', () => {
  const block = { type: 'thinking', thinking: 'hmm', signature: 'sig_x' };
  const r = response('messages', 'responses', { type: 'message', model: 'm', content: [block], stop_reason: 'end_turn' });
  const item = r.output[0];
  assert.equal(item.type, 'reasoning');
  assert.deepEqual(item.summary, [{ type: 'summary_text', text: 'hmm' }]);
  assert.ok(item.encrypted_content.startsWith('ccswitch-anthropic-thinking-v1:'));
  // decode back
  const decoded = JSON.parse(
    Buffer.from(item.encrypted_content.slice('ccswitch-anthropic-thinking-v1:'.length), 'base64url').toString('utf8')
  );
  assert.deepEqual(decoded, block);
  // unsigned thinking is skipped
  const r2 = response('messages', 'responses', {
    type: 'message',
    model: 'm',
    content: [{ type: 'thinking', thinking: 'plain' }],
  });
  assert.deepEqual(r2.output, []);
});

test('response messages->responses: stop_reason status table', () => {
  const mk = (stop) => response('messages', 'responses', { type: 'message', model: 'm', content: [], stop_reason: stop });
  assert.deepEqual(
    { status: mk('max_tokens').status, reason: mk('max_tokens').incomplete_details?.reason },
    { status: 'incomplete', reason: 'max_output_tokens' }
  );
  assert.deepEqual(
    { status: mk('model_context_window_exceeded').status, reason: mk('model_context_window_exceeded').incomplete_details?.reason },
    { status: 'incomplete', reason: 'max_output_tokens' }
  );
  assert.deepEqual(
    { status: mk('refusal').status, reason: mk('refusal').incomplete_details?.reason },
    { status: 'incomplete', reason: 'content_filter' }
  );
  assert.equal(mk('end_turn').status, 'completed');
  assert.ok(!('incomplete_details' in mk('end_turn')));
});

test('response messages->responses: usage inverse math', () => {
  const r = response('messages', 'responses', {
    type: 'message',
    model: 'm',
    content: [],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      output_tokens_details: { thinking_tokens: 4 },
    },
  });
  assert.equal(r.usage.input_tokens, 15); // fresh + cache_read + cache_creation
  assert.deepEqual(r.usage.input_tokens_details, { cached_tokens: 3, cache_write_tokens: 2 });
  assert.equal(r.usage.cache_creation_input_tokens, 2);
  assert.deepEqual(r.usage.output_tokens_details, { reasoning_tokens: 4 });
  assert.equal(r.usage.total_tokens, 20);
});

test('response messages->responses: error envelope throws', () => {
  assert.throws(
    () => response('messages', 'responses', { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
    ConversionError
  );
  assert.throws(() => response('messages', 'responses', { error: { message: 'bad' } }), ConversionError);
});

// ---------------------------------------------------------------------------
// SSE: responses upstream → anthropic
// ---------------------------------------------------------------------------

test('SSE responses->messages: message_start deferred until first substantive delta', () => {
  const conv = createSse('responses', 'messages');
  let out = conv.push(sse('response.created', { type: 'response.created', response: { id: 'resp_9', model: 'gpt-5' } }));
  assert.equal(out, ''); // deferred
  out += conv.push(sse('response.in_progress', { type: 'response.in_progress', response: { id: 'resp_9' } }));
  assert.equal(out, '');
  out += conv.push(sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'Hi' }));
  const ts = types(out);
  assert.deepEqual(ts, ['message_start', 'content_block_start', 'content_block_delta']);
  const start = dataOf(events(out)[0]);
  assert.equal(start.message.id, 'resp_9');
  assert.equal(start.message.model, 'gpt-5');
  const delta = dataOf(events(out)[2]);
  assert.deepEqual(delta.delta, { type: 'text_delta', text: 'Hi' });
  assert.equal(delta.index, 0);
});

test('SSE responses->messages: completed closes stream with usage and stop_reason', () => {
  const conv = createSse('responses', 'messages');
  let out = conv.push(sse('response.created', { response: { id: 'resp_1', model: 'm' } }));
  out += conv.push(sse('response.output_text.delta', { delta: 'Hello' }));
  out += conv.push(
    sse('response.completed', {
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 20 } },
      },
    })
  );
  assert.equal(conv.end(), '');
  const ts = types(out);
  assert.ok(ts.includes('message_start'));
  assert.ok(ts.includes('content_block_start'));
  assert.ok(ts.includes('content_block_delta'));
  assert.ok(ts.includes('content_block_stop'));
  const md = dataOf(events(out).find((b) => dataOf(b).type === 'message_delta'));
  assert.equal(md.delta.stop_reason, 'end_turn');
  assert.equal(md.delta.stop_sequence, null);
  assert.equal(md.usage.input_tokens, 80); // 100 - 20 cached
  assert.equal(md.usage.output_tokens, 5);
  assert.equal(md.usage.cache_read_input_tokens, 20);
  assert.ok(ts.includes('message_stop'));
  // no [DONE] sentinel on the Anthropic wire
  assert.ok(!out.includes('[DONE]'));
});

test('SSE responses->messages: function_call lifecycle with deltas and tool_use stop', () => {
  const conv = createSse('responses', 'messages');
  let out = '';
  out += conv.push(
    sse('response.output_item.added', {
      item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'f' },
    })
  );
  out += conv.push(sse('response.function_call_arguments.delta', { item_id: 'fc1', delta: '{"a":' }));
  out += conv.push(sse('response.function_call_arguments.delta', { item_id: 'fc1', delta: '1}' }));
  out += conv.push(sse('response.function_call_arguments.done', { item_id: 'fc1', arguments: '{"a":1}' }));
  out += conv.push(sse('response.completed', { response: { id: 'r', status: 'completed' } }));
  const ts = types(out);
  assert.deepEqual(ts, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  const start = dataOf(events(out)[1]);
  assert.deepEqual(start.content_block, { type: 'tool_use', id: 'c1', name: 'f' });
  assert.equal(start.index, 0);
  const md = dataOf(events(out).find((b) => dataOf(b).type === 'message_delta'));
  assert.equal(md.delta.stop_reason, 'tool_use');
});

test('SSE responses->messages: arguments.done flushes args when gateway skipped deltas', () => {
  const conv = createSse('responses', 'messages');
  let out = conv.push(
    sse('response.output_item.added', {
      item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'f' },
    })
  );
  out += conv.push(sse('response.function_call_arguments.done', { item_id: 'fc1', arguments: '{"a":1}' }));
  const ts = types(out);
  const deltaIdx = ts.indexOf('content_block_delta');
  assert.ok(deltaIdx >= 0);
  assert.deepEqual(dataOf(events(out)[deltaIdx]).delta, { type: 'input_json_delta', partial_json: '{"a":1}' });
  assert.equal(ts[ts.length - 1], 'content_block_stop');
});

test('SSE responses->messages: thinking lifecycle closes open text block first', () => {
  const conv = createSse('responses', 'messages');
  let out = conv.push(sse('response.output_text.delta', { delta: 'text' }));
  out += conv.push(sse('response.reasoning_summary_text.delta', { item_id: 'rs1', delta: 'why' }));
  const ts = types(out);
  assert.deepEqual(ts, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
  ]);
  const thinkStart = dataOf(events(out)[4]);
  assert.deepEqual(thinkStart.content_block, { type: 'thinking', thinking: '' });
  assert.equal(thinkStart.index, 1);
  assert.deepEqual(dataOf(events(out)[5]).delta, { type: 'thinking_delta', thinking: 'why' });
});

test('SSE responses->messages: reasoning item done carries signature envelope or redacted block', () => {
  const item = { id: 'rs1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'why' }], encrypted_content: 'opaque' };
  const conv = createSse('responses', 'messages');
  let out = conv.push(sse('response.output_item.added', { item }));
  out += conv.push(sse('response.reasoning_summary_text.delta', { item_id: 'rs1', delta: 'why' }));
  out += conv.push(sse('response.output_item.done', { item }));
  const ts = types(out);
  assert.deepEqual(ts, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop']);
  const sig = dataOf(events(out)[3]);
  assert.equal(sig.delta.type, 'signature_delta');
  assert.ok(sig.delta.signature.startsWith('ccswitch-openai-reasoning-v1:'));
  // summary-less encrypted item becomes redacted_thinking
  const item2 = { id: 'rs2', type: 'reasoning', summary: [], encrypted_content: 'opaque' };
  const conv2 = createSse('responses', 'messages');
  const out2 = conv2.push(sse('response.output_item.done', { item: item2 }));
  const start2 = dataOf(events(out2).find((b) => dataOf(b).type === 'content_block_start'));
  assert.equal(start2.content_block.type, 'redacted_thinking');
  assert.ok(start2.content_block.data.startsWith('ccswitch-openai-reasoning-v1:'));
});

test('SSE responses->messages: failed terminal event emits error without message_stop', () => {
  const conv = createSse('responses', 'messages');
  let out = conv.push(sse('response.output_text.delta', { delta: 'x' }));
  out += conv.push(sse('response.failed', { response: { status: 'failed', error: { code: 'server_error', message: 'boom' } } }));
  const err = dataOf(events(out).find((b) => b.startsWith('event: error')));
  assert.deepEqual(err, { type: 'error', error: { type: 'server_error', message: 'boom' } });
  assert.ok(!out.includes('message_stop'));
  assert.equal(conv.push(sse('response.output_text.delta', { delta: 'late' })), '');
  assert.equal(conv.end(), '');
});

test('SSE responses->messages: incomplete response maps to max_tokens stop', () => {
  const conv = createSse('responses', 'messages');
  let out = conv.push(sse('response.output_text.delta', { delta: 'partial' }));
  out += conv.push(
    sse('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })
  );
  const md = dataOf(events(out).find((b) => dataOf(b).type === 'message_delta'));
  assert.equal(md.delta.stop_reason, 'max_tokens');
});

test('SSE responses->messages: text-only truncation flushes max_tokens completion', () => {
  const conv = createSse('responses', 'messages');
  let out = conv.push(sse('response.created', { response: { id: 'resp_t', model: 'm' } }));
  out += conv.push(sse('response.output_text.delta', { delta: 'partial' }));
  out += conv.end();
  const ts = types(out);
  assert.ok(ts.includes('content_block_stop'));
  const md = dataOf(events(out).find((b) => dataOf(b).type === 'message_delta'));
  assert.equal(md.delta.stop_reason, 'max_tokens');
  assert.deepEqual(md.usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(ts[ts.length - 1], 'message_stop');
});

test('SSE responses->messages: dangling tool block truncation fails closed', () => {
  const conv = createSse('responses', 'messages');
  let out = conv.push(
    sse('response.output_item.added', { item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'f' } })
  );
  out += conv.push(sse('response.function_call_arguments.delta', { item_id: 'fc1', delta: '{"a":' }));
  out += conv.end();
  const err = dataOf(events(out).find((b) => b.startsWith('event: error')));
  assert.deepEqual(err, {
    type: 'error',
    error: { type: 'stream_truncated', message: 'Responses upstream stream ended before a terminal event' },
  });
  assert.ok(!out.includes('message_stop'));
});

test('SSE responses->messages: empty stream truncation fails closed', () => {
  const conv = createSse('responses', 'messages');
  const out = conv.end();
  assert.ok(out.includes('stream_truncated'));
});

test('SSE responses->messages: utf-8 safe stitching across chunk boundary', () => {
  const conv = createSse('responses', 'messages');
  const ev = sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'a😊b' });
  const bytes = Buffer.from(ev, 'utf8');
  const cut = bytes.length - 2; // split inside the emoji
  const out = conv.push(bytes.subarray(0, cut)) + conv.push(bytes.subarray(cut));
  assert.ok(out.includes('a😊b'));
});

test('SSE responses->messages: [DONE] sentinel tolerated and final block without blank line processed', () => {
  const conv = createSse('responses', 'messages');
  let out = conv.push(sse('response.output_text.delta', { delta: 'x' }));
  out += conv.push('data: [DONE]\n\n');
  assert.equal(conv.push('data: {"type":"response.completed","response":{"status":"completed"}}'), '');
  out += conv.end();
  // the completed event came through end()'s residual flush
  assert.ok(out.includes('message_stop'));
});

// ---------------------------------------------------------------------------
// SSE: anthropic upstream → responses
// ---------------------------------------------------------------------------

test('SSE messages->responses: text stream full lifecycle', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 12 } } }));
  const head = events(out).map(dataOf);
  assert.deepEqual(head.map((e) => e.type), ['response.created', 'response.in_progress']);
  assert.equal(head[0].response.id, 'resp_msg_1');
  assert.equal(head[0].response.model, 'claude');
  assert.equal(head[0].response.status, 'in_progress');

  out += conv.push(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  let added = events(out).slice(2).map(dataOf);
  assert.deepEqual(added.map((e) => e.type), ['response.output_item.added', 'response.content_part.added']);
  assert.deepEqual(added[0].item, { id: 'resp_msg_1_msg_0', type: 'message', status: 'in_progress', role: 'assistant', content: [] });

  out += conv.push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }));
  assert.ok(out.includes('"type":"response.output_text.delta"'));
  assert.ok(out.includes('"delta":"Hello"'));

  out += conv.push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
  added = events(out).slice(-3).map(dataOf);
  assert.deepEqual(added.map((e) => e.type), [
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
  ]);
  assert.equal(added[2].item.content[0].text, 'Hello');

  out += conv.push(
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })
  );
  assert.equal(events(out).slice(-1).map(dataOf)[0].type, 'response.output_item.done'); // message_delta emits nothing

  out += conv.push(sse('message_stop', { type: 'message_stop' }));
  assert.equal(conv.end(), '');
  const completed = dataOf(events(out).slice(-1)[0]);
  assert.equal(completed.type, 'response.completed');
  assert.equal(completed.response.status, 'completed');
  assert.equal(completed.response.usage.input_tokens, 12);
  assert.equal(completed.response.usage.output_tokens, 3);
  assert.equal(completed.response.output.length, 1);
});

test('SSE messages->responses: tool_use stream emits function_call events', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { message: { id: 'msg_2', model: 'claude' } }));
  out += conv.push(
    sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } })
  );
  out += conv.push(
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"Tokyo"}' } })
  );
  out += conv.push(sse('content_block_stop', { index: 0 }));
  out += conv.push(sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }));
  out += conv.push(sse('message_stop'));
  assert.ok(out.includes('"type":"response.function_call_arguments.delta"'));
  assert.ok(out.includes('"type":"response.function_call_arguments.done"'));
  assert.ok(out.includes('"call_id":"toolu_1"'));
  const done = dataOf(events(out).find((b) => dataOf(b).type === 'response.function_call_arguments.done'));
  assert.equal(done.arguments, '{"city":"Tokyo"}');
  const itemDone = dataOf(events(out).find((b) => dataOf(b).type === 'response.output_item.done'));
  assert.equal(itemDone.item.type, 'function_call');
  assert.equal(itemDone.item.status, 'completed');
  assert.equal(itemDone.item.arguments, '{"city":"Tokyo"}');
  const completed = dataOf(events(out).slice(-1)[0]);
  assert.equal(completed.response.status, 'completed');
  // no [DONE] on Responses wire
  assert.ok(!out.includes('[DONE]'));
});

test('SSE messages->responses: tool input only on content_block_start is recovered', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { message: { id: 'msg_si', model: 'claude' } }));
  out += conv.push(
    sse('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_i', name: 'get_weather', input: { city: 'Tokyo' } },
    })
  );
  out += conv.push(sse('content_block_stop', { index: 0 }));
  out += conv.push(sse('message_delta', { delta: { stop_reason: 'tool_use' } }));
  out += conv.push(sse('message_stop'));
  assert.ok(out.includes('"type":"response.function_call_arguments.done"'));
  assert.ok(out.includes('Tokyo'));
  // no delta event was emitted for the start-event-only input
  assert.ok(!out.includes('"type":"response.function_call_arguments.delta"'));
});

test('SSE messages->responses: thinking stream stores signature in encrypted envelope', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { message: { id: 'msg_3', model: 'claude' } }));
  out += conv.push(sse('content_block_start', { index: 0, content_block: { type: 'thinking' } }));
  out += conv.push(sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }));
  out += conv.push(sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig_abc' } }));
  // signature_delta must not emit an event
  assert.ok(!out.includes('signature'));
  out += conv.push(sse('content_block_stop', { index: 0 }));
  out += conv.push(sse('message_delta', { delta: { stop_reason: 'end_turn' } }));
  out += conv.push(sse('message_stop'));
  assert.ok(out.includes('"type":"response.reasoning_summary_text.delta"'));
  assert.ok(out.includes('"delta":"hmm"'));
  assert.ok(out.includes('ccswitch-anthropic-thinking-v1:'));
  const itemDone = dataOf(events(out).find((b) => dataOf(b).type === 'response.output_item.done'));
  assert.equal(itemDone.item.type, 'reasoning');
  assert.ok(!('status' in itemDone.item));
  const encoded = itemDone.item.encrypted_content.slice('ccswitch-anthropic-thinking-v1:'.length);
  const block = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(block.signature, 'sig_abc');
  assert.equal(block.thinking, 'hmm');
});

test('SSE messages->responses: redacted thinking has no visible summary', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { message: { id: 'msg_r', model: 'claude' } }));
  out += conv.push(sse('content_block_start', { index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } }));
  out += conv.push(sse('content_block_stop', { index: 0 }));
  out += conv.push(sse('message_stop'));
  assert.ok(!out.includes('reasoning_summary_text.done'));
  assert.ok(out.includes('ccswitch-anthropic-thinking-v1:'));
  const itemDone = dataOf(events(out).find((b) => dataOf(b).type === 'response.output_item.done'));
  assert.deepEqual(itemDone.item.summary, []);
});

test('SSE messages->responses: upstream error event becomes response.failed', () => {
  const conv = createSse('messages', 'responses');
  let out = conv.push(sse('message_start', { message: { id: 'msg_6', model: 'claude' } }));
  out += conv.push(sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'boom' } }));
  const failed = dataOf(events(out).find((b) => dataOf(b).type === 'response.failed'));
  assert.equal(failed.response.status, 'failed');
  assert.deepEqual(failed.response.error, { message: 'boom', type: 'overloaded_error' });
  assert.equal(conv.push(sse('message_stop')), '');
  assert.equal(conv.end(), '');
  assert.ok(!out.includes('response.completed'));
});

test('SSE messages->responses: late error after message_stop emits only one terminal', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { message: { id: 'msg_terminal' } }));
  out += conv.push(sse('message_stop'));
  out += conv.push(sse('error', { type: 'error', error: { message: 'late' } }));
  assert.equal(events(out).filter((b) => dataOf(b).type === 'response.completed').length, 1);
  assert.equal(events(out).filter((b) => dataOf(b).type === 'response.failed').length, 0);
});

test('SSE messages->responses: truncation with partial output reports incomplete', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { message: { id: 'msg_t1', model: 'claude', usage: { input_tokens: 4 } } }));
  out += conv.push(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
  out += conv.push(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'partial' } }));
  out += conv.end();
  assert.ok(out.includes('"delta":"partial"'));
  const completed = dataOf(events(out).find((b) => dataOf(b).type === 'response.completed'));
  assert.equal(completed.response.status, 'incomplete');
  assert.deepEqual(completed.response.incomplete_details, { reason: 'max_output_tokens' });
});

test('SSE messages->responses: truncated tool call is incomplete without arguments.done', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { message: { id: 'msg_tt', model: 'claude' } }));
  out += conv.push(
    sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'exec' } })
  );
  out += conv.push(sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } }));
  out += conv.end();
  assert.ok(!out.includes('"type":"response.function_call_arguments.done"'));
  const completed = dataOf(events(out).find((b) => dataOf(b).type === 'response.completed'));
  assert.equal(completed.response.status, 'incomplete');
  const itemDone = dataOf(events(out).find((b) => dataOf(b).type === 'response.output_item.done'));
  assert.equal(itemDone.item.status, 'incomplete');
});

test('SSE messages->responses: truncation without output reports failed', () => {
  const conv = createSse('messages', 'responses');
  let out = conv.push(sse('message_start', { message: { id: 'msg_t2', model: 'claude' } }));
  out += conv.end();
  assert.ok(out.includes('event: response.failed'));
  assert.ok(out.includes('stream_truncated'));
  assert.ok(!out.includes('response.completed'));
});

test('SSE messages->responses: stop_reason without message_stop completes normally', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { message: { id: 'msg_t3', model: 'claude' } }));
  out += conv.push(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
  out += conv.push(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'done' } }));
  out += conv.push(sse('content_block_stop', { index: 0 }));
  out += conv.push(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }));
  out += conv.end();
  const completed = dataOf(events(out).find((b) => dataOf(b).type === 'response.completed'));
  assert.equal(completed.response.status, 'completed');
  assert.ok(!out.includes('response.failed'));
});

test('SSE messages->responses: max_tokens stop maps to incomplete', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { message: { id: 'msg_4', model: 'claude' } }));
  out += conv.push(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
  out += conv.push(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'partial' } }));
  out += conv.push(sse('content_block_stop', { index: 0 }));
  out += conv.push(sse('message_delta', { delta: { stop_reason: 'max_tokens' } }));
  out += conv.push(sse('message_stop'));
  const completed = dataOf(events(out).slice(-1)[0]);
  assert.equal(completed.type, 'response.completed');
  assert.equal(completed.response.status, 'incomplete');
  assert.deepEqual(completed.response.incomplete_details, { reason: 'max_output_tokens' });
});

test('SSE messages->responses: Read tool drops empty pages argument', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { message: { id: 'msg_5', model: 'claude' } }));
  out += conv.push(
    sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_r', name: 'Read' } })
  );
  out += conv.push(
    sse('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/x","pages":""}' },
    })
  );
  out += conv.push(sse('content_block_stop', { index: 0 }));
  out += conv.push(sse('message_stop'));
  assert.ok(out.includes('/tmp/x'));
  assert.ok(!out.includes('pages'));
  // Read-tool args are buffered, so no mid-stream arguments.delta was emitted
  assert.ok(!out.includes('"type":"response.function_call_arguments.delta"'));
});

test('SSE messages->responses: JSON document body becomes a full responses stream', () => {
  const conv = createSse('messages', 'responses');
  const body = JSON.stringify({
    id: 'msg_json',
    type: 'message',
    role: 'assistant',
    model: 'claude',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 4, output_tokens: 2 },
  });
  const out = conv.push(body + '\n') + conv.end();
  assert.ok(out.includes('event: response.created'));
  assert.ok(out.includes('event: response.output_text.delta'));
  assert.ok(out.includes('"delta":"Hello"'));
  const completed = dataOf(events(out).find((b) => dataOf(b).type === 'response.completed'));
  assert.equal(completed.response.status, 'completed');
  assert.ok(!out.includes('response.failed'));
});

test('SSE messages->responses: non-object JSON body fails gracefully', () => {
  const conv = createSse('messages', 'responses');
  const out = conv.push('[1,2,3]') + conv.end();
  const failed = dataOf(events(out).find((b) => dataOf(b).type === 'response.failed'));
  assert.equal(failed.response.error.type, 'invalid_response');
});

test('SSE messages->responses: final event without blank line is processed', () => {
  const conv = createSse('messages', 'responses');
  let out = '';
  out += conv.push(sse('message_start', { message: { id: 'msg_tail', model: 'claude' } }));
  out += conv.push(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
  out += conv.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"tail"}}');
  out += conv.end();
  assert.ok(out.includes('"delta":"tail"'));
  const completed = dataOf(events(out).find((b) => dataOf(b).type === 'response.completed'));
  assert.equal(completed.response.status, 'incomplete');
});
