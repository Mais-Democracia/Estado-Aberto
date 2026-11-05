// Módulo "regioes": /api/regioes/*  (dados em data/regioes.db, produzidos por ingest/jobs/regioes.py)
export default function register({ one, routes, openData }) {
  const mine = openData("regioes");
  const q = (sql, ...p) => (mine ? mine.prepare(sql).all(...p) : []);
  const q1 = (sql, ...p) => (mine ? mine.prepare(sql).get(...p) : undefined);
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const REG = { acores: "Região Autónoma dos Açores", madeira: "Região Autónoma da Madeira" };
  const reg = (p) => { const r = String(p.get("regiao") || "acores").toLowerCase(); return REG[r] ? r : "acores"; };
  const NOT = { error: "data/regioes.db não existe; corra: python3 ingest/run_all.py regioes" };
  const eids = (nifs) => {
    const out = {};
    for (const n of new Set(nifs.filter(Boolean))) { const r = safe(() => one("SELECT id FROM entities WHERE nif = ?", n)); if (r) out[n] = r.id; }
    return out;
  };
  const PHASE = {
    GAPR_PublicadoEncerr: "Encerrada: publicada", GAPR_FechoRejeit: "Encerrada: rejeitada", GAPR_Caducada: "Caducada", GAPR_Retirada: "Retirada",
    GAPR_EncerrVoto: "Encerrada: votada", GP_AgendPlenário: "Agendada para Plenário", SEAC_ParecerComissão: "Em parecer na comissão",
    SEAC_DiscussEspec: "Em discussão na especialidade", GP_VotFinGlobal: "Aguarda votação final global",
  };
  const spendBySec = (r) => {
    const m = {};
    for (const s of q("SELECT * FROM c_secretaria WHERE region = ?", r)) m[s.secretaria_key] = s;
    return m;
  };

  routes["/api/regioes/overview"] = (p) => {
    if (!mine) return NOT;
    const r = reg(p);
    const region = q1("SELECT * FROM regions WHERE id = ?", r) || { id: r, name: REG[r] };
    const members = q("SELECT * FROM members WHERE region = ? AND current = 1 ORDER BY ord", r);
    const groups = q("SELECT * FROM groups WHERE region = ? ORDER BY seats DESC", r);
    const seats = groups.reduce((a, g) => a + g.seats, 0);
    const lastEl = q1("SELECT max(year) y FROM elections WHERE region = ?", r)?.y;
    const winner = lastEl ? q1("SELECT party, abbr, pct, seats FROM elections WHERE region = ? AND year = ? ORDER BY votes DESC LIMIT 1", r, lastEl) : null;
    const dlr = q("SELECT substr(date,1,4) y, count(*) n FROM acts WHERE region = ? GROUP BY y ORDER BY y DESC LIMIT 6", r);
    const budget = q("SELECT year, scope, amount FROM budget WHERE region = ? AND scope IN ('despesa_total','receita_corrente_capital') ORDER BY year DESC", r);
    const ct = q1("SELECT sum(n) n, sum(value) v, sum(direct_n) dn, sum(direct_value) dv FROM c_year WHERE region = ?", r) || {};
    const nb = q1("SELECT count(*) n FROM c_buyer WHERE region = ?", r)?.n || 0;
    return {
      region, members, groups, seats, last_election: lastEl, winner, dlr_per_year: dlr, budget,
      contracts: { n: ct.n || 0, value: ct.v || 0, direct_n: ct.dn || 0, direct_value: ct.dv || 0, buyers: nb },
      counts: {
        bodies: q1("SELECT count(*) n FROM bodies WHERE region = ? AND current = 1", r).n,
        secretarias: q1("SELECT count(*) n FROM secretarias WHERE region = ?", r).n,
        initiatives: q1("SELECT count(*) n FROM initiatives WHERE region = ?", r).n,
        acts: q1("SELECT count(*) n FROM acts WHERE region = ?", r).n,
      },
      blocked: q("SELECT topic, source, reason FROM blocked WHERE region = ? OR region IS NULL", r),
      built_at: q1("SELECT value FROM meta WHERE key = 'built_at'")?.value,
    };
  };

  routes["/api/regioes/governo"] = (p) => {
    if (!mine) return NOT;
    const r = reg(p);
    const spend = spendBySec(r);
    const budget = q("SELECT year, secretaria_key, code, name, amount, source_url FROM budget WHERE region = ? AND scope = 'despesa_departamento' ORDER BY year DESC, code", r);
    const sfa = q("SELECT year, secretaria_key, code, name, amount FROM budget WHERE region = ? AND scope = 'sfa' ORDER BY year DESC, amount DESC", r);
    const secretarias = q("SELECT * FROM secretarias WHERE region = ? ORDER BY CASE key WHEN 'pres' THEN 0 WHEN 'vice' THEN 1 ELSE 2 END, ord", r);
    const bodies = q("SELECT * FROM bodies WHERE region = ? ORDER BY secretaria_key, CASE kind WHEN 'direcao_regional' THEN 0 WHEN 'instituto' THEN 1 WHEN 'empresa' THEN 2 ELSE 3 END, name", r);
    // dedup por (secretaria, nome) mantendo a linha com titular
    const seen = new Map();
    for (const b of bodies) {
      const k = b.secretaria_key + "|" + b.name.toLowerCase().slice(0, 30) + "|" + b.current;
      if (!seen.has(k) || (b.holder && !seen.get(k).holder)) seen.set(k, b);
    }
    const bySec = {};
    for (const b of seen.values()) (bySec[b.secretaria_key || "?"] ||= []).push(b);
    for (const s of secretarias) {
      s.bodies = bySec[s.key] || [];
      s.spend = spend[s.key] || null;
      s.budget = budget.filter((x) => x.secretaria_key === s.key);
    }
    const members = q("SELECT * FROM members WHERE region = ? ORDER BY current DESC, ord", r);
    return {
      region: q1("SELECT * FROM regions WHERE id = ?", r), secretarias, members,
      crosscheck: q("SELECT * FROM crosscheck WHERE region = ?", r),
      budget, sfa, blocked: q("SELECT topic, source, reason FROM blocked WHERE (region = ? OR region IS NULL) AND topic IN ('governo (fonte oficial)','governo (Wikipedia)','orçamento','execução orçamental e dívida')", r),
      budget_acts: q("SELECT * FROM budget_acts WHERE region = ? ORDER BY year DESC", r),
      budget_totals: q("SELECT year, scope, name, amount, source_url, note FROM budget WHERE region = ? AND scope IN ('despesa_total','receita_corrente_capital','sfa_total') ORDER BY year DESC, scope", r),
    };
  };

  routes["/api/regioes/assembleia"] = (p) => {
    if (!mine) return NOT;
    const r = reg(p);
    const kind = p.get("kind") || "dlr"; // dlr | todas
    const lim = Math.min(200, Math.max(1, Number(p.get("limit")) || 40));
    const off = Math.max(0, Number(p.get("offset")) || 0);
    const kinds = kind === "todas" ? "" : "AND kind LIKE '%Decreto Legislativo%'";
    const ini = q(`SELECT * FROM initiatives WHERE region = ? ${kinds} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`, r, lim, off);
    for (const i of ini) i.phase_label = PHASE[i.phase] || (i.result ? i.result : i.phase) || null;
    const total = q1(`SELECT count(*) n FROM initiatives WHERE region = ? ${kinds}`, r).n;
    const byType = q("SELECT kind, legislature, count(*) n FROM initiatives WHERE region = ? GROUP BY kind, legislature ORDER BY n DESC LIMIT 40", r);
    const deputies = q("SELECT name, full_name, party, circle, role, status, source_url FROM deputies WHERE region = ? ORDER BY CASE status WHEN 'em funções' THEN 0 ELSE 1 END, party, name", r);
    const elections = q("SELECT * FROM elections WHERE region = ? ORDER BY year DESC, votes DESC", r);
    const el = {};
    const meta = Object.fromEntries(q("SELECT * FROM elections_meta WHERE region = ?", r).map((m) => [m.year, m]));
    for (const e of elections) (el[e.year] ||= { year: e.year, source_url: e.source_url, source: e.source, meta: meta[e.year] || null, rows: [] }).rows.push(e);
    const years = q("SELECT substr(date,1,4) y, count(*) n FROM acts WHERE region = ? GROUP BY y ORDER BY y", r);
    return {
      region: q1("SELECT * FROM regions WHERE id = ?", r),
      groups: q("SELECT * FROM groups WHERE region = ? ORDER BY seats DESC", r),
      deputies,
      circles: q("SELECT circle, count(*) n FROM deputies WHERE region = ? AND status = 'em funções' GROUP BY circle ORDER BY n DESC", r),
      committees: q("SELECT * FROM committees WHERE region = ?", r),
      agenda: q("SELECT * FROM agenda WHERE region = ?", r),
      initiatives: ini, initiatives_total: total, initiatives_by_type: byType,
      elections: Object.values(el).sort((a, b) => b.year - a.year),
      election_check: q("SELECT * FROM election_check WHERE region = ? AND votes_mai IS NOT NULL AND (abs(dvotes) > 0 OR dpp > 0.1) ORDER BY year DESC, abs(dvotes) DESC", r),
      election_check_n: q1("SELECT count(*) n, sum(abs(pct_wp - pct_valid_mai) > 0.1) base_diff FROM election_check WHERE region = ? AND votes_mai IS NOT NULL", r),
      dlr_per_year: years,
      acts: q("SELECT number, date, title, summary, url FROM acts WHERE region = ? ORDER BY date DESC LIMIT 25", r),
      blocked: q("SELECT topic, source, reason FROM blocked WHERE (region = ? OR region IS NULL) AND topic IN ('deputados','comissões e agenda','círculos','eleições (fonte oficial)')", r),
    };
  };

  routes["/api/regioes/contratos"] = (p) => {
    if (!mine) return NOT;
    const r = reg(p);
    const grp = p.get("grupo") || null;
    const years = q("SELECT year, n, value, direct_n, direct_value FROM c_year WHERE region = ? AND year >= 2012 ORDER BY year", r);
    const tot = years.reduce((a, y) => ({ n: a.n + y.n, value: a.value + y.value, dn: a.dn + y.direct_n, dv: a.dv + y.direct_value }), { n: 0, value: 0, dn: 0, dv: 0 });
    const groups = q("SELECT * FROM c_group WHERE region = ? ORDER BY value DESC", r);
    const buyers = q(`SELECT * FROM c_buyer WHERE region = ? ${grp ? "AND grp = ?" : ""} ORDER BY value DESC LIMIT 25`, ...(grp ? [r, grp] : [r]));
    const secs = q("SELECT c.*, s.name FROM c_secretaria c LEFT JOIN secretarias s ON s.region = c.region AND s.key = c.secretaria_key WHERE c.region = ? ORDER BY c.value DESC", r);
    const sups = q("SELECT * FROM c_supplier WHERE region = ? ORDER BY value DESC LIMIT 20", r);
    const procs = q("SELECT * FROM c_proc WHERE region = ? ORDER BY value DESC LIMIT 8", r);
    const ids = eids([...buyers.map((b) => b.nif), ...sups.map((s) => s.nif)]);
    for (const b of buyers) b.eid = ids[b.nif] || null;
    for (const s of sups) s.eid = ids[s.nif] || null;
    return {
      total: tot, years, groups, buyers, secretarias: secs, suppliers: sups, procedures: procs, n_buyers: q1("SELECT count(*) n FROM c_buyer WHERE region = ?", r).n,
      method: q1("SELECT value FROM meta WHERE key = 'contracts_method'")?.value,
    };
  };
}
