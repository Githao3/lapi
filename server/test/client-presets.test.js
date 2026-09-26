import test from "node:test";
import assert from "node:assert/strict";

import { classifyCaptureHeaders } from "../client-presets.js";
import { applyClientPreset } from "../relay-lib.js";

// fixtures 取自真实捕获（2026-09 的 opencode / claude-cli / ZCode 记录，头名如实）
const OPENCODE_IN = {
  host: "localhost:8787",
  "user-agent": "opencode/1.18.30 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
  accept: "*/*",
  authorization: "Bearer real-secret",
  "content-type": "application/json",
  "content-length": "6249",
  "accept-encoding": "gzip, deflate, br, zstd",
  connection: "keep-alive",
  "x-session-id": "ses_f4aa0000000000000000000000000XOE",
  "x-session-affinity": "ses_f4aa0000000000000000000000000XOE",
};

const CLAUDE_IN = {
  host: "localhost:8787",
  "user-agent": "claude-cli/2.1.273 (external, cli)",
  accept: "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta":
    "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27",
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
  "x-stainless-lang": "js",
  "x-stainless-os": "Windows",
  "x-stainless-arch": "x64",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.3.0",
  "x-stainless-package-version": "0.112.1",
  "x-stainless-retry-count": "0",
  "x-stainless-timeout": "600",
  "x-claude-code-session-id": "e69959000000000000000000000007ae2",
  authorization: "Bearer real-secret",
  "content-length": "135217",
};

const ZCODE_IN = {
  "x-query-id": "01a0b9bf-ed16-77a4-b8d6-4103e33e862c",
  "x-session-id": "341f5f00000000000000000000001b49",
};

// ---------- 分类器 ----------

test("classify: 网关管辖头与认证头一律排除", () => {
  const { headers } = classifyCaptureHeaders(OPENCODE_IN);
  const names = headers.map((h) => h.name);
  for (const gone of ["host", "content-length", "content-type", "accept-encoding", "connection"]) {
    assert.ok(!names.includes(gone), "排除 " + gone);
  }
  assert.ok(!names.includes("authorization"), "排除 authorization");
});

test("classify: anthropic-beta 明确排除（逐请求变化的开关组合）", () => {
  const { headers } = classifyCaptureHeaders(CLAUDE_IN);
  assert.ok(!headers.some((h) => h.name === "anthropic-beta"));
});

test("classify: 会话/请求类头按名字命中 fill", () => {
  const { headers } = classifyCaptureHeaders(OPENCODE_IN);
  const byName = Object.fromEntries(headers.map((h) => [h.name, h]));
  assert.equal(byName["x-session-id"].mode, "fill");
  assert.equal(byName["x-session-affinity"].mode, "fill");
  assert.equal(byName["x-session-id"].value, "ses_f4aa0000000000000000000000000XOE", "fill 预填捕获值");

  const cl = classifyCaptureHeaders(CLAUDE_IN);
  const clByName = Object.fromEntries(cl.headers.map((h) => [h.name, h]));
  assert.equal(clByName["x-claude-code-session-id"].mode, "fill");
  assert.equal(clByName["x-stainless-retry-count"].mode, "fill", "retry 命中启发式");

  const zc = classifyCaptureHeaders(ZCODE_IN);
  assert.equal(zc.headers[0].name, "x-query-id");
  assert.equal(zc.headers[0].mode, "fill", "query 命中启发式");
  assert.equal(zc.name, "", "无 UA 时猜不出名字");
});

test("classify: 身份头与其余头预标 fixed，名字从 UA 猜", () => {
  const { name, headers } = classifyCaptureHeaders(OPENCODE_IN);
  assert.equal(name, "opencode");
  const byName = Object.fromEntries(headers.map((h) => [h.name, h]));
  assert.equal(byName["user-agent"].mode, "fixed");
  assert.equal(byName["user-agent"].value, OPENCODE_IN["user-agent"]);
  assert.equal(byName.accept.mode, "fixed");

  const cl = classifyCaptureHeaders(CLAUDE_IN);
  const clByName = Object.fromEntries(cl.headers.map((h) => [h.name, h]));
  assert.equal(cl.name, "claude-cli");
  for (const n of ["x-stainless-lang", "x-stainless-os", "x-stainless-package-version", "anthropic-version", "x-app"]) {
    assert.equal(clByName[n].mode, "fixed", n + " → fixed");
  }
});

// ---------- 应用三态 ----------

test("applyClientPreset: fixed 覆盖、fill 缺了才补、drop 删除", () => {
  const out = {
    "user-agent": "some-other-client/1.0",
    "x-session-id": "ses_live_from_client",
    accept: "application/json",
  };
  applyClientPreset(out, {
    name: "opencode",
    headers: [
      { name: "user-agent", value: "opencode/1.18.30", mode: "fixed" },
      { name: "x-session-id", value: "ses_pinned", mode: "fill" },
      { name: "x-session-affinity", value: "ses_pinned", mode: "fill" },
      { name: "x-request-id", value: "deadbeef", mode: "drop" },
    ],
  });
  assert.equal(out["user-agent"], "opencode/1.18.30", "fixed 覆盖客户端自带值");
  assert.equal(out["x-session-id"], "ses_live_from_client", "fill 透传客户端活值");
  assert.equal(out["x-session-affinity"], "ses_pinned", "fill 给缺失的头补位");
  assert.ok(!("x-request-id" in out), "drop 移除出站头");
});

test("applyClientPreset: fill 的补位值为空时宁可不发", () => {
  const out = { accept: "application/json" };
  applyClientPreset(out, {
    name: "p",
    headers: [
      { name: "x-session-id", value: "", mode: "fill" },
      { name: "x-session-affinity", value: "", mode: "fill" },
    ],
  });
  assert.ok(!("x-session-id" in out), "空头不该被发送");
  assert.ok(!("x-session-affinity" in out));
});

test("applyClientPreset: 管辖头（host/认证/长度）永不被档案触碰", () => {
  const out = {
    host: "api.fengwind.com",
    authorization: "Bearer channel-key",
    "content-length": "42",
    "content-type": "application/json",
    "accept-encoding": "identity",
  };
  applyClientPreset(out, {
    name: "rogue",
    headers: [
      { name: "host", value: "evil.example.com", mode: "fixed" },
      { name: "authorization", value: "Bearer evil", mode: "fixed" },
      { name: "x-api-key", value: "evil", mode: "fixed" },
      { name: "content-length", value: "9999", mode: "fixed" },
      { name: "content-type", value: "text/plain", mode: "fixed" },
      { name: "accept-encoding", value: "gzip", mode: "fixed" },
    ],
  });
  assert.equal(out.host, "api.fengwind.com");
  assert.equal(out.authorization, "Bearer channel-key");
  assert.ok(!("x-api-key" in out));
  assert.equal(out["content-length"], "42");
  assert.equal(out["content-type"], "application/json");
  assert.equal(out["accept-encoding"], "identity");
});

test("applyClientPreset: 无效/空预设原样返回", () => {
  const out = { "user-agent": "x" };
  applyClientPreset(out, null);
  applyClientPreset(out, {});
  applyClientPreset(out, { name: "empty", headers: [] });
  assert.equal(out["user-agent"], "x");
});
