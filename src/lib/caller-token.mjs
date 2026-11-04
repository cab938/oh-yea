import fs from "node:fs/promises";
import { parseEnv } from "node:util";

export const SERVICE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export function serviceTokenKey(service) {
  if (typeof service !== "string" || !SERVICE_ID.test(service)) {
    throw new CallerTokenError("TOKEN_NOT_CONFIGURED", "A configured service is required");
  }
  return `AGENT_BROKER_TOKEN_${service.toUpperCase().replaceAll("-", "_")}`;
}

export class CallerTokenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CallerTokenError";
    this.code = code;
  }
}

export async function resolveCallerToken({
  explicitToken,
  environmentToken,
  filePath,
  service,
}) {
  if (typeof explicitToken === "string" && explicitToken.length > 0) {
    return explicitToken;
  }
  if (typeof environmentToken === "string" && environmentToken.length > 0) {
    return environmentToken;
  }

  const tokens = await readServiceTokens(filePath);
  const token = Object.hasOwn(tokens, service) ? tokens[service] : null;
  if (!token) {
    throw new CallerTokenError("TOKEN_NOT_CONFIGURED", "No token is configured for this broker service");
  }
  return token;
}

export async function readServiceTokens(filePath) {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw new CallerTokenError("TOKEN_READ_FAILED", "The broker service token file could not be read");
  }

  const currentUid = process.getuid?.();
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o600 ||
    (currentUid !== undefined && stats.uid !== currentUid)
  ) {
    throw new CallerTokenError(
      "TOKEN_FILE_INSECURE",
      "The broker .env must be an ordinary user-owned mode-0600 file",
    );
  }

  let entries;
  try { entries = parseEnv(await fs.readFile(filePath, "utf8")); }
  catch { throw new CallerTokenError("TOKEN_READ_FAILED", "The broker .env could not be parsed"); }
  const tokens = {};
  for (const [key, token] of Object.entries(entries)) {
    if (!key.startsWith("AGENT_BROKER_TOKEN_")) continue;
    const service = key.slice("AGENT_BROKER_TOKEN_".length).toLowerCase().replaceAll("_", "-");
    if (!SERVICE_ID.test(service) || serviceTokenKey(service) !== key || token.length < 8) {
      throw new CallerTokenError("TOKEN_NOT_CONFIGURED", "Service token entries must have a valid service name and at least 8 characters");
    }
    if (Object.values(tokens).includes(token)) {
      throw new CallerTokenError("TOKEN_NOT_CONFIGURED", "Each broker service must have a distinct token");
    }
    tokens[service] = token;
  }
  return tokens;
}
