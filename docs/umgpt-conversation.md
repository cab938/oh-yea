# UM GPT Conversation

The canonical agent procedure is [the UM GPT workflow](../services/umgpt/workflow.md), discovered with `agent-broker services`. This document covers operator setup and implementation.

UM GPT uses OpenID Connect through U-M Shibboleth. The operator signs in through the broker's Browser pane. The broker uses that application session for fixed JSON reads and a dedicated WebSocket prompt action. It does not export or copy browser credentials.

Add this application profile to the existing `authentications` mapping in the private runtime-home `config.yaml`, substituting the configured service origin:

```yaml
umgpt_session:
  display_name: UM GPT Conversation
  sign_in_group: U-M SSO
  url: https://umgpt.example.test/umgpt/api/me
  login_url: https://umgpt.example.test/
```

The six disabled capability templates are in [`services/umgpt/templates/`](../services/umgpt/templates/), one file per capability. Follow the [non-overwriting copy procedure](../README.md#bundled-templates) for the selected files. Set the same service origin in each selected capability and its profile, configure `AGENT_BROKER_TOKEN_UMGPT` in the private `.env`, and enable the selected capabilities. Keep their filenames and `service: umgpt` unchanged. Templates contain no live token.

| Capability | Input | Result |
| --- | --- | --- |
| `umich.umgpt.models.list` | `{}` | Available text models, including agentic status and service-declared upload/PHI flags |
| `umich.umgpt.connectors.list` | `{}` | Installed account connectors: ID, display name, description, active state, and tool count |
| `umich.umgpt.connector.set_active` | `connector_id`, Boolean `is_active` | Verified account connector and `changed` (false when already set) |
| `umich.umgpt.conversations.list` | `{}` | The authenticated user's conversation summaries |
| `umich.umgpt.conversation.read` | `conversation_id` | Conversation summary and messages, including pending tool approvals |
| `umich.umgpt.conversation.send` | `request_id`, `prompt`, `model_id`, optional `conversation_id` | A completed assistant message or `approval_required`, with the conversation ID and link |

The bundled YAML files are operator templates; the deployed schemas are authoritative and are exported to the service contract file by `agent-broker services`. Model IDs come from the live model catalog. Conversation IDs must belong to the authenticated user's current conversation list, and continuing a conversation requires its existing model ID. Omit `conversation_id` to start a new conversation. Caller inputs cannot specify an origin, user ID, endpoint, request headers, attachments, location, or tool-approval decision.

Read operations derive the user ID internally from `/umgpt/api/me`, then use the fixed `/umgpt/api/users/<id>/conversations/` and conversation-message routes. Model discovery uses `/umgpt/api/services`. These requests use the broker's session cookies and do not need the identity-derived headers used by ARC. Identity responses remain broker-only. Results project a finite set of conversation and message fields; file attachments are indicated but not downloaded.

Connector discovery uses a fixed GET to `/umgpt/api/users/<id>/connectors/` for the signed-in account. It returns both active and inactive installed connectors, projecting only `id`, `display_name`, `description`, `is_active`, and `tool_count`. Missing descriptions or tool counts become null; a null count means unknown. Active state is account-level, not a conversation-specific allowlist or proof of tool readiness. Connector credentials, endpoint configuration, and other upstream fields are excluded. This read does not install, activate, deactivate, or approve connectors.

Connector state changes use the dedicated `umgpt_connector_state` action. The adapter derives the account from `/umgpt/api/me`, checks the connector ID against that account's fresh inventory, and returns `changed: false` without writing when the desired state is already set. Otherwise it makes one PATCH to `/umgpt/api/users/<id>/connectors/<connector_id>/` with only `{ "is_active": boolean }`. The broker obtains the `csrftoken` cookie internally and sends the corresponding CSRF header with fixed same-origin Origin and Referer headers. Neither the cookie nor the raw write response is returned or logged. A fresh inventory read must confirm the requested state before returning `changed: true` and the projected connector. The account setting applies across conversations; it does not select individual tools or install connectors. Model-specific tool limits can still affect subsequent conversation use.

A definite HTTP rejection returns `UMGPT_CONNECTOR_REJECTED`. Network loss, server errors, redirects, or unconfirmed readback after the PATCH return `UMGPT_CONNECTOR_OUTCOME_UNKNOWN`. Neither condition triggers retries or rollback. Inspect the account through connector discovery before any further authorized change. The desired-state setter needs no prompt-style request journal: an already-satisfied request is a read-only no-op.

Sending uses `/ws/umgpt/conversations/messages/` in the serialized hidden browser worker. The visible operator page stays in place. The worker sends one text prompt with the selected service and empty attachment lists. It accepts the application's `conversation.created`, final assistant `conversation.message`, and `conversation.tool_interrupt` events. Connector use follows the selected agentic model and the user's existing UM GPT settings. Sending does not change connectors or consent settings and does not approve tool actions. On `approval_required`, the user reviews the pending actions in UM GPT; a later read can inspect the conversation. The broker does not automatically resume or resend the prompt.

Every attempted send reserves `request_id` in a mode-0600 journal under the runtime `submissions/umgpt/` directory before opening the WebSocket. Records contain only comparison digests, identifiers, timestamps, and outcome state, not prompts, replies, or credentials. Reusing an attempted ID returns `REQUEST_ALREADY_ATTEMPTED`; changing its content returns `REQUEST_ID_CONFLICT`. A disconnect, timeout, malformed event, or unconfirmed result returns `UMGPT_OUTCOME_UNKNOWN`. All three require inspection rather than an automatic resend or a new request ID. A fresh user-requested prompt gets a fresh ID.

Connector delegation and evidence-checking instructions are maintained in the service workflow linked above.

The initial protocol was identified from the authenticated application's observed requests and its deployed JavaScript on 2026-10-21. Live verification on that date passed model discovery, conversation listing, a new GPT-5.6 Sol (Agent) conversation, and conversation readback. The test requested official U-M M-Connectors documentation using the active Tavily connector. The persisted history contained a `tavily__tavily_search` tool message followed by an assistant answer with three source links. The visible operator browser stayed at its original URL. This is a private web-application interface and can change; recheck model availability, schemas, and live behavior when deploying against a changed service.
