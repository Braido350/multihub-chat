// Testes dos Prioritários (feedback Importante / Não importante e pontuação de relevância), sem rede.
// Uso: node email/test/run-priority-cases.js
//  1. Sem feedback: regra padrão (o filtro não fica vazio; propaganda e suspeitos ficam fora).
//  2. Feedback grava id, remetente, domínio, assunto, tópicos, vetor, rótulo e data; desfazer apaga.
//  3. Aprende remetente, domínio, tópicos e vizinhos; feedbacks recentes pesam mais.
//  4. Casos ambíguos vão para o LLM com o perfil resumido (nunca o histórico); o filtro respeita o limiar.
//  5. Ajuste manual (+10/-10): 60 vira 70, limite de 100, desfazer, ajuste preservado no recálculo.
//  6. Atividade no e-mail: pontos, motivo com a origem, uma vez por ação, queda por idade e aprendizado.
process.removeAllListeners("warning");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../service/db");
const { Store } = require("../service/store");
const { createOrganizer } = require("../service/organize");
const { createPriority, embed, cos, buildModel, scoreMessage } = require("../service/organize/priority");

let fails = 0;
let checks = 0;
const ok = (cond, label, extra) => {
  checks++;
  if (!cond) fails++;
  console.log(`${cond ? "OK   " : "FALHA"} ${label}${extra ? `  ${extra}` : ""}`);
};

const store = new Store(db.open(fs.mkdtempSync(path.join(os.tmpdir(), "mh-priority-"))));
const accId = store.insertAccount({
  $email: "eu@empresa.com.br", $name: "Eu", $provider: "imap", $auth: "password", $username: "eu",
  $imap_host: "x", $imap_port: 993, $imap_secure: 1, $smtp_host: "x", $smtp_port: 465, $smtp_secure: 1,
  $secret: "x", $color: "#1f93ff", $signature: "", $auto_images: 0, $sender_name: "",
});
const [inbox] = store.replaceFolders(accId, [{ path: "INBOX", name: "INBOX", role: "inbox" }]);
let uid = 1;
let clock = Date.now() - 60_000;
function add({ from, subject, text, hdr = {}, seen = 0, answered = 0, ageDays = 0 }) {
  const id = `<p${uid}@t>`;
  clock -= 60_000;
  store.upsertMessages([{
    $account_id: accId, $folder_id: inbox.id, $uid: uid++, $message_id: id, $in_reply_to: null, $refs: null, $thread_key: `m:${id}`,
    $subject: subject, $from_name: from.split("@")[0], $from_addr: from, $to_json: '[{"address":"eu@empresa.com.br"}]', $cc_json: "[]",
    $reply_to_json: "[]", $date: clock - ageDays * 864e5, $size: 1000, $seen: seen, $flagged: 0, $answered: answered, $draft: 0,
    $has_attachments: 0, $labels: null, $hdr: JSON.stringify(hdr),
  }]);
  const row = store.db.prepare("SELECT id FROM messages WHERE message_id = ?").get(id);
  store.saveBody({ messageId: row.id, html: `<p>${text}</p>`, text, remoteImages: 0, attachments: [], headers: {}, links: [], snippet: text.slice(0, 160) });
  return row.id;
}

const llmCalls = [];
const fakeLlm = {
  provider: async () => ({ ask: true }),
  askPriority: async (p) => {
    llmCalls.push(p);
    return { prioritario: /licita/i.test(p.email.assunto), confianca: 90, motivo: "Teste" };
  },
};
const promo = { "list-unsubscribe": "<https://x/u>" };

(async () => {
  const org = createOrganizer({ store, emit: () => {}, log: () => {}, listWorkers: () => [] });
  const pr = createPriority({ store, llm: null, emit: () => {}, log: () => {} });
  const score = (id) => store.getPriorityScore(accId, store.priorityMessage(id).msg_key);

  // ---------- 1. Sem feedback ----------
  console.log("=== 1. Sem feedback: regra padrão ===");
  const cliente = add({ from: "joao@cliente.com.br", subject: "Re: proposta do contrato de manutenção", text: "Segue a proposta revisada do contrato de manutenção, preciso da sua resposta até sexta.", answered: 1 });
  const loja = add({ from: "ofertas@loja.com.br", subject: "Só hoje: 50% de desconto", text: "Aproveite a liquidação com frete grátis. Cupom exclusivo.", hdr: { ...promo, "return-path": "mcsv.net" } });
  const aviso = add({ from: "noreply@sistema.com.br", subject: "Seu relatório semanal", text: "O relatório semanal do sistema está disponível.", hdr: { "auto-submitted": "auto-generated" } });
  await org.runNow();
  await pr.runNow();
  ok(score(cliente).score >= 60, "Cliente que você respondeu é prioritário sem feedback", `${score(cliente).score} · ${score(cliente).reason}`);
  ok(score(loja).score < 60, "Propaganda não é prioritária", `${score(loja).score}`);
  const prio0 = store.listMessages({ role: "inbox", threads: false, priority: 60, limit: 50 });
  ok(prio0.length >= 1 && prio0.every((m) => m.pscore >= 60 && m.preason), "Filtro Prioritários não fica vazio e traz o motivo", `${prio0.length} mensagem(ns)`);

  // ---------- 2. Gravar e desfazer ----------
  console.log("\n=== 2. Feedback: gravar e desfazer ===");
  let r = pr.feedback(aviso, 1);
  const f = store.getPriorityFeedback(accId, store.priorityMessage(aviso).msg_key);
  ok(f && f.label === 1 && f.from_addr === "noreply@sistema.com.br" && f.domain === "sistema.com.br" && f.subject && JSON.parse(f.topics).includes("relatorio") && f.embedding.length === 1024 && f.created_at,
    "Grava remetente, domínio, assunto, tópicos, vetor, rótulo e data", JSON.parse(f.topics).join(","));
  ok(r.label === 1 && r.manual === 10 && r.score === Math.min(100, r.base + 10), "A própria mensagem ganha +10 na hora (não vai a 100)", `${r.base} → ${r.score}`);
  r = pr.feedback(aviso, 0);
  ok(r.label === 0 && !store.getPriorityFeedback(accId, store.priorityMessage(aviso).msg_key), "Clicar de novo desfaz (apaga o feedback)");
  await pr.runNow();
  ok(score(aviso).source !== "feedback", "Depois de desfazer volta a ser calculada", `${score(aviso).score} · ${score(aviso).source}`);

  // ---------- 3. Aprendizado ----------
  console.log("\n=== 3. Aprendizado ===");
  const lic = [];
  for (let i = 0; i < 4; i++) lic.push(add({ from: `compras${i}@prefeitura${i}.gov.br`, subject: `Licitação ${100 + i}: edital de pregão eletrônico`, text: "Edital do pregão eletrônico para licitação de serviços. Prazo de propostas e documentos de habilitação." , hdr: promo }));
  const news = [];
  for (let i = 0; i < 4; i++) news.push(add({ from: `contato@empresa${i}.com.br`, subject: `Novidades da semana ${i}`, text: "Confira as novidades do blog e os eventos da semana na nossa comunidade." }));
  for (const id of lic.slice(0, 3)) pr.feedback(id, 1);
  for (const id of news.slice(0, 3)) pr.feedback(id, -1);
  for (let i = 0; i < 3; i++) pr.feedback(add({ from: "ofertas@loja.com.br", subject: `Cupom ${i}`, text: "Desconto e frete grátis." , hdr: promo }), -1);
  await pr.runNow();
  ok(score(lic[3]).score >= 60, "Licitação nova (outro remetente, mesmo assunto) sobe por tópicos e vizinhos", `${score(lic[3]).score} · ${score(lic[3]).reason}`);
  ok(score(news[3]).score < 50, "Novidades parecidas com as rejeitadas descem", `${score(news[3]).score} · ${score(news[3]).reason}`);
  ok(/remetente/.test(score(loja).reason) && score(loja).score < 20, "Remetente rejeitado pesa", `${score(loja).score} · ${score(loja).reason}`);
  const s1 = embed("Licitação edital pregão", "pregão eletrônico licitação");
  ok(cos(s1, embed("Edital de licitação", "licitação pregão")) > cos(s1, embed("Novidades do blog", "eventos da semana")), "Vetor do conteúdo aproxima assuntos parecidos");

  // Recentes pesam mais: o mesmo remetente marcado importante há 1 ano e não importante hoje
  const velho = add({ from: "ana@parceiro.com.br", subject: "Reunião", text: "Vamos marcar a reunião.", ageDays: 0 });
  pr.feedback(velho, 1);
  store.db.prepare("UPDATE priority_feedback SET created_at = ? WHERE message_id = ?").run(Date.now() - 365 * 864e5, velho);
  pr.feedback(add({ from: "ana@parceiro.com.br", subject: "Convite", text: "Convite para o evento." }), -1);
  const ana = add({ from: "ana@parceiro.com.br", subject: "Lembrete", text: "Lembrete do evento." });
  await pr.runNow();
  ok(score(ana).score < 50, "Feedback recente vale mais que o antigo", `${score(ana).score} · ${score(ana).reason}`);

  // ---------- 4. LLM nos ambíguos e limiar ----------
  console.log("\n=== 4. LLM só nos ambíguos, com perfil resumido ===");
  const pr2 = createPriority({ store, llm: () => fakeLlm, emit: () => {}, log: () => {} });
  // Limiar 45: os avisos automáticos (40) e alguns aprendidos ficam perto dele (ambíguos)
  store.setSetting("priority_config", JSON.stringify({ threshold: 45, llm: true }));
  await pr2.runNow();
  const asked = llmCalls.length;
  const all = store.db.prepare("SELECT score, source FROM priority_score").all();
  const amb = all.filter((x) => x.source === "llm").length;
  ok(asked > 0 && asked < all.length, "LLM consultado só em parte (casos ambíguos)", `${asked} de ${all.length}`);
  const p0 = llmCalls[0] || {};
  ok(p0.profile && Array.isArray(p0.profile.topicos_aprovados) && p0.profile.exemplos_importantes.length <= 3 && !("historico" in p0.profile) && JSON.stringify(p0).length < 4000,
    "Vai só o perfil resumido (remetentes, tópicos e até 3 exemplos)", `${JSON.stringify(p0.profile).length} caracteres`);
  ok(amb === asked, "Resposta do LLM fica registrada com o motivo");
  await pr2.runNow();
  ok(llmCalls.length === asked, "Não pergunta de novo sobre o mesmo e-mail");
  pr2.setConfig({ threshold: 90 });
  await pr2.runNow();
  const hi = store.listMessages({ role: "inbox", threads: false, priority: 90, limit: 100 });
  const lo = store.listMessages({ role: "inbox", threads: false, priority: 30, limit: 100 });
  ok(hi.length < lo.length && hi.every((m) => m.pscore >= 90), "Limiar ajustável muda o filtro", `limiar 90: ${hi.length} · limiar 30: ${lo.length}`);
  // Modelos gratuitos: só não lidas que chegaram depois da chave
  const freeCalls = [];
  const freeLlm = { provider: async () => ({ ask: true, restricted: true }), freeSince: async () => Date.now() - 2 * 60_000,
    askPriority: async (p) => (freeCalls.push(p), { prioritario: true, confianca: 80, motivo: "Teste" }) };
  store.db.exec("UPDATE priority_score SET llm_verdict = NULL, llm_reason = NULL, llm_at = NULL");
  store.setSetting("priority_config", JSON.stringify({ threshold: 45, llm: true }));
  const prFree = createPriority({ store, llm: () => freeLlm, emit: () => {}, log: () => {} });
  await prFree.runNow();
  const keyAt = Date.now() - 2 * 60_000;
  const bad = freeCalls.filter((c) => { const m = store.db.prepare("SELECT seen, date FROM messages WHERE subject = ?").get(c.email.assunto); return m.seen || m.date < keyAt; });
  ok(bad.length === 0, "Gratuitos: nada lido nem anterior à chave vai para o LLM", `${freeCalls.length} consulta(s), ${bad.length} fora da regra`);

  // ---------- 5. Ajuste manual ----------
  console.log("\n=== 5. Ajuste manual (+10 / -10) ===");
  const now = Date.now();
  // Nota calculada 60: categoria Outros (40) com a opinião do LLM 73 → 0,4·40 + 0,6·73 = 60
  const m60 = { account_id: 1, msg_key: "<m60@t>", subject: "Assunto", from_addr: "x@y.com", grp: "outros", risk: 0, date: now, llm_verdict: 73, llm_reason: "teste" };
  const fbRow = (label) => ({ account_id: 1, msg_key: "<m60@t>", from_addr: "x@y.com", domain: "y.com", topics: "[]", embedding: null, label, adjust: label * 10, created_at: now });
  const q0 = scoreMessage(buildModel([], []), m60, 60, now);
  const q1 = scoreMessage(buildModel([fbRow(1)], []), m60, 60, now);
  ok(q0.score === 60 && q1.score === 70 && q1.base === 60 && q1.manual === 10, "60 vira 70 com ★ Importante", `${q0.score} → ${q1.score}`);
  const sNeg = scoreMessage(buildModel([fbRow(-1)], []), m60, 60, now);
  ok(sNeg.score === 50, "Não importante tira 10 (60 vira 50)", `${sNeg.score}`);
  ok(/^\+10 marcado importante/.test(q1.reason), "Motivo mostra a origem dos pontos", q1.reason);
  const m95 = { ...m60, llm_verdict: 100, grp: "importante", answered: 1 };
  const s95 = scoreMessage(buildModel([fbRow(1)], []), m95, 60, now);
  ok(s95.score === 100 && s95.base + s95.manual + s95.activity > 100, "Limite de 100", `${s95.base} + ${s95.manual} + ${s95.activity} → ${s95.score}`);
  const s0b = scoreMessage(buildModel([fbRow(-1)], []), { ...m60, llm_verdict: 0, grp: "propaganda" }, 60, now);
  ok(s0b.score === 0 && s0b.base < 10, "Limite de 0", `${s0b.base} - 10 → ${s0b.score}`);

  const alvo = add({ from: "beto@fornecedor.com.br", subject: "Cotação de materiais", text: "Segue a cotação de materiais pedida." });
  await pr2.runNow();
  const antes = store.getPriorityScore(accId, store.priorityMessage(alvo).msg_key);
  r = pr2.feedback(alvo, 1);
  ok(r.score === Math.min(100, antes.score + 10) && r.base === antes.base, "Clique soma 10 à nota atual", `${antes.score} → ${r.score}`);
  await pr2.runNow();
  await pr2.runNow();
  const depois = pr2.get(alvo);
  ok(depois.score === r.score && depois.manual === 10 && depois.base === antes.base, "Ajuste preservado no recálculo (gravado à parte)", `base ${depois.base} + manual ${depois.manual} = ${depois.score}`);
  r = pr2.feedback(alvo, 0);
  ok(r.label === 0 && r.manual === 0 && r.score === antes.score, "Clicar de novo desfaz o ajuste", `${r.score}`);

  // ---------- 6. Atividade ----------
  console.log("\n=== 6. Atividade no e-mail ===");
  const act = add({ from: "carla@obra.com.br", subject: "Medição da obra", text: "Segue a planilha de medição da obra." });
  await pr2.runNow();
  const a0 = pr2.get(act);
  pr2.activity(act, "open");
  pr2.activity(act, "read");
  pr2.activity(act, "reply");
  pr2.activity(act, "forward");
  pr2.activity(act, "flag");
  pr2.activity(act, "attachment");
  r = pr2.activity(act, "link");
  ok(r.activity === 2 + 3 + 8 + 6 + 5 + 4 + 3 && r.score === Math.min(100, r.base + r.activity), "Abrir +2, ler +3, responder +8, encaminhar +6, favoritar +5, anexo +4, link +3", `atividade ${r.activity} · ${a0.score} → ${r.score}`);
  ok(/\+8 respondido/.test(r.reason) && /\+6 encaminhado/.test(r.reason) && /\+2 aberto/.test(r.reason), "Motivo lista cada ação", r.reason.slice(0, 120));
  pr2.activity(act, "open");
  ok(pr2.get(act).activity === 31, "A mesma ação conta uma vez por e-mail");
  pr2.activity(act, "flag", false);
  ok(pr2.get(act).activity === 26, "Tirar dos favoritos desfaz os +5");
  const n1 = add({ from: "spam@lixo.com.br", subject: "Oferta", text: "Oferta." });
  const n2 = add({ from: "spam@lixo.com.br", subject: "Aviso", text: "Aviso." });
  await pr2.runNow();
  const b1 = pr2.get(n1).score;
  const b2 = pr2.get(n2).score;
  const dl = pr2.activity(n1, "delete_unopened");
  ok(dl.activity === -8 && dl.score === Math.max(0, b1 - 8), "Excluir sem abrir: -8", `${b1} → ${dl.score}`);
  const ar = pr2.activity(n2, "archive_unread");
  ok(ar.activity === -4 && /-4 arquivado sem ler/.test(ar.reason), "Arquivar sem ler: -4", `${b2} → ${ar.score} (${ar.reason.slice(0, 60)})`);
  const acts = store.listPriorityActivity().filter((x) => x.message_id === act);
  ok(acts.length === 6 && acts.every((x) => x.created_at && x.from_addr === "carla@obra.com.br" && x.points), "Cada ação gravada com data, pontos e remetente", `${acts.length} ações`);
  // Queda por idade: uma resposta de 45 dias vale metade
  store.db.prepare("UPDATE priority_activity SET created_at = ? WHERE message_id = ? AND action = 'reply'").run(Date.now() - 45 * 864e5, act);
  pr2.activity(act, "flag");
  ok(/\+4 respondido/.test(pr2.get(act).reason), "Ação de 45 dias vale metade (+8 vira +4)", pr2.get(act).reason.slice(0, 80));
  // Aprendizado: atividade ensina o remetente, com peso menor que o clique explícito
  const novoCarla = add({ from: "carla@obra.com.br", subject: "Cronograma", text: "Cronograma atualizado." });
  const novoBeto = add({ from: "dani@outra.com.br", subject: "Cronograma", text: "Cronograma atualizado." });
  await pr2.runNow();
  const ga = pr2.get(novoCarla);
  const gb = pr2.get(novoBeto);
  ok(ga.base > gb.base && ga.base < 75 && /remetente/.test(ga.reason), "Atividade ensina o remetente", `carla ${ga.base} · outro ${gb.base} · ${ga.reason.slice(0, 90)}`);
  const exp = add({ from: "edu@obra2.com.br", subject: "Boleto de condomínio", text: "Boleto de condomínio de março." });
  const expNovo = add({ from: "edu@obra2.com.br", subject: "Ata da assembleia", text: "Ata da assembleia geral." });
  const actOnly = add({ from: "fabi@obra3.com.br", subject: "Fotos do jardim", text: "Fotos do jardim novo." });
  const actNovo = add({ from: "fabi@obra3.com.br", subject: "Convite de aniversário", text: "Convite para o aniversário." });
  pr2.feedback(exp, 1);
  pr2.activity(actOnly, "open");
  await pr2.runNow();
  ok(pr2.get(expNovo).base > pr2.get(actNovo).base, "Clique explícito ensina mais que uma ação", `explícito ${pr2.get(expNovo).base} · abrir ${pr2.get(actNovo).base}`);

  const st = pr2.status();
  ok(st.counts.pos > 0 && st.counts.neg > 0 && st.profile.remetentes_nao_importantes.includes("ofertas@loja.com.br"), "Status e perfil atualizados a cada feedback");

  console.log(`\n${checks - fails}/${checks} verificações OK`);
  process.exitCode = fails ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
