// Configurações › E-mail: tudo o que antes ficava espalhado pela aba de E-mail (contas, a engrenagem da
// Triagem, "Editar conta"). A aba de E-mail fica só com o uso do dia a dia.
"use strict";
(() => {
  const S = window.Settings;
  const {
    h,
    go,
    toast,
    showDialog,
    closeDialog,
    confirmDialog,
    toggle,
    actionButton,
    fmtNum,
    when,
  } = S;
  const $ = S.$;
  const api = window.mail;

  const COLORS = [
    "#1f93ff",
    "#f5a524",
    "#17c964",
    "#f31260",
    "#9353d3",
    "#06b7db",
    "#ff7a45",
    "#8a94a0",
  ];
  const PROVIDER = { gmail: "Gmail", locaweb: "Locaweb", imap: "IMAP/SMTP" };
  const STATUS = {
    connecting: ["⟳", "Conectando…"],
    syncing: ["⟳", "Sincronizando…"],
    idle: ["✓", "Sincronizada"],
    offline: ["●", "Sem conexão"],
    error: ["●", "Erro na sincronização"],
    auth: ["!", "Login necessário"],
  };
  const GROUP = {
    importante: "Importante",
    propaganda: "Propaganda",
    outros: "Outros",
    suspeito: "Suspeitos",
    lidos: "Já lidos",
  };
  const SOURCE = {
    manual: "Você (mover ou arrastar)",
    remetente: "Regras de remetente",
    reputacao: "Reputação do remetente",
    regra: "Regras",
    modelo: "Modelo estatístico",
    padrao: "Na dúvida → Outros",
    pendente: "Aguardando análise",
  };

  // ---------- Estado compartilhado ----------
  let state = {
    accounts: [],
    crypto: { available: true },
    google: { configured: false },
  };
  const loadState = async () => (state = await api.call("getState"));
  const accountById = (id) => state.accounts.find((a) => a.id === id);
  const listeners = new Set();
  const notify = (kind, data) => listeners.forEach((fn) => fn(kind, data));
  const listen = (fn) => (listeners.add(fn), () => listeners.delete(fn));
  api.on("accounts-changed", async () => {
    await loadState().catch(() => {});
    notify("accounts");
  });
  api.on("account-status", ({ id, status, error }) => {
    const a = accountById(id);
    if (a)
      Object.assign(a, {
        status,
        error,
        last_sync_at: status === "idle" ? Date.now() : a.last_sync_at,
      });
    notify("status");
  });
  api.on("organize-progress", (p) => notify("progress", p));
  api.on("connected", async () => {
    await loadState().catch(() => {});
    notify("accounts");
  });

  const dot = (color) => {
    const d = h("span", "dot");
    d.style.background = color;
    return d;
  };
  const card = (...children) => {
    const c = h("div", "card");
    c.append(...children);
    return c;
  };

  // =====================================================================
  // Contas
  // =====================================================================
  async function renderContas(el, arg) {
    await loadState();
    const draw = () => {
      el.replaceChildren();
      el.append(h("p", "lead", "Contas usadas na aba de E-mail. "));
      if (!state.crypto.available)
        el.append(
          h(
            "div",
            "banner",
            "O chaveiro do sistema não está disponível: não é possível salvar contas com segurança.",
          ),
        );
      else if (state.crypto.backend === "basic_text")
        el.append(
          h(
            "div",
            "banner",
            "Sem chaveiro do sistema (GNOME Keyring/KWallet): as senhas ficam só ofuscadas no disco. Instale ou ative um chaveiro.",
          ),
        );
      const top = h("div", "row");
      const add = h("button", "primary", "+ Adicionar conta");
      add.onclick = openAdd;
      add.disabled = !state.crypto.available;
      top.append(add);
      el.append(
        top,
        h(
          "div",
          "section",
          `${state.accounts.length} conta${state.accounts.length === 1 ? "" : "s"}`,
        ),
      );
      if (!state.accounts.length)
        el.append(
          card(
            h(
              "div",
              "muted",
              "Nenhuma conta ainda. Adicione uma para começar a usar a aba de E-mail.",
            ),
          ),
        );
      for (const a of state.accounts) el.append(accountCard(a));
    };
    draw();
    if (arg === "add") openAdd();
    else if (/^\d+$/.test(arg || "")) {
      const c = el.querySelector(`.acc[data-id="${arg}"]`);
      if (c) {
        c.scrollIntoView({ block: "center" });
        c.classList.add("flash");
        setTimeout(() => c.classList.remove("flash"), 1600);
      }
    }
    return listen(
      (kind) =>
        (kind === "accounts" || kind === "status") &&
        $("overlay").hidden &&
        draw(),
    );
  }

  function accountCard(a) {
    const c = h("div", "card acc");
    c.dataset.id = a.id;
    c.append(
      dot(a.color),
      h("div", "acc-name", a.name),
      h("span", "muted small", PROVIDER[a.provider] || a.provider),
    );
    c.append(
      h(
        "div",
        "acc-sub",
        a.email + (a.sender_name ? ` · envia como “${a.sender_name}”` : ""),
      ),
    );
    const [sym, label] = STATUS[a.status] || ["●", a.status || "Desconectada"];
    const st = h("div", "acc-status");
    st.append(h("span", `st-${a.status}`, `${sym} ${label}`));
    if (a.status === "idle" || a.status === "syncing")
      st.append(
        h("span", "muted", `· última sincronização ${when(a.last_sync_at)}`),
      );
    if (a.error && a.status !== "idle")
      st.append(h("span", "muted", `· ${a.error}`));
    c.append(st);
    const actions = h("div", "acc-actions");
    actions.append(
      actionButton("Sincronizar agora", "secondary sm", () =>
        api
          .call("syncNow", { accountId: a.id })
          .then(() => toast("Sincronizando…")),
      ),
    );
    if (a.auth === "oauth-google") {
      const b = h("button", "secondary sm", "Reconectar com Google");
      b.onclick = () => openGoogleReconnect(a);
      actions.append(b);
    } else if (["auth", "offline", "error"].includes(a.status)) {
      actions.append(
        actionButton("Tentar de novo", "secondary sm", () =>
          api.call("reconnect", { accountId: a.id }),
        ),
      );
    }
    const edit = h("button", "secondary sm", "Editar…");
    edit.onclick = () => openEdit(a);
    const rm = h("button", "danger-text sm", "Remover");
    rm.onclick = async () => {
      const ok = await confirmDialog(
        `Remover ${a.email}?`,
        "A conta sai do app e o cache local dela é apagado. As mensagens continuam no servidor.",
        "Remover",
      );
      if (!ok) return;
      try {
        await api.call("removeAccount", { id: a.id });
        toast("Conta removida.");
      } catch (err) {
        toast(err.message, true);
      }
    };
    actions.append(edit, rm);
    c.append(actions);
    return c;
  }

  function openEdit(a) {
    const f = $("edit-form");
    f.elements.name.value = a.name;
    f.elements.senderName.value = a.sender_name || "";
    f.querySelector(".err").textContent = "";
    let color = a.color;
    const box = $("edit-colors");
    box.replaceChildren();
    for (const c of COLORS) {
      const b = h("button", c === color ? "on" : "");
      b.type = "button";
      b.style.background = c;
      b.title = c;
      b.onclick = () => {
        color = c;
        for (const x of box.children) x.classList.toggle("on", x === b);
      };
      box.append(b);
    }
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api.call("updateAccount", {
          id: a.id,
          name: f.elements.name.value,
          senderName: f.elements.senderName.value,
          color,
        });
        closeDialog();
        toast("Conta atualizada.");
      } catch (ex) {
        f.querySelector(".err").textContent = ex.message;
      }
    };
    showDialog("dlg-edit");
  }

  // ---------- Adicionar conta (assistente) ----------
  const STEPS = [
    "step-provider",
    "step-gmail",
    "step-gmail-tutorial",
    "step-google-client",
    "step-google-wait",
    "step-password",
  ];
  const stepHistory = [];
  let provider = null;
  let googleWaiting = false;
  let reconnectAccount = null;
  const PRESETS = {
    gmail: {
      imap_host: "imap.gmail.com",
      imap_port: 993,
      smtp_host: "smtp.gmail.com",
      smtp_port: 465,
    },
    locaweb: {
      imap_host: "email-ssl.com.br",
      imap_port: 993,
      smtp_host: "email-ssl.com.br",
      smtp_port: 465,
    },
    imap: { imap_host: "", imap_port: 993, smtp_host: "", smtp_port: 465 },
  };

  function step(id, push = true) {
    const current = STEPS.find((s) => !$(s).hidden);
    if (push && current && current !== id) stepHistory.push(current);
    for (const s of STEPS) $(s).hidden = s !== id;
    for (const e of $(id).querySelectorAll(".err")) e.textContent = "";
    const first = $(id).querySelector("input");
    if (first) setTimeout(() => first.focus());
  }
  const onAddClose = () => {
    if (googleWaiting) api.call("cancelGoogle").catch(() => {});
    googleWaiting = false;
  };
  function openAdd() {
    if (!state.crypto.available)
      return toast(
        "O chaveiro do sistema não está disponível: não é possível salvar contas.",
        true,
      );
    stepHistory.length = 0;
    reconnectAccount = null;
    $("dlg-add").querySelector("h2").textContent = "Adicionar conta";
    showDialog("dlg-add", onAddClose);
    step("step-provider", false);
  }
  function openGoogleReconnect(a) {
    stepHistory.length = 0;
    reconnectAccount = a;
    $("dlg-add").querySelector("h2").textContent = "Reconectar conta Google";
    showDialog("dlg-add", onAddClose);
    if (state.google.configured) googleWaitStep();
    else step("step-google-client", false);
  }
  for (const b of document.querySelectorAll("[data-back]"))
    b.onclick = () => step(stepHistory.pop() || "step-provider", false);
  for (const b of document.querySelectorAll(".provider")) {
    b.onclick = () => {
      provider = b.dataset.provider;
      if (provider === "gmail") return step("step-gmail");
      preparePasswordForm();
    };
  }
  function preparePasswordForm() {
    const f = $("step-password");
    f.reset();
    const p = PRESETS[provider];
    for (const k of Object.keys(p)) f.elements[k].value = p[k];
    $("password-label").textContent =
      provider === "gmail" ? "Senha de app (16 letras)" : "Senha";
    $("gmail-hint").hidden = provider !== "gmail";
    $("advanced").open = provider === "imap";
    for (const k of ["imap_host", "smtp_host"])
      f.elements[k].required = provider === "imap";
    step("step-password");
  }
  $("gmail-password").onclick = () => step("step-gmail-tutorial");
  $("gmail-tutorial-next").onclick = preparePasswordForm;
  $("step-password").elements.email.addEventListener("change", (e) => {
    const f = $("step-password");
    const dom = (e.target.value.split("@")[1] || "").toLowerCase();
    if (provider === "imap" && dom && !f.elements.imap_host.value) {
      f.elements.imap_host.value = "imap." + dom;
      f.elements.smtp_host.value = "smtp." + dom;
    }
  });
  $("step-password").elements.smtp_secure.addEventListener("change", (e) => {
    $("step-password").elements.smtp_port.value =
      e.target.value === "ssl" ? 465 : 587;
  });
  $("step-password").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector("[type=submit]");
    const err = f.querySelector(".err");
    const v = Object.fromEntries(new FormData(f));
    const p = PRESETS[provider];
    const advanced =
      provider === "imap" ||
      v.imap_host !== p.imap_host ||
      v.smtp_host !== p.smtp_host ||
      Number(v.imap_port) !== p.imap_port ||
      Number(v.smtp_port) !== p.smtp_port ||
      v.smtp_secure !== "ssl";
    btn.disabled = true;
    btn.textContent = "Testando conexão…";
    err.textContent = "";
    try {
      const r = await api.call("addPasswordAccount", {
        provider,
        email: v.email,
        password: v.password,
        name: v.name,
        username: v.username,
        advanced,
        imap_host: v.imap_host,
        imap_port: Number(v.imap_port),
        imap_secure: true,
        smtp_host: v.smtp_host,
        smtp_port: Number(v.smtp_port),
        smtp_secure: v.smtp_secure === "ssl",
        senderName: v.senderName,
      });
      f.reset();
      closeDialog();
      await loadState();
      toast("Conta adicionada. A primeira sincronização começou.");
      go(`email/contas/${r.id}`);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Conectar";
    }
  };
  $("gmail-oauth").onclick = () =>
    state.google.configured ? googleWaitStep() : step("step-google-client");
  $("step-google-client").onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    try {
      await api.call("setGoogleClient", v);
      state.google.configured = true;
      e.target.reset();
      googleWaitStep();
    } catch (ex) {
      e.target.querySelector(".err").textContent = ex.message;
    }
  };
  function googleWaitStep() {
    step("step-google-wait");
    $("google-name").parentElement.hidden = !!reconnectAccount;
    $("google-sender").parentElement.hidden = !!reconnectAccount;
    $("google-wait-text").textContent = reconnectAccount
      ? `Entre novamente com ${reconnectAccount.email} no navegador.`
      : "O login abre no seu navegador. Conclua lá e volte para cá.";
    $("google-go").disabled = false;
    $("google-go").textContent = "Abrir login do Google";
  }
  $("google-go").onclick = async () => {
    const errEl = $("step-google-wait").querySelector(".err");
    errEl.textContent = "";
    $("google-go").disabled = true;
    $("google-go").textContent = "Aguardando o navegador…";
    googleWaiting = true;
    try {
      const r = await api.call("connectGoogle", {
        accountId: reconnectAccount ? reconnectAccount.id : null,
        name: $("google-name").value,
        senderName: $("google-sender").value,
      });
      googleWaiting = false;
      closeDialog();
      await loadState();
      toast(reconnectAccount ? "Conta reconectada." : "Conta adicionada.");
      go(`email/contas/${r.id}`);
    } catch (ex) {
      googleWaiting = false;
      errEl.textContent = ex.message;
      $("google-go").disabled = false;
      $("google-go").textContent = "Tentar de novo";
    }
  };
  $("google-cancel").onclick = closeDialog;

  // =====================================================================
  // Organização da caixa de entrada
  // =====================================================================
  async function renderOrganizacao(el) {
    el.append(
      h(
        "p",
        "lead",
        "A Caixa de entrada é dividida em Importante, Propaganda e Outros (não lidas) e Já lidos.",
      ),
    );
    const statusCard = h("div", "card");
    const tiles = h("div", "tiles");
    const bars = h("div", "card bars");
    el.append(
      statusCard,
      h("div", "section", "Não lidas na Caixa de entrada, por grupo"),
      tiles,
      h("div", "section", "Quem decidiu cada mensagem"),
      bars,
    );

    // Tabela de decisões por mensagem
    el.append(h("div", "section", "Decisão por mensagem (confiança e motivo)"));
    const filters = h("div", "filters");
    const q = h("input");
    q.type = "search";
    q.placeholder = "Buscar por assunto ou remetente";
    const gsel = h("select");
    for (const [v, t] of [
      ["", "Todos os grupos"],
      ["importante", "Importante"],
      ["propaganda", "Propaganda"],
      ["outros", "Outros"],
      ["suspeito", "Suspeitos"],
    ]) {
      const o = h("option", "", t);
      o.value = v;
      gsel.append(o);
    }
    const ssel = h("select");
    for (const [v, t] of [["", "Qualquer origem"], ...Object.entries(SOURCE)]) {
      const o = h("option", "", t);
      o.value = v;
      ssel.append(o);
    }
    filters.append(q, gsel, ssel);
    const table = h("table", "cls");
    const thead = h("thead");
    const tr = h("tr");
    for (const t of [
      "Data",
      "Mensagem",
      "Grupo",
      "Confiança",
      "Origem e motivo",
    ])
      tr.append(h("th", "", t));
    thead.append(tr);
    const tbody = h("tbody");
    table.append(thead, tbody);
    const more = h("button", "secondary sm", "Mostrar mais");
    const moreRow = h("div", "row end");
    moreRow.append(more);
    el.append(filters, card(table, moreRow));

    let offset = 0;
    const PAGE_ROWS = 40;
    async function loadRows(reset) {
      if (reset) {
        offset = 0;
        tbody.replaceChildren();
      }
      const rows = await api.call("listClassifications", {
        q: q.value,
        group: gsel.value,
        source: ssel.value,
        limit: PAGE_ROWS,
        offset,
      });
      offset += rows.length;
      for (const r of rows) tbody.append(classRow(r));
      if (!tbody.children.length) {
        const td = h("td", "muted", "Nenhuma mensagem.");
        td.colSpan = 5;
        const e = h("tr");
        e.append(td);
        tbody.append(e);
      }
      more.hidden = rows.length < PAGE_ROWS;
    }
    more.onclick = () => loadRows(false);
    let qTimer;
    q.oninput = () => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => loadRows(true), 250);
    };
    gsel.onchange = ssel.onchange = () => loadRows(true);

    function draw(s) {
      const p = s.progress;
      statusCard.replaceChildren();
      const head = h("div", "row");
      head.append(
        h(
          "h3",
          "",
          p.running
            ? `Organizando… ${fmtNum.format(p.done)} de ${fmtNum.format(p.total)}`
            : "Caixa de entrada organizada",
        ),
      );
      if (!p.running && p.finishedAt)
        head.append(
          h("span", "muted small", `última análise ${when(p.finishedAt)}`),
        );
      statusCard.append(head);
      if (p.running && p.total) {
        const bar = h("div", "progress");
        const fill = h("span");
        fill.style.width = Math.round((100 * p.done) / p.total) + "%";
        bar.append(fill);
        statusCard.append(bar);
      }
      const total = Object.values(s.model.docs).reduce((n, v) => n + v, 0);
      statusCard.append(
        h(
          "div",
          "muted small",
          s.model.ready
            ? `Modelo pronto · ${fmtNum.format(Math.round(total))} exemplos (Importante ${fmtNum.format(Math.round(s.model.docs.importante))} · Propaganda ${fmtNum.format(Math.round(s.model.docs.propaganda))} · Outros ${fmtNum.format(Math.round(s.model.docs.outros))}) · ${fmtNum.format(s.model.vocabulary)} palavras`
            : `Modelo aprendendo: decide sozinho a partir de 30 exemplos de pelo menos duas categorias (tem ${fmtNum.format(Math.round(total))}). Até lá valem as regras e a reputação.`,
        ),
        h(
          "div",
          "muted small",
          `${fmtNum.format(s.shortcuts)} remetente(s) com atalho de reputação (decisão já aprendida)`,
        ),
      );
      statusCard.append(
        toggle(
          "Aprender com o meu uso",
          "Treina o modelo e a reputação com o que você lê, responde, favorita, apaga sem abrir e move entre grupos. Desligado, o que já foi aprendido continua valendo.",
          s.learning,
          async (on, input) => {
            try {
              draw(await api.call("setOrganize", { learning: on }));
              toast(on ? "Aprendizado ligado." : "Aprendizado desligado.");
            } catch (err) {
              input.checked = !on;
              toast(err.message, true);
            }
          },
        ),
      );
      const actions = h("div", "row end");
      actions.append(
        actionButton("Reclassificar tudo", "secondary", async () => {
          draw(await api.call("reclassifyAll"));
          toast("Reclassificando em segundo plano.");
        }),
        actionButton("Redefinir aprendizado", "danger-text", async () => {
          const ok = await confirmDialog(
            "Redefinir o aprendizado?",
            "Apaga o modelo, a reputação aprendida e as suas correções (mensagens movidas entre grupos). As regras de remetente ficam. A Caixa de entrada é reorganizada do zero, só com as regras, e volta a aprender.",
            "Redefinir",
          );
          if (!ok) return;
          draw(await api.call("resetLearning"));
          toast("Aprendizado redefinido.");
          loadRows(true);
        }),
      );
      statusCard.append(actions);

      tiles.replaceChildren();
      for (const g of ["importante", "propaganda", "outros", "suspeito"]) {
        const t = h("div", "tile");
        const l = h("div", "l");
        l.append(h("span", `pill g-${g}`, GROUP[g]));
        t.append(h("div", "n", fmtNum.format(s.stats.byGroup[g] || 0)), l);
        tiles.append(t);
      }
      const lt = h("div", "tile");
      lt.append(
        h("div", "n", fmtNum.format(s.stats.read || 0)),
        h("div", "l", "Já lidos"),
      );
      tiles.append(lt);

      bars.replaceChildren();
      const max = Math.max(1, ...Object.values(s.stats.bySource));
      for (const k of Object.keys(SOURCE)) {
        const n = s.stats.bySource[k] || 0;
        if (!n && k === "pendente") continue;
        const row = h("div", "bar-row");
        const track = h("div", "track");
        const fill = h("span", "fill");
        fill.style.width = Math.round((100 * n) / max) + "%";
        track.append(fill);
        row.append(
          h("span", "", SOURCE[k]),
          track,
          h("span", "v", fmtNum.format(n)),
        );
        bars.append(row);
      }
      bars.append(
        h(
          "div",
          "muted small",
          `${fmtNum.format(s.stats.total)} mensagens na Caixa de entrada (todas as contas).`,
        ),
      );
    }

    draw(await api.call("getOrganize"));
    await loadRows(true);
    let pending = null;
    return listen((kind, p) => {
      if (kind !== "progress") return;
      // Atualiza no máximo a cada segundo; ao terminar, recarrega também a tabela
      if (pending) return;
      pending = setTimeout(
        async () => {
          pending = null;
          try {
            draw(await api.call("getOrganize"));
            if (!p.running) loadRows(true);
          } catch {}
        },
        p.running ? 1000 : 200,
      );
    });
  }

  function classRow(r) {
    const tr = h("tr");
    tr.append(h("td", "conf muted", when(r.date)));
    const who = h("td", "who");
    const a = accountById(r.account_id);
    const from = h("div", "", r.from_name || r.from_addr || "(sem remetente)");
    from.title = r.from_addr;
    const subj = h("div", "muted", r.subject || "(sem assunto)");
    subj.title = r.subject;
    who.append(from, subj);
    if (a && state.accounts.length > 1) who.title = a.name;
    const g = h("td");
    g.append(h("span", `pill g-${r.grp}`, GROUP[r.grp] || r.grp));
    if (r.seen) g.append(h("span", "read-mark", "lida"));
    const conf = h("td", "conf", `${r.confidence}%`);
    const why = h("td", "why");
    why.append(
      h("div", "", SOURCE[r.source] || r.source),
      h("div", "small", r.reason || ""),
    );
    tr.append(who, g, conf, why);
    return tr;
  }

  // =====================================================================
  // Remetentes
  // =====================================================================
  async function renderRemetentes(el) {
    const s = await api.call("getSenders");
    el.append(
      h(
        "p",
        "lead",
        "Regras explícitas por remetente. Valem antes do aprendizado automático. A análise de segurança continua acima delas: se alguém imitar um remetente confiável, a mensagem vai para Suspeitos.",
      ),
    );
    const lists = h("div", "card grid2");
    const area = (label, hint, value, placeholder) => {
      const l = h("label", "", label + " ");
      l.append(h("span", "muted", hint));
      const t = h("textarea");
      t.rows = 7;
      t.spellcheck = false;
      t.placeholder = placeholder;
      t.value = (value || []).join("\n");
      l.append(t);
      return [l, t];
    };
    const [tl, trusted] = area(
      "Confiáveis",
      "(vão para Importante)",
      s.trusted,
      "chefe@empresa.com.br\n@cliente.com.br",
    );
    const [bl, blocked] = area(
      "Bloqueados",
      "(vão para Suspeitos)",
      s.blocked,
      "@spam-chato.com",
    );
    tl.style.marginTop = bl.style.marginTop = "0";
    lists.append(tl, bl);
    el.append(
      h("div", "section", "Listas"),
      lists,
      h(
        "div",
        "muted small",
        "Um por linha. @dominio.com vale para todo o domínio (e os subdomínios).",
      ),
    );

    // "Sempre classificar como"
    let rules = (s.rules || []).map((r) => ({ ...r }));
    const rulesCard = h("div", "card");
    rulesCard.append(
      h("h3", "", "Sempre classificar como"),
      h(
        "div",
        "muted small",
        "Também criadas pelo menu de contexto da lista de mensagens (clique direito › “Sempre classificar este remetente como”).",
      ),
    );
    const box = h("div", "rules");
    const catSelect = (value, onChange) => {
      const sel = h("select");
      for (const c of ["importante", "propaganda", "outros"]) {
        const o = h("option", "", GROUP[c]);
        o.value = c;
        sel.append(o);
      }
      sel.value = value || "importante";
      if (onChange) sel.onchange = () => onChange(sel.value);
      return sel;
    };
    const drawRules = () => {
      box.replaceChildren();
      if (!rules.length) box.append(h("div", "muted small", "Nenhuma regra."));
      rules.forEach((r, i) => {
        const row = h("div", "rule");
        const m = h("div", "match", r.match);
        m.title = r.match;
        const rm = h("button", "rm", "✕");
        rm.title = "Remover regra";
        rm.onclick = () => {
          rules.splice(i, 1);
          drawRules();
        };
        row.append(
          m,
          catSelect(r.category, (v) => (r.category = v)),
          rm,
        );
        box.append(row);
      });
    };
    drawRules();
    const addRow = h("div", "rule-add");
    const newMatch = h("input");
    newMatch.placeholder = "pessoa@empresa.com.br ou @dominio.com.br";
    newMatch.spellcheck = false;
    const newCat = catSelect("propaganda");
    const addBtn = h("button", "secondary", "Adicionar");
    addBtn.type = "button";
    addBtn.onclick = () => {
      const m = newMatch.value.trim().toLowerCase();
      if (!/^@?[^\s@]+(@[^\s@]+)?$/.test(m) || !m.includes("."))
        return toast("Informe um e-mail ou @dominio válido.", true);
      rules = rules.filter((r) => r.match !== m);
      rules.push({ match: m, category: newCat.value });
      newMatch.value = "";
      drawRules();
    };
    newMatch.onkeydown = (e) => e.key === "Enter" && addBtn.onclick();
    addRow.append(newMatch, newCat, addBtn);
    rulesCard.append(box, addRow);
    el.append(h("div", "section", "Regras"), rulesCard);

    const save = h("div", "row end");
    save.append(
      actionButton("Salvar remetentes", "primary", async () => {
        const r = await api.call("setSenders", {
          trusted: trusted.value,
          blocked: blocked.value,
          rules,
        });
        trusted.value = r.trusted.join("\n");
        blocked.value = r.blocked.join("\n");
        rules = r.rules.map((x) => ({ ...x }));
        drawRules();
        toast(
          "Remetentes salvos. A Caixa de entrada é reorganizada em segundo plano.",
        );
      }),
    );
    el.append(save);
  }

  // =====================================================================
  // Segurança
  // =====================================================================
  async function renderSeguranca(el) {
    await loadState();
    const [sec, tri, av] = await Promise.all([
      api.call("getSecurity"),
      api.call("getTriageConfig"),
      api.call("triageStatus").catch(() => null),
    ]);
    el.append(
      h(
        "p",
        "lead",
        "Cada e-mail recebido passa por uma análise de risco local . As mensagens suspeitas recebem um selo e vão para o grupo Suspeitos da Caixa de entrada. O app nunca apaga, responde nem encaminha nada sozinho.",
      ),
    );
    const saveSec = async (patch, input, prev) => {
      try {
        await api.call("setSecurity", patch);
        toast("Salvo.");
      } catch (err) {
        if (input) input.checked = prev;
        toast(err.message, true);
      }
    };
    const c1 = h("div", "card");
    c1.append(
      toggle(
        "Modo sombra (só avisar)",
        "Ligado, as mensagens suspeitas ficam no grupo da categoria delas, só com o selo de risco. Desligado, vão para o grupo Suspeitos (recolhido, logo antes de Já lidos).",
        sec.shadow,
        (on, input) => saveSec({ shadow: on }, input, !on),
      ),
    );
    const sens = h("div", "field-row");
    const sensText = h("span", "toggle-text");
    sensText.append(
      h("b", "", "Sensibilidade"),
      h(
        "span",
        "muted small",
        "Alta pega mais golpes e erra mais em e-mails legítimos; baixa só separa o que é claramente perigoso.",
      ),
    );
    const sensSel = h("select");
    for (const [v, t] of [
      ["baixa", "Baixa (só perigosos)"],
      ["normal", "Normal"],
      ["alta", "Alta (qualquer sinal)"],
    ]) {
      const o = h("option", "", t);
      o.value = v;
      sensSel.append(o);
    }
    sensSel.value = sec.sensitivity;
    sensSel.onchange = () => saveSec({ sensitivity: sensSel.value });
    sens.append(sensText, sensSel);
    c1.append(sens);
    c1.append(
      toggle(
        "Quarentena",
        "Nas mensagens suspeitas, os links ficam desativados (mostram o destino real), os anexos só podem ser salvos e as imagens remotas nunca carregam sozinhas.",
        sec.neutralize,
        (on, input) => saveSec({ neutralize: on }, input, !on),
      ),
    );
    el.append(c1);

    // Por conta
    el.append(h("div", "section", "Por conta"));
    if (!state.accounts.length)
      el.append(card(h("div", "muted", "Nenhuma conta.")));
    else {
      const t = h("table", "per-acc");
      const head = h("tr");
      for (const x of [
        "Conta",
        "Análise de segurança",
        "Baixar imagens remotas automaticamente",
      ])
        head.append(h("th", "", x));
      t.append(head);
      for (const a of state.accounts) {
        const tr = h("tr");
        const name = h("td");
        const wrap = h("span", "row");
        wrap.append(
          dot(a.color),
          h("span", "", a.name),
          h("span", "muted small", a.email),
        );
        name.append(wrap);
        const cb = (field, value, key) => {
          const td = h("td");
          const i = h("input");
          i.type = "checkbox";
          i.checked = !!value;
          i.onchange = async () => {
            try {
              await api.call("updateAccount", { id: a.id, [key]: i.checked });
              a[field] = i.checked ? 1 : 0;
              toast("Salvo.");
            } catch (err) {
              i.checked = !i.checked;
              toast(err.message, true);
            }
          };
          td.append(i);
          return td;
        };
        tr.append(
          name,
          cb("triage_enabled", a.triage_enabled, "triageEnabled"),
          cb("auto_images", a.auto_images, "autoImages"),
        );
        t.append(tr);
      }
      el.append(
        card(t),
        h(
          "div",
          "muted small",
          "Imagens remotas desligadas: o remetente não consegue saber quando você abriu a mensagem. Dá para mostrar as imagens de um e-mail com um clique.",
        ),
      );
    }

    // Antivírus
    if (av) {
      const txt =
        av.antivirus === "clamd"
          ? [
              "ok",
              "ClamAV (clamd) ativo: anexos de risco dos últimos 3 dias são examinados.",
            ]
          : av.antivirus === "clamscan"
            ? [
                "ok",
                "ClamAV (clamscan) ativo: exames mais lentos, um de cada vez.",
              ]
            : [
                "warn",
                "ClamAV não encontrado neste computador: as outras camadas da análise continuam valendo (veja docs/TRIAGEM.md).",
              ];
      el.append(
        h("div", "section", "Antivírus"),
        card(h("div", txt[0] + " small", txt[1])),
      );
    }

    // Camada de LLM (opcional)
    el.append(h("div", "section", "Camada de LLM (opcional)"));
    el.append(llmCard(tri));
  }

  function llmCard(data) {
    const d = h("details", "card");
    const c = data.config;
    const sum = h("summary", "", "Agente LLM na análise de risco");
    sum.append(
      h(
        "span",
        "muted small",
        c.provider === "none"
          ? "· desligado"
          : `· ${c.provider === "anthropic" ? "Claude API" : "OpenRouter"}`,
      ),
    );
    d.append(sum);
    d.open = c.provider !== "none";
    d.append(
      h(
        "p",
        "muted small",
        "Opcional. Só ajuda a apontar golpes que as regras não pegam (ex.: fraude do “chefe” sem link). A organização em grupos não usa LLM. O agente nunca apaga, envia, responde nem encaminha nada, e não pode rebaixar o que as regras marcaram como perigoso.",
      ),
    );
    const f = h("form");
    f.autocomplete = "off";
    const field = (label, el, hint) => {
      const l = h("label", "", label + " ");
      if (hint) l.append(h("span", "muted", hint));
      l.append(el);
      return l;
    };
    const sel = (opts, value) => {
      const s = h("select");
      for (const [v, t] of opts) {
        const o = h("option", "", t);
        o.value = v;
        s.append(o);
      }
      s.value = value;
      return s;
    };
    const input = (type, value, placeholder) => {
      const i = h("input");
      i.type = type;
      i.value = value == null ? "" : value;
      i.placeholder = placeholder || "";
      i.spellcheck = false;
      return i;
    };
    const providerSel = sel(
      [
        ["none", "Desligado (só as regras locais)"],
        ["anthropic", "Claude API"],
        ["openrouter", "OpenRouter"],
      ],
      c.provider,
    );
    const anthropicKey = input(
      "password",
      "",
      data.status.hasAnthropicKey
        ? "•••••• configurada (deixe em branco para manter)"
        : "sk-ant-…",
    );
    const openrouterKey = input(
      "password",
      "",
      data.status.hasOpenrouterKey
        ? "•••••• configurada (deixe em branco para manter)"
        : "sk-or-…",
    );
    const orMode = sel(
      [
        ["free", "Gratuitos, em rodízio automático (modo restrito)"],
        [
          "chosen",
          "Escolhidos por mim (pagos, provedores que não guardam dados)",
        ],
      ],
      c.openrouterMode,
    );
    const orModels = h("textarea");
    orModels.rows = 3;
    orModels.spellcheck = false;
    orModels.placeholder = "anthropic/claude-haiku-5.5";
    orModels.value = (c.openrouterModels || []).join("\n");
    const prefs = h("textarea");
    prefs.rows = 3;
    prefs.placeholder =
      "Ex.: clientes, contratos, pagamentos de fornecedores e qualquer coisa da diretoria.";
    prefs.value = c.preferences || "";
    const daily = input("number", c.dailyLimit);
    daily.min = 0;
    daily.max = 10000;
    const remove = {};
    const removeLink = (key, el) => {
      const b = h("button", "link", "Remover chave");
      b.type = "button";
      b.onclick = () => {
        remove[key] = true;
        el.value = "";
        el.placeholder = "será removida ao salvar";
      };
      return b;
    };

    const anth = h("div");
    anth.append(field("Chave da API do Claude", anthropicKey));
    const anthHint = h(
      "p",
      "muted small",
      "Haiku 5.5 analisa os e-mails; Sonnet 5.5 revisa só os casos ambíguos. Custo estimado: cerca de US$ 5 por mês para 100 e-mails por dia. ",
    );
    anthHint.append(removeLink("anthropicKey", anthropicKey));
    anth.append(anthHint);

    const or = h("div");
    const chosenOnly = field(
      "Modelos, um por linha, em ordem de preferência",
      orModels,
    );
    const freeOnly = h(
      "p",
      "notice-dark small",
      "⚠ Modelos gratuitos podem guardar e usar o conteúdo para treinamento. Cada conta precisa ser liberada abaixo, e os e-mails vão reduzidos e mascarados. ",
    );
    freeOnly.append(removeLink("openrouterKey", openrouterKey));
    or.append(
      field("Chave da OpenRouter", openrouterKey),
      field("Modelos", orMode),
      chosenOnly,
      freeOnly,
    );

    // Liberar modelos gratuitos por conta
    const freeBox = h("div");
    freeBox.append(
      h("label", "", "Contas liberadas para modelos gratuitos (modo restrito)"),
    );
    for (const a of state.accounts) {
      const l = h("label", "row");
      l.style.marginTop = "6px";
      const i = h("input");
      i.type = "checkbox";
      i.style.width = "auto";
      i.checked = !!a.triage_allow_free;
      i.onchange = async () => {
        try {
          await api.call("updateAccount", { id: a.id, allowFree: i.checked });
          a.triage_allow_free = i.checked ? 1 : 0;
        } catch (err) {
          i.checked = !i.checked;
          toast(err.message, true);
        }
      };
      l.append(i, h("span", "", `${a.name} (${a.email})`));
      freeBox.append(l);
    }
    or.append(freeBox);

    const sync = () => {
      anth.hidden = providerSel.value !== "anthropic";
      or.hidden = providerSel.value !== "openrouter";
      chosenOnly.hidden = orMode.value !== "chosen";
      freeOnly.hidden = orMode.value === "chosen";
      freeBox.hidden = orMode.value === "chosen";
    };
    providerSel.onchange = orMode.onchange = sync;

    const status = h("div", "status-lines");
    const renderStatus = (st) => {
      status.replaceChildren();
      const u = st.usage || {};
      const line = (text, cls) =>
        status.append(h("div", cls || "muted small", text));
      if (st.provider === "none")
        line("Desligado: só as regras locais e o antivírus.");
      else if (!st.ready) line("Falta a chave do provedor.", "warn small");
      else
        line(
          `Pronto · ${st.provider === "anthropic" ? "Claude API" : "OpenRouter"}${st.restricted ? " · modo restrito" : ""} · prompt ${st.promptVersion}`,
          "ok small",
        );
      line(
        `Hoje: ${u.calls || 0} análise(s)${u.escalations ? `, ${u.escalations} revisada(s) pelo modelo maior` : ""}${u.cost ? ` · ~US$ ${u.cost.toFixed(4)}` : ""}`,
      );
      if (
        st.openrouter &&
        st.openrouter.cooling &&
        st.openrouter.cooling.length
      ) {
        line(
          "Em pausa (limite): " +
            st.openrouter.cooling
              .map((x) => `${x.id} até ${S.fmtTime.format(new Date(x.until))}`)
              .join(", "),
        );
      }
      if (st.lastError) line("Último erro: " + st.lastError, "warn small");
    };
    renderStatus(data.status);

    const patch = () => {
      const p = {
        provider: providerSel.value,
        openrouterMode: orMode.value,
        openrouterModels: orModels.value,
        preferences: prefs.value,
        dailyLimit: Number(daily.value),
      };
      if (remove.anthropicKey) p.anthropicKey = null;
      else if (anthropicKey.value.trim())
        p.anthropicKey = anthropicKey.value.trim();
      if (remove.openrouterKey) p.openrouterKey = null;
      else if (openrouterKey.value.trim())
        p.openrouterKey = openrouterKey.value.trim();
      return p;
    };
    const err = h("div", "err");
    const save = async () => {
      err.textContent = "";
      const r = await api.call("setTriageConfig", patch());
      anthropicKey.value = openrouterKey.value = "";
      renderStatus(r.status);
      return r;
    };
    const row = h("div", "row end");
    row.append(
      actionButton("Testar", "secondary", async () => {
        try {
          await save();
          const r = await api.call("testTriageLLM");
          status.append(
            h(
              "div",
              r.result.category === "suspeito" ? "ok small" : "warn small",
              `Teste (e-mail fictício de golpe do "diretor"): ${r.result.category} · risco ${r.result.risk} · ${r.model}${r.escalated ? " (revisado)" : ""} · ${(r.ms / 1000).toFixed(1)} s${r.cost ? ` · US$ ${r.cost.toFixed(4)}` : ""}`,
            ),
          );
        } catch (ex) {
          err.textContent = ex.message;
        }
      }),
      actionButton("Salvar", "primary", async () => {
        try {
          await save();
          toast("Camada de LLM salva.");
        } catch (ex) {
          err.textContent = ex.message;
        }
      }),
    );
    f.onsubmit = (e) => e.preventDefault();
    f.append(
      field("Provedor", providerSel),
      anth,
      or,
      field(
        "O que é importante para mim",
        prefs,
        "(o agente usa para dar prioridade)",
      ),
      field(
        "Limite de análises por dia",
        daily,
        "(controle de custo; 0 = sem limite)",
      ),
      status,
      err,
      row,
    );
    d.append(f);
    sync();
    return d;
  }

  // =====================================================================
  // Assinaturas
  // =====================================================================
  async function renderAssinaturas(el) {
    await loadState();
    el.append(
      h(
        "p",
        "lead",
        "Entra no fim das mensagens novas, das respostas e dos encaminhamentos de cada conta.  ",
      ),
    );
    if (!state.accounts.length)
      el.append(card(h("div", "muted", "Nenhuma conta.")));
    for (const a of state.accounts) {
      const c = h("div", "card");
      const head = h("div", "sig-head");
      head.append(
        dot(a.color),
        h("b", "", a.name),
        h("span", "acc-sub", a.email),
      );
      const t = h("textarea");
      t.rows = 4;
      t.value = a.signature || "";
      t.placeholder = `${a.sender_name || "Seu nome"}\nCargo · (00) 00000-0000`;
      const hint = h("div", "acc-sub", "Texto simples ou HTML (comece com uma tag, ex.: <table>). Imagens e scripts são removidos.");
      hint.style.marginTop = "4px";
      const row = h("div", "row end");
      row.style.marginTop = "8px";
      row.append(
        actionButton("Salvar assinatura", "secondary sm", async () => {
          await api.call("updateAccount", { id: a.id, signature: t.value });
          a.signature = t.value;
          toast(`Assinatura de ${a.name} salva.`);
        }),
      );
      c.append(head, t, hint, row);
      el.append(c);
    }
  }

  S.register({
    id: "email",
    title: "E-mail",
    icon: "✉",
    pages: [
      { id: "contas", title: "Contas", render: renderContas },
      {
        id: "organizacao",
        title: "Organização da caixa de entrada",
        render: renderOrganizacao,
      },
      { id: "remetentes", title: "Remetentes", render: renderRemetentes },
      { id: "seguranca", title: "Segurança", render: renderSeguranca },
      { id: "assinaturas", title: "Assinaturas", render: renderAssinaturas },
    ],
  });
})();
