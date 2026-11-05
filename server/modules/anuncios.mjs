// Anúncios de concurso (Portal BASE / IMPIC): transparência ANTES do contrato.
// Dados: data/anuncios.db (ingest/jobs/anuncios.py). Rotas: /api/anuncios/overview, /search, /buyer, /flags, /contract.
// Indicadores estatísticos, não acusações: cada linha traz a evidência e a comparação com pares do mesmo entities.kind.
export default function register({ all, one, routes, openData }) {
  const mine = openData("anuncios");
  const qa = (sql, ...p) => mine.prepare(sql).all(...p);
  const q1 = (sql, ...p) => mine.prepare(sql).get(...p);
  const J = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
  const missing = () => ({ available: false, note: "A base data/anuncios.db ainda não foi gerada (python3 ingest/run_all.py anuncios)." });
  const KINDS = ["prazo_curto", "sem_anuncio", "sem_contrato", "preco_base", "vencedor_repetido"];
  const DEFS = {
    prazo_curto: { label: "Prazos de propostas curtos", unit: "concursos com prazo curto",
      what: "Parte dos concursos públicos (não urgentes) do comprador cujo prazo entre a publicação do anúncio e o limite de propostas é igual ou inferior ao percentil 10 do mesmo tipo (bens/serviços ou empreitadas) e do mesmo regime (anúncios até 2017 / desde 2018-01-01, porque a distribuição dos prazos tem uma quebra nítida em 2018). Por construção ~10% dos concursos de cada regime ficam abaixo; a taxa em causa compara o comprador com os pares." },
    sem_anuncio: { label: "Concursos sem anúncio associado", unit: "contratos por concurso sem anúncio",
      what: "Contratos adjudicados por procedimento concorrencial (concurso público, limitado, negociação) desde 2013 cujo registo no BASE não indica nenhum anúncio (campo vazio) ou indica um número inexistente nos dados. Excluídas as referências anteriores a 2012 e as que existem com outro NIF de comprador (ambíguas). Atenção: entidades dos setores especiais (água, energia, transportes) e serviços partilhados podem seguir regras de publicidade próprias, o que explica parte dos casos." },
    sem_contrato: { label: "Anúncios sem contrato publicado", unit: "anúncios sem contrato ligado",
      what: "Procedimentos anunciados há mais de ~13 meses sem nenhum contrato ligado no BASE (mesmo número de anúncio e mesmo NIF). Pode significar procedimento deserto, revogado, repetido com novo anúncio, adjudicação ainda por publicar ou falha de ligação — não prova irregularidade." },
    preco_base: { label: "Adjudicação exatamente ao preço base", unit: "contratos ao preço base",
      what: "Contratos de procedimento concorrencial cujo anúncio tem um só contrato e nenhum lote e em que o preço contratual é igual ao preço base do anúncio. É normal com um único concorrente ou preço fixado pelo caderno de encargos; só é invulgar em comparação com pares." },
    vencedor_repetido: { label: "Vencedor repetido em procedimentos anunciados", unit: "procedimentos ganhos pelo mesmo fornecedor",
      what: "Quota de procedimentos anunciados do comprador ganhos pelo fornecedor mais frequente, comparada com a mediana de compradores do mesmo tipo e escalão de volume. Fornecedores especializados ou mercados pequenos produzem quotas altas sem irregularidade." },
  };
  let ovCache = null;

  const ents = (nifs) => {
    nifs = [...new Set(nifs.filter(Boolean))];
    const out = new Map();
    for (let i = 0; i < nifs.length; i += 500) {
      const c = nifs.slice(i, i + 500);
      for (const e of all(`SELECT id, nif, name, kind FROM entities WHERE nif IN (${c.map(() => "?").join(",")})`, ...c)) out.set(e.nif, e);
    }
    return out;
  };

  routes["/api/anuncios/overview"] = () => {
    if (!mine) return missing();
    if (ovCache) return ovCache;
    const ov = J(q1("SELECT value FROM meta WHERE key='overview'")?.value, {});
    const ds = J(q1("SELECT value FROM meta WHERE key='dataset'")?.value, {});
    const files = qa("SELECT year, n_records FROM source_files ORDER BY year");
    const flagCounts = Object.fromEntries(qa("SELECT kind, COUNT(*) n FROM flags GROUP BY kind").map((r) => [r.kind, r.n]));
    const kinds = qa("SELECT kind, COUNT(*) n FROM buyer_stats WHERE kind IS NOT NULL AND n_tender>=? GROUP BY kind ORDER BY n DESC", ov.min_n || 10);
    ovCache = { available: true, ...ov, dataset: ds, files, defs: DEFS, flagCounts, kinds, procedures: qa("SELECT procedure p, COUNT(*) n FROM announcements WHERE is_primary=1 GROUP BY 1 ORDER BY 2 DESC").map((r) => [r.p, r.n]) };
    return ovCache;
  };

  routes["/api/anuncios/search"] = (q) => {
    if (!mine) return missing();
    const page = Math.max(1, +q.get("page") || 1), limit = 25;
    const w = ["a.is_primary=1"], p = [];
    const text = (q.get("q") || "").trim();
    if (text) { w.push("(a.description LIKE ? OR a.buyer_name LIKE ?)"); p.push(`%${text}%`, `%${text}%`); }
    const buyer = (q.get("buyer") || "").trim();
    if (buyer) { if (/^\d{9}$/.test(buyer)) { w.push("a.buyer_nif=?"); p.push(buyer); } else { w.push("a.buyer_name LIKE ?"); p.push(`%${buyer}%`); } }
    const cpv = (q.get("cpv") || "").replace(/\D/g, "");
    if (cpv) { w.push("a.cpv_code LIKE ?"); p.push(`${cpv}%`); }
    const year = +q.get("year"); if (year) { w.push("a.year=?"); p.push(year); }
    const proc = q.get("procedure"); if (proc) { w.push("a.procedure=?"); p.push(proc); }
    const st = q.get("status");
    if (st === "followed") w.push("a.n_contracts>0"); else if (st === "unfollowed") w.push("a.unfollowed=1"); else if (st === "short") w.push("a.short=1");
    const where = w.join(" AND ");
    const total = q1(`SELECT COUNT(*) n FROM announcements a WHERE ${where}`, ...p).n;
    const rows = qa(`SELECT a.id, a.n_anuncio, a.published, a.buyer_nif, a.buyer_name, a.buyer_kind, a.buyer_entity_id, a.location, a.procedure, a.contract_types, a.base_price,
        a.prazo_dias, a.deadline, a.cpv_code, a.cpv_desc, a.description, a.n_lotes, a.url, a.n_contracts, a.contract_value, a.first_contract_id, a.unfollowed, a.ok_deadline, a.short, a.obras, a.tipo_acto, a.n_amend
        FROM announcements a WHERE ${where} ORDER BY a.published DESC, a.id DESC LIMIT ? OFFSET ?`, ...p, limit, (page - 1) * limit);
    const m = ents(rows.map((r) => r.buyer_nif));
    for (const r of rows) { const e = m.get(r.buyer_nif); r.entity_id = e?.id ?? null; r.entity_name = e?.name ?? null; }
    return { available: true, total, page, limit, rows };
  };

  routes["/api/anuncios/contract"] = (q) => {
    if (!mine) return missing();
    const id = q.get("id");
    const l = q1("SELECT * FROM contract_links WHERE contract_id=?", id);
    if (!l) return { available: true, link: null, noann: q1("SELECT * FROM contracts_no_ann WHERE contract_id=?", id) || null };
    return { available: true, link: l, announcement: q1("SELECT * FROM announcements WHERE id=?", l.announcement_id) };
  };

  routes["/api/anuncios/buyer"] = (q) => {
    if (!mine) return missing();
    const nif = (q.get("nif") || "").trim();
    const s = q1("SELECT * FROM buyer_stats WHERE nif=?", nif);
    if (!s) return { available: true, found: false };
    const flags = qa("SELECT * FROM flags WHERE nif=? ORDER BY kind", nif).map((f) => ({ ...f, evidence: J(f.evidence, {}) }));
    const peers = s.kind ? q1(`SELECT COUNT(*) n, SUM(n_tender) tenders, SUM(n_dl) dl, SUM(dl_short) dls, SUM(n_comp) comp, SUM(n_noann) noann, SUM(n_at_base) atb, SUM(n_base_cmp) bcmp,
        SUM(n_unfollowed) unf, SUM(n_eligible_unf) elig FROM buyer_stats WHERE kind=? AND n_tender>=1`, s.kind) : null;
    const dlMed = s.kind ? qa("SELECT dl_median FROM buyer_stats WHERE kind=? AND n_dl>=10 AND dl_median IS NOT NULL ORDER BY dl_median", s.kind).map((r) => r.dl_median) : [];
    const byYear = qa(`SELECT year, COUNT(*) n, SUM(is_tender) tenders, SUM(n_contracts>0 AND is_tender=1) followed, SUM(unfollowed) unfollowed, SUM(base_price) base
        FROM announcements WHERE buyer_nif=? AND is_primary=1 GROUP BY year ORDER BY year`, nif);
    const recent = qa(`SELECT id, n_anuncio, published, procedure, base_price, prazo_dias, ok_deadline, short, obras, n_contracts, contract_value, first_contract_id, unfollowed, description, url, cpv_code
        FROM announcements WHERE buyer_nif=? AND is_primary=1 ORDER BY published DESC LIMIT 15`, nif);
    const noann = qa(`SELECT contract_id, signed, price, procedure, reason, announcement_ref, seller_name, object FROM contracts_no_ann WHERE buyer_nif=? AND reason<>'anterior_2012' ORDER BY signed DESC LIMIT 15`, nif);
    return { available: true, found: true, stats: s, flags, defs: DEFS, peers, peer_dl_median: dlMed.length ? dlMed[Math.floor(dlMed.length / 2)] : null, peer_dl_n: dlMed.length, byYear, recent, noann };
  };

  routes["/api/anuncios/flags"] = (q) => {
    if (!mine) return missing();
    const kind = KINDS.includes(q.get("kind")) ? q.get("kind") : "prazo_curto";
    const page = Math.max(1, +q.get("page") || 1), limit = 20;
    const w = ["kind=?"], p = [kind];
    const ek = q.get("ekind"); if (ek) { w.push("ekind=?"); p.push(ek); }
    const where = w.join(" AND ");
    const total = q1(`SELECT COUNT(*) n FROM flags WHERE ${where}`, ...p).n;
    const rows = qa(`SELECT * FROM flags WHERE ${where} ORDER BY z DESC LIMIT ? OFFSET ?`, ...p, limit, (page - 1) * limit).map((f) => ({ ...f, evidence: J(f.evidence, {}) }));
    const m = ents(rows.map((r) => r.nif));
    for (const r of rows) r.entity_id = m.get(r.nif)?.id ?? null;
    const kinds = qa("SELECT ekind, COUNT(*) n FROM flags WHERE kind=? GROUP BY 1 ORDER BY 2 DESC", kind);
    return { available: true, kind, def: DEFS[kind], total, page, limit, rows, kinds, min_n: q1("SELECT 1") && (J(q1("SELECT value FROM meta WHERE key='overview'")?.value, {}).min_n || 10) };
  };
}
