// Módulo "empresas_locais": empresas municipais/intermunicipais (Sector Empresarial Local).
// Dados: data/empresas_locais.db (ingest/jobs/empresas_locais.py); contratos lidos ao vivo de politica.db (só leitura).
export default function register({ db, all, one, has, routes, openData }) {
  const mine = openData("empresas_locais");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const meta = (k) => { const r = q1("SELECT value FROM meta WHERE key=?", k); try { return r ? JSON.parse(r.value) : r?.value ?? null; } catch { return r ? r.value : null; } };
  const missing = () => ({ available: false, note: "A base data/empresas_locais.db ainda não foi gerada (python3 ingest/run_all.py empresas_locais)." });
  const eid = (nif) => (nif && has("entities") ? safe(() => one("SELECT id FROM entities WHERE nif = ?", nif))?.id ?? null : null);
  const common = () => ({ selNote: meta("sel_note"), built: meta("built"), stats: meta("stats"), errors: meta("errors"), blocked: meta("blocked"), sources: meta("sources") });
  const SORTS = { valor: "seller_value DESC", nome: "name COLLATE NOCASE", contratos: "seller_contracts DESC", recente: "last_signed DESC", comprador: "buyer_value DESC" };

  routes["/api/empresas_locais/overview"] = () => {
    if (!mine) return missing();
    const k = q1(`SELECT COUNT(*) n, SUM(scope='intermunicipal') inter, SUM(status='em liquidação') liq, SUM(n_admins>0) with_admins,
      SUM(seller_value) seller_value, SUM(seller_contracts) seller_contracts, SUM(buyer_value) buyer_value, SUM(buyer_contracts) buyer_contracts,
      SUM(registry_kind='empresa_municipal') reg_em, SUM(registry_kind<>'empresa_municipal') reg_other FROM company`);
    const own = q1("SELECT COUNT(DISTINCT company_id) n_owned, COUNT(DISTINCT dico) n_munis FROM owner");
    const conf = q1("SELECT COUNT(DISTINCT CASE WHEN confidence='média' THEN company_id END) n_owned_med, COUNT(DISTINCT CASE WHEN company_id NOT IN (SELECT company_id FROM owner WHERE confidence='média') THEN company_id END) n_owned_low FROM owner");
    const idle = q1("SELECT COUNT(*) n FROM company WHERE buyer_contracts=0 AND seller_contracts=0").n;
    const ownByMethod = qa("SELECT CASE WHEN method LIKE 'nome (%' THEN 'nome' WHEN method LIKE 'nome%' THEN 'fragmento' ELSE 'cliente' END m, COUNT(DISTINCT company_id) n FROM owner GROUP BY 1");
    const mu = q1(`SELECT SUM(muni_to_companies_value) v, SUM(muni_to_companies_contracts) n, SUM(excluded_value) ev, SUM(excluded_contracts) en,
      SUM(muni_buyer_value) tv FROM muni WHERE n_companies>0`);
    const nm = q1("SELECT COUNT(*) n FROM muni").n;
    const bySector = qa("SELECT sector, COUNT(*) n, SUM(seller_value) value FROM company GROUP BY 1 ORDER BY n DESC");
    const byForm = qa("SELECT legal_form, COUNT(*) n FROM company GROUP BY 1 ORDER BY n DESC");
    const top = qa("SELECT id, nif, name, sector, legal_form, seller_contracts, seller_value, seller_to_owner_value FROM company ORDER BY seller_value DESC LIMIT 15").map((r) => ({ ...r, owners: qa("SELECT municipality, dico FROM owner WHERE company_id=?", r.id) }));
    const topMunis = qa("SELECT dico, name, n_companies, companies_seller_value, muni_to_companies_value, muni_buyer_value, share_pct FROM muni WHERE n_companies>0 ORDER BY muni_to_companies_value DESC LIMIT 15");
    const topShare = qa("SELECT dico, name, n_companies, muni_to_companies_value, muni_buyer_value, share_pct FROM muni WHERE n_companies>0 AND muni_buyer_value>=1000000 ORDER BY share_pct DESC LIMIT 15");
    const sel = qa("SELECT year, SUM(n_entities) n_entities, SUM(employees) employees, SUM(financial_result) result, SUM(total_debt) debt, SUM(n_entities>0) munis_with FROM sel_muni GROUP BY year ORDER BY year");
    const setores = qa("SELECT DISTINCT sector FROM company ORDER BY sector").map((r) => r.sector);
    return { available: true, kpis: { ...k, ...own, ...conf, idle, munis_med: q1("SELECT COUNT(*) n FROM muni WHERE n_companies_certain>0").n, municipios: nm, munis_with_companies: q1("SELECT COUNT(*) n FROM muni WHERE n_companies>0").n, muni_to_companies_value: mu.v, muni_to_companies_contracts: mu.n, excluded_value: mu.ev, excluded_contracts: mu.en },
      ownByMethod, bySector, byForm, top, topMunis, topShare, sel, setores, ...common() };
  };

  routes["/api/empresas_locais/lista"] = (p) => {
    if (!mine) return missing();
    const page = Math.max(1, +p.get("page") || 1), limit = 40;
    const w = [], a = [];
    const qq = (p.get("q") || "").trim();
    if (qq) { w.push("(name LIKE ? OR nif = ?)"); a.push(`%${qq}%`, qq); }
    const c = p.get("concelho");
    if (c) { w.push("id IN (SELECT company_id FROM owner WHERE dico = ?)"); a.push(c); }
    const s = p.get("setor"); if (s) { w.push("sector = ?"); a.push(s); }
    const f = p.get("forma"); if (f) { w.push("legal_form LIKE ?"); a.push(f + "%"); }
    if (p.get("semdono")) w.push("id NOT IN (SELECT company_id FROM owner)");
    const where = w.length ? "WHERE " + w.join(" AND ") : "";
    const sort = SORTS[p.get("sort")] || SORTS.valor;
    const total = q1(`SELECT COUNT(*) n FROM company ${where}`, ...a).n;
    const rows = qa(`SELECT id, nif, name, legal_form, scope, sector, status, seller_contracts, seller_value, buyer_contracts, buyer_value, last_signed, n_admins, owner_method FROM company ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...a, limit, (page - 1) * limit)
      .map((r) => ({ ...r, owners: qa("SELECT dico, municipality, method, confidence FROM owner WHERE company_id=?", r.id) }));
    return { available: true, total, page, limit, rows };
  };

  routes["/api/empresas_locais/empresa"] = (p) => {
    if (!mine) return missing();
    const c = p.get("id") ? q1("SELECT * FROM company WHERE id=?", +p.get("id")) : q1("SELECT * FROM company WHERE nif=?", p.get("nif") || "");
    if (!c) return { available: true, found: false };
    const owners = qa("SELECT dico, municipality, pct, method, confidence, evidence FROM owner WHERE company_id=?", c.id);
    const admins = qa("SELECT holder, role, board, begin_date, end_date, match_method, source_url FROM admin WHERE company_id=? ORDER BY (end_date IS NULL OR end_date='') DESC, begin_date DESC", c.id);
    const years = qa("SELECT year, role, n, value FROM company_year WHERE company_id=? ORDER BY year", c.id);
    const ownerNifs = owners.map((o) => q1("SELECT nif FROM muni WHERE dico=?", o.dico)?.nif).filter(Boolean);
    const ents = safe(() => ({
      buyers: all("SELECT buyer_nif nif, buyer_name name, COUNT(*) n, SUM(price) value FROM contracts WHERE seller_nif=? GROUP BY 1,2 ORDER BY value DESC LIMIT 10", c.nif),
      sellers: all("SELECT seller_nif nif, seller_name name, COUNT(*) n, SUM(price) value FROM contracts WHERE buyer_nif=? GROUP BY 1,2 ORDER BY value DESC LIMIT 10", c.nif),
      procs: all("SELECT procedure, COUNT(*) n, SUM(price) value FROM contracts WHERE seller_nif=? GROUP BY 1 ORDER BY value DESC LIMIT 8", c.nif),
    }), { buyers: [], sellers: [], procs: [] });
    const withEid = (arr) => arr.map((r) => ({ ...r, entity_id: eid(r.nif) }));
    const fromOwner = ownerNifs.length ? safe(() => all(`SELECT id, signed, object, procedure, price, buyer_name, link FROM contracts WHERE seller_nif=? AND buyer_nif IN (${ownerNifs.map(() => "?").join(",")}) ORDER BY price DESC LIMIT 25`, c.nif, ...ownerNifs), []) : [];
    const asSeller = safe(() => all("SELECT id, signed, object, procedure, price, buyer_name, buyer_nif, link FROM contracts WHERE seller_nif=? ORDER BY signed DESC LIMIT 25", c.nif), []);
    const asBuyer = safe(() => all("SELECT id, signed, object, procedure, price, seller_name, seller_nif, link FROM contracts WHERE buyer_nif=? ORDER BY signed DESC LIMIT 25", c.nif), []);
    return { available: true, found: true, company: { ...c, entity_id: c.entity_id ?? eid(c.nif) },
      owners: owners.map((o) => ({ ...o, entity_id: eid(q1("SELECT nif FROM muni WHERE dico=?", o.dico)?.nif) })),
      admins, years, buyers: withEid(ents.buyers), sellers: withEid(ents.sellers), procs: ents.procs, fromOwner, asSeller, asBuyer, ...common() };
  };

  routes["/api/empresas_locais/concelho"] = (p) => {
    if (!mine) return missing();
    const dico = p.get("dico") || (p.get("nif") ? q1("SELECT dico FROM muni WHERE nif=?", p.get("nif"))?.dico : null);
    const m = dico ? q1("SELECT * FROM muni WHERE dico=?", dico) : null;
    if (!m) return { available: true, found: false };
    const companies = qa(`SELECT c.id, c.nif, c.name, c.legal_form, c.sector, c.seller_contracts, c.seller_value, c.seller_to_owner_value, c.last_signed, c.n_admins, o.method, o.confidence
      FROM owner o JOIN company c ON c.id=o.company_id WHERE o.dico=? ORDER BY c.seller_value DESC`, dico);
    const sel = qa("SELECT year, n_entities, employees, financial_result, total_debt, source_url FROM sel_muni WHERE dico=? ORDER BY year", dico);
    return { available: true, found: true, muni: m, companies, sel, entity_id: eid(m.nif), ...common() };
  };
}
