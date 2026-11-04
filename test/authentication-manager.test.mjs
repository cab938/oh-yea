import test from "node:test";
import assert from "node:assert/strict";
import {
  AuthenticationManager,
  authenticationPollDelay,
} from "../src/lib/authentication-manager.mjs";

function authentication() {
  return {
    name: "example_sso",
    url: "https://app.example.test/identity",
    loginUrl: "https://app.example.test/login",
    expectedExpiry: {
      jsonPointer: "/id_token/exp",
      format: "unix_seconds",
    },
  };
}

test("backs authentication polling off to at most twelve retries in five minutes", () => {
  assert.deepEqual(
    Array.from({ length: 7 }, (_value, attempt) =>
      authenticationPollDelay(attempt),
    ),
    [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000],
  );

  let elapsed = 0;
  let retries = 0;
  while (true) {
    const delay = authenticationPollDelay(retries);
    if (elapsed + delay >= 5 * 60 * 1_000) break;
    elapsed += delay;
    retries += 1;
  }
  assert.equal(retries, 12);
});

test("keeps identity header values private while returning them to the extractor", async () => {
  const statuses = [];
  const authSession = {
    async fetch() {
      return new Response("{}", {
        status: 200,
        headers: { "x-example-identity": "private-value" },
      });
    },
  };
  const manager = new AuthenticationManager({
    authSession,
    onStatus: (status) => statuses.push(status),
  });
  const result = await manager.check(authentication(), {
    reason: "request",
    requestHeaders: {
      "x-example-identity": {
        responseHeader: "x-example-identity",
        prefix: "",
      },
    },
  });

  assert.equal(result.authenticated, true);
  assert.deepEqual(result.requestHeaders, {
    "x-example-identity": "private-value",
  });
  assert.equal(JSON.stringify(statuses).includes("private-value"), false);
  assert.equal(
    JSON.stringify(manager.publicStatuses()).includes("private-value"),
    false,
  );
  assert.equal(manager.publicStatuses()[0].state, "authenticated");
  assert.equal(
    manager.publicStatuses()[0].authentication,
    "example_sso",
  );
});

test("builds request headers from response headers, JSON pointers, and static values", async () => {
  const manager = new AuthenticationManager({
    authSession: {
      async fetch() {
        return new Response(
          JSON.stringify({
            userinfo: { preferred_username: "person" },
            id_token: { exp: 1_784_569_733 },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-identity-token": "token-value",
            },
          },
        );
      },
    },
  });
  const result = await manager.check({
    name: "example_sso",
    url: "https://app.example.test/identity",
    loginUrl: "https://app.example.test/login",
    expectedExpiry: {
      jsonPointer: "/id_token/exp",
      format: "unix_seconds",
    },
  }, {
    requestHeaders: {
      Authorization: {
        responseHeader: "x-identity-token",
        prefix: "Bearer ",
      },
      "X-Forwarded-User": {
        jsonPointer: "/userinfo/preferred_username",
        prefix: "",
      },
      "Content-Type": { value: "application/json", prefix: "" },
    },
  });
  assert.deepEqual(result.requestHeaders, {
    Authorization: "Bearer token-value",
    "X-Forwarded-User": "person",
    "Content-Type": "application/json",
  });
  assert.equal(result.expectedExpiresAt, "2026-07-20T17:48:53.000Z");
  assert.equal(
    manager.publicStatuses()[0].expectedExpiresAt,
    "2026-07-20T17:48:53.000Z",
  );
  assert.equal(
    JSON.stringify(manager.publicStatuses()).includes("token-value"),
    false,
  );
});

test("treats missing advisory expiry metadata as authenticated", async () => {
  const configured = authentication();
  configured.expectedExpiry = {
    jsonPointer: "/id_token/exp",
    format: "unix_seconds",
  };
  const manager = new AuthenticationManager({
    authSession: {
      async fetch() {
        return new Response("{}", {
          status: 200,
          headers: { "x-example-identity": "private-value" },
        });
      },
    },
  });

  const result = await manager.check(configured);
  assert.equal(result.authenticated, true);
  assert.equal(result.expectedExpiresAt, undefined);
});

test("treats Electron redirect cancellation as an unavailable application session", async () => {
  const manager = new AuthenticationManager({
    authSession: {
      async fetch() {
        throw new Error("Redirect was cancelled");
      },
    },
  });

  const result = await manager.check(authentication());
  assert.equal(result.authenticated, false);
  assert.equal(result.state, "unauthenticated");
  assert.equal(result.reason, "redirect-cancelled");
});

test("keeps shared SSO authenticated when capability header material is missing", async () => {
  const manager = new AuthenticationManager({
    authSession: {
      async fetch() {
        return new Response("{}", { status: 200 });
      },
    },
  });

  const result = await manager.check(authentication(), {
    requestHeaders: {
      Authorization: {
        responseHeader: "x-missing-token",
        prefix: "Bearer ",
      },
    },
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.identityMaterialAvailable, false);
  assert.equal(manager.publicStatuses()[0].state, "authenticated");
});

test("coalesces concurrent checks for one authentication profile", async () => {
  let fetches = 0;
  let release;
  const responseReady = new Promise((resolve) => {
    release = resolve;
  });
  const manager = new AuthenticationManager({
    authSession: {
      async fetch() {
        fetches += 1;
        await responseReady;
        return new Response("{}", { status: 200 });
      },
    },
  });
  const requestHeaders = {
    "X-Test": { value: "configured-value", prefix: "" },
  };

  const first = manager.check(authentication(), {
    reason: "request",
    requestHeaders,
  });
  const second = manager.check(authentication(), {
    reason: "request",
    requestHeaders,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.authenticated, true);
  assert.deepEqual(secondResult, firstResult);
});

test("tracks stable states separately from transient checking updates", async () => {
  const stableTransitions = [];
  const manager = new AuthenticationManager({
    authSession: {
      async fetch() {
        return new Response("{}", { status: 401 });
      },
    },
    onStatus: (status, _previous, previousStable) => {
      if (
        status.state !== "checking" &&
        previousStable?.state !== status.state
      ) {
        stableTransitions.push(status.state);
      }
    },
  });

  await manager.check(authentication());
  await manager.check(authentication());
  assert.deepEqual(stableTransitions, ["unauthenticated"]);
});

test("opens the configured login and resumes after authentication", async () => {
  const responses = [
    new Response("{}", { status: 401 }),
    new Response("{}", {
      status: 200,
      headers: { "x-example-identity": "private-value" },
    }),
  ];
  const required = [];
  const manager = new AuthenticationManager({
    authSession: {
      async fetch() {
        return responses.shift();
      },
    },
    onAuthenticationRequired: (event) => required.push(event),
  });
  const result = await manager.ensure(authentication(), {
    capability: "example.read",
    requestHeaders: {
      "x-example-identity": {
        responseHeader: "x-example-identity",
        prefix: "",
      },
    },
    timeoutMs: 100,
    pollInitialMs: 1,
    pollMaxMs: 1,
    requestId: "request-1",
  });

  assert.equal(result.authenticated, true);
  assert.deepEqual(required, [
    {
      authentication: "example_sso",
      displayName: "example_sso",
      capability: "example.read",
      requestId: "request-1",
      url: "https://app.example.test/login",
    },
  ]);
});

test("silently establishes an application session before requesting human sign-in", async () => {
  const responses = [
    new Response("{}", { status: 401 }),
    new Response("{}", {
      status: 200,
      headers: { "x-example-identity": "private-value" },
    }),
  ];
  const silent = [];
  const required = [];
  const manager = new AuthenticationManager({
    authSession: {
      async fetch() {
        return responses.shift();
      },
    },
    onSilentAuthentication: async (event) => silent.push(event),
    onAuthenticationRequired: (event) => required.push(event),
  });

  const result = await manager.ensure(authentication(), {
    capability: "example.read",
    requestHeaders: {
      "x-example-identity": {
        responseHeader: "x-example-identity",
        prefix: "",
      },
    },
    timeoutMs: 100,
    pollInitialMs: 1,
    requestId: "request-1",
  });

  assert.equal(result.authenticated, true);
  assert.deepEqual(silent, [
    {
      authentication: "example_sso",
      displayName: "example_sso",
      capability: "example.read",
      requestId: "request-1",
      url: "https://app.example.test/login",
    },
  ]);
  assert.deepEqual(required, []);
});
test("browser readiness probes share their in-flight result and preserve unavailable states", async () => {
  const manager = new AuthenticationManager();
  let release;
  let probes = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const options = { probeKey: "fixed-response", probe: async () => { probes++; await pending; } };
  const first = manager.checkBrowser(authentication(), options);
  const second = manager.checkBrowser(authentication(), options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
  release();
  assert.equal((await first).authenticated, true);
  assert.deepEqual(await second, await first);
  const required = await manager.checkBrowser(authentication(), {
    probeKey: "fixed-response", probe: async () => { throw Object.assign(new Error("login"), { code: "AUTHENTICATION_REQUIRED" }); },
  });
  assert.equal(required.authenticated, false);
  assert.equal(manager.publicStatuses()[0].state, "unauthenticated");
});

test("concurrent requests use one silent session handoff and never open visible login when ready", async () => {
  let ready = false;
  let handoffs = 0;
  let visible = 0;
  const manager = new AuthenticationManager({
    authSession: { fetch: async () => new Response("{}", { status: ready ? 200 : 401 }) },
    onSilentAuthentication: async () => { handoffs++; await new Promise((resolve) => setImmediate(resolve)); ready = true; },
    onAuthenticationRequired: () => { visible++; },
  });
  const options = { timeoutMs: 200, pollInitialMs: 1 };
  const results = await Promise.all([manager.ensure(authentication(), options), manager.ensure(authentication(), options)]);
  assert.ok(results.every((result) => result.authenticated && result.identityMaterialAvailable));
  assert.equal(handoffs, 1);
  assert.equal(visible, 0);
});
