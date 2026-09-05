// Egress control: route upstream fetches through a local proxy tool (Clash /
// v2rayN / ...) so GFW-blocked channels become reachable. Reads settings on
// every call — proxy changes apply immediately, no restart.
//
//   upstream_proxy        e.g. http://127.0.0.1:7897 (empty = direct)
//   upstream_proxy_bypass comma-separated host keywords; a host containing one
//                         goes direct (for domestically reachable upstreams)
import { getSetting } from './db.js';
import { ProxyAgent } from 'undici';

let cachedAgent = null;
let cachedProxyUrl = '';

function bypassed(host) {
  const list = String(getSetting('upstream_proxy_bypass') ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const h = String(host ?? '').toLowerCase();
  return list.some((b) => h.includes(b));
}

// Extra fetch init for reaching this URL: { dispatcher } when the request must
// ride the proxy, {} for direct. Merge into fetch(url, init).
export function egressOptions(url) {
  const proxy = String(getSetting('upstream_proxy') ?? '').trim();
  if (!proxy) return {};
  let host = '';
  try { host = new URL(url).host; } catch { return {}; }
  if (bypassed(host)) return {};
  if (cachedProxyUrl !== proxy || !cachedAgent) {
    cachedAgent = new ProxyAgent(proxy);
    cachedProxyUrl = proxy;
  }
  return { dispatcher: cachedAgent };
}
