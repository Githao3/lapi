// Ported from cc-switch (MIT, (c) 2025 Jason Young) — transform_responses.rs, transform_codex_anthropic.rs, reasoning_bridge.rs, streaming_responses.rs, streaming_codex_anthropic.rs, codex_responses_sse.rs.
//
// Mirror-pair converter: Anthropic /v1/messages ⇄ OpenAI /v1/responses.
//   request('messages','responses', b)  — anthropic_to_responses + convert_messages_to_input
//   request('responses','messages', b)  — responses_request_to_anthropic (history normalization included)
//   response('responses','messages', b) — responses_to_anthropic (non-streaming)
//   response('messages','responses', b) — anthropic_response_to_responses (non-streaming)
//   createSse(from,to)                  — both SSE directions; Responses-side event bytes come
//                                         from the codex_responses_sse.rs builders ported below.
//
// Deliberate simplifications vs cc-switch (fail-closed where noted):
// - The ~1100-line markdown citation lexer (text_with_url_citations) is NOT ported.
//   url_citation annotations are rendered as a simplified "Sources:" footnote text block.
// - Hosted web-search bridging (hosted tools, web_search_call, server_tool_use,
//   web_search_tool_result) is not bridged; payloads carrying them throw ConversionError.
// - Embedded-media extraction from tool-result JSON (strip_and_clamp_media_from_tool_value)
//   is not ported; unrepresentable tool-result parts fall back to canonical JSON text.
// - Anthropic message_start on the Responses→Anthropic SSE stream is deferred until the
//   first substantive content (cc-switch emits it at response.created).

import { ConversionError } from './errors.mjs';
import {
  takeSseBlock,
  parseEventBlock,
  isDoneData,
  canonicalJsonString,
  canonicalizeToolArguments,
} from './sse-common.mjs';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const TOOL_RESULT_ERROR_MARKER = '[cc-switch:tool-result-error]';
const OPENAI_REASONING_ITEM_PREFIX = 'ccswitch-openai-reasoning-v1:';
const ANTHROPIC_THINKING_ENCRYPTED_PREFIX = 'ccswitch-anthropic-thinking-v1:';
const ANTHROPIC_BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';
const DEFAULT_MAX_TOKENS = 4096;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// serde's u64 view of a JSON value: non-negative integers only, else 0.
function u64(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) return 0;
  return v;
}

function u64Opt(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

function cloneJson(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function isMeaningfulText(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

function stripLeadingAnthropicBillingHeader(text) {
  if (!text.startsWith(ANTHROPIC_BILLING_HEADER_PREFIX)) return text;
  const m = /\r\n|\r|\n/.exec(text);
  if (!m) return '';
  let rest = text.slice(m.index + m[0].length);
  if (rest.startsWith('\r\n')) rest = rest.slice(2);
  else if (rest.startsWith('\n') || rest.startsWith('\r')) rest = rest.slice(1);
  return rest;
}

// --- Read-tool argument sanitizer (transform_responses.rs) -------------------
function sanitizeReadToolInput(name, input) {
  if (name !== 'Read' || !isObj(input)) return input;
  if (input.pages === '') {
    const out = { ...input };
    delete out.pages;
    return out;
  }
  return input;
}

function sanitizeReadToolInputJson(name, raw) {
  if (name !== 'Read' || !raw) return raw;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  return JSON.stringify(sanitizeReadToolInput(name, parsed));
}

// ---------------------------------------------------------------------------
// reasoning_bridge.rs — opaque reasoning round-trip envelopes (base64url)
// ---------------------------------------------------------------------------

function encodeBase64Url(bytes) {
  return Buffer.from(bytes, 'utf8').toString('base64url');
}

function decodeBase64UrlText(encoded) {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

function reasoningSummaryText(item) {
  const summary = Array.isArray(item?.summary) ? item.summary : [];
  const parts = [];
  for (const part of summary) {
    if (isObj(part) && (part.type === 'summary_text' || part.type === 'reasoning_text') && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('');
}

function encodeOpenaiReasoningItem(item) {
  if (!isObj(item) || item.type !== 'reasoning') return null;
  try {
    return OPENAI_REASONING_ITEM_PREFIX + encodeBase64Url(JSON.stringify(item));
  } catch {
    return null;
  }
}

function decodeOpenaiReasoningItem(encoded) {
  if (typeof encoded !== 'string' || !encoded.startsWith(OPENAI_REASONING_ITEM_PREFIX)) return null;
  try {
    const item = JSON.parse(decodeBase64UrlText(encoded.slice(OPENAI_REASONING_ITEM_PREFIX.length)));
    if (isObj(item) && item.type === 'reasoning') return item;
    return null;
  } catch {
    return null;
  }
}

// Responses reasoning item → Anthropic thinking block (reasoning_bridge.rs).
function anthropicBlockFromOpenaiReasoningItem(item) {
  if (!isObj(item) || item.type !== 'reasoning') return null;
  const text = reasoningSummaryText(item);
  const encryptedContent = typeof item.encrypted_content === 'string' ? item.encrypted_content : '';
  if (encryptedContent.length > 0) {
    const envelope = encodeOpenaiReasoningItem(item);
    if (!envelope) return null;
    if (text === '') return { type: 'redacted_thinking', data: envelope };
    return { type: 'thinking', thinking: text, signature: envelope };
  }
  if (text === '') return null;
  return { type: 'thinking', thinking: text };
}

// Anthropic thinking block → Responses reasoning item (reasoning_bridge.rs).
function openaiReasoningItemFromAnthropicBlock(block) {
  if (!isObj(block)) return null;
  if (block.type === 'thinking') return decodeOpenaiReasoningItem(block.signature);
  if (block.type === 'redacted_thinking') return decodeOpenaiReasoningItem(block.data);
  return null;
}

// --- Anthropic-side envelope (transform_codex_anthropic.rs) ------------------

function encodeAnthropicThinkingBlock(block) {
  if (!isObj(block)) return null;
  if (block.type === 'thinking') {
    if (typeof block.signature !== 'string' || block.signature.length === 0) return null;
  } else if (block.type === 'redacted_thinking') {
    if (typeof block.data !== 'string' || block.data.length === 0) return null;
  } else {
    return null;
  }
  try {
    return ANTHROPIC_THINKING_ENCRYPTED_PREFIX + encodeBase64Url(JSON.stringify(block));
  } catch {
    return null;
  }
}

function decodeAnthropicThinkingBlock(encryptedContent) {
  if (typeof encryptedContent !== 'string' || !encryptedContent.startsWith(ANTHROPIC_THINKING_ENCRYPTED_PREFIX)) return null;
  try {
    const block = JSON.parse(decodeBase64UrlText(encryptedContent.slice(ANTHROPIC_THINKING_ENCRYPTED_PREFIX.length)));
    // Reuse the encoder's validation so malformed envelopes cannot replay an
    // unsigned thinking block into an Anthropic tool turn.
    return encodeAnthropicThinkingBlock(block) ? block : null;
  } catch {
    return null;
  }
}

function responsesReasoningItemFromAnthropicBlock(itemId, block) {
  const encryptedContent = encodeAnthropicThinkingBlock(block);
  if (!encryptedContent) return null;
  const thinkingText = typeof block.thinking === 'string' ? block.thinking : '';
  const summary = isMeaningfulText(thinkingText) ? [{ type: 'summary_text', text: thinkingText }] : [];
  return {
    id: itemId,
    type: 'reasoning',
    summary,
    encrypted_content: encryptedContent,
  };
}

// ---------------------------------------------------------------------------
// Schema cleaning + reasoning-effort heuristics (transform.rs)
// ---------------------------------------------------------------------------

function cleanSchemaInner(schema, isRoot) {
  if (!isObj(schema)) return schema;
  const out = { ...schema };
  const missingType = isRoot && !('type' in out);
  if (missingType) out.type = 'object';
  if (missingType && !('properties' in out)) out.properties = {};
  if (out.format === 'uri') delete out.format;
  if (isObj(out.properties)) {
    const props = {};
    for (const key of Object.keys(out.properties)) {
      props[key] = cleanSchemaInner(out.properties[key], false);
    }
    out.properties = props;
  }
  if ('items' in out) out.items = cleanSchemaInner(out.items, false);
  return out;
}

function cleanSchema(schema) {
  return cleanSchemaInner(isObj(schema) ? schema : {}, true);
}

function isOpenaiOSeries(model) {
  return model.length > 1 && model.startsWith('o') && model.charCodeAt(1) >= 48 && model.charCodeAt(1) <= 57;
}

// supports_reasoning_effort: o-series / gpt-5+ / grok-4.5* / grok-build-*
function supportsReasoningEffort(model) {
  const m = String(model ?? '').toLowerCase();
  if (!m) return false;
  if (isOpenaiOSeries(m)) return true;
  if (m.startsWith('gpt-')) {
    const c = m.charAt(4);
    if (c >= '5' && c <= '9') return true;
  }
  if (m === 'grok-4.5' || m.startsWith('grok-4.5-') || m.startsWith('grok-build-')) return true;
  return false;
}

// resolve_reasoning_effort: output_config.effort first, then thinking.{type,budget_tokens}.
function resolveReasoningEffort(body) {
  const cfgEffort = body?.output_config?.effort;
  if (typeof cfgEffort === 'string') {
    if (cfgEffort === 'low' || cfgEffort === 'medium' || cfgEffort === 'high') return cfgEffort;
    if (cfgEffort === 'max') return 'xhigh';
    return null;
  }
  const thinking = body?.thinking;
  if (!isObj(thinking)) return null;
  if (thinking.type === 'adaptive') return 'xhigh';
  if (thinking.type === 'enabled') {
    const budget = u64Opt(thinking.budget_tokens);
    if (budget != null) {
      if (budget < 4000) return 'low';
      if (budget < 16000) return 'medium';
      return 'high';
    }
    return 'high';
  }
  return null;
}

// effort_to_thinking_budget (transform_codex_anthropic.rs)
function effortToThinkingBudget(effort) {
  if (typeof effort !== 'string') return null;
  switch (effort.trim().toLowerCase()) {
    case 'minimal':
    case 'low':
      return 2048;
    case 'medium':
      return 8192;
    case 'high':
      return 16384;
    case 'xhigh':
    case 'max':
    case 'ultra':
      return 24576;
    default:
      return null;
  }
}

function reasoningExplicitlyDisabled(effort) {
  if (typeof effort !== 'string') return false;
  const e = effort.trim().toLowerCase();
  return e === 'none' || e === 'off' || e === 'disabled';
}

// map_anthropic_stop_reason_to_status → [status, incompleteReason]
function mapAnthropicStopReasonToStatus(stopReason) {
  switch (stopReason) {
    case 'max_tokens':
      return ['incomplete', 'max_output_tokens'];
    case 'refusal':
      return ['incomplete', 'content_filter'];
    case 'model_context_window_exceeded':
      return ['incomplete', 'max_output_tokens'];
    case 'pause_turn':
      return ['completed', null];
    default:
      return ['completed', null];
  }
}

// map_responses_stop_reason. Missing status maps to 'end_turn' (task table:
// "failed/other → end_turn"); cc-switch yields null there, but Anthropic clients
// expect a concrete stop_reason.
function mapResponsesStopReason(status, hasToolUse, incompleteReason) {
  if (typeof status !== 'string') return 'end_turn';
  if (status === 'completed' && hasToolUse) return 'tool_use';
  if (status === 'incomplete') {
    if (incompleteReason == null || incompleteReason === 'max_output_tokens' || incompleteReason === 'max_tokens') return 'max_tokens';
    return 'end_turn';
  }
  return 'end_turn';
}

// ---------------------------------------------------------------------------
// Usage tables (both directions)
// ---------------------------------------------------------------------------

// build_anthropic_usage_from_responses: OpenAI inclusive input → Anthropic fresh
// input by subtracting cache_read + cache_creation (saturating).
function buildAnthropicUsageFromResponses(usage) {
  if (!isObj(usage) || Object.keys(usage).length === 0) {
    return { input_tokens: 0, output_tokens: 0 };
  }
  const input = u64Opt(usage.input_tokens) ?? u64Opt(usage.prompt_tokens) ?? 0;
  const output = u64Opt(usage.output_tokens) ?? u64Opt(usage.completion_tokens) ?? 0;
  const result = { input_tokens: input, output_tokens: output };

  const nestedRead = u64Opt(usage.input_tokens_details?.cached_tokens);
  if (nestedRead != null) result.cache_read_input_tokens = nestedRead;
  const stdRead = u64Opt(usage.prompt_tokens_details?.cached_tokens);
  if (stdRead != null && result.cache_read_input_tokens === undefined) {
    result.cache_read_input_tokens = stdRead;
  }
  const nestedWrite =
    u64Opt(usage.input_tokens_details?.cache_write_tokens) ?? u64Opt(usage.prompt_tokens_details?.cache_write_tokens);
  if (nestedWrite != null) result.cache_creation_input_tokens = nestedWrite;

  // Direct Anthropic-style fields override (authoritative when present).
  if ('cache_read_input_tokens' in usage) result.cache_read_input_tokens = usage.cache_read_input_tokens;
  if ('cache_creation_input_tokens' in usage) result.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  if ('cache_creation' in usage) result.cache_creation = usage.cache_creation;

  const cached = u64(result.cache_read_input_tokens);
  const cacheCreation = u64(result.cache_creation_input_tokens);
  if (cached > 0 || cacheCreation > 0) {
    result.input_tokens = Math.max(0, Math.max(0, input - cached) - cacheCreation);
  }
  return result;
}

// build_responses_usage_from_anthropic: fresh input + cache subsets → inclusive input.
function buildResponsesUsageFromAnthropic(usage) {
  if (!isObj(usage)) {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } };
  }
  const freshInput = u64(usage.input_tokens);
  const output = u64(usage.output_tokens);
  const reasoning = u64(usage.output_tokens_details?.thinking_tokens);
  const cacheRead = u64(usage.cache_read_input_tokens);
  const cacheCreation = u64(usage.cache_creation_input_tokens);
  const inputTokens = freshInput + cacheRead + cacheCreation;

  const result = {
    input_tokens: inputTokens,
    output_tokens: output,
    total_tokens: inputTokens + output,
    output_tokens_details: { reasoning_tokens: reasoning },
  };
  if (cacheRead > 0 || cacheCreation > 0) {
    result.input_tokens_details = { cached_tokens: cacheRead, cache_write_tokens: cacheCreation };
  }
  if (cacheCreation > 0) result.cache_creation_input_tokens = cacheCreation;
  return result;
}

// ---------------------------------------------------------------------------
// REQUEST: Anthropic → Responses (anthropic_to_responses)
// ---------------------------------------------------------------------------

function hasHttpUrlScheme(value) {
  const v = String(value ?? '');
  return v.slice(0, 7).toLowerCase() === 'http://' || v.slice(0, 8).toLowerCase() === 'https://';
}

function anthropicImageToResponsesPart(block) {
  const source = block?.source;
  if (!isObj(source)) return null;
  if (source.type === 'url') {
    if (typeof source.url !== 'string' || !hasHttpUrlScheme(source.url)) return null;
    return { type: 'input_image', image_url: source.url };
  }
  // "base64" or missing type falls to the base64 path (transform_responses.rs).
  const data = source.data;
  if (typeof data !== 'string' || data.length === 0) return null;
  const mediaType = typeof source.media_type === 'string' && source.media_type ? source.media_type : 'image/png';
  return { type: 'input_image', image_url: 'data:' + mediaType + ';base64,' + data };
}

function anthropicDocumentToResponsesPart(block) {
  const source = block?.source;
  if (!isObj(source)) return null;
  const filename =
    (typeof block.title === 'string' && block.title) ||
    (typeof block.filename === 'string' && block.filename) ||
    'document.pdf';
  if (source.type === 'url') {
    if (typeof source.url !== 'string' || !hasHttpUrlScheme(source.url)) return null;
    return { type: 'input_file', file_url: source.url, filename };
  }
  if (source.type === 'base64') {
    const data = source.data;
    if (typeof data !== 'string' || data.length === 0) return null;
    const mediaType =
      typeof source.media_type === 'string' && source.media_type ? source.media_type : 'application/pdf';
    return { type: 'input_file', file_data: 'data:' + mediaType + ';base64,' + data, filename };
  }
  return null;
}

// Simplified vs cc-switch: the embedded-media extraction pass
// (alternate_image_tool_result_to_responses) is not ported; unrepresentable
// parts degrade to canonical JSON text.
function anthropicToolResultToResponsesOutput(block) {
  const isError = block?.is_error === true;
  const content = block?.content;
  if (!isError && typeof content === 'string') {
    return [{ type: 'input_text', text: content }];
  }
  const output = [];
  if (isError) output.push({ type: 'input_text', text: TOOL_RESULT_ERROR_MARKER });
  if (typeof content === 'string') {
    output.push({ type: 'input_text', text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      const t = isObj(part) ? str(part.type) : '';
      if (t === 'text') {
        if (typeof part.text === 'string') output.push({ type: 'input_text', text: part.text });
      } else if (t === 'image') {
        const image = anthropicImageToResponsesPart(part);
        output.push(image ?? { type: 'input_text', text: canonicalJsonString(part) });
      } else if (t === 'document') {
        const file = anthropicDocumentToResponsesPart(part);
        output.push(file ?? { type: 'input_text', text: canonicalJsonString(part) });
      } else {
        output.push({ type: 'input_text', text: canonicalJsonString(part) });
      }
    }
  } else if (content !== undefined && content !== null) {
    output.push({ type: 'input_text', text: canonicalJsonString(content) });
  }
  return output;
}

function isAnthropicWebSearchTool(tool) {
  const t = str(tool?.type);
  return t === 'web_search' || t.startsWith('web_search_');
}

function mapToolChoiceToResponses(toolChoice) {
  if (typeof toolChoice === 'string') return toolChoice;
  if (isObj(toolChoice)) {
    switch (toolChoice.type) {
      case 'any':
        return 'required';
      case 'auto':
        return 'auto';
      case 'none':
        return 'none';
      case 'tool':
        return { type: 'function', name: str(toolChoice.name) };
      default:
        return toolChoice;
    }
  }
  return toolChoice;
}

// convert_messages_to_input. Trailing reasoning-only assistant turns are pruned
// per message ("reasoning item without its required following item" avoidance).
function convertMessagesToInput(messages) {
  const input = [];
  for (const msg of messages) {
    const role = str(msg?.role) || 'user';
    const content = msg?.content;
    const messageInputStart = input.length;
    const flushMessage = () => {
      if (messageContent.length > 0) {
        input.push({ role, content: messageContent.slice() });
        messageContent.length = 0;
      }
    };
    const messageContent = [];

    if (typeof content === 'string') {
      const contentType = role === 'assistant' ? 'output_text' : 'input_text';
      input.push({ role, content: [{ type: contentType, text: content }] });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const blockType = isObj(block) ? str(block.type) : '';
        if (blockType === 'text') {
          if (typeof block.text === 'string') {
            const contentType = role === 'assistant' ? 'output_text' : 'input_text';
            messageContent.push({ type: contentType, text: block.text });
          }
        } else if (blockType === 'image') {
          const image = anthropicImageToResponsesPart(block);
          if (image) messageContent.push(image);
        } else if (blockType === 'document') {
          const file = anthropicDocumentToResponsesPart(block);
          if (file) messageContent.push(file);
        } else if (blockType === 'tool_use') {
          flushMessage();
          input.push({
            type: 'function_call',
            call_id: str(block.id),
            name: str(block.name),
            arguments: canonicalJsonString(block.input ?? {}),
          });
        } else if (blockType === 'tool_result') {
          flushMessage();
          input.push({
            type: 'function_call_output',
            call_id: str(block.tool_use_id),
            output: anthropicToolResultToResponsesOutput(block),
          });
        } else if (blockType === 'server_tool_use' || blockType === 'web_search_tool_result') {
          throw new ConversionError(
            'Anthropic server_tool_use/web_search_tool_result blocks are not supported by the Responses bridge'
          );
        } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          const reasoningItem = openaiReasoningItemFromAnthropicBlock(block);
          if (reasoningItem) {
            flushMessage();
            input.push(reasoningItem);
          }
        }
        // Unknown block types are dropped (cc-switch `_ => {}`).
      }
      flushMessage();
    } else {
      // No content or null content.
      input.push({ role });
    }

    if (role === 'assistant') {
      let hasGeneratedFollower = false;
      for (let index = input.length - 1; index >= messageInputStart; index--) {
        const item = input[index];
        const itemType = str(item?.type);
        const isAssistantMessage = item?.role === 'assistant';
        if (itemType === 'reasoning') {
          if (!hasGeneratedFollower) input.splice(index, 1);
        } else if (itemType === 'function_call' || isAssistantMessage) {
          hasGeneratedFollower = true;
        }
      }
    }
  }
  return input;
}

function anthropicToResponses(body) {
  const result = {};

  if (typeof body.model === 'string') result.model = body.model;

  // system → instructions (billing header stripped per part).
  if ('system' in body) {
    const system = body.system;
    let instructions = '';
    if (typeof system === 'string') {
      instructions = stripLeadingAnthropicBillingHeader(system);
    } else if (Array.isArray(system)) {
      instructions = system
        .filter((msg) => isObj(msg) && typeof msg.text === 'string')
        .map((msg) => stripLeadingAnthropicBillingHeader(msg.text))
        .filter((text) => text.length > 0)
        .join('\n\n');
    }
    if (instructions.length > 0) result.instructions = instructions;
  }

  if (Array.isArray(body.messages)) {
    result.input = convertMessagesToInput(body.messages);
  }

  if ('max_tokens' in body) result.max_output_tokens = body.max_tokens;
  if ('temperature' in body) result.temperature = body.temperature;
  if ('top_p' in body) result.top_p = body.top_p;
  if ('stream' in body) result.stream = body.stream;

  // Map Anthropic thinking → reasoning.effort, only for models that accept it.
  if (typeof body.model === 'string' && supportsReasoningEffort(body.model)) {
    const effort = resolveReasoningEffort(body);
    if (effort) result.reasoning = { effort };
  }

  // stop_sequences → dropped (Responses API does not support them).

  if (Array.isArray(body.tools)) {
    const responseTools = [];
    for (const tool of body.tools) {
      if (!isObj(tool)) continue;
      if (isAnthropicWebSearchTool(tool)) {
        throw new ConversionError(
          'Anthropic hosted WebSearch tools are not supported by the Responses bridge'
        );
      }
      if ('blocked_domains' in tool || 'allowed_domains' in tool) {
        throw new ConversionError('Anthropic web-search domain filters are not supported by the Responses bridge');
      }
      const toolType = tool.type;
      if (toolType !== undefined && toolType !== 'custom') {
        throw new ConversionError('unsupported Anthropic tool type: ' + String(toolType));
      }
      responseTools.push({
        type: 'function',
        name: str(tool.name),
        description: tool.description ?? null,
        parameters: cleanSchema(isObj(tool.input_schema) ? tool.input_schema : {}),
      });
    }
    if (responseTools.length > 0) result.tools = responseTools;
  }

  if ('tool_choice' in body) result.tool_choice = mapToolChoiceToResponses(body.tool_choice);

  return result;
}

// ---------------------------------------------------------------------------
// REQUEST: Responses → Anthropic (responses_request_to_anthropic)
// ---------------------------------------------------------------------------

function responsesSystemText(item) {
  const content = item?.content;
  if (typeof content === 'string') {
    return isMeaningfulText(content) ? [content.trim()] : [];
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      const t = isObj(part) ? str(part.type) : '';
      if (t === 'input_text' || t === 'output_text' || t === 'text') {
        if (isMeaningfulText(part.text)) parts.push(part.text.trim());
      }
    }
    return parts;
  }
  return [];
}

function imageBlockFromInputImage(part) {
  let url = null;
  const raw = part?.image_url;
  if (typeof raw === 'string') url = raw;
  else if (isObj(raw) && typeof raw.url === 'string') url = raw.url;
  if (url == null) return null;
  if (url.slice(0, 5).toLowerCase() === 'data:') {
    const rest = url.slice(5);
    const comma = rest.indexOf(',');
    if (comma < 0) return null;
    const meta = rest.slice(0, comma);
    const data = rest.slice(comma + 1);
    const mediaType = meta.split(';')[0] || 'image/png';
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }
  if (url.slice(0, 7).toLowerCase() === 'http://' || url.slice(0, 8).toLowerCase() === 'https://') {
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

function documentBlockFromInputFile(part) {
  const filename = typeof part?.filename === 'string' && part.filename ? part.filename : null;
  let block;
  const fileUrl = part?.file_url;
  if (typeof fileUrl === 'string' && hasHttpUrlScheme(fileUrl)) {
    block = { type: 'document', source: { type: 'url', url: fileUrl } };
  } else {
    const fileData = part?.file_data;
    if (typeof fileData !== 'string' || !fileData.startsWith('data:')) return null;
    const rest = fileData.slice(5);
    const comma = rest.indexOf(',');
    if (comma < 0) return null;
    const meta = rest.slice(0, comma);
    const data = rest.slice(comma + 1);
    if (data.length === 0) return null;
    const mediaType = meta.split(';')[0] || 'application/pdf';
    block = { type: 'document', source: { type: 'base64', media_type: mediaType || 'application/pdf', data } };
  }
  if (filename) block.title = filename;
  return block;
}

// function_call_output → tool_result content. The error marker text flips is_error.
function toolResultContentFromResponsesItem(item) {
  const output = item?.output;
  if (typeof output === 'string') {
    return { content: output, isError: false };
  }
  if (Array.isArray(output)) {
    const content = [];
    let isError = false;
    for (const part of output) {
      const t = isObj(part) ? str(part.type) : '';
      if (t === 'input_text' || t === 'output_text') {
        if (typeof part.text === 'string') {
          if (part.text === TOOL_RESULT_ERROR_MARKER) isError = true;
          else content.push({ type: 'text', text: part.text });
        }
      } else if (t === 'input_image') {
        const image = imageBlockFromInputImage(part);
        content.push(image ?? { type: 'text', text: canonicalJsonString(part) });
      } else if (t === 'input_file') {
        const document = documentBlockFromInputFile(part);
        content.push(document ?? { type: 'text', text: canonicalJsonString(part) });
      } else {
        content.push({ type: 'text', text: canonicalJsonString(part) });
      }
    }
    return { content, isError };
  }
  if (output !== undefined) return { content: canonicalJsonString(output), isError: false };
  return { content: canonicalJsonString(item), isError: false };
}

function pushBlock(messages, role, block) {
  const last = messages[messages.length - 1];
  if (last && last.role === role && Array.isArray(last.content)) {
    last.content.push(block);
    return;
  }
  messages.push({ role, content: [block] });
}

// tool_result blocks must precede any text/image blocks in a user turn.
function pushToolResultBlock(messages, block) {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    let insertAt = last.content.length;
    for (let i = 0; i < last.content.length; i++) {
      if (last.content[i]?.type !== 'tool_result') {
        insertAt = i;
        break;
      }
    }
    last.content.splice(insertAt, 0, block);
    return;
  }
  messages.push({ role: 'user', content: [block] });
}

// Thinking blocks stay at the front of their assistant turn.
function pushAssistantThinkingBlock(messages, block) {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant' && Array.isArray(last.content)) {
    let index = 0;
    while (index < last.content.length) {
      const t = last.content[index]?.type;
      if (t !== 'thinking' && t !== 'redacted_thinking') break;
      index++;
    }
    last.content.splice(index, 0, block);
    return;
  }
  pushBlock(messages, 'assistant', block);
}

// convert_input_to_messages: flat Responses input[] → Anthropic messages.
function convertInputToMessages(items) {
  const messages = [];
  for (const item of items) {
    const itemType = str(item?.type);
    if (itemType === 'function_call' && item.status === 'incomplete') {
      // Incomplete historical tool calls cannot form a valid Anthropic turn.
      continue;
    }
    if (itemType === 'function_call') {
      const callId = str(item.call_id ?? item.id);
      const name = str(item.name);
      const argsStr = typeof item.arguments === 'string' ? item.arguments : '';
      let input;
      if (argsStr.trim() === '') {
        input = {};
      } else {
        try {
          input = JSON.parse(argsStr);
        } catch (error) {
          throw new ConversionError("Invalid function_call arguments for '" + name + "': " + error.message);
        }
      }
      if (!isObj(input)) {
        throw new ConversionError("Function call arguments for '" + name + "' must be a JSON object");
      }
      pushBlock(messages, 'assistant', {
        type: 'tool_use',
        id: callId,
        name,
        input: sanitizeReadToolInput(name, input),
      });
    } else if (itemType === 'function_call_output') {
      const result = toolResultContentFromResponsesItem(item);
      const block = { type: 'tool_result', tool_use_id: str(item.call_id), content: result.content };
      if (result.isError) block.is_error = true;
      pushToolResultBlock(messages, block);
    } else if (itemType === 'input_text') {
      if (isMeaningfulText(item.text)) pushBlock(messages, 'user', { type: 'text', text: item.text });
    } else if (itemType === 'input_image') {
      const block = imageBlockFromInputImage(item);
      if (block) pushBlock(messages, 'user', block);
    } else if (itemType === 'reasoning') {
      const block = decodeAnthropicThinkingBlock(item.encrypted_content);
      if (block) pushAssistantThinkingBlock(messages, block);
    } else {
      // message item or an item carrying a role.
      const role = str(item?.role) || 'user';
      if (role === 'system' || role === 'developer') continue;
      const anthRole = role === 'assistant' ? 'assistant' : 'user';
      const content = item?.content;
      if (typeof content === 'string') {
        if (isMeaningfulText(content)) pushBlock(messages, anthRole, { type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          const partType = isObj(part) ? str(part.type) : '';
          if (partType === 'input_text' || partType === 'output_text') {
            if (isMeaningfulText(part.text)) pushBlock(messages, anthRole, { type: 'text', text: part.text });
          } else if (partType === 'refusal') {
            if (isMeaningfulText(part.refusal)) pushBlock(messages, anthRole, { type: 'text', text: part.refusal });
          } else if (partType === 'input_image') {
            const block = imageBlockFromInputImage(part);
            if (block) pushBlock(messages, anthRole, block);
          } else if (partType === 'input_file') {
            const block = documentBlockFromInputFile(part);
            if (block) pushBlock(messages, anthRole, block);
          }
        }
      }
    }
  }
  return messages;
}

// --- History normalization (Anthropic 400 avoidance) -------------------------

function messageBlockIds(message, blockType, idField) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const ids = [];
  for (const block of content) {
    if (isObj(block) && block.type === blockType) ids.push(str(block[idField]));
  }
  return ids;
}

function dropToolResultBlocks(message) {
  if (Array.isArray(message?.content)) {
    message.content = message.content.filter((block) => isObj(block) && block.type !== 'tool_result');
  }
}

function messageHasContent(message) {
  if (Array.isArray(message?.content)) return message.content.length > 0;
  return true;
}

function stringSetsEqual(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

// drop_incomplete_tool_turns: remove tool-call turns without a complete adjacent
// assistant tool_use ↔ user tool_result pair.
function dropIncompleteToolTurns(messages) {
  const original = messages.slice();
  const sanitized = [];
  let index = 0;
  while (index < original.length) {
    const message = original[index];
    const isAssistant = message?.role === 'assistant';
    const toolUseIds = isAssistant ? messageBlockIds(message, 'tool_use', 'id') : [];

    if (toolUseIds.length > 0) {
      const pairedUser = original[index + 1];
      const hasPairedUser = pairedUser?.role === 'user';
      const toolResultIds = hasPairedUser ? messageBlockIds(pairedUser, 'tool_result', 'tool_use_id') : [];
      const complete =
        toolUseIds.every((id) => id !== '') &&
        toolResultIds.every((id) => id !== '') &&
        new Set(toolUseIds).size === toolUseIds.length &&
        new Set(toolResultIds).size === toolResultIds.length &&
        stringSetsEqual(toolUseIds, toolResultIds);

      if (complete) {
        sanitized.push(message, pairedUser);
      } else if (hasPairedUser) {
        const user = cloneJson(pairedUser);
        dropToolResultBlocks(user);
        if (messageHasContent(user)) sanitized.push(user);
      }
      index += hasPairedUser ? 2 : 1;
      continue;
    }

    if (message?.role === 'user') {
      // A user message not consumed as a complete tool pair cannot retain tool_results.
      dropToolResultBlocks(message);
    }
    if (messageHasContent(message)) sanitized.push(message);
    index += 1;
  }
  messages.length = 0;
  for (const m of sanitized) messages.push(m);
}

function dropEmptyMessages(messages) {
  const kept = messages.filter((msg) => {
    if (Array.isArray(msg?.content)) return msg.content.length > 0;
    return true;
  });
  messages.length = 0;
  for (const m of kept) messages.push(m);
}

function ensureLeadingUserMessage(messages) {
  const leadsWithUser = messages.length > 0 && messages[0]?.role === 'user';
  if (messages.length > 0 && !leadsWithUser) {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continuing the conversation)' }] });
  }
}

// trim_trailing_assistant_text: strip whitespace-only assistant prefills and
// trailing whitespace of a real prefill.
function trimTrailingAssistantText(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  if (!Array.isArray(last.content) || last.content.length === 0) return;
  const block = last.content[last.content.length - 1];
  if (!isObj(block) || block.type !== 'text' || typeof block.text !== 'string') return;
  const trimmed = block.text.replace(/\s+$/, '');
  if (trimmed === '') last.content.pop();
  else if (trimmed.length !== block.text.length) block.text = trimmed;
}

function mapToolChoiceToAnthropic(toolChoice) {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'required') return { type: 'any' };
    if (toolChoice === 'auto') return { type: 'auto' };
    if (toolChoice === 'none') return { type: 'none' };
    return { type: 'auto' };
  }
  if (isObj(toolChoice)) {
    if (toolChoice.type === 'function') return { type: 'tool', name: str(toolChoice.name) };
    if (toolChoice.type === 'custom') return { type: 'tool', name: str(toolChoice.name) };
    // Other object shapes (hosted-tool selectors etc.) are not recognized by
    // Anthropic; downgrade to auto.
    return { type: 'auto' };
  }
  return { type: 'auto' };
}

function responsesRequestToAnthropic(body) {
  const result = {};

  if (typeof body.model === 'string') result.model = body.model;

  // instructions + historical system/developer items → merged system string.
  const systemParts = [];
  if (isMeaningfulText(body.instructions)) systemParts.push(body.instructions.trim());
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isObj(item) && (item.role === 'system' || item.role === 'developer')) {
        systemParts.push(...responsesSystemText(item));
      }
    }
  }
  if (systemParts.length > 0) result.system = systemParts.join('\n\n');

  let messages = [];
  if (Array.isArray(body.input)) {
    messages = convertInputToMessages(body.input);
  } else if (isMeaningfulText(body.input)) {
    messages = [{ role: 'user', content: [{ type: 'text', text: body.input }] }];
  }
  dropIncompleteToolTurns(messages);
  dropEmptyMessages(messages);
  ensureLeadingUserMessage(messages);
  if (messages.length === 0) {
    throw new ConversionError('cannot convert Responses request: empty messages');
  }
  trimTrailingAssistantText(messages);
  dropEmptyMessages(messages);
  if (messages.length === 0) {
    throw new ConversionError('cannot convert Responses request: empty messages');
  }
  result.messages = messages;

  // max_output_tokens → max_tokens (Anthropic requires it; inject a default).
  const maxTokensOpt = u64Opt(body.max_output_tokens);
  const maxTokens = maxTokensOpt != null && maxTokensOpt > 0 ? maxTokensOpt : DEFAULT_MAX_TOKENS;

  const reasoningEffort = isObj(body.reasoning) && typeof body.reasoning.effort === 'string' ? body.reasoning.effort : null;
  let thinkingEnabled = false;
  let thinkingBudget = effortToThinkingBudget(reasoningEffort) ?? 0;
  const explicitlyDisabled = reasoningExplicitlyDisabled(reasoningEffort);

  if (explicitlyDisabled) {
    result.thinking = { type: 'disabled' };
  } else if (thinkingBudget > 0) {
    thinkingEnabled = true;
    // Reserve headroom for the visible answer: cap at half of max_tokens; below
    // Anthropic's 1024 floor, disable thinking and restore normal sampling.
    const ceiling = Math.floor(maxTokens / 2);
    thinkingBudget = Math.min(thinkingBudget, ceiling);
    if (thinkingBudget < 1024) thinkingEnabled = false;
  }
  result.max_tokens = maxTokens;

  if (thinkingEnabled) {
    result.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }
  if (!thinkingEnabled) {
    if ('temperature' in body) result.temperature = body.temperature;
    if ('top_p' in body) result.top_p = body.top_p;
  }

  if ('stream' in body) result.stream = body.stream;

  const anthTools = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isObj(tool)) continue;
      const toolType = str(tool.type);
      if (toolType === 'web_search' || toolType.startsWith('web_search')) {
        throw new ConversionError('Responses hosted WebSearch tools are not supported by the Anthropic bridge');
      }
      if (toolType !== '' && toolType !== 'function') {
        throw new ConversionError('unsupported Responses tool type: ' + toolType);
      }
      const name = typeof tool.name === 'string' ? tool.name.trim() : '';
      if (!name) continue;
      const anthTool = { name };
      if (isMeaningfulText(tool.description)) anthTool.description = tool.description;
      anthTool.input_schema = isObj(tool.parameters) ? tool.parameters : {};
      anthTools.push(anthTool);
    }
  }
  const hasTools = anthTools.length > 0;
  if (hasTools) result.tools = anthTools;

  // Only forward tool_choice when tools survived; Anthropic 400s otherwise.
  if (hasTools && 'tool_choice' in body) {
    const mapped = mapToolChoiceToAnthropic(body.tool_choice);
    const forced = mapped.type === 'any' || mapped.type === 'tool';
    if (thinkingEnabled && forced) {
      // Anthropic rejects forced tools while thinking is enabled; disable thinking.
      result.thinking = { type: 'disabled' };
      thinkingEnabled = false;
      if ('temperature' in body) result.temperature = body.temperature;
      if ('top_p' in body) result.top_p = body.top_p;
    }
    result.tool_choice = mapped;
  }

  if (hasTools && body.parallel_tool_calls === false) {
    if (result.tool_choice == null) result.tool_choice = { type: 'auto' };
    result.tool_choice.disable_parallel_tool_use = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// RESPONSE: Responses → Anthropic (responses_to_anthropic)
// ---------------------------------------------------------------------------

function responsesErrorDetails(data, fallback) {
  const response = isObj(data) && isObj(data.response) ? data.response : data;
  const error = isObj(response) && response.error != null ? response.error : response;
  let message = fallback;
  if (typeof error === 'string' && error.trim() !== '') message = error;
  else if (isObj(error) && typeof error.message === 'string' && error.message.trim() !== '') message = error.message;
  let errorType = 'upstream_error';
  if (isObj(error)) {
    if (typeof error.type === 'string' && error.type) errorType = error.type;
    else if (typeof error.code === 'string' && error.code) errorType = error.code;
  }
  return { message, errorType };
}

// A Responses failure can arrive inside an HTTP 2xx envelope; never mask it.
function validateResponsesTerminalStatus(body) {
  if (body?.status === 'failed' || body?.status === 'cancelled' || (isObj(body) && body.error != null)) {
    const details = responsesErrorDetails(body, 'Responses upstream returned a failed terminal response');
    throw new ConversionError(details.errorType + ': ' + details.message);
  }
}

// Simplified citation rendering (cc-switch ports a ~1100-line markdown lexer here;
// we only collect url_citation annotations and append a "Sources:" footnote block).
function escapeMarkdownLabel(text) {
  const cleaned = String(text)
    .replace(/[\[\]\r\n]+/g, ' ')
    .trim();
  return cleaned || 'source';
}

function escapeMarkdownUrl(url) {
  return String(url)
    .trim()
    .replace(/[<>]/g, '')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\s+/g, '%20');
}

function collectUrlCitations(output) {
  const citations = [];
  const seen = new Set();
  for (const item of output) {
    if (!isObj(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!isObj(block) || block.type !== 'output_text' || !Array.isArray(block.annotations)) continue;
      for (const annotation of block.annotations) {
        if (!isObj(annotation) || annotation.type !== 'url_citation') continue;
        const url = typeof annotation.url === 'string' ? annotation.url.trim() : '';
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const title = isMeaningfulText(annotation.title) ? annotation.title : url;
        citations.push({ title, url });
      }
    }
  }
  return citations;
}

function responsesToAnthropic(body) {
  validateResponsesTerminalStatus(body);

  if (!Array.isArray(body.output)) {
    throw new ConversionError('No output in response');
  }
  const output = body.output;
  const responseCompleted = body.status === 'completed';

  const content = [];
  let hasToolUse = false;
  for (const item of output) {
    const itemType = isObj(item) ? str(item.type) : '';
    if (itemType === 'message') {
      const msgContent = Array.isArray(item.content) ? item.content : [];
      for (const block of msgContent) {
        const blockType = isObj(block) ? str(block.type) : '';
        if (blockType === 'output_text') {
          if (typeof block.text === 'string' && block.text.length > 0) {
            content.push({ type: 'text', text: block.text });
          }
        } else if (blockType === 'refusal') {
          if (typeof block.refusal === 'string' && block.refusal.length > 0) {
            content.push({ type: 'text', text: block.refusal });
          }
        }
      }
    } else if (itemType === 'function_call') {
      const callId = str(item.call_id);
      const name = str(item.name);
      const argsStr = typeof item.arguments === 'string' ? item.arguments : '{}';
      let input;
      if (argsStr.trim() === '') {
        input = {};
      } else {
        try {
          input = JSON.parse(argsStr);
        } catch {
          if (!responseCompleted) {
            // Incomplete call: replace the unparseable partial arguments.
            input = {};
          } else {
            throw new ConversionError("Invalid function_call arguments for '" + name + "'");
          }
        }
      }
      if (!isObj(input)) {
        if (!responseCompleted) input = {};
        else throw new ConversionError("Function call arguments for '" + name + "' must be a JSON object");
      }
      input = sanitizeReadToolInput(name, input);
      content.push({ type: 'tool_use', id: callId, name, input });
      hasToolUse = true;
    } else if (itemType === 'reasoning') {
      const block = anthropicBlockFromOpenaiReasoningItem(item);
      if (block) content.push(block);
    } else if (itemType === 'web_search_call') {
      throw new ConversionError('Responses web_search_call output is not supported by the Anthropic bridge');
    }
    // Unknown output item types are dropped (cc-switch `_ => {}`).
  }

  const citations = collectUrlCitations(output);
  if (citations.length > 0) {
    const links = citations.map((c) => '[' + escapeMarkdownLabel(c.title) + '](' + escapeMarkdownUrl(c.url) + ')');
    content.push({ type: 'text', text: 'Sources: ' + links.join(', ') });
  }

  const stopReason = mapResponsesStopReason(
    typeof body.status === 'string' ? body.status : undefined,
    hasToolUse,
    isObj(body.incomplete_details) ? body.incomplete_details.reason : undefined
  );
  const usage = buildAnthropicUsageFromResponses(isObj(body.usage) ? body.usage : null);

  return {
    id: str(body.id),
    type: 'message',
    role: 'assistant',
    content,
    model: str(body.model),
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

// ---------------------------------------------------------------------------
// RESPONSE: Anthropic → Responses (anthropic_response_to_responses)
// ---------------------------------------------------------------------------

function anthropicResponseToResponses(body) {
  if (isObj(body) && (body.type === 'error' || body.error != null)) {
    const error = body.error != null ? body.error : body;
    let message = 'Anthropic upstream returned an error envelope';
    if (typeof error === 'string' && error.length > 0) message = error;
    else if (isObj(error) && typeof error.message === 'string' && error.message.length > 0) message = error.message;
    const errorType = isObj(error) && typeof error.type === 'string' && error.type ? error.type : 'error';
    throw new ConversionError('Anthropic upstream ' + errorType + ': ' + message);
  }

  const id = str(body?.id);
  const responseId = id === '' ? 'resp_ccswitch' : id.startsWith('resp_') ? id : 'resp_' + id;
  const model = str(body?.model);

  const output = [];
  let textParts = [];
  const flushText = () => {
    if (textParts.length > 0) {
      const idx = output.length;
      output.push({
        id: responseId + '_msg_' + idx,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: textParts,
      });
      textParts = [];
    }
  };

  const blocks = Array.isArray(body?.content) ? body.content : [];
  for (const block of blocks) {
    const blockType = isObj(block) ? str(block.type) : '';
    if (blockType === 'text') {
      if (typeof block.text === 'string') {
        textParts.push({ type: 'output_text', text: block.text, annotations: [] });
      }
    } else if (blockType === 'tool_use') {
      flushText();
      const callId = str(block.id);
      const name = str(block.name);
      const input = sanitizeReadToolInput(name, isObj(block.input) ? block.input : {});
      output.push({
        id: 'fc_' + callId,
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name,
        arguments: canonicalJsonString(input),
      });
    } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      flushText();
      const idx = output.length;
      const item = responsesReasoningItemFromAnthropicBlock('rs_' + responseId + '_' + idx, block);
      if (item) output.push(item);
    }
    // Unknown block types are dropped (cc-switch `_ => {}`).
  }
  flushText();

  const [status, incompleteReason] = mapAnthropicStopReasonToStatus(
    typeof body?.stop_reason === 'string' ? body.stop_reason : null
  );
  const usage = buildResponsesUsageFromAnthropic(isObj(body?.usage) ? body.usage : null);

  const result = {
    id: responseId,
    object: 'response',
    created_at: 0,
    status,
    model,
    output,
    usage,
  };
  if (incompleteReason) result.incomplete_details = { reason: incompleteReason };
  return result;
}

// ---------------------------------------------------------------------------
// Public request/response dispatch
// ---------------------------------------------------------------------------

export function request(from, to, body) {
  const b = isObj(body) ? body : {};
  if (from === 'messages' && to === 'responses') return anthropicToResponses(b);
  if (from === 'responses' && to === 'messages') return responsesRequestToAnthropic(b);
  throw new ConversionError('unsupported conversion pair: ' + from + ' to ' + to);
}

export function response(from, to, body) {
  const b = isObj(body) ? body : {};
  if (from === 'responses' && to === 'messages') return responsesToAnthropic(b);
  if (from === 'messages' && to === 'responses') return anthropicResponseToResponses(b);
  throw new ConversionError('unsupported conversion pair: ' + from + ' to ' + to);
}

// ---------------------------------------------------------------------------
// SSE envelope builders — port of codex_responses_sse.rs (source of truth for
// the exact Responses SSE bytes; both directions emit through these).
// ---------------------------------------------------------------------------

function sseEvent(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

function responseCreated(response) {
  return sseEvent('response.created', { type: 'response.created', response });
}

function responseInProgress(response) {
  return sseEvent('response.in_progress', { type: 'response.in_progress', response });
}

function responseCompleted(response) {
  return sseEvent('response.completed', { type: 'response.completed', response });
}

function responseFailed(response) {
  return sseEvent('response.failed', { type: 'response.failed', response });
}

function outputItemAdded(outputIndex, item) {
  return sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item });
}

function outputItemDone(outputIndex, item) {
  return sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
}

function messageItemAdded(outputIndex, itemId) {
  return outputItemAdded(outputIndex, {
    id: itemId,
    type: 'message',
    status: 'in_progress',
    role: 'assistant',
    content: [],
  });
}

function messageContentPartAdded(outputIndex, itemId) {
  return sseEvent('response.content_part.added', {
    type: 'response.content_part.added',
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
}

function outputTextDelta(outputIndex, itemId, delta) {
  return sseEvent('response.output_text.delta', {
    type: 'response.output_text.delta',
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    delta,
  });
}

function messageItem(itemId, text) {
  return {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

// output_text.done → content_part.done → output_item.done
function messageClose(outputIndex, itemId, text) {
  const item = messageItem(itemId, text);
  const events =
    sseEvent('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text,
    }) +
    sseEvent('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    }) +
    outputItemDone(outputIndex, item);
  return { events, item };
}

function reasoningItemAdded(outputIndex, itemId) {
  return outputItemAdded(outputIndex, {
    id: itemId,
    type: 'reasoning',
    status: 'in_progress',
    summary: [],
  });
}

function reasoningSummaryPartAdded(outputIndex, itemId) {
  return sseEvent('response.reasoning_summary_part.added', {
    type: 'response.reasoning_summary_part.added',
    item_id: itemId,
    output_index: outputIndex,
    summary_index: 0,
    part: { type: 'summary_text', text: '' },
  });
}

function reasoningSummaryTextDelta(outputIndex, itemId, delta) {
  return sseEvent('response.reasoning_summary_text.delta', {
    type: 'response.reasoning_summary_text.delta',
    item_id: itemId,
    output_index: outputIndex,
    summary_index: 0,
    delta,
  });
}

// Completed reasoning item intentionally carries no `status` field.
function reasoningItem(itemId, text) {
  return {
    id: itemId,
    type: 'reasoning',
    summary: [{ type: 'summary_text', text }],
  };
}

function reasoningCloseWithItem(outputIndex, itemId, text, item, hasVisibleSummary) {
  let events = '';
  if (hasVisibleSummary) {
    events +=
      sseEvent('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        text,
      }) +
      sseEvent('response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done',
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text },
      });
  }
  events += outputItemDone(outputIndex, item);
  return events;
}

function functionCallArgumentsDelta(outputIndex, itemId, delta) {
  return sseEvent('response.function_call_arguments.delta', {
    type: 'response.function_call_arguments.delta',
    item_id: itemId,
    output_index: outputIndex,
    delta,
  });
}

function functionCallArgumentsDone(outputIndex, itemId, args) {
  return sseEvent('response.function_call_arguments.done', {
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    output_index: outputIndex,
    arguments: args,
  });
}

function functionCallItem(itemId, status, callId, name, args) {
  return {
    id: itemId,
    type: 'function_call',
    status,
    call_id: callId,
    name,
    arguments: args,
  };
}

// --- Anthropic-side SSE framing ---------------------------------------------

function anthropicSse(eventName, payload) {
  return 'event: ' + eventName + '\ndata: ' + JSON.stringify(payload) + '\n\n';
}

function anthropicErrorSse(message, errorType) {
  return anthropicSse('error', { type: 'error', error: { type: errorType, message } });
}

// ---------------------------------------------------------------------------
// SSE: Responses upstream → Anthropic (create_anthropic_sse_stream_from_responses,
// simplified — no citation buffering, message_start deferred to first content).
// ---------------------------------------------------------------------------

function createResponsesToMessagesSse() {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let terminated = false;
  let messageId = '';
  let currentModel = '';
  let hasSentMessageStart = false;
  let hasToolUse = false;
  let nextContentIndex = 0;
  let currentTextIndex = null;
  const openIndices = new Set();
  const kindByIndex = new Map(); // index → 'text' | 'tool' | 'reasoning'
  const toolIndexByItemId = new Map();
  const toolNameByIndex = new Map();
  const toolArgsByIndex = new Map();
  const toolHadDelta = new Set();
  let lastToolIndex = null;
  const reasoningIndexByItemId = new Map();
  const reasoningItemByIndex = new Map();
  const reasoningTextByIndex = new Map();
  let legacyReasoningIndex = null;
  let hasSubstantiveOutput = false;

  const ensureMessageStart = () => {
    if (hasSentMessageStart) return '';
    hasSentMessageStart = true;
    return anthropicSse('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: currentModel,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const closeCurrentText = () => {
    if (currentTextIndex == null) return '';
    const index = currentTextIndex;
    currentTextIndex = null;
    if (!openIndices.delete(index)) return '';
    kindByIndex.delete(index);
    return anthropicSse('content_block_stop', { type: 'content_block_stop', index });
  };

  const closeOpenBlock = (index) => {
    if (!openIndices.delete(index)) return '';
    kindByIndex.delete(index);
    return anthropicSse('content_block_stop', { type: 'content_block_stop', index });
  };

  const closeAllOpenBlocks = () => {
    let out = '';
    const remaining = [...openIndices].sort((a, b) => a - b);
    for (const index of remaining) out += closeOpenBlock(index);
    return out;
  };

  const handleBlock = (block) => {
    const { event, dataText, data, parsed } = parseEventBlock(block);
    if (!parsed || !isObj(data)) return '';
    if (isDoneData(dataText)) return '';
    if (terminated) return '';
    // Official streams use both a named SSE event and `type` in the payload;
    // parseEventBlock already prefers the header and falls back to the payload.
    const eventName = event ?? '';
    return handleEvent(eventName, data);
  };

  const handleEvent = (eventName, data) => {
    const responseObj = isObj(data.response) ? data.response : null;

    if (eventName === 'response.created') {
      // Capture id/model; message_start is deferred until first substantive content.
      const resp = responseObj ?? data;
      if (typeof resp.id === 'string') messageId = resp.id;
      if (typeof resp.model === 'string') currentModel = resp.model;
      return '';
    }

    if (eventName === 'response.in_progress') {
      return '';
    }

    if (eventName === 'response.content_part.added') {
      const part = isObj(data.part) ? data.part : null;
      const partType = str(part?.type);
      if (partType !== 'output_text' && partType !== 'refusal') return '';
      let out = ensureMessageStart();
      if (currentTextIndex == null) {
        currentTextIndex = nextContentIndex;
        nextContentIndex += 1;
      }
      const index = currentTextIndex;
      if (!openIndices.has(index)) {
        out += anthropicSse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        });
        openIndices.add(index);
        kindByIndex.set(index, 'text');
      }
      return out;
    }

    if (eventName === 'response.output_text.delta' || eventName === 'response.refusal.delta') {
      const delta = typeof data.delta === 'string' ? data.delta : null;
      if (delta == null) return '';
      hasSubstantiveOutput = true;
      let out = ensureMessageStart();
      if (currentTextIndex == null) {
        currentTextIndex = nextContentIndex;
        nextContentIndex += 1;
      }
      const index = currentTextIndex;
      if (!openIndices.has(index)) {
        out += anthropicSse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        });
        openIndices.add(index);
        kindByIndex.set(index, 'text');
      }
      out += anthropicSse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: delta },
      });
      return out;
    }

    if (eventName === 'response.output_item.added') {
      const item = isObj(data.item) ? data.item : null;
      if (!item) return '';
      const itemType = str(item.type);
      if (itemType === 'function_call') {
        hasToolUse = true;
        hasSubstantiveOutput = true;
        let out = closeCurrentText();
        out += ensureMessageStart();
        const itemId = str(item.id) || str(data.item_id) || null;
        let index;
        if (itemId != null && toolIndexByItemId.has(itemId)) {
          index = toolIndexByItemId.get(itemId);
        } else {
          index = nextContentIndex;
          nextContentIndex += 1;
        }
        if (itemId != null) toolIndexByItemId.set(itemId, index);
        toolNameByIndex.set(index, str(item.name));
        lastToolIndex = index;
        if (openIndices.has(index)) return out;
        toolArgsByIndex.set(index, '');
        openIndices.add(index);
        kindByIndex.set(index, 'tool');
        out += anthropicSse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: str(item.call_id), name: str(item.name) },
        });
        return out;
      }
      if (itemType === 'reasoning') {
        let out = ensureMessageStart();
        const itemId = str(item.id) || str(data.item_id) || null;
        let index;
        if (itemId != null && reasoningIndexByItemId.has(itemId)) {
          index = reasoningIndexByItemId.get(itemId);
        } else {
          index = nextContentIndex;
          nextContentIndex += 1;
        }
        if (itemId != null) reasoningIndexByItemId.set(itemId, index);
        reasoningItemByIndex.set(index, item);
        if (!reasoningTextByIndex.has(index)) reasoningTextByIndex.set(index, '');
        kindByIndex.set(index, 'reasoning');
        return out;
      }
      return '';
    }

    if (eventName === 'response.function_call_arguments.delta') {
      const delta = typeof data.delta === 'string' ? data.delta : null;
      if (delta == null) return '';
      hasToolUse = true;
      hasSubstantiveOutput = true;
      const itemId = str(data.item_id) || null;
      let index;
      if (itemId != null && toolIndexByItemId.has(itemId)) {
        index = toolIndexByItemId.get(itemId);
      } else if (lastToolIndex != null) {
        index = lastToolIndex;
      } else {
        index = nextContentIndex;
        nextContentIndex += 1;
      }
      if (itemId != null) toolIndexByItemId.set(itemId, index);
      if (typeof data.name === 'string') toolNameByIndex.set(index, data.name);
      else if (!toolNameByIndex.has(index)) toolNameByIndex.set(index, '');
      lastToolIndex = index;

      let out = '';
      if (!openIndices.has(index)) {
        out += anthropicSse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: str(data.call_id) || str(itemId), name: str(data.name) },
        });
        openIndices.add(index);
        kindByIndex.set(index, 'tool');
      }
      toolArgsByIndex.set(index, (toolArgsByIndex.get(index) ?? '') + delta);
      toolHadDelta.add(index);
      // Read-tool arguments are sanitized and flushed at done time.
      if (toolNameByIndex.get(index) === 'Read') return out;
      out += anthropicSse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: delta },
      });
      return out;
    }

    if (eventName === 'response.function_call_arguments.done') {
      hasToolUse = true;
      const itemId = str(data.item_id) || null;
      let index = null;
      if (itemId != null && toolIndexByItemId.has(itemId)) index = toolIndexByItemId.get(itemId);
      else if (lastToolIndex != null) index = lastToolIndex;
      if (index == null) return '';
      if (!openIndices.has(index)) return '';
      openIndices.delete(index);
      kindByIndex.delete(index);
      const name = toolNameByIndex.get(index) ?? '';
      let out = '';
      if (name === 'Read') {
        const raw =
          (typeof data.arguments === 'string' && data.arguments) ||
          (isObj(data.item) && typeof data.item.arguments === 'string' && data.item.arguments) ||
          toolArgsByIndex.get(index) ||
          '';
        const sanitized = sanitizeReadToolInputJson('Read', raw);
        if (sanitized) {
          out += anthropicSse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: sanitized },
          });
        }
      } else if (!toolHadDelta.has(index)) {
        // Compatible gateways may skip deltas and only send complete arguments here.
        const args =
          (typeof data.arguments === 'string' && data.arguments) ||
          (isObj(data.item) && typeof data.item.arguments === 'string' && data.item.arguments) ||
          '';
        if (args) {
          out += anthropicSse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: args },
          });
        }
      }
      out += anthropicSse('content_block_stop', { type: 'content_block_stop', index });
      if (itemId != null) toolIndexByItemId.delete(itemId);
      toolNameByIndex.delete(index);
      toolArgsByIndex.delete(index);
      toolHadDelta.delete(index);
      return out;
    }

    if (
      eventName === 'response.reasoning_summary_text.delta' ||
      eventName === 'response.reasoning_text.delta' ||
      eventName === 'response.reasoning.delta'
    ) {
      const delta = typeof data.delta === 'string' ? data.delta : typeof data.text === 'string' ? data.text : null;
      if (delta == null) return '';
      hasSubstantiveOutput = true;
      let out = closeCurrentText();
      out += ensureMessageStart();
      const itemId = str(data.item_id) || null;
      let index;
      if (itemId != null && reasoningIndexByItemId.has(itemId)) {
        index = reasoningIndexByItemId.get(itemId);
      } else if (itemId == null && legacyReasoningIndex != null) {
        index = legacyReasoningIndex;
      } else {
        index = nextContentIndex;
        nextContentIndex += 1;
        if (itemId != null) reasoningIndexByItemId.set(itemId, index);
        else legacyReasoningIndex = index;
      }
      if (!openIndices.has(index)) {
        out += anthropicSse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '' },
        });
        openIndices.add(index);
        kindByIndex.set(index, 'reasoning');
      }
      reasoningTextByIndex.set(index, (reasoningTextByIndex.get(index) ?? '') + delta);
      out += anthropicSse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: delta },
      });
      return out;
    }

    if (eventName === 'response.reasoning_summary_text.done' || eventName === 'response.reasoning_text.done') {
      const itemId = str(data.item_id) || null;
      let index = null;
      if (itemId != null && reasoningIndexByItemId.has(itemId)) index = reasoningIndexByItemId.get(itemId);
      else if (itemId == null && legacyReasoningIndex != null) index = legacyReasoningIndex;
      if (index == null) return '';
      const emitted = reasoningTextByIndex.get(index) ?? '';
      if (emitted.length > 0) return '';
      const text = typeof data.text === 'string' ? data.text : '';
      if (text === '') return '';
      let out = '';
      if (!openIndices.has(index)) {
        out += anthropicSse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '' },
        });
        openIndices.add(index);
        kindByIndex.set(index, 'reasoning');
      }
      reasoningTextByIndex.set(index, (reasoningTextByIndex.get(index) ?? '') + text);
      out += anthropicSse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: text },
      });
      return out;
    }

    if (eventName === 'response.output_item.done') {
      const item = isObj(data.item) ? data.item : null;
      if (!item) return '';
      const itemType = str(item.type);
      if (itemType === 'function_call') {
        hasToolUse = true;
        const itemId = str(item.id) || str(data.item_id) || null;
        let index = null;
        if (itemId != null && toolIndexByItemId.has(itemId)) index = toolIndexByItemId.get(itemId);
        else if (lastToolIndex != null) index = lastToolIndex;
        if (index == null || !openIndices.has(index)) return '';
        const name = toolNameByIndex.get(index) ?? '';
        if (!toolHadDelta.has(index) || name === 'Read') {
          const raw =
            (typeof item.arguments === 'string' && item.arguments) ||
            toolArgsByIndex.get(index) ||
            '';
          const args = name === 'Read' ? sanitizeReadToolInputJson(name, raw) : raw;
          if (args) {
            return (
              anthropicSse('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: args },
              }) + closeOpenBlock(index)
            );
          }
        }
        return closeOpenBlock(index);
      }
      if (itemType === 'reasoning') {
        const itemId = str(item.id) || str(data.item_id) || null;
        let index;
        if (itemId != null && reasoningIndexByItemId.has(itemId)) {
          index = reasoningIndexByItemId.get(itemId);
        } else {
          index = nextContentIndex;
          nextContentIndex += 1;
        }
        const finalItem = reasoningItemByIndex.get(index) ?? item;
        reasoningItemByIndex.set(index, finalItem);
        let out = '';
        const fullText = reasoningSummaryText(finalItem);
        const emitted = reasoningTextByIndex.get(index) ?? '';
        if (emitted.length === 0 && fullText.length > 0) {
          if (!openIndices.has(index)) {
            out += anthropicSse('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'thinking', thinking: '' },
            });
            openIndices.add(index);
            kindByIndex.set(index, 'reasoning');
          }
          reasoningTextByIndex.set(index, (reasoningTextByIndex.get(index) ?? '') + fullText);
          out += anthropicSse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: fullText },
          });
        }
        const encrypted = typeof finalItem.encrypted_content === 'string' && finalItem.encrypted_content.length > 0;
        if (encrypted) {
          const envelope = encodeOpenaiReasoningItem(finalItem);
          if (envelope) {
            if (openIndices.has(index)) {
              out += anthropicSse('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'signature_delta', signature: envelope },
              });
            } else {
              out += anthropicSse('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'redacted_thinking', data: envelope },
              });
              openIndices.add(index);
              kindByIndex.set(index, 'reasoning');
            }
          }
        }
        out += closeOpenBlock(index);
        if (itemId != null) reasoningIndexByItemId.delete(itemId);
        reasoningItemByIndex.delete(index);
        reasoningTextByIndex.delete(index);
        return out;
      }
      return '';
    }

    if (eventName === 'response.content_part.done' || eventName === 'response.output_text.done') {
      return closeCurrentText();
    }

    if (eventName === 'response.refusal.done') {
      return closeCurrentText();
    }

    if (eventName === 'response.completed' || eventName === 'response.incomplete') {
      const resp = responseObj ?? data;
      if (
        resp.status === 'failed' ||
        resp.status === 'cancelled' ||
        (isObj(resp) && resp.error != null)
      ) {
        const details = responsesErrorDetails(data, 'Responses upstream returned a failed terminal response');
        terminated = true;
        return anthropicErrorSse(details.message, details.errorType);
      }
      let out = '';
      if (!hasSentMessageStart) {
        if (typeof resp.id === 'string') messageId = resp.id;
        if (typeof resp.model === 'string') currentModel = resp.model;
        out += ensureMessageStart();
      }
      const terminalStatus =
        typeof resp.status === 'string'
          ? resp.status
          : eventName === 'response.incomplete'
            ? 'incomplete'
            : 'completed';
      const stopReason = mapResponsesStopReason(
        terminalStatus,
        hasToolUse,
        isObj(resp.incomplete_details) ? resp.incomplete_details.reason : undefined
      );
      out += closeAllOpenBlocks();
      const usage = buildAnthropicUsageFromResponses(isObj(resp.usage) ? resp.usage : {});
      out += anthropicSse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage,
      });
      out += anthropicSse('message_stop', { type: 'message_stop' });
      terminated = true;
      return out;
    }

    if (eventName === 'response.failed' || eventName === 'error') {
      const details = responsesErrorDetails(
        data,
        eventName === 'response.failed'
          ? 'Responses upstream reported response.failed'
          : 'Responses upstream emitted an error event'
      );
      terminated = true;
      return anthropicErrorSse(details.message, details.errorType);
    }

    return '';
  };

  const processEnd = () => {
    if (terminated) return '';
    const hasOpenTool = [...openIndices].some((index) => kindByIndex.get(index) === 'tool');
    const hasOpenReasoning = [...openIndices].some((index) => kindByIndex.get(index) === 'reasoning');
    if (hasSubstantiveOutput && !hasOpenTool && !hasOpenReasoning) {
      // Text-only partial output is safe to expose as a max-token style incomplete turn.
      let out = closeAllOpenBlocks();
      out += ensureMessageStart();
      out += anthropicSse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens', stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      out += anthropicSse('message_stop', { type: 'message_stop' });
      terminated = true;
      return out;
    }
    // A truncated tool/reasoning block cannot be safely finalized — never fake success.
    terminated = true;
    return anthropicErrorSse('Responses upstream stream ended before a terminal event', 'stream_truncated');
  };

  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      buf += text;
      let out = '';
      let block;
      while ((block = takeSseBlock(buf)) !== null) {
        buf = block.rest;
        if (block.block.trim() === '') continue;
        out += handleBlock(block.block);
      }
      return out;
    },
    end() {
      buf += decoder.decode();
      let out = '';
      if (!terminated && buf.trim() !== '') {
        // Tolerate a final event that omitted its trailing blank line.
        out += handleBlock(buf);
        buf = '';
      }
      out += processEnd();
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// SSE: Anthropic upstream → Responses (create_responses_sse_stream_from_anthropic)
// ---------------------------------------------------------------------------

function extractAnthropicSseError(value) {
  const error = isObj(value) && value.error != null ? value.error : value;
  let message;
  if (typeof error === 'string') message = error;
  else if (isObj(error) && typeof error.message === 'string') message = error.message;
  else message = JSON.stringify(error) ?? '';
  let errorType = null;
  if (isObj(error) && typeof error.type === 'string' && error.type) errorType = error.type;
  return [message, errorType];
}

// Shared state machine for both the streaming path and the synthesized
// whole-message path (responses_sse_events_from_anthropic_message).
function createAnthropicToResponsesState() {
  const st = {
    responseStarted: false,
    completed: false,
    responseId: 'resp_ccswitch',
    model: '',
    nextOutputIndex: 0,
    blocks: new Map(),
    outputItems: [],
    anthropicUsage: {},
    stopReason: null,
    streamTruncated: false,
  };

  const responsesUsage = () => {
    if (Object.keys(st.anthropicUsage).length === 0) {
      return { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } };
    }
    return buildResponsesUsageFromAnthropic(st.anthropicUsage);
  };

  const baseResponse = (status, output) => ({
    id: st.responseId,
    object: 'response',
    created_at: 0,
    status,
    model: st.model,
    output,
    usage: responsesUsage(),
  });

  const mergeUsage = (usage) => {
    if (!isObj(usage)) return;
    for (const key of Object.keys(usage)) {
      if (usage[key] === null) continue;
      st.anthropicUsage[key] = usage[key];
    }
  };

  const ensureResponseStarted = () => {
    if (st.responseStarted) return '';
    st.responseStarted = true;
    const response = baseResponse('in_progress', []);
    return responseCreated(response) + responseInProgress(response);
  };

  const handleMessageStart = (data) => {
    const message = data?.message;
    if (isObj(message)) {
      if (typeof message.id === 'string' && message.id) {
        st.responseId = message.id.startsWith('resp_') ? message.id : 'resp_' + message.id;
      }
      if (typeof message.model === 'string' && message.model) st.model = message.model;
      if (isObj(message.usage)) mergeUsage(message.usage);
    }
    return ensureResponseStarted();
  };

  const handleContentBlockStart = (data) => {
    let events = ensureResponseStarted();
    const index = data?.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return events;
    const block = isObj(data.content_block) ? data.content_block : {};
    const blockType = str(block.type);

    if (blockType === 'text') {
      const outputIndex = st.nextOutputIndex;
      st.nextOutputIndex += 1;
      const itemId = st.responseId + '_msg_' + outputIndex;
      events += messageItemAdded(outputIndex, itemId);
      events += messageContentPartAdded(outputIndex, itemId);
      st.blocks.set(index, {
        kind: 'text',
        outputIndex,
        itemId,
        callId: '',
        name: '',
        accum: typeof block.text === 'string' ? block.text : '',
        startInput: '',
        sourceBlock: cloneJson(block) ?? {},
        hasVisibleSummary: false,
        done: false,
      });
    } else if (blockType === 'tool_use') {
      const outputIndex = st.nextOutputIndex;
      st.nextOutputIndex += 1;
      const callId = str(block.id);
      const name = str(block.name);
      // Some gateways carry the full tool input on content_block_start and emit
      // no input_json_delta; capture it as a close-time fallback.
      const startInput = isObj(block.input) && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : '';
      const itemId = 'fc_' + callId;
      const item = functionCallItem(itemId, 'in_progress', callId, name, '');
      events += outputItemAdded(outputIndex, item);
      st.blocks.set(index, {
        kind: 'tool',
        outputIndex,
        itemId,
        callId,
        name,
        accum: '',
        startInput,
        sourceBlock: cloneJson(block) ?? {},
        hasVisibleSummary: false,
        done: false,
      });
    } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      const outputIndex = st.nextOutputIndex;
      st.nextOutputIndex += 1;
      const itemId = 'rs_' + st.responseId + '_' + outputIndex;
      events += reasoningItemAdded(outputIndex, itemId);
      const hasVisibleSummary = blockType === 'thinking';
      if (hasVisibleSummary) events += reasoningSummaryPartAdded(outputIndex, itemId);
      st.blocks.set(index, {
        kind: 'thinking',
        outputIndex,
        itemId,
        callId: '',
        name: '',
        accum: typeof block.thinking === 'string' ? block.thinking : '',
        startInput: '',
        sourceBlock: cloneJson(block) ?? {},
        hasVisibleSummary,
        done: false,
      });
    }
    return events;
  };

  const handleContentBlockDelta = (data) => {
    const index = data?.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return '';
    const block = st.blocks.get(index);
    if (!block) return '';
    const delta = isObj(data.delta) ? data.delta : {};
    const deltaType = str(delta.type);
    if (deltaType === 'text_delta') {
      const text = str(delta.text);
      block.accum += text;
      return outputTextDelta(block.outputIndex, block.itemId, text);
    }
    if (deltaType === 'input_json_delta') {
      const partial = str(delta.partial_json);
      block.accum += partial;
      // The Read tool is sanitized at close time to avoid emitting pages:"" deltas.
      if (block.name === 'Read') return '';
      return functionCallArgumentsDelta(block.outputIndex, block.itemId, partial);
    }
    if (deltaType === 'thinking_delta') {
      const text = str(delta.thinking);
      block.accum += text;
      block.sourceBlock.thinking = block.accum;
      return reasoningSummaryTextDelta(block.outputIndex, block.itemId, text);
    }
    if (deltaType === 'signature_delta') {
      if (typeof delta.signature === 'string') block.sourceBlock.signature = delta.signature;
      return '';
    }
    return '';
  };

  const closeBlock = (index) => {
    const block = st.blocks.get(index);
    if (!block || block.done) return '';
    block.done = true;
    const outputIndex = block.outputIndex;
    const itemId = block.itemId;
    if (block.kind === 'text') {
      const { events, item } = messageClose(outputIndex, itemId, block.accum);
      st.outputItems.push({ outputIndex, item });
      return events;
    }
    if (block.kind === 'tool') {
      // Prefer streamed input_json_delta; fall back to the input carried on the
      // start event when the gateway emitted no deltas.
      const rawInput = block.accum.trim() !== '' ? block.accum : block.startInput;
      let args;
      if (rawInput.trim() === '') args = '{}';
      else if (block.name === 'Read') args = sanitizeReadToolInputJson('Read', rawInput);
      else args = canonicalizeToolArguments(rawInput);
      const item = functionCallItem(
        itemId,
        st.streamTruncated ? 'incomplete' : 'completed',
        block.callId,
        block.name,
        args
      );
      let events = '';
      if (!st.streamTruncated) events += functionCallArgumentsDone(outputIndex, itemId, args);
      events += outputItemDone(outputIndex, item);
      st.outputItems.push({ outputIndex, item });
      return events;
    }
    // thinking
    if (block.sourceBlock.type === 'thinking') block.sourceBlock.thinking = block.accum;
    const item = responsesReasoningItemFromAnthropicBlock(itemId, block.sourceBlock);
    if (!item) return '';
    const events = reasoningCloseWithItem(outputIndex, itemId, block.accum, item, block.hasVisibleSummary);
    st.outputItems.push({ outputIndex, item });
    return events;
  };

  const handleContentBlockStop = (data) => {
    const index = data?.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return '';
    return closeBlock(index);
  };

  const handleMessageDelta = (data) => {
    const reason = data?.delta?.stop_reason;
    if (typeof reason === 'string') st.stopReason = reason;
    if (isObj(data?.usage)) mergeUsage(data.usage);
    return '';
  };

  const sortedOutput = () =>
    st.outputItems
      .slice()
      .sort((a, b) => a.outputIndex - b.outputIndex)
      .map((entry) => entry.item);

  const finalize = () => {
    if (st.completed) return '';
    let events = ensureResponseStarted();
    const open = [...st.blocks.entries()]
      .filter(([, block]) => !block.done)
      .map(([index]) => index)
      .sort((a, b) => a - b);
    for (const index of open) events += closeBlock(index);
    const [status, incompleteReason] = mapAnthropicStopReasonToStatus(st.stopReason);
    const response = baseResponse(status, sortedOutput());
    if (incompleteReason) response.incomplete_details = { reason: incompleteReason };
    events += responseCompleted(response);
    st.completed = true;
    return events;
  };

  const failedEvent = (message, errorType) => {
    if (st.completed) return null;
    st.completed = true;
    const error = { message };
    if (errorType) error.type = errorType;
    const response = baseResponse('failed', sortedOutput());
    response.error = error;
    return responseFailed(response);
  };

  const hasSubstantiveOutput = () =>
    st.outputItems.length > 0 ||
    [...st.blocks.values()].some((block) => block.accum.trim() !== '' || block.callId.trim() !== '' || block.name.trim() !== '');

  return {
    st,
    handleMessageStart,
    handleContentBlockStart,
    handleContentBlockDelta,
    handleContentBlockStop,
    handleMessageDelta,
    finalize,
    failedEvent,
    hasSubstantiveOutput,
    closeBlock,
    ensureResponseStarted,
  };
}

function processAnthropicSseBlock(state, block) {
  if (block.trim() === '') return { events: '', failed: false };
  const { event, data, parsed } = parseEventBlock(block);
  if (!parsed || !isObj(data)) return { events: '', failed: false };
  // Anthropic upstream: payload `type` wins over the header event name.
  const msgType = (typeof data.type === 'string' && data.type) || event || '';
  let events = '';
  let failed = false;
  if (msgType === 'message_start') events = state.handleMessageStart(data);
  else if (msgType === 'content_block_start') events = state.handleContentBlockStart(data);
  else if (msgType === 'content_block_delta') events = state.handleContentBlockDelta(data);
  else if (msgType === 'content_block_stop') events = state.handleContentBlockStop(data);
  else if (msgType === 'message_delta') events = state.handleMessageDelta(data);
  else if (msgType === 'message_stop') events = state.finalize();
  else if (msgType === 'error') {
    const [message, errorType] = extractAnthropicSseError(data);
    const failedPayload = state.failedEvent(message, errorType);
    events = failedPayload ?? '';
    failed = true;
  }
  return { events, failed };
}

// Convert a complete non-streaming Anthropic message (or error envelope) into
// the same Responses SSE lifecycle for gateways that ignored stream:true.
function responsesSseEventsFromAnthropicMessage(body) {
  const state = createAnthropicToResponsesState();
  if (!isObj(body)) {
    return state.failedEvent('upstream returned a non-object Anthropic message body', 'invalid_response') ?? '';
  }
  if (body.type === 'error' || body.error != null) {
    const [message, errorType] = extractAnthropicSseError(body);
    return state.failedEvent(message, errorType) ?? '';
  }
  let events = state.handleMessageStart({ type: 'message_start', message: { ...body, content: [] } });
  const content = Array.isArray(body.content) ? body.content : [];
  content.forEach((block, index) => {
    const blockType = isObj(block) ? str(block.type) : '';
    const startBlock = isObj(block) ? { ...block } : {};
    if (blockType === 'text') startBlock.text = '';
    if (blockType === 'thinking') startBlock.thinking = '';
    events += state.handleContentBlockStart({ type: 'content_block_start', index, content_block: startBlock });
    if (blockType === 'text' && typeof block.text === 'string') {
      events += state.handleContentBlockDelta({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else if (blockType === 'thinking' && typeof block.thinking === 'string') {
      events += state.handleContentBlockDelta({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
    }
    events += state.handleContentBlockStop({ type: 'content_block_stop', index });
  });
  events += state.handleMessageDelta({
    type: 'message_delta',
    delta: { stop_reason: typeof body.stop_reason === 'string' ? body.stop_reason : null },
  });
  events += state.finalize();
  return events;
}

function looksLikeJsonDocument(input) {
  const trimmed = input.replace(/^[\s\uFEFF]+/, '');
  const first = trimmed.charAt(0);
  return first === '{' || first === '[' ? trimmed : null;
}

function createMessagesToResponsesSse() {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let jsonMode = false;
  let failed = false;
  const state = createAnthropicToResponsesState();

  return {
    push(chunk) {
      if (failed || state.st.completed) return '';
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      buf += text;
      if (!jsonMode && looksLikeJsonDocument(buf) != null) {
        // A gateway ignored stream:true and is returning one JSON document; hold
        // the body intact until EOF instead of parsing it as SSE blocks.
        jsonMode = true;
      }
      if (jsonMode) return '';
      let out = '';
      let block;
      while ((block = takeSseBlock(buf)) !== null) {
        buf = block.rest;
        const result = processAnthropicSseBlock(state, block.block);
        out += result.events;
        if (result.failed) {
          failed = true;
          break;
        }
      }
      return out;
    },
    end() {
      if (failed || state.st.completed) return '';
      buf += decoder.decode();
      let out = '';
      if (buf.trim() !== '') {
        if (!state.st.responseStarted) {
          const candidate = looksLikeJsonDocument(buf);
          if (candidate != null) {
            try {
              const body = JSON.parse(candidate);
              out += responsesSseEventsFromAnthropicMessage(body);
              state.st.completed = true;
            } catch {
              // Fall through: treat as a (unparseable) final SSE block.
            }
          }
        }
        if (!state.st.completed) {
          const result = processAnthropicSseBlock(state, buf);
          out += result.events;
          if (result.failed) failed = true;
          buf = '';
        }
      }
      if (!failed && !state.st.completed) {
        if (state.st.stopReason !== null) {
          // message_delta arrived but message_stop did not: semantically complete.
          out += state.finalize();
        } else if (state.hasSubstantiveOutput()) {
          // Truncated mid-stream: report incomplete so the partial output is not
          // mistaken for a normal completion.
          state.st.stopReason = 'max_tokens';
          state.st.streamTruncated = true;
          out += state.finalize();
        } else {
          const event = state.failedEvent('Upstream Anthropic stream ended before message_stop', 'stream_truncated');
          if (event) out += event;
        }
      }
      return out;
    },
  };
}

export function createSse(from, to) {
  if (from === 'responses' && to === 'messages') return createResponsesToMessagesSse();
  if (from === 'messages' && to === 'responses') return createMessagesToResponsesSse();
  throw new ConversionError('unsupported conversion pair: ' + from + ' to ' + to);
}
