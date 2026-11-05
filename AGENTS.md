# AGENTS.md

## Purpose and scope

`agent-broker` is a local, human-supervised Electron control plane for cooperative callers under one Unix account. It exposes named, configured capabilities with JSON input/output contracts. This is a personal prototype: prefer the smallest direct implementation, one package, and the existing finite dispatcher.

Follow `../AGENTS.md` when working in this workspace. [README.md](README.md) is the operator entry point; [skills/agent-broker/SKILL.md](skills/agent-broker/SKILL.md) is the agent entry point. [IDEAS.md](IDEAS.md) is a deferred historical backlog, not current architecture or authorization to expand scope. Keep these instructions current when behavior or boundaries change.

## Trust boundary

- Keep the broker local-first. Do not add a network listener without an explicit threat model and user approval.
- Callers supply capability names and semantic input, never target URLs, selectors, form controls, headers, or browser instructions. Preserve the protocol's JSON `input` object; each type defines its accepted fields.
- A service token authorizes every enabled capability with that `service`. New capabilities in an existing service inherit that grant. Never restore per-capability token lists.
- Never return or log broker tokens, cookies, passwords, OAuth credentials, 2FA values, identity bodies, or sensitive browser state. Never send the token map or identity-header values to the renderer.
- Human authentication and tool approvals remain human-operated. Do not fill credentials or 2FA challenges.
- Validate inputs before execution and outputs before release. An invalid output fails closed as `CAPABILITY_BROKEN`; never return malformed results.
- Writes are explicitly named and bounded. Current writes are `umich.teamdynamix.expense_report.submit`, `umich.umgpt.conversation.send`, and `umich.umgpt.connector.set_active`. Do not add general HTTP, form, attachment, connector-configuration, JavaScript, or WebSocket capabilities.
- Duplicate, rejected, interrupted, conflicting, or uncertain writes must not retry automatically. Never erase journals or change identifiers to force another attempt. Preserve the existing service-specific no-op/replay behavior.
- Hostile processes running as the same Unix user are outside the prototype's threat model.

## Ownership and files

| Owner | Responsibility |
| --- | --- |
| `src/main.mjs` | Electron lifecycle, windows, IPC, configuration reload, result validation, health |
| `src/lib/config.mjs` | Authentication/capability normalization and schema validation |
| `src/lib/capability-executor.mjs` | Finite dispatch using current profiles and browser surfaces; no adapter registry |
| `src/lib/authentication-manager.mjs` | Shared checks, coalescing, deadlines, polling, silent handoffs, waits |
| `src/lib/paths.mjs` | Shared CLI/app runtime locations |
| `src/lib/desktop-launcher.mjs` | Installed Electron resolution, desktop prerequisites, detached startup, bounded discovery |
| `src/lib/services.mjs` | Workflow discovery and fresh redacted contract publication |
| `services/SERVICE_ID/workflow.md` | Canonical service procedure and approval rules |
| `services/SERVICE_ID/templates/` | Disabled sanitized capability examples reused by tests |
| `skills/agent-broker/references/add-service.md` | Canonical service/capability setup and authoring procedure |

Normal writable state belongs under `${XDG_CONFIG_HOME:-~/.config}/agent-broker`: authentication `config.yaml`, `.env`, private `capabilities/`, workflow copies/generated contracts, logs, journals, socket, and optional development browser state. `AGENT_BROKER_HOME` overrides that home. `AGENT_BROKER_CONFIG` selects a different authentication file with capability YAML and `.env` beside it; other state remains in the home. Installed source, templates, workflows, and icons are resources.

Use mode `0700` for private directories and `0600` for private files. Capability YAML is watched; valid edits apply automatically, while invalid files remain visible but unavailable. On macOS a metadata poll supplements FSEvents, which can omit immediate changes in newly watched directories. Stop both notification paths on shutdown. Change permissions only when modes differ, avoiding watcher feedback loops. Profile edits apply through the Authentication editor or a deliberate restart; token and broker code changes require a restart. Keep the same default runtime locations on Linux and macOS; do not migrate Mac configuration to a different home.

A first launch has an empty authentication map and no enabled capabilities. Do not install, merge, enable, or replace configuration at startup or during tests. An explicit setup request may configure only the requested service/capabilities, following the authoring guide. Use `npm run add-service-token -- SERVICE_ID` to provision a token without exposing or rotating existing values. Read `.env` as data only, never source or export it.

`agent-broker services` is tokenless discovery. Workflow frontmatter defines service IDs/names/aliases/descriptions; each private capability's `service` defines membership. Unknown services fail discovery. Publish workflow copies and atomically regenerated `capabilities.json` under the runtime home, never into installed resources. Keep generated files ignored.

Public catalogs contain only names, service IDs, descriptions, enabled state, and schemas. Never include URLs, selectors, authentication details, headers, pointers, tokens, or private-file paths. Discovery does not authorize a call.

## Agent use and configuration

The skill routes ordinary requests through discovery and only the selected workflow/contracts. `agent-broker start` reuses a responding broker or starts installed Electron once with Node-managed detachment and waits at most 30 seconds for discovery. Its JSON envelope returns a startup status and the newly owned PID (null on reuse). It requires a desktop display on Linux or a graphical login session on macOS. It must not download Electron, read tokens, or retry a launch. Failed startup or missing prerequisites means report and stop, not install/restart software as recovery. Foreground CLI startup remains available; operator Electron options follow `start --` for background startup.

One-shot `agent-broker connect` resolves the service and reads its token internally. Agents never read or supply tokens. Long-lived callers supply a service token in each request. Explicit token overrides remain operator-only. Keep the same pending invocation during human login; never replay a possible mutation after a disconnect.

Explicit requests to add or configure access use the skill's authoring guide. This permits relevant local profile/capability editing, not credential export or unrelated configuration. Public templates stay sanitized and disabled; private deployment and enablement must be part of the user's request. Keep the skill's OpenAI metadata aligned with both supported tasks.

## Browser and authentication invariants

- Use the ephemeral `agent-broker-auth` partition by default. Normal startup clears legacy persistent storage/cache/authentication and removes the development cookie snapshot before opening a browser surface.
- Closing the main control-plane window quits on Linux and macOS even when a popup remains. Quit and terminal signals share cleanup; repeated quit requests must wait for the same socket shutdown and optional persistence flush. Do not recreate windows during shutdown or retry interrupted writes. A second launch restores/focuses the existing window without resetting authentication.
- Only `AGENT_BROKER_DEV_PERSIST_AUTH=1` selects persistence, restores/mirrors the mode-0600 development snapshot, and shows `DEV · AUTH PERSISTENCE`.
- The visible operator browser and unmapped hidden worker share a partition. Hidden work must never replace or move the visible browser. Visible CSS and hidden browser-JSON work have separate serialized surfaces; direct authenticated JSON navigates neither.
- Profiles are reusable application sessions. Profiles in one `sign_in_group` keep separate probes but share one readiness indicator. Refresh only profiles referenced by enabled capabilities: at startup, every five minutes, and for authorized calls. Coalesce concurrent checks.
- Authentication waits back off after 2, 4, 8, and 16 seconds, then at most every 30 seconds; a five-minute wait makes no more than 12 retry probes. Log stable state changes, not each transient `checking` state. Identity expiry is an estimate, never raw identity data.
- Before human login for an authorized request, try exactly one queued hidden navigation to the fixed profile `login_url`, then recheck. Do not do this during periodic checks. If human interaction is needed, resolve an enabled unready profile in the main process; never accept a login URL from the renderer.
- Treat Electron's exact `Redirect was cancelled` probe outcome as an unavailable application session so the bounded login handoff remains usable.
- Preserve SPA login-return grace periods and bounded same-origin retries. Do not depend on `did-stop-loading`, reset grace on every history event, or discard post-authentication state before extraction succeeds. Preserve target-to-root bounce handling even without an external login visit.
- Do not synchronize the address field while the operator edits it. Enter/Go commits; Escape restores the current webview URL.
- `agent-broker inspect` is a user-only socket diagnostic for the visible browser's attached DevTools, never an agent capability or TCP debugging port. Do not record cookies or request headers.

Prefer `authenticated_json` for a suitable fixed structured GET. Use `browser_json` when the application must make the exact same-origin GET itself; never retain that request's headers. Keep CSS as a constrained discovery/fallback path. JSON projection is RFC 6901; transforms are finite built-ins, not arbitrary scripts.

MCommunity validates a semantic group key against the fresh active-group list before constructing fixed-origin paths. Expense behavior and operator setup are in [docs/expense-reports.md](docs/expense-reports.md); preserve fresh-form validation, frozen attachments, non-posting capture, one POST, confirmation detection, and private journals. UM GPT behavior is in [docs/umgpt-conversation.md](docs/umgpt-conversation.md); preserve account ownership/model validation, finite projections, prompt reservation, account-wide connector verification, and human tool approvals. Agent procedures remain in the service workflows rather than these operator notes.

Keep the renderer compact: light system styling, readable fonts, square controls, little nesting/padding, plain titles, and no promotional placeholder copy. Events go to the runtime `logs/agent-broker.jsonl`, not a live event feed.

## Commands and verification

```bash
npm ci
npx install-electron --no
npm link
npm start
agent-broker start
npm run check
npm run smoke:linux
npm run smoke:macos
npm run preview
npm run add-service-token -- SERVICE_ID
agent-broker services
agent-broker capabilities
agent-broker connect --capability NAME --input '{}'
agent-broker inspect summary
agent-broker inspect auth --capability NAME
agent-broker inspect query --selector 'main'
agent-broker inspect console --limit 20
agent-broker inspect network --limit 20
```

For changes, update README and these instructions when behavior/boundaries change. Update and validate the bundled skill when agent-facing behavior changes. Add or adjust focused protocol, authorization, or configuration tests when those behaviors change, and run `npm run check`.

Renderer, extraction, startup, or lifecycle implementation changes require the Electron smoke. All automated Electron UI checks on the Thelio must use the installed `testing-native-xwindows-apps-on-thelio` skill and its private Xvfb harness, including `smoke:linux` in headful test mode. On macOS, an explicit desktop-testing request authorizes `smoke:macos` in the logged-in, unlocked native desktop; it uses direct Electron APIs without Accessibility automation or a debugging port. The Mac smoke checks screen-lock state before launching. Inspect a desktop-sized screenshot and confirm teardown. On Linux never launch a test on the inherited display. A user's request to use the broker authorizes its visible login window, not desktop UI testing.

The Linux smoke uses local fixtures, standard Xvfb/D-Bus tools, and an isolated home. Mac tests reuse the fixture assertions and native lifecycle checks with short private socket paths. Preserve the Linux safeguards and assertions when changing shared tests. Forced process-group cleanup is a test failure. CI checks Ubuntu and both Mac architectures with Node 22.12 and 24, including Electron smoke on Node 24. Do not turn tests into live external-account writes. Keep the `package.json` source allowlist free of runtime data and output experiments.
