// Lado do processo principal: inicia o serviço de e-mail (utilityProcess), faz a ponte de
// criptografia com o chaveiro do sistema (safeStorage) e liga a aba de E-mail ao serviço.
const { utilityProcess, MessageChannelMain, safeStorage, shell, app, dialog } = require("electron");
const path = require("path");
const os = require("os");

// Únicos endereços que o serviço pode pedir para abrir no navegador
const EXTERNAL_ALLOWED = /^https:\/\/accounts\.google\.com\//;
// Anexos só são abertos a partir da pasta temporária do serviço, e nunca executáveis
const TMP_ROOT = path.join(os.tmpdir(), "multihub-mail") + path.sep;
const BLOCKED_EXT =
  /\.(exe|com|bat|cmd|msi|msix|msp|scr|pif|cpl|hta|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|reg|lnk|url|scf|inf|dll|sys|sh|bash|run|bin|appimage|desktop|deb|rpm|apk|app|command|py|pl|rb|iso|img|vhd|vhdx|docm|xlsm|pptm)$/i;

class EmailHost {
  /** @param {{ onCounts: (total:number) => void, getWindow: () => Electron.BrowserWindow | null }} opts */
  constructor({ onCounts, getWindow }) {
    this.onCounts = onCounts;
    this.getWindow = getWindow || (() => null);
    this.child = null;
    this.stopping = false;
    this.views = new Set(); // webContents da aba de E-mail
  }

  start() {
    if (this.child) return;
    this.stopping = false;
    const child = utilityProcess.fork(path.join(__dirname, "service", "index.js"), [], {
      serviceName: "MultiHub Chat E-mail",
      stdio: "inherit",
    });
    this.child = child;

    // O serviço espera o "init" antes de atender a interface
    (async () => {
      let available = false;
      let backend = "unknown";
      try {
        available = await safeStorage.isAsyncEncryptionAvailable();
        if (process.platform === "linux") backend = safeStorage.getSelectedStorageBackend();
        else backend = process.platform === "win32" ? "dpapi" : "keychain";
      } catch {}
      if (this.child !== child) return;
      child.postMessage({
        t: "init",
        dataDir: path.join(app.getPath("userData"), "email"),
        crypto: { available, backend },
      });
    })();

    child.on("message", (msg) => this.onMessage(msg));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      console.error(`[email] serviço encerrou (código ${code}); reiniciando`);
      setTimeout(() => {
        if (this.stopping) return;
        this.start();
        for (const wc of this.views) this.connect(wc);
      }, 3000);
    });
  }

  async onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    const child = this.child;
    const reply = (result, error) => child && child.postMessage({ t: "reply", id: msg.id, result, error });
    try {
      if (msg.t === "encrypt") {
        reply((await safeStorage.encryptStringAsync(String(msg.text))).toString("base64"));
      } else if (msg.t === "decrypt") {
        // shouldReEncrypt (troca de chave do chaveiro) é tratado na fase 5
        reply((await safeStorage.decryptStringAsync(Buffer.from(String(msg.b64), "base64"))).result);
      } else if (msg.t === "open-external") {
        if (EXTERNAL_ALLOWED.test(String(msg.url))) shell.openExternal(msg.url);
      } else if (msg.t === "counts") {
        this.onCounts(Number(msg.total) || 0);
      } else if (msg.t === "save-dialog") {
        const name = path.basename(String(msg.defaultName || "anexo")).replace(/[\x00-\x1f]/g, "_");
        const opts = { title: "Salvar anexo", defaultPath: path.join(app.getPath("downloads"), name) };
        const win = this.getWindow();
        const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
        reply(r.canceled ? null : r.filePath);
      } else if (msg.t === "open-path") {
        const file = path.resolve(String(msg.file || ""));
        if (!file.startsWith(TMP_ROOT) || BLOCKED_EXT.test(file)) throw new Error("Arquivo não permitido.");
        const err = await shell.openPath(file);
        if (err) throw new Error(err);
        reply(true);
      }
    } catch (err) {
      reply(undefined, msg.t === "encrypt" || msg.t === "decrypt" ? "Falha no chaveiro do sistema: " + err.message : err.message);
    }
  }

  /** Liga a página da aba de E-mail ao serviço por um canal direto (MessagePort). */
  connect(wc) {
    if (!this.child || wc.isDestroyed()) return;
    if (!this.views.has(wc)) {
      this.views.add(wc);
      wc.once("destroyed", () => this.views.delete(wc));
    }
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage({ t: "port" }, [port1]);
    wc.postMessage("email:port", null, [port2]);
  }

  syncAll() {
    if (this.child) this.child.postMessage({ t: "sync-all" });
  }

  stop() {
    this.stopping = true;
    const c = this.child;
    this.child = null;
    if (!c) return;
    c.postMessage({ t: "shutdown" });
    setTimeout(() => c.kill(), 3000);
  }
}

module.exports = { EmailHost };
