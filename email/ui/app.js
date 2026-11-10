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
// Caixa de entrada em grupos virtuais (só no app: nada é movido no servidor). "Já lidos" é sempre o último.
const GROUPS = [
  { key: "importante", title: "Importante" },
  { key: "propaganda", title: "Propaganda" },
  { key: "outros", title: "Outros" },
  { key: "suspeito", title: "Suspeitos" }, // análise de risco: só aparece quando há itens
  { key: "lidos", title: "Já lidos" },
];
const CAT_LABEL = { importante: "Importante", propaganda: "Propaganda", outros: "Outros", suspeito: "Suspeito" };
const MOVABLE = ["importante", "propaganda", "outros"];
const FIRST_PAGE = { importante: 10, propaganda: 10, outros: 10, suspeito: 10, lidos: 20 };
const MORE_PAGE = { importante: 20, propaganda: 20, outros: 20, suspeito: 20, lidos: 50 };
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
  { accountId: null, role: "inbox", unread: false, read: false, flagged: false, attachments: false, q: "", selectedId: null, threads: true, navCollapsed: false },
  (() => {
    try {
      return JSON.parse(localStorage.getItem(UI_KEY)) || {};
    } catch {
      return {};
    }
  })()
);
// Grupos recolhidos (lembrados): Suspeitos e Já lidos começam fechados
ui.collapsed = Object.assign({ suspeito: true, lidos: true }, ui.collapsed || {});
// As antigas visões da Triagem (Importantes, Notificações...) não existem mais
if (String(ui.role).startsWith("v-")) ui.role = "inbox";
if (ui.unread && ui.read) ui.read = false;
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
  renderGroup($("folders"), FOLDERS);
}

/** Abre as Configurações do app (engrenagem da barra lateral) numa seção. */
function openSettings(route) {
  if (window.appShell) window.appShell.openSettings(route || "email/contas");
}

function renderGroup(fl, items) {
  fl.replaceChildren();
  const multi = accounts.length > 1;
  const open = new Set(ui.openFolders || []);
  // A pasta da conta selecionada fica sempre aberta, para a seleção aparecer
  if (multi && ui.accountId) open.add(ui.role);

  for (const f of items) {
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
  sticky = null;
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
  sticky = null;
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
// Adicionar, editar, remover e reconectar contas ficam em Configurações › E-mail › Contas
function accountMenu(a, anchor) {
  showMenu(
    [
      ["Sincronizar agora", () => api.call("syncNow", { accountId: a.id })],
      ["Configurações da conta…", () => openSettings(`email/contas/${a.id}`)],
    ],
    anchor
  );
}

// Botão direito em uma pasta (todas as contas)
function allAccountsMenu(anchor) {
  const items = [];
  if (accounts.length) items.push(["Sincronizar todas", () => api.call("syncNow", {})]);
  items.push(["Configurações de e-mail…", () => openSettings("email/contas")]);
  showMenu(items, anchor);
}

/**
 * Menu flutuante. Itens: [rótulo, ação, classe] | { header } | { sep: true } | { label, fn, check }.
 * Fecha ao tocar/clicar fora (pointerdown), para funcionar também depois de uma pressão longa.
 */
function showMenu(items, anchor, at) {
  const menu = $("menu");
  menu.replaceChildren();
  for (const it of items) {
    if (it.sep) {
      menu.append(h("div", "menu-sep"));
      continue;
    }
    if (it.header) {
      menu.append(h("div", "menu-head", it.header));
      if (it.sub) menu.append(h("div", "menu-sub", it.sub));
      continue;
    }
    const [label, fn, cls] = Array.isArray(it) ? it : [it.label, it.fn, it.cls];
    const b = h("button", (cls || "") + (it.check ? " checked" : ""), label);
    b.setAttribute("role", "menuitem");
    b.onclick = () => {
      closeMenu();
      fn();
    };
    menu.append(b);
  }
  menu.hidden = false;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  if (at) {
    menu.style.left = Math.max(4, Math.min(at.x, innerWidth - mw - 8)) + "px";
    menu.style.top = Math.max(4, at.y + mh > innerHeight ? at.y - mh : at.y) + "px";
  } else {
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, innerWidth - mw - 8) + "px";
    menu.style.top = (r.bottom + mh > innerHeight ? r.top - mh : r.bottom) + "px";
  }
  setTimeout(() => document.addEventListener("pointerdown", closeOutside, true));
}
function closeOutside(e) {
  if (!$("menu").contains(e.target)) closeMenu();
}
function closeMenu() {
  $("menu").hidden = true;
  document.removeEventListener("pointerdown", closeOutside, true);
}

// ---------- Lista de mensagens ----------
// Caixa de entrada (todas as contas ou uma): grupos virtuais. Outras pastas e a busca: lista simples.
let groups = null; // modo agrupado: { importante: { count, items, hasMore }, ... }
const shown = {}; // quantas linhas de cada grupo recarregar nas atualizações (cresce com "Mostrar mais")
// A mensagem aberta fica no grupo onde estava até você abrir outra ou atualizar a lista,
// para a seleção não pular durante a leitura: { id, group, row }
let sticky = null;

const grouped = () => ui.role === "inbox" && !String(ui.q || "").trim() && !ui.priority;
const anyFilter = () => !!(ui.unread || ui.read || ui.flagged || ui.attachments);
// Com qualquer filtro ativo, "Já lidos" abre sozinho para nada ficar escondido
const groupOpen = (key) => (key === "lidos" && anyFilter()) || !ui.collapsed[key];
const rowsInView = () => (groups ? GROUPS.flatMap((g) => groups[g.key].items) : messages);
const findRow = (id) => rowsInView().find((m) => m.id === id) || (sticky && sticky.id === id ? sticky.row : null);

/** Recarrega mantendo o que já está carregado e a rolagem (eventos do serviço). */
function refreshList() {
  return grouped() ? loadInbox(false) : loadList(true, messages.length);
}

async function loadList(reset, keepCount) {
  if (grouped()) return loadInbox(reset && !keepCount);
  groups = null;
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
      read: ui.read,
      flagged: ui.flagged,
      attachments: ui.attachments,
      q: ui.q,
      priority: ui.priority && ui.role === "inbox",
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

/** Caixa de entrada em grupos: um pedido traz o total de cada grupo e as mais recentes de cada um. */
async function loadInbox(reset) {
  const token = ++listToken;
  if (reset) {
    $("messages").scrollTop = 0;
    for (const k of Object.keys(shown)) delete shown[k];
  }
  const limits = {};
  for (const g of GROUPS) limits[g.key] = groupOpen(g.key) ? Math.max(FIRST_PAGE[g.key], shown[g.key] || 0) : 0;
  loading = true;
  try {
    const r = await api.call("listInbox", {
      accountId: ui.accountId,
      unread: ui.unread,
      read: ui.read,
      flagged: ui.flagged,
      attachments: ui.attachments,
      threads: ui.threads,
      limits,
    });
    if (token !== listToken || !grouped()) return;
    groups = r.groups;
    messages = [];
    hasMore = false;
    for (const g of GROUPS) if (groupOpen(g.key)) shown[g.key] = Math.max(shown[g.key] || 0, groups[g.key].items.length);
    renderList();
  } catch (err) {
    if (token === listToken) showBanner(err.message);
  } finally {
    if (token === listToken) loading = false;
  }
}

/** "Mostrar mais" de um grupo: próxima página, direto do banco. */
async function showMore(key, btn) {
  const g = groups && groups[key];
  if (!g) return;
  const last = g.items[g.items.length - 1];
  btn.disabled = true;
  btn.textContent = "Carregando…";
  try {
    const r = await api.call("listInboxGroup", {
      accountId: ui.accountId,
      unread: ui.unread,
      read: ui.read,
      flagged: ui.flagged,
      attachments: ui.attachments,
      threads: ui.threads,
      group: key,
      cursor: last ? { date: last.date, id: last.id } : null,
      limit: MORE_PAGE[key],
    });
    if (!groups || groups[key] !== g) return;
    const have = new Set(g.items.map((m) => m.id));
    g.items.push(...r.items.filter((m) => !have.has(m.id)));
    g.hasMore = r.hasMore;
    shown[key] = g.items.length;
    renderList();
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
}

/** A mensagem aberta continua no grupo de onde foi aberta (com os dados mais novos, se vieram). */
function placeSticky() {
  if (!sticky || !groups || !groups[sticky.group]) return;
  let fresh = null;
  for (const g of GROUPS) {
    const list = groups[g.key].items;
    const i = list.findIndex((m) => m.id === sticky.id);
    if (i === -1) continue;
    fresh = list[i];
    if (g.key !== sticky.group) list.splice(i, 1);
  }
  const row = fresh || sticky.row;
  if (!row) return;
  sticky.row = row;
  const list = groups[sticky.group].items;
  if (list.some((m) => m.id === row.id)) return;
  const at = list.findIndex((m) => m.date < row.date || (m.date === row.date && m.id < row.id));
  list.splice(at === -1 ? list.length : at, 0, row);
}

function renderList() {
  const ul = $("messages");
  // A mensagem selecionada fica no mesmo lugar da tela mesmo que outras mudem de grupo acima dela
  const sel = ul.querySelector(".msg.selected");
  const anchorTop = sel ? sel.offsetTop - ul.scrollTop : null;
  const scroll = ul.scrollTop;
  ul.replaceChildren();
  let visible = 0;
  if (groups) visible = renderGroups(ul);
  else {
    for (const m of messages) ul.append(msgRow(m, null));
    if (hasMore) ul.append(h("li", "more-row", "Carregando mais…"));
    visible = messages.length;
  }
  const now = ul.querySelector(".msg.selected");
  ul.scrollTop = now && anchorTop != null ? now.offsetTop - anchorTop : scroll;
  renderEmpty(visible);
}

function renderGroups(ul) {
  placeSticky();
  const filtered = anyFilter();
  let visible = 0;
  for (const g of GROUPS) {
    if (g.key === "lidos" && (ui.read || ui.unread)) continue;
    const data = groups[g.key];
    const has = data.count > 0 || data.items.length > 0;
    // Sem filtro, Importante/Propaganda/Outros aparecem sempre (servem para soltar mensagens arrastadas);
    // com filtro, grupo sem resultado some. Suspeitos e Já lidos só aparecem quando têm itens.
    if (!has && (filtered || g.key === "suspeito" || g.key === "lidos")) continue;
    visible += has ? 1 : 0;
    const open = groupOpen(g.key);
    ul.append(groupHeader(g, data, open));
    if (!open) continue;
    for (const m of data.items) ul.append(msgRow(m, g.key));
    if (data.hasMore) {
      const li = h("li", "grp-more");
      li.dataset.group = g.key;
      const b = h("button", "link", g.key === "lidos" ? "Mostrar mais lidas" : "Mostrar mais");
      b.onclick = () => showMore(g.key, b);
      li.append(b, h("span", "muted small", ` ${data.items.length} de ${badge(data.count)}`));
      if (MOVABLE.includes(g.key)) dropTarget(li, g.key);
      ul.append(li);
    } else if (!data.items.length && MOVABLE.includes(g.key)) {
      const li = h("li", "grp-empty muted small", ui.unread ? "Nenhuma não lida" : "Nenhuma mensagem");
      li.dataset.group = g.key;
      dropTarget(li, g.key);
      ul.append(li);
    }
  }
  return visible;
}

function groupHeader(g, data, open) {
  const li = h("li", `grp-head g-${g.key}` + (open ? " open" : ""));
  li.dataset.group = g.key;
  li.tabIndex = 0;
  li.setAttribute("role", "button");
  li.setAttribute("aria-expanded", String(open));
  const forced = g.key === "lidos" && anyFilter();
  const readCount = g.key === "lidos" || ui.read;
  // Lidas ficam no grupo da categoria: o número do cabeçalho é o de não lidas
  const n = readCount ? data.count : data.unread ?? data.count;
  li.title = forced
    ? "Aberto porque há um filtro ativo"
    : `${open ? "Recolher" : "Expandir"} · ${n} ${readCount ? "lida" : "não lida"}${n === 1 ? "" : "s"}` +
      (!readCount && data.count > n ? ` de ${data.count}` : "");
  li.append(h("span", "grp-chev", "›"), h("span", "grp-title", g.title));
  if (n) li.append(h("span", "grp-count" + (readCount ? " read" : ""), badge(n)));
  const toggleIt = () => {
    if (forced) return;
    ui.collapsed[g.key] = open;
    saveUi();
    open ? renderList() : loadInbox(false);
  };
  li.onclick = toggleIt;
  li.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleIt();
    }
  };
  if (MOVABLE.includes(g.key)) dropTarget(li, g.key);
  return li;
}

function msgRow(m, groupKey) {
  const a = accountById(m.account_id);
  const showAccount = !ui.accountId && accounts.length > 1;
  const li = h("li", "msg" + (m.seen ? "" : " unread") + (m.id === ui.selectedId ? " selected" : ""));
  li.dataset.id = m.id;
  li.dataset.group = groupKey || "";
  const bar = h("span", "bar");
  bar.style.background = a ? a.color : "transparent";

  const outgoing = ui.role === "sent" || ui.role === "drafts";
  const to = outgoing ? JSON.parse(m.to_json || "[]") : null;
  const who = outgoing
    ? "Para: " + (to.map((x) => x.name || x.address).join(", ") || "(sem destinatário)")
    : m.from_name || m.from_addr || "(sem remetente)";

  const side = h("span", "side");
  // Etiqueta discreta da categoria de origem: em "Já lidos" e na busca da Caixa de entrada
  if (ui.role === "inbox" && (groupKey === "lidos" || !groupKey) && CAT_LABEL[m.grp]) {
    const t = h("span", `gtag t-${m.grp}`, CAT_LABEL[m.grp]);
    t.title = m.manual ? "Você escolheu este grupo" : "Grupo da mensagem";
    side.append(t);
  }
  if (showAccount && a) {
    const tag = h("span", "acct", a.name);
    tag.style.color = a.color;
    side.append(tag);
  }
  const risk = RISK[m.risk_rank];
  if (risk) {
    const b = h("span", `risk ${risk.cls}`, risk.short);
    b.title = risk.title;
    side.append(b);
  }
  if (m.has_attachments) side.append(h("span", "", "📎"));
  if (m.flagged) side.append(h("span", "star", "★"));
  side.append(h("span", "", shortDate(m.date)));

  const fromEl = h("span", "from", who);
  if (m.thread_count > 1) fromEl.append(h("span", "tcount", ` ${m.thread_count}`));
  const subj = h("span", "subject", m.subject || "(sem assunto)");
  if (m.snippet) subj.append(h("span", "snip", ` — ${m.snippet}`));
  li.append(bar, fromEl, side, subj);
  // Prioritários: pontuação e o motivo da classificação
  if (ui.priority && m.pscore != null) {
    const why = h("span", "prio-why", `★ ${m.pscore} · ${m.preason || ""}`);
    why.title = m.preason || "";
    li.append(why);
  }
  li.onclick = () => {
    if (li._longPressed) return (li._longPressed = false);
    selectMessage(m.id);
  };

  // Ajuste manual dos grupos (só na Caixa de entrada): arrastar ou menu de contexto (clique direito / pressão longa)
  if (ui.role === "inbox") {
    li.oncontextmenu = (e) => {
      e.preventDefault();
      categoryMenu(m, e.clientX, e.clientY);
    };
    longPress(li, (x, y) => categoryMenu(m, x, y));
    if (groupKey) {
      li.draggable = true;
      li.addEventListener("dragstart", (e) => {
        drag = { id: m.id, from: groupKey };
        e.dataTransfer.setData("application/x-multihub-message", String(m.id));
        e.dataTransfer.effectAllowed = "move";
        li.classList.add("dragging");
      });
      li.addEventListener("dragend", () => {
        drag = null;
        li.classList.remove("dragging");
        clearDrop();
      });
    }
    if (groupKey && MOVABLE.includes(groupKey)) dropTarget(li, groupKey);
  }
  return li;
}

// ---------- Arrastar entre grupos ----------
let drag = null; // { id, from }
let dropTimer = null;
function dropTarget(el, key) {
  el.addEventListener("dragover", (e) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    highlightDrop(key);
  });
  el.addEventListener("drop", (e) => {
    if (!drag) return;
    e.preventDefault();
    const { id } = drag;
    drag = null;
    clearDrop();
    moveToGroup([id], key);
  });
}
function highlightDrop(key) {
  for (const el of $("messages").querySelectorAll(".drop")) if (el.dataset.group !== key) el.classList.remove("drop");
  for (const el of $("messages").querySelectorAll(`[data-group="${key}"]`)) el.classList.add("drop");
  clearTimeout(dropTimer);
  dropTimer = setTimeout(clearDrop, 200); // some sozinho ao sair da área (o dragover se repete enquanto está em cima)
}
function clearDrop() {
  clearTimeout(dropTimer);
  for (const el of $("messages").querySelectorAll(".drop")) el.classList.remove("drop");
}

/** Pressão longa (toque ou caneta) abre o menu de contexto. */
function longPress(el, cb) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    sx = e.clientX;
    sy = e.clientY;
    timer = setTimeout(() => {
      timer = null;
      el._longPressed = true;
      cb(sx, sy);
    }, 550);
  });
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointermove", (e) => timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10 && cancel());
}

/** Menu de contexto da mensagem: "Mover para" e "Sempre classificar este remetente como". */
function categoryMenu(m, x, y) {
  const items = [{ header: "Mover para" }];
  for (const c of MOVABLE) items.push({ label: CAT_LABEL[c], check: m.grp === c, fn: () => moveToGroup([m.id], c) });
  if (m.manual) items.push({ label: "Voltar à classificação automática", fn: () => moveToGroup([m.id], null) });
  if (m.from_addr) {
    items.push({ sep: true }, { header: "Sempre classificar este remetente como", sub: m.from_addr });
    for (const c of MOVABLE) items.push({ label: CAT_LABEL[c], fn: () => senderRule(m.from_addr, c) });
  }
  showMenu(items, null, { x, y });
}

/** Muda o grupo no app (category = null volta ao automático). Nada é movido no servidor. */
async function moveToGroup(ids, category) {
  const row = findRow(ids[0]);
  const prev = row ? row.manual || null : null;
  const prevSticky = sticky ? { ...sticky } : null;
  try {
    await api.call("setCategory", { ids, category, threads: ui.threads });
    if (sticky && ids.includes(sticky.id) && sticky.group !== "lidos" && category) sticky.group = category;
    const msg = category ? `Movida para ${CAT_LABEL[category]}.` : "Voltou à classificação automática.";
    const stays = "";
    toast(msg + stays, false, {
      label: "Desfazer",
      fn: async () => {
        await api.call("setCategory", { ids, category: prev, threads: ui.threads }).catch((e) => toast(e.message, true));
        if (prevSticky && sticky && sticky.id === prevSticky.id) sticky.group = prevSticky.group;
        refreshList();
      },
    });
    refreshList();
  } catch (err) {
    toast(err.message, true);
  }
}

async function senderRule(address, category) {
  try {
    const before = await api.call("getSenders");
    const old = (before.rules || []).find((r) => r.match === address);
    await api.call("setSenderRule", { match: address, category });
    toast(`E-mails de ${address} vão sempre para ${CAT_LABEL[category]}.`, false, {
      label: "Desfazer",
      fn: () =>
        api
          .call("setSenderRule", { match: address, category: old ? old.category : null })
          .then(refreshList)
          .catch((e) => toast(e.message, true)),
    });
    refreshList();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderEmpty(visible) {
  const empty = $("empty");
  empty.replaceChildren();
  if (visible) {
    empty.hidden = true;
    $("messages").hidden = false;
    return;
  }
  empty.hidden = false;
  $("messages").hidden = true;
  if (!accounts.length) {
    empty.append(h("div", "", "Nenhuma conta de e-mail ainda."));
    const b = h("button", "primary", "Adicionar conta");
    b.title = "Abre Configurações › E-mail › Contas";
    b.onclick = () => openSettings("email/contas/add");
    empty.append(b);
  } else if (accounts.some((a) => a.status === "connecting" || a.status === "syncing")) {
    empty.append(h("div", "", "Sincronizando…"));
  } else {
    empty.append(h("div", "", ui.q || anyFilter() ? "Nada encontrado com esses filtros." : ui.role === "inbox" ? "Caixa de entrada vazia." : "Pasta vazia."));
  }
}

$("messages").addEventListener("scroll", (e) => {
  const el = e.target;
  if (!groups && hasMore && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 300) loadList(false);
});

async function selectMessage(id) {
  const li = $("messages").querySelector(`.msg[data-id="${id}"]`);
  const prev = sticky;
  // A anterior é liberada (pode ir para Já lidos); a nova fica onde está
  sticky = grouped() && li && li.dataset.group ? { id, group: li.dataset.group, row: findRow(id) } : null;
  ui.selectedId = id;
  saveUi();
  for (const el of $("messages").querySelectorAll(".msg")) el.classList.toggle("selected", Number(el.dataset.id) === id);
  if (prev && prev.id !== id && groups) loadInbox(false);
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

/** j/k e setas: seguem a ordem da tela (grupos abertos, de cima para baixo). */
function moveSelection(delta) {
  const rows = [...$("messages").querySelectorAll(".msg")];
  const i = rows.findIndex((r) => Number(r.dataset.id) === ui.selectedId);
  const next = rows[i === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, i + delta))];
  if (!next || Number(next.dataset.id) === ui.selectedId) return;
  selectMessage(Number(next.dataset.id));
  const row = $("messages").querySelector(`.msg[data-id="${next.dataset.id}"]`);
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

  renderPriority();
  trackReading();
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
/* Muitos e-mails usam html,body{height:100%}: isso prende o <html> à altura do iframe e fitFrame
   mede sempre o tamanho atual, deixando a mensagem minúscula. Força a altura do conteúdo. */
html,body{height:auto!important;min-height:0!important;max-height:none!important}
body{padding:16px 18px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere;overflow-x:auto}
img{max-width:100%;height:auto}
img[data-remote-src]:not([src]),img:not([src]){visibility:hidden}
a[data-mh-off]{color:#8a6d00;text-decoration:line-through;cursor:not-allowed}
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
  // A caixa do <html> não basta: e-mails com height:100%, posição absoluta ou floats transbordam dela
  // (o e-mail fica minúsculo com barra de rolagem). scrollHeight pega tudo, mas nunca é menor que a área
  // visível; então encolhe o iframe por um instante, mede e devolve (síncrono: não pisca).
  const set = () => {
    const root = doc.documentElement;
    if (!root) return;
    const scroller = frame.closest("#reader") || document.scrollingElement;
    const keep = scroller ? scroller.scrollTop : 0;
    frame.style.height = "1px";
    const hgt = Math.max(40, root.scrollHeight, doc.body ? doc.body.scrollHeight : 0, Math.ceil(root.getBoundingClientRect().height));
    frame.style.height = hgt + "px";
    if (scroller) scroller.scrollTop = keep;
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
  wrap._msg = m;
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

  // Análise de segurança; mensagem suspeita em quarentena (Configurações › Segurança): links desativados,
  // anexos só para salvar e imagens remotas sem carregar sozinhas
  let quarantined = false;
  const panel =
    thread && ["inbox", "junk", "archive", "trash"].includes(m.role || thread.role)
      ? triagePanel(m, (t) => t.quarantine && !quarantined && wrap.isConnected && (quarantined = true) && quarantine(wrap, frame))
      : null;
  if (panel) wrap.append(panel);
  const triageReady = panel ? panel._ready : Promise.resolve(null);
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
  // Prioritários: clicar num link do e-mail conta como atividade (+3)
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    if (doc) doc.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a[href]");
      if (a && /^(https?|mailto):/i.test(a.getAttribute("href") || "")) prioActivity(m.id, "link");
    }, true);
  });

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
    frame.addEventListener(
      "load",
      () =>
        triageReady.then((t) => {
          if (!bar) return;
          // Em quarentena, só carrega se você mesmo pediu neste e-mail
          if (t && t.quarantine && !imagesShown.has(m.id)) bar.hidden = false;
          else showImages(frame, bar, m.id);
        }),
      { once: true }
    );
  }

  const atts = (b.attachments || []).filter((x) => !x.inline);
  if (atts.length) {
    const list = h("div", "c-atts");
    for (const x of atts) list.append(attachmentChip(m, x));
    wrap.append(list);
  }
  return wrap;
}

/** "Não é golpe": tira esta mensagem da quarentena de vez (links, anexos e grupo). */
function releaseButton(m) {
  const b = h("button", "link", "Não é golpe — tirar da quarentena");
  b.onclick = async () => {
    const ok = await confirmDialog(
      "Tirar da quarentena?",
      "Os links e anexos voltam ao normal e a mensagem sai do grupo Suspeitos. Faça isso só se tiver certeza de que ela é legítima (confira o remetente)."
    );
    if (!ok) return;
    b.disabled = true;
    try {
      await api.call("releaseTriage", { id: m.id });
      toast("Mensagem tirada da quarentena.");
      scheduleReload(); // o aviso "triage-changed" também recarrega; aqui é só para não esperar
    } catch (e) {
      b.disabled = false;
      toast("Não foi possível: " + (e.message || e), true);
    }
  };
  return b;
}

const imagesShown = new Set(); // ids de mensagens com imagens liberadas nesta sessão

/** Quarentena: desativa os links (o destino real fica na dica) e tira o "Abrir" dos anexos. */
function quarantine(wrap, frame) {
  const bar = h("div", "notice q");
  bar.append(h("span", "", "🛡 Mensagem suspeita: links desativados e anexos só para salvar. "));
  const undo = h("button", "link", "Reativar links");
  undo.onclick = async () => {
    const ok = await confirmDialog(
      "Reativar os links?",
      "A análise de segurança considerou esta mensagem suspeita. Só reative os links se tiver certeza de que ela é legítima."
    );
    if (!ok) return;
    setLinks(frame, true);
    bar.remove();
  };
  bar.append(undo, h("span", "", " · "), releaseButton(wrap._msg));
  wrap.insertBefore(bar, frame);
  setLinks(frame, false);
  frame.addEventListener("load", () => bar.isConnected && setLinks(frame, false));
  for (const b of wrap.querySelectorAll(".att-open")) b.remove();
}
function setLinks(frame, on) {
  const doc = frame.contentDocument;
  if (!doc) return;
  if (on) {
    for (const a of doc.querySelectorAll("a[data-mh-href]")) {
      a.setAttribute("href", a.getAttribute("data-mh-href"));
      a.removeAttribute("data-mh-href");
      a.removeAttribute("data-mh-off");
      a.removeAttribute("title");
    }
    return;
  }
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    a.setAttribute("data-mh-href", href);
    a.setAttribute("data-mh-off", "");
    a.removeAttribute("href");
    a.title = "Link desativado (mensagem suspeita): " + href;
  }
}

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
    const open = h("button", "link att-open", "Abrir");
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

/**
 * Ações da barra de leitura com resposta visual: enquanto o servidor responde, os botões ficam travados
 * (evita cliques repetidos) e o clicado mostra que está trabalhando; no fim a lista e a leitura recarregam.
 */
let acting = false;
function setActing(on, btn) {
  acting = on;
  $("thread").classList.toggle("acting", on);
  for (const b of document.querySelectorAll("#thread .r-toolbar .tb")) b.disabled = on;
  if (btn) btn.classList.toggle("busy", on);
  if (!on) for (const b of document.querySelectorAll("#thread .r-toolbar .tb.busy")) b.classList.remove("busy");
}
async function busy(btn, fn) {
  if (acting) return;
  setActing(true, btn);
  try {
    await fn();
  } finally {
    setActing(false);
    await refreshList(); // recarrega do banco: o que mudou aparece na hora
    if (thread) renderReader(true);
  }
}

async function doAction(act, anchor) {
  if (!thread || acting) return;
  if (act === "move") return moveMenu(anchor); // o menu abre na hora; a mudança em si usa busy()
  if (act === "reply" || act === "replyAll" || act === "forward") return doActionNow(act, anchor);
  return busy(anchor, () => doActionNow(act, anchor));
}

async function doActionNow(act, anchor) {
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
      await toggleStar(flagged.length ? flagged : [lastInFolder()]);
      toast(flagged.length ? "Removida dos favoritos." : "Adicionada aos favoritos.");
    } else if (act === "move") {
      moveMenu(anchor);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/** Remove a conversa da lista e abre a próxima (na ordem da tela). */
function afterRemove(msg) {
  const rows = [...$("messages").querySelectorAll(".msg")];
  const i = rows.findIndex((r) => Number(r.dataset.id) === ui.selectedId);
  const next = i === -1 ? null : rows[i + 1] || rows[i - 1] || null;
  const gone = ui.selectedId;
  messages = messages.filter((m) => m.id !== gone);
  if (groups) for (const g of GROUPS) groups[g.key].items = groups[g.key].items.filter((m) => m.id !== gone);
  sticky = null;
  ui.selectedId = next ? Number(next.dataset.id) : null;
  // A próxima também fica no lugar enquanto você a lê
  if (next && groups && next.dataset.group) sticky = { id: ui.selectedId, group: next.dataset.group, row: findRow(ui.selectedId) };
  saveUi();
  renderList();
  renderReader();
  if (msg) toast(msg);
}

async function markSeen(ids, seen) {
  for (const m of thread ? thread.messages : []) if (ids.includes(m.id)) m.seen = seen ? 1 : 0;
  const row = findRow(ui.selectedId);
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
    const row = findRow(ui.selectedId);
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
      () =>
        busy(anchor, async () => {
          try {
            await api.call("move", { ids: idsInFolder(), folderId: f.id });
            afterRemove(`Movida para ${f.role ? FOLDER_LABEL[f.role] : f.name}.`);
          } catch (err) {
            toast(err.message, true);
          }
        }),
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



// ---------- Triagem de segurança (fase 6a: modo sombra) ----------
const RISK = {
  3: { cls: "r3", short: "⛔ Perigoso", label: "Perigoso", title: "Sinais fortes de golpe ou malware" },
  2: { cls: "r2", short: "⚠ Suspeito", label: "Suspeito", title: "Sinais de golpe: confira antes de clicar ou responder" },
  1: { cls: "r1", short: "Atenção", label: "Atenção", title: "Pequenos sinais de risco" },
};
const LEVEL_RANK = { perigoso: 3, suspeito: 2, atencao: 1, ok: 0 };
const SEV_ICON = { critical: "⛔", high: "⚠", medium: "▲", low: "•", info: "ℹ" };
const AV_TEXT = {
  clean: "Antivírus: nenhuma ameaça nos anexos",
  infected: "Antivírus: AMEAÇA ENCONTRADA",
  unavailable: "Antivírus: ClamAV não encontrado neste computador",
  error: "Antivírus: falha ao examinar",
};

/** Painel da análise de segurança. onResult(t) é chamado quando o resultado chega (agora ou depois). */
function triagePanel(m, onResult) {
  const box = h("details", "triage");
  box.dataset.pending = "1";
  box.hidden = true; // só aparece se houver risco (ou se a análise falhar)
  const load = async () => {
    let t = null;
    try {
      t = await api.call("getTriage", { id: m.id });
    } catch {}
    box.replaceChildren();
    if (!t) {
      box.append(h("summary", "", "🛡 Análise de segurança: aguardando…"));
      return null;
    }
    delete box.dataset.pending;
    if (onResult) onResult(t);
    const rank = Math.max(LEVEL_RANK[t.level] || 0, t.category === "suspeito" ? 2 : 0);
    box.className = `triage lvl${rank}`;
    const summary = h("summary");
    const visible = t.signals.filter((s) => s.weight > 0);
    box.hidden = !(t.status === "error" || rank || visible.length || t.injection || t.av === "infected");
    const head =
      t.status === "error"
        ? `🛡 Análise de segurança: não concluída (${t.error || "erro"})`
        : rank
        ? visible.length
          ? `🛡 ${RISK[rank].label}: ${visible.length} sinal(is) técnico(s) · ${t.score} pontos`
          : `🛡 ${RISK[rank].label}: apontado pelo agente (sem sinais técnicos)`
        : t.category
        ? `🛡 ${CAT_NAME[t.category]} · nenhum sinal técnico de risco`
        : "🛡 Nenhum sinal de risco encontrado";
    summary.append(h("span", "", head));
    if (t.shadow) summary.append(h("span", "shadow", "modo sombra"));
    box.append(summary);
    if (rank >= 2) box.open = true;

    const agent = agentBlock(t);
    if (agent) box.append(agent);
    if (t.category === "importante" || t.category === "incerto" || t.injection) box.open = true;
    const list = h("ul", "sig-list");
    for (const s of t.signals.filter((x) => x.weight > 0).concat(t.signals.filter((x) => !x.weight))) {
      const li = h("li", `sev-${s.severity}`);
      li.append(h("span", "ico", SEV_ICON[s.severity] || "•"), h("span", "", s.detail));
      if (s.weight) li.append(h("span", "pts", `+${s.weight}`));
      list.append(li);
    }
    if (t.av && AV_TEXT[t.av]) list.append(h("li", t.av === "infected" ? "sev-critical" : "sev-info", AV_TEXT[t.av]));
    box.append(list);
    const foot = h("div", "triage-foot");
    const note = t.shadow && rank >= 2
      ? "Modo sombra: o app só avisa; a mensagem ficou no grupo da categoria."
      : t.quarantine
      ? "Em quarentena: links desativados e anexos só para salvar."
      : "";
    if (note) foot.append(h("span", "muted small", note));
    if (t.quarantine || (rank >= 2 && t.category !== "liberado")) foot.append(releaseButton(m));
    box.append(foot);
    return t;
  };
  box._reload = load;
  box.append(h("summary", "", "🛡 Análise de segurança…"));
  box._ready = load();
  return box;
}


// ---------- Agente de triagem (6b) ----------
const CAT_NAME = { liberado: "Liberado por você", importante: "Importante", notificacao: "Notificação", promocao: "Promoção", suspeito: "Suspeito", incerto: "Incerto (verificar)" };
const SOCIAL_NAME = {
  urgencia: "urgência", ameaca: "ameaça", pedido_credenciais: "pede senha/código", pedido_pagamento: "pede pagamento",
  falsa_autoridade: "falsa autoridade", premio_falso: "prêmio falso", sigilo: "pede sigilo",
  inconsistencia_remetente: "remetente inconsistente", anexo_isca: "anexo isca", outro: "outro",
};
const modelName = (m) =>
  !m ? "" : m === "usuario" ? "você" : m === "lista" ? "suas listas de remetentes" : m.includes("/") ? m : m.replace(/^claude-/, "Claude ").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-/g, " ");

/** Bloco do agente dentro do painel de segurança da mensagem. */
function agentBlock(t) {
  if (!t.category) return null;
  const box = h("div", "agent");
  const head = h("div", "agent-head");
  head.append(h("span", `cat-pill cp-${t.category}`, CAT_NAME[t.category] || t.category));
  if (t.priority != null && t.category !== "suspeito") head.append(h("span", "muted small", `prioridade ${t.priority}`));
  const by = h("span", "muted small", `por ${modelName(t.model)}${t.escalated ? " (revisado pelo modelo maior)" : ""}${t.restricted ? " · modo restrito" : ""}`);
  head.append(by);
  box.append(head);
  if (t.injection) box.append(h("div", "agent-alert", "⛔ Este e-mail tentou dar ordens ao agente de IA (técnica de golpe). As ordens foram ignoradas."));
  if (t.summary) box.append(h("div", "agent-summary", t.summary));
  if (t.reasons.length) {
    const ul = h("ul", "agent-reasons");
    for (const r of t.reasons) ul.append(h("li", "", r));
    box.append(ul);
  }
  if (t.social.length) box.append(h("div", "muted small", "Engenharia social: " + t.social.map((s) => SOCIAL_NAME[s] || s).join(", ")));
  if (t.deadlines.length) {
    const d = h("div", "agent-deadlines");
    d.append(h("span", "", "⏰ Prazos: "));
    d.append(h("span", "", t.deadlines.map((x) => `${x.what} (${x.when})`).join(" · ")));
    box.append(d);
  }
  return box;
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
  if (!accounts.length) return openSettings("email/contas/add");
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
// Os filtros atuam dentro dos grupos. "Não lidas" e "Lidas" se excluem.
function syncChips() {
  for (const c of document.querySelectorAll(".chip")) c.classList.toggle("on", !!ui[c.dataset.filter]);
}
for (const chip of document.querySelectorAll(".chip")) {
  chip.onclick = () => {
    const key = chip.dataset.filter;
    ui[key] = !ui[key];
    if (key === "unread" && ui.unread) ui.read = false;
    if (key === "read" && ui.read) ui.unread = false;
    sticky = null;
    syncChips();
    saveUi();
    loadList(true);
  };
}
syncChips();

// ---------- Prioritários ----------
var prioConfig = { threshold: 60 };
function syncPrioBar() {
  $("prio-bar").hidden = !(ui.priority && ui.role === "inbox");
  $("prio-th").value = prioConfig.threshold;
  $("prio-th-val").textContent = `${prioConfig.threshold} de 100`;
}
const _syncChips = syncChips;
syncChips = function () {
  _syncChips();
  syncPrioBar();
};
api.call("getPriorityConfig").then((c) => {
  prioConfig = c;
  syncPrioBar();
}).catch(() => {});
let prioTimer;
$("prio-th").addEventListener("input", () => {
  prioConfig.threshold = Number($("prio-th").value);
  $("prio-th-val").textContent = `${prioConfig.threshold} de 100`;
  clearTimeout(prioTimer);
  prioTimer = setTimeout(async () => {
    await api.call("setPriorityConfig", { threshold: prioConfig.threshold }).catch((err) => toast(err.message, true));
    loadList(true);
  }, 250);
});
syncPrioBar();

/** Atividade no e-mail (abrir, ler por mais de 20 s, link): só na Caixa de entrada, uma vez por mensagem. */
var prioDone = new Set();
function prioActivity(id, action) {
  prioDone ||= new Set(); // pode ser chamada antes desta parte do arquivo rodar
  if (!id || ui.role !== "inbox" || prioDone.has(id + action)) return;
  prioDone.add(id + action);
  api.call("priorityActivity", { id, action }).catch(() => {});
}
var readTimer = null;
var readingId = null;
function trackReading() {
  const id = ui.selectedId;
  if (id === readingId) return;
  readingId = id;
  clearTimeout(readTimer);
  if (!id) return;
  prioActivity(id, "open");
  readTimer = setTimeout(() => {
    if (ui.selectedId === id && !document.hidden) prioActivity(id, "read");
  }, 20_000);
}

/** Botões Importante / Não importante da leitura: estado atual, pontuação e motivo. */
var prioToken;
async function renderPriority() {
  const token = (prioToken = (prioToken || 0) + 1);
  const id = ui.selectedId;
  const p = id && ui.role !== "sent" && ui.role !== "drafts" ? await api.call("getPriority", { id }).catch(() => null) : null;
  if (token !== prioToken) return;
  for (const b of document.querySelectorAll("#thread .prio")) {
    const on = !!p && p.label === Number(b.dataset.prio);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.hidden = !p;
  }
  const line = $("t-prio");
  line.hidden = !p || p.score == null;
  if (p && p.score != null) line.textContent = `Relevância ${p.score} de 100${p.score >= p.threshold ? " · Prioritário" : ""} — ${p.reason || ""}`;
  line.title = p && p.base != null ? `Nota calculada ${p.base} · ajuste manual ${p.manual > 0 ? "+" : ""}${p.manual} · atividade ${p.activity > 0 ? "+" : ""}${p.activity}` : "";
}
for (const b of document.querySelectorAll("#thread .prio")) {
  b.onclick = async () => {
    const id = ui.selectedId;
    if (!id) return;
    const v = Number(b.dataset.prio);
    const label = b.classList.contains("on") ? 0 : v; // clicar de novo desfaz
    b.disabled = true;
    try {
      await api.call("setPriorityFeedback", { id, label });
      await renderPriority();
      if (ui.priority) refreshList();
      toast(label ? (label > 0 ? "Marcado como importante" : "Marcado como não importante") : "Marcação desfeita");
    } catch (err) {
      toast(err.message, true);
    } finally {
      b.disabled = false;
    }
  };
}
api.on("priority-changed", () => {
  if (ui.priority && ui.role === "inbox") scheduleReload();
  renderPriority();
});
const search = $("search");
search.value = ui.q || "";
let searchTimer;
search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    ui.q = search.value;
    sticky = null;
    saveUi();
    loadList(true);
  }, 250);
});
// Atualizar: sincroniza e reorganiza a lista na hora (a mensagem aberta também vai para o grupo dela)
$("refresh").onclick = () => {
  sticky = null;
  api.call("syncNow", { accountId: ui.accountId }).catch(() => {});
  refreshList();
};

// Marcar tudo como lido: na pasta aberta, da conta escolhida ou de todas as contas
$("mark-all-read").onclick = async () => {
  const acc = ui.accountId && accountById(ui.accountId);
  const where = acc ? acc.email : "todas as contas";
  if (!(await confirmDialog("Marcar tudo como lido?", `Todas as mensagens desta pasta em ${where} serão marcadas como lidas, também no servidor.`))) return;
  const btn = $("mark-all-read");
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    await api.call("markAllRead", { accountId: ui.accountId, role: ui.role });
    sticky = null;
    await refreshList();
    toast("Tudo marcado como lido");
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
  }
};

function showBanner(text, action) {
  const b = $("banner");
  b.replaceChildren();
  if (text) {
    b.append(h("span", "", text));
    if (action) {
      const btn = h("button", "link", action.label);
      btn.onclick = action.fn;
      b.append(" ", btn);
    }
  }
  b.hidden = !text;
}
function renderBanner() {
  if (!cryptoInfo.available) return showBanner("O chaveiro do sistema não está disponível: não é possível salvar contas com segurança.");
  if (cryptoInfo.backend === "basic_text")
    return showBanner("Sem chaveiro do sistema (GNOME Keyring/KWallet): as senhas ficam só ofuscadas no disco. Instale/ative um chaveiro.");
  const bad = accounts.filter((a) => a.status === "auth");
  showBanner(
    bad.length ? `${bad.map((a) => a.email).join(", ")}: ${bad[0].error || "login necessário"}` : "",
    bad.length ? { label: "Abrir Configurações", fn: () => openSettings(`email/contas/${bad[0].id}`) } : null
  );
}

// ---------- Diálogos ----------
let dialogResolve = null;
function showDialog(id) {
  $("overlay").hidden = false;
  for (const d of document.querySelectorAll(".dialog")) d.hidden = d.id !== id;
}
function closeDialog() {
  $("overlay").hidden = true;
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
  renderEmpty(visibleCount());
}
const visibleCount = () => (groups ? GROUPS.filter((g) => groups[g.key].count || groups[g.key].items.length).length : messages.length);

let reloadTimer;
const scheduleReload = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    refreshList();
    if (thread) renderReader(true); // nova resposta ou flag alterada em outro lugar
  }, 400);
};

api.on("accounts-changed", async () => {
  await refreshState();
  refreshList();
});
api.on("account-status", ({ id, status, error }) => {
  const a = accountById(id);
  if (!a) return;
  a.status = status;
  a.error = error;
  renderNav();
  renderBanner();
  if (!visibleCount()) renderEmpty(0);
});
api.on("folders-changed", scheduleReload);
api.on("messages-changed", scheduleReload);
// Organização (grupos) mudou em segundo plano: atualiza a lista
api.on("organize-changed", scheduleReload);
// Configurações › Segurança mudou: a quarentena da mensagem aberta pode ter mudado
api.on("security-changed", () => thread && renderReader());
api.on("triage-changed", () => {
  scheduleReload();
  for (const p of document.querySelectorAll(".triage[data-pending]")) p._reload && p._reload();
});
api.on("counts", ({ byAccount }) => {
  counts = byAccount;
  renderNav();
});
// Serviço reiniciado: recarrega tudo
api.on("connected", async () => {
  await refreshState().catch(() => {});
  refreshList();
  renderReader();
  restoreComposer();
});
