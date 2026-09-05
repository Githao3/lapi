// Conversion dispatch — cc-switch-style pairwise adapters (ported to JS).
// Six directed pairs collapse into three mirror-pair modules, keyed by
// (fromKind, toKind) where kind is one of 'messages' | 'chat' | 'responses'.
// Interfaces (synchronous — relay.js calls them in-line):
//   convertRequestBody(body, from, to) -> converted body (throws ConversionError on unconvertible client payload)
//   convertResponseBody(body, from, to) -> converted body (throws ConversionError on unconvertible upstream payload)
//   createLineConverter(from, to) -> { push(Uint8Array) -> string, end() -> string }  (SSE state machine)
//   convertUpstreamError(upstreamErrorBody, protocol, fallbackMsg) -> local error envelope
// Same-format pairs short-circuit to identity (byte-level passthrough lives in relay.js).

import { ConversionError } from './errors.mjs';
import * as anthropicChat from './anthropic-chat.mjs';
import * as anthropicResponses from './anthropic-responses.mjs';
import * as chatResponses from './chat-responses.mjs';

const PAIRS = {
  'messages-chat': anthropicChat,
  'chat-messages': anthropicChat,
  'messages-responses': anthropicResponses,
  'responses-messages': anthropicResponses,
  'chat-responses': chatResponses,
  'responses-chat': chatResponses,
};

function pairFor(from, to) {
  const mod = PAIRS[from + '-' + to];
  if (!mod) throw new ConversionError('unsupported conversion pair: ' + from + ' to ' + to);
  return mod;
}

export function convertRequestBody(body, from, to) {
  if (from === to) return body;
  const mod = pairFor(from, to);
  if (typeof mod.request !== 'function') throw new ConversionError('converter missing request() for ' + from + ' to ' + to);
  return mod.request(from, to, body ?? {});
}

export function convertResponseBody(body, from, to) {
  if (from === to) return body;
  const mod = pairFor(from, to);
  if (typeof mod.response !== 'function') throw new ConversionError('converter missing response() for ' + from + ' to ' + to);
  return mod.response(from, to, body ?? {});
}

export function createLineConverter(from, to) {
  if (from === to) return identityLine();
  const mod = pairFor(from, to);
  if (typeof mod.createSse !== 'function') throw new ConversionError('converter missing createSse() for ' + from + ' to ' + to);
  return mod.createSse(from, to);
}

// Identity passthrough (relay.js bypasses conversion when from === to; kept for safety).
function identityLine() {
  const dec = new TextDecoder();
  return {
    push(chunk) { return chunk instanceof Uint8Array ? dec.decode(chunk) : String(chunk); },
    end() { return ''; },
  };
}

// Local error envelope, shaped per the LOCAL client-facing protocol (legacy parity).
export function convertUpstreamError(p, protocol, fallbackMsg) {
  const src = p ?? {};
  const et = String((src.error && src.error.type) || src.type || 'upstream_error');
  const em = String((src.error && src.error.message) || src.message || fallbackMsg || '');
  if (protocol === 'anthropic') return { type: 'error', error: { type: et, message: em } };
  return { error: { message: em, type: et } };
}

export { ConversionError };
