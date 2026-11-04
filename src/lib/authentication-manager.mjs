import { resolveJsonPointer } from "./json-pointer.mjs";

export const AUTHENTICATION_POLL_INITIAL_MS = 2_000;
export const AUTHENTICATION_POLL_MAX_MS = 30_000;
const PROBE_TIMEOUT_MS = 15_000;

export function authenticationPollDelay(
  attempt,
  {
    initialMs = AUTHENTICATION_POLL_INITIAL_MS,
    maxMs = AUTHENTICATION_POLL_MAX_MS,
  } = {},
) {
  return Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt));
}

function statusUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function authenticationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function redirectWasCancelled(error) {
  return error?.message?.trim().toLowerCase() === "redirect was cancelled";
}

function externalRedirect(response, sourceUrl) {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  const source = new URL(sourceUrl);
  const target = new URL(location, source);
  return target.origin === source.origin ? null : target;
}

async function buildIdentityMaterial(
  response,
  authentication,
  requestHeaderMappings,
) {
  const mappings = requestHeaderMappings;
  const requestHeaders = {};
  const expectedExpiry = authentication?.expectedExpiry;
  const needsPayload =
    expectedExpiry?.jsonPointer !== undefined ||
    Object.values(mappings ?? {}).some(
      (source) => source.jsonPointer !== undefined,
    );
  let payload;

  if (needsPayload) {
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
  }

  for (const [header, source] of Object.entries(mappings ?? {})) {
    let value;
    if (source.responseHeader) {
      value = response.headers.get(source.responseHeader);
    } else if (source.jsonPointer !== undefined) {
      try {
        value = resolveJsonPointer(payload, source.jsonPointer);
      } catch {
        value = undefined;
      }
    } else {
      value = source.value;
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      return { requestHeaders: null, expectedExpiresAt: null };
    }
    requestHeaders[header] = `${source.prefix ?? ""}${String(value)}`;
  }

  let expectedExpiresAt = null;
  if (
    expectedExpiry?.format === "unix_seconds" &&
    expectedExpiry.jsonPointer !== undefined
  ) {
    try {
      const seconds = resolveJsonPointer(payload, expectedExpiry.jsonPointer);
      const milliseconds = Number(seconds) * 1_000;
      if (Number.isFinite(milliseconds) && milliseconds > 0) {
        expectedExpiresAt = new Date(milliseconds).toISOString();
      }
    } catch {
      // Expiry is advisory and must not make otherwise valid authentication fail.
    }
  }

  return { requestHeaders, expectedExpiresAt };
}

export class AuthenticationManager {
  constructor({
    authSession,
    onStatus,
    onAuthenticationRequired,
    onSilentAuthentication,
  } = {}) {
    this.authSession = authSession;
    this.onStatus = onStatus;
    this.onAuthenticationRequired = onAuthenticationRequired;
    this.onSilentAuthentication = onSilentAuthentication;
    this.statuses = new Map();
    this.stableStatuses = new Map();
    this.inFlightChecks = new Map();
    this.silentBootstraps = new Map();
    this.interactiveWaits = new Map();
    this.requestHeaderMappingIds = new WeakMap();
    this.nextRequestHeaderMappingId = 1;
  }

  #identity(authentication) {
    return {
      authentication: authentication.name,
      displayName: authentication.displayName ?? authentication.name,
    };
  }

  publicStatuses() {
    return [...this.statuses.values()];
  }

  #publish(status) {
    const previous = this.statuses.get(status.authentication);
    const previousStable = this.stableStatuses.get(status.authentication);
    this.statuses.set(status.authentication, status);
    if (status.state !== "checking") {
      this.stableStatuses.set(status.authentication, status);
    }
    this.onStatus?.(status, previous, previousStable);
    return status;
  }

  recordBrowserResult(
    authentication,
    { authenticated, reason = "browser-response", message } = {},
  ) {
    const state =
      authenticated === true
        ? "authenticated"
        : authenticated === false
          ? "unauthenticated"
          : "unknown";
    const status = this.#publish({
      ...this.#identity(authentication),
      state,
      reason,
      checkedAt: new Date().toISOString(),
      target: statusUrl(authentication.url),
      ...(message ? { message } : {}),
    });
    return {
      ...status,
      authenticated:
        state === "authenticated"
          ? true
          : state === "unauthenticated"
            ? false
            : null,
      requestHeaders: {},
    };
  }

  #checkKey(authentication, requestHeaderMappings) {
    let mappingId = "none";
    if (
      requestHeaderMappings &&
      typeof requestHeaderMappings === "object"
    ) {
      mappingId = this.requestHeaderMappingIds.get(requestHeaderMappings);
      if (!mappingId) {
        mappingId = this.nextRequestHeaderMappingId;
        this.nextRequestHeaderMappingId += 1;
        this.requestHeaderMappingIds.set(requestHeaderMappings, mappingId);
      }
    }
    return `${authentication.name}\n${authentication.url}\n${mappingId}`;
  }

  async #coalesce(tasks, key, run) {
    const existing = tasks.get(key);
    if (existing) return existing;
    const task = Promise.resolve().then(run);
    tasks.set(key, task);
    try { return await task; }
    finally { if (tasks.get(key) === task) tasks.delete(key); }
  }

  check(authentication, options = {}) {
    return this.#coalesce(this.inFlightChecks,
      this.#checkKey(authentication, options.requestHeaders),
      () => this.#runCheck(authentication, options));
  }

  checkBrowser(authentication, { probe, probeKey, reason = "manual" }) {
    const key = `browser\n${authentication.name}\n${probeKey}`;
    return this.#coalesce(this.inFlightChecks, key, async () => {
      try {
        await probe();
        return this.recordBrowserResult(authentication, { authenticated: true, reason });
      } catch (error) {
        const required = error.code === "AUTHENTICATION_REQUIRED";
        return this.recordBrowserResult(authentication, {
          authenticated: required ? false : null,
          reason: required ? "browser-authentication-required"
            : error.code === "CONTROL_PLANE_UNAVAILABLE" ? "worker-unavailable" : "browser-probe-failed",
          message: required ? undefined : error.message,
        });
      }
    });
  }

  async trySilentAuthentication(authentication, {
    timeoutMs, check, pollInitialMs = AUTHENTICATION_POLL_INITIAL_MS, ...context
  }) {
    if (!this.onSilentAuthentication || !authentication.loginUrl) return null;
    const deadline = Date.now() + timeoutMs;
    try {
      await this.#coalesce(this.silentBootstraps, authentication.name, () =>
        this.onSilentAuthentication({
          ...this.#identity(authentication), ...context, url: authentication.loginUrl,
        }));
    } catch {
      // Silent setup is opportunistic; human authentication remains the fallback.
      return null;
    }
    await wait(Math.min(pollInitialMs, Math.max(0, deadline - Date.now())));
    return Date.now() < deadline ? check() : null;
  }

  async waitFor(authentication, {
    timeoutMs, check, requireIdentity = false,
    pollInitialMs = AUTHENTICATION_POLL_INITIAL_MS,
    pollMaxMs = AUTHENTICATION_POLL_MAX_MS,
    timeoutMessage = "Extraction timed out while waiting for authentication",
  }) {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      const delay = authenticationPollDelay(attempt++, { initialMs: pollInitialMs, maxMs: pollMaxMs });
      await wait(Math.min(delay, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      const result = await check();
      if (result.authenticated && (!requireIdentity || result.identityMaterialAvailable)) return result;
    }
    throw authenticationError("EXTRACTION_TIMEOUT", timeoutMessage);
  }

  watch(authentication, options) {
    return this.#coalesce(this.interactiveWaits, authentication.name, () =>
      this.waitFor(authentication, options).catch((error) => {
        if (error.code !== "EXTRACTION_TIMEOUT") throw error;
        return null;
      }));
  }

  async #runCheck(
    authentication,
    {
      reason = "manual",
      announceChecking = true,
      requestHeaders: requestHeaderMappings,
    } = {},
  ) {
    const probeUrl = authentication.url;
    if (announceChecking) {
      this.#publish({
        ...this.#identity(authentication),
        state: "checking",
        reason,
        checkedAt: new Date().toISOString(),
      });
    }

    let response;
    try {
      response = await this.authSession.fetch(probeUrl, {
        method: "GET",
        credentials: "include",
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { accept: "application/json, text/html;q=0.9, */*;q=0.8" },
      });
    } catch (error) {
      const redirectCancelled = redirectWasCancelled(error);
      const status = this.#publish({
        ...this.#identity(authentication),
        state: redirectCancelled ? "unauthenticated" : "unknown",
        reason: redirectCancelled ? "redirect-cancelled" : "probe-failed",
        checkedAt: new Date().toISOString(),
        message: error.message,
      });
      return {
        ...status,
        authenticated: redirectCancelled ? false : null,
        requestHeaders: {},
      };
    }

    const redirect = externalRedirect(response, probeUrl);
    if (redirect || [401, 403].includes(response.status)) {
      const status = this.#publish({
        ...this.#identity(authentication),
        state: "unauthenticated",
        reason: redirect ? "external-authentication-redirect" : "protected-response",
        checkedAt: new Date().toISOString(),
        status: response.status,
        target: statusUrl(probeUrl),
        ...(redirect ? { redirectTo: statusUrl(redirect.href) } : {}),
      });
      return { ...status, authenticated: false, requestHeaders: {} };
    }

    const identity = response.ok
      ? await buildIdentityMaterial(
          response,
          authentication,
          requestHeaderMappings,
        )
      : { requestHeaders: null, expectedExpiresAt: null };
    const { requestHeaders, expectedExpiresAt } = identity;
    if (!response.ok) {
      const status = this.#publish({
        ...this.#identity(authentication),
        state: "unauthenticated",
        reason: "probe-response-error",
        checkedAt: new Date().toISOString(),
        status: response.status,
        target: statusUrl(probeUrl),
      });
      return { ...status, authenticated: false, requestHeaders: {} };
    }

    const status = this.#publish({
      ...this.#identity(authentication),
      state: "authenticated",
      reason: "probe-succeeded",
      checkedAt: new Date().toISOString(),
      status: response.status,
      target: statusUrl(probeUrl),
      ...(expectedExpiresAt ? { expectedExpiresAt } : {}),
    });
    return {
      ...status,
      authenticated: true,
      requestHeaders,
      identityMaterialAvailable: requestHeaders !== null,
    };
  }

  async ensure(
    authentication,
    {
      capability,
      requestHeaders: requestHeaderMappings,
      timeoutMs,
      pollInitialMs = AUTHENTICATION_POLL_INITIAL_MS,
      pollMaxMs = AUTHENTICATION_POLL_MAX_MS,
      requestId,
    } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    let result = await this.check(authentication, {
      reason: "request",
      requestHeaders: requestHeaderMappings,
    });
    if (result.authenticated && result.identityMaterialAvailable) return result;

    result = await this.trySilentAuthentication(authentication, {
      capability, requestId, timeoutMs: Math.max(0, deadline - Date.now()), pollInitialMs,
      check: () => this.check(authentication, {
        reason: "silent-session-bootstrap", announceChecking: false,
        requestHeaders: requestHeaderMappings,
      }),
    });
    if (result?.authenticated && result.identityMaterialAvailable) return result;

    const loginUrl = authentication.loginUrl;
    if (!loginUrl) {
      throw authenticationError(
        "AUTHENTICATION_REQUIRED",
        "The authentication profile is unavailable and has no configured login URL",
      );
    }
    this.onAuthenticationRequired?.({
      authentication: authentication.name,
      displayName: authentication.displayName ?? authentication.name,
      capability,
      requestId,
      url: loginUrl,
    });

    return this.waitFor(authentication, {
      timeoutMs: Math.max(0, deadline - Date.now()), pollInitialMs, pollMaxMs,
      requireIdentity: true,
      check: () => this.check(authentication, {
        reason: "authentication-wait", announceChecking: false,
        requestHeaders: requestHeaderMappings,
      }),
    });
  }
}
