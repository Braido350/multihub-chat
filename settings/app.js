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
    el.append(h("p", "lead", "O app procura versões novas ao abrir e a cada 6 horas. A versão nova é baixada em segundo plano, conferida (SHA-256) e instalada sozinha na próxima vez que você abrir o app. Seus dados, contas e configurações ficam fora da pasta do app e são mantidos."));

    const statusCard = h("div", "card");
    el.append(statusCard);

    function draw(st) {
      statusCard.replaceChildren();
      const head = h("div", "row");
      head.append(h("h3", "", `Versão instalada: ${info.version}`));
      head.append(h("span", "muted small", st.kind ? KIND[st.kind] || st.kind : "modo de desenvolvimento"));
      statusCard.append(head);

      let text = "";
      let bar = null;
      switch (st.state) {
        case "checking":
          text = "Verificando…";
          break;
        case "downloading":
          text = `Baixando a versão ${st.version}…` + (st.total ? ` ${mb(st.received || 0)} de ${mb(st.total)}` : st.received ? ` ${mb(st.received)}` : "");
          if (st.total) {
            bar = h("div", "progress");
            const fill = h("span");
            fill.style.width = Math.round((100 * (st.received || 0)) / st.total) + "%";
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
      if (st.at && st.state !== "idle") statusCard.append(h("div", "muted small", `Última atualização deste status: ${when(st.at)}`));

      if (st.state === "ready" && st.notes) {
        const notes = h("pre", "notes", st.notes);
        notes.style.whiteSpace = "pre-wrap";
        notes.style.font = "inherit";
        notes.style.margin = "10px 0 0";
        statusCard.append(notes);
      }
      if (st.state === "ready" && !st.installable) statusCard.append(h("div", "muted small", st.reason || "Esta instalação não pode ser atualizada automaticamente."));

      const row = h("div", "row end");
      const busy = ["checking", "downloading", "verifying", "installing"].includes(st.state);
      const check = actionButton("Verificar atualizações", "secondary", async () => {
        const r = await shell.update("check");
        draw(r);
        if (r.state === "uptodate") toast("Nenhuma versão nova.");
      });
      check.disabled = busy;
      row.append(check);
      if (st.state === "ready" && st.installable) {
        row.append(
          actionButton("Atualizar agora", "primary", async () => {
            await shell.update("install");
          })
        );
      }
      statusCard.append(row);
    }

    // Endereço do latest.json e verificação automática
    const cfgCard = h("div", "card");
    cfgCard.append(h("h3", "", "Onde procurar"));
    cfgCard.append(h("div", "muted small", "Endereço do latest.json publicado no GitHub Releases (ex.: https://github.com/usuario/repositorio/releases/latest/download/latest.json)."));
    const url = h("input");
    url.type = "url";
    url.placeholder = "https://github.com/…/releases/latest/download/latest.json";
    url.value = info.config.url || "";
    url.spellcheck = false;
    url.setAttribute("aria-label", "Endereço do latest.json");
    url.style.marginTop = "8px";
    const row = h("div", "row end");
    row.append(
      actionButton("Salvar endereço", "secondary sm", async () => {
        info.config = await shell.update("config", { url: url.value });
        toast("Endereço salvo.");
      })
    );
    cfgCard.append(url, row);
    cfgCard.append(
      toggle("Verificar automaticamente", "Ao abrir o app e a cada 6 horas.", info.config.auto, async (on) => {
        info.config = await shell.update("config", { auto: on });
      })
    );
    el.append(cfgCard);

    const logCard = h("div", "card");
    logCard.append(h("h3", "", "Registro"));
    logCard.append(h("div", "muted small", `Tudo o que o atualizador faz fica em ${info.logFile}`));
    const lrow = h("div", "row end");
    lrow.append(actionButton("Abrir pasta do registro", "secondary sm", () => shell.update("log")));
    logCard.append(lrow);
    el.append(logCard);

    draw(info.status);
    onStatus = draw;
    return () => (onStatus = null);
  }

  S.register({
    id: "app",
    title: "Aplicativo",
    icon: "⚙",
    pages: [{ id: "atualizacoes", title: "Atualizações", render: renderAtualizacoes }],
  });
})();
