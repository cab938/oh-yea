import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function changed() {
  return failure("CAPABILITY_BROKEN", "UM GPT returned an unexpected response shape");
}

function model(value) {
  if (!positiveId(value?.id) || typeof value.title !== "string" ||
      typeof value.is_agentic !== "boolean") throw changed();
  return {
    id: value.id,
    title: value.title,
    agentic: value.is_agentic,
    backend_type: value.backend_type ?? null,
    supports_upload: value.supports_upload === true,
    supports_phi: value.supports_phi === true,
  };
}

function connector(value) {
  if (!positiveId(value?.id) || typeof value.display_name !== "string" ||
      typeof value.is_active !== "boolean" ||
      (value.description != null && typeof value.description !== "string") ||
      (value.tool_count != null && (!Number.isSafeInteger(value.tool_count) || value.tool_count < 0))) throw changed();
  return {
    id: value.id,
    display_name: value.display_name,
    description: value.description ?? null,
    is_active: value.is_active,
    tool_count: value.tool_count ?? null,
  };
}

function conversation(value) {
  if (!positiveId(value?.id) || typeof value.title !== "string") throw changed();
  return {
    id: value.id,
    title: value.title,
    model_id: value.extras?.service ?? null,
    agentic: value.extras?.is_agentic === true,
    created_at: value.created ?? null,
    updated_at: value.meta?.last_message_created_at ?? null,
    message_count: value.meta?.message_count ?? null,
  };
}

export function normalizeUmGptMessage(value) {
  if (!value || !positiveId(value.conversation_id) ||
      !["user", "ai", "tool", "interrupt"].includes(value.message_type) ||
      (value.content != null && typeof value.content !== "string")) throw changed();
  return {
    id: value.id ?? null,
    conversation_id: value.conversation_id,
    role: value.message_type === "ai" ? "assistant" : value.message_type,
    content: value.content ?? null,
    created_at: value.created_at ?? null,
    has_attachments: Array.isArray(value.attachments) && value.attachments.length > 0,
    tool_name: value.tool_name ?? null,
    action_id: value.action_id ?? null,
    interrupt_id: value.interrupt_id ?? null,
    approval_pending: value.message_type === "interrupt" && value.response === null,
  };
}

function client(fetch, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const get = async (route) => {
    let response;
    try {
      response = await fetch(new URL(route, origin).href, {
        method: "GET", credentials: "include", redirect: "manual", cache: "no-store",
        signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" },
      });
    } catch {
      throw failure("UPSTREAM_UNREACHABLE", "The UM GPT read request could not complete");
    }
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
      throw failure("AUTHENTICATION_REQUIRED", "UM GPT requires an authenticated application session");
    }
    if (!response.ok) throw failure("UPSTREAM_RESPONSE_ERROR", `UM GPT returned HTTP ${response.status}`);
    if (!response.headers.get("content-type")?.includes("application/json")) throw changed();
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_JSON_BYTES) throw failure("UPSTREAM_RESPONSE_TOO_LARGE", "UM GPT response exceeded 5 MiB");
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw changed(); }
  };
  const account = async () => {
    const identity = await get("/umgpt/api/me");
    if (!positiveId(identity?.id)) throw changed();
    // Identity data stays in this broker process; only the ID selects the user's fixed routes.
    return identity.id;
  };
  const list = async (userId) => {
    const items = await get(`/umgpt/api/users/${userId}/conversations/`);
    if (!Array.isArray(items)) throw changed();
    return items.map(conversation);
  };
  const owned = async (userId, id) => {
    if (!positiveId(id)) throw failure("INVALID_INPUT", "conversation_id must be a positive integer");
    const found = (await list(userId)).find((item) => item.id === id);
    if (!found) throw failure("RESOURCE_NOT_AVAILABLE", "The conversation is not in the authenticated user's conversation list");
    return found;
  };
  const models = async () => {
    const items = await get("/umgpt/api/services");
    if (!Array.isArray(items)) throw changed();
    return items.map(model).filter((item) => item.backend_type !== "image");
  };
  const connectors = async (userId) => {
    const items = await get(`/umgpt/api/users/${userId}/connectors/`);
    if (!Array.isArray(items)) throw changed();
    return items.map(connector);
  };
  return { get, account, list, owned, models, connectors };
}

export async function readUmGpt({ fetch, definition, input = {} }) {
  const api = client(fetch, definition.url);
  const userId = await api.account();
  const operation = definition.extraction.operation;
  if (operation === "models") return { models: await api.models() };
  if (operation === "connectors") return { connectors: await api.connectors(userId) };
  if (operation === "list") return { conversations: await api.list(userId) };
  if (operation !== "read") throw failure("INVALID_INPUT", "Unknown UM GPT read operation");
  const selected = await api.owned(userId, input.conversation_id);
  const raw = await api.get(`/umgpt/api/users/${userId}/conversations/${selected.id}/messages/`);
  if (!Array.isArray(raw)) throw changed();
  const messages = raw.map(normalizeUmGptMessage);
  if (messages.some((message) => message.conversation_id !== selected.id)) throw changed();
  return { conversation: selected, messages };
}

export async function setUmGptConnectorActive({ fetch, getCsrfToken, definition, input = {} }) {
  if (!positiveId(input.connector_id) || typeof input.is_active !== "boolean") {
    throw failure("INVALID_INPUT", "A positive connector_id and Boolean is_active are required");
  }
  const pageUrl = definition.action.pageUrl;
  const api = client(fetch, pageUrl);
  const userId = await api.account();
  const selected = (await api.connectors(userId)).find((item) => item.id === input.connector_id);
  if (!selected) throw failure("RESOURCE_NOT_AVAILABLE", "The connector is not installed for the authenticated account");
  if (selected.is_active === input.is_active) return { connector: selected, changed: false };

  let csrfToken;
  try { csrfToken = await getCsrfToken(pageUrl); }
  catch { /* Fail before writing if the broker cannot obtain its session's CSRF value. */ }
  if (typeof csrfToken !== "string" || !/^[A-Za-z0-9]+$/u.test(csrfToken)) {
    throw failure("AUTHENTICATION_REQUIRED", "Open UM GPT in the broker Browser pane to establish its CSRF session");
  }
  const unknown = () => failure("UMGPT_CONNECTOR_OUTCOME_UNKNOWN",
    "The connector state may have changed. List account connectors before another action; do not retry automatically");
  let response;
  try {
    response = await fetch(new URL(`/umgpt/api/users/${userId}/connectors/${selected.id}/`, pageUrl).href, {
      method: "PATCH", credentials: "include", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: "application/json", "content-type": "application/json",
        "X-CSRFToken": csrfToken, Origin: new URL(pageUrl).origin, Referer: pageUrl,
      },
      body: JSON.stringify({ is_active: input.is_active }),
    });
  } catch { throw unknown(); }
  // The write response may contain private configuration. Discard it and read the safe projection.
  try { await response.body?.cancel(); } catch { /* Only the status and fresh readback are used. */ }
  if (response.status >= 400 && response.status < 500 && response.status !== 408) {
    throw failure("UMGPT_CONNECTOR_REJECTED", `UM GPT rejected the connector change (HTTP ${response.status}); inspect account connectors before another action`);
  }
  if (!response.ok) throw unknown();
  try {
    const confirmed = (await api.connectors(userId)).find((item) => item.id === selected.id);
    if (!confirmed || confirmed.is_active !== input.is_active) throw unknown();
    return { connector: confirmed, changed: true };
  } catch { throw unknown(); }
}

export async function sendUmGpt({ fetch, send, definition, input, journalDirectory }) {
  if (typeof input.request_id !== "string" || !REQUEST_ID.test(input.request_id) || typeof input.prompt !== "string" ||
      !input.prompt.trim() || input.prompt.length > 100_000 || !positiveId(input.model_id) ||
      (input.conversation_id !== undefined && !positiveId(input.conversation_id))) {
    throw failure("INVALID_INPUT", "A request_id, prompt, model_id, and optional positive conversation_id are required");
  }
  const pageUrl = definition.action.pageUrl;
  const digest = crypto.createHash("sha256").update(JSON.stringify([
    pageUrl, input.prompt, input.model_id, input.conversation_id ?? null,
  ])).digest("hex");
  await fs.mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(journalDirectory, 0o700);
  const journalPath = path.join(journalDirectory, `${input.request_id}.json`);
  const duplicate = async () => {
    let previous;
    try { previous = JSON.parse(await fs.readFile(journalPath, "utf8")); }
    catch { throw failure("UMGPT_OUTCOME_UNKNOWN", "The existing UM GPT request record cannot be read; inspect the conversation"); }
    throw failure(previous.digest === digest ? "REQUEST_ALREADY_ATTEMPTED" : "REQUEST_ID_CONFLICT",
      "This request ID has already been used. Read the conversation to inspect its outcome; do not resend automatically");
  };
  try { await fs.stat(journalPath); return await duplicate(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const api = client(fetch, pageUrl);
  const userId = await api.account();
  const selectedModel = (await api.models()).find((item) => item.id === input.model_id);
  if (!selectedModel || selectedModel.backend_type === "image") {
    throw failure("RESOURCE_NOT_AVAILABLE", "Select an available text model from the UM GPT model catalog");
  }
  if (input.conversation_id !== undefined) {
    const selected = await api.owned(userId, input.conversation_id);
    if (selected.model_id !== input.model_id) {
      throw failure("INVALID_INPUT", "model_id must match the selected conversation's model");
    }
  }
  let handle;
  try { handle = await fs.open(journalPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") return duplicate();
    throw failure("JOURNAL_UNAVAILABLE", "The UM GPT request record could not be created");
  }
  const record = {
    requestId: input.request_id, digest, state: "started", createdAt: new Date().toISOString(),
    conversationId: input.conversation_id ?? null, modelId: input.model_id,
  };
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
  finally { await handle.close(); }

  let outcome;
  try {
    outcome = await send({
      pageUrl,
      message: {
        question: input.prompt, service: input.model_id,
        conversation_id: input.conversation_id ?? -1,
        ...(input.conversation_id === undefined ? { temp_conversation_id: -1 } : {}),
        attachment_group_ids: [], attachment_ids: [],
      },
      timeoutMs: 120_000,
    });
    if (!["complete", "approval_required"].includes(outcome?.status) ||
        !positiveId(outcome.conversationId)) throw changed();
    const message = normalizeUmGptMessage(outcome.message);
    if (message.conversation_id !== outcome.conversationId ||
        (input.conversation_id !== undefined && outcome.conversationId !== input.conversation_id) ||
        (outcome.status === "complete" && message.role !== "assistant") ||
        (outcome.status === "approval_required" && !message.approval_pending)) throw changed();
    record.state = outcome.status;
    record.conversationId = outcome.conversationId;
    record.messageId = message.id;
    // The journal contains identifiers and a comparison digest, never prompts or replies.
    await fs.writeFile(journalPath, JSON.stringify(record), { mode: 0o600 });
    return {
      request_id: input.request_id, status: outcome.status,
      conversation_id: outcome.conversationId,
      conversation_url: new URL(`/conversations/${outcome.conversationId}`, pageUrl).href,
      model_id: input.model_id, message,
    };
  } catch (error) {
    record.state = "outcome_unknown";
    record.conversationId = outcome?.conversationId ?? error.conversationId ?? record.conversationId;
    await fs.writeFile(journalPath, JSON.stringify(record), { mode: 0o600 }).catch(() => {});
    throw failure("UMGPT_OUTCOME_UNKNOWN", "The prompt may have been accepted. Inspect UM GPT before taking another action; do not resend automatically");
  }
}

// This finite adapter runs in the hidden browser's authenticated page, never in the caller.
export function runUmGptSocket({ origin, message, timeoutMs }) {
  return new Promise((resolve) => {
    if (window.location.origin !== origin) {
      resolve({ error: "AUTHENTICATION_REQUIRED" });
      return;
    }
    const url = new URL("/ws/umgpt/conversations/messages/", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    let finished = false;
    let conversationId = message.conversation_id > 0 ? message.conversation_id : null;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket) {
        socket.onopen = null; socket.onclose = null; socket.onerror = null; socket.onmessage = null;
        try { socket.close(); } catch { /* The result is already settled. */ }
      }
      resolve({ ...result, conversationId });
    };
    const timer = setTimeout(() => finish({ error: "UMGPT_OUTCOME_UNKNOWN" }), timeoutMs);
    try { socket = new WebSocket(url.href); }
    catch { finish({ error: "UPSTREAM_UNREACHABLE" }); return; }
    socket.onopen = () => {
      if (finished) return;
      try { socket.send(JSON.stringify(message)); }
      catch { finish({ error: "UMGPT_OUTCOME_UNKNOWN" }); }
    };
    socket.onerror = () => finish({ error: "UMGPT_OUTCOME_UNKNOWN" });
    socket.onclose = () => finish({ error: "UMGPT_OUTCOME_UNKNOWN" });
    socket.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data.length > 5 * 1024 * 1024) {
        finish({ error: "UMGPT_OUTCOME_UNKNOWN" }); return;
      }
      let value;
      try { value = JSON.parse(event.data); }
      catch { finish({ error: "UMGPT_OUTCOME_UNKNOWN" }); return; }
      if (value.type === "conversation.created") {
        if (!Number.isSafeInteger(value.conversation_id) || value.conversation_id <= 0 ||
            (conversationId !== null && conversationId !== value.conversation_id)) {
          finish({ error: "UMGPT_OUTCOME_UNKNOWN" }); return;
        }
        conversationId = value.conversation_id;
      } else if (value.type === "conversation.message" || value.type === "conversation.tool_interrupt") {
        const incoming = value.message;
        if (!Number.isSafeInteger(incoming?.conversation_id) || incoming.conversation_id <= 0 ||
            (conversationId !== null && incoming.conversation_id !== conversationId)) {
          finish({ error: "UMGPT_OUTCOME_UNKNOWN" }); return;
        }
        conversationId = incoming.conversation_id;
        if (value.type === "conversation.tool_interrupt") {
          finish({ status: "approval_required", message: incoming });
        } else if (incoming.message_type === "ai") {
          finish({ status: "complete", message: incoming });
        }
      } else if (value.type === "conversation.error") {
        finish({ error: "UMGPT_OUTCOME_UNKNOWN" });
      }
    };
  });
}
