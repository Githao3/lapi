// Unit tests for relay log usage accounting (normalizeUsage + createUsageScanner).
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUsage, createUsageScanner } from '../relay-lib.js';

test('normalizeUsage: three wire shapes -> canonical', () => {
  const chat = normalizeUsage('chat', { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 4 } });
  assert.deepEqual(chat, { input_tokens: 10, output_tokens: 3, total_tokens: 13, cache_read_input_tokens: 4 });
  const resp = normalizeUsage('responses', { input_tokens: 7, output_tokens: 2, total_tokens: 9, input_tokens_details: { cached_tokens: 5 } });
  assert.deepEqual(resp, { input_tokens: 7, output_tokens: 2, total_tokens: 9, cache_read_input_tokens: 5 });
  const ant = normalizeUsage('messages', { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 });
  assert.deepEqual(ant, { input_tokens: 6, output_tokens: 2, total_tokens: 8, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 });
  assert.equal(normalizeUsage('chat', {}), null);
  assert.equal(normalizeUsage('chat', null), null);
});

test('createUsageScanner: finds last usage across chunk boundaries', () => {
  const s = createUsageScanner('chat');
  s.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  s.push('data: {"choices":[],"usage":{"prompt_to');
  s.push('kens": 11, "completion_tokens": 2}}\n\n');
  assert.deepEqual(s.end(), { input_tokens: 11, output_tokens: 2 });
});

test('createUsageScanner: no usage -> null; nested details survive', () => {
  const empty = createUsageScanner('chat');
  empty.push('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
  assert.equal(empty.end(), null);
  const s2 = createUsageScanner('chat');
  s2.push('data: {"usage":{"prompt_tokens":5,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":2}}}\n\n');
  assert.deepEqual(s2.end(), { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 2 });
});
