// Ported from cc-switch (MIT, (c) 2025 Jason Young) — transform_codex_chat.rs,
// streaming_codex_chat.rs, codex_responses_sse.rs, codex_chat_common.rs.
//
// Mirror-pair converter: OpenAI /v1/chat/completions <-> OpenAI /v1/responses.
//   request()  responses->chat = responses_to_chat_completions_with_reasoning
//              chat->responses = the derived inverse
//   response() chat->responses  = chat_completion_to_response_with_context
//              responses->chat  = the derived inverse
//   createSse() chat->responses = streaming_codex_chat state machine (Chat SSE -> Responses SSE)
//               responses->chat = the derived inverse (Responses SSE -> Chat SSE)
//
// Documented simplifications vs upstream (kept deliberately small):
//   - CodexToolContext: function tools keep their names (identity); namespace tools
//     flatten with the plain `namespace__name` prefix (no 64-char hash truncation);
//     custom / tool_search tools are synthesized 1:1 as chat function tools.
//   - Tool-result media relocation machinery (tool_media.rs) is omitted; tool outputs
//     stay text/canonical JSON.
//   - reasoning_effort: extended Codex tiers (xhigh/max/ultra) clamp to 'xhigh'
//     instead of cc-switch's verbatim passthrough; unknown values are dropped.
//   - chat->responses: only the first system/developer message becomes `instructions`;
//     later system messages cannot be expressed in Responses input and are dropped.
//   - `store`, `previous_response_id`, `include` (responses->chat) and `stop`,
//     `stream_options` (chat->responses) are dropped: the target protocol cannot
//     express them.

import { ConversionError } from './errors.mjs';
import {
  takeSseBlock,
  parseEventBlock,
  isDoneData,
  createUtf8Buffer,
  canonicalJsonString,
  canonicalizeToolArguments,
} from './sse-common.mjs';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// serde `as_u64` equivalent: non-negative integers only (null otherwise).
function u64(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  return null;
}

const THINK_OPEN_TAG = '<think>';
const THINK_CLOSE_TAG = '</think>';

// codex_chat_common.rs split_leading_think_block -> [reasoning, answer] | null
function splitLeadingThinkBlock(text) {
  if (typeof text !== 'string') return null;
  const leadingWsLen = text.length - text.trimStart().length;
  const afterWs = text.slice(leadingWsLen);
  if (!afterWs.startsWith(THINK_OPEN_TAG)) return null;
  const bodyStart = leadingWsLen + THINK_OPEN_TAG.length;
  const closeStart = text.indexOf(THINK_CLOSE_TAG, bodyStart);
  if (closeStart < 0) return null;
  const answerStart = closeStart + THINK_CLOSE_TAG.length;
  return [
    text.slice(bodyStart, closeStart).trim(),
    text.slice(answerStart).replace(/^[\r\n\t ]+/, ''),
  ];
}

// codex_chat_common.rs strip_leading_think_open_tag
function stripLeadingThinkOpenTag(text) {
  if (typeof text !== 'string') return null;
  const leadingWsLen = text.length - text.trimStart().length;
  const afterWs = text.slice(leadingWsLen);
  if (!afterWs.startsWith(THINK_OPEN_TAG)) return null;
  return afterWs.slice(THINK_OPEN_TAG.length).trim();
}

// codex_chat_common.rs extract_reasoning_field_text
function extractReasoningFieldText(value) {
  if (!isObj(value)) return null;
  for (const key of ['reasoning_content', 'reasoning']) {
    const t = value[key];
    if (typeof t === 'string' && t.length > 0) return t;
  }
  const reasoning = value.reasoning;
  if (isObj(reasoning)) {
    for (const key of ['content', 'text', 'summary']) {
      const t = reasoning[key];
      if (typeof t === 'string' && t.length > 0) return t;
    }
  }
  if (value.reasoning_details !== undefined && value.reasoning_details !== null) {
    const t = extractReasoningDetailsText(value.reasoning_details);
    if (t) return t;
  }
  return null;
}

function extractReasoningDetailsText(value) {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    const text = value
      .map(extractReasoningDetailPartText)
      .filter((t) => typeof t === 'string' && t.length > 0)
      .join('\n\n');
    return text.length > 0 ? text : null;
  }
  if (isObj(value)) return extractReasoningDetailPartText(value);
  return null;
}

function extractReasoningDetailPartText(value) {
  if (!isObj(value)) return null;
  for (const key of ['text', 'content', 'summary']) {
    const t = value[key];
    if (typeof t === 'string' && t.length > 0) return t;
  }
  const parts = value.parts;
  if (Array.isArray(parts)) {
    const text = parts
      .map(extractReasoningDetailPartText)
      .filter((t) => typeof t === 'string' && t.length > 0)
      .join('\n\n');
    return text.length > 0 ? text : null;
  }
  return null;
}

// codex_chat_common.rs extract_reasoning_summary_text
function extractReasoningSummaryText(value) {
  if (!isObj(value)) return null;
  for (const key of ['reasoning_content', 'content', 'text']) {
    const t = value[key];
    if (typeof t === 'string' && t.length > 0) return t;
  }
  const summary = value.summary;
  if (typeof summary === 'string') return summary.length > 0 ? summary : null;
  if (Array.isArray(summary)) {
    const text = summary
      .map((part) => {
        if (isObj(part)) {
          if (typeof part.text === 'string' && part.text.length > 0) return part.text;
          if (typeof part.content === 'string' && part.content.length > 0) return part.content;
          return '';
        }
        return typeof part === 'string' ? part : '';
      })
      .filter((t) => t.length > 0)
      .join('\n\n');
    return text.length > 0 ? text : null;
  }
  return null;
}

// codex_chat_common.rs append_reasoning_content (message object variant)
function appendReasoningContent(obj, reasoning) {
  const r = String(reasoning ?? '').trim();
  if (r.length === 0) return false;
  const existing = obj.reasoning_content;
  if (typeof existing === 'string' && existing.length > 0) {
    obj.reasoning_content = existing + '\n\n' + r;
  } else {
    obj.reasoning_content = r;
  }
  return true;
}

function canonicalizeJsonStringIfParseable(s) {
  if (typeof s !== 'string' || s.trim().length === 0) return s;
  try {
    return canonicalJsonString(JSON.parse(s));
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// usage / ids / status / model capability tables
// ---------------------------------------------------------------------------

// transform_codex_chat.rs chat_usage_to_responses_usage
function chatUsageToResponsesUsage(usage) {
  if (!isObj(usage)) {
    return {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      total_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
    };
  }
  const inputTokens = u64(usage.prompt_tokens) ?? u64(usage.input_tokens) ?? 0;
  const outputTokens = u64(usage.completion_tokens) ?? u64(usage.output_tokens) ?? 0;
  const totalTokens = u64(usage.total_tokens) ?? inputTokens + outputTokens;

  const result = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens };

  const directCacheRead = u64(usage.cache_read_input_tokens);
  const cached =
    directCacheRead ??
    u64(usage.prompt_tokens_details?.cached_tokens) ??
    u64(usage.input_tokens_details?.cached_tokens) ??
    u64(usage.prompt_cache_hit_tokens) ??
    0;
  const cacheWrite =
    u64(usage.prompt_tokens_details?.cache_write_tokens) ??
    u64(usage.input_tokens_details?.cache_write_tokens) ??
    u64(usage.cache_creation_input_tokens) ??
    0;
  if (cached > 0 || cacheWrite > 0) {
    result.input_tokens_details = { cached_tokens: cached, cache_write_tokens: cacheWrite };
  } else {
    result.input_tokens_details = { cached_tokens: 0 };
  }

  if (isObj(usage.completion_tokens_details)) {
    const details = { ...usage.completion_tokens_details };
    if (details.reasoning_tokens == null) details.reasoning_tokens = 0;
    result.output_tokens_details = details;
  } else {
    result.output_tokens_details = { reasoning_tokens: 0 };
  }

  if (directCacheRead !== null) result.cache_read_input_tokens = directCacheRead;
  if (cacheWrite > 0) result.cache_creation_input_tokens = cacheWrite;
  return result;
}

// Inverse of chat_usage_to_responses_usage (derived; no upstream counterpart).
function responsesUsageToChatUsage(usage) {
  if (!isObj(usage)) {
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    };
  }
  const input = u64(usage.input_tokens) ?? 0;
  const output = u64(usage.output_tokens) ?? 0;
  const total = u64(usage.total_tokens) ?? input + output;
  const cached = u64(usage.input_tokens_details?.cached_tokens) ?? u64(usage.cache_read_input_tokens) ?? 0;
  const reasoning = u64(usage.output_tokens_details?.reasoning_tokens) ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

// transform_codex_chat.rs response_id_from_chat_id
function responseIdFromChatId(id) {
  const s = typeof id === 'string' ? id : 'ccswitch';
  return s.startsWith('resp_') ? s : 'resp_' + s;
}

// transform_codex_chat.rs response_status_from_finish_reason
// (upstream table: only `length` maps to incomplete; every other reason,
// including a missing one, completes.)
function responseStatusFromFinishReason(finishReason) {
  return finishReason === 'length' ? 'incomplete' : 'completed';
}

// transform.rs is_openai_o_series
function isOpenAiOSeries(model) {
  const m = str(model);
  return m.length > 1 && m.startsWith('o') && m.charCodeAt(1) >= 48 && m.charCodeAt(1) <= 57;
}

// transform.rs supports_reasoning_effort (o-series / gpt-5+ / grok-4.5* heuristic)
function supportsReasoningEffort(model) {
  const m = str(model).toLowerCase();
  if (isOpenAiOSeries(m)) return true;
  if (m.startsWith('gpt-')) {
    const c = m.charAt(4);
    return c >= '5' && c <= '9';
  }
  return m === 'grok-4.5' || m.startsWith('grok-4.5-') || m.startsWith('grok-build-');
}

// transform.rs inject_openai_stream_include_usage
function injectOpenaiStreamIncludeUsage(result) {
  if (result.stream !== true) return;
  if (isObj(result.stream_options)) {
    result.stream_options = { ...result.stream_options, include_usage: true };
  } else {
    result.stream_options = { include_usage: true };
  }
}

// ---------------------------------------------------------------------------
// REQUEST: responses -> chat (responses_to_chat_completions_with_reasoning)
// ---------------------------------------------------------------------------

const EXTRA_CHAT_PASSTHROUGH_FIELDS = [
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'metadata',
  'n',
  'parallel_tool_calls',
  'presence_penalty',
  'response_format',
  'seed',
  'service_tier',
  'stop',
  'stream_options',
  'top_logprobs',
  'user',
];

const TOOL_SEARCH_PROXY_NAME = 'tool_search';
const CUSTOM_TOOL_INPUT_FIELD = 'input';
const CUSTOM_TOOL_PRESERVED_METADATA_HEADING = 'Original tool definition:';
const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description.';

// Simplified CodexToolContext (see file header note).
function createToolContext() {
  const chatTools = [];
  const seenChatNames = new Set();
  const specByName = new Map();

  function add(chatName, spec, chatTool) {
    if (!chatName || chatName.trim().length === 0 || seenChatNames.has(chatName)) return;
    seenChatNames.add(chatName);
    specByName.set(chatName, spec);
    chatTools.push(chatTool);
  }

  function responsesToolName(tool) {
    if (!isObj(tool)) return null;
    let raw;
    if (isObj(tool.function) && typeof tool.function.name === 'string') raw = tool.function.name;
    else if (typeof tool.name === 'string') raw = tool.name;
    else return null;
    const s = raw.trim();
    return s.length > 0 ? s : null;
  }

  function normalizeFunctionParameters(params) {
    const p = isObj(params) ? { ...params } : { type: 'object', properties: {} };
    if (str(p.type) !== 'object') p.type = 'object';
    return p;
  }

  function responsesFunctionToolToChatTool(tool, chatName) {
    if (str(tool?.type) !== 'function') return null;
    if (isObj(tool.function)) {
      const fn = { ...tool.function };
      fn.parameters = normalizeFunctionParameters(fn.parameters);
      fn.name = chatName;
      if (tool.strict !== undefined && fn.strict === undefined) fn.strict = tool.strict;
      return { type: 'function', function: fn };
    }
    const fn = {
      name: chatName,
      description: tool.description !== undefined ? tool.description : null,
      parameters: normalizeFunctionParameters(tool.parameters),
    };
    if (tool.strict !== undefined) fn.strict = tool.strict;
    return { type: 'function', function: fn };
  }

  function addFunctionTool(tool, namespace) {
    const originalName = responsesToolName(tool);
    if (originalName === null) return;
    const chatName = namespace ? flattenNamespaceToolName(namespace, originalName) : originalName;
    const chatTool = responsesFunctionToolToChatTool(tool, chatName);
    if (!chatTool) return;
    add(chatName, { kind: namespace ? 'namespace' : 'function', name: originalName }, chatTool);
  }

  function addCustomTool(tool) {
    const name = responsesToolName(tool);
    if (name === null) return;
    const description =
      CUSTOM_TOOL_PRESERVED_METADATA_HEADING + '\n```json\n' + canonicalJsonString(tool) + '\n```';
    add(
      name,
      { kind: 'custom', name },
      {
        type: 'function',
        function: {
          name,
          description,
          parameters: {
            type: 'object',
            properties: {
              [CUSTOM_TOOL_INPUT_FIELD]: { type: 'string', description: CUSTOM_TOOL_INPUT_DESCRIPTION },
            },
            required: [CUSTOM_TOOL_INPUT_FIELD],
          },
        },
      }
    );
  }

  function addToolSearchTool() {
    add(
      TOOL_SEARCH_PROXY_NAME,
      { kind: 'tool_search', name: TOOL_SEARCH_PROXY_NAME },
      {
        type: 'function',
        function: {
          name: TOOL_SEARCH_PROXY_NAME,
          description:
            'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query for tools or connectors to load.' },
              limit: { type: 'integer', description: 'Maximum number of tool groups to return.' },
            },
            required: ['query'],
          },
        },
      }
    );
  }

  function addNamespaceTool(tool) {
    const namespace = str(tool.name);
    if (namespace.length === 0) return;
    const children = Array.isArray(tool.tools)
      ? tool.tools
      : Array.isArray(tool.children)
        ? tool.children
        : null;
    if (!children) return;
    for (const child of children) {
      if (isObj(child) && str(child.type) === 'function') addFunctionTool(child, namespace);
    }
  }

  return {
    addResponseTool(tool) {
      if (typeof tool === 'string') {
        addCustomTool({ type: 'custom', name: tool });
        return;
      }
      if (!isObj(tool)) return;
      switch (str(tool.type)) {
        case 'function':
          addFunctionTool(tool, null);
          return;
        case 'custom':
          addCustomTool(tool);
          return;
        case 'tool_search':
          addToolSearchTool();
          return;
        case 'namespace':
          addNamespaceTool(tool);
          return;
        default:
          return;
      }
    },
    chatTools() {
      return chatTools;
    },
    isCustomToolChatName(name) {
      const spec = specByName.get(name);
      return !!spec && spec.kind === 'custom';
    },
    chatNameForResponseFunction(name, namespace) {
      const n = str(name);
      if (namespace && namespace.length > 0) return flattenNamespaceToolName(namespace, n);
      return n;
    },
  };
}

// Simplified: plain `namespace__name` prefix (no hash truncation), see file header.
function flattenNamespaceToolName(namespace, name) {
  return namespace + '__' + name;
}

function responsesFunctionCallToChatToolCall(item, ctx) {
  const callId = str(item.call_id) || str(item.id);
  const namespace = str(item.namespace);
  const chatName = ctx.chatNameForResponseFunction(str(item.name), namespace);
  return {
    id: callId,
    type: 'function',
    function: { name: chatName, arguments: canonicalizeToolArguments(item.arguments) },
  };
}

function responsesCustomToolCallToChatToolCall(item) {
  const callId = str(item.call_id) || str(item.id);
  const input = item.input !== undefined ? item.input : '';
  return {
    id: callId,
    type: 'function',
    function: { name: str(item.name), arguments: canonicalJsonString({ [CUSTOM_TOOL_INPUT_FIELD]: input }) },
  };
}

function responsesToolSearchCallToChatToolCall(item) {
  const callId = str(item.call_id) || str(item.id);
  const args = item.arguments !== undefined && item.arguments !== null ? canonicalJsonString(item.arguments) : '{}';
  return { id: callId, type: 'function', function: { name: TOOL_SEARCH_PROXY_NAME, arguments: args } };
}

function responsesToolChoiceToChat(toolChoice, ctx) {
  if (isObj(toolChoice)) {
    const t = str(toolChoice.type);
    if (t === 'function') {
      return {
        type: 'function',
        function: { name: ctx.chatNameForResponseFunction(str(toolChoice.name), str(toolChoice.namespace)) },
      };
    }
    if (t === 'tool_search') return { type: 'function', function: { name: TOOL_SEARCH_PROXY_NAME } };
    if (t === 'custom') return { type: 'function', function: { name: str(toolChoice.name) } };
  }
  return toolChoice;
}

// transform_codex_chat.rs instruction_text
function instructionText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (isObj(part) && typeof part.text === 'string') return part.text;
        if (typeof part === 'string') return part;
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n\n');
  }
  return '';
}

// transform_codex_chat.rs responses_role_to_chat_role
function responsesRoleToChatRole(role) {
  switch (role) {
    case 'system':
    case 'developer':
      return 'system';
    case 'assistant':
      return 'assistant';
    case 'tool':
      return 'tool';
    default:
      return 'user'; // user | latest_reminder | anything else
  }
}

// transform_codex_chat.rs responses_content_to_chat_content
function responsesContentToChatContent(content) {
  if (content === null || content === undefined || typeof content === 'string') {
    return content === undefined ? null : content;
  }
  if (!Array.isArray(content)) return content;
  const chatParts = [];
  let hasNonTextPart = false;
  for (const part of content) {
    const t = isObj(part) ? str(part.type) : '';
    if (t === 'input_text' || t === 'output_text' || t === 'text') {
      const text = str(part.text);
      if (text.length > 0) chatParts.push({ type: 'text', text });
    } else if (t === 'refusal') {
      const text = str(part.refusal);
      if (text.length > 0) chatParts.push({ type: 'text', text });
    } else if (t === 'input_image') {
      let imageUrl = part.image_url;
      if (isObj(imageUrl)) imageUrl = { ...imageUrl };
      else if (typeof imageUrl === 'string') imageUrl = { url: imageUrl };
      else imageUrl = null;
      if (imageUrl) {
        chatParts.push({ type: 'image_url', image_url: imageUrl });
        hasNonTextPart = true;
      }
    }
    // input_file / input_audio: media machinery out of scope for this port (dropped).
  }
  if (!hasNonTextPart) {
    return chatParts
      .map((p) => p.text)
      .join('\n');
  }
  return chatParts;
}

// Chat adaptation of transform_codex_anthropic.rs drop_incomplete_tool_turns:
// drop assistant tool-call turns (and their orphaned tool outputs) that do not form
// a complete adjacent assistant tool_calls -> tool results pair.
function dropIncompleteToolTurns(messages) {
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    const isAssistantWithCalls =
      message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!isAssistantWithCalls) {
      if (message.role !== 'tool') out.push(message);
      i += 1;
      continue;
    }
    const callIds = message.tool_calls.map((tc) => str(isObj(tc) ? tc.id : undefined)).filter((id) => id.length > 0);
    const uniqueCalls = new Set(callIds);
    let j = i + 1;
    const toolMessages = [];
    while (j < messages.length && messages[j].role === 'tool') {
      toolMessages.push(messages[j]);
      j += 1;
    }
    const resultIds = toolMessages.map((m) => str(m.tool_call_id)).filter((id) => id.length > 0);
    const uniqueResults = new Set(resultIds);
    const complete =
      callIds.length === message.tool_calls.length &&
      uniqueCalls.size === callIds.length &&
      uniqueResults.size === resultIds.length &&
      uniqueCalls.size === uniqueResults.size &&
      [...uniqueCalls].every((id) => uniqueResults.has(id));
    if (complete) {
      out.push(message);
      for (const m of toolMessages) out.push(m);
    }
    // incomplete turn: assistant tool-call message and its orphaned outputs are dropped
    i = j;
  }
  return out;
}

// transform_codex_chat.rs collapse_system_messages_to_head
function collapseSystemMessagesToHead(messages) {
  const systemChunks = [];
  const rest = [];
  for (const msg of messages) {
    if (msg.role === 'system' && typeof msg.content === 'string') {
      if (msg.content.trim().length > 0) systemChunks.push(msg.content);
      continue;
    }
    rest.push(msg);
  }
  const out = [];
  if (systemChunks.length > 0) out.push({ role: 'system', content: systemChunks.join('\n\n') });
  for (const m of rest) out.push(m);
  return out;
}

// transform.rs map_reasoning_effort, passthrough mode, clamped per port checklist:
// low/medium/high 1:1; extended Codex tiers (xhigh/max/ultra) -> 'xhigh'; unknown dropped.
function mapResponsesReasoningEffort(effort) {
  const e = effort.trim().toLowerCase();
  if (e === 'none' || e === 'off' || e === 'disabled') return null;
  if (e === 'minimal') return 'minimal';
  if (e === 'low' || e === 'medium' || e === 'high') return e;
  if (e === 'xhigh' || e === 'max' || e === 'ultra') return 'xhigh';
  return null;
}

function responsesRequestToChat(body) {
  const result = {};
  const ctx = createToolContext();
  for (const tool of Array.isArray(body.tools) ? body.tools : []) ctx.addResponseTool(tool);

  if (body.model !== undefined) result.model = body.model;

  let messages = [];
  const instructions = instructionText(body.instructions);
  if (instructions.length > 0) messages.push({ role: 'system', content: instructions });

  appendResponsesInputAsChatMessages(body.input, messages, ctx);

  messages = dropIncompleteToolTurns(messages);
  messages = collapseSystemMessagesToHead(messages);
  result.messages = messages;

  const model = typeof body.model === 'string' ? body.model : '';
  if (body.max_output_tokens !== undefined) {
    if (isOpenAiOSeries(model)) result.max_completion_tokens = body.max_output_tokens;
    else result.max_tokens = body.max_output_tokens;
  }
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) result.max_completion_tokens = body.max_completion_tokens;

  for (const key of ['temperature', 'top_p', 'stream']) {
    if (body[key] !== undefined) result[key] = body[key];
  }

  if (supportsReasoningEffort(model)) {
    const effort = isObj(body.reasoning) ? body.reasoning.effort : undefined;
    if (typeof effort === 'string' && effort.length > 0) {
      const mapped = mapResponsesReasoningEffort(effort);
      if (mapped !== null) result.reasoning_effort = mapped;
    }
  }

  const tools = ctx.chatTools();
  if (tools.length > 0) result.tools = tools;
  if (body.tool_choice !== undefined) result.tool_choice = responsesToolChoiceToChat(body.tool_choice, ctx);

  for (const key of EXTRA_CHAT_PASSTHROUGH_FIELDS) {
    if (body[key] !== undefined) result[key] = body[key];
  }

  // Strict upstreams reject tool_choice / parallel_tool_calls without tools.
  const hasTools = Array.isArray(result.tools) && result.tools.length > 0;
  if (!hasTools) {
    delete result.tool_choice;
    delete result.parallel_tool_calls;
  }

  injectOpenaiStreamIncludeUsage(result);

  if (!Array.isArray(result.messages) || result.messages.length === 0) {
    throw new ConversionError('responses request has no messages convertible to chat');
  }
  return result;
}

// transform_codex_chat.rs append_responses_input_as_chat_messages (+ item pipeline)
function appendResponsesInputAsChatMessages(input, messages, ctx) {
  let pendingToolCalls = [];
  let pendingReasoning = null;
  let lastAssistantIndex = null;

  const appendPendingReasoning = (reasoning) => {
    if (reasoning === null) return;
    const r = reasoning.trim();
    if (r.length === 0) return;
    if (typeof pendingReasoning === 'string' && pendingReasoning.length > 0) {
      pendingReasoning = pendingReasoning + '\n\n' + r;
    } else {
      pendingReasoning = r;
    }
  };

  const appendUniquePendingReasoning = (reasoning) => {
    if (reasoning === null) return;
    const r = reasoning.trim();
    if (r.length === 0) return;
    if (typeof pendingReasoning === 'string' && pendingReasoning.includes(r)) return;
    appendPendingReasoning(r);
  };

  // attach_pending_reasoning_to_assistant
  const attachPendingReasoningToAssistant = (message) => {
    if (pendingReasoning === null) return;
    const r = pendingReasoning;
    pendingReasoning = null;
    if (r.trim().length === 0) return;
    appendReasoningContent(message, r);
  };

  // attach_pending_reasoning_to_previous_assistant: back-attach at boundaries/end of
  // input; orphaned reasoning with no previous assistant is dropped.
  const attachPendingReasoningToPreviousAssistant = () => {
    if (pendingReasoning === null) return;
    const r = pendingReasoning;
    pendingReasoning = null;
    if (r.trim().length === 0) return;
    if (lastAssistantIndex === null) return;
    const target = messages[lastAssistantIndex];
    if (!target || target.role !== 'assistant') return;
    appendReasoningContent(target, r);
  };

  const updateLastAssistantIndex = (message) => {
    if (message.role === 'assistant') lastAssistantIndex = messages.length;
    else if (message.role !== 'tool') lastAssistantIndex = null;
  };

  // flush_pending_tool_calls
  const flushPendingToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    const message = { role: 'assistant', content: null, tool_calls: pendingToolCalls };
    pendingToolCalls = [];
    attachPendingReasoningToAssistant(message);
    lastAssistantIndex = messages.length;
    messages.push(message);
  };

  const pushFunctionCallOutput = (item) => {
    flushPendingToolCalls();
    const callId = str(item.call_id);
    let output;
    if (typeof item.output === 'string') {
      output = canonicalizeJsonStringIfParseable(item.output);
    } else if (Array.isArray(item.output)) {
      // Content-part array form (mirror of the chat->responses output envelope).
      const texts = [];
      for (const part of item.output) {
        if (!isObj(part)) continue;
        const t =
          part.type === 'input_text' || part.type === 'output_text' || part.type === 'text'
            ? str(part.text)
            : '';
        if (t.length > 0) texts.push(t);
      }
      output = texts.join('\n');
    } else if (item.output !== undefined) {
      output = canonicalJsonString(item.output);
    } else {
      output = '';
    }
    messages.push({ role: 'tool', tool_call_id: callId, content: output });
  };

  const pushCustomToolOutput = (item) => {
    flushPendingToolCalls();
    messages.push({ role: 'tool', tool_call_id: str(item.call_id), content: canonicalJsonString(item) });
  };

  // responses_message_item_to_chat_message
  const messageItemToChatMessage = (item) => {
    const role = responsesRoleToChatRole(str(item.role) || 'user');
    let content = item.content !== undefined ? responsesContentToChatContent(item.content) : null;
    const message = { role, content };
    if (role === 'assistant') {
      appendPendingReasoning(extractReasoningFieldText(item));
      // Inline <think> blocks in history text split into reasoning_content.
      if (typeof content === 'string') {
        const split = splitLeadingThinkBlock(content);
        if (split) {
          if (split[0].length > 0) appendPendingReasoning(split[0]);
          content = split[1];
        }
      }
      attachPendingReasoningToAssistant(message);
    } else {
      attachPendingReasoningToPreviousAssistant();
    }
    message.content = content;
    return message;
  };

  const pushMessageItem = (item) => {
    if (item.role === undefined && item.content === undefined) {
      // inert item: preserves legacy ordering by closing a pending tool-call batch
      flushPendingToolCalls();
      return;
    }
    flushPendingToolCalls();
    const message = messageItemToChatMessage(item);
    updateLastAssistantIndex(message);
    messages.push(message);
  };

  // bare top-level content-part items (input_text / input_image / ...)
  const pushBarePartItem = (item) => {
    flushPendingToolCalls();
    const role = responsesRoleToChatRole(str(item.role) || 'user');
    const message = { role, content: responsesContentToChatContent([item]) };
    if (role === 'assistant') attachPendingReasoningToAssistant(message);
    else attachPendingReasoningToPreviousAssistant();
    updateLastAssistantIndex(message);
    messages.push(message);
  };

  const pushItem = (item) => {
    if (!isObj(item)) return;
    switch (str(item.type)) {
      case 'function_call':
        appendUniquePendingReasoning(extractReasoningFieldText(item));
        pendingToolCalls.push(responsesFunctionCallToChatToolCall(item, ctx));
        return;
      case 'custom_tool_call':
        appendUniquePendingReasoning(extractReasoningFieldText(item));
        pendingToolCalls.push(responsesCustomToolCallToChatToolCall(item));
        return;
      case 'tool_search_call':
        appendUniquePendingReasoning(extractReasoningFieldText(item));
        pendingToolCalls.push(responsesToolSearchCallToChatToolCall(item));
        return;
      case 'function_call_output':
        pushFunctionCallOutput(item);
        return;
      case 'custom_tool_call_output':
      case 'tool_search_output':
        pushCustomToolOutput(item);
        return;
      case 'reasoning':
        appendPendingReasoning(extractReasoningSummaryText(item));
        return;
      case 'input_text':
      case 'input_image':
      case 'input_file':
      case 'input_audio':
        pushBarePartItem(item);
        return;
      case 'message':
        pushMessageItem(item);
        return;
      default:
        pushMessageItem(item);
        return;
    }
  };

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) pushItem(item);
  } else if (isObj(input)) {
    pushItem(input);
  }

  flushPendingToolCalls();
  attachPendingReasoningToPreviousAssistant();
  backfillToolCallReasoningPlaceholders(messages);
}

// transform_codex_chat.rs backfill_tool_call_reasoning_placeholders /
// ensure_tool_call_reasoning_content
function backfillToolCallReasoningPlaceholders(messages) {
  for (const message of messages) {
    const isAssistantToolCall =
      message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!isAssistantToolCall) continue;
    const has = typeof message.reasoning_content === 'string' && message.reasoning_content.trim().length > 0;
    if (!has) message.reasoning_content = 'tool call';
  }
}

// ---------------------------------------------------------------------------
// REQUEST: chat -> responses (derived inverse)
// ---------------------------------------------------------------------------

function chatContentPieces(content) {
  if (typeof content === 'string') {
    return { text: content, parts: [{ type: 'text', text: content }], images: [] };
  }
  if (!Array.isArray(content)) {
    return { text: content === null || content === undefined ? '' : String(content), parts: [], images: [] };
  }
  const texts = [];
  const parts = [];
  const images = [];
  for (const part of content) {
    if (!isObj(part)) continue;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      const t = str(part.text);
      if (t.length > 0) {
        texts.push(t);
        parts.push({ type: 'text', text: t });
      }
    } else if (part.type === 'refusal') {
      const t = str(part.refusal);
      if (t.length > 0) {
        texts.push(t);
        parts.push({ type: 'text', text: t });
      }
    } else if (part.type === 'image_url') {
      images.push(part.image_url);
    }
  }
  return { text: texts.join('\n'), parts, images };
}

function chatRequestToResponses(body) {
  const result = {};
  if (body.model !== undefined) result.model = body.model;

  const input = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let instructionsEmitted = false;

  for (const message of messages) {
    if (!isObj(message)) continue;
    const role = str(message.role) || 'user';
    if (role === 'system' || role === 'developer') {
      if (!instructionsEmitted) {
        const text = chatContentPieces(message.content).text;
        if (text.length > 0) {
          result.instructions = text;
          instructionsEmitted = true;
        }
      }
      continue; // later system/developer messages: Responses input cannot express them
    }
    if (role === 'tool') {
      const content = message.content;
      const text =
        typeof content === 'string' ? content : content === undefined || content === null ? '' : canonicalJsonString(content);
      input.push({
        type: 'function_call_output',
        call_id: str(message.tool_call_id),
        output: [{ type: 'input_text', text }],
      });
      continue;
    }
    if (role === 'assistant') {
      const reasoning = extractReasoningFieldText(message);
      if (reasoning && reasoning.trim().length > 0) {
        input.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning.trim() }] });
      }
      const pieces = chatContentPieces(message.content);
      if (pieces.parts.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: pieces.parts.map((p) => ({ type: 'output_text', text: p.text })),
        });
      } else if (typeof message.content === 'string') {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      }
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const tc of toolCalls) {
        if (!isObj(tc)) continue;
        const fn = isObj(tc.function) ? tc.function : {};
        input.push({
          type: 'function_call',
          call_id: str(tc.id),
          name: str(fn.name),
          arguments: canonicalizeToolArguments(fn.arguments),
        });
      }
      continue;
    }
    // user (and any other role) -> message item
    const pieces = chatContentPieces(message.content);
    const content = [];
    for (const p of pieces.parts) content.push({ type: 'input_text', text: p.text });
    for (const image of pieces.images) content.push({ type: 'input_image', image_url: image });
    if (content.length === 0 && typeof message.content !== 'string') continue;
    input.push({ type: 'message', role: 'user', content });
  }

  if (input.length === 0) {
    throw new ConversionError('chat request has no messages convertible to responses');
  }
  result.input = input;

  if (body.max_tokens !== undefined) result.max_output_tokens = body.max_tokens;
  else if (body.max_completion_tokens !== undefined) result.max_output_tokens = body.max_completion_tokens;

  for (const key of ['temperature', 'top_p', 'stream']) {
    if (body[key] !== undefined) result[key] = body[key];
  }
  // `stop` and `stream_options` have no Responses equivalent — dropped.
  // Effort clamps mirror the responses->chat direction (extended tiers -> 'xhigh').

  const effort = str(body.reasoning_effort).trim();
  if (effort.length > 0) {
    const mapped = mapResponsesReasoningEffort(effort);
    if (mapped !== null) result.reasoning = { effort: mapped };
  }

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const flatTools = [];
  const seen = new Set();
  for (const tool of tools) {
    if (!isObj(tool)) continue;
    const fn = isObj(tool.function) ? tool.function : tool;
    const name = str(fn.name).trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    const flat = { type: 'function', name };
    if (typeof fn.description === 'string' && fn.description.length > 0) flat.description = fn.description;
    flat.parameters = isObj(fn.parameters) ? fn.parameters : { type: 'object', properties: {} };
    flatTools.push(flat);
  }
  if (flatTools.length > 0) {
    result.tools = flatTools;
    if (body.tool_choice !== undefined) {
      const tc = body.tool_choice;
      if (typeof tc === 'string') result.tool_choice = tc;
      else if (isObj(tc) && str(tc.type) === 'function') {
        const name = (isObj(tc.function) ? str(tc.function.name) : '') || str(tc.name);
        result.tool_choice = { type: 'function', name };
      } else if (isObj(tc)) {
        result.tool_choice = tc;
      }
    }
    if (body.parallel_tool_calls !== undefined) result.parallel_tool_calls = body.parallel_tool_calls;
  }

  return result;
}

// ---------------------------------------------------------------------------
// RESPONSE: chat -> responses (chat_completion_to_response_with_context)
// ---------------------------------------------------------------------------

// transform_codex_chat.rs chat_reasoning_text
function chatReasoningText(message) {
  const field = extractReasoningFieldText(message);
  if (field) return field;
  if (typeof message.content === 'string') {
    const split = splitLeadingThinkBlock(message.content);
    if (split && split[0].length > 0) return split[0];
  }
  return null;
}

function chatReasoningToResponseOutputItem(reasoning, responseId) {
  if (!reasoning || reasoning.length === 0) return null;
  return {
    id: 'rs_' + responseId,
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: reasoning }],
  };
}

// codex_chat_common.rs response_function_call_item (namespace/custom reduced away)
function responseFunctionCallItem(itemId, status, callId, name, args, reasoning) {
  const item = { id: itemId, type: 'function_call', status, call_id: callId, name, arguments: args };
  const r = reasoning ? reasoning.trim() : '';
  if (r.length > 0) item.reasoning_content = r;
  return item;
}

function chatToolCallToResponseItem(toolCall, index, reasoning) {
  const rawId = str(toolCall.id);
  const callId = rawId.length > 0 ? rawId : 'call_' + index;
  const fn = isObj(toolCall.function) ? toolCall.function : {};
  const name = str(fn.name);
  const args = canonicalizeToolArguments(fn.arguments);
  return responseFunctionCallItem('fc_' + callId, 'completed', callId, name, args, reasoning);
}

function chatLegacyFunctionCallToResponseItem(functionCall, reasoning) {
  const callId = str(functionCall.id) || 'call_0';
  const name = str(functionCall.name);
  if (name.trim().length === 0) return null;
  const args = canonicalizeToolArguments(functionCall.arguments);
  return responseFunctionCallItem('fc_' + callId, 'completed', callId, name, args, reasoning);
}

function chatToolCallsToResponseOutputItems(message, reasoning) {
  const items = [];
  let dropped = 0;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : null;
  if (toolCalls) {
    toolCalls.forEach((toolCall, index) => {
      const fn = isObj(toolCall?.function) ? toolCall.function : {};
      const name = str(fn.name);
      if (name.trim().length === 0) {
        dropped += 1;
        return;
      }
      items.push(chatToolCallToResponseItem(toolCall, index, reasoning));
    });
  } else if (isObj(message.function_call)) {
    const item = chatLegacyFunctionCallToResponseItem(message.function_call, reasoning);
    if (item) items.push(item);
    else dropped += 1;
  }
  return { items, dropped };
}

// Task-spec item id (`_msg_0`); upstream Rust uses `{response_id}_msg`.
function chatMessageToResponseOutputItem(message, responseId) {
  const content = [];
  if (typeof message.content === 'string') {
    const split = splitLeadingThinkBlock(message.content);
    const answer = split ? split[1] : message.content;
    if (answer.length > 0) content.push({ type: 'output_text', text: answer, annotations: [] });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const t = isObj(part) ? str(part.type) : '';
      if (t === 'text' || t === 'output_text') {
        const text = str(part.text);
        if (text.length > 0) content.push({ type: 'output_text', text, annotations: [] });
      } else if (t === 'refusal') {
        const text = str(part.refusal);
        if (text.length > 0) content.push({ type: 'refusal', refusal: text });
      }
    }
  }
  const refusal = str(message.refusal);
  if (refusal.length > 0) content.push({ type: 'refusal', refusal });
  if (content.length === 0) return null;
  return {
    id: responseId + '_msg_0',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content,
  };
}

function chatResponseToResponses(body) {
  const choices = Array.isArray(body.choices) ? body.choices : null;
  if (!choices || choices.length === 0) throw new ConversionError('No choices in chat response');
  const choice = choices[0];
  if (!isObj(choice) || !isObj(choice.message)) throw new ConversionError('No message in chat choice');
  const message = choice.message;

  const responseId = responseIdFromChatId(typeof body.id === 'string' ? body.id : null);
  const model = typeof body.model === 'string' ? body.model : '';
  const createdAt = u64(body.created) ?? 0;
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;

  const reasoning = chatReasoningText(message);
  const output = [];
  const reasoningItem = chatReasoningToResponseOutputItem(reasoning, responseId);
  if (reasoningItem) output.push(reasoningItem);
  const messageItem = chatMessageToResponseOutputItem(message, responseId);
  if (messageItem) output.push(messageItem);

  const toolCalls = chatToolCallsToResponseOutputItems(message, reasoning);
  const status = responseStatusFromFinishReason(finishReason);
  if (status === 'completed' && toolCalls.dropped > 0 && toolCalls.items.length === 0) {
    throw new ConversionError(
      'Upstream returned ' + toolCalls.dropped + ' tool call(s) without a function name, ' +
        'leaving no usable tool call in this turn'
    );
  }
  for (const item of toolCalls.items) output.push(item);

  const resp = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output,
    usage: chatUsageToResponsesUsage(isObj(body.usage) ? body.usage : null),
  };
  if (finishReason === 'length') resp.incomplete_details = { reason: 'max_output_tokens' };
  return resp;
}

// ---------------------------------------------------------------------------
// RESPONSE: responses -> chat (derived inverse)
// ---------------------------------------------------------------------------

function responsesResponseToChat(body) {
  if (body.error !== undefined && body.error !== null) {
    const err = isObj(body.error) ? body.error : {};
    throw new ConversionError(str(err.message) || 'Upstream Responses turn failed');
  }
  const status = str(body.status);
  if (status === 'failed') {
    const err = isObj(body.error) ? body.error : {};
    throw new ConversionError(str(err.message) || 'Upstream Responses turn failed');
  }
  const output = Array.isArray(body.output) ? body.output : null;
  if (output === null) throw new ConversionError('No output in responses response');

  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];
  for (const item of output) {
    if (!isObj(item)) continue;
    const type = str(item.type);
    if (type === 'message') {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (!isObj(part)) continue;
        if (part.type === 'output_text' || part.type === 'text') {
          const t = str(part.text);
          if (t.length > 0) textParts.push(t);
        } else if (part.type === 'refusal') {
          const t = str(part.refusal);
          if (t.length > 0) textParts.push(t);
        }
        // other content parts: skipped (text-path conversion)
      }
    } else if (type === 'reasoning') {
      const t = extractReasoningSummaryText(item);
      if (t) reasoningParts.push(t);
    } else if (type === 'function_call') {
      toolCalls.push({
        id: str(item.call_id) || str(item.id),
        type: 'function',
        function: { name: str(item.name), arguments: canonicalizeToolArguments(item.arguments) },
      });
    } else {
      const k = type || 'item';
      throw new ConversionError('upstream response contains non-text output (' + k + ')');
    }
  }

  const message = { role: 'assistant' };
  const reasoningText = reasoningParts.join('\n\n');
  if (reasoningText.length > 0) message.reasoning_content = reasoningText;
  if (textParts.length === 1) message.content = textParts[0];
  else if (textParts.length > 1) message.content = textParts.map((t) => ({ type: 'text', text: t }));
  else if (toolCalls.length > 0) message.content = null;
  else message.content = '';
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const incomplete =
    status === 'incomplete' ||
    (isObj(body.incomplete_details) && body.incomplete_details.reason === 'max_output_tokens');
  const finishReason = incomplete ? 'length' : toolCalls.length > 0 ? 'tool_calls' : 'stop';

  return {
    id: typeof body.id === 'string' ? body.id : '',
    object: 'chat.completion',
    created: u64(body.created_at) ?? 0,
    model: typeof body.model === 'string' ? body.model : '',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: responsesUsageToChatUsage(isObj(body.usage) ? body.usage : null),
  };
}

// ---------------------------------------------------------------------------
// SSE envelope builders (codex_responses_sse.rs — exact Responses wire bytes)
// ---------------------------------------------------------------------------

function sseEvent(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

function envResponseCreated(response) {
  return sseEvent('response.created', { type: 'response.created', response });
}
function envResponseInProgress(response) {
  return sseEvent('response.in_progress', { type: 'response.in_progress', response });
}
function envResponseCompleted(response) {
  return sseEvent('response.completed', { type: 'response.completed', response });
}
function envResponseFailed(response) {
  return sseEvent('response.failed', { type: 'response.failed', response });
}
function envOutputItemAdded(outputIndex, item) {
  return sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item });
}
function envOutputItemDone(outputIndex, item) {
  return sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
}
function envMessageItemAdded(outputIndex, itemId) {
  return envOutputItemAdded(outputIndex, {
    id: itemId,
    type: 'message',
    status: 'in_progress',
    role: 'assistant',
    content: [],
  });
}
function envMessageContentPartAdded(outputIndex, itemId) {
  return sseEvent('response.content_part.added', {
    type: 'response.content_part.added',
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
}
function envOutputTextDelta(outputIndex, itemId, delta) {
  return sseEvent('response.output_text.delta', {
    type: 'response.output_text.delta',
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    delta,
  });
}
function envMessageItem(itemId, text) {
  return {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}
function envMessageClose(outputIndex, itemId, text) {
  const item = envMessageItem(itemId, text);
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
    envOutputItemDone(outputIndex, item);
  return { events, item };
}
function envReasoningItemAdded(outputIndex, itemId) {
  return envOutputItemAdded(outputIndex, {
    id: itemId,
    type: 'reasoning',
    status: 'in_progress',
    summary: [],
  });
}
function envReasoningSummaryPartAdded(outputIndex, itemId) {
  return sseEvent('response.reasoning_summary_part.added', {
    type: 'response.reasoning_summary_part.added',
    item_id: itemId,
    output_index: outputIndex,
    summary_index: 0,
    part: { type: 'summary_text', text: '' },
  });
}
function envReasoningSummaryTextDelta(outputIndex, itemId, delta) {
  return sseEvent('response.reasoning_summary_text.delta', {
    type: 'response.reasoning_summary_text.delta',
    item_id: itemId,
    output_index: outputIndex,
    summary_index: 0,
    delta,
  });
}
// Completed reasoning item carries no `status` field (matches both upstream converters).
function envReasoningItem(itemId, text) {
  return { id: itemId, type: 'reasoning', summary: [{ type: 'summary_text', text }] };
}
function envReasoningClose(outputIndex, itemId, text) {
  const item = envReasoningItem(itemId, text);
  const events =
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
    }) +
    envOutputItemDone(outputIndex, item);
  return { events, item };
}
function envFunctionCallArgumentsDelta(outputIndex, itemId, delta) {
  return sseEvent('response.function_call_arguments.delta', {
    type: 'response.function_call_arguments.delta',
    item_id: itemId,
    output_index: outputIndex,
    delta,
  });
}
function envFunctionCallArgumentsDone(outputIndex, itemId, args) {
  return sseEvent('response.function_call_arguments.done', {
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    output_index: outputIndex,
    arguments: args,
  });
}

// ---------------------------------------------------------------------------
// SSE: chat -> responses (streaming_codex_chat.rs state machine)
// ---------------------------------------------------------------------------

function createChatToResponsesState() {
  const st = {
    responseStarted: false,
    completed: false,
    failed: false, // mirrors Rust breaking out of the stream loop after an error frame
    responseId: 'resp_ccswitch',
    model: '',
    createdAt: 0,
    nextOutputIndex: 0,
    text: { outputIndex: null, itemId: '', text: '', added: false, done: false },
    reasoning: { outputIndex: null, itemId: '', text: '', added: false, done: false },
    inlineThink: { mode: 'detecting', buffer: '' }, // detecting | reasoning | text
    tools: new Map(), // chat index -> tool state
    nextToolIndexToAdd: 0,
    outputItems: [], // [outputIndex, completed item]
    latestUsage: null,
    finishReason: null,
    droppedToolCalls: 0,
  };

  const nextOutputIndex = () => {
    const index = st.nextOutputIndex;
    st.nextOutputIndex += 1;
    return index;
  };

  const sortedToolKeys = () => [...st.tools.keys()].sort((a, b) => a - b);

  const baseResponse = (status, output) => ({
    id: st.responseId,
    object: 'response',
    created_at: st.createdAt,
    status,
    model: st.model,
    output,
    usage: st.latestUsage ?? chatUsageToResponsesUsage(null),
  });

  const completedOutputItems = () =>
    st.outputItems
      .slice()
      .sort((a, b) => a[0] - b[0])
      .map(([, item]) => item);

  const failedEvent = (message, errorType) => {
    st.completed = true;
    const error = { message };
    if (errorType && errorType.length > 0) error.type = errorType;
    const response = baseResponse('failed', completedOutputItems());
    response.error = error;
    return envResponseFailed(response);
  };

  const ensureResponseStarted = () => {
    if (st.responseStarted) return '';
    st.responseStarted = true;
    const response = baseResponse('in_progress', []);
    return envResponseCreated(response) + envResponseInProgress(response);
  };

  const pushReasoningDelta = (delta) => {
    let events = '';
    if (!st.reasoning.added) {
      const outputIndex = nextOutputIndex();
      const itemId = 'rs_' + st.responseId;
      st.reasoning.outputIndex = outputIndex;
      st.reasoning.itemId = itemId;
      st.reasoning.added = true;
      events += envReasoningItemAdded(outputIndex, itemId);
      events += envReasoningSummaryPartAdded(outputIndex, itemId);
    }
    st.reasoning.text += delta;
    events += envReasoningSummaryTextDelta(st.reasoning.outputIndex ?? 0, st.reasoning.itemId, delta);
    return events;
  };

  const pushTextDelta = (delta) => {
    let events = '';
    if (!st.text.added) {
      const outputIndex = nextOutputIndex();
      const itemId = st.responseId + '_msg';
      st.text.outputIndex = outputIndex;
      st.text.itemId = itemId;
      st.text.added = true;
      events += envMessageItemAdded(outputIndex, itemId);
      events += envMessageContentPartAdded(outputIndex, itemId);
    }
    st.text.text += delta;
    events += envOutputTextDelta(st.text.outputIndex ?? 0, st.text.itemId, delta);
    return events;
  };

  const currentReasoningText = () => {
    const trimmed = st.reasoning.text.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  // leading_think_prefix_decision
  const leadingThinkPrefixDecision = (buffer) => {
    const trimmed = buffer.trimStart();
    if (trimmed.length === 0) return 'need_more';
    if (trimmed.startsWith(THINK_OPEN_TAG)) return 'reasoning';
    if (THINK_OPEN_TAG.startsWith(trimmed)) return 'need_more';
    return 'text';
  };

  const drainCompleteInlineThink = () => {
    const split = splitLeadingThinkBlock(st.inlineThink.buffer);
    if (!split) return '';
    st.inlineThink.mode = 'text';
    st.inlineThink.buffer = '';
    let events = '';
    if (split[0].length > 0) {
      events += pushReasoningDelta(split[0]);
      events += finalizeReasoning();
    }
    if (split[1].length > 0) events += pushTextDelta(split[1]);
    return events;
  };

  const flushInlineThinkAtBoundary = () => {
    if (st.inlineThink.mode === 'text') return '';
    if (st.inlineThink.mode === 'detecting') {
      st.inlineThink.mode = 'text';
      const text = st.inlineThink.buffer;
      st.inlineThink.buffer = '';
      if (text.length === 0) return '';
      let events = finalizeReasoning();
      events += pushTextDelta(text);
      return events;
    }
    // reasoning mode: close the inline block even without a </think> terminator
    const buffered = st.inlineThink.buffer;
    st.inlineThink.buffer = '';
    st.inlineThink.mode = 'text';
    const split = splitLeadingThinkBlock(buffered);
    if (split) {
      let events = '';
      if (split[0].length > 0) {
        events += pushReasoningDelta(split[0]);
        events += finalizeReasoning();
      }
      if (split[1].length > 0) events += pushTextDelta(split[1]);
      return events;
    }
    const reasoning = stripLeadingThinkOpenTag(buffered) ?? buffered;
    if (reasoning.length === 0) return '';
    let events = pushReasoningDelta(reasoning);
    events += finalizeReasoning();
    return events;
  };

  const pushContentDelta = (delta) => {
    if (st.inlineThink.mode === 'text') {
      let events = finalizeReasoning();
      events += pushTextDelta(delta);
      return events;
    }
    if (st.inlineThink.mode === 'detecting') {
      st.inlineThink.buffer += delta;
      const decision = leadingThinkPrefixDecision(st.inlineThink.buffer);
      if (decision === 'need_more') return '';
      if (decision === 'reasoning') {
        st.inlineThink.mode = 'reasoning';
        return drainCompleteInlineThink();
      }
      st.inlineThink.mode = 'text';
      const text = st.inlineThink.buffer;
      st.inlineThink.buffer = '';
      let events = finalizeReasoning();
      events += pushTextDelta(text);
      return events;
    }
    st.inlineThink.buffer += delta;
    return drainCompleteInlineThink();
  };

  // resolve_tool_key_without_index: without `index`, only split when a new distinct id
  // proves a new call; otherwise collapse into the last known key (or 0).
  const resolveToolKeyWithoutIndex = (toolCall) => {
    const keys = sortedToolKeys();
    const lastKey = keys.length > 0 ? keys[keys.length - 1] : null;
    const id = typeof toolCall?.id === 'string' && toolCall.id.length > 0 ? toolCall.id : null;
    if (id === null) return lastKey ?? 0;
    for (const key of keys) {
      if (st.tools.get(key).callId === id) return key;
    }
    return lastKey === null ? 0 : lastKey + 1;
  };

  const toolStateFor = (chatIndex) => {
    let state = st.tools.get(chatIndex);
    if (!state) {
      state = {
        outputIndex: null,
        itemId: '',
        callId: '',
        name: '',
        arguments: '',
        reasoningContent: '',
        added: false,
        done: false,
      };
      st.tools.set(chatIndex, state);
    }
    return state;
  };

  const functionCallItemFor = (state, status) => {
    const item = {
      id: state.itemId,
      type: 'function_call',
      status,
      call_id: state.callId,
      name: state.name,
      arguments: status === 'completed' ? undefined : '',
    };
    if (status === 'completed') item.arguments = canonicalizeToolArguments(state.arguments);
    const r = state.reasoningContent.trim();
    if (r.length > 0) item.reasoning_content = r;
    return item;
  };

  // flush_ready_tool_calls: release consecutive chat indexes in order once id+name known.
  const flushReadyToolCalls = () => {
    let events = '';
    for (;;) {
      const key = st.nextToolIndexToAdd;
      const state = st.tools.get(key);
      if (!state) break;
      if (state.added || state.done) {
        st.nextToolIndexToAdd += 1;
        continue;
      }
      if (state.callId.length === 0 || state.name.length === 0) break;
      const assigned = nextOutputIndex();
      state.added = true;
      state.outputIndex = assigned;
      state.itemId = 'fc_' + state.callId;
      events += envOutputItemAdded(assigned, functionCallItemFor(state, 'in_progress'));
      if (state.arguments.length > 0) {
        events += envFunctionCallArgumentsDelta(assigned, state.itemId, state.arguments);
      }
      st.nextToolIndexToAdd += 1;
    }
    return events;
  };

  const appendReasoningToActiveTools = (delta) => {
    if (delta.trim().length === 0) return;
    for (const state of st.tools.values()) {
      if (state.done) continue;
      if (state.reasoningContent.length === 0) state.reasoningContent = delta.trimStart();
      else state.reasoningContent += delta;
    }
  };

  const pushToolCallDelta = (toolCall, reasoning) => {
    const idx = u64(toolCall?.index);
    const chatIndex = idx !== null ? idx : resolveToolKeyWithoutIndex(toolCall);
    const idDelta = typeof toolCall?.id === 'string' ? toolCall.id : null;
    const fn = isObj(toolCall?.function) ? toolCall.function : {};
    const nameDelta = typeof fn.name === 'string' ? fn.name : null;
    const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : '';

    const state = toolStateFor(chatIndex);
    if (idDelta !== null && idDelta.length > 0) state.callId = idDelta;
    if (nameDelta !== null && nameDelta.length > 0) state.name = nameDelta;
    if (argsDelta.length > 0) state.arguments += argsDelta;
    if (state.reasoningContent.length === 0 && reasoning && reasoning.trim().length > 0) {
      state.reasoningContent = reasoning.trim();
    }

    let events = '';
    if (argsDelta.length > 0 && state.added) {
      events += envFunctionCallArgumentsDelta(state.outputIndex ?? 0, state.itemId, argsDelta);
    }
    events += flushReadyToolCalls();
    return events;
  };

  const finalizeReasoning = () => {
    if (!st.reasoning.added || st.reasoning.done) return '';
    const { events, item } = envReasoningClose(st.reasoning.outputIndex ?? 0, st.reasoning.itemId, st.reasoning.text);
    st.outputItems.push([st.reasoning.outputIndex ?? 0, item]);
    st.reasoning.done = true;
    return events;
  };

  const finalizeText = () => {
    if (!st.text.added || st.text.done) return '';
    const { events, item } = envMessageClose(st.text.outputIndex ?? 0, st.text.itemId, st.text.text);
    st.outputItems.push([st.text.outputIndex ?? 0, item]);
    st.text.done = true;
    return events;
  };

  const finalizeTools = () => {
    let events = '';
    for (const key of sortedToolKeys()) {
      const state = st.tools.get(key);
      if (!state || state.done) continue;
      // Missing / blank function name: drop and count (defensive, matches upstream).
      if (state.name.trim().length === 0) {
        state.done = true;
        st.droppedToolCalls += 1;
        continue;
      }
      if (!state.added) {
        const assigned = nextOutputIndex();
        state.added = true;
        if (state.callId.length === 0) state.callId = 'call_' + key;
        state.outputIndex = assigned;
        state.itemId = 'fc_' + state.callId;
        events += envOutputItemAdded(assigned, functionCallItemFor(state, 'in_progress'));
      }
      const outputIndex = state.outputIndex ?? 0;
      const item = functionCallItemFor(state, 'completed');
      state.done = true;
      st.outputItems.push([outputIndex, item]);
      events += envFunctionCallArgumentsDone(outputIndex, state.itemId, item.arguments);
      events += envOutputItemDone(outputIndex, item);
    }
    return events;
  };

  const hasEmittedToolCall = () => st.outputItems.some(([, item]) => item.type === 'function_call');

  const hasSubstantiveOutput = () => {
    if (st.text.text.trim().length > 0) return true;
    if (st.reasoning.text.trim().length > 0) return true;
    if (st.inlineThink.buffer.trim().length > 0) return true;
    if (st.outputItems.length > 0) return true;
    for (const s of st.tools.values()) {
      if (
        s.added ||
        s.callId.trim().length > 0 ||
        s.name.trim().length > 0 ||
        s.arguments.trim().length > 0 ||
        s.reasoningContent.trim().length > 0
      ) {
        return true;
      }
    }
    return false;
  };

  const finalize = () => {
    if (st.completed) return '';
    let events = ensureResponseStarted();
    events += flushInlineThinkAtBoundary();
    events += finalizeReasoning();
    events += finalizeText();
    events += finalizeTools();

    const status = responseStatusFromFinishReason(st.finishReason);
    // All tool calls dropped on an otherwise-completed turn: report honestly (#4341).
    if (status === 'completed' && st.droppedToolCalls > 0 && !hasEmittedToolCall()) {
      events += failedEvent(
        'Upstream returned ' + st.droppedToolCalls + ' tool call(s) without a function name, ' +
          'leaving no usable tool call in this turn',
        'upstream_tool_call_dropped'
      );
      return events;
    }

    const response = baseResponse(status, completedOutputItems());
    if (status === 'incomplete') response.incomplete_details = { reason: 'max_output_tokens' };
    events += envResponseCompleted(response);
    st.completed = true;
    return events;
  };

  const handleChatChunk = (chunk) => {
    if (!isObj(chunk)) return '';
    let events = '';
    if (typeof chunk.id === 'string') st.responseId = responseIdFromChatId(chunk.id);
    if (typeof chunk.model === 'string' && chunk.model.length > 0) st.model = chunk.model;
    const created = u64(chunk.created);
    if (created !== null) st.createdAt = created;

    events += ensureResponseStarted();

    if (chunk.usage !== undefined && chunk.usage !== null) {
      st.latestUsage = chatUsageToResponsesUsage(chunk.usage);
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!isObj(choice)) return events;

    const delta = choice.delta;
    if (isObj(delta)) {
      const reasoning = extractReasoningFieldText(delta);
      if (reasoning) {
        events += pushReasoningDelta(reasoning);
        appendReasoningToActiveTools(reasoning);
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        events += pushContentDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        // finalize reasoning BEFORE tool calls start (upstream finalize_reasoning(first))
        events += flushInlineThinkAtBoundary();
        const reasoningForToolCall = currentReasoningText();
        events += finalizeReasoning();
        for (const toolCall of delta.tool_calls) {
          events += pushToolCallDelta(toolCall, reasoningForToolCall);
        }
      }
    }

    if (typeof choice.finish_reason === 'string') st.finishReason = choice.finish_reason;
    return events;
  };

  return { st, handleChatChunk, finalize, failedEvent, hasSubstantiveOutput };
}

// streaming_codex_chat.rs extract_chat_sse_error
function extractChatSseError(value) {
  const error = isObj(value) && value.error !== undefined ? value.error : value;
  let message;
  if (typeof error === 'string') message = error;
  else if (isObj(error)) {
    message =
      (typeof error.message === 'string' && error.message) ||
      (typeof error.detail === 'string' && error.detail) ||
      null;
    if (message === null) message = canonicalJsonString(error);
  } else {
    message = String(error);
  }
  const errorType = isObj(error)
    ? (typeof error.type === 'string' && error.type) || (typeof error.code === 'string' && error.code) || null
    : null;
  return [message, errorType];
}

function createChatToResponsesSse() {
  const utf8 = createUtf8Buffer();
  let buffer = '';
  let closed = false;
  const machine = createChatToResponsesState();

  function feed(text) {
    if (machine.st.failed) return '';
    buffer += text;
    let out = '';
    let block;
    while ((block = takeSseBlock(buffer)) !== null) {
      buffer = block.rest;
      if (block.block.trim().length === 0) continue;
      const parsed = parseEventBlock(block.block);
      if (isDoneData(parsed.dataText)) {
        out += machine.finalize();
        continue;
      }
      if (!parsed.parsed) continue;
      // Terminal frame already emitted ([DONE] finalize or failure): the legacy
      // converter ignores any trailing upstream frames after it.
      if (machine.st.completed) continue;
      const chunk = parsed.data;
      if (parsed.event === 'error' || (isObj(chunk) && chunk.error !== undefined)) {
        const [message, errorType] = extractChatSseError(chunk);
        out += machine.failedEvent(message, errorType);
        machine.st.failed = true;
        return out; // upstream breaks the stream loop on error frames
      }
      out += machine.handleChatChunk(chunk);
    }
    return out;
  }

  return {
    push(chunk) {
      if (closed || machine.st.failed) return '';
      utf8.push(chunk);
      // Drain decoded text only when no partial UTF-8 sequence is pending.
      let out = '';
      if (utf8.getPending().length === 0) out = feed(utf8.end());
      return out;
    },
    end() {
      if (closed) return '';
      closed = true;
      let out = '';
      if (machine.st.failed) return out;
      out += feed(utf8.end());
      if (machine.st.failed) return out;
      if (machine.st.completed || machine.st.finishReason !== null) {
        out += machine.finalize();
      } else if (machine.hasSubstantiveOutput()) {
        // Stream cut without finish_reason: synthesize `length`, never fake completed.
        machine.st.finishReason = 'length';
        out += machine.finalize();
      } else {
        out += machine.failedEvent(
          'Upstream Chat Completions stream ended before sending finish_reason',
          'stream_truncated'
        );
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// SSE: responses -> chat (derived inverse — bare data: lines, [DONE] terminator)
// ---------------------------------------------------------------------------

function createResponsesToChatSse() {
  const utf8 = createUtf8Buffer();
  let buffer = '';
  let closed = false;
  let terminated = false;
  let substantive = false; // any content / reasoning / tool delta emitted
  let sawToolCalls = false;
  let toolIndex = 0;
  const itemIdToIndex = new Map();
  const indexToCallId = new Map();
  let latestUsage = null;

  const chatLine = (data) => 'data: ' + JSON.stringify(data) + '\n\n';

  const resolveToolIndex = (itemId) => {
    if (itemId && itemIdToIndex.has(itemId)) return itemIdToIndex.get(itemId);
    return toolIndex > 0 ? toolIndex - 1 : 0;
  };

  const emitToolFragment = (index, entry) => {
    substantive = true;
    return chatLine({ choices: [{ index: 0, delta: { tool_calls: [entry] } }] });
  };

  const errorLine = (message, type) => {
    terminated = true;
    const error = { message };
    if (type && type.length > 0) error.type = type;
    return chatLine({ error }) + 'data: [DONE]\n\n';
  };

  const finishLine = (response, forceIncomplete) => {
    if (terminated) return '';
    terminated = true;
    const status = str(response?.status);
    if (status === 'failed') {
      const err = isObj(response?.error) ? response.error : {};
      return errorLine(str(err.message) || 'Upstream Responses turn failed', str(err.type) || 'upstream_error');
    }
    const incomplete =
      forceIncomplete ||
      status === 'incomplete' ||
      (isObj(response?.incomplete_details) && response.incomplete_details.reason === 'max_output_tokens');
    const finish = incomplete ? 'length' : sawToolCalls ? 'tool_calls' : 'stop';
    const chunk = { choices: [{ index: 0, delta: {}, finish_reason: finish }] };
    if (latestUsage) chunk.usage = responsesUsageToChatUsage(latestUsage);
    return chatLine(chunk) + 'data: [DONE]\n\n';
  };

  function handleEvent(parsed) {
    if (terminated || !isObj(parsed.data)) return '';
    const data = parsed.data;
    const type = parsed.event || str(data.type);
    switch (type) {
      case 'response.created':
      case 'response.in_progress':
        return ''; // capture-only: id/model are not echoed into chat delta chunks
      case 'response.output_item.added': {
        const item = isObj(data.item) ? data.item : {};
        if (str(item.type) !== 'function_call') return '';
        const index = toolIndex;
        toolIndex += 1;
        const itemId = str(item.id);
        if (itemId.length > 0) itemIdToIndex.set(itemId, index);
        const callId = str(item.call_id) || itemId;
        if (callId.length > 0) indexToCallId.set(index, callId);
        sawToolCalls = true;
        return emitToolFragment(index, {
          index,
          id: callId,
          type: 'function',
          function: { name: str(item.name) },
        });
      }
      case 'response.output_text.delta': {
        const delta =
          typeof data.delta === 'string' ? data.delta : isObj(data.delta) ? str(data.delta.text) : '';
        if (delta.length === 0) return '';
        substantive = true;
        return chatLine({ choices: [{ index: 0, delta: { content: delta } }] });
      }
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta': {
        const delta = typeof data.delta === 'string' ? data.delta : '';
        if (delta.length === 0) return '';
        const index = resolveToolIndex(str(data.item_id));
        return emitToolFragment(index, { index, type: 'function', function: { arguments: delta } });
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = typeof data.delta === 'string' ? data.delta : '';
        if (delta.length === 0) return '';
        substantive = true;
        return chatLine({ choices: [{ index: 0, delta: { reasoning_content: delta } }] });
      }
      case 'response.completed':
      case 'response.done': {
        const response = isObj(data.response) ? data.response : {};
        if (isObj(response.usage)) latestUsage = response.usage;
        return finishLine(response, false);
      }
      case 'response.incomplete': {
        const response = isObj(data.response) ? data.response : {};
        if (isObj(response.usage)) latestUsage = response.usage;
        return finishLine(response, true);
      }
      case 'response.failed': {
        const response = isObj(data.response) ? data.response : {};
        const err = isObj(response.error) ? response.error : {};
        return errorLine(str(err.message) || 'Upstream Responses turn failed', str(err.type) || 'upstream_error');
      }
      default:
        // top-level error payloads (non-standard upstreams)
        if (data.error !== undefined) {
          const err = isObj(data.error) ? data.error : {};
          return errorLine(
            str(err.message) || canonicalJsonString(err),
            str(err.type) || 'upstream_error'
          );
        }
        return '';
    }
  }

  function feed(text) {
    if (terminated) return '';
    buffer += text;
    let out = '';
    let block;
    while ((block = takeSseBlock(buffer)) !== null) {
      buffer = block.rest;
      if (block.block.trim().length === 0) continue;
      const parsed = parseEventBlock(block.block);
      if (isDoneData(parsed.dataText)) continue; // responses upstreams do not send [DONE]
      if (!parsed.parsed) continue;
      out += handleEvent(parsed);
      if (terminated) break;
    }
    return out;
  }

  return {
    push(chunk) {
      if (closed || terminated) return '';
      utf8.push(chunk);
      let out = '';
      if (utf8.getPending().length === 0) out = feed(utf8.end());
      return out;
    },
    end() {
      if (closed) return '';
      closed = true;
      if (terminated) return '';
      const out = feed(utf8.end());
      if (terminated) return out;
      // Stream truncated without a terminal event: never fake silent success.
      if (substantive) {
        terminated = true;
        return out + chatLine({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) + 'data: [DONE]\n\n';
      }
      return out + errorLine('Upstream Responses stream ended before completion', 'stream_truncated');
    },
  };
}

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

export function request(from, to, body) {
  const b = body ?? {};
  if (from === 'responses' && to === 'chat') return responsesRequestToChat(b);
  if (from === 'chat' && to === 'responses') return chatRequestToResponses(b);
  throw new ConversionError('unsupported request direction: ' + from + ' -> ' + to);
}

// from = upstream wire format, to = local format.
export function response(from, to, body) {
  const b = body ?? {};
  if (from === 'chat' && to === 'responses') return chatResponseToResponses(b);
  if (from === 'responses' && to === 'chat') return responsesResponseToChat(b);
  throw new ConversionError('unsupported response direction: ' + from + ' -> ' + to);
}

export function createSse(from, to) {
  if (from === 'chat' && to === 'responses') return createChatToResponsesSse();
  if (from === 'responses' && to === 'chat') return createResponsesToChatSse();
  throw new ConversionError('unsupported SSE direction: ' + from + ' -> ' + to);
}
