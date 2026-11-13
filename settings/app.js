// Configurações › Aplicativo › Atualizações: versão instalada, "Verificar atualizações", progresso do download,
// instalar a versão baixada e a URL do latest.json. O trabalho é do processo principal (updater/).
"use strict";
(() => {
  const S = window.Settings;
  const { h, toast, toggle, actionButton, when } = S;
  const shell = window.appShell;
  if (!shell || !shell.update) return;

  const KIND = {
    "linux-appimage": "AppImage (Linux)",
    "win-dir": "instalado (Windows)",
  };
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  let onStatus = null; // página aberta recebe o progresso
  shell.onUpdateStatus((st) => onStatus && onStatus(st));

  async function renderAtualizacoes(el) {
    let info = await shell.update("status");
    el.append(
      h("p", "lead", "O app procura versões novas ao abrir e a cada 6 horas."),
    );

    const statusCard = h("div", "card");
    el.append(statusCard);

    function draw(st) {
      statusCard.replaceChildren();
      const head = h("div", "row");
      head.append(h("h3", "", `Versão instalada: ${info.version}`));
      head.append(
        h(
          "span",
          "muted small",
          st.kind ? KIND[st.kind] || st.kind : "modo de desenvolvimento",
        ),
      );
      statusCard.append(head);

      let text = "";
      let bar = null;
      switch (st.state) {
        case "checking":
          text = "Verificando…";
          break;
        case "downloading":
          text =
            `Baixando a versão ${st.version}…` +
            (st.total
              ? ` ${mb(st.received || 0)} de ${mb(st.total)}`
              : st.received
                ? ` ${mb(st.received)}`
                : "");
          if (st.total) {
            bar = h("div", "progress");
            const fill = h("span");
            fill.style.width =
              Math.round((100 * (st.received || 0)) / st.total) + "%";
            bar.append(fill);
          }
          break;
        case "verifying":
          text = `Conferindo a versão ${st.version} (SHA-256)…`;
          break;
        case "ready":
          text = st.installable
            ? `Versão ${st.version} baixada e conferida. Será instalada na próxima vez que você abrir o app (ou agora, pelo botão abaixo).`
            : `Versão ${st.version} baixada e conferida.`;
          break;
        case "installing":
          text = "Preparando a atualização… o app vai fechar e abrir de novo.";
          break;
        case "uptodate":
          text = `Você está na versão mais recente (${st.latest}).`;
          break;
        case "unconfigured":
          text = st.message;
          break;
        case "error":
          text = `Não foi possível atualizar: ${st.message}`;
          break;
        default:
          text = "Ainda não verificado nesta sessão.";
      }
      const line = h("div", st.state === "error" ? "err" : "muted", text);
      line.setAttribute("role", "status");
      statusCard.append(line);
      if (bar) statusCard.append(bar);
      if (st.at && st.state !== "idle")
        statusCard.append(
          h(
            "div",
            "muted small",
            `Última atualização deste status: ${when(st.at)}`,
          ),
        );

      if (st.state === "ready" && st.notes) {
        const notes = h("pre", "notes", st.notes);
        notes.style.whiteSpace = "pre-wrap";
        notes.style.font = "inherit";
        notes.style.margin = "10px 0 0";
        statusCard.append(notes);
      }
      if (st.state === "ready" && !st.installable)
        statusCard.append(
          h(
            "div",
            "muted small",
            st.reason ||
              "Esta instalação não pode ser atualizada automaticamente.",
          ),
        );

      const row = h("div", "row end");
      const busy = [
        "checking",
        "downloading",
        "verifying",
        "installing",
      ].includes(st.state);
      const check = actionButton(
        "Verificar atualizações",
        "secondary",
        async () => {
          const r = await shell.update("check");
          draw(r);
          if (r.state === "uptodate") toast("Nenhuma versão nova.");
        },
      );
      check.disabled = busy;
      row.append(check);
      if (st.state === "ready" && st.installable) {
        row.append(
          actionButton("Atualizar agora", "primary", async () => {
            await shell.update("install");
          }),
        );
      }
      statusCard.append(row);
    }

    // Verificação automática (o endereço do latest.json vem do package.json › multihub.updateUrl)
    const cfgCard = h("div", "card");
    cfgCard.append(
      toggle(
        "Verificar automaticamente",
        "Ao abrir o app e a cada 6 horas.",
        info.config.auto,
        async (on) => {
          info.config = await shell.update("config", { auto: on });
        },
      ),
    );
    el.append(cfgCard);

    const logCard = h("div", "card");
    logCard.append(h("h3", "", "Registro"));
    logCard.append(
      h(
        "div",
        "muted small",
        `Tudo o que o atualizador faz fica em ${info.logFile}`,
      ),
    );
    const lrow = h("div", "row end");
    lrow.append(
      actionButton("Abrir pasta do registro", "secondary sm", () =>
        shell.update("log"),
      ),
    );
    logCard.append(lrow);
    el.append(logCard);

    draw(info.status);
    onStatus = draw;
    return () => (onStatus = null);
  }

  // Configurações › Aplicativo › Desempenho: registro gravado a cada segundo pelo processo principal (perflog.js)
  async function renderDesempenho(el) {
    el.append(
      h(
        "p",
        "lead",
        "O app grava a cada segundo a memória e o processador de cada site, a memória livre do computador e o " +
          "atraso do app (lag), guardando só os últimos 5 minutos. Lag alto (⚠lento / ⚠TRAVOU) indica travamento. " +
          "Quando notar lentidão, copie o registro logo em seguida e envie para o suporte.",
      ),
    );

    const card = h("div", "card");
    const summary = h("div", "muted small", "Carregando…");
    const pre = h("pre");
    Object.assign(pre.style, {
      maxHeight: "50vh",
      overflow: "auto",
      margin: "10px 0 0",
      padding: "8px 10px",
      fontSize: "11.5px",
      lineHeight: "1.45",
      whiteSpace: "pre",
      background: "rgba(127,127,127,.08)",
      borderRadius: "8px",
    });
    const row = h("div", "row end");
    row.append(
      actionButton("Abrir pasta", "secondary sm", () => shell.perf("folder")),
      actionButton("Limpar registro", "secondary sm", async () => {
        await shell.perf("clear");
        toast("Registro apagado.");
        refresh();
      }),
      actionButton("Copiar registro", "primary sm", async () => {
        const r = await shell.perf("copy");
        toast(`Copiado: ${r.lines} linhas (${(r.bytes / 1048576).toFixed(1)} MB).`);
      }),
    );
    card.append(h("h3", "", "Registro de desempenho"), summary, pre, row);
    el.append(card);

    let follow = true; // rola junto se o usuário estiver no fim
    pre.addEventListener("scroll", () => {
      follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    });

    async function refresh() {
      let r;
      try {
        r = await shell.perf("recent");
      } catch {
        return;
      }
      summary.textContent =
        `Gravando em ${r.file} · maior atraso nesta sessão: ${r.maxLag} ms · ` +
        `${r.lines.length} linhas guardadas (só os últimos 5 minutos).`;
      pre.textContent = r.lines.join("\n");
      if (follow) pre.scrollTop = pre.scrollHeight;
    }
    await refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }

  S.register({
    id: "app",
    title: "Aplicativo",
    icon: "⚙",
    pages: [
      { id: "atualizacoes", title: "Atualizações", render: renderAtualizacoes },
      ...(shell.perf ? [{ id: "desempenho", title: "Desempenho", render: renderDesempenho }] : []),
    ],
  });
})();
