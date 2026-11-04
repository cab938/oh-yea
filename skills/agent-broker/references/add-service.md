# Add services and capabilities

Read this guide when the user explicitly asks to add, configure, or change broker access. For example: "Use $agent-broker to add a service for my portal and a capability that reads my quota." For ordinary requests to use an existing service, return to [SKILL.md](../SKILL.md).

Work from the broker source checkout and read its `AGENTS.md` before editing. The installed skill may be a symlink to that checkout; a standalone copy of the skill is not the broker source. If source access is unavailable, prepare the requested definition and identify the installation step that needs the operator.

## Decide what is being added

| Item | Meaning | What changes |
| --- | --- | --- |
| Capability in an existing service | Another bounded operation authorized by that service's existing token | Add a capability template, update its service workflow, and configure the selected private capability. Reuse a suitable authentication profile. |
| New service | A new discovery entry and permission group | Add a service directory and workflow, capability templates, an authentication example if needed, and one private service token. |
| New operation type | Behavior none of the current extraction/action types can express | Make a small broker implementation change as described below; YAML alone cannot add an execution type. |

A service is a permission boundary, not just a website name. Every existing token for a service gains access to every newly enabled capability in it. Use an existing service only when that grant is intended. Authentication profiles are separate: services can share a suitable login session without sharing their service token.

Establish the requested account/resource, exact read or write, allowed inputs, and smallest useful output. Resolve missing decisions that change access or behavior before implementing them. Reuse decisions the user already supplied. A request to add access does not authorize submitting a real transaction to test it.

## 1. Inspect the existing system and target

Run `agent-broker services` if the broker is available. Read the selected existing service's workflow and contracts before adding a duplicate. Read-only discovery of a stopped broker does not prevent offline authoring. Follow the entrypoint's startup procedure only when a live browser is needed.

Inspect the nearest maintained template and the normalizer in `src/lib/config.mjs`. During this explicit setup task, you may inspect and edit the relevant private authentication and capability files locally. This permission does not extend to ordinary service calls, unrelated configuration, or exporting private details. Never display tokens or browser credentials, source `.env` as shell code, or copy browser state.

For a new target, have the human sign in through the broker's Browser pane and inspect the intended page. Operator diagnostics include:

```bash
agent-broker inspect summary
agent-broker inspect query --selector 'main'
agent-broker inspect network --limit 20
```

These inspect the visible browser, not the hidden worker. Network diagnostics omit headers, bodies, and URL queries; they are not a complete API description. Use the intended site's documentation or inspected page structure to establish missing routing. Do not guess identity-header mappings, harvest cookie values, fill credentials, approve tools, or submit forms as discovery.

Prefer an existing execution path:

| Path | Use it for | Private definition |
| --- | --- | --- |
| `authenticated_json` | A fixed authenticated GET that Electron can request directly | Fixed `url`, named `authentication`, identity-derived `request_headers`, and JSON `pointer`. This type requires a header sourced from the identity response; cookie-only traffic may fit `browser_json` or a finite service adapter. |
| `browser_json` | A page whose own application must make the request | Fixed page `url`, exact same-origin `response_url`, `response_method: GET`, named profile, and JSON `pointer`. |
| `css` | Data available through a stable DOM selector, or initial discovery | Fixed page `url`, constrained `selector`, and `return` (`textContent`, `json`, `innerHTML`, or `outerHTML`). Prefer the smallest useful return. |
| Existing service action | The same bounded expense or UM GPT operation already implemented | Use that service's template and operator notes. Those actions are not general form, HTTP, or WebSocket access. |

`pointer: ""` selects the whole JSON value; `/remaining` selects that property, with normal RFC 6901 escaping. Browser JSON transforms are a finite built-in set, currently for MCommunity. They are not user-defined scripts.

Generic declarative reads do not interpolate caller input into URLs or selectors. Do not advertise input parameters they ignore. A parameterized operation needs a finite implementation that validates semantic input and constructs only permitted fixed-origin routes.

## 2. Write the maintained service resources

Keep each subject in its canonical file:

```text
services/SERVICE_ID/
  workflow.md                   agent procedure and approvals
  authentication.example.yaml   sanitized operator example, when needed
  templates/CAPABILITY_NAME.yaml
```

The service ID must match `[a-z][a-z0-9]*(?:-[a-z0-9]+)*`. The workflow frontmatter requires `id`, `name`, `aliases` (an array), and `description`. Its ID must equal its directory name; names and aliases must not collide with another service, ignoring case.

For an existing service, update its workflow rather than creating another guide. Write concrete instructions for choosing its capabilities, forming semantic inputs, interpreting results, handling login, and stopping after uncertain writes. Put the write-approval rule before the invocation that needs it. Do not repeat private schemas or endpoints in the workflow; deployed contracts supply the schemas.

A small new service could have this `workflow.md`:

```markdown
---
id: sample-portal
name: Sample Portal
aliases: [portal quota]
description: Read the configured portal account's remaining quota.
---

# Sample Portal

Read the adjacent capabilities.json refreshed by agent-broker services.
Call the enabled sample-portal.quota.read capability with {}.
Report the remaining quota as returned; it is not a forecast.
This service is read-only. Keep the same request open during human login.
```

This authentication example belongs in `authentication.example.yaml`:

```yaml
version: 1
authentications:
  sample_portal:
    display_name: Sample Portal
    sign_in_group: Portal sign-in
    url: https://portal.example.invalid/api/me
    login_url: https://portal.example.invalid/
```

This template belongs in `templates/sample-portal.quota.read.yaml`:

```yaml
name: sample-portal.quota.read
service: sample-portal
description: Read the configured account's remaining quota
enabled: false
url: https://portal.example.invalid/api/quota
authentication: sample_portal
extraction:
  type: authenticated_json
  request_headers:
    X-Portal-Identity:
      json_pointer: /session_marker
  pointer: /remaining
contract:
  input_schema:
    type: object
    properties: {}
    additionalProperties: false
  output_schema:
    type: number
    minimum: 0
```

Capability names must start with a letter and contain only letters, numbers, `.`, `_`, or `-`. Use a readable service/resource/operation name. The filename must be exactly `NAME.yaml`, and `service` must select a maintained workflow.

Every definition needs a description, explicit `enabled: false` in its shipped template, exactly one `extraction` or `action`, and `contract.input_schema` / `contract.output_schema`. The schema declares what callers can supply and what may leave the broker. For writes, include only semantic fields and the duplicate-protection identifier required by the implementation. Never put tokens in a capability.

Public examples must use placeholder origins and sanitized mappings. Private inspected URLs, account IDs, selectors, header mappings, and field values belong only in runtime configuration. Do not commit captured pages, responses, receipts, cookies, or identity bodies. Never hand-edit generated `capabilities.json`.

## 3. Add broker code only if needed

If an existing type expresses the operation, stop at configuration. Otherwise:

1. Define the finite input, output, target routes, and failure meaning with the user. A new write needs a clear approval procedure and protection against duplicate or uncertain execution.
2. Add normalization and validation in `src/lib/config.mjs` and dispatch in `src/lib/capability-executor.mjs`. Keep application-specific mechanics in a small service module. Reuse the authentication manager and existing browser surfaces.
3. Keep target URLs, selectors, and credentials broker-owned. Reject unsupported caller fields and invalid results. Do not add arbitrary navigation, JavaScript, HTTP, or WebSocket capabilities, an adapter registry, or a network listener.
4. Add a compact behavior test with sanitized fixtures, including input rejection, the permitted result, and relevant authorization or duplicate-write behavior. Update `AGENTS.md` when architecture or boundaries change.

## 4. Validate before installing

Update `test/templates.test.mjs` with the intended new capability/service names and `test/services.test.mjs` with the intended discovery membership. For a service without an authentication example, validate its templates against an empty authentication map. Reuse the maintained templates in tests. Validate that templates remain disabled and public contracts exclude private routing and credentials.

Run the focused tests for the changed path, then the project-required `npm run check`. Renderer or extraction implementation changes also require the documented Electron smoke. On the Thelio, use the prescribed private Xvfb harness; never test on the inherited desktop.

Use an isolated `AGENT_BROKER_HOME` and local fixtures for test configuration. Do not enable or change the operator's live capabilities to make a test pass. A passing fixture test establishes behavior, not access to the real account.

## 5. Install the requested private definitions

Skip this step if the user requested only source/templates. Otherwise, use the runtime paths described in the repository README; `src/lib/paths.mjs` is their resolver. Respect `AGENT_BROKER_HOME` and `AGENT_BROKER_CONFIG` rather than assuming the checkout holds configuration.

1. Preserve existing private files before editing. Keep private directories mode `0700` and files mode `0600`. Copy only selected templates without overwriting an existing capability. Replace their placeholders locally and initially keep them disabled.
2. Add only the needed profile under the existing `authentications` map in `config.yaml`. Do not replace that map or change a shared profile without accounting for its other capabilities. A profile's `url` is an authentication probe; `login_url` is the human sign-in entry. Profiles share the isolated browser partition; `sign_in_group` controls the grouped readiness indicator.
3. For a new service, provision its token with the operator helper below. It validates the service ID, creates a private random token, preserves existing entries, and displays no token values. Existing services already have their token; adding a capability needs no new token.

   ```bash
   npm run add-service-token -- sample-portal
   ```

4. Apply authentication edits through the Configuration pane or arrange one deliberate restart. External capability YAML edits are watched, but token and broker code changes require a restart. Workflow resource edits are picked up by the next discovery. A restart ends ephemeral sign-in sessions; preserve pending requests and tell the operator before doing it. Restarting is an installation step, never recovery for an uncertain capability call.
5. Enable only the capabilities covered by the user's setup request, after validation. If enablement was not requested or inspected routing is incomplete, leave them disabled and state the remaining action.

The helper honors the same runtime path overrides as the broker. It never rotates or returns an existing token. Token names follow `AGENT_BROKER_TOKEN_` plus the uppercase service ID with hyphens changed to underscores. Agents do not need the resulting value.

Do not create live routing files or activate a service merely because a template or new workflow was added to source. Installation must be part of the user's request.

## 6. Verify and hand back

Refresh `agent-broker services` after installation. Confirm the service and enabled capabilities appear, and inspect the regenerated selected contract. Unknown services break discovery, so a private capability must not reference a missing guide.

Exercise one configured read-only capability with its actual schema when the user has requested live setup. Wait on the same invocation while the human signs in. For a new write, use an available non-posting rehearsal or a local fixture; a real write requires the service's separate approval. Do not invent a rehearsal capability or send a test transaction.

Report the service ID, capability names, files changed, checks performed, whether configuration is installed/enabled, and whether a restart or human sign-in remains. Distinguish source implementation, fixture validation, and a successful live read. Keep token values, private routes, and browser state out of the report.
