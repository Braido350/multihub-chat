// Testa a organização da Caixa de entrada (grupos virtuais) num banco SQLite temporário, sem rede e sem LLM.
// Uso: node email/test/run-organize-cases.js        (Node 22.5+; o mesmo SQLite embutido do app)
//
// Cenários:
//  1. E-mails de exemplo de cada grupo (organize-cases.json), lidos e não lidos: cada um no grupo certo.
//  2. Aprendizado a partir do banco: com um histórico sintético, o modelo e a reputação classificam
//     mensagens novas que as regras sozinhas não decidiriam.
//  3. Ajustes manuais (mover, "sempre classificar"), filtros (Lidas, Não lidas, conversas), paginação,
//     idempotência e retomada depois de interromper.
process.removeAllListeners("warning");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../service/db");
const { Store } = require("../service/store");
const { createOrganizer } = require("../service/organize");

const data = require(path.join(__dirname, "organize-cases.json"));
let fails = 0;
let checks = 0;
const ok = (cond, label, extra) => {
  checks++;
  if (!cond) fails++;
  console.log(
    `${cond ? "OK   " : "FALHA"} ${label}${extra ? `  ${extra}` : ""}`,
  );
};

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-organize-"));
  return { store: new Store(db.open(dir)), dir };
}

function setupAccounts(store) {
  const acc = {};
  for (const a of data.accounts) {
    const id = store.insertAccount({
      $email: a.email,
      $name: a.name,
      $provider: "imap",
      $auth: "password",
      $username: a.email,
      $imap_host: "127.0.0.1",
      $imap_port: 993,
      $imap_secure: 1,
      $smtp_host: "127.0.0.1",
      $smtp_port: 465,
      $smtp_secure: 1,
      $secret: "x",
      $color: "#1f93ff",
      $signature: "",
      $auto_images: 0,
      $sender_name: "",
    });
    const folders = store.replaceFolders(id, [
      { path: "INBOX", name: "INBOX", role: "inbox" },
      { path: "Enviados", name: "Enviados", role: "sent" },
      { path: "Arquivo", name: "Arquivo", role: "archive" },
      { path: "Lixeira", name: "Lixeira", role: "trash" },
    ]);
    acc[a.key] = {
      id,
      email: a.email,
      folders: Object.fromEntries(folders.map((f) => [f.role, f.id])),
    };
  }
  return acc;
}

let uidSeq = 1;
let clock = Date.parse("2026-11-09T12:00:00Z");
/** Grava uma mensagem (e corpo, e análise de risco) como a sincronização faria. */
function addMessage(store, acc, c) {
  const a = acc[c.account];
  const folderId = a.folders[c.folder || "inbox"];
  const uid = uidSeq++;
  const messageId = `<${c.id}@teste>`;
  clock -= 60_000;
  store.upsertMessages([
    {
      $account_id: a.id,
      $folder_id: folderId,
      $uid: uid,
      $message_id: messageId,
      $in_reply_to: null,
      $refs: null,
      $thread_key: c.thread ? `m:${c.thread}` : `m:${messageId}`,
      $subject: c.subject || "",
      $from_name: (c.from && c.from.name) || "",
      $from_addr: ((c.from && c.from.address) || "").toLowerCase(),
      $to_json: JSON.stringify(
        (c.to || [a.email]).map((x) => ({ name: "", address: x })),
      ),
      $cc_json: JSON.stringify(
        (c.cc || []).map((x) => ({ name: "", address: x })),
      ),
      $reply_to_json: "[]",
      $date: c.date || clock,
      $size: 1000,
      $seen: c.seen ? 1 : 0,
      $flagged: c.flagged ? 1 : 0,
      $answered: c.answered ? 1 : 0,
      $draft: 0,
      $has_attachments: 0,
      $labels: null,
      $hdr:
        c.hdr === null || c.hdr === undefined ? null : JSON.stringify(c.hdr),
    },
  ]);
  const row = store.db
    .prepare("SELECT id FROM messages WHERE folder_id = ? AND uid = ?")
    .get(folderId, uid);
  if (c.text || c.html) {
    const links = [
      ...String(c.html || "").matchAll(/<a href='([^']+)'>([^<]*)<\/a>/g),
    ].map((m) => ({ href: m[1], text: m[2] }));
    store.saveBody({
      messageId: row.id,
      html: c.html || `<div>${c.text}</div>`,
      text: c.text || null,
      remoteImages: 0,
      attachments: [],
      headers: {},
      links,
      snippet: (c.text || "").slice(0, 200),
    });
  }
  if (c.risk) {
    store.saveTriage({
      accountId: a.id,
      key: messageId,
      status: "done",
      detScore: c.risk === "perigoso" ? 90 : 45,
      detLevel: c.risk,
      signals: [],
      pipeline: "teste",
    });
  }
  return row.id;
}

function addSent(store, acc, s) {
  addMessage(store, acc, {
    id: `sent-${uidSeq}`,
    account: s.account,
    folder: "sent",
    from: { name: "Eu", address: acc[s.account].email },
    to: s.to,
    subject: s.subject,
    thread: s.thread,
    seen: 1,
    hdr: {},
  });
}

const ALL = {
  importante: 500,
  propaganda: 500,
  outros: 500,
  suspeito: 500,
  lidos: 500,
};
function placement(store, opts = {}) {
  const r = store.listInbox({
    mode: "all",
    threads: false,
    limits: ALL,
    ...opts,
  });
  const where = new Map();
  for (const [g, v] of Object.entries(r.groups))
    for (const m of v.items)
      where.set(m.subject, { group: g, tag: m.grp, id: m.id });
  return { where, groups: r.groups };
}

function newOrganizer(store) {
  return createOrganizer({
    store,
    emit: () => {},
    log: (...a) => console.log("   [log]", ...a),
    listWorkers: () => [],
  });
}

(async () => {
  // ================= 1. E-mails de exemplo de cada grupo =================
  console.log("=== 1. Exemplos de cada grupo (lidos e não lidos) ===");
  {
    const { store } = freshStore();
    const acc = setupAccounts(store);
    for (const s of data.sent) addSent(store, acc, s);
    for (const c of data.cases) addMessage(store, acc, c);
    const org = newOrganizer(store);
    await org.runNow();
    const { where } = placement(store);
    for (const c of data.cases) {
      const got = where.get(c.subject) || {};
      const cls =
        store.listClassifications({ q: c.subject, limit: 1 })[0] || {};
      const hit =
        got.group === c.expect.group &&
        (!c.expect.tag || got.tag === c.expect.tag);
      ok(
        hit,
        c.id.padEnd(30),
        `→ ${got.group}${c.expect.group === "lidos" ? ` [${got.tag}]` : ""} · ${cls.source} ${cls.confidence}% · ${cls.reason}`,
      );
    }

    // Filtro "Lidas": só as lidas, ainda separadas por categoria
    const read = store.listInbox({
      mode: "read",
      threads: false,
      limits: ALL,
    }).groups;
    ok(
      read.propaganda.items.some((m) => m.subject.startsWith("Newsletter")) &&
        read.importante.items.some((m) => m.subject.startsWith("Dúvida")) &&
        !read.lidos.count,
      "Filtro Lidas separa as lidas por categoria",
      `imp ${read.importante.count} · prop ${read.propaganda.count} · out ${read.outros.count} · susp ${read.suspeito.count}`,
    );
    const unread = store.listInbox({
      mode: "unread",
      threads: false,
      limits: ALL,
    }).groups;
    ok(
      !unread.lidos.count && unread.importante.count === 4,
      "Filtro Não lidas esconde Já lidos",
      `imp ${unread.importante.count}`,
    );

    // Ler não muda o grupo: a mensagem lida continua na categoria
    const before = where.get("Últimas vagas com desconto especial");
    store.setSeenLocal(store.messagesByIds([before.id]), true);
    await org.runNow();
    const after = placement(store).where.get(
      "Últimas vagas com desconto especial",
    );
    ok(
      after.group === "propaganda" && !placement(store).groups?.lidos?.count,
      "Ao ler, continua em Propaganda",
      `${after.group}`,
    );
    store.setSeenLocal(store.messagesByIds([before.id]), false);
    await org.runNow();
    ok(
      placement(store).where.get("Últimas vagas com desconto especial")
        .group === "propaganda",
      "Ao marcar como não lida, continua em Propaganda",
    );

    // Idempotente: rodar de novo não refaz nada nem muda o modelo
    const st1 = org.status();
    await org.runNow();
    const st2 = org.status();
    ok(
      st2.progress.total === 0 &&
        JSON.stringify(st1.model) === JSON.stringify(st2.model),
      "Rodar de novo não refaz nada (idempotente)",
      `pendentes ${st2.progress.total}`,
    );
  }

  // ================= 2. Aprendizado a partir do banco =================
  console.log(
    "\n=== 2. Aprendizado a partir do banco (reputação e modelo) ===",
  );
  {
    const { store, dir } = freshStore();
    const acc = setupAccounts(store);
    const pick = (arr, i) => arr[i % arr.length];
    const PROMO_WORDS = [
      "coleção nova",
      "lançamento",
      "aproveite o cupom",
      "desconto especial",
      "frete grátis",
      "oferta da semana",
      "liquidação",
      "promoção relâmpago",
    ];
    const PROMO_BODY =
      "Confira a nova coleção com preços incríveis. Aproveite o cupom de desconto na loja e garanta já o seu. Ofertas por tempo limitado, compre agora e ganhe frete grátis.";
    const WORK_BODY =
      "Prezado Fulano, segue o contrato revisado para assinatura. Precisamos alinhar o prazo do projeto e o cronograma de entrega com a equipe do cliente. Aguardo seu retorno sobre a proposta.";
    const NOTIF_BODY =
      "Seu pedido foi aprovado. A nota fiscal está disponível e o rastreamento da entrega será enviado por e-mail. Este é um aviso automático, não responda.";
    for (let i = 0; i < 40; i++) {
      // Lojas diferentes, todas com cabeçalhos de lista: as regras rotulam como Propaganda (rótulo fraco)
      addMessage(store, acc, {
        id: `hist-prop-${i}`,
        account: "pessoal",
        from: { name: `Loja ${i}`, address: `contato@loja${i}.com.br` },
        subject: `${pick(PROMO_WORDS, i)} na Loja ${i}`,
        text: PROMO_BODY,
        seen: i % 3 ? 1 : 0,
        hdr: {
          "list-unsubscribe": "<https://x/unsub>",
          "list-id": `<loja${i}>`,
          "return-path": "mcsv.net",
        },
      });
      // Conversas de trabalho que você respondeu: rótulo fraco Importante
      addMessage(store, acc, {
        id: `hist-imp-${i}`,
        account: "publica",
        from: { name: `Cliente ${i}`, address: `diretoria@cliente${i}.com.br` },
        subject: `Contrato e prazo do projeto ${i}`,
        text: WORK_BODY,
        seen: 1,
        answered: 1,
        hdr: {},
      });
      // Avisos automáticos: rótulo fraco Outros
      addMessage(store, acc, {
        id: `hist-out-${i}`,
        account: "pessoal",
        from: { name: `Serviço ${i}`, address: `noreply@servico${i}.com.br` },
        subject: `Pedido ${1000 + i} aprovado - nota fiscal`,
        text: NOTIF_BODY,
        seen: 1,
        hdr: { "auto-submitted": "auto-generated" },
      });
    }
    // Remetente que você sempre apaga sem abrir
    for (let i = 0; i < 4; i++) {
      addMessage(store, acc, {
        id: `ignorado-${i}`,
        account: "pessoal",
        folder: "trash",
        from: { name: "Clube de Vantagens", address: "clube@vantagens.com.br" },
        subject: `Oferta imperdível ${i}: desconto`,
        seen: 0,
        hdr: {
          "list-unsubscribe": "<https://x>",
          "return-path": "sendgrid.net",
        },
      });
    }
    // Mensagens novas que as regras sozinhas NÃO decidem (sem cabeçalhos, remetentes desconhecidos)
    const novos = [
      {
        id: "novo-loja-desconhecida",
        account: "pessoal",
        from: { name: "Ateliê Bela", address: "atendimento@ateliebela.com.br" },
        subject: "Chegou a coleção nova",
        text: PROMO_BODY,
        hdr: null,
        expect: "propaganda",
        by: "modelo",
      },
      {
        id: "novo-cliente-desconhecido",
        account: "publica",
        from: {
          name: "Fernanda Rocha",
          address: "fernanda@empresanova.com.br",
        },
        subject: "Contrato do projeto",
        text: WORK_BODY,
        hdr: null,
        expect: "importante",
        by: "modelo",
      },
      {
        id: "novo-aviso-desconhecido",
        account: "pessoal",
        from: { name: "Loja Virtual", address: "pedidos@lojavirtual.com.br" },
        subject: "Pedido 2024 aprovado",
        text: NOTIF_BODY,
        hdr: null,
        expect: "outros",
      },
      {
        id: "novo-do-ignorado",
        account: "pessoal",
        from: { name: "Clube de Vantagens", address: "clube@vantagens.com.br" },
        subject: "Novidades para você",
        hdr: null,
        expect: "propaganda",
        by: "reputacao",
      },
    ];
    for (const c of novos) addMessage(store, acc, c);

    const org = newOrganizer(store);
    const t0 = Date.now();
    await org.runNow();
    const st = org.status();
    console.log(
      `   processo: ${Date.now() - t0} ms · modelo ${st.model.ready ? "pronto" : "não pronto"} ${JSON.stringify(st.model.docs)} · ${st.model.vocabulary} palavras · atalhos ${st.shortcuts}`,
    );
    console.log(
      `   origem das decisões (Caixa de entrada): ${JSON.stringify(st.stats.bySource)}`,
    );
    ok(st.model.ready, "Modelo treinado com os rótulos fracos do banco");
    const { where } = placement(store);
    for (const c of novos) {
      const got = where.get(c.subject) || {};
      const cls =
        store.listClassifications({ q: c.subject, limit: 1 })[0] || {};
      ok(
        got.group === c.expect && (!c.by || cls.source === c.by),
        c.id.padEnd(30),
        `→ ${got.group} · ${cls.source} ${cls.confidence}% · ${cls.reason}`,
      );
    }

    // Retomada: um processo novo (como depois de fechar o app) continua de onde parou
    store.db.exec("UPDATE inbox_class SET version = 0 WHERE id % 2 = 0");
    const org2 = newOrganizer(store);
    await org2.runNow();
    const again = placement(store).where;
    ok(
      novos.every((c) => (again.get(c.subject) || {}).group === c.expect),
      "Retoma depois de interromper (processo novo, mesmo banco)",
      novos
        .map((c) => `${c.id}=${(again.get(c.subject) || {}).group}`)
        .join(" "),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ================= 3. Ajustes manuais, conversas, paginação =================
  console.log("\n=== 3. Ajustes manuais, conversas e paginação ===");
  {
    const { store } = freshStore();
    const acc = setupAccounts(store);
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        addMessage(store, acc, {
          id: `promo-amigo-${i}`,
          account: "pessoal",
          from: { name: "Clube do Livro", address: "news@clubedolivro.com.br" },
          subject: `Promoção ${i}: livros com desconto`,
          hdr: { "list-unsubscribe": "<https://x>", "return-path": "mcsv.net" },
        }),
      );
    }
    const org = newOrganizer(store);
    await org.runNow();
    ok(
      placement(store).where.get("Promoção 0: livros com desconto").group ===
        "propaganda",
      "Antes: Propaganda pelas regras",
    );

    // Mover (arrastar ou "Mover para") muda só o grupo no app
    org.setCategory([ids[0]], "importante", false);
    let w = placement(store).where;
    ok(
      w.get("Promoção 0: livros com desconto").group === "importante",
      "Mover para Importante",
      w.get("Promoção 1: livros com desconto").group,
    );
    org.setCategory([ids[1]], "importante", false);
    w = placement(store).where;
    const c2 = store.listClassifications({ q: "Promoção 2", limit: 1 })[0];
    ok(
      w.get("Promoção 2: livros com desconto").group === "importante" &&
        c2.source === "reputacao",
      "Dois movimentos coerentes viram atalho para o remetente",
      `${c2.source}: ${c2.reason}`,
    );
    org.setCategory([ids[0]], null, false); // desfazer
    ok(
      store.listClassifications({ q: "Promoção 0", limit: 1 })[0].source !==
        "manual",
      "Desfazer volta ao automático",
    );

    // "Sempre classificar este remetente como"
    const other = addMessage(store, acc, {
      id: "fornecedor",
      account: "publica",
      from: { name: "Fornecedor", address: "vendas@fornecedorx.com.br" },
      subject: "Catálogo atualizado",
      hdr: null,
    });
    await org.runNow();
    org.setSenderRule("@fornecedorx.com.br", "importante");
    const cr = store.listClassifications({ q: "Catálogo", limit: 1 })[0];
    ok(
      placement(store).where.get("Catálogo atualizado").group ===
        "importante" && cr.source === "remetente",
      "Regra de remetente por domínio",
      cr.reason,
    );
    org.setSenderRule("@fornecedorx.com.br", null);
    ok(
      store.listClassifications({ q: "Catálogo", limit: 1 })[0].source !==
        "remetente",
      "Remover a regra volta ao automático",
    );
    void other;

    // Conversas: uma linha por conversa, no grupo da categoria
    const t1 = addMessage(store, acc, {
      id: "conv-1",
      account: "publica",
      from: { name: "Ana", address: "ana@empresa.example" },
      subject: "Conversa A",
      thread: "conv",
      seen: 1,
      hdr: {},
    });
    addMessage(store, acc, {
      id: "conv-2",
      account: "publica",
      from: { name: "Ana", address: "ana@empresa.example" },
      subject: "Re: Conversa A",
      thread: "conv",
      seen: 0,
      hdr: {},
    });
    await org.runNow();
    const th = store.listInbox({
      mode: "all",
      threads: true,
      limits: ALL,
    }).groups;
    const inLidos = th.lidos.items.some((m) => m.thread_key === "m:conv");
    const inGroup = ["importante", "outros", "propaganda"].some((g) =>
      th[g].items.some(
        (m) => m.thread_key === "m:conv" && m.thread_count === 2,
      ),
    );
    ok(
      !inLidos && inGroup,
      "Conversa com mensagem não lida fica no grupo (uma linha, 2 mensagens)",
    );
    void t1;

    // Paginação no banco ("Mostrar mais")
    for (let i = 0; i < 25; i++)
      addMessage(store, acc, {
        id: `velha-${i}`,
        account: "pessoal",
        from: { name: "X", address: `x${i}@exemplo.com` },
        subject: `Lida ${i}`,
        seen: 1,
        hdr: null,
      });
    await org.runNow();
    const first = store.listInbox({
      mode: "all",
      threads: false,
      limits: { outros: 10 },
    }).groups.outros;
    const last = first.items[first.items.length - 1];
    const page2 = store.listInboxGroup({
      mode: "all",
      threads: false,
      group: "outros",
      cursor: { date: last.date, id: last.id },
      limit: 10,
    });
    const overlap = page2.items.some((m) =>
      first.items.some((x) => x.id === m.id),
    );
    ok(
      first.items.length === 10 &&
        first.hasMore &&
        page2.items.length === 10 &&
        !overlap &&
        page2.items[0].date <= last.date,
      "Mostrar mais pagina no banco, do mais recente para o mais antigo",
      `total ${first.count}`,
    );
  }

  console.log(`\n${checks - fails}/${checks} verificações OK`);
  process.exitCode = fails ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
