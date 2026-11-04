import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { readServiceTokens } from "../src/lib/caller-token.mjs";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/add-service-token.mjs", import.meta.url));
const setup = (home, service) => run(process.execPath, [script, service], {
  env: { ...process.env, AGENT_BROKER_HOME: home, AGENT_BROKER_CONFIG: "" },
});

test("operator token setup creates private, distinct service tokens without replacing or displaying existing values", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "broker-token-setup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home");
  const first = await setup(home, "sample-service");
  const file = path.join(home, ".env");
  const original = `# Operator settings\nEXTRA_SETTING=preserved\n${(await fs.readFile(file, "utf8")).trimEnd()}`;
  await fs.writeFile(file, original);
  const unchanged = await setup(home, "sample-service");
  assert.equal(await fs.readFile(file, "utf8"), original);
  const next = await setup(home, "another-service");
  assert.ok((await fs.readFile(file, "utf8")).startsWith(`${original}\n`));
  const tokens = await readServiceTokens(file);
  assert.deepEqual(Object.keys(tokens).sort(), ["another-service", "sample-service"]);
  assert.notEqual(tokens["sample-service"], tokens["another-service"]);
  for (const result of [first, unchanged, next]) {
    for (const token of Object.values(tokens)) assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
  }
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
});

test("operator token setup rejects invalid services and insecure files without changing existing contents", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "broker-token-reject-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await assert.rejects(setup(home, "../invalid"));
  await assert.rejects(fs.stat(path.join(home, ".env")), { code: "ENOENT" });
  const file = path.join(home, ".env");
  const contents = "AGENT_BROKER_TOKEN_EXISTING=private-existing-token";
  await fs.writeFile(file, contents, { mode: 0o644 });
  await assert.rejects(setup(home, "new-service"), (error) => {
    assert.match(error.stderr, /mode-0600/);
    assert.equal(error.stderr.includes("private-existing-token"), false);
    return true;
  });
  assert.equal(await fs.readFile(file, "utf8"), contents);
});
