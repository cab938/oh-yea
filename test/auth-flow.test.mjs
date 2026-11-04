import test from "node:test";
import assert from "node:assert/strict";
import {
  canRetrySettledAuthReturn,
  matchesConfiguredTarget,
  transitionForNavigation,
} from "../src/renderer/auth-flow.mjs";

const target =
  "https://arc.example.test/project/example/account/example0";

function job(overrides = {}) {
  return {
    definition: { url: target },
    phase: "navigating-target",
    sawForeignOrigin: false,
    authRetryCount: 0,
    authNotified: false,
    waitLogged: false,
    ...overrides,
  };
}

test("recognizes the configured target while ignoring fragments", () => {
  assert.equal(matchesConfiguredTarget(`${target}#section`, target), true);
  const transition = transitionForNavigation(job(), target);
  assert.equal(transition.action, "target");
  assert.equal(transition.patch.phase, "target");
});

test("records a navigation to an external authentication origin", () => {
  const transition = transitionForNavigation(
    job({ phase: "target" }),
    "https://weblogin.umich.edu/login",
  );
  assert.equal(transition.action, "await-auth");
  assert.equal(transition.patch.phase, "awaiting-auth");
  assert.equal(transition.patch.sawForeignOrigin, true);
});

test("waits for the return page to settle when authentication returns to its origin", () => {
  const transition = transitionForNavigation(
    job({
      phase: "awaiting-auth",
      sawForeignOrigin: true,
      authNotified: true,
      waitLogged: true,
    }),
    "https://arc.example.test/",
  );
  assert.equal(transition.action, "auth-returned");
  assert.deepEqual(transition.patch, {
    phase: "auth-returned",
    retryStrategy: "reload",
  });
});

test("retries only after the authentication return page has settled", () => {
  assert.equal(
    canRetrySettledAuthReturn(
      job({
        phase: "auth-returned",
        sawForeignOrigin: true,
      }),
      "https://arc.example.test/",
    ),
    true,
  );
  assert.equal(
    canRetrySettledAuthReturn(
      job({
        phase: "awaiting-auth",
        sawForeignOrigin: true,
      }),
      "https://arc.example.test/",
    ),
    false,
  );
});

test("preserves post-authentication context at the exact target", () => {
  const transition = transitionForNavigation(
    job({
      phase: "auth-returned",
      sawForeignOrigin: true,
    }),
    target,
  );
  assert.equal(transition.action, "target");
  assert.deepEqual(transition.patch, {
    phase: "target-after-auth",
    sawForeignOrigin: true,
    authNotified: false,
  });
});

test("switches to in-page navigation when an unready target bounces to the portal root", () => {
  const transition = transitionForNavigation(
    job({
      phase: "target-after-auth",
      sawForeignOrigin: true,
      authRetryCount: 1,
      waitLogged: true,
    }),
    "https://arc.example.test/",
  );
  assert.equal(transition.action, "target-bounced");
  assert.deepEqual(transition.patch, {
    phase: "auth-returned",
    retryStrategy: "in-page",
  });
});

test("detects an unready target bounce without an OAuth redirect in this request", () => {
  const transition = transitionForNavigation(
    job({
      phase: "target",
      sawForeignOrigin: false,
      waitLogged: true,
    }),
    "https://arc.example.test/",
  );
  assert.equal(transition.action, "target-bounced");
  assert.deepEqual(transition.patch, {
    phase: "auth-returned",
    retryStrategy: "in-page",
  });
});

test("does not mistake an initial same-origin redirect for completed authentication", () => {
  const transition = transitionForNavigation(
    job(),
    "https://arc.example.test/",
  );
  assert.equal(transition.action, "await-auth");
  assert.equal(transition.patch.sawForeignOrigin, false);
});

test("bounds post-authentication retries", () => {
  const transition = transitionForNavigation(
    job({
      phase: "awaiting-auth",
      sawForeignOrigin: true,
      authRetryCount: 2,
    }),
    "https://arc.example.test/",
  );
  assert.equal(transition.action, "retry-exhausted");
  assert.equal(
    canRetrySettledAuthReturn(
      job({
        phase: "auth-returned",
        authRetryCount: 2,
      }),
      "https://arc.example.test/",
    ),
    false,
  );
});
