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

  // A varredura completa (check) percorre a página inteira e o WhatsApp muda o DOM o tempo todo: fazê-la a
  // cada mudança pesa no processador. Só varre quando algo recém-adicionado contém o texto de um dos botões
  // da chamada; enquanto está tocando, confere a cada mudança (no máximo 1x por segundo) para ver o fim.
  const HINT = /aceitar|atender|accept|answer|recusar|rejeitar|decline|reject/i;
  const mayBeCall = (records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 3) {
          if (HINT.test(n.nodeValue)) return true;
        } else if (n.nodeType === 1) {
          if (HINT.test(n.textContent)) return true;
          const label = n.getAttribute("aria-label");
          if (label && HINT.test(label)) return true;
          if (n.querySelector("[aria-label*='ceitar' i],[aria-label*='tender' i],[aria-label*='ccept' i],[aria-label*='nswer' i],[aria-label*='ecusar' i],[aria-label*='ejeitar' i],[aria-label*='ecline' i],[aria-label*='eject' i]")) return true;
        }
      }
    }
    return false;
  };

  let pending = false;
  window.addEventListener("DOMContentLoaded", () => {
    new MutationObserver((records) => {
      if (pending) return;
      if (!ringing && !mayBeCall(records)) return;
      pending = true;
      setTimeout(
        () => {
          pending = false;
          check();
        },
        ringing ? 1000 : 300
      );
    }).observe(document.body, { childList: true, subtree: true });
  });
}

// WhatsApp Web: recursos extras (Configurações › WhatsApp). O processo principal entrega o script e a
// configuração desta aba; o script roda no mundo da página porque precisa dos módulos internos do WhatsApp.
if (location.hostname === "web.whatsapp.com") {
  let boot = null;
  try {
    boot = ipcRenderer.sendSync("wa:boot");
  } catch {}
  if (boot && boot.script) {
    let config = boot.config || {};
    let onConfig = null;
    let onCommand = null;
    ipcRenderer.on("wa:config", (_e, c) => {
      config = c || {};
      if (onConfig) onConfig(config);
    });
    ipcRenderer.on("wa:command", (_e, cmd) => onCommand && onCommand(cmd));
    contextBridge.exposeInMainWorld("__waTools", {
      config: () => config,
      onConfig: (cb) => {
        onConfig = cb;
      },
      onCommand: (cb) => {
        onCommand = cb;
      },
      status: (id, state, detail) => ipcRenderer.send("wa:status", { id, state, detail }),
      send: (type, payload) => ipcRenderer.send("wa:event", { type, payload }),
    });
    webFrame.executeJavaScript(boot.script).catch(() => {});
  }
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

// Chatwoot: o painel só avisa por Web Push (service worker + FCM), que não existe no Electron.
// Escuta o websocket do próprio Chatwoot (ActionCable, canal RoomChannel) e gera a notificação nativa
// para cada mensagem recebida de cliente (incoming, não privada).
if (location.hostname !== "web.whatsapp.com") {
  webFrame.executeJavaScript(`(() => {
    const NativeWS = window.WebSocket;
    if (!NativeWS || NativeWS.__desktopHooked) return;
    const seen = new Set();

    const strip = (html) => {
      const d = document.createElement("div");
      d.innerHTML = String(html || "");
      return (d.textContent || "").replace(/\\s+/g, " ").trim();
    };

    const openConversation = (accountId, conversationId) => {
      const url = "/app/accounts/" + accountId + "/conversations/" + conversationId;
      if (location.pathname === url) return;
      history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    };

    const handle = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || !msg.identifier || !String(msg.identifier).includes("RoomChannel")) return;
      const ev = msg.message;
      if (!ev || ev.event !== "message.created" || !ev.data) return;
      const m = ev.data;
      if (m.message_type !== 0 || m.private) return; // 0 = incoming (do cliente)
      if (seen.has(m.id)) return;
      seen.add(m.id);
      if (seen.size > 500) seen.delete(seen.values().next().value);
      // Já está olhando esta conversa: não avisa
      if (document.hasFocus() && location.pathname.endsWith("/conversations/" + m.conversation_id)) return;

      const sender = (m.sender && (m.sender.name || m.sender.email || m.sender.phone_number)) || "Chatwoot";
      let body = strip(m.content);
      if (!body && m.attachments && m.attachments.length) body = "📎 Anexo";
      const n = new window.Notification(sender, { body: body.slice(0, 200) || "Nova mensagem" });
      n.onclick = () => openConversation(m.account_id, m.conversation_id);
    };

    function HookedWS(...args) {
      const ws = new NativeWS(...args);
      ws.addEventListener("message", (e) => {
        if (typeof e.data === "string") handle(e.data);
      });
      return ws;
    }
    HookedWS.prototype = NativeWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) HookedWS[k] = NativeWS[k];
    HookedWS.__desktopHooked = true;
    window.WebSocket = HookedWS;
  })();`);
}
