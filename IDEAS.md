# IDEAS.md

This file is the backlog for work deliberately excluded from the first
`agent-broker` prototype. Items here are possibilities, not commitments. They
should not be pulled into the current work without an explicit decision.

## Current boundary

The current version is for one operator and cooperative local callers. It adds
one private YAML file per capability, JSON-only contract discovery, live file
reload, operator creation and editing, and fail-closed JSON Schema validation
to the original authenticated extraction proof of concept.

V2 uses:

- One agent-facing token per configured capability.
- One visible browser for authentication and operator-directed CSS extraction.
- CSS-selector and authenticated-JSON extraction adapters.
- Exact same-origin GET response observation in a hidden, session-sharing
  browser worker, with finite MCommunity normalizers.
- Raw DOM subtree return modes plus RFC 6901 JSON Pointer projections.
- Passive awareness logging without per-request approval, persisted as redacted
  user-only JSON Lines under the ignored runtime logs directory.
- Read-only extraction behavior plus one fixed TeamDynamix expense-report
  submission action.
- Input and output JSON Schema contracts enforced by the broker.
- `agent-broker capabilities` for redacted machine-readable discovery.
- Fixed TeamDynamix web-form submission through the shared SSO session.
- Non-posting TeamDynamix expense rehearsal capture with redacted inspection
  artifacts.
- One-shot expense journaling and duplicate-submission refusal.

Adversarial processes running as the same Unix user are explicitly not in the
v1 threat model.

## Security and process isolation

- Revisit same-user process isolation if clients become untrusted. Options
  include a separate broker UID, stronger client sandboxes, process-bound
  channels, or another OS boundary that prevents clients from reading broker
  configuration and browser state.
- Move tokens out of plaintext YAML into an OS keyring or broker-owned secret
  store.
- Store only token hashes and issue high-entropy credentials.
- Add explicit client identities separate from capabilities.
- Add revocation, rotation, expiry, maximum-use counts, and short-lived
  connection tickets.
- Use Unix peer credentials as an additional audit signal.

## Grants, roles, and policy

Named callers and human-approved access requests are the next candidate work
package after the file-backed capability system has been exercised. Keep them
out of the current implementation until that decision is made.

- Separate client identity, grants, capability definitions, and browser
  sessions.
- Allow one client to receive a reviewed set of capability grants.
- Consider roles or reusable scopes only after real usage shows that individual
  capability grants are too cumbersome.
- Add time-limited, call-limited, or purpose-limited grants.
- Allow a client to discover only the capabilities granted to it.

## Extraction durability

- Add richer typed projections only when the current JSON Schema contracts and
  narrow JSON Pointer or raw-subtree results prove insufficient.
- Add alternative adapter types only in response to real targets:
  - XPath
  - Shadow DOM traversal
  - Download and parse
  - Carefully reviewed, immutable JavaScript as a last-resort escape hatch
- Version extraction definitions and retain sanitized fixtures for regression
  tests.
- Detect selector drift and fail closed when no match or an unexpected number
  of matches is found.
- Add operator-facing authoring and preview tools if maintaining selectors by
  hand becomes burdensome.

## Authentication and browser execution

- The hidden worker now handles exact structured responses while sharing the
  visible browser's persistent session. Revisit further separation only if a
  real target needs a different partition or stronger process isolation.
- Reconsider U-M API Directory client credentials as an alternative
  TeamDynamix backend only after the service owner confirms the target
  application, workflow equivalence, service-account audit trail, and
  least-privilege role.
- Consider separate browser-session partitions for different providers or
  accounts.
- Keep a migration path for providers that reject embedded browsers, such as a
  system-browser handoff, browser extension, or dedicated external profile.
- Add explicit authentication and readiness detectors instead of inferring
  authentication solely from redirects or a missing selector.

## Human supervision

- Add per-capability modes such as log only, notify, approve once, always
  approve, and preview result before release.
- Record the requesting client, capability, stated purpose, result size,
  freshness, and outcome without storing secrets or sensitive response bodies.
- Add an operator queue for paused requests.
- Decide retention and export policies for awareness logs.

## Mutating capabilities and side effects

- Keep the implemented expense-report write as the sole bounded action until a
  different concrete need is approved.
- Require stronger confirmation for form submission, button clicks, uploads, or
  other state changes when cooperative agent instructions prove insufficient.
- Extend dry-run or preview stages beyond the implemented expense rehearsal only
  when another concrete action needs one.
- Generalize the expense submission journal only after another real write needs
  duplicate-submission protection.
- Distinguish navigation or authentication side effects from the requested
  business action.
- Consider capability-level declarations such as `read_only`, `reversible`, and
  `destructive` once mutating operations are introduced.

## Reliability and operations

- Add configurable deadlines, cancellation, output-size limits, rate limits,
  and bounded queues.
- Add approved redirect-origin lists for each capability.
- Add optional caching with freshness metadata.
- Add protocol negotiation and compatibility versions.
- Consider a background broker service or tray process so closing the control
  window does not necessarily terminate active requests.
- Add packaged-app signing, release automation, and upgrade behavior.
