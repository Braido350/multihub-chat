// Preload da aba de E-mail e da tela de Configurações: recebe o canal direto com o serviço de e-mail
// e expõe uma API mínima. O processo principal confere quem pode abrir e fechar as Configurações.
const { contextBridge, ipcRenderer } = require("electron");

let port = null;
let seq = 0;
const calls = new Map();
const queue = [];
const listeners = new Map();

function dispatch(msg) {
  if (msg.id) {
    const c = calls.get(msg.id);
    if (!c) return;
    calls.delete(msg.id);
    msg.error ? c.reject(new Error(msg.error)) : c.resolve(msg.result);
  } else if (msg.event) {
    for (const cb of listeners.get(msg.event) || []) cb(msg.data);
  }
}

ipcRenderer.on("email:port", (e) => {
  // Serviço reiniciado: as chamadas em andamento no canal antigo não vão voltar
  for (const c of calls.values()) c.reject(new Error("Serviço de e-mail reiniciado."));
  calls.clear();
  port = e.ports[0];
  port.onmessage = (ev) => dispatch(ev.data);
  while (queue.length) port.postMessage(queue.shift());
  for (const cb of listeners.get("connected") || []) cb();
});

contextBridge.exposeInMainWorld("mail", {
  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      calls.set(id, { resolve, reject });
      const msg = { id, method: String(method), params: params || {} };
      port ? port.postMessage(msg) : queue.push(msg);
    });
  },
  on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(cb);
  },
});

contextBridge.exposeInMainWorld("appShell", {
  /** Aba de E-mail: abre as Configurações numa seção (ex.: "email/contas"). */
  openSettings: (route) => ipcRenderer.send("app:open-settings", String(route || "")),
  /** Tela de Configurações: fecha e volta ao site que estava aberto. */
  closeSettings: () => ipcRenderer.send("app:close-settings"),
  /** Tela de Configurações: pedido para ir a outra seção com ela já aberta. */
  onGoto: (cb) => ipcRenderer.on("settings:goto", (_e, route) => cb(String(route || ""))),
  /** Tela de Configurações: atualização do app (versão, verificar, instalar, URL do latest.json). */
  update: (action, data) => ipcRenderer.invoke("app:update", { ...(data || {}), action: String(action) }),
  onUpdateStatus: (cb) => ipcRenderer.on("app:update-status", (_e, st) => cb(st)),
  /** Tela de Configurações › WhatsApp: recursos extras por aba (whatsapp/host.js). */
  wa: (action, data) => ipcRenderer.invoke("app:wa", { ...(data || {}), action: String(action) }),
  /** Tela de Configurações › Aplicativo › Desempenho: registro gravado a cada segundo (perflog.js). */
  perf: (action) => ipcRenderer.invoke("app:perf", { action: String(action) }),
});
