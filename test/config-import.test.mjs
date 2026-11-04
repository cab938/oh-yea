import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ACTIVE_CAPABILITY, TEST_CONFIG } from "../test-support/fixtures.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/import-config.mjs", import.meta.url));

test("explicit import copies configuration privately, retains journals and refuses overwrite", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "broker-import-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination");
  await fs.mkdir(path.join(source, "capabilities"), { recursive: true });
  await fs.writeFile(path.join(source, "config.yaml"), TEST_CONFIG);
  const token = "AGENT_BROKER_TOKEN_ARC=private-import-test-token\n";
  await fs.writeFile(path.join(source, ".env"), token, { mode: 0o600 });
  const filename = "arc.remaining_hours.read.yaml";
  await fs.writeFile(path.join(source, "capabilities", filename), ACTIVE_CAPABILITY);
  await fs.mkdir(path.join(destination, "submissions"), { recursive: true });
  await fs.writeFile(path.join(destination, "submissions", "existing.json"), "preserved");
  const env = { ...process.env, AGENT_BROKER_HOME: destination };
  delete env.AGENT_BROKER_CONFIG;
  const result = await exec(process.execPath, [script, source], { env });
  assert.ok(!result.stdout.includes("private-import-test-token"));
  for (const relative of ["config.yaml", ".env", `capabilities/${filename}`]) {
    assert.equal(await fs.readFile(path.join(destination, relative), "utf8"), await fs.readFile(path.join(source, relative), "utf8"));
    assert.equal((await fs.stat(path.join(destination, relative))).mode & 0o777, 0o600);
  }
  assert.equal(await fs.readFile(path.join(destination, "submissions/existing.json"), "utf8"), "preserved");
  await assert.rejects(exec(process.execPath, [script, source], { env }), /would overwrite/);
  assert.equal(await fs.readFile(path.join(destination, ".env"), "utf8"), token);
});

test("an invalid source fails before copying any configuration", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "broker-import-invalid-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination");
  await fs.mkdir(path.join(source, "capabilities"), { recursive: true });
  await fs.writeFile(path.join(source, "config.yaml"), TEST_CONFIG);
  await fs.writeFile(path.join(source, "capabilities/wrong.yaml"), ACTIVE_CAPABILITY);
  const env = { ...process.env, AGENT_BROKER_HOME: destination };
  delete env.AGENT_BROKER_CONFIG;
  await assert.rejects(exec(process.execPath, [script, source], { env }), /must match/);
  await assert.rejects(fs.access(destination), { code: "ENOENT" });
});
