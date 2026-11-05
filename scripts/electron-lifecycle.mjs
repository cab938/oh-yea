import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installedElectron } from "../src/lib/desktop-launcher.mjs";
import { temporaryRuntime, checkSmokePlatform, electronTestArgs, groupAlive, stopGroup, wait } from "../test-support/electron-process.mjs";

checkSmokePlatform();
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const binary = await installedElectron();
const directory = await temporaryRuntime();
const env = { ...process.env, AGENT_BROKER_HOME: directory, AGENT_BROKER_DEV_PERSIST_AUTH: "0", AGENT_BROKER_TEST_NODE: process.execPath };
delete env.AGENT_BROKER_CONFIG;
delete env.AGENT_BROKER_TOKEN;
delete env.AGENT_BROKER_SMOKE_SCREENSHOT;
let group;
let transcript = "";

async function run(mode, persistent = false) {
  const child = spawn(binary, ["test-support/electron-lifecycle.mjs", ...electronTestArgs()], {
    cwd: root, env: { ...env, AGENT_BROKER_LIFECYCLE_MODE: mode, AGENT_BROKER_DEV_PERSIST_AUTH: persistent ? "1" : "0" },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  group = child.pid;
  let output = "";
  let signaled = false;
  child.stdout.on("data", (data) => {
    output += data;
    transcript += data;
    if (!signaled && ["SIGTERM", "SIGINT"].includes(mode) && output.includes("LIFECYCLE_READY")) {
      signaled = true;
      child.kill(mode);
    }
  });
  child.stderr.on("data", (data) => { transcript += data; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, transcript);
  assert.ok(output.includes("LIFECYCLE_PASSED"), transcript);
  assert.equal(await groupAlive(group), false, "lifecycle left an owned Electron process behind");
  await assert.rejects(fs.access(path.join(directory, "broker.sock")), { code: "ENOENT" });
  group = undefined;
}

try {
  for (const mode of ["close", "quit", "SIGTERM", "SIGINT"]) await run(mode);
  await run("quit", true);
  const snapshot = JSON.parse(await fs.readFile(path.join(directory, "development-cookies.json"), "utf8"));
  assert.ok(JSON.stringify(snapshot).includes("lifecycle-fixture"), "development cookies were not flushed");
  await run("restored", true);
  await run("quit");
  await assert.rejects(fs.access(path.join(directory, "development-cookies.json")), { code: "ENOENT" });

  // The real public CLI must return while its detached Electron process survives.
  const { stdout } = await exec(process.execPath, ["bin/agent-broker.mjs", "start", "--", ...electronTestArgs()], { cwd: root, env, timeout: 35_000 });
  const started = JSON.parse(stdout);
  assert.equal(started.ok, true, stdout);
  assert.equal(started.data.status, "started");
  group = started.data.pid;
  await wait(250);
  assert.equal(await groupAlive(group), true, "background broker did not survive the CLI");
  const reused = JSON.parse((await exec(process.execPath, ["bin/agent-broker.mjs", "start"], { cwd: root, env, timeout: 5_000 })).stdout);
  assert.deepEqual(reused.data, { status: "already_running", pid: null });
  await stopGroup(group);
  group = undefined;
  await assert.rejects(fs.access(path.join(directory, "broker.sock")), { code: "ENOENT" });
  console.log("Electron lifecycle passed: restore/focus, session reuse, close with popup, Quit, SIGTERM, SIGINT, ephemeral restart, persistence flush, and detached CLI start");
} catch (error) {
  console.error(error, transcript);
  process.exitCode = 1;
} finally {
  try { await stopGroup(group); } catch (error) { console.error(error); process.exitCode = 1; }
  await fs.rm(directory, { recursive: true, force: true });
}
