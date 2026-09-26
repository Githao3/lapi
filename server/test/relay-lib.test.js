import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeUpstreamUrl,
  buildOutboundHeaders,
  matchChannelForModel,
  pickCandidateChannels,
  pickWeightedChannel,
  errorPayload,
  bodyPreview,
  normalizeUsage,
  createUsageScanner,
  hashId,
} from "../relay-lib.js";

// ---------- URL normalization ----------

test("normalizeUpstreamUrl: messages", () => {
  assert.equal(normalizeUpstreamUrl("https://api.anthropic.com", "messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(normalizeUpstreamUrl("https://api.anthropic.com/", "messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(normalizeUpstreamUrl("https://api.anthropic.com/v1", "messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(normalizeUpstreamUrl("https://api.anthropic.com/v1beta", "messages"), "https://api.anthropic.com/v1beta/messages");
  assert.equal(normalizeUpstreamUrl("https://api.anthropic.com/v1/messages", "messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(normalizeUpstreamUrl("https://x.test/messages", "messages"), "https://x.test/messages");
  assert.equal(normalizeUpstreamUrl("", "messages"), "");
});

test("normalizeUpstreamUrl: chat and responses", () => {
  assert.equal(normalizeUpstreamUrl("https://api.deepseek.com", "chat"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(normalizeUpstreamUrl("https://api.deepseek.com/v1", "chat"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(normalizeUpstreamUrl("https://x.test/v1/chat/completions", "chat"), "https://x.test/v1/chat/completions");
  assert.equal(normalizeUpstreamUrl("https://x.test/v1", "responses"), "https://x.test/v1/responses");
  assert.equal(normalizeUpstreamUrl("https://x.test/v1/responses", "responses"), "https://x.test/v1/responses");
});

test("normalizeUpstreamUrl: models", () => {
  assert.equal(normalizeUpstreamUrl("https://api.anthropic.com", "models"), "https://api.anthropic.com/v1/models");
  assert.equal(normalizeUpstreamUrl("https://x.test/v1/models", "models"), "https://x.test/v1/models");
});

// ---------- outbound headers ----------

function clientHeaders(obj) {
  return { "content-type": "application/json", "accept": "application/json", host: "0.0.0.0:8787", ...obj };
}

test("buildOutboundHeaders: injects auth per authMode", () => {
  const base = { clientHeaders: clientHeaders({}), targetUrl: "https://api.anthropic.com/v1/messages", apiKey: "sk-secret-123456", authMode: "bearer", protocol: "anthropic" };
  const o = buildOutboundHeaders(base);
  assert.equal(o.authorization, "Bearer sk-secret-123456");
  const x = buildOutboundHeaders({ ...base, authMode: "x-api-key" });
  assert.equal(x["x-api-key"], "sk-secret-123456");
  assert.equal(x.authorization, undefined);
  const g = buildOutboundHeaders({ ...base, authMode: "x-goog-api-key" });
  assert.equal(g["x-goog-api-key"], "sk-secret-123456");
  const n = buildOutboundHeaders({ ...base, authMode: "none" });
  assert.equal(n.authorization, undefined);
});

test("buildOutboundHeaders: drops hop-by-hop/CDN and rebuilds host", () => {
  const o = buildOutboundHeaders({
    clientHeaders: clientHeaders({
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "accept-encoding": "gzip",
      host: "evil.example.com",
      "x-forwarded-for": "10.0.0.1",
      "cf-ray": "abc",
      traceparent: "00-abc",
    }),
    targetUrl: "https://api.deepseek.com/v1/chat/completions",
    apiKey: "k",
    authMode: "bearer",
    protocol: "openai",
  });
  assert.equal(o.host, "api.deepseek.com");
  assert.equal(o.connection, undefined);
  assert.equal(o["transfer-encoding"], undefined);
  assert.equal(o["accept-encoding"], "identity");
  assert.equal(o["x-forwarded-for"], undefined);
  assert.equal(o["cf-ray"], undefined);
  assert.equal(o.traceparent, undefined);
});

test("buildOutboundHeaders: user-agent override and defaults", () => {
  const o = buildOutboundHeaders({
    clientHeaders: clientHeaders({ "user-agent": "my-original-ua" }),
    targetUrl: "https://x.test/v1/chat/completions",
    apiKey: "k",
    authMode: "bearer",
    protocol: "openai",
  });
  assert.equal(o["user-agent"], "my-original-ua");
  const p = buildOutboundHeaders({
    clientHeaders: clientHeaders({ "user-agent": "my-original-ua" }),
    targetUrl: "https://x.test/v1/chat/completions",
    apiKey: "k",
    authMode: "bearer",
    protocol: "openai",
    userAgentOverride: "claude-cli/2.1.161 (external, cli)",
  });
  assert.equal(p["user-agent"], "claude-cli/2.1.161 (external, cli)");
});

test("buildOutboundHeaders: anthropic-version default only for anthropic", () => {
  const a = buildOutboundHeaders({ clientHeaders: {}, targetUrl: "https://x.test", apiKey: "k", authMode: "bearer", protocol: "anthropic" });
  assert.equal(a["anthropic-version"], "2023-06-01");
  const b = buildOutboundHeaders({ clientHeaders: {}, targetUrl: "https://x.test", apiKey: "k", authMode: "bearer", protocol: "openai" });
  assert.equal(b["anthropic-version"], undefined);
});

test("buildOutboundHeaders: anthropic-version follows channel-declared upstream format", () => {
  // cross-format: chat client hitting an anthropic channel must still send anthropic-version
  const a = buildOutboundHeaders({ clientHeaders: {}, targetUrl: "https://x.test", apiKey: "k", authMode: "bearer", protocol: "openai", upstreamKind: "messages" });
  assert.equal(a["anthropic-version"], "2023-06-01");
  // cross-format: messages client hitting an openai channel must NOT send anthropic-version
  const b = buildOutboundHeaders({ clientHeaders: { "anthropic-version": "2023-06-01" }, targetUrl: "https://x.test", apiKey: "k", authMode: "bearer", protocol: "anthropic", upstreamKind: "chat" });
  assert.equal(b["anthropic-version"], undefined);
  // same-format sanity
  const c = buildOutboundHeaders({ clientHeaders: {}, targetUrl: "https://x.test", apiKey: "k", authMode: "bearer", protocol: "anthropic", upstreamKind: "messages" });
  assert.equal(c["anthropic-version"], "2023-06-01");
});

test("buildOutboundHeaders: extra overrides respect protected list", () => {
  const o = buildOutboundHeaders({
    clientHeaders: {},
    targetUrl: "https://x.test/v1/messages",
    apiKey: "k",
    authMode: "bearer",
    protocol: "anthropic",
    headerOverrides: {
      "x-custom-tag": "v42",
      "anthropic-version": "2024-01-01",
      authorization: "Bearer evil",
      "x-api-key": "evil",
      "content-length": "999",
      cookie: "session=evil",
    },
  });
  assert.equal(o["x-custom-tag"], "v42");
  assert.equal(o["anthropic-version"], "2024-01-01");
  assert.notEqual(o.authorization, "Bearer evil");
  assert.equal(o.authorization, "Bearer k");
  assert.notEqual(o["x-api-key"], "evil");
  assert.equal(o["content-length"], undefined);
  assert.equal(o.cookie, undefined);
});



// ---------- model matching ----------

test("matchChannelForModel: level 3 exact", () => {
  const ch = { models: "claude-sonnet-4-5,claude-opus-4-5", model_mapping: {} };
  assert.equal(matchChannelForModel(ch, "claude-sonnet-4-5", {}).level, 3);
  assert.equal(matchChannelForModel(ch, "claude-opus-4-5", {}).level , 3);
  assert.equal(matchChannelForModel(ch, "gpt-4o", {}).ok, false);
});

test("matchChannelForModel: level 2 normalized date suffix", () => {
  const ch = { models: "claude-sonnet-4-5-20250829", model_mapping: {} };
  assert.equal(matchChannelForModel(ch, "claude-sonnet-4-5", {}).level , 2);
  assert.equal(matchChannelForModel(ch, "claude-sonnet-4-5-20250101", {}).level , 2);
});

test("matchChannelForModel: level 1 wildcards", () => {
  const ch = { models: "sonnet*,*", model_mapping: {} };
  assert.equal(matchChannelForModel(ch, "sonnet-3-5", {}).level , 1);
  assert.equal(matchChannelForModel(ch, "any-thing", {}).level , 1);
});

test("matchChannelForModel: modelMapping keys act as aliases", () => {
  const ch = { models: "claude-opus-4-5", model_mapping: { "my-alias": "claude-opus-4-5" } };
  assert.equal(matchChannelForModel(ch, "my-alias", ch.model_mapping).level , 3);
});

// ---------- candidate picking ----------

test("pickCandidateChannels: filters and buckets by match level", () => {
  const channels = [
    { name: "exact-only", enabled: true, protocol: "anthropic", models: "claude-opus-4-5", model_mapping: {}, weight: 1 },
    { name: "dated", enabled: true, protocol: "anthropic", models: "claude-opus-4-5-20250101", model_mapping: {}, weight: 1 },
    { name: "wild", enabled: true, protocol: "anthropic", models: "claude-opus*", model_mapping: {}, weight:1 },
    { name: "disabled", enabled: false, protocol: "anthropic", models: "claude-opus-4-5", model_mapping: {}, weight:1 },
    { name: "openai-proto", enabled: true, protocol: "openai", models: "claude-opus-4-5", model_mapping: {}, weight:1 },
  ];
  const c = pickCandidateChannels(channels, "anthropic", "claude-opus-4-5");
  assert.deepEqual(c.map(x=>x.name), ["exact-only", "openai-proto"]);
  const w = pickCandidateChannels(channels, "anthropic", "claude-opus-3-5");
  assert.deepEqual(w.map(x=>x.name), ["wild"]);
});

test("pickCandidateChannels: pools chat and responses channels regardless of endpoint", () => {
  const channels = [
    { name: "chat-a", enabled: true, protocol: "openai", openai_endpoint: "chat", models: "gpt-4o" },
    { name: "chat-b", enabled: true, protocol: "openai", openai_endpoint: "chat", models: "gpt-4o" },
    { name: "resp-c", enabled: true, protocol: "openai", openai_endpoint: "responses", models: "gpt-4o" },
    { name: "legacy-no-field", enabled: true, protocol: "openai", models: "gpt-4o" },
    { name: "anthropic-m", enabled: true, protocol: "anthropic", models: "gpt-4o" },
  ];
  const expected = ["chat-a", "chat-b", "resp-c", "legacy-no-field", "anthropic-m"];
  const chat = pickCandidateChannels(channels, "openai", "gpt-4o", "chat");
  assert.deepEqual(chat.map(x=>x.name), expected);
  const resp = pickCandidateChannels(channels, "openai", "gpt-4o", "responses");
  assert.deepEqual(resp.map(x=>x.name), expected);
});
test("pickWeightedChannel: never null on non-empty list", () => {
  const candidates = [{ name: "a", weight:0 }, { name: "b", weight:0 }];
  for (let i=0; i<50; i++) {
    const c = pickWeightedChannel(candidates);
    assert.ok(c);
  }
  assert.equal(pickWeightedChannel([]), null);
  assert.equal(pickWeightedChannel(null), null);
});

// ---------- error shapes ----------

test("errorPayload: protocol-shape payloads", () => {
  const a = errorPayload("anthropic", "boom", "some_type");
  assert.deepEqual(a, { type: "error", error: { type: "some_type", message: "boom" } });
  assert.deepEqual(errorPayload("openai", "boom"), { error: { message: "boom", type: "invalid_request_error" } });
});

// ---------- body preview ----------

test("bodyPreview: 4KB cap", () => {
  const small = "x".repeat(100);
  assert.equal(bodyPreview(small), "x".repeat(100));
  const big = bodyPreview("y".repeat(5000));
  assert.ok(big.length > 4096);
  assert.ok(big.includes("(truncated)"));
});

// ---------- hash ----------

test("hashId: deterministic 12 hex chars", () => {
  const h1 = hashId("hello");
  const h2 = hashId("hello");
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{12}$/);
});
