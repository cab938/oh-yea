import fs from "node:fs/promises";
import { parse } from "yaml";

// Fixtures use the shipped contracts, overriding only what their local service needs.
export async function readTemplates(service) {
  const directory = new URL(`../services/${service}/templates/`, import.meta.url);
  const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".yaml")).sort();
  return Promise.all(files.map(async (filename) => ({
    filename,
    definition: parse(await fs.readFile(new URL(filename, directory), "utf8")),
  })));
}
