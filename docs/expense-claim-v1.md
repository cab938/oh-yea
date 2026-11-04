# Expense report capability

Status: the form-backed rehearsal and submission actions are implemented. The
live rehearsal capability validates and captures the mapped request without a
POST; each real submission requires separate explicit operator approval.

## Agent workflow

The canonical preparation, review, and single-submission procedure is
[the expense-report service workflow](../services/expense-reports/workflow.md).
Discover it and the current public contracts with `agent-broker services`.
This document covers the adapter's operator setup and implementation.

The disabled [capture and submission templates](../services/expense-reports/templates/) are the maintained examples. Copy selected files using the [non-overwriting setup procedure](../README.md#bundled-templates), replace every example route and form mapping with inspected values, and keep the two private input contracts and mappings aligned.

Capabilities use `service: expense-reports`; its one token is
`AGENT_BROKER_TOKEN_EXPENSE_REPORTS` in the private `.env` beside the broker
configuration. Per-capability token lists are no longer supported.

There is no general TeamDynamix, browser-form, HTTP, or attachment capability.
Callers cannot choose a URL, form action, form ID, anti-forgery value, HTML field
name, or encoded choice.

## Agent-facing contract

The two capabilities' `input_schema` values are the only template interface. The
current personal v1 supports employee expenses submitted by the authenticated
operator and deliberately excludes student academic-pursuit reimbursements and
submitting on behalf of another person.

The schema covers:

- one operator-selected submission ID and one or more absolute attachment paths;
- eForm or completed-template submission;
- travel, hosting, and other expense categories;
- university card, CTA airfare, out-of-pocket, and cash-advance payment types;
- shortcodes and department references;
- travel dates, mileage/per-diem, locations, and provided-meal details;
- hosting attendees and alcohol handling;
- over-60-day handling and delay reason;
- the operator's own expense attestation; and
- optional additional comments.

Each attachment may specify a plain filename override. The initial configuration
permits PDF, JPEG, and PNG and enforces the form's 50 MiB combined limit.

A successful result has this shape:

```json
{
  "submission_id": "expense-2026-07-26-01",
  "status": "complete",
  "ticket_reference": "TDX-123456",
  "attachments": {
    "requested": 2,
    "uploaded": 2,
    "failed": 0,
    "items": [
      { "name": "hotel.pdf", "status": "uploaded" },
      { "name": "taxi.jpg", "status": "uploaded" }
    ]
  }
}
```

A successful rehearsal returns:

```json
{
  "submission_id": "expense-2026-07-26-01",
  "status": "captured",
  "capture_reference": "CAPTURE-6f37a680-ec40-4a9b-9784-3587932286ec",
  "attachments": {
    "requested": 2,
    "captured": 2,
    "items": [
      {
        "name": "hotel.pdf",
        "status": "captured",
        "media_type": "application/pdf",
        "bytes": 48231
      },
      {
        "name": "taxi.jpg",
        "status": "captured",
        "media_type": "image/jpeg",
        "bytes": 183204
      }
    ]
  }
}
```

The form accepts the ticket and attachments in the same request, so v1 has no
API-style partial-upload state. A rejected or uncertain POST returns a
structured error and is never retried automatically.

## Broker behavior

The action types are `teamdynamix_expense_report_capture` and
`teamdynamix_expense_report`. A capability defines exactly one `extraction` or
`action`.

The capture path performs steps 1–6 below, writes a mode-0600 redacted artifact
under `logs/expense-captures/`, validates its sanitized result, and stops. It
does not create a submission journal, send a POST, or consume the submission
ID. The artifact contains mapped field values and attachment metadata, but not
attachment bytes, local paths, credentials, cookies, or anti-forgery values.

For an authorized expense submission, the broker:

1. validates input against the advertised JSON Schema;
2. rejects semantic fields absent from its private mapping;
3. reads every attachment into broker memory before any external write;
4. loads the fixed form in the hidden worker that shares the visible browser's
   SSO partition;
5. verifies the exact POST action, multipart encoding, form ID, both
   anti-forgery fields, configured controls and choices, and receipt file input;
6. converts semantic choices and ISO dates into the inspected form encoding;
7. starts a mode-0600 submission journal immediately before the write;
8. sends one same-origin multipart POST with the fresh anti-forgery values and
   frozen files;
9. accepts only a configured same-origin confirmation location containing a
   ticket ID; and
10. validates the sanitized result against the output schema.

Form drift returns `FORM_CHANGED` before a submission record is created. A
network failure after the POST starts returns `SUBMISSION_OUTCOME_UNKNOWN` and
requires the operator to inspect My Requests. A completed submission ID replays
its result without another POST. Conflicting, rejected, interrupted, and
uncertain attempts are not automatically retried.

The journal may use a private content digest to detect submission-ID conflicts,
but agents and operators do not need to compute, display, compare, or approve
hashes.

## Authentication

The action uses the same session-sharing Electron browser partition as the visible
operator browser. Authentication remains human-operated. A private runtime
profile points both its probe and login surface at the fixed expense page:

```yaml
authentications:
  teamdynamix_sso:
    url: https://teamdynamix.example.invalid/expense/request
    login_url: https://teamdynamix.example.invalid/expense/request
```

If the session has expired, the broker opens that configured page in the
visible Browser pane and waits for the operator to finish U-M authentication.
The agent never receives or fills credentials, cookies, passwords, or 2FA.

## Live enablement gate

Before the first real expense:

1. keep the live capability and authentication profile in ignored mode-0600
   YAML;
2. confirm a live authentication probe succeeds;
3. invoke the capture capability and inspect its returned summary and local
   capture reference; and
4. keep the live submit capability disabled until the operator is ready for the
   first authorized write; then submit one prepared real expense only after the
   operator reviews its summary and explicitly authorizes it.

No production expense report should be created solely as an automated test.
