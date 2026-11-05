// Test-only Electron entrypoint. Direct APIs keep lifecycle checks off the broker
// socket and avoid a debugging port or OS Accessibility permissions.
import { app, BrowserWindow, session } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { requestOnce } from "../src/lib/broker-client.mjs";
import { wait, electronTestArgs } from "./electron-process.mjs";
import "../src/main.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const socket = path.join(process.env.AGENT_BROKER_HOME, "broker.sock");
const mode = process.env.AGENT_BROKER_LIFECYCLE_MODE;
const exec = promisify(execFile);
const deadline = setTimeout(() => { console.error("Lifecycle test timed out"); app.exit(1); }, 35_000);

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await wait(100);
  }
  throw new Error("Lifecycle condition timed out");
}

async function run() {
try {
  await app.whenReady();
  let main;
  await until(async () => {
    main = BrowserWindow.getAllWindows().find((window) => window.getTitle() === "agent-broker");
    if (!main || main.webContents.isLoading()) return false;
    try { return (await requestOnce(socket, { operation: "services" }, 500)).ok; }
    catch { return false; }
  });
  const auth = session.fromPartition(process.env.AGENT_BROKER_DEV_PERSIST_AUTH === "1" ? "persist:agent-broker-auth" : "agent-broker-auth");
  const cookies = await auth.cookies.get({ name: "lifecycle-fixture" });
  assert.equal(cookies.length, mode === "restored" ? 1 : 0, "fresh ephemeral startup must not restore a prior login");
  await auth.cookies.set({ url: "http://127.0.0.1", name: "lifecycle-fixture", value: "fixture-only" });

  if (mode === "close") {
    const events = [];
    const state = () => ({ pid: process.pid, visible: main.isVisible(), focused: main.isFocused(), minimized: main.isMinimized(), focusable: main.isFocusable(), ...(process.platform === "darwin" ? { hidden: app.isHidden(), dock: app.dock.isVisible() } : {}) });
    for (const event of ["focus", "blur", "minimize", "restore", "show"]) main.on(event, () => events.push({ event, ...state() }));
    app.on("second-instance", () => events.push({ event: "second-instance", ...state() }));
    main.minimize();
    if (!process.argv.includes("--headless")) await until(() => main.isMinimized());
    let refocused = false;
    main.once("focus", () => { refocused = true; });
    const { stdout } = await exec(process.env.AGENT_BROKER_TEST_NODE, [path.join(root, "bin/agent-broker.mjs"), ...electronTestArgs()], {
      cwd: root, env: process.env, timeout: 10_000,
    });
    assert.equal(stdout.trim(), "");
    await until(() => !main.isMinimized());
    // Record the focus event: a user can switch apps after the CLI brings this
    // window forward, before the parent test process samples its current state.
    if (!process.argv.includes("--headless")) {
      try { await until(() => refocused); }
      catch { throw new Error(`Second launch did not focus its window: ${JSON.stringify({ events, state: state() })}`); }
    }
    assert.equal((await auth.cookies.get({ name: "lifecycle-fixture" })).length, 1);
    assert.equal(BrowserWindow.getAllWindows().filter((window) => window.getTitle() === "agent-broker").length, 1);
    const log = fs.readFileSync(path.join(process.env.AGENT_BROKER_HOME, "logs/agent-broker.jsonl"), "utf8");
    assert.equal(log.split('"event":"session.ephemeral"').length - 1, 1, "second launch reinitialized authentication");
    // A separate popup must not keep the broker alive when its main window closes.
    new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  }
  app.on("will-quit", (event) => {
    if (event.defaultPrevented) return;
    try {
      assert.equal(fs.existsSync(socket), false, "graceful quit left the broker socket behind");
      clearTimeout(deadline);
      process.stdout.write("LIFECYCLE_PASSED\n");
    } catch (error) { console.error(error); app.exit(1); }
  });
  process.stdout.write("LIFECYCLE_READY\n");
  if (mode === "close") main.close();
  else if (!["SIGTERM", "SIGINT"].includes(mode)) { app.quit(); app.quit(); }
} catch (error) {
  console.error(error);
  app.exit(1);
}
}
void run();
