// Relay: routes an API request to a matching enabled channel, rewrites headers,
// streams responses back,and retries once on network error / 5xx / 429 (only before any byte is sent).

import {
  normalizeUpstreamUrl,
  buildOutboundHeaders,
  pickCandidateChannels,
  pickWeightedChannel,
  errorPayload,
  matchChannelForModel,
  extractUsageFromJson,
  createUsageScanner,
} from './relay-lib.js';
import { egressOptions } from './egress.js';
import { listChannels, insertLog, getSetting } from './db.js';
import { handleCapture, captureIsEnabled } from './capture.js';
import { convertRequestBody, convertResponseBody, createLineConverter, convertUpstreamError } from './conversion/index.mjs';

const STREAM_IDLE_MS = 90000;

export async function handleRelayRequest(req, res, protocol, kind) {
if (captureIsEnabled()) {
    handleCapture(req, res, protocol, kind);
    return;
  }
 const started = Date.now();
 const body = req.body ?? {};
 const model = body.model ? String(body.model) : '';
 if (!model) {
    const payload = errorPayload(protocol, 'missing "model" field in request body');
    res.status(400).set('content-type', 'application/json').send(JSON.stringify(payload));
    return;
  }
const channels = listChannels();
  const candidates = pickCandidateChannels(channels, protocol, model);
  if (!candidates.length) {
    const payload = mismatchOrNoChannelMessage(protocol, model, channels, kind);
    res.status(400).set('content-type', 'application/json').send(JSON.stringify(payload));
    return;
  }
 let attemptChannel = null;
 let lastError = '';
 let clientError = '';
 let lastUsage = null;
 let lastUpstreamModel = '';
 const attempts = [];
 for (let attempt =   0; attempt < 2; attempt++) {
    const c = pickWeightedChannel(candidates);
    if (!c) break;
    attemptChannel = c;
    const out = await forwardOnce(req, res, c, protocol, kind, body);
    if (out.attempt) attempts.push(out.attempt);
    if (out.usage) lastUsage = out.usage;
    if (out.upstreamModel) lastUpstreamModel = out.upstreamModel;
    if (out.clientError) {
      clientError = out.clientError;
      lastError = '';
      if (!res.headersSent) {
        const payload = errorPayload(protocol, out.clientError);
        res.status(400).set('content-type', 'application/json').send(JSON.stringify(payload));
      }
      break;
    }
    if (out.sentBytes) {
      lastError = '';
      break;
    }
    if (out.retryable) {
      lastError = out.error;
      continue;
    }
    lastError = out.error;
    break;
  }
  if (lastError && !res.headersSent) {
    const payload = errorPayload(protocol, 'relay failed: ' + lastError);
    res.status(502).set('content-type', 'application/json').send(JSON.stringify(payload));
  }
 logRelay(started, req, res, protocol, attemptChannel, model, lastError, attempts, clientError, lastUsage, lastUpstreamModel);
}

// ---------- helpers ----------

function mismatchOrNoChannelMessage(protocol, model, channels, kind) {
  const available = uniqueModels(channels);
  const msg =
    'no enabled channel supports model "' + model + '"' +
    ' (available models: ' + (available.join(', ') || 'none') + ')';
  return errorPayload(protocol, msg);
}
function uniqueModels(channels) {
  const set = new Set();
  for (const c of channels) {
    const parts = String(c.models ?? null).match(/[^,]+/g) ?? [];
    for (const m of parts) {
      const t = String(m).trim();
      if (t) set.add(t);
    }
  }
  return [...set];
}

// ---------- forwarding ----------

async function forwardOnce(req, res, c, protocol, kind, body) {
  // Upstream format comes from the channel's declaration;local format comes from the path..
  const upKind = c.protocol === 'openai' ? String(c.openai_endpoint ?? 'chat') : 'messages';
  const localKind = kind;
  const needConvert = upKind !== localKind;
  const targetUrl = normalizeUpstreamUrl(c.base_url, upKind);
  if (!targetUrl) {
    return { done: true, retryable: false, error: 'invalid base url', sentBytes: false };
  }
  const headers = buildOutboundHeaders({
    clientHeaders: req.headers,
    targetUrl,
    apiKey: c.api_key,
    authMode: c.auth_mode,
    userAgentOverride: c.user_agent_override,
    protocol,
    upstreamKind: upKind,
    headerOverrides: c.header_overrides,
  });
  let outBody = body;
  if (needConvert) {
    try {
      outBody = convertRequestBody(body, localKind, upKind);
    } catch (e) {
      const msg = 'local protocol conversion failed: ' + (e && e.message ? e.message : e);
      return { done: true, retryable: false, error: '', sentBytes: false, clientError: msg };
    }
  }
  const upstreamBody = applyModelMapping(outBody, c.model_mapping);
  const upstreamModel = String(upstreamBody?.model ?? body?.model ?? '');
  let resp;
  try {
    resp = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(300000),
      duplex: 'half',
      ...egressOptions(targetUrl),
    });
  } catch (e) {
    return { done: false, retryable: true, error: String(e && e.message ? e.message : e), sentBytes: false, attempt: { channel: c.name, status: null, error: String(e && e.message ? e.message : e) } };
  }
  if (resp.status >=500 || (resp.status === 429 && resp.headers.get('retry-after'))) {
    const errText = await resp.text().catch(() => '');
    return { done: false, retryable: true, error: 'upstream status ' + resp.status, sentBytes: false, attempt: { channel: c.name, status: resp.status, error: maskSecrets(errText, c) } };
  }
  if (resp.status >=400) {
    const raw = await resp.text().catch(() => '');
    let out = raw;
    if (raw) {
      try {
        const j = JSON.parse(raw);
        out = JSON.stringify(convertUpstreamError(j, localKind, 'upstream status ' + resp.status));
      } catch { /* non-JSON error body: pass through */ }
    } else {
      out = JSON.stringify(errorPayload(protocol, 'upstream status ' + resp.status));
    }
    res.status(resp.status);
    res.set('content-type', 'application/json');
    res.send(out);
    return { done: true, retryable: false, error: '', sentBytes: false, attempt: { channel: c.name, status: resp.status, error: maskSecrets(raw, c) } };
  }
  // pipe through (streaming or buffered)
  let sentBytes = false;
  let conv = null;
  let usage = null;
  let scanner = null;
  res.status(resp.status);
  for (const h of ['content-type', 'cache-control', 'retry-after']) {
    const v = resp.headers.get(h);
    if (v) res.set(h, v);
  }
  const ct = resp.headers.get('content-type') ?? '';
  const isStream = ct.includes('text/event-stream') || ct.includes('application/x-ndjson');
  try {
    if (isStream) {
      conv = needConvert ? createLineConverter(upKind, localKind) : null;
      scanner = createUsageScanner(upKind);
      const reader = resp.body.getReader();
      let lastData = Date.now();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          scanner.push(value);
          let out = value;
          if (conv) out = Buffer.from(conv.push(value), 'utf8');
          if (out && out.length) {
            res.write(out);
            sentBytes = true;
            lastData = Date.now();
          }
        }
        if (Date.now() - lastData > STREAM_IDLE_MS) break;
      }
      if (conv) {
        const tail = Buffer.from(conv.end(), 'utf8');
        if (tail.length) res.write(tail);
      }
      try { usage = scanner.end(); } catch { /* usage scan is best-effort */ }
      res.end();
    } else {
      const buf = Buffer.from(await resp.arrayBuffer());
      try { usage = extractUsageFromJson(upKind, JSON.parse(buf.toString('utf8'))); } catch { /* non-JSON or no usage */ }
      if (needConvert && buf.length) {
        let convErr = '';
        try {
          const j = JSON.parse(buf.toString('utf8'));
          const local = convertResponseBody(j, upKind, localKind);
          const has = local && Object.keys(local).length > 0;
          sentBytes = has;
          res.set('content-type', 'application/json');
          res.end(JSON.stringify(local));
        } catch (e) {
          convErr = 'upstream response conversion failed: ' + (e && e.message ? e.message : e);
          res.status(502);
          res.set('content-type', 'application/json');
          res.end(JSON.stringify(errorPayload(protocol, convErr)));
        }
        return { done: true, retryable: false, error: convErr, sentBytes, attempt: { channel: c.name, status: resp.status, error: convErr }, usage, upstreamModel };
      }
      sentBytes = buf.length >0;
      res.end(buf);
    }
  } catch (e) {
    // client or upstream dropped mid-stream: never retry after bytes (G3).
    // A converted stream still gets its fail-closed tail (e.g. a stream_truncated
    // error event) so an abruptly cut upstream never masquerades as a success.
    if (conv) {
      try {
        const tail = Buffer.from(conv.end(), 'utf8');
        if (tail.length) res.write(tail);
      } catch { /* client already gone */ }
    }
    if (scanner) {
      try { usage = usage || scanner.end(); } catch { /* best-effort */ }
    }
    res.end();
  }
  return { done: true, retryable: false, error: '', sentBytes, usage, upstreamModel };
}
function applyModelMapping(body, mapping) {
  if (!mapping) return body;
  const m = mapping[body.model];
 if (m && body.model !== m) {
    return { ...body, model: m };
  }
 return body;
}

function logRelay(started, req, res, protocol, channel, model, lastError, attempts, clientError, usage, upstreamModel) {
  if (getSetting('logging_enabled') !== '1') return;
 if (!channel) {
    insertLog({
      kind: 'relay',
      path: req.originalUrl ?? req.url,
      method: req.method,
      model,
      status: null,
      ms: Date.now() - started,
      error: lastError || 'no channel',
      detail: {},
    });
    return;
  }
 insertLog({
    kind: 'relay',
    path: req.originalUrl ?? req.url,
    method: req.method,
    channel_id: channel.id,
    channel_name: channel.name,
    model,
    status: res.statusCode ?? null,
    ms: Date.now() - started,
    error: lastError,
    detail: buildRelayDetail(attempts, clientError, usage, upstreamModel),
  });
}

// Redact channel secrets from an upstream error body before it lands in the log,
// and keep it short — this is diagnostics, not a transcript.
function maskSecrets(text, channel) {
  let t = String(text ?? '');
  const keys = String(channel?.api_key ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  for (const k of keys) t = t.split(k).join('***');
  if (t.length > 1200) t = t.slice(0, 1200) + '…';
  return t;
}

function buildRelayDetail(attempts, clientError, usage, upstreamModel) {
  const detail = {};
  if (attempts && attempts.length) detail.attempts = attempts;
  if (clientError) detail.clientError = clientError;
  if (usage) detail.usage = usage;
  if (upstreamModel) detail.upstream_model = upstreamModel;
  return detail;
}



