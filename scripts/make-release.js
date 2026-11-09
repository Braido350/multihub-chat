// Gera os pacotes .zip da atualização automática e o latest.json (com SHA-256 e tamanho) para publicar no
// GitHub Releases. Rode depois de "npm run build:all" (ou build:linux / build:win).
//
// Uso:
//   node scripts/make-release.js --base-url https://github.com/USUARIO/REPO/releases/download/v1.2.0/ \
//        [--notes "texto"] [--notes-file NOTAS.md] [--dist dist] [--out dist/release] [--version 1.2.0]
//
// Saída em dist/release: um .zip por tipo de instalação encontrado em dist/ e o latest.json.
//   linux-appimage  MultiHubChat-<v>-linux-x86_64.AppImage   (o .zip contém só o AppImage)
//   win-dir         win-unpacked/                            (instalação do Windows, NSIS por usuário)
// Publique todos os arquivos de dist/release como anexos do release (o latest.json também). Veja docs/ATUALIZACAO.md.
"use strict";
const fs = require("fs");
const path = require("path");
const { createZip } = require("../updater/zip");
const { sha256File } = require("../updater");
const semver = require("../updater/semver");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}

(async () => {
  const root = path.join(__dirname, "..");
  const pkg = require(path.join(root, "package.json"));
  const version = arg("version", pkg.version);
  if (!semver.valid(version)) throw new Error(`Versão inválida: ${version}`);
  const dist = path.resolve(root, arg("dist", "dist"));
  const out = path.resolve(root, arg("out", path.join(arg("dist", "dist"), "release")));
  let base = arg("base-url");
  if (!base) throw new Error("Informe --base-url (ex.: https://github.com/USUARIO/REPO/releases/download/v" + version + "/)");
  if (!base.endsWith("/")) base += "/";
  const notesFile = arg("notes-file");
  const notes = notesFile ? fs.readFileSync(notesFile, "utf8").trim() : arg("notes", "");

  const sources = {
    "linux-appimage": path.join(dist, `MultiHubChat-${version}-linux-x86_64.AppImage`),
    "win-dir": path.join(dist, "win-unpacked"),
  };
  fs.mkdirSync(out, { recursive: true });
  const files = {};
  for (const [kind, src] of Object.entries(sources)) {
    if (!fs.existsSync(src)) {
      console.log(`- ${kind.padEnd(15)} não encontrado (${path.relative(root, src)}): pulando`);
      continue;
    }
    const name = `MultiHubChat-${version}-${kind}.zip`;
    const zip = path.join(out, name);
    process.stdout.write(`- ${kind.padEnd(15)} compactando ${path.relative(root, src)}… `);
    const r = await createZip(src, zip);
    const sha256 = await sha256File(zip);
    files[kind] = { url: base + name, sha256, size: r.bytes };
    console.log(`${(r.bytes / 1048576).toFixed(1)} MB, ${r.files} arquivo(s), sha256 ${sha256.slice(0, 16)}…`);
  }
  if (!Object.keys(files).length) throw new Error(`Nada para publicar em ${dist}. Rode o build antes.`);
  const manifest = { version, date: new Date().toISOString(), notes, files };
  fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nPronto: ${path.relative(root, out)}/latest.json e ${Object.keys(files).length} pacote(s).`);
  console.log(`Publique no release v${version} todos os arquivos de ${path.relative(root, out)}/.`);
  console.log(`URL para o app (Configurações › Aplicativo › Atualizações):`);
  console.log(`  ${base.replace(/\/download\/[^/]+\/$/, "/latest/download/")}latest.json`);
})().catch((err) => {
  console.error("Erro:", err.message);
  process.exitCode = 1;
});
