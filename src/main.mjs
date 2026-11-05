import { app, BrowserWindow, ipcMain, session } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerServer } from "./lib/broker-server.mjs";
import { BrowserJsonExtractor } from "./lib/browser-json-extractor.mjs";
import { BrowserJsonWorker } from "./lib/browser-json-worker.mjs";
import { BrowserInspector } from "./lib/browser-inspector.mjs";
import { AuthenticationManager } from "./lib/authentication-manager.mjs";
import { executeCapability } from "./lib/capability-executor.mjs";
import {
  capabilityCatalog,
  DEFAULT_CAPABILITY,
  DEFAULT_CONFIG,
  parseConfig,
  publicConfig,
  validateCapabilityResult,
} from "./lib/config.mjs";
import {
  loadCapabilityDirectory,
  saveCapabilityFile,
  watchCapabilityDirectory,
} from "./lib/capability-store.mjs";
import { LogStore } from "./lib/log-store.mjs";
import { runtimePaths } from "./lib/paths.mjs";
import { readServiceTokens } from "./lib/caller-token.mjs";
import { publishServices } from "./lib/services.mjs";
import {
  restoreDevelopmentCookies,
  watchDevelopmentCookies,
} from "./lib/session-persistence.mjs";
import {
  PERSISTENT_AUTH_PARTITION,
  authenticationSessionPolicy,
  clearLegacyAuthenticationState,
} from "./lib/session-policy.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.join(root, "renderer");
const paths = runtimePaths();
const authPolicy = authenticationSessionPolicy();
const logs = new LogStore({
  filePath: path.join(paths.logs, "agent-broker.jsonl"),
});
logs.on("persistence-error", (error) => {
  process.stderr.write(`Could not persist broker log: ${error.message}\n`);
});
const browserInspector = new BrowserInspector({
  authProbe: (capability) => probeConfiguredAuthentication(capability),
});
const extractionTimeoutMs = 5 * 60 * 1000;
const authenticationRefreshMs = 5 * 60 * 1000;
const interactiveAuthenticationTimeoutMs = 5 * 60 * 1000;

let mainWindow;
let broker;
let configText;
let baseConfig;
let serviceTokens = {};
let config;
let capabilityFiles = [];
let capabilityWatcher;
const capabilityHealth = new Map();
let rendererReady = false;
let authSession;
let authenticationManager;
let authenticationRefreshTimer;
let sessionPersistence;
let browserJsonWorker;
let quitting = false;
let shutdown;
let shutdownComplete = false;

function capabilityState() {
  return {
    directory: paths.capabilities,
    template: DEFAULT_CAPABILITY,
    files: capabilityFiles.map((file) => ({
      ...file,
      runtime: capabilityHealth.get(file.name) ?? null,
    })),
  };
}

function publishCapabilityState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("capabilities:changed", capabilityState());
  }
}

function inspectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function authenticationForCapability(definition) {
  if (!definition?.authentication) return null;
  return config.authentications[definition.authentication] ?? null;
}

function referencedAuthentications() {
  const names = new Set(
    config.capabilities
      .filter((definition) => definition.enabled !== false)
      .map((definition) => definition.authentication)
      .filter(Boolean),
  );
  return [...names]
    .map((name) => config.authentications[name])
    .filter(Boolean);
}

function browserJsonCapabilityForAuthentication(authenticationName) {
  return config.capabilities.find(
    (definition) =>
      definition.enabled !== false &&
      definition.authentication === authenticationName &&
      definition.extraction?.type === "browser_json",
  );
}

async function checkConfiguredAuthentication(
  authentication,
  { reason = "manual" } = {},
) {
  const definition = browserJsonCapabilityForAuthentication(authentication.name);
  if (!definition) {
    return authenticationManager.check(authentication, { reason });
  }

  return authenticationManager.checkBrowser(authentication, {
    reason,
    probeKey: `${definition.name}\n${definition.url}\n${definition.extraction.responseUrl}`,
    probe: () => {
      if (!browserJsonWorker) {
        throw inspectionError("CONTROL_PLANE_UNAVAILABLE", "The hidden browser worker is unavailable");
      }
      return browserJsonWorker.capture({
        pageUrl: definition.url,
        responseUrl: definition.extraction.responseUrl,
        method: definition.extraction.responseMethod,
        timeoutMs: 12_000,
        authenticationExpected: true,
      });
    },
  });
}

async function probeConfiguredAuthentication(capabilityName) {
  const enabled = config.capabilities.filter(
    (definition) => definition.enabled !== false,
  );
  let definition;
  let authentication;
  if (capabilityName) {
    definition = enabled.find((candidate) => candidate.name === capabilityName);
    if (!definition) {
      throw inspectionError(
        "INVALID_INSPECTION",
        `No enabled capability is named ${capabilityName}`,
      );
    }
    authentication = authenticationForCapability(definition);
    if (!authentication) {
      throw inspectionError(
        "INVALID_INSPECTION",
        `Capability ${capabilityName} has no configured authentication`,
      );
    }
  } else {
    const referenced = referencedAuthentications();
    if (referenced.length === 1) {
      [authentication] = referenced;
    } else {
      throw inspectionError(
        "INVALID_INSPECTION",
        "Specify --capability when more than one authentication is active",
      );
    }
  }

  const {
    requestHeaders: _requestHeaders,
    identityMaterialAvailable: _identityMaterialAvailable,
    ...result
  } = await checkConfiguredAuthentication(authentication, {
    reason: "inspection",
  });
  return {
    ...result,
    ...(definition ? { capability: definition.name } : {}),
  };
}

function publishAuthenticationStatus(status, _previous, previousStable) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("authentication:status", status);
  }
  if (
    status.state !== "checking" &&
    previousStable?.state !== status.state
  ) {
    logs.add(
      status.state === "authenticated" ? "success" : "warn",
      "authentication.status",
      status.state === "authenticated"
        ? "Application session is available"
        : status.state === "unauthenticated"
          ? "Application session has not been established"
          : "Application session status could not be determined",
      { authentication: status.authentication },
    );
  }
}

function requestVisibleAuthentication(event) {
  const authentication = config?.authentications?.[event.authentication];
  const visibleEvent = {
    ...event,
    displayName:
      event.displayName ?? authentication?.displayName ?? event.authentication,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("authentication:required", visibleEvent);
  }
  const operatorInitiated = event.source === "operator";
  logs.add(
    "warn",
    operatorInitiated
      ? "authentication.sign-in-opened"
      : "authentication.required",
    operatorInitiated
      ? "Operator opened sign-in in the browser pane"
      : "Human authentication is required in the browser pane",
    {
      requestId: event.requestId,
      capability: event.capability,
      authentication: event.authentication,
      url: event.url,
    },
  );
}

async function bootstrapApplicationSession(event) {
  if (!browserJsonWorker) {
    throw inspectionError(
      "CONTROL_PLANE_UNAVAILABLE",
      "The hidden browser worker is unavailable",
    );
  }

  logs.add("info", "authentication.session-bootstrap",
    "Trying the shared browser session for an application", {
      requestId: event.requestId, capability: event.capability,
      authentication: event.authentication,
    });
  return browserJsonWorker.navigate({ pageUrl: event.url, timeoutMs: 20_000 });
}

async function startInteractiveAuthentication(authenticationName) {
  if (typeof authenticationName !== "string" || !authenticationName) {
    throw inspectionError(
      "INVALID_AUTHENTICATION",
      "A configured authentication profile is required",
    );
  }

  const authentication = referencedAuthentications().find(
    (candidate) => candidate.name === authenticationName,
  );
  if (!authentication) {
    throw inspectionError(
      "INVALID_AUTHENTICATION",
      `No enabled capability references authentication profile ${authenticationName}`,
    );
  }
  if (!authentication.loginUrl) {
    throw inspectionError(
      "AUTHENTICATION_REQUIRED",
      `Authentication profile ${authenticationName} has no configured login URL`,
    );
  }

  let result = await checkConfiguredAuthentication(authentication, {
    reason: "operator-session-check",
  });
  if (result.authenticated) {
    return { authentication: authentication.name, visible: false };
  }

  if (!browserJsonCapabilityForAuthentication(authentication.name)) {
    result = await authenticationManager.trySilentAuthentication(authentication, {
      source: "operator", timeoutMs: interactiveAuthenticationTimeoutMs,
      check: () => checkConfiguredAuthentication(authentication, { reason: "operator-session-bootstrap" }),
    });
    if (result?.authenticated) {
      return { authentication: authentication.name, visible: false };
    }
  }

  requestVisibleAuthentication({
    authentication: authentication.name,
    displayName: authentication.displayName,
    source: "operator",
    url: authentication.loginUrl,
  });
  void authenticationManager.watch(authentication, {
    timeoutMs: interactiveAuthenticationTimeoutMs,
    check: () => checkConfiguredAuthentication(authentication, { reason: "operator-sign-in" }),
  }).catch((error) => logs.add("warn", "authentication.wait-failed", error.message,
    { authentication: authentication.name }));
  return { authentication: authentication.name, visible: true };
}

async function refreshAuthenticationStatuses(reason = "interval") {
  await Promise.allSettled(
    referencedAuthentications().map((authentication) =>
      checkConfiguredAuthentication(authentication, { reason }),
    ),
  );
}

async function extractBrowserJson(job, authentication) {
  if (!browserJsonWorker) {
    const error = new Error("The hidden browser worker is unavailable");
    error.code = "CONTROL_PLANE_UNAVAILABLE";
    throw error;
  }

  const deadline = Date.now() + extractionTimeoutMs;
  let authenticationRequested = false;
  const capture = async (request) => {
    const attempt = async () => {
      try {
        const data = await browserJsonWorker.capture({
          ...request,
          timeoutMs: Math.min(12_000, Math.max(1, deadline - Date.now())),
        });
        if (authentication) authenticationManager.recordBrowserResult(authentication, {
          authenticated: true, reason: "capability-response",
        });
        return { authenticated: true, data };
      } catch (error) {
        if (error.code === "AUTHENTICATION_REQUIRED" && authentication) {
          authenticationManager.recordBrowserResult(authentication, {
            authenticated: false, reason: "browser-authentication-required",
          });
        }
        throw error;
      }
    };
    try { return (await attempt()).data; }
    catch (error) {
      if (error.code !== "AUTHENTICATION_REQUIRED" || !authentication?.loginUrl) throw error;
      if (!authenticationRequested) {
        authenticationRequested = true;
        requestVisibleAuthentication({
          authentication: authentication.name, capability: job.capability,
          requestId: job.id, source: "capability", url: authentication.loginUrl,
        });
      }
      const result = await authenticationManager.waitFor(authentication, {
        timeoutMs: Math.max(0, deadline - Date.now()),
        timeoutMessage: "Extraction timed out while waiting for browser authentication",
        check: async () => {
          try { return await attempt(); }
          catch (failure) {
            if (failure.code !== "AUTHENTICATION_REQUIRED") throw failure;
            return { authenticated: false };
          }
        },
      });
      return result.data;
    }
  };

  const extractor = new BrowserJsonExtractor({ capture });
  return extractor.extract({ definition: job.definition, input: job.input });
}

async function executeAuthorizedJob(job) {
  const data = await executeCapability(job, {
    configuredAuthentication: authenticationForCapability(job.definition),
    authenticationManager, authSession, browserJsonWorker,
    rendererExecutor: executor, extractBrowserJson, paths, logs,
    timeoutMs: extractionTimeoutMs,
  });

  const validation = validateCapabilityResult(job.definition, data);
  if (!validation.ok) {
    const message = "Capability result did not match its declared output schema";
    capabilityHealth.set(job.capability, {
      state: "broken",
      message,
      details: validation.errors,
    });
    publishCapabilityState();
    logs.add("error", "capability.broken", message, {
      requestId: job.id,
      capability: job.capability,
      validationErrors: validation.errors,
    });
    const error = new Error(message);
    error.code = "CAPABILITY_BROKEN";
    throw error;
  }

  if (capabilityHealth.has(job.capability)) {
    capabilityHealth.delete(job.capability);
    publishCapabilityState();
  }
  return data;
}

class RendererExecutor {
  constructor() {
    this.pending = new Map();
    this.queue = Promise.resolve();
  }

  execute(job) {
    const next = this.queue.then(
      () => this.#dispatch(job),
      () => this.#dispatch(job),
    );
    this.queue = next.catch(() => {});
    return next;
  }

  #dispatch(job) {
    return new Promise((resolve, reject) => {
      if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) {
        const error = new Error("The control-plane window is not ready");
        error.code = "CONTROL_PLANE_UNAVAILABLE";
        reject(error);
        return;
      }

      const safeDefinition = job.definition;
      const timeout = setTimeout(() => {
        this.pending.delete(job.id);
        const error = new Error(
          "Extraction timed out while waiting for authentication or target content",
        );
        error.code = "EXTRACTION_TIMEOUT";
        mainWindow?.webContents.send("broker:cancel", { id: job.id });
        reject(error);
      }, extractionTimeoutMs);

      this.pending.set(job.id, {
        resolve,
        reject,
        timeout,
        capability: job.capability,
      });
      mainWindow.webContents.send("broker:execute", {
        id: job.id,
        capability: job.capability,
        definition: safeDefinition,
        input: job.input,
      });
      logs.add("info", "extraction.dispatched", "Sent extraction to browser", {
        requestId: job.id,
        capability: job.capability,
      });
    });
  }

  settle(id, error, data) {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (error) {
      const failure = new Error(error.message ?? "Browser extraction failed");
      failure.code = error.code ?? "EXTRACTION_FAILED";
      pending.reject(failure);
    } else {
      pending.resolve(data);
    }
    return true;
  }

  rejectAll(message) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      const error = new Error(message);
      error.code = "CONTROL_PLANE_UNAVAILABLE";
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

const executor = new RendererExecutor();

async function loadConfiguration() {
  await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.directory, 0o700);
  await fs.mkdir(path.dirname(paths.config), {
    recursive: true,
    mode: 0o700,
  });

  try {
    configText = await fs.readFile(paths.config, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    configText = DEFAULT_CONFIG;
    await fs.writeFile(paths.config, configText, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }
  await fs.chmod(paths.config, 0o600);
  baseConfig = parseConfig(configText);
  serviceTokens = await readServiceTokens(paths.serviceTokens);
  await reloadCapabilityFiles("startup");
  logs.add("success", "config.loaded", "Configuration loaded", {
    capabilityCount: config.capabilities.length,
  });
}

async function reloadCapabilityFiles(reason = "filesystem") {
  const loaded = await loadCapabilityDirectory(
    paths.capabilities,
    baseConfig.authentications,
  );
  capabilityFiles = loaded.files;
  config = { ...baseConfig, serviceTokens, capabilities: loaded.capabilities };
  capabilityHealth.clear();
  const invalid = capabilityFiles.filter((file) => !file.valid);
  for (const file of invalid) {
    logs.add("error", "capability.invalid", file.error.message, {
      capability: file.name,
      file: file.fileName,
      details: file.error.details,
    });
  }
  if (reason !== "startup") {
    logs.add(
      invalid.length === 0 ? "success" : "warn",
      "capabilities.reloaded",
      "Capability files reloaded",
      {
        capabilityCount: loaded.capabilities.length,
        invalidCount: invalid.length,
        reason,
      },
    );
  }
  publishCapabilityState();
  return loaded;
}

async function saveConfiguration(text) {
  const next = parseConfig(text);
  await fs.writeFile(paths.config, text, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(paths.config, 0o600);
  configText = text;
  baseConfig = next;
  await reloadCapabilityFiles("authentication-configuration");
  logs.add("success", "config.saved", "Configuration validated and applied", {
    capabilityCount: config.capabilities.length,
  });
  return publicConfig(config);
}

async function saveCapability(request) {
  const saved = await saveCapabilityFile(
    paths.capabilities,
    baseConfig.authentications,
    request,
  );
  await reloadCapabilityFiles("operator-save");
  logs.add("success", "capability.saved", "Capability validated and saved", {
    capability: saved.definition.name,
    file: saved.fileName,
  });
  return { state: capabilityState(), fileName: saved.fileName };
}

function installIpc() {
  ipcMain.handle("state:get", () => ({
    configText,
    config: publicConfig(config),
    configPath: paths.config,
    capabilities: capabilityState(),
    socketPath: paths.socket,
    authenticationPersistence: authPolicy.developmentPersistence
      ? "development"
      : "ephemeral",
    authenticationStatuses:
      authenticationManager?.publicStatuses() ?? [],
  }));

  ipcMain.handle("config:save", async (_event, text) => {
    try {
      const safeConfig = await saveConfiguration(text);
      void refreshAuthenticationStatuses("configuration");
      return { ok: true, config: safeConfig };
    } catch (error) {
      logs.add("error", "config.rejected", error.message);
      return {
        ok: false,
        error: {
          code: error.code ?? "INVALID_CONFIG",
          message: error.message,
          details: error.details ?? [],
        },
      };
    }
  });

  ipcMain.handle("capability:save", async (_event, request) => {
    try {
      return { ok: true, ...(await saveCapability(request)) };
    } catch (error) {
      logs.add("error", "capability.rejected", error.message, {
        file: request?.fileName,
      });
      return {
        ok: false,
        error: {
          code: error.code ?? "INVALID_CAPABILITY",
          message: error.message,
          details: error.details ?? [],
        },
      };
    }
  });

  ipcMain.handle("authentication:sign-in", async (_event, authenticationName) => {
    try {
      return {
        ok: true,
        ...(await startInteractiveAuthentication(authenticationName)),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error.code ?? "AUTHENTICATION_REQUIRED",
          message: error.message,
        },
      };
    }
  });

  ipcMain.on("renderer:ready", () => {
    rendererReady = true;
    logs.add("success", "control.ready", "Control-plane window is ready");
    void refreshAuthenticationStatuses("startup");
    if (process.env.AGENT_BROKER_SMOKE_SCREENSHOT && mainWindow) {
      setTimeout(() => {
        void mainWindow.webContents
          .capturePage()
          .then((image) =>
            fs.writeFile(
              process.env.AGENT_BROKER_SMOKE_SCREENSHOT,
              image.toPNG(),
            ),
          )
          .catch((error) => {
            process.stderr.write(`Could not capture smoke screenshot: ${error.message}\n`);
          });
      }, 750);
    }
  });

  ipcMain.on("broker:result", (_event, result) => {
    if (!result || typeof result.id !== "string") return;
    executor.settle(result.id, result.error, result.data);
  });

  ipcMain.on("broker:auth-required", (_event, event) => {
    logs.add(
      "warn",
      "authentication.required",
      "Human authentication is required in the browser pane",
      {
        requestId: event?.id,
        capability: event?.capability,
        url: event?.url,
      },
    );
  });

  ipcMain.on("browser:event", (_event, event) => {
    const allowedEvents = new Set([
      "navigation",
      "load.failed",
      "extraction.waiting",
      "authentication.returned",
      "authentication.retry-skipped",
      "authentication.resumed",
      "target.bounced",
    ]);
    if (!allowedEvents.has(event?.event)) return;
    logs.add(
      event.event === "load.failed" ? "error" : "info",
      `browser.${event.event}`,
      event.message,
      {
        ...(event.id ? { requestId: event.id } : {}),
        ...(event.capability ? { capability: event.capability } : {}),
        ...(event.url ? { url: event.url } : {}),
      },
    );
  });
}

function secureWebviews(webContents) {
  webContents.on(
    "will-attach-webview",
    (event, webPreferences, params) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.partition = authPolicy.partition;

      let protocol;
      try {
        protocol = new URL(params.src).protocol;
      } catch {
        protocol = "";
      }
      if (!["https:", "http:", "file:"].includes(protocol)) {
        event.preventDefault();
      }
    },
  );

  webContents.on("did-attach-webview", (_event, guest) => {
    void browserInspector.attach(guest);
    guest.setWindowOpenHandler(({ url }) => {
      try {
        if (!["https:", "http:"].includes(new URL(url).protocol)) {
          return { action: "deny" };
        }
      } catch {
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            partition: authPolicy.partition,
          },
        },
      };
    });
  });
}

function createHiddenWorkerWindow() {
  const workerWindow = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: authPolicy.partition,
    },
  });
  workerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  workerWindow.webContents.on("will-navigate", (event, url) => {
    try {
      if (["https:", "http:"].includes(new URL(url).protocol)) return;
    } catch {
      // Invalid and non-web navigations are denied below.
    }
    event.preventDefault();
  });
  return workerWindow;
}

function createBrowserJsonWorker() {
  browserJsonWorker?.close();
  browserJsonWorker = new BrowserJsonWorker({
    createWindow: createHiddenWorkerWindow,
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "agent-broker",
    width: 1480,
    height: 900,
    minWidth: 1120,
    minHeight: 680,
    backgroundColor: "#0b1118",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  });

  secureWebviews(mainWindow.webContents);
  createBrowserJsonWorker();
  mainWindow.loadFile(path.join(rendererRoot, "index.html"));
  mainWindow.on("closed", () => {
    rendererReady = false;
    executor.rejectAll("The control-plane window was closed");
    browserJsonWorker?.close();
    browserJsonWorker = null;
    mainWindow = null;
    // Authentication popups and the hidden worker must not keep a headless
    // broker alive after the operator closes its control plane.
    if (!quitting) app.quit();
  });
}

function focusMainWindow() {
  if (quitting || !mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  // macOS may restore a minimized window without activating its application.
  if (process.platform === "darwin") app.focus({ steal: true });
  mainWindow.focus();
}

async function start() {
  app.setName("agent-broker");
  await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.directory, 0o700);
  app.setPath("userData", paths.directory);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on("second-instance", focusMainWindow);

  await app.whenReady();
  await loadConfiguration();
  capabilityWatcher = watchCapabilityDirectory(
    paths.capabilities,
    async () => {
      await reloadCapabilityFiles("filesystem");
      void refreshAuthenticationStatuses("capability-files");
    },
    (error) =>
      logs.add("error", "capabilities.watch-failed", error.message),
  );
  if (authPolicy.developmentPersistence) {
    authSession = session.fromPartition(authPolicy.partition);
    await restoreDevelopmentCookies(
      authSession,
      paths.developmentCookies,
    );
    logs.add(
      "warn",
      "session.development-persistence",
      "Development authentication persistence is enabled",
    );
    sessionPersistence = watchDevelopmentCookies(
      authSession,
      paths.developmentCookies,
      {
        onError: (error) =>
          logs.add(
            "error",
            "session.persist-failed",
            "Development browser session could not be persisted",
            { error: error.message },
          ),
      },
    );
  } else {
    const legacySession = session.fromPartition(
      PERSISTENT_AUTH_PARTITION,
    );
    await clearLegacyAuthenticationState(
      legacySession,
      paths.developmentCookies,
    );
    authSession = session.fromPartition(authPolicy.partition);
    logs.add(
      "info",
      "session.ephemeral",
      "Browser authentication started without persisted state",
    );
  }
  authenticationManager = new AuthenticationManager({
    authSession,
    onStatus: publishAuthenticationStatus,
    onAuthenticationRequired: requestVisibleAuthentication,
    onSilentAuthentication: bootstrapApplicationSession,
  });
  installIpc();

  authSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  createWindow();
  broker = new BrokerServer({
    socketPath: paths.socket,
    configProvider: () => config,
    capabilityCatalogProvider: () => capabilityCatalog(config),
    serviceCatalogProvider: () => publishServices({
      sourceDirectory: paths.serviceGuides, directory: paths.services, config,
    }),
    executor: executeAuthorizedJob,
    operatorExecutor: (request) => browserInspector.inspect(request),
    logger: logs,
  });
  await broker.start();
  authenticationRefreshTimer = setInterval(
    () => void refreshAuthenticationStatuses(),
    authenticationRefreshMs,
  );

  app.on("activate", focusMainWindow);
}

app.on("before-quit", () => {
  if (quitting) return;
  quitting = true;
  rendererReady = false;
  executor.rejectAll("The control plane is shutting down");
  browserJsonWorker?.close();
  browserJsonWorker = null;
  if (authenticationRefreshTimer) {
    clearInterval(authenticationRefreshTimer);
    authenticationRefreshTimer = null;
  }
  capabilityWatcher?.stop();
  capabilityWatcher = null;
});

app.on("window-all-closed", () => {
  if (!quitting) app.quit();
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.quit());

app.on("will-quit", (event) => {
  if (shutdownComplete) return;
  // A secondary instance has no resources to flush and should exit immediately.
  if (!shutdown && !broker?.server && !sessionPersistence) return;
  event.preventDefault();
  if (shutdown) return;
  const stopping = broker;
  broker = null;
  const persistence = sessionPersistence;
  sessionPersistence = null;
  persistence?.stop();
  shutdown = Promise.allSettled([
    stopping?.stop(),
    persistence?.flush(),
  ]).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

start().catch((error) => {
  process.stderr.write(`agent-broker failed to start: ${error.stack ?? error}\n`);
  app.exit(1);
});
