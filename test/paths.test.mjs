import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePaths } from "../src/lib/paths.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("keeps writable state in the user runtime home and resources in the checkout", () => {
  const paths = runtimePaths({
    HOME: "/tmp/agent-broker-home",
    XDG_CONFIG_HOME: "/tmp/agent-broker-xdg",
  });
  const directory = "/tmp/agent-broker-xdg/agent-broker";
  assert.equal(paths.config, path.join(directory, "config.yaml"));
  assert.equal(paths.capabilities, path.join(directory, "capabilities"));
  assert.equal(
    paths.socket,
    "/tmp/agent-broker-xdg/agent-broker/broker.sock",
  );
  assert.equal(
    paths.developmentCookies,
    "/tmp/agent-broker-xdg/agent-broker/development-cookies.json",
  );
  assert.equal(
    paths.submissions,
    "/tmp/agent-broker-xdg/agent-broker/submissions",
  );
  assert.equal(
    paths.serviceTokens,
    path.join(directory, ".env"),
  );
  assert.equal(paths.logs, path.join(directory, "logs"));
  assert.equal(paths.services, path.join(directory, "services"));
  assert.equal(paths.serviceGuides, path.join(root, "services"));
});

test("AGENT_BROKER_HOME keeps smoke and isolated test state together", () => {
  const paths = runtimePaths({
    AGENT_BROKER_HOME: "/tmp/isolated-agent-broker",
  });
  assert.equal(paths.config, "/tmp/isolated-agent-broker/config.yaml");
  assert.equal(paths.capabilities, "/tmp/isolated-agent-broker/capabilities");
  assert.equal(paths.socket, "/tmp/isolated-agent-broker/broker.sock");
  assert.equal(paths.serviceTokens, "/tmp/isolated-agent-broker/.env");
  assert.equal(
    paths.submissions,
    "/tmp/isolated-agent-broker/submissions",
  );
  assert.equal(paths.logs, "/tmp/isolated-agent-broker/logs");
});

test("AGENT_BROKER_CONFIG selects an explicit live policy file", () => {
  const paths = runtimePaths({
    AGENT_BROKER_CONFIG: "/tmp/policies/agent-broker.yaml",
    XDG_CONFIG_HOME: "/tmp/agent-broker-xdg",
  });
  assert.equal(paths.config, "/tmp/policies/agent-broker.yaml");
  assert.equal(paths.capabilities, "/tmp/policies/capabilities");
  assert.equal(
    paths.socket,
    "/tmp/agent-broker-xdg/agent-broker/broker.sock",
  );
});
