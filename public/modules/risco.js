"use strict";
/* Módulo "risco": #/risco (Sinais de risco na contratação pública) + secção nas páginas de entidade.
   API: /api/risco/* — indicadores estatísticos explicáveis calculados sobre o Portal BASE (ingest/jobs/risco.py). */
(() => {
  const { esc } = Portal;
  const LEVEL = { contrato: "Contrato", par: "Par comprador–fornecedor", entidade: "Entidade" };
  const css = `<style>
    .rk-warn{border:2px solid #b45309;background:color-mix(in srgb,#f59e0b 12%,var(--card));border-radius:10px;padding:14px 16px;margin:0 0 16px}
    .rk-warn b{font-size:1.05rem}
    .rk-f{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.rk-f select{padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);font:inherit;font-size:.88rem;max-width:100%}
    .rk-flags{display:flex;flex-wrap:wrap;gap:4px}.rk-flags .tag{cursor:help}
    .rk-ev{font-size:.82rem;margin:4px 0 0;padding:6px 8px;border-left:3px solid var(--line);background:var(--line2);border-radius:4px;overflow-wrap:anywhere}
    .rk-ev ul{margin:4px 0 0 16px;padding:0}.rk-ev li{margin:1px 0}
    .rk-def{border-top:1px solid var(--line);padding:8px 0}.rk-def:first-child{border-top:0}
    .rk-def h3{font-size:.95rem;margin:0 0 2px}.rk-w{font-variant-numeric:tabular-nums;white-space:nowrap}
    details.rk summary{cursor:pointer;color:var(--accent,inherit)}
    .rk-num{font-variant-numeric:tabular-nums}
    .rk-tbl td{vertical-align:top}
  </style>`;
  const sel = (name, opts, cur, all) => `<select name="${name}" aria-label="${esc(all)}"><option value="">${esc(all)}</option>${opts.map((o) => `<option value="${esc(o[0])}" ${String(cur ?? "") === String(o[0]) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;
  const color = (w) => (w >= 2 ? "red" : w >= 1 ? "amber" : "blue");
  const ent = (id, name, nif) => (id ? `<a href="#/entidade/${id}">${esc(name || nif)}</a>` : nif ? `<a href="#/contratos?seller=${esc(nif)}">${esc(name || nif)}</a>` : esc(name || "—"));
  const ctr = (id, text) => `<a href="#/contrato/${esc(id)}">${esc(text || id)}</a>`;
  const KEYS = {
    regra: "regra", teto: "teto legal (€)", preco: "preço (€)", pct_do_teto: "% do teto", base_nacional_pct: "média nacional na faixa (%)", janela_dias: "janela (dias)",
    grupo_cpv: "classe CPV", n_contratos: "nº contratos", soma: "soma (€)", soma_max_janela: "soma máx. numa janela (€)", anos: "anos económicos",
    soma_anterior: "soma anterior (€)", n_anteriores: "contratos anteriores", procedimento: "procedimento", concorrentes: "concorrentes",
    primeira_aparicao: "1.ª aparição no BASE", dias_desde_primeira: "dias desde a 1.ª aparição", preco_inicial: "preço inicial (€)", preco_final: "preço final (€)",
    aumento_pct: "aumento (%)", n_modificacoes: "modificações", trabalhos_complementares: "com trabalhos complementares", motivo: "motivo", fundamento: "fundamento legal",
    n_ajustes_diretos: "ajustes diretos", valor: "valor (€)", quota_valor_pct: "quota do valor (%)", total_ajustes_comprador: "ajustes diretos do comprador",
    valor_ajustes_comprador: "valor dos ajustes do comprador (€)", concorrente_perdedor: "NIF do concorrente que perde", nome_perdedor: "concorrente que perde",
    derrotas: "derrotas neste comprador", derrotas_para_este_vencedor: "derrotas para este vencedor", taxa_vitoria_nacional_pct: "taxa de vitória nacional (%)",
    propostas_nacionais: "propostas no país", procedimentos: "procedimentos", datas_distintas: "datas distintas", vitorias: "vitórias por concorrente",
    vitorias_com_1_2_concorrentes: "vitórias com 1–2 concorrentes", procedimentos_comprador_com_1_2: "procedimentos do comprador com 1–2 concorrentes",
    observados: "observados", esperados: "esperados (média nacional)", razao: "razão", z: "desvio (erros-padrão)", contratos_pelo_valor: "contratos pelo valor",
    contratos: "contratos", de: "de", taxa_pct: "taxa (%)", taxa_nacional_pct: "taxa nacional (%)", taxa_tipo_pct: "taxa do tipo de entidade (%)",
    concorrente_unico: "com concorrente único", ajustes_dezembro: "ajustes em dezembro", ajustes: "ajustes diretos", quota_pct: "quota (%)", quota_tipo_pct: "quota do tipo (%)",
    ajustes_na_janela_anos_eleicao: "ajustes nos dias antes das eleições", ajustes_anos_eleicao: "ajustes nos anos de eleições", quota_anos_eleicao_pct: "quota antes das eleições (%)",
    quota_outros_anos_pct: "quota no mesmo período de outros anos (%)", razao_nacional_autarquias: "razão nacional (autarquias)", casos: "casos",
    contratos_subida_25: "contratos com subida > 25%", contratos_modificados: "contratos modificados", aumento_total: "aumento total (€)",
    com_trabalhos_complementares: "com trabalhos complementares", quota_complementares_pct: "parte com trabalhos complementares (%)",
    fracionamento: "fracionamento", art113: "art.º 113.º", compradores: "compradores", propostas: "propostas", vitorias_do_perdedor_neste_comprador: "vitórias do perdedor aqui",
    perdedor_alguma_vez_ganhou: "o perdedor já ganhou algures?",
    n_procedimentos: "nº procedimentos", valor_procedimento: "valor do procedimento (€)", lotes: "lotes", taxa_pares_pct: "taxa dos pares (%)", n_pares: "nº de pares",
    grupo_pares: "grupo de pares", razao_pares: "razão dos pares", anuncio: "anúncio", publicado: "publicado", prazo_dias: "prazo (dias)", limiar_p10_dias: "p10 do tipo/regime (dias)",
    regime: "regime", referencia_anuncio: "referência de anúncio", valor_inicial_procedimento: "valor inicial do procedimento (€)", valor_final_procedimento: "valor final do procedimento (€)",
    procedimentos_em_fracionamento: "procedimentos em fracionamento", procedimentos_pelo_valor: "procedimentos pelo valor", procedimentos_art113: "procedimentos art.º 113.º",
    procedimentos_concorrente_unico: "procedimentos com concorrente único", procedimentos_concorrenciais: "procedimentos concorrenciais", ajustes_em_dezembro: "ajustes em dezembro",
    procedimentos_ajuste_direto: "procedimentos de ajuste direto", anuncios_prazo_curto: "anúncios com prazo curto", anuncios_com_prazo: "anúncios com prazo",
    concursos_sem_anuncio: "concursos sem anúncio", concursos: "concursos", procedimentos_modificados_acima_do_teto: "procedimentos que passam o teto após modificação",
    procedimentos_junto_ao_teto: "procedimentos junto ao teto", esperados_media_nacional: "esperados (média nacional)", procedimentos_ad_comprador: "procedimentos AD do comprador",
    procedimentos_ganhos_com_1_2_concorrentes: "ganhos com 1–2 concorrentes", procedimentos_concorrenciais_ganhos: "procedimentos concorrenciais ganhos",
    procedimentos_fracionamento: "procedimentos em fracionamento", nota: "nota", nif: "NIF", vitorias_concorrenciais: "vitórias concorrenciais", ver: "ver bandeira",
  };
  const fmtVal = (k, v) => {
    if (v == null) return "—";
    if (typeof v === "boolean") return v ? "sim" : "não";
    if (typeof v === "number") return /€|\(€\)/.test(KEYS[k] || "") ? Portal.eurFull(v) : Portal.nf.format(v);
    if (Array.isArray(v)) return v.every((x) => typeof x !== "object") ? esc(v.join(" – ")) : `${v.length} itens`;
    if (typeof v === "object") return esc(Object.entries(v).map(([a, b]) => `${a}: ${Array.isArray(b) ? b.join(", ") : b}`).join(" · "));
    return esc(String(v));
  };
  // evidência: pares chave-valor + listas de contratos citados (com link)
  const evidence = (e, evc = {}) => {
    if (!e || typeof e !== "object") return "";
    const kv = Object.entries(e).filter(([k, v]) => !(Array.isArray(v) && v.length && Array.isArray(v[0])) && k !== "modificacoes");
    const lists = Object.entries(e).filter(([k, v]) => Array.isArray(v) && v.length && Array.isArray(v[0]) && k !== "modificacoes");
    const mods = e.modificacoes || [];
    return `<div class="rk-ev">${kv.map(([k, v]) => `<span><b>${esc(KEYS[k] || k)}:</b> ${fmtVal(k, v)}</span>`).join(" · ")}
      ${lists.map(([k, arr]) => `<ul>${arr.slice(0, 12).map((x) => { const c = evc[String(x[0])]; return `<li>${ctr(x[0], c?.object || "contrato " + x[0])} <span class="muted">· ${esc(x[1] || c?.signed || "")}${typeof x[2] === "number" ? " · " + Portal.eurFull(x[2]) : x[2] ? " · vencedor NIF " + esc(x[2]) : ""}${typeof x[3] === "number" && x[3] > 1 ? ` · ${x[3]} lotes` : ""}</span></li>`; }).join("")}${arr.length > 12 ? `<li class="muted">+${arr.length - 12}…</li>` : ""}</ul>`).join("")}
      ${mods.length ? `<ul>${mods.map((m) => `<li>${esc(m[0] || "")} · ${esc(m[1] || "")} → ${Portal.eurFull(m[2])}</li>`).join("")}</ul>` : ""}</div>`;
  };
  const flagTags = (flags, defs) => `<span class="rk-flags">${flags.map((f) => { const d = defs?.[f.flag] || {}; return `<span class="tag ${color(f.weight)}" title="${esc((d.description || f.label || "") + " — Peso " + f.weight)}">${esc(f.label || d.label || f.flag)} · ${f.weight}</span>`; }).join("")}</span>`;
  const DISCLAIMER = `<div class="rk-warn" role="note"><b>⚠ Sinais estatísticos, não acusações.</b>
    <p style="margin:6px 0 0">Cada indicador assinala um padrão que, em média, está associado a maior risco de má gestão ou favorecimento na contratação pública. A maior parte dos casos assinalados tem explicações legítimas (urgência, exclusividade técnica, mercados pequenos, erros de registo no Portal BASE). Nenhuma bandeira prova ilegalidade: é um ponto de partida para pedir esclarecimentos, nunca uma conclusão. Mostramos sempre a evidência para que possa verificar.</p></div>`;

  Portal.nav("Sinais de risco", "#/risco");

  Portal.page("risco", async (arg, p) => {
    $app.innerHTML = `${css}<div class="pagehead"><div><div class="kicker">Contratação pública</div><h1>Sinais de risco</h1></div></div><p class="muted">A carregar…</p>`;
    const ov = await Portal.api("risco/overview");
    if (!ov.available) { $app.innerHTML = `<div class="pagehead"><div><h1>Sinais de risco</h1></div></div><p class="note warn">${esc(ov.note)}</p>`; return; }
    const defs = Object.fromEntries(ov.flags.map((f) => [f.flag, f]));
    const role = p.role === "fornecedor" ? "fornecedor" : "comprador";
    const flag = p.flag && defs[p.flag] ? p.flag : "";
    const [es, top] = await Promise.all([
      Portal.api("risco/entities" + Portal.qs({ role, kind: p.kind, flag, year: p.year, sort: p.sort, page: p.page })),
      Portal.api("risco/top" + Portal.qs({ flag: flag && defs[flag].level !== "entidade" ? flag : "", year: p.year, kind: role === "comprador" ? p.kind : "", limit: 12, page: p.cpage })),
    ]);
    const link = (o) => `#/risco${Portal.qs({ ...p, ...o })}`;
    const c = ov.counts || {}, nat = ov.national || {};
    const flagOpts = ["contrato", "par", "entidade"].flatMap((lv) => ov.flags.filter((f) => f.level === lv && f.n_flagged).map((f) => [f.flag, `${LEVEL[lv]} · ${f.label} (${Portal.int(f.n_flagged)})`]));
    const kindOpts = (ov.kinds || []).filter((k) => k.kind).map((k) => [k.kind, `${Portal.kindLabel(k.kind)} (${k.n})`]);
    const th = (ov.thresholds || []);
    const yearSel = (ov.years || []).map((y) => [y, y]);
    const pe = nat.autarquias_pre_eleitoral || {};
    const sens = nat.fracionamento_sensibilidade || {};

    const entTable = Portal.table([
      { h: "#", f: (r, i) => "" },
      { h: role === "comprador" ? "Entidade compradora" : "Fornecedor", f: (r) => `${ent(r.entity_id, r.name, r.nif)}<div class="small muted">${esc(Portal.kindLabel(r.kind) || "")} · NIF ${esc(r.nif)}</div>${r.peer_group ? `<div class="small muted" title="grupo usado para comparar as taxas">pares: ${esc(r.peer_group)} (${Portal.int(r.n_peers)})</div>` : ""}` },
      { h: "Pontuação", num: 1, sort: "score", f: (r) => `<b class="rk-num">${r.score ?? "—"}</b>${r.period_score != null ? `<div class="small muted" title="soma das pontuações dos contratos assinalados no filtro">${r.period_score} no filtro</div>` : ""}` },
      { h: "Bandeiras (passe o rato para a explicação)", f: (r) => `${flagTags(r.flags || [], defs)}<details class="rk"><summary class="small">evidência</summary>${(r.flags || []).map((f) => `<div><b class="small">${esc(f.label)}</b>${evidence(f.evidence)}</div>`).join("")}
          <p class="small"><a href="#/contratos?${role === "comprador" ? "buyer" : "seller"}=${esc(r.nif)}">Ver contratos →</a></p></details>` },
      { h: "Contratos c/ bandeira", num: 1, sort: "flagged", f: (r) => `${Portal.int(r.n_flagged_period ?? r.n_flagged_contracts)}<div class="small muted">de ${Portal.int(r.n_contracts)}</div>` },
      { h: "Valor total", num: 1, sort: "value", f: (r) => Portal.eur(r.value) },
    ].filter((x) => x.h !== "#"), es.rows || [], { sort: p.sort || "score", sortLink: (k) => link({ sort: k, page: "" }) });

    const contractRows = (rows, evc) => rows.map((r) => `<tr><td>${Portal.fmtDate(r.signed)}</td>
        <td>${ctr(r.contract_id, (r.object || "").slice(0, 140))}<div class="small muted">${esc(r.procedure || "")} · ${esc(r.buyer_name || "")} → ${esc(r.seller_name || "sem NIF")}</div>
          ${r.flagRows ? flagTags(r.flagRows.map((f) => ({ ...f, label: defs[f.flag]?.label })), defs) : ""}
          <details class="rk"><summary class="small">evidência</summary>${(r.flagRows || [{ flag: r.flag, weight: r.weight, evidence: r.evidence }]).map((f) => `<div><b class="small">${esc(defs[f.flag]?.label || f.flag)} (peso ${f.weight})</b>${evidence(f.evidence, evc)}</div>`).join("")}</details></td>
        <td class="num">${Portal.eurFull(r.price)}</td><td class="num">${r.score ?? r.weight}</td></tr>`).join("");
    const pairRows = (rows, evc) => rows.map((r) => `<tr><td>${ent(r.buyer_nif_id, r.buyer_nif_name, r.buyer_nif)}</td><td>${ent(r.seller_nif_id, r.seller_nif_name, r.seller_nif)}</td>
        <td><details class="rk"><summary class="small">${esc(defs[r.flag]?.label || r.flag)} · ${r.n_contracts} casos</summary>${evidence(r.evidence, evc)}</details></td><td class="num">${r.value ? Portal.eur(r.value) : "—"}</td></tr>`).join("");
    let examples = "";
    if (top.level === "par") examples = `<div class="tblwrap"><table class="tbl rk-tbl"><thead><tr><th>Comprador</th><th>Fornecedor (vencedor)</th><th>Padrão e evidência</th><th class="num">Valor</th></tr></thead><tbody>${pairRows(top.rows, top.evidence)}</tbody></table></div>`;
    else if (top.rows) examples = `<div class="tblwrap"><table class="tbl rk-tbl"><thead><tr><th>Data</th><th>Contrato, partes e bandeiras</th><th class="num">Preço</th><th class="num">${flag ? "Peso" : "Pontuação"}</th></tr></thead><tbody>${contractRows(top.rows, top.evidence) || '<tr><td colspan="4" class="empty">Sem resultados.</td></tr>'}</tbody></table></div>`;

    $app.innerHTML = `${css}
      <div class="crumbs"><a href="#/">Início</a> / Sinais de risco</div>
      <div class="pagehead"><div><div class="kicker">Contratação pública · Portal BASE</div><h1>Sinais de risco</h1>
        <p class="lead">Indicadores transparentes e reprodutíveis sobre ${Portal.int(nat.contratos)} contratos públicos: fracionamento, valores colados ao teto legal, concorrência fraca, fornecedores recém-surgidos, derrapagens e picos de despesa. Cada sinal mostra a regra, o peso e as linhas que o justificam.</p>
        <div class="small muted">Calculado em ${esc((ov.built || "").replace("T", " "))} · <a href="#/risco/metodologia">metodologia completa</a></div></div></div>
      ${DISCLAIMER}
      ${arg === "metodologia" ? methodology(ov, defs) : `
      <div class="kpis">
        <div class="kpi"><b>${Portal.int(c.contracts_flagged)}</b><span>contratos com ≥ 1 bandeira (incl. lacunas de dados)</span></div>
        <div class="kpi"><b>${Portal.int(c.contracts_score_ge_3)}</b><span>contratos com pontuação ≥ 3</span></div>
        <div class="kpi"><b>${Portal.int(defs.FRACIONAMENTO?.n_flagged)}</b><span>contratos em possível fracionamento</span></div>
        <div class="kpi"><b>${Portal.int(c.pair_flags)}</b><span>pares comprador–fornecedor com padrões</span></div>
        <div class="kpi"><b>${Portal.int(c.entities_flagged)}</b><span>entidades com bandeiras</span></div></div>
      ${ov.scoreDist?.buckets ? `<section class="panel"><h2>Distribuição da pontuação por contrato</h2>
        ${Portal.table([{ h: "Pontuação (soma dos pesos)", f: (b) => esc(b.label) }, { h: "Contratos", num: 1, f: (b) => Portal.int(b.n) }, { h: "% do total", num: 1, f: (b) => Portal.pct(100 * b.n / (ov.scoreDist.total_contracts || 1), 1) }], ov.scoreDist.buckets)}
        <p class="small muted">${Portal.int(ov.scoreDist.unflagged)} contratos sem bandeiras · ${Portal.int(ov.scoreDist.flagged)} com pelo menos uma. Pontuações entre 0 e 1 são quase sempre só lacunas de dados ou um valor colado ao teto (pesos 0,25–0,5).</p></section>` : ""}
      <section class="panel"><h2>Filtrar</h2>
        <form class="rk-f" id="rk-form">
          ${sel("role", [["comprador", "Entidades compradoras"], ["fornecedor", "Fornecedores"]], role, "Papel")}
          ${sel("flag", flagOpts, flag, "Todas as bandeiras")}
          ${sel("kind", kindOpts, p.kind, "Todos os tipos de entidade")}
          ${sel("year", yearSel, p.year, "Todos os anos")}
          <button class="btn primary" type="submit">Aplicar</button> ${Object.keys(p).length ? '<a class="btn" href="#/risco">Limpar</a>' : ""}</form>
        ${flag ? `<div class="rk-def"><h3>${esc(defs[flag].label)} <span class="tag ${color(defs[flag].weight)}">peso ${defs[flag].weight}</span> <span class="tag">${LEVEL[defs[flag].level]}</span></h3><p class="small">${esc(defs[flag].description)}</p><p class="small muted"><b>Limitação:</b> ${esc(defs[flag].caveat)}</p></div>` : ""}
        <p class="small muted">${p.year || (flag && defs[flag].level !== "entidade") ? "Ordenado pela soma das pontuações dos contratos/pares assinalados no filtro." : "Ordenado pela pontuação da entidade (soma dos pesos das bandeiras de entidade, calculadas sobre todo o período 2012–2026)."}</p>
      </section>
      <section class="panel"><h2>${role === "comprador" ? "Entidades compradoras" : "Fornecedores"} com mais sinais <span class="small muted">(${Portal.int(es.total)})</span></h2>
        ${es.note ? `<p class="note">${esc(es.note)}</p>` : ""}${entTable}${Portal.pager(es.total, es.page, es.limit, (n) => link({ page: n }))}</section>
      <section class="panel"><h2>${flag && defs[flag].level !== "entidade" ? `Exemplos: ${esc(defs[flag].label)}` : "Contratos com maior pontuação"}${p.year ? ` · ${esc(p.year)}` : ""}</h2>
        <p class="small muted">${top.level === "par" ? "Pares ordenados pelo número de casos." : flag ? "Ordenados por preço." : "Pontuação = soma dos pesos das bandeiras do contrato. Abra «evidência» para ver os contratos relacionados."}</p>
        ${top.note ? `<p class="note">${esc(top.note)}</p>` : ""}${examples}${top.total ? Portal.pager(top.total, top.page, top.limit, (n) => link({ cpage: n })) : ""}</section>
      <div class="cols">
        <section class="panel"><h2>Tetos legais validados nos dados</h2>
          <p class="small">Os tetos não foram assumidos: para cada fundamento legal procurámos o pico de contratos logo abaixo do limite.</p>
          ${Portal.table([{ h: "Regra", f: (t) => `<span class="small">${esc(t.description)}</span>` }, { h: "Teto", num: 1, f: (t) => Portal.eurFull(t.ceiling) },
            { h: "95–100% vs 85–90%", num: 1, f: (t) => `${Portal.int(t.n_95_100)} vs ${Portal.int(t.n_85_90)} <span class="tag ${t.confirmed ? "blue" : "amber"}">${t.spike_ratio}×</span>` }], th)}</section>
        <section class="panel"><h2>Linhas de base nacionais</h2>
          <ul class="small">
            <li>Contratos pelo valor em possível fracionamento: <b>${Portal.pct(100 * (nat.taxa_fracionamento || 0), 2)}</b> (janela de 14/30/60 dias: ${["14", "30", "60"].map((w) => Portal.int(sens[w]?.contratos)).join(" / ")} contratos).</li>
            <li>Contratos acima do limite acumulado de 3 anos (art.º 113.º): <b>${Portal.pct(100 * (nat.taxa_art113 || 0), 2)}</b> dos contratos pelo valor.</li>
            <li>Autarquias: ${Portal.pct(100 * (pe.quota_janela_anos_eleicao || 0), 1)} dos ajustes diretos dos anos eleitorais caem nos ${pe.janela_dias} dias antes das autárquicas, contra ${Portal.pct(100 * (pe.quota_janela_outros_anos || 0), 1)} no mesmo período dos outros anos (razão ${pe.razao}).</li>
            <li>Ajustes diretos em dezembro: ${Object.entries(nat.dezembro_por_tipo || {}).slice(0, 6).map(([k, v]) => `${esc(Portal.kindLabel(k))} ${Portal.pct(100 * v, 1)}`).join(" · ")}.</li>
          </ul>
          <p class="small"><a href="#/risco/metodologia">Todas as bandeiras, pesos e limitações →</a> · Dados para análise: <code>data/risco.db</code>, <code>data/exports/risco_contracts.csv.gz</code>, dicionário em <code>docs/DATA.md</code>.</p></section></div>`}`;
    const f = document.getElementById("rk-form");
    if (f) f.onsubmit = (e) => { e.preventDefault(); const d = new FormData(f); Portal.go("risco", "", { role: d.get("role"), flag: d.get("flag"), kind: d.get("kind"), year: d.get("year") }); };
  });

  function methodology(ov, defs) {
    const by = (lv) => ov.flags.filter((f) => f.level === lv);
    const block = (lv) => by(lv).map((f) => `<div class="rk-def"><h3>${esc(f.label)} <code class="small">${esc(f.flag)}</code> <span class="tag ${color(f.weight)}">peso ${f.weight}</span> <span class="small muted">${Portal.int(f.n_flagged)} assinalados</span></h3>
        <p class="small">${esc(f.description)}</p><p class="small muted"><b>Limitação:</b> ${esc(f.caveat)}</p>
        ${f.level !== "entidade" && f.n_flagged ? `<p class="small"><a href="#/risco?flag=${esc(f.flag)}">Ver exemplos →</a></p>` : ""}</div>`).join("");
    return `<section class="panel"><h2>Como funciona</h2>
      <ol class="small">
        <li><b>Tetos legais medidos, não assumidos.</b> Para cada fundamento legal de ajuste direto ou consulta prévia "pelo valor" (art.º 19.º, 20.º e 21.º do CCP; DLR 27/2015/A nos Açores) verificámos no histograma de preços um pico logo abaixo do teto (ex.: 19 500–19 999 € no ajuste direto de bens e serviços). Os ajustes diretos por critério material (urgência, exclusividade, art.º 24.º) não têm teto de valor e não entram nestes testes.</li>
        <li><b>Bandeiras de contrato, de par e de entidade.</b> Cada uma tem uma regra fixa, um peso e a evidência gravada (contratos, valores, limiares e média nacional).</li>
        <li><b>Pontuação = soma dos pesos.</b> Contrato: soma das suas bandeiras. Entidade: soma das bandeiras de entidade (que comparam a entidade com a média nacional ou com entidades do mesmo tipo). A pontuação nunca é mostrada sem as bandeiras que a compõem.</li>
        <li><b>Calibração sobre toda a população</b> (2012–2026). Bandeiras de lacunas de dados têm peso baixo (0,25–0,5).</li>
        <li><b>Lotes = um procedimento.</b> Todos os contratos com o mesmo <code>idprocedimento</code> do Portal BASE (lotes de um concurso, ou vários contratos de um mesmo ajuste direto) contam como um só procedimento: o valor é a soma dos lotes, e o fracionamento exige procedimentos diferentes.</li>
        <li><b>Comparação com pares.</b> As bandeiras de entidade comparam cada comprador com entidades do mesmo tipo e escalão de dimensão (municípios: quartil de população dos Censos 2021; restantes: quartil do valor contratado) e mostram quantos pares entram na comparação.</li>
        <li><b>Contexto não é bandeira.</b> Para municípios mostramos o prazo médio de pagamento e a execução orçamental (DGAL) só como contexto.</li>
      </ol></section>
      <section class="panel"><h2>Bandeiras de contrato</h2>${block("contrato")}</section>
      <section class="panel"><h2>Bandeiras de par comprador–fornecedor</h2>${block("par")}</section>
      <section class="panel"><h2>Bandeiras de entidade</h2>${block("entidade")}</section>
      <section class="panel"><h2>Limitações gerais</h2><ul class="small">
        <li>O Portal BASE só tem contratos publicados; contratos abaixo dos limiares de publicação ou não reportados não aparecem.</li>
        <li>O "mesmo objeto" é aproximado pelo código CPV e pelas palavras da descrição — não lemos os cadernos de encargos.</li>
        <li>A "idade" de um fornecedor é a sua primeira aparição no Portal BASE (desde 2012), não a data de constituição.</li>
        <li>As listas de concorrentes faltam em ~${Portal.int(defs.SEM_LISTA_CONCORRENTES?.n_flagged)} procedimentos concorrenciais, o que esconde padrões de cobertura e rotação.</li>
        <li>As exceções legais (fundamentação de urgência, exclusividade, art.º 113.º, n.º 5) não estão nos dados; um sinal pode ter justificação documentada no processo.</li>
      </ul></section>`;
  }

  // ---------- secção nas páginas de entidade (só quando há bandeiras)
  Portal.entityHooks.push(async (data, el) => {
    const nif = data?.entity?.nif;
    if (!nif) return;
    const d = await Portal.api("risco/entity?nif=" + encodeURIComponent(nif));
    if (!d || d.available === false) return;
    const hasAny = (d.roles || []).length || (d.pairs || []).length || (d.asBuyer || []).some((x) => (d.defs[x.flag]?.weight || 0) >= 1) || (d.asSeller || []).some((x) => (d.defs[x.flag]?.weight || 0) >= 1);
    if (!hasAny) return;
    const defs = d.defs;
    const roleBlock = (r) => `<div style="margin:0 0 10px"><b>Como ${esc(r.role)}</b> — pontuação <b>${r.score}</b> <span class="small muted">(soma dos pesos)</span>
        ${r.flags.map((f) => `<div class="flag ${f.weight < 1 ? "info" : ""}"><div><b>${esc(f.label)} <span class="tag ${color(f.weight)}">peso ${f.weight}</span></b><p class="small">${esc(defs[f.flag]?.description || "")}</p>${evidence(f.evidence)}
          ${f.evidence?.ver ? `<p class="small">${String(f.evidence.ver).split(",").map((v) => `<a href="#/risco?flag=${esc(v)}&role=${r.role === "comprador" ? "comprador" : "fornecedor"}">${esc(defs[v]?.label || v)} →</a>`).join(" · ")}</p>` : ""}</div></div>`).join("")}</div>`;
    const counts = (rows, side) => rows.length ? `<p class="small">${rows.map((x) => `<span class="tag ${color(defs[x.flag]?.weight || 0)}" title="${esc(defs[x.flag]?.description || "")}">${esc(defs[x.flag]?.label || x.flag)}: ${Portal.int(x.n)}</span>`).join(" ")}
        · <a href="#/contratos?${side}=${esc(nif)}">ver contratos →</a></p>` : "";
    el.insertAdjacentHTML("beforeend", `${css}<section class="panel"><h2>Sinais de risco</h2>
      <p class="small muted">Indicadores estatísticos, <b>não acusações</b>: cada sinal tem explicações legítimas possíveis. <a href="#/risco/metodologia">Metodologia</a>.</p>
      ${d.context ? `<p class="small"><b>Contexto (não é bandeira):</b> comparado com ${Portal.int(d.context.n_pares)} pares — ${esc(d.context.grupo_pares)}${d.context.prazo_medio_pagamento ? ` · prazo médio de pagamento ${d.context.prazo_medio_pagamento.dias} dias (${esc(d.context.prazo_medio_pagamento.data)})` : ""}${d.context.execucao_despesa ? ` · execução da despesa ${d.context.execucao_despesa.ano}: ${Portal.pct(d.context.execucao_despesa.taxa_execucao_pct, 1)}` : ""}${d.context.modificacoes ? ` · ${Portal.int(d.context.modificacoes.contratos_modificados)} contratos modificados (+${Portal.eur(d.context.modificacoes.aumento_total_eur)})` : ""}</p>` : ""}
      ${(d.roles || []).map(roleBlock).join("")}
      ${d.asBuyer.length ? `<h3 style="font-size:1rem">Contratos assinalados como comprador</h3>${counts(d.asBuyer, "buyer")}` : ""}
      ${d.asSeller.length ? `<h3 style="font-size:1rem">Contratos assinalados como fornecedor</h3>${counts(d.asSeller, "seller")}` : ""}
      ${d.pairs.length ? `<h3 style="font-size:1rem">Padrões comprador–fornecedor</h3><div class="tblwrap"><table class="tbl rk-tbl"><thead><tr><th>Comprador</th><th>Fornecedor</th><th>Padrão e evidência</th><th class="num">Valor</th></tr></thead><tbody>
        ${d.pairs.slice(0, 15).map((r) => `<tr><td>${ent(r.buyer_nif_id, r.buyer_nif_name, r.buyer_nif)}</td><td>${ent(r.seller_nif_id, r.seller_nif_name, r.seller_nif)}</td><td><details class="rk"><summary class="small">${esc(defs[r.flag]?.label || r.flag)} · ${r.n_contracts} casos</summary>${evidence(r.evidence, d.evidence)}</details></td><td class="num">${r.value ? Portal.eur(r.value) : "—"}</td></tr>`).join("")}</tbody></table></div>` : ""}
      ${d.contracts.length ? `<h3 style="font-size:1rem">Contratos com mais sinais</h3><div class="tblwrap"><table class="tbl rk-tbl"><thead><tr><th>Data</th><th>Contrato e bandeiras</th><th class="num">Preço</th><th class="num">Pont.</th></tr></thead><tbody>
        ${d.contracts.slice(0, 12).map((r) => `<tr><td>${Portal.fmtDate(r.signed)}</td><td>${ctr(r.contract_id, (r.object || "").slice(0, 120))}<div class="small muted">${esc(r.buyer_name || "")} → ${esc(r.seller_name || "")}</div>${flagTags(r.flagRows.map((f) => ({ ...f, label: defs[f.flag]?.label })), defs)}
          <details class="rk"><summary class="small">evidência</summary>${r.flagRows.map((f) => `<div><b class="small">${esc(defs[f.flag]?.label || f.flag)}</b>${evidence(f.evidence, d.evidence)}</div>`).join("")}</details></td><td class="num">${Portal.eurFull(r.price)}</td><td class="num">${r.score}</td></tr>`).join("")}</tbody></table></div>` : ""}
    </section>`);
  });
})();
