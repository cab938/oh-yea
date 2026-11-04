import test from "node:test";
import assert from "node:assert/strict";
import { executeCapability } from "../src/lib/capability-executor.mjs";

test("CSS checks the current profile and leaves authentication/navigation to the renderer", async () => {
  const calls = [];
  const job = { id: "css", capability: "fixture.read", definition: { extraction: { type: "css" } } };
  const profile = { name: "current-profile" };
  const context = {
    configuredAuthentication: profile,
    authenticationManager: { check: async (...args) => calls.push(["check", ...args]) },
    rendererExecutor: { execute: async (received) => { calls.push(["render", received]); return "result"; } },
  };
  assert.equal(await executeCapability(job, context), "result");
  assert.deepEqual(calls, [["check", profile, { reason: "request" }], ["render", job]]);
  calls.length = 0;
  await executeCapability(job, { ...context, configuredAuthentication: null });
  assert.deepEqual(calls, [["render", job]]);
});

test("browser JSON retains its own authentication and serialized worker path", async () => {
  const job = { id: "browser", capability: "fixture.read", definition: { extraction: { type: "browser_json" } } };
  const profile = { name: "reloaded-profile" };
  const calls = [];
  const result = await executeCapability(job, {
    configuredAuthentication: profile,
    logs: { add() {} },
    extractBrowserJson: async (...args) => { calls.push(args); return { groups: [] }; },
  });
  assert.deepEqual(result, { groups: [] });
  assert.deepEqual(calls, [[job, profile]]);
});

test("a missing worker blocks actions with the existing authentication order", async () => {
  for (const type of ["teamdynamix_expense_report", "teamdynamix_expense_report_capture", "umgpt_conversation"]) {
    const calls = [];
    const job = { id: "action", capability: "fixture.write", definition: { action: { type } } };
    await assert.rejects(executeCapability(job, {
      configuredAuthentication: "profile", timeoutMs: 123,
      authenticationManager: { ensure: async (...args) => calls.push(args) },
    }), { code: "CONTROL_PLANE_UNAVAILABLE" });
    assert.deepEqual(calls, type === "umgpt_conversation"
      ? [["profile", { requestId: "action", capability: "fixture.write", timeoutMs: 123 }]] : []);
  }
});
