// Testes da atualização automática com uma versão falsa, um servidor HTTP local e um "app" falso.
// Uso: node updater/test/run-updater-tests.js   (Linux: a troca de arquivos usa o apply.sh de verdade)
//  1. semver
//  2. zip: cria, lista e extrai mantendo permissões
//  3. latest.json, download com retomada (conexão cai no meio), nova tentativa, SHA-256
//  4. não pergunta nada; não baixa de novo uma versão já baixada
//  5. SHA-256 errado: descarta e não guarda para instalar
//  6. instalação ao abrir o app (pasta): espera o app fechar, backup, troca, reabre, dados intactos, log
//  7. versão nova que não inicia: restaura o backup e avisa na próxima abertura
//  8. instalação de arquivo único (como o AppImage)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { createUpdater, sha256File } = require("..");
const { createZip, extractZip, listZip } = require("../zip");
const semver = require("../semver");

let fails = 0;
let checks = 0;
const ok = (cond, label, extra) => {
  checks++;
  if (!cond) fails++;
  console.log(`${cond ? "OK   " : "FALHA"} ${label}${extra ? `  ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};
const read = (f) => fs.readFileSync(f, "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-update-"));

// ---------- servidor local (latest.json + pacotes), com Range e falhas simuladas ----------
const served = new Map(); // caminho -> arquivo
const hits = [];
let cutNext = 0; // derruba a próxima resposta de pacote depois de N bytes
let manifest = null;
const server = http.createServer((req, res) => {
  hits.push({ url: req.url, range: req.headers.range || null });
  if (req.url === "/latest.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(manifest));
  }
  const file = served.get(req.url);
  if (!file) return res.writeHead(404).end();
  const size = fs.statSync(file).size;
  let start = 0;
  const m = /bytes=(\d+)-/.exec(req.headers.range || "");
  if (m) start = +m[1];
  if (start >= size) return res.writeHead(416).end();
  res.writeHead(m ? 206 : 200, { "Content-Length": size - start, ...(m ? { "Content-Range": `bytes ${start}-${size - 1}/${size}` } : {}) });
  const stream = fs.createReadStream(file, { start });
  if (cutNext) {
    const limit = cutNext;
    cutNext = 0;
    let sent = 0;
    stream.on("data", (c) => {
      sent += c.length;
      if (sent >= limit) {
        stream.destroy();
        res.destroy(); // conexão cai no meio do download
      }
    });
  }
  stream.pipe(res);
});

function updaterFor(dataDir, extra = {}) {
  const prompts = [];
  const u = createUpdater({
    currentVersion: "1.0.0",
    dataDir,
    install: { kind: null, reason: "teste" },
    defaultUrl: `http://127.0.0.1:${server.address().port}/latest.json`,
    prompt: async (info) => (prompts.push(info), "later"), // não deve ser chamado: não há pergunta
    quit: () => {},
    backoff: () => 50,
    firstCheck: 0,
    ...extra,
  });
  return { u, prompts };
}

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ---------- 1. semver ----------
  console.log("=== 1. Versões (semver) ===");
  ok(semver.gt("1.10.0", "1.9.9") && semver.gt("2.0.0", "1.99.99") && !semver.gt("1.0.0", "1.0.0"), "Compara número a número (1.10 > 1.9)");
  ok(semver.gt("1.2.0", "1.2.0-beta.2") && semver.gt("1.2.0-beta.10", "1.2.0-beta.2") && semver.gt("v1.0.1", "1.0.0"), "Pré-lançamento e prefixo v");
  ok(!semver.valid("1.2") && !semver.valid("abc"), "Rejeita versão inválida");

  // ---------- 2. zip ----------
  console.log("\n=== 2. Pacote .zip ===");
  const src = path.join(tmp, "src");
  fs.mkdirSync(path.join(src, "resources"), { recursive: true });
  fs.writeFileSync(path.join(src, "app"), "#!/bin/sh\necho v\n", { mode: 0o755 });
  fs.writeFileSync(path.join(src, "resources", "dados.bin"), require("crypto").randomBytes(400_000));
  await createZip(src, path.join(tmp, "t.zip"));
  await extractZip(path.join(tmp, "t.zip"), path.join(tmp, "t-out"));
  ok(read(path.join(tmp, "t-out", "app")) === read(path.join(src, "app")) && (fs.statSync(path.join(tmp, "t-out", "app")).mode & 0o111) !== 0,
    "Extrai igual e mantém o bit de execução");
  ok(fs.readFileSync(path.join(tmp, "t-out", "resources", "dados.bin")).equals(fs.readFileSync(path.join(src, "resources", "dados.bin"))), "Arquivo binário íntegro (CRC conferido)");
  const evil = path.join(tmp, "evil.zip");
  fs.copyFileSync(path.join(tmp, "t.zip"), evil);
  const buf = fs.readFileSync(evil);
  const at = buf.indexOf(Buffer.from("resources/dados.bin"), buf.length - 400);
  Buffer.from("../../../../tmp/x").copy(buf, at); // mesmo tamanho de nome não é garantido; basta ter ".."
  fs.writeFileSync(evil, buf);
  let blocked = false;
  try {
    await extractZip(evil, path.join(tmp, "evil-out"));
  } catch (e) {
    blocked = /inválido/.test(e.message);
  }
  ok(blocked, "Bloqueia caminho com ../ (zip slip)");

  // ---------- 3. download com retomada ----------
  console.log("\n=== 3. Verificação e download ===");
  const pkgDir = path.join(tmp, "pkg");
  fs.mkdirSync(pkgDir);
  const zip2 = path.join(pkgDir, "v2.zip");
  fs.mkdirSync(path.join(tmp, "big"));
  fs.writeFileSync(path.join(tmp, "big", "blob"), require("crypto").randomBytes(3_000_000));
  await createZip(path.join(tmp, "big"), zip2);
  const sha2 = await sha256File(zip2);
  served.set("/v2.zip", zip2);
  manifest = { version: "9.9.9-fake", notes: "Versão falsa de teste.\n- item 1", files: { "win-dir": { url: `${base}/v2.zip`, sha256: sha2, size: fs.statSync(zip2).size } }, url: `${base}/v2.zip`, sha256: sha2 };

  const data1 = path.join(tmp, "dados1");
  fs.mkdirSync(data1);
  let { u, prompts } = updaterFor(data1);
  const states = [];
  u.onStatus((s) => states.push(s.state));
  cutNext = 1_000_000; // a primeira conexão cai depois de ~1 MB
  hits.length = 0;
  let st = await u.check();
  await sleep(50);
  const zipHits = hits.filter((x) => x.url === "/v2.zip");
  ok(st.state === "ready" && st.version === "9.9.9-fake", "Versão falsa 9.9.9-fake encontrada, baixada e pronta", st.state + (st.message ? ` ${st.message}` : ""));
  ok(zipHits.length === 2 && !zipHits[0].range && /^bytes=\d+-$/.test(zipHits[1].range || "") && +zipHits[1].range.slice(6, -1) > 0,
    "Conexão caiu e o download foi retomado de onde parou (Range)", zipHits.map((x) => x.range || "início").join(" → "));
  ok((await sha256File(st.file)) === sha2 && st.file.startsWith(path.join(data1, "updates")), "SHA-256 confere e o pacote fica na pasta de atualizações do usuário");
  ok(states.indexOf("verifying") > states.indexOf("downloading") && states.indexOf("ready") > states.indexOf("verifying"), "Só fica pronto depois de conferir", states.filter((s, i) => s !== states[i - 1]).join(" → "));
  ok(prompts.length === 0 && st.notes && /item 1/.test(st.notes), "Não pergunta nada (as notas ficam nas Configurações)");
  const saved = JSON.parse(read(path.join(data1, "updates", "state.json"))).downloaded;
  ok(saved && saved.version === "9.9.9-fake" && saved.file === st.file, "Guardada para instalar na próxima abertura");

  // ---------- 4. não baixa de novo; "Depois" ----------
  console.log("\n=== 4. Já baixada ===");
  hits.length = 0;
  st = await u.check();
  ok(st.state === "ready" && !hits.some((x) => x.url === "/v2.zip"), "Não baixa de novo a versão já baixada");
  ok(!(await updaterFor(data1).u.applyPending()), "Em modo de desenvolvimento não instala ao abrir");
  manifest.version = "1.0.0";
  st = await updaterFor(data1).u.check({ manual: true });
  ok(st.state === "uptodate", "Mesma versão publicada: nada a fazer");
  manifest.version = "9.9.9-fake";

  // ---------- 5. SHA-256 errado ----------
  console.log("\n=== 5. SHA-256 errado ===");
  const data2 = path.join(tmp, "dados2");
  fs.mkdirSync(data2);
  manifest.files["win-dir"].sha256 = manifest.sha256 = "0".repeat(64);
  ({ u, prompts } = updaterFor(data2));
  st = await u.check();
  const left = fs.readdirSync(path.join(data2, "updates")).filter((f) => f.endsWith(".zip") || f.endsWith(".part"));
  ok(st.state === "error" && /SHA-256 não confere/.test(st.message) && !left.length && !fs.existsSync(path.join(data2, "updates", "state.json")), "Descarta o arquivo e não guarda para instalar", st.message);
  manifest.files["win-dir"].sha256 = manifest.sha256 = sha2;

  if (process.platform === "win32") {
    console.log("\n(instalação: testes 6–8 usam o apply.sh; no Windows, teste manual conforme docs/ATUALIZACAO.md)");
  } else {
    // ---------- 6. instalação (pasta) ----------
    console.log("\n=== 6. Instalação: pasta do app (a troca da instalação do Windows, rodada aqui com o apply.sh) ===");
    const userData = path.join(tmp, "userdata");
    fs.mkdirSync(userData);
    fs.writeFileSync(path.join(userData, "mail.db"), "BANCO");
    fs.writeFileSync(path.join(userData, "sites.json"), "{\"config\":1}");
    const installDir = path.join(tmp, "Apps", "MultiHubChat");
    const appV1 = path.join(tmp, "v1");
    const appV2 = path.join(tmp, "v2");
    const fakeApp = (dir, version, starts) => {
      fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
      fs.writeFileSync(path.join(dir, "resources", "VERSAO"), version);
      // O app de verdade grava started-<versão>.ok ao abrir; este falso faz o mesmo (ou não, para testar a volta)
      fs.writeFileSync(path.join(dir, "multihub-chat"),
        `#!/bin/sh\necho "$$" > "${path.join(userData, "updates", `rodando-${version}`)}"\n` +
        (starts ? `sleep 1; date > "${path.join(userData, "updates", `started-${version}.ok`)}"\nsleep 2\n` : "sleep 1; exit 3\n"),
        { mode: 0o755 });
    };
    fakeApp(appV1, "1.0.0", true);
    fs.cpSync(appV1, installDir, { recursive: true });
    fakeApp(appV2, "9.9.9-fake", true);
    const zipV2 = path.join(pkgDir, "app-v2.zip");
    await createZip(appV2, zipV2);
    served.set("/app-v2.zip", zipV2);
    manifest.files["win-dir"] = { url: `${base}/app-v2.zip`, sha256: await sha256File(zipV2) };

    const instDir = { kind: "win-dir", mode: "dir", target: installDir, exe: path.join(installDir, "multihub-chat") };
    ({ u } = updaterFor(userData, { install: instDir }));
    st = await u.check();
    ok(st.state === "ready" && st.installable && fs.existsSync(path.join(userData, "updates", "staging-9.9.9-fake.ready")), "Baixado e já extraído em segundo plano", st.message || "");
    ok(read(path.join(installDir, "resources", "VERSAO")) === "1.0.0", "Nada muda enquanto o app está aberto");
    // Próxima abertura do app: aplica antes de abrir a janela
    const fakeRunning = spawn("sleep", ["2"]); // o "app" que precisa fechar antes da troca
    let quitCalled = false;
    ({ u } = updaterFor(userData, { install: instDir, pid: fakeRunning.pid, waitStart: 10, quit: () => (quitCalled = true) }));
    const t0 = Date.now();
    ok(await u.applyPending(), "Ao abrir: aplica a versão baixada sem perguntar");
    const resultFile = path.join(userData, "updates", "result.json");
    await until(() => fs.existsSync(resultFile), 30000);
    const res = fs.existsSync(resultFile) ? JSON.parse(read(resultFile)) : {};
    const log = read(path.join(userData, "updates", "update.log"));
    ok(quitCalled && /esperando iniciar/.test(log) && log.indexOf("app fechado") > -1 && Date.now() - t0 >= 1500, "Atualizador separado espera o app fechar antes de trocar");
    ok(res.status === "ok" && read(path.join(installDir, "resources", "VERSAO")) === "9.9.9-fake", "Versão nova no lugar e iniciou", JSON.stringify(res));
    ok(read(path.join(userData, "updates", "backup", "resources", "VERSAO")) === "1.0.0", "Backup da versão anterior guardado");
    ok(read(path.join(userData, "mail.db")) === "BANCO" && read(path.join(userData, "sites.json")) === "{\"config\":1}", "Banco e configurações intactos");
    ok(/backup feito/.test(log) && /iniciou: atualização concluída/.test(log) && /instalando 9\.9\.9-fake/.test(log), "Tudo registrado no log");
    // Próxima abertura (já na versão nova): lê o resultado e limpa
    const after = createUpdater({ currentVersion: "9.9.9-fake", dataDir: userData, install: { kind: "win-dir" }, prompt: async () => "later", quit: () => {} });
    const r2 = after._startedOk();
    ok(r2 && r2.status === "ok" && !fs.readdirSync(path.join(userData, "updates")).some((f) => f.startsWith("staging-")), "Ao abrir a versão nova: resultado lido e temporários apagados");

    // ---------- 7. versão que não inicia: restaura ----------
    console.log("\n=== 7. Versão nova que não inicia ===");
    const appV3 = path.join(tmp, "v3");
    fakeApp(appV3, "9.9.10-quebrada", false);
    const zipV3 = path.join(pkgDir, "app-v3.zip");
    await createZip(appV3, zipV3);
    served.set("/app-v3.zip", zipV3);
    manifest.version = "9.9.10-quebrada";
    manifest.files["win-dir"] = { url: `${base}/app-v3.zip`, sha256: await sha256File(zipV3) };
    const before = read(path.join(installDir, "resources", "VERSAO"));
    const running2 = spawn("sleep", ["1"]);
    ({ u } = updaterFor(userData, {
      currentVersion: "9.9.9-fake",
      install: { kind: "win-dir", mode: "dir", target: installDir, exe: path.join(installDir, "multihub-chat") },
      pid: running2.pid,
      waitStart: 6,
    }));
    st = await u.check();
    ({ u } = updaterFor(userData, {
      currentVersion: "9.9.9-fake",
      install: { kind: "win-dir", mode: "dir", target: installDir, exe: path.join(installDir, "multihub-chat") },
      pid: running2.pid,
      waitStart: 6,
    }));
    ok(await u.applyPending(), "Ao abrir: aplica a 9.9.10-quebrada");
    await until(() => fs.existsSync(resultFile), 30000);
    const res3 = fs.existsSync(resultFile) ? JSON.parse(read(resultFile)) : {};
    ok(res3.status === "rollback" && read(path.join(installDir, "resources", "VERSAO")) === before, "Não iniciou: backup restaurado", `${JSON.stringify(res3)} · pasta: ${read(path.join(installDir, "resources", "VERSAO"))}`);
    await until(() => fs.existsSync(path.join(userData, "updates", `rodando-${before}`)), 5000);
    ok(/fechou sozinha antes de iniciar|não iniciou/.test(read(path.join(userData, "updates", "update.log"))) && /restaurada/.test(read(path.join(userData, "updates", "update.log"))), "Falha e restauração registradas no log");
    let warned = "";
    const back = createUpdater({ currentVersion: before, dataDir: userData, install: { kind: "win-dir" }, prompt: async () => "later", quit: () => {}, onRollback: (m) => (warned = m) });
    back._startedOk();
    ok(/9\.9\.10-quebrada/.test(warned) && JSON.parse(read(path.join(userData, "updates", "state.json"))).failedVersion === "9.9.10-quebrada", "Versão restaurada avisa o que houve", warned.slice(0, 70));
    const again = updaterFor(userData, { currentVersion: before, install: { kind: "win-dir", mode: "dir", target: installDir, exe: path.join(installDir, "multihub-chat") } }).u;
    ok(!(await again.applyPending()), "Não tenta de novo a versão quebrada ao abrir (sem repetir sem fim)");

    // ---------- 8. arquivo único (AppImage) ----------
    console.log("\n=== 8. Instalação: arquivo único (AppImage) ===");
    const ud3 = path.join(tmp, "userdata3");
    fs.mkdirSync(path.join(ud3, "updates"), { recursive: true });
    const appImage = path.join(tmp, "Apps", "MultiHubChat.AppImage");
    fs.writeFileSync(appImage, `#!/bin/sh\necho v1\n`, { mode: 0o755 });
    const newImgDir = path.join(tmp, "img");
    fs.mkdirSync(newImgDir);
    const newImg = path.join(newImgDir, "MultiHubChat-9.9.9-fake-linux-x86_64.AppImage");
    fs.writeFileSync(newImg, `#!/bin/sh\n# v2\nsleep 1; date > "${path.join(ud3, "updates", "started-9.9.9-fake.ok")}"\nsleep 1\n`, { mode: 0o755 });
    const zipImg = path.join(pkgDir, "img.zip");
    await createZip(newImg, zipImg);
    served.set("/img.zip", zipImg);
    manifest.version = "9.9.9-fake";
    manifest.files = { "linux-appimage": { url: `${base}/img.zip`, sha256: await sha256File(zipImg) } };
    delete manifest.url;
    const running3 = spawn("sleep", ["1"]);
    ({ u } = updaterFor(ud3, { install: { kind: "linux-appimage", mode: "file", target: appImage, exe: appImage }, pid: running3.pid, waitStart: 10 }));
    st = await u.check();
    await u.install(); // "Atualizar agora" nas Configurações: na hora
    const rf3 = path.join(ud3, "updates", "result.json");
    await until(() => fs.existsSync(rf3), 30000);
    ok(fs.existsSync(rf3) && JSON.parse(read(rf3)).status === "ok" && /# v2/.test(read(appImage)) && (fs.statSync(appImage).mode & 0o111) !== 0 && /v1/.test(read(path.join(ud3, "updates", "backup"))),
      "AppImage trocado (executável), versão anterior no backup");
  }

  server.close();
  console.log(`\n${checks - fails}/${checks} verificações OK`);
  process.exitCode = fails ? 1 : 0;
})().catch((err) => {
  console.error(err);
  server.close();
  process.exitCode = 1;
});
