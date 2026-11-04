import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCallerToken, readServiceTokens } from "../src/lib/caller-token.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-broker-token-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("uses explicit and environment tokens before the service token file", async () => {
  assert.equal(
    await resolveCallerToken({
      explicitToken: "explicit-token",
      environmentToken: "environment-token",
      filePath: "/does/not/exist",
    }),
    "explicit-token",
  );
  assert.equal(
    await resolveCallerToken({
      environmentToken: "environment-token",
      filePath: "/does/not/exist",
    }),
    "environment-token",
  );
});

test("selects the service token from a private dotenv file without evaluating it", async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, ".env");
  await fs.writeFile(filePath, 'AGENT_BROKER_TOKEN_ARC="stored-token"\nAGENT_BROKER_TOKEN_UMGPT=other-service-token\nIGNORED=$(do-not-execute)\n', { mode: 0o600 });

  assert.equal(await resolveCallerToken({ filePath, service: "arc" }), "stored-token");
  assert.equal(await resolveCallerToken({ filePath, service: "umgpt" }), "other-service-token");
  await assert.rejects(resolveCallerToken({ filePath, service: "missing" }), {code:"TOKEN_NOT_CONFIGURED"});
  await assert.rejects(resolveCallerToken({ filePath, service: "constructor" }), {code:"TOKEN_NOT_CONFIGURED"});
});

test("rejects insecure, symlinked, and shared service token files", async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, ".env");
  await fs.writeFile(filePath, "AGENT_BROKER_TOKEN_ARC=stored-token\n", { mode: 0o644 });
  await fs.chmod(filePath, 0o644);

  await assert.rejects(
    resolveCallerToken({ filePath, service: "arc" }),
    (error) => error.code === "TOKEN_FILE_INSECURE",
  );
  await fs.chmod(filePath, 0o600);
  const link = path.join(directory, "link.env");
  await fs.symlink(filePath, link);
  await assert.rejects(readServiceTokens(link), {code:"TOKEN_FILE_INSECURE"});
  await fs.appendFile(filePath, "AGENT_BROKER_TOKEN_UMGPT=stored-token\n");
  await assert.rejects(readServiceTokens(filePath), {code:"TOKEN_NOT_CONFIGURED"});
});
