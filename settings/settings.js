// Tela de Configurações do app. Cada módulo (E-mail, e no futuro outros) registra suas páginas com
// Settings.register({ id, title, pages: [{ id, title, render(container, arg) }] }).
// Rotas: "modulo/pagina[/argumento]", por exemplo "email/contas/add".
// Todo texto vindo do serviço entra via textContent (nunca innerHTML).
"use strict";

const $ = (id) => document.getElementById(id);
const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

const Settings = {
  modules: [],
  current: null, // { mod, page, arg, cleanup }
  register(mod) {
    this.modules.push(mod);
  },
};
window.Settings = Settings;

const LAST_KEY = "settings.route.v1";

function findRoute(route) {
  const [modId, pageId, ...rest] = String(route || "").split("/");
  const mod = Settings.modules.find((m) => m.id === modId) || Settings.modules[0];
  if (!mod) return null;
  const page = mod.pages.find((p) => p.id === pageId) || mod.pages[0];
  return { mod, page, arg: rest.join("/") || null };
}

function renderNav() {
  const nav = $("nav");
  nav.replaceChildren();
  for (const mod of Settings.modules) {
    const title = h("div", "nav-title");
    if (mod.icon) title.append(h("span", "nav-icon", mod.icon));
    title.append(h("span", "", mod.title));
    nav.append(title);
    for (const p of mod.pages) {
      const b = h("button", "nav-item", p.title);
      b.dataset.route = `${mod.id}/${p.id}`;
      b.onclick = () => go(`${mod.id}/${p.id}`);
      nav.append(b);
    }
  }
}

/** Abre uma página. */
async function go(route) {
  const r = findRoute(route);
  if (!r) return;
  if (Settings.current && Settings.current.cleanup) {
    try {
      Settings.current.cleanup();
    } catch {}
  }
  Settings.current = { ...r, cleanup: null };
  try {
    localStorage.setItem(LAST_KEY, `${r.mod.id}/${r.page.id}`);
  } catch {}
  for (const b of document.querySelectorAll(".nav-item")) b.classList.toggle("active", b.dataset.route === `${r.mod.id}/${r.page.id}`);
  $("crumb").textContent = r.mod.title;
  $("page-title").textContent = r.page.title;
  const page = $("page");
  page.replaceChildren();
  $("main").scrollTop = 0;
  try {
    const cleanup = await r.page.render(page, r.arg);
    if (Settings.current && Settings.current.page === r.page && typeof cleanup === "function") Settings.current.cleanup = cleanup;
  } catch (err) {
    page.replaceChildren(h("div", "err", err.message || String(err)));
  }
}

// ---------- Utilidades compartilhadas pelos módulos ----------
let toastTimer;
function toast(text, error) {
  const t = $("toast");
  t.textContent = text;
  t.classList.toggle("error", !!error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 3000);
}

let dialogClose = null;
function showDialog(id, onClose) {
  $("overlay").hidden = false;
  for (const d of document.querySelectorAll(".dialog")) d.hidden = d.id !== id;
  dialogClose = onClose || null;
  const first = $(id).querySelector("input:not([type=hidden]), select, textarea, button.primary");
  if (first) setTimeout(() => first.focus());
}
function closeDialog() {
  $("overlay").hidden = true;
  const cb = dialogClose;
  dialogClose = null;
  if (cb) cb();
}

function confirmDialog(title, text, yesLabel) {
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-yes").textContent = yesLabel || "Confirmar";
  return new Promise((resolve) => {
    let done = false;
    showDialog("dlg-confirm", () => !done && resolve(false));
    $("confirm-yes").onclick = () => {
      done = true;
      closeDialog();
      resolve(true);
    };
    $("confirm-no").onclick = closeDialog;
  });
}

/** Interruptor (checkbox estilizado) com título e explicação. */
function toggle(title, desc, checked, onChange) {
  const label = h("label", "toggle");
  const input = h("input");
  input.type = "checkbox";
  input.checked = !!checked;
  const text = h("span", "toggle-text");
  text.append(h("b", "", title));
  if (desc) text.append(h("span", "muted small", desc));
  label.append(text, input, h("span", "switch"));
  if (onChange) input.onchange = () => onChange(input.checked, input);
  return label;
}

/** Botão que mostra "…" enquanto a ação roda e o erro num toast. */
function actionButton(label, cls, fn) {
  const b = h("button", cls, label);
  b.type = "button";
  b.onclick = async () => {
    b.disabled = true;
    const old = b.textContent;
    b.textContent = "…";
    try {
      await fn(b);
    } catch (err) {
      toast(err.message || String(err), true);
    } finally {
      b.disabled = false;
      if (b.textContent === "…") b.textContent = old;
    }
  };
  return b;
}

const fmtNum = new Intl.NumberFormat("pt-BR");
const fmtTime = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const fmtDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
function when(ts) {
  if (!ts) return "nunca";
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? `hoje às ${fmtTime.format(d)}` : fmtDate.format(d);
}

Object.assign(Settings, { h, $, go, toast, showDialog, closeDialog, confirmDialog, toggle, actionButton, fmtNum, fmtTime, fmtDate, when });

// ---------- Início ----------
function close() {
  if (window.appShell) window.appShell.closeSettings();
}
$("close").onclick = close;
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("overlay").hidden) return closeDialog();
  if (e.target.closest && e.target.closest("input, textarea, select") && e.target.value) return; // Esc no campo não fecha a tela
  close();
});
for (const b of document.querySelectorAll("[data-close]")) b.onclick = closeDialog;

document.addEventListener("DOMContentLoaded", () => {
  renderNav();
  let start = new URLSearchParams(location.search).get("s") || "";
  if (!start) {
    try {
      start = localStorage.getItem(LAST_KEY) || "";
    } catch {}
  }
  go(start);
  if (window.appShell) window.appShell.onGoto((r) => go(r));
});
