import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadCapabilityDirectory,
  saveCapabilityFile,
  watchCapabilityDirectory,
} from "../src/lib/capability-store.mjs";
import { parseConfig } from "../src/lib/config.mjs";
import { ACTIVE_CAPABILITY, TEST_CONFIG } from "../test-support/fixtures.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-broker-capabilities-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("loads one validated capability per YAML file", async (t) => {
  const directory = await temporaryDirectory(t);
  const authentications = parseConfig(TEST_CONFIG).authentications;
  await fs.writeFile(
    path.join(directory, "arc.remaining_hours.read.yaml"),
    ACTIVE_CAPABILITY,
  );
  const loaded = await loadCapabilityDirectory(directory, authentications);
  assert.equal(loaded.capabilities.length, 1);
  assert.equal(loaded.files[0].valid, true);
  assert.equal((await fs.stat(loaded.files[0].path)).mode & 0o777, 0o600);
});

test("keeps invalid capability files visible but unavailable", async (t) => {
  const directory = await temporaryDirectory(t);
  await fs.writeFile(
    path.join(directory, "wrong-name.yaml"),
    ACTIVE_CAPABILITY,
  );
  const loaded = await loadCapabilityDirectory(
    directory,
    parseConfig(TEST_CONFIG).authentications,
  );
  assert.equal(loaded.capabilities.length, 0);
  assert.equal(loaded.files[0].valid, false);
  assert.match(loaded.files[0].error.message, /must match its filename/);
});

test("creates and updates capability files without renaming them", async (t) => {
  const directory = await temporaryDirectory(t);
  const authentications = parseConfig(TEST_CONFIG).authentications;
  const created = await saveCapabilityFile(directory, authentications, {
    fileName: null,
    text: ACTIVE_CAPABILITY,
  });
  assert.equal(created.fileName, "arc.remaining_hours.read.yaml");
  await saveCapabilityFile(directory, authentications, {
    fileName: created.fileName,
    text: ACTIVE_CAPABILITY.replace("enabled: true", "enabled: false"),
  });
  const loaded = await loadCapabilityDirectory(directory, authentications);
  assert.equal(loaded.capabilities[0].enabled, false);
});

test("watches capability files for external changes", async (t) => {
  const directory = await temporaryDirectory(t);
  let resolveChanged;
  const changed = new Promise((resolve) => {
    resolveChanged = resolve;
  });
  const watcher = watchCapabilityDirectory(directory, resolveChanged);
  t.after(() => watcher.stop());
  await fs.writeFile(
    path.join(directory, "arc.remaining_hours.read.yaml"),
    ACTIVE_CAPABILITY,
  );
  await Promise.race([
    changed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Capability watcher timed out")), 2_000),
    ),
  ]);
});

test("reloading from a watcher does not create a chmod feedback loop", async (t) => {
  const directory = await temporaryDirectory(t);
  const authentications = parseConfig(TEST_CONFIG).authentications;
  const target = path.join(
    directory,
    "arc.remaining_hours.read.yaml",
  );
  await fs.writeFile(target, ACTIVE_CAPABILITY);
  await loadCapabilityDirectory(directory, authentications);

  let changes = 0;
  let resolveChanged;
  const changed = new Promise((resolve) => {
    resolveChanged = resolve;
  });
  const watcher = watchCapabilityDirectory(directory, async () => {
    changes += 1;
    await loadCapabilityDirectory(directory, authentications);
    resolveChanged();
  });
  t.after(() => watcher.stop());

  await fs.writeFile(
    target,
    ACTIVE_CAPABILITY.replace("enabled: true", "enabled: false"),
  );
  await Promise.race([
    changed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Capability watcher timed out")), 2_000),
    ),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(changes, 1);
});

test("observes immediate create, atomic replacement, and removal in a newly watched directory", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "example.yaml");
  let changes = 0;
  const watcher = watchCapabilityDirectory(directory, () => { changes++; });
  t.after(() => watcher.stop());
  async function observed(action) {
    const before = changes;
    await action();
    const deadline = Date.now() + 2_000;
    while (changes === before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(changes > before, "watcher missed an external capability edit");
  }
  await observed(() => fs.writeFile(target, "enabled: false\n"));
  await observed(async () => {
    await fs.writeFile(`${target}.tmp`, "enabled: true\n");
    await fs.rename(`${target}.tmp`, target);
  });
  await observed(() => fs.unlink(target));
  watcher.stop();
  const stopped = changes;
  await fs.writeFile(target, "enabled: false\n");
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(changes, stopped, "stopped watcher still emitted changes");
});
