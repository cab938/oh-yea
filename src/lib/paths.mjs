import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function runtimeDirectory(env = process.env) {
  if (env.AGENT_BROKER_HOME) {
    return path.resolve(env.AGENT_BROKER_HOME);
  }

  const configRoot = env.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");

  return path.join(configRoot, "agent-broker");
}

export function runtimePaths(env = process.env) {
  const directory = runtimeDirectory(env);
  const config = env.AGENT_BROKER_CONFIG
    ? path.resolve(env.AGENT_BROKER_CONFIG)
    : path.join(directory, "config.yaml");

  return {
    directory,
    config,
    capabilities: path.join(path.dirname(config), "capabilities"),
    submissions: path.join(directory, "submissions"),
    socket: path.join(directory, "broker.sock"),
    serviceTokens: path.join(path.dirname(config), ".env"),
    services: path.join(directory, "services"),
    serviceGuides: path.join(packageRoot, "services"),
    developmentCookies: path.join(directory, "development-cookies.json"),
    logs: path.join(directory, "logs"),
  };
}
