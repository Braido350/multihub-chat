// Camada 1 da triagem: sinais determinísticos (sem rede, sem LLM).
// Cada sinal tem um id estável (para métricas), peso, gravidade e uma explicação em português.
const { domainToUnicode } = require("url");
const BRANDS = require("./brands");

const VERSION = "det-3"; // det-2: Reply-To para um endereço seu não é risco · det-3: mais domínios oficiais da Microsoft

// ---------- Domínios ----------
// Sufixos com dois níveis mais comuns (o suficiente para achar o domínio registrável)
const MULTI_SUFFIX = new Set([
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "art.br", "blog.br", "eco.br", "emp.br", "ind.br", "inf.br",
  "jus.br", "leg.br", "mil.br", "mp.br", "nom.br", "srv.br", "tur.br", "app.br", "dev.br", "log.br", "med.br",
  "adv.br", "eng.br", "coop.br", "co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "net.au", "com.ar", "com.mx",
  "com.co", "com.pt", "co.jp", "co.in", "com.es", "com.uy", "com.py", "com.cl", "co.za",
]);

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** "mail.loja.com.br" -> "loja.com.br" (e subdomínios de gov.br ficam com 3 níveis: "receita.fazenda.gov.br" -> "fazenda.gov.br"). */
function registrable(host) {
  host = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || isIp(host)) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const two = parts.slice(-2).join(".");
  return MULTI_SUFFIX.has(two) ? parts.slice(-3).join(".") : two;
}
const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
const domainOfEmail = (addr) => String(addr || "").split("@")[1]?.toLowerCase().trim() || "";
const label = (reg) => reg.split(".")[0] || "";

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "yahoo.com", "yahoo.com.br",
  "bol.com.br", "uol.com.br", "terra.com.br", "ig.com.br", "icloud.com", "me.com", "proton.me", "protonmail.com",
  "zoho.com", "gmx.com", "aol.com", "mail.com", "yandex.com",
]);

const SHORTENERS = new Set([
  "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly", "rb.gy",
  "shorturl.at", "tiny.cc", "s.id", "t.ly", "rebrand.ly", "encurtador.com.br", "encurta.net", "bl.ink", "lnkd.in",
  "shorte.st", "adf.ly", "v.gd", "x.co", "qr.ae", "trib.al", "short.gy", "shorturl.gg", "u.to", "clck.ru", "linktr.ee",
]);

// Redirecionadores de rastreamento de e-mail marketing legítimo: texto ≠ destino é normal neles
// (só serviços conhecidos; subdomínios do próprio remetente são tratados à parte)
const TRACKERS = /(^|\.)(list-manage\.com|mailchimp\.com|sendgrid\.net|mandrillapp\.com|hubspotlinks\.com|hubspotemail\.net|hs-analytics\.net|rdstation\.com\.br|rdstation\.com|exct\.net|exacttarget\.com|sparkpostmail\.com|mailgun\.org|awstrack\.me|amazonses\.com|safelinks\.protection\.outlook\.com|l\.facebook\.com|mlsend\.com|brevo\.com|sendibt\d*\.com|sendinblue\.com|mailerlite\.com|acems\d*\.com|activehosted\.com|klclick\d*\.com|klaviyo\.com|substack\.com|beehiiv\.com|convertkit-mail\d*\.com|rs6\.net|constantcontact\.com|emarsys\.net|dynect\.net|salesforce\.com|pardot\.com)$/i;

// ---------- Homóglifos / domínios parecidos ----------
const CONFUSABLE = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ӏ": "l", "ԁ": "d", "ѕ": "s",
  "ɡ": "g", "ο": "o", "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "l",
};
function skeleton(s) {
  let out = String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  out = [...out].map((c) => CONFUSABLE[c] || c).join("");
  return out.replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d").replace(/[-_.]/g, "");
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const isOfficial = (reg, brand) => brand.domains.some((d) => reg === d || reg.endsWith("." + d));

/**
 * Compara um host com as marcas conhecidas.
 * @returns {null | {kind: "lookalike"|"brand-subdomain"|"brand-keyword", brand, detail}}
 */
function brandCheck(host) {
  if (!host || isIp(host)) return null;
  const unicodeHost = domainToUnicode(host) || host;
  const reg = registrable(host);
  for (const b of BRANDS) {
    if (isOfficial(reg, b)) return null; // domínio oficial de alguma marca: tudo certo
  }
  const regLabel = label(registrable(unicodeHost));
  for (const b of BRANDS) {
    // "itau.com.br.verifica-conta.xyz": o domínio oficial aparece, mas o registrável é outro
    for (const d of b.domains) {
      if (d.includes(".") && (unicodeHost.startsWith(d + ".") || unicodeHost.includes("." + d + "."))) {
        return { kind: "brand-subdomain", brand: b.name, detail: d };
      }
    }
    for (const d of b.domains) {
      const official = label(d);
      if (official.length < 4) continue;
      // Letras trocadas só contam em nomes longos ("intel" não imita "inter")
      if (skeleton(regLabel) === skeleton(official) || (official.length >= 6 && levenshtein(regLabel, official) <= (official.length >= 9 ? 2 : 1))) {
        return { kind: "lookalike", brand: b.name, detail: d };
      }
    }
    const inDomain = b.domainKeywords || (b.strict ? b.keywords : []);
    if (inDomain.length) {
      for (const k of inDomain) {
        const kk = norm(k).replace(/\s+/g, "");
        if (kk.length >= 5 && skeleton(unicodeHost).includes(skeleton(kk))) return { kind: "brand-keyword", brand: b.name, detail: k };
      }
    }
  }
  return null;
}

/** Nome de exibição cita uma marca, mas o e-mail não é de domínio oficial dela. */
function displayBrand(name, fromDomain) {
  const n = ` ${norm(name).replace(/[^a-z0-9.]+/g, " ")} `;
  const reg = registrable(fromDomain);
  for (const b of BRANDS) {
    if (isOfficial(reg, b)) continue;
    for (const k of b.keywords) {
      if (n.includes(` ${norm(k)} `)) return b;
    }
  }
  return null;
}

// ---------- Anexos ----------
const EXEC = /\.(exe|com|scr|pif|bat|cmd|msi|msix|msp|cpl|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|hta|lnk|reg|dll|app|command|sh|apk|appimage|run|elf)$/i;
const DISK = /\.(iso|img|vhd|vhdx|dmg)$/i;
const MACRO = /\.(docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam|sldm)$/i;
const HTMLISH = /\.(html?|shtml|xhtml|svg|mht|mhtml)$/i;
const ONENOTE = /\.(one|onepkg)$/i;
const ARCHIVE = /\.(zip|rar|7z|gz|tgz|tar|ace|cab|arj|lzh|xz|bz2)$/i;
const DOUBLE_EXT = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|txt|csv|zip|rar)(\s{2,}|\.)+[a-z0-9]{2,5}$/i;

function attachmentSignals(list) {
  const out = [];
  for (const a of list || []) {
    if (a.inline) continue;
    const f = String(a.filename || "");
    if (DOUBLE_EXT.test(f) && (EXEC.test(f) || HTMLISH.test(f) || DISK.test(f))) {
      out.push(sig("ATT_DOUBLE_EXT", 75, "critical", `Anexo com extensão dupla disfarçada: "${f}"`));
    } else if (EXEC.test(f)) {
      out.push(sig("ATT_EXECUTABLE", 45, "high", `Anexo executável ou script: "${f}"`));
    } else if (DISK.test(f)) {
      out.push(sig("ATT_DISK_IMAGE", 40, "high", `Anexo de imagem de disco (usado para driblar antivírus): "${f}"`));
    } else if (MACRO.test(f)) {
      out.push(sig("ATT_MACRO", 35, "high", `Documento do Office com macros: "${f}"`));
    } else if (HTMLISH.test(f)) {
      out.push(sig("ATT_HTML", 30, "medium", `Anexo HTML/SVG (pode abrir uma página falsa de login): "${f}"`));
    } else if (ONENOTE.test(f)) {
      out.push(sig("ATT_ONENOTE", 30, "medium", `Anexo do OneNote (vetor comum de malware): "${f}"`));
    }
  }
  return out;
}

// ---------- Autenticação (SPF/DKIM/DMARC) ----------
function parseAuth(headers) {
  // Vale o Authentication-Results mais recente (o que o NOSSO provedor acrescentou, no topo)
  const ar = (headers["authentication-results"] || [])[0] || "";
  const res = {};
  for (const k of ["spf", "dkim", "dmarc"]) {
    const m = new RegExp(`\\b${k}=([a-z]+)`, "i").exec(ar);
    if (m) res[k] = m[1].toLowerCase();
  }
  if (!res.spf) {
    const m = /^([a-z]+)/i.exec((headers["received-spf"] || [])[0] || "");
    if (m) res.spf = m[1].toLowerCase();
  }
  const from = /header\.from=([^\s;]+)/i.exec(ar);
  res.headerFrom = from ? from[1].toLowerCase() : null;
  res.present = !!ar || !!res.spf;
  return res;
}

function addressFromHeader(v) {
  const m = /<([^>]+)>/.exec(v || "") || /([^\s<>"]+@[^\s<>"]+)/.exec(v || "");
  return m ? m[1].toLowerCase() : "";
}

const sig = (id, weight, severity, detail, extra) => ({ id, weight, severity, detail, ...(extra || {}) });

// ---------- Links ----------
const URLISH = /^(https?:\/\/)?(www\.)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;
const RISKY_DOWNLOAD = /\.(exe|scr|msi|bat|cmd|js|vbs|jar|apk|iso|img|zip|rar|7z|ps1|hta|lnk|appimage)(\?|#|$)/i;

function linkSignals(links, fromReg) {
  const out = [];
  const seen = new Set();
  const shorteners = [];
  for (const l of links || []) {
    let u;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    const host = u.hostname.toLowerCase();
    const reg = registrable(host);
    const text = String(l.text || "").trim();

    // Texto mostra um endereço, mas o link vai para outro domínio
    if (URLISH.test(text) && !text.includes(" ")) {
      const textHost = hostOf(/^https?:\/\//i.test(text) ? text : "http://" + text);
      const textReg = registrable(textHost);
      if (textReg && textReg !== reg && !seen.has("txt:" + reg)) {
        seen.add("txt:" + reg);
        // Rastreador de serviço de envio conhecido, ou subdomínio do próprio remetente (click.loja.com.br)
        const tracker = TRACKERS.test(host) || (fromReg && reg === fromReg);
        out.push(
          tracker
            ? sig("LINK_TEXT_MISMATCH_TRACKER", 5, "low", `Link mostra "${textHost}" mas passa por rastreador de marketing (${host})`)
            : sig("LINK_TEXT_MISMATCH", 30, "high", `Link mostra "${textHost}" mas leva para "${host}"`, { url: u.href })
        );
      }
    }
    if (seen.has(host)) continue;
    seen.add(host);

    if (isIp(host.replace(/^\[|\]$/g, ""))) {
      out.push(sig("LINK_IP", 25, "high", `Link aponta direto para um endereço IP (${host})`, { url: u.href }));
    } else if (host.split(".").some((p) => p.startsWith("xn--"))) {
      out.push(sig("LINK_PUNYCODE", 25, "high", `Link com domínio internacionalizado (pode imitar letras): ${domainToUnicode(host)} (${host})`, { url: u.href }));
    }
    const bc = brandCheck(host);
    if (bc && bc.kind === "lookalike") out.push(sig("LINK_LOOKALIKE", 45, "critical", `Link para domínio que imita ${bc.brand}: ${host}`, { url: u.href }));
    else if (bc && bc.kind === "brand-subdomain") out.push(sig("LINK_BRAND_SUBDOMAIN", 45, "critical", `Link usa "${bc.detail}" como disfarce dentro de outro domínio: ${host}`, { url: u.href }));
    else if (bc && bc.kind === "brand-keyword" && reg !== fromReg) out.push(sig("LINK_BRAND_KEYWORD", 20, "medium", `Link para domínio não oficial com o nome de ${bc.brand}: ${host}`, { url: u.href }));

    if (SHORTENERS.has(reg) || SHORTENERS.has(host)) {
      out.push(sig("LINK_SHORTENER", 8, "low", `Link encurtado (esconde o destino): ${host}`, { url: u.href }));
      shorteners.push(u.href);
    }
    if (RISKY_DOWNLOAD.test(u.pathname)) out.push(sig("LINK_RISKY_FILE", 35, "high", `Link baixa arquivo de risco: ${u.pathname.split("/").pop()}`, { url: u.href }));
  }
  // Links não podem, sozinhos, passar de 60 pontos (newsletters têm muitos)
  let total = 0;
  for (const s of out) {
    const room = Math.max(0, 60 - total);
    if (s.weight > room) s.weight = room;
    total += s.weight;
  }
  return { signals: out, shorteners };
}

// ---------- Análise completa ----------
/**
 * @param {{from:{name,address}, headers:object, links:Array, attachments:Array}} m
 */
function analyze(m) {
  const signals = [];
  const fromAddr = String(m.from.address || "").toLowerCase();
  const fromDomain = domainOfEmail(fromAddr);
  const fromReg = registrable(fromDomain);
  const headers = m.headers || {};

  // Autenticação
  const auth = parseAuth(headers);
  if (auth.dmarc === "fail") signals.push(sig("AUTH_DMARC_FAIL", 35, "high", "DMARC falhou: o domínio do remetente não autorizou este envio"));
  if (auth.spf === "fail") signals.push(sig("AUTH_SPF_FAIL", 15, "medium", "SPF falhou: o servidor que enviou não está autorizado pelo domínio"));
  else if (auth.spf === "softfail") signals.push(sig("AUTH_SPF_SOFTFAIL", 5, "low", "SPF parcial (softfail)"));
  if (auth.dkim === "fail") signals.push(sig("AUTH_DKIM_FAIL", 15, "medium", "Assinatura DKIM inválida (a mensagem pode ter sido alterada)"));
  if (auth.dmarc === "pass" || (auth.spf === "pass" && auth.dkim === "pass")) signals.push(sig("AUTH_PASS", 0, "info", "Remetente autenticado (SPF/DKIM/DMARC ok)"));
  if (!auth.present) signals.push(sig("AUTH_UNKNOWN", 0, "info", "O servidor não informou SPF/DKIM/DMARC"));

  // Remetente
  const fromCheck = brandCheck(fromDomain);
  if (fromDomain && fromDomain.split(".").some((p) => p.startsWith("xn--"))) {
    signals.push(sig("FROM_PUNYCODE", 30, "high", `Domínio do remetente com letras internacionais: ${domainToUnicode(fromDomain)}`));
  }
  if (fromCheck && fromCheck.kind === "lookalike") signals.push(sig("FROM_LOOKALIKE", 50, "critical", `Domínio do remetente imita ${fromCheck.brand}: ${fromDomain}`));
  else if (fromCheck && fromCheck.kind === "brand-subdomain") signals.push(sig("FROM_BRAND_SUBDOMAIN", 45, "critical", `Remetente usa "${fromCheck.detail}" dentro de outro domínio: ${fromDomain}`));
  else if (fromCheck && fromCheck.kind === "brand-keyword") signals.push(sig("FROM_BRAND_KEYWORD", 25, "medium", `Domínio não oficial com o nome de ${fromCheck.brand}: ${fromDomain}`));

  const name = String(m.from.name || "");
  const nameEmail = /[^\s<>"]+@[^\s<>"]+\.[a-z]{2,}/i.exec(name);
  if (nameEmail && nameEmail[0].toLowerCase() !== fromAddr) {
    signals.push(sig("DISPLAY_EMAIL_SPOOF", 30, "high", `Nome do remetente mostra "${nameEmail[0]}", mas o e-mail real é ${fromAddr}`));
  }
  const spoofed = displayBrand(name, fromDomain);
  if (spoofed) {
    const freemail = FREEMAIL.has(fromReg);
    // Órgão público só envia de gov.br: nome do governo fora disso é imitação quase certa
    const gov = spoofed.gov && !fromReg.endsWith("gov.br");
    signals.push(
      sig(
        "DISPLAY_BRAND_SPOOF",
        freemail || gov ? 50 : 30,
        freemail || gov ? "critical" : "high",
        `Nome do remetente diz "${spoofed.name}", mas o e-mail vem de ${fromDomain}` +
          (freemail ? " (e-mail gratuito)" : gov ? " (órgãos públicos usam gov.br)" : "")
      )
    );
  }

  // Reply-To e Return-Path
  const replyTo = addressFromHeader((headers["reply-to"] || [])[0]);
  const replyReg = registrable(domainOfEmail(replyTo));
  // Reply-To para um endereço seu (ex.: comprovante do Mercado Pago com respostas para você): não é risco
  const replyToMe = !!replyTo && (m.myAddresses || []).includes(replyTo.toLowerCase());
  if (replyToMe && replyReg !== fromReg) signals.push(sig("REPLYTO_SELF", 0, "info", `Respostas vão para o seu próprio endereço (${replyTo})`));
  if (replyTo && replyReg && replyReg !== fromReg && !replyToMe) {
    const free = FREEMAIL.has(replyReg) && !FREEMAIL.has(fromReg);
    signals.push(
      sig(
        free ? "REPLYTO_FREEMAIL" : "REPLYTO_MISMATCH",
        free ? 25 : 10,
        free ? "high" : "low",
        free ? `Respostas vão para um e-mail gratuito (${replyTo}), não para ${fromDomain}` : `Respostas vão para outro domínio: ${replyTo}`
      )
    );
  }
  const returnPath = addressFromHeader((headers["return-path"] || [])[0]);
  const rpReg = registrable(domainOfEmail(returnPath));
  if (returnPath && rpReg && rpReg !== fromReg) {
    signals.push(sig("RETURNPATH_MISMATCH", 3, "info", `Enviado por outro domínio (${rpReg}), comum em serviços de envio`));
  }

  // Links e anexos
  const { signals: ls, shorteners } = linkSignals(m.links, fromReg);
  signals.push(...ls, ...attachmentSignals(m.attachments));

  return { ...score(signals), shorteners, auth, fromReg };
}

function score(signals) {
  const total = Math.min(100, signals.reduce((n, s) => n + (s.weight || 0), 0));
  // Um único sinal crítico já põe a mensagem como suspeita, mesmo com poucos pontos
  const critical = signals.some((s) => s.severity === "critical");
  let level = total >= 70 ? "perigoso" : total >= 40 ? "suspeito" : total >= 20 ? "atencao" : "ok";
  if (critical && (level === "ok" || level === "atencao")) level = "suspeito";
  return { signals, score: total, level };
}

module.exports = { analyze, score, linkSignals, attachmentSignals, brandCheck, registrable, hostOf, skeleton, levenshtein, SHORTENERS, ARCHIVE, VERSION, sig };
