"use strict";
/* Portal core: router, helpers, plug-in registry and the core pages.
   Plug-ins live in public/modules/*.js and call Portal.page(name, fn) / Portal.nav(...). See docs/MODULES.md */
const Portal = (window.Portal = {
  pages: {}, extraNav: [],
  page(name, fn) { this.pages[name] = fn; },
  nav(label, hash) { this.extraNav.push({ label, hash }); },
  hasPage(name) { return !!(this.pages[name] || EAR.mods[name]); },
});
const EAR = window.EA_ROUTES || { version: "", mods: {}, extra: {}, hooks: [], files: [], story: [], data: {} };
const VER = (document.querySelector('meta[name="ea-version"]') || {}).content || EAR.version || "";
const vurl = (u) => (VER ? u + (u.includes("?") ? "&" : "?") + "v=" + encodeURIComponent(VER) : u);
const idle = (fn, timeout = 1200) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 60));
const loaded = new Set(), loading = {};
const loadScripts = (files) => Promise.all(files.map((f) => (loading[f] ||= new Promise((res) => {
  const s = document.createElement("script"); s.src = vurl(f); s.async = false;
  s.onload = () => { loaded.add(f); res(true); }; s.onerror = () => { delete loading[f]; res(false); };
  document.head.appendChild(s);
}))));
const loadCss = (href) => (loading[href] ||= new Promise((res) => {
  if (document.querySelector(`link[data-lazy="${href}"]`)) return res(true);
  const l = document.createElement("link"); l.rel = "stylesheet"; l.href = vurl(href); l.dataset.lazy = href;
  l.onload = () => { loaded.add(href); res(true); }; l.onerror = () => res(false);
  document.head.appendChild(l);
}));
const storyFiles = (arg) => { const slug = String(arg || "").split("/")[0]; return ["/story-morphs.js", "/story-engine.js"].concat(EAR.story.includes(slug) ? ["/historias/" + slug + ".js"] : []); };
const needsFiles = (name, arg) => {
  if (name === "historia") return storyFiles(arg).filter((f) => !loaded.has(f)).concat(loaded.has("/story.css") ? [] : ["/story.css"]);
  if (name === "painel-classico") return loaded.has("/novidades.js") ? [] : ["/novidades.js"];
  const out = [EAR.mods[name]].concat(EAR.extra[name] || []).filter((f) => f && !loaded.has(f));
  if (name === "entidade") for (const f of EAR.hooks) if (!loaded.has(f)) out.push(f);
  return out;
};
let allMods;
const loadAllModules = () => (allMods ||= (async () => {
  try { const m = await (await fetch("/api/modules")).json(); await loadScripts(m.client.filter((f) => !loaded.has("/modules/" + f)).map((f) => "/modules/" + f)); } catch (e) { console.warn("modules", e); }
})());
async function ensure(name, arg) {
  const need = needsFiles(name, arg), jobs = [];
  if (need.includes("/story.css")) jobs.push(loadCss("/story.css"));
  const js = need.filter((f) => f.endsWith(".js"));
  if (js.length) jobs.push(loadScripts(js));
  await Promise.all(jobs);
  if (!Portal.pages[name]) await loadAllModules();
}
const dataReady = (name, arg) => {
  const seeds = EAR.data[name];
  return !arg && !!seeds && seeds.length > 0 && seeds.every(apiCached);
};
const pageReady = (name, arg) => !!Portal.pages[name] && needsFiles(name, arg).length === 0 && (dataReady(name, arg) || name === "historia");
const noPrefetch = /[?&]prefetch=0\b/.test(location.search);
const prefetched = new Set();
function prefetch(href) {
  if (noPrefetch || prefetched.has(href)) return;
  const m = /^#\/?([^/?]*)\/?([^?]*)/.exec(href); if (!m) return;
  const name = m[1], arg = decodeURIComponent(m[2] || "");
  prefetched.add(href);
  ensure(name, arg).catch(() => {});
  if (!arg) for (const p of EAR.data[name] || []) if (!apiCached(p)) api(p, true).catch(() => {});
}
Portal.prefetch = prefetch;

/* ---------- helpers ---------- */
const nf = new Intl.NumberFormat("pt-PT", { useGrouping: "always" });
const eurC = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", notation: "compact", maximumFractionDigits: 1 });
const eurF = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
Object.assign(Portal, {
  esc, api, nf, fmtDate, fmtTime, clean,
  eur: (v) => { if (v == null) return "—"; const a = Math.abs(v), f = (x, d = 1) => x.toLocaleString("pt-PT", { maximumFractionDigits: d }); return a >= 1e9 ? `${f(v / 1e9)} mil M€` : a >= 1e6 ? `${f(v / 1e6)} M€` : a >= 1e4 ? `${f(v / 1e3, 0)} mil €` : `${f(v, 0)} €`; }, eurFull: (v) => (v == null ? "—" : eurF.format(v)),
  int: (v) => (v == null ? "—" : nf.format(v)), pct: (v, d = 0) => (v == null ? "—" : `${Number(v).toFixed(d)}%`),
  qs: (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== "" && v != null) p.set(k, v); const s = p.toString(); return s ? "?" + s : ""; },
});
const KIND = {
  municipio: "Município", freguesia: "Freguesia", cim_am: "Comunidade intermunicipal / área metropolitana", empresa_municipal: "Empresa municipal",
  saude: "Saúde", universidade: "Ensino superior", escola: "Escola / agrupamento", tribunal_justica: "Justiça", seguranca_defesa: "Segurança e defesa",
  regional: "Administração regional", instituto_publico: "Instituto / organismo público", empresa_publica: "Empresa pública",
  outra_entidade: "Outra entidade adjudicante", empresa_ou_particular: "Empresa / particular", ministerio: "Ministério",
  terceiro_setor: "Terceiro setor (IPSS, associações, misericórdias)", diplomacia: "Embaixadas, consulados e arquivos", sociedade_adjudicante: "Sociedade comercial adjudicante",
};
Portal.kindLabel = (k) => KIND[k] || k || "";
const $ = (sel, el = document) => el.querySelector(sel);
const parseHash = () => {
  const h = location.hash.replace(/^#\/?/, ""), [path, query = ""] = h.split("?");
  const [name = "", ...rest] = path.split("/");
  return { name, arg: rest.length ? decodeURIComponent(rest.join("/")) : "", params: Object.fromEntries(new URLSearchParams(query)) };
};
const go = (name, arg, params) => { location.hash = `#/${name}${arg ? "/" + encodeURIComponent(arg) : ""}${Portal.qs(params || {})}`; };
Portal.go = go;
const table = (cols, rows, opts = {}) => `<div class="tblwrap"><table class="tbl"><thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${c.sort && opts.sortLink ? `<a href="${opts.sortLink(c.sort)}" class="${opts.sort === c.sort ? "on" : ""}">${esc(c.h)}${opts.sort === c.sort ? " ↓" : ""}</a>` : esc(c.h)}</th>`).join("")}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.f(r)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length}" class="empty">Sem resultados.</td></tr>`}</tbody></table></div>`;
Portal.table = table;
const pager = (total, page, limit, hrefFor) => {
  const pages = Math.max(1, Math.ceil(total / limit));
  return pages <= 1 ? "" : `<div class="pager">${page > 1 ? `<a class="btn" href="${hrefFor(page - 1)}">← Anterior</a>` : ""}<span class="muted small">Página ${page} de ${nf.format(pages)}</span>${page < pages ? `<a class="btn" href="${hrefFor(page + 1)}">Seguinte →</a>` : ""}</div>`;
};
Portal.pager = pager;
const entLink = (id, name) => (id ? `<a href="#/entidade/${id}">${esc(name)}</a>` : esc(name));
const nifLink = (nif, name) => (nif ? `<a href="#/contratos?${nif.length === 9 ? "seller=" : "q="}${nif}" title="NIF ${nif}">${esc(name || nif)}</a>` : esc(name || "—"));

function bars(years) {
  const max = Math.max(1, ...years.map((y) => y.value));
  return `<div class="barchart" role="img" aria-label="Valor contratado por ano">${years.map((y) => `<div class="col" title="${y.year}: ${eurF.format(y.value)} · ${y.n} contratos · ${y.direct_value && y.value ? Math.round(100 * y.direct_value / y.value) : 0}% ajuste direto">
    <div class="b" style="height:${Math.max(1, 130 * y.value / max)}px"><i style="height:${y.value ? 100 * (y.direct_value || 0) / y.value : 0}%"></i></div><div class="lbl">${String(y.year).slice(2)}${y.partial ? "*" : ""}</div></div>`).join("")}</div>
    <div class="legend"><span><i style="background:var(--bar)"></i>Valor contratado</span><span><i style="background:var(--bar2)"></i>Parte por ajuste direto</span>${years.some((y) => y.partial) ? "<span>* ano em curso (parcial)</span>" : ""}</div>`;
}
Portal.bars = bars;

/* ---------- follows ---------- */
let followState = [];
const visitorId = () => { let v = localStorage.getItem("ea:vid"); if (!v) { v = crypto.randomUUID(); localStorage.setItem("ea:vid", v); } return v; };
async function refreshFollows() { try { followState = (await api("follows?v=" + visitorId())).follows; } catch { followState = []; } $("#followcount").textContent = followState.length; }
const isFollowing = (kind, ref) => followState.some((f) => f.kind === kind && String(f.ref) === String(ref));
Portal.followButton = (kind, ref, label) => `<button class="btn ${isFollowing(kind, ref) ? "on" : ""}" data-follow="${kind}" data-ref="${esc(ref)}" data-label="${esc(label)}">${isFollowing(kind, ref) ? "A seguir ✓" : "+ Seguir"}</button>`;
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-follow]"); if (!b) return;
  const kind = b.dataset.follow, ref = b.dataset.ref;
  if (isFollowing(kind, ref)) await fetch(`/api/follows?v=${visitorId()}&kind=${kind}&ref=${encodeURIComponent(ref)}`, { method: "DELETE" });
  else await fetch("/api/follows", { method: "POST", body: JSON.stringify({ v: visitorId(), kind, ref, label: b.dataset.label }) });
  await refreshFollows();
  b.outerHTML = Portal.followButton(kind, ref, b.dataset.label);
});

/* ---------- global search ---------- */
function initSearch(form = $("#gsearch"), input = $("#gq"), box = $("#gresults")) {
  let t;
  const close = () => { box.hidden = true; };
  input.addEventListener("input", () => {
    clearTimeout(t); const q = input.value.trim();
    if (q.length < 2) return close();
    t = setTimeout(async () => {
      const r = await api("search?q=" + encodeURIComponent(q)).catch(() => null); if (!r) return;
      const sec = (title, items) => (items.length ? `<h4>${title}</h4>${items.join("")}` : "");
      box.innerHTML = sec("Entidades", r.entities.map((e) => `<a href="#/entidade/${e.id}"><b>${esc(e.name)}</b><small>${esc(Portal.kindLabel(e.kind))}${e.nif ? " · NIF " + e.nif : ""}${e.municipality ? " · " + esc(e.municipality) : ""}</small></a>`))
        + sec("Contratos", r.contracts.map((c) => `<a href="#/contrato/${c.id}"><b>${esc((c.object || "").slice(0, 90))}</b><small>${esc(c.buyer_name || "")} · ${Portal.eur(c.price)} · ${fmtDate(c.signed)}</small></a>`))
        + sec("Leis e iniciativas", r.initiatives.map((i) => `<a href="#/leis/${encodeURIComponent(i.key)}"><b>${esc(i.kind)} ${i.number}/${esc(i.legislature)}</b><small>${esc(clean(i.title)).slice(0, 90)}</small></a>`))
        + sec("Agenda parlamentar", r.events.map((e) => `<a href="#/calendario"><b>${esc(e.title.split("\n")[0].slice(0, 90))}</b><small>${fmtDate(e.start)} · ${esc(e.section)}</small></a>`))
        + `<a href="#/contratos?q=${encodeURIComponent(q)}"><b>Pesquisar “${esc(q)}” em todos os contratos →</b></a>`;
      box.hidden = false;
    }, 180);
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); close(); go("contratos", "", { q: input.value.trim() }); });
  document.addEventListener("click", (e) => { if (!form.contains(e.target)) close(); });
  box.addEventListener("click", close);
}

/* ---------- core pages ---------- */
const HOME_TILES = [
  ["contratos", "Contratos públicos", "2,3 milhões de contratos desde 2012: pesquisar por entidade, fornecedor, valor ou assunto."],
  ["autarquias", "Autarquias", "Quanto contrata cada município e freguesia, e com quem."],
  ["autarquias-mapa", "Câmaras: poder e contas", "Quem governa cada município e como gasta (eleições, despesa, dívida)."],
  ["risco", "Sinais de risco", "Fracionamento, preços colados ao teto, concorrência fraca: indicadores explicáveis."],
  ["deputados", "Deputados", "Os 230 deputados: círculo, comissões, iniciativas e faltas em plenário."],
  ["leis", "Leis em curso", "Do projeto à votação: o percurso de cada iniciativa no Parlamento."],
  ["dre", "Diário da República", "Como cada lei nasceu, foi alterada e qual a forma em vigor."],
  ["orcamento", "Orçamento do Estado", "Para onde vai o dinheiro: orçamento vs execução, por ministério e categoria."],
  ["fundos", "Fundos europeus e PRR", "Quem recebe: 70 mil milhões € por beneficiário, programa e região."],
  ["ministerios", "Ministérios", "Quem dirige, o que tutela e quanto contrata cada ministério."],
  ["responsaveis", "Quem decide", "Administradores, dirigentes e titulares de cargos, com o que declararam publicamente."],
  ["estado", "O Estado em números", "768 mil trabalhadores públicos, remunerações e empresas do Estado."],
  ["saude", "Saúde", "Hospitais, ULS e contratação do SNS."],
  ["educacao", "Educação", "Escolas, listas de docentes e Parque Escolar."],
  ["eleicoes", "Eleições", "Como Portugal votou, por território e eleição."],
  ["votacoes", "Votações", "Como votou cada partido e o percurso completo de cada lei."],
  ["regioes", "Regiões autónomas", "Governos, assembleias e contratação dos Açores e da Madeira."],
  ["entidades", "Instituições", "Diretório de todas as entidades públicas, por tipo."],
  ["poderes", "Como se divide o poder", "Presidente, Parlamento, Governo e Tribunais: o que cada um pode fazer."],
  ["calendario", "Calendário parlamentar", "Plenário, comissões e audições dos próximos dias."],
];
const RES_TAG = (r) => (/aprovad/i.test(r || "") ? "blue" : /rejeitad/i.test(r || "") ? "red" : "");
const novidadesPanel = async (st) => {
  const items = window.NOVIDADES || [];
  const cards = await Promise.all(items.map(async (m) => {
    let num = "";
    try { num = m.num(m.api ? await Portal.api(m.api) : null, st); } catch (e) { num = ""; }
    return `<a class="card link" href="#/${m.route}"><span class="badge-new">Novo</span><h3>${esc(m.title)}</h3><p class="small muted">${esc(m.desc)}</p>${num ? `<b class="cardnum">${esc(num)}</b>` : ""}</a>`;
  }));
  return cards.length ? `<section class="novidades"><h2 class="sec">Novidades</h2><div class="grid novgrid">${cards.join("")}</div></section>` : "";
};
const changesPanel = (ch) => {
  const blocks = [];
  if (ch.contracts && ch.contracts.n) blocks.push(`<section class="panel"><h2>Contratos publicados</h2><p class="small muted">Últimos 7 dias até ${fmtDate(ch.contracts.until)}: <b>${Portal.int(ch.contracts.n)}</b> contratos, <b>${Portal.eur(ch.contracts.value)}</b>.</p>${ch.contracts.top.map((c) => `<div class="row"><div class="what"><a href="#/contrato/${c.id}"><b>${esc((c.object || "").slice(0, 90))}</b></a><div class="small muted">${esc(c.buyer_name || "")} → ${esc(c.seller_name || "")} · ${Portal.eurFull(c.price)}</div></div></div>`).join("")}<p class="small"><a href="#/contratos">Todos os contratos →</a></p></section>`);
  if (ch.votes && ch.votes.length) blocks.push(`<section class="panel"><h2>Votações recentes no Parlamento</h2>${ch.votes.slice(0, 6).map((v) => `<div class="row"><div class="when">${fmtDate(v.data)}</div><div class="what"><a href="#/votacoes/${encodeURIComponent(v.key)}"><b>${esc(v.tipo)} ${v.numero}/${esc(v.leg)}</b></a> <span class="tag ${RES_TAG(v.resultado)}">${esc(v.resultado || "")}</span><div class="small muted">${esc((v.titulo || "").slice(0, 100))} · ${esc(v.fase || "")}</div></div></div>`).join("")}<p class="small"><a href="#/votacoes">Todas as votações →</a></p></section>`);
  if (ch.dre && ch.dre.length) blocks.push(`<section class="panel"><h2>Diário da República</h2>${ch.dre.map((d) => `<div class="small muted" style="margin-top:6px">${fmtDate(d.date)}</div>${d.acts.slice(0, 4).map((a) => `<div class="row"><div class="what"><a href="#/dre/${a.id}"><b>${esc(a.kind)} ${esc(a.number)}</b></a><div class="small muted">${esc((a.summary || a.title || "").slice(0, 110))}</div></div></div>`).join("")}`).join("")}<p class="small"><a href="#/dre">Todas as publicações →</a></p></section>`);
  if (ch.events && ch.events.length) blocks.push(`<section class="panel"><h2>Agenda do Parlamento e Presidência</h2>${ch.events.map(eventRow).join("")}${(ch.news || []).map((n) => `<div class="row"><div class="when">${fmtDate(n.date)}</div><div class="what"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></div></div>`).join("")}</section>`);
  return blocks.length ? `<h2 class="sec">O que mudou</h2><div class="cols">${blocks.join("")}</div>` : "";
};
Portal.page("roadmap", async () => {
  const d = await api("roadmap");
  const meta = { "Em curso": ["now", "A decorrer agora"], "A seguir": ["next", "Planeado"], "Feito": ["done", "Concluído"] };
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">Início</a> / Roadmap</div>
    <div class="pagehead"><div><div class="kicker">Em construção</div><h1>Roadmap</h1><p class="lead">${esc(d.intro)}</p>
      <p class="small muted">Última atualização: ${fmtDate(d.updated)} ${fmtTime(d.updated)}</p></div></div>
    <div class="road">${d.sections.map((sec) => { const [cls, label] = meta[sec.title] || ["next", sec.title]; return `<section class="road-col ${cls}"><h2><span class="road-dot"></span>${esc(sec.title)} <small class="muted">· ${sec.items.length}</small></h2><p class="small muted">${esc(label)}</p>
      ${sec.items.map((i) => `<article class="road-item"><b>${esc(i.title)}</b>${i.text ? `<p>${esc(i.text)}</p>` : ""}</article>`).join("")}</section>`; }).join("")}</div>
    <p class="small muted">Tem uma sugestão ou encontrou um erro? Use o botão <i>A minha lista</i> para seguir as novidades; as correções de qualidade são registadas e verificadas continuamente.</p>`;
});

const homeTiles = () => `<div class="tiles">${HOME_TILES.filter(([r]) => Portal.pages[r]).map(([r, t, d]) => `<a class="tile" href="#/${r}"><b>${esc(t)}</b><span>${esc(d)}</span></a>`).join("")}</div>`;

Portal.page("painel-classico", async () => {
  const [ov, st, act, ch] = await Promise.all([api("overview"), api("status"), api("activity"), api("changes").catch(() => ({}))]);
  const tot = ov.byYear.reduce((a, y) => ({ n: a.n + y.n, v: a.v + y.value }), { n: 0, v: 0 });
  const thisYear = new Date().getFullYear();
  const yrs = ov.byYear.map((y) => ({ year: y.year, value: y.value, n: y.n, direct_value: y.value * (y.direct_pct || 0) / 100, partial: y.year === thisYear }));
  const novi = await novidadesPanel(st);
  $app.innerHTML = `
    <section class="hero"><div class="hero-in">
      <div class="kicker">Portal do poder público</div><h1>Quem decide, quanto gasta, e com quem.</h1>
      <p class="lead">Parlamento, Governo, ministérios, autarquias e ${Portal.int(st.counts.public_bodies)} entidades públicas — ligados aos ${Portal.int(st.counts.contracts)} contratos públicos, ao Diário da República, ao Orçamento, aos fundos europeus e a quem decide.</p>
      <form class="herosearch" id="hsearch" autocomplete="off" role="search"><input id="hq" type="search" placeholder="Entidade, NIF, contrato, lei ou tema…" aria-label="Pesquisa"><button type="submit">Pesquisar</button><div id="hresults" class="results" hidden></div></form>
      <p class="hero-hint">Experimente: <a href="#/contratos?q=iluminação pública">iluminação pública</a> · <a href="#/responsaveis">quem decide</a> · <a href="#/habitacao">habitação</a> · <a href="#/votacoes">votações</a></p>
    </div></section>
    <div class="kpis strip">
      <div class="kpi"><b>${Portal.int(st.counts.contracts)}</b><span>contratos públicos</span></div>
      <div class="kpi"><b>${Portal.eur(tot.v)}</b><span>valor contratado</span></div>
      <div class="kpi"><b>${Portal.int(st.counts.public_bodies)}</b><span>entidades públicas</span></div>
      <div class="kpi"><b>${Portal.int(st.counts.municipios)}</b><span>municípios</span></div>
      <div class="kpi"><b>${Portal.int(st.counts.freguesias)}</b><span>freguesias e juntas</span></div>
    </div>
    ${novi}
    ${changesPanel(ch)}
    ${homeTiles()}
    <div class="cols">
      <section class="panel"><h2>Contratado por ano</h2>${bars(yrs)}</section>
      <section class="panel"><h2>Como se contrata</h2>${table([{ h: "Procedimento", f: (r) => esc(r.procedure) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }, { h: "Nº", num: 1, f: (r) => Portal.int(r.n) }], ov.procedures)}</section>
    </div>
    <div class="cols">
      <section class="panel"><h2>Maiores compradores públicos</h2>${table([{ h: "Entidade", f: (r) => entLink(r.id, r.name) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }], ov.topBuyers)}</section>
      <section class="panel"><h2>Maiores fornecedores do Estado</h2>${table([{ h: "Empresa", f: (r) => entLink(r.id, r.name) }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }, { h: "Clientes", num: 1, f: (r) => r.n_buyers }], ov.topSellers)}</section>
    </div>
    <div class="cols">
      <section class="panel"><h2>Contratos mais recentes</h2>${ov.latest.map((c) => `<a class="list item" style="display:block;padding:8px 0;border-bottom:1px solid var(--line2);text-decoration:none;color:inherit" href="#/contrato/${c.id}"><b>${esc((c.object || "").slice(0, 110))}</b><small class="muted" style="display:block">${esc(c.buyer_name || "")} → ${esc(c.seller_name || "")} · ${Portal.eurFull(c.price)} · ${fmtDate(c.signed)}</small></a>`).join("")}</section>
      <section class="panel"><h2>Próximos no Parlamento</h2>${act.parlamento.map(eventRow).join("")}<p class="small"><a href="#/calendario">Calendário completo →</a></p>
        <h2 style="margin-top:1.2rem">Presidência</h2>${act.presidente.slice(0, 3).map((n) => `<div class="row"><div class="when">${fmtDate(n.date)}</div><div class="what"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></div></div>`).join("")}</section>
    </div>`;
  initSearch($("#hsearch"), $("#hq"), $("#hresults"));
});

Portal.page("entidades", async (_, p) => {
  const page = +p.page || 1, sort = p.sort || "value", limit = 50;
  const d = await api("entities" + Portal.qs({ kind: p.kind, q: p.q, sort, page, limit }));
  const link = (o) => `#/entidades${Portal.qs({ ...p, ...o })}`;
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">Início</a> / Instituições</div>
    <div class="pagehead"><div><h1>Instituições públicas</h1><p class="lead">${Portal.int(d.total)} entidades${p.kind ? " em “" + esc(Portal.kindLabel(p.kind)) + "”" : ""}. Cada uma ligada aos seus contratos, fornecedores e indicadores.</p></div></div>
    <div class="side"><aside class="rail"><h4>Tipo</h4><a href="${link({ kind: "", page: 1 })}" class="${!p.kind ? "on" : ""}">Todas</a>
      ${d.kinds.map((k) => `<a href="${link({ kind: k.kind, page: 1 })}" class="${p.kind === k.kind ? "on" : ""}">${esc(Portal.kindLabel(k.kind))}<span>${Portal.int(k.n)}</span></a>`).join("")}</aside>
    <section>${d.dados_parciais ? `<p class="note small">${esc(d.nota || "dados em atualização")}: a população das entidades ainda não está disponível.</p>` : ""}<div class="toolbar"><input type="search" id="eq" placeholder="Filtrar por nome ou NIF" value="${esc(p.q || "")}" style="flex:1;min-width:200px"></div>
    <div class="panel" style="padding:0">${table([
      { h: "Entidade", sort: "name", f: (r) => `${entLink(r.id, r.name)}<div class="small muted">${esc(Portal.kindLabel(r.kind))}${r.municipality ? " · " + esc(r.municipality) : ""}</div>` },
      { h: "Contratos", sort: "n", num: 1, f: (r) => Portal.int(r.n) }, { h: "Valor", sort: "value", num: 1, f: (r) => Portal.eur(r.value) },
      { h: "% ajuste direto", sort: "direct", num: 1, f: (r) => (r.direct_pct == null ? "—" : `<span class="meter"><i style="width:${r.direct_pct}%"></i></span>${r.direct_pct}%`) },
    ], d.rows, { sort, sortLink: (s) => link({ sort: s, page: 1 }) })}</div>
    ${pager(d.total, page, limit, (n) => link({ page: n }))}</section></div>`;
  $("#eq").onchange = (e) => go("entidades", "", { ...p, q: e.target.value, page: 1 });
});

Portal.page("autarquias", async (_, p) => {
  const kind = p.kind === "freguesia" ? "freguesia" : "municipio", page = +p.page || 1, sort = p.sort || "value", limit = 60;
  const d = await api("localgov" + Portal.qs({ kind, district: p.district, q: p.q, sort, page, limit }));
  const link = (o) => `#/autarquias${Portal.qs({ ...p, ...o })}`;
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">Início</a> / Autarquias</div>
    <div class="pagehead"><div><div class="kicker">Poder local</div><h1>${kind === "municipio" ? `Os ${Portal.int(d.total)} municípios` : `As ${Portal.int(d.total)} freguesias`}</h1>
      <p class="lead">Quanto contrata cada autarquia, quanto por habitante e que parte é por ajuste direto. Clique numa autarquia para ver os seus fornecedores e contratos.</p></div>
      <div class="tabs" style="border:0"><a href="#/autarquias" class="${kind === "municipio" ? "on" : ""}">Municípios</a><a href="#/autarquias?kind=freguesia" class="${kind === "freguesia" ? "on" : ""}">Freguesias</a></div></div>
    <div class="toolbar"><input type="search" id="lq" placeholder="Pesquisar autarquia" value="${esc(p.q || "")}">
      <select id="ld"><option value="">Todas as sub-regiões (NUTS III)</option>${d.districts.map((x) => `<option ${x === p.district ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></div>
    <div class="panel" style="padding:0">${table([
      { h: "Autarquia", sort: "name", f: (r) => `${entLink(r.id, r.name)}<div class="small muted">${esc(r.municipality || r.district || "")}</div>` },
      { h: kind === "freguesia" ? "População (Censos 2021)" : "População", sort: "pop", num: 1, f: (r) => Portal.int(r.population) },
      { h: "Contratos", sort: "n", num: 1, f: (r) => Portal.int(r.n) }, { h: "Valor contratado", sort: "value", num: 1, f: (r) => Portal.eur(r.value) },
      { h: "€ contratados / hab. (acum. desde 2012)", sort: "percapita", num: 1, f: (r) => (r.percapita == null ? "—" : Portal.int(r.percapita) + " €") },
      { h: "% ajuste direto", sort: "direct", num: 1, f: (r) => (r.direct_pct == null ? "—" : `<span class="meter"><i style="width:${r.direct_pct}%"></i></span>${r.direct_pct}%`) },
    ], d.rows, { sort, sortLink: (s) => link({ sort: s, page: 1 }) })}</div>
    ${pager(d.total, page, limit, (n) => link({ page: n }))}
    ${kind === "freguesia" ? '<p class="note warn">As freguesias só têm contratos associados quando o seu nome é inequívoco no registo de contratos; as restantes aparecem sem valores.</p>' : ""}`;
  $("#lq").onchange = (e) => go("autarquias", "", { ...p, q: e.target.value, page: 1 });
  $("#ld").onchange = (e) => go("autarquias", "", { ...p, district: e.target.value, page: 1 });
});

Portal.page("entidade", async (id) => {
  const d = await api("entity?id=" + encodeURIComponent(id)), e = d.entity, b = d.asBuyer, s = d.asSeller;
  const yrs = (d.years || []).map((y) => ({ ...y }));
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">Início</a> / <a href="#/entidades?kind=${esc(e.kind)}">${esc(Portal.kindLabel(e.kind))}</a>${d.parent ? ` / <a href="#/entidade/${d.parent.id}">${esc(d.parent.name)}</a>` : ""}</div>
    <div class="pagehead"><div><div class="kicker">${esc(Portal.kindLabel(e.kind))}${e.is_public ? " · entidade pública" : ""}</div><h1>${esc(e.name)}</h1>
      <div class="small muted">${e.nif ? `NIF ${e.nif}` : "NIF não associado"}${e.district ? ` · Distrito de ${esc(e.district)}` : ""}${e.municipality ? ` · Município de ${esc(e.municipality)}` : ""}${e.population ? ` · ${Portal.int(e.population)} habitantes (${esc(e.population_source || "fonte não indicada")})` : ""}${e.website ? ` · <a href="${esc(e.website)}" target="_blank" rel="noopener">sítio oficial ↗</a>` : ""}${e.wikidata ? ` · <a href="https://www.wikidata.org/wiki/${esc(e.wikidata)}" target="_blank" rel="noopener">Wikidata</a>` : ""}</div></div>
      <div>${Portal.followButton("entity", e.id, e.name)}</div></div>
    ${b || s ? `<div class="kpis">
      ${b ? `<div class="kpi"><b>${Portal.eur(b.value)}</b><span>contratado como comprador</span></div><div class="kpi"><b>${Portal.int(b.n)}</b><span>contratos celebrados</span></div>
        <div class="kpi"><b>${Portal.pct(100 * b.direct_value / (b.value || 1))}</b><span>do valor por ajuste direto</span></div>${d.mods ? `<div class="kpi"><b>${Portal.int(d.mods.modified_n)}</b><span>contratos modificados (+${Portal.eur(d.mods.increase_value)})</span></div>` : ""}${e.population && b.value ? `<div class="kpi"><b>${Portal.int(Math.round(b.value / e.population))} €</b><span>contratados por habitante (2012–hoje, acumulado)</span></div>` : ""}` : ""}
      ${s ? `<div class="kpi"><b>${Portal.eur(s.value)}</b><span>recebido como fornecedor</span></div><div class="kpi"><b>${Portal.int(s.n)}</b><span>contratos ganhos</span></div><div class="kpi"><b>${Portal.int(s.n_buyers)}</b><span>entidades clientes</span></div>` : ""}</div>` : ""}
    ${d.flags && d.flags.length ? `<section class="panel"><h2>Indicadores a observar</h2>${d.flags.map((f) => `<div class="flag ${f.level === "info" ? "info" : ""}"><div><b>${esc(f.label)}</b><p>${esc(f.text)}</p></div></div>`).join("")}
      <p class="small muted">Sinais estatísticos comparados com ${d.peer.n} entidades do mesmo tipo. São pontos de partida para escrutínio, não prova de irregularidade.</p></section>` : ""}
    ${e.description ? `<section class="panel"><p>${esc(e.description)}</p></section>` : ""}
    ${yrs.length ? `<section class="panel"><h2>Evolução anual</h2>${bars(yrs)}</section>` : ""}
    <div class="cols">
      ${d.topSuppliers && d.topSuppliers.length ? `<section class="panel"><h2>Principais fornecedores</h2>${table([{ h: "Fornecedor", f: (r) => entLink(r.eid, r.name || r.nif) }, { h: "Contratos", num: 1, f: (r) => r.n }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }, { h: "% direto", num: 1, f: (r) => Math.round(100 * r.direct_n / r.n) + "%" }], d.topSuppliers)}
        <p class="small"><a href="#/contratos?buyer=${e.nif}">Ver todos os contratos →</a></p></section>` : ""}
      ${d.topClients && d.topClients.length ? `<section class="panel"><h2>Principais clientes públicos</h2>${table([{ h: "Entidade", f: (r) => entLink(r.eid, r.name || r.nif) }, { h: "Contratos", num: 1, f: (r) => r.n }, { h: "Valor", num: 1, f: (r) => Portal.eur(r.value) }], d.topClients)}
        <p class="small"><a href="#/contratos?seller=${e.nif}">Ver todos os contratos →</a></p></section>` : ""}
    </div>
    ${d.recent && d.recent.length ? `<section class="panel"><h2>Contratos recentes</h2>${table([{ h: "Data", f: (r) => fmtDate(r.signed) }, { h: "Objeto", f: (r) => `<a href="#/contrato/${r.id}">${esc((r.object || "").slice(0, 120))}</a>` }, { h: "Comprador → Fornecedor", f: (r) => `<span class="small">${esc(r.buyer_name || "")} → ${esc(r.seller_name || "")}</span>` }, { h: "Preço", num: 1, f: (r) => Portal.eurFull(r.price) }], d.recent)}</section>` : ""}
    ${d.children && d.children.length ? `<section class="panel"><h2>${e.kind === "municipio" ? "Freguesias do município" : "Entidades dependentes"} (${d.children.length})</h2><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">${d.children.map((c) => `<a href="#/entidade/${c.id}">${esc(c.name)}</a>`).join("")}</div></section>` : ""}
    ${!b && !s ? '<p class="note">Sem contratos públicos associados a esta entidade (ainda). Esta entidade foi identificada a partir de outras fontes públicas.</p>' : ""}
    <div id="entity-extra"></div>`;
  // plug-ins can append sections to entity pages
  for (const fn of Portal.entityHooks || []) { try { await fn(d, $("#entity-extra")); } catch (err) { console.warn(err); } }
});
Portal.entityHooks = [];

Portal.page("contratos", async (_, p) => {
  const page = +p.page || 1, limit = 30;
  const d = await api("contracts" + Portal.qs({ q: p.q, buyer: p.buyer, seller: p.seller, procedure: p.procedure, year: p.year, min: p.min, cpv: p.cpv, sort: p.sort || (p.q ? "price" : "date"), page, limit }));
  const link = (o) => `#/contratos${Portal.qs({ ...p, ...o })}`;
  const active = ["buyer", "seller", "procedure", "year", "min", "cpv"].filter((k) => p[k]);
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">Início</a> / Contratos públicos</div>
    <div class="pagehead"><div><div class="kicker">Portal BASE · IMPIC</div><h1>Contratos públicos</h1><p class="lead">Todos os contratos públicos celebrados em Portugal desde 2012. Pesquise por assunto, filtre por procedimento, valor ou ano.</p></div></div>
    <form class="toolbar" id="cf"><input type="search" name="q" placeholder="Assunto (ex.: gabinete de comunicação, iluminação pública)" value="${esc(p.q || "")}" style="flex:2;min-width:240px">
      <select name="procedure"><option value="">Qualquer procedimento</option>${d.procedures.map((x) => `<option ${x.procedure === p.procedure ? "selected" : ""} value="${esc(x.procedure)}">${esc(x.procedure)}</option>`).join("")}</select>
      <select name="year"><option value="">Todos os anos</option>${Array.from({ length: 15 }, (_, i) => 2026 - i).map((y) => `<option ${String(y) === p.year ? "selected" : ""}>${y}</option>`).join("")}</select>
      <input name="min" type="number" placeholder="Valor mínimo €" value="${esc(p.min || "")}" style="width:140px"><button class="btn primary">Filtrar</button></form>
    ${active.some((k) => ["buyer", "seller", "cpv"].includes(k)) ? `<p class="note">Filtros ativos: ${active.map((k) => `${k} = <b>${esc(p[k])}</b>`).join(", ")} · <a href="#/contratos">limpar</a></p>` : ""}
    <p class="muted small">${d.total > 20000 ? "Mais de 20 000" : Portal.int(d.total)} contratos</p>
    <div class="panel" style="padding:0">${table([
      { h: "Data", sort: "date", f: (r) => fmtDate(r.signed) },
      { h: "Objeto do contrato", f: (r) => `<a href="#/contrato/${r.id}">${esc((r.object || "").slice(0, 140))}</a><div class="small muted">${esc(r.procedure || "")}${r.n_bidders ? ` · ${r.n_bidders} concorrente(s)` : ""}</div>` },
      { h: "Comprador", f: (r) => `<a href="#/contratos?buyer=${r.buyer_nif}" style="font-weight:500">${esc(r.buyer_name || "")}</a>` },
      { h: "Fornecedor", f: (r) => `${nifLink(r.seller_nif, r.seller_name)}${r.n_sellers > 1 ? ` <span class="tag">+${r.n_sellers - 1}</span>` : ""}` },
      { h: "Preço", sort: "price", num: 1, f: (r) => Portal.eurFull(r.price) },
    ], d.rows, { sort: p.sort || (p.q ? "price" : "date"), sortLink: (s) => link({ sort: s, page: 1 }) })}</div>
    ${pager(d.total > 20000 ? 20000 : d.total, page, limit, (n) => link({ page: n }))}`;
  $("#cf").onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); go("contratos", "", { ...p, q: f.get("q"), procedure: f.get("procedure"), year: f.get("year"), min: f.get("min"), page: 1 }); };
});

Portal.page("contrato", async (id) => {
  const d = await api("contract?id=" + encodeURIComponent(id)), c = d.contract;
  const row = (k, v) => (v == null || v === "" ? "" : `<tr><th style="width:230px">${k}</th><td>${v}</td></tr>`);
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">Início</a> / <a href="#/contratos">Contratos públicos</a> / ${esc(c.id)}</div>
    <div class="pagehead"><div><div class="kicker">${esc(c.procedure || "Contrato público")}</div><h1>${esc((c.object || "").slice(0, 200))}</h1></div><div>${Portal.followButton("topic", (c.object || "").split(" ").slice(0, 3).join(" "), "Tema: " + (c.object || "").slice(0, 40))}</div></div>
    <div class="kpis"><div class="kpi"><b>${Portal.eurFull(c.price)}</b><span>preço contratual</span></div><div class="kpi"><b>${Portal.eurFull(c.base_price)}</b><span>preço base</span></div>
      <div class="kpi"><b>${c.effective_price ? Portal.eurFull(c.effective_price) : "—"}</b><span>preço efetivo</span></div><div class="kpi"><b>${c.duration_days ?? "—"}</b><span>dias de execução</span></div></div>
    ${d.mods && d.mods.length ? (() => {
      const modRows = (arr) => table([
        { h: "Data", f: (m) => fmtDate(m.date) }, { h: "Fundamento", f: (m) => `<span class="small">${esc(m.basis || "")}</span><div class="small muted">${esc(m.act_type || "")}</div>` },
        { h: "Novo preço", num: 1, f: (m) => Portal.eurFull(m.new_price) },
        { h: "Variação", num: 1, f: (m) => (c.price > 0 && m.new_price ? `<span class="tag ${m.new_price > c.price * 1.25 ? "red" : m.new_price > c.price ? "amber" : "blue"}">${m.new_price >= c.price ? "+" : ""}${((m.new_price / c.price - 1) * 100).toFixed(1)}%</span>` : "—") },
        { h: "Prazo", num: 1, f: (m) => esc(m.new_duration || "—") }], arr);
      const last = d.mods[d.mods.length - 1], recent = d.mods.slice(-8).reverse(), older = d.mods.slice(0, -8).reverse();
      const chg = c.price > 0 && last.new_price ? (last.new_price / c.price - 1) * 100 : null;
      return `<section class="panel"><h2>Modificações ao contrato (${d.mods.length})</h2>
        <p>Preço inicial <b>${Portal.eurFull(c.price)}</b> → preço após a última modificação <b>${Portal.eurFull(last.new_price)}</b>${chg == null ? "" : ` (<b>${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%</b>)`}.</p>
        ${modRows(recent)}${older.length ? `<details style="margin-top:10px"><summary class="small" style="cursor:pointer">Ver as ${older.length} modificações anteriores</summary>${modRows(older)}</details>` : ""}
        <p class="small muted">Cada modificação indica o novo preço total do contrato. Fonte: Portal BASE (modificações contratuais).</p></section>`;
    })() : ""}
    <div class="cols"><section class="panel"><h2>Partes</h2>${table([{ h: "Papel", f: (r) => ({ buyer: "Comprador", seller: "Fornecedor", bidder: "Concorrente" }[r.role]) }, { h: "Entidade", f: (r) => (r.eid ? entLink(r.eid, r.name) : esc(r.name || r.nif)) }, { h: "NIF", f: (r) => esc(r.nif || "—") }], d.parties)}</section>
    <section class="panel"><h2>Detalhes</h2><table>${row("Tipo de contrato", esc(c.types))}${row("Procedimento", esc(c.procedure))}${row("Critério de adjudicação", esc(c.criterion))}${row("Fundamentação", esc(c.legal_basis))}${row("Fundamento do ajuste direto", esc(c.direct_basis))}
      ${row("CPV", esc(c.cpv))}${row("Local de execução", esc(c.location))}${row("Data de publicação", fmtDate(c.published))}${row("Data de adjudicação", fmtDate(c.decision))}${row("Data de celebração", fmtDate(c.signed))}${row("Acordo-quadro", esc(c.framework))}${row("Anúncio", esc(c.announcement))}
      ${c.link ? row("Peças do procedimento", `<a href="${esc(c.link)}" target="_blank" rel="noopener">abrir ↗</a>`) : ""}${row("ID BASE", `<a href="https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id=${esc(c.id)}" target="_blank" rel="noopener">${esc(c.id)} ↗</a>`)}</table></section></div>`;
});

Portal.page("painel", async () => {
  const d = await api("feed?v=" + visitorId());
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">Início</a> / A minha lista</div>
    <div class="pagehead"><div><div class="kicker">Seguir</div><h1>A minha lista</h1><p class="lead">Entidades, temas e leis que segue. Aqui aparecem os novos contratos, eventos e passos legislativos que lhes dizem respeito.</p></div></div>
    ${d.follows.length ? "" : '<p class="note">Ainda não segue nada. Use o botão “+ Seguir” numa entidade, lei ou contrato — ou siga um tema pesquisando-o em “Contratos públicos”.</p>'}
    <form class="toolbar" id="tf"><input name="t" placeholder="Seguir um tema (ex.: habitação, Parque Escolar, ajuste direto)" style="flex:1;min-width:240px"><button class="btn primary">Seguir tema</button></form>
    <div class="cols"><section class="panel"><h2>Novidades</h2>${d.items.map((i) => `<div class="row"><div class="when">${fmtDate(i.date)}</div><div class="what"><span class="tag blue">${esc(i.follow)}</span><br>
      ${i.type === "contract" ? `<a href="#/contrato/${i.id}"><b>${esc((i.object || "").slice(0, 110))}</b></a><div class="small muted">${esc(i.buyer_name || "")} → ${esc(i.seller_name || "")} · ${Portal.eurFull(i.price)}</div>` : i.type === "event" ? `<a href="#/calendario"><b>${esc(i.title.split("\n")[0])}</b></a><div class="small muted">${esc(i.section)}</div>` : `<a href="#/leis/${encodeURIComponent(i.key)}"><b>${esc(i.phase)}</b></a><div class="small muted">${esc(i.body || "")}</div>`}</div></div>`).join("") || '<p class="empty">Sem novidades.</p>'}</section>
    <section class="panel"><h2>A seguir (${d.follows.length})</h2>${d.follows.map((f) => `<div class="row"><div class="what"><span class="tag">${esc(f.kind)}</span> ${f.kind === "entity" ? `<a href="#/entidade/${esc(f.ref)}">${esc(f.label)}</a>` : f.kind === "initiative" ? `<a href="#/leis/${encodeURIComponent(f.ref)}">${esc(f.label)}</a>` : esc(f.label || f.ref)}</div>
      <button class="btn" data-unfollow="${esc(f.kind)}|${esc(f.ref)}">Deixar</button></div>`).join("")}</section></div>`;
  $("#tf").onsubmit = async (e) => { e.preventDefault(); const t = new FormData(e.target).get("t").trim(); if (!t) return; await fetch("/api/follows", { method: "POST", body: JSON.stringify({ v: visitorId(), kind: "topic", ref: t, label: "Tema: " + t }) }); await refreshFollows(); route(); };
  $app.querySelectorAll("[data-unfollow]").forEach((b) => (b.onclick = async () => { const [k, r] = b.dataset.unfollow.split("|"); await fetch(`/api/follows?v=${visitorId()}&kind=${k}&ref=${encodeURIComponent(r)}`, { method: "DELETE" }); await refreshFollows(); route(); }));
});

Portal.page("parlamento", async () => {
  const [st, act] = await Promise.all([api("status"), api("activity")]);
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">Início</a> / Parlamento</div>
    <div class="pagehead"><div><div class="kicker">Assembleia da República · XVII Legislatura</div><h1>Parlamento</h1><p class="lead">230 deputados. Aprova as leis, o Orçamento do Estado e fiscaliza o Governo.</p></div></div>
    <div class="tiles"><a class="tile" href="#/calendario"><b>Calendário</b><span>${Portal.int(st.counts.events)} eventos: plenário, comissões, audições.</span></a>
      <a class="tile" href="#/leis"><b>Leis e iniciativas</b><span>${Portal.int(st.counts.initiatives)} iniciativas com percurso.</span></a>
      <a class="tile" href="#/partidos"><b>Partidos e deputados</b><span>Composição e bancadas.</span></a>
      <a class="tile" href="#/poderes/parlamento"><b>O que faz o Parlamento</b><span>Poderes e limites.</span></a></div>
    <section class="panel"><h2>Próximos eventos</h2>${act.parlamento.map(eventRow).join("")}</section>
    ${st.counts.votes === 0 ? '<p class="note warn">Votações nominais, assiduidade e lista de deputados dependem dos dados abertos do Parlamento, que neste momento não respondem. Ver o roteiro de dados.</p>' : ""}`;
});

Portal.page("presidencia", async () => {
  const [g, act] = await Promise.all([api("government"), api("activity")]);
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">Início</a> / Presidência</div>
    <div class="pagehead"><div><div class="kicker">Chefe de Estado</div><h1>${esc(g.president.name)}</h1><p class="lead">Presidente da República desde ${fmtDate(g.president.since)}. Promulga ou veta as leis, nomeia o Primeiro-Ministro e pode dissolver o Parlamento.</p></div><div><a class="btn" href="#/poderes/presidente">O que pode fazer →</a></div></div>
    <section class="panel"><h2>Últimas notícias da Presidência</h2>${act.presidente.map((n) => `<div class="row"><div class="when">${fmtDate(n.date)}</div><div class="what"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></div></div>`).join("")}</section>`;
});

/* legacy pages (app.js) */
Portal.page("calendario", () => pageCalendar());
Portal.page("leis", (arg) => (arg ? pageLaw(arg) : pageLaws()));
Portal.page("partidos", () => pageParties());
Portal.page("governo", () => pageGov());
Portal.page("poderes", (arg) => pagePowers(arg));

/* ---------- router ---------- */
let routeSeq = 0, firstRoute = true;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const SKELETON = '<div class="sk sk-page" aria-busy="true" aria-label="A carregar"><div class="sk-b sk-kick"></div><div class="sk-b sk-h"></div><div class="sk-b sk-l"></div><div class="sk-grid"><div class="sk-b sk-c"></div><div class="sk-b sk-c"></div><div class="sk-b sk-c"></div></div><div class="sk-b sk-t"></div></div>';
Portal.skeleton = () => SKELETON;
async function route(soft) {
  soft = soft === true;
  const seq = ++routeSeq;
  const { name, arg, params } = parseHash();
  if (Portal.storyHandle && Portal.storyHandle(name, arg, params)) return;
  if (Portal.storyUnmount) Portal.storyUnmount();
  if (!soft) { EA.used.clear(); EA.swr = false; }
  document.body.classList.remove("nav-open");
  document.body.classList.toggle("is-home", name === "painel-classico");
  document.body.classList.toggle("is-ed", name === "" || name === "edicao");
  const cur = name === "historia" && arg ? "historia/" + String(arg).split("/")[0] : name;
  document.querySelectorAll(".mainnav a").forEach((a) => a.classList.toggle("on", a.dataset.r === cur));
  document.querySelectorAll(".grp").forEach((g) => g.classList.toggle("on", !!g.querySelector("a.on")));
  const instant = soft || pageReady(name, arg);
  if (!instant) { $app.innerHTML = SKELETON; if (name !== "" && name !== "edicao") window.scrollTo(0, 0); }
  await ensure(name, arg);
  if (seq !== routeSeq) return;
  const fn = Portal.pages[name];
  if (!fn) { $app.innerHTML = '<p class="note warn">Página não encontrada.</p>'; return; }
  const run = async () => {
    try { await fn(arg, params); } catch (e) { console.error(e); if (e && e.status === 503) { const h = document.getElementById("ed-plate"); if (h) h.remove(); $app.innerHTML = noDataHtml(e); } else $app.innerHTML = `<p class="note warn">Não foi possível carregar esta página (${esc(e.message)}).</p>`; }
  };
  if (instant && !soft && !firstRoute && !reducedMotion.matches && document.startViewTransition && name !== "historia") { try { await document.startViewTransition(run).updateCallbackDone; } catch { } } else await run();
  firstRoute = false;
  if (seq !== routeSeq) return;
  if (!soft && !["entidades", "autarquias", "contratos", "calendario", "historia"].includes(name)) window.scrollTo(0, 0);
  if (!soft && !arg) { try { const learned = JSON.parse(localStorage.getItem("ea:learn") || "{}"); learned[name] = [...EA.used].filter((p) => !/^(follows|feed|search|modules)(\b|$)/.test(p) && !p.includes("?")).slice(0, 8); localStorage.setItem("ea:learn", JSON.stringify(learned)); EAR.data[name] ||= learned[name]; } catch { } }
}
EA.stale = (p) => { const ae = document.activeElement; if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return; if (EA.used.has(p) && !EA.swr) { EA.swr = true; const y = window.scrollY; route(true).then(() => window.scrollTo(0, y)); } };
Portal.route = route;
window.route = route;

const NAV_GROUPS = [
  ["Parlamento", "parlamento", [["calendario", "Calendário"], ["leis", "Leis em curso"], ["votacoes", "Votações"], ["posicoes", "Posições dos partidos"], ["deputados", "Deputados"], ["partidos", "Partidos"], ["eleicoes", "Eleições"], ["parlamento", "Visão geral"]]],
  ["Governo", "governo", [["governo", "Governo"], ["ministerios", "Ministérios"], ["responsaveis", "Quem decide"], ["presidencia", "Presidência"], ["estado", "Estado e empresas"], ["poderes", "Os poderes"]]],
  ["Dinheiro público", "dinheiro", [["contratos", "Contratos públicos"], ["orcamento", "Orçamento do Estado"], ["apoios", "Apoios públicos"], ["anuncios", "Concursos e anúncios"], ["fundos", "Fundos europeus"], ["risco", "Sinais de risco"], ["divida", "Dívida pública"]]],
  ["Poder local", "poder-local", [["autarquias", "Municípios e freguesias"], ["autarquias-mapa", "Câmaras: poder e contas"], ["regioes", "Regiões autónomas"], ["empresas-locais", "Empresas municipais"], ["igf", "Inspeção-Geral de Finanças"]]],
  ["Instituições", "instituicoes", [["entidades", "Diretório"], ["reguladores", "Reguladores"], ["educacao", "Educação"], ["saude", "Saúde"], ["seguranca", "Segurança"]]],
  ["Leis e justiça", "leis-justica", [["dre", "Diário da República"], ["justica", "Justiça"], ["provedor", "Provedor de Justiça"], ["atos-presidente", "Atos do Presidente"]]],
  ["Indicadores", "indicadores", [["indicadores", "Indicadores"], ["habitacao", "Habitação"], ["imigracao", "Imigração"], ["dgeec", "Educação (DGEEC)"]]],
  ["Roadmap", null, [["roadmap", "Roadmap"]]],
];
Portal.NAV_GROUPS = NAV_GROUPS;
let navBound = false;
function buildNav() {
  const groups = NAV_GROUPS.map(([label, slug, items]) => [label, slug, items.filter(([r]) => Portal.hasPage(r))]).filter(([, , items]) => items.length);
  $("#navwrap").innerHTML = groups.map(([label, slug, items]) => !slug
    ? `<a href="#/${items[0][0]}" data-r="${items[0][0]}">${esc(items[0][1])}</a>`
    : `<div class="grp" data-slug="${slug}"><a class="grp-link" href="#/historia/${slug}" data-r="historia/${slug}">${esc(label)}</a><button type="button" class="grp-btn" aria-haspopup="true" aria-expanded="false" aria-label="Abrir menu: ${esc(label)}"><span aria-hidden="true">▾</span></button><div class="menu"><a href="#/historia/${slug}" data-r="historia/${slug}" class="menu-story">A história</a>${items.map(([r, l]) => `<a href="#/${r}" data-r="${r}">${esc(l)}</a>`).join("")}</div></div>`).join("");
  if (navBound) { const { name, arg } = parseHash(); const cur = name === "historia" && arg ? "historia/" + String(arg).split("/")[0] : name; document.querySelectorAll(".mainnav a").forEach((a) => a.classList.toggle("on", a.dataset.r === cur)); document.querySelectorAll(".grp").forEach((g) => g.classList.toggle("on", !!g.querySelector("a.on"))); return; }
  navBound = true;
  const closeAll = (except) => document.querySelectorAll(".grp.open").forEach((x) => { if (x !== except) { x.classList.remove("open"); const b = x.querySelector(".grp-btn"); if (b) b.setAttribute("aria-expanded", "false"); } });
  $("#navwrap").addEventListener("click", (e) => {
    const b = e.target.closest(".grp-btn");
    if (b) { const g = b.parentElement, open = g.classList.contains("open"); closeAll(); if (!open) { g.classList.add("open"); b.setAttribute("aria-expanded", "true"); } }
    else closeAll();
  });
  $("#navwrap").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { const g = e.target.closest(".grp"); closeAll(); if (g) { const b = g.querySelector(".grp-btn"); if (b) b.focus(); } }
    else if (e.key === "ArrowDown" && e.target.closest(".grp-btn")) { const g = e.target.closest(".grp"); closeAll(g); g.classList.add("open"); g.querySelector(".grp-btn").setAttribute("aria-expanded", "true"); const a = g.querySelector(".menu a"); if (a) a.focus(); e.preventDefault(); }
  });
  $("#navwrap").addEventListener("focusout", (e) => { const g = e.target.closest(".grp"); if (g && g.classList.contains("open") && e.relatedTarget && !g.contains(e.relatedTarget)) closeAll(); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".grp")) closeAll(); });
}

const prefetchTarget = (e) => { const a = e.target.closest && e.target.closest('a[href^="#/"]'); if (a) prefetch(a.getAttribute("href")); };
function initPrefetch() {
  const conn = navigator.connection || {};
  if (noPrefetch) return;
  document.addEventListener("pointerover", (e) => { if (e.pointerType !== "touch") prefetchTarget(e); }, { passive: true });
  document.addEventListener("focusin", prefetchTarget, { passive: true });
  document.addEventListener("touchstart", prefetchTarget, { passive: true });
  if (conn.saveData || /2g/.test(conn.effectiveType || "") || !window.IntersectionObserver) return;
  const io = new IntersectionObserver((es) => { for (const en of es) if (en.isIntersecting) { io.unobserve(en.target); idle(() => { const h = en.target.getAttribute("href"); const m = /^#\/?([^/?]*)\/?([^?]*)/.exec(h || ""); if (m && !prefetched.has(h)) { const name = m[1], arg = m[2]; if (name !== "historia") ensure(name, arg).catch(() => {}); } }, 3000); } }, { rootMargin: "100px" });
  const watch = () => document.querySelectorAll('#app a[href^="#/"]').forEach((a) => { if (!a.dataset.pf) { a.dataset.pf = "1"; io.observe(a); } });
  new MutationObserver(() => idle(watch, 2500)).observe($app, { childList: true, subtree: true });
}

const syncFollows = () => document.querySelectorAll("[data-follow]").forEach((b) => { const on = isFollowing(b.dataset.follow, b.dataset.ref); b.classList.toggle("on", on); b.textContent = on ? "A seguir ✓" : "+ Seguir"; });

window.PORTAL_START = () => {
  try { const learned = JSON.parse(localStorage.getItem("ea:learn") || "{}"); for (const k of Object.keys(learned)) EAR.data[k] ||= learned[k]; } catch { }
  initSearch();
  buildNav();
  initPrefetch();
  window.addEventListener("hashchange", () => route());
  route();
  idle(async () => {
    await refreshFollows(); syncFollows();
    api("status").then((s) => { $("#freshness").textContent = s.contracts_updated ? `Contratos atualizados ${s.contracts_updated.slice(0, 10)} · agenda ${String(s.agenda_updated || "").slice(0, 10)}` : ""; }).catch(() => {});
    try { const m = await (await fetch("/api/modules")).json(); const extra = m.client.filter((f) => !EAR.files.includes(f)); if (extra.length) { await loadAllModules(); buildNav(); } } catch { }
  }, 2500);
};
