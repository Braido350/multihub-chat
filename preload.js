const { contextBridge, ipcRenderer, webFrame } = require("electron");

let clickCb = null;

contextBridge.exposeInMainWorld("__desktop", {
  notify: (id, title, body) => ipcRenderer.send("notify", { id, title, body }),
  onClick: (cb) => {
    clickCb = cb;
  },
});

ipcRenderer.on("notification-click", (_e, id) => {
  if (clickCb) clickCb(id);
});

// WhatsApp Web: detecta a tela de chamada recebida ("Recusar" + "Aceitar" na tela)
if (location.hostname === "web.whatsapp.com") {
  const ACCEPT = /^(aceitar|atender|accept|answer)$/i;
  const DECLINE = /^(recusar|rejeitar|decline|reject)$/i;
  let ringing = false;

  // Os botões do WhatsApp nem sempre são <button>: procura o texto em qualquer elemento
  const has = (re) => {
    for (const el of document.querySelectorAll("[aria-label]")) {
      if (re.test(el.getAttribute("aria-label").trim())) return true;
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if (re.test(walker.currentNode.nodeValue.trim())) return true;
    return false;
  };

  const check = () => {
    const now = has(DECLINE) && has(ACCEPT);
    if (now && !ringing) ipcRenderer.send("incoming-call");
    ringing = now;
  };

  let pending = false;
  window.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        check();
      }, 300);
    }).observe(document.body, { childList: true, subtree: true });
  });
}

// Substitui a Notification da página por uma que dispara notificação nativa do sistema
webFrame.executeJavaScript(`(() => {
  const bridge = window.__desktop;
  if (!bridge) return;
  let seq = 0;
  const live = new Map();

  class DesktopNotification extends EventTarget {
    static permission = "granted";
    static requestPermission(cb) {
      if (typeof cb === "function") cb("granted");
      return Promise.resolve("granted");
    }
    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = String(options.body || "");
      this.tag = options.tag;
      this.data = options.data;
      this.onclick = null;
      this.onclose = null;
      this.onshow = null;
      this.onerror = null;
      this._id = ++seq;
      live.set(this._id, this);
      setTimeout(() => live.delete(this._id), 300000);
      bridge.notify(this._id, this.title, this.body);
    }
    close() {
      live.delete(this._id);
    }
  }

  bridge.onClick((id) => {
    const n = live.get(id);
    if (!n) return;
    live.delete(id);
    const ev = new Event("click");
    if (typeof n.onclick === "function") n.onclick(ev);
    n.dispatchEvent(ev);
  });

  Object.defineProperty(window, "Notification", {
    value: DesktopNotification,
    configurable: true,
    writable: true,
  });
})();`);
