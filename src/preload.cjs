const { contextBridge, ipcRenderer } = require("electron");

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld("agentBroker", {
  getState: () => ipcRenderer.invoke("state:get"),
  saveConfig: (text) => ipcRenderer.invoke("config:save", text),
  saveCapability: (request) => ipcRenderer.invoke("capability:save", request),
  startSignIn: (authentication) =>
    ipcRenderer.invoke("authentication:sign-in", authentication),
  ready: () => ipcRenderer.send("renderer:ready"),
  onAuthenticationStatus: (callback) => on("authentication:status", callback),
  onAuthenticationRequired: (callback) =>
    on("authentication:required", callback),
  onCapabilitiesChanged: (callback) => on("capabilities:changed", callback),
  onExecute: (callback) => on("broker:execute", callback),
  onCancel: (callback) => on("broker:cancel", callback),
  extractionResult: (result) => ipcRenderer.send("broker:result", result),
  authRequired: (event) => ipcRenderer.send("broker:auth-required", event),
  browserEvent: (event) => ipcRenderer.send("browser:event", event),
});
