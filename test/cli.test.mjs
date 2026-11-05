import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerServer } from "../src/lib/broker-server.mjs";
import { capabilityCatalog } from "../src/lib/config.mjs";
import { configured } from "../test-support/fixtures.mjs";
import { publishServices } from "../src/lib/services.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/agent-broker.mjs", ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("one-shot CLI connects using the token environment variable", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-broker-cli-"));
  const socketPath = path.join(directory, "broker.sock");
  const config = configured();
  const server = new BrokerServer({
    socketPath,
    configProvider: () => config,
    capabilityCatalogProvider: () => capabilityCatalog(config),
    executor: async ({ input }) => ({ remaining: 42, input }),
  });
  await server.start();
  t.after(async () => {
    await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const result = await runCli(
    [
      "connect",
      "--id",
      "cli-test",
      "--capability",
      "arc.remaining_hours.read",
      "--input",
      '{"caller":"node-test"}',
    ],
    {
      AGENT_BROKER_HOME: directory,
      AGENT_BROKER_TOKEN: "replace-with-a-long-random-token",
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: "cli-test",
    ok: true,
    data: { remaining: 42, input: { caller: "node-test" } },
    meta: { capability: "arc.remaining_hours.read" },
  });
});

test("one-shot CLI connects using the private service .env", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-broker-cli-"));
  const socketPath = path.join(directory, "broker.sock");
  await fs.writeFile(
    path.join(directory, ".env"),
    "AGENT_BROKER_TOKEN_ARC=replace-with-a-long-random-token\nAGENT_BROKER_TOKEN_UMGPT=unique-umgpt-test-token\n",
    { mode: 0o600 },
  );
  const config = configured();
  config.serviceTokens.umgpt = "unique-umgpt-test-token";
  config.capabilities.push({...config.capabilities[0],name:"umich.umgpt.models.list",service:"umgpt"});
  const server = new BrokerServer({
    socketPath,
    configProvider: () => config,
    capabilityCatalogProvider: () => capabilityCatalog(config),
    executor: async () => ({ remaining: 42 }),
  });
  await server.start();
  t.after(async () => {
    await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const result = await runCli(
    [
      "connect",
      "--id",
      "cli-file-token",
      "--capability",
      "arc.remaining_hours.read",
      "--input",
      "{}",
    ],
    {
      AGENT_BROKER_HOME: directory,
      AGENT_BROKER_TOKEN: "",
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: "cli-file-token",
    ok: true,
    data: { remaining: 42 },
    meta: { capability: "arc.remaining_hours.read" },
  });
  const second = await runCli(["connect","--capability","umich.umgpt.models.list"], {AGENT_BROKER_HOME:directory,AGENT_BROKER_TOKEN:""});
  assert.equal(second.code,0,second.stdout);
  assert.equal(JSON.parse(second.stdout).meta.capability,"umich.umgpt.models.list");
  const wrong = await runCli(["connect","--capability","umich.umgpt.models.list"], {AGENT_BROKER_HOME:directory,AGENT_BROKER_TOKEN:config.serviceTokens.arc});
  assert.equal(JSON.parse(wrong.stdout).error.code,"UNAUTHORIZED");
});

test("CLI services returns public file pointers without loading or revealing service tokens", async (t) => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"broker-cli-services-"));
  const config=configured();
  const server=new BrokerServer({
    socketPath:path.join(directory,"broker.sock"),configProvider:()=>config,
    executor:async()=>{throw new Error("discovery must not execute capabilities");},
    serviceCatalogProvider:()=>publishServices({sourceDirectory:path.join(root,"services"),directory:path.join(directory,"services"),config}),
  });
  await server.start();
  t.after(async()=>{await server.stop();await fs.rm(directory,{recursive:true,force:true});});
  const result=await runCli(["services"],{AGENT_BROKER_HOME:directory});
  assert.equal(result.code,0,result.stdout);
  const response=JSON.parse(result.stdout);
  assert.deepEqual(response.meta,{operation:"services"});
  assert.equal(response.data.length,4);
  for(const service of response.data) {
    await fs.access(service.workflow_file);
    const text=await fs.readFile(service.capabilities_file,"utf8");
    assert.equal(text.includes(config.serviceTokens.arc),false);
    assert.equal(text.includes("requestHeaders"),false);
  }
  assert.equal(result.stdout.includes(".env"),false);
  const started = await runCli(["start"], { AGENT_BROKER_HOME: directory, DISPLAY: "", WAYLAND_DISPLAY: "" });
  assert.equal(started.code, 0, started.stdout);
  assert.deepEqual(JSON.parse(started.stdout).data, { status: "already_running", pid: null });
});

test("CLI inspects the browser without a capability token", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-broker-cli-"));
  const socketPath = path.join(directory, "broker.sock");
  const config = configured();
  const server = new BrokerServer({
    socketPath,
    configProvider: () => config,
    capabilityCatalogProvider: () => capabilityCatalog(config),
    executor: async () => null,
    operatorExecutor: async ({ command, selector }) => ({
      command,
      selector,
      found: true,
    }),
  });
  await server.start();
  t.after(async () => {
    await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const result = await runCli(
    ["inspect", "query", "--selector", "app-remaining-hours"],
    { AGENT_BROKER_HOME: directory },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: JSON.parse(result.stdout).id,
    ok: true,
    data: {
      command: "query",
      selector: "app-remaining-hours",
      found: true,
    },
    meta: { operation: "inspect", command: "query" },
  });
});

test("CLI sends a named capability to the authentication probe", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-broker-cli-"));
  const socketPath = path.join(directory, "broker.sock");
  const config = configured();
  const server = new BrokerServer({
    socketPath,
    configProvider: () => config,
    capabilityCatalogProvider: () => capabilityCatalog(config),
    executor: async () => null,
    operatorExecutor: async ({ command, capability }) => ({
      command,
      capability,
      authenticated: false,
    }),
  });
  await server.start();
  t.after(async () => {
    await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const result = await runCli(
    [
      "inspect",
      "auth",
      "--capability",
      "arc.remaining_hours.read",
    ],
    { AGENT_BROKER_HOME: directory },
  );

  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.deepEqual(response.data, {
    command: "auth",
    capability: "arc.remaining_hours.read",
    authenticated: false,
  });
});

test("CLI returns capability contracts as JSON", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-broker-cli-"));
  const socketPath = path.join(directory, "broker.sock");
  const config = configured();
  const server = new BrokerServer({
    socketPath,
    configProvider: () => config,
    capabilityCatalogProvider: () => capabilityCatalog(config),
    executor: async () => null,
  });
  await server.start();
  t.after(async () => {
    await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const result = await runCli(["capabilities"], {
    AGENT_BROKER_HOME: directory,
  });
  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.equal(response.data[0].name, "arc.remaining_hours.read");
  assert.deepEqual(response.meta, { operation: "capabilities" });
});
