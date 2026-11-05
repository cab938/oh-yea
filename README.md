# agent-broker

A local, human-supervised bridge between agents and authenticated web applications. Agents request named capabilities with JSON input. The broker checks service permissions, uses private configured routing, and releases only schema-validated results.

This is a Linux and macOS desktop prototype for one operator and cooperative processes under the same Unix account.

## Install

Use Node.js 22.12 or newer, npm, and a logged-in Linux or macOS desktop capable of running Electron. Native Apple silicon and Intel Macs are supported. macOS needs no XQuartz or GNU utilities.

```bash
git clone https://github.com/cab938/oh-yea.git
cd oh-yea
npm ci
npx install-electron --no
npm_config_prefix="$HOME/.local" npm link
export PATH="$HOME/.local/bin:$PATH"
agent-broker
```

These commands install dependencies and link the CLI locally; they do not publish to npm. Add the PATH setting to your shell configuration if you want the CLI available in new terminals. `npm start` also opens the app directly from the checkout.

Keep the checkout in place: the linked CLI uses it. A first launch has no configured capabilities. Choose a maintained service below and follow the [setup guide](skills/agent-broker/references/add-service.md#5-install-the-requested-private-definitions). Templates stay disabled until their private routing is configured and they are deliberately enabled.

The Browser pane handles human sign-in and 2FA. The Configuration pane edits capabilities and authentication profiles. A second launch focuses the existing window; closing it exits the broker.

`agent-broker start` starts once in the background and waits up to 30 seconds for service discovery. Its JSON envelope returns `data.status: "started"` and the owned Electron `pid`, or `"already_running"` with `pid: null`. Failures return `ok: false` and a nonzero exit status; startup never retries a launch. It reuses an existing broker without requiring a desktop or loading tokens. A new Linux instance requires `DISPLAY` or `WAYLAND_DISPLAY`; a new Mac instance requires a graphical login session. The Electron binary must already be installed. Operator Electron options can follow `start --`, as with foreground startup; ordinary agent startup needs none.

Closing the main window, Quit, SIGINT, and SIGTERM stop the broker, its popups, workers, and socket on both platforms. A restart begins a new ephemeral authentication session by default.

## Use with an agent

Install the [agent-broker skill](skills/agent-broker/SKILL.md) in your agent's skill directory. For Codex, a symlink keeps it current with this checkout and refuses to replace an existing installation:

```bash
skill_destination="${CODEX_HOME:-$HOME/.codex}/skills/agent-broker"
mkdir -p "$(dirname "$skill_destination")"
if [ -e "$skill_destination" ] || [ -L "$skill_destination" ]; then
  printf 'Keep or review the existing installation at %s\n' "$skill_destination"
else
  ln -s "$PWD/skills/agent-broker" "$skill_destination"
fi
```

Keep an existing link to this checkout. Review a different installation at that name before replacing it.

Example requests:

- "Use $agent-broker to check my Great Lakes allocation balance."
- "Use $agent-broker to prepare this expense report for review."
- "Use $agent-broker to add a new service for my portal and a capability that reads my quota."

The skill loads only the chosen service's procedure and contracts for ordinary tasks. An explicit request to add access loads its separate [service and capability authoring guide](skills/agent-broker/references/add-service.md). Ordinary use never authorizes configuration changes.

A **service** groups capabilities under one permission token. A **capability** is one bounded operation with input and output schemas. **Authentication profiles** describe how the broker checks a human-operated application session; profiles are separate from service permissions.

## Maintained services

| Service | Operator resources | Agent procedure |
| --- | --- | --- |
| ARC Great Lakes | [authentication](services/arc/authentication.example.yaml), [templates](services/arc/templates/) | [workflow](services/arc/workflow.md) |
| MCommunity | [authentication](services/mcommunity/authentication.example.yaml), [templates](services/mcommunity/templates/) | [workflow](services/mcommunity/workflow.md) |
| U-M expense reports | [setup notes](docs/expense-reports.md), [templates](services/expense-reports/templates/) | [workflow](services/expense-reports/workflow.md) |
| UM GPT | [setup notes](docs/umgpt-conversation.md), [templates](services/umgpt/templates/) | [workflow](services/umgpt/workflow.md) |

Examples contain placeholder routing and no live tokens. Maintained templates are also used by tests. Adding a capability to an existing service grants it to every token for that service; choose the service boundary deliberately.

## Calls and authentication

```bash
agent-broker services
agent-broker connect --capability arc.remaining_hours.read --input '{}'
```

The call above is an example for an enabled ARC capability. Discover first, read the returned service workflow and contract paths, then use the input schema actually advertised by the running broker. `agent-broker capabilities` returns the full redacted catalog when diagnosis needs it.

Discovery needs no token. One-shot `connect` resolves the service and reads its token internally; agents never read or supply tokens. Long-lived JSON Lines `connect` is for operator-managed clients that supply their service token with each request.

If login is needed, the same request waits while the human signs in through the Browser pane. The visible browser and hidden worker share an isolated session; routine structured operations do not move the visible page. Authentication lasts while the process remains open. Development can explicitly opt into persistence with `AGENT_BROKER_DEV_PERSIST_AUTH=1`; its private cookie snapshot must never be shared.

The service workflow owns approval rules. Expense submission needs separate approval of the prepared report. UM GPT tool approvals remain human-operated. A failed or interrupted call can have an uncertain write outcome: preserve its identifier and never resend automatically.

## Private runtime files

Normal writable state lives under `${XDG_CONFIG_HOME:-~/.config}/agent-broker` on both Linux and macOS (including Macs with no `XDG_CONFIG_HOME`):

| Path | Purpose |
| --- | --- |
| `config.yaml` | Shared authentication profiles |
| `.env` | One distinct token per service |
| `capabilities/` | Private capability YAML |
| `services/` | Workflow copies and generated redacted contracts |
| `logs/` | Redacted events and expense rehearsal artifacts |
| `submissions/` | Duplicate-write prevention journals |
| `broker.sock` | User-only Unix socket |

`AGENT_BROKER_HOME` selects an isolated runtime home. `AGENT_BROKER_CONFIG` selects another authentication file, with capability YAML and `.env` beside it; other state stays in the runtime home. The app and CLI share the resolver in [paths.mjs](src/lib/paths.mjs). Private directories use mode `0700`; configuration and token files use `0600`.

Capability file edits reload while the app runs. Apply profile changes through the Authentication editor or a deliberate restart. Token and broker code changes require a restart, which ends ephemeral sign-in sessions.

To add a token during an explicit service setup:

```bash
npm run add-service-token -- SERVICE_ID
```

Replace `SERVICE_ID` with a lowercase service ID such as `sample-portal`. The helper creates a random token privately, preserves existing entries, and prints no values. [.env.example](.env.example) documents the key format. Do not source `.env`, commit it, or send its contents to an agent.

## Diagnosis and development

Operator diagnostics inspect the visible browser through the local socket:

```bash
agent-broker inspect summary
agent-broker inspect auth --capability arc.remaining_hours.read
agent-broker inspect query --selector 'main'
agent-broker inspect network --limit 20
```

This is an operator interface, not an agent capability. It opens no TCP debugging port. The event log is `logs/agent-broker.jsonl` under the runtime home.

```bash
npm run check
npm run smoke:linux   # Linux, on a private Xvfb display
npm run smoke:macos   # macOS, in the logged-in native desktop session
```

The Linux smoke needs `xvfb-run`, `xauth`, and `dbus-run-session`, supplied on Debian/Ubuntu by `xvfb`, `xauth`, and `dbus-x11`. It uses a private display and D-Bus session. The Mac smoke opens native Electron windows and requires an unlocked desktop; it checks the screen-lock prerequisite before launching and requires no Accessibility permissions. Both use only local fixture services and short private temporary runtime homes, never the operator's configuration or real accounts. Run these tests serially on a desktop.

Both commands include fixture integration and lifecycle checks: detached startup, discovery, single-instance reuse, authentication, output validation, simulated service writes, window restore/focus, close with a popup open, Quit, terminal signals, ephemeral restart, and explicit development-cookie flush. Forced teardown or surviving owned processes fails the run. `npm run smoke:lifecycle` runs just the lifecycle checks inside the appropriate desktop harness.

The smoke leaves a screenshot in the system temporary directory as `agent-broker-smoke.png`; `AGENT_BROKER_SMOKE_SCREENSHOT` selects another path. On fixture failure, a sibling `.diagnostics.txt` preserves the stage, Electron stderr, and broker log before temporary state is removed. These artifacts use synthetic fixture data. Inspect the screenshot and verify teardown when validating locally.

CI runs `npm run check` on Ubuntu 24.04, macOS 15 ARM64, and macOS 15 Intel with Node 22.12 and 24. It runs each platform's full Electron smoke on Node 24 and retains screenshots and test diagnostics. Local fixture coverage does not establish compatibility with current live U-M services.

On the Thelio, follow the installed native-Xvfb skill's harness as required by [AGENTS.md](AGENTS.md). Its `AGENT_BROKER_SMOKE_HEADFUL=1` mode checks the private display and authority before launching Electron. Never test against the inherited desktop.

`npm run preview` serves a static browser preview on loopback without authenticating or executing capabilities.

The source is organized around [configuration validation](src/lib/config.mjs), a [finite capability dispatcher](src/lib/capability-executor.mjs), [authentication coordination](src/lib/authentication-manager.mjs), and service-specific modules. The [authoring guide](skills/agent-broker/references/add-service.md) explains when each needs changing.

The `files` allowlist in [package.json](package.json) defines distributable resources. Private runtime data, generated contracts, dependencies, and local output are excluded. This is a source release; filesystem permissions and tokens do not isolate a hostile process running as the same Unix user. [IDEAS.md](IDEAS.md) is a deferred historical backlog, not a description of the current architecture.

## License

[MIT](LICENSE).
