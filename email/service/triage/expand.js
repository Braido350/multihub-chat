// Expande links encurtados sem abrir página nenhuma: só segue os redirecionamentos HTTP.
// Sem JavaScript, sem cookies, sem corpo da resposta, e com proteção contra SSRF
// (um link de e-mail não pode fazer o app acessar a rede interna, o roteador ou o próprio PC).
const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");

const MAX_HOPS = 6;
const TIMEOUT = 5000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 || // reservado, privado, loopback, multicast/futuro
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local (inclui metadados de nuvem)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("64:ff9b:") || v.startsWith("ff");
}

/** Resolve o nome e recusa se QUALQUER endereço for interno (evita truques com vários registros DNS). */
async function safeResolve(hostname) {
  hostname = String(hostname).replace(/^\[|\]$/g, ""); // IPv6 vem entre colchetes na URL
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("endereço interno bloqueado");
    return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
  }
  const list = await dns.lookup(hostname, { all: true });
  if (!list.length) throw new Error("domínio não encontrado");
  if (list.some((a) => isPrivateIp(a.address))) throw new Error("domínio aponta para endereço interno");
  return list[0];
}

function request(url, addr, method) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        // Conecta no IP já verificado (impede "DNS rebinding" entre a checagem e a conexão)
        lookup: (_h, opts, cb) =>
          opts && opts.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family),
        headers: { "User-Agent": "Mozilla/5.0 (link-check)", Accept: "*/*", ...(method === "GET" ? { Range: "bytes=0-0" } : {}) },
        timeout: TIMEOUT,
      },
      (res) => {
        res.resume(); // descarta o corpo
        resolve({ status: res.statusCode, location: res.headers.location });
        req.destroy();
      }
    );
    req.on("timeout", () => req.destroy(new Error("tempo esgotado")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * @returns {Promise<{final: string, chain: string[], error?: string}>}
 */
async function expand(href) {
  const chain = [];
  let url;
  try {
    url = new URL(href);
  } catch {
    return { final: href, chain, error: "endereço inválido" };
  }
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    chain.push(url.href);
    if (!/^https?:$/.test(url.protocol)) break;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (port !== 80 && port !== 443) return { final: url.href, chain, error: "porta incomum bloqueada" };
    try {
      const addr = await safeResolve(url.hostname);
      let r = await request(url, addr, "HEAD");
      if (r.status === 405 || r.status === 403 || r.status === 501) r = await request(url, addr, "GET");
      if (r.status >= 300 && r.status < 400 && r.location) {
        url = new URL(r.location, url);
        continue;
      }
      return { final: url.href, chain };
    } catch (err) {
      return { final: url.href, chain, error: err.message };
    }
  }
  return { final: url.href, chain, error: chain.length >= MAX_HOPS ? "redirecionamentos demais" : undefined };
}

module.exports = { expand, isPrivateIp, safeResolve };
