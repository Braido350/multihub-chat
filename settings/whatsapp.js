// Configurações › WhatsApp: recursos extras por aba de WhatsApp Web (whatsapp/host.js e whatsapp/inject.js).
// Cada aba tem a própria configuração; o estado de cada recurso vem da própria aba ("funcionando",
// "aguardando o WhatsApp", "não funcionou: …"), então dá para ver na hora se o WhatsApp mudou algo.
"use strict";
(() => {
  const S = window.Settings;
  const { h, toast, toggle, actionButton, confirmDialog, when } = S;
  const shell = window.appShell;
  if (!shell || !shell.wa) return;
  const wa = (action, data) => shell.wa(action, data);

  const TAB_KEY = "settings.wa.tab.v1";
  let tabs = [];
  let tabId = null;
  try {
    tabId = localStorage.getItem(TAB_KEY);
  } catch {}
  const cur = () => tabs.find((t) => t.id === tabId) || tabs[0];

  async function load() {
    tabs = await wa("list");
    if (!tabs.some((t) => t.id === tabId)) tabId = tabs[0] && tabs[0].id;
    return cur();
  }
  async function set(patch) {
    const t = cur();
    t.config = await wa("set", { siteId: t.id, patch });
    return t.config;
  }

  /** Seletor de aba (só aparece com mais de uma aba de WhatsApp). */
  function tabPicker(onChange) {
    const row = h("div", "row wa-tabs");
    if (tabs.length < 2) return row;
    for (const t of tabs) {
      const b = h("button", t.id === cur().id ? "primary sm" : "secondary sm", t.name);
      b.type = "button";
      b.onclick = () => {
        tabId = t.id;
        try {
          localStorage.setItem(TAB_KEY, t.id);
        } catch {}
        onChange();
      };
      row.append(b);
    }
    return row;
  }
  function noTabs(el) {
    el.append(
      h("p", "lead", "Nenhuma aba de WhatsApp aberta no app."),
      h("div", "card muted small", "Adicione um site com o endereço web.whatsapp.com pelo botão + da barra lateral. Cada aba de WhatsApp tem as próprias opções aqui.")
    );
  }

  // ---------- Estado de cada recurso ----------
  const STATE = {
    ok: ["ok", "● funcionando"],
    warn: ["warn", "● funcionando com ressalvas"],
    waiting: ["muted", "○ aguardando o WhatsApp conectar nesta aba"],
    broken: ["err-inline", "● não funcionou"],
  };
  const stateEls = new Map(); // featureId -> [elementos]
  function stateLine(id) {
    const s = h("span", "small wa-state");
    if (!stateEls.has(id)) stateEls.set(id, []);
    stateEls.get(id).push(s);
    return s;
  }
  function paintStates(t) {
    for (const [id, els] of stateEls) {
      const st = (t.status || {})[id];
      for (const e of els) {
        const conf = st && STATE[st.state];
        if (!conf || !t.open) {
          e.textContent = "";
          e.className = "small wa-state";
          continue;
        }
        e.className = "small wa-state " + conf[0];
        e.textContent = conf[1] + (st.detail ? ` · ${st.detail}` : "");
      }
    }
  }
  /** Atualiza o estado a cada 3 s enquanto a página estiver aberta. */
  function poll() {
    const timer = setInterval(async () => {
      try {
        const fresh = await wa("list");
        const t = fresh.find((x) => x.id === (cur() && cur().id));
        if (t) {
          Object.assign(cur(), { status: t.status, open: t.open, schedule: t.schedule, bulkJob: t.bulkJob, deletedCount: t.deletedCount });
          paintStates(cur());
          if (pollHook) pollHook(cur());
        }
      } catch {}
    }, 3000);
    return () => {
      clearInterval(timer);
      stateEls.clear();
      pollHook = null;
    };
  }
  let pollHook = null;

  /** Interruptor ligado a uma chave booleana da configuração, com o estado do recurso embaixo. */
  function sw(key, title, desc, featureId, opts = {}) {
    const t = cur();
    const label = toggle(title, desc, t.config[key], async (on, input) => {
      if (on && opts.confirm) {
        const ok = await confirmDialog(opts.confirm[0], opts.confirm[1], "Entendi o risco, ligar");
        if (!ok) return (input.checked = false);
      }
      try {
        await set({ [key]: on });
        if (opts.after) opts.after(on);
      } catch (err) {
        input.checked = !on;
        toast(err.message, true);
      }
    });
    if (featureId) label.querySelector(".toggle-text").append(stateLine(featureId));
    return label;
  }
  const card = (...children) => {
    const c = h("div", "card");
    c.append(...children);
    return c;
  };
  const section = (title) => h("div", "section", title);
  const tabNote = (t) => (t.open ? null : h("div", "card warn small", `A aba "${t.name}" não está aberta agora: as mudanças valem quando ela abrir.`));

  // ---------- Página: Recursos ----------
  async function renderRecursos(el) {
    const t = await load();
    if (!t) return noTabs(el);
    const redraw = () => {
      stateEls.clear();
      el.replaceChildren();
      draw();
    };
    function draw() {
      const t = cur();
      el.append(
        h("p", "lead", "Recursos extras do WhatsApp Web, por aba. Cada um funciona sozinho: se o WhatsApp mudar e um deles parar, os outros e a aba continuam normais."),
        tabPicker(redraw)
      );
      const note = tabNote(t);
      if (note) el.append(note);

      el.append(section("Privacidade"));
      el.append(
        card(
          sw("hideOnline", "Ocultar status online", "Seus contatos não veem \"online\" enquanto você usa esta aba. O WhatsApp também deixa de mostrar o online deles quando o seu está oculto (regra do próprio WhatsApp).", "hideOnline"),
          sw("hideTyping", "Ocultar \"digitando…\" e \"gravando áudio…\"", null, "hideTyping"),
          sw("noReadReceipts", "Não enviar confirmação de leitura", "Você lê as conversas, mas os risquinhos azuis não aparecem para quem enviou. Em grupos e em status pode haver exceções.", "noReadReceipts")
        )
      );

      el.append(section("Desfoque (passe o mouse para ver)"));
      el.append(
        card(
          sw("blurChats", "Desfocar a lista de conversas", null, "blur"),
          sw("blurMessages", "Desfocar as mensagens", null),
          sw("blurPhotos", "Desfocar fotos e vídeos", "Fotos de perfil, imagens e vídeos das conversas.")
        )
      );

      el.append(section("Mensagens apagadas"));
      const goDeleted = h("button", "link", "Ver mensagens apagadas guardadas");
      goDeleted.type = "button";
      goDeleted.onclick = () => S.go("whatsapp/apagadas");
      el.append(
        card(
          sw("keepDeleted", "Guardar mensagens apagadas", "Quando alguém apaga uma mensagem para todos, o texto continua visível na conversa e fica guardado aqui. Só vale para mensagens que chegaram com esta aba aberta; de fotos e áudios fica só o tipo.", "keepDeleted"),
          goDeleted
        )
      );

      el.append(section("Respostas rápidas"));
      el.append(card(sw("quickReplies", "Respostas rápidas com modelos", "Botão ⚡ acima da caixa de texto da conversa. Use {nome} para o primeiro nome do contato.", "quickReplies"), templatesEditor(t)));

      el.append(section("Etiquetas por conversa"));
      el.append(card(sw("labels", "Etiquetas", "Botão 🏷 no cabeçalho da conversa; as etiquetas aparecem na lista de conversas. Ficam salvas pelo nome da conversa.", "labels"), labelsEditor(t)));

      el.append(section("Exportar"));
      el.append(
        card(
          h("div", "muted small", "Salva um arquivo CSV (abre no Excel) com os contatos e os grupos desta aba. A aba precisa estar aberta e conectada."),
          (() => {
            const r = h("div", "row end");
            r.append(
              actionButton("Exportar contatos e grupos", "secondary sm", async () => {
                const res = await wa("export", { siteId: cur().id });
                if (res.saved) toast(`Exportado: ${res.contacts} contato(s) e ${res.groups} grupo(s).`);
              })
            );
            return r;
          })()
        )
      );
      paintStates(t);
    }
    draw();
    return poll();
  }

  function templatesEditor(t) {
    const box = h("div", "wa-editor");
    let list = (t.config.templates || []).map((x) => ({ ...x }));
    const rows = h("div");
    const drawRows = () => {
      rows.replaceChildren();
      if (!list.length) rows.append(h("div", "muted small", "Nenhum modelo ainda."));
      list.forEach((tp, i) => {
        const r = h("div", "wa-tpl");
        const name = h("input");
        name.placeholder = "Nome (ex.: Boas-vindas)";
        name.value = tp.name;
        name.maxLength = 60;
        name.oninput = () => (tp.name = name.value);
        const text = h("textarea");
        text.rows = 3;
        text.placeholder = "Olá {nome}! …";
        text.value = tp.text;
        text.maxLength = 4000;
        text.oninput = () => (tp.text = text.value);
        const del = h("button", "link", "Remover");
        del.type = "button";
        del.onclick = () => {
          list.splice(i, 1);
          drawRows();
        };
        r.append(name, text, del);
        rows.append(r);
      });
    };
    drawRows();
    const add = h("button", "secondary sm", "Novo modelo");
    add.type = "button";
    add.onclick = () => {
      list.push({ name: "", text: "" });
      drawRows();
      const inputs = rows.querySelectorAll("input");
      if (inputs.length) inputs[inputs.length - 1].focus();
    };
    const actions = h("div", "row end");
    actions.append(
      add,
      actionButton("Salvar modelos", "primary sm", async () => {
        const cfg = await set({ templates: list });
        list = cfg.templates.map((x) => ({ ...x }));
        drawRows();
        toast("Modelos salvos.");
      })
    );
    box.append(rows, actions);
    return box;
  }

  function labelsEditor(t) {
    const box = h("div", "wa-editor");
    let list = (t.config.labelDefs || []).map((x) => ({ ...x }));
    const rows = h("div");
    const drawRows = () => {
      rows.replaceChildren();
      list.forEach((l, i) => {
        const r = h("div", "row wa-label-row");
        const color = h("input");
        color.type = "color";
        color.value = l.color;
        color.oninput = () => (l.color = color.value);
        const name = h("input");
        name.value = l.name;
        name.maxLength = 40;
        name.placeholder = "Nome da etiqueta";
        name.oninput = () => (l.name = name.value);
        const del = h("button", "link", "Remover");
        del.type = "button";
        del.onclick = () => {
          list.splice(i, 1);
          drawRows();
        };
        r.append(color, name, del);
        rows.append(r);
      });
    };
    drawRows();
    const add = h("button", "secondary sm", "Nova etiqueta");
    add.type = "button";
    add.onclick = () => {
      list.push({ id: "l" + Date.now().toString(36), name: "", color: "#607d8b" });
      drawRows();
    };
    const actions = h("div", "row end");
    actions.append(
      add,
      actionButton("Salvar etiquetas", "primary sm", async () => {
        const cfg = await set({ labelDefs: list });
        list = cfg.labelDefs.map((x) => ({ ...x }));
        drawRows();
        toast("Etiquetas salvas.");
      })
    );
    box.append(h("div", "muted small", `${t.labelsUsed || 0} conversa(s) com etiqueta nesta aba.`), rows, actions);
    return box;
  }

  // ---------- Página: Envios (agendadas, em massa, resposta automática) ----------
  const RISK =
    "O WhatsApp proíbe automação e envio em massa nos termos de uso e pode BANIR O NÚMERO, às vezes sem aviso e sem volta. " +
    "O risco cresce com mensagens para quem não tem seu número salvo, textos repetidos e envios rápidos. Use por sua conta e risco.";

  async function renderEnvios(el) {
    const t0 = await load();
    if (!t0) return noTabs(el);
    const redraw = () => {
      stateEls.clear();
      el.replaceChildren();
      draw();
    };
    function draw() {
      const t = cur();
      el.append(h("p", "lead", "Mensagens agendadas, envio em massa e resposta automática. O app precisa estar aberto (pode estar na bandeja) para enviar."), tabPicker(redraw));
      const note = tabNote(t);
      if (note) el.append(note);

      // Agendadas
      el.append(section("Mensagens agendadas"));
      const schedCard = card(sw("scheduled", "Mensagens agendadas", "Envia na hora marcada pelo próprio WhatsApp desta aba. Se o app estiver fechado na hora, envia ao abrir (até 12 h de atraso).", "scheduled", { after: redraw }));
      if (t.config.scheduled) schedCard.append(scheduleForm(t), scheduleList(t));
      el.append(schedCard);

      // Em massa
      el.append(section("Envio em massa"));
      el.append(h("div", "card warn small", "⚠ " + RISK));
      const bulkCard = card(sw("bulk", "Envio em massa", `Até 50 números por vez, com intervalo aleatório entre as mensagens (mínimo de 20 s). Para sozinho depois de 3 falhas seguidas.`, "bulk", { confirm: ["Ligar o envio em massa?", RISK], after: redraw }));
      if (t.config.bulk) bulkCard.append(bulkForm(t));
      el.append(bulkCard);

      // Resposta automática
      el.append(section("Resposta automática"));
      el.append(h("div", "card warn small", "⚠ " + RISK));
      const arCard = card(sw("autoReply", "Resposta automática", "Responde a conversas individuais (nunca grupos) uma vez por período.", "autoReply", { confirm: ["Ligar a resposta automática?", RISK], after: redraw }));
      if (t.config.autoReply) arCard.append(autoReplyForm(t));
      el.append(arCard);
      paintStates(t);
    }
    draw();
    const stop = poll();
    pollHook = (t) => {
      const list = el.querySelector(".wa-sched-list");
      if (list) list.replaceWith(scheduleList(t));
      const prog = el.querySelector(".wa-bulk-progress");
      if (prog) prog.replaceWith(bulkProgress(t));
    };
    return stop;
  }

  function scheduleForm(t) {
    const box = h("div", "wa-editor");
    const mode = h("select");
    for (const [v, l] of [["chat", "Conversa existente"], ["phone", "Número de telefone"]]) {
      const o = h("option", "", l);
      o.value = v;
      mode.append(o);
    }
    const chat = h("select");
    chat.append(h("option", "", "Carregando conversas…"));
    const phone = h("input");
    phone.placeholder = "Número com DDI e DDD (ex.: 5511999998888)";
    phone.hidden = true;
    const loadChats = async () => {
      try {
        const list = await wa("chats", { siteId: t.id });
        chat.replaceChildren();
        for (const c of list) {
          const o = h("option", "", (c.group ? "👥 " : "") + c.name);
          o.value = c.id;
          chat.append(o);
        }
        if (!list.length) chat.append(h("option", "", "Nenhuma conversa encontrada"));
      } catch (err) {
        chat.replaceChildren(h("option", "", "Não carregou: " + err.message));
      }
    };
    loadChats();
    mode.onchange = () => {
      chat.hidden = mode.value !== "chat";
      phone.hidden = mode.value !== "phone";
    };
    const at = h("input");
    at.type = "datetime-local";
    const d = new Date(Date.now() + 3600e3);
    d.setSeconds(0, 0);
    at.value = new Date(d - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
    const text = h("textarea");
    text.rows = 3;
    text.placeholder = "Mensagem";
    const actions = h("div", "row end");
    actions.append(
      actionButton("Agendar", "primary sm", async () => {
        const when = new Date(at.value).getTime();
        const opt = chat.selectedOptions[0];
        const req = { siteId: t.id, at: when, text: text.value };
        if (mode.value === "chat") Object.assign(req, { chatId: opt && opt.value, name: opt && opt.textContent });
        else req.phone = phone.value;
        cur().schedule = await wa("scheduleAdd", req);
        text.value = "";
        const list = document.querySelector(".wa-sched-list");
        if (list) list.replaceWith(scheduleList(cur()));
        toast("Mensagem agendada.");
      })
    );
    const lbl = (text, ...els) => {
      const l = h("label", "", text);
      l.append(...els);
      return l;
    };
    box.append(lbl("Para", mode, chat, phone), lbl("Quando", at), lbl("Mensagem", text), actions);
    return box;
  }

  function scheduleList(t) {
    const box = h("div", "wa-sched-list");
    // Pendentes primeiro (a mais próxima no topo), depois as já tratadas (a mais recente no topo)
    const pend = (t.schedule || []).filter((s) => s.status === "pendente").sort((a, b) => a.at - b.at);
    const rest = (t.schedule || []).filter((s) => s.status !== "pendente").sort((a, b) => (b.doneAt || b.at) - (a.doneAt || a.at));
    const items = [...pend, ...rest];
    if (!items.length) return box;
    box.append(h("div", "section", "Agendadas"));
    for (const s of items) {
      const r = h("div", "wa-sched");
      const head = h("div", "row");
      head.append(h("b", "", s.name || s.phone || s.chatId), h("span", "muted small", when(s.at)));
      const st = h("span", "small " + (s.status === "enviada" ? "ok" : s.status === "falhou" ? "err-inline" : "muted"), s.status + (s.error ? ` · ${s.error}` : ""));
      head.append(st);
      const del = h("button", "link", s.status === "pendente" ? "Cancelar" : "Remover");
      del.type = "button";
      del.onclick = async () => {
        cur().schedule = await wa("scheduleRemove", { siteId: t.id, id: s.id });
        box.replaceWith(scheduleList(cur()));
      };
      head.append(del);
      r.append(head, h("div", "muted small wa-text", s.text));
      box.append(r);
    }
    return box;
  }

  function bulkForm(t) {
    const box = h("div", "wa-editor");
    const nums = h("textarea");
    nums.rows = 4;
    nums.placeholder = "Um número por linha, com DDI e DDD (ex.: 5511999998888)";
    const text = h("textarea");
    text.rows = 3;
    text.placeholder = "Mensagem";
    const minD = h("input");
    minD.type = "number";
    minD.min = "20";
    minD.value = "30";
    const maxD = h("input");
    maxD.type = "number";
    maxD.min = "25";
    maxD.value = "90";
    const delays = h("div", "row");
    const l1 = h("label", "", "Intervalo mínimo (s)");
    l1.append(minD);
    const l2 = h("label", "", "Intervalo máximo (s)");
    l2.append(maxD);
    delays.append(l1, l2);
    const actions = h("div", "row end");
    actions.append(
      actionButton("Parar", "secondary sm", async () => {
        cur().bulkJob = await wa("bulkStop", { siteId: t.id });
        document.querySelector(".wa-bulk-progress").replaceWith(bulkProgress(cur()));
      }),
      actionButton("Iniciar envio", "primary sm", async () => {
        const ok = await confirmDialog("Iniciar o envio em massa?", RISK, "Enviar");
        if (!ok) return;
        cur().bulkJob = await wa("bulkStart", { siteId: t.id, numbers: nums.value, text: text.value, minDelay: Number(minD.value), maxDelay: Number(maxD.value) });
        document.querySelector(".wa-bulk-progress").replaceWith(bulkProgress(cur()));
        toast("Envio em massa iniciado.");
      })
    );
    const lbl = (txt, e) => {
      const l = h("label", "", txt);
      l.append(e);
      return l;
    };
    box.append(lbl("Números", nums), lbl("Mensagem", text), delays, actions, bulkProgress(t));
    return box;
  }

  function bulkProgress(t) {
    const box = h("div", "wa-bulk-progress");
    const j = t.bulkJob;
    if (!j) return box;
    const done = (j.results || []).filter(Boolean).length;
    const ok = (j.results || []).filter((x) => x === "ok").length;
    box.append(h("div", "small", `Último envio: ${j.status} · ${done}/${j.numbers.length} processados · ${ok} enviados · ${done - ok} falhas`));
    const bar = h("div", "progress");
    const fill = h("span");
    fill.style.width = Math.round((100 * done) / j.numbers.length) + "%";
    bar.append(fill);
    box.append(bar);
    const fails = (j.results || []).map((r, i) => (r && r !== "ok" ? `${j.numbers[i]}: ${r}` : null)).filter(Boolean);
    if (fails.length) box.append(h("div", "muted small wa-text", fails.slice(0, 10).join("\n")));
    return box;
  }

  function autoReplyForm(t) {
    const box = h("div", "wa-editor");
    const text = h("textarea");
    text.rows = 3;
    text.value = t.config.autoReplyText || "";
    const cool = h("input");
    cool.type = "number";
    cool.min = "1";
    cool.max = "168";
    cool.value = t.config.autoReplyCooldownHours || 12;
    const l1 = h("label", "", "Mensagem");
    l1.append(text);
    const l2 = h("label", "", "Responder a mesma conversa no máximo a cada (horas)");
    l2.append(cool);
    const away = toggle("Só quando eu não estiver olhando", "Não responde se a janela do app estiver em foco.", t.config.autoReplyOnlyAway, async (on, input) => {
      try {
        await set({ autoReplyOnlyAway: on });
      } catch (err) {
        input.checked = !on;
        toast(err.message, true);
      }
    });
    const actions = h("div", "row end");
    actions.append(
      actionButton("Salvar", "primary sm", async () => {
        await set({ autoReplyText: text.value, autoReplyCooldownHours: Number(cool.value) });
        toast("Resposta automática salva.");
      })
    );
    box.append(l1, l2, away, actions);
    return box;
  }

  // ---------- Página: Mensagens apagadas ----------
  async function renderApagadas(el) {
    const t0 = await load();
    if (!t0) return noTabs(el);
    const redraw = async () => {
      el.replaceChildren();
      await draw();
    };
    async function draw() {
      const t = cur();
      el.append(h("p", "lead", "Mensagens que alguém apagou para todos, guardadas quando \"Guardar mensagens apagadas\" está ligado (Recursos)."), tabPicker(redraw));
      const list = await wa("deleted", { siteId: t.id });
      const head = h("div", "row end");
      if (list.length) {
        head.append(
          actionButton("Apagar o histórico", "secondary sm", async () => {
            if (!(await confirmDialog("Apagar o histórico?", "As mensagens apagadas guardadas desta aba serão removidas.", "Apagar"))) return;
            await wa("deletedClear", { siteId: t.id });
            await redraw();
          })
        );
      }
      el.append(head);
      if (!list.length) {
        el.append(card(h("div", "muted small", t.config.keepDeleted ? "Nenhuma mensagem apagada até agora." : "O recurso está desligado nesta aba.")));
        return;
      }
      for (const m of list) {
        const c = h("div", "card");
        const r = h("div", "row");
        r.append(h("b", "", m.chat || "?"), h("span", "muted small", (m.from && m.from !== m.chat ? m.from + " · " : "") + "apagada " + when(m.at)));
        c.append(r, h("div", "wa-text", m.text));
        el.append(c);
      }
    }
    await draw();
  }

  S.register({
    id: "whatsapp",
    title: "WhatsApp",
    icon: "💬",
    pages: [
      { id: "recursos", title: "Recursos", render: renderRecursos },
      { id: "envios", title: "Agendadas e automação", render: renderEnvios },
      { id: "apagadas", title: "Mensagens apagadas", render: renderApagadas },
    ],
  });
})();
