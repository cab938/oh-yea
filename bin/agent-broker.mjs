#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectSocket, requestOnce } from "../src/lib/broker-client.mjs";
import { resolveCallerToken } from "../src/lib/caller-token.mjs";
import { runtimePaths } from "../src/lib/paths.mjs";

const require = createRequire(import.meta.url);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function usage() {
  return `agent-broker

Usage:
  agent-broker
  agent-broker capabilities
  agent-broker services
  agent-broker connect
  agent-broker connect --capability NAME [--input JSON] [--token TOKEN]
  agent-broker inspect [summary]
  agent-broker inspect auth [--capability NAME]
  agent-broker inspect query --selector CSS
  agent-broker inspect console|network [--limit NUMBER]
  agent-broker inspect clear

Commands:
  (none)       Open the Electron control plane
  capabilities Return the known capability contracts as JSON
  services     Refresh public service contracts and return workflow/file pointers
  connect      Bridge JSON Lines on stdin/stdout, or send one request with flags
  inspect      Inspect the live Electron browser over the user-only local socket

Environment:
  AGENT_BROKER_HOME    Override the private runtime home
  AGENT_BROKER_CONFIG  Override the live YAML configuration file
  AGENT_BROKER_TOKEN   Explicit caller override; otherwise use the service token in .env
`;
}

function parseInspectArgs(args) {
  const remaining = [...args];
  const command =
    remaining[0] && !remaining[0].startsWith("-")
      ? remaining.shift()
      : "summary";
  if (
    !["auth", "summary", "query", "console", "network", "clear"].includes(
      command,
    )
  ) {
    throw new Error(`Unknown inspection command: ${command}`);
  }

  const options = { command };
  for (let index = 0; index < remaining.length; index += 1) {
    const argument = remaining[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!["--capability", "--selector", "--limit"].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = remaining[index + 1];
    if (value === undefined) {
      throw new Error(`${argument} requires a value`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function parseConnectArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (
      !["--capability", "--input", "--token", "--id"].includes(argument)
    ) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`${argument} requires a value`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function brokerUnavailable(error) {
  return {
    id: null,
    ok: false,
    error: {
      code: "BROKER_UNAVAILABLE",
      message:
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? "The agent-broker control plane is not running"
          : error.message,
    },
  };
}

async function connectCommand(args) {
  const options = parseConnectArgs(args);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const paths = runtimePaths();
  const socketPath = paths.socket;
  const oneShot = options.capability;

  if (oneShot) {
    let input = {};
    if (options.input) {
      input = JSON.parse(options.input);
    }
    let token;
    let catalog;
    try {
      catalog = await requestOnce(socketPath, { operation: "capabilities" }, 15_000);
    } catch (error) {
      process.stdout.write(`${JSON.stringify(brokerUnavailable(error))}\n`);
      return 1;
    }
    if (!catalog.ok) {
      process.stdout.write(`${JSON.stringify(catalog)}\n`);
      return 1;
    }
    try {
      const definition = catalog.data.find((item) => item.name === options.capability && item.enabled);
      if (!definition) {
        throw Object.assign(new Error("The requested capability is not enabled"), { code: "RESOURCE_NOT_AVAILABLE" });
      }
      token = await resolveCallerToken({
        explicitToken: options.token,
        environmentToken: process.env.AGENT_BROKER_TOKEN,
        filePath: paths.serviceTokens,
        service: definition.service,
      });
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          id: options.id ?? null,
          ok: false,
          error: {
            code: error.code ?? "TOKEN_READ_FAILED",
            message: error.message,
          },
        })}\n`,
      );
      return 1;
    }
    const request = {
      ...(options.id ? { id: options.id } : {}),
      capability: options.capability,
      token,
      input,
    };
    try {
      const response = await requestOnce(socketPath, request);
      process.stdout.write(`${JSON.stringify(response)}\n`);
      return response.ok ? 0 : 1;
    } catch (error) {
      process.stdout.write(`${JSON.stringify(brokerUnavailable(error))}\n`);
      return 1;
    }
  }

  try {
    const socket = await connectSocket(socketPath);
    if (process.stdin.isTTY) {
      process.stderr.write(
        "Connected. Enter one JSON request per line; press Ctrl-D to close.\n",
      );
    }
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    await new Promise((resolve, reject) => {
      socket.once("close", resolve);
      socket.once("error", reject);
    });
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(brokerUnavailable(error))}\n`);
    return 1;
  }
}

async function inspectCommand(args) {
  const options = parseInspectArgs(args);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  try {
    const response = await requestOnce(
      runtimePaths().socket,
      {
        operation: "inspect",
        command: options.command,
        ...(options.capability ? { capability: options.capability } : {}),
        ...(options.selector ? { selector: options.selector } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
      },
      15_000,
    );
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return response.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(brokerUnavailable(error))}\n`);
    return 1;
  }
}

async function discoveryCommand(operation, args) {
  if (args.length > 0) {
    throw new Error(`${operation} does not accept options`);
  }
  try {
    const response = await requestOnce(
      runtimePaths().socket,
      { operation },
      15_000,
    );
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return response.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(brokerUnavailable(error))}\n`);
    return 1;
  }
}

function launchElectron(args) {
  const electronBinary = require("electron");
  const child = spawn(electronBinary, [projectRoot, ...args], {
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    process.stderr.write(`Could not start Electron: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "connect") {
    process.exitCode = await connectCommand(args);
    return;
  }
  if (command === "capabilities" || command === "services") {
    process.exitCode = await discoveryCommand(command, args);
    return;
  }
  if (command === "inspect") {
    process.exitCode = await inspectCommand(args);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(usage());
    return;
  }
  launchElectron(process.argv.slice(2));
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
