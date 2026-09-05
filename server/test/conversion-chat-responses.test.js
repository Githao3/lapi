import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, response, createSse } from '../conversion/chat-responses.mjs';
import { ConversionError } from '../conversion/errors.mjs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function dataLine(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

function eventLine(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

function toolCallDataLine(tc) {
  return dataLine({ choices: [{ index: 0, delta: { tool_calls: [tc] } }] });
}

function parseEvents(out) {
  const events = [];
  for (const block of out.split('\n\n').filter((b) => b.trim().length > 0)) {
    const lines = block.split('\n');
    let event = null;
    let dataText = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataText += line.slice(6);
    }
    let data = null;
    try {
      data = JSON.parse(dataText);
    } catch {
      /* keep raw */
    }
    events.push({ event, dataText, data });
  }
  return events;
}

// ---------------------------------------------------------------------------
// REQUEST: chat -> responses
// ---------------------------------------------------------------------------

test('request chat->responses: user text becomes input_text item (legacy parity)', () => {
  const r = request('chat', 'responses', { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 });
  assert.equal(r.model, 'm');
  assert.equal(r.input[0].type, 'message');
  assert.equal(r.input[0].role, 'user');
  assert.equal(r.input[0].content[0].type, 'input_text');
  assert.equal(r.input[0].content[0].text, 'hi');
  assert.equal(r.max_output_tokens, 50);
});

test('request chat->responses: first system message hoists to instructions', () => {
  const r = request('chat', 'responses', {
    model: 'm',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'system', content: 'never lie' },
      { role: 'user', content: 'q' },
    ],
  });
  assert.equal(r.instructions, 'be terse');
  assert.equal(r.input.length, 1);
  assert.equal(r.input[0].content[0].text, 'q');
});

test('request chat->responses: assistant tool_calls become function_call items after text', () => {
  const r = request('chat', 'responses', {
    model: 'm',
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'wx', arguments: '{"city":"SF"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":60}' },
    ],
  });
  assert.equal(r.input[0].content[0].text, 'weather?');
  const fc = r.input[1];
  assert.equal(fc.type, 'function_call');
  assert.equal(fc.call_id, 'call_1');
  assert.equal(fc.name, 'wx');
  assert.equal(fc.arguments, '{"city":"SF"}'); // stays a JSON string
  const out = r.input[2];
  assert.equal(out.type, 'function_call_output');
  assert.equal(out.call_id, 'call_1');
  assert.equal(out.output[0].type, 'input_text');
  assert.equal(out.output[0].text, '{"temp":60}');
});

test('request chat->responses: image_url part becomes input_image', () => {
  const r = request('chat', 'responses', {
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'https://x/img.png' } },
        ],
      },
    ],
  });
  const content = r.input[0].content;
  assert.equal(content[0].type, 'input_text');
  assert.equal(content[1].type, 'input_image');
  assert.deepEqual(content[1].image_url, { url: 'https://x/img.png' });
});

test('request chat->responses: reasoning_content carries as reasoning summary item before assistant', () => {
  const r = request('chat', 'responses', {
    model: 'm',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', reasoning_content: 'because' },
    ],
  });
  assert.equal(r.input[1].type, 'reasoning');
  assert.equal(r.input[1].summary[0].type, 'summary_text');
  assert.equal(r.input[1].summary[0].text, 'because');
  assert.equal(r.input[2].type, 'message');
  assert.equal(r.input[2].content[0].type, 'output_text');
});

test('request chat->responses: params mapping (stop/stream_options dropped, effort mapped)', () => {
  const r = request('chat', 'responses', {
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
    stop: ['END'],
    stream_options: { include_usage: true },
    temperature: 0.4,
    top_p: 0.9,
    reasoning_effort: 'max',
  });
  assert.equal(r.max_output_tokens, 100);
  assert.equal(r.stop, undefined);
  assert.equal(r.stream_options, undefined);
  assert.equal(r.temperature, 0.4);
  assert.equal(r.top_p, 0.9);
  assert.deepEqual(r.reasoning, { effort: 'xhigh' });
});

test('request chat->responses: tools flatten and tool_choice inverts', () => {
  const r = request('chat', 'responses', {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'f' } },
    parallel_tool_calls: false,
  });
  assert.deepEqual(r.tools, [
    { type: 'function', name: 'f', description: 'd', parameters: { type: 'object', properties: {} } },
  ]);
  assert.deepEqual(r.tool_choice, { type: 'function', name: 'f' });
  assert.equal(r.parallel_tool_calls, false);
});

test('request chat->responses: empty messages throw ConversionError', () => {
  assert.throws(() => request('chat', 'responses', { model: 'm', messages: [] }), ConversionError);
  assert.throws(() => request('chat', 'responses', { model: 'm' }), ConversionError);
});

// ---------------------------------------------------------------------------
// REQUEST: responses -> chat
// ---------------------------------------------------------------------------

test('request responses->chat: instructions + string input (legacy parity)', () => {
  const r = request('responses', 'chat', { model: 'm', input: 'hi2', instructions: 'sys' });
  assert.equal(r.messages[0].role, 'system');
  assert.equal(r.messages[0].content, 'sys');
  assert.equal(r.messages[1].role, 'user');
  assert.equal(r.messages[1].content, 'hi2');
  assert.equal(r.messages.length, 2);
});

test('request responses->chat: function_call/output round trip keeps arguments a string', () => {
  const r = request('responses', 'chat', {
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'function_call', call_id: 'call_1', name: 'wx', arguments: '{"city":"SF"}' },
      { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: '{"temp":60}' }] },
    ],
  });
  assert.equal(r.messages[0].content, 'weather?');
  const assistant = r.messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'wx', arguments: '{"city":"SF"}' } },
  ]);
  const tool = r.messages[2];
  assert.equal(tool.role, 'tool');
  assert.equal(tool.tool_call_id, 'call_1');
  assert.equal(tool.content, '{"temp":60}');
});

test('request responses->chat: incomplete tool turn is dropped', () => {
  const r = request('responses', 'chat', {
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'call_x', name: 'wx', arguments: '{}' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ],
  });
  // the unmatched function_call turn (assistant tool_calls) is dropped, user turn stays
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, 'user');
  assert.equal(r.messages[0].content, 'hello');
});

test('request responses->chat: orphaned tool output without call pair is dropped', () => {
  const r = request('responses', 'chat', {
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { type: 'function_call_output', call_id: 'ghost', output: [{ type: 'input_text', text: 'x' }] },
    ],
  });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, 'user');
});

test('request responses->chat: reasoning item attaches to following assistant message', () => {
  const r = request('responses', 'chat', {
    model: 'm',
    input: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking hard' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ],
  });
  assert.equal(r.messages[0].role, 'assistant');
  assert.equal(r.messages[0].reasoning_content, 'thinking hard');
  assert.equal(r.messages[0].content, 'answer');
});

test('request responses->chat: inline <think> block splits into reasoning_content', () => {
  const r = request('responses', 'chat', {
    model: 'm',
    input: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<think>why</think>\n\nanswer' }] },
    ],
  });
  assert.equal(r.messages[0].reasoning_content, 'why');
  assert.equal(r.messages[0].content, 'answer');
  assert.ok(!r.messages[0].content.includes('<think>'));
});

test('request responses->chat: input_image becomes image_url part', () => {
  const r = request('responses', 'chat', {
    model: 'm',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'https://x/i.png' },
        ],
      },
    ],
  });
  assert.equal(r.messages[0].content[0].type, 'text');
  assert.equal(r.messages[0].content[0].text, 'look');
  assert.deepEqual(r.messages[0].content[1], { type: 'image_url', image_url: { url: 'https://x/i.png' } });
});

test('request responses->chat: params, o-series, and effort support heuristic', () => {
  const r = request('responses', 'chat', {
    model: 'o3-mini',
    input: 'hi',
    max_output_tokens: 77,
    temperature: 0.2,
    reasoning: { effort: 'high' },
  });
  assert.equal(r.max_completion_tokens, 77); // o-series uses max_completion_tokens
  assert.equal(r.temperature, 0.2);
  assert.equal(r.reasoning_effort, 'high');

  const r2 = request('responses', 'chat', {
    model: 'gpt-4o',
    input: 'hi',
    max_output_tokens: 77,
    reasoning: { effort: 'high' },
  });
  assert.equal(r2.max_tokens, 77);
  assert.equal(r2.max_completion_tokens, undefined);
  assert.equal(r2.reasoning_effort, undefined); // gpt-4o does not support reasoning_effort

  const r3 = request('responses', 'chat', {
    model: 'gpt-5.4',
    input: 'hi',
    reasoning: { effort: 'max' },
  });
  assert.equal(r3.reasoning_effort, 'xhigh');
});

test('request responses->chat: tools nest, tool_choice maps, stream injects include_usage', () => {
  const r = request('responses', 'chat', {
    model: 'm',
    input: 'hi',
    stream: true,
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }],
    tool_choice: 'auto',
  });
  assert.deepEqual(r.tools, [
    {
      type: 'function',
      function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } },
    },
  ]);
  assert.equal(r.tool_choice, 'auto');
  assert.deepEqual(r.stream_options, { include_usage: true });

  const r2 = request('responses', 'chat', {
    model: 'm',
    input: 'hi',
    stream: true,
    tool_choice: { type: 'function', name: 'f' },
  });
  assert.equal(r2.tool_choice, undefined); // no tools -> tool_choice dropped
});

test('request responses->chat: store/previous_response_id/include dropped, xhigh clamps', () => {
  const r = request('responses', 'chat', {
    model: 'gpt-5',
    input: 'hi',
    store: false,
    previous_response_id: 'resp_1',
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: 'xhigh' },
  });
  assert.equal(r.store, undefined);
  assert.equal(r.previous_response_id, undefined);
  assert.equal(r.include, undefined);
  assert.equal(r.reasoning_effort, 'xhigh');
});

test('request responses->chat: empty convertible input throws', () => {
  assert.throws(
    () => request('responses', 'chat', { model: 'm', input: [{ type: 'reasoning', summary: [] }] }),
    ConversionError
  );
});

test('request responses->chat: developer role collapses into system head', () => {
  const r = request('responses', 'chat', {
    model: 'm',
    instructions: 'base',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'extra rules' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
    ],
  });
  assert.equal(r.messages[0].role, 'system');
  assert.ok(r.messages[0].content.includes('base'));
  assert.ok(r.messages[0].content.includes('extra rules'));
  assert.equal(r.messages.length, 2);
});

// ---------------------------------------------------------------------------
// RESPONSE: chat -> responses
// ---------------------------------------------------------------------------

test('response chat->responses: text envelope (legacy parity, resp_ id)', () => {
  const r = response('chat', 'responses', {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 123,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'c' }, finish_reason: 'stop' }],
  });
  assert.equal(r.id, 'resp_chatcmpl-1');
  assert.equal(r.object, 'response');
  assert.equal(r.created_at, 123);
  assert.equal(r.status, 'completed');
  assert.equal(r.model, 'm');
  const item = r.output[0];
  assert.equal(item.id, 'resp_chatcmpl-1_msg_0');
  assert.equal(item.type, 'message');
  assert.equal(item.status, 'completed');
  assert.equal(item.role, 'assistant');
  assert.deepEqual(item.content, [{ type: 'output_text', text: 'c', annotations: [] }]);
  assert.ok(r.usage.input_tokens === 0 && r.usage.total_tokens === 0);
});

test('response chat->responses: reasoning_content item placed before message item', () => {
  const r = response('chat', 'responses', {
    model: 'm',
    choices: [{ message: { content: 'a', reasoning_content: 'why' }, finish_reason: 'stop' }],
  });
  assert.equal(r.output[0].type, 'reasoning');
  assert.equal(r.output[0].id, 'rs_resp_ccswitch');
  assert.deepEqual(r.output[0].summary, [{ type: 'summary_text', text: 'why' }]);
  assert.equal(r.output[1].type, 'message');
  assert.equal(r.output[1].content[0].text, 'a');
});

test('response chat->responses: tool_calls -> function_call items, finish tool_calls completes', () => {
  const r = response('chat', 'responses', {
    model: 'm',
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'wx', arguments: '{"a":1}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  assert.equal(r.status, 'completed');
  assert.equal(r.output.length, 1);
  const fc = r.output[0];
  assert.equal(fc.id, 'fc_call_9');
  assert.equal(fc.type, 'function_call');
  assert.equal(fc.status, 'completed');
  assert.equal(fc.call_id, 'call_9');
  assert.equal(fc.name, 'wx');
  assert.equal(fc.arguments, '{"a":1}');
});

test('response chat->responses: finish length -> incomplete with max_output_tokens details', () => {
  const r = response('chat', 'responses', {
    model: 'm',
    choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
  });
  assert.equal(r.status, 'incomplete');
  assert.deepEqual(r.incomplete_details, { reason: 'max_output_tokens' });
});

test('response chat->responses: usage maps prompt/completion/cached tokens', () => {
  const r = response('chat', 'responses', {
    model: 'm',
    choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  });
  assert.equal(r.usage.input_tokens, 10);
  assert.equal(r.usage.output_tokens, 5);
  assert.equal(r.usage.total_tokens, 15);
  assert.equal(r.usage.input_tokens_details.cached_tokens, 4);
  assert.equal(r.usage.output_tokens_details.reasoning_tokens, 2);
});

test('response chat->responses: refusal becomes refusal content part', () => {
  const r = response('chat', 'responses', {
    model: 'm',
    choices: [{ message: { content: null, refusal: 'no can do' }, finish_reason: 'stop' }],
  });
  assert.deepEqual(r.output[0].content, [{ type: 'refusal', refusal: 'no can do' }]);
});

test('response chat->responses: inline <think> content splits reasoning out', () => {
  const r = response('chat', 'responses', {
    model: 'm',
    choices: [{ message: { content: '<think>hmm</think>visible' }, finish_reason: 'stop' }],
  });
  assert.equal(r.output[0].type, 'reasoning');
  assert.equal(r.output[0].summary[0].text, 'hmm');
  assert.equal(r.output[1].content[0].text, 'visible');
  assert.ok(!r.output[1].content[0].text.includes('<think>'));
});

test('response chat->responses: unnamed-only tool calls on completed turn throw', () => {
  assert.throws(
    () =>
      response('chat', 'responses', {
        model: 'm',
        choices: [
          {
            message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: '', arguments: '{}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    /without a function name/
  );
});

test('response chat->responses: missing choices / message throw ConversionError', () => {
  assert.throws(() => response('chat', 'responses', { model: 'm' }), ConversionError);
  assert.throws(() => response('chat', 'responses', { model: 'm', choices: [] }), ConversionError);
  assert.throws(
    () => response('chat', 'responses', { model: 'm', choices: [{ finish_reason: 'stop' }] }),
    ConversionError
  );
});

// ---------------------------------------------------------------------------
// RESPONSE: responses -> chat
// ---------------------------------------------------------------------------

test('response responses->chat: single output_text collapses to content string (legacy parity)', () => {
  const r = response('responses', 'chat', {
    id: 'r',
    object: 'response',
    model: 'm',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 't' }] }],
  });
  assert.equal(r.object, 'chat.completion');
  assert.equal(r.choices[0].index, 0);
  assert.equal(r.choices[0].message.role, 'assistant');
  assert.equal(r.choices[0].message.content, 't');
  assert.equal(r.choices[0].finish_reason, 'stop');
});

test('response responses->chat: multiple text parts become content array; reasoning becomes reasoning_content', () => {
  const r = response('responses', 'chat', {
    id: 'r',
    object: 'response',
    model: 'm',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'part1' },
          { type: 'output_text', text: 'part2' },
        ],
      },
    ],
  });
  assert.equal(r.choices[0].message.reasoning_content, 'think');
  assert.deepEqual(r.choices[0].message.content, [
    { type: 'text', text: 'part1' },
    { type: 'text', text: 'part2' },
  ]);
});

test('response responses->chat: function_call items become tool_calls with finish tool_calls', () => {
  const r = response('responses', 'chat', {
    id: 'r',
    object: 'response',
    model: 'm',
    output: [
      { type: 'function_call', call_id: 'call_5', name: 'wx', arguments: '{"a":1}' },
    ],
  });
  assert.equal(r.choices[0].message.content, null);
  assert.deepEqual(r.choices[0].message.tool_calls, [
    { id: 'call_5', type: 'function', function: { name: 'wx', arguments: '{"a":1}' } },
  ]);
  assert.equal(r.choices[0].finish_reason, 'tool_calls');
});

test('response responses->chat: incomplete + usage inverse', () => {
  const r = response('responses', 'chat', {
    id: 'r',
    object: 'response',
    model: 'm',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'cut' }] }],
    usage: {
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
  });
  assert.equal(r.choices[0].finish_reason, 'length');
  assert.equal(r.usage.prompt_tokens, 7);
  assert.equal(r.usage.completion_tokens, 3);
  assert.equal(r.usage.total_tokens, 10);
  assert.equal(r.usage.prompt_tokens_details.cached_tokens, 2);
  assert.equal(r.usage.completion_tokens_details.reasoning_tokens, 1);
});

test('response responses->chat: failed envelope and error body throw ConversionError', () => {
  assert.throws(
    () =>
      response('responses', 'chat', {
        object: 'response',
        status: 'failed',
        error: { message: 'boom', type: 'server_error' },
      }),
    /boom/
  );
  assert.throws(() => response('responses', 'chat', { error: { message: 'bad' } }), ConversionError);
  assert.throws(
    () => response('responses', 'chat', { object: 'response', output: [{ type: 'file', content: [] }] }),
    ConversionError
  );
});

// ---------------------------------------------------------------------------
// SSE: chat -> responses
// ---------------------------------------------------------------------------

test('SSE chat->responses: eager created/in_progress, text deltas, [DONE] finalize with usage', () => {
  const conv = createSse('chat', 'responses');
  let out = '';
  out += conv.push(
    dataLine({ id: 'cc1', model: 'm1', created: 5, choices: [{ index: 0, delta: { content: 'a' } }] })
  );
  out += conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'b' } }] }));
  out += conv.push(dataLine({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  out += conv.push(dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  out += conv.push('data: [DONE]\n\n');

  const events = parseEvents(out);
  assert.equal(events[0].event, 'response.created');
  assert.equal(events[0].data.response.id, 'resp_cc1');
  assert.equal(events[0].data.response.model, 'm1');
  assert.equal(events[1].event, 'response.in_progress');
  assert.ok(out.includes('"type":"response.output_text.delta"'));
  assert.ok(out.includes('"a"') && out.includes('"b"'));
  const completed = events.filter((e) => e.event === 'response.completed')[0];
  assert.ok(completed, 'has response.completed');
  assert.equal(completed.data.response.status, 'completed');
  assert.equal(completed.data.response.usage.input_tokens, 3);
  assert.equal(completed.data.response.output[0].content[0].text, 'ab');
  assert.ok(!out.includes('response.failed'));
  assert.equal(conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'late' } }] })), '');
  assert.equal(conv.end(), '');
});

test('SSE chat->responses: reasoning lifecycle finalizes before tool calls start', () => {
  const conv = createSse('chat', 'responses');
  let out = '';
  out += conv.push(dataLine({ choices: [{ index: 0, delta: { reasoning_content: 'think' } }] }));
  out += conv.push(
    dataLine({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '' } }] } },
      ],
    })
  );
  out += conv.push(toolCallDataLine({ index: 0, function: { arguments: '{"x":1}' } }));
  out += conv.push('data: [DONE]\n\n');

  const events = parseEvents(out);
  const types = events.map((e) => e.data?.type ?? e.event);
  const reasoningDelta = types.indexOf('response.reasoning_summary_text.delta');
  const reasoningDone = types.indexOf('response.reasoning_summary_text.done');
  const fcAdded = events.findIndex(
    (e) => e.data?.type === 'response.output_item.added' && e.data.item?.type === 'function_call'
  );
  const argsDelta = types.indexOf('response.function_call_arguments.delta');
  assert.ok(reasoningDelta >= 0, 'reasoning delta present');
  assert.ok(fcAdded > reasoningDone, 'reasoning closes before tool item added');
  assert.ok(fcAdded < argsDelta, 'args stream after item added');
  const reasoningItem = events.filter((e) => e.data?.type === 'response.output_item.done')[0];
  assert.equal(reasoningItem.data.item.type, 'reasoning');
  assert.equal(reasoningItem.data.item.summary[0].text, 'think');
  const completed = events.filter((e) => e.event === 'response.completed')[0];
  const fcItem = completed.data.response.output.find((i) => i.type === 'function_call');
  assert.equal(fcItem.name, 'f');
  assert.equal(fcItem.arguments, '{"x":1}');
  assert.equal(fcItem.call_id, 'c1');
});

test('SSE chat->responses: tool fragments before id/name are buffered, item.added deferred', () => {
  const conv = createSse('chat', 'responses');
  let out = '';
  // args arrive first, identity later
  out += conv.push(toolCallDataLine({ index: 0, function: { arguments: '{"a"' } }));
  let early = parseEvents(out);
  assert.ok(!early.some((e) => e.data?.type === 'response.output_item.added'), 'no premature item.added');
  out += conv.push(
    dataLine({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: 'cid', type: 'function', function: { name: 'f', arguments: ':1}' } }] } },
      ],
    })
  );
  out += conv.push(dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  out += conv.push('data: [DONE]\n\n');

  const events = parseEvents(out);
  const added = events.filter((e) => e.data?.type === 'response.output_item.added')[0];
  assert.ok(added, 'deferred item.added emitted once identity known');
  assert.equal(added.data.item.name, 'f');
  assert.equal(added.data.item.call_id, 'cid');
  const completed = events.filter((e) => e.event === 'response.completed')[0];
  assert.equal(completed.data.response.status, 'completed');
  assert.equal(completed.data.response.output[0].arguments, '{"a":1}');
  assert.equal(completed.data.response.output[0].id, 'fc_cid');
});

test('SSE chat->responses: parallel calls release in consecutive order, later name arrives late', () => {
  const conv = createSse('chat', 'responses');
  let out = '';
  out += conv.push(
    dataLine({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'a', type: 'function', function: { arguments: '{}' } },
              { index: 1, id: 'b', type: 'function', function: { arguments: '{}' } },
            ],
          },
        },
      ],
    })
  );
  out += conv.push(
    dataLine({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 1, type: 'function', function: { name: 'second' } },
              { index: 0, type: 'function', function: { name: 'first' } },
            ],
          },
        },
      ],
    })
  );
  out += conv.push('data: [DONE]\n\n');
  const events = parseEvents(out);
  const added = events.filter((e) => e.data?.type === 'response.output_item.added');
  assert.equal(added.length, 2);
  assert.equal(added[0].data.output_index, 0);
  assert.equal(added[0].data.item.name, 'first');
  assert.equal(added[1].data.output_index, 1);
  assert.equal(added[1].data.item.name, 'second');
});

test('SSE chat->responses: all tools dropped (no name) on completed turn -> response.failed upstream_tool_call_dropped', () => {
  const conv = createSse('chat', 'responses');
  let out = '';
  out += conv.push(
    dataLine({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'x', type: 'function', function: { arguments: '{}' } }] } }],
    })
  );
  out += conv.push(dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  out += conv.push('data: [DONE]\n\n');
  const events = parseEvents(out);
  const failed = events.filter((e) => e.event === 'response.failed')[0];
  assert.ok(failed, 'response.failed emitted');
  assert.equal(failed.data.response.status, 'failed');
  assert.equal(failed.data.response.error.type, 'upstream_tool_call_dropped');
  assert.ok(!out.includes('"response.completed"'));
});

test('SSE chat->responses: mixed valid+dropped tools still completes with the valid one', () => {
  const conv = createSse('chat', 'responses');
  let out = '';
  out += conv.push(
    dataLine({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'ok', type: 'function', function: { name: 'good', arguments: '{}' } },
              { index: 1, id: 'bad', type: 'function', function: { arguments: '{}' } },
            ],
          },
        },
      ],
    })
  );
  out += conv.push(dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  out += conv.push('data: [DONE]\n\n');
  const events = parseEvents(out);
  const completed = events.filter((e) => e.event === 'response.completed')[0];
  assert.ok(completed, 'completes when at least one usable tool call remains');
  const names = completed.data.response.output.filter((i) => i.type === 'function_call').map((i) => i.name);
  assert.deepEqual(names, ['good']);
});

test('SSE chat->responses: inline <think> split without leaking tags', () => {
  const conv = createSse('chat', 'responses');
  let out = '';
  out += conv.push(dataLine({ choices: [{ index: 0, delta: { content: '<think>why' } }] }));
  out += conv.push(dataLine({ choices: [{ index: 0, delta: { content: ' not</think>\n\nanswer' } }] }));
  out += conv.push('data: [DONE]\n\n');
  const events = parseEvents(out);
  const reasoningDelta = events.filter((e) => e.data?.type === 'response.reasoning_summary_text.delta');
  const textDelta = events.filter((e) => e.data?.type === 'response.output_text.delta');
  assert.equal(reasoningDelta.map((e) => e.data.delta).join(''), 'why not');
  assert.equal(textDelta.map((e) => e.data.delta).join(''), 'answer');
  assert.ok(!out.includes('<think>'));
  const reasoningDone = events.filter((e) => e.data?.type === 'response.reasoning_summary_part.done')[0];
  assert.ok(reasoningDone, 'reasoning item closed');
});

test('SSE chat->responses: upstream error frame -> response.failed, stream stops', () => {
  const conv = createSse('chat', 'responses');
  let out = '';
  out += conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'a' } }] }));
  out += conv.push(dataLine({ error: { message: 'overloaded', type: 'server_error' } }));
  out += conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'b' } }] }));
  out += conv.push('data: [DONE]\n\n');
  const events = parseEvents(out);
  const failed = events.filter((e) => e.event === 'response.failed')[0];
  assert.ok(failed, 'response.failed emitted');
  assert.equal(failed.data.response.error.message, 'overloaded');
  assert.equal(failed.data.response.error.type, 'server_error');
  assert.ok(!out.includes('"b"'), 'stream processing stops after error');
  assert.ok(!out.includes('response.completed'));
  assert.equal(conv.end(), '');
});

test('SSE chat->responses: truncation without finish_reason -> incomplete length; empty -> failed stream_truncated', () => {
  const conv = createSse('chat', 'responses');
  let out = conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'half' } }] }));
  out += conv.end();
  let events = parseEvents(out);
  let completed = events.filter((e) => e.event === 'response.completed')[0];
  assert.ok(completed, 'finalize on end() with substantive output');
  assert.equal(completed.data.response.status, 'incomplete');
  assert.deepEqual(completed.data.response.incomplete_details, { reason: 'max_output_tokens' });

  const conv2 = createSse('chat', 'responses');
  const out2 = conv2.end();
  const failed = parseEvents(out2).filter((e) => e.event === 'response.failed')[0];
  assert.ok(failed, 'no-output truncation reports failed');
  assert.equal(failed.data.response.error.type, 'stream_truncated');
});

test('SSE chat->responses: finish length completes with incomplete status', () => {
  const conv = createSse('chat', 'responses');
  let out = conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'x' } }] }));
  out += conv.push(dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }));
  out += conv.push('data: [DONE]\n\n');
  const events = parseEvents(out);
  const completed = events.filter((e) => e.event === 'response.completed')[0];
  assert.equal(completed.data.response.status, 'incomplete');
  assert.deepEqual(completed.data.response.incomplete_details, { reason: 'max_output_tokens' });
});

test('SSE chat->responses: message close triple (output_text.done, content_part.done, output_item.done)', () => {
  const conv = createSse('chat', 'responses');
  let out = conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'hi' } }] }));
  out += conv.push('data: [DONE]\n\n');
  const types = parseEvents(out).map((e) => e.data?.type ?? e.event);
  assert.ok(types.includes('response.output_item.added'));
  assert.ok(types.includes('response.content_part.added'));
  assert.ok(types.includes('response.output_text.done'));
  assert.ok(types.includes('response.content_part.done'));
  assert.ok(types.includes('response.output_item.done'));
  const doneItem = parseEvents(out).filter((e) => e.data?.type === 'response.output_item.done')[0];
  assert.equal(doneItem.data.item.content[0].text, 'hi');
});

// ---------------------------------------------------------------------------
// SSE: responses -> chat (inverse)
// ---------------------------------------------------------------------------

test('SSE responses->chat: output_text.delta maps to bare chat data lines', () => {
  const conv = createSse('responses', 'chat');
  let out = '';
  out += conv.push(eventLine('response.created', { type: 'response.created', response: { id: 'resp_1' } }));
  out += conv.push(dataLine({ type: 'response.output_text.delta', delta: 'z' }));
  out += conv.push(dataLine({ type: 'response.output_text.delta', delta: 'w' }));
  out += conv.push(dataLine({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } }));

  assert.ok(out.startsWith('data: {"choices"'), 'bare data lines, no event: headers');
  assert.ok(!out.includes('event:'));
  const chunks = out.split('\n\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
  const deltas = chunks.slice(0, 2).map((l) => JSON.parse(l.slice(6)));
  assert.equal(deltas[0].choices[0].delta.content, 'z');
  assert.equal(deltas[1].choices[0].delta.content, 'w');
  const final = JSON.parse(chunks[2].slice(6));
  assert.equal(final.choices[0].finish_reason, 'stop');
  assert.deepEqual(final.choices[0].delta, {});
  assert.ok(out.endsWith('data: [DONE]\n\n'));
  assert.equal(conv.end(), '');
});

test('SSE responses->chat: function_call item.added carries id+name, args deltas share its index', () => {
  const conv = createSse('responses', 'chat');
  let out = '';
  out += conv.push(
    eventLine('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'wx', arguments: '' },
    })
  );
  out += conv.push(
    dataLine({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city"' })
  );
  out += conv.push(dataLine({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: ':"SF"}' }));
  out += conv.push(
    dataLine({
      type: 'response.completed',
      response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } },
    })
  );

  const lines = out.split('\n\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
  const first = JSON.parse(lines[0].slice(6));
  const tc0 = first.choices[0].delta.tool_calls[0];
  assert.equal(tc0.index, 0);
  assert.equal(tc0.id, 'call_1');
  assert.equal(tc0.type, 'function');
  assert.equal(tc0.function.name, 'wx');
  const arg1 = JSON.parse(lines[1].slice(6)).choices[0].delta.tool_calls[0];
  assert.equal(arg1.index, 0);
  assert.equal(arg1.function.arguments, '{"city"');
  const arg2 = JSON.parse(lines[2].slice(6)).choices[0].delta.tool_calls[0];
  assert.equal(arg2.index, 0);
  assert.equal(arg2.function.arguments, ':"SF"}');
  const final = JSON.parse(lines[3].slice(6));
  assert.equal(final.choices[0].finish_reason, 'tool_calls');
  assert.equal(final.usage.prompt_tokens, 9);
  assert.equal(final.usage.completion_tokens, 4);
  assert.ok(out.includes('data: [DONE]\n\n'));
});

test('SSE responses->chat: second function_call item gets the next index', () => {
  const conv = createSse('responses', 'chat');
  let out = '';
  for (const [oid, itemId, callId] of [[0, 'fc_1', 'c1'], [1, 'fc_2', 'c2']]) {
    out += conv.push(
      eventLine('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: oid,
        item: { id: itemId, type: 'function_call', call_id: callId, name: 't' + oid, arguments: '' },
      })
    );
  }
  out += conv.push(dataLine({ type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{}' }));
  out += conv.push(dataLine({ type: 'response.completed', response: { status: 'completed' } }));
  const lines = out.split('\n\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
  assert.equal(JSON.parse(lines[0].slice(6)).choices[0].delta.tool_calls[0].index, 0);
  assert.equal(JSON.parse(lines[1].slice(6)).choices[0].delta.tool_calls[0].index, 1);
  const frag = JSON.parse(lines[2].slice(6)).choices[0].delta.tool_calls[0];
  assert.equal(frag.index, 1);
  assert.equal(frag.function.arguments, '{}');
  const final = JSON.parse(lines[3].slice(6));
  assert.equal(final.choices[0].finish_reason, 'tool_calls');
});

test('SSE responses->chat: reasoning deltas become reasoning_content chunks', () => {
  const conv = createSse('responses', 'chat');
  let out = conv.push(dataLine({ type: 'response.reasoning_summary_text.delta', delta: 'hmm' }));
  out += conv.push(dataLine({ type: 'response.output_text.delta', delta: 'ok' }));
  out += conv.push(dataLine({ type: 'response.completed', response: { status: 'completed' } }));
  const lines = out.split('\n\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
  assert.equal(JSON.parse(lines[0].slice(6)).choices[0].delta.reasoning_content, 'hmm');
  assert.equal(JSON.parse(lines[1].slice(6)).choices[0].delta.content, 'ok');
});

test('SSE responses->chat: response.failed emits chat error chunk + [DONE]', () => {
  const conv = createSse('responses', 'chat');
  let out = conv.push(
    eventLine('response.failed', {
      type: 'response.failed',
      response: { status: 'failed', error: { message: 'kaput', type: 'server_error' } },
    })
  );
  assert.ok(out.includes('"error"'));
  assert.ok(out.includes('kaput'));
  assert.ok(out.includes('data: [DONE]\n\n'));
  assert.equal(conv.push(dataLine({ type: 'response.output_text.delta', delta: 'x' })), '');
  assert.equal(conv.end(), '');
});

test('SSE responses->chat: truncated stream with output -> length finish; without -> error chunk', () => {
  const conv = createSse('responses', 'chat');
  let out = conv.push(dataLine({ type: 'response.output_text.delta', delta: 'part' }));
  out += conv.end();
  const lines = out.split('\n\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
  assert.equal(JSON.parse(lines.at(-1).slice(6)).choices[0].finish_reason, 'length');
  assert.ok(out.includes('data: [DONE]\n\n'));

  const conv2 = createSse('responses', 'chat');
  const out2 = conv2.end();
  assert.ok(out2.includes('"error"'));
  assert.ok(out2.includes('stream_truncated'));
  assert.ok(out2.includes('data: [DONE]\n\n'));
});

test('SSE responses->chat: incomplete response maps to finish length', () => {
  const conv = createSse('responses', 'chat');
  let out = conv.push(dataLine({ type: 'response.output_text.delta', delta: 'x' }));
  out += conv.push(
    dataLine({
      type: 'response.completed',
      response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    })
  );
  const lines = out.split('\n\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
  assert.equal(JSON.parse(lines.at(-1).slice(6)).choices[0].finish_reason, 'length');
});

test('SSE responses->chat: message item.added emits nothing; .end() idempotent', () => {
  const conv = createSse('responses', 'chat');
  const out = conv.push(
    eventLine('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    })
  );
  assert.equal(out, '');
  assert.equal(conv.end().length > 0, true); // truncation guard fires
  assert.equal(conv.end(), '');
});
