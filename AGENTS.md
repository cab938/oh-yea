# AGENTS.md

## Project intent

`agent-broker` is a local, human-supervised control plane that lets processes
request named capabilities backed by configured web extractions, one bounded
expense-form workflow, or UM GPT conversations and account connector activation. A request is permitted only when its token belongs
to the service of the named, enabled capability. The capability's target URL, form action, and
field routing are private broker configuration and are never selected by the
calling agent.

This is a personal prototype and local hack, not production or enterprise
software. Prefer the smallest direct implementation that is easy to inspect
and change. Do not add compatibility layers, negotiation machinery, wrapper
objects, or version fields without a concrete current use for them.

Keep this file current whenever the architecture, trust boundary, commands, or
prototype status changes.

## Governing constraints

- Follow `../AGENTS.md`.
- Keep the broker local-first. Do not add a network listener without an explicit
  threat model and user approval.
- Never return browser cookies, OAuth credentials, passwords, 2FA values, or
  configured broker tokens to a calling process.
- Never log raw tokens or sensitive browser state.
- Agents supply capability names, never target URLs, selectors, or browser
  instructions. Do not turn caller input into an unrestricted fetch or
  browser-navigation capability.
- Mutating capabilities must be explicitly named and bounded. Current writes
  are `umich.teamdynamix.expense_report.submit`,
  `umich.umgpt.conversation.send`, and `umich.umgpt.connector.set_active`; do not expose general
  TeamDynamix ticket, attachment, HTTP, or API operations.
- Prefer declarative, reviewable extraction routines over arbitrary JavaScript.
- Authentication is human-operated in the visible browser pane. Agents may wait
  for completion, but may not fill credentials or 2FA challenges.
- Preserve the arbitrary JSON `input` object in the request protocol. New uses
  of it must be explicitly defined by each extraction type.
- The prototype assumes cooperative local callers. Adversarial processes running as the same
  Unix user are out of scope.
- `IDEAS.md` is the explicitly deferred backlog. Do not expand the current scope from it
  without a new decision.

## Current prototype

- `src/main.mjs` owns Electron lifecycle, windows, IPC, configuration reloads,
  and result validation/health reporting. `src/lib/capability-executor.mjs`
  dispatches the finite supported operations using the current request's
  authentication profile and existing browser surfaces. Application-specific
  operations remain in their expense and UM GPT modules. Configuration
  normalization stays in `src/lib/config.mjs`; capability files validate directly against normalized profiles. The authentication manager owns shared browser/API check coalescing, silent handoffs, polling, and waits; there is no adapter registry.
- Electron control plane with Browser and Configuration panes. Redacted
  operational events are appended to the ignored mode-0600
  `logs/agent-broker.jsonl` file rather than rendered as a live event feed.
  All runs keep writable state under the runtime home, including configuration, tokens, capabilities, logs, journals, workflow copies, and generated contracts. Installed source, service examples, and icons are resources.
- Capability definitions are private mode-0600 YAML files at
  `<runtime-home>/capabilities/<capability-name>.yaml`. The runtime `config.yaml` holds
  shared authentication profiles only. Each capability has a `service` field;
  it never stores broker tokens. One distinct token per service lives in the
  private mode-0600 `.env` beside `config.yaml`. These live files remain ignored.
  Service tokens grant every enabled capability in that service; adding a
  capability does not create another grant mapping. Reject legacy capability
  `tokens` fields instead of silently retaining per-capability permissions.
  Read .env as data without sourcing shell code or exporting its values.
  Token changes require a broker restart; never send the token map to the renderer.
- Disabled, sanitized capability templates live only at
  `services/<service-id>/templates/<capability-name>.yaml`. Tests and smoke
  fixtures reuse them. Operators copy selected templates without overwriting
  live files, configure private routing and authentication, and explicitly
  enable them. Do not install, merge, enable, or update configuration automatically.
  Source checkout installation uses `npm ci` and `npm link`; the bundled
  skill can be symlinked as documented in README without replacing another skill.
- Every capability declares `input_schema` and `output_schema` JSON Schemas.
  Inputs are checked before execution and results are checked before release.
  An output mismatch fails closed as `CAPABILITY_BROKEN` and is surfaced to the
  operator as a broken capability; callers never receive malformed data.
- The capability directory is watched while the app is running. Valid external
  edits apply automatically; invalid files remain visible in the operator UI
  but are unavailable to callers. Normalize directory and file modes only when
  they differ from `0700` and `0600`; unconditional chmod during reload creates
  a watcher feedback loop and repeated authentication refreshes.
- `agent-broker capabilities` returns a JSON-only catalog containing names,
  service IDs, descriptions, enabled state, and schemas. It must never include URLs,
  tokens, authentication details, selectors, request headers, or pointers.
- `agent-broker services` is tokenless discovery of maintained service workflows.
  `services/<id>/workflow.md` frontmatter supplies id, name, aliases, and
  description. Capability membership comes only from each private capability's
  `service` field. Discovery atomically regenerates adjacent `capabilities.json`
  files using the redacted live catalog and returns absolute workflow/contract
  paths. Never return paths to private YAML, .env, or browser state. Public
  snapshots do not authorize calls. Unknown service guides fail discovery.
  Every runtime home receives copies of the maintained guides and generated snapshots under its services directory; discovery never writes into installed resources. Keep generated contracts ignored.
- The Configuration pane lists capability files, supports creating and editing
  them, and retains a separate Authentication YAML editor for `config.yaml`.
- Keep the renderer compact and operational: light system styling, readable
  system fonts, square controls and panels, minimal padding, plain pane titles,
  and no promotional or explanatory browser-placeholder copy.
- All automated Electron UI testing on the Thelio must use
  the installed `testing-native-xwindows-apps-on-thelio` skill and its private
  Xvfb harness. Never launch `npm start`, `agent-broker`, or UI
  input tools on the inherited desktop display for testing. A user request to
  use the broker or one of its services authorizes opening its visible login
  window when needed; this does not authorize desktop launches for testing.
- Ephemeral isolated Electron browser session by default for interactive
  authentication, plus an unmapped worker window sharing the same partition for
  routine structured-response extraction, fixed expense-form preparation,
  and UM GPT conversation sends.
  Authentication persists across calls only while the broker process remains
  open. Hidden-worker navigation must never replace or move the visible
  operator browser.
- Do not overwrite the browser address field while it has focus. Extraction
  polling and navigation events may synchronize it only when the operator is not
  editing; Enter/Go commits and Escape restores the current webview URL.
- YAML defines named, reusable application-session profiles separately from
  capabilities. Profiles share one isolated browser partition, so a single
  human U-M identity-provider sign-in can establish multiple application
  sessions without another credential prompt. Enabled capabilities reference a
  profile by name, so each application session is polled once rather than once
  per capability. Capability-specific
  authenticated API request-header mappings remain on the extraction, not the
  shared profile. Capabilities retain private URLs and service membership. The
  three general declarative extraction methods are listed here; the finite
  UM GPT adapter is described below:
  - `authenticated_json` derives configured API request headers from a
    session-bound identity response, performs an authenticated GET to a fixed
    backend URL, and releases only an RFC 6901 JSON Pointer projection.
  - `css` loads a fixed page in the visible browser and returns a constrained
    DOM selection.
  - `browser_json` loads a fixed page in the hidden session-sharing worker,
    captures only an exact configured same-origin GET response body, and applies
    a JSON Pointer plus an optional finite built-in normalization. Never capture
    or retain the matching request's headers.
- A capability defines exactly one `extraction` or `action`. The expense action
  types are `teamdynamix_expense_report_capture` and
  `teamdynamix_expense_report`. Their advertised `input_schema` is the
  agent's form template. Private configuration fixes the form URL, exact
  same-origin POST action, confirmation prefix, form ID, semantic field
  mappings, and attachment limits. Caller input contains semantic values and
  absolute attachment paths, never TeamDynamix field names, choice values,
  tokens, or endpoints.
- UM GPT uses a dedicated `umgpt_conversation` extraction (models, connectors, list, read)
  and action (one text prompt). Its profile probes the fixed same-origin
  `/umgpt/api/me`; identity data stays broker-only. The adapter resolves the
  authenticated user's ID and validates conversation ownership and model
  membership before using fixed service routes. Connector discovery reads the
  signed-in account's fixed connectors route and projects only ID, display name,
  description, account active state, and tool count. It includes inactive
  connectors, preserves unknown counts as null, and never changes settings or
  releases connector credentials or endpoint configuration. Sending runs in the serialized
  hidden worker with its session-bound WebSocket. Agentic models may use the
  user's existing connectors, but tool approval decisions remain human-operated.
  `approval_required` returns a conversation link for review. Reserve each
  request ID before sending; duplicates, conflicts, or uncertain outcomes never
  send automatically. Journals contain identifiers, digests, and outcome state,
  never prompts or replies. See `docs/umgpt-conversation.md` and
  `services/umgpt/templates/` for setup and maintained contract templates.
  Do not add general WebSocket access,
  general connector configuration, automatic tool approvals, or arbitrary HTTP operations.
- The `umgpt_connector_state` action sets one installed connector's account-wide
  `is_active` flag. Derive the account internally and require the connector ID
  in its fresh inventory. An already-satisfied state is a no-op; otherwise make
  one fixed same-origin PATCH containing only `is_active`, using the session's
  broker-only CSRF value, then verify through a fresh inventory read. Never
  return the write response, cookies, or CSRF value. Rejected or uncertain
  writes must not retry automatically; direct callers to connector discovery.
- The capture action shares the live form load, verification, semantic mapping,
  and attachment freezing used by submission, then stops before journaling or
  POST. It writes a mode-0600 inspection artifact under
  `logs/expense-captures/` containing mapped values and attachment metadata but
  no receipt bytes, local paths, cookies, credentials, or anti-forgery values.
  It returns only a sanitized capture reference and attachment status and does
  not consume the submission ID.
- For expense submission, load a fresh copy of the fixed form in the hidden
  session-sharing worker, verify its action, form ID, anti-forgery fields,
  configured controls, choices, and file input, then submit exactly one
  multipart POST containing the fixed attachment bytes. Any drift fails closed
  before the write. Record success only after extracting a request ID from the
  fixed confirmation location or returned detail page, including a marked-up
  `Service Request ID` label. A returned expense form is a definite rejection;
  any other unrecognized post-submit response is outcome-unknown. Record a
  sanitized mode-0600 journal under the broker runtime directory. A completed
  submission ID replays its recorded result
  without another POST; conflicting, rejected, interrupted, or uncertain
  attempts must not retry automatically. Internal comparison digests remain
  broker-only and are not part of the agent workflow.
- Prefer `authenticated_json` when DOM inspection reveals that a page is backed
  by a suitable structured request that the broker can call directly. Use
  `browser_json` only when the authenticated application itself must make the
  structured request. Keep CSS as the discovery path and fallback; do not add
  arbitrary JavaScript.
- MCommunity uses the built-in `mcommunity_groups` and `mcommunity_group`
  browser-JSON transforms. Detail input is a human-readable group key, never a
  URL. Refresh the authenticated group list and require an exact active-group
  match before constructing the fixed-origin group and API paths.
- The header has one indicator per configured `sign_in_group` referenced by an
  enabled capability. Profiles in that group retain separate application-session
  probes, but the header represents the shared human sign-in burden rather than
  listing each application's cookie separately. It reports grouped application readiness, not a direct central identity-provider probe,
  and refreshes each profile referenced by
  an enabled capability at startup, every five minutes, and for every authorized
  CLI capability request. Concurrent checks for the same profile and probe are
  coalesced. Authentication waits retry after 2, 4, 8, and 16 seconds, then at
  most every 30 seconds; a five-minute wait performs no more than 12 retry
  probes. The log records stable authentication-state changes only, not each
  transient `checking` update. An optional declarative identity-body expiry
  pointer supplies an approximate revalidation time; expose only the converted
  timestamp and label it as an estimate. Never send identity-header values or
  the identity response body to the renderer.
- Electron may report a protected application's manual redirect as
  `Redirect was cancelled`. Treat that exact result as an unavailable
  application session, not an unknown probe failure, so the grouped header can
  offer its bounded sign-in handoff.
- Before visible authentication for an authorized request, make exactly one
  queued hidden-worker navigation to the profile's fixed `login_url`, then
  recheck its probe. This lets an existing U-M identity-provider session
  establish ARC, TeamDynamix, and similar application sessions silently and
  on demand; do not perform these navigations during periodic startup checks.
  When a profile still needs human interaction, make its group's header indicator an
  accessible button. Resolve its action against one enabled unready profile in the main
  process, try the same silent handoff once, then open only that profile's
  configured `login_url` in the Browser pane and poll for completion. Never
  accept a login URL from the renderer.
- Normal startup uses the non-persistent `agent-broker-auth` partition, clears
  the legacy `persist:agent-broker-auth` partition through Electron's storage,
  cache, and authentication-cache APIs, and removes the old
  `development-cookies.json` snapshot before opening a browser surface. Setting
  `AGENT_BROKER_DEV_PERSIST_AUTH=1` explicitly selects the persistent partition,
  restores and mirrors cookies in the mode-0600 development snapshot, and
  displays `DEV · AUTH PERSISTENCE` in the header. Isolated
  `AGENT_BROKER_HOME` runs keep the snapshot in that directory. Never log,
  commit, or return it.
- The live authentication policy is `<runtime-home>/config.yaml`; capability files live under `<runtime-home>/capabilities/`. A first launch creates an empty authentication map and no enabled capabilities. Sanitized authentication examples accompany each maintained service. Legacy checkout files are imported only by an explicit operator `npm run import-config -- /path/to/previous/configuration-directory`; the importer validates first, never overwrites or enables files, preserves private modes, and leaves originals and journals intact. Do not commit live tokens, private URLs, selectors, or request-header mappings.
- `skills/agent-broker/SKILL.md` is the single agent entry point. Route broker,
  UM GPT, ARC, MCommunity, and expense requests through service discovery; read
  only the selected workflow and contracts. Canonical procedures are under
  `services/`, including expense review and separate explicit submission approval.
  Follow `services/umgpt/workflow.md` for agent connector selection and the
  operator's authorization for account-wide activation changes.
  Operator setup documents link to those procedures. Keep the router's OpenAI
  metadata synchronized with the CLI. Never put tokens or private routing in
  the skill or public service files.
- The skill first tries `agent-broker services` and reuses a running broker.
  Only when initial discovery reports that the control plane is not running,
  launch visibly on Linux with
  `setsid --fork agent-broker </dev/null >/dev/null 2>&1`, then wait at most
  30 seconds for discovery. Launch once; preserve the existing single-instance
  lock and focus behavior. Keep the same capability request pending during
  human login. Missing executable/display or failed startup means report and
  stop, not install software, restart a broker, or replay a possible mutation.
- Local Unix-domain socket and JSON Lines request/response protocol.
- `agent-broker connect` supports long-lived stdin/stdout and one-shot requests.
  One-shot mode resolves the capability's service from the live catalog and
  reads its `AGENT_BROKER_TOKEN_<UPPERCASE_SERVICE>` from the private `.env`;
  hyphens in service IDs become underscores. Explicit CLI or environment token
  overrides retain precedence for operator use. Agents never read or supply
  tokens. Long-lived callers supply the service token in each request. The old
  `client-token` file is not used. An alternate `AGENT_BROKER_CONFIG` selects
  .env beside that configuration; isolated homes use their own .env.
- Visible CSS requests and hidden browser-JSON requests are each serialized on
  their own browser surface. Direct authenticated-JSON requests do not navigate
  either surface.
- Operator browser diagnosis uses `agent-broker inspect` over the mode-0600
  Unix socket and Electron's attached DevTools protocol. It remains attached to
  the visible operator webview, not the hidden worker. Do not open a TCP
  remote-debugging port, record cookies or headers, or expose this interface as
  an agent capability.
- After an external login flow returns to the capability's target origin, let
  the return page have a short grace period before retrying the configured URL.
  Do not depend on `did-stop-loading` or keep resetting the grace period for
  same-origin SPA history updates; authenticated SPAs may do either indefinitely.
  Keep retries bounded so client-side session initialization is not interrupted
  and redirect loops remain contained.
- Do not discard post-authentication state merely because the exact target URL
  was briefly reached. Preserve it until extraction succeeds so an unready
  target-to-root SPA bounce can use a same-origin in-page navigation retry. The
  bounce must work even when an existing login means the request never visits
  an external identity-provider origin.

## Commands

```bash
npm ci
npm test
npm run check
npm run smoke
npm run smoke:linux
npm run import-config -- /path/to/previous/configuration-directory
npm start
AGENT_BROKER_DEV_PERSIST_AUTH=1 npm start
npm run preview
npm link
agent-broker
agent-broker services
agent-broker capabilities
agent-broker connect
agent-broker inspect summary
agent-broker inspect auth
agent-broker inspect auth --capability arc.remaining_hours.read
agent-broker inspect query --selector 'app-remaining-hours'
agent-broker inspect console --limit 50
agent-broker inspect network --limit 50
```

The runtime home is `${XDG_CONFIG_HOME:-~/.config}/agent-broker`, containing configuration, tokens, capabilities, logs, journals, generated contracts, the socket, and optional development browser state. `AGENT_BROKER_HOME` overrides that home. `AGENT_BROKER_CONFIG` selects an explicit authentication file with capabilities and `.env` beside it; other runtime state stays in the home. The source release includes only the allowlisted resources in `package.json`; `output/` experiments and private runtime files remain excluded. The public Linux smoke command uses standard Xvfb/D-Bus tools. On the Thelio, continue using the prescribed private native-Xvfb harness, including for `smoke:linux` with its existing headful test mode.

## Definition of done for changes

- Update `README.md` and this file when behavior or boundaries change.
- Update and validate `skills/agent-broker` when the agent-facing CLI,
  discovery, capability request, timeout, or error contract changes.
- Add or update tests for protocol, authorization, and configuration behavior.
- Run `npm run check`.
- For renderer or extraction changes, run `npm run smoke`, then use the private
  Xvfb harness for any interactive Electron checks and inspect its screenshot at
  a desktop-sized viewport. Confirm the Xvfb display is gone after teardown.
