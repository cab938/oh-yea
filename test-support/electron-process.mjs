import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function temporaryRuntime() {
  // macOS TMPDIR can be too long for a Unix-domain socket.
  const directory = await fs.mkdtemp(path.join("/tmp", "ab-"));
  await fs.chmod(directory, 0o700);
  return directory;
}

export async function groupAlive(group) {
  if (!Number.isSafeInteger(group) || group <= 1) return false;
  const { stdout } = await exec("ps", ["-axo", "pgid=,stat="]);
  return stdout.trim().split("\n").some((line) => {
    const [id, state] = line.trim().split(/\s+/);
    return Number(id) === group && !state.startsWith("Z");
  });
}

export function signalGroup(group, signal = "SIGTERM") {
  if (!Number.isSafeInteger(group) || group <= 1) return;
  try { process.kill(-group, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

export async function stopGroup(group) {
  signalGroup(group);
  const deadline = Date.now() + 5_000;
  while (await groupAlive(group) && Date.now() < deadline) await wait(100);
  if (await groupAlive(group)) {
    signalGroup(group, "SIGKILL");
    throw new Error("Owned Electron process group required forced teardown");
  }
}

export function electronTestArgs() {
  return process.platform === "linux" ? [
    ...(process.env.AGENT_BROKER_SMOKE_HEADFUL === "1" ? [] : ["--headless"]),
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  ] : [];
}

export function checkSmokePlatform() {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("Electron smoke supports Linux and macOS");
  if (process.platform === "linux" && process.env.AGENT_BROKER_SMOKE_HEADFUL === "1" &&
      (!/^:(?:9\d|10\d|11\d)$/.test(process.env.DISPLAY ?? "") ||
       !path.basename(path.dirname(process.env.XAUTHORITY ?? "")).startsWith("native-x11-headless-session."))) {
    throw new Error("Visible Linux startup checks require the private Xvfb harness");
  }
}
