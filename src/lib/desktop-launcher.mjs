import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { requestOnce } from "./broker-client.mjs";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launchError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Resolve only an installed binary. Electron 43's require("electron") can download
// software synchronously; an agent's startup request must not do that implicitly.
export async function installedElectron(env = process.env) {
  try {
    const directory = path.dirname(require.resolve("electron"));
    const executable = (await fs.readFile(path.join(directory, "path.txt"), "utf8")).trim();
    const binary = path.join(env.ELECTRON_OVERRIDE_DIST_PATH ?? path.join(directory, "dist"), executable);
    await fs.access(binary, constants.X_OK);
    return binary;
  } catch {
    throw launchError("ELECTRON_NOT_INSTALLED", "Install the Electron binary first with npx install-electron --no");
  }
}

export async function checkDesktop(platform, env) {
  if (platform === "linux") {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
      throw launchError("DESKTOP_UNAVAILABLE", "Linux startup requires DISPLAY or WAYLAND_DISPLAY");
    }
  } else if (platform === "darwin") {
    try {
      await execFileAsync("/bin/launchctl", ["print", `gui/${process.getuid()}`], { timeout: 2_000 });
    } catch {
      throw launchError("DESKTOP_UNAVAILABLE", "macOS startup requires a logged-in graphical session");
    }
  } else {
    throw launchError("UNSUPPORTED_PLATFORM", "Desktop startup supports Linux and macOS");
  }
}

export async function startBroker({
  socketPath, projectRoot, env = process.env, platform = process.platform,
  electronArgs = [],
  timeoutMs = 30_000, request = requestOnce, resolveBinary = installedElectron,
  desktopCheck = checkDesktop, spawnProcess = spawn,
}) {
  const deadline = Date.now() + timeoutMs;
  async function discover() {
    try {
      const result = await request(socketPath, { operation: "services" }, Math.max(1, Math.min(1_000, deadline - Date.now())));
      if (!result.ok) throw launchError(result.error?.code ?? "DISCOVERY_UNAVAILABLE", "Broker discovery failed; check the service workflows");
      return true;
    } catch (error) {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code)) return false;
      throw error;
    }
  }

  if (await discover()) return { status: "already_running", pid: null };
  await desktopCheck(platform, env);
  const binary = await resolveBinary(env);
  const child = spawnProcess(binary, [projectRoot, ...electronArgs], { env, detached: true, stdio: "ignore" });
  let exited = false;
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  child.once("exit", () => { exited = true; });
  child.unref();
  try {
    while (Date.now() < deadline) {
      if (spawnError || exited) throw launchError("STARTUP_FAILED", "Electron exited before broker discovery became available");
      if (await discover()) return { status: "started", pid: child.pid };
      await wait(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    throw launchError("STARTUP_TIMEOUT", "Broker discovery did not become available within 30 seconds");
  } catch (error) {
    // Signal only this invocation's owned process; never stop a reused instance.
    if (child.pid && !exited) child.kill("SIGTERM");
    throw error;
  }
}
