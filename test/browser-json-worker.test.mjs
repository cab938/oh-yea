import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserJsonWorker } from "../src/lib/browser-json-worker.mjs";

class FakeDebugger extends EventEmitter {
  constructor(body, status = 200) {
    super();
    this.body = body;
    this.status = status;
    this.attached = false;
  }

  isAttached() {
    return this.attached;
  }

  attach() {
    this.attached = true;
  }

  async sendCommand(command) {
    if (command === "Network.getResponseBody") {
      return { body: JSON.stringify(this.body), base64Encoded: false };
    }
    return {};
  }
}

class FakeContents extends EventEmitter {
  constructor(
    inspector,
    { responseUrl, method = "GET", formSnapshot, finalUrl } = {},
  ) {
    super();
    this.debugger = inspector;
    this.responseUrl = responseUrl;
    this.method = method;
    this.snapshot = formSnapshot;
    this.finalUrl = finalUrl;
    this.currentUrl = "about:blank";
  }

  async loadURL(url) {
    this.currentUrl = this.finalUrl ?? url;
    if (!this.responseUrl) return;
    queueMicrotask(() => {
      const requestId = "request-1";
      this.debugger.emit("message", {}, "Network.requestWillBeSent", {
        requestId,
        request: {
          method: this.method,
          url: this.responseUrl,
          headers: { Authorization: "must-not-be-consumed" },
        },
      });
      this.debugger.emit("message", {}, "Network.responseReceived", {
        requestId,
        response: { status: this.debugger.status },
      });
      this.debugger.emit("message", {}, "Network.loadingFinished", {
        requestId,
      });
    });
  }

  getURL() {
    return this.currentUrl;
  }

  async executeJavaScript(source) {
    assert.match(source, /form\.js-entry-form/u);
    return this.snapshot;
  }
}

class FakeWindow extends EventEmitter {
  constructor(contents) {
    super();
    this.webContents = contents;
    this.destroyed = false;
  }

  isDestroyed() {
    return this.destroyed;
  }

  close() {
    this.destroyed = true;
    this.webContents.emit("destroyed");
    this.emit("closed");
  }
}

function fixture({
  body = { groups: [1] },
  status = 200,
  responseUrl,
  formSnapshot,
  finalUrl,
} = {}) {
  const inspector = new FakeDebugger(body, status);
  const contents = new FakeContents(inspector, {
    responseUrl,
    formSnapshot,
    finalUrl,
  });
  const window = new FakeWindow(contents);
  return { inspector, contents, window };
}

test("captures only the configured JSON response body", async () => {
  const responseUrl = "https://example.test/api/groups/";
  const fake = fixture({ responseUrl });
  const worker = new BrowserJsonWorker({
    createWindow: () => fake.window,
    timeoutMs: 100,
  });

  const result = await worker.capture({
    pageUrl: "https://example.test/my-groups",
    responseUrl,
    method: "GET",
  });
  assert.deepEqual(result, { groups: [1] });
  worker.close();
});

test("fails closed when the configured response is rejected", async () => {
  const responseUrl = "https://example.test/api/groups/";
  const fake = fixture({ responseUrl, status: 401 });
  const worker = new BrowserJsonWorker({
    createWindow: () => fake.window,
    timeoutMs: 100,
  });

  await assert.rejects(
    worker.capture({
      pageUrl: "https://example.test/my-groups",
      responseUrl,
      authenticationExpected: true,
    }),
    (error) => error.code === "AUTHENTICATION_REQUIRED",
  );
  worker.close();
});

test("does not accept a different response URL", async () => {
  const fake = fixture({
    responseUrl: "https://example.test/api/not-the-configured-resource",
  });
  const worker = new BrowserJsonWorker({
    createWindow: () => fake.window,
    timeoutMs: 20,
  });

  await assert.rejects(
    worker.capture({
      pageUrl: "https://example.test/my-groups",
      responseUrl: "https://example.test/api/groups/",
      authenticationExpected: false,
    }),
    (error) => error.code === "UPSTREAM_RESPONSE_MISSING",
  );
  worker.close();
});

test("captures a fixed form snapshot without exposing browser state", async () => {
  const pageUrl = "https://example.test/expense";
  const expected = {
    found: true,
    pageUrl,
    actionUrl: "https://example.test/submit",
    method: "POST",
    enctype: "multipart/form-data",
    entries: [["FormID", "3196"]],
    controls: [],
  };
  const fake = fixture({ formSnapshot: expected });
  const worker = new BrowserJsonWorker({
    createWindow: () => fake.window,
    timeoutMs: 100,
  });

  const result = await worker.formSnapshot({ pageUrl });
  assert.deepEqual(result, expected);
  worker.close();
});

test("queues a configured navigation for silent application-session setup", async () => {
  const fake = fixture({ finalUrl: "https://example.test/account" });
  const worker = new BrowserJsonWorker({
    createWindow: () => fake.window,
    timeoutMs: 100,
  });

  const result = await worker.navigate({
    pageUrl: "https://example.test/login",
  });
  assert.deepEqual(result, { finalUrl: "https://example.test/account" });
  worker.close();
});

test("treats a cross-origin form redirect as authentication-required", async () => {
  const fake = fixture({
    formSnapshot: { found: false },
    finalUrl: "https://login.example.test/",
  });
  const worker = new BrowserJsonWorker({
    createWindow: () => fake.window,
    timeoutMs: 100,
  });

  await assert.rejects(
    worker.formSnapshot({ pageUrl: "https://example.test/expense" }),
    (error) => error.code === "AUTHENTICATION_REQUIRED",
  );
  worker.close();
});
