"use strict";
(() => {
  const { esc, api, int, fmtDate } = Portal;
  const PCOL = { PSD: "#f48a1f", CH: "#202056", PS: "#e8537a", IL: "#00a7e6", L: "#8bc34a", PCP: "#c8102e", BE: "#a00000", "CDS-PP": "#0073c2", PAN: "#2a9d8f", JPP: "#6a4c93", PEV: "#2e7d32", Governo: "#5b6475" };
  const css = `<style id="iv-css">
    .iv-tabs { display:flex; gap:6px; flex-wrap:wrap; margin:12px 0 14px; } .iv-tabs a { padding:5px 12px; border:1px solid var(--line); border-radius:999px; text-decoration:none; color:var(--ink); background:var(--card); cursor:pointer; font-size:.9rem; }
    .iv-tabs a.on { background:var(--ink); color:var(--card); }
    .iv-party { margin:14px 0 4px; display:flex; align-items:center; gap:8px; } .iv-party i { width:12px; height:12px; border-radius:3px; background:var(--pc); display:inline-block; }
    .iv-chip { display:inline-block; padding:1px 9px; border-radius:999px; border:1px solid var(--pc); font-size:.85rem; }
    .iv-item { border:1px solid var(--line); border-left:4px solid var(--pc, #5b6475); border-radius:6px; padding:8px 12px; margin:8px 0; background:var(--card); }
    .iv-item .meta { font-size:.82rem; color:var(--muted, #5b6475); } .iv-item p { margin:.4rem 0; } .iv-item details summary { cursor:pointer; font-size:.85rem; }
    .iv-item .full { white-space:pre-wrap; margin-top:6px; }
  </style>`;
  const ext = (u, l) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(l)} ↗</a>` : "");
  const who = (x) => (x.dep_bid ? `<a href="#/deputados/${x.dep_bid}">${esc(x.orador)}</a>` : esc(x.orador || x.cargo || "—"));

  const item = (x, showIni) => `<div class="iv-item" style="--pc:${PCOL[x.partido] || "#5b6475"}">
    <div class="meta"><b>${who(x)}</b>${x.partido ? ` (${esc(x.partido)})` : x.cargo ? ` · ${esc(x.cargo)}` : ""} · ${fmtDate(x.data)} · reunião plenária n.º ${esc(x.numero)} · ${int(x.palavras)} palavras</div>
    ${showIni && x.iniciativas && x.iniciativas.length ? `<div class="meta">Em debate: ${x.iniciativas.map((i) => i.bid ? `<a href="#/votacoes/${i.bid}">${esc(i.ref)}</a>` : esc(i.ref)).join(", ")}</div>` : ""}
    <p>${esc(x.excerto)}</p>
    <div class="meta"><a href="#" data-iv="${x.id}">Ler intervenção completa</a> · ${ext(x.source_url, "Diário da AR (PDF, p. " + x.pagina + ")")}</div>
    <div class="full" hidden></div></div>`;

  function wire(root) {
    root.querySelectorAll("a[data-iv]").forEach((a) => {
      a.onclick = async (e) => {
        e.preventDefault();
        const box = a.closest(".iv-item").querySelector(".full");
        if (!box.hidden) { box.hidden = true; a.textContent = "Ler intervenção completa"; return; }
        if (!box.dataset.loaded) { const r = await api("intervencoes/intervencao?id=" + a.dataset.iv); box.textContent = r.texto || r.error || ""; box.dataset.loaded = "1"; }
        box.hidden = false; a.textContent = "Fechar";
      };
    });
  }

  async function waitFor(sel, valid) {
    for (let k = 0; k < 60; k++) {
      const el = $app.querySelector(sel);
      if (el && valid()) return el;
      if (!valid()) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  }

  async function decorateInitiative() {
    const m = location.hash.match(/^#\/votacoes\/([^?/]+)/);
    if (!m) return;
    const arg = decodeURIComponent(m[1]);
    const valid = () => location.hash.startsWith("#/votacoes/" + m[1]);
    const r = await api("intervencoes/iniciativa" + (/^\d+$/.test(arg) ? "?bid=" + arg : "?key=" + encodeURIComponent(arg)) + "&limit=50&offset=0").catch(() => null);
    if (!r || !r.available) return;
    const head = await waitFor(".pagehead", valid);
    if (!head || $app.querySelector("#iv-wrap")) return;
    const rest = []; for (let n = head.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
    const proc = document.createElement("div"); proc.id = "iv-proc"; rest.forEach((n) => proc.append(n));
    const panel = document.createElement("div"); panel.id = "iv-panel"; panel.hidden = true;
    const PAGE = 50;
    let cur = "";
    const chips = () => r.partidos.map((p) => `<a href="#" data-p="${esc(p.partido)}"><span class="iv-chip" style="--pc:${PCOL[p.partido] || "#5b6475"}">${esc(p.partido)} ${p.n}</span></a>`).join(" · ");
    panel.innerHTML = r.total ? `<p class="note">${esc(r.note)} Cobertura: reuniões plenárias de ${fmtDate(r.coverage.first)} a ${fmtDate(r.coverage.last)} (${int(r.coverage.meetings)} reuniões).</p>
      <p class="small"><a href="#" data-p="">Todos ${r.total}</a> · ${chips()}</p><div class="iv-list"></div><p class="iv-more" hidden><a href="#" data-more>Mostrar mais</a> <span class="muted small"></span></p>`
      : `<p class="note">Sem intervenções em plenário ligadas a esta iniciativa nas reuniões cobertas (${r.coverage.first ? fmtDate(r.coverage.first) + " a " + fmtDate(r.coverage.last) : "sem dados"}). Não significa que não tenha sido debatida: só se ligam intervenções cujo anúncio da ordem do dia cita a iniciativa.</p>`;
    const base = "intervencoes/iniciativa" + (/^\d+$/.test(arg) ? "?bid=" + arg : "?key=" + encodeURIComponent(arg));
    const list = panel.querySelector(".iv-list"), more = panel.querySelector(".iv-more");
    const load = async (partido, offset) => {
      const d = offset === 0 && !partido && r.offset === 0 && r.limit === PAGE ? r : await api(base + "&limit=" + PAGE + "&offset=" + offset + (partido ? "&partido=" + encodeURIComponent(partido) : "")).catch(() => null);
      if (!d || !d.available) return;
      if (offset === 0) list.innerHTML = "";
      list.insertAdjacentHTML("beforeend", d.items.map((x) => item(x, false)).join(""));
      wire(list);
      const shown = offset + d.items.length;
      more.hidden = shown >= d.filtered;
      more.dataset.next = shown; more.dataset.p = partido;
      more.querySelector("span").textContent = `${shown} de ${d.filtered}`;
    };
    if (r.total && list) {
      load("", 0);
      panel.querySelectorAll("a[data-p]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); cur = a.dataset.p; load(cur, 0); }; });
      more.querySelector("a").onclick = (e) => { e.preventDefault(); load(more.dataset.p || "", Number(more.dataset.next)); };
    }
    const tabs = document.createElement("div"); tabs.className = "iv-tabs"; tabs.id = "iv-wrap";
    tabs.innerHTML = css + `<a class="on" data-t="proc">Processo e votações</a><a data-t="iv">Intervenções (${int(r.total)})</a>`;
    head.after(tabs); tabs.after(proc, panel);
    tabs.querySelectorAll("a[data-t]").forEach((a) => {
      a.onclick = () => {
        const on = a.dataset.t === "iv";
        tabs.querySelectorAll("a[data-t]").forEach((b) => b.classList.toggle("on", b === a));
        proc.hidden = on; panel.hidden = !on;
      };
    });
    if (/[?&]tab=iv\b/.test(location.hash)) tabs.querySelector('a[data-t="iv"]').click();
  }

  async function decorateDeputy() {
    const m = location.hash.match(/^#\/deputados\/(\d+)/);
    if (!m) return;
    const valid = () => location.hash.startsWith("#/deputados/" + m[1]);
    const r = await api("intervencoes/deputado?id=" + m[1] + "&limit=10").catch(() => null);
    if (!r || !r.available || !r.total) return;
    const h1 = await waitFor("h1", valid);
    if (!h1 || $app.querySelector("#iv-dep")) return;
    const sec = document.createElement("section"); sec.id = "iv-dep";
    sec.innerHTML = css + `<h2>Intervenções recentes em plenário</h2><p class="small muted">${int(r.total)} intervenções com mais de 40 palavras identificadas no Diário da AR (I Série); ${int(r.linked)} ligadas a iniciativas.</p>${r.items.map((x) => item(x, true)).join("")}`;
    $app.append(sec);
    wire(sec);
  }

  const run = () => { decorateInitiative(); decorateDeputy(); };
  window.addEventListener("hashchange", run);
  run();
})();
