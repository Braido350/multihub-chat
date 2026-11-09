// Corpo das mensagens: baixa do servidor, decodifica o MIME e sanitiza o HTML.
// O resultado (já limpo) vai para o cache; o HTML original nunca chega à interface.
const { simpleParser } = require("mailparser");
const sanitizeHtml = require("sanitize-html");
const libmime = require("libmime");
const { Parser } = require("htmlparser2");

const MAX_PARSE = 20 * 1024 * 1024; // acima disso, baixa só as partes de texto
const MAX_TEXT_PART = 3 * 1024 * 1024;
const MAX_INLINE_EACH = 3 * 1024 * 1024; // imagens embutidas (cid:) viram data: URI
const MAX_INLINE_TOTAL = 10 * 1024 * 1024;
const MAX_HTML = 5 * 1024 * 1024;

// ---------- Estrutura MIME ----------
function leaves(node, out = []) {
  if (!node) return out;
  if (node.childNodes && node.childNodes.length) {
    for (const c of node.childNodes) leaves(c, out);
  } else {
    out.push(node);
  }
  return out;
}

function decodeName(v) {
  if (!v) return "";
  try {
    return /=\?/.test(v) ? libmime.decodeWords(v) : v;
  } catch {
    return v;
  }
}

const cidKey = (v) => String(v || "").replace(/^<|>$/g, "").trim().toLowerCase();

/** Anexos a partir do BODYSTRUCTURE (precisamos do número da parte para baixar depois). */
function attachmentsFrom(structure) {
  const list = [];
  for (const n of leaves(structure)) {
    const type = String(n.type || "application/octet-stream").toLowerCase();
    const disp = String(n.disposition || "").toLowerCase();
    let filename = decodeName((n.dispositionParameters && n.dispositionParameters.filename) || (n.parameters && n.parameters.name));
    const isBodyText = (type === "text/plain" || type === "text/html") && !filename && disp !== "attachment";
    if (isBodyText || type.startsWith("multipart/")) continue;
    if (!filename) {
      if (type === "message/rfc822") filename = ((n.envelope && n.envelope.subject) || "mensagem") + ".eml";
      else if (type === "text/calendar") filename = "convite.ics";
      else filename = "anexo" + (type.startsWith("image/") ? "." + type.slice(6).replace(/\W.*/, "") : "");
    }
    // Estimativa do tamanho decodificado (base64 ocupa ~4/3)
    const size = n.size ? (String(n.encoding).toLowerCase() === "base64" ? Math.floor((n.size * 3) / 4) : n.size) : 0;
    list.push({
      part: n.part || "1",
      filename: filename.replace(/[\\/\x00-\x1f]/g, "_").slice(0, 200),
      contentType: type,
      size,
      cid: n.id ? cidKey(n.id) : null,
      inline: !!n.id && type.startsWith("image/") && disp !== "attachment",
    });
  }
  return list;
}

// ---------- Sanitização ----------
const ALLOWED_TAGS = [
  "a", "abbr", "b", "big", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del",
  "div", "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark",
  "ol", "p", "pre", "q", "s", "small", "span", "strike", "strong", "style", "sub", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "tt", "u", "ul", "wbr", "article", "section", "header", "footer", "main", "figure",
  "figcaption",
];
const COMMON_ATTRS = [
  "style", "class", "align", "valign", "width", "height", "bgcolor", "border", "dir", "title", "lang",
  "cellpadding", "cellspacing", "colspan", "rowspan", "color", "face", "size", "nowrap",
];

/**
 * @param {string} html
 * @param {Map<string,string>} inline  cid -> data: URI
 */
function sanitize(html, inline) {
  let remote = 0;
  const usedCids = new Set();
  const clean = sanitizeHtml(String(html).slice(0, MAX_HTML), {
    allowedTags: ALLOWED_TAGS,
    disallowedTagsMode: "discard",
    // Conteúdo destes some junto com a tag (o <title> não deve aparecer como texto)
    nonTextTags: ["script", "noscript", "textarea", "option", "title", "xml", "template", "object", "iframe"],
    allowedAttributes: {
      "*": COMMON_ATTRS,
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "data-remote-src"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["data"] },
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    // <style> é necessário para e-mails ficarem legíveis. CSS não executa script, e o iframe que exibe o
    // e-mail tem CSP sem rede (img-src data:), então url() remoto em CSS não carrega.
    allowVulnerableTags: true,
    parseStyleAttributes: false,
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }),
      img: (tagName, attribs) => {
        const src = String(attribs.src || "").trim();
        const out = { ...attribs };
        delete out.src;
        if (/^cid:/i.test(src)) {
          const key = cidKey(src.slice(4));
          const data = inline.get(key);
          if (data) {
            out.src = data;
            usedCids.add(key);
          }
        } else if (/^https?:\/\//i.test(src)) {
          remote++;
          out["data-remote-src"] = src; // a interface só carrega se o usuário pedir
        } else if (/^data:image\//i.test(src)) {
          out.src = src;
        }
        return { tagName, attribs: out };
      },
    },
  });
  return { html: clean, remote, usedCids };
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Texto puro vira HTML seguro, com links clicáveis. */
function textToHtml(text) {
  const parts = String(text).split(/(\bhttps?:\/\/[^\s<>"']+)/g);
  const body = parts
    .map((p, i) => {
      if (i % 2 === 0) return escapeHtml(p);
      const url = p.replace(/[.,;:!?)\]]+$/, "");
      const rest = p.slice(url.length);
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>${escapeHtml(rest)}`;
    })
    .join("");
  return `<div class="mh-plain">${body}</div>`;
}

// ---------- Cabeçalhos e links para a triagem (fase 6) ----------
// Só o que importa para segurança; nada de corpo
const SECURITY_HEADERS = new Set([
  "authentication-results", "arc-authentication-results", "received-spf", "return-path", "reply-to", "from",
  "sender", "list-unsubscribe", "list-unsubscribe-post", "list-id", "precedence", "auto-submitted", "x-mailer",
  "dkim-signature", "message-id",
]);

/** Bloco de cabeçalhos bruto -> { nome: [valores] } (só os de SECURITY_HEADERS). */
function pickHeaders(raw) {
  const out = {};
  if (!raw) return out;
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    if (!SECURITY_HEADERS.has(key)) continue;
    let value = line.slice(i + 1).trim();
    if (key === "dkim-signature") value = (/\bd=([^;\s]+)/i.exec(value) || [])[0] || ""; // só o domínio assinante
    (out[key] ||= []).push(value.slice(0, 1000));
    if (out[key].length > 10) out[key].length = 10;
  }
  return out;
}

/** Links com o texto que o leitor vê (para achar "texto diz banco X, link vai para Y"). */
function extractLinks(html, text) {
  const out = [];
  if (html) {
    let cur = null;
    const p = new Parser(
      {
        onopentag(name, attrs) {
          if (name === "a" && attrs.href && out.length < 300) cur = { href: String(attrs.href).trim().slice(0, 2000), text: "" };
        },
        ontext(t) {
          if (cur && cur.text.length < 300) cur.text += t;
        },
        onclosetag(name) {
          if (name === "a" && cur) {
            cur.text = cur.text.replace(/\s+/g, " ").trim().slice(0, 300);
            out.push(cur);
            cur = null;
          }
        },
      },
      { decodeEntities: true }
    );
    p.write(String(html).slice(0, MAX_HTML));
    p.end();
  }
  if (!out.length && text) {
    for (const m of String(text).matchAll(/\bhttps?:\/\/[^\s<>"']+/g)) {
      if (out.length >= 300) break;
      out.push({ href: m[0].replace(/[.,;:!?)\]]+$/, ""), text: "" });
    }
  }
  return out;
}

const snippetOf = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);

async function readStream(stream, max) {
  const chunks = [];
  let n = 0;
  for await (const c of stream) {
    n += c.length;
    if (n > max) break;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/**
 * Baixa e prepara o corpo de uma mensagem. Deve ser chamado com a pasta já travada (getMailboxLock).
 * @param {import('imapflow').ImapFlow} client
 */
async function fetchBody(client, uid) {
  const meta = await client.fetchOne(String(uid), { uid: true, bodyStructure: true, size: true, headers: true }, { uid: true });
  if (!meta) {
    const err = new Error("A mensagem não está mais no servidor (pode ter sido movida ou excluída).");
    err.code = "GONE";
    throw err;
  }
  const attachments = attachmentsFrom(meta.bodyStructure);
  let html = null;
  let text = null;
  let truncated = false;
  const inline = new Map();

  if ((meta.size || 0) <= MAX_PARSE) {
    // fetchOne com source usa BODY.PEEK[]: não marca a mensagem como lida
    const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
    const parsed = await simpleParser(full.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
    html = parsed.html || null;
    text = parsed.text || null;
    let total = 0;
    for (const a of parsed.attachments || []) {
      if (!a.contentId || !/^image\//i.test(a.contentType) || a.size > MAX_INLINE_EACH) continue;
      if ((total += a.size) > MAX_INLINE_TOTAL) break;
      inline.set(cidKey(a.contentId), `data:${a.contentType};base64,${a.content.toString("base64")}`);
    }
  } else {
    // Mensagem enorme: baixa só o texto, sem os anexos
    truncated = true;
    const nodes = leaves(meta.bodyStructure);
    const pick = (t) =>
      nodes.find((n) => String(n.type).toLowerCase() === t && String(n.disposition || "").toLowerCase() !== "attachment");
    for (const [t, set] of [
      ["text/html", (v) => (html = v)],
      ["text/plain", (v) => (text = v)],
    ]) {
      const n = pick(t);
      if (!n) continue;
      const dl = await client.download(String(uid), n.part || "1", { uid: true, maxBytes: MAX_TEXT_PART, decodeText: true });
      if (dl && dl.content) set((await readStream(dl.content, MAX_TEXT_PART)).toString("utf8"));
    }
  }

  let out;
  if (html) out = sanitize(html, inline);
  else out = { html: textToHtml(text || ""), remote: 0, usedCids: new Set() };

  // Imagens embutidas que aparecem no corpo não precisam ser listadas como anexo
  for (const a of attachments) if (a.inline && !(a.cid && out.usedCids.has(a.cid))) a.inline = false;

  return {
    html: out.html,
    text: text,
    remoteImages: out.remote,
    attachments,
    truncated,
    headers: pickHeaders(meta.headers),
    links: extractLinks(html, text),
    snippet: snippetOf(text || sanitizeHtml(html || "", { allowedTags: [], nonTextTags: ["style", "script", "title"] })),
  };
}

module.exports = { fetchBody, sanitize, textToHtml, attachmentsFrom, readStream, pickHeaders, extractLinks };
