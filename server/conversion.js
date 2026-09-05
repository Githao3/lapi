// Three-format conversion for the local gateway.

 export class ConversionError extends Error {}
 
 function parseContent(content) {
   if (content === undefined || content === null) return '';
   if (typeof content === 'string') return content;
   if (Array.isArray(content)) {
     const texts = [];
     for (const c of content) {
       if (c && c.type === 'text') {
         const t = String(c.text ?? '');
         if (t) texts.push(t);
       } else {
         const k = c && c.type ? c.type : typeof c;
         throw new ConversionError('conversion covers text blocks only, found ' + k);
       }
     }
     return texts.join('\n');
   }
   throw new ConversionError('unrecognized message content shape');
 }
 
 // Read a request body in the given format and normalize it to a canonical text-chat shape..
 export function importRequest(body, fmt) {
   const b = body ?? {};
   const model = String(b.model ?? '');
   if (!model) throw new ConversionError('missing model field');
   if ((b.tools ?? []).length > 0) {
     throw new ConversionError('tool calls are not supportedin v1 conversion');
   }
   let system = '';
   if (b.system !== undefined) system = String(b.system);
   else if (b.instructions !== undefined) system = String(b.instructions);
   let messages = [];
   if (fmt === 'messages' || fmt === 'chat') {
     const msgs = Array.isArray(b.messages) ? b.messages : [];
     const sys = [];
     const rest = [];
     for (const m of msgs) {
       const role = String((m && m.role) ?? 'user');
       const content = parseContent(m && m.content);
       if (role === 'system') sys.push(content); else rest.push({ role, content });
     }
     if (sys.length) system = (system ? system + '\n' : '') + sys.join('\n');
     messages = rest;
   } else if (fmt === 'responses') {
     const input = b.input ?? [];
     if (typeof input === 'string') {
       messages = [{ role: 'user', content: input }];
     } else if (Array.isArray(input)) {
       for (const it of input) {
         const role = String((it && it.role) ?? 'user');
         messages.push({ role, content: parseContent(it && it.content) });
       }
     } else {
       throw new ConversionError('responses input must be a string or an array');
     }
   } else {
     throw new ConversionError('unknown format ' + fmt);
   }
   const canon = { model, messages };
   if (system) canon.system = system;
   if (b.temperature !== undefined) canon.temperature = b.temperature;
   if (b.top_p !== undefined) canon.top_p = b.top_p;

   if (b.max_output_tokens !== undefined) canon.max_tokens = b.max_output_tokens;
   else if (b.max_tokens !== undefined) canon.max_tokens = b.max_tokens;
   else if (b.max_completion_tokens !== undefined) {
     canon.max_completion_tokens = b.max_completion_tokens;
   }
   if (b.stream === true || b.stream === 'true') canon.stream = true;
   return canon;
 }
 
 // Write a canonical request in the target format..
 export function exportRequest(canon, fmt) {
   const out = { model: canon.model };
   if (fmt === 'messages' || fmt === 'chat') {
     out.messages = [];
     if (canon.system) out.messages.push({ role: 'system', content: canon.system });
     const msgs = canon.messages ?? [];
     for (const m of msgs) out.messages.push({ role: m.role, content: m.content });
   } else if (fmt === 'responses') {
     if (canon.system) out.instructions = canon.system;
     out.input = [];
     const msgs = canon.messages ?? [];
     for (const m of msgs) {
       out.input.push({ type: 'message', role: m.role,
         content: [{ type: 'input_text', text: m.content }] });
     }
   } else {
     throw new ConversionError('unknown format ' + fmt);
   }
   if (canon.stream) out.stream = true;
   if (canon.temperature !== undefined) out.temperature = canon.temperature;
   if (canon.top_p !== undefined) out.top_p = canon.top_p;
   if (canon.max_tokens !== undefined) {
     if (fmt === 'responses') out.max_output_tokens = canon.max_tokens;
     else out.max_tokens = canon.max_tokens;
   } else if (canon.max_completion_tokens !== undefined) {
     out.max_tokens = canon.max_completion_tokens;
   }
   return out;
 }
 
 // Convert a request body between formats;for passthrough just return the original body..
 export function convertRequestBody(body, from, to) {
   if (from === to) return body;
   return exportRequest(importRequest(body, from), to);
 }
 
 // ---------- response conversion ----------
 
 function extractTextBlocks(blocks) {
   const out = [];
   for (const b of (blocks ?? [])) {
     if (b && b.type === 'text') {
       out.push(String(b.text ?? ''));
     } else if (b && b.type === 'thinking') {
       continue;
     } else if (b && b.type === 'redacted_thinking') {
       continue;
     } else {
       const k = b && b.type ? b.type : typeof b;
       throw new ConversionError('upstream response contains non-text content (' + k + ')');
     }
   }
   return out.join('\n');
 }
 
 function responseTextAndStop(j, fmt) {
   const r = j ?? {};
   const model = String(r.model ?? '');
   let text = '';
   let stopReason = '';
   if (fmt === 'chat') {
     const c = r.choices && r.choices[0];
     const m = c && c.message;
     if (m && m.tool_calls && m.tool_calls.length) {
       throw new ConversionError('upstream response contains tool calls; conversion covers text only');
     }
     if (m && m.content !== undefined && m.content !== null) text = String(m.content);
     if (c && c.finish_reason) stopReason = c.finish_reason;
   } else if (fmt === 'messages') {
     text = extractTextBlocks(r.content);
     stopReason = r.stop_reason || 'end_turn';
   } else if (fmt === 'responses') {
     const out = Array.isArray(r.output) ? r.output : [];
     for (const x of out) {
       if (x && x.type !== 'message' && x.type !== 'reasoning') {
         const k = x && x.type ? x.type : 'item';
         throw new ConversionError('upstream response contains non-text output (' + k + ')');
       }
     }
     const o = out.find((x) => x && x.type === 'message');
     if (o && Array.isArray(o.content)) {
       const pieces = [];
       for (const x of o.content) {
         if (x && x.type === 'output_text') {
           pieces.push(String(x.text ?? ''));
         } else if (x && x.type === 'reasoning') {
           continue;
         } else {
           const k = x && x.type ? x.type : 'block';
           throw new ConversionError('upstream response contains non-text output (' + k + ')');
         }
       }
       text = pieces.join('\n');
     }
     stopReason = 'end_turn';
   } else {
     throw new ConversionError('unknown format ' + fmt);
   }
   return { model, text, stopReason };
 }
 
 function exportResponseText(conv, fmt) {
   const model = conv.model ?? '';
   const text = conv.text ?? '';
   const stop = conv.stopReason;
   const created = Math.floor(Date.now() / 1000);
   if (fmt === 'messages') {
     return {
       type: 'message',
       id: 'msg_lapi_conv',
       model,
       role: 'assistant',
       content: [{ type: 'text', text }],
       stop_reason: stop && stop !== 'stop' ? stop : 'end_turn',
     };
   }
   if (fmt === 'chat') {
     return {
       id: 'chatcmpl_lapi_conv',
       object: 'chat.completion',
       created,
       model,
       choices: [{ index:  0, message: { role: 'assistant', content: text },
         finish_reason: stop === 'end_turn' ? 'stop' : (stop || 'stop') }] }
   }
   if (fmt === 'responses') {
     return {
       id: 'resp_lapi_conv',
       object: 'response',
       created,
       model,
       status: 'completed',
       output: [{ type: 'message', id: 'msg_lapi_conv', role: 'assistant', status: 'completed',
         content: [{ type: 'output_text', text, annotations: [] }] }] }
  }
   throw new ConversionError('unknown format ' + fmt);
 }
 
 export function convertResponseBody(json, from, to) {
   if (from === to) return json;
   return exportResponseText(responseTextAndStop(json, from), to);
 }

 // ---------- streaming(SSE 行级转换）----------

 function parseStreamEvent(fmt, j) {
   if (!j || typeof j !== 'object') return null;
   if (fmt === 'chat') {
     const c = j.choices && j.choices[0];
     if (c && c.delta && c.delta.content !== undefined) {
       return { text: c.delta.content };
     }
     if (c && c.message && c.message.content !== undefined) {
       return { text: c.message.content };
     }
     if (c && c.finish_reason) return { done: true };
     return null;
   }
   if (fmt === 'messages') {
     if (j.type === 'content_block_delta' && j.delta) {
       if (j.delta.text !== undefined) return { text: j.delta.text };
     }
     if (j.type === 'message_delta' || j.type === 'message_stop') {
       return { done: true };
     }
     return null;
   }
   if (fmt === 'responses') {
     if (j.type === 'response.output_text.delta') {
       let t = '';
       if (typeof j.delta === 'string') t = j.delta;
       else if (j.delta && typeof j.delta.text === 'string') t = j.delta.text;
       return { text: t };
     }
     if (j.type === 'response.completed' || j.type === 'response.done') {
       return { done: true };
     }
     return null;
   }
   return null;
 }

 function emitTextLine(localFmt, text) {
   let data;
   if (localFmt === 'chat') {
     data = { choices: [{ index:  0, delta: { content: text } }] };
   } else if (localFmt === 'responses') {
     data = { type: 'response.output_text.delta',
       item_id: 'msg_lapi_conv', output_index: 0, content_index: 0, delta: text };
   } else {
     data = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
   }
   return 'data: ' + JSON.stringify(data) + '\n\n';
 }
 
 function endLinesFor(localFmt) {
   if (localFmt === 'chat') return 'data: [DONE]\n\n';
   if (localFmt === 'responses') {
     const ev = { type: 'response.completed',
       response: { id: 'resp_lapi_conv', object: 'response', status: 'completed' } };
     return 'data: ' + JSON.stringify(ev) + '\n\n';
   }
   const a = { type: 'content_block_stop', index: 0 };
   const b = { type: 'message_delta',
     delta: { stop_reason: 'end_turn' },
     usage: { input_tokens: 0, output_tokens:  0 } };
   const c = { type: 'message_stop' };
   return 'data: ' + JSON.stringify(a) + '\n\n' +
     'data: ' + JSON.stringify(b) + '\n\n' +
     'data: ' + JSON.stringify(c) + '\n\n';
 }
 
 function startLinesFor(localFmt) {
   if (localFmt === 'messages') {
     const a = { type: 'message_start',
       message: { id: 'msg_lapi_conv', type: 'message', role: 'assistant',
         model: '', content: [], stop_reason: null } };
     const b = { type: 'content_block_start', index: 0,
       content_block: { type: 'text', text: '' } };
     return 'data: ' + JSON.stringify(a) + '\n\n' +
       'data: ' + JSON.stringify(b) + '\n\n';
   }
   if (localFmt === 'responses') {
     const a = { type: 'response.created',
       response: { id: 'resp_lapi_conv', object: 'response', status: 'in_progress' } };
     return 'data: ' + JSON.stringify(a) + '\n\n';
   }
   return '';
 }
 
 // Stateful line converter, driven by chunk pushes from the reader loop..
 export function createLineConverter(upFmt, localFmt) {
   let buf = '';
   let started = false;
   let ended = false;
   function startLines() {
     started = true;
     return startLinesFor(localFmt);
   }
   function endLines() {
     if (ended) return '';
     ended = true;
     return endLinesFor(localFmt);
   }
   function handlePayload(payload) {
     if (ended) return '';
     if (payload === '[DONE]') return endLines();
     let j = null;
     try { j = JSON.parse(payload); } catch { /* ignore */ }
     if (j == null) return '';
     const ev = parseStreamEvent(upFmt, j);
     if (ev == null) return '';
     if (ev.done) return endLines();
     if (ev.text == null) return '';
     let out = '';
     if (!started) out = startLines();
     out += emitTextLine(localFmt, ev.text);
     return out;
   }
   return {
     push(chunk) {
       const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
       buf += s;
       let out = '';
       while (true) {
         const nl = buf.indexOf('\n');
         if (nl < 0) break;
         const line = buf.slice(0, nl).replace(/\r$/, '').trim();
         buf = buf.slice(nl + 1);
         if (!line.startsWith('data:')) continue;
         out += handlePayload(line.slice(5).trim());
       }
       return out;
     },
     end() {
       if (ended) return '';
       if (!started) return '';
       return endLines();
     },
   };
 }
 
 // ---------- upstream error envelope ----------
 
 export function convertUpstreamError(payload, localFmt, fallbackMsg) {
   const p = payload ?? {};
   const raw = p.error && p.error.message ? p.error.message : p.message;
   const message = String(raw || fallbackMsg);
   let type = 'upstream_error';
   if (p.error && p.error.type) type = p.error.type;
   else if (p.type && p.type !== 'error') type = p.type;
   if (localFmt === 'messages') {
     return { type: 'error', error: { type: String(type), message } };
   }
   return { error: { message, type: String(type) } };
 }
