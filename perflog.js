// Registro de desempenho: a cada segundo grava uma linha com o estado do app em <dados do usuário>/perf/perf.log.
// Serve para investigar lentidão e consumo de memória em máquinas onde não dá para reproduzir (ex.: Windows).
// Cada linha: hora | atraso do processo principal | memória do sistema | total do app | cada processo (nome, RAM, CPU).
// O atraso ("lag") é quanto o timer de 1 s chegou atrasado: valores altos = processo principal travado.
// Guarda só os últimos 5 minutos (MAX_LINES linhas): o arquivo é regravado a cada segundo com essa janela.
// Ao abrir, aproveita o que restou da execução anterior (útil se o app travou e foi fechado à força).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app } = require("electron");

const INTERVAL = 1000;
const MAX_LINES = 5 * 60; // 5 minutos, uma linha por segundo

function createPerfLog({ describe }) {
  const dir = path.join(app.getPath("userData"), "perf");
  const file = path.join(dir, "perf.log");
  fs.mkdirSync(dir, { recursive: true });

  let timer = null;
  let expected = 0;
  let maxLag = 0;
  let lines = [];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-MAX_LINES);
  } catch {}

  const mb = (kb) => Math.round(kb / 1024);
  const gb = (b) => (b / 1073741824).toFixed(1);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  function write(line) {
    lines.push(line);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    try {
      // grava num temporário e renomeia: se o app cair no meio, o arquivo anterior continua inteiro
      fs.writeFileSync(file + ".tmp", lines.join("\n") + "\n");
      fs.renameSync(file + ".tmp", file);
    } catch {}
  }

  function tick() {
    const now = Date.now();
    const lag = Math.max(0, now - expected);
    expected = now + INTERVAL;
    maxLag = Math.max(maxLag, lag);

    let metrics = [];
    try {
      metrics = app.getAppMetrics();
    } catch {}
    const names = describe(); // pid -> nome (site, Configurações, barra lateral)
    let totalKb = 0;
    let totalCpu = 0;
    const parts = [];
    for (const m of metrics) {
      const kb = (m.memory && m.memory.workingSetSize) || 0;
      const cpu = (m.cpu && m.cpu.percentCPUUsage) || 0;
      totalKb += kb;
      totalCpu += cpu;
      const name = names.get(m.pid) || (m.type === "Utility" ? m.name || m.serviceName || "Utility" : m.type);
      parts.push({ name, kb, cpu });
    }
    parts.sort((a, b) => b.kb - a.kb);

    const flag = lag >= 500 ? " ⚠TRAVOU" : lag >= 150 ? " ⚠lento" : "";
    const line =
      `${stamp(new Date(now))} | lag ${lag}ms${flag} | sistema livre ${gb(os.freemem())}/${gb(os.totalmem())} GB` +
      ` | app ${mb(totalKb)} MB cpu ${totalCpu.toFixed(0)}% | ` +
      parts.map((p) => `${p.name} ${mb(p.kb)}MB ${p.cpu.toFixed(0)}%`).join(" · ");
    write(line);
  }

  function start() {
    if (timer) return;
    write(
      `${stamp(new Date())} | INÍCIO app ${app.getVersion()} · ${process.platform} ${os.release()} · ${os.cpus().length} CPUs ${os.cpus()[0] ? os.cpus()[0].model : ""} · RAM ${gb(os.totalmem())} GB · Electron ${process.versions.electron}`
    );
    expected = Date.now() + INTERVAL;
    timer = setInterval(tick, INTERVAL);
    timer.unref && timer.unref();
  }

  return {
    start,
    file,
    dir,
    recent: () => lines.slice(),
    maxLag: () => maxLag,
    readAll: () => (lines.length ? lines.join("\n") + "\n" : ""),
    clear() {
      lines = [];
      maxLag = 0;
      fs.rmSync(file, { force: true });
    },
  };
}

module.exports = { createPerfLog };
