// Pure-function layer. No db or express deps. Unit-testable.
// URL normalization; outbound header building; secret masking; model matching; weighted picks.
// Style: short statements to keep lines simple.

import { createHash } from 'node:crypto';

// ---------- URL normalization ----------

// kind: messages, chat, responses, models, test

export function normalizeUpstreamUrl(baseUrl, kind, _ignored) {
  let base = String(baseUrl ?? '');
  base = base.trim();
  base = base.replace(/\/+$/, '');
  if (!base) return '';
  if (kind === 'messages') {
    if (base.endsWith('/v1/messages')) return base;
    if (base.endsWith('/messages')) return base;
    if (base.endsWith('/v1')) return base + '/messages';
    if (base.endsWith('/v1beta')) return base + '/messages';
    return base + '/v1/messages';
  }
  if (kind === 'chat') {
    if (base.endsWith('/chat/completions')) return base;
    if (base.endsWith('/v1/chat/completions')) return base;
    if (base.endsWith('/v1')) return base + '/chat/completions';
    return base + '/v1/chat/completions';
  }
  if (kind === 'responses') {
    if (base.endsWith('/responses')) return base;
    if (base.endsWith('/v1')) return base + '/responses';
    return base + '/v1/responses';
  }
  if (kind === 'models') {
    if (base.endsWith('/v1/models')) return base;
    if (base.endsWith('/models')) return base;
    if (base.endsWith('/v1')) return base + '/models';
    if (base.endsWith('/v1beta')) return base + '/models';
    return base + '/v1/models';
  }
  return base;
}

// ---------- outbound header building ----------

const DROP_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'proxy-connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'accept-encoding',
  'content-type',
  'traceparent',
  'tracestate',
  'x-request-id',
]);

const DROP_HEADER_PREFIXES = [
  'x-forwarded-',
  'forwarded',
  'cf-',
  'x-envoy-',
];

const PROTECTED_OVERRIDE_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'proxy-connection',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'accept-encoding',
  'content-type',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
  'traceparent',
  'tracestate',
]);

function isDroppedHeader(name) {
  if (DROP_HEADERS.has(name)) return true;
  for (const pre of DROP_HEADER_PREFIXES) {
    if (name.startsWith(pre)) return true;
  }
  return false;
}
export { isDroppedHeader };

function isProtectedOverrideHeader(name) {
  return PROTECTED_OVERRIDE_HEADERS.has(String(name).toLowerCase());
}
export { isProtectedOverrideHeader };

// clientHeaders: node req.headers, lowercased keys.

export function buildOutboundHeaders(opts) {
  const clientHeaders = opts.clientHeaders ?? {};
 const targetUrl = opts.targetUrl ?? '';
 let apiKey = opts.apiKey ?? '';
 const authMode = opts.authMode ?? 'bearer';
 const userAgentOverride = opts.userAgentOverride ?? '';
 const protocol = opts.protocol ?? 'anthropic';
 const headerOverrides = opts.headerOverrides ?? {};
 const out = {};
 for (const [k, v] of Object.entries(clientHeaders)) {
    const name = String(k).toLowerCase();
    if (!v) continue;
    if (isDroppedHeader(name)) continue;
    const isAuth = name === 'authorization';
    const isKey = name === 'x-api-key';
    const isGKey = name === 'x-goog-api-key';
    const isHost = name === 'host';
    const isCookie = name === 'cookie';
    if (isAuth || isKey || isGKey || isHost || isCookie) continue;
    out[name] = Array.isArray(v) ? v.join(', ') : v;
  }
 try {
    const u = new URL(targetUrl);
    out['host'] = u.host;
  } catch {}
apiKey = String(apiKey).trim();
 if ((apiKey)) {
    if (authMode === 'bearer') out['authorization'] = 'Bearer ' + apiKey;
    if (authMode === 'x-api-key') out['x-api-key'] = apiKey;
    if (authMode === 'x-goog-api-key') out['x-goog-api-key'] = apiKey;
  }
 out['content-type'] = 'application/json';
 out['accept'] = 'application/json';
 out['accept-encoding'] = 'identity';
 // anthropic-version follows the CHANNEL-declared upstream format when the caller
 // knows it (upstreamKind); legacy callers without it keep the local-protocol rule.
 const upstreamKind = opts.upstreamKind ?? null;
 const wantAnthropicVersion = upstreamKind != null ? upstreamKind === 'messages' : protocol === 'anthropic';
 if (wantAnthropicVersion) {
    if (!out['anthropic-version']) out['anthropic-version'] = '2023-06-01';
  } else if (upstreamKind != null) {
    // openai-declared channel: a client-sent anthropic-version is protocol noise — drop it.
    delete out['anthropic-version'];
  }
 // Client impersonation profile: fixed/fill/drop rows plus the strict scrub of
 // client fingerprint headers. Slots in above gateway defaults.
 if (opts.clientPreset) {
    applyClientPreset(out, opts.clientPreset);
  }
 // Channel-level UA override lands LAST among identity layers so a per-channel
 // tweak wins over the profile's pinned UA. Empty = keep the passthrough value.
 if (userAgentOverride) {
    out['user-agent'] = String(userAgentOverride);
  }
 for (const [k, v] of Object.entries(headerOverrides)) {
    const name = String(k).toLowerCase().trim();
    if (!name) continue;
    if (PROTECTED_OVERRIDE_HEADERS.has(name)) continue;
    out[name] = String(v) ?? '';
  }
 for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
    if (out[k] === null) delete out[k];
  }
 return out;
}

// ---------- client impersonation presets ----------

// Under strict mode these survive the scrub (they're recomputed by the gateway,
// not client identity); everything else the client sent is dropped so the
// outbound exactly matches the captured fingerprint.
const STRICT_KEEP = new Set([
  'host',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'anthropic-version',
]);

// Applies a client preset onto the outbound header set:
//   strict — strip every client header the profile doesn't list, then apply rows
//            (the outbound becomes a faithful replay of the captured fingerprint)
//   fixed — always override (the profile owns this header's identity)
//   fill  — pass the client's live value through; only backfill the pinned
//           value when the client sent nothing (e.g. session ids)
//   drop  — remove the header from the outbound set
// Gateway-managed headers (host/auth/framing/length) can never be touched.
export function applyClientPreset(out, preset) {
  if (!preset || !Array.isArray(preset.headers)) return out;
  const rows = new Map();
  for (const h of preset.headers) {
    const name = String(h?.name ?? '').toLowerCase().trim();
    if (!name || isProtectedOverrideHeader(name)) continue;
    rows.set(name, h);
  }
  if (preset.strict) {
    for (const k of Object.keys(out)) {
      if (!STRICT_KEEP.has(k) && !rows.has(k)) delete out[k];
    }
  }
  for (const [name, h] of rows) {
    const value = String(h?.value ?? '');
    if (h.mode === 'fixed') {
      out[name] = value;
    } else if (h.mode === 'fill') {
      const cur = out[name];
      // 缺了才补；补位的值是空串时宁可不发，也不发一个空头
      if ((cur == null || cur === '') && value !== '') out[name] = value;
    } else if (h.mode === 'drop') {
      delete out[name];
    }
  }
  return out;
}

// ---------- model matching, 3 levels ----------
// level 3: exact; 2: normalized (date suffix stripped);;1: wildcard.

const DATE_SUFFIX_RE = /-(20\d{2})(\d{2})(\d{2})$/;

function normalizeModelName(m) {
  let s = String(m ?? '');
 s = s.trim();
 return DATE_SUFFIX_RE.test(s) ? s.replace(DATE_SUFFIX_RE, '') : s;
}

// channel.models: comma list, supports '*' and 'prefix*'.

export function matchChannelForModel(channel, model, modelMapping) {
  const want = String(model ?? '');
 const mapping = modelMapping ?? {};
 const accepted = [];
 if (!want.trim()) return { ok: false, level: 0 };
for (const raw of String(channel.models ?? '' ).split(',')) {
    const m = raw.trim();
    if (!m) continue;
    accepted.push(m);
  }
for (const raw of Object.keys(mapping)) {
    const m = raw.trim();
    if (!m) continue;
    accepted.push(m);
  }
for (const a of accepted) {
    if (a === '*') continue;
    if (a === want) return { ok: true, level: 3 };
 if (normalizeModelName(a) === normalizeModelName(want)) return { ok: true, level: 2 };
 if (a.endsWith('*')) {
if (want.startsWith(a.slice(0,-1))) return { ok: true, level: 1 };
    }
  }
 if (accepted.includes('*')) return { ok: true, level: 1 };
return { ok: false, level: 0 };
}

// ---------- candidate channels ----------
// The pool spans every enabled channel of the request's protocol (messages/chat/responses),
// regardless of its declared upstream endpoint; whether to convert is decided by the relay layer.

export function pickCandidateChannels(channels, protocol, model) {
  const want = String(model ?? '');
  if (!want.trim()) return [];
  const pool = [];
  for (const c of (channels ?? [])) {
    if (!c.enabled) continue;
    pool.push(c);
  }
 const exact = [];
 const norm = [];
 const wild = [];
 for (const c of pool) {
    const r = matchChannelForModel(c, want, c.model_mapping);
    if (!r.ok) continue;
    if (r.level === 3) exact.push(c);
 if (r.level === 2) norm.push(c);
 if (r.level === 1) wild.push(c);
  }
 if (exact.length) return exact;
 if (norm.length) return norm;
 return wild;
}

// Weighted random. Weight 0 counts as 1.

export function pickWeightedChannel(candidates) {
  if (!candidates) return null;
 if (!candidates.length) return null;
 let total = 0;
 for (const c of candidates) {
    let w = Number(c.weight);
    if (!w) w =   1;
    total += w;
  }
  let roll = Math.random() * total;
for (const c of candidates) {

    let w = Number(c.weight);
    if (!w) w =   1;
    roll -= w;
    if (roll <= 0) return c;
  }
 return candidates[candidates.length -   1];
}

// ---------- error shapes ----------

export function errorPayload(protocol, message, type) {
  const t = type ?? 'invalid_request_error';
 if (protocol === 'anthropic') {
    return {
      type: 'error',
      error: {
        type: t,
        message: String(message),
      },
    };
  }
 return {
    error: {
      message: String(message),
      type: t,
    },
  };
}

// ---------- body preview, 4KB cap ----------

export function bodyPreview(rawBody) {
  let s = String(rawBody ?? '');
 if (s.length > 4096) {
    s = s.slice(0, 4096);
    s = s + '\n...(truncated)';
  }
 return s;
}

export function hashId(str) {
  const h = createHash('sha1');
 h.update(String(str));
 return h.digest('hex').slice(0,12);
}


// ---------- usage extraction (new-api style prompt/completion accounting) ----------

// Normalize the three upstream usage shapes into one canonical object; returns
// null when no token counts are present.
export function normalizeUsage(kind, u) {
  if (!u || typeof u !== 'object') return null;
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  let input = null;
  let output = null;
  let total = null;
  let cacheRead = null;
  let cacheWrite = null;
  if (kind === 'chat') {
    input = n(u.prompt_tokens);
    output = n(u.completion_tokens);
    total = n(u.total_tokens);
    cacheRead = n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens);
  } else if (kind === 'responses') {
    input = n(u.input_tokens);
    output = n(u.output_tokens);
    total = n(u.total_tokens);
    cacheRead = n(u.input_tokens_details && u.input_tokens_details.cached_tokens);
  } else {
    input = n(u.input_tokens);
    output = n(u.output_tokens);
    cacheRead = n(u.cache_read_input_tokens);
    cacheWrite = n(u.cache_creation_input_tokens);
    if (input != null && output != null) total = input + output;
  }
  const out = {};
  if (input != null) out.input_tokens = input;
  if (output != null) out.output_tokens = output;
  if (total != null) out.total_tokens = total;
  if (cacheRead != null) out.cache_read_input_tokens = cacheRead;
  if (cacheWrite != null) out.cache_creation_input_tokens = cacheWrite;
  return Object.keys(out).length ? out : null;
}

export function extractUsageFromJson(kind, obj) {
  return normalizeUsage(kind, obj && typeof obj === 'object' ? obj.usage : null);
}

// Stream-side scanner: passively accumulates the RAW upstream text (capped) while
// the real stream is piped, and pulls the LAST complete "usage" object out at
// end-of-stream. Never touches the stream itself; works for passthrough and
// converted streams alike because it sits on the raw side.
export function createUsageScanner(kind) {
  let buf = '';
  const CAP = 4 * 1024 * 1024;
  return {
    push(chunk) {
      if (buf.length >= CAP) return;
      buf += chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
      if (buf.length > CAP) buf = buf.slice(0, CAP);
    },
    end() {
      const idx = buf.lastIndexOf('"usage"');
      if (idx < 0) return null;
      const open = buf.indexOf('{', idx);
      if (open < 0) return null;
      let depth = 0;
      let endIdx = -1;
      let inStr = false;
      let esc = false;
      for (let i = open; i < buf.length; i++) {
        const ch = buf[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { endIdx = i; break; }
        }
      }
      if (endIdx < 0) return null;
      try { return normalizeUsage(kind, JSON.parse(buf.slice(open, endIdx + 1))); } catch { return null; }
    },
  };
}
