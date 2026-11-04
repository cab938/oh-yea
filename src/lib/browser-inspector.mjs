const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;
const MAX_BUFFERED_EVENTS = 500;
const MAX_QUERY_OUTPUT = 100_000;

function inspectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function safeBrowserUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return `file://${url.pathname}`;
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

export function redactDiagnosticText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(
      /https?:\/\/[^\s"'<>]+/g,
      (url) => safeBrowserUrl(url) || "[redacted-url]",
    )
    .replace(/(bearer\s+)[^\s"',;]+/gi, "$1[redacted]")
    .replace(
      /((?:code|token|assertion|samlresponse|relaystate)=)[^&\s"',;]+/gi,
      "$1[redacted]",
    )
    .replace(/[A-Za-z0-9_-]{80,}/g, "[redacted-long-value]");
}

function eventLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_EVENT_LIMIT;
  return Math.max(1, Math.min(MAX_EVENT_LIMIT, parsed));
}

function pushBounded(events, entry) {
  events.push(entry);
  if (events.length > MAX_BUFFERED_EVENTS) events.shift();
}

function consoleArgument(argument) {
  if (Object.hasOwn(argument, "value")) {
    if (typeof argument.value === "string") {
      return redactDiagnosticText(argument.value).slice(0, 2_000);
    }
    if (["number", "boolean"].includes(typeof argument.value)) {
      return argument.value;
    }
  }
  return redactDiagnosticText(argument.description ?? `[${argument.type}]`).slice(
    0,
    2_000,
  );
}

export class BrowserInspector {
  constructor({ authProbe } = {}) {
    this.authProbe = authProbe;
    this.guest = null;
    this.ready = Promise.resolve();
    this.attachError = null;
    this.consoleEvents = [];
    this.networkEvents = [];
    this.messageListener = null;
  }

  attach(guest) {
    if (
      this.guest &&
      !this.guest.isDestroyed() &&
      this.messageListener &&
      this.guest.debugger.isAttached()
    ) {
      this.guest.debugger.off("message", this.messageListener);
      this.guest.debugger.detach();
    }
    this.guest = guest;
    this.attachError = null;
    this.consoleEvents = [];
    this.networkEvents = [];
    this.messageListener = (_event, method, params) => {
      this.#recordEvent(method, params);
    };
    this.ready = this.#attachDebugger(guest);
    guest.once("destroyed", () => {
      if (this.guest === guest) {
        this.guest = null;
        this.attachError = null;
      }
    });
    return this.ready;
  }

  async #attachDebugger(guest) {
    try {
      if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
      guest.debugger.on("message", this.messageListener);
      await Promise.allSettled([
        guest.debugger.sendCommand("Runtime.enable"),
        guest.debugger.sendCommand("Log.enable"),
        guest.debugger.sendCommand("Network.enable"),
        guest.debugger.sendCommand("Page.enable"),
      ]);
    } catch (error) {
      this.attachError = error;
    }
  }

  #recordEvent(method, params) {
    const timestamp = new Date().toISOString();
    if (method === "Runtime.consoleAPICalled") {
      pushBounded(this.consoleEvents, {
        timestamp,
        kind: "console",
        level: params.type,
        text: params.args.map(consoleArgument).join(" ").slice(0, 4_000),
      });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      pushBounded(this.consoleEvents, {
        timestamp,
        kind: "exception",
        level: "error",
        text: redactDiagnosticText(
          params.exceptionDetails?.exception?.description ??
            params.exceptionDetails?.text ??
            "Uncaught exception",
        ).slice(0, 4_000),
      });
      return;
    }
    if (method === "Log.entryAdded") {
      pushBounded(this.consoleEvents, {
        timestamp,
        kind: "log",
        level: params.entry?.level ?? "info",
        source: params.entry?.source,
        text: redactDiagnosticText(params.entry?.text ?? "").slice(0, 4_000),
        url: safeBrowserUrl(params.entry?.url),
      });
      return;
    }
    if (method === "Network.requestWillBeSent") {
      pushBounded(this.networkEvents, {
        timestamp,
        kind: "request",
        requestId: params.requestId,
        method: params.request?.method,
        resourceType: params.type,
        url: safeBrowserUrl(params.request?.url),
      });
      return;
    }
    if (method === "Network.responseReceived") {
      pushBounded(this.networkEvents, {
        timestamp,
        kind: "response",
        requestId: params.requestId,
        resourceType: params.type,
        status: params.response?.status,
        mimeType: params.response?.mimeType,
        url: safeBrowserUrl(params.response?.url),
      });
      return;
    }
    if (method === "Network.loadingFailed") {
      pushBounded(this.networkEvents, {
        timestamp,
        kind: "failure",
        requestId: params.requestId,
        resourceType: params.type,
        errorText: params.errorText,
        canceled: params.canceled,
      });
    }
  }

  async #sendCommand(method, params = {}) {
    await this.ready;
    if (!this.guest || this.guest.isDestroyed()) {
      throw inspectionError(
        "BROWSER_UNAVAILABLE",
        "The authentication browser is not attached",
      );
    }
    if (this.attachError || !this.guest.debugger.isAttached()) {
      throw inspectionError(
        "INSPECTOR_UNAVAILABLE",
        this.attachError?.message ?? "The browser debugger is not attached",
      );
    }
    return this.guest.debugger.sendCommand(method, params);
  }

  async #evaluate(expression) {
    const response = await this.#sendCommand("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw inspectionError(
        "INSPECTION_FAILED",
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "Browser evaluation failed",
      );
    }
    return response.result?.value;
  }

  async #summary() {
    const result = await this.#evaluate(`(() => {
      const angularRoot = document.querySelector("[ng-version]");
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyText: (document.body?.innerText ?? "").slice(0, 5000),
        htmlLength: document.documentElement?.outerHTML?.length ?? 0,
        bodyChildCount: document.body?.children?.length ?? 0,
        iframeCount: document.querySelectorAll("iframe").length,
        scriptSources: Array.from(document.scripts)
          .map(script => script.src)
          .filter(Boolean)
          .slice(0, 50),
        angularVersion: angularRoot?.getAttribute("ng-version") ?? null,
        hasRemainingHours: Boolean(document.querySelector("app-remaining-hours"))
      };
    })()`);
    return {
      ...result,
      url: safeBrowserUrl(result?.url),
      bodyText: redactDiagnosticText(result?.bodyText ?? ""),
      scriptSources: (result?.scriptSources ?? []).map(safeBrowserUrl),
    };
  }

  async #query(selector) {
    if (typeof selector !== "string" || !selector.trim()) {
      throw inspectionError(
        "INVALID_INSPECTION",
        "The query command requires --selector CSS",
      );
    }
    if (selector.length > 512) {
      throw inspectionError(
        "INVALID_INSPECTION",
        "The CSS selector exceeds 512 characters",
      );
    }
    const result = await this.#evaluate(`(() => {
      const selector = ${JSON.stringify(selector)};
      let node;
      try {
        node = document.querySelector(selector);
      } catch (error) {
        return { selector, found: false, selectorError: error.message };
      }
      if (!node) return { selector, found: false };
      const outerHTML = node.outerHTML ?? "";
      const textContent = node.textContent ?? "";
      return {
        selector,
        found: true,
        tagName: node.tagName?.toLowerCase() ?? null,
        attributes: node.attributes
          ? Object.fromEntries(Array.from(node.attributes, item => [item.name, item.value]))
          : {},
        outerHTML: outerHTML.slice(0, ${MAX_QUERY_OUTPUT}),
        outerHTMLLength: outerHTML.length,
        textContent: textContent.slice(0, ${MAX_QUERY_OUTPUT})
      };
    })()`);
    return {
      ...result,
      outerHTML: redactDiagnosticText(result?.outerHTML ?? ""),
      textContent: redactDiagnosticText(result?.textContent ?? ""),
      truncated: (result?.outerHTMLLength ?? 0) > MAX_QUERY_OUTPUT,
    };
  }

  async inspect(request) {
    const command = request?.command ?? "summary";
    if (command === "auth") {
      if (!this.authProbe) {
        throw inspectionError(
          "INSPECTION_UNAVAILABLE",
          "The authentication probe is not available",
        );
      }
      return this.authProbe(request.capability);
    }
    if (command === "summary") return this.#summary();
    if (command === "query") return this.#query(request.selector);
    if (command === "console") {
      return this.consoleEvents.slice(-eventLimit(request.limit));
    }
    if (command === "network") {
      return this.networkEvents.slice(-eventLimit(request.limit));
    }
    if (command === "clear") {
      this.consoleEvents = [];
      this.networkEvents = [];
      return { cleared: true };
    }
    throw inspectionError(
      "INVALID_INSPECTION",
      `Unknown inspection command: ${command}`,
    );
  }
}
