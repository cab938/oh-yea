import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { checkDesktop, startBroker } from "../src/lib/desktop-launcher.mjs";

const unavailable = () => { throw Object.assign(new Error("not running"), { code: "ENOENT" }); };
function setup(overrides = {}) {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 12345;
  child.unref = () => calls.push("unref");
  child.kill = (signal) => calls.push(signal);
  return {
    child, calls,
    options: {
      socketPath: "/tmp/unused.sock", projectRoot: "/checkout with spaces",
      env: { DISPLAY: ":99" }, platform: "linux", timeoutMs: 500,
      desktopCheck: async () => {}, resolveBinary: async () => "/electron with spaces",
      spawnProcess: (...args) => { calls.push(args); return child; },
      ...overrides,
    },
  };
}

test("start reuses discovery without requiring a desktop, Electron, or service tokens", async () => {
  const { options, calls } = setup({
    request: async () => ({ ok: true, data: [] }),
    desktopCheck: () => { throw new Error("must not inspect a desktop"); },
    resolveBinary: () => { throw new Error("must not load Electron"); },
  });
  assert.deepEqual(await startBroker(options), { status: "already_running", pid: null });
  assert.equal(calls.length, 0);
});

test("start detaches once and returns the owned PID after discovery", async () => {
  let requests = 0;
  const { options, calls } = setup({ request: async () => ++requests < 3 ? unavailable() : { ok: true } });
  assert.deepEqual(await startBroker(options), { status: "started", pid: 12345 });
  assert.deepEqual(calls, [["/electron with spaces", ["/checkout with spaces"], {
    env: options.env, detached: true, stdio: "ignore",
  }], "unref"]);
});

test("discovery errors never trigger a new process", async () => {
  for (const request of [async () => ({ ok: false, error: { code: "BAD_WORKFLOW" } }), async () => { throw Object.assign(new Error("denied"), {code:"EACCES"}); }]) {
    const { options, calls } = setup({ request });
    await assert.rejects(startBroker(options));
    assert.equal(calls.length, 0);
  }
});

test("start fails once on child exit or spawn failure", async () => {
  for (const event of ["exit", "error"]) {
    let attempts = 0;
    const fixture = setup({ request: async () => unavailable() });
    fixture.options.spawnProcess = () => {
      attempts++;
      setImmediate(() => fixture.child.emit(event, event === "error" ? new Error("failed") : 1));
      return fixture.child;
    };
    await assert.rejects(startBroker(fixture.options), { code: "STARTUP_FAILED" });
    assert.equal(attempts, 1);
  }
});

test("startup timeout stops only its newly owned process", async () => {
  const { options, calls } = setup({ request: async () => unavailable(), timeoutMs: 30 });
  await assert.rejects(startBroker(options), { code: "STARTUP_TIMEOUT" });
  assert.equal(calls.filter((item) => Array.isArray(item)).length, 1);
  assert.equal(calls.at(-1), "SIGTERM");
});

test("Linux requires a display and unsupported platforms fail explicitly", async () => {
  await assert.rejects(checkDesktop("linux", {}), { code: "DESKTOP_UNAVAILABLE" });
  await checkDesktop("linux", { WAYLAND_DISPLAY: "wayland-0" });
  await assert.rejects(checkDesktop("win32", {}), { code: "UNSUPPORTED_PLATFORM" });
});
