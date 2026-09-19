// Header capture mode (core feature). When enabled, relay paths never forward;
// instead they record incoming+outbound headers and echo them back as a 400 payload,
// so a CLI tool prints them in its terminal.
// Headers are stored AS-IS (no masking): the records are the source material for
// client impersonation presets, which need real session/credential values. That
// makes capture records credential-equivalent — same trust level as the channel
// keys stored alongside them in the same SQLite file.

import {
  pickCandidateChannels,
  buildOutboundHeaders,
  normalizeUpstreamUrl,
  bodyPreview,
  errorPayload,
} from './relay-lib.js';
import { listChannels, insertLog, getSetting } from './db.js';

export function captureIsEnabled() {
  return getSetting('capture_enabled') === '1';
}

export function handleCapture(req, res, protocol, kind) {
  const bodyRaw = JSON.stringify(req.body ?? null);
  const model = req.body?.model ? String(req.body.model) : '';
  const channels = listChannels();
  const candidates = pickCandidateChannels(channels, protocol, model);
  const inHeaders = { ...req.headers };
  let outHeaders = null;
  if (candidates.length) {
    const c = candidates[0];
    const upKind = protocol === 'openai' ? String(c.openai_endpoint ?? 'chat') : kind;
    const targetUrl = normalizeUpstreamUrl(c.base_url, upKind);
    outHeaders = buildOutboundHeaders({
      clientHeaders: req.headers,
      targetUrl,
      apiKey: c.api_key,
      authMode: c.auth_mode,
      userAgentOverride: c.user_agent_override,
      protocol,
      headerOverrides: c.header_overrides,
    });
  }
 insertLog({
    kind: 'capture',
    path: req.originalUrl ?? req.url,
    method: req.method,
    channel_id: candidates.length ? candidates[0].id : null,
    channel_name: candidates.length ? candidates[0].name : '',
    model,
    status: 400,
    error: '',
    detail: {
      inHeaders,
      outHeaders,
      bodyPreview: bodyPreview(bodyRaw),
    },
  });
 const t = String(candidates[0]?.name ?? '(no matching channel)');
 const message =
    '=== lapi header capture ===\n\n' +
    'INCOMING HEADERS (masked):\n' +
    JSON.stringify(inHeaders, null, 2) +
    '\n\nOUTBOUND HEADERS preview (channel: ' + t + '):\n' +
    (outHeaders ? JSON.stringify(outHeaders, null, 2) : '(nothing rewritten)') +
    '\n\nBody preview (4KB capped):\n' +
    bodyPreview(bodyRaw);
  res.status(400);
  res.set('content-type', 'application/json');
  res.send(JSON.stringify(errorPayload(protocol, message)));
  return true;
}