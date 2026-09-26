// Client impersonation presets: storage + draft classification from captures.
// A preset pins a coherent header identity ("伪装成哪个客户端") that a channel can
// reference; the two credential-ish axes (host, auth) stay channel-owned and can
// never appear in a preset.

import { getSetting, setSetting } from './db.js';
import { isDroppedHeader } from './relay-lib.js';

const KEY = 'client_presets';

// Names carrying per-session / per-request values: replaying one pinned value
// across sessions goes stale, so these default to fill (backfill-only).
const FILL_NAME_RE = /session|thread|request|uuid|turn|window|nonce|retry|query/i;
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'proxy-authorization']);
// Volatile per request type (flag combinations), name gives no hint — decided to exclude.
const EXTRA_EXCLUDED = new Set(['anthropic-beta']);
// 浏览器/undici 自动注入的头：随客户端运行时变化，不该进档案
// （真 opencode 不发它们；严格模式会把客户端带来的这类头剔除）。
const EXCLUDED_PREFIXES = ['sec-fetch-'];
const EXCLUDED_NAMES = new Set(['accept-language', 'anthropic-beta']);

export function loadPresets() {
  try {
    const arr = JSON.parse(getSetting(KEY) || '[]');
    const list = Array.isArray(arr) ? arr : [];
    // 旧档案（strict 字段诞生前创建的）没有该字段：读取时归一化为开启，
    // 否则历史档案会一直处于"叠加模式"，指纹泄漏排障会非常困惑。
    for (const p of list) {
      if (p && typeof p === 'object') p.strict = p.strict !== false;
    }
    return list;
  } catch {
    return [];
  }
}

export function getPreset(name) {
  return loadPresets().find((p) => p && p.name === name) ?? null;
}

export function savePresets(list) {
  setSetting(KEY, JSON.stringify(list));
}

// 一条捕获 → 预设草稿：网关管辖/认证/明确排除的不收；会话请求类 fill；其余 fixed。
export function classifyCaptureHeaders(inHeaders) {
  const headers = [];
  for (const [name, v] of Object.entries(inHeaders ?? {})) {
    const lower = String(name).toLowerCase().trim();
    if (!lower) continue;
    if (isDroppedHeader(lower)) continue; // 网关管辖：转发时自动重建/计算
    if (AUTH_HEADERS.has(lower)) continue; // 认证：渠道 key 管辖
    if (EXCLUDED_NAMES.has(lower) || EXCLUDED_PREFIXES.some((p) => lower.startsWith(p))) continue;
    headers.push({
      name: lower,
      value: Array.isArray(v) ? v.join(', ') : String(v ?? ''),
      mode: FILL_NAME_RE.test(lower) ? 'fill' : 'fixed',
    });
  }
  headers.sort((a, b) => a.name.localeCompare(b.name));
  const ua = String(inHeaders?.['user-agent'] ?? '');
  const guess = ua.split('/')[0].trim().slice(0, 60);
  return { name: guess, headers };
}
