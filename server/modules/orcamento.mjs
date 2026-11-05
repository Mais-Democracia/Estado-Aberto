// Módulo "orcamento": /api/orcamento/*  (dados em data/orcamento.db, produzidos por ingest/jobs/orcamento.py)
// Valores em milhões de euros (M€) salvo indicação; Eurostat em M€ ou % do PIB.
export default function register({ one, routes, openData }) {
  const mine = openData("orcamento");
  const q = (sql, ...p) => (mine ? mine.prepare(sql).all(...p) : []);
  const q1 = (sql, ...p) => (mine ? mine.prepare(sql).get(...p) : undefined);
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^\s*\d{3}\s*-\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
  const MINISTRIES = safe(() => {
    const m = openData("ministerios");
    const r = m ? m.prepare("SELECT slug, name FROM ministries ORDER BY ord").all() : [];
    return Object.fromEntries(r.map((x) => [x.slug, x.name]));
  }, {});
  const OE_LAW = { 2027: "#/leis/Proposta%20de%20Lei%7C110%7CXVII" };

  // categorias económicas da despesa do Estado (Quadro "Execução Orçamental do Estado")
  const ECO = [
    ["Despesas com o pessoal", "despesas com o pessoal#d"], ["Aquisição de bens e serviços", "aquisicao de bens e servicos#d"],
    ["Juros e outros encargos", "juros e outros encargos#d"], ["Transferências correntes", "transferencias correntes#d"],
    ["Subsídios", "subsidios#d"], ["Outras despesas correntes", "outras despesas correntes#d"], ["Investimento", "investimento#d"],
    ["Transferências de capital", "transferencias de capital#d"], ["Outras despesas de capital", "outras despesas de capital#d"],
  ];
  const TAX = [
    ["IRS", /\(irs\)|pessoas singulares/i], ["IRC", /\(irc\)|pessoas col/i], ["IVA", /\(iva\)|valor acrescentado/i], ["ISP (produtos petrolíferos)", /petrol/i], ["Imposto do Selo", /^imposto do selo/i],
    ["Tabaco", /tabaco/i], ["IUC", /\(iuc\)|circula/i], ["ISV (veículos)", /\(isv\)|sobre ve[íi]culos/i], ["IABA (álcool)", /alcool|álcool/i],
  ];

  const years = () => q("SELECT year FROM exec_cum WHERE tbl='estado' GROUP BY year HAVING COUNT(DISTINCT month) > 1 ORDER BY year").map((r) => r.year);
  const lastMonth = (y) => q1("SELECT MAX(month) m FROM exec_cum WHERE tbl='estado' AND year=?", y)?.m || null;
  const cum = (tbl, lkey, y, m, measure = "exec") => q1("SELECT value, source_url, edition FROM exec_cum WHERE tbl=? AND lkey=? AND year=? AND month=? AND measure=?", tbl, lkey, y, m, measure);
  const ann = (tbl, lkey, y, kind) => q1("SELECT value, source, source_url FROM annual WHERE tbl=? AND lkey=? AND year=? AND kind=? ORDER BY source DESC LIMIT 1", tbl, lkey, y, kind);
  const monthly = (tbl, lkey, y, measure = "exec") => {
    const rows = q("SELECT month, value FROM exec_cum WHERE tbl=? AND lkey=? AND year=? AND measure=? ORDER BY month", tbl, lkey, y, measure);
    let prev = 0, pm = 0;
    return rows.map((r) => { const o = { month: r.month, cum: r.value, value: r.month === pm + 1 ? r.value - prev : null }; prev = r.value; pm = r.month; return o; });
  };
  const line3 = (tbl, lkey, y, m) => ({
    exec: cum(tbl, lkey, y, m)?.value ?? null, prev: cum(tbl, lkey, y - 1, m)?.value ?? null,
    budget: ann(tbl, lkey, y, "oe_inicial")?.value ?? null, cge: ann(tbl, lkey, y, "cge")?.value ?? null, cgePrev: ann(tbl, lkey, y - 1, "cge")?.value ?? null,
  });
  const programs = () => Object.fromEntries(q("SELECT name, code, ministry FROM programs").map((p) => [norm(p.name), p]));
  const es = (code, unit, ds) => q("SELECT year, value FROM eurostat WHERE dataset=? AND code=? AND unit=? ORDER BY year", ds, code, unit);
  const oeCol = (oe, tbl, rx, lineRx, exclude = /variac|estrutura|sem prr|s\/ prr|prr\b|%/i) => {
    const rows = q("SELECT line, ord, col, colord, value, title, source_url FROM oe_cells WHERE oe=? AND tbl=? ORDER BY ord, colord", oe, tbl);
    const out = [];
    for (const r of rows) if (rx.test(r.col) && !exclude.test(r.col) && (!lineRx || lineRx.test(r.line)) && !out.some((o) => o.ord === r.ord)) out.push(r);
    return out;
  };


  // série longa: por ano, último mês disponível do Estado + orçamento inicial + Eurostat (% PIB)
  function longrun() {
    const ys = years();
    const b9 = Object.fromEntries(es("B9", "PC_GDP", "gov_10dd_edpt1").map((r) => [r.year, r.value]));
    const gd = Object.fromEntries(es("GD", "PC_GDP", "gov_10dd_edpt1").map((r) => [r.year, r.value]));
    return ys.map((y) => {
      const m = lastMonth(y);
      const g = (lk) => cum("estado", lk, y, m)?.value ?? null;
      return { year: y, month: m, receita: g("receita efetiva#r"), despesa: g("despesa efetiva#d"), saldo: g("saldo global#s"),
        budgetDespesa: ann("estado", "despesa efetiva#d", y, "oe_inicial")?.value ?? null, budgetReceita: ann("estado", "receita efetiva#r", y, "oe_inicial")?.value ?? null,
        saldoPIB: b9[y] ?? null, dividaPIB: gd[y] ?? null };
    });
  }
  // CGE: despesa consolidada da Administração Central por ministério (orçamento inicial, final, executado)
  function cgeYear(y) {
    const yy = q1("SELECT MAX(year) y FROM annual WHERE tbl='cge_organica' AND year<=?", y)?.y;
    if (!yy) return null;
    const rows = q("SELECT line, ord, kind, value, source_url FROM annual WHERE tbl='cge_organica' AND year=? ORDER BY ord", yy);
    const out = [];
    for (const r of rows) {
      let o = out.find((x) => x.line === r.line);
      if (!o) { o = { line: r.line, ord: r.ord }; out.push(o); }
      o[r.kind] = r.value; o.source_url = r.source_url;
    }
    const progs = programs();
    const lines = [];
    for (const o of out) {
      if (/^1\./.test(o.line)) break;
      const pr = progs[norm(o.line)] || {};
      lines.push({ ...o, sub: /^\s*(dos|das|do|da) qua/i.test(o.line), ministry: pr.ministry || null, ministryName: MINISTRIES[pr.ministry] || null });
    }
    return { year: yy, lines, total: out.find((o) => /^1\.\s*despesa efetiva/i.test(o.line)) || null, source_url: out[0]?.source_url,
      years: q("SELECT DISTINCT year FROM annual WHERE tbl='cge_organica' ORDER BY year").map((r) => r.year) };
  }
  function checksSummary() {
    const sums = q1("SELECT COUNT(*) n, SUM(ABS(diff_pct) > 0.5) bad, MAX(ABS(diff_pct)) worst FROM checks WHERE kind='soma'") || {};
    const ov = q("SELECT what, year, month, value, expected, diff_pct FROM checks WHERE kind='xls_vs_xlsx' ORDER BY year, month LIMIT 12");
    return { sums, overlap: ov };
  }

  routes["/api/orcamento/overview"] = (p) => {
    if (!mine) return { error: "data/orcamento.db não existe; corra: python3 ingest/run_all.py orcamento" };
    const ys = years();
    const y = Number(p.get("year")) || ys[ys.length - 1];
    const m = lastMonth(y);
    const ed = q1("SELECT * FROM seo_editions WHERE year=? AND month=?", y, m);
    const kp = (lk) => line3("estado", lk, y, m);
    const kpis = { receita: kp("receita efetiva#r"), despesa: kp("despesa efetiva#d"), saldo: kp("saldo global#s"), primario: kp("saldo primario#s"), juros: kp("juros e outros encargos#d") };
    const ap = {};
    for (const meas of ["receita", "despesa", "saldo"]) ap[meas] = { exec: cum("subsetores", "administracoes publicas#1", y, m, meas)?.value ?? null, prev: cum("subsetores", "administracoes publicas#1", y - 1, m, meas)?.value ?? null };
    const subsetores = q("SELECT line, lkey, measure, value FROM exec_cum WHERE tbl='subsetores' AND year=? AND month=? ORDER BY ord", y, m);
    const series = {
      receita: monthly("estado", "receita efetiva#r", y), despesa: monthly("estado", "despesa efetiva#d", y),
      receitaPrev: monthly("estado", "receita efetiva#r", y - 1), despesaPrev: monthly("estado", "despesa efetiva#d", y - 1),
      saldoAP: monthly("subsetores", "administracoes publicas#1", y, "saldo"),
    };
    const eco = ECO.map(([label, lk]) => ({ label, ...line3("estado", lk, y, m) }));
    const taxLines = q("SELECT DISTINCT lkey, line, ord FROM exec_cum WHERE tbl='receita_estado' AND year=? AND month=? ORDER BY ord", y, m);
    const taxes = TAX.map(([label, rx]) => { const l = taxLines.find((t) => rx.test(t.line)); return l ? { label, line: l.line, ...line3("receita_estado", l.lkey, y, m) } : null; }).filter(Boolean);
    const progs = programs();
    const plines = q("SELECT lkey, line, ord, value FROM exec_cum WHERE tbl='programas' AND year=? AND month=? AND measure='exec' ORDER BY ord", y, m);
    let byProgram = plines.filter((r) => /^\s*\d{3}\s*-/.test(r.line)).map((r) => {
      const pr = progs[norm(r.line)] || {};
      const oeProp = ann("programas", r.lkey, y, "oe_proposta");
      return { line: r.line, lkey: r.lkey, exec: r.value, prev: cum("programas", r.lkey, y - 1, m)?.value ?? null, proposta: oeProp?.value ?? null, ministry: pr.ministry || null, ministryName: MINISTRIES[pr.ministry] || null };
    });
    if (!byProgram.length) {           // 2009-2013: quadro antigo "Despesa do Estado por Ministérios" (subsetor Estado)
      for (const r of q("SELECT lkey, line, value FROM exec_cum WHERE tbl='ministerios' AND measure='despesa efetiva' AND year=? AND month=? ORDER BY value DESC", y, m)) {
        const pr = progs[norm(r.line)] || {};
        byProgram.push({ line: r.line, lkey: r.lkey, exec: r.value, prev: q1("SELECT value FROM exec_cum WHERE tbl='ministerios' AND measure='despesa efetiva' AND year=? AND month=? AND lkey=?", y - 1, m, r.lkey)?.value ?? null,
          proposta: null, ministry: pr.ministry || null, ministryName: MINISTRIES[pr.ministry] || null, legacy: true });
      }
    }
    const programsTotal = plines.find((r) => /^total da despesa/i.test(r.line));
    // OE do ano seguinte / em discussão
    const oes = q("SELECT DISTINCT oe FROM oe_cells ORDER BY oe").map((r) => r.oe);
    const cofogY = q1("SELECT MAX(year) y FROM eurostat WHERE dataset='gov_10a_exp' AND unit='MIO_EUR'")?.y;
    const cofog = q("SELECT a.code, a.label, a.value mio, b.value pct FROM eurostat a LEFT JOIN eurostat b ON b.dataset=a.dataset AND b.code=a.code AND b.year=a.year AND b.unit='PC_GDP' WHERE a.dataset='gov_10a_exp' AND a.unit='MIO_EUR' AND a.year=? ORDER BY a.value DESC", cofogY);
    const meta = Object.fromEntries(q("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
    return {
      year: y, month: m, years: ys, edition: ed, kpis, ap, subsetores, series, eco, taxes, byProgram,
      programsTotal: programsTotal ? { exec: programsTotal.value, prev: cum("programas", programsTotal.lkey, y - 1, m)?.value ?? null } : null,
      deficit: { saldo: es("B9", "PC_GDP", "gov_10dd_edpt1"), divida: es("GD", "PC_GDP", "gov_10dd_edpt1"), saldoMio: es("B9", "MIO_EUR", "gov_10dd_edpt1"), dividaMio: es("GD", "MIO_EUR", "gov_10dd_edpt1"), source: "https://ec.europa.eu/eurostat/databrowser/view/gov_10dd_edpt1/default/table" },
      cofog: { year: cofogY, rows: cofog, source: "https://ec.europa.eu/eurostat/databrowser/view/gov_10a_exp/default/table" },
      oes, oeNext: oeSummary(Math.max(...oes, 0)), meta, blocked: q("SELECT * FROM blocked"),
      longrun: longrun(), cge: cgeYear(y), checks: checksSummary(),
    };
  };

  function oeSummary(oe) {
    if (!oe) return null;
    const src = q1("SELECT source_url FROM oe_cells WHERE oe=? LIMIT 1", oe)?.source_url;
    const yr = String(oe);
    const pick = (tbl, rx, lineRx) => oeCol(oe, tbl, rx, lineRx);
    // receita fiscal: coluna do ano do OE vs ano anterior
    const rfNew = pick("receita_fiscal", new RegExp("^" + yr)), rfOld = pick("receita_fiscal", new RegExp("^" + (oe - 1)));
    const taxes = rfNew.map((r) => ({ line: r.line.replace(/^\s*-\s*/, ""), value: r.value, prev: rfOld.find((o) => o.ord === r.ord)?.value ?? null }));
    const progs = programs();
    const programas = pick("programas", new RegExp(yr + ".*Or[çc]amento|^Or[çc]amento", "i")).filter((r) => !/total|subtotal|fluxos|mem[óo]ria|dota|diferen|despesa|ativos/i.test(r.line))
      .map((r) => { const pr = progs[norm(r.line)] || {}; return { line: r.line, value: r.value, ministry: pr.ministry || null, ministryName: MINISTRIES[pr.ministry] || null }; });
    const ecoNew = pick("despesa_ac", new RegExp("^" + yr + ".*Or[çc]amento.*Total|^" + yr + ".*Or[çc]amento$", "i")), ecoOld = pick("despesa_ac", new RegExp("^" + (oe - 1) + ".*Estimativa.*Total|^" + (oe - 1) + ".*Estimativa$", "i"));
    const eco = ecoNew.map((r) => ({ line: r.line, value: r.value, prev: ecoOld.find((o) => o.ord === r.ord)?.value ?? null }));
    const apRows = q("SELECT line, col, value FROM oe_cells WHERE oe=? AND tbl='conta_ap_nac' AND (line LIKE 'Saldo%' OR line LIKE 'Cap.%' OR line LIKE 'Receita total%' OR line LIKE 'Despesa total%') ORDER BY ord, colord", oe);
    const divida = q("SELECT line, col, value FROM oe_cells WHERE oe=? AND tbl='divida' AND line LIKE 'Dívida%' ORDER BY colord", oe);
    const estado = q("SELECT line, value FROM oe_cells WHERE oe=? AND tbl='estado_oe' ORDER BY ord", oe);
    return { oe, source_url: src, law: OE_LAW[oe] || null, taxes, programas, eco, ap: apRows, divida, estado };
  }

  routes["/api/orcamento/oe"] = (p) => (mine ? oeSummary(Number(p.get("oe")) || Math.max(...q("SELECT DISTINCT oe FROM oe_cells").map((r) => r.oe), 0)) || { error: "sem dados" } : { error: "sem dados" });

  routes["/api/orcamento/ministerio"] = (p) => {
    if (!mine) return { error: "sem dados" };
    const slug = p.get("slug");
    const progs = q("SELECT * FROM programs WHERE ministry=?", slug);
    const keys = [...new Set(progs.map((x) => norm(x.name) + "#1"))];
    const ys = years();
    const out = { slug, name: MINISTRIES[slug] || slug, programs: [], entities: [], oeConta: [] };
    if (!keys.length) return { ...out, error: "nenhum programa orçamental associado a este ministério" };
    out.programs = [];
    const ph = keys.map(() => "?").join(",");
    const labels = q(`SELECT lkey, MAX(line) line FROM exec_cum WHERE tbl='programas' AND lkey IN (${ph}) GROUP BY lkey`, ...keys);
    for (const l of labels) {
      const perYear = ys.map((y) => {
        const m = q1("SELECT MAX(month) m FROM exec_cum WHERE tbl='programas' AND lkey=? AND year=?", l.lkey, y)?.m;
        const v = m ? cum("programas", l.lkey, y, m) : null;
        return { year: y, month: m || null, exec: v?.value ?? null, proposta: ann("programas", l.lkey, y, "oe_proposta")?.value ?? null, estimativa: ann("programas", l.lkey, y, "estimativa")?.value ?? null };
      });
      out.programs.push({ lkey: l.lkey, line: l.line, years: perYear, monthly: Object.fromEntries(ys.slice(-3).map((y) => [y, monthly("programas", l.lkey, y)])) });
    }
    // conta de cada programa (classificação económica) nas propostas de OE
    const pl = q("SELECT DISTINCT oe, sheet, title FROM oe_cells WHERE tbl='pl_conta' ORDER BY oe DESC");
    for (const t of pl) {
      const name = (t.title.match(/^Quadro [\d.]+\.?\s*(.*?)\s*\((?:PL|P)\s?\d+\)/) || [])[1];
      if (!name || !progs.some((x) => norm(x.name) === norm(name))) continue;
      const rows = q("SELECT line, ord, col, colord, value FROM oe_cells WHERE oe=? AND sheet=? AND tbl='pl_conta' ORDER BY ord, colord", t.oe, t.sheet);
      const isB = (c) => new RegExp("^" + t.oe + "\\b.*Or[çc]amento", "i").test(c) && !/sem prr|variac|estrutura/i.test(c);
      const isE = (c) => new RegExp("^" + (t.oe - 1) + "\\b.*Estimativa", "i").test(c) && !/sem prr|variac|estrutura/i.test(c);
      const lines = [];
      for (const r of rows) {
        let L = lines.find((x) => x.ord === r.ord);
        if (!L) { if (r.ord > (rows.find((x) => /^despesa total consolidada/i.test(x.line))?.ord ?? 1e9)) break; L = { ord: r.ord, line: r.line, budget: null, estimate: null }; lines.push(L); }
        if (isB(r.col) && L.budget == null) L.budget = r.value;
        if (isE(r.col) && L.estimate == null) L.estimate = r.value;
      }
      out.oeConta.push({ oe: t.oe, program: name, title: t.title, lines });
      if (out.oeConta.filter((x) => x.oe === t.oe).length >= 3) continue;
    }
    // despesa do Estado por ministério 2010-2013 (SEO antiga) e CGE por ministério (2014+)
    const oldNames = q("SELECT name FROM programs WHERE ministry=?", slug).map((x) => x.name);
    const olds = q("SELECT year, month, line, value, source_url FROM exec_cum WHERE tbl='ministerios' AND measure='despesa efetiva' ORDER BY year, month");
    const byY = {};
    for (const r of olds) if (oldNames.includes(r.line)) { const k = r.year + "|" + r.line; if (!byY[k] || byY[k].month < r.month) byY[k] = r; }
    out.oldMinistry = Object.values(byY).sort((a, b) => a.year - b.year);
    const cg = q("SELECT year, line, kind, value, source_url FROM annual WHERE tbl='cge_organica' ORDER BY year, ord").filter((r) => oldNames.includes(r.line) && !/^\s*(dos|das|do|da) qua/i.test(r.line));
    const cgY = {};
    for (const r of cg) { const k = r.year + "|" + r.line; (cgY[k] ||= { year: r.year, line: r.line, source_url: r.source_url })[r.kind] = r.value; }
    out.cge = Object.values(cgY);
    // entidades da Missão de Base Orgânica (OE mais recente com lista)
    const ents = q("SELECT oe, mbo, name, nif, source_url FROM mbo_entities WHERE ministry=? AND oe=(SELECT MAX(oe) FROM mbo_entities) ORDER BY mbo, name LIMIT 600", slug);
    for (const e of ents) e.eid = safe(() => one("SELECT id FROM entities WHERE nif = ?", e.nif)?.id, null) || null;
    out.entities = ents;
    return out;
  };

  // séries mensais genéricas: ?tbl=estado&line=despesa efetiva#1&years=2024,2025,2026&measure=exec  |  ?eurostat=B9&unit=PC_GDP
  routes["/api/orcamento/series"] = (p) => {
    if (!mine) return { error: "sem dados" };
    if (p.get("eurostat")) {
      const ds = p.get("dataset") || (/^GF|TOTAL/.test(p.get("eurostat")) ? "gov_10a_exp" : "gov_10dd_edpt1");
      return { dataset: ds, code: p.get("eurostat"), unit: p.get("unit") || "PC_GDP", values: es(p.get("eurostat"), p.get("unit") || "PC_GDP", ds) };
    }
    const tbl = p.get("tbl") || "estado", lkey = p.get("line") || "despesa efetiva#d", measure = p.get("measure") || "exec";
    const ys = (p.get("years") || "").split(",").map(Number).filter(Boolean);
    const use = ys.length ? ys : years();
    const label = q1("SELECT line FROM exec_cum WHERE tbl=? AND lkey=? LIMIT 1", tbl, lkey)?.line || null;
    return {
      tbl, lkey, label, measure, unit: "M€ (acumulado jan-mês e valor do mês)",
      years: Object.fromEntries(use.slice(0, 10).map((y) => [y, { monthly: monthly(tbl, lkey, y, measure), budget: ann(tbl, lkey, y, "oe_inicial")?.value ?? null, cge: ann(tbl, lkey, y, "cge")?.value ?? null }])),
      lines: q("SELECT DISTINCT lkey, line FROM exec_cum WHERE tbl=? ORDER BY ord LIMIT 200", tbl),
    };
  };
}
