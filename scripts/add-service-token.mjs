import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { readServiceTokens, serviceTokenKey } from "../src/lib/caller-token.mjs";
import { runtimePaths } from "../src/lib/paths.mjs";

async function addServiceToken(service) {
  const key = serviceTokenKey(service);
  const file = runtimePaths().serviceTokens;
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("The configuration directory must be an ordinary mode-0700 directory");
  }

  // Append one entry without exposing or replacing any existing service token.
  const handle = await fs.open(file,
    constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const tokens = await readServiceTokens(file);
    if (Object.hasOwn(tokens, service)) {
      process.stdout.write(`Service ${service} already has a token; unchanged.\n`);
      return;
    }
    const existing = await handle.readFile("utf8");
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await handle.writeFile(`${separator}${key}=${crypto.randomBytes(32).toString("hex")}\n`);
    process.stdout.write(`Created a token for ${service}; restart the broker to load it. Token values were not displayed.\n`);
  } finally {
    await handle.close();
  }
}

if (process.argv.length !== 3) {
  process.stderr.write("Usage: npm run add-service-token -- SERVICE_ID\n");
  process.exitCode = 1;
} else {
  await addServiceToken(process.argv[2]).catch((error) => {
    process.stderr.write(`Service token setup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
