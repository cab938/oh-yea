import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { parseCapability } from "./config.mjs";

const CAPABILITY_FILE = /^[a-z][a-z0-9._-]*\.yaml$/i;

function errorDetails(error) {
  return {
    code: error.code ?? "INVALID_CAPABILITY",
    message: error.message,
    details: error.details ?? [],
  };
}

async function ensureMode(target, expectedMode) {
  const currentMode = (await fs.stat(target)).mode & 0o777;
  if (currentMode !== expectedMode) {
    await fs.chmod(target, expectedMode);
  }
}

export async function loadCapabilityDirectory(directory, authentications) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await ensureMode(directory, 0o700);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const files = [];
  const capabilities = [];
  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName);
    const text = await fs.readFile(filePath, "utf8");
    await ensureMode(filePath, 0o600);
    try {
      if (!CAPABILITY_FILE.test(fileName)) {
        const error = new Error(
          "Capability filenames may contain only letters, numbers, ., _ and -",
        );
        error.code = "INVALID_CAPABILITY_FILE";
        throw error;
      }
      const definition = parseCapability(text, authentications);
      const expectedFileName = `${definition.name}.yaml`;
      if (fileName !== expectedFileName) {
        const error = new Error(
          `Capability name must match its filename (${expectedFileName})`,
        );
        error.code = "INVALID_CAPABILITY_FILE";
        throw error;
      }
      capabilities.push(definition);
      files.push({
        fileName,
        path: filePath,
        name: definition.name,
        description: definition.description,
        enabled: definition.enabled,
        authentication: definition.authentication ?? null,
        text,
        valid: true,
      });
    } catch (error) {
      files.push({
        fileName,
        path: filePath,
        name: fileName.slice(0, -".yaml".length),
        description: "",
        enabled: false,
        text,
        valid: false,
        error: errorDetails(error),
      });
    }
  }

  return { capabilities, files };
}

export async function saveCapabilityFile(
  directory,
  authentications,
  { fileName, text },
) {
  const definition = parseCapability(text, authentications);
  const nextFileName = `${definition.name}.yaml`;
  if (fileName && fileName !== nextFileName) {
    const error = new Error(
      `Capability name must remain ${fileName.slice(0, -".yaml".length)}; rename the file and name together outside the app`,
    );
    error.code = "INVALID_CAPABILITY_FILE";
    throw error;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await ensureMode(directory, 0o700);
  const target = path.join(directory, nextFileName);
  if (!fileName) {
    await fs.writeFile(target, text, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } else {
    await fs.writeFile(target, text, { encoding: "utf8", mode: 0o600 });
  }
  await ensureMode(target, 0o600);
  return { definition, fileName: nextFileName };
}

export function watchCapabilityDirectory(
  directory,
  onChange,
  onError = () => {},
) {
  let timer = null;
  const watcher = watch(directory, { persistent: false }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      Promise.resolve(onChange()).catch(onError);
    }, 100);
  });
  watcher.on("error", onError);
  return {
    stop() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}
