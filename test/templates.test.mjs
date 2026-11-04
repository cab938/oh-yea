import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { parseCapability, parseConfig } from "../src/lib/config.mjs";
import { readTemplates } from "../test-support/templates.mjs";

test("ships one disabled, parseable template for each maintained capability", async () => {
  const expected = {
    arc: ["arc.remaining_hours.read"],
    mcommunity: ["mcommunity.group.read", "mcommunity.groups.list"],
    "expense-reports": ["umich.teamdynamix.expense_report.capture", "umich.teamdynamix.expense_report.submit"],
    umgpt: ["umich.umgpt.connector.set_active", "umich.umgpt.connectors.list", "umich.umgpt.conversation.read", "umich.umgpt.conversation.send", "umich.umgpt.conversations.list", "umich.umgpt.models.list"],
  };
  for (const [service, names] of Object.entries(expected)) {
    const profiles = parseConfig(await fs.readFile(
      new URL(`../services/${service}/authentication.example.yaml`, import.meta.url), "utf8",
    )).authentications;
    for (const profile of Object.values(profiles)) {
      assert.match(new URL(profile.url).hostname, /\.example\.(?:invalid|test)$/);
    }
    const templates = await readTemplates(service);
    assert.deepEqual(templates.map(({ definition }) => definition.name).sort(), names.sort());
    for (const { filename, definition } of templates) {
      assert.equal(filename, `${definition.name}.yaml`);
      assert.equal(definition.service, service);
      assert.equal(definition.enabled, false);
      const parsed = parseCapability(stringify(definition), profiles);
      assert.equal(parsed.enabled, false);
      const routes = [definition.url, definition.extraction?.response_url,
        definition.action?.page_url, definition.action?.form_url,
        definition.action?.submit_url, definition.action?.confirmation_url_prefix].filter(Boolean);
      assert.ok(routes.length > 0);
      for (const route of routes) {
        const url = new URL(route);
        assert.match(url.hostname, /\.example\.(?:invalid|test)$/);
        assert.equal(url.username + url.password, "");
      }
    }
  }
});
