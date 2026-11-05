// Preload da aba de E-mail: recebe o canal direto com o serviço e expõe uma API mínima.
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
