// Camada 2 da organização: reputação por remetente e por domínio, aprendida do seu histórico.
// É recalculada a partir do banco (agregados), então é sempre coerente e não precisa de "desfazer":
//  - o que você moveu entre grupos (o sinal mais forte);
//  - os rótulos de treino das mensagens anteriores (regras de alta confiança e sinais de uso);
//  - abertura, resposta e "apagou ou arquivou sem abrir".
const { FREEMAIL, NAME } = require("./rules");

const CATS = ["importante", "propaganda", "outros"];

function best(counts) {
  const total = CATS.reduce((n, c) => n + (counts[c] || 0), 0);
  if (!total) return null;
  const cat = CATS.reduce((a, c) => ((counts[c] || 0) > (counts[a] || 0) ? c : a), CATS[0]);
  return { cat, n: counts[cat], total, share: counts[cat] / total };
}

class Reputation {
  /**
   * @param {Array} rows  store.senderStats(): por endereço, {addr, n, opened, replied, ignored, l_*, m_*}
   * @param {Set} myDomains  domínios das suas contas (não viram reputação de domínio)
   */
  constructor(rows = [], myDomains = new Set()) {
    this.byAddr = new Map();
    this.byDom = new Map();
    for (const r of rows) {
      const e = {
        n: r.n || 0,
        opened: r.opened || 0,
        replied: r.replied || 0,
        ignored: r.ignored || 0,
        labels: { importante: r.l_imp || 0, propaganda: r.l_prop || 0, outros: r.l_out || 0 },
        manual: { importante: r.m_imp || 0, propaganda: r.m_prop || 0, outros: r.m_out || 0 },
      };
      this.byAddr.set(r.addr, e);
      const dom = String(r.addr).split("@")[1] || "";
      if (!dom || FREEMAIL.has(dom) || myDomains.has(dom)) continue;
      const d = this.byDom.get(dom) || { n: 0, labels: { importante: 0, propaganda: 0, outros: 0 }, manual: { importante: 0, propaganda: 0, outros: 0 } };
      d.n += e.n;
      for (const c of CATS) {
        d.labels[c] += e.labels[c];
        d.manual[c] += e.manual[c];
      }
      this.byDom.set(dom, d);
    }
  }

  /** Atalho por correções suas: 2 movimentos coerentes do mesmo remetente (3 do mesmo domínio). */
  manual(addr) {
    const a = this.byAddr.get(addr);
    const m = a && best(a.manual);
    if (m && m.total >= 2 && m.share >= 0.9) {
      return { category: m.cat, confidence: 95, reason: `Você moveu ${m.total} e-mails deste remetente para ${NAME[m.cat]}` };
    }
    const dom = String(addr).split("@")[1] || "";
    const d = this.byDom.get(dom);
    const dm = d && best(d.manual);
    if (dm && dm.total >= 3 && dm.share >= 0.9) {
      return { category: dm.cat, confidence: 90, reason: `Você moveu ${dm.total} e-mails de @${dom} para ${NAME[dm.cat]}` };
    }
    return null;
  }

  /** Atalho pelo histórico: poucos casos coerentes do remetente (ou muitos do domínio) decidem. */
  history(addr) {
    const a = this.byAddr.get(addr);
    if (a) {
      if (a.replied >= 2) return { category: "importante", confidence: 88, reason: `Você já respondeu ${a.replied} e-mails deste remetente` };
      const l = best(a.labels);
      if (l && l.total >= 3 && l.share >= 0.9) {
        return { category: l.cat, confidence: Math.min(95, 70 + 5 * l.total), reason: `${l.total} e-mails anteriores deste remetente foram ${NAME[l.cat]}` };
      }
      if (a.ignored >= 3 && a.ignored / Math.max(1, a.n) >= 0.6 && !a.replied) {
        const prop = a.labels.propaganda > 0;
        return {
          category: prop ? "propaganda" : "outros",
          confidence: prop ? 86 : 75,
          reason: `Você costuma apagar ou arquivar sem abrir (${a.ignored} de ${a.n})`,
        };
      }
    }
    const dom = String(addr).split("@")[1] || "";
    const d = this.byDom.get(dom);
    const dl = d && best(d.labels);
    if (dl && dl.total >= 6 && dl.share >= 0.9) {
      return { category: dl.cat, confidence: Math.min(90, 60 + 4 * dl.total), reason: `${dl.total} e-mails anteriores de @${dom} foram ${NAME[dl.cat]}` };
    }
    return null;
  }

  /** Você abre quase tudo desse remetente: o modelo sozinho não deve mandá-lo para Propaganda. */
  engaged(addr) {
    const a = this.byAddr.get(addr);
    return !!a && a.n >= 5 && a.opened / a.n >= 0.8;
  }

  /** Quantos remetentes/domínios já têm atalho (para as estatísticas). */
  shortcuts() {
    let n = 0;
    for (const addr of this.byAddr.keys()) if (this.manual(addr) || this.history(addr)) n++;
    return n;
  }
}

module.exports = { Reputation };
