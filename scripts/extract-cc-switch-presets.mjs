#!/usr/bin/env node
// 从 cc-switch 的 claudeProviderPresets.ts 提取 Anthropic 协议渠道预设，转成 lapi 的预设数据文件。

// 用法：node scripts/extract-cc-switch-presets.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcFile = join(root, 'sources', 'cc-switch', 'src', 'config', 'claudeProviderPresets.ts');
const outFile = join(root, 'server', 'presets-data.mjs');

const raw = readFileSync(srcFile, 'utf8');

// 找到 export const providerPresets: ProviderPreset[] = [ …… ];
const marker = 'providerPresets';
const mk = raw.indexOf(marker);
if (mk < 0) throw new Error('找不到 providerPresets 导出');
const openBracket = raw.indexOf('[', mk);
const closeBracket = raw.lastIndexOf(']');
if (openBracket < 0 || closeBracket < openBracket) throw new Error('预设数组括号不完整');
const entriesSrc = raw.slice(openBracket + 1, closeBracket);

let entries;

try {
  entries = Function(`"use strict"; return [${entriesSrc}];`)();
} catch (e) {
  throw new Error('解析预设数组失败：' + e.message);
}

const CATEGORY_LABEL = {
  official: '官方',
  cn_official: '国内官方',
  cloud_provider: '云厂商',
  aggregator: '聚合',
  third_party: '第三方',
  custom: '自定义',
};

/** 去掉推广参数：?aff=xxx、?ch=xxx 等，并去尾部斜杠 */
function cleanUrl(url) {
  if (!url) return '';
  return url.split('?')[0].replace(/\/+$/, '');
}

/** 从 env 里取默认模型（去重） */
function modelsFromEnv(env) {
  const m = [];
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) {
    if (env[k] && !m.includes(env[k])) m.push(env[k]);
  }
  return m;
}

const anthropic = [];
const unsupported = [];
const seenNames = new Map();
let skipped = 0;

for (const p of entries ?? []) {
  if (!p || typeof p !== 'object') continue;
  if (p.hidden) { skipped++; continue; }
  if (p.requiresOAuth || p.providerType) {
    unsupported.push({
      name: p.name ?? '?',
      reason: p.providerType ? '需要 ' + p.providerType + ' OAuth 登录' : '需要 OAuth 登录',
    });
    skipped++; continue;
  }
  if (p.apiFormat && p.apiFormat !== 'anthropic') {
    unsupported.push({ name: p.name ?? '?', reason: 'apiFormat ' + p.apiFormat + '（v1 不支持协议转换）' });
    skipped++; continue;
  }
  const env = p.settingsConfig?.env;
  const baseUrl = cleanUrl(env?.ANTHROPIC_BASE_URL);
  if (!baseUrl) { skipped++; continue; }
  const needsManual = /\$\{[^}]+\}/.test(baseUrl + JSON.stringify(p.templateValues ?? {}));
  if (needsManual) {
    unsupported.push({ name: p.name ?? '?', reason: '含模板变量（需人工补全地址）' });
    skipped++; continue;
  }
  const authMode = env.ANTHROPIC_API_KEY ? 'x-api-key' : 'bearer';
  const id = (p.name ?? 'unnamed').trim();
  const cnt = seenNames.get(id) ?? 0;
  seenNames.set(id, cnt + 1);
  const uniqueName = cnt === 0 ? id : id + ' #' + (cnt + 1);
anthropic.push({
    id: 'cc-' + Buffer.from(uniqueName).toString('base64url').slice(0, 12),
    name: uniqueName,
    websiteUrl: cleanUrl(p.websiteUrl) ?? '',
    baseUrl,
    authMode,
    protocol: 'anthropic',
    category: CATEGORY_LABEL[p.category] ?? '其他',
    defaultModels: modelsFromEnv(env),
    verified: false,
  });
}

// ── OpenAI 协议精选（手写知名稳定端点；模型填 '*' 全收，上游不认识的模型会报错，建议按实际模型名改）──
const openaiPresets = [
  { name: 'DeepSeek', websiteUrl: 'https://platform.deepseek.com', baseUrl: 'https://api.deepseek.com', authMode: 'bearer', protocol: 'openai', category: '国内官方', defaultModels: ['deepseek-chat', 'deepseek-reasoner'], verified: true },
  { name: 'OpenRouter', websiteUrl: 'https://openrouter.ai', baseUrl: 'https://openrouter.ai/api/v1', authMode: 'bearer', protocol: 'openai', category: '聚合', defaultModels: ['*'], verified: true },
  { name: 'Moonshot Kimi', websiteUrl: 'https://platform.moonshot.cn', baseUrl: 'https://api.moonshot.cn/v1', authMode: 'bearer', protocol: 'openai', category: '国内官方', defaultModels: ['*'], verified: true },
  { name: 'Zhipu GLM', websiteUrl: 'https://open.bigmodel.cn', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', authMode: 'bearer', protocol: 'openai', category: '国内官方', defaultModels: ['*'], verified: true },
  { name: 'SiliconFlow 硅基流动', websiteUrl: 'https://siliconflow.cn', baseUrl: 'https://api.siliconflow.cn/v1', authMode: 'bearer', protocol: 'openai', category: '国内官方', defaultModels: ['*'], verified: true },
  { name: 'ModelScope 魔搭', websiteUrl: 'https://modelscope.cn', baseUrl: 'https://api-inference.modelscope.cn/v1', authMode: 'bearer', protocol: 'openai', category: '国内官方', defaultModels: ['*'], verified: true },
];

const UA_PRESETS = [
  'claude-cli/2.1.161 (external, cli)',
  'claude-cli/2.1.161',
  'claude-code/1.0.0',
  'claude-code/0.1.0',
  'Kilo-Code/1.0',
];

const out =
  '// 由 scripts/extract-cc-switch-presets.mjs 生成，勿手改（再次运行会覆盖）。\n' +
  '// 预设数据提取自开源 cc-switch（MIT），截至 2026-08-31 的条目；上游地址可能失效。\n' +
  '// verified: false 表示"未逐一核实"（自动提取层）；true 表示人工核对过。\n\n' +
  'export const PRESET_META = {\n' +
  '  source: "cc-switch（https://github.com/farionbjam/cc-switch，MIT）",\n' +
  '  extractedAt: "2026-08-31",\n' +
  '  note: "上游地址可能失效；OAuth 类预设 v1 暂不支持",\n' +
  '};\n' +
  'export const ANTHROPIC_PRESETS = ' + JSON.stringify(anthropic, null, 2) + ';\n\n' +
  'export const OPENAI_PRESETS = ' + JSON.stringify(openaiPresets, null, 2) + ';\n\n' +
  'export const UA_PRESETS = ' + JSON.stringify(UA_PRESETS, null, 2) + ';\n\n' +
  'export const UNSUPPORTED_PRESETS = ' + JSON.stringify(unsupported, null, 2) + ';\n';

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, out);
console.log('已生成 ' + outFile);
console.log('Anthropic 预设：' + anthropic.length + ' 条；');
console.log('OpenAI 预设：' + openaiPresets.length + ' 条；');
console.log('跳过/暂不支持：' + unsupported.length + ' 条；（' + unsupported.slice(0, 8).
  map(u => u.name).
  join('、') + '…）');
console.log('\\nAnthropic 预设名单：');
for (const p of anthropic) {
  console.log('  [' + p.category + '] ' + p.name + '  →  ' + p.baseUrl + '  (' + p.authMode + ')  ' + p.defaultModels.join(','));
}