// Coloca os e-mails de exemplo (organize-cases.json) numa conta de teste do GreenMail, para ver os grupos
// da Caixa de entrada no app com um servidor IMAP de verdade: Importante, Propaganda, Outros, Suspeitos e
// Já lidos, com os cabeçalhos de envio em massa, as lidas/respondidas e as conversas em que você respondeu.
//
// Uso (GreenMail rodando como em docs/EMAIL.md, "Como testar sem contas reais"):
//   node email/test/seed-greenmail.js            envia para alice@local.test
//   node email/test/seed-greenmail.js --dry      só mostra os cabeçalhos que seriam enviados
// Variáveis opcionais: SEED_TO, SEED_USER, SEED_PASS, SEED_HOST, SEED_SMTP_PORT (3025), SEED_IMAP_PORT (3143)
const path = require("path");
const nodemailer = require("nodemailer");
const MailComposer = require("nodemailer/lib/mail-composer");
const { ImapFlow } = require("imapflow");
const data = require(path.join(__dirname, "organize-cases.json"));

const TO = process.env.SEED_TO || "alice@local.test";
const USER = process.env.SEED_USER || "alice";
const PASS = process.env.SEED_PASS || "secret";
const HOST = process.env.SEED_HOST || "127.0.0.1";
const DRY = process.argv.includes("--dry");
const myAddrs = new Set(data.accounts.map((a) => a.email));
const swap = (list) => (list || []).map((x) => (myAddrs.has(x) ? TO : x));
const msgId = (id) => `<${id}@exemplo.test>`;

/** Cabeçalhos de envio em massa do caso, como um servidor de verdade mandaria. */
function headersOf(hdr) {
  const out = {};
  if (!hdr) return out;
  if (hdr["list-unsubscribe"]) out["List-Unsubscribe"] = hdr["list-unsubscribe"];
  if (hdr["list-id"]) out["List-Id"] = hdr["list-id"];
  if (hdr.precedence) out.Precedence = hdr.precedence;
  if (hdr["auto-submitted"]) out["Auto-Submitted"] = hdr["auto-submitted"];
  return out;
}

function mailOf(c) {
  return {
    from: { name: c.from.name, address: c.from.address },
    to: swap(c.to || [TO]),
    cc: swap(c.cc),
    subject: c.subject,
    text: c.text || (c.html ? undefined : `Mensagem de exemplo: ${c.subject}.`),
    html: c.html,
    messageId: msgId(c.id),
    // Conversa em que você respondeu: a resposta aponta para a sua mensagem em Enviados
    references: c.thread ? [msgId(c.thread)] : undefined,
    inReplyTo: c.thread ? msgId(c.thread) : undefined,
    headers: headersOf(c.hdr),
    // Return-Path (plataforma de envio): o servidor grava o remetente do envelope
    envelope: { from: c.hdr && c.hdr["return-path"] ? `bounce@${c.hdr["return-path"]}` : c.from.address, to: [TO] },
  };
}

async function raw(mail) {
  return new MailComposer(mail).compile().build();
}

(async () => {
  const sent = data.sent.map((s) => ({
    from: TO,
    to: s.to,
    subject: s.subject,
    text: `Mensagem enviada por você: ${s.subject}.`,
    messageId: msgId(s.thread),
    date: new Date(Date.now() - 3 * 864e5),
  }));
  const cases = data.cases.filter((c) => (c.folder || "inbox") === "inbox");

  if (DRY) {
    for (const c of cases) {
      const text = (await raw(mailOf(c))).toString("utf8");
      const head = text.slice(0, text.indexOf("\r\n\r\n"));
      console.log(`--- ${c.id} → esperado: ${c.expect.group}${c.expect.tag ? ` [${c.expect.tag}]` : ""}`);
      console.log(head.split("\r\n").filter((l) => /^(From|To|Cc|Subject|Message-ID|References|List-|Precedence|Auto-Submitted)/i.test(l)).join("\n"));
    }
    return;
  }

  // 1) "Enviados": dá os contatos conhecidos e as conversas em que você respondeu
  const imap = new ImapFlow({ host: HOST, port: Number(process.env.SEED_IMAP_PORT || 3143), secure: false, auth: { user: USER, pass: PASS }, logger: false });
  await imap.connect();
  const boxes = await imap.list();
  if (!boxes.some((b) => b.path === "Sent")) await imap.mailboxCreate("Sent");
  for (const s of sent) await imap.append("Sent", await raw(s), ["\\Seen"], s.date);
  console.log(`Enviados: ${sent.length} mensagens`);

  // 2) Caixa de entrada: cada exemplo chega por SMTP, como um e-mail de verdade
  const smtp = nodemailer.createTransport({ host: HOST, port: Number(process.env.SEED_SMTP_PORT || 3025), secure: false, ignoreTLS: true });
  for (const c of cases) {
    await smtp.sendMail(mailOf(c));
    console.log(`enviado: ${c.id.padEnd(30)} → esperado ${c.expect.group}${c.expect.tag ? ` [${c.expect.tag}]` : ""}`);
  }
  smtp.close();

  // 3) Lidas, respondidas e favoritas (o que você "já fez" com elas)
  await new Promise((r) => setTimeout(r, 1500));
  const lock = await imap.getMailboxLock("INBOX");
  try {
    for (const c of cases) {
      const flags = [c.seen && "\\Seen", c.answered && "\\Answered", c.flagged && "\\Flagged"].filter(Boolean);
      if (!flags.length) continue;
      const uids = await imap.search({ header: { "message-id": msgId(c.id) } }, { uid: true });
      if (uids && uids.length) await imap.messageFlagsAdd(uids, flags, { uid: true });
    }
  } finally {
    lock.release();
  }
  await imap.logout();
  console.log(`\nPronto: ${cases.length} e-mails em ${TO}. No app, a Caixa de entrada se organiza sozinha em alguns segundos.`);
})().catch((err) => {
  console.error("Falha:", err.message);
  process.exitCode = 1;
});
