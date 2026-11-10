// Mede a camada determinística (fase 6a) contra os casos de teste.
// Uso: node email/test/run-triage-cases.js
// Com --llm, mede também o agente (regras + LLM + regra de ouro) usando a API configurada por variável:
//   MULTIHUB_ANTHROPIC_API_KEY=sk-ant-… node email/test/run-triage-cases.js --llm
//   MULTIHUB_OPENROUTER_API_KEY=sk-or-… node email/test/run-triage-cases.js --llm --openrouter   (gratuitos, restrito)
// ATENÇÃO: --llm chama a API de verdade (16 e-mails fictícios: alguns centavos no Claude).
const path = require("path");
const { analyze } = require("../service/triage/signals");
const { cases } = require(path.join(__dirname, "triage-cases.json"));

const RANK = { ok: 0, atencao: 1, suspeito: 2, perigoso: 3 };
let ok = 0;
const misses = [];
const byGroup = {};
for (const c of cases) {
  const headers = { ...(c.headers || {}) };
  if (c.auth) headers["authentication-results"] = ["mx.teste; " + c.auth];
  const r = analyze({ from: c.from, headers, links: c.links || [], attachments: c.attachments || [] });
  // Acerta se o nível bate, ou se é mais grave num golpe (errar para o lado seguro em golpe é aceitável)
  const hit = r.level === c.expected_level || (c.grupo === "golpe" && RANK[r.level] > RANK[c.expected_level]);
  const g = (byGroup[c.grupo] ||= { total: 0, ok: 0 });
  g.total++;
  if (hit) {
    ok++;
    g.ok++;
  } else misses.push(`${c.id}: esperado ${c.expected_level}, veio ${r.level} (${r.score}) ${r.signals.filter((s) => s.weight).map((s) => s.id).join(" ")}`);
  console.log(`${hit ? "OK   " : "FALHA"} ${c.id.padEnd(32)} ${r.level.padEnd(9)} ${String(r.score).padStart(3)}  ${r.signals.filter((s) => s.weight).map((s) => s.id).join(" ")}`);
}

// Métricas que importam para segurança
const isScam = (c) => c.grupo === "golpe" || c.grupo === "injecao";
const flagged = (c) => {
  const headers = { ...(c.headers || {}) };
  if (c.auth) headers["authentication-results"] = ["mx.teste; " + c.auth];
  return RANK[analyze({ from: c.from, headers, links: c.links || [], attachments: c.attachments || [] }).level] >= 2;
};
const scams = cases.filter(isScam);
const legit = cases.filter((c) => !isScam(c));
const caught = scams.filter(flagged).length;
const falseAlarm = legit.filter(flagged).length;
console.log(`\nAcertos de nível: ${ok}/${cases.length}`);
for (const [g, v] of Object.entries(byGroup)) console.log(`  ${g.padEnd(12)} ${v.ok}/${v.total}`);
console.log(`Golpes pegos só pelas regras (suspeito+): ${caught}/${scams.length}  (o resto fica para o LLM na fase 6b)`);
console.log(`Falsos alarmes em e-mails legítimos: ${falseAlarm}/${legit.length}  (meta: 0)`);
if (misses.length) console.log("\nDivergências:\n  " + misses.join("\n  "));
process.exitCode = falseAlarm > 0 ? 1 : 0;

if (process.argv.includes("--llm")) runLlm().catch((e) => {
  console.error("Falha:", e.message);
  process.exitCode = 1;
});

async function runLlm() {
  const { buildUserMessage, merge } = require("../service/triage/llm/prompt");
  const useOR = process.argv.includes("--openrouter");
  let provider;
  if (useOR) {
    const { createOpenRouterProvider } = require("../service/triage/llm/openrouter");
    let cache = null;
    provider = createOpenRouterProvider({ apiKey: process.env.MULTIHUB_OPENROUTER_API_KEY, mode: "free", getCache: () => cache, setCache: (v) => (cache = v), log: console.log });
  } else {
    const { createAnthropicProvider } = require("../service/triage/llm/anthropic");
    provider = createAnthropicProvider({ apiKey: process.env.MULTIHUB_ANTHROPIC_API_KEY });
  }
  console.log(`\n=== Agente (${useOR ? "OpenRouter gratuitos, modo restrito" : "Claude API"}) ===`);
  const CATS = ["importante", "notificacao", "promocao", "suspeito", "incerto"];
  const matrix = Object.fromEntries(CATS.map((c) => [c, Object.fromEntries(CATS.map((d) => [d, 0]))]));
  let cost = 0, okCount = 0, injOk = 0, injTotal = 0, hiddenImportant = 0, missedScam = 0;
  for (const c of cases) {
    const headers = { ...(c.headers || {}) };
    if (c.auth) headers["authentication-results"] = ["mx.teste; " + c.auth];
    const det = analyze({ from: c.from, headers, links: c.links || [], attachments: c.attachments || [] });
    const user = buildUserMessage({ from: c.from, subject: c.subject, text: c.text, links: c.links, attachments: c.attachments, det, preferences: "Clientes, contratos e pedidos são prioridade." }, { restricted: provider.restricted });
    try {
      const r = await provider.classify(user, det);
      const m = merge(det, r.result, c.from);
      cost += r.cost || 0;
      matrix[c.expected_category][m.category]++;
      const hit = m.category === c.expected_category;
      if (hit) okCount++;
      if (c.grupo === "injecao") { injTotal++; if (r.result.injection_detected && m.category === "suspeito") injOk++; }
      if (c.expected_category === "importante" && m.category === "suspeito") hiddenImportant++;
      if (c.expected_category === "suspeito" && m.category !== "suspeito") missedScam++;
      console.log(`${hit ? "OK   " : "FALHA"} ${c.id.padEnd(32)} ${m.category.padEnd(11)} conf ${String(r.result.confidence).padStart(3)} ${r.model}${r.escalated ? " (escalou)" : ""}`);
    } catch (err) {
      console.log(`ERRO  ${c.id.padEnd(32)} ${err.message}`);
    }
  }
  console.log(`\nCategoria correta: ${okCount}/${cases.length}`);
  console.log(`Golpes que escaparam da quarentena: ${missedScam}  (meta: 0)`);
  console.log(`Importantes escondidos na quarentena: ${hiddenImportant}  (meta: 0)`);
  console.log(`Injeções detectadas e contidas: ${injOk}/${injTotal}`);
  console.log(`Custo: US$ ${cost.toFixed(4)}`);
  console.log("\nMatriz (linha = esperado, coluna = obtido):");
  console.log("".padEnd(12) + CATS.map((c) => c.slice(0, 6).padStart(8)).join(""));
  for (const a of CATS) console.log(a.padEnd(12) + CATS.map((b) => String(matrix[a][b]).padStart(8)).join(""));
}
