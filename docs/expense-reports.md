# Expense reports: operator setup

The [service workflow](../services/expense-reports/workflow.md) owns agent preparation, review, and separate submission approval. The live contract returned by `agent-broker services` owns the current input and output schemas.

## Configure

Use the [setup and authoring guide](../skills/agent-broker/references/add-service.md) to install selected [disabled templates](../services/expense-reports/templates/) and the [authentication example](../services/expense-reports/authentication.example.yaml). The service ID is `expense-reports`; create its token with `npm run add-service-token -- expense-reports`.

Inspect the actual form before replacing placeholder routing. The private definitions must fix the form URL, exact same-origin POST action, confirmation prefix, form ID, anti-forgery field names, semantic control/choice mappings, file input, and attachment limits. Keep the capture and submit definitions' input contracts and form mappings aligned.

The implemented workflow covers the authenticated operator's own employee expenses. It excludes student academic-pursuit reimbursement and submissions on another person's behalf. Callers provide semantic values and absolute attachment paths, never form field names, encoded choices, endpoints, or authentication values.

## Rehearse before a real write

`teamdynamix_expense_report_capture` loads and verifies the form, maps the input, and freezes attachments in broker memory, then stops before POST or submission journaling. It does not consume the submission ID.

A capture returns a sanitized reference and attachment status. Its mode-0600 artifact is stored under the runtime home's `logs/expense-captures/`. It contains mapped values and attachment metadata, with no receipt bytes, local paths, credentials, cookies, or anti-forgery values. A capture is not a submitted report.

Keep submit disabled while configuring. Validate the configured authentication probe and one requested capture. Enable submission only when live setup requires it; the first real report still needs the workflow's separate approval. Do not create an expense solely to test the integration.

## Submission and outcomes

`teamdynamix_expense_report` verifies the fresh form's action, multipart encoding, identity fields, configured controls, choices, and file input. It submits one multipart POST using frozen attachment bytes and fresh anti-forgery values. Form drift fails closed before the write.

Success requires a ticket reference from the fixed confirmation location or returned detail page, including a marked-up `Service Request ID` label. A returned expense form is a definite rejection. An unrecognized post-submit result is outcome-unknown.

Private mode-0600 records under `submissions/teamdynamix-expense/` prevent duplicate writes. A completed submission ID replays its recorded result without another POST. Conflicting, rejected, interrupted, or uncertain attempts must not retry automatically. Never remove journals or replace an ID to force a second attempt.

On `FORM_CHANGED`, inspect the form and repair the private mapping. On a rejected or uncertain submission, have the human inspect TeamDynamix My Requests before any separately reviewed attempt. Do not infer failure from a lost connection.
