import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrokerServer } from "../src/lib/broker-server.mjs";
import { requestOnce } from "../src/lib/broker-client.mjs";
import { capabilityCatalog } from "../src/lib/config.mjs";
import { configured } from "../test-support/fixtures.mjs";

test("serves authorized extraction requests over a user-only socket", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-broker-test-"));
  const socketPath = path.join(directory, "broker.sock");
  const config = configured();
  const calls = [];
  const server = new BrokerServer({
    socketPath,
    configProvider: () => config,
    executor: async (job) => {
      calls.push(job);
      return "<app-remaining-hours>42</app-remaining-hours>";
    },
  });

  await server.start();
  t.after(async () => {
    await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const mode = (await fs.stat(socketPath)).mode & 0o777;
  assert.equal(mode, 0o600);

  const response = await requestOnce(socketPath, {
    id: "test-1",
    capability: "arc.remaining_hours.read",
    token: "replace-with-a-long-random-token",
    input: { source: "test" },
  });

  assert.deepEqual(response, {
    id: "test-1",
    ok: true,
    data: "<app-remaining-hours>42</app-remaining-hours>",
    meta: { capability: "arc.remaining_hours.read" },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { source: "test" });
});

test("does not invoke the extractor for a rejected request", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-broker-test-"));
  const socketPath = path.join(directory, "broker.sock");
  const config = configured();
  let invoked = false;
  const server = new BrokerServer({
    socketPath,
    configProvider: () => config,
    executor: async () => {
      invoked = true;
    },
  });

  await server.start();
  t.after(async () => {
    await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const response = await requestOnce(socketPath, {
    id: "test-2",
    capability: "arc.remaining_hours.read",
    token: "wrong-token-value",
    input: {},
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "UNAUTHORIZED");
  assert.equal(invoked, false);
});

test("serves operator browser inspection over the user-only socket", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-broker-test-"));
  const socketPath = path.join(directory, "broker.sock");
  const config = configured();
  const calls = [];
  const server = new BrokerServer({
    socketPath,
    configProvider: () => config,
    executor: async () => {
      throw new Error("Extractor should not run for inspection");
    },
    operatorExecutor: async (request) => {
      calls.push(request);
      return {
        url: "https://arc.example.test/",
        readyState: "complete",
      };
    },
  });

  await server.start();
  t.after(async () => {
    await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const response = await requestOnce(socketPath, {
    id: "inspect-1",
    operation: "inspect",
    command: "summary",
  });

  assert.deepEqual(response, {
    id: "inspect-1",
    ok: true,
    data: {
      url: "https://arc.example.test/",
      readyState: "complete",
    },
    meta: { operation: "inspect", command: "summary" },
  });
  assert.equal(calls.length, 1);
});

test("serves capability contracts without exposing extraction internals", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-broker-test-"));
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

  const response = await requestOnce(socketPath, {
    id: "catalog-1",
    operation: "capabilities",
  });
  assert.equal(response.ok, true);
  assert.equal(response.data[0].name, "arc.remaining_hours.read");
  assert.equal(JSON.stringify(response).includes("rmp-backend"), false);
  assert.equal(JSON.stringify(response).includes("replace-with"), false);
});
