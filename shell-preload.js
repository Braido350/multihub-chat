const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shellApi", {
  getState: () => ipcRenderer.invoke("shell:get-state"),
  select: (id) => ipcRenderer.send("shell:select", id),
  save: (data) => ipcRenderer.invoke("shell:save", data),
  menu: (id) => ipcRenderer.send("shell:menu", id),
  addMenu: () => ipcRenderer.send("shell:add-menu"),
  settings: () => ipcRenderer.send("shell:settings"),
  resized: () => ipcRenderer.send("shell:resized"),
  modal: (open) => ipcRenderer.send("shell:modal", !!open),
  onState: (cb) => ipcRenderer.on("shell:state", (_e, s) => cb(s)),
  onEdit: (cb) => ipcRenderer.on("shell:edit", (_e, id) => cb(id)),
});
