import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { capabilityCatalog } from "./config.mjs";
import { SERVICE_ID } from "./caller-token.mjs";

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_SERVICE" });
}

async function writeSnapshot(filePath, content) {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

// Only these maintained workflow files and the redacted catalog become agent-facing files.
export async function publishServices({ sourceDirectory, directory, config }) {
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  const guides = [];
  const aliases = new Set();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !SERVICE_ID.test(entry.name)) continue;
    const source = path.join(sourceDirectory, entry.name, "workflow.md");
    const text = await fs.readFile(source, "utf8");
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
    if (!header) throw invalid(`Service ${entry.name} needs workflow metadata`);
    let metadata;
    try { metadata = parse(header[1]); }
    catch { throw invalid(`Service ${entry.name} has invalid workflow metadata`); }
    if (metadata?.id !== entry.name || typeof metadata.name !== "string" || !metadata.name.trim() ||
        typeof metadata.description !== "string" || !metadata.description.trim() ||
        !Array.isArray(metadata.aliases) || metadata.aliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
      throw invalid(`Service ${entry.name} needs id, name, description, and aliases`);
    }
    for (const alias of new Set([metadata.id, metadata.name, ...metadata.aliases].map((value) => value.toLowerCase()))) {
      if (aliases.has(alias)) throw invalid(`Service ${entry.name} has an ambiguous alias`);
      aliases.add(alias);
    }
    guides.push({ metadata, source, text });
  }
  const known = new Set(guides.map(({ metadata }) => metadata.id));
  const catalog = capabilityCatalog(config);
  for (const capability of catalog) {
    if (!known.has(capability.service)) throw invalid(`Service ${capability.service} has no workflow`);
  }
  const services = [];
  for (const { metadata, source, text } of guides) {
    const folder = path.resolve(directory, metadata.id);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const workflowFile = path.join(folder, "workflow.md");
    const capabilitiesFile = path.join(folder, "capabilities.json");
    // Runtime homes get their own copy; installed resources remain canonical.
    if (workflowFile !== path.resolve(source)) await writeSnapshot(workflowFile, text);
    const capabilities = catalog.filter((capability) => capability.service === metadata.id);
    await writeSnapshot(capabilitiesFile, `${JSON.stringify(capabilities, null, 2)}\n`);
    services.push({
      id: metadata.id, name: metadata.name, aliases: metadata.aliases,
      description: metadata.description,
      enabled: capabilities.some((capability) => capability.enabled),
      workflow_file: workflowFile, capabilities_file: capabilitiesFile,
    });
  }
  return services;
}
