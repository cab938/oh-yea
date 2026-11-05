import { spawn } from "node:child_process";

if (process.platform !== "darwin") throw new Error("smoke:macos requires macOS");
for (const script of ["scripts/electron-smoke.mjs", "scripts/electron-lifecycle.mjs"]) {
  const child = spawn(process.execPath, [script], { stdio: "inherit", env: process.env });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (code !== 0) { process.exitCode = 1; break; }
}
