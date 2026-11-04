# agent-broker

A local, human-supervised bridge between agents and authenticated web applications. Callers request named capabilities with JSON input. The broker checks service permissions, uses private configured routing, and returns only schema-validated results.

This is a personal prototype for Linux desktop users and cooperative callers under the same Unix account.

## Install and run

Use Node.js 22.12 or newer, npm, and a working Linux desktop capable of running Electron.

```bash
git clone https://github.com/cab938/oh-yea.git
cd oh-yea
npm ci
npm link
agent-broker
```

Keep the checkout in place: the linked CLI uses its source files. A second launch focuses the existing window and retains authentication. Closing the window exits the broker.

The Browser pane handles human-operated SSO and 2FA. The Configuration pane edits capability files and shared authentication profiles. Operational events are written to a private log.

## Runtime files

All normal writable state lives under `${XDG_CONFIG_HOME:-~/.config}/agent-broker`:

| Path | Contents |
| --- | --- |
| `config.yaml` | Application authentication profiles |
| `.env` | One private token per service |
| `capabilities/*.yaml` | Private capability routing and schemas |
| `services/*/` | Workflow copies and generated public contracts |
| `logs/` | Redacted events and expense rehearsal captures |
| `submissions/` | Duplicate-write prevention journals |
| `broker.sock` | User-only Unix socket |

Configuration and tokens are mode `0600`; private directories are mode `0700`. The installed source, templates, workflows, and icons are resources rather than runtime storage.

`AGENT_BROKER_HOME` selects a different runtime home for an isolated installation or test. `AGENT_BROKER_CONFIG` selects an explicit authentication file; its capability directory and `.env` remain beside that file, while logs, journals, generated contracts, and the socket stay in the runtime home. The app and CLI use the same resolver.

Source changes and token changes take effect on the next broker restart. Updating the linked skill changes agent instructions immediately.

## Import an existing installation

Earlier versions kept private configuration in the checkout. Before the first launch using the new layout, run:

```bash
npm run import-config -- /absolute/path/to/previous/configuration-directory
```

For an earlier checkout, pass that checkout's directory. This explicitly copies its validated `config.yaml`, optional `.env`, and capability YAML into the selected runtime configuration location. It never overwrites destination files, changes enablement, deletes originals, or changes submission journals. An invalid source fails before copying.

If the destination is already configured, review it in the Configuration pane instead of replacing it with the importer. There is no automatic migration.

## Configure a service

A first launch creates an empty authentication configuration and no enabled capabilities. The maintained service examples are:

| Service | Operator examples | Agent procedure |
| --- | --- | --- |
| ARC Great Lakes | [authentication](services/arc/authentication.example.yaml), [capabilities](services/arc/templates/) | [workflow](services/arc/workflow.md) |
| MCommunity | [authentication](services/mcommunity/authentication.example.yaml), [capabilities](services/mcommunity/templates/) | [workflow](services/mcommunity/workflow.md) |
| U-M expense reports | [authentication](services/expense-reports/authentication.example.yaml), [capabilities](services/expense-reports/templates/) | [workflow](services/expense-reports/workflow.md) |
| UM GPT | [authentication](services/umgpt/authentication.example.yaml), [capabilities](services/umgpt/templates/) | [workflow](services/umgpt/workflow.md) |

All example URLs and mappings are placeholders. Every bundled capability is disabled. Tests reuse the same maintained examples.

Before first launch, an operator can copy one selected service's authentication example and selected capability files without replacing existing files. For example:

```bash
broker_home="${AGENT_BROKER_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-broker}"
(
  umask 077
  mkdir -p "$broker_home/capabilities"
  cp -n services/arc/authentication.example.yaml "$broker_home/config.yaml"
  cp -n services/arc/templates/arc.remaining_hours.read.yaml "$broker_home/capabilities/"
)
```

If `config.yaml` already exists, use its editor to add the selected profile under `authentications`. Several services can share that mapping. Replace example routing, selectors, response projections, and field mappings with inspected values for the intended account before deliberately enabling a capability.

The operator must also create a mode-`0600` `.env` beside `config.yaml`. The following command creates distinct random tokens for the four maintained services and refuses to replace an existing file. It prints no token values:

```bash
node --input-type=module - "$broker_home/.env" <<'JS'
import fs from "node:fs";
import { randomBytes } from "node:crypto";
const services = ["arc", "mcommunity", "umgpt", "expense-reports"];
const entries = services.map((service) =>
  "AGENT_BROKER_TOKEN_" + service.toUpperCase().replaceAll("-", "_") +
  "=" + randomBytes(32).toString("hex"));
fs.writeFileSync(process.argv[2], entries.join("\n") + "\n",
  { mode: 0o600, flag: "wx" });
JS
```

An explicit `AGENT_BROKER_CONFIG` override changes the token file location as described above. [.env.example](.env.example) documents the supported token names. Do not source the file, commit it, send it to agents, or export its values.

Each token authorizes all enabled capabilities in its service. Inputs are checked before execution; outputs are checked before release. A malformed result fails closed as `CAPABILITY_BROKEN`. Capability files are watched: valid edits apply automatically, while invalid files remain visible to the operator and unavailable to callers.

Expense setup is documented in [expense-claim-v1.md](docs/expense-claim-v1.md); UM GPT setup is in [umgpt-conversation.md](docs/umgpt-conversation.md).

## Authentication and execution

Authentication is ephemeral by default and shared across calls while the broker remains open. The visible browser and serialized hidden worker share one isolated partition. Routine structured reads and bounded actions use the worker without moving the operator's browser.

The authentication manager owns shared checks, polling, silent-session handoff coordination, and authentication waits. Application-specific probe mechanics remain with their browser or API surface. Grouped header indicators show application readiness for a shared human sign-in.

If an application session is unavailable, the broker tries the profile's fixed login URL silently before asking for human interaction. The same request remains pending during login. Passwords, credentials, and 2FA remain human-operated.

Development can explicitly opt into persistence:

```bash
AGENT_BROKER_DEV_PERSIST_AUTH=1 agent-broker
```

This uses a persistent partition and a private development cookie snapshot. The header displays `DEV · AUTH PERSISTENCE`. Normal ephemeral startup clears legacy persisted authentication and removes that snapshot. Never publish browser state.

The supported extraction paths are constrained CSS in the visible browser, authenticated JSON with a fixed projection, and exact same-origin GET response capture in the hidden worker. Expense and UM GPT operations have finite service-specific implementations.

The main process owns Electron lifecycle, IPC, configuration reloads, and result validation. [capability-executor.mjs](src/lib/capability-executor.mjs) dispatches the finite supported operations. Private routing and browser credentials stay inside the broker; callers supply capability names and semantic input.

## CLI and agent use

```bash
agent-broker services
agent-broker capabilities
agent-broker connect --capability arc.remaining_hours.read --input '{}'
```

Discovery is tokenless. `services` publishes fresh redacted contracts under the runtime home and returns each service's workflow and contract paths. Agents read only the selected pair. Public contracts include names, services, descriptions, enablement, and schemas; they do not expose private routing or credentials.

One-shot `connect` resolves the service and reads its token internally. Agents never read or supply tokens. Long-lived `connect` bridges JSON Lines on stdin/stdout; operator-managed callers supply their service token with each request. Explicit CLI and environment token overrides remain available for operator use.

The single [agent skill](skills/agent-broker/SKILL.md) contains startup, invocation, and error procedures. A request to use the broker authorizes its visible login window when needed. Agents first try discovery and reuse a running instance; they launch once only when initial discovery says the control plane is not running.

To expose the skill locally, create a symlink only when the destination does not already exist:

```bash
skill_destination="${CODEX_HOME:-$HOME/.codex}/skills/agent-broker"
mkdir -p "$(dirname "$skill_destination")"
ln -sT "$PWD/skills/agent-broker" "$skill_destination"
```

Keep an existing link to this checkout. Resolve another installed skill at that name manually.

The maintained workflows govern review of writes. Expense submission requires separate explicit approval; UM GPT tool approvals remain human-operated. Rejected, interrupted, conflicting, or uncertain mutations must not be resent automatically.

## Diagnosis

```bash
agent-broker inspect summary
agent-broker inspect auth
agent-broker inspect auth --capability arc.remaining_hours.read
agent-broker inspect query --selector 'app-remaining-hours'
agent-broker inspect console --limit 50
agent-broker inspect network --limit 50
```

Inspection uses the local socket and DevTools attached to the visible operator browser. It is an operator diagnostic interface, not an agent capability. No TCP debugging port is opened.

The event log is `logs/agent-broker.jsonl` under the runtime home. Expense rehearsal artifacts are under `logs/expense-captures/`; they contain sanitized mapped values and attachment metadata, not receipt bytes or authentication material.

## Development and verification

```bash
npm run check
npm run smoke:linux
```

The Linux smoke runner uses a private Xvfb display and D-Bus session. It needs `xvfb-run`, `xauth`, and `dbus-run-session` in addition to the runtime's Linux libraries and standard process tools. On Debian/Ubuntu these are supplied by `xvfb`, `xauth`, and `dbus-x11`.

The fixture smoke creates isolated configuration and local HTTP/WebSocket servers, exercises discovery, authentication, reads, bounded writes, duplicate protection, and invalid-result handling, then tears down its processes and runtime home. It leaves a screenshot at `/tmp/agent-broker-smoke.png` by default; `AGENT_BROKER_SMOKE_SCREENSHOT` selects another path.

On the Thelio, automated Electron checks must instead run through the installed native-Xvfb skill's private harness as required by [AGENTS.md](AGENTS.md). `AGENT_BROKER_SMOKE_HEADFUL=1` is accepted only with that harness's reserved display and authority. These requirements are checked before an Electron process is launched. Other Linux users can use the self-contained `smoke:linux` command above without that private skill.

`npm run preview` serves a static browser preview on loopback. It uses synthetic data and does not authenticate or execute capabilities.

## Release scope

The initial distribution is a Linux source release. [The refactor plan](docs/refactor-plan.md) records implementation and verification status. The `files` allowlist in [package.json](package.json) identifies distributable source, examples, tests, workflows, and selected assets; private runtime data and `output/` experiments are excluded.

This prototype assumes cooperative local callers. Filesystem permissions and service tokens do not isolate a hostile process running as the same Unix user. Deferred ideas remain in [IDEAS.md](IDEAS.md).

## License

[MIT](LICENSE).
