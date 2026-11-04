import fs from "node:fs/promises";
import path from "node:path";
import { parseCapability, parseConfig } from "../src/lib/config.mjs";
import { readServiceTokens } from "../src/lib/caller-token.mjs";
import { runtimePaths } from "../src/lib/paths.mjs";

async function ordinaryFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Import requires ordinary configuration files");
}

async function importConfiguration(source) {
  const paths = runtimePaths();
  const configFile = path.join(source, "config.yaml");
  await ordinaryFile(configFile);
  const config = parseConfig(await fs.readFile(configFile, "utf8"));
  const files = [[configFile, paths.config]];
  const tokens = path.join(source, ".env");
  try {
    await ordinaryFile(tokens);
    await readServiceTokens(tokens);
    files.push([tokens, paths.serviceTokens]);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const capabilities = path.join(source, "capabilities");
  let entries = [];
  try { entries = await fs.readdir(capabilities); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const filename of entries.sort().filter((name) => name.endsWith(".yaml"))) {
    const file = path.join(capabilities, filename);
    await ordinaryFile(file);
    const definition = parseCapability(await fs.readFile(file, "utf8"), config.authentications);
    if (`${definition.name}.yaml` !== filename) throw new Error("Capability names must match their filenames");
    files.push([file, path.join(paths.capabilities, filename)]);
  }

  // Preflight the entire import, then use exclusive copies and roll back only
  // files created by this invocation if another writer wins a race.
  for (const [, target] of files) {
    try {
      await fs.lstat(target);
      throw new Error(`Import would overwrite ${path.basename(target)}; existing files were left intact`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const directory of new Set([paths.directory, path.dirname(paths.config), paths.capabilities])) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Import requires ordinary destination directories");
    if ((stat.mode & 0o777) !== 0o700) await fs.chmod(directory, 0o700);
  }
  const created = [];
  try {
    for (const [file, target] of files) {
      // Create the destination privately before copying any sensitive bytes.
      const handle = await fs.open(target, "wx", 0o600);
      created.push(target);
      try { await handle.writeFile(await fs.readFile(file)); }
      finally { await handle.close(); }
    }
  } catch (error) {
    await Promise.all(created.map((file) => fs.unlink(file)));
    throw error;
  }
  process.stdout.write(`Imported ${files.length} configuration files into ${path.dirname(paths.config)}. Originals and submission journals are unchanged.\n`);
}

if (process.argv.length !== 3) {
  process.stderr.write("Usage: npm run import-config -- /path/to/previous/configuration-directory\n");
  process.exitCode = 1;
} else {
  await importConfiguration(path.resolve(process.argv[2])).catch((error) => {
    process.stderr.write(`Configuration import failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
