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
  header_overrides: Record<string, string>;
  model_mapping: Record<string, string>;
  models: string;
  weight: number;
  enabled: boolean;
  notes: string;
  created_at?: number;
  updated_at?: number;
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

export interface SettingsPayload {
  port?: string;
  bind?: string;
  gateway_token?: string;
  capture_enabled?: string;
  logging_enabled?: string;
  resolved_port?: string;
  upstream_proxy?: string;
  upstream_proxy_bypass?: string;
}

export interface CapturePayload {
  enabled: boolean;
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
  rpm: number;
  tpm: number;
  trend: { bucket: number; requests: number; input_tokens: number; output_tokens: number }[];
  trend_by_model: { bucket: number; model: string; requests: number; input_tokens: number; output_tokens: number }[];
  by_model: UsageStatName[];
  by_channel: UsageStatName[];
}
