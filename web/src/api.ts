import type {
  Channel,
  PresetsPayload,
  LogEntry,
  SystemInfo,
  SettingsPayload,
  CapturePayload,
  FetchModelsResult,
  ApplyPresetResult,
  UsageStats,
  UsageStatName,
  CatalogChannelRef,
  ModelsCatalogEntry,
  SessionInfo,
} from './types';

const SESSION_KEY = 'lapi_session';

export function getSessionToken(): string {
  try {
    return localStorage.getItem(SESSION_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setSessionToken(token: string): void {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage disabled — the session then lives only until this tab reloads */
  }
}

// The panel switches to the login screen whenever a call comes back 401.
function fireUnauthorized(): void {
  setSessionToken('');
  window.dispatchEvent(new CustomEvent('lapi-unauthorized'));
}

export function onUnauthorized(cb: () => void): () => void {
  window.addEventListener('lapi-unauthorized', cb);
  return () => window.removeEventListener('lapi-unauthorized', cb);
}

// fetch with the admin session attached; a rejected session drops it and asks for login.
function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = getSessionToken();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.authorization = 'Bearer ' + token;
  return fetch(url, { ...init, headers }).then((r) => {
    if (r.status === 401) fireUnauthorized();
    return r;
  });
}

async function j<T>(res: Response | Promise<Response>): Promise<T> {
  const r = await res as unknown as { text?: unknown; ok?: unknown; status?: unknown };
  if (typeof r.text !== 'function') {
    let preview = '';
    try {
      preview = JSON.stringify(r).slice(0, 80);
    } catch {
      preview = String(r);
    }
    throw new TypeError('HTTP 客户端异常：fetch 结果不是标准 Response（' + preview + '）');
  }
  const text = await r.text();
  if (!r.ok) {
    let msg = text || ('HTTP ' + r.status);
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed?.error === 'string') msg = parsed.error;
    } catch {
      /* non-JSON error body: keep the raw text */
    }
    throw new Error(msg);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const api = {
  getSession: () => j<SessionInfo>(authFetch('/api/session')),
  // Plain fetch: a wrong password is a normal 401 here, not an expired session.
  login: (password: string) =>
    j<{ ok: boolean; session: string }>(
      fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
    ),
  logout: () => j<{ ok: boolean }>(authFetch('/api/logout', { method: 'POST' })),
  getConfig: () => j<SettingsPayload>(authFetch('/api/config')),
  putConfig: (body: Record<string, unknown>) => j<{ ok: boolean }>(authFetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  listChannels: () => j<Channel[]>(authFetch('/api/channels')),
  createChannel: (c: Partial<Channel>) => j<{ ok: boolean; id: number }>(authFetch('/api/channels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })),
  updateChannel: (id: number, c: Partial<Channel>) => j<{ ok: boolean }>(authFetch('/api/channels/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })),
  deleteChannel: (id: number) => j<{ ok: boolean }>(authFetch('/api/channels/' + id, { method: 'DELETE' })),
  toggleChannel: (id: number) => j<{ ok: boolean; enabled: boolean }>(authFetch('/api/channels/' + id + '/toggle', { method: 'POST' })),
  fetchModels: (id: number) => j<FetchModelsResult>(authFetch('/api/channels/' + id + '/fetch-models', { method: 'POST' })),
  fetchModelsDraft: (c: Record<string, unknown>) => j<FetchModelsResult>(authFetch('/api/channels/fetch-models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })),
  listPresets: () => j<PresetsPayload>(authFetch('/api/presets')),
  applyPreset: (name: string) => j<ApplyPresetResult>(authFetch('/api/presets/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })),
  getCapture: () => j<CapturePayload>(authFetch('/api/capture')),
  toggleCapture: (enabled: boolean) => j<{ ok: boolean }>(authFetch('/api/capture/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) })),
  clearCapture: () => j<{ ok: boolean }>(authFetch('/api/capture', { method: 'DELETE' })),
  saveUaPreset: (ua: string) => j<{ ok: boolean; added?: boolean; uaPresetsCustom?: string[] }>(authFetch('/api/ua-presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ua }) })),
  deleteUaPreset: (ua: string) => j<{ ok: boolean; removed?: boolean; uaPresetsCustom?: string[] }>(authFetch('/api/ua-presets?ua=' + encodeURIComponent(ua), { method: 'DELETE' })),
  getStats: (range: string) => j<UsageStats>(authFetch('/api/stats?range=' + encodeURIComponent(range))),
  // Raw Response on purpose: the playground reads the SSE stream off it itself.
  playgroundChat: (body: Record<string, unknown>, signal?: AbortSignal) =>
    authFetch('/api/playground/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }),
  getModelsCatalog: () => j<ModelsCatalogEntry[]>(authFetch('/api/models-catalog')),
  listLogs: (limit?: number) => j<LogEntry[]>(authFetch('/api/logs?limit=' + (limit ?? 100))),
  getSystem: () => j<SystemInfo>(authFetch('/api/system')),
};

export function fmtTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

export function fmtUptime(sec: number): string {
  if (sec < 60) return Math.floor(sec) + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}
