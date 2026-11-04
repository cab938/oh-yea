import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LogStore } from "../src/lib/log-store.mjs";

test("persists redacted awareness events to a user-only JSON Lines file", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-broker-logs-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "logs", "agent-broker.jsonl");
  const logs = new LogStore({ filePath });

  const entry = logs.add("info", "test.event", "Recorded safely", {
    url: "https://example.test/path?private=yes#fragment",
    token: "must-not-be-written",
    nested: {
      cookie: "must-not-be-written",
      kept: 42,
    },
  });

  assert.equal(entry.url, "https://example.test/path");
  assert.equal("token" in entry, false);
  assert.deepEqual(entry.nested, { kept: 42 });
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(persisted, entry);
  assert.equal((await fs.stat(path.dirname(filePath))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});
