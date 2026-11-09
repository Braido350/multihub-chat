// Atualização automática. Fluxo completo em docs/ATUALIZACAO.md.
//  1. Ao abrir e a cada 6 h: baixa o latest.json da URL configurada e compara a versão (semver).
//  2. Versão nova: baixa o .zip em segundo plano para <dados do usuário>/updates, retomando de onde parou
//     e tentando de novo em caso de falha; uma versão já baixada (e conferida) não é baixada de novo.
//  3. Confere o SHA-256 e já extrai numa pasta temporária. Não pergunta nada.
//  4. Na próxima vez que o app abrir (antes da janela): grava o plano, inicia um atualizador separado
//     (apply.sh / apply.ps1, copiado para fora da pasta do app) e fecha. O atualizador espera o app fechar,
//     faz backup da versão atual, troca os arquivos, reabre o app e, se ele não iniciar, restaura o backup.
//     "Atualizar agora" nas Configurações faz o mesmo na hora.
// Banco, configurações e chaves ficam em <dados do usuário>, fora da pasta do app: nunca são tocados.
// Este módulo não depende do Electron: o main.js passa o que ele precisa (testável com Node puro).
"use strict";
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const semver = require("./semver");
const { extractZip, listZip } = require("./zip");

const CHECK_EVERY = 6 * 60 * 60 * 1000;
const FIRST_CHECK = 15_000; // espera o app abrir antes da primeira verificação
const RETRIES = 5;
const IDLE_TIMEOUT = 60_000; // download parado por 1 min: cancela e tenta de novo (retomando)
const LOG_MAX = 1024 * 1024;

/** Variáveis do AppImage/Electron que não podem passar para o app reaberto pelo atualizador. */
const DROP_ENV = ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "LD_LIBRARY_PATH", "ELECTRON_RUN_AS_NODE", "CHROME_DESKTOP", "GDK_BACKEND_ORIGINAL"];

async function sha256File(file) {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
const exists = (p) => fs.promises.access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Qual instalação é esta e o que o atualizador troca:
 *  - linux-appimage / win-portable: um arquivo só (o .AppImage ou o .exe portátil)
 *  - linux-dir / win-dir: a pasta do app (instalação do Windows ou pasta linux-unpacked)
 */
function detectInstall({ isPackaged, platform = process.platform, env = process.env, execPath = process.execPath }) {
  const os = platform === "win32" ? "win" : platform === "linux" ? "linux" : null;
  // Desenvolvimento (npm start): verifica e baixa o pacote "pasta" do sistema, mas não instala
  if (!isPackaged) return { kind: null, lookup: os ? `${os}-dir` : null, reason: "Rodando em modo de desenvolvimento (npm start): só a verificação e o download funcionam." };
  if (!os) return { kind: null, reason: `Sistema não suportado pelo atualizador: ${platform}` };
  if (os === "linux" && env.APPIMAGE) return { kind: "linux-appimage", mode: "file", target: env.APPIMAGE, exe: env.APPIMAGE };
  if (os === "win" && env.PORTABLE_EXECUTABLE_FILE) return { kind: "win-portable", mode: "file", target: env.PORTABLE_EXECUTABLE_FILE, exe: env.PORTABLE_EXECUTABLE_FILE };
  const dir = path.dirname(execPath);
  return { kind: `${os}-dir`, mode: "dir", target: dir, exe: path.join(dir, path.basename(execPath)) };
}

/**
 * @param {object} o
 * @param {string} o.currentVersion   versão instalada
 * @param {string} o.dataDir          pasta de dados do usuário (app.getPath("userData"))
 * @param {object} o.install          resultado de detectInstall
 * @param {string} o.defaultUrl       URL padrão do latest.json (package.json › multihub.updateUrl)
 * @param {() => void} o.quit         fecha o app (o atualizador separado assume dali)
 * @param {(msg: string) => void} [o.onRollback]  avisa que a última atualização falhou e foi desfeita
 */
function createUpdater(o) {
  const updatesDir = path.join(o.dataDir, "updates");
  const logFile = path.join(updatesDir, "update.log");
  const configFile = path.join(o.dataDir, "update-config.json");
  const stateFile = path.join(updatesDir, "state.json");
  const fetchFn = o.fetch || globalThis.fetch;
  const backoff = o.backoff || ((n) => Math.min(5 * 60_000, 5000 * 3 ** (n - 1)));
  const listeners = new Set();
  let status = { state: "idle" };
  let timer = null;
  let running = null;
  let lastResult = null; // resultado da última atualização (lido ao abrir)

  fs.mkdirSync(updatesDir, { recursive: true });

  function log(...a) {
    const line = `${new Date().toISOString()} [app ${o.currentVersion}] ${a.join(" ")}\n`;
    try {
      const st = fs.statSync(logFile, { throwIfNoEntry: false });
      if (st && st.size > LOG_MAX) fs.renameSync(logFile, logFile + ".1");
      fs.appendFileSync(logFile, line);
    } catch {}
    if (o.log) o.log(line.trimEnd());
  }
  function setStatus(s) {
    status = { ...s, current: o.currentVersion, kind: o.install.kind, at: Date.now() };
    for (const fn of listeners) fn(status);
  }
  const readJson = (f, d) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return d;
    }
  };
  const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

  function getConfig() {
    const c = readJson(configFile, {});
    return { url: process.env.MULTIHUB_UPDATE_URL || c.url || o.defaultUrl || "", auto: c.auto !== false };
  }
  function setConfig(p) {
    const c = readJson(configFile, {});
    if (p.url !== undefined) {
      const u = String(p.url || "").trim();
      if (u && !/^https:\/\//i.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(u)) throw new Error("Use um endereço https:// para o latest.json.");
      c.url = u;
    }
    if (p.auto !== undefined) c.auto = !!p.auto;
    writeJson(configFile, c);
    log(`configuração: url=${c.url || "(padrão)"} auto=${c.auto !== false}`);
    return getConfig();
  }

  // ---------- 1. latest.json ----------
  async function fetchManifest(url) {
    const res = await fetchFn(url, { headers: { "Cache-Control": "no-cache", Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`latest.json: HTTP ${res.status}`);
    const m = await res.json();
    if (!m || !semver.valid(m.version)) throw new Error("latest.json sem versão válida.");
    // Um arquivo por tipo de instalação ("files"), ou url/sha256 direto (um tipo só)
    const kind = o.install.kind || o.install.lookup;
    const entry = (m.files && m.files[kind]) || (m.url ? { url: m.url, sha256: m.sha256, size: m.size } : null);
    return { version: String(m.version).replace(/^v/, ""), notes: String(m.notes || "").slice(0, 4000), date: m.date || null, entry };
  }

  // ---------- 2. download com retomada ----------
  const zipPath = (version) => path.join(updatesDir, `MultiHubChat-${version}-${o.install.kind || o.install.lookup || "pacote"}.zip`);

  /** Baixa (ou reaproveita) o .zip e confere o SHA-256. Retorna o caminho do arquivo pronto. */
  async function download(version, entry) {
    if (!entry || !/^https?:\/\//i.test(entry.url || "")) throw new Error(`latest.json não tem arquivo para esta instalação (${o.install.kind || o.install.lookup}).`);
    const want = String(entry.sha256 || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(want)) throw new Error("latest.json sem SHA-256 válido.");
    const final = zipPath(version);
    const part = final + ".part";
    const meta = final + ".json";

    // Já baixada e conferida: não baixa de novo
    if (await exists(final)) {
      const m = readJson(meta, {});
      if (m.sha256 === want) {
        log(`versão ${version} já baixada (${path.basename(final)})`);
        return final;
      }
      log(`arquivo baixado não confere com o latest.json atual: baixando de novo`);
      await fsp.rm(final, { force: true });
    }
    // Pedaço de outro arquivo (o latest.json mudou): começa do zero
    const pm = readJson(part + ".json", {});
    if (pm.sha256 !== want || pm.url !== entry.url) await fsp.rm(part, { force: true });
    writeJson(part + ".json", { sha256: want, url: entry.url });

    let lastErr = null;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        await downloadOnce(entry.url, part, entry.size);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        log(`download falhou (tentativa ${attempt}/${RETRIES}): ${err.message}`);
        if (attempt < RETRIES) await sleep(backoff(attempt));
      }
    }
    if (lastErr) throw new Error(`Não foi possível baixar a versão ${version}: ${lastErr.message}`);

    setStatus({ state: "verifying", version });
    const got = await sha256File(part);
    if (got !== want) {
      await fsp.rm(part, { force: true });
      throw new Error(`SHA-256 não confere (esperado ${want.slice(0, 12)}…, recebido ${got.slice(0, 12)}…). Arquivo descartado.`);
    }
    await fsp.rename(part, final);
    await fsp.rm(part + ".json", { force: true });
    writeJson(meta, { version, sha256: want, url: entry.url, at: new Date().toISOString() });
    log(`versão ${version} baixada e conferida (SHA-256 ok)`);
    return final;
  }

  async function downloadOnce(url, part, expectedSize) {
    const have = (await fsp.stat(part).catch(() => null))?.size || 0;
    if (expectedSize && have === expectedSize) return; // já completo (falta só conferir)
    const ctrl = new AbortController();
    let idle = setTimeout(() => ctrl.abort(new Error("download parado")), IDLE_TIMEOUT);
    try {
      const res = await fetchFn(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: ctrl.signal, redirect: "follow" });
      if (res.status === 416 && have) return; // nada mais a baixar
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let start = have;
      if (have && res.status !== 206) {
        log("servidor não aceitou retomar: começando do zero");
        start = 0;
      }
      if (have && start === have) log(`retomando o download a partir de ${(have / 1048576).toFixed(1)} MB`);
      const len = Number(res.headers.get("content-length")) || 0;
      const total = len ? start + len : expectedSize || 0;
      const out = fs.createWriteStream(part, { flags: start ? "a" : "w" });
      let received = start;
      let lastEmit = 0;
      try {
        for await (const chunk of res.body) {
          clearTimeout(idle);
          idle = setTimeout(() => ctrl.abort(new Error("download parado")), IDLE_TIMEOUT);
          if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
          received += chunk.length;
          if (Date.now() - lastEmit > 500) {
            lastEmit = Date.now();
            setStatus({ ...status, state: "downloading", received, total });
          }
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
      if (total && received < total) throw new Error(`download incompleto (${received} de ${total} bytes)`);
    } finally {
      clearTimeout(idle);
    }
  }

  // ---------- verificação ----------
  /**
   * Verifica, baixa, confere e deixa pronta para a próxima abertura. manual = botão "Verificar atualizações".
   * @returns {Promise<object>} status final
   */
  function check({ manual = false } = {}) {
    if (running) return running;
    running = (async () => {
      const { url } = getConfig();
      if (!url) {
        setStatus({ state: "unconfigured", message: "Informe a URL do latest.json para receber atualizações." });
        return status;
      }
      try {
        setStatus({ state: "checking" });
        log(`verificando ${url}${manual ? " (manual)" : ""}`);
        const m = await fetchManifest(url);
        if (!semver.gt(m.version, o.currentVersion)) {
          log(`sem atualização (publicada ${m.version}, instalada ${o.currentVersion})`);
          setStatus({ state: "uptodate", latest: m.version });
          return status;
        }
        log(`versão nova: ${m.version} (instalada ${o.currentVersion})`);
        setStatus({ state: "downloading", version: m.version, received: 0, total: (m.entry && m.entry.size) || 0 });
        const file = await download(m.version, m.entry);
        // Sem perguntar: fica guardada e é aplicada na próxima vez que o app abrir
        writeJson(stateFile, { ...readJson(stateFile, {}), downloaded: { version: m.version, file, notes: m.notes, at: new Date().toISOString() } });
        if (o.install.kind) await prepare({ version: m.version, file }); // a próxima abertura só troca os arquivos
        log(`versão ${m.version} pronta: será instalada na próxima abertura do app`);
        setStatus({ state: "ready", version: m.version, notes: m.notes, date: m.date, file, installable: !!o.install.kind, reason: o.install.reason || null });
        return status;
      } catch (err) {
        log(`erro: ${err.message}`);
        setStatus({ state: "error", message: err.message });
        return status;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  // ---------- 4. instalar ----------
  /**
   * Extrai o pacote em updates/staging-X (fora da pasta do app), conferindo o SHA-256 antes. Feito logo depois
   * do download, para que a próxima abertura só precise trocar os arquivos. Reaproveita uma extração já feita.
   */
  async function prepare(pkg) {
    const meta = readJson(pkg.file + ".json", {});
    const staging = path.join(updatesDir, `staging-${pkg.version}`);
    const readyFile = staging + ".ready";
    if (meta.sha256 && readJson(readyFile, {}).sha256 === meta.sha256 && (await exists(staging))) return staging;
    // Confere de novo o arquivo (pode ter sido mexido desde o download)
    if ((await sha256File(pkg.file)) !== meta.sha256) throw new Error("O arquivo baixado mudou desde a conferência. Verifique de novo.");
    await fsp.rm(readyFile, { force: true });
    await fsp.rm(staging, { recursive: true, force: true });
    await extractZip(pkg.file, staging);
    writeJson(readyFile, { sha256: meta.sha256, version: pkg.version });
    log(`versão ${pkg.version} extraída e pronta em ${staging}`);
    return staging;
  }

  /** Instala a versão baixada (a do status ou, ao abrir, a guardada em state.json). */
  async function install(pkg) {
    pkg = pkg || (status.state === "ready" ? { version: status.version, file: status.file } : null);
    if (!pkg) throw new Error("Nenhuma atualização pronta para instalar.");
    const inst = o.install;
    if (!inst.kind) throw new Error(inst.reason || "Esta instalação não pode ser atualizada automaticamente.");
    const version = pkg.version;
    
    setStatus({ ...status, version, state: "installing" });
    log(`instalando ${version} (${inst.kind}) em ${inst.target}`);

    const staging = await prepare(pkg);
    let staged;
    if (inst.mode === "dir") {
      staged = staging;
      if (!(await exists(path.join(staging, path.basename(inst.exe))))) {
        throw new Error(`O pacote não corresponde a esta instalação (falta ${path.basename(inst.exe)}).`);
      }
    } else {
      const files = (await listZip(pkg.file)).filter((e) => !e.dir);
      if (files.length !== 1) throw new Error("O pacote deste tipo de instalação deve conter um único arquivo.");
      staged = path.join(staging, files[0].name);
    }
    // A pasta onde o app está precisa aceitar escrita (instalação "para todos os usuários" não aceita)
    // (cria um arquivo de teste: no Windows, fs.access não confere as permissões da pasta)
    try {
      const probe = path.join(path.dirname(inst.target), `.multihub-update-${process.pid}`);
      await fsp.writeFile(probe, "");
      await fsp.rm(probe, { force: true });
    } catch {
      throw new Error(`Sem permissão para atualizar em ${path.dirname(inst.target)}. Baixe e instale a versão nova manualmente.`);
    }

    const plan = {
      pid: o.pid ?? process.pid,
      mode: inst.mode,
      target: inst.target,
      staged,
      backup: path.join(updatesDir, "backup"),
      exe: inst.exe,
      marker: path.join(updatesDir, `started-${version}.ok`),
      log: logFile,
      result: path.join(updatesDir, "result.json"),
      version,
      from: o.currentVersion,
      waitExit: o.waitExit ?? 90,
      waitStart: o.waitStart ?? 90,
    };
    await fsp.rm(plan.marker, { force: true });
    await fsp.rm(plan.result, { force: true });
    const isWin = (o.platform || process.platform) === "win32";
    // O atualizador roda de uma cópia fora da pasta do app (que vai ser trocada)
    const script = path.join(updatesDir, isWin ? "apply.ps1" : "apply.sh");
    // (lê e grava em vez de copiar: no app empacotado o original fica dentro do app.asar)
    await fsp.writeFile(script, await fsp.readFile(path.join(__dirname, isWin ? "apply.ps1" : "apply.sh")));
    let args;
    if (isWin) {
      const planFile = path.join(updatesDir, "plan.json");
      writeJson(planFile, plan);
      args = ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-Plan", planFile]];
    } else {
      const planFile = path.join(updatesDir, "plan.env");
      const keys = { PID: plan.pid, MODE: plan.mode, TARGET: plan.target, STAGED: plan.staged, BACKUP: plan.backup, EXE: plan.exe, MARKER: plan.marker, LOG: plan.log, RESULT: plan.result, VERSION: plan.version, FROM: plan.from, WAIT_EXIT: plan.waitExit, WAIT_START: plan.waitStart };
      fs.writeFileSync(planFile, Object.entries(keys).map(([k, v]) => `U_${k}=${shq(v)}`).join("\n") + "\n");
      args = ["/bin/sh", [script, planFile]];
    }
    writeJson(stateFile, { ...readJson(stateFile, {}), pending: { version, from: o.currentVersion, at: new Date().toISOString() } });
    const env = { ...process.env };
    for (const k of DROP_ENV) delete env[k];
    const child = (o.spawn || spawn)(args[0], args[1], { detached: true, stdio: "ignore", env, windowsHide: true });
    child.unref();
    log(`atualizador iniciado (pid ${child.pid}); fechando o app`);
    o.quit();
    return { ok: true };
  }

  // ---------- ao abrir ----------
  /** Lê o resultado da última atualização (feito pelo atualizador separado). Pode ser chamado mais de uma vez. */
  function readResult() {
    const result = readJson(path.join(updatesDir, "result.json"), null);
    if (!result) return lastResult;
    lastResult = result;
    fs.rmSync(path.join(updatesDir, "result.json"), { force: true });
    const st = readJson(stateFile, {});
    delete st.pending;
    if (result.status === "rollback") {
      st.failedVersion = result.version; // não aplica de novo sozinha esta versão ("Atualizar agora" ainda funciona)
      log(`a atualização para ${result.version} falhou e a versão ${o.currentVersion} foi restaurada`);
    } else if (result.status === "ok") {
      delete st.failedVersion;
      if (st.downloaded && !semver.gt(st.downloaded.version, o.currentVersion)) delete st.downloaded;
      log(`atualizado de ${result.from} para ${result.version}`);
      // Limpa o pacote e a pasta temporária desta versão (o backup fica até a próxima atualização)
      for (const f of fs.readdirSync(updatesDir)) {
        const v = (/^MultiHubChat-(.+?)-(linux|win|pacote)/.exec(f) || [])[1];
        if (f.startsWith("staging-") || (v && semver.valid(v) && !semver.gt(v, o.currentVersion))) {
          fs.rmSync(path.join(updatesDir, f), { recursive: true, force: true });
        }
      }
    }
    writeJson(stateFile, st);
    return result;
  }

  /** O app novo avisa que iniciou (o atualizador espera por isto) e avisa se a última atualização foi desfeita. */
  function startedOk() {
    try {
      fs.writeFileSync(path.join(updatesDir, `started-${o.currentVersion}.ok`), new Date().toISOString());
    } catch {}
    const result = readResult();
    if (result && result.status === "rollback" && !result.warned) {
      result.warned = true;
      if (o.onRollback) o.onRollback(`A atualização para a versão ${result.version} não iniciou e a versão ${o.currentVersion} foi restaurada. Detalhes em ${logFile}.`);
    }
    return result;
  }

  /**
   * Ao abrir, antes da janela: se há uma versão nova já baixada e conferida, aplica agora (o app fecha e o
   * atualizador separado reabre a versão nova). Retorna true se a atualização começou.
   */
  async function applyPending() {
    readResult(); // a versão que acabou de ser restaurada não pode ser aplicada de novo (evita repetir sem fim)
    const st = readJson(stateFile, {});
    const d = st.downloaded;
    if (!d || !o.install.kind || !semver.valid(d.version) || !semver.gt(d.version, o.currentVersion)) return false;
    if (d.version === st.failedVersion) return false;
    if (!(await exists(d.file))) return false;
    log(`aplicando a versão ${d.version} baixada antes (sem perguntar)`);
    try {
      await install({ version: d.version, file: d.file });
      return true;
    } catch (err) {
      log(`não foi possível aplicar ao abrir: ${err.message}`);
      setStatus({ state: "error", message: err.message });
      return false;
    }
  }

  function start() {
    const r = startedOk();
    log(`app iniciado (${o.install.kind || "desenvolvimento"})`);
    if (!getConfig().auto) return r;
    timer = setTimeout(function tick() {
      check().catch(() => {});
      timer = setTimeout(tick, CHECK_EVERY);
    }, o.firstCheck ?? FIRST_CHECK);
    return r;
  }
  function stop() {
    clearTimeout(timer);
  }

  return {
    start,
    stop,
    check,
    install,
    applyPending,
    getStatus: () => status,
    getConfig,
    setConfig,
    onStatus: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    logFile,
    updatesDir,
    // para testes
    _download: download,
    _startedOk: startedOk,
  };
}

module.exports = { createUpdater, detectInstall, sha256File, CHECK_EVERY };
