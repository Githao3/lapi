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
import { getPreset } from './client-presets.js';
import { request as undiciRequest } from 'undici';

const STREAM_IDLE_MS = 90000;

export async function handleRelayRequest(req, res, protocol, kind, opts = {}) {
if (!opts.skipCapture && captureIsEnabled()) {
    handleCapture(req, res, protocol, kind);
    return;
  }
  // A hung-up client (playground stop button, cancelled CLI call) must abort the
  // upstream fetch too, or tokens keep burning for an answer nobody will read.
  const clientGone = new AbortController();
  res.on('close', () => clientGone.abort());
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
 let lastOutHeaders = null;
 const attempts = [];
 for (let attempt =   0; attempt < 2; attempt++) {
    const c = pickWeightedChannel(candidates);
    if (!c) break;
    attemptChannel = c;
    const out = await forwardOnce(req, res, c, protocol, kind, body, clientGone.signal);
    if (out.attempt) attempts.push(out.attempt);
    if (out.usage) lastUsage = out.usage;
    if (out.upstreamModel) lastUpstreamModel = out.upstreamModel;
    if (out.out_headers) lastOutHeaders = out.out_headers;
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
      if (res.destroyed) break; // client is gone: a retry has no reader
      lastError = out.error;
      continue;
    }
    lastError = out.error;
    break;
  }
  if (lastError && !res.headersSent && !res.destroyed) {
    const payload = errorPayload(protocol, 'relay failed: ' + lastError);
    res.status(502).set('content-type', 'application/json').send(JSON.stringify(payload));
  }
 logRelay(started, req, res, protocol, attemptChannel, model, lastError, attempts, clientError, lastUsage, lastUpstreamModel, lastOutHeaders);
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

async function forwardOnce(req, res, c, protocol, kind, body, clientAbort) {
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
    clientPreset: c.client_preset ? getPreset(c.client_preset) : null,
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
    // undici.request（而非全局 fetch）：只发送我们构造的头。fetch 会自动注入
    // sec-fetch-mode / accept-language / accept: */* 等指纹头，伪装场景不可接受。
    resp = await undiciRequest(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: clientAbort ? AbortSignal.any([AbortSignal.timeout(300000), clientAbort]) : AbortSignal.timeout(300000),
      ...egressOptions(targetUrl),
    });
  } catch (e) {
    if (clientAbort?.aborted) {
      return { done: true, retryable: false, error: 'client aborted', sentBytes: false };
    }
    return { done: false, retryable: true, error: String(e && e.message ? e.message : e), sentBytes: false, attempt: { channel: c.name, status: null, error: String(e && e.message ? e.message : e), out_headers: headers } };
  }
  const status = resp.statusCode;
  const getHeader = (name) => {
    const v = resp.headers[name];
    return Array.isArray(v) ? v[0] : (v ?? null);
  };
  if (status >=500 || (status === 429 && getHeader('retry-after'))) {
    const errText = await readBodyString(resp.body).catch(() => '');
    return { done: false, retryable: true, error: 'upstream status ' + status, sentBytes: false, out_headers: headers, attempt: { channel: c.name, status, error: maskSecrets(errText, c), out_headers: headers } };
  }
  if (status >=400) {
    const raw = await readBodyString(resp.body).catch(() => '');
    let out = raw;
    if (raw) {
      try {
        const j = JSON.parse(raw);
        out = JSON.stringify(convertUpstreamError(j, localKind, 'upstream status ' + status));
      } catch { /* non-JSON error body: pass through */ }
    } else {
      out = JSON.stringify(errorPayload(protocol, 'upstream status ' + status));
    }
    res.status(status);
    res.set('content-type', 'application/json');
    res.send(out);
    return { done: true, retryable: false, error: '', sentBytes: false, out_headers: headers, attempt: { channel: c.name, status, error: maskSecrets(raw, c), out_headers: headers } };
  }
  // pipe through (streaming or buffered)
  let sentBytes = false;
  let conv = null;
  let usage = null;
  let scanner = null;
  res.status(status);
  for (const h of ['content-type', 'cache-control', 'retry-after']) {
    const v = getHeader(h);
    if (v) res.set(h, v);
  }
  const ct = getHeader('content-type') ?? '';
  const isStream = ct.includes('text/event-stream') || ct.includes('application/x-ndjson');
  try {
    if (isStream) {
      conv = needConvert ? createLineConverter(upKind, localKind) : null;
      scanner = createUsageScanner(upKind);
      let lastData = Date.now();
      for await (const chunk of resp.body) {
        const value = chunk ? Buffer.from(chunk) : null;
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
        if (Date.now() - lastData > STREAM_IDLE_MS) {
          resp.body.destroy();
          break;
        }
      }
      if (conv) {
        const tail = Buffer.from(conv.end(), 'utf8');
        if (tail.length) res.write(tail);
      }
      try { usage = scanner.end(); } catch { /* usage scan is best-effort */ }
      res.end();
    } else {
      const buf = await readBodyBuffer(resp.body);
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
        return { done: true, retryable: false, error: convErr, sentBytes, attempt: { channel: c.name, status, error: convErr }, usage, upstreamModel };
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
  return { done: true, retryable: false, error: '', sentBytes, usage, upstreamModel, out_headers: headers };
}
function applyModelMapping(body, mapping) {
  if (!mapping) return body;
  const m = mapping[body.model];
 if (m && body.model !== m) {
    return { ...body, model: m };
  }
 return body;
}

function logRelay(started, req, res, protocol, channel, model, lastError, attempts, clientError, usage, upstreamModel, outHeaders) {
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
    // 4xx/5xx 的 error 字段可能为空（错误体直接回给客户端了），状态码也算失败
    detail: buildRelayDetail(attempts, clientError, usage, upstreamModel, outHeaders, lastError || clientError || (res.statusCode ?? 0) >= 400),
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

// 读取上游响应体为字符串（undici.request 的 body 是异步可迭代流）
async function readBodyString(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function readBodyBuffer(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function buildRelayDetail(attempts, clientError, usage, upstreamModel, outHeaders, isFailure) {
  const detail = {};
  if (attempts && attempts.length) detail.attempts = attempts;
  if (clientError) detail.clientError = clientError;
  if (usage) detail.usage = usage;
  if (upstreamModel) detail.upstream_model = upstreamModel;
  // 出站头快照：失败请求总是记录（排障刚需）；设置打开后成功请求也记录
  if (outHeaders && (isFailure || getSetting('log_out_headers') === '1')) {
    detail.out_headers = outHeaders;
  }
  return detail;
}



