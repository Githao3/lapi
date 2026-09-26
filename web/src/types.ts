export type Protocol = 'anthropic' | 'openai';

export type AuthMode = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

export interface Channel {
  id?: number;
  name: string;
  protocol: Protocol;
  openai_endpoint: string;
  base_url: string;
  api_key: string;
  auth_mode: AuthMode;
  user_agent_override: string;
  client_preset: string;
  header_overrides: Record<string, string>;
  model_mapping: Record<string, string>;
  models: string;
  weight: number;
  enabled: boolean;
  notes: string;
  created_at?: number;
  updated_at?: number;
}

export interface ClientPresetHeader {
  name: string;
  value: string;
  mode: 'fixed' | 'fill' | 'drop';
}

export interface ClientPreset {
  name: string;
  created_at: number;
  headers: ClientPresetHeader[];
}

export interface PresetEntry {
  name: string;
  websiteUrl?: string;
  baseUrl: string;
  authMode: string;
  defaultModels?: string[];
  protocol?: Protocol;
  verified?: boolean;
  featured?: boolean;
  category?: string;
}

export interface PresetsPayload {
  meta: Record<string, unknown>;
  anthropic: PresetEntry[];
  openai: PresetEntry[];
  featured: PresetEntry[];
  uaPresets: string[];
  uaPresetsCustom?: string[];
  unsupported: PresetEntry[] | string[];
}

export interface LogEntry {
  id: number;
  ts: number;
  kind: string;
  path: string;
  method: string;
  channel_id: number | null;
  channel_name: string;
  model: string;
  status: number | null;
  ms: number | null;
  error: string;
  detail: Record<string, unknown>;
}

export interface SystemInfo {
  uptime: number;
  mode: string;
  channels: number;
}

export interface LogSummary {
  total: number;
  relay: number;
  capture: number;
  oldest_ts: number | null;
  newest_ts: number | null;
  older?: number;
}

export interface SettingsPayload {
  port?: string;
  bind?: string;
  gateway_token?: string;
  has_gateway_token?: boolean;
  has_admin_password?: boolean;
  capture_enabled?: string;
  logging_enabled?: string;
  log_out_headers?: string;
  resolved_port?: string;
  upstream_proxy?: string;
  upstream_proxy_bypass?: string;
}

export interface SessionInfo {
  ok: boolean;
  local: boolean;
  auth_required: boolean;
  configured: boolean;
  authed: boolean;
}

export interface CapturePayload {
  // Server may answer with a SQLite int (1/0) or string; normalize on read.
  enabled: boolean | number | string;
  entries: LogEntry[];
}

export interface FetchModelsResult {
  models: string[];
  error: string;
}

export interface ApplyPresetResult {
  ok: boolean;
  draft: Partial<Channel>;
}
export interface CatalogChannelRef {
  name: string;
  via: 'declared' | 'alias';
  enabled: boolean;
}

export interface ModelsCatalogEntry {
  model: string;
  channels: CatalogChannelRef[];
}

export interface UsageStatName {
  name: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageStats {
  range: string;
  bucket_ms: number;
  totals: { requests: number; ok: number; fail: number; success_rate: number; input_tokens: number; output_tokens: number; cache_read: number; cache_creation: number; avg_ms: number };
  prev_totals: { requests: number; input_tokens: number; output_tokens: number };
  rpm: number;
  tpm: number;
  trend: { bucket: number; requests: number; input_tokens: number; output_tokens: number }[];
  trend_by_model: { bucket: number; model: string; requests: number; input_tokens: number; output_tokens: number }[];
  by_model: UsageStatName[];
  by_channel: UsageStatName[];
}
