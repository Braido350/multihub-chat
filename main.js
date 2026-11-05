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
const { EmailHost } = require("./email/host");

const APP_NAME = "MultiHub Chat";
const APP_ID = "io.github.multihub-chat";
const ICON = path.join(__dirname, "icon.png");
const LINUX_APP_ID = "multihub-chat"; // = desktopName do package.json (app_id no Wayland / WM_CLASS no X11)
const SIDEBAR_W = 48;
const MAX_SITES = 3; // site principal + 2 adicionais (a aba de E-mail não conta)
const EMAIL_ID = "email";
const isEmail = (s) => !!s && s.kind === "email";
const webSites = () => sites.filter((s) => !isEmail(s));

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
let emailHost = null;
let emailUnread = 0;

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
  if (data.email) sites.push(emailSite());
  activeId = "main"; // sempre abre no site principal ao iniciar
}

function saveSites() {
  try {
    fs.writeFileSync(
      sitesFile(),
      JSON.stringify({
        main: { name: sites[0].name, url: sites[0].url },
        sites: webSites()
          .filter((s) => !s.builtin)
          .map(({ id, name, url, partition, favicon }) => ({ id, name, url, partition, favicon })),
        email: sites.some(isEmail),
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
function shellState() {
  return {
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      kind: s.kind || "web",
      builtin: !!s.builtin,
      favicon: s.favicon || null,
      unread: !!unread[s.id],
      badge: isEmail(s) ? emailUnread : 0,
    })),
    activeId,
    max: MAX_SITES,
    canAddSite: webSites().length < MAX_SITES,
    emailOpen: sites.some(isEmail),
  };
}

function sendState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("shell:state", shellState());
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
  // Várias resoluções: o sistema escolhe a certa para a escala da tela (125%, 150%, 200%...)
  const base = nativeImage.createFromPath(ICON);
  const size = process.platform === "win32" ? 16 : process.platform === "darwin" ? 18 : 24;
  const img = nativeImage.createEmpty();
  for (const scale of [1, 1.25, 1.5, 2, 3]) {
    const px = Math.round(size * scale);
    img.addRepresentation({
      scaleFactor: scale,
      width: px,
      height: px,
      buffer: base.resize({ width: px, height: px, quality: "best" }).toPNG(),
    });
  }
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

function reloadSite(id) {
  const v = views.get(id);
  const site = siteById(id);
  if (!v || !site) return;
  if (isEmail(site)) return v.webContents.reload(); // o estado da tela volta do localStorage
  v.webContents.getURL().startsWith("file://")
    ? v.webContents.loadURL(site.url)
    : v.webContents.reload();
}

function reloadActive() {
  reloadSite(activeId);
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
  if (isEmail(site)) return createEmailView(site);
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

  const { response } = await dialog.showMessageBox(
    win,
    isEmail(site)
      ? {
          type: "question",
          buttons: ["Cancelar", "Fechar"],
          defaultId: 0,
          cancelId: 0,
          title: "Fechar aba de E-mail",
          message: "Fechar a aba de E-mail?",
          detail: "As contas e o cache continuam salvos: ao abrir de novo pelo +, tudo volta como estava.",
        }
      : {
          type: "warning",
          buttons: ["Cancelar", "Remover"],
          defaultId: 0,
          cancelId: 0,
          title: "Remover site",
          message: `Remover "${site.name}"?`,
          detail: "O login salvo desse site será apagado.",
        }
  );
  if (response !== 1) return;

  const view = views.get(id);
  if (view) {
    win.contentView.removeChildView(view);
    view.webContents.close();
    views.delete(id);
  }
  if (isEmail(site)) {
    if (emailHost) emailHost.stop();
    emailHost = null;
    emailUnread = 0;
  } else {
    session.fromPartition(site.partition).clearStorageData().catch(() => {});
  }
  sites = sites.filter((s) => s.id !== id);
  delete unread[id];
  if (activeId === id) activeId = sites[0].id;
  saveSites();
  showActive();
  sendState();
}

// ---------- Aba de E-mail (única) ----------
function emailSite() {
  return { id: EMAIL_ID, kind: "email", name: "E-mail", url: "", partition: "persist:email" };
}

function setupEmailSession(partition) {
  if (configuredSessions.has(partition)) return;
  configuredSessions.add(partition);
  const ses = session.fromPartition(partition);
  ses.setSpellCheckerEnabled(true);
  ses.setSpellCheckerLanguages(["pt-BR"]);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // A interface do e-mail não acessa a rede: tudo passa pelo serviço. Isso também impede
  // que imagens remotas ou pixels de rastreamento de um e-mail carreguem por acidente.
  ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_d, cb) =>
    cb({ cancel: true })
  );
}

function startEmailHost() {
  if (emailHost) return emailHost;
  emailHost = new EmailHost({
    getWindow: () => win,
    onCounts: (total) => {
      if (total === emailUnread) return;
      emailUnread = total;
      sendState();
    },
  });
  emailHost.start();
  return emailHost;
}

function createEmailView(site) {
  setupEmailSession(site.partition);
  const host = startEmailHost();

  const view = new WebContentsView({
    webPreferences: {
      partition: site.partition,
      preload: path.join(__dirname, "email", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  win.contentView.addChildView(view);
  views.set(site.id, view);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    e.preventDefault();
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });
  // A cada carga (inclusive F5) a página recebe um canal novo com o serviço
  wc.on("did-finish-load", () => {
    wc.setZoomLevel(loadZoom());
    host.connect(wc);
  });
  wc.on("zoom-changed", (_e, direction) => zoomBy(direction === "in" ? ZOOM_STEP : -ZOOM_STEP));
  wc.on("before-input-event", handleShortcut);
  wc.on("context-menu", (_e, params) => {
    const items = [];
    if (params.misspelledWord) {
      for (const sug of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: sug, click: () => wc.replaceMisspelling(sug) });
      }
      if (items.length) items.push({ type: "separator" });
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

  wc.loadFile(path.join(__dirname, "email", "ui", "index.html"));
  layout();
  showActive();
  return view;
}

/** "+" → E-mail: abre a aba se não existir; se já existir, só leva até ela. */
function openEmail() {
  if (!siteById(EMAIL_ID)) {
    const site = emailSite();
    sites.push(site);
    createSiteView(site);
  }
  selectSite(EMAIL_ID);
  sendState();
}

// ---------- IPC da barra lateral ----------
const fromShell = (e) => win && !win.isDestroyed() && e.sender === win.webContents;

ipcMain.handle("shell:get-state", (e) => {
  if (!fromShell(e)) return null;
  return shellState();
});

// A página da barra lateral avisa quando o tamanho real da janela muda
ipcMain.on("shell:resized", (e) => {
  if (fromShell(e)) layout();
});

ipcMain.on("shell:select", (e, id) => {
  if (fromShell(e)) selectSite(id);
});

// Menu do botão "+": novo site da web ou a aba de E-mail
ipcMain.on("shell:add-menu", (e) => {
  if (!fromShell(e)) return;
  const emailOpen = sites.some(isEmail);
  const canAdd = webSites().length < MAX_SITES;
  Menu.buildFromTemplate([
    {
      label: canAdd ? "Site da web…" : `Site da web (limite de ${MAX_SITES})`,
      enabled: canAdd,
      click: () => win.webContents.send("shell:edit", null),
    },
    { label: emailOpen ? "E-mail (ir para a aba)" : "E-mail", click: openEmail },
  ]).popup({ window: win });
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
      if (webSites().length >= MAX_SITES) throw new Error(`Limite de ${MAX_SITES} sites atingido.`);
      const id = Date.now().toString(36);
      const site = { id, name, url, partition: `persist:site-${id}` };
      // sites da web ficam antes da aba de E-mail
      const at = sites.findIndex(isEmail);
      at === -1 ? sites.push(site) : sites.splice(at, 0, site);
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
  if (isEmail(site)) {
    Menu.buildFromTemplate([
      { label: "Sincronizar agora", click: () => emailHost && emailHost.syncAll() },
      { label: "Recarregar", click: () => reloadSite(id) },
      { type: "separator" },
      { label: "Fechar aba de E-mail", click: () => removeSite(id) },
    ]).popup({ window: win });
    return;
  }
  const items = [{ label: "Recarregar", click: () => reloadSite(id) }];
  items.push({ label: "Editar…", click: () => win.webContents.send("shell:edit", id) });
  if (!site.builtin) {
    items.push({ type: "separator" }, { label: "Remover", click: () => removeSite(id) });
  }
  Menu.buildFromTemplate(items).popup({ window: win });
});

// ---------- Ícone no Linux ----------
// O AppImage não instala nada: sem um .desktop com o mesmo nome do app_id da janela, o GNOME/KDE
// (principalmente no Wayland, que ignora o ícone da janela) mostram um ícone genérico na dock.
// Registramos o ícone e o atalho em ~/.local/share, como um app instalado.
function integrateLinuxDesktop() {
  if (process.platform !== "linux" || !app.isPackaged || !process.env.APPIMAGE) return;
  try {
    const share = path.join(app.getPath("home"), ".local", "share");
    const base = nativeImage.createFromPath(ICON);
    for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) {
      const dir = path.join(share, "icons", "hicolor", `${s}x${s}`, "apps");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${LINUX_APP_ID}.png`), base.resize({ width: s, height: s, quality: "best" }).toPNG());
    }
    const desktop = [
      "[Desktop Entry]",
      "Type=Application",
      `Name=${APP_NAME}`,
      "Comment=WhatsApp Web, Chatwoot e e-mail em um só app",
      `Exec="${process.env.APPIMAGE}" %U`,
      `Icon=${LINUX_APP_ID}`,
      `StartupWMClass=${LINUX_APP_ID}`,
      "Terminal=false",
      "Categories=Network;InstantMessaging;Email;",
      "",
    ].join("\n");
    const appsDir = path.join(share, "applications");
    const file = path.join(appsDir, `${LINUX_APP_ID}.desktop`);
    let current = "";
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {}
    if (current !== desktop) {
      fs.mkdirSync(appsDir, { recursive: true });
      fs.writeFileSync(file, desktop);
      // Atualiza os caches (se as ferramentas existirem); sem elas o sistema percebe sozinho depois
      execFile("update-desktop-database", [appsDir], () => {});
      execFile("gtk-update-icon-cache", ["-f", "-t", path.join(share, "icons", "hicolor")], () => {});
    }
  } catch {}
}

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
          `Icon=${LINUX_APP_ID}`,
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
    if (site && !isEmail(site)) v.webContents.loadURL(site.url); // o E-mail não precisa (e perderia rascunhos)
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
  integrateLinuxDesktop();
  setupAutostart();
  createTray();
  createWindow();
  setInterval(reloadBackgroundSites, RELOAD_EVERY);
});

app.on("before-quit", () => {
  quitting = true;
  if (emailHost) emailHost.stop();
});

// Não encerra ao fechar a janela: continua na bandeja
app.on("window-all-closed", () => {});
app.on("activate", showWindow);
