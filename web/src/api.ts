import type {
  Channel,
  PresetsPayload,
  LogEntry,
  SystemInfo,
  SettingsPayload,
  CapturePayload,
  FetchModelsResult,
  ApplyPresetResult,
  CatalogChannelRef,
  ModelsCatalogEntry,
} from './types';

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
  if (!r.ok) throw new Error(text || ('HTTP ' + r.status));
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const api = {
  getConfig: () => j<SettingsPayload>(fetch('/api/config')),
  putConfig: (body: Record<string, unknown>) => j<{ ok: boolean }>(fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  listChannels: () => j<Channel[]>(fetch('/api/channels')),
  createChannel: (c: Partial<Channel>) => j<{ ok: boolean; id: number }>(fetch('/api/channels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })),
  updateChannel: (id: number, c: Partial<Channel>) => j<{ ok: boolean }>(fetch('/api/channels/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })),
  deleteChannel: (id: number) => j<{ ok: boolean }>(fetch('/api/channels/' + id, { method: 'DELETE' })),
  toggleChannel: (id: number) => j<{ ok: boolean; enabled: boolean }>(fetch('/api/channels/' + id + '/toggle', { method: 'POST' })),
  fetchModels: (id: number) => j<FetchModelsResult>(fetch('/api/channels/' + id + '/fetch-models', { method: 'POST' })),
  fetchModelsDraft: (c: Record<string, unknown>) => j<FetchModelsResult>(fetch('/api/channels/fetch-models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })),
  listPresets: () => j<PresetsPayload>(fetch('/api/presets')),
  applyPreset: (name: string) => j<ApplyPresetResult>(fetch('/api/presets/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })),
  getCapture: () => j<CapturePayload>(fetch('/api/capture')),
  toggleCapture: (enabled: boolean) => j<{ ok: boolean }>(fetch('/api/capture/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) })),
  clearCapture: () => j<{ ok: boolean }>(fetch('/api/capture', { method: 'DELETE' })),
  saveUaPreset: (ua: string) => j<{ ok: boolean; added?: boolean; uaPresetsCustom?: string[] }>(fetch('/api/ua-presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ua }) })),
  deleteUaPreset: (ua: string) => j<{ ok: boolean; removed?: boolean; uaPresetsCustom?: string[] }>(fetch('/api/ua-presets?ua=' + encodeURIComponent(ua), { method: 'DELETE' })),
  getModelsCatalog: () => j<ModelsCatalogEntry[]>(fetch('/api/models-catalog')),
  listLogs: (limit?: number) => j<LogEntry[]>(fetch('/api/logs?limit=' + (limit ?? 100))),
  getSystem: () => j<SystemInfo>(fetch('/api/system')),
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