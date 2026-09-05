// App assembly: express wiring, relay routes, admin auth guard, static hosting, port picking.

import express from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { listChannels, getSetting, setSetting } from './db.js';
import { handleRelayRequest } from './relay.js';
import { attachCrud } from './crud.js';

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
  app.use('/api', adminAuth);
  attachCrud(app);

  // relay (gateway) routes for CLI tools
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
  app.get('/models', handleModelsList);
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

function adminAuth(req, res, next) {
  const bind = getSetting('bind');
  const localHosts = ['127.0.0.1', 'localhost', '::1'];
  if (localHosts.includes(bind)) return next();
  const token = getSetting('gateway_token');
  if (!token) {
    res.status(503).json({ ok: false, error: 'non-local bind requires a gateway token; set it in Settings' });
    return;
  }
  const auth = req.headers.authorization ?? '';
  const ok = auth === token || auth === 'Bearer ' + token;
  if (!ok) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  next();
}

export async function startServer() {
  const bind = getSetting('bind') || '127.0.0.1';
  let port = Number(getSetting('port') || 8787);
  for (let i=0; i<20; i++) {
    try {
      await listenOnce(bind, port);
      setSetting('port', String(port));
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