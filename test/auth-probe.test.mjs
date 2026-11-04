import test from "node:test";
import assert from "node:assert/strict";
import { probeSessionAuthentication } from "../src/lib/auth-probe.mjs";

function fakeSession(responses) {
  const calls = [];
  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("authentication probe stops before an external identity-provider redirect", async () => {
  const authSession = fakeSession([
    new Response(null, {
      status: 302,
      headers: {
        location:
          "https://shibboleth.umich.edu/idp/profile/oidc/authorize?code=secret",
      },
    }),
  ]);

  const result = await probeSessionAuthentication(
    authSession,
    "https://arc.example.test/protected",
  );

  assert.equal(result.authenticated, false);
  assert.equal(result.reason, "external-authentication-redirect");
  assert.equal(
    result.redirectTo,
    "https://shibboleth.umich.edu/idp/profile/oidc/authorize",
  );
  assert.equal(authSession.calls.length, 1);
  assert.equal(authSession.calls[0].options.credentials, "include");
  assert.equal(authSession.calls[0].options.redirect, "manual");
});

test("authentication probe follows same-origin redirects and accepts a target-origin response", async () => {
  const authSession = fakeSession([
    new Response(null, {
      status: 302,
      headers: { location: "/application" },
    }),
    new Response(null, { status: 404 }),
  ]);

  const result = await probeSessionAuthentication(
    authSession,
    "https://arc.example.test/protected",
  );

  assert.equal(result.authenticated, true);
  assert.equal(result.status, 404);
  assert.equal(result.targetReachable, false);
  assert.equal(authSession.calls.length, 2);
});

test("authentication probe reports protected responses as unauthenticated", async () => {
  const authSession = fakeSession([new Response(null, { status: 403 })]);
  const result = await probeSessionAuthentication(
    authSession,
    "https://arc.example.test/protected",
  );
  assert.equal(result.authenticated, false);
  assert.equal(result.reason, "protected-response");
});

test("authentication probe reports network failures as inconclusive", async () => {
  const authSession = fakeSession([new Error("network unavailable")]);
  const result = await probeSessionAuthentication(
    authSession,
    "https://arc.example.test/protected",
  );
  assert.equal(result.authenticated, null);
  assert.equal(result.reason, "probe-failed");
});
