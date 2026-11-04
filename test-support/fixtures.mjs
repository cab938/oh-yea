import fs from "node:fs/promises";
import {
  parseCapability,
  parseConfig,
} from "../src/lib/config.mjs";

import { stringify } from "yaml";
import { readTemplates } from "./templates.mjs";

const [{ definition: arcTemplate }] = await readTemplates("arc");
export const TEST_CONFIG = await fs.readFile(
  new URL("../services/arc/authentication.example.yaml", import.meta.url), "utf8",
);

export const ACTIVE_CAPABILITY = stringify({
  ...arcTemplate,
  enabled: true,
  url: "https://arc.example.test/allocations/example/remaining-hours",
  extraction: {
    type: "authenticated_json",
    request_headers: {
      Authorization: { response_header: "x-umich-jwt", prefix: "Bearer " },
      "X-Forwarded-User": { json_pointer: "/userinfo/preferred_username" },
      "Content-Type": { value: "application/json" },
    },
    pointer: "/0/subaccounts/0/limits/spending/unitHours",
  },
});

export function configured(capabilityText = ACTIVE_CAPABILITY) {
  const base = parseConfig(TEST_CONFIG);
  return {
    ...base,
    serviceTokens: { arc: "replace-with-a-long-random-token" },
    capabilities: [parseCapability(capabilityText, base.authentications)],
  };
}
