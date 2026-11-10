// Recursos extras das abas de WhatsApp Web (Configurações › WhatsApp), por script injetado em cada aba.
// Substitui a extensão "WA Web Plus", que depende de licença e servidor da empresa (veja docs/WHATSAPP.md).
//
// Processo principal: guarda a configuração e os dados de cada aba em userData/whatsapp-tools.json,
// entrega o script à aba (preload.js › "wa:boot"), recebe o estado de cada recurso e os eventos da página
// (mensagem apagada, etiqueta, agendada enviada…) e atende a tela de Configurações ("app:wa").
"use strict";
const fs = require("fs");
const path = require("path");

const MAX_DELETED = 500; // mensagens apagadas guardadas por aba
const MAX_SCHEDULE = 100;
const MAX_TEMPLATES = 50;
const MAX_LABELS = 20;
const BULK_MAX = 50; // números por envio em massa
const BULK_MIN_DELAY = 20; // segundos entre mensagens (mínimo)

const DEFAULTS = {
  hideOnline: false,
  hideTyping: false,
  noReadReceipts: false,
  blurChats: false,
  blurMessages: false,
  blurPhotos: false,
  keepDeleted: false,
  quickReplies: false,
  templates: [],
  labels: false,
  labelDefs: [
    { id: "l1", name: "Novo cliente", color: "#2e7d32" },
    { id: "l2", name: "Aguardando pagamento", color: "#f9a825" },
    { id: "l3", name: "Pós-venda", color: "#1565c0" },
  ],
  scheduled: false,
  // Arriscados: desligados por padrão, só ligam depois do aviso de banimento
  bulk: false,
  autoReply: false,
  autoReplyText: "Olá! Recebemos sua mensagem e respondemos assim que possível.",
  autoReplyCooldownHours: 12,
  autoReplyOnlyAway: true,
};
const BOOL_KEYS = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === "boolean");

const str = (v, max) => String(v == null ? "" : v).slice(0, max);
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const COLOR = /^#[0-9a-f]{6}$/i;

function createWaTools({ app, ipcMain, dialog, getWin, getSites, viewOf, siteOfWebContents, isWhatsApp, log }) {
  const file = path.join(app.getPath("userData"), "whatsapp-tools.json");
  let db = { sites: {} };
  try {
    db = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!db || typeof db !== "object" || !db.sites) db = { sites: {} };
  } catch {}

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(file + ".tmp", JSON.stringify(db));
        fs.renameSync(file + ".tmp", file);
      } catch (err) {
        log && log(`whatsapp-tools: não salvou (${err.message})`);
      }
    }, 300);
  }

  /** Dados de uma aba (cria com os padrões). */
  function rec(siteId) {
    let r = db.sites[siteId];
    if (!r) r = db.sites[siteId] = {};
    r.config = { ...DEFAULTS, ...(r.config || {}) };
    r.deleted ||= [];
    r.chatLabels ||= {};
    r.schedule ||= [];
    r.bulkJob ||= null;
    return r;
  }

  const statuses = {}; // siteId -> { featureId: { state, detail, at } } (só em memória)
  const waSites = () => getSites().filter(isWhatsApp);

  /** O que a página precisa saber (sem o histórico de apagadas). */
  function pageConfig(siteId) {
    const r = rec(siteId);
    return {
      ...r.config,
      chatLabels: r.chatLabels,
      schedule: r.schedule.filter((s) => s.status === "pendente"),
      bulkJob: r.bulkJob && r.bulkJob.status === "enviando" ? r.bulkJob : null,
    };
  }

  function push(siteId) {
    const v = viewOf(siteId);
    if (v && !v.webContents.isDestroyed()) v.webContents.send("wa:config", pageConfig(siteId));
  }

  /** Aba de WhatsApp que enviou a mensagem IPC (ou null). */
  function senderSite(e) {
    const site = siteOfWebContents(e.sender);
    if (!site || !isWhatsApp(site)) return null;
    try {
      if (!e.senderFrame || new URL(e.senderFrame.url).hostname !== "web.whatsapp.com") return null;
    } catch {
      return null;
    }
    return site;
  }

  // ---------- Página → processo principal ----------
  ipcMain.on("wa:boot", (e) => {
    const site = senderSite(e);
    if (!site) return (e.returnValue = null);
    let script = "";
    try {
      script = fs.readFileSync(path.join(__dirname, "inject.js"), "utf8");
    } catch (err) {
      log && log(`whatsapp-tools: sem inject.js (${err.message})`);
      return (e.returnValue = null);
    }
    statuses[site.id] = {};
    e.returnValue = { script, config: pageConfig(site.id) };
  });

  ipcMain.on("wa:status", (e, s) => {
    const site = senderSite(e);
    if (!site || !s || typeof s.id !== "string") return;
    (statuses[site.id] ||= {})[str(s.id, 40)] = { state: str(s.state, 20), detail: str(s.detail, 300), at: Date.now() };
  });

  const pending = new Map(); // reqId -> { resolve, reject, timer }

  ipcMain.on("wa:event", (e, ev) => {
    const site = senderSite(e);
    if (!site || !ev || typeof ev.type !== "string") return;
    const p = ev.payload || {};
    const r = rec(site.id);
    switch (ev.type) {
      case "deleted": {
        const item = { chat: str(p.chat, 120), from: str(p.from, 120), text: str(p.text, 4000), kind: str(p.kind, 30), sentAt: Number(p.sentAt) || null, at: Date.now() };
        if (!item.text) return;
        r.deleted.unshift(item);
        r.deleted.length = Math.min(r.deleted.length, MAX_DELETED);
        save();
        return;
      }
      case "labels": {
        const chat = str(p.chat, 120).trim();
        if (!chat) return;
        const valid = new Set(r.config.labelDefs.map((l) => l.id));
        const ids = (Array.isArray(p.labels) ? p.labels : []).map((x) => str(x, 20)).filter((x) => valid.has(x));
        if (ids.length) r.chatLabels[chat] = ids;
        else delete r.chatLabels[chat];
        save();
        push(site.id); // as outras partes da página (lista de conversas) se atualizam
        return;
      }
      case "job": {
        const it = r.schedule.find((s) => s.id === p.id);
        if (!it || it.status !== "pendente") return;
        it.status = p.ok ? "enviada" : "falhou";
        it.error = p.ok ? null : str(p.error, 200);
        it.doneAt = Date.now();
        save();
        push(site.id);
        return;
      }
      case "bulk": {
        const j = r.bulkJob;
        if (!j || j.id !== p.jobId || j.status !== "enviando") return;
        const i = Number(p.index);
        if (!(i >= 0 && i < j.numbers.length) || j.results[i]) return;
        j.results[i] = p.ok ? "ok" : str(p.error || "erro", 120);
        j.next = i + 1;
        if (p.stop) j.status = "interrompido";
        else if (j.next >= j.numbers.length) j.status = "concluído";
        save();
        if (j.status !== "enviando") push(site.id);
        return;
      }
      case "reply": {
        const w = pending.get(p.reqId);
        if (!w) return;
        pending.delete(p.reqId);
        clearTimeout(w.timer);
        p.error ? w.reject(new Error(str(p.error, 300))) : w.resolve(p.result);
        return;
      }
    }
  });

  /** Pede algo à página da aba e espera a resposta. */
  function ask(siteId, name, args, ms = 30000) {
    const v = viewOf(siteId);
    if (!v || v.webContents.isDestroyed()) return Promise.reject(new Error("A aba não está aberta."));
    const reqId = rid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error("O WhatsApp não respondeu. Ele está aberto e conectado nessa aba?"));
      }, ms);
      pending.set(reqId, { resolve, reject, timer });
      v.webContents.send("wa:command", { reqId, name, args: args || {} });
    });
  }

  // ---------- Configurações (tela) ----------
  function cleanTemplates(list) {
    return (Array.isArray(list) ? list : [])
      .map((t) => ({ name: str(t && t.name, 60).trim(), text: str(t && t.text, 4000) }))
      .filter((t) => t.name && t.text.trim())
      .slice(0, MAX_TEMPLATES);
  }
  function cleanLabels(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : [])
      .map((l) => ({ id: str(l && l.id, 20) || "l" + rid(), name: str(l && l.name, 40).trim(), color: COLOR.test(l && l.color) ? l.color : "#607d8b" }))
      .filter((l) => l.name && !seen.has(l.id) && seen.add(l.id))
      .slice(0, MAX_LABELS);
  }

  function siteOrThrow(siteId) {
    const site = waSites().find((s) => s.id === siteId);
    if (!site) throw new Error("Aba de WhatsApp não encontrada.");
    return site;
  }

  async function handle(req) {
    const action = req && req.action;
    if (action === "list") {
      return waSites().map((s) => {
        const r = rec(s.id);
        return {
          id: s.id,
          name: s.name,
          open: !!viewOf(s.id),
          config: r.config,
          status: statuses[s.id] || {},
          labelsUsed: Object.keys(r.chatLabels).length,
          schedule: r.schedule,
          bulkJob: r.bulkJob,
          deletedCount: r.deleted.length,
        };
      });
    }
    const site = siteOrThrow(req.siteId);
    const r = rec(site.id);

    switch (action) {
      case "set": {
        const p = req.patch || {};
        for (const k of BOOL_KEYS) if (typeof p[k] === "boolean") r.config[k] = p[k];
        if (p.templates !== undefined) r.config.templates = cleanTemplates(p.templates);
        if (p.labelDefs !== undefined) {
          r.config.labelDefs = cleanLabels(p.labelDefs);
          const valid = new Set(r.config.labelDefs.map((l) => l.id));
          for (const [chat, ids] of Object.entries(r.chatLabels)) {
            const keep = ids.filter((x) => valid.has(x));
            keep.length ? (r.chatLabels[chat] = keep) : delete r.chatLabels[chat];
          }
        }
        if (p.autoReplyText !== undefined) r.config.autoReplyText = str(p.autoReplyText, 1000);
        if (p.autoReplyCooldownHours !== undefined) r.config.autoReplyCooldownHours = Math.max(1, Math.min(168, Number(p.autoReplyCooldownHours) || 12));
        if (typeof p.autoReplyOnlyAway === "boolean") r.config.autoReplyOnlyAway = p.autoReplyOnlyAway;
        // Envio em massa desligado: interrompe o que estiver rodando
        if (p.bulk === false && r.bulkJob && r.bulkJob.status === "enviando") r.bulkJob.status = "interrompido";
        save();
        push(site.id);
        return r.config;
      }
      case "deleted":
        return r.deleted;
      case "deletedClear":
        r.deleted = [];
        save();
        return true;
      case "chats":
        return ask(site.id, "listChats");
      case "scheduleAdd": {
        if (!r.config.scheduled) throw new Error("Ligue as mensagens agendadas primeiro.");
        const at = Number(req.at);
        if (!(at > Date.now() - 60000)) throw new Error("Escolha uma data no futuro.");
        const text = str(req.text, 4000);
        if (!text.trim()) throw new Error("Escreva a mensagem.");
        const target = req.chatId ? { chatId: str(req.chatId, 120), name: str(req.name, 120) } : null;
        const phone = str(req.phone, 30).replace(/\D/g, "");
        if (!target && !(phone.length >= 10 && phone.length <= 15)) throw new Error("Escolha a conversa ou informe o número com DDI e DDD (ex.: 5511999998888).");
        if (r.schedule.filter((s) => s.status === "pendente").length >= MAX_SCHEDULE) throw new Error(`No máximo ${MAX_SCHEDULE} mensagens agendadas.`);
        r.schedule.push({ id: rid(), at, text, ...(target || { phone, name: "+" + phone }), status: "pendente", createdAt: Date.now() });
        r.schedule = r.schedule.filter((s) => s.status === "pendente" || Date.now() - (s.doneAt || s.at) < 30 * 864e5).slice(-300);
        save();
        push(site.id);
        return r.schedule;
      }
      case "scheduleRemove":
        r.schedule = r.schedule.filter((s) => s.id !== req.id);
        save();
        push(site.id);
        return r.schedule;
      case "bulkStart": {
        if (!r.config.bulk) throw new Error("Ligue o envio em massa primeiro.");
        if (r.bulkJob && r.bulkJob.status === "enviando") throw new Error("Já há um envio em massa em andamento.");
        const numbers = [...new Set(String(req.numbers || "").split(/[\s,;]+/).map((n) => n.replace(/\D/g, "")).filter((n) => n.length >= 10 && n.length <= 15))];
        if (!numbers.length) throw new Error("Nenhum número válido (use DDI + DDD + número, um por linha).");
        if (numbers.length > BULK_MAX) throw new Error(`No máximo ${BULK_MAX} números por envio.`);
        const text = str(req.text, 4000);
        if (!text.trim()) throw new Error("Escreva a mensagem.");
        const minDelay = Math.max(BULK_MIN_DELAY, Number(req.minDelay) || 30);
        const maxDelay = Math.max(minDelay + 5, Number(req.maxDelay) || 90);
        r.bulkJob = { id: rid(), numbers, text, minDelay, maxDelay, next: 0, results: [], status: "enviando", createdAt: Date.now() };
        save();
        push(site.id);
        return r.bulkJob;
      }
      case "bulkStop":
        if (r.bulkJob && r.bulkJob.status === "enviando") r.bulkJob.status = "interrompido";
        save();
        push(site.id);
        return r.bulkJob;
      case "export": {
        const data = await ask(site.id, "export", {}, 60000);
        const csv = toCsv(data);
        const win = getWin();
        const stamp = new Date().toISOString().slice(0, 10);
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
          title: "Exportar contatos e grupos",
          defaultPath: path.join(app.getPath("downloads"), `whatsapp-${site.name.replace(/[^\w.-]+/g, "_")}-${stamp}.csv`),
          filters: [{ name: "CSV", extensions: ["csv"] }],
        });
        if (canceled || !filePath) return { saved: false };
        fs.writeFileSync(filePath, "﻿" + csv); // BOM: o Excel abre os acentos certos
        return { saved: true, filePath, contacts: data.contacts.length, groups: data.groups.length };
      }
    }
    throw new Error("Ação desconhecida.");
  }

  return { handle, onSitesChanged: () => waSites().forEach((s) => push(s.id)) };
}

/** CSV (separador ;, padrão do Excel em português) com contatos e grupos. */
function toCsv(data) {
  const q = (v) => {
    const s = String(v == null ? "" : v);
    return /[;"\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
  };
  const rows = [["tipo", "nome", "numero_ou_id", "nome_no_whatsapp", "salvo_nos_contatos", "empresa", "participantes"]];
  for (const c of (data && data.contacts) || []) rows.push(["contato", c.name, c.number || c.id, c.pushname, c.saved ? "sim" : "não", c.business ? "sim" : "não", ""]);
  for (const g of (data && data.groups) || []) rows.push(["grupo", g.name, g.id, "", "", "", g.participants == null ? "" : g.participants]);
  return rows.map((r) => r.map(q).join(";")).join("\r\n") + "\r\n";
}

module.exports = { createWaTools, toCsv, DEFAULTS };
