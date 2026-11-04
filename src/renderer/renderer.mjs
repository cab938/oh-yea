import {
  AUTH_SETTLE_DELAY_MS,
  canRetrySettledAuthReturn,
  matchesConfiguredTarget,
  transitionForNavigation,
} from "./auth-flow.mjs";
import { shouldSyncAddress } from "./address-sync.mjs";
import {
  describeSignInGroup,
  listSignInGroups,
} from "./authentication-status.mjs";

const bridge = window.agentBroker;
const isElectron = Boolean(bridge);

const elements = {
  authenticationStates: document.querySelector("#authentication-states"),
  developmentAuthPersistence: document.querySelector(
    "#development-auth-persistence",
  ),
  browser: document.querySelector("#auth-browser"),
  browserFallback: document.querySelector("#browser-fallback"),
  browserStatus: document.querySelector("#browser-status"),
  browserStatusText: document.querySelector("#browser-status-text"),
  address: document.querySelector("#address-input"),
  back: document.querySelector("#back-button"),
  forward: document.querySelector("#forward-button"),
  reload: document.querySelector("#reload-button"),
  go: document.querySelector("#go-button"),
  capabilitiesTab: document.querySelector("#capabilities-tab"),
  authenticationTab: document.querySelector("#authentication-tab"),
  capabilitiesPanel: document.querySelector("#capabilities-panel"),
  authenticationPanel: document.querySelector("#authentication-panel"),
  capabilityList: document.querySelector("#capability-list"),
  capabilityEditor: document.querySelector("#capability-editor"),
  capabilityPath: document.querySelector("#capability-path"),
  capabilityMessage: document.querySelector("#capability-message"),
  capabilityState: document.querySelector("#capability-state"),
  newCapability: document.querySelector("#new-capability"),
  saveCapability: document.querySelector("#save-capability"),
  configEditor: document.querySelector("#config-editor"),
  configPath: document.querySelector("#config-path"),
  configMessage: document.querySelector("#config-message"),
  configState: document.querySelector("#config-state"),
  capabilityCount: document.querySelector("#capability-count"),
  saveConfig: document.querySelector("#save-config"),
  socketPath: document.querySelector("#socket-path"),
};

const previewConfig = `version: 1
authentications:
  arc_session:
    display_name: ARC
    sign_in_group: U-M SSO
    url: https://arc.example.test/redirect/baz?info=json
    login_url: https://arc.example.test/
    expected_expiry:
      json_pointer: /id_token/exp
      format: unix_seconds
`;

const previewCapability = `name: arc.remaining_hours.read
service: arc
description: ARC Great Lakes remaining partition hours
enabled: true
url: https://arc.example.test/allocations/example/remaining-hours
authentication: arc_session
extraction:
  type: authenticated_json
  request_headers:
    Authorization:
      response_header: x-umich-jwt
      prefix: "Bearer "
  pointer: /0/subaccounts/0/limits/spending/unitHours
contract:
  input_schema:
    type: object
  output_schema:
    type: object
    additionalProperties:
      type: number
`;

const authenticationStatuses = new Map();
let authenticationProfiles = {};
let activeJob = null;
let extractionTimer = null;
let authSettleTimer = null;
let extractionRunning = false;
let configDirty = false;
let capabilityDirty = false;
let capabilityFiles = [];
let selectedCapabilityFile = null;
let capabilityTemplate = "";
let signInPending = false;
let interactiveSignInAuthentication = null;

function setBrowserStatus(kind, message) {
  elements.browserStatus.className = `browser-status ${kind}`;
  elements.browserStatusText.textContent = message;
}

function renderAuthenticationStatus() {
  const groups = listSignInGroups(
    authenticationProfiles,
    capabilityFiles,
    [...authenticationStatuses.values()],
  );
  elements.authenticationStates.replaceChildren();
  for (const group of groups) {
    const description = describeSignInGroup(group);
    const canSignIn = Boolean(
      isElectron && description.signInAuthentication && !signInPending,
    );
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      `service-state ${description.state}${canSignIn ? " actionable" : ""}`;
    button.title = description.title;
    button.disabled = !canSignIn;
    button.dataset.authentication = description.signInAuthentication ?? "";
    button.setAttribute(
      "aria-label",
      canSignIn
        ? `${description.label}. Open sign-in page`
        : description.label,
    );
    const pulse = document.createElement("span");
    pulse.className = "pulse";
    const label = document.createElement("span");
    label.className = "service-state-label";
    label.textContent = description.label;
    button.append(pulse, label);
    elements.authenticationStates.append(button);
  }
}

function updateAuthenticationStatus(status) {
  if (!status?.authentication) return;
  authenticationStatuses.set(status.authentication, status);
  renderAuthenticationStatus();
  if (
    status.state === "authenticated" &&
    status.authentication === interactiveSignInAuthentication
  ) {
    interactiveSignInAuthentication = null;
    setBrowserStatus(
      "success",
      `${status.displayName ?? status.authentication} session is ready`,
    );
  }
}

function beginAuthentication(event) {
  if (!isElectron || !event?.url) return;
  const subject =
    event.displayName ?? event.authentication ?? "configured application";
  if (event.source === "operator" && event.authentication) {
    interactiveSignInAuthentication = event.authentication;
  }
  setBrowserStatus(
    "waiting",
    event.capability
      ? `Authentication needed for ${event.capability}. Complete it in this pane.`
      : `Complete ${subject} session setup in this pane.`,
  );
  elements.browserFallback.classList.add("hidden");
  syncAddress(event.url);
  if (elements.browser.getURL() !== event.url) {
    elements.browser.loadURL(event.url);
  }
}

async function startSignIn(authentication) {
  if (!isElectron || signInPending) return;
  if (!authentication) return;

  signInPending = true;
  renderAuthenticationStatus();
  try {
    const result = await bridge.startSignIn(authentication);
    if (!result?.ok) {
      setBrowserStatus(
        "error",
        result?.error?.message ?? "Could not open the sign-in page",
      );
    }
  } catch (error) {
    setBrowserStatus("error", error.message ?? "Could not open the sign-in page");
  } finally {
    signInPending = false;
    renderAuthenticationStatus();
  }
}

function safeDisplayPath(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function syncAddress(value, { force = false } = {}) {
  if (
    !force &&
    !shouldSyncAddress(document.activeElement, elements.address)
  ) {
    return;
  }
  elements.address.value = value;
}

function showConfigError(error) {
  const details = error?.details?.length ? `: ${error.details.join("; ")}` : "";
  elements.configMessage.className = "config-message error";
  elements.configMessage.textContent = `${error?.message ?? "Configuration rejected"}${details}`;
  elements.configState.textContent = "Needs attention";
}

function showConfigSuccess(message) {
  elements.configMessage.className = "config-message success";
  elements.configMessage.textContent = message;
  elements.configState.textContent = "Saved";
  configDirty = false;
}

function updateCapabilityCount(value) {
  const count = value?.files?.length ?? value?.capabilities?.length ?? 0;
  elements.capabilityCount.textContent = `${count} capabilit${count === 1 ? "y" : "ies"}`;
}

function capabilityBadge(file) {
  if (!file.valid) return { label: "invalid", className: "invalid" };
  if (file.runtime?.state === "broken") {
    return { label: "broken", className: "broken" };
  }
  if (!file.enabled) return { label: "disabled", className: "disabled" };
  return { label: "ready", className: "ready" };
}

function renderCapabilityList() {
  elements.capabilityList.replaceChildren();
  for (const file of capabilityFiles) {
    const badge = capabilityBadge(file);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `capability-item ${badge.className}${
      file.fileName === selectedCapabilityFile ? " selected" : ""
    }`;
    button.dataset.fileName = file.fileName;
    button.setAttribute("role", "option");
    button.setAttribute(
      "aria-selected",
      String(file.fileName === selectedCapabilityFile),
    );
    const name = document.createElement("span");
    name.className = "capability-name";
    name.textContent = file.name;
    const state = document.createElement("span");
    state.className = "capability-badge";
    state.textContent = badge.label;
    button.append(name, state);
    elements.capabilityList.append(button);
  }
}

function showCapabilityFile(file) {
  selectedCapabilityFile = file?.fileName ?? null;
  elements.capabilityEditor.value = file?.text ?? capabilityTemplate;
  elements.capabilityPath.textContent = file?.path ?? "New capability file";
  elements.capabilityPath.title = file?.path ?? "";
  elements.capabilityState.textContent = file ? "Saved" : "New";
  elements.capabilityMessage.className = "config-message";
  elements.capabilityMessage.textContent = "";
  capabilityDirty = false;
  if (file && !file.valid) {
    const details = file.error?.details?.length
      ? `: ${file.error.details.join("; ")}`
      : "";
    elements.capabilityMessage.className = "config-message error";
    elements.capabilityMessage.textContent = `${file.error?.message ?? "Capability is invalid"}${details}`;
    elements.capabilityState.textContent = "Invalid";
  } else if (file?.runtime?.state === "broken") {
    elements.capabilityMessage.className = "config-message error";
    elements.capabilityMessage.textContent = `${file.runtime.message}: ${file.runtime.details.join("; ")}`;
    elements.capabilityState.textContent = "Broken";
  }
  renderCapabilityList();
}

function selectCapability(fileName) {
  if (
    capabilityDirty &&
    !window.confirm("Discard unsaved capability changes?")
  ) {
    return;
  }
  const file = capabilityFiles.find((candidate) => candidate.fileName === fileName);
  if (file) showCapabilityFile(file);
}

function applyCapabilityState(next, preferredFileName) {
  capabilityTemplate = next?.template ?? capabilityTemplate;
  capabilityFiles = next?.files ?? [];
  renderAuthenticationStatus();
  updateCapabilityCount(next);
  const fileName =
    preferredFileName ??
    selectedCapabilityFile ??
    capabilityFiles[0]?.fileName ??
    null;
  const file = capabilityFiles.find((candidate) => candidate.fileName === fileName);
  if (capabilityDirty) {
    renderCapabilityList();
    elements.capabilityMessage.className = "config-message error";
    elements.capabilityMessage.textContent =
      "Capability files changed on disk; the unsaved editor was preserved";
    return;
  }
  showCapabilityFile(file ?? null);
}

function beginNewCapability() {
  if (
    capabilityDirty &&
    !window.confirm("Discard unsaved capability changes?")
  ) {
    return;
  }
  showCapabilityFile(null);
  capabilityDirty = true;
  elements.capabilityState.textContent = "New";
  elements.capabilityMessage.textContent =
    "Set a unique name; the file will be created when saved";
}

async function saveCapabilityDefinition() {
  if (!isElectron) {
    capabilityDirty = false;
    elements.capabilityState.textContent = "Preview";
    elements.capabilityMessage.className = "config-message success";
    elements.capabilityMessage.textContent = "Preview mode: capability editor verified";
    return;
  }
  elements.saveCapability.disabled = true;
  elements.capabilityState.textContent = "Validating…";
  const result = await bridge.saveCapability({
    fileName: selectedCapabilityFile,
    text: elements.capabilityEditor.value,
  });
  elements.saveCapability.disabled = false;
  if (!result.ok) {
    const details = result.error?.details?.length
      ? `: ${result.error.details.join("; ")}`
      : "";
    elements.capabilityMessage.className = "config-message error";
    elements.capabilityMessage.textContent = `${result.error?.message ?? "Capability rejected"}${details}`;
    elements.capabilityState.textContent = "Needs attention";
    return;
  }
  capabilityDirty = false;
  applyCapabilityState(result.state, result.fileName);
  elements.capabilityMessage.className = "config-message success";
  elements.capabilityMessage.textContent = "Capability validated and applied";
}

function showConfigurationPanel(panel) {
  const capabilities = panel === "capabilities";
  elements.capabilitiesPanel.classList.toggle("hidden", !capabilities);
  elements.authenticationPanel.classList.toggle("hidden", capabilities);
  elements.capabilitiesTab.classList.toggle("active", capabilities);
  elements.authenticationTab.classList.toggle("active", !capabilities);
  elements.capabilitiesTab.setAttribute("aria-selected", String(capabilities));
  elements.authenticationTab.setAttribute("aria-selected", String(!capabilities));
}

async function saveConfig() {
  if (!isElectron) {
    showConfigSuccess("Preview mode: YAML editor interaction verified");
    return;
  }
  elements.saveConfig.disabled = true;
  elements.configState.textContent = "Validating…";
  const result = await bridge.saveConfig(elements.configEditor.value);
  elements.saveConfig.disabled = false;
  if (!result.ok) {
    showConfigError(result.error);
    return;
  }
  authenticationProfiles = result.config.authentications ?? {};
  updateCapabilityCount(result.config);
  renderAuthenticationStatus();
  showConfigSuccess("Configuration validated and applied");
}

function makeExtractionSource(extraction) {
  const selector = JSON.stringify(extraction.selector);
  const returnType = JSON.stringify(extraction.return ?? "outerHTML");
  return `(() => {
    const selector = ${selector};
    const returnType = ${returnType};
    let node;
    try {
      node = document.querySelector(selector);
    } catch (error) {
      return { found: false, error: { code: "INVALID_SELECTOR", message: error.message } };
    }
    if (!node) return { found: false };
    if (returnType === "outerHTML") return { found: true, data: node.outerHTML };
    if (returnType === "innerHTML") return { found: true, data: node.innerHTML };
    if (returnType === "textContent") return { found: true, data: node.textContent };
    return {
      found: true,
      data: {
        tagName: node.tagName ? node.tagName.toLowerCase() : null,
        attributes: node.attributes
          ? Object.fromEntries(Array.from(node.attributes, item => [item.name, item.value]))
          : {},
        textContent: node.textContent
      }
    };
  })()`;
}

function stopExtractionTimer() {
  if (extractionTimer) {
    clearInterval(extractionTimer);
    extractionTimer = null;
  }
}

function stopAuthSettleTimer() {
  if (authSettleTimer) {
    clearTimeout(authSettleTimer);
    authSettleTimer = null;
  }
}

function scheduleAuthRetry() {
  if (!activeJob || authSettleTimer) return;
  const jobId = activeJob.id;
  authSettleTimer = setTimeout(() => {
    authSettleTimer = null;
    if (!activeJob || activeJob.id !== jobId) return;

    const currentUrl = elements.browser.getURL();
    if (!canRetrySettledAuthReturn(activeJob, currentUrl)) {
      bridge.browserEvent({
        event: "authentication.retry-skipped",
        message: "Authentication retry was no longer applicable",
        id: activeJob.id,
        capability: activeJob.capability,
        url: safeDisplayPath(currentUrl),
      });
      return;
    }

    activeJob.phase = "post-auth-retry";
    activeJob.sawForeignOrigin = true;
    activeJob.authNotified = false;
    activeJob.waitLogged = false;
    activeJob.authRetryCount = (activeJob.authRetryCount ?? 0) + 1;
    const strategy = activeJob.retryStrategy ?? "reload";
    setBrowserStatus(
      "waiting",
      `Authentication settled; retrying ${activeJob.capability}`,
    );
    bridge.browserEvent({
      event: "authentication.resumed",
      message:
        strategy === "in-page"
          ? "Portal settled; retrying capability through in-page navigation"
          : "Authentication return page settled; reloading capability URL",
      id: activeJob.id,
      capability: activeJob.capability,
      url: safeDisplayPath(currentUrl),
    });
    syncAddress(activeJob.definition.url);
    if (strategy === "in-page") {
      const target = new URL(activeJob.definition.url);
      const relativeTarget = `${target.pathname}${target.search}${target.hash}`;
      const source = `(() => {
        const target = ${JSON.stringify(relativeTarget)};
        history.pushState(history.state, "", target);
        window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        return location.href;
      })()`;
      void elements.browser.executeJavaScript(source, true).catch(() => {
        if (activeJob?.id === jobId) {
          elements.browser.loadURL(activeJob.definition.url);
        }
      });
    } else {
      elements.browser.loadURL(activeJob.definition.url);
    }
  }, AUTH_SETTLE_DELAY_MS);
}

async function attemptExtraction() {
  if (!activeJob || extractionRunning || !isElectron) return;
  extractionRunning = true;
  try {
    const currentUrl = elements.browser.getURL();
    syncAddress(currentUrl);

    if (!matchesConfiguredTarget(currentUrl, activeJob.definition.url)) {
      if (activeJob.phase === "auth-returned") {
        setBrowserStatus(
          "waiting",
          `Authentication return detected; waiting for ${activeJob.capability}`,
        );
        return;
      }
      setBrowserStatus(
        "waiting",
        `Authentication needed for ${activeJob.capability}. Complete it in this pane.`,
      );
      if (!activeJob.authNotified) {
        activeJob.authNotified = true;
        bridge.authRequired({
          id: activeJob.id,
          capability: activeJob.capability,
          url: safeDisplayPath(currentUrl),
        });
      }
      return;
    }

    const result = await elements.browser.executeJavaScript(
      makeExtractionSource(activeJob.definition.extraction),
      true,
    );
    if (result?.error) {
      const id = activeJob.id;
      activeJob = null;
      stopExtractionTimer();
      stopAuthSettleTimer();
      setBrowserStatus("error", result.error.message);
      bridge.extractionResult({ id, error: result.error });
      return;
    }
    if (!result?.found) {
      setBrowserStatus(
        "waiting",
        `Waiting for ${activeJob.capability} target content`,
      );
      if (!activeJob.waitLogged) {
        activeJob.waitLogged = true;
        bridge.browserEvent({
          event: "extraction.waiting",
          message: "Target CSS selector is not available yet",
          id: activeJob.id,
          capability: activeJob.capability,
          url: safeDisplayPath(currentUrl),
        });
      }
      return;
    }

    const finished = activeJob;
    activeJob = null;
    stopExtractionTimer();
    stopAuthSettleTimer();
    setBrowserStatus(
      "success",
      `Extraction completed for ${finished.capability}`,
    );
    bridge.extractionResult({ id: finished.id, data: result.data });
  } catch (error) {
    if (!activeJob) return;
    setBrowserStatus(
      "waiting",
      `Browser is still loading ${activeJob.capability}`,
    );
  } finally {
    extractionRunning = false;
  }
}

function handleJobNavigation(url) {
  if (!activeJob) return;
  const previousPhase = activeJob.phase;
  const transition = transitionForNavigation(activeJob, url);
  if (!["auth-returned", "target-bounced"].includes(transition.action)) {
    stopAuthSettleTimer();
  }
  Object.assign(activeJob, transition.patch);

  if (
    transition.action === "auth-returned" &&
    previousPhase !== "auth-returned"
  ) {
    setBrowserStatus(
      "waiting",
      "Authentication return detected; allowing the portal to finish",
    );
    bridge.browserEvent({
      event: "authentication.returned",
      message:
        "Authentication returned to the target origin; waiting for the page to settle",
      id: activeJob.id,
      capability: activeJob.capability,
      url: safeDisplayPath(url),
    });
  }
  if (transition.action === "target-bounced") {
    setBrowserStatus(
      "waiting",
      "Target route returned to the portal; preparing in-page navigation",
    );
    bridge.browserEvent({
      event: "target.bounced",
      message:
        "Target route returned before content was ready; switching to in-page navigation",
      id: activeJob.id,
      capability: activeJob.capability,
      url: safeDisplayPath(url),
    });
  }
  if (["auth-returned", "target-bounced"].includes(transition.action)) {
    scheduleAuthRetry();
  }
}

function executeJob(job) {
  activeJob = {
    ...job,
    phase: "navigating-target",
    sawForeignOrigin: false,
    authRetryCount: 0,
    authNotified: false,
    waitLogged: false,
  };
  stopExtractionTimer();
  stopAuthSettleTimer();
  setBrowserStatus("waiting", `Loading ${job.capability}`);
  elements.browserFallback.classList.add("hidden");
  syncAddress(job.definition.url);

  const currentUrl = elements.browser.getURL();
  if (matchesConfiguredTarget(currentUrl, job.definition.url)) {
    activeJob.phase = "target";
    void attemptExtraction();
  } else {
    elements.browser.loadURL(job.definition.url);
  }
  extractionTimer = setInterval(() => void attemptExtraction(), 1_000);
}

function cancelJob(job) {
  if (activeJob?.id !== job?.id) return;
  activeJob = null;
  stopExtractionTimer();
  stopAuthSettleTimer();
  setBrowserStatus("error", "Extraction timed out");
}

function manualNavigate() {
  if (!isElectron) return;
  let url;
  try {
    url = new URL(elements.address.value);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error();
  } catch {
    setBrowserStatus("error", "Enter an absolute http or https URL");
    return;
  }
  elements.browserFallback.classList.add("hidden");
  elements.address.blur();
  syncAddress(url.href, { force: true });
  elements.browser.loadURL(url.href);
}

function installBrowserControls() {
  if (!isElectron) return;

  elements.browser.addEventListener("dom-ready", () => {
    elements.browserFallback.classList.add("hidden");
    void attemptExtraction();
  });
  elements.browser.addEventListener("did-stop-loading", () => {
    syncAddress(elements.browser.getURL());
    void attemptExtraction();
  });
  elements.browser.addEventListener("did-navigate", (event) => {
    syncAddress(event.url);
    handleJobNavigation(event.url);
    bridge.browserEvent({
      event: "navigation",
      message: "Browser navigated",
      ...(activeJob
        ? { id: activeJob.id, capability: activeJob.capability }
        : {}),
      url: safeDisplayPath(event.url),
    });
  });
  elements.browser.addEventListener("did-navigate-in-page", (event) => {
    syncAddress(event.url);
    handleJobNavigation(event.url);
    void attemptExtraction();
  });
  elements.browser.addEventListener("did-fail-load", (event) => {
    if (event.errorCode === -3) return;
    setBrowserStatus("error", event.errorDescription);
    bridge.browserEvent({
      event: "load.failed",
      message: event.errorDescription,
      ...(activeJob
        ? { id: activeJob.id, capability: activeJob.capability }
        : {}),
      url: safeDisplayPath(event.validatedURL),
    });
  });

  elements.back.addEventListener("click", () => {
    if (elements.browser.canGoBack()) elements.browser.goBack();
  });
  elements.forward.addEventListener("click", () => {
    if (elements.browser.canGoForward()) elements.browser.goForward();
  });
  elements.reload.addEventListener("click", () => elements.browser.reload());
  elements.go.addEventListener("click", manualNavigate);
  elements.address.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      manualNavigate();
    }
    if (event.key === "Escape") {
      syncAddress(elements.browser.getURL(), { force: true });
      elements.address.blur();
    }
  });
}

async function initialize() {
  elements.authenticationStates.addEventListener("click", (event) => {
    const button = event.target.closest("[data-authentication]");
    if (button) void startSignIn(button.dataset.authentication);
  });
  elements.capabilitiesTab.addEventListener("click", () =>
    showConfigurationPanel("capabilities"),
  );
  elements.authenticationTab.addEventListener("click", () =>
    showConfigurationPanel("authentication"),
  );
  elements.capabilityList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-file-name]");
    if (button) selectCapability(button.dataset.fileName);
  });
  elements.newCapability.addEventListener("click", beginNewCapability);
  elements.saveCapability.addEventListener("click", () =>
    void saveCapabilityDefinition(),
  );
  elements.capabilityEditor.addEventListener("input", () => {
    capabilityDirty = true;
    elements.capabilityState.textContent = "Unsaved";
    elements.capabilityMessage.className = "config-message";
    elements.capabilityMessage.textContent =
      "Changes are local until saved and validated";
  });
  elements.saveConfig.addEventListener("click", () => void saveConfig());
  elements.configEditor.addEventListener("input", () => {
    configDirty = true;
    elements.configState.textContent = "Unsaved";
    elements.configMessage.className = "config-message";
    elements.configMessage.textContent = "Changes are local until saved and validated";
  });

  if (!isElectron) {
    authenticationProfiles = {
      arc_session: { displayName: "ARC", signInGroup: "U-M SSO" },
    };
    updateAuthenticationStatus({
      authentication: "arc_session",
      displayName: "ARC",
      state: "unauthenticated",
    });
    elements.configEditor.value = previewConfig;
    elements.configPath.textContent = "./config.yaml";
    applyCapabilityState({
      directory: "./capabilities",
      template: previewCapability.replace(
        "arc.remaining_hours.read",
        "new.capability.read",
      ),
      files: [
        {
          fileName: "arc.remaining_hours.read.yaml",
          path: "./capabilities/arc.remaining_hours.read.yaml",
          name: "arc.remaining_hours.read",
          description: "ARC Great Lakes remaining partition hours",
          enabled: true,
          authentication: "arc_session",
          text: previewCapability,
          valid: true,
          runtime: null,
        },
      ],
    });
    elements.socketPath.textContent = "~/.config/agent-broker/broker.sock";
    elements.configState.textContent = "Preview";
    return;
  }

  installBrowserControls();
  const state = await bridge.getState();
  authenticationProfiles = state.config?.authentications ?? {};
  elements.developmentAuthPersistence.hidden =
    state.authenticationPersistence !== "development";
  elements.configEditor.value = state.configText;
  elements.configPath.textContent = state.configPath;
  elements.configPath.title = state.configPath;
  elements.socketPath.textContent = state.socketPath;
  elements.socketPath.title = state.socketPath;
  elements.configState.textContent = "Saved";
  applyCapabilityState(state.capabilities);
  for (const status of state.authenticationStatuses ?? []) {
    authenticationStatuses.set(status.authentication, status);
  }
  renderAuthenticationStatus();
  bridge.onAuthenticationStatus(updateAuthenticationStatus);
  bridge.onAuthenticationRequired(beginAuthentication);
  bridge.onCapabilitiesChanged((next) => applyCapabilityState(next));
  bridge.onExecute(executeJob);
  bridge.onCancel(cancelJob);
  bridge.ready();
}

window.addEventListener("beforeunload", (event) => {
  if (!configDirty && !capabilityDirty) return;
  event.preventDefault();
  event.returnValue = "";
});

void initialize();
