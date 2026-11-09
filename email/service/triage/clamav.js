// Antivírus local (ClamAV). Usa o clamd (rápido, assinaturas já carregadas) se estiver rodando;
// senão o clamscan, que carrega as assinaturas a cada execução (~5 s e ~1 GB de RAM).
// Nada é enviado para fora do computador.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const CANDIDATES =
  process.platform === "win32"
    ? {
        clamdscan: ["C:\\Program Files\\ClamAV\\clamdscan.exe", "clamdscan.exe"],
        clamscan: ["C:\\Program Files\\ClamAV\\clamscan.exe", "clamscan.exe"],
      }
    : { clamdscan: ["/usr/bin/clamdscan", "/usr/local/bin/clamdscan"], clamscan: ["/usr/bin/clamscan", "/usr/local/bin/clamscan", "/opt/homebrew/bin/clamscan"] };

const run = (bin, args, timeout) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") })
    );
  });

let detected = null;
/** Descobre qual binário usar (uma vez). */
async function detect() {
  if (detected) return detected;
  for (const bin of CANDIDATES.clamdscan) {
    const r = await run(bin, ["--ping", "1"], 5000);
    if (r.code === 0) return (detected = { mode: "clamd", bin });
  }
  for (const bin of CANDIDATES.clamscan) {
    const r = await run(bin, ["--version"], 10000);
    if (r.code === 0) return (detected = { mode: "clamscan", bin, version: r.stdout.trim() });
  }
  return (detected = { mode: "none" });
}

let queue = Promise.resolve(); // um exame por vez (o clamscan pesa ~1 GB)

/**
 * Examina arquivos (bytes em memória).
 * @param {{name: string, content: Buffer}[]} files
 * @returns {Promise<{status: "clean"|"infected"|"unavailable"|"error", found: {name, signature}[], engine?: string}>}
 */
function scan(files) {
  const job = queue.then(async () => {
    const av = await detect();
    if (av.mode === "none") return { status: "unavailable", found: [] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multihub-av-"));
    const map = new Map();
    try {
      for (const f of files) {
        const p = path.join(dir, crypto.randomBytes(6).toString("hex"));
        fs.writeFileSync(p, f.content, { mode: 0o600 });
        map.set(p, f.name);
      }
      const args = av.mode === "clamd" ? ["--no-summary", "--fdpass", ...map.keys()] : ["--no-summary", "--stdout", ...map.keys()];
      const r = await run(av.bin, args, 120000);
      if (r.code !== 0 && r.code !== 1) return { status: "error", found: [], engine: av.mode, error: (r.stderr || r.stdout).slice(0, 200) };
      const found = [];
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = /^(.*): (.+) FOUND$/.exec(line.trim());
        if (m && map.has(m[1])) found.push({ name: map.get(m[1]), signature: m[2] });
      }
      return { status: found.length ? "infected" : "clean", found, engine: av.mode };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  queue = job.catch(() => {});
  return job;
}

module.exports = { scan, detect };
