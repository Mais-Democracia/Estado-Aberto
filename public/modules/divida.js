"use strict";
(() => {
  const { esc } = Portal;
  const mi = (v) => (v == null ? "—" : Portal.int(Math.round(v)) + " M€");
  const spark = (pts, w = 900, h = 220) => {
    if (!pts.length) return "";
    const vs = pts.map((p) => p.value), lo = Math.min(...vs, 0), hi = Math.max(...vs);
    const x = (i) => ((i / (pts.length - 1 || 1)) * (w - 50) + 40).toFixed(1), y = (v) => (h - 20 - ((v - lo) / (hi - lo || 1)) * (h - 40)).toFixed(1);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join("");
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => pts[Math.round(f * (pts.length - 1))]).map((p, i, a) => `<text x="${x(Math.round([0, 0.25, 0.5, 0.75, 1][i] * (pts.length - 1)))}" y="${h - 4}" font-size="11" text-anchor="middle" fill="currentColor">${esc(p.date.slice(0, 4))}</text>`).join("");
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Evolução" style="width:100%;height:auto"><path d="${d}" fill="none" stroke="var(--accent,#1d4ed8)" stroke-width="2"/><text x="4" y="14" font-size="11" fill="currentColor">${esc(Portal.int(Math.round(hi)))}</text><text x="4" y="${h - 22}" font-size="11" fill="currentColor">${esc(Portal.int(Math.round(lo)))}</text>${ticks}</svg>`;
  };

  Portal.nav("Dívida pública", "#/divida");
  Portal.page("divida", async () => {
    try {
      const [ov, s] = await Promise.all([Portal.api("divida/overview"), Portal.api("divida/series?codes=total,ot,aforro,ct,prazo_medio,pct_fixa")]);
      if (ov.available === false) { $app.innerHTML = `<div class="pagehead"><div><h1>Dívida pública</h1></div></div><p class="note warn">${esc(ov.note)}</p>`; return; }
      const L = ov.latest, ser = s.series;
      const comp = [["Obrigações do Tesouro", L.ot], ["Certificados de Aforro", L.aforro], ["Certificados do Tesouro", L.ct]];
      const rows = comp.map(([n, v]) => `<tr><td>${esc(n)}</td><td>${mi(v)}</td><td>${v ? ((100 * v) / L.total).toFixed(1).replace(".", ",") + " %" : "—"}</td></tr>`).join("");
      $app.innerHTML = `<div class="crumbs"><a href="#/">Início</a> / Dívida pública</div>
        <div class="pagehead"><div><div class="kicker">IGCP</div><h1>Dívida direta do Estado</h1>
        <p class="small muted">Stock mensal e indicadores de risco da dívida. Fonte: <a href="${esc(ov.source)}" target="_blank" rel="noopener">igcp.pt ↗</a> (recolha de ${esc(ov.built || "—")}).</p></div></div>
        <div class="kpis"><div class="kpi"><b>${mi(L.total)}</b><span>dívida total em ${esc(L.date)}</span></div>
        <div class="kpi"><b>${ov.yoy == null ? "—" : (ov.yoy >= 0 ? "+" : "") + Portal.int(Math.round(ov.yoy)) + " M€"}</b><span>variação homóloga</span></div>
        <div class="kpi"><b>${L.prazo_medio == null ? "—" : L.prazo_medio.toFixed(1).replace(".", ",")} anos</b><span>prazo médio residual</span></div>
        <div class="kpi"><b>${L.pct_fixa == null ? "—" : L.pct_fixa.toFixed(1).replace(".", ",")} %</b><span>a taxa fixa</span></div></div>
        <p class="note">${esc(ov.note)}</p>
        <section class="panel"><h2>Dívida total desde ${esc(ov.first.slice(0, 4))} (milhões de euros)</h2>${spark(ser.total)}</section>
        <section class="panel"><h2>Composição em ${esc(L.date)}</h2><table class="tbl"><thead><tr><th>Instrumento</th><th>Montante</th><th>Peso</th></tr></thead><tbody>${rows}</tbody></table></section>
        <section class="panel"><h2>Prazo médio residual (anos)</h2>${spark(ser.prazo_medio)}</section>`;
    } catch (e) {
      $app.innerHTML = `<div class="pagehead"><div><h1>Dívida pública</h1></div></div><p class="note warn">Não foi possível carregar os dados (${esc(String(e.message || e))}).</p>`;
    }
  });
})();
