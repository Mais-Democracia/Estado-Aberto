// Sinais de risco na contratação pública (indicadores explicáveis; não são acusações).
// Dados: data/risco.db (ingest/jobs/risco.py). Rotas: /api/risco/overview, /entities, /entity, /contract, /top.
export default function register({ db, all, one, num, routes, openData }) {
  const mine = openData("risco");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const missing = () => ({ available: false, note: "A base data/risco.db ainda não foi gerada (python3 ingest/run_all.py risco)." });
  const J = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
  const meta = (k) => { const r = mine && q1("SELECT value FROM meta WHERE key=?", k); return r ? J(r.value) : null; };
  let defsCache = null;
  const defs = () => (defsCache ||= Object.fromEntries(qa("SELECT * FROM flag_defs").map((d) => [d.flag, d])));
  const ents = (nifs) => {
    nifs = [...new Set(nifs.filter(Boolean))];
    if (!nifs.length) return new Map();
    const out = new Map();
    for (let i = 0; i < nifs.length; i += 500) {
      const chunk = nifs.slice(i, i + 500);
      for (const e of all(`SELECT id, nif, name, kind FROM entities WHERE nif IN (${chunk.map(() => "?").join(",")})`, ...chunk)) out.set(e.nif, e);
    }
    return out;
  };
  const contractsById = (ids) => {
    ids = [...new Set(ids.filter(Boolean))];
    if (!ids.length) return new Map();
    return new Map(all(`SELECT id, signed, object, procedure, price, buyer_nif, buyer_name, seller_nif, seller_name, n_bidders, cpv_code, legal_basis
                        FROM contracts WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).map((c) => [c.id, c]));
  };
  const withNames = (rows, keys) => {
    const m = ents(rows.flatMap((r) => keys.map((k) => r[k])));
    return rows.map((r) => { const o = { ...r }; for (const k of keys) { const e = m.get(r[k]); o[k + "_name"] = e?.name ?? o[k + "_name"] ?? null; o[k + "_id"] = e?.id ?? null; o[k + "_kind"] = e?.kind ?? null; } return o; });
  };
  // ids das evidências (contratos citados dentro do JSON) -> objeto/data para a UI
  const evidenceContracts = (rows) => {
    const ids = [];
    for (const r of rows) for (const k of ["contratos", "anteriores", "procedimentos", "exemplos"]) { const arr = r.evidence?.[k]; if (Array.isArray(arr)) for (const x of arr) if (Array.isArray(x)) ids.push(String(x[0])); }
    const m = contractsById(ids.slice(0, 400));
    return Object.fromEntries([...m].map(([id, c]) => [id, { signed: c.signed, object: (c.object || "").slice(0, 160), price: c.price, seller_name: c.seller_name, buyer_name: c.buyer_name }]));
  };
  let ovCache = null;

  routes["/api/risco/overview"] = () => {
    if (!mine) return missing();
    if (ovCache) return ovCache;
    const byYear = qa("SELECT year, flag, COUNT(*) n, SUM(CASE WHEN price>0 THEN price END) value FROM contract_flags GROUP BY year, flag ORDER BY year");
    const kinds = qa("SELECT kind, COUNT(*) n FROM entity_risk WHERE role='comprador' GROUP BY kind ORDER BY n DESC");
    // distribuição em intervalos explícitos sobre os pesos reais (sem truncar: 0,25 não é "0")
    const totalContracts = meta("national")?.contratos ?? one("SELECT COUNT(*) n FROM contracts").n;
    const sd = q1(`SELECT COUNT(*) flagged, SUM(score > 0 AND score < 1) b0, SUM(score >= 1 AND score < 2) b1, SUM(score >= 2 AND score < 3) b2, SUM(score >= 3) b3 FROM contract_score`);
    const scoreDist = {
      total_contracts: totalContracts, flagged: sd.flagged, unflagged: totalContracts - sd.flagged,
      buckets: [
        { range: "0", label: "0 (sem bandeiras)", n: totalContracts - sd.flagged },
        { range: ">0-<1", label: "> 0 e < 1", n: sd.b0 },
        { range: "1-<2", label: "1 a < 2", n: sd.b1 },
        { range: "2-<3", label: "2 a < 3", n: sd.b2 },
        { range: ">=3", label: "≥ 3", n: sd.b3 },
      ],
    };
    ovCache = {
      available: true, version: meta("version"), built: meta("built"), anuncios: meta("anuncios"), params: meta("params"), thresholds: meta("thresholds"), national: meta("national"), counts: meta("counts"),
      flags: Object.values(defs()), byYear, kinds, scoreDist,
      years: qa("SELECT DISTINCT year FROM contract_score WHERE year IS NOT NULL ORDER BY year DESC").map((r) => r.year),
    };
    return ovCache;
  };

  routes["/api/risco/entities"] = (q) => {
    if (!mine) return missing();
    const page = num(q.get("page"), 1), limit = 30, off = (page - 1) * limit;
    const role = q.get("role") === "fornecedor" ? "fornecedor" : "comprador";
    const kind = q.get("kind") || "", flag = (q.get("flag") || "").replace(/[^A-Z0-9_]/g, ""), year = q.get("year") ? num(q.get("year"), 0, 2000, 2100) : null;
    const sort = { score: "score DESC, value DESC", value: "value DESC", flagged: "n_flagged_contracts DESC", n: "n_contracts DESC" }[q.get("sort")] || "score DESC, n_flagged_contracts DESC";
    const where = ["role = ?"], p = [role];
    if (kind) { where.push("kind = ?"); p.push(kind); }
    if (flag && defs()[flag]?.level === "entidade") { where.push("flags_json LIKE ?"); p.push(`%"flag": "${flag}"%`); }
    let rows, total, note = null;
    const lvl = flag ? defs()[flag]?.level : null;
    const col = role === "comprador" ? "buyer_nif" : "seller_nif", kcol = role === "comprador" ? "buyer_kind" : "seller_kind";
    const attach = (agg) => {   // junta a linha entity_risk (se existir) a cada NIF da página
      const er = new Map(agg.length ? qa(`SELECT * FROM entity_risk WHERE role = ? AND nif IN (${agg.map(() => "?").join(",")})`, role, ...agg.map((r) => r.nif)).map((r) => [r.nif, r]) : []);
      const em = ents(agg.map((r) => r.nif));
      return agg.map((r) => ({ ...(er.get(r.nif) || { nif: r.nif, role, name: em.get(r.nif)?.name, kind: em.get(r.nif)?.kind, score: null, flags_json: "[]" }),
        n_flagged_period: r.n_flagged, period_score: r.ssum == null ? null : Math.round(r.ssum * 100) / 100, flagged_value: r.fvalue ?? null }));
    };
    if (lvl === "par") {
      // pares: filtro de tipo em SQL (pair_flags.buyer_kind / seller_kind); ano não se aplica (padrões de todo o período)
      const w2 = ["flag = ?", `${col} IS NOT NULL`], p2 = [flag];
      if (kind) { w2.push(`${kcol} = ?`); p2.push(kind); }
      total = q1(`SELECT COUNT(DISTINCT ${col}) n FROM pair_flags WHERE ${w2.join(" AND ")}`, ...p2).n;
      rows = attach(qa(`SELECT ${col} nif, COUNT(*) n_flagged, SUM(weight) ssum FROM pair_flags WHERE ${w2.join(" AND ")} GROUP BY ${col} ORDER BY ssum DESC, n_flagged DESC, ${col} LIMIT ? OFFSET ?`, ...p2, limit, off));
      if (year) note = "Os padrões de pares são calculados sobre todo o período; o filtro de ano não se aplica.";
    } else if (lvl === "contrato" || (year && lvl !== "entidade")) {
      // contratos assinalados (todas as bandeiras ou uma bandeira de contrato), filtros de tipo e ano em SQL
      const src = lvl === "contrato" ? "contract_flags" : "contract_score";
      const w2 = [`${col} IS NOT NULL`], p2 = [];
      if (lvl === "contrato") { w2.push("flag = ?"); p2.push(flag); }
      if (year) { w2.push("year = ?"); p2.push(year); }
      if (kind) { w2.push(`${kcol} = ?`); p2.push(kind); }
      total = q1(`SELECT COUNT(DISTINCT ${col}) n FROM ${src} WHERE ${w2.join(" AND ")}`, ...p2).n;
      rows = attach(qa(`SELECT ${col} nif, COUNT(*) n_flagged, SUM(${src === "contract_score" ? "score" : "weight"}) ssum, SUM(CASE WHEN price>0 THEN price END) fvalue
                        FROM ${src} WHERE ${w2.join(" AND ")} GROUP BY ${col} ORDER BY ssum DESC, ${col} LIMIT ? OFFSET ?`, ...p2, limit, off));
    } else {
      if (year && lvl === "entidade") note = "As bandeiras de entidade são calculadas sobre todo o período 2012–2026; o filtro de ano não se aplica.";
      total = q1(`SELECT COUNT(*) n FROM entity_risk WHERE ${where.join(" AND ")}`, ...p).n;
      rows = qa(`SELECT * FROM entity_risk WHERE ${where.join(" AND ")} ORDER BY ${sort}, nif LIMIT ? OFFSET ?`, ...p, limit, off);
    }
    const em = ents(rows.map((r) => r.nif));
    rows = rows.map((r) => { const f = J(r.flags_json, []); delete r.flags_json; r.context = J(r.context_json); delete r.context_json; return { ...r, entity_id: em.get(r.nif)?.id ?? null, name: r.name || em.get(r.nif)?.name || null, kind: r.kind || em.get(r.nif)?.kind || null, flags: f.map((x) => ({ flag: x.flag, weight: x.weight, label: x.label, evidence: x.evidence })) }; });
    return { total, page, limit, role, rows, note };
  };

  routes["/api/risco/entity"] = (q) => {
    if (!mine) return missing();
    const nif = (q.get("nif") || "").trim();
    if (!nif) return { error: "nif em falta" };
    const roles = qa("SELECT * FROM entity_risk WHERE nif = ?", nif).map((r) => ({ ...r, flags: J(r.flags_json, []), flags_json: undefined, context: J(r.context_json), context_json: undefined }));
    const ctxRow = q1("SELECT * FROM entity_context WHERE nif = ?", nif);
    const context = ctxRow ? J(ctxRow.context_json) : null;
    const asBuyer = qa("SELECT flag, COUNT(*) n, SUM(CASE WHEN price>0 THEN price END) value FROM contract_flags WHERE buyer_nif = ? GROUP BY flag ORDER BY n DESC", nif);
    const asSeller = qa("SELECT flag, COUNT(*) n, SUM(CASE WHEN price>0 THEN price END) value FROM contract_flags WHERE seller_nif = ? GROUP BY flag ORDER BY n DESC", nif);
    const pairs = withNames(qa("SELECT * FROM pair_flags WHERE buyer_nif = ? OR seller_nif = ? ORDER BY weight DESC, n_contracts DESC LIMIT 60", nif, nif), ["buyer_nif", "seller_nif"])
      .map((r) => ({ ...r, evidence: J(r.evidence_json), evidence_json: undefined }));
    const top = qa(`SELECT * FROM contract_score WHERE buyer_nif = ? AND score >= 1 ORDER BY score DESC, price DESC LIMIT 15`, nif)
      .concat(qa(`SELECT * FROM contract_score WHERE seller_nif = ? AND buyer_nif != ? AND score >= 1 ORDER BY score DESC, price DESC LIMIT 10`, nif, nif));
    const cm = contractsById(top.map((r) => r.contract_id));
    const fl = top.length ? qa(`SELECT contract_id, flag, weight, evidence_json FROM contract_flags WHERE contract_id IN (${top.map(() => "?").join(",")})`, ...top.map((r) => r.contract_id)) : [];
    const contracts = top.map((r) => ({ ...r, ...(cm.get(r.contract_id) || {}), flagRows: fl.filter((f) => f.contract_id === r.contract_id).map((f) => ({ flag: f.flag, weight: f.weight, evidence: J(f.evidence_json) })) }));
    return { nif, version: meta("version"), context, roles, asBuyer, asSeller, pairs, contracts, defs: defs(), evidence: evidenceContracts(contracts.flatMap((c) => c.flagRows).concat(pairs)) };
  };

  routes["/api/risco/contract"] = (q) => {
    if (!mine) return missing();
    const id = q.get("id");
    const rows = qa("SELECT flag, weight, evidence_json FROM contract_flags WHERE contract_id = ?", id).map((r) => ({ flag: r.flag, weight: r.weight, evidence: J(r.evidence_json), def: defs()[r.flag] }));
    const s = q1("SELECT score, flags FROM contract_score WHERE contract_id = ?", id);
    const c = one("SELECT * FROM contracts WHERE id = ?", id) || null;
    return { id, contract: c, score: s?.score ?? 0, flags: rows, evidence: evidenceContracts(rows) };
  };

  routes["/api/risco/top"] = (q) => {
    if (!mine) return missing();
    const flag = (q.get("flag") || "").replace(/[^A-Z0-9_]/g, "");
    const d = defs()[flag];
    const page = num(q.get("page"), 1), limit = num(q.get("limit"), 20, 1, 100), off = (page - 1) * limit;
    const year = q.get("year") ? num(q.get("year"), 0, 2000, 2100) : null, kind = q.get("kind") || "";
    if (!flag) {   // contratos com maior pontuação composta
      const w = ["1=1"], p = [];
      if (year) { w.push("year = ?"); p.push(year); }
      if (kind) { w.push("buyer_kind = ?"); p.push(kind); }
      const total = q1(`SELECT COUNT(*) n FROM contract_score WHERE ${w.join(" AND ")}`, ...p).n;
      const rows = qa(`SELECT * FROM contract_score WHERE ${w.join(" AND ")} ORDER BY score DESC, price DESC, contract_id LIMIT ? OFFSET ?`, ...p, limit, off);
      const cm = contractsById(rows.map((r) => r.contract_id));
      const fl = rows.length ? qa(`SELECT contract_id, flag, weight, evidence_json FROM contract_flags WHERE contract_id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.contract_id)) : [];
      const out = rows.map((r) => ({ ...r, ...(cm.get(r.contract_id) || {}), flagRows: fl.filter((f) => f.contract_id === r.contract_id).map((f) => ({ flag: f.flag, weight: f.weight, evidence: J(f.evidence_json) })) }));
      return { level: "contrato", flag: null, page, limit, total, rows: out, evidence: evidenceContracts(out.flatMap((c) => c.flagRows)) };
    }
    if (!d) return { error: "bandeira desconhecida", flags: Object.keys(defs()) };
    if (d.level === "par") {
      const w = ["flag = ?"], p = [flag];
      if (kind) { w.push("buyer_kind = ?"); p.push(kind); }   // tipo do comprador; ano não se aplica a padrões de todo o período
      const rows = withNames(qa(`SELECT * FROM pair_flags WHERE ${w.join(" AND ")} ORDER BY n_contracts DESC, value DESC, buyer_nif, seller_nif LIMIT ? OFFSET ?`, ...p, limit, off), ["buyer_nif", "seller_nif"])
        .map((r) => ({ ...r, evidence: J(r.evidence_json), evidence_json: undefined }));
      const total = q1(`SELECT COUNT(*) n FROM pair_flags WHERE ${w.join(" AND ")}`, ...p).n;
      return { level: "par", flag, def: d, page, limit, total, rows, evidence: evidenceContracts(rows), note: year ? "Padrões de todo o período: o filtro de ano não se aplica." : null };
    }
    if (d.level === "entidade") {
      const w = ["flags_json LIKE ?"], p = [`%"flag": "${flag}"%`];
      if (kind) { w.push("kind = ?"); p.push(kind); }
      const total = q1(`SELECT COUNT(*) n FROM entity_risk WHERE ${w.join(" AND ")}`, ...p).n;
      const rows = qa(`SELECT * FROM entity_risk WHERE ${w.join(" AND ")} ORDER BY score DESC, nif LIMIT ? OFFSET ?`, ...p, limit, off)
        .map((r) => { const f = J(r.flags_json, []); return { ...r, flags_json: undefined, flags: f, this: f.find((x) => x.flag === flag) }; });
      const em = ents(rows.map((r) => r.nif));
      return { level: "entidade", flag, def: d, page, limit, total, rows: rows.map((r) => ({ ...r, entity_id: em.get(r.nif)?.id ?? null })), note: year ? "Bandeiras de entidade de todo o período: o filtro de ano não se aplica." : null };
    }
    const w = ["flag = ?"], p = [flag];
    if (year) { w.push("year = ?"); p.push(year); }
    if (kind) { w.push("buyer_kind = ?"); p.push(kind); }
    const rows = qa(`SELECT * FROM contract_flags WHERE ${w.join(" AND ")} ORDER BY price DESC, contract_id LIMIT ? OFFSET ?`, ...p, limit, off);
    const total = q1(`SELECT COUNT(*) n FROM contract_flags WHERE ${w.join(" AND ")}`, ...p).n;
    const cm = contractsById(rows.map((r) => r.contract_id));
    const out = rows.map((r) => ({ ...r, ...(cm.get(r.contract_id) || {}), evidence: J(r.evidence_json), evidence_json: undefined }));
    return { level: "contrato", flag, def: d, page, limit, total, rows: out, evidence: evidenceContracts(out) };
  };
}
