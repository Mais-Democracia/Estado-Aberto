"use strict";
(() => {
  const { esc } = Portal;
  const nf1 = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 0 });
  const fmt = (v, unit) => (v == null ? "—" : Math.abs(v) >= 1000 || /^(hab\.|dormidas|fogos|pessoas|€)$/.test(unit) ? nf0.format(v) : nf1.format(v));
  const css = `<style>.is-tbl td.sp{padding:2px 8px}.is-sp{width:120px;height:30px;display:block}.is-sp .ln{fill:none;stroke:var(--bar);stroke-width:2}.is-sp .nat{fill:none;stroke:var(--bar2);stroke-width:1.6;stroke-dasharray:3 3}.is-sp .pt{fill:var(--red)}
  .is-tbl .th{color:var(--muted);font-size:.74rem;text-transform:uppercase;letter-spacing:.04em;background:var(--chip)}.is-tbl small{color:var(--muted)}.is-tbl .up{color:var(--green)}.is-tbl .dn{color:var(--red-ink)}
  .is-tbl-wrap{max-height:none;overflow:visible}.is-years{overflow-x:auto}.is-years table{border-collapse:collapse;font-size:.82rem}.is-years th,.is-years td{padding:3px 9px;border-bottom:1px solid var(--line2);text-align:right;white-space:nowrap}.is-years th:first-child,.is-years td:first-child{text-align:left}
  .is-sort{cursor:pointer;user-select:none;white-space:nowrap}.is-sort.on{color:var(--green);text-decoration:underline;text-decoration-color:var(--gold);text-decoration-thickness:3px}.is-wrap{max-height:74vh;overflow:auto;border:1px solid var(--line);border-radius:8px}.is-wrap thead th{position:sticky;top:0;background:var(--card);z-index:1}
  .is-filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px;align-items:center}.is-natrow td{background:var(--warn-bg);font-weight:600}</style>`;
  Portal.nav("Indicadores", "#/indicadores");

  function spark(serie) {
    if (serie.length < 2) return "";
    const W = 120, H = 30, P = 3;
    const vals = serie.flatMap((p) => [p.value, p.median].filter((x) => x != null));
    const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const X = (i) => P + (i * (W - 2 * P)) / (serie.length - 1);
    const Y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
    const path = (k) => serie.map((p, i) => (p[k] == null ? "" : `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p[k]).toFixed(1)}`)).join(" ");
    const l = serie.length - 1;
    return `<svg class="is-sp" viewBox="0 0 ${W} ${H}" role="img" aria-label="evolução ${esc(serie[0].year)}–${esc(serie[l].year)}"><path class="nat" d="${path("median")}"/><path class="ln" d="${path("value")}"/><circle class="pt" cx="${X(l).toFixed(1)}" cy="${Y(serie[l].value).toFixed(1)}" r="2.6"/></svg>`;
  }

  function panelHtml(d) {
    const inds = d.indicadores || [];
    if (!inds.length) return "";
    let theme = "";
    const rows = inds.map((i) => {
      const l = i.serie[i.serie.length - 1], prev = i.serie.length > 1 ? i.serie[i.serie.length - 2] : null;
      const head = i.theme !== theme ? `<tr><td colspan="6" class="th">${esc(i.theme)}</td></tr>` : "";
      theme = i.theme;
      const dv = prev && prev.value ? 100 * (l.value / prev.value - 1) : null;
      const delta = dv == null ? "" : ` <small class="${dv >= 0 ? "up" : "dn"}">${dv >= 0 ? "+" : ""}${nf1.format(dv)} %</small>`;
      return `${head}<tr><td><b>${esc(i.label)}</b><br><small>${esc(i.unit)}</small></td><td class="sp">${spark(i.serie)}</td><td class="num"><b>${fmt(l.value, i.unit)}</b>${delta}<br><small>${esc(l.year)}</small></td><td class="num">${fmt(l.median, i.unit)}</td><td class="num">${i.rank}.º <small>de ${i.de}</small></td><td class="small"><a href="${esc(i.source_url)}" target="_blank" rel="noopener">INE ↗</a></td></tr>`;
    }).join("");
    const years = [...new Set(inds.flatMap((i) => i.serie.map((p) => p.year)))].sort((a, b) => b - a).slice(0, 6).reverse();
    const yrows = inds.map((i) => {
      const by = Object.fromEntries(i.serie.map((p) => [p.year, p]));
      return `<tr><td>${esc(i.label)}</td>${years.map((y) => `<td>${by[y] ? `${fmt(by[y].value, i.unit)} <small class="muted">(${fmt(by[y].median, i.unit)})</small>` : "—"}</td>`).join("")}</tr>`;
    }).join("");
    return `${css}<div class="tblwrap is-tbl-wrap"><table class="tbl is-tbl"><thead><tr><th>Indicador</th><th>Evolução</th><th class="num">Último valor</th><th class="num">Mediana dos 308</th><th class="num">Posição</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <details style="margin-top:10px"><summary>Valores por ano (entre parêntesis, a mediana nacional dos municípios)</summary><div class="is-years"><table><thead><tr><th>Indicador</th>${years.map((y) => `<th>${y}</th>`).join("")}</tr></thead><tbody>${yrows}</tbody></table></div></details>
    <p class="small muted">Linha verde: este município; tracejado dourado: mediana dos 308 municípios no mesmo ano. Posição: 1.º = valor mais alto. Fonte: INE, associado ao município pelo código geográfico oficial. <a href="#/indicadores">Ranking de municípios por indicador →</a></p>`;
  }

  Portal.entityHooks.push(async (data, el) => {
    const e = data.entity;
    if (!e || e.kind !== "municipio") return;
    const d = await Portal.api("ine_series/concelho?" + (e.dico ? "dico=" + encodeURIComponent(e.dico) : "nif=" + encodeURIComponent(e.nif || ""))).catch(() => null);
    if (!d || !d.found) return;
    const h = panelHtml(d);
    if (h) el.insertAdjacentHTML("beforeend", `<section class="panel"><h2>Indicadores</h2>${h}</section>`);
  });

  Portal.page("indicadores", async (arg, p) => {
    $app.innerHTML = `${css}<h1>Indicadores por município</h1><p class="muted">Séries do INE para os 308 municípios (demografia, rendimento, segurança, saúde, habitação, turismo, ambiente), ligadas pelo código geográfico oficial. Clique no cabeçalho de uma coluna para ordenar.</p><div id="is-body"><p class="muted">A carregar…</p></div>`;
    const body = document.getElementById("is-body");
    const d = await Portal.api("ine_series/ranking").catch(() => null);
    if (!d || !d.available) { body.innerHTML = `<p class="note warn">${esc((d && d.note) || "Indicadores indisponíveis.")}</p>`; return; }
    const inds = d.indicadores;
    const districts = [...new Set(d.rows.map((r) => r.district).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt"));
    let sortKey = (p && p.ord && inds.some((i) => i.key === p.ord)) ? p.ord : "pop", dir = p && p.dir === "asc" ? 1 : -1;
    const draw = () => {
      const q = document.getElementById("is-q").value.trim().toLowerCase();
      const dist = document.getElementById("is-d").value;
      let rows = d.rows.filter((r) => (!dist || r.district === dist) && (!q || r.name.toLowerCase().includes(q)));
      const val = (r) => (sortKey === "name" ? r.name : r.v[sortKey]);
      rows = rows.slice().sort((a, b) => {
        const x = val(a), y = val(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (sortKey === "name" ? x.localeCompare(y, "pt") : x - y) * (sortKey === "name" ? -dir : dir);
      });
      const th = (k, l, sub) => `<th class="${k === "name" ? "" : "num "}is-sort${sortKey === k ? " on" : ""}" data-k="${k}" title="Ordenar">${esc(l)}${sortKey === k ? (dir < 0 ? " ↓" : " ↑") : ""}${sub ? `<br><small>${esc(sub)}</small>` : ""}</th>`;
      const nat = `<tr class="is-natrow"><td></td><td>Mediana dos 308</td>${inds.map((i) => `<td class="num">${d.nacional[i.key] ? fmt(d.nacional[i.key].median, i.unit) : "—"}</td>`).join("")}</tr>`;
      const trs = rows.map((r, n) => `<tr><td class="num">${n + 1}</td><td><a href="#/indicadores/${esc(r.dico)}" data-d="${esc(r.dico)}">${esc(r.name)}</a>${r.eid ? ` <a class="small muted" href="#/entidade/${r.eid}" title="Perfil da câmara">câmara</a>` : ""}<br><small class="muted">${esc(r.district || "")}</small></td>${inds.map((i) => `<td class="num">${fmt(r.v[i.key], i.unit)}</td>`).join("")}</tr>`).join("");
      document.getElementById("is-tab").innerHTML = `<div class="tblwrap is-wrap"><table class="tbl"><thead><tr><th class="num">#</th>${th("name", "Município")}${inds.map((i) => th(i.key, i.label, `${i.unit} · ${i.last_year}`)).join("")}</tr></thead><tbody>${nat}${trs}</tbody></table></div><p class="small muted">${rows.length} municípios. Último ano disponível por indicador no cabeçalho; "—" = INE não publica valor. Fonte: INE (json_indicador), atualização ${esc((d.built || "").slice(0, 10))}.</p>`;
      for (const h of document.querySelectorAll(".is-sort")) h.onclick = () => { const k = h.dataset.k; if (k === sortKey) dir = -dir; else { sortKey = k; dir = k === "name" ? -1 : -1; } draw(); };
      for (const a of document.querySelectorAll("#is-tab a[data-d]")) a.onclick = (ev) => { ev.preventDefault(); location.hash = "#/indicadores/" + a.dataset.d; };
    };
    if (arg && /^\d{4}$/.test(arg)) {
      const c = await Portal.api("ine_series/concelho?dico=" + arg).catch(() => null);
      if (!c || !c.found) { body.innerHTML = `<p class="note warn">Município não encontrado.</p>`; return; }
      const m = c.municipio;
      $app.innerHTML = `${css}<h1>Indicadores · ${esc(m.name)}</h1><p class="muted"><a href="#/indicadores">← Ranking</a>${m.eid ? ` · <a href="#/entidade/${m.eid}">Perfil da câmara</a>` : ""} · ${esc(m.district || "")}</p><section class="panel">${panelHtml(c)}</section>`;
      return;
    }
    body.innerHTML = `<div class="is-filters"><input id="is-q" type="search" placeholder="Procurar município…" aria-label="Procurar município"><select id="is-d" aria-label="Distrito"><option value="">Todos os distritos</option>${districts.map((x) => `<option>${esc(x)}</option>`).join("")}</select></div><div id="is-tab"></div>`;
    document.getElementById("is-q").oninput = draw;
    document.getElementById("is-d").onchange = draw;
    draw();
  });
})();
