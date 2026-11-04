import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EPHEMERAL_AUTH_PARTITION,
  PERSISTENT_AUTH_PARTITION,
  authenticationSessionPolicy,
  clearLegacyAuthenticationState,
} from "../src/lib/session-policy.mjs";

test("uses an ephemeral authentication partition by default", () => {
  assert.deepEqual(authenticationSessionPolicy({}), {
    developmentPersistence: false,
    partition: EPHEMERAL_AUTH_PARTITION,
  });
  assert.equal(EPHEMERAL_AUTH_PARTITION.startsWith("persist:"), false);
});

test("requires an explicit development flag for persistent authentication", () => {
  assert.deepEqual(
    authenticationSessionPolicy({
      AGENT_BROKER_DEV_PERSIST_AUTH: "1",
    }),
    {
      developmentPersistence: true,
      partition: PERSISTENT_AUTH_PARTITION,
    },
  );
  assert.equal(
    authenticationSessionPolicy({
      AGENT_BROKER_DEV_PERSIST_AUTH: "true",
    }).developmentPersistence,
    false,
  );
});

test("normal startup clears legacy browser state and its cookie snapshot", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-broker-session-policy-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const snapshotPath = path.join(directory, "development-cookies.json");
  await fs.writeFile(snapshotPath, "sensitive development state");
  const calls = [];
  const persistentSession = {
    async clearStorageData() {
      calls.push("storage");
    },
    async clearCache() {
      calls.push("cache");
    },
    async clearAuthCache() {
      calls.push("auth-cache");
    },
  };

  await clearLegacyAuthenticationState(
    persistentSession,
    snapshotPath,
  );

  assert.deepEqual(calls, ["storage", "cache", "auth-cache"]);
  await assert.rejects(fs.stat(snapshotPath), { code: "ENOENT" });
});

test("the renderer leaves authentication partition selection to the main process", async () => {
  const html = await fs.readFile(
    new URL("../src/renderer/index.html", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(html, /\bpartition=/u);
  assert.match(html, /id="development-auth-persistence"/u);
});
