import { runUmGptSocket } from "./umgpt-conversation.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameUrl(left, right) {
  try {
    const first = new URL(left);
    const second = new URL(right);
    first.hash = "";
    second.hash = "";
    return first.href === second.href;
  } catch {
    return false;
  }
}

function responseText(body) {
  if (!body?.base64Encoded) return body?.body ?? "";
  return Buffer.from(body.body ?? "", "base64").toString("utf8");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function bounded(promise, milliseconds, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(workerError("CONTROL_PLANE_UNAVAILABLE", message)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

export class BrowserJsonWorker {
  constructor({ createWindow, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof createWindow !== "function") {
      throw new TypeError("BrowserJsonWorker requires a window factory");
    }
    this.createWindow = createWindow;
    this.timeoutMs = timeoutMs;
    this.window = null;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  capture(request) {
    const next = this.queue.then(
      () => this.#capture(request),
      () => this.#capture(request),
    );
    this.queue = next.catch(() => {});
    return next;
  }

  formSnapshot(request) {
    const next = this.queue.then(
      () => this.#formSnapshot(request),
      () => this.#formSnapshot(request),
    );
    this.queue = next.catch(() => {});
    return next;
  }

  navigate(request) {
    const next = this.queue.then(
      () => this.#navigate(request),
      () => this.#navigate(request),
    );
    this.queue = next.catch(() => {});
    return next;
  }

  umgptConversation(request) {
    const next = this.queue.then(
      () => this.#umgptConversation(request),
      () => this.#umgptConversation(request),
    );
    this.queue = next.catch(() => {});
    return next;
  }

  async #umgptConversation({ pageUrl, message, timeoutMs }) {
    const workerWindow = await this.#window();
    const contents = workerWindow.webContents;
    await bounded(contents.loadURL(pageUrl), 30_000, "UM GPT did not load in the hidden browser");
    const origin = new URL(pageUrl).origin;
    if (new URL(contents.getURL()).origin !== origin) {
      throw workerError("AUTHENTICATION_REQUIRED", "UM GPT redirected to authentication");
    }
    let result;
    try {
      result = await bounded(contents.executeJavaScript(
        `(${runUmGptSocket.toString()})(${JSON.stringify({ origin, message, timeoutMs })})`,
        true,
      ), timeoutMs + 5_000, "The UM GPT response outcome is unknown");
    } catch (error) {
      // A timed-out execution must not leave a socket or delayed send in the worker.
      if (!workerWindow.isDestroyed()) workerWindow.close();
      throw error;
    }
    if (result?.error) {
      const error = workerError(result.error, "UM GPT did not confirm a completed reply");
      error.conversationId = result.conversationId;
      throw error;
    }
    return result;
  }

  async #window() {
    if (this.closed) {
      throw workerError(
        "CONTROL_PLANE_UNAVAILABLE",
        "The hidden browser worker is closed",
      );
    }
    if (this.window && !this.window.isDestroyed()) return this.window;

    const workerWindow = this.createWindow();
    this.window = workerWindow;
    workerWindow.once("closed", () => {
      if (this.window === workerWindow) this.window = null;
    });

    try {
      await bounded(
        workerWindow.webContents.loadURL("about:blank"),
        5_000,
        "The hidden browser worker did not initialize",
      );
      const inspector = workerWindow.webContents.debugger;
      if (!inspector.isAttached()) inspector.attach("1.3");
      await bounded(
        inspector.sendCommand("Network.enable"),
        5_000,
        "The hidden browser network inspector did not initialize",
      );
      await bounded(
        inspector.sendCommand("Network.setCacheDisabled", {
          cacheDisabled: true,
        }),
        5_000,
        "The hidden browser cache policy did not initialize",
      );
      return workerWindow;
    } catch (error) {
      if (!workerWindow.isDestroyed()) workerWindow.close();
      if (this.window === workerWindow) this.window = null;
      throw error;
    }
  }

  async #navigate({ pageUrl, timeoutMs = this.timeoutMs }) {
    const workerWindow = await this.#window();
    const contents = workerWindow.webContents;
    await bounded(
      contents.loadURL(pageUrl),
      timeoutMs,
      "The hidden browser worker did not establish the application session",
    );
    return { finalUrl: contents.getURL() };
  }

  async #formSnapshot({
    pageUrl,
    timeoutMs = this.timeoutMs,
  }) {
    const workerWindow = await this.#window();
    const contents = workerWindow.webContents;
    try {
      await bounded(
        contents.loadURL(pageUrl),
        timeoutMs,
        "The hidden browser worker did not load the configured form",
      );
    } catch (error) {
      const finalUrl = contents.getURL();
      try {
        if (
          finalUrl &&
          new URL(finalUrl).origin !== new URL(pageUrl).origin
        ) {
          throw workerError(
            "AUTHENTICATION_REQUIRED",
            "The configured form redirected to authentication",
          );
        }
      } catch (urlError) {
        if (urlError.code === "AUTHENTICATION_REQUIRED") throw urlError;
      }
      throw error;
    }

    const finalUrl = contents.getURL();
    if (new URL(finalUrl).origin !== new URL(pageUrl).origin) {
      throw workerError(
        "AUTHENTICATION_REQUIRED",
        "The configured form redirected to authentication",
      );
    }

    return bounded(
      contents.executeJavaScript(
        `(() => {
          const form = document.querySelector("form.js-entry-form");
          if (!form) {
            return {
              found: false,
              pageUrl: window.location.href,
            };
          }

          const entries = [];
          const controls = [];
          for (const element of form.elements) {
            const name = element.name || "";
            const tagName = element.tagName.toLowerCase();
            const type = String(element.type || "").toLowerCase();
            const control = {
              tagName,
              type,
              name,
              id: element.id || "",
              disabled: Boolean(element.disabled),
              multiple: Boolean(element.multiple),
              value: typeof element.value === "string" ? element.value : "",
              checked: Boolean(element.checked),
              dataName: element.dataset?.name || "",
              dataValue: element.dataset?.value || "",
              options:
                tagName === "select"
                  ? Array.from(element.options).map((option) => ({
                      value: option.value,
                      label: option.textContent || "",
                      selected: option.selected,
                    }))
                  : [],
            };
            controls.push(control);

            if (!name || element.disabled) continue;
            if (["button", "submit", "reset", "file"].includes(type)) {
              continue;
            }
            if (
              ["checkbox", "radio"].includes(type) &&
              !element.checked
            ) {
              continue;
            }
            if (tagName === "select") {
              for (const option of element.selectedOptions) {
                entries.push([name, option.value]);
              }
              continue;
            }
            entries.push([name, String(element.value ?? "")]);
          }

          return {
            found: true,
            pageUrl: window.location.href,
            actionUrl: form.action,
            method: form.method.toUpperCase(),
            enctype: form.enctype,
            entries,
            controls,
          };
        })()`,
        true,
      ),
      timeoutMs,
      "The hidden browser worker could not inspect the configured form",
    );
  }

  async #capture({
    pageUrl,
    responseUrl,
    method = "GET",
    timeoutMs = this.timeoutMs,
    authenticationExpected = false,
  }) {
    const workerWindow = await this.#window();
    const contents = workerWindow.webContents;
    const inspector = contents.debugger;
    const matchingRequests = new Map();

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        inspector.off("message", onMessage);
        contents.off("destroyed", onDestroyed);
        if (error) reject(error);
        else resolve(value);
      };

      const onDestroyed = () =>
        finish(
          workerError(
            "CONTROL_PLANE_UNAVAILABLE",
            "The hidden browser worker was closed",
          ),
        );

      const consume = async (requestId, observed) => {
        if (settled || observed.consuming) return;
        observed.consuming = true;
        if ([401, 403].includes(observed.status)) {
          finish(
            workerError(
              "AUTHENTICATION_REQUIRED",
              "The authenticated browser request was rejected",
            ),
          );
          return;
        }
        if (
          typeof observed.status === "number" &&
          (observed.status < 200 || observed.status >= 300)
        ) {
          finish(
            workerError(
              "UPSTREAM_RESPONSE_ERROR",
              `The configured browser response returned HTTP ${observed.status}`,
            ),
          );
          return;
        }

        let body;
        let bodyError;
        for (let attempt = 0; attempt < 20 && !settled; attempt += 1) {
          try {
            body = await inspector.sendCommand("Network.getResponseBody", {
              requestId,
            });
            bodyError = null;
            break;
          } catch (error) {
            bodyError = error;
            await wait(50);
          }
        }
        if (!body) {
          finish(
            workerError(
              "INVALID_UPSTREAM_RESPONSE",
              `The configured browser response body was unavailable: ${bodyError?.message ?? "unknown error"}`,
            ),
          );
          return;
        }

        const text = responseText(body);
        if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
          finish(
            workerError(
              "UPSTREAM_RESPONSE_TOO_LARGE",
              "The configured browser response exceeded 5 MiB",
            ),
          );
          return;
        }
        try {
          finish(null, JSON.parse(text));
        } catch {
          finish(
            workerError(
              "INVALID_UPSTREAM_RESPONSE",
              "The configured browser response was not valid JSON",
            ),
          );
        }
      };

      const onMessage = (_event, eventMethod, params) => {
        if (eventMethod === "Network.requestWillBeSent") {
          const matched =
            params.request?.method === method &&
            sameUrl(params.request?.url, responseUrl);
          if (
            matched
          ) {
            matchingRequests.set(params.requestId, { status: null });
          }
          return;
        }

        const observed = matchingRequests.get(params.requestId);
        if (!observed) return;
        if (eventMethod === "Network.responseReceived") {
          observed.status = params.response?.status ?? null;
          void consume(params.requestId, observed);
          return;
        }
        if (eventMethod === "Network.loadingFailed") {
          finish(
            workerError(
              "UPSTREAM_UNREACHABLE",
              "The configured browser response failed to load",
            ),
          );
          return;
        }
        if (eventMethod === "Network.loadingFinished") {
          void consume(params.requestId, observed);
        }
      };

      inspector.on("message", onMessage);
      contents.once("destroyed", onDestroyed);
      timeout = setTimeout(() => {
        finish(
          workerError(
            authenticationExpected
              ? "AUTHENTICATION_REQUIRED"
              : "UPSTREAM_RESPONSE_MISSING",
            authenticationExpected
              ? "The authenticated page did not produce its configured JSON response"
              : "The page did not produce its configured JSON response",
          ),
        );
      }, timeoutMs);

      void contents.loadURL(pageUrl).catch((error) => {
        if (error.code === "ERR_ABORTED" || error.errno === -3) return;
        finish(
          workerError(
            "UPSTREAM_UNREACHABLE",
            `The hidden browser could not load the configured page: ${error.message}`,
          ),
        );
      });
    });
  }

  close() {
    this.closed = true;
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
  }
}
