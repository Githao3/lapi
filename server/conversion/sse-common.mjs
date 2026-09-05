// Mechanical SSE + JSON-canonical primitives shared by the three conversion pairs.
// Ported from cc-switch (MIT, (c) 2025 Jason Young) — sse.rs (block scanning, UTF-8
// stitching) and json_canonical.rs (argument canonicalization). These are pure helpers;
// response-event envelope builders live in each pair module (their exact bytes come from
// cc-switch's codex_responses_sse.rs, owned per pair;review pass unifies them here).

// --- SSE block scanning -------------------------------------------------------
// Accept both \n\n and CRLF \r\n\r\n block delimiters (as cc-switch sse.rs:8-23).
export function takeSseBlock(s) {
  if (typeof s !== 'string') return null;
  const i1 = s.indexOf('\n\n');
  const i2 = s.indexOf('\r\n\r\n');
  let idx = -1, len = 0;
  if ((i1 >= 0 && (i2 < 0 || i1 < i2))) { idx = i1; len = 2; }
  else if (i2 >= 0) { idx = i2; len = 4; }
  if (idx < 0) return null;
  return { block: s.slice(0, idx), rest: s.slice(idx + len) };
}

// Split 'field:value' (accepts 'field:' as bare field, optional single space after colon).
export function stripSseField(line) {
  const i = line.indexOf(':');
  if (i < 0) return { field: line, value: '' };
  const field = line.slice(0, i);
  let value = line.slice(i + 1);
  if (value.startsWith(' ')) value = value.slice(1);
  return { field, value };
}

// Parse ONE complete SSE block (already delimiter-removed) into its parts.
// Returns { event, dataText, data } — data is the JSON-parsed data (null on parse
// failure — callers then decide (e.g. '[DONE]') via isDoneData;event falls back
// to the payload's `type` when no `event:` header is present (cc-switch
// streaming_responses.rs:2474-2478): multiple `data:` lines are joined with '\n'
// back into one JSON body;comment lines (';')are ignored.

export function parseEventBlock(block) {
  let event = null;
  const dataParts = [];
  for (const line of String(block ?? '').split(String.fromCharCode(10))) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) { event = line.slice(6).replace(/^ /, ''); continue; }
    if (line.startsWith('data:')) { let v = line.slice(5); if (v.startsWith(' ')) v = v.slice(1); dataParts.push(v); continue; }
    if (line.startsWith('event: ')) { event = line.slice(7); continue; }
  }
  if (dataParts.length === 0) return { event, dataText: null, data: null, parsed: false };
  const dataText = dataParts.join('\n');
  let data = null;
  let parsed = false;
  try { data = JSON.parse(dataText); parsed = true; } catch { /* skip silently (cc-switch) */ }
  if (!event && parsed && data && typeof data === 'object' && typeof data.type === 'string') event = data.type;
  return { event, dataText, data, parsed };
}

export function isDoneData(dataText) {
  return typeof dataText === 'string' && dataText.trim() === '[DONE]';
}

// --- UTF-8 safe chunk stitching ------------------------------------------------
// Keep at most 3 trailing bytes pending (cc-switch sse.rs append_utf8_safe),
// so a multi-byte char split across chunks is carried over, never emitted as U+FFFD.
export function createUtf8Buffer() {
  let pending = new Uint8Array(0);
  let out = '';
  const concat = (b1, b2) => {
    if (b1.length === 0) return b2;
    if (b2.length === 0) return b1;
    const n = new Uint8Array(b1.length + b2.length);
    n.set(b1, 0); n.set(b2, b1.length);
    return n;
  };
  const decodeFatal = (bytes, end) => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, end ?? bytes.length)); }
    catch { return null; }
  };
  function push(chunkn) {
    const bytes = chunkn instanceof Uint8Array ? chunkn : new TextEncoder().encode(String(chunkn));
    const merged = pending.length ? concat(pending, bytes) : bytes;
    pending = new Uint8Array(0);
    let ok = decodeFatal(merged);
    if (ok !== null) { out += ok; return; }
    // find longest decodable head;only look within last 3 bytes for the split point.
    let cut = -1;
    for (let i = merged.length - 1; i >= Math.max(0, merged.length - 3); i--) {
      if (decodeFatal(merged, i) !== null) { cut = i; break; }
    }
    if (cut < 0) {
      // trailing bytes belong to a broken sequence, or the whole thing is invalid — emit as-is.
      out += decodeFatal(merged) ?? new TextDecoder().decode(merged);
      return;
    }
    out += decodeFatal(merged, cut);
    pending = merged.slice(cut);
  }
  function end() {
    if (pending.length) { out += new TextDecoder().decode(pending); pending = new Uint8Array(0); }
    const t = out;
    out = '';
    return t;
  }
  return { push, end, getPending: () => pending };
}

// --- JSON canonicalization -------------------------------------------------------
// Key-sorted, no whitespace, recursively (cc-switch json_canonical.rs);used for tool
// `arguments` so byte-identical bodies are produced for prompt caches.

export function canonicalJsonString(v) {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'number' || t === 'boolean') return v === -0 ? '0' : String(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJsonString).join(',') + ']';
  if (t === 'object') {
    const ks = Object.keys(v) || [];
    ks.sort();
    return '{' + ks.map((k) => JSON.stringify(k) + ':' + canonicalJsonString(v[k])).join(',') + '}';
  }
  return String(v);
}

// Tool `arguments`: empty → '{}';string → parse-and-recanonicalize (verbatim on
// parse failure);object → canonical JSON string (cc-switch canonicalize_tool_arguments).
export function canonicalizeToolArguments(input) {
  if (input === null || input === undefined) return '{}';
  if (typeof input === 'string') {
    if (input.trim() === '') return '{}';
    try { return canonicalJsonString(JSON.parse(input)); }
    catch { return input; }
  }
  return canonicalJsonString(input);
}