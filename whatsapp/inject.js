// Recursos extras do WhatsApp Web (Configurações › WhatsApp). Roda no "mundo" da página (precisa dos módulos
// internos do WhatsApp), injetado pelo preload.js. Cada recurso é independente: se o WhatsApp mudar e algo
// não for encontrado, só aquele recurso para e informa o motivo (Configurações › WhatsApp › estado).
// Nada aqui pode lançar erro para dentro do código do WhatsApp: toda chamada nossa fica em try/catch.
(() => {
  "use strict";
  if (window.__mhWaLoaded) return;
  window.__mhWaLoaded = true;
  const bridge = window.__waTools;
  if (!bridge) return;

  let cfg = {};
  try {
    cfg = bridge.config() || {};
  } catch {}

  const report = (id, state, detail) => {
    try {
      bridge.status(id, state, String(detail || "").slice(0, 300));
    } catch {}
  };
  const emit = (type, payload) => {
    try {
      bridge.send(type, payload);
    } catch {}
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Módulos internos do WhatsApp ----------
  function modulesMap() {
    try {
      const d = typeof window.require === "function" && window.require("__debug");
      return (d && d.modulesMap) || null;
    } catch {
      return null;
    }
  }
  function mod(name) {
    const map = modulesMap();
    if (!map || !map[name]) return null;
    try {
      return window.require(name);
    } catch {
      return null;
    }
  }
  /** Conectado e com a lista de conversas na tela. */
  const loggedIn = () => !!document.querySelector("#pane-side");
  const collections = () => {
    const c = mod("WAWebCollections");
    return c && c.Chat && c.Msg ? c : null;
  };
  const models = (col) => {
    if (!col) return [];
    try {
      if (typeof col.getModelsArray === "function") return col.getModelsArray();
    } catch {}
    return col.models || col._models || [];
  };
  const widStr = (id) => (id && (id._serialized || (id.toString && id.toString()))) || "";

  /**
   * Troca uma função exportada por um módulo. Devolve a função que desfaz a troca.
   * Lança erro se o módulo ou a função não existirem (o recurso informa "não encontrado").
   */
  function patch(modName, fnName, make) {
    const m = mod(modName);
    if (!m || typeof m[fnName] !== "function") throw new Error(`${modName}.${fnName} não encontrado`);
    const orig = m[fnName].__mhOrig || m[fnName];
    const rep = make(orig);
    rep.__mhOrig = orig;
    m[fnName] = rep;
    return () => {
      if (m[fnName] === rep) m[fnName] = orig;
    };
  }
  // O WhatsApp tem dois caminhos para a mesma coisa: a função "Bridge" do módulo e, quando
  // WAWebBackendRuntime.isWebDiBackendEnabled() está ligado, runtime(Serviço).método. As duas precisam ser
  // trocadas. runtime() é trocado uma vez só; cada recurso registra os métodos que quer substituir.
  const svcOverrides = new Map(); // objeto-etiqueta do serviço -> Map(método -> make(original, impl))
  let runtimeUndo = null;
  function ensureRuntimePatch() {
    if (runtimeUndo) return;
    runtimeUndo = patch("WAWebBackendRuntime", "runtime", (orig) =>
      function (svc) {
        const impl = orig.apply(this, arguments);
        const over = svcOverrides.get(svc);
        if (!over || !over.size || !impl || typeof impl !== "object") return impl;
        return new Proxy(impl, {
          get(t, k) {
            const v = Reflect.get(t, k, t);
            const make = over.get(k);
            if (make && typeof v === "function") {
              try {
                return make(v.bind(t), t);
              } catch {}
            }
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
      }
    );
  }
  /** Substitui serviço.método no caminho runtime(). Devolve a função que desfaz. */
  function patchService(modName, svcKey, method, make) {
    const m = mod(modName);
    const svc = m && m[svcKey];
    if (!svc) throw new Error(`${modName}.${svcKey} não encontrado`);
    ensureRuntimePatch();
    if (!svcOverrides.has(svc)) svcOverrides.set(svc, new Map());
    const over = svcOverrides.get(svc);
    over.set(method, make);
    return () => {
      if (over.get(method) === make) over.delete(method);
      if (![...svcOverrides.values()].some((o) => o.size) && runtimeUndo) {
        runtimeUndo();
        runtimeUndo = null;
      }
    };
  }

  /**
   * Aplica várias trocas; precisa de pelo menos uma. Devolve { undo, missing }.
   * Cada item: [módulo, função, make] ou { svc: [módulo, chave, método], make }.
   */
  function patchAll(list) {
    const undos = [];
    const missing = [];
    for (const item of list) {
      try {
        if (Array.isArray(item)) undos.push(patch(item[0], item[1], item[2]));
        else undos.push(patchService(item.svc[0], item.svc[1], item.svc[2], item.make));
      } catch {
        missing.push(Array.isArray(item) ? `${item[0]}.${item[1]}` : item.svc.join("."));
      }
    }
    if (!undos.length) throw new Error("A interface do WhatsApp mudou: " + missing.join(", ") + " não encontrados");
    return { undo: () => undos.forEach((u) => u()), missing };
  }
  const resolved = () => Promise.resolve();

  // ---------- Observador do DOM compartilhado (um só, com intervalo) ----------
  const domHandlers = new Map(); // id -> { fn, errors }
  let domTimer = null;
  const runDom = () => {
    domTimer = null;
    for (const [id, h] of domHandlers) {
      try {
        h.fn();
        h.errors = 0;
      } catch (err) {
        if (++h.errors >= 3) {
          domHandlers.delete(id);
          stopFeature(id, "broken", "Parou depois de erros seguidos: " + (err && err.message));
        }
      }
    }
  };
  const scheduleDom = () => {
    if (!domTimer) domTimer = setTimeout(runDom, 400);
  };
  const startObserver = () => {
    if (!document.body) return setTimeout(startObserver, 200);
    new MutationObserver(scheduleDom).observe(document.body, { childList: true, subtree: true });
  };
  startObserver();

  // ---------- Elementos nossos (fora da árvore do React do WhatsApp sempre que possível) ----------
  const STYLE = `
  .mh-btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;font-size:17px;line-height:1;color:var(--icon,#54656f)}
  .mh-btn:hover{background:rgba(127,127,127,.18)}
  .mh-float{position:fixed;z-index:9999}
  .mh-menu{position:fixed;z-index:10000;min-width:240px;max-width:360px;max-height:50vh;overflow:auto;background:var(--dropdown-background,#fff);color:var(--primary,#111b21);
    border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);padding:6px;font:14px/1.4 system-ui,sans-serif}
  .mh-menu input[type=search]{width:100%;box-sizing:border-box;padding:6px 8px;margin-bottom:4px;border:1px solid rgba(127,127,127,.35);border-radius:6px;background:transparent;color:inherit}
  .mh-item{display:flex;gap:8px;align-items:center;padding:7px 9px;border-radius:6px;cursor:pointer}
  .mh-item:hover,.mh-item.on{background:rgba(127,127,127,.15)}
  .mh-item small{opacity:.65;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
  .mh-empty{padding:8px 9px;opacity:.7}
  .mh-labels{display:inline-flex;gap:3px;margin-left:6px;vertical-align:middle;flex-wrap:wrap}
  .mh-label{font-size:10.5px;line-height:15px;padding:0 6px;border-radius:8px;color:#fff;white-space:nowrap}
  .mh-dot{width:10px;height:10px;border-radius:50%;flex:none}
  .mh-deleted{margin-top:4px;padding:4px 8px;border-left:3px solid #e53935;background:rgba(229,57,53,.08);font-size:12.5px;white-space:pre-wrap;border-radius:4px}
  html.mh-blur-chats #pane-side [role=listitem],html.mh-blur-chats #pane-side [role=row]{filter:blur(6px);transition:filter .15s}
  html.mh-blur-chats #pane-side [role=listitem]:hover,html.mh-blur-chats #pane-side [role=row]:hover{filter:none}
  html.mh-blur-msgs #main [data-id] .copyable-text,html.mh-blur-msgs #main [data-id] .selectable-text{filter:blur(6px);transition:filter .15s}
  html.mh-blur-msgs #main [data-id]:hover .copyable-text,html.mh-blur-msgs #main [data-id]:hover .selectable-text{filter:none}
  html.mh-blur-photos #pane-side img,html.mh-blur-photos #main header img,html.mh-blur-photos #main [data-id] img,html.mh-blur-photos #main [data-id] video{filter:blur(12px);transition:filter .15s}
  html.mh-blur-photos #pane-side img:hover,html.mh-blur-photos #main header img:hover,html.mh-blur-photos #main [data-id]:hover img,html.mh-blur-photos #main [data-id]:hover video{filter:none}
  `;
  const addStyle = () => {
    if (document.getElementById("mh-wa-style")) return;
    if (!document.head) return setTimeout(addStyle, 200);
    const s = document.createElement("style");
    s.id = "mh-wa-style";
    s.textContent = STYLE;
    document.head.append(s);
  };
  addStyle();

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  let openMenu = null;
  function closeMenu() {
    if (openMenu) openMenu.remove();
    openMenu = null;
  }
  document.addEventListener("mousedown", (e) => openMenu && !openMenu.contains(e.target) && !e.target.closest(".mh-btn") && closeMenu(), true);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu(), true);
  function showMenu(anchor, build) {
    closeMenu();
    const m = el("div", "mh-menu");
    build(m);
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    const mh = m.offsetHeight;
    const mw = m.offsetWidth;
    m.style.left = Math.max(8, Math.min(r.left, innerWidth - mw - 8)) + "px";
    m.style.top = (r.top - mh - 6 > 8 ? r.top - mh - 6 : Math.min(r.bottom + 6, innerHeight - mh - 8)) + "px";
    openMenu = m;
    return m;
  }

  const composer = () =>
    document.querySelector('#main footer [contenteditable="true"]') || document.querySelector('#main [contenteditable="true"][role="textbox"]');
  /** Nome da conversa aberta (cabeçalho). */
  function activeChatName() {
    const head = document.querySelector("#main header");
    if (!head) return "";
    const t = head.querySelector("span[title]") || head.querySelector('span[dir="auto"]');
    return ((t && (t.getAttribute("title") || t.textContent)) || "").trim();
  }
  function insertText(text) {
    const box = composer();
    if (!box) throw new Error("Abra uma conversa primeiro.");
    box.focus();
    // execCommand passa pelo editor do WhatsApp (o texto fica pronto para enviar com Enter)
    if (!document.execCommand("insertText", false, text)) throw new Error("Não foi possível escrever na conversa.");
  }

  // ---------- Recursos ----------
  const running = new Map(); // id -> { key, stop }

  function stopFeature(id, state, detail) {
    const r = running.get(id);
    running.delete(id);
    domHandlers.delete(id);
    if (r && r.stop) {
      try {
        r.stop();
      } catch {}
    }
    report(id, state || "off", detail);
  }

  /** Espera a condição (sem prazo: o login pode demorar). Para se o recurso for desligado. */
  async function until(id, key, cond) {
    for (;;) {
      const r = running.get(id);
      if (!r || r.key !== key) return false;
      try {
        if (cond()) return true;
      } catch {}
      await sleep(1500);
    }
  }

  const FEATURES = [
    // Status "online": o WhatsApp avisa "disponível" quando a janela fica ativa; vira "indisponível"
    {
      id: "hideOnline",
      on: (c) => c.hideOnline,
      internals: true,
      start() {
        const pc = mod("WAWebPresenceChatAction");
        const cb = mod("WAWebContactPresenceBridge");
        const unavailable = (pc && pc.sendPresenceUnavailable) || (cb && cb.setPresenceUnavailable);
        const off = function () {
          try {
            if (unavailable) return unavailable.apply(this, arguments);
          } catch {}
          return resolved();
        };
        const p = patchAll([
          ["WAWebPresenceChatAction", "sendPresenceAvailable", () => off],
          ["WAWebContactPresenceBridge", "setPresenceAvailable", () => off],
          // Caminho novo: o próprio serviço manda "indisponível" no lugar de "disponível"
          { svc: ["WAWebPresenceService", "PresenceService", "setPresenceAvailable"], make: (_orig, impl) => () => (typeof impl.setPresenceUnavailable === "function" ? impl.setPresenceUnavailable() : resolved()) },
        ]);
        try {
          if (unavailable) unavailable();
        } catch {}
        return { stop: p.undo, detail: p.missing.length ? "parcial: " + p.missing.join(", ") : "" };
      },
    },
    // "digitando…" e "gravando áudio…"
    {
      id: "hideTyping",
      on: (c) => c.hideTyping,
      internals: true,
      start() {
        const p = patchAll([
          ["WAWebChatStateBridge", "sendChatStateComposing", () => resolved],
          ["WAWebChatStateBridge", "sendChatStateRecording", () => resolved],
          ["WAWebPresenceChatAction", "markComposing", () => resolved],
          ["WAWebPresenceChatAction", "markRecording", () => resolved],
          { svc: ["WAWebChatStateService", "ChatStateService", "sendChatStateComposing"], make: () => resolved },
          { svc: ["WAWebChatStateService", "ChatStateService", "sendChatStateRecording"], make: () => resolved },
        ]);
        return { stop: p.undo, detail: p.missing.length ? "parcial: " + p.missing.join(", ") : "" };
      },
    },
    // Confirmação de leitura (risquinhos azuis): a conversa é lida aqui, mas o aviso não é enviado
    {
      id: "noReadReceipts",
      on: (c) => c.noReadReceipts,
      internals: true,
      start() {
        const p = patchAll([
          ["WAWebSendReadReceiptJob", "markChatRead", () => resolved],
          ["WAWebChatSendConversationSeen", "sendConversationSeen", () => resolved],
          { svc: ["WAWebChatReadService", "ChatReadService", "sendConversationSeen"], make: () => resolved },
        ]);
        return { stop: p.undo, detail: p.missing.length ? "parcial: " + p.missing.join(", ") : "" };
      },
    },
    // Desfoque: só CSS (passar o mouse mostra)
    {
      id: "blur",
      on: (c) => c.blurChats || c.blurMessages || c.blurPhotos,
      key: (c) => [c.blurChats, c.blurMessages, c.blurPhotos].join(),
      start(c) {
        const cls = { "mh-blur-chats": c.blurChats, "mh-blur-msgs": c.blurMessages, "mh-blur-photos": c.blurPhotos };
        for (const [k, v] of Object.entries(cls)) document.documentElement.classList.toggle(k, !!v);
        let warned = false;
        domHandlers.set("blur", {
          errors: 0,
          fn() {
            // Conectado, mas nenhuma conversa com a estrutura esperada: a interface mudou
            if (!warned && loggedIn() && c.blurChats && !document.querySelector("#pane-side [role=listitem], #pane-side [role=row]")) {
              warned = true;
              report("blur", "warn", "Lista de conversas com estrutura diferente: o desfoque pode não pegar");
            }
          },
        });
        return { stop: () => Object.keys(cls).forEach((k) => document.documentElement.classList.remove(k)) };
      },
    },
    // Mensagens apagadas: guarda o texto das mensagens recebidas; se forem apagadas, mostra e registra
    {
      id: "keepDeleted",
      on: (c) => c.keepDeleted,
      internals: true,
      start() {
        const C = collections();
        if (!C || typeof C.Msg.on !== "function") throw new Error("Coleção de mensagens não encontrada");
        const cache = new Map(); // id -> {...}
        const chatName = (m) => {
          try {
            const ch = m.chat || (C.Chat.get && C.Chat.get(m.id.remote));
            return (ch && (ch.formattedTitle || ch.name || (ch.contact && (ch.contact.name || ch.contact.pushname)))) || widStr(m.id && m.id.remote);
          } catch {
            return "";
          }
        };
        const fromName = (m) => {
          try {
            const c = m.senderObj || (m.author && C.Contact.get && C.Contact.get(m.author)) || (C.Contact.get && C.Contact.get(m.from));
            return (c && (c.name || c.pushname || c.formattedName)) || widStr(m.author || m.from);
          } catch {
            return "";
          }
        };
        const remember = (m) => {
          try {
            if (!m || !m.id || m.id.fromMe) return;
            const text = typeof m.body === "string" && m.type === "chat" ? m.body : typeof m.caption === "string" ? m.caption : "";
            if (!text && !["image", "video", "ptt", "audio", "document", "sticker"].includes(m.type)) return;
            cache.set(widStr(m.id), { text, kind: m.type, sentAt: (m.t || 0) * 1000, chat: chatName(m), from: fromName(m) });
            if (cache.size > 4000) cache.delete(cache.keys().next().value);
          } catch {}
        };
        // Texto mostrado no aviso "Mensagem apagada" (id do aviso -> texto). Fica no localStorage desta aba
        // para continuar visível ao reabrir a conversa ou recarregar.
        const SHOWN_KEY = "mh-deleted-v1";
        let shownMap = {};
        try {
          shownMap = JSON.parse(localStorage.getItem(SHOWN_KEY) || "{}") || {};
        } catch {}
        const saveShown = () => {
          try {
            const keys = Object.keys(shownMap);
            if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete shownMap[k];
            localStorage.setItem(SHOWN_KEY, JSON.stringify(shownMap));
          } catch {}
        };
        const keyStr = (k) => (k ? String(k._serialized || k) : "");
        const handled = new Set();

        // Quando chega um "apagar para todos", o WhatsApp chama esta função com a chave da mensagem ORIGINAL
        // (revokeMsgKey) e a do aviso que a substitui (newMsgKey), e só então apaga o conteúdo. Pegamos o texto
        // antes: do que guardamos ou, se a mensagem estiver carregada, direto da coleção.
        const capture = (list) => {
          for (const item of Array.isArray(list) ? list : []) {
            try {
              const orig = item && item.revokeMsgKey;
              if (!orig || orig.fromMe) continue; // você mesmo apagou
              const id = keyStr(orig);
              if (!id || handled.has(id)) continue;
              let hit = cache.get(id);
              if (!hit) {
                const m = C.Msg.get && C.Msg.get(orig);
                if (m) {
                  remember(m);
                  hit = cache.get(id);
                }
              }
              if (!hit) continue; // não estava carregada nesta aba
              handled.add(id);
              const text = hit.text || `[${hit.kind}]`;
              emit("deleted", { chat: hit.chat, from: hit.from, text, kind: hit.kind, sentAt: hit.sentAt });
              const newId = keyStr(item.newMsgKey);
              if (newId) {
                shownMap[newId] = text;
                saveShown();
                scheduleDom();
              }
            } catch {}
          }
        };
        const wrap = (orig) =>
          function (list) {
            try {
              capture(list);
            } catch {}
            return orig.apply(this, arguments);
          };
        const p = patchAll([
          ["WAWebDBProcessRevokeMsgs", "processRevokeMsgsAndGetCleanupEligibleKeys", wrap],
          ["WAWebDBProcessRevokeMsgs", "processRevokeMsgs", wrap],
        ]);

        // Mostra o texto dentro do aviso (o WhatsApp redesenha as linhas: confere sempre)
        domHandlers.set("keepDeleted", {
          errors: 0,
          fn() {
            if (!document.querySelector("#main")) return;
            for (const row of document.querySelectorAll("#main [data-id]")) {
              const text = shownMap[row.getAttribute("data-id")];
              if (!text || row.querySelector(".mh-deleted")) continue;
              const bubble = row.querySelector(".message-in, .message-out") || row;
              bubble.append(el("div", "mh-deleted", "Apagada: " + text));
            }
          },
        });

        for (const m of models(C.Msg)) remember(m);
        const onAdd = (m) => remember(m);
        C.Msg.on("add", onAdd);
        return {
          stop() {
            p.undo();
            try {
              C.Msg.off("add", onAdd);
            } catch {}
            for (const n of document.querySelectorAll(".mh-deleted")) n.remove();
          },
          detail: "vale para mensagens que chegaram ou foram abertas com esta aba aberta",
        };
      },
    },
    // Respostas rápidas: botão ⚡ ao lado da caixa de texto
    {
      id: "quickReplies",
      on: (c) => c.quickReplies,
      key: (c) => JSON.stringify(c.templates || []),
      start(c) {
        const btn = el("button", "mh-btn mh-float", "⚡");
        btn.title = "Respostas rápidas";
        btn.hidden = true;
        document.body.append(btn);
        const fill = (t) => {
          const first = activeChatName().split(/\s+/)[0] || "";
          return t.replace(/\{nome\}/gi, /^\+?\d/.test(first) ? "" : first);
        };
        btn.onclick = () => {
          const templates = c.templates || [];
          showMenu(btn, (m) => {
            if (!templates.length) {
              m.append(el("div", "mh-empty", "Nenhum modelo. Crie em Configurações › WhatsApp."));
              return;
            }
            const search = el("input");
            search.type = "search";
            search.placeholder = "Procurar modelo…";
            const list = el("div");
            const draw = () => {
              list.replaceChildren();
              const q = search.value.toLowerCase();
              for (const t of templates.filter((t) => !q || (t.name + " " + t.text).toLowerCase().includes(q))) {
                const it = el("div", "mh-item");
                const box = el("div");
                box.append(el("div", "", t.name), el("small", "", t.text));
                it.append(box);
                it.onclick = () => {
                  closeMenu();
                  try {
                    insertText(fill(t.text));
                  } catch (err) {
                    report("quickReplies", "warn", err.message);
                  }
                };
                list.append(it);
              }
              if (!list.children.length) list.append(el("div", "mh-empty", "Nada encontrado."));
            };
            search.oninput = draw;
            search.onkeydown = (e) => e.key === "Enter" && list.querySelector(".mh-item") && list.querySelector(".mh-item").click();
            m.append(search, list);
            draw();
            setTimeout(() => search.focus());
          });
        };
        domHandlers.set("quickReplies", {
          errors: 0,
          fn() {
            const box = composer();
            const footer = box && box.closest("footer");
            if (!box) return (btn.hidden = true);
            const r = (footer || box).getBoundingClientRect();
            btn.hidden = false;
            btn.style.left = Math.max(4, r.right - 44) + "px";
            btn.style.top = Math.max(4, r.top - 40) + "px";
          },
        });
        const onResize = () => scheduleDom();
        addEventListener("resize", onResize);
        return {
          stop() {
            btn.remove();
            removeEventListener("resize", onResize);
          },
        };
      },
    },
    // Etiquetas por conversa: botão 🏷 no cabeçalho da conversa e etiquetas coloridas na lista
    {
      id: "labels",
      on: (c) => c.labels,
      key: (c) => JSON.stringify([c.labelDefs, c.chatLabels]),
      start(c) {
        const defs = new Map((c.labelDefs || []).map((l) => [l.id, l]));
        const byChat = c.chatLabels || {};
        const btn = el("button", "mh-btn mh-float", "🏷");
        btn.title = "Etiquetas desta conversa";
        btn.hidden = true;
        document.body.append(btn);
        btn.onclick = () => {
          const chat = activeChatName();
          if (!chat) return;
          const sel = new Set(byChat[chat] || []);
          showMenu(btn, (m) => {
            m.append(el("div", "mh-empty", chat));
            if (!defs.size) m.append(el("div", "mh-empty", "Nenhuma etiqueta. Crie em Configurações › WhatsApp."));
            for (const l of defs.values()) {
              const it = el("div", "mh-item" + (sel.has(l.id) ? " on" : ""));
              const dot = el("span", "mh-dot");
              dot.style.background = l.color;
              it.append(dot, el("span", "", (sel.has(l.id) ? "✓ " : "") + l.name));
              it.onclick = () => {
                sel.has(l.id) ? sel.delete(l.id) : sel.add(l.id);
                byChat[chat] = [...sel];
                emit("labels", { chat, labels: [...sel] });
                closeMenu();
              };
              m.append(it);
            }
          });
        };
        const badge = (ids) => {
          const wrap = el("span", "mh-labels");
          for (const id of ids) {
            const l = defs.get(id);
            if (!l) continue;
            const b = el("span", "mh-label", l.name);
            b.style.background = l.color;
            wrap.append(b);
          }
          return wrap;
        };
        domHandlers.set("labels", {
          errors: 0,
          fn() {
            // Botão no canto do cabeçalho da conversa aberta
            const head = document.querySelector("#main header");
            if (head) {
              const r = head.getBoundingClientRect();
              btn.hidden = false;
              btn.style.left = Math.max(4, r.left + r.width / 2 - 16) + "px";
              btn.style.top = r.top + (r.height - 32) / 2 + "px";
            } else btn.hidden = true;
            // Lista de conversas (as linhas são reaproveitadas ao rolar: confere o nome sempre)
            for (const row of document.querySelectorAll("#pane-side [role=listitem], #pane-side [role=row]")) {
              const t = row.querySelector("span[title]");
              const name = t && t.getAttribute("title");
              const old = row.querySelector(".mh-labels");
              const ids = (name && byChat[name]) || [];
              if (old && old.dataset.k === name + "|" + ids.join()) continue;
              if (old) old.remove();
              if (!ids.length || !t) continue;
              const b = badge(ids);
              b.dataset.k = name + "|" + ids.join();
              t.parentElement.append(b);
            }
          },
        });
        return {
          stop() {
            btn.remove();
            for (const b of document.querySelectorAll(".mh-labels")) b.remove();
          },
        };
      },
    },
    // Mensagens agendadas (o app precisa estar aberto na hora)
    {
      id: "scheduled",
      on: (c) => c.scheduled,
      internals: true,
      key: (c) => JSON.stringify(c.schedule || []),
      start(c) {
        need(["WAWebSendTextMsgChatAction", "sendTextMsgToChat"], ["WAWebFindChatAction", "findOrCreateLatestChat"]);
        const busy = new Set();
        const tick = async () => {
          for (const s of c.schedule || []) {
            if (s.at > Date.now() || busy.has(s.id) || doneJobs.has(s.id)) continue;
            busy.add(s.id);
            doneJobs.add(s.id);
            const late = Date.now() - s.at;
            if (late > 12 * 3600e3) {
              emit("job", { id: s.id, ok: false, error: "O app estava fechado na hora marcada (mais de 12 h de atraso)." });
              continue;
            }
            try {
              await sendText(s.chatId ? { chatId: s.chatId } : { phone: s.phone }, s.text);
              emit("job", { id: s.id, ok: true });
            } catch (err) {
              emit("job", { id: s.id, ok: false, error: err.message || String(err) });
            }
            await sleep(3000);
          }
        };
        const timer = setInterval(() => tick().catch(() => {}), 15000);
        tick().catch(() => {});
        const n = (c.schedule || []).length;
        return { stop: () => clearInterval(timer), detail: n ? `${n} pendente(s)` : "" };
      },
    },
    // Envio em massa (arriscado: desligado por padrão)
    {
      id: "bulk",
      on: (c) => c.bulk,
      internals: true,
      key: (c) => JSON.stringify(c.bulkJob && [c.bulkJob.id, c.bulkJob.status]),
      start(c) {
        need(["WAWebSendTextMsgChatAction", "sendTextMsgToChat"], ["WAWebFindChatAction", "findOrCreateLatestChat"]);
        const job = c.bulkJob;
        let stopped = false;
        if (job) {
          (async () => {
            let fails = 0;
            for (let i = job.next || 0; i < job.numbers.length && !stopped; i++) {
              let ok = false;
              let error = "";
              try {
                await sendText({ phone: job.numbers[i] }, job.text);
                ok = true;
                fails = 0;
              } catch (err) {
                error = err.message || String(err);
                fails++;
              }
              // 3 falhas seguidas: pode ser bloqueio do WhatsApp; para por segurança
              emit("bulk", { jobId: job.id, index: i, ok, error, stop: fails >= 3 });
              if (fails >= 3) break;
              const wait = (job.minDelay + Math.random() * (job.maxDelay - job.minDelay)) * 1000;
              for (let t = 0; t < wait && !stopped; t += 1000) await sleep(1000);
            }
          })();
        }
        return { stop: () => (stopped = true), detail: job ? `enviando ${job.next || 0}/${job.numbers.length}` : "" };
      },
    },
    // Resposta automática (arriscada: desligada por padrão). Só conversas individuais, uma vez por período.
    {
      id: "autoReply",
      on: (c) => c.autoReply,
      internals: true,
      key: (c) => JSON.stringify([c.autoReplyText, c.autoReplyCooldownHours, c.autoReplyOnlyAway]),
      start(c) {
        need(["WAWebSendTextMsgChatAction", "sendTextMsgToChat"]);
        const C = collections();
        if (!C || typeof C.Msg.on !== "function") throw new Error("Coleção de mensagens não encontrada");
        const KEY = "mh-autoreply-v1";
        const last = (() => {
          try {
            return JSON.parse(localStorage.getItem(KEY) || "{}");
          } catch {
            return {};
          }
        })();
        const started = Date.now();
        const onAdd = (m) => {
          try {
            if (!m || !m.id || m.id.fromMe || !m.isNewMsg) return;
            if ((m.t || 0) * 1000 < started - 60000) return; // histórico chegando, não mensagem nova
            const chatId = widStr(m.id.remote);
            if (!/@(c\.us|lid)$/.test(chatId)) return; // nada de grupos, status, canais
            if (c.autoReplyOnlyAway && document.hasFocus()) return;
            const text = String(c.autoReplyText || "").trim();
            if (!text) return;
            const cool = (c.autoReplyCooldownHours || 12) * 3600e3;
            if (Date.now() - (last[chatId] || 0) < cool) return;
            last[chatId] = Date.now();
            try {
              localStorage.setItem(KEY, JSON.stringify(last));
            } catch {}
            setTimeout(() => sendText({ chatId }, text).catch((err) => report("autoReply", "warn", "Falhou ao responder: " + err.message)), 4000 + Math.random() * 8000);
          } catch {}
        };
        C.Msg.on("add", onAdd);
        return {
          stop() {
            try {
              C.Msg.off("add", onAdd);
            } catch {}
          },
        };
      },
    },
  ];
  const doneJobs = new Set(); // agendadas já tentadas nesta página (evita repetir antes da confirmação)

  function need(...pairs) {
    const miss = pairs.filter(([m, f]) => {
      const x = mod(m);
      return !x || typeof x[f] !== "function";
    });
    if (miss.length) throw new Error("A interface do WhatsApp mudou: " + miss.map((p) => p.join(".")).join(", ") + " não encontrados");
  }

  /** Envia texto pelos módulos do próprio WhatsApp (como se você tivesse digitado e enviado). */
  async function sendText(target, text) {
    const C = collections();
    let chat = null;
    if (target.chatId && C && C.Chat.get) chat = C.Chat.get(target.chatId);
    if (!chat) {
      const W = mod("WAWebWidFactory");
      const F = mod("WAWebFindChatAction");
      if (!W || !F) throw new Error("Módulos de conversa não encontrados");
      const id = target.chatId || String(target.phone).replace(/\D/g, "") + "@c.us";
      const wid = W.createWid(id);
      const r = await F.findOrCreateLatestChat(wid);
      chat = (r && r.chat) || r;
    }
    if (!chat) throw new Error("Conversa não encontrada (o número tem WhatsApp?)");
    const S = mod("WAWebSendTextMsgChatAction");
    const res = await S.sendTextMsgToChat(chat, text);
    if (res && res.messageSendResult && String(res.messageSendResult).toUpperCase() !== "OK") throw new Error("WhatsApp recusou: " + res.messageSendResult);
  }

  // ---------- Pedidos das Configurações ----------
  const COMMANDS = {
    listChats() {
      const C = collections();
      if (!C) throw new Error("O WhatsApp ainda não carregou nesta aba.");
      return models(C.Chat)
        .map((ch) => ({ id: widStr(ch.id), name: ch.formattedTitle || ch.name || (ch.contact && (ch.contact.name || ch.contact.pushname)) || widStr(ch.id), group: !!(ch.isGroup || /@g\.us$/.test(widStr(ch.id))), t: ch.t || 0 }))
        .filter((c) => /@(c\.us|g\.us|lid)$/.test(c.id))
        .sort((a, b) => b.t - a.t)
        .slice(0, 500);
    },
    export() {
      const C = collections();
      if (!C || !C.Contact) throw new Error("O WhatsApp ainda não carregou nesta aba.");
      const contacts = [];
      for (const c of models(C.Contact)) {
        const id = widStr(c.id);
        if (!/@c\.us$/.test(id)) continue; // só pessoas (sem grupos, canais e ids internos)
        if (!(c.isMyContact || c.name || c.pushname)) continue;
        contacts.push({ id, number: id.split("@")[0], name: c.name || c.formattedName || "", pushname: c.pushname || "", saved: !!c.isMyContact, business: !!c.isBusiness });
      }
      const groups = [];
      for (const ch of models(C.Chat)) {
        const id = widStr(ch.id);
        if (!/@g\.us$/.test(id)) continue;
        let participants = null;
        try {
          const gm = ch.groupMetadata;
          const p = gm && gm.participants;
          participants = p ? (typeof p.length === "number" ? p.length : models(p).length) : null;
        } catch {}
        groups.push({ id, name: ch.formattedTitle || ch.name || "", participants });
      }
      return { contacts, groups };
    },
  };
  try {
    bridge.onCommand(async (cmd) => {
      try {
        const fn = COMMANDS[cmd && cmd.name];
        if (!fn) throw new Error("Pedido desconhecido");
        emit("reply", { reqId: cmd.reqId, result: await fn(cmd.args || {}) });
      } catch (err) {
        emit("reply", { reqId: cmd.reqId, error: (err && err.message) || String(err) });
      }
    });
  } catch {}

  // ---------- Liga/desliga conforme a configuração ----------
  async function startFeature(f, key) {
    running.set(f.id, { key, stop: null });
    if (f.internals) {
      report(f.id, "waiting", "Aguardando o WhatsApp carregar (conectado nesta aba)");
      if (!(await until(f.id, key, () => loggedIn() && modulesMap()))) return;
    } else if (!(document.body && document.head)) {
      // O script entra antes de a página existir: os recursos visuais esperam o <body>
      if (!(await until(f.id, key, () => document.body && document.head))) return;
    }
    const r = running.get(f.id);
    if (!r || r.key !== key) return;
    try {
      const res = f.start(cfg) || {};
      r.stop = res.stop || null;
      report(f.id, res.detail && /^parcial/.test(res.detail) ? "warn" : "ok", res.detail || "");
    } catch (err) {
      running.delete(f.id);
      domHandlers.delete(f.id);
      report(f.id, "broken", (err && err.message) || String(err));
    }
  }

  function apply() {
    for (const f of FEATURES) {
      let on = false;
      let key = "";
      try {
        on = !!f.on(cfg);
        key = f.key ? f.key(cfg) : "1";
      } catch {}
      const r = running.get(f.id);
      if (!on) {
        if (r) stopFeature(f.id, "off");
        else report(f.id, "off");
        continue;
      }
      if (r && r.key === key) continue;
      if (r) stopFeature(f.id, "off");
      startFeature(f, key);
    }
    scheduleDom();
  }

  try {
    bridge.onConfig((c) => {
      cfg = c || {};
      apply();
    });
  } catch {}
  apply();
})();
