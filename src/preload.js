const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tmuxApi", {
  createPane: (payload) => ipcRenderer.invoke("pane:create", payload),
  writePane: (payload) => ipcRenderer.invoke("pane:write", payload),
  resizePane: (payload) => ipcRenderer.invoke("pane:resize", payload),
  killPane: (paneId) => ipcRenderer.invoke("pane:kill", paneId),
  suggestCommands: (payload) => ipcRenderer.invoke("ai:suggest", payload),
  onData: (callback) => ipcRenderer.on("pty:data", (_, event) => callback(event)),
  onExit: (callback) => ipcRenderer.on("pty:exit", (_, event) => callback(event))
});
