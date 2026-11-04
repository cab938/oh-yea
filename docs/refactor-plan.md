# Repository simplification and Linux source release

Status: the local refactor is implemented, and the source release passes clean-install verification. Publication and fresh-installation acceptance with a real external account remain pending. MIT licensing has no personal attribution.

## Agreed release target

- Public source repository, Linux first.
- MIT license without personal attribution.
- Source-checkout installation using the existing Node/Electron application and CLI.
- Another Linux user can clone the repository, install dependencies, configure one service, authenticate, and successfully request a read-only capability.

The release repository is [cab938/oh-yea](https://github.com/cab938/oh-yea). It was empty when selected; publication uses the reviewed source snapshot rather than the old local history.

## Boundaries

[AGENTS.md](../AGENTS.md) and the maintained [service workflows](../services/) remain authoritative for behavior and trust boundaries. Preserve the existing capability names, input/output contracts, service authorization, human-operated authentication, browser-surface separation, and duplicate-write protection.

Keep one package and the existing finite dispatcher. Introduce additional structure only where it removes demonstrated duplication or separates installed resources from writable data.

## Work order

### 1. Preserve and curate the current baseline

- [x] Review the existing tracked diff and untracked source files before making implementation changes.
- [x] Separate intended source, examples, and selected assets from private files, generated contracts, logs, and image experiments.
- [x] Create a reviewed local checkpoint without discarding existing work or including private configuration.
- [x] Record the current verification baseline and distinguish it from checks of the forthcoming refactor.

Completion: the starting implementation is recoverable, and the files intended for eventual sharing are identified.

### 2. Consolidate writable state

Primary files: [paths.mjs](../src/lib/paths.mjs), [main.mjs](../src/main.mjs), [services.mjs](../src/lib/services.mjs), and the CLI.

- [x] Make normal installations use the single runtime-home layout already supported by isolated runs.
- [x] Put private configuration, service tokens, capability files, logs, submission journals, and generated service contracts under that home.
- [x] Keep shipped workflows, templates, code, and icons as installed resources.
- [x] Have Electron and the CLI resolve the same locations while preserving explicit environment overrides.
- [x] Provide an explicit, non-destructive import for the current installation. Preserve private file permissions and submission journals; do not overwrite live files or enable templates during import.

Completion: normal operation writes no runtime data into the source checkout, and existing configuration can be retained or imported deliberately.

### 3. Simplify configuration validation

Primary files: [config.mjs](../src/lib/config.mjs), [capability-store.mjs](../src/lib/capability-store.mjs), and configuration/template tests.

- [x] Validate a capability directly against the existing normalized authentication profiles.
- [x] Remove the conversion of normalized profiles back into configuration-shaped objects merely to validate a synthetic whole configuration.
- [x] Inventory field aliases before deciding which are unnecessary. Preserve current live configuration until any required rewrite is explicit.
- [x] Keep advertised schemas, authorization behavior, and failure handling equivalent.

Completion: parsing has a direct, inspectable path, and focused configuration/template checks establish that accepted definitions and rejected inputs retain their meaning.

### 4. Consolidate authentication coordination

Primary files: [authentication-manager.mjs](../src/lib/authentication-manager.mjs), [main.mjs](../src/main.mjs), and relevant browser helpers.

- [x] Give shared authentication waiting, deadlines, polling policy, and concurrent-check coalescing one owner, reusing the existing authentication manager.
- [x] Remove duplicated coordination from the main process where the manager can own it directly.
- [x] Keep service-specific probes and browser mechanics distinct where their behavior differs.
- [x] Preserve the existing silent-session handoff, visible human-login fallback, bounded retries, ephemeral default, and separation of visible and hidden browser work.

Completion: the same readiness and authentication behavior passes focused checks with fewer competing owners of request state.

### 5. Make setup and verification portable

Primary files: README, configuration defaults, service examples, test fixtures, smoke tooling, and the bundled agent skill.

- [x] Start a new installation with a usable empty configuration instead of an ARC-specific profile.
- [x] Replace personal allocation routing in fixtures with synthetic routing.
- [x] Document a short, explicit setup procedure using sanitized service examples. Selected templates remain disabled until configured and deliberately enabled.
- [x] Make smoke verification reproducible from repository files and documented Linux prerequisites, without requiring private files from this workstation.
- [x] Keep installation, operator instructions, service procedures, and agent routing in their existing canonical locations.
- [x] Update documentation and validate the agent skill when implementation changes its CLI, discovery, timeout, or error contract.

Completion: setup and verification can be followed from a clean checkout without access to the original operator's home directory.

### 6. Prepare and publish the source release

- [x] Inspect intended public files and Git history for private configuration, credentials, personal routing, and runtime artifacts.
- [x] Define the contents of the release explicitly, including selected artwork and excluding generated image experiments and runtime data.
- [x] Verify a clean extracted source tree using the documented dependency installation and fixture configuration.
- [x] Exercise a read-only capability with fixtures.
- [ ] Perform account-dependent acceptance on a fresh Linux installation when the required account is available; this has not been verified.
- [x] Choose the repository host and owner/name.
- [ ] Review the exact public contents, publish the repository, and tag the initial source release.

Completion: a public tagged source release exists, with a reproducible Linux installation path and an accurate statement of what was verified.

## Verification during implementation

For each code change, run the narrowest existing checks that exercise its behavior. Pay particular attention to path agreement between CLI and Electron, configuration validation, authentication handoff, redacted discovery, and prevention of duplicate writes.

Run the project-required `npm run check`. Run `npm run smoke` for renderer or extraction changes as required by project instructions. All interactive Electron verification on this workstation must use the prescribed private Xvfb harness, with screenshot inspection and teardown confirmation.

Do not substitute a passing fixture test for verified access to a real external account. Record verification when performed; unchecked work above remains incomplete.

## Implementation record

- Baseline source checkpoint: `.git/agent-broker-checkpoints/baseline-20261104T144138Z.tar.gz`, with private configuration and generated artifacts excluded.
- Baseline check: 117 tests passed before implementation. After implementation, `npm run check` passes 122 tests.
- Focused path, importer, configuration/template, browser, and authentication checks pass. The importer refuses overwrite and preserves existing journals.
- The Electron fixture smoke passed in both the working tree and a clean extracted source tree through the native private Xvfb harness. The 1480x900 screenshots were inspected, and each display :90, authority directory, and associated process was removed.
- The clean source tree installed with `npm ci --no-audit --no-fund`, passed all 122 checks, and passed `npm run smoke:linux` inside the prescribed private harness. This verifies fixture behavior on the current Linux host; another Linux distribution and a real external account have not been exercised.
- The existing installation was explicitly imported into the normal runtime home after verification. All 12 imported files match their originals byte-for-byte and have mode 0600 inside mode-0700 directories. The 12 source files and 13 existing journal files are unchanged. The running broker was left open; it uses the refactor after its next restart.
- Eleven private YAML files were inspected for field alias usage without printing their contents. No camelCase aliases were found. Accepted aliases remain supported to preserve the existing configuration contract; direct capability validation no longer reconstructs or revalidates authentication profiles.
- The existing agent router remains valid and uses discovery-provided paths; no new agent-facing invocation contract was introduced.
- Historical commits contain personal fixture routing. The reviewed source archive excludes Git history; the existing local history is preserved. Do not publish the old history as part of the clean source release.
- The release is `output/releases/agent-broker-0.2.0-source.tar.gz`, with an adjacent SHA-256 file manifest. Its explicit allowlist includes the lockfile and selected artwork, excludes private configuration, generated contracts, logs, dependencies, and image experiments, and was checked for configured service-token bytes.

### Linux smoke invocation

The verification command was run from each source tree with the native-Xvfb skill installed under the operator's Codex home:

```bash
env __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json \
  LIBGL_ALWAYS_SOFTWARE=1 \
  AGENT_BROKER_SMOKE_HEADFUL=1 \
  AGENT_BROKER_SMOKE_SCREENSHOT=/tmp/agent-broker-clean-source-smoke.png \
  "${CODEX_HOME:-$HOME/.codex}/skills/testing-native-xwindows-apps-on-thelio/scripts/run-headless-x11-app.sh" \
  --window-class agent-broker --screen 1600x1000 --settle 1 --interactive -- \
  npm run smoke:linux
```

The clean-source screenshot is `/tmp/agent-broker-clean-source-smoke.png`; its fixture run completed successfully. The harness provided an isolated display and D-Bus state, and teardown was verified after completion.

## Next release step

Publish the reviewed clean source snapshot to `cab938/oh-yea` and tag `v0.2.0`. Keep real-account acceptance explicitly pending until exercised. No installer distribution or npm publication has been introduced.
