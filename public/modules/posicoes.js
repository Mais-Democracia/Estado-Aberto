"use strict";
(() => {
  const { esc, api, int, fmtDate, table } = Portal;
  const PCOL = { PSD: "#f48a1f", CH: "#202056", PS: "#e8537a", IL: "#00a7e6", L: "#8bc34a", PCP: "#c8102e", BE: "#a00000", "CDS-PP": "#0073c2", PAN: "#2a9d8f", JPP: "#6a4c93" };
  const SL = { favor: "a favor", contra: "contra", "abstenção": "abstenção", dividido: "dividido", varia: "varia", ausencia: "ausente" };
  const pc = (a, b) => (b ? (100 * a / b).toFixed(0) + "%" : "—");
  const ext = (u, l) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(l)} ↗</a>` : "");
  const css = `<style id="pos-css">
    .pos-tabs { display:flex; gap:6px; flex-wrap:wrap; margin:12px 0 14px; } .pos-tabs a { padding:5px 12px; border:1px solid var(--line); border-radius:999px; text-decoration:none; color:var(--ink); background:var(--card); cursor:pointer; font-size:.9rem; }
    .pos-tabs a.on { background:var(--ink); color:var(--card); }
    .pos-chip { display:inline-block; padding:1px 9px; border-radius:6px; font-size:.82rem; font-weight:600; border:1px solid var(--line); }
    .pos-favor { background:#dff3e4; color:#14532d; border-color:#9fd5ae } .pos-contra { background:#fde2e2; color:#7f1d1d; border-color:#f3a5a5 }
    .pos-abstenção { background:#fdf1d6; color:#713f12; border-color:#ecc97a } .pos-dividido,.pos-varia,.pos-ausencia { background:var(--chip,#eef); color:var(--ink) }
    .pos-ok { color:#15803d; font-weight:700 } .pos-ko { color:#b91c1c; font-weight:700 } .pos-na { color:var(--muted,#667) }
    .pos-matrix { border-collapse:collapse; font-size:.86rem; width:100%; } .pos-matrix th, .pos-matrix td { border:1px solid var(--line); padding:4px 7px; text-align:right; }
    .pos-matrix th:first-child, .pos-matrix td:first-child { text-align:left; } .pos-matrix thead th { position:sticky; top:0; background:var(--card); }
    .pos-matrix td a { display:block; color:inherit; text-decoration:none; } .pos-matrix td.z { color:var(--muted,#99a); }
    .pos-method { border-left:4px solid #b7791f; background:#fffaf0; padding:10px 16px; margin:0 0 16px; border-radius:4px; font-size:.9rem; } .pos-method ul { margin:.3rem 0 .3rem 1.1rem; padding:0; }
    .pos-quote { font-style:italic; margin:0; padding:2px 8px; border-left:3px solid var(--line); font-size:.88rem; max-width:560px; } .pos-quote mark { background:#fff3b0; font-style:normal; }
    .pos-kpis { display:flex; flex-wrap:wrap; gap:12px; margin:8px 0 14px; } .pos-kpis div { border:1px solid var(--line); border-radius:8px; padding:8px 14px; background:var(--card); } .pos-kpis b { display:block; font-size:1.25rem; }
    .pos-bar { height:8px; background:var(--chip,#eee); border-radius:4px; overflow:hidden; min-width:80px; } .pos-bar i { display:block; height:100%; background:var(--pc,#5b6475); }
    .pos-scroll { overflow-x:auto; } .pos-scroll .tblwrap, .panel .pos-scroll .tblwrap { max-height:none; overflow:visible; } #app h3 { margin:26px 0 10px; } .pos-quote a { font-weight:400; }
  </style>`;
  const partyChip = (p) => `<a href="#/posicoes/${encodeURIComponent(p)}" class="chip dot" style="--c:${PCOL[p] || "#5b6475"}">${esc(p)}</a>`;
  const vchip = (s) => `<span class="pos-chip pos-${esc(s)}">${esc(SL[s] || s)}</span>`;
  const iniLink = (r) => `<a href="#/votacoes/${r.bid}">${esc(r.ref || "Iniciativa " + r.bid)}</a>`;

  function highlight(text) {
    const rx = /vot(?:aremos|amos|emos)[^.?!]{0,60}?(?:a favor|favoravelmente|contra|desfavoravelmente|absten[cç][aã]o)|(?:vamos|iremos|vou|irei)[^.?!]{0,50}?(?:votar[^.?!]{0,40}?(?:a favor|favoravelmente|contra|desfavoravelmente)|abster)|abster-?nos-?emos|abstermo-nos|abstemo-nos|o nosso voto (?:ser[aá]|é)[^.?!]{0,30}/i;
    const m = rx.exec(text);
    if (!m) return esc(text);
    return esc(text.slice(0, m.index)) + "<mark>" + esc(m[0]) + "</mark>" + esc(text.slice(m.index + m[0].length));
  }

  function declTable(items, showParty) {
    if (!items.length) return `<p class="muted">Sem declarações explícitas de voto neste âmbito: <b>sem declaração explícita</b>.</p>`;
    return `<div class="pos-scroll">` + table([
      { h: "Discurso", f: (r) => fmtDate(r.data_discurso) },
      ...(showParty ? [{ h: "Partido", f: (r) => partyChip(r.partido) }] : []),
      { h: "Orador", f: (r) => (r.dep_bid ? `<a href="#/deputados/${r.dep_bid}">${esc(r.orador)}</a>` : esc(r.orador)) },
      { h: "Iniciativa", f: (r) => `${iniLink(r)}<div class="small muted">${esc((r.titulo || "").slice(0, 130))}</div>${r.n_inic_discurso > 1 ? `<div class="small muted">debate conjunto de ${r.n_inic_discurso} iniciativas, mesmo sentido de voto do partido em todas</div>` : ""}` },
      { h: "Citação literal", f: (r) => `<p class="pos-quote">${highlight(r.citacao)}</p><div class="small">${ext(r.source_url, "Diário da AR (PDF)")} · <a href="#/votacoes/${r.bid}?tab=iv">intervenções desta iniciativa</a></div>` },
      { h: "Declarou", f: (r) => vchip(r.declarado) },
      { h: "Votou", f: (r) => `${vchip(r.voto)}<div class="small muted">${esc(r.fase)} · ${fmtDate(r.data_voto)} · ${esc(r.voto_origem)}</div><div class="small">${ext(r.voto_url, "fonte do voto")}</div>` },
      { h: "Coincide", f: (r) => (r.estado !== "comparavel" ? `<span class="pos-na">não comparável (${esc(r.estado)})</span>` : r.coincide ? `<span class="pos-ok">sim</span>` : `<span class="pos-ko">não</span>`) },
    ], items) + `</div>`;
  }

  const sumLine = (s) => `${s.comparaveis} comparáveis: <b class="pos-ok">${s.coincidem} coincidem</b>, <b class="pos-ko">${s.divergem} divergem</b>${s.nao_comparaveis ? `; ${s.nao_comparaveis} não comparáveis (voto dividido)` : ""}`;

  function method(st) {
    const c = st.coverage, d = st.declarations;
    const excl = st.excluded.map((e) => `<li>${int(e.n)} × ${esc(e.motivo)}</li>`).join("");
    return `<div class="pos-method"><b>Metodologia e limites</b>
      <ul>
        <li><b>Âmbito:</b> apenas as legislaturas ${c.legs.map((l) => `${esc(l.leg)} (${fmtDate(l.primeira)} a ${fmtDate(l.ultima)}; ${int(l.n)} intervenções)`).join(" e ")}. Intervenções em sessão plenária com mais de 40 palavras (Diário da AR, I Série); não há dados anteriores, nem comissões.</li>
        <li><b>Ligação a iniciativas:</b> só ${int(c.linked)} de ${int(c.speeches)} intervenções (${pc(c.linked, c.speeches)}) estão ligadas a uma iniciativa, pelo anúncio da ordem do dia feito pelo Presidente. As restantes não têm tema nem entram na comparação.</li>
        <li><b>Temas:</b> atribuídos por palavras-chave (<a href="#/posicoes?config=1">lista completa</a>) ao <i>título</i> da iniciativa, não ao texto do discurso; ${int(c.with_topic)} intervenções ficam com pelo menos um tema. Uma iniciativa pode ter vários temas.</li>
        <li><b>Tempo de palavra:</b> o Diário não publica durações; mostram-se contagens de palavras.</li>
        <li><b>Sem modelo de sentimento:</b> a posição declarada só existe quando uma frase explícita, na primeira pessoa do plural (ex.: “votaremos a favor”, “vamos votar contra”, “vamos abster-nos”), aparece literalmente no discurso; sem isso, <b>sem declaração explícita</b>. Frases negadas, condicionais, com ressalva (“mas”, “exceto”) ou sobre parte da iniciativa (recurso, requerimento, artigo, proposta de alteração) são descartadas.</li>
        <li><b>Voto comparado:</b> sentido do grupo parlamentar na primeira votação em plenário (generalidade, final global, deliberação) nos ${st.janela_dias} dias seguintes ao discurso; votações na especialidade ficam de fora. Se houver votações com sentidos diferentes ou iniciativas do mesmo debate com votos diferentes, a declaração é descartada por ambiguidade. A Assembleia não publica o voto individual de cada deputado na maioria dos casos.</li>
        <li><b>Amostra pequena:</b> ${int(d.declaracoes)} declarações explícitas passaram todos os filtros (${int(d.comparaveis)} comparáveis: ${int(d.coincidem)} coincidem, ${int(d.divergem)} divergem). Não permite classificar partidos nem deputados; cada linha deve ser lida com a citação.</li>
      </ul>
      ${excl ? `<details><summary>Declarações encontradas mas descartadas</summary><ul>${excl}</ul></details>` : ""}
      <span class="small muted">Atualizado em ${esc(st.updated_at || "—")}. Fontes: intervencoes.db (Diário da AR) e votacoes.db (parlamento.pt).</span></div>`;
  }

  function topicRows(temas, party) {
    const max = Math.max(1, ...temas.map((t) => t.n)), tot = temas.reduce((s, t) => s + t.n, 0);
    return table([
      { h: "Tema", f: (t) => (party ? `<a href="#/posicoes/${encodeURIComponent(party)}?tema=${encodeURIComponent(t.tema)}">${esc(t.tema)}</a>` : esc(t.tema)) },
      { h: "Intervenções", f: (t) => int(t.n) },
      { h: "", f: (t) => `<div class="pos-bar" style="--pc:${PCOL[party] || "#5b6475"}"><i style="width:${(100 * t.n / max).toFixed(0)}%"></i></div>` },
      { h: "Palavras", f: (t) => int(t.palavras || 0) },
      { h: "% das ligadas", f: (t) => pc(t.n, tot) },
    ], temas);
  }

  async function matrixPage() {
    const [st, m, d] = await Promise.all([api("posicoes/stats"), api("posicoes/matriz"), api("posicoes/declaracoes?limit=60")]);
    if (!st.available) { $app.innerHTML = `${css}<div class="pagehead"><div><h1>Posições</h1></div></div><p class="note warn">${esc(st.error)}</p>`; return; }
    const cell = new Map(m.cells.map((c) => [c.tema + "|" + c.partido, c]));
    const tot = new Map(m.totals.map((t) => [t.partido, t]));
    const colMax = {}; m.parties.forEach((p) => { colMax[p] = Math.max(1, ...m.topics.map((t) => (cell.get(t + "|" + p) || { n: 0 }).n)); });
    const head = `<tr><th>Tema</th>${m.parties.map((p) => `<th><a href="#/posicoes/${encodeURIComponent(p)}" style="color:${PCOL[p] || "inherit"}">${esc(p)}</a></th>`).join("")}</tr>`;
    const body = m.topics.map((t) => `<tr><td>${esc(t)}</td>${m.parties.map((p) => {
      const c = cell.get(t + "|" + p);
      if (!c) return `<td class="z">0</td>`;
      const a = (0.08 + 0.55 * c.n / colMax[p]).toFixed(2);
      return `<td style="background:${PCOL[p] || "#5b6475"}${Math.round(a * 255).toString(16).padStart(2, "0")}"><a href="#/posicoes/${encodeURIComponent(p)}?tema=${encodeURIComponent(t)}" title="${esc(p)} · ${esc(t)}: ${c.n} intervenções, ${int(c.palavras || 0)} palavras (${pc(c.n, tot.get(p).ligadas)} das ligadas do partido)">${c.n}</a></td>`;
    }).join("")}</tr>`).join("");
    const foot = `<tr><th>Total de intervenções do partido</th>${m.parties.map((p) => `<th>${int((tot.get(p) || {}).n || 0)}</th>`).join("")}</tr><tr><th>das quais ligadas a iniciativas</th>${m.parties.map((p) => `<th>${int((tot.get(p) || {}).ligadas || 0)}</th>`).join("")}</tr><tr><th>Palavras ditas</th>${m.parties.map((p) => `<th>${int((tot.get(p) || {}).palavras || 0)}</th>`).join("")}</tr>`;
    const dc = d.partidos.map((x) => ({ ...x }));
    $app.innerHTML = `${css}<div class="pagehead"><div><div class="kicker">Discurso e voto · Assembleia da República</div><h1>Posições</h1>
      <p class="lead">O que cada partido diz em plenário, em que temas, e se o que declara explicitamente coincide com o que depois vota. Só factos do Diário da AR e das votações; sem classificação de sentimento.</p></div></div>
      ${method(st)}
      <section class="panel"><h2>Temas × partidos (número de intervenções)</h2><p class="small muted">${esc(m.note)}</p>
      <div class="pos-scroll"><table class="pos-matrix"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div></section>
      <section class="panel"><h2>Declarado versus votado, por partido</h2>
      <p class="small muted">Só contam intervenções em que a frase de voto aparece literalmente (citada abaixo). Os partidos sem linhas não tiveram nenhuma declaração que passasse os filtros.</p>
      ${table([{ h: "Partido", f: (x) => partyChip(x.partido) }, { h: "Declarações", f: (x) => x.declaracoes }, { h: "Coincidem", f: (x) => `<span class="pos-ok">${x.coincidem}</span>` }, { h: "Divergem", f: (x) => `<span class="pos-ko">${x.divergem}</span>` }, { h: "Não comparáveis", f: (x) => x.nao_comparaveis }], dc)}
      ${dc.map((x) => `<h3 id="pos-${esc(x.partido)}">${esc(x.partido)} <span class="small muted">· ${sumLine(x)}</span></h3>${declTable(x.items, false)}`).join("")}</section>`;
  }

  async function configPage() {
    const c = await api("posicoes/config");
    $app.innerHTML = `${css}<div class="pagehead"><div><div class="kicker">Posições · taxonomia</div><h1>Temas e palavras-chave</h1><p class="lead">${esc(c.nota || "")}</p></div></div>
      <p><a href="#/posicoes">← Voltar a Posições</a></p>
      ${Object.entries(c.temas || {}).map(([t, k]) => `<section class="panel"><h3>${esc(t)}</h3><p class="small">${k.map((x) => `<code>${esc(x.trim())}</code>`).join(" ")}</p></section>`).join("")}`;
  }

  function profileHtml(r, st, who) {
    const f = r.fala, party = who.party;
    let html = `<div class="pos-kpis"><div><b>${int(f.n)}</b>intervenções</div><div><b>${int(f.palavras || 0)}</b>palavras</div><div><b>${int(f.ligadas || 0)}</b>ligadas a iniciativas (${pc(f.ligadas, f.n)})</div><div><b>${fmtDate(f.primeira)}</b>a ${fmtDate(f.ultima)}</div>`;
    if (party && r.falou_e_votou) html += `<div><b>${int(r.falou_e_votou.n)}</b>iniciativas em que falou e votou</div>`;
    html += `</div>`;
    html += `<h3>Temas das intervenções (via título das iniciativas)</h3>${r.temas.length ? topicRows(r.temas, party) : `<p class="muted">Nenhuma intervenção ligada a iniciativa com tema atribuído.</p>`}`;
    if (party && r.votos.length) {
      const order = ["favor", "contra", "abstenção", "dividido", "varia"];
      html += `<h3>Sentido de voto nas iniciativas em que o partido falou e votou</h3><p class="small muted">Voto do grupo parlamentar na primeira votação em plenário até ${st.janela_dias} dias depois da primeira intervenção. Não indica a posição do discurso.</p><p>${order.map((s) => { const x = r.votos.find((v) => v.voto === s); return x ? `${vchip(s)} ${int(x.n)}` : ""; }).filter(Boolean).join(" &nbsp; ")}</p>`;
    }
    html += `<h3>Declarado versus votado</h3><p class="small muted">${r.declaracoes ? sumLine(r) : "Nenhuma declaração explícita de voto passou os filtros: <b>sem declaração explícita</b>."}${who.dep ? " O voto comparado é o do grupo parlamentar do deputado (a fonte não publica, em regra, o voto individual)." : ""}</p>${r.declaracoes ? declTable(r.declaracoes_itens, false) : ""}`;
    return html;
  }

  async function partyPage(p, params) {
    const [st, r] = await Promise.all([api("posicoes/stats"), api("posicoes/partido?p=" + encodeURIComponent(p))]);
    if (!st.available || r.error) { $app.innerHTML = `${css}<p class="note warn">${esc(st.error || r.error)}</p><p><a href="#/posicoes">← Posições</a></p>`; return; }
    const tema = params && params.tema;
    const ini = await api("posicoes/iniciativas?p=" + encodeURIComponent(p) + "&limit=80" + (tema ? "&tema=" + encodeURIComponent(tema) : ""));
    $app.innerHTML = `${css}<div class="pagehead"><div><div class="kicker"><a href="#/posicoes">Posições</a> · partido</div><h1>${esc(p)}</h1>
      <p class="lead">Temas, volume de intervenções e coerência entre o que declara e o que vota. <a href="#/votacoes?tab=partidos&code=${encodeURIComponent(p)}">Como vota o ${esc(p)} →</a></p></div></div>
      ${method(st)}${profileHtml(r, st, { party: p })}
      <h3>${tema ? `Iniciativas do tema “${esc(tema)}” em que falou e votou (<a href="#/posicoes/${encodeURIComponent(p)}">limpar</a>)` : "Iniciativas recentes em que falou e votou"}</h3>
      ${ini.items.length ? table([{ h: "Primeira fala", f: (x) => fmtDate(x.primeira_fala) }, { h: "Iniciativa", f: (x) => `${iniLink(x)}<div class="small muted">${esc((x.titulo || "").slice(0, 140))}</div>` }, { h: "Falas", f: (x) => `${x.n_falas} (${int(x.palavras)} palavras)` }, { h: "Voto do grupo", f: (x) => `${vchip(x.voto)}<div class="small muted">${esc(x.fase)} · ${fmtDate(x.data_voto)}</div>` }, { h: "Declaração explícita", f: (x) => (x.decl_id ? `<span class="pos-ok">ver declaração acima</span>` : `<span class="pos-na">sem declaração explícita</span>`) }], ini.items) : `<p class="muted">Sem iniciativas neste filtro.</p>`}
      <h3>Deputados que mais intervêm</h3>${table([{ h: "Deputado", f: (x) => `<a href="#/deputados/${x.dep_bid}">${esc(x.orador)}</a>` }, { h: "Intervenções", f: (x) => x.n }, { h: "Palavras", f: (x) => int(x.palavras || 0) }], r.deputados)}`;
  }

  async function mainPage(arg, params) {
    if (params && params.config) return configPage();
    if (arg) return partyPage(arg, params);
    return matrixPage();
  }

  Portal.page("posicoes", mainPage);
  Portal.nav("Posições", "#/posicoes");

  async function waitFor(sel, valid) {
    for (let k = 0; k < 60; k++) {
      const el = $app.querySelector(sel);
      if (el && valid()) return el;
      if (!valid()) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  }

  async function decorateParty() {
    const h = location.hash;
    if (!/^#\/votacoes\?/.test(h)) return;
    const code = (h.match(/[?&]code=([^&]+)/) || [])[1];
    const valid = () => /^#\/votacoes\?/.test(location.hash);
    const tabs = await waitFor(".vt-tabs", valid);
    if (!tabs || tabs.querySelector("[data-pos]")) return;
    const a = document.createElement("a");
    a.dataset.pos = "1";
    a.href = code ? "#/posicoes/" + code : "#/posicoes";
    a.textContent = "Posições";
    tabs.append(a);
  }

  async function decorateDeputy() {
    const m = location.hash.match(/^#\/deputados\/(\d+)/);
    if (!m) return;
    const valid = () => location.hash.startsWith("#/deputados/" + m[1]);
    const r = await api("posicoes/deputado?id=" + m[1]).catch(() => null);
    if (!r || !r.available || r.empty) return;
    const head = await waitFor(".pagehead", valid);
    if (!head || $app.querySelector("#pos-wrap")) return;
    const st = await api("posicoes/stats").catch(() => null);
    if (!st || !st.available) return;
    const rest = []; for (let n = head.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
    const proc = document.createElement("div"); proc.id = "pos-proc"; rest.forEach((n) => proc.append(n));
    const panel = document.createElement("div"); panel.id = "pos-panel"; panel.hidden = true;
    panel.innerHTML = `<p class="note">Posições de ${esc(r.deputado.orador)} (${esc(r.deputado.partido || "—")}) nas intervenções em plenário ligadas a iniciativas. Os limites do método estão no <a href="#/posicoes">painel de metodologia</a>: sem modelo de sentimento, só declarações literais, XVI e XVII.</p>${profileHtml(r, st, { dep: true })}`;
    const tabs = document.createElement("div"); tabs.className = "pos-tabs"; tabs.id = "pos-wrap";
    tabs.innerHTML = css + `<a class="on" data-t="proc">Perfil</a><a data-t="pos">Posições (${int(r.fala.n)} intervenções)</a>`;
    head.after(tabs); tabs.after(proc, panel);
    tabs.querySelectorAll("a[data-t]").forEach((a) => {
      a.onclick = () => {
        const on = a.dataset.t === "pos";
        tabs.querySelectorAll("a[data-t]").forEach((b) => b.classList.toggle("on", b === a));
        proc.hidden = on; panel.hidden = !on;
      };
    });
  }

  const run = () => { decorateParty(); decorateDeputy(); };
  window.addEventListener("hashchange", run);
  run();
})();
