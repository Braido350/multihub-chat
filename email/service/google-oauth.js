// OAuth2 do Google para app desktop: navegador do sistema + redirecionamento para
// 127.0.0.1 (loopback) + PKCE. O Google não permite mais fazer login dentro de webviews.
const http = require("http");
const crypto = require("crypto");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// mail.google.com é o único escopo que libera IMAP/SMTP (XOAUTH2). É um escopo "restrito".
const SCOPES = ["openid", "email", "https://mail.google.com/"];
const TIMEOUT = 5 * 60 * 1000;

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

class OAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const DONE_PAGE = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>MultiHub Chat</title>
<body style="font-family:system-ui,sans-serif;background:#14161a;color:#e8eaed;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h2>${ok ? "Conta conectada" : "Não foi possível conectar"}</h2>
<p style="color:#9aa4b0">${msg}</p></div></body>`;

let pending = null; // só um login por vez

function cancel() {
  if (pending) pending.abort(new OAuthError("Login cancelado.", "cancelled"));
}

/**
 * Abre o consentimento do Google no navegador e devolve os tokens.
 * @param {{clientId:string, clientSecret:string, loginHint?:string, openExternal:(url:string)=>void}} o
 */
function authorize({ clientId, clientSecret, loginHint, openExternal }) {
  cancel();
  return new Promise((resolve, reject) => {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    let redirectUri = "";
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      pending = null;
      err ? reject(err) : resolve(value);
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const send = (ok, msg) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE(ok, msg));
      };
      if (url.searchParams.get("state") !== state) {
        send(false, "Resposta inválida. Tente de novo pelo app.");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        send(false, "O acesso não foi autorizado. Você pode fechar esta aba.");
        finish(new OAuthError(error === "access_denied" ? "Acesso negado no Google." : `Google: ${error}`, error));
        return;
      }
      try {
        const tokens = await tokenRequest({
          client_id: clientId,
          client_secret: clientSecret,
          code: url.searchParams.get("code") || "",
          code_verifier: verifier,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        });
        if (!tokens.refresh_token) throw new OAuthError("O Google não devolveu um refresh token.", "no_refresh");
        const email = emailFromIdToken(tokens.id_token);
        if (!email) throw new OAuthError("Não foi possível identificar o e-mail da conta.", "no_email");
        send(true, "Pode fechar esta aba e voltar ao MultiHub Chat.");
        finish(null, {
          email,
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
        });
      } catch (err) {
        send(false, "Falha ao concluir o login. Volte ao app para ver o motivo.");
        finish(err);
      }
    });

    const timer = setTimeout(() => finish(new OAuthError("Tempo esgotado esperando o login no navegador.", "timeout")), TIMEOUT);
    pending = { abort: (err) => finish(err) };

    server.on("error", (err) => finish(err));
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        access_type: "offline",
        prompt: "consent", // garante refresh_token mesmo em reconexões
        state,
      });
      if (loginHint) params.set("login_hint", loginHint);
      openExternal(`${AUTH_URL}?${params}`);
    });
  });
}

async function refresh({ clientId, clientSecret, refreshToken }) {
  const t = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return { accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000 };
}

async function tokenRequest(body) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new OAuthError("Sem conexão com o Google.", "network");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant = token revogado ou expirado (apps em modo "Teste" expiram em 7 dias)
    const code = data.error || `http_${res.status}`;
    const msg =
      code === "invalid_grant"
        ? "O acesso ao Google expirou ou foi revogado. Reconecte a conta."
        : code === "invalid_client"
        ? "Client ID ou Client secret do Google inválidos."
        : `Erro do Google (${code}).`;
    throw new OAuthError(msg, code);
  }
  return data;
}

// O id_token veio direto do endpoint de token via TLS: não precisa validar a assinatura (OIDC 3.1.3.7)
function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return payload.email_verified === false ? null : String(payload.email || "").toLowerCase() || null;
  } catch {
    return null;
  }
}

module.exports = { authorize, refresh, cancel, OAuthError };
