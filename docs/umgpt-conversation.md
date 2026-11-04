# UM GPT: operator setup

The [service workflow](../services/umgpt/workflow.md) owns agent model/connector selection, account-wide connector changes, and human tool approvals. Deployed schemas come from `agent-broker services`; do not substitute a remembered model ID or template contract.

## Configure

Use the [setup and authoring guide](../skills/agent-broker/references/add-service.md) with the [authentication example](../services/umgpt/authentication.example.yaml) and selected [disabled templates](../services/umgpt/templates/). The service ID is `umgpt`; create its token with `npm run add-service-token -- umgpt`.

Set the inspected service origin consistently in the selected capabilities and their `umgpt_session` profile. The profile probes the fixed same-origin `/umgpt/api/me`; `login_url` is the application's human sign-in entry. Authentication uses the broker's shared browser session, not caller-supplied credentials.

The finite operations cover models, installed connectors, conversation listing/readback, one text prompt, and one connector's active flag. Inputs never select an origin, user ID, endpoint, headers, attachments, or approval decision. Conversations must belong to the signed-in user's fresh inventory, and continuations retain the existing model.

## Reads and connector settings

The adapter derives the account internally, uses fixed service routes, and releases a finite projection. Identity responses, connector credentials, endpoint settings, cookies, and CSRF values remain broker-only. A missing connector tool count is unknown, not zero. A tool name in conversation history is evidence of a call, not its completion status or raw result.

`umgpt_connector_state` validates an installed connector against fresh inventory. An already-satisfied state is a read-only no-op. Otherwise it sends one same-origin PATCH containing only `is_active`, then confirms the requested state with a new inventory read. The setting affects the whole account; it does not select individual tools or install a connector.

On `UMGPT_CONNECTOR_REJECTED` or `UMGPT_CONNECTOR_OUTCOME_UNKNOWN`, stop changing settings and inspect connector discovery. Do not retry or roll back automatically, or send a dependent task with an unverified active set.

## Prompt sends

The hidden worker sends one text prompt using the application's fixed WebSocket route while the visible browser stays in place. Omit `conversation_id` for a new conversation; provide an owned ID only when continuing one. Sending does not activate connectors or approve tools.

A new prompt requires a fresh `request_id`. Its private journal is under `submissions/umgpt/`, reserved before dispatch. Records contain identifiers, comparison digests, timestamps, and outcome state, never prompts, replies, or credentials.

On `REQUEST_ALREADY_ATTEMPTED`, `REQUEST_ID_CONFLICT`, or `UMGPT_OUTCOME_UNKNOWN`, inspect the conversation rather than resend or replace the ID. On `approval_required`, give the human the conversation link to review the tool actions in UM GPT. A later read may inspect the outcome; the broker never approves, resumes, or resends automatically.

This adapter follows a private application interface. Recheck inspected routes and live behavior when the service changes; fixture validation alone does not establish current external-account access.
