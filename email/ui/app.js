// Interface da aba de E-mail. Todo texto vindo de e-mails entra via textContent (nunca innerHTML).
"use strict";

const api = window.mail;
const $ = (id) => document.getElementById(id);
const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

const FOLDERS = [
  { role: "inbox", name: "Caixa de entrada", icon: "📥" },
  { role: "sent", name: "Enviados", icon: "📤" },
  { role: "drafts", name: "Rascunhos", icon: "📝" },
  { role: "archive", name: "Arquivo", icon: "🗄" },
  { role: "junk", name: "Spam", icon: "⚠" },
  { role: "trash", name: "Lixeira", icon: "🗑" },
];
const COLORS = ["#1f93ff", "#f5a524", "#17c964", "#f31260", "#9353d3", "#06b7db", "#ff7a45", "#8a94a0"];
const STATUS = {
  connecting: ["⟳", "Conectando…"],
  syncing: ["⟳", "Sincronizando…"],
  idle: ["", ""],
  offline: ["●", "Sem conexão"],
  error: ["●", "Erro"],
  auth: ["!", "Login necessário"],
};
const PAGE = 100;

// ---------- Estado (preservado entre trocas de aba e reinícios) ----------
const UI_KEY = "mail.ui.v1";
const ui = Object.assign(
  { accountId: null, role: "inbox", unread: false, flagged: false, attachments: false, q: "", selectedId: null, threads: true, navCollapsed: false },
  (() => {
    try {
      return JSON.parse(localStorage.getItem(UI_KEY)) || {};
    } catch {
      return {};
    }
  })()
);
const saveUi = () => {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {}
};

let accounts = [];
let counts = {};
let cryptoInfo = { available: true };
let googleInfo = { configured: false };
let messages = [];
let hasMore = false;
let loading = false;
let listToken = 0;

const accountById = (id) => accounts.find((a) => a.id === id);

// ---------- Formatação ----------
const fmtTime = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" });
const fmtFull = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const fmtLong = new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeStyle: "short" });
const fmtDayTime = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDateTime = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
/** Data compacta para cabeçalhos: "18:22", "4 de nov., 18:22" ou "04/11/2025, 18:22". */
function mediumDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Hoje, " + fmtTime.format(d);
  if (d.getFullYear() === now.getFullYear()) return fmtDayTime.format(d);
  return fmtDateTime.format(d);
}
function shortDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime.format(d);
  if (d.getFullYear() === now.getFullYear()) return fmtDay.format(d).replace(".", "");
  return fmtFull.format(d);
}
const people = (list) => (list || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
const unreadOf = (accId, role) => {
  if (accId) return (counts[accId] && counts[accId][role]) || 0;
  return Object.values(counts).reduce((n, r) => n + (r[role] || 0), 0);
};
const badge = (n) => (n > 999 ? "999+" : String(n));

// ---------- Navegação ----------
function renderNav() {
  const fl = $("folders");
  fl.replaceChildren();
  const multi = accounts.length > 1;
  const open = new Set(ui.openFolders || []);
  // A pasta da conta selecionada fica sempre aberta, para a seleção aparecer
  if (multi && ui.accountId) open.add(ui.role);

  for (const f of FOLDERS) {
    const withCount = !["sent", "drafts", "trash"].includes(f.role);
    const isOpen = multi && open.has(f.role);
    const li = navItem(h("span", "folder-icon", f.icon), f.name, null, withCount ? unreadOf(null, f.role) : 0, ui.role === f.role && !ui.accountId);
    li.classList.add("folder-row");
    if (ui.role === f.role && ui.accountId) li.classList.add("has-active");

    if (multi) {
      const chev = h("button", "chev" + (isOpen ? " open" : ""), "›");
      chev.title = isOpen ? "Ocultar contas" : "Mostrar contas separadas";
      chev.setAttribute("aria-expanded", String(isOpen));
      chev.onclick = (e) => {
        e.stopPropagation();
        const set = new Set(ui.openFolders || []);
        isOpen ? set.delete(f.role) : set.add(f.role);
        ui.openFolders = [...set];
        // Fechar a pasta da conta selecionada volta para "todas as contas"
        if (isOpen && ui.role === f.role && ui.accountId) return selectFolder(f.role, null);
        saveUi();
        renderNav();
      };
      li.prepend(chev);
    }
    li.onclick = () => selectFolder(f.role, null);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      allAccountsMenu(li);
    };
    fl.append(li);

    if (isOpen) for (const a of accounts) fl.append(accountRow(a, f.role, withCount));
  }
}

/** Linha de uma conta dentro de uma pasta. */
function accountRow(a, role, withCount) {
  const icon = h("span", "swatch acc-icon", (a.name || a.email).trim().charAt(0).toUpperCase());
  icon.style.background = a.color;
  const li = navItem(icon, a.name, null, withCount ? unreadOf(a.id, role) : 0, ui.role === role && ui.accountId === a.id);
  li.classList.add("sub-item");
  li.title = `${a.name}\n${a.email}` + (a.error ? `\n${a.error}` : "");

  const [sym, label] = STATUS[a.status] || STATUS.idle;
  if (sym) {
    const st = h("span", `status ${a.status}`, sym);
    st.title = a.error || label;
    li.insertBefore(st, li.querySelector(".count") || null);
  }
  const more = h("button", "more", "⋯");
  more.title = "Opções da conta";
  more.onclick = (e) => {
    e.stopPropagation();
    accountMenu(a, more);
  };
  li.append(more);
  li.onclick = () => selectFolder(role, a.id);
  li.oncontextmenu = (e) => {
    e.preventDefault();
    accountMenu(a, li);
  };
  return li;
}

function selectFolder(role, accountId) {
  ui.role = role;
  ui.accountId = accountId;
  ui.selectedId = null;
  saveUi();
  renderNav();
  loadList(true);
  renderReader();
}

function navItem(icon, label, sub, count, active) {
  const li = h("li", "nav-item" + (active ? " active" : ""));
  // Dica ao passar o mouse (essencial com o menu recolhido)
  li.title = label + (sub ? `\n${sub}` : "") + (count ? `\n${count} não lida${count > 1 ? "s" : ""}` : "");
  const lb = h("span", "label", label);
  if (sub) lb.append(h("span", "sub", sub));
  li.append(icon, lb);
  if (count) li.append(h("span", "count", badge(count)));
  return li;
}

function selectAccount(id) {
  ui.accountId = id;
  ui.selectedId = null;
  saveUi();
  renderNav();
  loadList(true);
  renderReader();
}

// ---------- Recolher/expandir o menu lateral ----------
function applyNav() {
  $("app").classList.toggle("nav-collapsed", !!ui.navCollapsed);
  const t = $("nav-toggle");
  const label = ui.navCollapsed ? "Expandir menu" : "Recolher menu";
  t.title = label + " ( [ )";
  t.setAttribute("aria-label", label);
  t.setAttribute("aria-expanded", String(!ui.navCollapsed));
}
function toggleNav() {
  ui.navCollapsed = !ui.navCollapsed;
  saveUi();
  applyNav();
  // A largura da leitura mudou: reajusta a altura dos e-mails abertos depois da animação
  setTimeout(() => {
    for (const f of document.querySelectorAll(".c-frame")) if (f._fit) f._fit();
  }, 220);
}
$("nav-toggle").onclick = toggleNav;
applyNav();

// ---------- Menu de conta ----------
function accountMenu(a, anchor) {
  const items = [["Sincronizar agora", () => api.call("syncNow", { accountId: a.id })]];
  if (a.auth === "oauth-google") items.push(["Reconectar com Google", () => openGoogleReconnect(a)]);
  else if (a.status === "auth" || a.status === "offline") items.push(["Tentar de novo", () => api.call("reconnect", { accountId: a.id })]);
  items.push(["Editar…", () => openEdit(a)], ["Remover conta", () => removeAccount(a), "danger-text"]);
  showMenu(items, anchor);
}

// Botão direito em "Todas as contas"
function allAccountsMenu(anchor) {
  const items = [["Adicionar conta…", openAdd]];
  if (accounts.length) items.push(["Sincronizar todas", () => api.call("syncNow", {})]);
  // Com uma conta só não há subitens: as opções dela ficam aqui
  for (const a of accounts) items.push([`Opções de ${a.name}…`, () => accountMenu(a, anchor)]);
  showMenu(items, anchor);
}

function showMenu(items, anchor) {
  const menu = $("menu");
  menu.replaceChildren();
  for (const [label, fn, cls] of items) {
    const b = h("button", cls || "", label);
    b.onclick = () => {
      closeMenu();
      fn();
    };
    menu.append(b);
  }
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  const mh = menu.offsetHeight;
  menu.style.left = Math.min(r.left, innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = (r.bottom + mh > innerHeight ? r.top - mh : r.bottom) + "px";
  setTimeout(() => document.addEventListener("click", closeMenu, { once: true }));
}
function closeMenu() {
  $("menu").hidden = true;
}

async function removeAccount(a) {
  const ok = await confirmDialog(
    `Remover ${a.email}?`,
    "A conta sai do app e o cache local dela é apagado. As mensagens continuam no servidor."
  );
  if (ok) await api.call("removeAccount", { id: a.id });
  if (ui.accountId === a.id) selectAccount(null);
}

// ---------- Lista de mensagens ----------
async function loadList(reset, keepCount) {
  const token = ++listToken;
  if (reset) {
    hasMore = false;
    if (!keepCount) $("messages").scrollTop = 0;
  }
  const limit = reset ? Math.max(PAGE, keepCount || 0) : PAGE;
  const last = !reset && messages[messages.length - 1];
  loading = true;
  try {
    const rows = await api.call("listMessages", {
      accountId: ui.accountId,
      role: ui.role,
      unread: ui.unread,
      flagged: ui.flagged,
      attachments: ui.attachments,
      q: ui.q,
      cursor: last ? { date: last.date, id: last.id } : null,
      limit,
      threads: ui.threads,
    });
    if (token !== listToken) return; // outra consulta mais nova já foi feita
    messages = reset ? rows : messages.concat(rows);
    hasMore = rows.length === limit;
    renderList();
  } catch (err) {
    if (token === listToken) showBanner(err.message);
  } finally {
    if (token === listToken) loading = false;
  }
}

function renderList() {
  const ul = $("messages");
  const scroll = ul.scrollTop;
  ul.replaceChildren();
  const showAccount = !ui.accountId && accounts.length > 1;

  for (const m of messages) {
    const a = accountById(m.account_id);
    const li = h("li", "msg" + (m.seen ? "" : " unread") + (m.id === ui.selectedId ? " selected" : ""));
    li.dataset.id = m.id;
    const bar = h("span", "bar");
    bar.style.background = a ? a.color : "transparent";

    const outgoing = ui.role === "sent" || ui.role === "drafts";
    const to = outgoing ? JSON.parse(m.to_json || "[]") : null;
    const who = outgoing
      ? "Para: " + (to.map((x) => x.name || x.address).join(", ") || "(sem destinatário)")
      : m.from_name || m.from_addr || "(sem remetente)";

    const side = h("span", "side");
    if (showAccount && a) {
      const tag = h("span", "acct", a.name);
      tag.style.color = a.color;
      side.append(tag);
    }
    if (m.has_attachments) side.append(h("span", "", "📎"));
    if (m.flagged) side.append(h("span", "star", "★"));
    side.append(h("span", "", shortDate(m.date)));

    const fromEl = h("span", "from", who);
    if (m.thread_count > 1) fromEl.append(h("span", "tcount", ` ${m.thread_count}`));
    const subj = h("span", "subject", m.subject || "(sem assunto)");
    if (m.snippet) subj.append(h("span", "snip", ` — ${m.snippet}`));
    li.append(bar, fromEl, side, subj);
    li.onclick = () => selectMessage(m.id);
    ul.append(li);
  }
  if (hasMore) ul.append(h("li", "more-row", "Carregando mais…"));
  ul.scrollTop = scroll;
  renderEmpty();
}

function renderEmpty() {
  const empty = $("empty");
  empty.replaceChildren();
  if (messages.length) {
    empty.hidden = true;
    $("messages").hidden = false;
    return;
  }
  empty.hidden = false;
  $("messages").hidden = true;
  if (!accounts.length) {
    empty.append(h("div", "", "Nenhuma conta de e-mail ainda."));
    const b = h("button", "primary", "Adicionar conta");
    b.onclick = openAdd;
    empty.append(b);
  } else if (accounts.some((a) => a.status === "connecting" || a.status === "syncing")) {
    empty.append(h("div", "", "Sincronizando…"));
  } else {
    empty.append(h("div", "", ui.q || ui.unread || ui.flagged || ui.attachments ? "Nada encontrado com esses filtros." : "Pasta vazia."));
  }
}

$("messages").addEventListener("scroll", (e) => {
  const el = e.target;
  if (hasMore && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 300) loadList(false);
});

async function selectMessage(id) {
  ui.selectedId = id;
  saveUi();
  for (const el of $("messages").querySelectorAll(".msg")) el.classList.toggle("selected", Number(el.dataset.id) === id);
  if (ui.role === "drafts") return openComposer("draft", { messageId: id }); // rascunho abre para editar
  renderReader();
}

/** Rola só o contêiner até o item ficar visível. */
function scrollIntoBox(box, el) {
  const b = box.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  if (e.top < b.top) box.scrollTop -= b.top - e.top;
  else if (e.bottom > b.bottom) box.scrollTop += e.bottom - b.bottom;
}

function moveSelection(delta) {
  const i = messages.findIndex((m) => m.id === ui.selectedId);
  const next = messages[i === -1 ? 0 : Math.min(messages.length - 1, Math.max(0, i + delta))];
  if (!next || next.id === ui.selectedId) return;
  selectMessage(next.id);
  const row = $("messages").querySelector(`[data-id="${next.id}"]`);
  if (row) scrollIntoBox($("messages"), row);
}

// ---------- Leitura: conversa ----------
// Mesma lista do serviço: anexos desses tipos só podem ser salvos, nunca abertos pelo app
const BLOCKED_EXT =
  /\.(exe|com|bat|cmd|msi|msix|msp|scr|pif|cpl|hta|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|reg|lnk|url|scf|inf|dll|sys|sh|bash|run|bin|appimage|desktop|deb|rpm|apk|app|command|py|pl|rb|iso|img|vhd|vhdx|docm|xlsm|pptm)$/i;

let thread = null; // { anchorId, accountId, role, subject, messages }
const expanded = new Set();
const bodies = new Map(); // id -> corpo já sanitizado pelo serviço
let readerToken = 0;

async function renderReader(keep) {
  const token = ++readerToken;
  const t = ui.selectedId ? await api.call("getThread", { id: ui.selectedId }).catch(() => null) : null;
  if (token !== readerToken) return;

  const same = keep && thread && t && t.anchorId === thread.anchorId;
  if (same && t.messages.map((m) => m.id).join() === thread.messages.map((m) => m.id).join()) {
    thread = t; // só flags mudaram: atualiza sem recriar os iframes
    renderToolbar();
    return;
  }
  if (!same) {
    expanded.clear();
    if (t) {
      const last = t.messages[t.messages.length - 1];
      for (const m of t.messages) if (!m.seen || m === last || m.id === t.anchorId) expanded.add(m.id);
    }
  }
  thread = t;
  $("reader-empty").hidden = !!t;
  $("thread").hidden = !t;
  if (!t) return;

  $("t-subject").textContent = t.subject || "(sem assunto)";
  const count = $("t-count");
  count.textContent = t.messages.length > 1 ? `${t.messages.length} mensagens` : "";
  renderToolbar();
  $("t-messages").replaceChildren(...t.messages.map(renderCard));

  if (!same) {
    $("reader").scrollTop = 0;
    // Abrir a conversa marca como lida (como no Gmail)
    const unread = t.messages.filter((m) => !m.seen).map((m) => m.id);
    if (unread.length) markSeen(unread, true);
    // Conversa longa: rola até a primeira mensagem aberta
    if (t.messages.length > 2) {
      const first = $("t-messages").querySelector(".card:not(.collapsed)");
      // Rola só o painel de leitura (scrollIntoView também rolaria a página inteira)
      if (first) {
        const r = $("reader");
        r.scrollTop += first.getBoundingClientRect().top - r.getBoundingClientRect().top - 60;
      }
    }
  }
}

function renderCard(m) {
  const a = accountById(thread.accountId);
  const open = expanded.has(m.id);
  const card = h("article", "card" + (open ? "" : " collapsed"));
  card.dataset.id = m.id;

  const head = h("div", "c-head");
  const av = h("div", "avatar", (m.from_name || m.from_addr || "?").trim().charAt(0).toUpperCase());
  av.style.background = a ? a.color : "#5b6b7b";

  const who = h("div", "c-who");
  const from = h("div", "c-from");
  from.title = m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr;
  from.append(h("strong", "c-name", m.from_name || m.from_addr || "(sem remetente)"));
  if (m.from_name) from.append(h("span", "muted small c-addr", `<${m.from_addr}>`));
  who.append(from);
  if (open) {
    // Uma linha cada; a lista completa aparece ao passar o mouse
    const line = (label, list) => {
      const el = h("div", "muted small c-line", `${label}: ` + list.map((x) => x.name || x.address).join(", "));
      el.title = people(list);
      return el;
    };
    if (m.to.length) who.append(line("Para", m.to));
    if (m.cc.length) who.append(line("Cc", m.cc));
  } else {
    who.append(h("div", "muted small c-snip", m.snippet || ""));
  }

  const right = h("div", "c-right");
  if (a && accounts.length > 1) {
    const tag = h("span", "tag", a.name);
    tag.style.background = a.color;
    right.append(tag);
  }
  if (m.has_attachments) right.append(h("span", "", "📎"));
  const date = h("span", "muted small c-date", open ? mediumDate(m.date) : shortDate(m.date));
  date.title = fmtLong.format(new Date(m.date));
  const star = h("button", "star-btn" + (m.flagged ? " on" : ""), m.flagged ? "★" : "☆");
  star.title = m.flagged ? "Remover dos favoritos" : "Favoritar";
  star.onclick = (e) => {
    e.stopPropagation();
    toggleStar([m]);
  };
  right.append(date, star);

  head.append(av, who, right);
  head.onclick = () => {
    if (thread.messages.length === 1) return;
    open ? expanded.delete(m.id) : expanded.add(m.id);
    card.replaceWith(renderCard(m));
  };
  card.append(head);
  if (open) card.append(renderBody(m));
  return card;
}

function frameDoc(html) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
<base target="_blank">
<style>
html,body{margin:0;background:#fff;color:#202124}
body{padding:16px 18px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere;overflow-x:auto}
img{max-width:100%;height:auto}
img[data-remote-src]:not([src]),img:not([src]){visibility:hidden}
table{max-width:100%}
.mh-plain{white-space:pre-wrap;font-family:inherit}
blockquote{margin:8px 0 8px 4px;padding-left:12px;border-left:3px solid #d0d7de;color:#57606a}
a{color:#0b65c2}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:#c9ced6;border-radius:8px;border:2px solid #fff}
::-webkit-scrollbar-thumb:hover{background:#a9b0ba}
::-webkit-scrollbar-button{display:none}
</style></head><body>${html}</body></html>`;
}

function fitFrame(frame) {
  const doc = frame.contentDocument;
  if (!doc || !doc.documentElement) return;
  // Altura do conteúdo (caixa do <html>), não scrollHeight: este nunca é menor que a área visível,
  // então somar algo a ele faria o iframe crescer sem parar
  let last = 0;
  const set = () => {
    const hgt = Math.max(40, Math.ceil(doc.documentElement.getBoundingClientRect().height));
    if (Math.abs(hgt - last) < 2) return;
    last = hgt;
    frame.style.height = hgt + "px";
  };
  set();
  frame._fit = set;
  // A altura muda quando imagens terminam de carregar (eventos "load" não sobem; captura pega todos)
  doc.addEventListener("load", () => requestAnimationFrame(set), true);
  setTimeout(set, 300);
}

// Largura da janela mudou: o texto do e-mail quebra diferente
let fitTimer;
window.addEventListener("resize", () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    for (const f of document.querySelectorAll(".c-frame")) if (f._fit) f._fit();
  }, 100);
});

function renderBody(m) {
  const wrap = h("div", "c-body");
  const b = bodies.get(m.id);
  if (!b) {
    wrap.classList.add("pending");
    wrap.append(h("div", "muted small loading", "Carregando mensagem…"));
    api
      .call("getBody", { id: m.id })
      .then((body) => {
        bodies.set(m.id, body);
        if (wrap.isConnected) wrap.replaceWith(renderBody(m));
      })
      .catch((err) => {
        wrap.replaceChildren(h("div", "err", err.message));
        const retry = h("button", "secondary", "Tentar de novo");
        retry.onclick = () => wrap.replaceWith(renderBody(m));
        wrap.append(retry);
      });
    return wrap;
  }

  if (b.truncated) {
    wrap.append(h("div", "notice", "Mensagem muito grande: só o texto foi carregado. Os anexos estão abaixo."));
  }

  const frame = document.createElement("iframe");
  frame.className = "c-frame";
  // Sem allow-scripts: nada do e-mail executa. allow-same-origin só para medir a altura.
  frame.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = "Conteúdo da mensagem";
  frame.srcdoc = frameDoc(b.html || "");
  frame.addEventListener("load", () => fitFrame(frame));

  if (b.remoteImages) {
    const bar = h("div", "notice");
    bar.append(
      h(
        "span",
        "",
        `${b.remoteImages} ${b.remoteImages === 1 ? "imagem remota bloqueada" : "imagens remotas bloqueadas"} para proteger sua privacidade. `
      )
    );
    const show = h("button", "link", "Mostrar imagens");
    show.onclick = () => showImages(frame, bar, m.id);
    bar.append(show);
    wrap.append(bar);
  }
  wrap.append(frame);
  // Conta com "baixar imagens automaticamente": carrega assim que o e-mail aparece
  // Imagens carregam sozinhas se a conta permite ou se você já as liberou neste e-mail (até fechar o app)
  const acc = accountById(thread.accountId);
  if (b.remoteImages && ((acc && acc.auto_images) || imagesShown.has(m.id))) {
    const bar = wrap.querySelector(".notice .link") && wrap.querySelector(".notice .link").parentElement;
    if (bar) bar.hidden = true; // evita piscar a faixa: as imagens vêm do cache na maioria das vezes
    frame.addEventListener("load", () => bar && showImages(frame, bar, m.id), { once: true });
  }

  const atts = (b.attachments || []).filter((x) => !x.inline);
  if (atts.length) {
    const list = h("div", "c-atts");
    for (const x of atts) list.append(attachmentChip(m, x));
    wrap.append(list);
  }
  return wrap;
}

const imagesShown = new Set(); // ids de mensagens com imagens liberadas nesta sessão

async function showImages(frame, bar, messageId) {
  const doc = frame.contentDocument;
  if (!doc) return;
  if (messageId) imagesShown.add(messageId);
  const imgs = [...doc.querySelectorAll("img[data-remote-src]")];
  bar.replaceChildren(h("span", "", "Carregando imagens…"));
  // Faixa escondida (carregamento automático): só aparece se demorar ou der erro
  const reveal = bar.hidden ? setTimeout(() => (bar.hidden = false), 400) : null;
  try {
    const map = await api.call("fetchImages", { urls: imgs.map((i) => i.getAttribute("data-remote-src")) });
    let failed = 0;
    for (const img of imgs) {
      const data = map[img.getAttribute("data-remote-src")];
      if (data) img.src = data;
      else failed++;
    }
    if (frame._fit) setTimeout(frame._fit, 50);
    if (failed) {
      bar.replaceChildren(h("span", "", `${failed} imagem(ns) não puderam ser carregadas.`));
      bar.hidden = false;
    } else bar.remove();
  } catch (err) {
    bar.replaceChildren(h("span", "", err.message));
    bar.hidden = false;
  } finally {
    clearTimeout(reveal);
  }
}

const fmtSize = (n) =>
  !n ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1).replace(".", ",")} MB`;
function fileIcon(type, name) {
  if (/^image\//.test(type)) return "🖼";
  if (/pdf/.test(type) || /\.pdf$/i.test(name)) return "📕";
  if (/zip|rar|7z|tar|gzip/.test(type)) return "🗜";
  if (/sheet|excel|csv/.test(type) || /\.(xlsx?|csv|ods)$/i.test(name)) return "📊";
  if (/word|document|text/.test(type) || /\.(docx?|odt|txt|rtf)$/i.test(name)) return "📄";
  if (/calendar/.test(type)) return "📅";
  return "📎";
}

function attachmentChip(m, x) {
  const chip = h("div", "att");
  chip.title = x.filename;
  chip.append(h("span", "att-icon", fileIcon(x.contentType, x.filename)));
  const info = h("div", "att-info");
  info.append(h("div", "att-name", x.filename), h("div", "muted small", fmtSize(x.size)));
  chip.append(info);
  const run = async (btn, method, label) => {
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const r = await api.call(method, { id: m.id, part: x.part });
      if (r && r.path) toast(`Salvo em ${r.path}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  if (!BLOCKED_EXT.test(x.filename)) {
    const open = h("button", "link", "Abrir");
    open.onclick = () => run(open, "openAttachment", "Abrir");
    chip.append(open);
  }
  const save = h("button", "link", "Salvar");
  save.onclick = () => run(save, "saveAttachment", "Salvar");
  chip.append(save);
  return chip;
}

// ---------- Ações ----------
function renderToolbar() {
  const role = thread.role;
  const set = (act, label, visible = true) => {
    const b = document.querySelector(`#thread [data-act="${act}"]`);
    b.hidden = !visible;
    if (label) b.textContent = label;
  };
  set("archive", role === "archive" ? "Mover para a entrada" : role === "trash" ? "Restaurar" : "Arquivar", ["inbox", "archive", "trash"].includes(role));
  set("trash", role === "trash" ? "Excluir para sempre" : "Excluir");
  set("spam", role === "junk" ? "Não é spam" : "Spam", ["inbox", "archive", "junk"].includes(role));
  const anyFlag = thread.messages.some((m) => m.flagged);
  set("star", anyFlag ? "★ Favorita" : "☆ Favoritar");
}

const idsInFolder = () => thread.messages.filter((m) => m.role === thread.role).map((m) => m.id);
const lastInFolder = () => [...thread.messages].reverse().find((m) => m.role === thread.role) || thread.messages[thread.messages.length - 1];

async function doAction(act, anchor) {
  if (!thread) return;
  if (act === "reply" || act === "replyAll" || act === "forward") {
    // Responde à mensagem mais recente da conversa (pela conta que a recebeu)
    const last = thread.messages[thread.messages.length - 1];
    return openComposer(act, { messageId: last.id });
  }
  const ids = idsInFolder();
  try {
    if (act === "archive") {
      if (thread.role === "inbox") await api.call("archive", { ids });
      else await api.call("spam", { ids, spam: false }); // de volta para a Caixa de entrada
      afterRemove(thread.role === "inbox" ? "Conversa arquivada." : "Movida para a Caixa de entrada.");
    } else if (act === "trash") {
      if (thread.role === "trash") {
        const ok = await confirmDialog("Excluir para sempre?", "A conversa será apagada do servidor e não poderá ser recuperada.");
        if (!ok) return;
        await api.call("deleteForever", { ids });
        afterRemove("Excluída para sempre.");
      } else {
        await api.call("trash", { ids });
        afterRemove("Movida para a Lixeira.");
      }
    } else if (act === "spam") {
      const toSpam = thread.role !== "junk";
      await api.call("spam", { ids, spam: toSpam });
      afterRemove(toSpam ? "Marcada como spam." : "Movida para a Caixa de entrada.");
    } else if (act === "unread") {
      const m = lastInFolder();
      await markSeen([m.id], false);
      toast("Marcada como não lida.");
    } else if (act === "star") {
      const flagged = thread.messages.filter((m) => m.flagged);
      toggleStar(flagged.length ? flagged : [lastInFolder()]);
    } else if (act === "move") {
      moveMenu(anchor);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/** Remove a conversa da lista e abre a próxima. */
function afterRemove(msg) {
  const i = messages.findIndex((m) => m.id === ui.selectedId);
  if (i !== -1) messages.splice(i, 1);
  const next = messages[i] || messages[i - 1] || null;
  ui.selectedId = next ? next.id : null;
  saveUi();
  renderList();
  renderReader();
  if (msg) toast(msg);
}

async function markSeen(ids, seen) {
  for (const m of thread ? thread.messages : []) if (ids.includes(m.id)) m.seen = seen ? 1 : 0;
  const row = messages.find((r) => r.id === ui.selectedId);
  if (row) {
    row.seen = thread && thread.messages.some((m) => !m.seen) ? 0 : 1;
    renderList();
  }
  try {
    await api.call("setSeen", { ids, seen });
  } catch (err) {
    toast(err.message, true);
  }
}

async function toggleStar(list) {
  const flagged = !list.some((m) => m.flagged);
  try {
    await api.call("setFlagged", { ids: list.map((m) => m.id), flagged });
    for (const m of list) m.flagged = flagged ? 1 : 0;
    const row = messages.find((r) => r.id === ui.selectedId);
    if (row) row.flagged = thread.messages.some((m) => m.flagged) ? 1 : 0;
    renderList();
    for (const m of list) {
      const card = $("t-messages").querySelector(`.card[data-id="${m.id}"] .star-btn`);
      if (card) {
        card.textContent = m.flagged ? "★" : "☆";
        card.classList.toggle("on", !!m.flagged);
      }
    }
    renderToolbar();
  } catch (err) {
    toast(err.message, true);
  }
}

const FOLDER_LABEL = { inbox: "Caixa de entrada", sent: "Enviados", drafts: "Rascunhos", archive: "Arquivo", junk: "Spam", trash: "Lixeira" };
async function moveMenu(anchor) {
  const t = thread;
  let folders = [];
  try {
    folders = await api.call("listFolders", { accountId: t.accountId });
  } catch (err) {
    return toast(err.message, true);
  }
  const items = folders
    .filter((f) => f.role !== t.role && f.role !== "drafts" && f.role !== "sent")
    .sort((a, b) => (a.role ? 0 : 1) - (b.role ? 0 : 1) || a.path.localeCompare(b.path))
    .map((f) => [
      f.role ? FOLDER_LABEL[f.role] : f.path.split(f.delimiter || "/").join(" / "),
      async () => {
        try {
          await api.call("move", { ids: idsInFolder(), folderId: f.id });
          afterRemove(`Movida para ${f.role ? FOLDER_LABEL[f.role] : f.name}.`);
        } catch (err) {
          toast(err.message, true);
        }
      },
    ]);
  if (!items.length) return toast("Não há outras pastas nesta conta.");
  showMenu(items, anchor);
}

for (const b of document.querySelectorAll("#thread [data-act]")) {
  b.onclick = (e) => {
    e.stopPropagation();
    doAction(b.dataset.act, b);
  };
}

// Atalhos (fora de campos de texto): j/k navegam, e arquiva, # exclui, u não lida, s favorita, ! spam
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || !$("overlay").hidden) return;
  if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
  if (e.key === "[") {
    e.preventDefault();
    return toggleNav();
  }
  if (!$("composer").hidden) return; // escrevendo: atalhos da leitura desligados
  if (e.key === "c") {
    e.preventDefault();
    return openComposer("new");
  }
  const replies = { r: "reply", a: "replyAll", f: "forward" };
  if (replies[e.key] && thread) {
    e.preventDefault();
    return doAction(replies[e.key]);
  }
  const nav = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
  if (e.key in nav) {
    e.preventDefault();
    return moveSelection(nav[e.key]);
  }
  const acts = { e: "archive", "#": "trash", Delete: "trash", u: "unread", s: "star", "!": "spam" };
  if (acts[e.key] && thread) {
    e.preventDefault();
    const btn = document.querySelector(`#thread [data-act="${acts[e.key]}"]`);
    if (btn && !btn.hidden) doAction(acts[e.key], btn);
  }
});

let toastTimer;
function toast(text, error, action, ms) {
  const t = $("toast");
  t.textContent = text;
  if (action) {
    const b = h("button", "undo", action.label);
    b.onclick = () => {
      t.hidden = true;
      action.fn();
    };
    t.append(b);
  }
  t.classList.toggle("error", !!error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms || (error ? 6000 : 3000));
}


// ---------- Escrever / responder / encaminhar ----------
const CP_KEY = "mail.compose.v1";
const CP_TITLES = { new: "Nova mensagem", reply: "Responder", replyAll: "Responder a todos", forward: "Encaminhar", draft: "Rascunho" };
const MAX_ATTACH = 25 * 1024 * 1024;
let cp = null; // composição aberta
let pendingSend = null; // { composeId, snap } durante os 5 s de "Desfazer"
let saveTimer = null;
let persistTimer = null;

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtAddr = (a) => (a.name ? `${/[,;"<>@]/.test(a.name) ? `"${a.name.replace(/"/g, "")}"` : a.name} <${a.address}>` : a.address);
const rcptText = (list) => (list && list.length ? list.map(fmtAddr).join(", ") + ", " : "");

function defaultAccountId() {
  let last = null;
  try {
    last = Number(localStorage.getItem("mail.lastFrom"));
  } catch {}
  return ui.accountId || (accountById(last) ? last : accounts[0] && accounts[0].id);
}

function signatureHtml(accountId) {
  const a = accountById(Number(accountId));
  if (!a || !a.signature || !a.signature.trim()) return "";
  return `<div class="mh-sig">-- <br>${escapeHtml(a.signature).replace(/\n/g, "<br>")}</div>`;
}

function fillFrom(accountId) {
  const sel = $("cp-from");
  sel.replaceChildren();
  for (const a of accounts) {
    const o = h("option", "", `${a.sender_name || a.name} <${a.email}>`);
    o.value = a.id;
    sel.append(o);
  }
  sel.value = String(accountId);
}

function setStatus(text) {
  $("cp-status").textContent = text || "";
}

function snapshot() {
  return {
    composeId: cp.composeId,
    mode: cp.mode,
    title: $("cp-title").textContent,
    accountId: Number($("cp-from").value),
    to: $("cp-to").value,
    cc: $("cp-cc").value,
    bcc: $("cp-bcc").value,
    subject: $("cp-subject").value,
    html: $("cp-editor").innerHTML,
    attachments: cp.attachments,
    draft: cp.draft,
  };
}

/** Mostra o editor com um estado já conhecido (restaurar após "Desfazer", falha ou F5). */
function showComposer(state) {
  cp = {
    composeId: state.composeId,
    mode: state.mode,
    attachments: state.attachments || [],
    draft: state.draft || null,
    version: 0,
    savedVersion: 0,
  };
  fillFrom(state.accountId);
  $("cp-title").textContent = state.title || CP_TITLES[state.mode] || CP_TITLES.new;
  $("cp-to").value = state.to || "";
  $("cp-cc").value = state.cc || "";
  $("cp-bcc").value = state.bcc || "";
  $("cp-cc-row").hidden = !state.cc;
  $("cp-bcc-row").hidden = !state.bcc;
  $("cp-subject").value = state.subject || "";
  $("cp-editor").innerHTML = state.html || "<div><br></div>";
  renderAtts();
  setStatus("");
  $("composer").hidden = false;
}

async function openComposer(mode, opts = {}) {
  if (!accounts.length) return openAdd();
  if (cp && !$("composer").hidden) await closeComposer(true); // a atual vira rascunho
  let data;
  try {
    data = await api.call("composeStart", {
      mode,
      messageId: opts.messageId,
      accountId: opts.restore ? opts.restore.accountId : opts.accountId || defaultAccountId(),
      draft: opts.restore ? opts.restore.draft : undefined,
    });
  } catch (err) {
    return toast(err.message, true);
  }
  if (opts.restore) {
    showComposer({ ...opts.restore, composeId: data.composeId, attachments: [], mode: "new" });
    markDirty(); // o texto restaurado pode ainda não estar no servidor: salva de novo
    if (opts.restore.attachmentsCount) toast("A mensagem foi restaurada. Anexe os arquivos de novo.", true);
    focusEnd($("cp-to"));
    return;
  }
  const sig = signatureHtml(data.accountId);
  const html =
    mode === "draft"
      ? data.html
      : `<div><br></div>${sig ? "<div><br></div>" + sig : ""}${data.quote ? "<div><br></div>" + data.quote : ""}`;
  showComposer({
    composeId: data.composeId,
    mode,
    accountId: data.accountId,
    to: rcptText(data.to),
    cc: rcptText(data.cc),
    bcc: rcptText(data.bcc),
    subject: data.subject,
    html,
    attachments: data.attachments,
  });
  if (data.skipped && data.skipped.length) toast(`Fora do limite de 25 MB, não anexados: ${data.skipped.join(", ")}`, true);
  if (!$("cp-to").value.trim()) $("cp-to").focus();
  else editorToStart();
  persist();
}

function editorToStart() {
  const ed = $("cp-editor");
  ed.focus();
  const r = document.createRange();
  r.setStart(ed.firstChild || ed, 0);
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  document.querySelector(".cp-paper").scrollTop = 0;
}
function focusEnd(input) {
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function payload() {
  return {
    composeId: cp.composeId,
    accountId: Number($("cp-from").value),
    to: $("cp-to").value,
    cc: $("cp-cc").value,
    bcc: $("cp-bcc").value,
    subject: $("cp-subject").value,
    html: $("cp-editor").innerHTML,
    text: $("cp-editor").innerText,
  };
}

function markDirty() {
  if (!cp) return;
  cp.version++;
  setStatus("");
  persist();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 4000); // salva no servidor 4 s depois da última alteração
}

async function saveDraft() {
  clearTimeout(saveTimer);
  if (!cp || cp.version === cp.savedVersion) return;
  const c = cp;
  const v = c.version;
  setStatus("Salvando rascunho…");
  try {
    const r = await api.call("composeSaveDraft", payload());
    c.savedVersion = v;
    c.draft = r.draft;
    if (cp === c) {
      setStatus(`Rascunho salvo às ${fmtTime.format(new Date(r.savedAt))}`);
      persist();
    }
  } catch (err) {
    if (cp === c) setStatus("Rascunho não salvo: " + err.message);
  }
}

/** Guarda o que está sendo escrito (sobrevive a F5); os anexos ficam no rascunho do servidor. */
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      if (!cp || $("composer").hidden) return localStorage.removeItem(CP_KEY);
      const s = snapshot();
      localStorage.setItem(CP_KEY, JSON.stringify({ ...s, attachments: undefined, attachmentsCount: cp.attachments.length }));
    } catch {}
  }, 300);
}

function hideComposer() {
  $("composer").hidden = true;
  hideSuggest();
  cp = null;
  try {
    localStorage.removeItem(CP_KEY);
  } catch {}
}

/** Fechar: o que foi escrito fica como rascunho; se nada foi escrito, não sobra nada. */
async function closeComposer(silent) {
  if (!cp) return hideComposer();
  const c = cp;
  if (c.version !== c.savedVersion) await saveDraft();
  if (!c.draft && c.version === 0 && c.mode !== "draft") api.call("composeDiscard", { composeId: c.composeId }).catch(() => {});
  hideComposer();
  if (!silent && c.draft) toast("Rascunho salvo.");
  if (ui.role === "drafts") loadList(true, messages.length);
}

async function discardComposer() {
  if (!cp) return;
  const c = cp;
  if ((c.version || c.draft || c.mode === "draft") && !(await confirmDialog("Descartar esta mensagem?", "O texto e o rascunho salvo serão apagados."))) return;
  clearTimeout(saveTimer);
  hideComposer();
  try {
    await api.call("composeDiscard", { composeId: c.composeId });
    toast("Mensagem descartada.");
  } catch (err) {
    toast(err.message, true);
  }
}

async function sendComposer() {
  if (!cp) return;
  const p = payload();
  if (!(p.to + p.cc + p.bcc).replace(/[\s,;]/g, "")) {
    toast("Informe pelo menos um destinatário.", true);
    return $("cp-to").focus();
  }
  if (!p.subject.trim() && !(await confirmDialog("Enviar sem assunto?", "A mensagem não tem assunto."))) return;
  clearTimeout(saveTimer);
  const snap = snapshot();
  const btn = $("cp-send");
  btn.disabled = true;
  try {
    const r = await api.call("composeSend", p);
    pendingSend = { composeId: p.composeId, snap };
    try {
      localStorage.setItem("mail.lastFrom", String(p.accountId));
    } catch {}
    hideComposer();
    toast("Enviando…", false, { label: "Desfazer", fn: undoSend }, r.undoMs || 5000);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function undoSend() {
  if (!pendingSend) return;
  const { composeId, snap } = pendingSend;
  const r = await api.call("composeCancelSend", { composeId }).catch(() => ({ cancelled: false }));
  if (!r.cancelled) return toast("A mensagem já tinha sido enviada.");
  pendingSend = null;
  if (cp && !$("composer").hidden) await closeComposer(true);
  showComposer(snap);
  toast("Envio cancelado. A mensagem voltou para edição.");
}

api.on("compose-sent", ({ composeId }) => {
  if (pendingSend && pendingSend.composeId === composeId) pendingSend = null;
  toast("Mensagem enviada.");
});
api.on("compose-failed", async ({ composeId, error }) => {
  if (!pendingSend || pendingSend.composeId !== composeId) return toast("Falha ao enviar: " + error, true);
  const { snap } = pendingSend;
  pendingSend = null;
  if (cp && !$("composer").hidden) await closeComposer(true);
  showComposer(snap);
  toast("Não foi enviada: " + error, true, null, 10000);
});

// ---------- Anexos ----------
function renderAtts() {
  const box = $("cp-atts");
  box.replaceChildren();
  const list = cp ? cp.attachments : [];
  box.hidden = !list.length;
  for (const a of list) {
    const chip = h("div", "att");
    chip.title = a.filename;
    chip.append(h("span", "att-icon", fileIcon(a.contentType, a.filename)));
    const info = h("div", "att-info");
    info.append(h("div", "att-name", a.filename), h("div", "muted small", fmtSize(a.size)));
    const rm = h("button", "rm", "✕");
    rm.title = "Remover anexo";
    rm.onclick = async () => {
      cp.attachments = cp.attachments.filter((x) => x.id !== a.id);
      renderAtts();
      markDirty();
      api.call("composeRemoveAttachment", { composeId: cp.composeId, id: a.id }).catch(() => {});
    };
    chip.append(info, rm);
    box.append(chip);
  }
  if (list.length) {
    const total = list.reduce((n, a) => n + a.size, 0);
    box.append(h("span", "muted small total", `${fmtSize(total)} de 25 MB`));
  }
}

async function addFiles(files) {
  if (!cp) return;
  const c = cp;
  for (const f of files) {
    const used = c.attachments.reduce((n, a) => n + a.size, 0);
    if (used + f.size > MAX_ATTACH) {
      toast(`"${f.name}" não cabe: o limite é 25 MB de anexos por mensagem.`, true);
      continue;
    }
    setStatus(`Anexando ${f.name}…`);
    try {
      const data = new Uint8Array(await f.arrayBuffer());
      const a = await api.call("composeAddAttachment", { composeId: c.composeId, filename: f.name, contentType: f.type, data });
      c.attachments.push(a);
      if (cp === c) renderAtts();
      markDirty();
    } catch (err) {
      toast(err.message, true);
    }
  }
  if (cp === c) setStatus("");
}

$("cp-attach").onclick = () => $("cp-file").click();
$("cp-file").onchange = (e) => {
  addFiles([...e.target.files]);
  e.target.value = "";
};

// Arrastar arquivos para a janela de escrita
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
$("composer").addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("cp-drop").hidden = false;
});
$("composer").addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
$("composer").addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("cp-drop").hidden = true;
  }
});
$("composer").addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("cp-drop").hidden = true;
  addFiles([...e.dataTransfer.files]);
});
// Arquivo solto fora da área de escrita não deve abrir nada
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// ---------- Editor ----------
const editor = $("cp-editor");
editor.addEventListener("input", markDirty);
for (const id of ["cp-to", "cp-cc", "cp-bcc", "cp-subject"]) $(id).addEventListener("input", markDirty);

// Imagem colada (print da tela) vai embutida na mensagem
editor.addEventListener("paste", (e) => {
  const img = [...(e.clipboardData ? e.clipboardData.files : [])].find((f) => f.type.startsWith("image/"));
  if (!img) return;
  e.preventDefault();
  if (img.size > 3 * 1024 * 1024) return toast("Imagem grande demais para colar (máx. 3 MB). Use Anexar.", true);
  const reader = new FileReader();
  reader.onload = () => document.execCommand("insertImage", false, reader.result);
  reader.readAsDataURL(img);
});

let savedRange = null;
for (const b of document.querySelectorAll(".cp-toolbar [data-cmd]")) {
  b.addEventListener("mousedown", (e) => e.preventDefault()); // não tira o foco do texto
  b.onclick = async () => {
    const cmd = b.dataset.cmd;
    if (cmd === "link") {
      const sel = getSelection();
      savedRange = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
      const url = await promptDialog("Inserir link", "https://", savedRange && /^https?:\/\//.test(String(savedRange)) ? String(savedRange) : "");
      if (!url) return;
      editor.focus();
      if (savedRange) {
        sel.removeAllRanges();
        sel.addRange(savedRange);
      }
      const href = /^(https?:|mailto:)/i.test(url) ? url : "https://" + url;
      if (sel.isCollapsed) document.execCommand("insertHTML", false, `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`);
      else document.execCommand("createLink", false, href);
    } else {
      editor.focus();
      document.execCommand(cmd);
    }
    markDirty();
  };
}

// Trocar a conta remetente troca a assinatura
$("cp-from").onchange = () => {
  const old = editor.querySelector(".mh-sig");
  const sig = signatureHtml($("cp-from").value);
  if (old) {
    if (sig) old.outerHTML = sig;
    else old.remove();
  } else if (sig) {
    const quoteStart = [...editor.children].find((el) => el.tagName === "BLOCKQUOTE" || /Mensagem encaminhada|escreveu:$/.test(el.textContent));
    const box = document.createElement("div");
    box.innerHTML = "<div><br></div>" + sig;
    for (const n of [...box.childNodes]) quoteStart ? editor.insertBefore(n, quoteStart) : editor.append(n);
  }
  markDirty();
};

$("cp-show-cc").onclick = () => {
  $("cp-cc-row").hidden = false;
  $("cp-bcc-row").hidden = false;
  $("cp-cc").focus();
};
$("cp-send").onclick = sendComposer;
$("cp-discard").onclick = discardComposer;
$("cp-close").onclick = () => closeComposer(false);
$("compose").onclick = () => openComposer("new");
$("composer").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    sendComposer();
  } else if (e.key === "Escape" && $("suggest").hidden && $("overlay").hidden) {
    e.preventDefault();
    closeComposer(false);
  }
});

// ---------- Sugestão de destinatários ----------
const sug = { input: null, items: [], index: 0, timer: null };
function hideSuggest() {
  $("suggest").hidden = true;
  sug.items = [];
}
function currentToken(input) {
  const v = input.value.slice(0, input.selectionStart);
  return v.slice(Math.max(v.lastIndexOf(","), v.lastIndexOf(";")) + 1).trim();
}
function chooseSuggestion(item) {
  const input = sug.input;
  const before = input.value.slice(0, input.selectionStart);
  const after = input.value.slice(input.selectionStart).replace(/^[^,;]*[,;]?\s*/, "");
  const cut = Math.max(before.lastIndexOf(","), before.lastIndexOf(";")) + 1;
  const head = before.slice(0, cut).trimEnd();
  input.value = (head ? head + " " : "") + fmtAddr(item) + ", " + after;
  const pos = input.value.length - after.length;
  input.setSelectionRange(pos, pos);
  hideSuggest();
  markDirty();
}
function renderSuggest() {
  const box = $("suggest");
  box.replaceChildren();
  sug.items.forEach((it, i) => {
    const b = h("button", i === sug.index ? "on" : "");
    b.type = "button";
    b.append(h("span", "", it.name || it.address));
    if (it.name) b.append(h("span", "s-addr", it.address));
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      chooseSuggestion(it);
    });
    box.append(b);
  });
  const r = sug.input.getBoundingClientRect();
  box.style.left = r.left + "px";
  box.style.top = r.bottom + 2 + "px";
  box.hidden = !sug.items.length;
}
for (const input of document.querySelectorAll(".rcpt")) {
  input.addEventListener("input", () => {
    clearTimeout(sug.timer);
    const q = currentToken(input);
    if (q.length < 2) return hideSuggest();
    sug.timer = setTimeout(async () => {
      const already = input.value.toLowerCase();
      const items = (await api.call("contacts", { q }).catch(() => [])).filter((x) => !already.includes(x.address + ">") && !already.includes(x.address + ","));
      if (currentToken(input) !== q) return;
      sug.input = input;
      sug.items = items;
      sug.index = 0;
      renderSuggest();
    }, 150);
  });
  input.addEventListener("keydown", (e) => {
    if ($("suggest").hidden || sug.input !== input) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sug.index = (sug.index + (e.key === "ArrowDown" ? 1 : -1) + sug.items.length) % sug.items.length;
      renderSuggest();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      chooseSuggestion(sug.items[sug.index]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideSuggest();
    }
  });
  input.addEventListener("blur", () => setTimeout(hideSuggest, 150));
}

// ---------- Pergunta com campo de texto (link) ----------
function promptDialog(title, placeholder, value) {
  return new Promise((resolve) => {
    const dlg = h("div", "dialog");
    dlg.append(h("h2", "", title));
    const input = h("input");
    input.placeholder = placeholder || "";
    input.value = value || "";
    const row = h("div", "row");
    const no = h("button", "secondary", "Cancelar");
    const yes = h("button", "primary", "OK");
    row.append(no, yes);
    dlg.append(input, row);
    const ov = $("overlay");
    const prev = [...ov.children].map((c) => [c, c.hidden]);
    for (const [c] of prev) c.hidden = true;
    ov.append(dlg);
    ov.hidden = false;
    const done = (v) => {
      dlg.remove();
      for (const [c, hid] of prev) c.hidden = hid;
      ov.hidden = true;
      resolve(v);
    };
    no.onclick = () => done(null);
    yes.onclick = () => done(input.value.trim());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value.trim());
      if (e.key === "Escape") {
        e.stopPropagation();
        done(null);
      }
    });
    setTimeout(() => input.focus());
  });
}

// Restaura uma mensagem que estava sendo escrita antes de recarregar a aba
let composeRestored = false;
async function restoreComposer() {
  if (composeRestored) return;
  composeRestored = true;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(CP_KEY));
  } catch {}
  if (saved && accounts.length) openComposer("new", { restore: saved });
}

// ---------- Filtros e busca ----------
for (const chip of document.querySelectorAll(".chip")) {
  const key = chip.dataset.filter;
  chip.classList.toggle("on", !!ui[key]);
  chip.onclick = () => {
    ui[key] = !ui[key];
    chip.classList.toggle("on", ui[key]);
    saveUi();
    loadList(true);
  };
}
const search = $("search");
search.value = ui.q || "";
let searchTimer;
search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    ui.q = search.value;
    saveUi();
    loadList(true);
  }, 250);
});
$("refresh").onclick = () => api.call("syncNow", { accountId: ui.accountId });

function showBanner(text) {
  const b = $("banner");
  b.textContent = text || "";
  b.hidden = !text;
}
function renderBanner() {
  if (!cryptoInfo.available) return showBanner("O chaveiro do sistema não está disponível: não é possível salvar contas com segurança.");
  if (cryptoInfo.backend === "basic_text")
    return showBanner("Sem chaveiro do sistema (GNOME Keyring/KWallet): as senhas ficam só ofuscadas no disco. Instale/ative um chaveiro.");
  const bad = accounts.filter((a) => a.status === "auth");
  showBanner(bad.length ? `${bad.map((a) => a.email).join(", ")}: ${bad[0].error || "login necessário"}` : "");
}

// ---------- Diálogos ----------
let dialogResolve = null;
function showDialog(id) {
  $("overlay").hidden = false;
  for (const d of document.querySelectorAll(".dialog")) d.hidden = d.id !== id;
}
function closeDialog() {
  $("overlay").hidden = true;
  if (googleWaiting) api.call("cancelGoogle");
  googleWaiting = false;
  if (dialogResolve) dialogResolve(false);
  dialogResolve = null;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("overlay").hidden) closeDialog();
  if (e.key === "Escape") closeMenu();
});
for (const b of document.querySelectorAll("[data-close]")) b.onclick = closeDialog;

function confirmDialog(title, text) {
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  showDialog("dlg-confirm");
  return new Promise((resolve) => {
    dialogResolve = resolve;
    $("confirm-yes").onclick = () => {
      dialogResolve = null;
      $("overlay").hidden = true;
      resolve(true);
    };
    $("confirm-no").onclick = closeDialog;
  });
}

// ---------- Adicionar conta ----------
const STEPS = ["step-provider", "step-gmail", "step-gmail-tutorial", "step-google-client", "step-google-wait", "step-password"];
const stepHistory = [];
let provider = null;
let googleWaiting = false;
let reconnectAccount = null;

function step(id, push = true) {
  const current = STEPS.find((s) => !$(s).hidden);
  if (push && current && current !== id) stepHistory.push(current);
  for (const s of STEPS) $(s).hidden = s !== id;
  for (const e of $(id).querySelectorAll(".err")) e.textContent = "";
  const first = $(id).querySelector("input");
  if (first) setTimeout(() => first.focus());
}
for (const b of document.querySelectorAll("[data-back]")) {
  b.onclick = () => step(stepHistory.pop() || "step-provider", false);
}

function openAdd() {
  if (!cryptoInfo.available) return renderBanner();
  stepHistory.length = 0;
  reconnectAccount = null;
  $("dlg-add").querySelector("h2").textContent = "Adicionar conta";
  showDialog("dlg-add");
  step("step-provider", false);
}
$("add-account").onclick = openAdd;
$("add-account-top").onclick = openAdd;

for (const b of document.querySelectorAll(".provider")) {
  b.onclick = () => {
    provider = b.dataset.provider;
    if (provider === "gmail") return step("step-gmail");
    preparePasswordForm();
  };
}

const PRESETS = {
  gmail: { imap_host: "imap.gmail.com", imap_port: 993, smtp_host: "smtp.gmail.com", smtp_port: 465 },
  locaweb: { imap_host: "email-ssl.com.br", imap_port: 993, smtp_host: "email-ssl.com.br", smtp_port: 465 },
  imap: { imap_host: "", imap_port: 993, smtp_host: "", smtp_port: 465 },
};
function preparePasswordForm() {
  const f = $("step-password");
  f.reset();
  const p = PRESETS[provider];
  for (const k of Object.keys(p)) f.elements[k].value = p[k];
  f.elements.password.previousSibling.textContent = provider === "gmail" ? "Senha de app (16 letras) " : "Senha ";
  $("gmail-hint").hidden = provider !== "gmail";
  $("advanced").open = provider === "imap";
  for (const k of ["imap_host", "smtp_host"]) f.elements[k].required = provider === "imap";
  step("step-password");
}
$("gmail-password").onclick = () => step("step-gmail-tutorial");
$("gmail-tutorial-next").onclick = preparePasswordForm;

// Sugere servidores ao digitar o e-mail num provedor genérico
$("step-password").elements.email.addEventListener("change", (e) => {
  const f = $("step-password");
  const dom = (e.target.value.split("@")[1] || "").toLowerCase();
  if (provider === "imap" && dom && !f.elements.imap_host.value) {
    f.elements.imap_host.value = "imap." + dom;
    f.elements.smtp_host.value = "smtp." + dom;
  }
});
$("step-password").elements.smtp_secure.addEventListener("change", (e) => {
  $("step-password").elements.smtp_port.value = e.target.value === "ssl" ? 465 : 587;
});

$("step-password").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector("[type=submit]");
  const err = f.querySelector(".err");
  const v = Object.fromEntries(new FormData(f));
  const p = PRESETS[provider];
  const advanced =
    provider === "imap" ||
    v.imap_host !== p.imap_host ||
    v.smtp_host !== p.smtp_host ||
    Number(v.imap_port) !== p.imap_port ||
    Number(v.smtp_port) !== p.smtp_port ||
    v.smtp_secure !== "ssl";
  btn.disabled = true;
  btn.textContent = "Testando conexão…";
  err.textContent = "";
  try {
    const r = await api.call("addPasswordAccount", {
      provider,
      email: v.email,
      password: v.password,
      name: v.name,
      username: v.username,
      advanced,
      imap_host: v.imap_host,
      imap_port: Number(v.imap_port),
      imap_secure: true,
      smtp_host: v.smtp_host,
      smtp_port: Number(v.smtp_port),
      smtp_secure: v.smtp_secure === "ssl",
      autoImages: f.elements.autoImages.checked,
      senderName: v.senderName,
    });
    f.reset();
    closeDialog();
    await refreshState();
    selectAccount(r.id);
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Conectar";
  }
};

// Gmail via OAuth2
$("gmail-oauth").onclick = () => {
  if (googleInfo.configured) googleWaitStep();
  else step("step-google-client");
};
$("step-google-client").onsubmit = async (e) => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target));
  try {
    await api.call("setGoogleClient", v);
    googleInfo.configured = true;
    e.target.reset();
    googleWaitStep();
  } catch (ex) {
    e.target.querySelector(".err").textContent = ex.message;
  }
};
function googleWaitStep() {
  step("step-google-wait");
  $("google-name").parentElement.hidden = !!reconnectAccount;
  $("google-images-label").hidden = !!reconnectAccount;
  $("google-sender").parentElement.hidden = !!reconnectAccount;
  $("google-wait-text").textContent = reconnectAccount
    ? `Entre novamente com ${reconnectAccount.email} no navegador.`
    : "O login abre no seu navegador. Conclua lá e volte para cá.";
  $("google-go").disabled = false;
  $("google-go").textContent = "Abrir login do Google";
}
$("google-go").onclick = async () => {
  const errEl = $("step-google-wait").querySelector(".err");
  errEl.textContent = "";
  $("google-go").disabled = true;
  $("google-go").textContent = "Aguardando o navegador…";
  googleWaiting = true;
  try {
    const r = await api.call("connectGoogle", {
      accountId: reconnectAccount ? reconnectAccount.id : null,
      name: $("google-name").value,
      autoImages: $("google-images").checked,
      senderName: $("google-sender").value,
    });
    googleWaiting = false;
    closeDialog();
    await refreshState();
    selectAccount(r.id);
  } catch (ex) {
    googleWaiting = false;
    errEl.textContent = ex.message;
    $("google-go").disabled = false;
    $("google-go").textContent = "Tentar de novo";
  }
};
$("google-cancel").onclick = closeDialog;

function openGoogleReconnect(a) {
  stepHistory.length = 0;
  reconnectAccount = a;
  $("dlg-add").querySelector("h2").textContent = "Reconectar conta Google";
  showDialog("dlg-add");
  if (googleInfo.configured) googleWaitStep();
  else step("step-google-client", false);
}

// ---------- Editar conta ----------
function openEdit(a) {
  const f = $("edit-form");
  f.elements.name.value = a.name;
  f.elements.signature.value = a.signature || "";
  f.elements.autoImages.checked = !!a.auto_images;
  f.elements.senderName.value = a.sender_name || "";
  f.querySelector(".err").textContent = "";
  let color = a.color;
  const box = $("edit-colors");
  box.replaceChildren();
  for (const c of COLORS) {
    const b = h("button", c === color ? "on" : "");
    b.type = "button";
    b.style.background = c;
    b.title = c;
    b.onclick = () => {
      color = c;
      for (const x of box.children) x.classList.toggle("on", x === b);
    };
    box.append(b);
  }
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.call("updateAccount", {
        id: a.id,
        name: f.elements.name.value,
        color,
        signature: f.elements.signature.value,
        autoImages: f.elements.autoImages.checked,
        senderName: f.elements.senderName.value,
      });
      closeDialog();
    } catch (ex) {
      f.querySelector(".err").textContent = ex.message;
    }
  };
  showDialog("dlg-edit");
}

// ---------- Eventos do serviço ----------
async function refreshState() {
  const s = await api.call("getState");
  accounts = s.accounts;
  counts = s.counts;
  cryptoInfo = s.crypto;
  googleInfo = s.google;
  if (ui.accountId && !accountById(ui.accountId)) ui.accountId = null;
  renderNav();
  renderBanner();
  renderEmpty();
}

let reloadTimer;
const scheduleReload = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    loadList(true, messages.length);
    if (thread) renderReader(true); // nova resposta ou flag alterada em outro lugar
  }, 400);
};

api.on("accounts-changed", async () => {
  await refreshState();
  loadList(true, messages.length);
});
api.on("account-status", ({ id, status, error }) => {
  const a = accountById(id);
  if (!a) return;
  a.status = status;
  a.error = error;
  renderNav();
  renderBanner();
  if (!messages.length) renderEmpty();
});
api.on("folders-changed", scheduleReload);
api.on("messages-changed", scheduleReload);
api.on("counts", ({ byAccount }) => {
  counts = byAccount;
  renderNav();
});
// Serviço reiniciado: recarrega tudo
api.on("connected", async () => {
  await refreshState().catch(() => {});
  loadList(true, messages.length);
  renderReader();
  restoreComposer();
});
