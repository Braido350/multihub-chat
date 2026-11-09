// Camada 1 da organização: regras com pontuação, explicáveis, sem rede e sem LLM.
// Cada regra soma pontos para Importante, Propaganda ou Outros e deixa um motivo curto em português.
const { fromBodyHeaders, safeJson } = require("./headers");

const CATS = ["importante", "propaganda", "outros"];
const NAME = { importante: "Importante", propaganda: "Propaganda", outros: "Outros", suspeito: "Suspeito" };

// Confiança mínima de cada categoria. Abaixo disso a mensagem vai para Outros:
// esconder algo importante em Propaganda é o pior erro, então Propaganda exige mais.
const MIN_CONF = { importante: 70, propaganda: 85, outros: 60 };

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const domainOf = (addr) => String(addr || "").split("@")[1]?.toLowerCase().trim() || "";
const localOf = (addr) => String(addr || "").split("@")[0]?.toLowerCase().trim() || "";
const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "yahoo.com", "yahoo.com.br",
  "bol.com.br", "uol.com.br", "terra.com.br", "ig.com.br", "icloud.com", "me.com", "proton.me", "protonmail.com",
  "zoho.com", "gmx.com", "aol.com", "mail.com", "yandex.com",
]);

// ---------- Plataformas de envio ----------
// Marketing: a plataforma só existe para campanhas
const MARKETING_ESP = [
  [/(^|\.)(mcsv\.net|mcdlv\.net|mailchimp\.com|mailchimpapp\.net|list-manage\.com|rsgsv\.net|campaign-archive\.com)$/, "Mailchimp"],
  [/(^|\.)(rdstation\.com\.br|rdstation\.com|rdstationmail\.com\.br)$/, "RD Station"],
  [/(^|\.)(hubspotemail\.net|hubspotlinks\.com|hs-email\.com|hubspotstarter\.net)$/, "HubSpot"],
  [/(^|\.)(klaviyomail\.com|klaviyo\.com|klclick\d*\.com)$/, "Klaviyo"],
  [/(^|\.)(mailerlite\.com|mlsend\.com|mlsend2\.com)$/, "MailerLite"],
  [/(^|\.)(sendinblue\.com|brevo\.com|sendibt\d*\.com|sendibm\d*\.com|brevosend\.com)$/, "Brevo"],
  [/(^|\.)(acems\d*\.com|activehosted\.com|emsend\d*\.com)$/, "ActiveCampaign"],
  [/(^|\.)(createsend\.com|createsend\d+\.com|cmail\d+\.com)$/, "Campaign Monitor"],
  [/(^|\.)(rs6\.net|constantcontact\.com|ccsend\.com)$/, "Constant Contact"],
  [/(^|\.)(mktomail\.com|marketo\.org|mktdns\.com)$/, "Marketo"],
  [/(^|\.)(pardot\.com|exacttarget\.com|exct\.net)$/, "Salesforce Marketing Cloud"],
  [/(^|\.)(substack\.com|substackcdn\.com)$/, "Substack"],
  [/(^|\.)beehiiv\.com$/, "Beehiiv"],
  [/(^|\.)(convertkit-mail\d*\.com|ck\.page)$/, "ConvertKit"],
  [/(^|\.)e-goi\.com$/, "E-goi"],
  [/(^|\.)dinamize\.com(\.br)?$/, "Dinamize"],
  [/(^|\.)akna\.com(\.br)?$/, "Akna"],
  [/(^|\.)allin\.com\.br$/, "Allin"],
  [/(^|\.)emarsys\.net$/, "Emarsys"],
];
// Envio em massa genérico: também manda recibos e avisos (não basta para Propaganda)
const BULK_ESP = [
  [/(^|\.)(sendgrid\.net|sendgrid\.info|sendgrid\.com)$/, "SendGrid"],
  [/(^|\.)amazonses\.com$/, "Amazon SES"],
  [/(^|\.)(sparkpostmail\.com|sparkpost\.com)$/, "SparkPost"],
  [/(^|\.)(mailgun\.org|mailgun\.net|mailgun\.info)$/, "Mailgun"],
  [/(^|\.)mandrillapp\.com$/, "Mandrill"],
  [/(^|\.)(postmarkapp\.com|mtasv\.net)$/, "Postmark"],
  [/(^|\.)(mailjet\.com|mjt\.lu)$/, "Mailjet"],
  [/(^|\.)smtplw\.com\.br$/, "Locaweb SMTP"],
];
const MAILER_MARKETING = /mailchimp|rd ?station|hubspot|klaviyo|mailerlite|sendinblue|brevo|activecampaign|campaign ?monitor|marketo|pardot|exacttarget|e-goi|dinamize|akna|allin|emarsys|newsletter|mass ?mail|bulk/i;

// Redirecionadores de clique / rastreamento
const TRACKER_HOST = /(^|\.)(list-manage\.com|mailchimp\.com|sendgrid\.net|mandrillapp\.com|hubspotlinks\.com|hubspotemail\.net|rdstation\.com\.br|rdstation\.com|exct\.net|exacttarget\.com|sparkpostmail\.com|mailgun\.org|awstrack\.me|mlsend\.com|sendibt\d*\.com|sendinblue\.com|mailerlite\.com|acems\d*\.com|activehosted\.com|klclick\d*\.com|klaviyo\.com|substack\.com|beehiiv\.com|convertkit-mail\d*\.com|rs6\.net|emarsys\.net|createsend\d*\.com|cmail\d+\.com|mjt\.lu|pardot\.com)$/;
const TRACKER_SUB = /^(click|clicks|track|tracking|trk|links?|email|e|go|r|t|ea|em|news|mkt|lnk)\d*\./;

// ---------- Termos ----------
const PROMO = [
  [/\bofertas?\b/, "oferta"],
  [/\bpromo(cao|coes|cional|cionais)?\b/, "promoção"],
  [/\bdescontos?\b/, "desconto"],
  [/\bcupo(m|ns|n)\b/, "cupom"],
  [/\bfrete gratis\b/, "frete grátis"],
  [/\d+ ?% ?(off|de desconto)\b|\bate \d+ ?%/, "% de desconto"],
  [/\bblack ?friday\b|\bcyber ?monday\b|\bblack ?week\b/, "Black Friday"],
  [/\bliquida(cao)?\b|\bqueima de estoque\b|\bsaldao\b/, "liquidação"],
  [/\bimperdive(l|is)\b/, "imperdível"],
  [/\b(so|somente|apenas) hoje\b|\bultimas? (horas|unidades|chances?|vagas)\b|\bacaba (hoje|amanha)\b/, "urgência de oferta"],
  [/\baproveite\b|\bcompre (ja|agora)\b|\bgaranta (ja|o seu|a sua|seu|sua)\b|\bnao perca\b/, "chamada de compra"],
  [/\bcashback\b/, "cashback"],
  [/\bnewsletter\b/, "newsletter"],
  [/\b(lancamento|novidades da semana|confira as novidades)\b/, "novidades"],
  [/\b(sale|deals?|discount|coupon|free shipping|limited time|special offer|shop now)\b/, "oferta"],
];
const TRANS = [
  [/\bpedido\b|\border\b/, "pedido"],
  [/\brecibo\b|\breceipt\b/, "recibo"],
  [/\bcomprovante\b/, "comprovante"],
  [/\bnota fiscal\b|\bnf-?e\b|\bdanfe\b/, "nota fiscal"],
  [/\bfatura\b|\binvoice\b/, "fatura"],
  [/\bboleto\b/, "boleto"],
  [/\bpagamento (confirmado|recebido|aprovado|efetuado|realizado)\b|\bcompra (aprovada|confirmada|realizada)\b|\bpayment (received|confirmed)\b/, "pagamento"],
  [/\bconfirmacao\b|\bconfirme (seu|sua|o|a)\b|\bconfirmation\b/, "confirmação"],
  [/\bcodigo de (verificacao|seguranca|acesso|confirmacao)\b|\bverification code\b|\bone-time\b/, "código de verificação"],
  [/\b(redefini(r|cao)|recupera(r|cao)|alteracao|troca) (de |da )?senha\b|\bsenha (alterada|redefinida)\b|\bpassword reset\b/, "senha"],
  [/\b(novo|nova) (acesso|login|dispositivo|entrada)\b|\bsign-?in\b|\bsecurity alert\b|\balerta de seguranca\b/, "alerta de acesso"],
  [/\b(sua )?entrega\b|\benviado\b|\bdespachado\b|\brastreio\b|\brastreamento\b|\bshipped\b|\bdelivered\b|\btracking number\b/, "entrega"],
  [/\bextrato\b|\btransacao\b|\btransferencia (recebida|realizada|enviada)\b/, "extrato"],
  [/\bassinatura (renovada|cancelada|confirmada)\b|\brenovacao\b|\bsubscription (renewed|confirmed)\b/, "assinatura"],
  [/\bnotifica(cao|coes)\b|\bnotification\b|\blembrete\b|\breminder\b|\baviso de\b/, "aviso"],
  [/\bverifique (seu|o) e-?mail\b|\bbem-?vind[oa]\b|\bwelcome to\b|\bcadastro (realizado|confirmado)\b/, "cadastro"],
  [/\b(chamado|ticket|protocolo) (#|n|numero|aberto)\b|\bseu chamado\b/, "chamado"],
];
const UNSUB = /unsubscribe|descadastr|cancelar (a |sua )?inscri|remover (da lista|meu e-?mail|seu e-?mail)|opt-?out|nao (quer|deseja) mais receber|deixar de receber|gerenciar (preferencias|inscri)|manage (preferences|subscription)|update your preferences/;

const NOREPLY_LOCAL = /^(no-?reply|nao-?responda|naoresponda|donotreply|do-not-reply|noresponder|nao_responda|mailer-daemon|postmaster|bounces?)([+._-].*)?$/;
const MARKETING_LOCAL = /^(newsletters?|news|marketing|mkt|e-?mkt|promo(cao|coes|tions?)?|ofertas?|deals|offers?|campanhas?|mailing|novidades|comunicacao|comunicados|loja|store|shop|vendas|sales)([+._-].*)?$/;
const NOTIFY_LOCAL = /^(notifica(coes|cao)|notifications?|notify|alerts?|alertas?|avisos?|seguranca|security|account|accounts|conta|billing|faturamento|financeiro|cobranca|nfe|nota-?fiscal|pedidos?|orders?|suporte|support|receipts?|recibos?|confirma(cao|coes)?|sistema|system|automatico|status|calendar|agenda)([+._-].*)?$/;

const STOP = new Set(
  (
    "que para com uma por mais como mas foi ele ela seu sua nos dos das isso esta este essa esse aos pelo pela " +
    "sem ser tem sao ter voce voces nao sim seja ate quando muito tambem ja pode deve sobre entre depois antes " +
    "the and for you your with this that are was from have has not but all can our will more about here " +
    "http https www com html email mail"
  ).split(" ")
);

function words(text, max, prefix) {
  const out = [];
  for (const w of norm(text).split(/[^a-z0-9]+/)) {
    if (w.length < 3 || w.length > 24 || STOP.has(w)) continue;
    out.push(prefix + (/^\d+$/.test(w) ? "#" : w));
    if (out.length >= max) break;
  }
  return out;
}

const stripHtml = (html) =>
  String(html || "")
    .slice(0, 60000)
    .replace(/<(style|script|title)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const espOf = (hosts, list) => {
  for (const h of hosts) for (const [re, name] of list) if (h && re.test(h)) return name;
  return null;
};

function matchTerms(text, list) {
  const found = [];
  for (const [re, label] of list) if (re.test(text) && !found.includes(label)) found.push(label);
  return found;
}

/**
 * Características de uma mensagem, a partir só do que já está no banco.
 * @param {object} m     linha de messages (subject, from_*, to_json, cc_json, message_id, flagged, answered, snippet, hdr)
 * @param {object} body  linha de bodies (text, html, links, headers, remote_images) ou null
 * @param {object} ctx   { myAddrs:Set, myDomains:Set, contacts:Set, repliedThread:boolean }
 */
function extract(m, body, ctx) {
  const fromAddr = String(m.from_addr || "").toLowerCase();
  const fromDomain = domainOf(fromAddr);
  const local = localOf(fromAddr);
  let hdr = m.hdr != null ? safeJson(m.hdr, {}) : null;
  if (!hdr && body && body.headers) hdr = fromBodyHeaders(body.headers);
  const h = hdr || {};

  // Plataforma de envio: domínio do Return-Path, de quem assinou (DKIM), do Message-ID e do link de descadastro
  const msgIdDomain = (/@([^>\s]+)>?$/.exec(String(m.message_id || "")) || [])[1] || "";
  const luHosts = (String(h["list-unsubscribe"] || "").match(/https?:\/\/[^>,\s]+/g) || []).map(hostOf);
  const hosts = [h["return-path"], ...(h.dkim || []), msgIdDomain.toLowerCase(), ...luHosts].filter(Boolean);
  let espMarketing = espOf(hosts, MARKETING_ESP);
  if (!espMarketing && h["x-mc-user"]) espMarketing = "Mailchimp";
  if (!espMarketing && h["x-mailer"] && MAILER_MARKETING.test(h["x-mailer"])) espMarketing = String(h["x-mailer"]).slice(0, 30);
  let espBulk = espMarketing ? null : espOf(hosts, BULK_ESP);
  if (!espBulk && !espMarketing) espBulk = h["x-sg-eid"] ? "SendGrid" : h["x-ses-outgoing"] ? "Amazon SES" : h["x-mailgun-sid"] ? "Mailgun" : null;

  const prec = norm(h.precedence || "");
  const auto = norm(h["auto-submitted"] || "");

  // Destinatários
  const to = safeJson(m.to_json, []);
  const cc = safeJson(m.cc_json, []);
  const rcpts = [...to, ...cc].map((a) => String(a.address || "").toLowerCase()).filter(Boolean);
  const toMeOnly = to.length === 1 && !cc.length && ctx.myAddrs.has(String(to[0].address || "").toLowerCase());

  // Corpo (só se já estiver no cache)
  const html = body && body.html ? String(body.html) : "";
  const bodyText = body ? (body.text ? String(body.text).slice(0, 6000) : stripHtml(html).slice(0, 6000)) : "";
  const text = bodyText || String(m.snippet || "");
  const links = body ? safeJson(body.links, []) : [];
  const imgCount = html ? (html.match(/<img\b/gi) || []).length : 0;
  const textLen = bodyText.replace(/\s+/g, " ").length;
  let trackers = 0;
  let unsubLink = false;
  for (const l of links.slice(0, 300)) {
    const href = String(l.href || "");
    const host = hostOf(href);
    if (TRACKER_HOST.test(host) || /[?&]utm_(source|medium|campaign)=/i.test(href) || (TRACKER_SUB.test(host) && host !== fromDomain)) trackers++;
    if (!unsubLink && UNSUB.test(norm(`${l.text || ""} ${href}`))) unsubLink = true;
  }
  if (!unsubLink && UNSUB.test(norm(text.slice(-1500)))) unsubLink = true;

  const subjectN = norm(m.subject);
  const textN = norm(text);
  const personalLocal = !NOREPLY_LOCAL.test(local) && !MARKETING_LOCAL.test(local) && !NOTIFY_LOCAL.test(local);

  return {
    hasHdr: !!hdr,
    hasBody: !!body,
    fromAddr,
    fromDomain,
    freemail: FREEMAIL.has(fromDomain),
    listUnsub: !!h["list-unsubscribe"],
    listId: !!h["list-id"],
    precBulk: /^(bulk|junk)$/.test(prec),
    precList: prec === "list",
    autoSubmitted: !!auto && auto !== "no",
    feedbackId: !!h["feedback-id"],
    campaign: !!(h["x-campaign"] || h["x-campaign-id"]),
    espMarketing,
    espBulk,
    noreply: NOREPLY_LOCAL.test(local),
    marketingLocal: MARKETING_LOCAL.test(local),
    notifyLocal: NOTIFY_LOCAL.test(local),
    personalLocal,
    promoSubject: matchTerms(subjectN, PROMO),
    promoBody: matchTerms(textN.slice(0, 4000), PROMO),
    transSubject: matchTerms(subjectN, TRANS),
    transBody: matchTerms(textN.slice(0, 3000), TRANS),
    emojiSubject: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(String(m.subject || "")),
    unsubLink,
    trackers,
    imgHeavy: (imgCount >= 3 && textLen / imgCount < 120) || ((body && body.remote_images) >= 4 && textLen < 600),
    toMeOnly,
    manyRcpts: rcpts.length > 10,
    fromMe: ctx.myAddrs.has(fromAddr),
    sameDomain: !!fromDomain && !FREEMAIL.has(fromDomain) && ctx.myDomains.has(fromDomain),
    known: ctx.contacts.has(fromAddr),
    repliedThread: !!ctx.repliedThread,
    answered: !!m.answered,
    flagged: !!m.flagged,
    reSubject: /^\s*(re|res|resp|aw)\s*:/i.test(String(m.subject || "")),
    subject: String(m.subject || ""),
    fromName: String(m.from_name || ""),
    text,
  };
}

const bulkMarkers = (f) => f.listUnsub || f.listId || f.precBulk || f.precList || f.espMarketing || f.espBulk || f.campaign || f.feedbackId;

/** Pontos por categoria, com os motivos. */
function scoreRules(f) {
  const s = { importante: 0, propaganda: 0, outros: 0 };
  const why = { importante: [], propaganda: [], outros: [] };
  const add = (cat, pts, reason) => {
    s[cat] += pts;
    if (reason && pts > 0) why[cat].push([pts, reason]);
  };
  const bulk = bulkMarkers(f);

  // ---- Importante: relação pessoal com o remetente ----
  if (f.answered) add("importante", 60, "Você respondeu esta mensagem");
  else if (f.repliedThread) add("importante", 50, "Você respondeu nesta conversa");
  if (f.flagged) add("importante", 45, "Você favoritou");
  if (f.fromMe) add("importante", 40, "Enviada por você");
  else if (f.known) add("importante", 40, "Você já escreveu para este remetente");
  if (f.toMeOnly && !bulk && !f.noreply) add("importante", 20, "Endereçada só a você");
  if (f.hasHdr && !bulk && !f.autoSubmitted && !f.noreply && !f.marketingLocal) add("importante", 15, "Sem cabeçalhos de envio em massa");
  if (f.sameDomain && !bulk && !f.noreply && !f.notifyLocal) add("importante", 20, "Mesmo domínio da sua conta");
  if (f.reSubject && !bulk) add("importante", 10, "Resposta (Re:)");
  if (f.freemail && f.personalLocal && !bulk) add("importante", 5, "Remetente pessoal");
  if (f.manyRcpts) add("importante", -10);
  if (f.personalLocal && f.fromName && !bulk) add("importante", 5);

  // ---- Propaganda: envio em massa + conteúdo de oferta ----
  if (f.listUnsub) add("propaganda", 25, "Cabeçalho List-Unsubscribe (lista de envio)");
  if (f.listId) add("propaganda", 10, "Cabeçalho List-Id");
  if (f.precBulk) add("propaganda", 20, "Precedence: bulk");
  else if (f.precList) add("propaganda", 10, "Precedence: list");
  if (f.feedbackId) add("propaganda", 8, "Feedback-ID de envio em massa");
  if (f.espMarketing) add("propaganda", 25, `Plataforma de marketing (${f.espMarketing})`);
  else if (f.espBulk) add("propaganda", 12, `Plataforma de envio em massa (${f.espBulk})`);
  if (f.campaign) add("propaganda", 15, "Cabeçalho de campanha");
  if (f.marketingLocal) add("propaganda", 20, "Remetente do tipo newsletter/marketing");
  if (f.noreply) add("propaganda", 8, "Remetente noreply");
  if (f.promoSubject.length) add("propaganda", Math.min(35, 20 + 10 * (f.promoSubject.length - 1)), `Assunto com oferta: ${f.promoSubject.slice(0, 3).join(", ")}`);
  if (f.promoBody.length) add("propaganda", Math.min(15, 5 * f.promoBody.length), `Texto com termos de oferta: ${f.promoBody.slice(0, 3).join(", ")}`);
  if (f.emojiSubject && bulk) add("propaganda", 5, "Emoji no assunto");
  if (f.unsubLink) add("propaganda", 20, "Link de descadastro no corpo");
  if (f.imgHeavy) add("propaganda", 15, "Muitas imagens para pouco texto");
  if (f.trackers >= 3) add("propaganda", 10, "Links de rastreamento");

  // ---- Outros: avisos automáticos, recibos, notificações ----
  if (f.autoSubmitted) add("outros", 30, "Mensagem automática (Auto-Submitted)");
  if (f.notifyLocal) add("outros", 15, "Remetente de avisos/sistema");
  if (f.noreply) add("outros", 10, "Remetente noreply");
  if (f.espBulk) add("outros", 5);
  if (f.transSubject.length) {
    add("outros", 30, `Assunto de aviso/recibo: ${f.transSubject.slice(0, 3).join(", ")}`);
    add("propaganda", -15);
  }
  if (f.transBody.length) add("outros", 10, `Texto de aviso/recibo: ${f.transBody.slice(0, 3).join(", ")}`);

  const ranked = CATS.map((c) => [c, s[c]]).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  const margin = top[1] - Math.max(0, second[1]);
  const confidence = top[1] < 25 ? 40 : Math.max(0, Math.min(98, Math.round(50 + margin * 0.5)));
  const reasons = (c) => why[c].sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  return { scores: s, category: top[1] < 25 ? "outros" : top[0], confidence, margin, reasons, bulk: !!bulk };
}

// ---------- Palavras para o modelo estatístico ----------
/** Palavras (únicas) do assunto, remetente e texto, mais marcadores estruturais. */
function tokensOf(f) {
  const t = new Set();
  for (const w of words(f.subject, 30, "s:")) t.add(w);
  for (const w of words(f.fromName, 6, "n:")) t.add(w);
  if (f.fromAddr) t.add("a:" + f.fromAddr);
  if (f.fromDomain) t.add("d:" + f.fromDomain);
  for (const w of words(f.text, 180, "w:")) t.add(w);
  const flags = {
    lu: f.listUnsub, lid: f.listId, bulk: f.precBulk || f.precList, auto: f.autoSubmitted, fb: f.feedbackId,
    espm: !!f.espMarketing, espb: !!f.espBulk, camp: f.campaign, noreply: f.noreply, mkt: f.marketingLocal,
    ntf: f.notifyLocal, unsub: f.unsubLink, img: f.imgHeavy, trk: f.trackers >= 3, tome: f.toMeOnly,
    many: f.manyRcpts, known: f.known, same: f.sameDomain, re: f.reSubject, free: f.freemail, emoji: f.emojiSubject,
  };
  for (const [k, v] of Object.entries(flags)) if (v) t.add("f:" + k);
  return [...t].slice(0, 250);
}

module.exports = { extract, scoreRules, tokensOf, norm, words, stripHtml, CATS, NAME, MIN_CONF, FREEMAIL };
