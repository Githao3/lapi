// App assembly: express wiring, relay routes, admin auth guard, static hosting, port picking.

import express from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { listChannels, getSetting, setSetting } from './db.js';
import { handleRelayRequest } from './relay.js';
import { attachCrud } from './crud.js';
import { errorPayload } from './relay-lib.js';
import {
  isLoopbackBind,
  clientKeyMatches,
  bearerOf,
  sessionValid,
  createSession,
  dropSession,
  safeEqual,
  loginBlockedFor,
  noteLoginFailure,
  noteLoginSuccess,
} from './auth.js';

process.on('uncaughtException', (e) => console.error('[lapi] UNCAUGHT ' + (e?.stack ?? e)));
process.on('unhandledRejection', (e) => console.error('[lapi] UNHANDLED ' + (e?.stack ?? e)));

const root = dirname(fileURLToPath(import.meta.url));
const distDir = join(root, '..', 'web', 'dist');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50mb' }));
  app.use((req, res, next) => {
    console.log('[lapi-req]', req.method, req.originalUrl);
    next();
  });
  // Panel session endpoints, reachable without a session (the login must be).
  app.get('/api/session', sessionInfo);
  app.post('/api/login', loginHandler);
  app.use('/api', adminAuth);
  app.post('/api/logout', logoutHandler);
  attachCrud(app);

  // relay (gateway) routes for CLI tools
  app.use('/v1', relayAuth);
  app.post('/v1/messages', (req, res) => {
    handleRelayRequest(req, res, 'anthropic', 'messages');
  });
  app.post('/v1/chat/completions', (req, res) => {
    handleRelayRequest(req, res, 'openai', 'chat');
  });
  app.post('/v1/responses', (req, res) => {
    handleRelayRequest(req, res, 'openai', 'responses');
  });
  app.get('/v1/models', handleModelsList);
  app.get('/models', relayAuth, handleModelsList);
 app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/v1')) return next();
    if (existsSync(join(distDir, 'index.html'))) {
      res.sendFile(join(distDir, 'index.html'));
    } else {
      next();
    }
  });
  return app;
}

function collectModelIds() {
  // Routable = union across ALL enabled channels: any declared model is reachable
  // from any local endpoint thanks to cross-format conversion, so the list is not
  // filtered by channel protocol. Mapping keys (client-side aliases) included; '*'
  // wildcard is not a concrete id and is skipped.
  const set = new Set();
  for (const c of listChannels()) {
    if (!c.enabled) continue;
    const rawModels = c.models == null ? "" : String(c.models);
    for (const m of rawModels.split(",")) {
      const id = m.trim();
      if (id && id !== '*') set.add(id);
    }
    const rawKeys = c.model_mapping == null ? {} : c.model_mapping;
    for (const k of Object.keys(rawKeys)) {
      set.add(k);
    }
  }
  return [...set];
}

function handleModelsList(req, res) {
  // Superset item shape: OpenAI parsers read id/object/owned_by, Anthropic parsers
  // read id/type/display_name — serve both so client header sniffing never matters.
  const ids = collectModelIds();
  const data = ids.map((id) => ({
    id,
    object: 'model',
    owned_by: 'lapi',
    type: 'model',
    display_name: id,
  }));
  res.json({ object: 'list', data });
}

// ---------- admin panel auth (admin_password + in-memory session) ----------

function sessionInfo(req, res) {
  const local = isLoopbackBind(getSetting('bind'));
  res.json({
    ok: true,
    local,
    auth_required: !local,
    configured: !!getSetting('admin_password'),
    authed: local ? true : sessionValid(bearerOf(req.headers.authorization)),
  });
}

function loginHandler(req, res) {
  if (isLoopbackBind(getSetting('bind'))) {
    res.json({ ok: true, session: createSession(), local: true });
    return;
  }
  const password = getSetting('admin_password');
  if (!password) {
    res.status(503).json({ ok: false, error: 'admin password not configured; set LAPI_ADMIN_PASSWORD on the host, or open the panel on loopback' });
    return;
  }
  const waitMs = loginBlockedFor();
  if (waitMs > 0) {
    res.status(429).json({ ok: false, error: 'too many failed attempts; retry in ' + Math.ceil(waitMs / 1000) + 's' });
    return;
  }
  if (!safeEqual(req.body?.password, password)) {
    noteLoginFailure();
    res.status(401).json({ ok: false, error: 'wrong password' });
    return;
  }
  noteLoginSuccess();
  res.json({ ok: true, session: createSession() });
}

function logoutHandler(req, res) {
  dropSession(bearerOf(req.headers.authorization));
  res.json({ ok: true });
}

function adminAuth(req, res, next) {
  if (isLoopbackBind(getSetting('bind'))) return next();
  if (!getSetting('admin_password')) {
    res.status(503).json({ ok: false, error: 'non-local bind requires an admin password; set LAPI_ADMIN_PASSWORD or use the Settings page' });
    return;
  }
  if (sessionValid(bearerOf(req.headers.authorization))) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

// ---------- relay auth (gateway_token = the key handed to users) ----------
// Users hold this key; it grants relay access only and can never reach /api.

function relayAuth(req, res, next) {
  if (isLoopbackBind(getSetting('bind'))) return next();
  const key = getSetting('gateway_token');
  if (!key) {
    res.status(503).json({ ok: false, error: 'non-local bind requires a relay key; set LAPI_GATEWAY_TOKEN or use the Settings page' });
    return;
  }
  if (!clientKeyMatches(req.headers, key)) {
    const url = req.originalUrl || req.url || '';
    const protocol = url.includes('/messages') ? 'anthropic' : 'openai';
    const payload = errorPayload(protocol, "invalid gateway key — put the relay key in the tool's API key field", 'authentication_error');
    res.status(401).set('content-type', 'application/json').send(JSON.stringify(payload));
    return;
  }
  next();
}

export async function startServer() {
  const bind = getSetting('bind') || '127.0.0.1';
  const preferred = Number(getSetting('port') || 8787);
  let port = preferred;
  for (let i=0; i<20; i++) {
    try {
      await listenOnce(bind, port);
      // The preferred port stays what the user set; a conflicted run only records
      // where it actually landed, so the next start tries the preferred port again.
      setSetting('active_port', String(port));
      if (port !== preferred) {
        console.log('[lapi] 端口 ' + preferred + ' 被占用，本次临时使用 ' + port + '；下次启动仍优先 ' + preferred);
      }
      return;
    } catch (e) {
      if (e.code === 'EADDRINUSE') {
        port+=1;
        continue;
      }
      throw e;
    }
  }
  throw new Error('no free port found');
}

function listenOnce(bind, port) {
  return new Promise((resolve, reject) => {
    const app = createApp();
    const srv = app.listen(port, bind, () => {
      console.log('[lapi] listening on http://' + bind + ':' + port);
      resolve(srv);
    });
    srv.on('error', (e) => {
      console.error('[lapi] srv-error ' + (e.code ?? '') + ' ' + (e.message ?? e));
      reject(e);
    });
  });
}

// main-entry check (works under node --watch too)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((e) => {
    console.error('[lapi] failed to start: ', e);
    process.exit(1);
  });
}