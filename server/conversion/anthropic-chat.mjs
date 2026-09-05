// Ported from cc-switch (MIT, (c) 2025 Jason Young) — src-tauri/src/proxy/providers/transform.rs + streaming.rs
// (tool-output media handling from src-tauri/src/proxy/tool_media.rs).
//
// Mirror-pair converter: Anthropic /v1/messages  <->  OpenAI /v1/chat/completions.
//
// Export surface (called from ./index.mjs):
//   request(from, to, body)    from/to in {'messages','chat'}; 'messages'->'chat' ports
//                              anthropic_to_openai_with_reasoning_content, 'chat'->'messages' is the
//                              derived inverse (cc-switch has no direct adapter). Throws ConversionError.
//   response(from, to, body)   converts the UPSTREAM response body into the local client format:
//                              'chat'->'messages' ports openai_to_anthropic; 'messages'->'chat' inverse.
//   createSse(from, to)        { push(chunk) -> string, end() -> string }; from = upstream wire format,
//                              to = local client format. 'chat'->'messages' ports create_anthropic_sse_stream;
//                              'messages'->'chat' is the derived inverse.

import { ConversionError } from './errors.mjs';
import {
  takeSseBlock,
  parseEventBlock,
  isDoneData,
  createUtf8Buffer,
  canonicalJsonString,
} from './sse-common.mjs';

// ---------------------------------------------------------------------------
// Shared small helpers (local to this pair)
// ---------------------------------------------------------------------------

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function asCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// transform.rs: strip_leading_anthropic_billing_header (first line only)
// ---------------------------------------------------------------------------

const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';

function stripLeadingAnthropicBillingHeader(text) {
  if (!text.startsWith(BILLING_HEADER_PREFIX)) return text;
  const lineEnd = text.search(/[\n\r]/);
  if (lineEnd < 0) return '';
  let restStart = lineEnd + 1;
  if (text[lineEnd] === '\r' && text[lineEnd + 1] === '\n') restStart += 1;
  const rest = text.slice(restStart);
  if (rest.startsWith('\r\n')) return rest.slice(2);
  if (rest.startsWith('\n')) return rest.slice(1);
  if (rest.startsWith('\r')) return rest.slice(1);
  return rest;
}

// ---------------------------------------------------------------------------
// transform.rs: is_openai_o_series — o1/o3/o4-mini/... need max_completion_tokens
// ---------------------------------------------------------------------------

function isOpenAioSeries(model) {
  return (
    typeof model === 'string' &&
    model.length > 1 &&
    model[0] === 'o' &&
    model.charCodeAt(1) >= 48 &&
    model.charCodeAt(1) <= 57
  );
}

// claude.rs REASONING_VENDOR_HINTS — providers that accept the non-standard
// `reasoning_content` field on assistant tool-call messages.
function isReasoningVendorModel(model) {
  return /deepseek|mimo|xiaomimimo/.test(String(model ?? '').toLowerCase());
}

// ---------------------------------------------------------------------------
// transform.rs: clean_schema — root defaults to {type:'object'}, drop format:'uri'
// ---------------------------------------------------------------------------

function cleanSchemaInner(schema, isRoot) {
  if (!isPlainObject(schema)) return schema;
  const out = { ...schema };
  const missingType = isRoot && !('type' in out);
  if (missingType) out.type = 'object';
  if (missingType && !('properties' in out)) out.properties = {};
  if (out.format === 'uri') delete out.format;
  if (isPlainObject(out.properties)) {
    const props = {};
    for (const [k, v] of Object.entries(out.properties)) props[k] = cleanSchemaInner(v, false);
    out.properties = props;
  }
  if ('items' in out) out.items = cleanSchemaInner(out.items, false);
  return out;
}

function cleanSchema(schema) {
  return cleanSchemaInner(isPlainObject(schema) ? schema : {}, true);
}

// ---------------------------------------------------------------------------
// transform.rs: map_tool_choice_to_chat (+ derived inverse)
// ---------------------------------------------------------------------------

function mapToolChoiceToChat(toolChoice) {
  if (typeof toolChoice === 'string') return toolChoice === 'any' ? 'required' : toolChoice;
  if (isPlainObject(toolChoice)) {
    switch (toolChoice.type) {
      case 'any':
        return 'required';
      case 'auto':
        return 'auto';
      case 'none':
        return 'none';
      case 'tool':
        return { type: 'function', function: { name: typeof toolChoice.name === 'string' ? toolChoice.name : '' } };
      default:
        return toolChoice;
    }
  }
  return toolChoice;
}

function mapToolChoiceToAnthropic(toolChoice) {
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice === 'auto' || toolChoice === 'none') return { type: toolChoice };
  if (isPlainObject(toolChoice) && toolChoice.type === 'function') {
    const name = isPlainObject(toolChoice.function) && typeof toolChoice.function.name === 'string'
      ? toolChoice.function.name
      : '';
    return { type: 'tool', name };
  }
  return toolChoice;
}

// ---------------------------------------------------------------------------
// stop-reason tables (transform.rs openai_to_anthropic + streaming.rs map_stop_reason)
// ---------------------------------------------------------------------------

function mapFinishReasonToStopReason(finishReason) {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

function mapStopReasonToFinishReason(stopReason) {
  switch (stopReason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'stop_sequence':
      return 'stop';
    default:
      return 'stop';
  }
}

// ---------------------------------------------------------------------------
// tool_media.rs (subset): recognize image media, pull it out of tool outputs.
// Chat tool messages are text-only, so extracted media is re-emitted in a
// synthetic following user message.
// ---------------------------------------------------------------------------

const WHOLE_DATA_URL_MIN_BYTES = 8 * 1024;
const BASE64ISH_MIN_BYTES = 16 * 1024;
const MAX_MEDIA_TRAVERSAL_DEPTH = 32;
const TOOL_RESULT_MEDIA_MOVED_MARKER = '[cc-switch: tool result media moved to the following user message]';
const TOOL_RESULT_MEDIA_REPLACEMENT_BLOCK = { type: 'text', text: TOOL_RESULT_MEDIA_MOVED_MARKER };

function isImageMimeType(v) {
  return typeof v === 'string' && v.slice(0, 6).toLowerCase() === 'image/';
}

function isImageBase64DataUrl(v) {
  const commaIndex = v.indexOf(',');
  if (commaIndex < 0) return false;
  const header = v.slice(0, commaIndex).toLowerCase();
  return header.startsWith('data:image/') && header.endsWith(';base64');
}

function looksLikeBase64Payload(v) {
  if (v.length < BASE64ISH_MIN_BYTES) return false;
  return /^[A-Za-z0-9+/=]+$/.test(v);
}

function clampBase64ishStrings(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const shouldOmit =
      (trimmed.length >= WHOLE_DATA_URL_MIN_BYTES && trimmed.slice(0, 5).toLowerCase() === 'data:') ||
      looksLikeBase64Payload(trimmed);
    return shouldOmit ? '[cc-switch: omitted ' + value.length + ' bytes]' : value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = clampBase64ishStrings(value[i]);
    return value;
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) value[k] = clampBase64ishStrings(value[k]);
    return value;
  }
  return value;
}

function wholeStringImageDataUrl(value) {
  const trimmed = value.trim();
  if (trimmed.length < WHOLE_DATA_URL_MIN_BYTES || !isImageBase64DataUrl(trimmed)) return null;
  return { type: 'image_url', image_url: { url: trimmed } };
}

function sourceMediaTypeIsImage(source) {
  const v = source.media_type ?? source.mime_type ?? source.mimeType;
  return v === undefined || v === null || isImageMimeType(v);
}

function mergeTopLevelDetail(part, imageUrl) {
  if (imageUrl.detail === undefined && isPlainObject(part) && part.detail !== undefined) {
    imageUrl.detail = part.detail;
  }
  return imageUrl;
}

// Anthropic typed image block ({type:'image', source:{type:'base64'|'url',...}}) -> chat image part.
function typedImageChatUrl(part) {
  if (!isPlainObject(part)) return null;
  const source = asObject(part.source);
  if (source && sourceMediaTypeIsImage(source)) {
    if (typeof source.url === 'string' && source.url.trim() !== '') {
      return { type: 'image_url', image_url: mergeTopLevelDetail(part, { url: source.url }) };
    }
    if (typeof source.data === 'string' && source.data !== '') {
      const mediaType = source.media_type ?? source.mime_type ?? source.mimeType ?? 'image/png';
      const url =
        source.data.slice(0, 11).toLowerCase() === 'data:image/'
          ? source.data
          : 'data:' + mediaType + ';base64,' + source.data;
      return { type: 'image_url', image_url: mergeTopLevelDetail(part, { url }) };
    }
  }
  const data = typeof part.data === 'string' ? part.data : '';
  if (data === '') return null;
  const mediaType = part.mimeType ?? part.mime_type;
  if (!isImageMimeType(mediaType)) return null;
  return { type: 'image_url', image_url: mergeTopLevelDetail(part, { url: 'data:' + mediaType + ';base64,' + data }) };
}

// Chat-style image part ({type:'image_url'|'input_image', image_url: string|{url}}).
function normalizedImageChatUrl(part) {
  const iu = part.image_url;
  let obj = null;
  if (typeof iu === 'string' && iu.trim() !== '') obj = { url: iu };
  else if (isPlainObject(iu) && typeof iu.url === 'string' && iu.url.trim() !== '') obj = { ...iu };
  if (!obj) return null;
  return mergeTopLevelDetail(part, obj);
}

// One recognized media block -> chat image content part (cc-switch
// chat_media_part_from_tool_part, image scope only for this pair).
function chatMediaPartFromToolPart(part) {
  if (!isPlainObject(part)) return null;
  const t = part.type;
  if (t === 'image_url' || t === 'input_image') {
    const normalized = normalizedImageChatUrl(part);
    return normalized ? { type: 'image_url', image_url: normalized } : null;
  }
  if (t === 'image') {
    return typedImageChatUrl(part);
  }
  if (t === undefined) {
    // loose {image_url: 'data:...'} without a type discriminator
    const normalized = normalizedImageChatUrl(part);
    if (normalized && typeof normalized.url === 'string' && normalized.url.slice(0, 5).toLowerCase() === 'data:') {
      return { type: 'image_url', image_url: normalized };
    }
  }
  return null;
}

// Returns [replacedCount, newValue]; newValue === value when nothing replaced.
// Strings that parse as JSON are transformed as a tree and canonicalized back
// (cc-switch strip_media_from_tool_value_at_depth).
function stripMediaFromToolValue(value, mediaParts, depth) {
  if (depth > MAX_MEDIA_TRAVERSAL_DEPTH) return [0, value];
  if (typeof value === 'string') {
    const whole = wholeStringImageDataUrl(value);
    if (whole) {
      mediaParts.push(whole);
      return [1, TOOL_RESULT_MEDIA_MOVED_MARKER];
    }
    const trimmed = value.trim();
    if (trimmed === '') return [0, value];
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [0, value];
    }
    if (!isPlainObject(parsed) && !Array.isArray(parsed)) return [0, value];
    const [replaced, newValue] = stripMediaFromToolValue(parsed, mediaParts, depth + 1);
    if (replaced > 0) {
      clampBase64ishStrings(newValue);
      return [replaced, canonicalJsonString(newValue)];
    }
    return [0, value];
  }
  if (Array.isArray(value)) {
    let total = 0;
    const out = value.slice();
    for (let i = 0; i < out.length; i++) {
      const [replaced, newValue] = stripMediaFromToolValue(out[i], mediaParts, depth + 1);
      if (replaced > 0) {
        out[i] = newValue;
        total += replaced;
      }
    }
    return total > 0 ? [total, out] : [0, value];
  }
  if (isPlainObject(value)) {
    const mediaPart = chatMediaPartFromToolPart(value);
    if (mediaPart) {
      mediaParts.push(mediaPart);
      return [1, TOOL_RESULT_MEDIA_REPLACEMENT_BLOCK];
    }
    if (value.content !== undefined) {
      const [replaced, newValue] = stripMediaFromToolValue(value.content, mediaParts, depth + 1);
      if (replaced > 0) return [replaced, { ...value, content: newValue }];
    }
    return [0, value];
  }
  return [0, value];
}

// cc-switch plan_chat_tool_output_media: extract media, keep the no-media
// representation byte-identical to the legacy converter (prompt-cache stability).
function planChatToolOutputMedia(output) {
  if (output === null || output === undefined) return null;
  const outputWasString = typeof output === 'string';
  if (!outputWasString && !isPlainObject(output) && !Array.isArray(output)) return null;
  const work = outputWasString ? output : JSON.parse(JSON.stringify(output));
  const mediaParts = [];
  const [replaced, newValue] = stripMediaFromToolValue(work, mediaParts, 0);
  if (replaced === 0) return null;
  clampBase64ishStrings(newValue);
  const toolContent = outputWasString
    ? String(newValue)
    : canonicalJsonString(newValue);
  return { toolContent, mediaParts };
}

function queueChatToolOutputMedia(pendingMedia, callId, mediaParts) {
  if (!mediaParts || mediaParts.length === 0) return;
  pendingMedia.push({ type: 'text', text: '[cc-switch: media output of tool call ' + callId + ']' });
  for (const p of mediaParts) pendingMedia.push(p);
}

function flushPendingChatToolMedia(messages, pendingMedia) {
  if (pendingMedia.length === 0) return;
  messages.push({ role: 'user', content: pendingMedia.splice(0, pendingMedia.length) });
}

// ---------------------------------------------------------------------------
// REQUEST: Anthropic messages -> OpenAI chat (transform.rs
// anthropic_to_openai_with_reasoning_content + claude.rs vendor hint)
// ---------------------------------------------------------------------------

function convertMessageToOpenai(role, content, preserveReasoning) {
  const result = [];

  if (content === undefined || content === null) {
    result.push({ role, content: null });
    return result;
  }
  if (typeof content === 'string') {
    result.push({ role, content });
    return result;
  }

  if (Array.isArray(content)) {
    const contentParts = [];
    const toolCalls = [];
    const pendingToolMedia = [];
    const reasoningParts = [];

    for (const block of content) {
      const blockType = isPlainObject(block) ? String(block.type ?? '') : '';
      switch (blockType) {
        case 'text': {
          if (typeof block.text === 'string') contentParts.push({ type: 'text', text: block.text });
          break;
        }
        case 'image': {
          const imagePart = chatMediaPartFromToolPart(block);
          if (imagePart) contentParts.push(imagePart);
          break;
        }
        case 'tool_use': {
          toolCalls.push({
            id: typeof block.id === 'string' ? block.id : '',
            type: 'function',
            function: {
              name: typeof block.name === 'string' ? block.name : '',
              arguments: canonicalJsonString(block.input ?? {}),
            },
          });
          break;
        }
        case 'tool_result': {
          // tool_result becomes a separate `tool` role message, emitted ahead
          // of this turn's ordinary content.
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          const contentVal = block.content;
          const mediaPlan = contentVal !== undefined && contentVal !== null ? planChatToolOutputMedia(contentVal) : null;
          let contentStr;
          if (mediaPlan) {
            queueChatToolOutputMedia(pendingToolMedia, toolUseId, mediaPlan.mediaParts);
            contentStr = mediaPlan.toolContent;
          } else if (typeof contentVal === 'string') {
            contentStr = contentVal;
          } else if (contentVal === undefined || contentVal === null) {
            contentStr = '';
          } else {
            contentStr = canonicalJsonString(contentVal);
          }
          result.push({ role: 'tool', tool_call_id: toolUseId, content: contentStr });
          break;
        }
        case 'thinking': {
          if (typeof block.thinking === 'string' && block.thinking !== '') reasoningParts.push(block.thinking);
          break;
        }
        case 'redacted_thinking': {
          if (preserveReasoning) reasoningParts.push('[redacted thinking]');
          break;
        }
        default:
          break;
      }
    }

    // Chat tool messages cannot carry images: flush all extracted media as one
    // synthetic user turn before this message's ordinary content.
    flushPendingChatToolMedia(result, pendingToolMedia);

    if (contentParts.length > 0 || toolCalls.length > 0) {
      const msg = { role };
      if (contentParts.length === 0) {
        msg.content = null;
      } else if (contentParts.length === 1 && typeof contentParts[0].text === 'string') {
        // single text block collapses to a plain string
        msg.content = contentParts[0].text;
      } else {
        msg.content = contentParts;
      }
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      if (preserveReasoning && role === 'assistant' && toolCalls.length > 0) {
        msg.reasoning_content = reasoningParts.length > 0 ? reasoningParts.join('\n') : 'tool call';
      }
      result.push(msg);
    }
    return result;
  }

  result.push({ role, content });
  return result;
}

function injectOpenaiStreamIncludeUsage(result) {
  if (result.stream !== true) return;
  if (isPlainObject(result.stream_options)) {
    result.stream_options = { ...result.stream_options, include_usage: true };
  } else {
    result.stream_options = { include_usage: true };
  }
}

function anthropicToChatRequest(body) {
  const result = {};

  if (typeof body.model === 'string') result.model = body.model;

  const messages = [];

  // Top-level system: string or array of text parts merged into ONE leading
  // system message (byte-stable across turns, prompt-cache friendly).
  if (typeof body.system === 'string') {
    const text = stripLeadingAnthropicBillingHeader(body.system);
    if (text !== '') messages.push({ role: 'system', content: text });
  } else if (Array.isArray(body.system)) {
    const parts = [];
    for (const part of body.system) {
      if (!isPlainObject(part) || typeof part.text !== 'string') continue;
      const text = stripLeadingAnthropicBillingHeader(part.text);
      if (text === '') continue;
      parts.push(text);
    }
    if (parts.length > 0) messages.push({ role: 'system', content: parts.join('\n') });
  }

  // Mid-conversation system messages stay IN PLACE (never hoisted or merged).
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of msgs) {
    const role = isPlainObject(msg) && typeof msg.role === 'string' ? msg.role : 'user';
    const content = isPlainObject(msg) ? msg.content : undefined;
    for (const converted of convertMessageToOpenai(role, content, isReasoningVendorModel(body.model))) {
      messages.push(converted);
    }
  }

  result.messages = messages;

  // Params — o-series models require max_completion_tokens.
  if (body.max_tokens !== undefined) {
    if (isOpenAioSeries(body.model)) result.max_completion_tokens = body.max_tokens;
    else result.max_tokens = body.max_tokens;
  }
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop_sequences !== undefined) result.stop = body.stop_sequences;
  if (body.stream !== undefined) result.stream = body.stream;
  if (result.stream === true) injectOpenaiStreamIncludeUsage(result);

  // Tools (filter BatchTool) — cache_control never survives (fresh objects).
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const openaiTools = [];
  for (const t of tools) {
    if (!isPlainObject(t)) continue;
    if (t.type === 'BatchTool' || t.name === 'BatchTool') continue;
    const fn = {
      name: typeof t.name === 'string' ? t.name : '',
      parameters: cleanSchema(isPlainObject(t.input_schema) ? t.input_schema : {}),
    };
    if (t.description !== undefined) fn.description = t.description;
    openaiTools.push({ type: 'function', function: fn });
  }
  if (openaiTools.length > 0) result.tools = openaiTools;

  if (body.tool_choice !== undefined) result.tool_choice = mapToolChoiceToChat(body.tool_choice);

  return result;
}

// ---------------------------------------------------------------------------
// REQUEST: OpenAI chat -> Anthropic messages (derived inverse; system content
// becomes ONE leading {role:'system'} message — legacy text-path parity)
// ---------------------------------------------------------------------------

function systemTextFromChatContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (isPlainObject(p) && typeof p.text === 'string' && p.text !== '') parts.push(p.text);
    }
    return parts.join('\n');
  }
  return '';
}

function imageBlockFromChatUrl(part) {
  const iu = isPlainObject(part) ? part.image_url : undefined;
  const url = typeof iu === 'string' ? iu : isPlainObject(iu) ? iu.url : undefined;
  if (typeof url !== 'string' || url === '') return null;
  if (/^data:/i.test(url)) {
    const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
    if (!m) return null;
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

function toolResultContentFromChat(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const blocks = [];
    for (const p of content) {
      if (!isPlainObject(p)) continue;
      if ((p.type === 'text' || p.type === 'output_text') && typeof p.text === 'string') {
        blocks.push({ type: 'text', text: p.text });
      } else if (p.type === 'image_url') {
        const img = imageBlockFromChatUrl(p);
        if (img) blocks.push(img);
      }
    }
    return blocks;
  }
  if (content === undefined || content === null) return '';
  return canonicalJsonString(content);
}

function chatMessageToAnthropicBlocks(msg) {
  // Returns { role, blocks, plainString } or null for dropped/empty messages.
  // `plainString` is set only when the message collapses to bare string content.
  const role = typeof msg.role === 'string' ? msg.role : 'user';
  const blocks = [];
  let plainString = null;

  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content !== '') {
    blocks.push({ type: 'thinking', thinking: msg.reasoning_content });
  }

  const content = msg.content;
  if (typeof content === 'string') {
    if (content !== '') plainString = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!isPlainObject(part)) continue;
      if ((part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string') {
        if (part.text !== '') blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        const img = imageBlockFromChatUrl(part);
        if (img) blocks.push(img);
      }
    }
  }

  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  // Fold string content in as a text block (after thinking, before tool_use)
  // whenever the message carries anything besides that string.
  if (plainString !== null && (blocks.length > 0 || toolCalls.length > 0)) {
    blocks.push({ type: 'text', text: plainString });
    plainString = null;
  }

  for (const tc of toolCalls) {
    if (!isPlainObject(tc)) continue;
    const fn = asObject(tc.function) ?? {};
    let input = {};
    if (typeof fn.arguments === 'string' && fn.arguments.trim() !== '') {
      try {
        input = JSON.parse(fn.arguments);
      } catch {
        input = {};
      }
    } else if (isPlainObject(fn.arguments) || Array.isArray(fn.arguments)) {
      input = fn.arguments;
    }
    blocks.push({
      type: 'tool_use',
      id: typeof tc.id === 'string' ? tc.id : '',
      name: typeof fn.name === 'string' ? fn.name : '',
      input,
    });
  }

  if (blocks.length === 0 && plainString === null) return null;
  return { role, blocks, plainString };
}

function chatToAnthropicRequest(body) {
  const result = {};

  if (typeof body.model === 'string') result.model = body.model;

  const messages = [];
  const systemParts = [];
  if (typeof body.system === 'string' && body.system !== '') {
    systemParts.push(body.system);
  } else if (Array.isArray(body.system)) {
    for (const p of body.system) {
      const t = typeof p === 'string' ? p : isPlainObject(p) && typeof p.text === 'string' ? p.text : '';
      if (t !== '') systemParts.push(t);
    }
  }

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of msgs) {
    if (!isPlainObject(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role : 'user';
    if (role === 'system') {
      // Anthropic has no mid-conversation system role: hoist into the leading
      // system message (legacy text-path behavior).
      const t = systemTextFromChatContent(msg.content);
      if (t !== '') systemParts.push(t);
      continue;
    }
    if (role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '',
            content: toolResultContentFromChat(msg.content),
          },
        ],
      });
      continue;
    }
    const converted = chatMessageToAnthropicBlocks(msg);
    if (!converted) continue;
    if (converted.blocks.length === 0) {
      messages.push({ role: converted.role, content: converted.plainString ?? '' });
      continue;
    }
    if (converted.plainString !== null) {
      converted.blocks.push({ type: 'text', text: converted.plainString });
    }
    messages.push({ role: converted.role, content: converted.blocks });
  }

  if (systemParts.length > 0) {
    messages.unshift({ role: 'system', content: systemParts.join('\n') });
  }

  result.messages = messages;

  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  else if (body.max_completion_tokens !== undefined) result.max_tokens = body.max_completion_tokens;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop !== undefined) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream !== undefined) result.stream = body.stream;
  // stream_options intentionally dropped (no Anthropic equivalent).

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const anthropicTools = [];
  for (const t of tools) {
    if (!isPlainObject(t)) continue;
    const fn = isPlainObject(t.function) ? t.function : t;
    const name = typeof fn.name === 'string' ? fn.name : '';
    if (name === 'BatchTool') continue;
    const def = { name, input_schema: cleanSchema(isPlainObject(fn.parameters) ? fn.parameters : {}) };
    if (fn.description !== undefined) def.description = fn.description;
    anthropicTools.push(def);
  }
  if (anthropicTools.length > 0) result.tools = anthropicTools;

  if (body.tool_choice !== undefined) result.tool_choice = mapToolChoiceToAnthropic(body.tool_choice);

  return result;
}

// ---------------------------------------------------------------------------
// RESPONSE: OpenAI chat -> Anthropic message (transform.rs openai_to_anthropic)
// ---------------------------------------------------------------------------

function chatUsageToAnthropic(usage) {
  const u = asObject(usage) ?? {};
  // prompt_tokens includes cache hits; Anthropic input_tokens excludes them
  // (three mutually-exclusive buckets: input + cache_read + cache_creation == prompt).
  const cached = asCount(u.cache_read_input_tokens) || asCount(u.prompt_tokens_details?.cached_tokens) || 0;
  const cacheCreation =
    asCount(u.cache_creation_input_tokens) ||
    asCount(u.prompt_tokens_details?.cache_write_tokens) ||
    asCount(u.input_tokens_details?.cache_write_tokens) ||
    0;
  const inputTokens = Math.max(0, asCount(u.prompt_tokens) - cached - cacheCreation);
  const outputTokens = asCount(u.completion_tokens);

  const usageJson = { input_tokens: inputTokens, output_tokens: outputTokens };
  if (cached > 0) usageJson.cache_read_input_tokens = cached;
  if (cacheCreation > 0) usageJson.cache_creation_input_tokens = cacheCreation;
  return usageJson;
}

function chatResponseToAnthropic(body) {
  if (!Array.isArray(body.choices)) throw new ConversionError('chat response has no choices array');
  const choice = body.choices[0];
  if (!isPlainObject(choice)) throw new ConversionError('chat response has an empty choices array');
  const message = asObject(choice.message);
  if (!message) throw new ConversionError('chat response choice has no message');

  const content = [];
  let hasToolUse = false;

  // DeepSeek-style reasoning content becomes a leading thinking block.
  if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }

  const msgContent = message.content;
  if (typeof msgContent === 'string') {
    if (msgContent !== '') content.push({ type: 'text', text: msgContent });
  } else if (Array.isArray(msgContent)) {
    for (const part of msgContent) {
      if (!isPlainObject(part)) continue;
      const partType = String(part.type ?? '');
      if (partType === 'text' || partType === 'output_text') {
        if (typeof part.text === 'string' && part.text !== '') content.push({ type: 'text', text: part.text });
      } else if (partType === 'refusal') {
        if (typeof part.refusal === 'string' && part.refusal !== '') content.push({ type: 'text', text: part.refusal });
      }
    }
  }
  // Some providers put refusal at message level.
  if (typeof message.refusal === 'string' && message.refusal !== '') {
    content.push({ type: 'text', text: message.refusal });
  }

  // tool_calls
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length > 0) hasToolUse = true;
  for (const tc of toolCalls) {
    if (!isPlainObject(tc)) continue;
    const fn = asObject(tc.function) ?? {};
    const argsStr = typeof fn.arguments === 'string' ? fn.arguments : '{}';
    let input = {};
    try {
      input = JSON.parse(argsStr);
      if (!isPlainObject(input) && !Array.isArray(input)) input = {};
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: typeof tc.id === 'string' ? tc.id : '',
      name: typeof fn.name === 'string' ? fn.name : '',
      input,
    });
  }

  // Legacy function_call form.
  if (!hasToolUse && isPlainObject(message.function_call)) {
    const fc = message.function_call;
    const name = typeof fc.name === 'string' ? fc.name : '';
    const hasArguments = fc.arguments !== undefined;
    let input = {};
    if (typeof fc.arguments === 'string') {
      try {
        input = JSON.parse(fc.arguments);
      } catch {
        input = {};
      }
      if (!isPlainObject(input) && !Array.isArray(input)) input = {};
    } else if (isPlainObject(fc.arguments) || Array.isArray(fc.arguments)) {
      input = fc.arguments;
    }
    if (name !== '' || hasArguments) {
      content.push({ type: 'tool_use', id: '', name, input });
      hasToolUse = true;
    }
  }

  let stopReason = null;
  if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
    stopReason = mapFinishReasonToStopReason(choice.finish_reason);
  } else if (hasToolUse) {
    stopReason = 'tool_use';
  }

  const result = {
    id: typeof body.id === 'string' ? body.id : '',
    type: 'message',
    role: 'assistant',
    content,
    model: typeof body.model === 'string' ? body.model : '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: chatUsageToAnthropic(body.usage),
  };
  return result;
}

// ---------------------------------------------------------------------------
// RESPONSE: Anthropic message -> OpenAI chat completion (derived inverse)
// ---------------------------------------------------------------------------

function anthropicUsageToChat(usage) {
  const u = asObject(usage) ?? {};
  const input = asCount(u.input_tokens);
  const output = asCount(u.output_tokens);
  const cacheRead = asCount(u.cache_read_input_tokens);
  const cacheCreation = asCount(u.cache_creation_input_tokens);
  const promptTokens = input + cacheRead + cacheCreation;
  const chatUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: promptTokens + output,
  };
  if (cacheRead > 0 || cacheCreation > 0) {
    const details = {};
    if (cacheRead > 0) details.cached_tokens = cacheRead;
    if (cacheCreation > 0) details.cache_write_tokens = cacheCreation;
    chatUsage.prompt_tokens_details = details;
  }
  return chatUsage;
}

function anthropicToChatResponse(body) {
  const blocks = Array.isArray(body.content) ? body.content : [];
  const textParts = [];
  const thinkingParts = [];
  const toolCalls = [];

  for (const b of blocks) {
    if (!isPlainObject(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push({ type: 'text', text: b.text });
    } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking !== '') {
      thinkingParts.push(b.thinking);
    } else if (b.type === 'tool_use') {
      toolCalls.push({
        id: typeof b.id === 'string' ? b.id : '',
        type: 'function',
        function: {
          name: typeof b.name === 'string' ? b.name : '',
          arguments: canonicalJsonString(b.input ?? {}),
        },
      });
    }
    // other block types (image / redacted_thinking / document) have no chat
    // completion equivalent and are dropped.
  }

  const message = { role: 'assistant' };
  if (thinkingParts.length > 0) message.reasoning_content = thinkingParts.join('\n');
  if (textParts.length === 1) message.content = textParts[0].text;
  else if (textParts.length > 1) message.content = textParts;
  else message.content = toolCalls.length > 0 ? null : '';
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  let finish;
  switch (body.stop_reason) {
    case 'end_turn':
      finish = 'stop';
      break;
    case 'max_tokens':
      finish = 'length';
      break;
    case 'tool_use':
      finish = 'tool_calls';
      break;
    case 'stop_sequence':
      finish = 'stop';
      break;
    case undefined:
    case null:
    case '':
      finish = toolCalls.length > 0 ? 'tool_calls' : 'stop';
      break;
    default:
      finish = 'stop';
      break;
  }

  return {
    id: typeof body.id === 'string' && body.id !== '' ? body.id : 'chatcmpl_lapi_conv',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === 'string' ? body.model : '',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: anthropicUsageToChat(body.usage),
  };
}

// ---------------------------------------------------------------------------
// SSE UTF-8 draining: createUtf8Buffer holds incomplete multi-byte tails but
// offers no drain; use it as the decoder of record — probe for the safe head
// and decode that head through a second buffer instance.
// ---------------------------------------------------------------------------

function concatBytes(a, b) {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const n = new Uint8Array(a.length + b.length);
  n.set(a, 0);
  n.set(b, a.length);
  return n;
}

function createSseDrainer() {
  let tail = new Uint8Array(0);
  const encoder = new TextEncoder();
  return {
    push(chunk) {
      const bytes = chunk instanceof Uint8Array ? chunk : encoder.encode(String(chunk));
      if (bytes.length === 0) return '';
      const merged = tail.length > 0 ? concatBytes(tail, bytes) : bytes;
      const probe = createUtf8Buffer();
      probe.push(merged);
      tail = probe.getPending();
      const headLen = merged.length - tail.length;
      if (headLen <= 0) return '';
      const head = createUtf8Buffer();
      head.push(merged.slice(0, headLen));
      return head.end();
    },
    end() {
      if (tail.length === 0) return '';
      const text = new TextDecoder().decode(tail);
      tail = new Uint8Array(0);
      return text;
    },
  };
}

// ---------------------------------------------------------------------------
// SSE: OpenAI chat stream -> Anthropic message stream (streaming.rs
// create_anthropic_sse_stream)
// ---------------------------------------------------------------------------

const INFINITE_WHITESPACE_THRESHOLD = 500;

function extractCacheReadTokensStreaming(usage) {
  // Direct compatibility field first; nested OpenAI detail only when > 0.
  if (usage.cache_read_input_tokens !== undefined) return asCount(usage.cache_read_input_tokens);
  const nested = asCount(usage.prompt_tokens_details?.cached_tokens);
  return nested > 0 ? nested : 0;
}

function extractCacheWriteTokensStreaming(usage) {
  if (usage.cache_creation_input_tokens !== undefined) return asCount(usage.cache_creation_input_tokens);
  const nested = asCount(usage.prompt_tokens_details?.cache_write_tokens);
  return nested > 0 ? nested : 0;
}

function buildAnthropicUsageJson(usage) {
  const u = asObject(usage) ?? {};
  const cached = extractCacheReadTokensStreaming(u);
  const cacheCreation = extractCacheWriteTokensStreaming(u);
  const inputTokens = Math.max(0, asCount(u.prompt_tokens) - cached - cacheCreation);
  const usageJson = { input_tokens: inputTokens, output_tokens: asCount(u.completion_tokens) };
  if (cached > 0) usageJson.cache_read_input_tokens = cached;
  if (cacheCreation > 0) usageJson.cache_creation_input_tokens = cacheCreation;
  return usageJson;
}

function defaultAnthropicUsageJson() {
  return { input_tokens: 0, output_tokens: 0 };
}

function buildMessageDeltaEvent(stopReason, usageJson) {
  const usage = isPlainObject(usageJson) ? usageJson : defaultAnthropicUsageJson();
  return {
    type: 'message_delta',
    delta: { stop_reason: stopReason ?? null, stop_sequence: null },
    usage,
  };
}

function chatToMessagesSse() {
  const drainer = createSseDrainer();
  let buffer = '';
  let out = '';
  let closed = false;
  let messageId = '';
  let currentModel = '';
  let nextContentIndex = 0;
  let hasSentMessageStart = false;
  let hasEmittedMessageDelta = false;
  let pendingMessageDelta = null; // { stopReason, usage }
  let latestUsage = null;
  let currentNonToolBlockType = null;
  let currentNonToolBlockIndex = null;
  const toolBlocksByIndex = new Map(); // chat tool index -> state
  const openToolBlockIndices = new Set();

  function emit(event, payload) {
    out += 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  }

  function ensureMessageStart(chunkUsage) {
    if (hasSentMessageStart) return;
    const startUsage = defaultAnthropicUsageJson();
    if (isPlainObject(chunkUsage)) {
      const cached = extractCacheReadTokensStreaming(chunkUsage);
      const cacheCreation = extractCacheWriteTokensStreaming(chunkUsage);
      startUsage.input_tokens = Math.max(0, asCount(chunkUsage.prompt_tokens) - cached - cacheCreation);
      if (cached > 0) startUsage.cache_read_input_tokens = cached;
      if (cacheCreation > 0) startUsage.cache_creation_input_tokens = cacheCreation;
    }
    emit('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: currentModel,
        usage: startUsage,
      },
    });
    hasSentMessageStart = true;
  }

  function closeCurrentNonToolBlock() {
    if (currentNonToolBlockIndex !== null) {
      emit('content_block_stop', { type: 'content_block_stop', index: currentNonToolBlockIndex });
      currentNonToolBlockIndex = null;
    }
    currentNonToolBlockType = null;
  }

  function closeOpenToolBlocks() {
    if (openToolBlockIndices.size === 0) return;
    const indices = [...openToolBlockIndices].sort((a, b) => a - b);
    for (const index of indices) {
      emit('content_block_stop', { type: 'content_block_stop', index });
    }
    openToolBlockIndices.clear();
  }

  function emitPendingMessageDelta(synthesize) {
    if (pendingMessageDelta) {
      emit('message_delta', buildMessageDeltaEvent(pendingMessageDelta.stopReason, pendingMessageDelta.usage));
      pendingMessageDelta = null;
      return true;
    }
    if (synthesize && hasSentMessageStart) {
      emit('message_delta', buildMessageDeltaEvent('end_turn', null));
      return true;
    }
    return false;
  }

  function handleDone() {
    closed = true;
    closeCurrentNonToolBlock();
    closeOpenToolBlocks();
    emitPendingMessageDelta(true);
    emit('message_stop', { type: 'message_stop' });
  }

  function handleError(data) {
    const err = asObject(data?.error);
    const message = String((err && err.message) || data?.message || 'Upstream stream error');
    closed = true;
    emit('error', { type: 'error', error: { type: 'stream_error', message } });
  }

  function handleToolCalls(toolCalls) {
    if (currentNonToolBlockIndex !== null) closeCurrentNonToolBlock();
    for (const toolCall of toolCalls) {
      if (!isPlainObject(toolCall)) continue;
      const chatIndex = typeof toolCall.index === 'number' ? toolCall.index : 0;
      let state = toolBlocksByIndex.get(chatIndex);
      if (!state) {
        state = {
          anthropicIndex: nextContentIndex++,
          id: '',
          name: '',
          started: false,
          pendingArgs: '',
          consecutiveWhitespace: 0,
          aborted: false,
        };
        toolBlocksByIndex.set(chatIndex, state);
      }

      // Tool aborted by the infinite-whitespace bug: skip everything further.
      if (state.aborted) continue;

      if (typeof toolCall.id === 'string') state.id = toolCall.id;
      const fn = asObject(toolCall.function);
      if (fn && typeof fn.name === 'string') state.name = fn.name;

      const shouldStart = !state.started && state.id !== '' && state.name !== '';
      if (shouldStart) state.started = true;
      let pendingAfterStart = null;
      if (shouldStart && state.pendingArgs !== '') {
        pendingAfterStart = state.pendingArgs;
        state.pendingArgs = '';
      }

      const argsDelta = fn && typeof fn.arguments === 'string' ? fn.arguments : null;
      let immediateDelta = null;
      if (argsDelta !== null) {
        // Infinite-whitespace bug detection (Copilot): >= 500 consecutive
        // whitespace chars aborts this tool call for good.
        for (const ch of argsDelta) {
          if (/\s/.test(ch)) state.consecutiveWhitespace += 1;
          else state.consecutiveWhitespace = 0;
        }
        if (state.consecutiveWhitespace >= INFINITE_WHITESPACE_THRESHOLD) {
          state.aborted = true;
        } else if (state.started) {
          immediateDelta = argsDelta;
        } else {
          state.pendingArgs += argsDelta;
        }
      }

      if (shouldStart) {
        emit('content_block_start', {
          type: 'content_block_start',
          index: state.anthropicIndex,
          content_block: { type: 'tool_use', id: state.id, name: state.name },
        });
        openToolBlockIndices.add(state.anthropicIndex);
      }
      if (pendingAfterStart !== null && pendingAfterStart !== '') {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: state.anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: pendingAfterStart },
        });
      }
      if (immediateDelta !== null && immediateDelta !== '') {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: state.anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: immediateDelta },
        });
      }
    }
  }

  function handleFinish(choice, chunkUsageJson, latestUsage) {
    const stopReason = mapFinishReasonToStopReason(choice.finish_reason);
    const usageJson = chunkUsageJson ?? latestUsage ?? null;
    if (hasEmittedMessageDelta) {
      // Duplicate finish_reason (OpenRouter): only refresh the pending usage.
      if (pendingMessageDelta && usageJson) pendingMessageDelta.usage = usageJson;
      return;
    }
    hasEmittedMessageDelta = true;
    closeCurrentNonToolBlock();

    // Late-start tool blocks that buffered args before id/name arrived.
    const lateStarts = [];
    for (const [toolIdx, state] of toolBlocksByIndex) {
      if (state.started || state.aborted) continue;
      const hasPayload = state.pendingArgs !== '' || state.id !== '' || state.name !== '';
      if (!hasPayload) continue;
      state.started = true;
      lateStarts.push({
        anthropicIndex: state.anthropicIndex,
        id: state.id !== '' ? state.id : 'tool_call_' + toolIdx,
        name: state.name !== '' ? state.name : 'unknown_tool',
        pendingArgs: state.pendingArgs,
      });
      state.pendingArgs = '';
    }
    lateStarts.sort((a, b) => a.anthropicIndex - b.anthropicIndex);
    for (const ls of lateStarts) {
      emit('content_block_start', {
        type: 'content_block_start',
        index: ls.anthropicIndex,
        content_block: { type: 'tool_use', id: ls.id, name: ls.name },
      });
      openToolBlockIndices.add(ls.anthropicIndex);
      if (ls.pendingArgs !== '') {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: ls.anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: ls.pendingArgs },
        });
      }
    }

    closeOpenToolBlocks();

    // Defer message_delta until [DONE] / stream end so late usage chunks merge.
    pendingMessageDelta = { stopReason, usage: usageJson };
  }

  function handleChunk(data) {
    if (messageId === '' && typeof data.id === 'string' && data.id !== '') messageId = data.id;
    if (currentModel === '' && typeof data.model === 'string' && data.model !== '') currentModel = data.model;

    const chunkUsageJson = isPlainObject(data.usage) ? buildAnthropicUsageJson(data.usage) : null;
    if (chunkUsageJson) {
      latestUsage = chunkUsageJson;
      if (pendingMessageDelta) pendingMessageDelta.usage = chunkUsageJson;
    }

    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = isPlainObject(choices[0]) ? choices[0] : null;
    if (!choice) return;
    const delta = asObject(choice.delta);
    if (!delta) return;

    ensureMessageStart(isPlainObject(data.usage) ? data.usage : null);

    // reasoning (OpenRouter/Kimi `reasoning`, DeepSeek `reasoning_content`)
    let reasoning = null;
    if (typeof delta.reasoning === 'string') reasoning = delta.reasoning;
    else if (typeof delta.reasoning_content === 'string') reasoning = delta.reasoning_content;
    if (reasoning !== null) {
      if (currentNonToolBlockType !== 'thinking') {
        closeCurrentNonToolBlock();
        const index = nextContentIndex++;
        emit('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '' },
        });
        currentNonToolBlockType = 'thinking';
        currentNonToolBlockIndex = index;
      }
      if (currentNonToolBlockIndex !== null) {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: currentNonToolBlockIndex,
          delta: { type: 'thinking_delta', thinking: reasoning },
        });
      }
    }

    // text content
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (currentNonToolBlockType !== 'text') {
        closeCurrentNonToolBlock();
        const index = nextContentIndex++;
        emit('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        });
        currentNonToolBlockType = 'text';
        currentNonToolBlockIndex = index;
      }
      if (currentNonToolBlockIndex !== null) {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: currentNonToolBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
      }
    }

    // tool calls
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      handleToolCalls(delta.tool_calls);
    }

    // finish_reason: cache the terminal message_delta, emit at [DONE]/end.
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
      handleFinish(choice, chunkUsageJson, latestUsage);
    }
  }

  function handleBlock(block) {
    const { event, dataText, data, parsed } = parseEventBlock(block);
    if (dataText === null) return;
    if (isDoneData(dataText)) {
      handleDone();
      return;
    }
    if (event === 'error' || (parsed && isPlainObject(data) && (data.type === 'error' || data.error))) {
      handleError(data);
      return;
    }
    if (!parsed || !isPlainObject(data)) return;
    handleChunk(data);
  }

  function drainBlocks() {
    let block;
    while ((block = takeSseBlock(buffer)) !== null) {
      buffer = block.rest;
      handleBlock(block.block);
      if (closed) break;
    }
  }

  return {
    push(chunk) {
      if (closed) return '';
      out = '';
      buffer += drainer.push(chunk);
      drainBlocks();
      const emitted = out;
      out = '';
      return emitted;
    },
    end() {
      if (closed) return '';
      out = '';
      buffer += drainer.end();
      drainBlocks();
      if (!closed) {
        closeCurrentNonToolBlock();
        closeOpenToolBlocks();
        const emitted = emitPendingMessageDelta(true);
        if (emitted) emit('message_stop', { type: 'message_stop' });
        closed = true;
      }
      const emittedTail = out;
      out = '';
      return emittedTail;
    },
  };
}

// ---------------------------------------------------------------------------
// SSE: Anthropic message stream -> OpenAI chat stream (derived inverse)
// ---------------------------------------------------------------------------

function messagesToChatSse() {
  const drainer = createSseDrainer();
  let buffer = '';
  let out = '';
  let closed = false;
  let emittedAnything = false;
  let capturedId = '';
  let capturedModel = '';
  let startUsage = null; // message_start usage (input side)
  const chatIndexByBlockIndex = new Map(); // anthropic block index -> chat tool_calls index
  let nextChatToolIndex = 0;

  const dataLine = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';

  function chatChunk(delta, extra) {
    const choice = { index: 0, delta };
    if (extra) {
      if (extra.finish_reason !== undefined) choice.finish_reason = extra.finish_reason;
    }
    const payload = { choices: [choice] };
    if (extra && extra.usage) payload.usage = extra.usage;
    return dataLine(payload);
  }

  function mergedUsage(deltaUsage) {
    const merged = { ...(asObject(startUsage) ?? {}) };
    if (isPlainObject(deltaUsage)) Object.assign(merged, deltaUsage);
    return merged;
  }

  function anthropicUsageToChatUsage(usage) {
    const u = asObject(usage);
    if (!u) return null;
    const input = asCount(u.input_tokens);
    const output = asCount(u.output_tokens);
    const cacheRead = asCount(u.cache_read_input_tokens);
    const cacheCreation = asCount(u.cache_creation_input_tokens);
    if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) return null;
    const chatUsage = {
      prompt_tokens: input + cacheRead + cacheCreation,
      completion_tokens: output,
    };
    if (cacheRead > 0 || cacheCreation > 0) {
      const details = {};
      if (cacheRead > 0) details.cached_tokens = cacheRead;
      if (cacheCreation > 0) details.cache_write_tokens = cacheCreation;
      chatUsage.prompt_tokens_details = details;
    }
    return chatUsage;
  }

  function emitToolStart(blockIndex, contentBlock) {
    let chatIndex = chatIndexByBlockIndex.get(blockIndex);
    if (chatIndex === undefined) {
      chatIndex = nextChatToolIndex++;
      chatIndexByBlockIndex.set(blockIndex, chatIndex);
    }
    out += chatChunk(
      {
        tool_calls: [
          {
            index: chatIndex,
            id: typeof contentBlock.id === 'string' ? contentBlock.id : '',
            type: 'function',
            function: {
              name: typeof contentBlock.name === 'string' ? contentBlock.name : '',
              arguments: '',
            },
          },
        ],
      },
      null
    );
    emittedAnything = true;
  }

  function emitToolArgs(blockIndex, partialJson) {
    let chatIndex = chatIndexByBlockIndex.get(blockIndex);
    if (chatIndex === undefined) {
      chatIndex = nextChatToolIndex++;
      chatIndexByBlockIndex.set(blockIndex, chatIndex);
    }
    out += chatChunk({ tool_calls: [{ index: chatIndex, function: { arguments: partialJson } }] }, null);
    emittedAnything = true;
  }

  function handleDone() {
    if (closed) return;
    closed = true;
    out += 'data: [DONE]\n\n';
  }

  function handleError(data) {
    if (closed) return;
    const err = asObject(data?.error);
    const message = String((err && err.message) || data?.message || 'Upstream stream error');
    const type = String((err && err.type) || 'upstream_error');
    closed = true;
    out += dataLine({ error: { message, type } });
    out += 'data: [DONE]\n\n';
  }

  function handleEvent(data) {
    const type = typeof data.type === 'string' ? data.type : '';
    switch (type) {
      case 'message_start': {
        const message = asObject(data.message);
        if (message) {
          if (capturedId === '' && typeof message.id === 'string') capturedId = message.id;
          if (capturedModel === '' && typeof message.model === 'string') capturedModel = message.model;
          if (isPlainObject(message.usage)) startUsage = message.usage;
        }
        // chat has no start event: capture and emit nothing yet
        return;
      }
      case 'content_block_start': {
        const block = asObject(data.content_block);
        if (block && block.type === 'tool_use') {
          const blockIndex = typeof data.index === 'number' ? data.index : nextChatToolIndex;
          emitToolStart(blockIndex, block);
        }
        return;
      }
      case 'content_block_delta': {
        const d = asObject(data.delta) ?? {};
        if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          out += chatChunk({ reasoning_content: d.thinking }, null);
          emittedAnything = true;
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const blockIndex = typeof data.index === 'number' ? data.index : 0;
          emitToolArgs(blockIndex, d.partial_json);
        } else if (typeof d.text === 'string') {
          // covers {type:'text_delta',text} and the bare {text} delta shape
          out += chatChunk({ content: d.text }, null);
          emittedAnything = true;
        }
        return;
      }
      case 'message_delta': {
        const delta = asObject(data.delta) ?? {};
        if (typeof delta.stop_reason === 'string' && delta.stop_reason !== '') {
          const usage = anthropicUsageToChatUsage(mergedUsage(data.usage));
          out += chatChunk({}, { finish_reason: mapStopReasonToFinishReason(delta.stop_reason), usage });
        }
        out += 'data: [DONE]\n\n';
        closed = true;
        return;
      }
      case 'message_stop': {
        out += 'data: [DONE]\n\n';
        closed = true;
        return;
      }
      default:
        return;
    }
  }

  function handleBlock(block) {
    const { event, dataText, data, parsed } = parseEventBlock(block);
    if (dataText === null) return;
    if (isDoneData(dataText)) {
      // Anthropic upstreams should not send [DONE]; tolerate as stream end.
      handleDone();
      return;
    }
    if (event === 'error' || (parsed && isPlainObject(data) && (data.type === 'error' || data.error))) {
      handleError(data);
      return;
    }
    if (!parsed || !isPlainObject(data)) return;
    handleEvent(data);
  }

  function drainBlocks() {
    let block;
    while ((block = takeSseBlock(buffer)) !== null) {
      buffer = block.rest;
      handleBlock(block.block);
      if (closed) break;
    }
  }

  return {
    push(chunk) {
      if (closed) return '';
      out = '';
      buffer += drainer.push(chunk);
      drainBlocks();
      const emitted = out;
      out = '';
      return emitted;
    },
    end() {
      if (closed) return '';
      out = '';
      buffer += drainer.end();
      drainBlocks();
      if (!closed) {
        if (emittedAnything) {
          out += 'data: [DONE]\n\n';
        }
        closed = true;
      }
      const emittedTail = out;
      out = '';
      return emittedTail;
    },
  };
}

// ---------------------------------------------------------------------------
// Export surface
// ---------------------------------------------------------------------------

export function request(from, to, body) {
  const b = isPlainObject(body) ? body : {};
  if (from === to) return body;
  if (from === 'messages' && to === 'chat') return anthropicToChatRequest(b);
  if (from === 'chat' && to === 'messages') return chatToAnthropicRequest(b);
  throw new ConversionError('unsupported conversion pair: ' + String(from) + ' to ' + String(to));
}

export function response(from, to, body) {
  const b = isPlainObject(body) ? body : {};
  if (from === to) return body;
  if (from === 'chat' && to === 'messages') return chatResponseToAnthropic(b);
  if (from === 'messages' && to === 'chat') return anthropicToChatResponse(b);
  throw new ConversionError('unsupported conversion pair: ' + String(from) + ' to ' + String(to));
}

export function createSse(from, to) {
  if (from === 'chat' && to === 'messages') return chatToMessagesSse();
  if (from === 'messages' && to === 'chat') return messagesToChatSse();
  throw new ConversionError('unsupported conversion pair: ' + String(from) + ' to ' + String(to));
}
