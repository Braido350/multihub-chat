// Cabeçalhos que denunciam envio em massa (List-Unsubscribe, Precedence, plataforma de envio...).
// São baixados junto com o envelope na sincronização (BODY.PEEK[HEADER.FIELDS], poucos bytes por mensagem),
// então a organização da caixa de entrada funciona sem precisar baixar o corpo.

// "references" continua aqui porque a sincronização já pedia esse cabeçalho para montar as conversas
const HDR_FIELDS = [
  "references",
  "list-unsubscribe",
  "list-id",
  "precedence",
  "auto-submitted",
  "feedback-id",
  "x-mailer",
  "return-path",
  "dkim-signature",
  "x-campaign",
  "x-campaign-id",
  "x-mc-user",
  "x-sg-eid",
  "x-ses-outgoing",
  "x-mailgun-sid",
];

/**
 * Bloco de cabeçalhos bruto -> JSON compacto (string). Sempre devolve um objeto, mesmo vazio:
 * '{}' quer dizer "baixado e sem nenhum desses cabeçalhos", diferente de NULL ("ainda não baixado").
 */
function parseHdr(raw) {
  const out = {};
  const text = raw ? (Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)) : "";
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    if (key === "references" || !HDR_FIELDS.includes(key)) continue;
    let value = line.slice(i + 1).trim();
    if (key === "dkim-signature") {
      // Só o domínio que assinou (d=): é o que revela a plataforma de envio
      const d = /\bd=([^;\s]+)/i.exec(value);
      if (d && !(out.dkim ||= []).includes(d[1].toLowerCase()) && out.dkim.length < 4) out.dkim.push(d[1].toLowerCase());
      continue;
    }
    if (key === "return-path") value = ((/@([^>\s]+)/.exec(value) || [])[1] || "").toLowerCase();
    if (!(key in out)) out[key] = value.slice(0, 300);
  }
  return JSON.stringify(out);
}

/** Converte os cabeçalhos guardados com o corpo (fase 6) para o mesmo formato, quando o envelope não tem. */
function fromBodyHeaders(headers) {
  const h = typeof headers === "string" ? safeJson(headers, {}) : headers || {};
  const out = {};
  for (const [k, list] of Object.entries(h)) {
    if (!Array.isArray(list) || !list.length) continue;
    if (k === "dkim-signature") {
      out.dkim = list.map((v) => String(v).replace(/^d=/i, "").toLowerCase()).filter(Boolean).slice(0, 4);
    } else if (k === "return-path") {
      out[k] = ((/@([^>\s]+)/.exec(list[0]) || [])[1] || "").toLowerCase();
    } else if (HDR_FIELDS.includes(k)) {
      out[k] = String(list[0]).slice(0, 300);
    }
  }
  return out;
}

function safeJson(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

module.exports = { HDR_FIELDS, parseHdr, fromBodyHeaders, safeJson };
