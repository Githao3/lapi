import test from "node:test";
import assert from "node:assert/strict";

import {
  isLoopbackBind,
  extractClientKey,
  clientKeyMatches,
  safeEqual,
  createSession,
  sessionValid,
  dropSession,
  bearerOf,
  loginBlockedFor,
  noteLoginFailure,
  noteLoginSuccess,
} from "../auth.js";

// ---------- loopback detection ----------

test("isLoopbackBind: local forms stay open", () => {
  assert.equal(isLoopbackBind("127.0.0.1"), true);
  assert.equal(isLoopbackBind("127.0.0.5"), true);
  assert.equal(isLoopbackBind("localhost"), true);
  assert.equal(isLoopbackBind("LOCALHOST"), true);
  assert.equal(isLoopbackBind("::1"), true);
  assert.equal(isLoopbackBind(""), true, "unset falls back to the loopback default");
  assert.equal(isLoopbackBind(undefined), true);
});

test("isLoopbackBind: exposed forms require auth", () => {
  assert.equal(isLoopbackBind("0.0.0.0"), false);
  assert.equal(isLoopbackBind("192.168.1.10"), false);
  assert.equal(isLoopbackBind("100.64.0.1"), false, "tailnet address is not loopback");
  assert.equal(isLoopbackBind("127.0.0.1.example.com"), false, "prefix must not fool the check");
  assert.equal(isLoopbackBind("127.0.0.300"), false, "invalid octet is not a loopback literal");
  assert.equal(isLoopbackBind("::ffff:10.0.0.1"), false, "IPv4-mapped public address");
});

test("isLoopbackBind: full and mapped loopback literals stay open", () => {
  assert.equal(isLoopbackBind("0:0:0:0:0:0:0:1"), true);
  assert.equal(isLoopbackBind("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackBind(" 127.0.0.1 "), true);
});

// ---------- client key extraction ----------

test("extractClientKey: reads any credential slot the tools use", () => {
  assert.equal(extractClientKey({ authorization: "Bearer sk-user" }), "sk-user");
  assert.equal(extractClientKey({ authorization: "bearer sk-user" }), "sk-user");
  assert.equal(extractClientKey({ authorization: "sk-user" }), "sk-user");
  assert.equal(extractClientKey({ "x-api-key": "sk-user" }), "sk-user");
  assert.equal(extractClientKey({ "x-goog-api-key": "sk-user" }), "sk-user");
  assert.equal(extractClientKey({ authorization: ["sk-user"] }), "sk-user", "repeated header");
});

test("extractClientKey: empty and missing credentials yield empty string", () => {
  assert.equal(extractClientKey({}), "");
  assert.equal(extractClientKey(undefined), "");
  assert.equal(extractClientKey({ authorization: "   " }), "");
  assert.equal(extractClientKey({ authorization: "", "x-api-key": "sk-user" }), "sk-user", "blank slot falls through");
});

test("clientKeyMatches: exact match only, and never with an unset key", () => {
  assert.equal(clientKeyMatches({ authorization: "Bearer sk-user" }, "sk-user"), true);
  assert.equal(clientKeyMatches({ "x-api-key": "sk-user" }, "sk-user"), true);
  assert.equal(clientKeyMatches({ "x-api-key": "sk-other" }, "sk-user"), false);
  assert.equal(clientKeyMatches({}, "sk-user"), false);
  assert.equal(clientKeyMatches({ "x-api-key": "" }, ""), false, "unset relay key must not accept a blank client key");
});

test("safeEqual: constant-time compare semantics", () => {
  assert.equal(safeEqual("pw", "pw"), true);
  assert.equal(safeEqual("pw", "pW"), false);
  assert.equal(safeEqual("short", "a-much-longer-password"), false, "unequal lengths do not throw");
  assert.equal(safeEqual(undefined, "pw"), false);
});

test("bearerOf strips the scheme case-insensitively", () => {
  assert.equal(bearerOf("Bearer abc"), "abc");
  assert.equal(bearerOf("bearer abc"), "abc");
  assert.equal(bearerOf("abc"), "abc");
  assert.equal(bearerOf(undefined), "");
});

// ---------- sessions ----------

test("sessions: issued tokens validate, dropped tokens do not", () => {
  const s = createSession();
  assert.equal(s.length, 64, "32 random bytes as hex");
  assert.equal(sessionValid(s), true);
  dropSession(s);
  assert.equal(sessionValid(s), false, "logged out");
  assert.equal(sessionValid("made-up-token"), false);
  assert.equal(sessionValid(""), false);
});

// ---------- login throttle (stateful: keep last) ----------

test("login throttle: blocks after repeated failures, success clears it", () => {
  assert.equal(loginBlockedFor(), 0, "starts unblocked");
  for (let i = 0; i < 5; i++) noteLoginFailure();
  assert.ok(loginBlockedFor() > 0, "blocked once failures reach the free allowance");
  noteLoginFailure();
  assert.ok(loginBlockedFor() > 30_000, "further failures extend the wait");
  noteLoginSuccess();
  assert.equal(loginBlockedFor(), 0, "a correct password clears the block");
});
