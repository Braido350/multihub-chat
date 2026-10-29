const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  Tray,
  Notification,
  nativeImage,
  ipcMain,
  session,
  shell,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const APP_NAME = "MultiHub Chat";
const APP_ID = "io.github.multihub-chat";
const ICON = path.join(__dirname, "icon.png");
const SIDEBAR_W = 48;
const MAX_SITES = 3; // site principal + 2 adicionais

let win = null;
let tray = null;
let quitting = false;
let modalOpen = false;

let sites = [];
let activeId = null;
const views = new Map(); // id -> WebContentsView
const unread = {}; // id -> true quando há notificação não vista
const liveNotifications = new Set(); // evita coleta de lixo antes do clique
const configuredSessions = new Set();

// Necessário no Windows para as notificações aparecerem
app.setAppUserModelId(APP_ID);
// User-Agent de Chrome "puro": sites como o WhatsApp Web recusam o UA padrão do Electron
const CHROME_MAJOR = process.versions.chrome.split(".")[0];
const UA_PLATFORM =
  process.platform === "win32"
    ? "Windows NT 10.0; Win64; x64"
    : process.platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : "X11; Linux x86_64";
const CHROME_UA = `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
app.userAgentFallback = CHROME_UA;

// Permite apenas uma instância aberta
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
}

// ---------- Sites (persistência) ----------
const sitesFile = () => path.join(app.getPath("userData"), "sites.json");

function loadSites() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(sitesFile(), "utf8"));
  } catch {}
  const extra = (Array.isArray(data.sites) ? data.sites : []).filter(
    (s) => s && s.id && s.url && s.partition && s.id !== "main"
  );
  // Site principal (não pode ser removido) é definido pelo usuário na primeira abertura
  const main = data.main || {};
  sites = [
    {
      id: "main",
      name: main.name || "Atendimento",
      url: main.url || "",
      partition: "persist:main",
      builtin: true,
    },
    ...extra,
  ].slice(0, MAX_SITES);
  activeId = "main"; // sempre abre no site principal ao iniciar
}

function saveSites() {
  try {
    fs.writeFileSync(
      sitesFile(),
      JSON.stringify({
        main: { name: sites[0].name, url: sites[0].url },
        sites: sites
          .filter((s) => !s.builtin)
          .map(({ id, name, url, partition, favicon }) => ({ id, name, url, partition, favicon })),
        activeId,
      })
    );
  } catch {}
}

const siteById = (id) => sites.find((s) => s.id === id);
const activeView = () => views.get(activeId);

function sameHost(url, site) {
  try {
    return new URL(url).hostname === new URL(site.url).hostname;
  } catch {
    return false;
  }
}

function siteByWebContents(wc) {
  for (const [id, v] of views) if (v.webContents === wc) return siteById(id);
  return null;
}

function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) throw new Error("Informe o endereço do site.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
  const parsed = new URL(u); // lança TypeError se inválida
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Use um endereço http ou https.");
  }
  return parsed.toString();
}

// ---------- Estado enviado à barra lateral ----------
function sendState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("shell:state", {
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      builtin: !!s.builtin,
      favicon: s.favicon || null,
      unread: !!unread[s.id],
    })),
    activeId,
    max: MAX_SITES,
  });
}

// ---------- Layout ----------
function layout() {
  if (!win || win.isDestroyed()) return;
  const { width: w, height: h } = win.contentView.getBounds();
  for (const v of views.values()) {
    v.setBounds({ x: SIDEBAR_W, y: 0, width: Math.max(0, w - SIDEBAR_W), height: h });
  }
}

// Todas as views ficam "visíveis" e empilhadas, com a ativa por cima: assim as de trás
// não ficam com document.hidden e sites como o WhatsApp Web sincronizam sem precisar abri-los
function showActive() {
  for (const v of views.values()) v.setVisible(!modalOpen);
  const v = activeView();
  if (v && !modalOpen && win && !win.isDestroyed()) win.contentView.addChildView(v); // traz para frente
}

function selectSite(id) {
  if (!siteById(id) || !views.has(id)) return;
  activeId = id;
  unread[id] = false;
  saveSites();
  showActive();
  const v = views.get(id);
  if (v && !modalOpen) v.webContents.focus();
  sendState();
}

// ---------- Janela / bandeja ----------
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 24, height: 24 });
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Abrir ${APP_NAME}`, click: showWindow },
      { type: "separator" },
      {
        label: "Sair",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", () => {
    win && win.isVisible() && win.isFocused() ? win.hide() : showWindow();
  });
}

// ---------- Zoom (persistente, vale para todos os sites) ----------
const ZOOM_STEP = 0.5; // cada passo = ~20%
const ZOOM_MIN = -3; // ~ 42%
const ZOOM_MAX = 5; // ~ 300%
const zoomFile = () => path.join(app.getPath("userData"), "zoom.json");

function loadZoom() {
  try {
    const v = JSON.parse(fs.readFileSync(zoomFile(), "utf8")).level;
    return typeof v === "number" ? v : 0;
  } catch {
    return 0;
  }
}

function saveZoom(level) {
  try {
    fs.writeFileSync(zoomFile(), JSON.stringify({ level }));
  } catch {}
}

function setZoom(level) {
  level = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
  for (const v of views.values()) v.webContents.setZoomLevel(level);
  saveZoom(level);
}

function zoomBy(delta) {
  const v = activeView();
  if (v) setZoom(v.webContents.getZoomLevel() + delta);
}

function reloadActive() {
  const v = activeView();
  const site = siteById(activeId);
  if (!v || !site) return;
  v.webContents.getURL().startsWith("file://")
    ? v.webContents.loadURL(site.url)
    : v.webContents.reload();
}

// Atalhos: F5 / Ctrl+R recarregam, Ctrl + / - / 0 zoom, Ctrl+1..3 troca de site, F11 tela cheia
function handleShortcut(event, input) {
  if (input.type !== "keyDown") return;
  const ctrl = input.control || input.meta;

  if (input.key === "F5" || (ctrl && input.code === "KeyR")) {
    event.preventDefault();
    reloadActive();
  } else if (input.key === "F11") {
    event.preventDefault();
    win.setFullScreen(!win.isFullScreen());
  } else if (ctrl && /^Digit[1-9]$/.test(input.code)) {
    const s = sites[Number(input.code.slice(5)) - 1];
    if (s) {
      event.preventDefault();
      selectSite(s.id);
    }
  } else if (ctrl && ["Equal", "NumpadAdd"].includes(input.code)) {
    event.preventDefault();
    zoomBy(ZOOM_STEP);
  } else if (ctrl && ["Minus", "NumpadSubtract"].includes(input.code)) {
    event.preventDefault();
    zoomBy(-ZOOM_STEP);
  } else if (ctrl && ["Digit0", "Numpad0"].includes(input.code)) {
    event.preventDefault();
    setZoom(0);
  }
}

// ---------- Sessão (corretor pt-BR + permissões) ----------
function setupSession(partition) {
  if (configuredSessions.has(partition)) return;
  configuredSessions.add(partition);

  const ses = session.fromPartition(partition);
  ses.setUserAgent(CHROME_UA);
  ses.setSpellCheckerEnabled(true);
  ses.setSpellCheckerLanguages(["pt-BR"]);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const site = sites.find((s) => s.partition === partition);
    const ok =
      !!site &&
      ["notifications", "media", "clipboard-sanitized-write"].includes(permission) &&
      sameHost(details.requestingUrl, site);
    callback(ok);
  });
}

// ---------- Notificações nativas ----------
// No Linux, n.show() bloqueia o processo principal por ~25s se o serviço de notificações
// do D-Bus não responder (o app congela). Testamos o serviço de forma assíncrona antes.
let notifyOk = process.platform !== "linux";
let notifyProbing = false;

function probeNotifications() {
  if (notifyOk || notifyProbing) return;
  notifyProbing = true;
  execFile(
    "gdbus",
    [
      "call", "--session",
      "--dest", "org.freedesktop.Notifications",
      "--object-path", "/org/freedesktop/Notifications",
      "--method", "org.freedesktop.Notifications.GetServerInformation",
    ],
    { timeout: 3000 },
    (err) => {
      notifyProbing = false;
      // Sem gdbus instalado não há como testar: tenta mostrar normalmente
      notifyOk = !err || err.code === "ENOENT";
    }
  );
}

// Chamada do WhatsApp: troca para o site de onde ela vem
let lastCallRaise = 0;
function raiseForCall(site) {
  if (Date.now() - lastCallRaise < 10000) return; // notificação + tela da chamada = um só aviso
  lastCallRaise = Date.now();
  selectSite(site.id);
}

// Restrito ao texto da notificação de chamada, para uma mensagem comum com "chamada" não abrir a janela
const CALL_TEXT = /chamada de (voz|vídeo)|ligação de (voz|vídeo)|incoming (voice|video) call/i;

ipcMain.on("incoming-call", (e) => {
  const site = siteByWebContents(e.sender);
  if (site && e.senderFrame && sameHost(e.senderFrame.url, site)) raiseForCall(site);
});

ipcMain.on("notify", (e, { id, title, body }) => {
  const site = siteByWebContents(e.sender);
  if (!site || !e.senderFrame || !sameHost(e.senderFrame.url, site)) return;

  if (/(^|\.)whatsapp\.com$/.test(new URL(site.url).hostname) && CALL_TEXT.test(`${title} ${body}`)) {
    raiseForCall(site);
  }

  const n = new Notification({
    title: String(title || site.name),
    body: String(body || ""),
    icon: ICON,
  });
  liveNotifications.add(n);

  n.on("click", () => {
    showWindow();
    selectSite(site.id);
    const v = views.get(site.id);
    if (v) v.webContents.send("notification-click", id);
  });
  n.on("close", () => liveNotifications.delete(n));
  if (notifyOk) n.show();
  else {
    liveNotifications.delete(n);
    probeNotifications(); // tenta de novo: o serviço pode ter voltado
  }

  // Bolinha verde no ícone do site se você não está olhando para ele
  const looking = win && win.isVisible() && win.isFocused() && activeId === site.id;
  if (!looking) {
    unread[site.id] = true;
    sendState();
  }
  // Pisca o ícone na barra de tarefas se a janela não estiver em foco
  if (win && !win.isFocused()) win.flashFrame(true);
});

// ---------- Views dos sites ----------
function createSiteView(site) {
  setupSession(site.partition);

  const view = new WebContentsView({
    webPreferences: {
      partition: site.partition, // login separado por site
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // mantém recebendo mensagens em segundo plano
    },
  });
  win.contentView.addChildView(view);
  views.set(site.id, view);

  const wc = view.webContents;

  // Links externos abrem no navegador padrão; do próprio domínio ficam no app
  wc.setWindowOpenHandler(({ url }) => {
    if (sameHost(url, site)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  wc.on("will-navigate", (e, url) => {
    if (!sameHost(url, site) && !url.startsWith("file://")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Sem conexão / servidor fora: tela de erro com botão de tentar novamente
  wc.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = abortado
    wc.loadFile(path.join(__dirname, "error.html"), {
      query: { desc, url: site.url },
    });
  });

  // Ícone do site para a barra lateral
  wc.on("page-favicon-updated", (_e, favicons) => {
    if (!favicons.length || site.favicon === favicons[0]) return;
    site.favicon = favicons[0];
    saveSites();
    sendState();
  });

  // Aplica o zoom salvo sempre que uma página carregar
  wc.on("did-finish-load", () => wc.setZoomLevel(loadZoom()));
  wc.on("zoom-changed", (_e, direction) => zoomBy(direction === "in" ? ZOOM_STEP : -ZOOM_STEP));
  wc.on("before-input-event", handleShortcut);

  // Menu de contexto: sugestões do corretor, dicionário, recortar/copiar/colar
  wc.on("context-menu", (_e, params) => {
    const items = [];

    if (params.misspelledWord) {
      for (const sug of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: sug, click: () => wc.replaceMisspelling(sug) });
      }
      if (params.dictionarySuggestions.length === 0) {
        items.push({ label: "Sem sugestões", enabled: false });
      }
      items.push(
        {
          label: "Adicionar ao dicionário",
          click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        { type: "separator" }
      );
    }

    if (params.isEditable) {
      items.push(
        { label: "Recortar", role: "cut", enabled: params.editFlags.canCut },
        { label: "Copiar", role: "copy", enabled: params.editFlags.canCopy },
        { label: "Colar", role: "paste", enabled: params.editFlags.canPaste },
        { label: "Selecionar tudo", role: "selectAll" }
      );
    } else if (params.selectionText) {
      items.push({ label: "Copiar", role: "copy" });
    }

    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  if (site.url) wc.loadURL(site.url);
  layout();
  showActive();
  return view;
}

async function removeSite(id) {
  const site = siteById(id);
  if (!site || site.builtin) return;

  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Cancelar", "Remover"],
    defaultId: 0,
    cancelId: 0,
    title: "Remover site",
    message: `Remover "${site.name}"?`,
    detail: "O login salvo desse site será apagado.",
  });
  if (response !== 1) return;

  const view = views.get(id);
  if (view) {
    win.contentView.removeChildView(view);
    view.webContents.close();
    views.delete(id);
  }
  session.fromPartition(site.partition).clearStorageData().catch(() => {});
  sites = sites.filter((s) => s.id !== id);
  delete unread[id];
  if (activeId === id) activeId = sites[0].id;
  saveSites();
  showActive();
  sendState();
}

// ---------- IPC da barra lateral ----------
const fromShell = (e) => win && !win.isDestroyed() && e.sender === win.webContents;

ipcMain.handle("shell:get-state", (e) => {
  if (!fromShell(e)) return null;
  return {
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      builtin: !!s.builtin,
      favicon: s.favicon || null,
      unread: !!unread[s.id],
    })),
    activeId,
    max: MAX_SITES,
  };
});

// A página da barra lateral avisa quando o tamanho real da janela muda
ipcMain.on("shell:resized", (e) => {
  if (fromShell(e)) layout();
});

ipcMain.on("shell:select", (e, id) => {
  if (fromShell(e)) selectSite(id);
});

ipcMain.on("shell:modal", (e, open) => {
  if (!fromShell(e)) return;
  modalOpen = !!open;
  showActive();
  if (!modalOpen) {
    const v = activeView();
    if (v) v.webContents.focus();
  }
});

ipcMain.handle("shell:save", (e, data) => {
  if (!fromShell(e)) return { ok: false, error: "Origem inválida." };
  try {
    const name = String((data && data.name) || "").trim().slice(0, 30);
    if (!name) throw new Error("Informe um nome.");
    const url = normalizeUrl(data && data.url);

    if (data.id) {
      const site = siteById(data.id);
      if (!site) throw new Error("Site não encontrado.");
      site.name = name;
      if (url !== site.url) {
        site.url = url;
        site.favicon = undefined;
        const v = views.get(site.id);
        if (v) v.webContents.loadURL(url);
      }
      saveSites();
      sendState();
    } else {
      if (sites.length >= MAX_SITES) throw new Error(`Limite de ${MAX_SITES} sites atingido.`);
      const id = Date.now().toString(36);
      const site = { id, name, url, partition: `persist:site-${id}` };
      sites.push(site);
      createSiteView(site);
      selectSite(id);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof TypeError ? "Endereço inválido." : err.message };
  }
});

ipcMain.on("shell:menu", (e, id) => {
  if (!fromShell(e)) return;
  const site = siteById(id);
  if (!site) return;
  const items = [
    {
      label: "Recarregar",
      click: () => {
        const v = views.get(id);
        const site2 = siteById(id);
        if (!v || !site2) return;
        v.webContents.getURL().startsWith("file://")
          ? v.webContents.loadURL(site2.url)
          : v.webContents.reload();
      },
    },
  ];
  items.push({ label: "Editar…", click: () => win.webContents.send("shell:edit", id) });
  if (!site.builtin) {
    items.push({ type: "separator" }, { label: "Remover", click: () => removeSite(id) });
  }
  Menu.buildFromTemplate(items).popup({ window: win });
});

// ---------- Iniciar com o sistema (escondido na bandeja) ----------
const HIDDEN_ARG = "--hidden";

function setupAutostart() {
  if (!app.isPackaged) return; // em desenvolvimento (bun run start) não registra
  if (process.platform === "linux") {
    const exe = process.env.APPIMAGE || process.execPath;
    const dir = path.join(app.getPath("home"), ".config", "autostart");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${APP_ID}.desktop`),
        [
          "[Desktop Entry]",
          "Type=Application",
          `Name=${APP_NAME}`,
          `Exec="${exe}" ${HIDDEN_ARG}`,
          `Icon=${ICON}`,
          "X-GNOME-Autostart-enabled=true",
          "",
        ].join("\n")
      );
    } catch {}
  } else {
    app.setLoginItemSettings({ openAtLogin: true, args: [HIDDEN_ARG] });
  }
}

// ---------- Recarga periódica (libera memória) ----------
// A cada 2 dias recarrega os sites que não estão na tela; os dados continuam salvos no disco
const RELOAD_EVERY = 2 * 24 * 60 * 60 * 1000;

function reloadBackgroundSites() {
  for (const [id, v] of views) {
    if (id === activeId && win && win.isVisible()) continue; // não mexe no que você está usando
    const site = siteById(id);
    if (site) v.webContents.loadURL(site.url);
  }
}

// ---------- Janela principal ----------
function createWindow() {
  win = new BrowserWindow({
    show: !process.argv.includes(HIDDEN_ARG),
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    icon: ICON,
    backgroundColor: "#14161a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "shell-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "sidebar.html"));
  // Primeira abertura: pede o endereço do site principal
  win.webContents.once("did-finish-load", () => {
    if (!sites[0].url) win.webContents.send("shell:edit", "main");
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("before-input-event", handleShortcut);

  for (const s of sites) createSiteView(s);
  layout();
  showActive();

  for (const ev of [
    "resize",
    "resized",
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
    "restore",
    "show",
  ]) {
    win.on(ev, layout);
  }
  // Disparado quando o layout real da janela muda (mais confiável no Linux)
  win.contentView.on("bounds-changed", layout);

  // Fechar a janela apenas esconde: o app continua em segundo plano
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on("focus", () => {
    win.flashFrame(false);
    if (unread[activeId]) {
      unread[activeId] = false;
      sendState();
    }
  });
  win.on("show", () => win.flashFrame(false));
  win.on("closed", () => {
    win = null;
    views.clear();
    modalOpen = false;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  loadSites();
  probeNotifications();
  setupAutostart();
  createTray();
  createWindow();
  setInterval(reloadBackgroundSites, RELOAD_EVERY);
});

app.on("before-quit", () => {
  quitting = true;
});

// Não encerra ao fechar a janela: continua na bandeja
app.on("window-all-closed", () => {});
app.on("activate", showWindow);
