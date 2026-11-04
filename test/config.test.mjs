import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  authorizeRequest,
  capabilityCatalog,
  DEFAULT_CONFIG,
  parseCapability,
  parseConfig,
  publicConfig,
  validateCapabilityResult,
} from "../src/lib/config.mjs";
import { ACTIVE_CAPABILITY, TEST_CONFIG, configured } from "../test-support/fixtures.mjs";

const TEAMDYNAMIX_CONFIG = `version: 1
authentications:
  teamdynamix_sso:
    url: https://teamdynamix.example.test/expense
    login_url: https://teamdynamix.example.test/expense
`;

const EXPENSE_CAPABILITY = `name: umich.teamdynamix.expense_report.submit
service: expense-reports
description: Create one configured expense report and upload its attachments
enabled: true
authentication: teamdynamix_sso
action:
  type: teamdynamix_expense_report
  form_url: https://teamdynamix.example.test/expense
  submit_url: https://teamdynamix.example.test/submit
  confirmation_url_prefix: https://teamdynamix.example.test/requests/
  form_id: 3196
  reference_prefix: TDX
  field_mappings:
    reimbursement_for:
      name: attribute15885
      kind: select
      choices:
        employee: 59724
    on_behalf_of:
      name: attribute15884
      kind: select
      choices:
        "false": 59723
  attachments:
    field_name: files
    allowed_extensions: [.pdf, .jpg, .jpeg, .png]
    max_files: 20
    max_file_bytes: 20971520
    max_total_bytes: 52428800
contract:
  input_schema:
    type: object
    additionalProperties: false
    required: [submission_id, fields, attachments]
    properties:
      submission_id: { type: string }
      fields:
        type: object
        additionalProperties: false
        properties:
          reimbursement_for: { enum: [employee] }
          on_behalf_of: { type: boolean }
      attachments:
        type: array
        minItems: 1
        items:
          type: object
          additionalProperties: false
          required: [path]
          properties:
            path: { type: string }
            name: { type: string }
  output_schema:
    type: object
    additionalProperties: false
    required: [submission_id, status, ticket_reference, attachments]
    properties:
      submission_id: { type: string }
      status: { const: complete }
      ticket_reference: { type: string }
      attachments: { type: object }
`;

const EXPENSE_CAPTURE_CAPABILITY = EXPENSE_CAPABILITY.replace(
  "name: umich.teamdynamix.expense_report.submit",
  "name: umich.teamdynamix.expense_report.capture",
).replace(
  "type: teamdynamix_expense_report",
  "type: teamdynamix_expense_report_capture",
);

test("the first-run configuration has no accounts or capabilities", () => {
  assert.deepEqual(parseConfig(DEFAULT_CONFIG), { version: 1, authentications: {}, capabilities: [] });
});

test("parses authentication configuration and a separate capability contract", () => {
  const config = parseConfig(TEST_CONFIG);
  assert.equal(config.authentications.arc_session.signInGroup, "U-M SSO");
  const capability = parseCapability(
    ACTIVE_CAPABILITY,
    config.authentications,
  );
  assert.equal(config.capabilities.length, 0);
  assert.equal(capability.name, "arc.remaining_hours.read");
  assert.equal(capability.enabled, true);
  assert.equal(capability.extraction.type, "authenticated_json");
  assert.equal(
    capability.extraction.pointer,
    "/0/subaccounts/0/limits/spending/unitHours",
  );
  assert.deepEqual(capability.contract.outputSchema, {
    type: "object",
    additionalProperties: { type: "number" },
  });
});

test("parses a bounded TeamDynamix expense action and exposes its input schema as the form template", () => {
  const base = parseConfig(TEAMDYNAMIX_CONFIG);
  const capability = parseCapability(
    EXPENSE_CAPABILITY,
    base.authentications,
  );
  assert.equal(capability.extraction, undefined);
  assert.equal(capability.action.type, "teamdynamix_expense_report");
  assert.equal(capability.action.formId, 3196);
  assert.deepEqual(capability.action.fieldMappings.reimbursement_for, {
    name: "attribute15885",
    kind: "select",
    choices: { employee: "59724" },
  });

  const config = { ...base, capabilities: [capability] };
  const template = capabilityCatalog(config)[0].input_schema;
  assert.deepEqual(
    template.properties.fields.properties.reimbursement_for.enum,
    ["employee"],
  );
  const catalogText = JSON.stringify(capabilityCatalog(config));
  assert.equal(catalogText.includes("teamdynamix.example.test"), false);
  assert.equal(catalogText.includes("attribute15885"), false);
  assert.equal(catalogText.includes("private"), false);
});

test("parses the non-posting TeamDynamix expense capture action", () => {
  const base = parseConfig(TEAMDYNAMIX_CONFIG);
  const capability = parseCapability(
    EXPENSE_CAPTURE_CAPABILITY,
    base.authentications,
  );
  assert.equal(
    capability.action.type,
    "teamdynamix_expense_report_capture",
  );
  assert.equal(
    capability.action.submitUrl,
    "https://teamdynamix.example.test/submit",
  );
});

test("keeps browser-session authentication free of credentials", () => {
  const config = parseConfig(TEAMDYNAMIX_CONFIG);
  const safe = publicConfig(config);
  const text = JSON.stringify(safe);
  assert.equal(text.includes("client_secret"), false);
  assert.deepEqual(safe.authentications.teamdynamix_sso, {
    name: "teamdynamix_sso",
    displayName: "teamdynamix_sso",
    type: "browser_session",
    url: "https://teamdynamix.example.test/expense",
    loginUrl: "https://teamdynamix.example.test/expense",
  });
});

test("keeps the documented expense capability template parseable", async () => {
  const base = parseConfig(TEAMDYNAMIX_CONFIG);
  const text = await fs.readFile(
    new URL("../services/expense-reports/templates/umich.teamdynamix.expense_report.submit.yaml", import.meta.url),
    "utf8",
  );
  const capability = parseCapability(text, base.authentications);
  assert.equal(
    capability.contract.inputSchema.properties.fields.properties.attestation
      .const,
    "self",
  );
  assert.equal(capability.action.attachments.maxTotalBytes, 52_428_800);
});

test("requires exactly one extraction or action and fixed action routing", () => {
  const base = parseConfig(TEAMDYNAMIX_CONFIG);
  assert.throws(
    () =>
      parseCapability(
        `${EXPENSE_CAPABILITY}\nextraction:\n  type: css\n  selector: main\n`,
        base.authentications,
      ),
    (error) => {
      assert.match(error.details.join("; "), /exactly one/);
      return true;
    },
  );
  const config = {
    ...base,
    serviceTokens: { "expense-reports": "long-enough-expense-token" },
    capabilities: [
      parseCapability(EXPENSE_CAPABILITY, base.authentications),
    ],
  };
  const result = authorizeRequest(config, {
    capability: "umich.teamdynamix.expense_report.submit",
    token: "long-enough-expense-token",
    input: {
      submission_id: "claim-1",
      fields: { reimbursement_for: "employee" },
      attachments: [{ path: "/tmp/receipt.pdf" }],
      application_id: 99,
    },
  });
  assert.equal(result.code, "INVALID_INPUT");
});

test("authorizes only a matching token and capability", () => {
  const config = configured();
  assert.equal(
    authorizeRequest(config, {
      capability: "arc.remaining_hours.read",
      token: "replace-with-a-long-random-token",
      input: {},
    }).ok,
    true,
  );
  assert.equal(
    authorizeRequest(config, {
      capability: "arc.remaining_hours.read",
      token: "not-the-configured-token",
      input: {},
    }).code,
    "UNAUTHORIZED",
  );
  assert.equal(
    authorizeRequest(config, {
      capability: "arc.another-resource.read",
      token: "replace-with-a-long-random-token",
      input: {},
    }).code,
    "UNAUTHORIZED",
  );
});

test("rejects caller-supplied URLs and non-object input", () => {
  const config = configured();
  assert.equal(
    authorizeRequest(config, {
      capability: "arc.remaining_hours.read",
      url: "https://example.test",
      token: "replace-with-a-long-random-token",
      input: {},
    }).code,
    "INVALID_REQUEST",
  );
  assert.equal(
    authorizeRequest(config, {
      capability: "arc.remaining_hours.read",
      token: "replace-with-a-long-random-token",
      input: [],
    }).code,
    "INVALID_REQUEST",
  );
});

test("validates capability input before dispatch", () => {
  const config = configured(
    ACTIVE_CAPABILITY.replace(
      "    type: object\n  output_schema:",
      "    type: object\n    required: [account]\n    properties:\n      account: { type: string }\n  output_schema:",
    ),
  );
  const result = authorizeRequest(config, {
    capability: "arc.remaining_hours.read",
    token: "replace-with-a-long-random-token",
    input: {},
  });
  assert.equal(result.code, "INVALID_INPUT");
  assert.match(result.details.join("; "), /required property/);
});

test("keeps tokens and extraction internals out of discovery", () => {
  const config = configured();
  const safe = publicConfig(config);
  assert.equal("serviceTokens" in safe, false);
  assert.equal("tokens" in safe.capabilities[0], false);

  const catalog = capabilityCatalog(config);
  assert.deepEqual(Object.keys(catalog[0]), [
    "name",
    "service",
    "description",
    "enabled",
    "input_schema",
    "output_schema",
  ]);
  const catalogText = JSON.stringify(catalog);
  assert.equal(catalogText.includes("replace-with"), false);
  assert.equal(catalogText.includes("rmp-backend"), false);
  assert.equal(catalogText.includes("requestHeaders"), false);
});

test("accepts constrained CSS capabilities with contracts", () => {
  const capability = parseCapability(`name: example.dom.read
service: arc
url: https://example.test/account
extraction:
  type: css
  selector: main .remaining
  return: textContent
contract:
  input_schema: { type: object }
  output_schema: { type: string }
`);
  assert.deepEqual(capability.extraction, {
    type: "css",
    selector: "main .remaining",
    return: "textContent",
  });
});

test("accepts same-origin GET-only browser JSON capabilities", () => {
  const base = parseConfig(TEST_CONFIG);
  const capability = parseCapability(`name: example.browser-json.read
service: mcommunity
url: https://example.test/my-groups
authentication: arc_session
extraction:
  type: browser_json
  response_url: https://example.test/api/groups/
  response_method: GET
  pointer: ""
  transform: mcommunity_groups
contract:
  input_schema: { type: object }
  output_schema: { type: object }
`, base.authentications);
  assert.deepEqual(capability.extraction, {
    type: "browser_json",
    responseUrl: "https://example.test/api/groups/",
    responseMethod: "GET",
    pointer: "",
    transform: "mcommunity_groups",
  });
});

test("rejects cross-origin or mutating browser JSON responses", () => {
  const base = parseConfig(TEST_CONFIG);
  assert.throws(
    () => parseCapability(`name: example.browser-json.read
service: mcommunity
url: https://example.test/my-groups
authentication: arc_session
extraction:
  type: browser_json
  response_url: https://other.example.test/api/groups/
  response_method: POST
  pointer: ""
contract:
  input_schema: { type: object }
  output_schema: { type: object }
`, base.authentications),
    (error) => {
      assert.match(error.details.join("; "), /same origin/);
      assert.match(error.details.join("; "), /must be GET/);
      return true;
    },
  );
});

test("rejects invalid capability definitions and schemas", () => {
  assert.throws(
    () =>
      parseCapability(`name: "bad name!"
url: javascript:alert(1)
extraction:
  type: xpath
contract:
  input_schema: { type: mystery }
  output_schema: []
`),
    (error) => {
      assert.equal(error.code, "INVALID_CONFIG");
      assert.ok(error.details.length >= 5);
      return true;
    },
  );
});

test("rejects unsupported authentication expiry formats", () => {
  assert.throws(
    () => parseConfig(TEST_CONFIG.replace("unix_seconds", "jwt_magic")),
    (error) => {
      assert.equal(error.code, "INVALID_CONFIG");
      assert.match(error.details.join("; "), /format must be unix_seconds/);
      return true;
    },
  );
});

test("allows capability files to share one named authentication", () => {
  const base = parseConfig(TEST_CONFIG);
  const second = parseCapability(
    ACTIVE_CAPABILITY.replace(
      "arc.remaining_hours.read",
      "arc.allocation.read",
    ),
    base.authentications,
  );
  assert.equal(second.authentication, "arc_session");
  assert.equal(Object.keys(base.authentications).length, 1);
});

test("rejects unknown authentication references", () => {
  const base = parseConfig(TEST_CONFIG);
  assert.throws(
    () =>
      parseCapability(
        ACTIVE_CAPABILITY.replace("authentication: arc_session", "authentication: missing_sso"),
        base.authentications,
      ),
    (error) => {
      assert.match(error.details.join("; "), /unknown authentication missing_sso/);
      return true;
    },
  );
});

test("validates extracted results against the output contract", () => {
  const capability = configured().capabilities[0];
  assert.equal(validateCapabilityResult(capability, { GPU: 42 }).ok, true);
  const invalid = validateCapabilityResult(capability, { GPU: "42" });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("; "), /must be number/);
});
