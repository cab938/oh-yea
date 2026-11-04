import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  persistDevelopmentCookies,
  restoreDevelopmentCookies,
  watchDevelopmentCookies,
} from "../src/lib/session-persistence.mjs";

test("persists and restores session cookies in a user-only development jar", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-broker-cookies-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const snapshotPath = path.join(directory, "cookies.json");
  const source = {
    cookies: {
      async get() {
        return [
          {
            name: "session",
            value: "private-value",
            domain: ".example.test",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            session: true,
          },
        ];
      },
    },
  };
  await persistDevelopmentCookies(source, snapshotPath);
  assert.equal((await fs.stat(snapshotPath)).mode & 0o777, 0o600);

  const restored = [];
  const target = {
    cookies: {
      async set(cookie) {
        restored.push(cookie);
      },
    },
  };
  assert.equal(
    await restoreDevelopmentCookies(target, snapshotPath),
    1,
  );
  assert.equal(restored[0].url, "https://example.test/");
  assert.equal(restored[0].value, "private-value");
});

test("mirrors cookie changes while development persistence is active", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-broker-cookie-watch-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const snapshotPath = path.join(directory, "cookies.json");
  const cookies = new EventEmitter();
  cookies.get = async () => [
    {
      name: "session",
      value: "private-value",
      domain: ".example.test",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      session: true,
    },
  ];
  const watcher = watchDevelopmentCookies(
    { cookies },
    snapshotPath,
    { debounceMs: 5 },
  );
  t.after(() => watcher.stop());

  cookies.emit("changed");
  await new Promise((resolve) => setTimeout(resolve, 30));

  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  assert.equal(snapshot.cookies.length, 1);
  assert.equal(snapshot.cookies[0].value, "private-value");
  assert.equal((await fs.stat(snapshotPath)).mode & 0o777, 0o600);
});
