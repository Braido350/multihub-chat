// Camada 3 da organização: classificador Naive Bayes treinado só neste computador.
// Aprendizado incremental: cada exemplo soma (ou, se o rótulo mudar, subtrai) as contagens das suas palavras.
// As contagens ficam na tabela nb_tokens; os totais por classe, em settings (nb_meta).
const { tx } = require("../db");

const COL = { importante: "imp", propaganda: "prop", outros: "outr" };
const CLASSES = Object.keys(COL);
const MIN_DOCS_TOTAL = 30; // antes disso o modelo não decide nada
const MIN_DOCS_CLASS = 8; // uma classe com menos exemplos que isso não pode ser escolhida pelo modelo

class NaiveBayes {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.load();
  }

  load() {
    this.tokens = new Map(); // token -> {importante, propaganda, outros}
    for (const r of this.db.prepare("SELECT token, imp, prop, outr FROM nb_tokens").all()) {
      this.tokens.set(r.token, { importante: r.imp, propaganda: r.prop, outros: r.outr });
    }
    let meta = null;
    try {
      meta = JSON.parse(this.store.getSetting("nb_meta") || "null");
    } catch {}
    this.docs = { importante: 0, propaganda: 0, outros: 0, ...(meta && meta.docs) };
    this.totals = { importante: 0, propaganda: 0, outros: 0, ...(meta && meta.totals) };
    this.dirty = new Set();
    this.metaDirty = false;
  }

  /** Soma (sign = 1) ou subtrai (sign = -1) um exemplo. */
  update(tokens, label, weight, sign) {
    if (!COL[label] || !weight || !tokens || !tokens.length) return;
    const w = weight * sign;
    for (const t of tokens) {
      let e = this.tokens.get(t);
      if (!e) {
        if (sign < 0) continue;
        e = { importante: 0, propaganda: 0, outros: 0 };
        this.tokens.set(t, e);
      }
      e[label] = Math.max(0, e[label] + w);
      this.dirty.add(t);
    }
    this.docs[label] = Math.max(0, this.docs[label] + w);
    this.totals[label] = Math.max(0, this.totals[label] + w * tokens.length);
    this.metaDirty = true;
  }
  train(tokens, label, weight) {
    this.update(tokens, label, weight, 1);
  }
  untrain(tokens, label, weight) {
    this.update(tokens, label, weight, -1);
  }

  get totalDocs() {
    return CLASSES.reduce((n, c) => n + this.docs[c], 0);
  }

  ready() {
    return this.totalDocs >= MIN_DOCS_TOTAL && CLASSES.filter((c) => this.docs[c] >= MIN_DOCS_CLASS).length >= 2;
  }

  /**
   * Probabilidade de cada classe. Só usa palavras já vistas no treino.
   * A soma dos logs é dividida por √n ("temperatura"): o Naive Bayes puro é confiante demais.
   */
  predict(tokens) {
    if (!this.ready()) return null;
    const V = Math.max(1, this.tokens.size);
    const total = this.totalDocs;
    const known = tokens.filter((t) => this.tokens.has(t));
    if (known.length < 3) return null;
    const T = Math.max(1, Math.sqrt(known.length));
    const logit = {};
    const contrib = {};
    for (const c of CLASSES) {
      const prior = Math.log((this.docs[c] + 1) / (total + CLASSES.length));
      const denom = this.totals[c] + V;
      let ll = 0;
      for (const t of known) ll += Math.log((this.tokens.get(t)[c] + 1) / denom);
      logit[c] = prior + ll / T;
      contrib[c] = denom;
    }
    const max = Math.max(...CLASSES.map((c) => logit[c]));
    const exp = Object.fromEntries(CLASSES.map((c) => [c, Math.exp(logit[c] - max)]));
    const sum = CLASSES.reduce((n, c) => n + exp[c], 0);
    const probs = Object.fromEntries(CLASSES.map((c) => [c, exp[c] / sum]));
    // Classes com poucos exemplos não podem ganhar
    const allowed = CLASSES.filter((c) => this.docs[c] >= MIN_DOCS_CLASS);
    const best = allowed.sort((a, b) => probs[b] - probs[a])[0];
    // Palavras que mais puxaram para a classe escolhida (para explicar a decisão)
    const top = known
      .map((t) => {
        const e = this.tokens.get(t);
        const pIn = (e[best] + 1) / contrib[best];
        const others = CLASSES.filter((c) => c !== best);
        const pOut = others.reduce((n, c) => n + (e[c] + 1) / contrib[c], 0) / others.length;
        return [t, Math.log(pIn / pOut)];
      })
      .filter(([t, v]) => v > 0.4 && !t.startsWith("f:") && !t.endsWith(":#"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t.replace(/^[a-z]:/, ""));
    return { best, p: probs[best], probs, top };
  }

  /** Grava as contagens alteradas (chamado ao fim de cada lote). */
  flush() {
    if (!this.dirty.size && !this.metaDirty) return;
    const up = this.db.prepare(`INSERT INTO nb_tokens (token, imp, prop, outr) VALUES (?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET imp = excluded.imp, prop = excluded.prop, outr = excluded.outr`);
    const del = this.db.prepare("DELETE FROM nb_tokens WHERE token = ?");
    tx(this.db, () => {
      for (const t of this.dirty) {
        const e = this.tokens.get(t);
        if (!e || e.importante + e.propaganda + e.outros <= 1e-9) {
          this.tokens.delete(t);
          del.run(t);
        } else up.run(t, e.importante, e.propaganda, e.outros);
      }
      this.store.setSetting("nb_meta", JSON.stringify({ docs: this.docs, totals: this.totals }));
    });
    this.dirty.clear();
    this.metaDirty = false;
  }

  reset() {
    tx(this.db, () => {
      this.db.exec("DELETE FROM nb_tokens");
      this.store.setSetting("nb_meta", null);
    });
    this.load();
  }

  stats() {
    return {
      ready: this.ready(),
      docs: Object.fromEntries(CLASSES.map((c) => [c, Math.round(this.docs[c] * 10) / 10])),
      vocabulary: this.tokens.size,
    };
  }
}

module.exports = { NaiveBayes, CLASSES };
