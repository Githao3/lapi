// Tests for the anthropic <-> chat mirror-pair converter.
// Ports the behavioral contracts of cc-switch's transform.rs / streaming.rs
// inline test suites, plus the legacy text-path shapes from conversion.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, response, createSse } from '../conversion/anthropic-chat.mjs';
import { ConversionError } from '../conversion/errors.mjs';

const dataLine = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';

function sseDataObjects(output) {
  const out = [];
  for (const block of output.split('\n\n')) {
    if (block === '') continue;
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const text = line.slice(5).trim();
    if (text === '[DONE]') continue;
    out.push(JSON.parse(text));
  }
  return out;
}

function sseTypes(output) {
  return sseDataObjects(output).map((o) => o.type);
}

// ---------------------------------------------------------------------------
// REQUEST messages -> chat
// ---------------------------------------------------------------------------

test('request messages->chat: simple text passthrough', () => {
  const r = request('messages', 'chat', {
    model: 'claude-3-opus',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(r.model, 'claude-3-opus');
  assert.equal(r.max_tokens, 1024);
  assert.deepEqual(r.messages, [{ role: 'user', content: 'Hello' }]);
});

test('request messages->chat: system string becomes leading system message', () => {
  const r = request('messages', 'chat', {
    model: 'claude-3-sonnet',
    max_tokens: 1024,
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(r.messages[0].role, 'system');
  assert.equal(r.messages[0].content, 'You are a helpful assistant.');
  assert.equal(r.messages[1].role, 'user');
});

test('request messages->chat: billing header stripped from system (string, array, kept mid-text)', () => {
  const strippedString = request('messages', 'chat', {
    model: 'm',
    system: 'x-anthropic-billing-header: cc_version=2.1.119.47e; cch=a7754;\n\nYou are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(strippedString.messages[0].content, 'You are helpful.');

  const strippedArray = request('messages', 'chat', {
    model: 'm',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cch=a7754;\n' },
      { type: 'text', text: 'Stable prompt' },
    ],
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(strippedArray.messages[0].content, 'Stable prompt');

  const samePart = request('messages', 'chat', {
    model: 'm',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cch=a7754;\n\nStable prompt part 1' },
      { type: 'text', text: 'Stable prompt part 2' },
    ],
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(samePart.messages[0].content, 'Stable prompt part 1\nStable prompt part 2');

  const kept = request('messages', 'chat', {
    model: 'm',
    system: 'Keep this literal:\nx-anthropic-billing-header: example',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(kept.messages[0].content, 'Keep this literal:\nx-anthropic-billing-header: example');
});

test('request messages->chat: cache_control stripped everywhere, single text collapses (GH-3805)', () => {
  const r = request('messages', 'chat', {
    model: 'glm-5.1',
    max_tokens: 1024,
    system: [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
    ],
    tools: [
      {
        name: 'search',
        description: 'Search the web',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral' },
      },
    ],
  });
  assert.equal(r.messages[0].role, 'system');
  assert.equal(r.messages[0].content, 'You are helpful.');
  assert.equal(r.messages[1].content, 'Hello');
  assert.ok(!JSON.stringify(r).includes('cache_control'));
  assert.ok(!JSON.stringify(r).includes('prompt_cache_breakpoint'));
});

test('request messages->chat: prompt_cache_breakpoint stripped from content parts', () => {
  const r = request('messages', 'chat', {
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi', prompt_cache_breakpoint: true },
          { type: 'text', text: 'there', cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  });
  assert.deepEqual(r.messages[0].content, [
    { type: 'text', text: 'hi' },
    { type: 'text', text: 'there' },
  ]);
});

test('request messages->chat: mid-conversation system stays in place', () => {
  const r = request('messages', 'chat', {
    model: 'claude-3-sonnet',
    max_tokens: 1024,
    system: 'You are Claude Code.',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'system', content: '<total_tokens>14963538 tokens left</total_tokens>' },
      { role: 'user', content: 'Continue' },
    ],
  });
  assert.equal(r.messages.length, 5);
  assert.equal(r.messages[0].role, 'system');
  assert.equal(r.messages[0].content, 'You are Claude Code.');
  assert.equal(r.messages[3].role, 'system');
  assert.equal(r.messages[3].content, '<total_tokens>14963538 tokens left</total_tokens>');
});

test('request messages->chat: tool defs, clean_schema defaults, BatchTool filtered', () => {
  const r = request('messages', 'chat', {
    model: 'm',
    messages: [{ role: 'user', content: 'Do work' }],
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather info',
        input_schema: { type: 'object', properties: { location: { type: 'string' } } },
      },
      { name: 'do_work', input_schema: {} },
      { name: 'uri_prop', input_schema: { properties: { q: { type: 'string', format: 'uri' } } } },
      { name: 'BatchTool', input_schema: {} },
      { type: 'BatchTool' },
    ],
  });
  assert.equal(r.tools.length, 3);
  assert.equal(r.tools[0].type, 'function');
  assert.equal(r.tools[0].function.name, 'get_weather');
  assert.equal(r.tools[0].function.description, 'Get weather info');
  assert.equal(r.tools[0].function.parameters.properties.location.type, 'string');
  assert.deepEqual(r.tools[1].function.parameters, { type: 'object', properties: {} });
  const q = r.tools[2].function.parameters.properties.q;
  assert.equal(q.type, 'string');
  assert.ok(!('format' in q));
});

test('request messages->chat: clean_schema only defaults the root', () => {
  const r = request('messages', 'chat', {
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [
      {
        name: 't',
        input_schema: {
          properties: {
            nullable_value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            list: { items: { type: 'string' } },
          },
        },
      },
    ],
  });
  const p = r.tools[0].function.parameters;
  assert.equal(p.type, 'object');
  assert.deepEqual(p.properties.nullable_value, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  assert.deepEqual(p.properties.list, { items: { type: 'string' } });
});

test('request messages->chat: tool_choice table', () => {
  const run = (tool_choice) =>
    request('messages', 'chat', {
      model: 'm',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{ name: 'search', input_schema: { type: 'object', properties: {} } }],
      tool_choice,
    }).tool_choice;
  assert.equal(run('any'), 'required');
  assert.equal(run('auto'), 'auto');
  assert.equal(run('none'), 'none');
  assert.equal(run({ type: 'any' }), 'required');
  assert.equal(run({ type: 'auto' }), 'auto');
  assert.equal(run({ type: 'none' }), 'none');
  assert.deepEqual(run({ type: 'tool', name: 'search' }), {
    type: 'function',
    function: { name: 'search' },
  });
});

test('request messages->chat: tool_use hoisted, thinking dropped by default, thinking-only dropped', () => {
  const r = request('messages', 'chat', {
    model: 'claude-3-opus',
    max_tokens: 1024,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool_use', id: 'call_123', name: 'get_weather', input: { location: 'Tokyo' } },
        ],
      },
    ],
  });
  const msg = r.messages[0];
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content, 'Let me check');
  assert.equal(msg.tool_calls[0].id, 'call_123');
  assert.equal(msg.tool_calls[0].type, 'function');
  assert.equal(msg.tool_calls[0].function.name, 'get_weather');
  assert.equal(msg.tool_calls[0].function.arguments, '{"location":"Tokyo"}');
  assert.ok(!('reasoning_content' in msg));

  const thinkingOnly = request('messages', 'chat', {
    model: 'claude-3-opus',
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'No visible content yet.' }] }],
  });
  assert.equal(thinkingOnly.messages.length, 0);
});

test('request messages->chat: vendor-hint models emit reasoning_content on tool-call turns', () => {
  const base = (model, content) =>
    request('messages', 'chat', { model, max_tokens: 1024, messages: [{ role: 'assistant', content }] }).messages[0];

  const deepseek = base('deepseek-v4-flash', [
    { type: 'thinking', thinking: 'I should call the tool.' },
    { type: 'tool_use', id: 'call_123', name: 'get_weather', input: { location: 'Tokyo' } },
  ]);
  assert.equal(deepseek.reasoning_content, 'I should call the tool.');
  assert.equal(deepseek.tool_calls[0].id, 'call_123');

  const placeholder = base('deepseek-v4-flash', [
    { type: 'tool_use', id: 'call_123', name: 'get_weather', input: {} },
  ]);
  assert.equal(placeholder.reasoning_content, 'tool call');

  const redacted = base('mimo-v2.5-pro', [
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'tool_use', id: 'call_123', name: 'get_weather', input: {} },
  ]);
  assert.equal(redacted.reasoning_content, '[redacted thinking]');

  const generic = base('gpt-5.4', [
    { type: 'thinking', thinking: 'I should call the tool.' },
    { type: 'tool_use', id: 'call_123', name: 'get_weather', input: {} },
  ]);
  assert.ok(!('reasoning_content' in generic));

  // thinking without tool calls never emits reasoning_content, even for vendors
  const noTools = base('deepseek-v4-flash', [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: 'hi' },
  ]);
  assert.ok(!('reasoning_content' in noTools));
  assert.equal(noTools.content, 'hi');
});

test('request messages->chat: tool_result becomes separate tool messages (order + content shapes)', () => {
  const r = request('messages', 'chat', {
    model: 'claude-3-opus',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_string', content: '{ "status": "ok", "count": 2 }' },
          { type: 'tool_result', tool_use_id: 'call_array', content: [{ type: 'text', text: 'plain' }] },
          { type: 'text', text: 'and my question' },
        ],
      },
    ],
  });
  assert.equal(r.messages.length, 3);
  assert.equal(r.messages[0].role, 'tool');
  assert.equal(r.messages[0].tool_call_id, 'call_string');
  assert.equal(r.messages[0].content, '{ "status": "ok", "count": 2 }');
  assert.equal(r.messages[1].tool_call_id, 'call_array');
  assert.equal(r.messages[1].content, '[{"text":"plain","type":"text"}]');
  assert.equal(r.messages[2].role, 'user');
  assert.equal(r.messages[2].content, 'and my question');
});

test('request messages->chat: tool result image moved to following synthetic user message', () => {
  const r = request('messages', 'chat', {
    model: 'claude-3-opus',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_image',
            content: [
              { type: 'text', text: 'caption' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'CLAUDE_CHAT_IMAGE_SENTINEL' },
                cache_control: { type: 'ephemeral' },
                prompt_cache_breakpoint: true,
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].role, 'tool');
  assert.equal(r.messages[0].tool_call_id, 'call_image');
  assert.ok(r.messages[0].content.includes('tool result media moved'));
  assert.ok(!r.messages[0].content.includes('CLAUDE_CHAT_IMAGE_SENTINEL'));
  assert.equal(r.messages[1].role, 'user');
  assert.equal(r.messages[1].content[0].text, '[cc-switch: media output of tool call call_image]');
  assert.equal(r.messages[1].content[1].type, 'image_url');
  assert.equal(r.messages[1].content[1].image_url.url, 'data:image/png;base64,CLAUDE_CHAT_IMAGE_SENTINEL');
  assert.ok(!('cache_control' in r.messages[1].content[1]));

  const parallel = request('messages', 'chat', {
    model: 'claude-3-opus',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ONE' } }],
          },
          {
            type: 'tool_result',
            tool_use_id: 'call_2',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'TWO' } }],
          },
        ],
      },
    ],
  });
  assert.equal(parallel.messages.length, 3);
  assert.equal(parallel.messages[0].role, 'tool');
  assert.equal(parallel.messages[1].role, 'tool');
  assert.equal(parallel.messages[2].role, 'user');
  assert.equal(parallel.messages[2].content.length, 4);
});

test('request messages->chat: image blocks map to image_url parts (base64 + remote url)', () => {
  const r = request('messages', 'chat', {
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'ABC123' },
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/image.png' },
            prompt_cache_breakpoint: true,
          },
        ],
      },
    ],
  });
  assert.equal(r.messages[0].content[0].type, 'image_url');
  assert.equal(r.messages[0].content[0].image_url.url, 'data:image/png;base64,ABC123');
  assert.equal(r.messages[0].content[1].image_url.url, 'https://example.com/image.png');
  assert.ok(!JSON.stringify(r).includes('cache_control'));
});

test('request messages->chat: params table (o-series, stop, stream_options, temperature/top_p)', () => {
  for (const model of ['o1', 'o3-mini', 'o4-mini']) {
    const r = request('messages', 'chat', {
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert.ok(!('max_tokens' in r), model + ' should not carry max_tokens');
    assert.equal(r.max_completion_tokens, 4096);
  }
  const plain = request('messages', 'chat', {
    model: 'gpt-4o',
    max_tokens: 1024,
    temperature: 0.5,
    top_p: 0.9,
    stop_sequences: ['a', 'b'],
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(plain.max_tokens, 1024);
  assert.ok(!('max_completion_tokens' in plain));
  assert.equal(plain.temperature, 0.5);
  assert.equal(plain.top_p, 0.9);
  assert.deepEqual(plain.stop, ['a', 'b']);

  const streaming = request('messages', 'chat', {
    model: 'gpt-4o',
    stream: true,
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(streaming.stream, true);
  assert.deepEqual(streaming.stream_options, { include_usage: true });

  const nonStreaming = request('messages', 'chat', {
    model: 'gpt-4o',
    stream: false,
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.ok(!('stream_options' in nonStreaming));
});

test('request messages->chat: legacy text-path shape (system prepend, stream kept)', () => {
  const r = request('messages', 'chat', {
    model: 'm',
    system: 'S',
    stream: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  });
  assert.equal(r.messages[0].role, 'system');
  assert.equal(r.messages[1].content, 'x');
  assert.equal(r.stream, true);
});

// ---------------------------------------------------------------------------
// REQUEST chat -> messages
// ---------------------------------------------------------------------------

test('request chat->messages: string content stays string, system param prepends message (legacy)', () => {
  const r = request('chat', 'messages', {
    model: 'm',
    messages: [{ role: 'user', content: 'a' }],
    system: 'S',
  });
  assert.equal(r.messages[0].role, 'system');
  assert.equal(r.messages[0].content, 'S');
  assert.equal(r.messages[1].content, 'a');
});

test('request chat->messages: system messages hoisted and merged; params inverted', () => {
  const r = request('chat', 'messages', {
    model: 'm',
    system: 'P',
    max_completion_tokens: 99,
    stop: 'END',
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: 'S1' },
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'u' },
    ],
  });
  assert.equal(r.messages[0].role, 'system');
  assert.equal(r.messages[0].content, 'P\nS1\nS2');
  assert.equal(r.messages[1].content, 'u');
  assert.equal(r.max_tokens, 99);
  assert.deepEqual(r.stop_sequences, ['END']);
  assert.equal(r.stream, true);
  assert.ok(!('stream_options' in r));
  assert.ok(!('system' in r));
});

test('request chat->messages: image_url parts become image blocks (data URI + remote)', () => {
  const r = request('chat', 'messages', {
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAABBBB' } },
          { type: 'image_url', image_url: 'https://example.com/cat.jpg' },
        ],
      },
    ],
  });
  const blocks = r.messages[0].content;
  assert.deepEqual(blocks[0], { type: 'text', text: 'look' });
  assert.deepEqual(blocks[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAAABBBB' },
  });
  assert.deepEqual(blocks[2], { type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } });
});

test('request chat->messages: tool_calls become tool_use blocks (arguments parse, failure -> {})', () => {
  const r = request('chat', 'messages', {
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
          { id: 'call_2', type: 'function', function: { name: 'g', arguments: 'not json' } },
        ],
      },
    ],
  });
  const blocks = r.messages[0].content;
  assert.deepEqual(blocks[0], { type: 'tool_use', id: 'call_1', name: 'f', input: { a: 1 } });
  assert.deepEqual(blocks[1], { type: 'tool_use', id: 'call_2', name: 'g', input: {} });
});

test('request chat->messages: tool role message becomes tool_result user message', () => {
  const r = request('chat', 'messages', {
    model: 'm',
    messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'Sunny, 25C' }],
  });
  assert.equal(r.messages[0].role, 'user');
  assert.deepEqual(r.messages[0].content, [
    { type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny, 25C' },
  ]);
});

test('request chat->messages: reasoning_content -> thinking; tools and tool_choice inverted', () => {
  const r = request('chat', 'messages', {
    model: 'm',
    messages: [
      {
        role: 'assistant',
        reasoning_content: 'Need the date first.',
        content: 'Checking',
        tool_calls: [{ id: 'call_date', type: 'function', function: { name: 'get_date', arguments: '{}' } }],
      },
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'search', description: 'search the web', parameters: { type: 'object', properties: { q: { type: 'string', format: 'uri' } } } },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'search' } },
  });
  const blocks = r.messages[0].content;
  assert.deepEqual(blocks[0], { type: 'thinking', thinking: 'Need the date first.' });
  assert.deepEqual(blocks[1], { type: 'text', text: 'Checking' });
  assert.deepEqual(blocks[2], { type: 'tool_use', id: 'call_date', name: 'get_date', input: {} });
  assert.equal(r.tools[0].name, 'search');
  assert.equal(r.tools[0].description, 'search the web');
  assert.deepEqual(r.tools[0].input_schema, { type: 'object', properties: { q: { type: 'string' } } });
  assert.deepEqual(r.tool_choice, { type: 'tool', name: 'search' });

  assert.deepEqual(request('chat', 'messages', { tool_choice: 'required', messages: [] }).tool_choice, { type: 'any' });
  assert.deepEqual(request('chat', 'messages', { tool_choice: 'auto', messages: [] }).tool_choice, { type: 'auto' });
  assert.deepEqual(request('chat', 'messages', { tool_choice: 'none', messages: [] }).tool_choice, { type: 'none' });
});

// ---------------------------------------------------------------------------
// RESPONSE chat -> messages
// ---------------------------------------------------------------------------

test('response chat->messages: simple text (legacy shape)', () => {
  const r = response('chat', 'messages', {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    model: 'gpt-4',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.equal(r.id, 'chatcmpl-123');
  assert.equal(r.type, 'message');
  assert.equal(r.role, 'assistant');
  assert.equal(r.model, 'gpt-4');
  assert.equal(r.content[0].type, 'text');
  assert.equal(r.content[0].text, 'Hello!');
  assert.equal(r.stop_reason, 'end_turn');
  assert.equal(r.stop_sequence, null);
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5 });
});

test('response chat->messages: tool_calls become tool_use (parse failure -> {})', () => {
  const r = response('chat', 'messages', {
    id: 'chatcmpl-123',
    model: 'gpt-4',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_123', type: 'function', function: { name: 'get_weather', arguments: '{"location": "Tokyo"}' } },
            { id: 'call_bad', type: 'function', function: { name: 'g', arguments: '{oops' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  assert.deepEqual(r.content[0], { type: 'tool_use', id: 'call_123', name: 'get_weather', input: { location: 'Tokyo' } });
  assert.deepEqual(r.content[1], { type: 'tool_use', id: 'call_bad', name: 'g', input: {} });
  assert.equal(r.stop_reason, 'tool_use');
});

test('response chat->messages: reasoning_content leads; content parts and refusal become text', () => {
  const r = response('chat', 'messages', {
    id: 'c1',
    model: 'deepseek-v4-flash',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          reasoning_content: 'Need the current date before calling weather.',
          content: [{ type: 'text', text: 'Hello' }, { type: 'refusal', refusal: 'I cannot' }],
        },
        finish_reason: 'stop',
      },
    ],
  });
  assert.deepEqual(r.content[0], { type: 'thinking', thinking: 'Need the current date before calling weather.' });
  assert.deepEqual(r.content[1], { type: 'text', text: 'Hello' });
  assert.deepEqual(r.content[2], { type: 'text', text: 'I cannot' });
});

test('response chat->messages: legacy function_call supported', () => {
  const r = response('chat', 'messages', {
    id: 'chatcmpl-123',
    model: 'gpt-4',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          function_call: { name: 'get_weather', arguments: '{"location":"Tokyo"}' },
        },
        finish_reason: 'function_call',
      },
    ],
  });
  assert.deepEqual(r.content[0], { type: 'tool_use', id: '', name: 'get_weather', input: { location: 'Tokyo' } });
  assert.equal(r.stop_reason, 'tool_use');
});

test('response chat->messages: usage three-bucket math (nested + direct + clamp)', () => {
  const nested = response('chat', 'messages', {
    id: 'c',
    model: 'gpt-4',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 80 } },
  });
  assert.deepEqual(nested.usage, { input_tokens: 20, output_tokens: 50, cache_read_input_tokens: 80 });

  const direct = response('chat', 'messages', {
    id: 'c',
    model: 'gpt-4',
    choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 50,
    },
  });
  assert.equal(direct.usage.input_tokens, 0);
  assert.equal(direct.usage.cache_read_input_tokens, 60);
  assert.equal(direct.usage.cache_creation_input_tokens, 50);
});

test('response chat->messages: finish_reason table', () => {
  const run = (choice) => response('chat', 'messages', { id: 'c', model: 'm', choices: [choice] }).stop_reason;
  assert.equal(run({ index: 0, message: { content: 'x' }, finish_reason: 'content_filter' }), 'end_turn');
  assert.equal(run({ index: 0, message: { content: 'x' }, finish_reason: 'mystery' }), 'end_turn');
  assert.equal(
    run({ index: 0, message: { tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] } }),
    'tool_use'
  );
  assert.equal(run({ index: 0, message: { content: 'x' } }), null);
});

// ---------------------------------------------------------------------------
// RESPONSE messages -> chat
// ---------------------------------------------------------------------------

test('response messages->chat: single text block collapses to string (legacy shape)', () => {
  const r = response('messages', 'chat', {
    type: 'message',
    id: 'msg_1',
    model: 'm',
    content: [{ type: 'text', text: 'yo' }],
    stop_reason: 'end_turn',
  });
  assert.equal(r.object, 'chat.completion');
  assert.equal(r.model, 'm');
  assert.equal(r.choices[0].index, 0);
  assert.equal(r.choices[0].message.role, 'assistant');
  assert.equal(r.choices[0].message.content, 'yo');
  assert.equal(r.choices[0].finish_reason, 'stop');
  assert.equal(typeof r.created, 'number');
});

test('response messages->chat: multiple text blocks become array; thinking becomes reasoning_content', () => {
  const multi = response('messages', 'chat', {
    type: 'message',
    model: 'm',
    content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    stop_reason: 'end_turn',
  });
  assert.deepEqual(multi.choices[0].message.content, [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ]);

  const thinking = response('messages', 'chat', {
    type: 'message',
    model: 'm',
    content: [{ type: 'thinking', thinking: 'ponder' }, { type: 'text', text: 'c' }],
    stop_reason: 'end_turn',
  });
  assert.equal(thinking.choices[0].message.reasoning_content, 'ponder');
  assert.equal(thinking.choices[0].message.content, 'c');
});

test('response messages->chat: tool_use becomes tool_calls with canonical arguments', () => {
  const r = response('messages', 'chat', {
    type: 'message',
    model: 'm',
    content: [{ type: 'tool_use', id: 'call_1', name: 'f', input: { b: 2, a: 1 } }],
  });
  assert.deepEqual(r.choices[0].message.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1,"b":2}' } },
  ]);
  assert.equal(r.choices[0].message.content, null);
  assert.equal(r.choices[0].finish_reason, 'tool_calls');
});

test('response messages->chat: stop_reason and usage inverse tables', () => {
  const run = (stop_reason) =>
    response('messages', 'chat', {
      type: 'message',
      model: 'm',
      content: [{ type: 'text', text: 'x' }],
      stop_reason,
    }).choices[0].finish_reason;
  assert.equal(run('end_turn'), 'stop');
  assert.equal(run('max_tokens'), 'length');
  assert.equal(run('stop_sequence'), 'stop');
  assert.equal(run(undefined), 'stop');

  const r = response('messages', 'chat', {
    type: 'message',
    model: 'm',
    content: [{ type: 'text', text: 'x' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 60, cache_creation_input_tokens: 30 },
  });
  assert.equal(r.usage.prompt_tokens, 100);
  assert.equal(r.usage.completion_tokens, 5);
  assert.deepEqual(r.usage.prompt_tokens_details, { cached_tokens: 60, cache_write_tokens: 30 });
});

// ---------------------------------------------------------------------------
// SSE chat -> messages (create_anthropic_sse_stream port)
// ---------------------------------------------------------------------------

test('SSE chat->messages: legacy text path (deferred message_start, [DONE] terminal, closed after)', () => {
  const conv = createSse('chat', 'messages');
  let out = '';
  out += conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'a' } }] }));
  out += conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'b' } }] }));
  out += conv.push('data: [DONE]\n\n');
  assert.ok(out.includes('message_start'));
  assert.ok(out.includes('content_block_start'));
  assert.ok(out.includes('content_block_delta'));
  assert.ok(out.includes('"a"'));
  assert.ok(out.includes('"b"'));
  assert.ok(out.includes('message_stop'));
  assert.ok(!out.includes('"choices"'));
  const types = sseTypes(out);
  assert.deepEqual(types.slice(0, 3), ['message_start', 'content_block_start', 'content_block_delta']);
  assert.deepEqual(types.slice(-3), ['content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(sseDataObjects(out).at(-2).delta.stop_reason, 'end_turn');
  assert.equal(conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'late' } }] })), '');
  assert.equal(conv.end(), '');
});

test('SSE chat->messages: message_start deferred and carries id/model/usage', () => {
  const conv = createSse('chat', 'messages');
  const out = conv.push(
    dataLine({ id: 'chatcmpl_1', model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'hi' } }] })
  );
  const events = sseDataObjects(out);
  assert.equal(events[0].type, 'message_start');
  assert.equal(events[0].message.id, 'chatcmpl_1');
  assert.equal(events[0].message.model, 'gpt-4o');
  assert.deepEqual(events[0].message.usage, { input_tokens: 0, output_tokens: 0 });
  // stream ends without [DONE]: end() flushes the deferred terminal events
  assert.deepEqual(sseTypes(conv.end()), ['content_block_stop', 'message_delta', 'message_stop']);
});

test('SSE chat->messages: end() flushes message_delta + message_stop; idempotent', () => {
  const conv = createSse('chat', 'messages');
  const first = conv.push(dataLine({ choices: [{ index: 0, delta: { content: 'x' } }] }));
  assert.ok(first.includes('"x"'));
  assert.ok(!first.includes('message_stop'));
  const tail = conv.end();
  const types = sseTypes(tail);
  assert.deepEqual(types, ['content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(conv.end(), '');

  // stream with no substantive output ends empty (legacy parity)
  const empty = createSse('chat', 'messages');
  assert.equal(empty.end(), '');
});

test('SSE chat->messages: tool calls routed by chat index', () => {
  const conv = createSse('chat', 'messages');
  let out = '';
  out += conv.push(
    dataLine({ id: 'chatcmpl_1', model: 'gpt-4o', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'first_tool' } }] } }] })
  );
  out += conv.push(
    dataLine({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_1', type: 'function', function: { name: 'second_tool' } }] } }] })
  );
  out += conv.push(dataLine({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"b":2}' } }] } }] }));
  out += conv.push(dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] }));
  out += conv.push(
    dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 4 } })
  );
  out += conv.push('data: [DONE]\n\n');

  const events = sseDataObjects(out);
  const toolIndexByCall = {};
  for (const e of events) {
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
      toolIndexByCall[e.content_block.id] = e.index;
    }
  }
  assert.equal(Object.keys(toolIndexByCall).length, 2);
  assert.notEqual(toolIndexByCall.call_0, toolIndexByCall.call_1);
  const deltas = events
    .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
    .map((e) => [e.index, e.delta.partial_json]);
  assert.equal(deltas.length, 2);
  assert.deepEqual(deltas.find(([, p]) => p === '{"a":1}'), [toolIndexByCall.call_0, '{"a":1}']);
  assert.deepEqual(deltas.find(([, p]) => p === '{"b":2}'), [toolIndexByCall.call_1, '{"b":2}']);
  const delta = events.find((e) => e.type === 'message_delta');
  assert.equal(delta.delta.stop_reason, 'tool_use');
  assert.deepEqual(delta.usage, { input_tokens: 8, output_tokens: 4 });
});

test('SSE chat->messages: tool start deferred until id and name ready', () => {
  const conv = createSse('chat', 'messages');
  let out = '';
  out += conv.push(dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] }));
  const early = sseDataObjects(out);
  assert.ok(!early.some((e) => e.type === 'content_block_start'), 'no block start before id+name');
  out += conv.push(dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'first_tool' } }] } }] }));
  out += conv.push(dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }));
  out += conv.push(dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 6, completion_tokens: 2 } }));
  out += conv.push('data: [DONE]\n\n');

  const events = sseDataObjects(out);
  const starts = events.filter((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].content_block.id, 'call_0');
  assert.equal(starts[0].content_block.name, 'first_tool');
  const fragments = events
    .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
    .map((e) => e.delta.partial_json);
  assert.ok(fragments.includes('{"a":'));
  assert.ok(fragments.includes('1}'));
});

test('SSE chat->messages: 500-whitespace run aborts the tool (never emitted)', () => {
  const conv = createSse('chat', 'messages');
  let out = '';
  out += conv.push(dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] }));
  out += conv.push(dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' '.repeat(600) } }] } }] }));
  out += conv.push(dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  out += conv.push('data: [DONE]\n\n');
  const events = sseDataObjects(out);
  assert.ok(!events.some((e) => e.type === 'content_block_start'), 'aborted tool must never start');
  assert.ok(!events.some((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta'));
  const types = sseTypes(out);
  assert.ok(types.includes('message_delta'));
  assert.ok(types.includes('message_stop'));
});

test('SSE chat->messages: late-start fallback id/name at finish_reason', () => {
  const conv = createSse('chat', 'messages');
  let out = '';
  out += conv.push(dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] }));
  out += conv.push(dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }));
  out += conv.push(dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  out += conv.push('data: [DONE]\n\n');
  const events = sseDataObjects(out);
  const starts = events.filter((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].content_block.id, 'tool_call_0');
  assert.equal(starts[0].content_block.name, 'unknown_tool');
  const fragments = events
    .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
    .map((e) => e.delta.partial_json);
  assert.deepEqual(fragments, ['{"a":1}']);
});

test('SSE chat->messages: duplicate finish_reason, usage-only chunk, zero-usage, missing [DONE]', () => {
  // usage-only chunk after finish updates the deferred message_delta usage
  const conv = createSse('chat', 'messages');
  let out = '';
  out += conv.push(
    dataLine({ id: 'c1', model: 'glm-5.1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool-0924', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }] } }] })
  );
  out += conv.push(dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  out += conv.push(
    dataLine({ choices: [], usage: { prompt_tokens: 13312, completion_tokens: 79, prompt_tokens_details: { cached_tokens: 100 } } })
  );
  out += conv.push('data: [DONE]\n\n');
  let deltas = sseDataObjects(out).filter((e) => e.type === 'message_delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta.stop_reason, 'tool_use');
  assert.equal(deltas[0].usage.input_tokens, 13212);
  assert.equal(deltas[0].usage.output_tokens, 79);
  assert.equal(deltas[0].usage.cache_read_input_tokens, 100);
  assert.equal(sseDataObjects(out).filter((e) => e.type === 'message_stop').length, 1);

  // duplicate finish_reason chunks emit exactly one message_delta, later usage wins
  const dup = createSse('chat', 'messages');
  let out2 = '';
  out2 += dup.push(dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  out2 += dup.push(
    dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
  );
  out2 += dup.push('data: [DONE]\n\n');
  deltas = sseDataObjects(out2).filter((e) => e.type === 'message_delta');
  assert.equal(deltas.length, 1);
  assert.deepEqual(deltas[0].usage, { input_tokens: 10, output_tokens: 5 });

  // stream with no usage at all still reports zero usage buckets
  const noUsage = createSse('chat', 'messages');
  let out3 = '';
  out3 += noUsage.push(dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 't', arguments: '{}' } }] } }] }));
  out3 += noUsage.push(dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  out3 += noUsage.push('data: [DONE]\n\n');
  const delta3 = sseDataObjects(out3).find((e) => e.type === 'message_delta');
  assert.equal(delta3.delta.stop_reason, 'tool_use');
  assert.deepEqual(delta3.usage, { input_tokens: 0, output_tokens: 0 });
});

test('SSE chat->messages: cache write/read subtracted and clamped in streamed usage', () => {
  const conv = createSse('chat', 'messages');
  let out = '';
  out += conv.push(dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }] } }] }));
  out += conv.push(dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  out += conv.push(
    dataLine({
      choices: [],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
      },
    })
  );
  out += conv.push('data: [DONE]\n\n');
  const delta = sseDataObjects(out).find((e) => e.type === 'message_delta');
  assert.equal(delta.usage.input_tokens, 100);
  assert.equal(delta.usage.cache_read_input_tokens, 600);
  assert.equal(delta.usage.cache_creation_input_tokens, 300);

  const clamp = createSse('chat', 'messages');
  let out2 = '';
  out2 += clamp.push(dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
  out2 += clamp.push(
    dataLine({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 80 },
        cache_creation_input_tokens: 50,
      },
    })
  );
  out2 += clamp.push('data: [DONE]\n\n');
  const delta2 = sseDataObjects(out2).find((e) => e.type === 'message_delta');
  assert.equal(delta2.usage.input_tokens, 0);
  assert.equal(delta2.usage.cache_read_input_tokens, 80);
  assert.equal(delta2.usage.cache_creation_input_tokens, 50);
});

test('SSE chat->messages: finish without [DONE] finalizes at end()', () => {
  const conv = createSse('chat', 'messages');
  let out = '';
  out += conv.push(dataLine({ id: 'c1', model: 'gpt-4o', choices: [{ delta: { content: 'hello' } }] }));
  out += conv.push(dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
  const tail = conv.end();
  const all = sseDataObjects(out + tail);
  const delta = all.find((e) => e.type === 'message_delta');
  assert.equal(delta.delta.stop_reason, 'end_turn');
  assert.equal(all.at(-1).type, 'message_stop');
  assert.equal(conv.end(), '');
});

test('SSE chat->messages: error event emits error and no success terminals', () => {
  const conv = createSse('chat', 'messages');
  const out = conv.push('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n');
  const events = sseDataObjects(out);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].error.type, 'stream_error');
  assert.equal(events[0].error.message, 'Overloaded');
  assert.ok(!out.includes('message_delta'));
  assert.ok(!out.includes('message_stop'));
  assert.equal(conv.push(dataLine({ choices: [{ delta: { content: 'x' } }] })), '');
  assert.equal(conv.end(), '');

  // chat-style inline error payload
  const conv2 = createSse('chat', 'messages');
  const out2 = conv2.push(dataLine({ error: { message: 'boom', type: 'server_error' } }));
  const events2 = sseDataObjects(out2);
  assert.equal(events2[0].type, 'error');
  assert.equal(events2[0].error.message, 'boom');
});

test('SSE chat->messages: reasoning deltas drive a thinking block lifecycle', () => {
  const conv = createSse('chat', 'messages');
  let out = '';
  out += conv.push(dataLine({ choices: [{ delta: { reasoning_content: 'think' } }] }));
  out += conv.push(dataLine({ choices: [{ delta: { reasoning: ' more' } }] }));
  out += conv.push(dataLine({ choices: [{ delta: { content: 'text' } }] }));
  out += conv.push(dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
  out += conv.push('data: [DONE]\n\n');
  const events = sseDataObjects(out);
  const thinkingStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'thinking');
  assert.ok(thinkingStart, 'thinking block started');
  const thinkingDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta');
  assert.deepEqual(
    thinkingDeltas.map((e) => e.delta.thinking),
    ['think', ' more']
  );
  const textStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'text');
  assert.equal(textStart.index, 1, 'text block opens after thinking closes');
  assert.ok(events.some((e) => e.type === 'content_block_stop' && e.index === 0));
});

test('SSE chat->messages: multi-byte char split across chunks survives (no U+FFFD)', () => {
  const full =
    'data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
    'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(full);
  let ni = -1;
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] === 0xe4 && bytes[i + 1] === 0xbd && bytes[i + 2] === 0xa0) {
      ni = i;
      break;
    }
  }
  assert.ok(ni >= 0);
  const conv = createSse('chat', 'messages');
  const out = conv.push(bytes.slice(0, ni + 1)) + conv.push(bytes.slice(ni + 1));
  assert.ok(out.includes('你好'));
  assert.ok(!out.includes('\uFFFD'));
});

// ---------------------------------------------------------------------------
// SSE messages -> chat
// ---------------------------------------------------------------------------

test('SSE messages->chat: legacy text path (finish chunk + [DONE] at message_delta, closed after)', () => {
  const conv = createSse('messages', 'chat');
  let out = '';
  out += conv.push(dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } }));
  out += conv.push(dataLine({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
  assert.ok(out.startsWith('data: {"choices"'));
  assert.ok(out.includes('"b"'));
  assert.ok(out.includes('[DONE]'));
  assert.ok(!out.includes('content_block_delta'));
  assert.ok(out.includes('"finish_reason":"stop"'));
  assert.equal(conv.end(), '');

  // closed: later events and end() emit nothing
  assert.equal(conv.push(dataLine({ type: 'message_stop' })), '');
});

test('SSE messages->chat: bare text deltas + [DONE] (e2e J4 shape), thinking deltas', () => {
  const conv = createSse('messages', 'chat');
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += conv.push(dataLine({ type: 'content_block_delta', index: 0, delta: { text: 'hi' + i } }));
  }
  out += conv.push(dataLine({ type: 'thinking_out', delta: {} }) /* noise tolerated */);
  out += conv.push(dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }));
  out += conv.push('data: [DONE]\n\n');
  assert.equal((out.match(/"content":"hi/g) ?? []).length, 4);
  assert.ok(out.includes('"reasoning_content":"hmm"'));
  assert.ok(out.includes('data: [DONE]\n\n'));
  assert.ok(!out.includes('finish_reason'));
  assert.equal((out.match(/\[DONE\]/g) ?? []).length, 1);
  assert.equal(conv.end(), '');
});

test('SSE messages->chat: tool_use block and input_json_delta become tool_calls fragments', () => {
  const conv = createSse('messages', 'chat');
  const startOut = conv.push(dataLine({ type: 'message_start', message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 7 } } }));
  assert.equal(startOut, '', 'message_start emits nothing');
  let out = '';
  out += conv.push(dataLine({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_x', name: 'get_weather' } }));
  out += conv.push(dataLine({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } }));
  out += conv.push(dataLine({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ' "Paris"}' } }));
  out += conv.push(dataLine({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }));
  const chunks = sseDataObjects(out);
  const start = chunks[0].choices[0].delta.tool_calls[0];
  assert.deepEqual(start, { index: 0, id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '' } });
  const args = chunks.slice(1, 3).map((c) => c.choices[0].delta.tool_calls[0]);
  assert.deepEqual(args, [
    { index: 0, function: { arguments: '{"city":' } },
    { index: 0, function: { arguments: ' "Paris"}' } },
  ]);
  const finish = chunks.at(-1);
  assert.deepEqual(finish.choices, [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
  assert.deepEqual(finish.usage, { prompt_tokens: 7, completion_tokens: 3 });
  assert.ok(out.endsWith('data: [DONE]\n\n'));
});

test('SSE messages->chat: stop_reason inverse table feeds finish_reason', () => {
  const run = (stop_reason) => {
    const conv = createSse('messages', 'chat');
    const out =
      conv.push(dataLine({ type: 'message_delta', delta: { stop_reason } })) + conv.push(dataLine({ type: 'message_stop' }));
    return sseDataObjects(out)[0].choices[0].finish_reason;
  };
  assert.equal(run('end_turn'), 'stop');
  assert.equal(run('max_tokens'), 'length');
  assert.equal(run('tool_use'), 'tool_calls');
  assert.equal(run('stop_sequence'), 'stop');
});

test('SSE messages->chat: upstream error event becomes chat error + [DONE]', () => {
  const conv = createSse('messages', 'chat');
  const out = conv.push('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n');
  const chunks = out.split('\n\n').filter((b) => b !== '');
  assert.equal(chunks.length, 2);
  assert.deepEqual(JSON.parse(chunks[0].slice(6)), { error: { message: 'Overloaded', type: 'overloaded_error' } });
  assert.equal(chunks[1], 'data: [DONE]');
  assert.equal(conv.push(dataLine({ type: 'message_stop' })), '');
  assert.equal(conv.end(), '');
});

test('SSE messages->chat: truncation end() emits [DONE] once; empty stream ends empty', () => {
  const conv = createSse('messages', 'chat');
  const out = conv.push(dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }));
  assert.ok(out.includes('"partial"'));
  assert.ok(!out.includes('[DONE]'));
  const tail = conv.end();
  assert.equal(tail, 'data: [DONE]\n\n');
  assert.equal(conv.end(), '');

  const empty = createSse('messages', 'chat');
  assert.equal(empty.end(), '');
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test('guards: invalid pairs and malformed chat responses throw ConversionError', () => {
  assert.throws(() => request('messages', 'responses', {}), ConversionError);
  assert.throws(() => response('responses', 'chat', {}), ConversionError);
  assert.throws(() => createSse('chat', 'responses'), ConversionError);
  assert.throws(() => response('chat', 'messages', {}), ConversionError);
  assert.throws(() => response('chat', 'messages', { choices: [] }), ConversionError);
  assert.throws(
    () => response('chat', 'messages', { choices: [{ finish_reason: 'stop' }] }),
    ConversionError
  );
});
