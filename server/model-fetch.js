// Upstream model-list fetching (cc-switch candidate chain), shared by the admin API
// (draft/saved channel 拉取模型) and the proxy port's /v1/models forward.

import { egressOptions } from './egress.js';

const KNOWN_COMPAT_SUFFIXES = ['/api/claudecode', '/api/anthropic', '/apps/anthropic', '/api/coding', '/claudecode', '/anthropic', '/step_plan', '/coding', '/claude'];

function endsWithVersionSegment(url) {
  const last = url.split('/').pop() ?? '';
  return /^v\d+$/.test(last);
}

function stripCompatSuffix(base) {
  for (const s of KNOWN_COMPAT_SUFFIXES) {
    if (base.endsWith(s)) return base.slice(0, base.length - s.length);
  }
  return null;
}

function buildModelsUrlCandidates(rawBase) {
  const base = String(rawBase ?? '').trim().replace(/\/+$/, '');
  if (!base) return [];
  const candidates = [];
  if (endsWithVersionSegment(base)) {
    // base already ends with a version segment (/v1, zhipu /api/coding/paas/v4 ...):
    // the models endpoint is {base}/models; appending /v1 would 404.
    candidates.push(base + '/models');
    if (!base.endsWith('/v1')) candidates.push(base + '/v1/models');
  } else {
    candidates.push(base + '/v1/models');
  }
  const stripped = stripCompatSuffix(base);
  if (stripped) {
    const root = stripped.replace(/\/+$/, '');
    if (root) {
      candidates.push(root + '/v1/models');
      candidates.push(root + '/models');
    }
  }
  return [...new Set(candidates)];
}

// Fetch the model list for a channel(-like) object { base_url, api_key, auth_mode }.
// Returns { models: string[], error: string } — no "test" semantics, the model
// picker's data source.
export async function fetchModelsList(c) {
  const base = String(c.base_url ?? '').trim();
  if (!base) {
    return { models: [], error: 'base_url 为空' };
  }
  const candidates = buildModelsUrlCandidates(base);
  const headers = {};
  const firstKey = String(c.api_key ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  if (firstKey) {
    if (c.auth_mode === 'bearer') headers['authorization'] = 'Bearer ' + firstKey;
    else if (c.auth_mode === 'x-api-key') headers['x-api-key'] = firstKey;
    else if (c.auth_mode === 'x-goog-api-key') headers['x-goog-api-key'] = firstKey;
  }
  headers['accept-encoding'] = 'identity';
  let models = [];
  let error = candidates.length ? '' : '无法从 base_url 推导模型列表端点';
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000), ...egressOptions(url) });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        const seen = new Set();
        const got = [];
        for (const m of (j?.data ?? [])) {
          const id = String(m?.id ?? m?.name ?? '').trim();
          if (id && !seen.has(id) && seen.size < 400) {
            seen.add(id);
            got.push(id);
          }
        }
        if (got.length) {
          models = got.sort();
          break;
        }
        error = '上游 ' + url + ' 未返回有效模型列表';
      } else if (r.status === 404 || r.status === 405) {
        // cc-switch rule: only 404/405 move on to the next candidate.
        error = '上游 ' + url + ' 返回 ' + r.status;
        continue;
      } else {
        error = '上游 ' + url + ' 返回 ' + r.status;
        break;
      }
    } catch (e) {
      error = String(e?.message ?? e);
      break;
    }
  }
  return { models, error };
}
