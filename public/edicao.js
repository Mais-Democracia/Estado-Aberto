(() => {
  "use strict";
  const nf = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat("pt-PT");
  const MES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const ART = new Set(["contrato", "voto", "relatorio", "ato", "apoio", "entidade", "regulador", "declaracao", "nomeacao"]);
  const href = (ref) => (ART.has(ref.split("/")[0]) ? "#/artigo/" + ref : "#/" + ref);
  const pd = (s) => { const d = new Date(String(s).slice(0, 10) + "T00:00:00Z"); return `${d.getUTCDate()} de ${MES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`; };
  const fmtV = (v, k) => {
    if (k === "int") return nf0.format(v);
    if (v >= 1e9) return nf.format(v / 1e9) + " mM€";
    if (v >= 1e6) return nf.format(v / 1e6) + " M€";
    if (v >= 1e3) return nf.format(v / 1e3) + " mil €";
    return nf0.format(v) + " €";
  };
  if (q0().get("anim") === "0") document.documentElement.classList.add("noanim");
  function q0() { return new URLSearchParams(location.search); }
  const THEME_KEY = "ed-tema";
  const applyTheme = (t) => { document.documentElement.setAttribute("data-theme", t); try { localStorage.setItem(THEME_KEY, t); } catch {} const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t === "dark" ? "#131210" : "#faf7f0"; };
  const q = new URLSearchParams(location.search);
  applyTheme(q.get("tema") === "noite" ? "dark" : q.get("tema") === "dia" ? "light" : (() => { try { return localStorage.getItem(THEME_KEY); } catch {} })() || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const toggleTheme = () => applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");

  const spark = (pts, w = 220, h = 30) => {
    if (!pts || pts.length < 2) return "";
    const mx = Math.max(...pts.map((p) => p.v), 1), x = (i) => (i / (pts.length - 1)) * w, y = (v) => h - 3 - (v / mx) * (h - 7);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join("");
    const last = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Evolução diária"><path class="spark-area" d="${line}L${w} ${h}L0 ${h}Z"/><path class="spark-line" d="${line}" vector-effect="non-scaling-stroke"/><circle class="spark-dot" cx="${w - 2}" cy="${y(last.v).toFixed(1)}" r="2.6"><title>${pd(last.d)}: ${nf0.format(Math.round(last.v))}</title></circle></svg>`;
  };

  const story = (s, big, i = 0) => `<article class="st${big ? " big" : ""} fade" style="--i:${i}"><span class="kick">${esc(s.kicker)}</span><h3><a href="${href(s.ref)}">${esc(s.hed)}</a></h3>${s.lead ? `<p>${esc(big ? s.lead.slice(0, 2).join(" ") : cutTxt(s.lead[0], 150))}</p>` : ""}<div class="meta">${s.when ? esc(s.when) : pd(s.date)}</div></article>`;
  const cutTxt = (s, n) => (s.length <= n ? s : s.slice(0, s.slice(0, n).lastIndexOf(" ")).replace(/[\s,;:–-]+$/, "") + "…");
  const section = (id, cls, title, list, note) => `<section class="blk ${cls}" id="${id}"><h2 class="sec-h">${title}${note ? `<small>${note}</small>` : ""}</h2>${list.length ? list.map((s, i) => story(s, i === 0 && list.length > 1 && cls.includes("fis"), i)).join("") : '<p class="muted" style="font-size:.86rem;font-style:italic">Sem registos nesta data nas bases do portal.</p>'}</section>`;

  const delta = (it) => (it.d == null ? "" : `<span class="d ${it.d >= 0 ? "up" : "dn"}" title="face ao período anterior">${it.d >= 0 ? "▲" : "▼"} ${nf.format(Math.abs(it.d))}${it.dUnit ? " " + it.dUnit : "%"}</span>`);

  const state = { cal: null };
  const navDate = (d, delta) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + delta); return x.toISOString().slice(0, 10); };

  const topbar = (d, extra = "") => `<div class="ed-bar no-print"><div>
      <button class="btn-ed" data-go="${navDate(d.data, -1)}" title="Tecla ←">‹ Anterior</button>
      <span style="position:relative"><button class="btn-ed" id="arch-btn" aria-haspopup="true">Arquivo ▾</button><div class="pop" id="pop" hidden></div></span>
      <button class="btn-ed" data-go="${navDate(d.data, 1)}" ${d.data >= d.max ? "disabled" : ""} title="Tecla →">Seguinte ›</button>
      <button class="btn-ed" data-go="">Última edição</button>${extra}</div>
    <div><form class="ed-search" id="ed-s" autocomplete="off"><input type="search" id="ed-q" placeholder="Pesquisar entidade, contrato, lei, tema…" aria-label="Pesquisar"><div class="ed-results" id="ed-r" hidden></div></form>
      <a class="btn-ed" href="#/painel">A minha lista</a><button class="btn-ed ed-menu" onclick="document.body.classList.toggle('nav-open')">Menu</button><button class="btn-ed" id="b-tema" title="Alternar entre edição da manhã e edição da noite">Edição da noite</button><button class="btn-ed" id="b-print">Imprimir</button></div></div>`;

  const plateHost = () => { let h = document.getElementById("ed-plate"); if (!h) { h = document.createElement("div"); h.id = "ed-plate"; h.className = "wrap"; const m = document.querySelector("header.masthead"); m.insertBefore(h, m.firstChild); } return h; };

  async function renderEdition(date) {
    const d = await api("edicao/dia" + (date ? "?data=" + date : ""));
    window.onscroll = null;
    state.cur = d.data; state.max = d.max;
    document.title = `Edição de ${d.extenso}, n.º ${nf0.format(d.numero)} · Estado Aberto`;
    const ft = d.fontes;
    const S = d.seccoes, n = d.numeros, L = d.lead;
    const tick = d.ticker.concat(d.ticker).map((t) => `<a href="${href(t.ref)}"><b>${esc(t.k)}</b>${esc(t.t)}</a>`).join("");
    const why = d.leadWhy;
    const host = plateHost();
    host.innerHTML = `<div class="ed-head">
        <div class="ear"><b>Edição n.º ${nf0.format(d.numero)}</b>${esc(d.diaSemana)}<br>${esc(d.extenso)}</div>
        <div class="plate"><span class="k reveal" style="--i:0">Dados abertos de Portugal</span><h1 class="reveal" style="--i:1"><a href="#/"><span>Estado <i>Aberto</i></span></a></h1><span class="s reveal" style="--i:3">Diário da democracia portuguesa</span></div>
        <div class="ear r"><b>Última recolha</b>Votações até ${pd(ft.vote)}<br>Diário da República até ${pd(ft.dre)}<br>Tribunal de Contas até ${pd(ft.tc)}<br>Contratos até ${pd(ft.pub)}</div>
      </div><div class="flagbar"></div>`;
    $app.innerHTML = `<div class="ed">
      ${topbar(d)}
      <div class="dateline"><span><b>Edição de ${esc(d.extenso)}</b> · ${esc(d.diaSemana)}</span>
        <span>Edição n.º ${nf0.format(d.numero)}</span></div>
      ${d.desatualizado ? `<div class="stale">Os contratos publicados mais recentes nas bases são de ${pd(d.desatualizado.contratos)}; os números de contratação desta edição referem-se a essa semana.</div>` : ""}
      <div class="ticker no-print" aria-label="Últimas ocorrências"><div class="lab">Agora</div><div style="overflow:hidden;flex:1"><div class="track">${tick}</div></div></div>
      <div class="front">
        <div class="col">
          ${section("sec-par", "tag-par", "Parlamento", S["Parlamento"])}
          ${section("sec-gov", "tag-gov", "Governo e Presidente", S["Governo e Presidente"])}
        </div>
        <div class="col">
          ${L ? `<article class="lede"><span class="kick reveal" style="--i:1">${esc(L.kicker)} · Manchete</span>
            <h2 class="lede-hed reveal" style="--i:2"><a href="${href(L.ref)}">${esc(L.hed)}</a></h2>
            <p class="lede-dek reveal" style="--i:4">${esc(L.dek || "")}</p>
            <div class="byline fade" style="--i:6"><span>Redação automática</span><span>${L.when ? esc(L.when) : pd(L.date)}</span><span>${esc(L.section)}</span>${d.leadNote ? `<span>${esc(d.leadNote)}</span>` : ""}</div>
            <div class="lede-body fade" style="--i:7">${L.lead.map((p) => `<p>${esc(p)}</p>`).join("")}</div>
            <a class="more" href="${href(L.ref)}">Ler a reportagem completa</a></article>` : '<p class="muted">Sem manchete para esta data.</p>'}
          <div class="bignum fade" style="--i:8">${n.destaques.map((x) => `<div><b>${esc(x.v)}</b><span>${esc(x.t)}</span></div>`).join("")}</div>
          ${section("sec-fis", "tag-jus fis", "Fiscalização", S["Fiscalização"])}
          ${why ? `<details class="why no-print"><summary>Como escolhemos a manchete</summary><div>Dá-se a cada candidata uma pontuação entre 0 e 1 pela relevância democrática: votações em plenário (mais alta em votações finais de leis, rejeitadas ou decididas por poucos lugares), vetos e promulgações do Presidente, relatórios de auditoria e fiscalização (Tribunal de Contas, Provedor de Justiça, reguladores), nomeações de relevo e votos que contrariam o que o partido declarou. Contratos e apoios públicos só entram com pontuação mais baixa, crescente com o valor (escala logarítmica). Desconta-se 1,5 a 3% por dia de antiguidade e vence a pontuação mais alta; a data de referência de cada edição é a mais recente com dados em qualquer das bases.<table><tr><td><b>${esc(why.tipo)}</b>: ${esc(why.why)}</td><td><b>${why.score}</b></td></tr>${why.outros.map((o) => `<tr><td>${esc(o.tipo)}: ${esc(o.why)}</td><td>${o.score}</td></tr>`).join("")}</table></div></details>` : ""}
        </div>
        <div class="col nums" id="sec-num">
          <h2 class="sec-h" style="--tag:var(--ed-ink)">Números do dia</h2>
          ${n.itens.map((it, i) => `<div class="n fade" style="--i:${i}"><span class="l">${esc(it.k)}</span><span class="v">${esc(it.v)}</span>${delta(it)}${it.spark ? spark(it.spark) : ""}<span class="sub">${esc(it.note)}</span></div>`).join("")}
        </div>
      </div>
      <div class="band">
        <div class="col">${section("sec-nom", "tag-nom", "Nomeações", S["Nomeações"])}</div>
        <div class="col">${section("sec-loc", "tag-loc", "Poder local", S["Poder local"])}</div>
        <div class="col">${section("sec-din", "tag-din", "Dinheiro público", S["Dinheiro público"])}</div>
      </div>
      <div class="band2">
        <div class="col ago"><h2 class="sec-h" style="--tag:var(--ed-ink)">Há um ano</h2><div class="ago-date">${pd(d.haUmAno.data)}</div><p>${esc(d.haUmAno.texto)}</p>${d.haUmAno.itens.map((it) => `<div class="it"><b>${esc(it.t)}</b>${it.ref ? `<a href="${href(it.ref)}">${esc(it.text)}</a>` : esc(it.text)}</div>`).join("")}<p style="margin-top:10px"><a class="more" href="#/edicao/${d.haUmAno.data}">Abrir a edição desse dia</a></p></div>
        <div class="col"><h2 class="sec-h" style="--tag:var(--ed-red)">Quem mais contratou</h2><p class="muted" style="font-size:.76rem;margin:0 0 10px;font-family:var(--sans)">Valor publicado entre ${pd(n.janela.a)} e ${pd(n.janela.b)}</p>${(() => { const mx = Math.max(...n.topBuyers.map((b) => b.v), 1); return n.topBuyers.map((b) => `<div class="hb"><a href="${b.eid ? "#/artigo/entidade/" + b.eid : "#/contratos?buyer=" + b.nif}" title="${esc(b.name)}">${esc(b.name)}</a><span>${fmtV(b.v)}</span><i style="--w:${((b.v / mx) * 100).toFixed(1)}%"></i></div>`).join(""); })()}</div>
        <div class="col" id="arquivo"><h2 class="sec-h" style="--tag:var(--ed-gold)">Arquivo de edições</h2><div class="edcal" id="cal-inline"></div></div>
      </div>
      <div class="colophon"><div>Edição n.º ${nf0.format(d.numero)}, contada desde 1 de janeiro de 2012, início da série de contratos públicos. Os textos são gerados por modelos a partir das bases de dados abertas (Assembleia da República, Presidência da República, Diário da República, Tribunal de Contas, Provedor de Justiça, IGF, reguladores, CReSAP, Portal BASE); todos os números, nomes e datas vêm diretamente dos registos. Quando uma fonte não tem dados recentes, o texto indica o período a que se refere.</div><div>Os indicadores de risco são sinais estatísticos e não constituem acusação. <a href="#/painel-classico">Painel clássico e novidades</a> · <a href="#/roadmap">Roadmap</a> · menu superior para todas as secções.</div></div>
    </div>`;
    wire(d);
    mountCal(document.getElementById("cal-inline"), d, false);
    window.scrollTo(0, 0);
  }

  function wire(d) {
    $app.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { location.hash = b.dataset.go ? "#/edicao/" + b.dataset.go : "#/"; }));
    const tb = document.getElementById("b-tema"); if (tb) tb.onclick = toggleTheme;
    const pb = document.getElementById("b-print"); if (pb) pb.onclick = () => window.print();
    const ab = document.getElementById("arch-btn"), pop = document.getElementById("pop");
    if (ab) ab.onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) mountCal(pop, d, true); };
    const form = document.getElementById("ed-s"), inp = document.getElementById("ed-q"), res = document.getElementById("ed-r");
    if (form) {
      let t;
      inp.oninput = () => { clearTimeout(t); t = setTimeout(async () => {
        const v = inp.value.trim(); if (v.length < 2) { res.hidden = true; return; }
        const r = await api("search?q=" + encodeURIComponent(v)).catch(() => null); if (!r) return;
        const grp = (title, items) => (items.length ? `<h4>${title}</h4>${items.join("")}` : "");
        res.innerHTML = grp("Entidades", r.entities.map((e) => `<a href="#/artigo/entidade/${e.id}">${esc(e.name)}</a>`)) + grp("Contratos", r.contracts.map((c) => `<a href="#/artigo/contrato/${c.id}">${esc(cutTxt(c.object || "", 90))} <small>· ${esc(c.buyer_name || "")}</small></a>`)) + grp("Leis e iniciativas", r.initiatives.map((i) => `<a href="#/leis/${encodeURIComponent(i.key)}">${esc(cutTxt(i.title || i.key, 100))}</a>`));
        res.hidden = !res.innerHTML;
      }, 220); };
      form.onsubmit = (e) => { e.preventDefault(); if (inp.value.trim()) location.hash = "#/contratos?q=" + encodeURIComponent(inp.value.trim()); };
    }
  }
  document.addEventListener("click", (e) => { const pop = document.getElementById("pop"); if (pop && !pop.hidden && !pop.contains(e.target)) pop.hidden = true; const r = document.getElementById("ed-r"); if (r && !r.contains(e.target)) r.hidden = true; });
  document.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const cur = state.cur; if (!cur || !document.querySelector('.ed-head')) return;
    if (e.key === "ArrowLeft") location.hash = "#/edicao/" + navDate(cur, -1);
    if (e.key === "ArrowRight" && cur < state.max) location.hash = "#/edicao/" + navDate(cur, 1);
    if (e.key === "Escape") { const p = document.getElementById("pop"); if (p) p.hidden = true; }
  });

  async function mountCal(el, d, withInput) {
    let mes = el.dataset.mes || d.data.slice(0, 7);
    const draw = async () => {
      const r = await api("edicao/arquivo?mes=" + mes);
      el.dataset.mes = mes;
      const [y, m] = mes.split("-").map(Number), first = new Date(Date.UTC(y, m - 1, 1)), off = (first.getUTCDay() + 6) % 7;
      const mx = Math.max(...r.dias.map((x) => x.c), 1);
      const cells = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'].map((x) => `<span class="dow">${x}</span>`).join("") + "<span></span>".repeat(off) +
        r.dias.map((x) => `<a href="#/edicao/${x.d}" class="${x.d === d.data ? "sel" : ""} ${x.d === d.defaultData ? "def" : ""} ${x.d > d.max ? "fut" : ""}" style="--k:${(x.c / mx).toFixed(2)}" title="${pd(x.d)}: ${nf0.format(x.c)} contratos, ${x.v} votações, ${x.r} atos">${Number(x.d.slice(8))}</a>`).join("");
      el.innerHTML = `<div class="edcal-h"><button data-m="-1" aria-label="Mês anterior">‹</button><span>${MES[m - 1]} ${y}</span><button data-m="1" aria-label="Mês seguinte">›</button></div><div class="edcal-g">${cells}</div>
        <div class="edcal-note">A barra vermelha indica o volume de contratos publicados em cada dia. Cada edição é recalculada com consultas filtradas por data. Contorno vermelho: edição mais recente com dados.</div>
        ${withInput ? `<input type="date" id="pick" min="${r.min}" max="${r.max}" value="${d.data}" aria-label="Escolher data">` : ""}`;
      el.querySelectorAll("[data-m]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const dt = new Date(Date.UTC(y, m - 1 + Number(b.dataset.m), 1)); mes = dt.toISOString().slice(0, 7); draw(); }));
      const pk = el.querySelector("#pick"); if (pk) pk.onchange = () => { if (pk.value) location.hash = "#/edicao/" + pk.value; };
    };
    await draw();
  }

  const chart = (c) => {
    const head = `<figure class="fig"><h5>${esc(c.title)}</h5>${c.sub ? `<div class="sub">${esc(c.sub)}</div>` : ""}`;
    if (c.type === "bars") {
      const W = 620, H = 210, pad = 26, mx = Math.max(...c.data.map((x) => x.v), 1), bw = (W - pad) / c.data.length;
      return head + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title)}">${c.data.map((x, i) => { const h = Math.max(1, (x.v / mx) * (H - 52)), bx = pad + i * bw + bw * 0.14; return `<g><rect class="bar${x.hi ? " hi" : ""}" x="${bx.toFixed(1)}" y="${(H - 24 - h).toFixed(1)}" width="${(bw * 0.72).toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(x.l)}: ${fmtV(x.v, c.fmt)}</title></rect><text class="val" x="${(bx + bw * 0.36).toFixed(1)}" y="${(H - 28 - h).toFixed(1)}" text-anchor="middle">${fmtV(x.v, c.fmt)}</text><text class="lbl" x="${(bx + bw * 0.36).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(x.l)}</text></g>`; }).join("")}<line x1="${pad}" x2="${W}" y1="${H - 24}" y2="${H - 24}" stroke="currentColor" stroke-opacity=".5"/></svg></figure>`;
    }
    if (c.type === "hbars") {
      const mx = Math.max(...c.data.map((x) => x.v), 1), rh = 26, H = c.data.length * rh + 6;
      return head + `<svg viewBox="0 0 620 ${H}" role="img" aria-label="${esc(c.title)}">${c.data.map((x, i) => `<g><text class="lbl" x="0" y="${i * rh + 16}">${esc(x.l)}</text><rect class="bar${x.hi ? " hi" : ""}" x="230" y="${i * rh + 5}" width="${Math.max(2, (x.v / mx) * 300).toFixed(1)}" height="14"/><text class="val" x="${236 + (x.v / mx) * 300}" y="${i * rh + 16}">${fmtV(x.v, c.fmt)}</text></g>`).join("")}</svg></figure>`;
    }
    if (c.type === "seats") {
      const col = { favor: "var(--ed-ok)", contra: "var(--ed-no)", abstencao: "var(--ed-ab)", ausencia: "var(--ed-na)" }, lab = { favor: "A favor", contra: "Contra", abstencao: "Abstenção", ausencia: "Sem voto registado" };
      const tot = c.tot.f + c.tot.c + c.tot.a || 1, W = 620;
      let x = 0; const seg = [["favor", c.tot.f], ["abstencao", c.tot.a], ["contra", c.tot.c]].map(([k, v]) => { const w = (v / 230) * W, r = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="30" fill="${col[k]}"><title>${lab[k]}: ${v} lugares</title></rect>${w > 38 ? `<text x="${(x + w / 2).toFixed(1)}" y="20" text-anchor="middle" fill="#fff" font-size="13" font-weight="700" style="fill:#fff">${v}</text>` : ""}`; x += w; return r; }).join("");
      const rows = c.data.map((p, i) => `<g><text class="lbl" x="0" y="${i * 24 + 14}">${esc(p.l)}</text><rect x="70" y="${i * 24 + 3}" width="${Math.max(3, (p.seats / 89) * 380).toFixed(1)}" height="15" fill="${col[p.s]}"/><text class="val" x="${76 + Math.max(3, (p.seats / 89) * 380)}" y="${i * 24 + 15}">${p.seats} · ${lab[p.s].toLowerCase()}</text></g>`).join("");
      return head + `<svg viewBox="0 0 ${W} 36" style="margin-bottom:12px"><g transform="translate(0,3)">${seg}</g></svg><svg viewBox="0 0 ${W} ${c.data.length * 24 + 6}">${rows}</svg><div class="legend">${["favor", "contra", "abstencao", "ausencia"].map((k) => `<span><i style="background:${col[k]}"></i>${lab[k]}</span>`).join("")}</div></figure>`;
    }
    if (c.type === "timeline") return head + `<ul class="tl">${c.data.map((x) => `<li><time>${pd(x.d)}</time>${esc(x.l)}${x.c ? ` <span style="color:var(--ed-mute)">· ${esc(x.c)}</span>` : ""}</li>`).join("")}</ul></figure>`;
    return "";
  };

  const para = (t) => esc(t).replace(/\[\^(\d+)\]/g, (_, n) => `<sup><a href="#fn-${n}" id="rf-${n}">${n}</a></sup>`);

  async function renderArticle(arg) {
    const i = arg.indexOf("/"), tipo = arg.slice(0, i), id = arg.slice(i + 1);
    const a = await api(`edicao/artigo?tipo=${tipo}&id=${encodeURIComponent(id)}`).catch(() => null);
    if (!a) { $app.innerHTML = '<div class="ed"><p class="note warn">Artigo não encontrado.</p></div>'; return; }
    document.title = `${a.hed} · Estado Aberto`;
    const words = a.paragraphs.join(" ").split(/\s+/).length, mins = Math.max(1, Math.round(words / 190));
    const back = a.date ? `#/edicao/${a.date}` : "#/";
    const body = [];
    a.paragraphs.forEach((p, k) => {
      body.push(`<p class="${k === 0 ? "first" : ""}">${para(p)}</p>`);
      if (k === 0 && a.pull) body.push(`<blockquote class="pullq">${esc(a.pull)}</blockquote>`);
      if (a.charts[k]) body.push(chart(a.charts[k]));
    });
    for (let k = a.paragraphs.length; k < a.charts.length; k++) body.push(chart(a.charts[k]));
    $app.innerHTML = `<div class="ed"><div class="progress" id="prog"></div>
      <div class="art-wrap"><div class="art-nav"><a href="${back}">‹ Voltar à edição${a.date ? " de " + pd(a.date) : ""}</a><div class="no-print"><button class="btn-ed" id="fs-" aria-label="Diminuir letra">A−</button><button class="btn-ed" id="fs+" aria-label="Aumentar letra">A+</button><button class="btn-ed" id="b-tema">Edição da noite</button><button class="btn-ed" id="b-print">Imprimir</button></div></div>
      <header class="art-head"><span class="kick reveal" style="--i:0">${esc(a.kicker)}</span><h1 class="reveal" style="--i:1">${esc(a.hed)}</h1>${a.dek ? `<p class="dek reveal" style="--i:3">${esc(a.dek)}</p>` : ""}
        <div class="byline fade" style="--i:5"><span>${esc(a.by)}</span>${a.date ? `<span>${pd(a.date)}</span>` : ""}<span>${mins} min de leitura</span></div></header>
      <div class="art-grid"><aside class="ficha"><h4>Ficha</h4><dl>${a.stats.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${a.links.map((l) => `<a class="lk" href="${href(l.ref)}">${esc(l.label)} →</a>`).join("")}${a.relacionados.map((l) => `<a class="lk" href="${href(l.ref)}">${esc(l.label)} →</a>`).join("")}</aside>
      <div class="art-body">${body.join("")}
        ${a.flags && a.flags.length ? `<div class="flags"><b>Indicadores estatísticos da entidade</b>${a.flags.map((f) => `<div>${esc(f.text)}</div>`).join("")}<div style="margin-top:6px;font-size:.78rem;color:var(--ed-mute)">São sinais relativos a entidades semelhantes e não constituem acusação.</div></div>` : ""}
        <div class="fnotes"><h4>Fontes</h4><ol>${a.fontes.map((f) => `<li id="fn-${f.n}">${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.label)}</a>` : esc(f.label)} <a href="#rf-${f.n}" aria-label="Voltar ao texto">↩</a></li>`).join("")}</ol><p style="color:var(--ed-mute)">Texto gerado automaticamente a partir dos registos citados; os números e as datas reproduzem os dados sem alteração.</p></div></div></div></div></div>`;
    document.getElementById("b-tema").onclick = toggleTheme;
    document.getElementById("b-print").onclick = () => window.print();
    let fs = 1; const root = $app.querySelector(".art-body");
    document.getElementById("fs+").onclick = () => { fs = Math.min(1.4, fs + 0.1); root.style.setProperty("--fs", fs); };
    document.getElementById("fs-").onclick = () => { fs = Math.max(0.8, fs - 0.1); root.style.setProperty("--fs", fs); };
    const prog = document.getElementById("prog");
    window.onscroll = () => { const h = document.documentElement; prog.style.width = Math.min(100, (h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)) * 100) + "%"; };
    state.cur = null;
    window.scrollTo(0, 0);
  }

  Portal.page("", () => renderEdition(""));
  Portal.page("edicao", (arg) => renderEdition(/^\d{4}-\d{2}-\d{2}$/.test(arg || "") ? arg : ""));
  Portal.page("artigo", (arg) => renderArticle(arg));
})();
