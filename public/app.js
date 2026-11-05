"use strict";
const $app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = (p) => fetch("/api/" + p).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const DOW = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = (s) => { if (!s) return ""; const d = new Date(s.length === 10 ? s + "T00:00" : s); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`; };
const fmtTime = (s) => { const t = (s || "").slice(11, 16); return t && t !== "00:00" ? t : ""; };
const clean = (s) => String(s || "").replace(/[;\s]+$/, "");
const sectionColor = (s) => { let h = 0; for (const c of s || "") h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; };
const SECTION_FIXED = { "Plenário": "#1F4E9C", "Comissões Parlamentares": "#047857" };
const colorFor = (s) => SECTION_FIXED[s] || sectionColor(s);
const pill = (txt, color) => `<span class="chip dot" style="--c:${color}">${esc(txt)}</span>`;
const initials = (n) => n.split(" ").filter((w) => w.length > 2).slice(0, 2).map((w) => w[0]).join("");

const state = { calMonth: null, calSel: null };


function eventRow(e) {
  return `<div class="row"><div class="when">${fmtDate(e.start).slice(0, -5)}<br>${fmtTime(e.start)}</div>
    <div class="what">${pill(e.section, colorFor(e.section))}<div><b>${esc(e.title.split("\n")[0].slice(0, 140))}</b></div>
    ${e.local ? `<div class="small muted">${esc(e.local)}</div>` : ""}</div></div>`;
}

/* ---------- Poderes ---------- */
async function pagePowers(sel) {
  const [p, act] = await Promise.all([api("powers"), api("activity")]);
  sel = p.powers.find((x) => x.id === sel) ? sel : p.powers[0].id;
  const cur = p.powers.find((x) => x.id === sel);
  const doing = {
    presidente: () => act.presidente.length ? act.presidente.map((n) => `<div class="row"><div class="when">${fmtDate(n.date)}</div><div class="what"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></div></div>`).join("") : "",
    parlamento: () => act.parlamento.map(eventRow).join(""),
    governo: () => `<p class="muted">As atividades do Conselho de Ministros e comunicados estão em <a href="https://www.portugal.gov.pt/pt/gc25/comunicacao/noticias" target="_blank" rel="noopener">portugal.gov.pt</a>. Os decretos-leis aparecem no <a href="https://diariodarepublica.pt" target="_blank" rel="noopener">Diário da República</a>.</p>`,
    tribunais: () => `<p class="muted">Decisões e acórdãos: <a href="https://www.tribunalconstitucional.pt" target="_blank" rel="noopener">Tribunal Constitucional</a>, <a href="https://www.stj.pt" target="_blank" rel="noopener">STJ</a>, <a href="https://www.tcontas.pt" target="_blank" rel="noopener">Tribunal de Contas</a>.</p>`,
  }[cur.doing]();
  $app.innerHTML = `
    <h1>Como se divide o poder</h1>
    <p class="lead">${esc(p.intro)}</p>
    <div class="tabs" role="tablist">${p.powers.map((x) => `<button role="tab" class="${x.id === sel ? "on" : ""}" style="--c:${x.color}" data-id="${x.id}">${esc(x.name)}</button>`).join("")}</div>
    <div class="card pow" style="--c:${cur.color}">
      <h2 style="margin-top:0">${esc(cur.name)} <span class="muted small">· ${esc(cur.article)}</span></h2>
      <p><b>${esc(cur.tagline)}</b></p><p>${esc(cur.how)}</p>
      <h3>O que pode fazer</h3><ul>${cur.can.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      <h3>O que não pode</h3><ul>${cur.cannot.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
    </div>
    <h2>O que está a fazer agora</h2>
    <div class="card">${doing || '<p class="muted">Sem atualizações.</p>'}</div>
    <h2>Como uma lei é aprovada</h2>
    <div class="flow">${p.lawFlow.map((s) => `<div class="s"><b>${esc(s.step)}</b><br><span class="muted">${esc(s.text)}</span></div>`).join("")}</div>
    <p><a href="#/leis">Acompanhar leis reais neste percurso →</a></p>
    <h2>Outros níveis de poder</h2>
    <div class="grid">${p.others.map((o) => `<div class="card"><h3>${esc(o.name)}</h3><p class="muted small">${esc(o.text)}</p></div>`).join("")}</div>`;
  $app.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { location.hash = "#/poderes/" + b.dataset.id; });
}

/* ---------- Calendário ---------- */
async function pageCalendar() {
  const now = new Date();
  if (!state.calMonth) state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const m = state.calMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const endD = new Date(start); endD.setDate(start.getDate() + 42);
  const sectionSel = $app.dataset.section || "";
  const q = $app.dataset.q || "";
  const data = await api(`events?from=${iso(start)}&to=${iso(endD)}${sectionSel ? "&section=" + encodeURIComponent(sectionSel) : ""}${q ? "&q=" + encodeURIComponent(q) : ""}`);
  const by = {};
  data.events.forEach((e) => (by[e.start.slice(0, 10)] ||= []).push(e));
  const sel = state.calSel || iso(now);
  let cells = DOW.map((d) => `<div class="h">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = iso(d), evs = by[k] || [];
    cells += `<div class="d ${d.getMonth() !== m.getMonth() ? "out" : ""} ${k === iso(now) ? "today" : ""} ${k === sel ? "sel" : ""}" data-d="${k}">
      <div class="n">${d.getDate()}</div>
      ${evs.slice(0, 3).map((e) => `<div class="ev" style="--c:${colorFor(e.section)}" title="${esc(e.title)}">${esc(e.title.split("\n")[0])}</div>`).join("")}
      ${evs.length > 3 ? `<div class="more">+${evs.length - 3}</div>` : ""}
      <div class="dots">${evs.slice(0, 6).map((e) => `<i class="dot" style="--c:${colorFor(e.section)}"></i>`).join("")}</div></div>`;
  }
  const dayEvs = (by[sel] || []);
  $app.innerHTML = `
    <h1>Calendário parlamentar</h1>
    <p class="lead">Reuniões de plenário, comissões, audições, grupos de trabalho e outros eventos da Assembleia da República. Fonte: agenda.parlamento.pt.</p>
    <div class="toolbar">
      <button class="btn" id="prev">←</button><button class="btn" id="today">Hoje</button><button class="btn" id="next">→</button>
      <b style="align-self:center;min-width:130px">${MONTHS[m.getMonth()]} ${m.getFullYear()}</b>
      <select id="sec"><option value="">Todos os tipos</option>${data.sections.map((s) => `<option ${s.section === sectionSel ? "selected" : ""} value="${esc(s.section)}">${esc(s.section)} (${s.n})</option>`).join("")}</select>
      <input type="search" id="q" placeholder="Pesquisar (ex.: orçamento, habitação)" value="${esc(q)}">
    </div>
    <div class="cal">${cells}</div>
    <h2>${fmtDate(sel)} <span class="muted small">· ${dayEvs.length} evento(s)</span></h2>
    <div class="card">${dayEvs.map((e) => `<div class="row"><div class="when">${fmtTime(e.start) || "—"}</div><div class="what">${pill(e.section, colorFor(e.section))}
      <div><b>${esc(e.title.split("\n")[0])}</b>${e.subtitle ? ` <span class="muted small">· ${esc(e.subtitle)}</span>` : ""}</div>
      ${e.local ? `<div class="small muted">📍 ${esc(e.local)}</div>` : ""}<div class="detail">${esc((e.text || "").slice(0, 900))}</div></div></div>`).join("") || '<p class="empty">Sem eventos neste dia.</p>'}</div>
    ${data.events.length === 0 ? '<p class="note">Sem dados para este período. A agenda cobre cerca de 2 meses para trás e 5 meses para a frente.</p>' : ""}`;
  const go = (n) => { state.calMonth = new Date(m.getFullYear(), m.getMonth() + n, 1); pageCalendar(); };
  $app.querySelector("#prev").onclick = () => go(-1); $app.querySelector("#next").onclick = () => go(1);
  $app.querySelector("#today").onclick = () => { state.calMonth = null; state.calSel = null; pageCalendar(); };
  $app.querySelector("#sec").onchange = (e) => { $app.dataset.section = e.target.value; pageCalendar(); };
  $app.querySelector("#q").onchange = (e) => { $app.dataset.q = e.target.value; pageCalendar(); };
  $app.querySelectorAll(".cal .d").forEach((c) => c.onclick = () => { state.calSel = c.dataset.d; pageCalendar(); });
}

/* ---------- Leis ---------- */
const STAGES = [
  ["Iniciativa", null], ["Distribuição / relator", ["Distribuição e nomeação de relator"]],
  ["Comissão", ["Relatório/votação em comissão", "Audição em comissão", "Apreciação na especialidade"]],
  ["Plenário", ["Debate em Plenário"]], ["Votação final", null], ["Promulgação", null], ["Publicação em DR", null],
];

async function pageLaws() {
  const kind = $app.dataset.kind || "", q = $app.dataset.lq || "";
  const d = await api(`initiatives?${kind ? "kind=" + encodeURIComponent(kind) + "&" : ""}${q ? "q=" + encodeURIComponent(q) : ""}`);
  $app.innerHTML = `
    <h1>Leis e iniciativas legislativas</h1>
    <p class="lead">Cada projeto ou proposta de lei, do momento em que entra no Parlamento até ao fim do processo. Escolha uma iniciativa para ver o seu percurso.</p>
    <div class="note"><b>Estado dos dados:</b> o percurso mostrado é reconstruído a partir da agenda oficial do Parlamento (distribuição, votação em comissão, debate em plenário). As votações nominais por partido e as versões históricas de cada lei vão ser acrescentadas quando os dados abertos do Parlamento ficarem acessíveis (neste momento o servidor não responde).</div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Pesquisar (ex.: Orçamento do Estado, arrendamento, 87/XVII)" value="${esc(q)}">
      <select id="kind"><option value="">Todos os tipos</option>${d.kinds.map((k) => `<option value="${esc(k.kind)}" ${k.kind === kind ? "selected" : ""}>${esc(k.kind)} (${k.n})</option>`).join("")}</select>
    </div>
    <div class="card">${d.initiatives.map((i) => `<div class="row"><div class="what">
      <a href="#/leis/${encodeURIComponent(i.key)}"><b>${esc(i.kind)} n.º ${i.number}/${esc(i.legislature)}</b>${i.origin ? ` <span class="chip">${esc(i.origin)}</span>` : ""}</a>
      <div>${esc(clean(i.title)) || '<span class="muted">Sem título disponível na agenda</span>'}</div>
      <div class="small muted">${i.steps} entrada(s) na agenda${i.last_date ? ` · última/próxima: ${fmtDate(i.last_date)}` : ""}</div></div></div>`).join("") || '<p class="empty">Nada encontrado.</p>'}</div>
    <h2>Histórico das leis em vigor</h2>
    <div class="card"><p class="muted">Aqui vai aparecer, para cada lei, a sequência de alterações ao longo dos anos (quem a alterou, quando, e como votou cada partido). Esta parte depende da base de dados de iniciativas e votações do Parlamento, que de momento está indisponível; a estrutura já está pronta para a receber (ver <code>ingest/ar_opendata.py</code>).</p></div>`;
  $app.querySelector("#q").onchange = (e) => { $app.dataset.lq = e.target.value; pageLaws(); };
  $app.querySelector("#kind").onchange = (e) => { $app.dataset.kind = e.target.value; pageLaws(); };
}

async function pageLaw(key) {
  const d = await api("initiative?key=" + encodeURIComponent(key));
  const i = d.initiative, now = new Date().toISOString();
  const seen = (names) => names && d.steps.some((s) => names.includes(s.phase) && s.date <= now);
  const planned = (names) => names && d.steps.some((s) => names.includes(s.phase) && s.date > now);
  $app.innerHTML = `
    <a class="back" href="#/leis">← Todas as iniciativas</a>
    <h1>${esc(i.kind)} n.º ${i.number}/${esc(i.legislature)}${i.session ? "/" + i.session + ".ª" : ""} ${i.origin ? `<span class="chip">${esc(i.origin)}</span>` : ""}</h1>
    <p class="lead">${esc(clean(i.title)) || "Sem título disponível na agenda."}</p>
    ${Portal.pages.votacoes ? `<p><a class="btn primary" href="#/votacoes/${encodeURIComponent(i.key)}">Votações por partido e processo completo →</a> ${Portal.followButton("initiative", i.key, i.kind + " " + i.number + "/" + i.legislature)}</p>` : ""}
    <h2>Fase do processo</h2>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">${STAGES.map(([name, phases], idx) => {
      const st = idx === 0 ? "done" : seen(phases) ? "done" : planned(phases) ? "next" : "unk";
      const label = { done: "Registado", next: "Agendado", unk: "Sem dados" }[st];
      return `<div class="card" style="padding:10px;${st === "unk" ? "opacity:.55" : ""}"><b class="small">${esc(name)}</b><div class="small ${st === "done" ? "" : "muted"}">${st === "done" ? "✅" : st === "next" ? "🗓️" : "·"} ${label}</div></div>`;
    }).join("")}</div>
    <h2>Percurso (agenda do Parlamento)</h2>
    <ol class="timeline">${d.steps.map((s) => {
      const fut = s.date > now;
      return `<li class="${fut ? "future" : ""}" style="--c:${colorFor(s.section || "")}"><time>${fmtDate(s.date)} ${fmtTime(s.date)} ${fut ? "· agendado" : ""}</time>
        <b>${esc(s.phase)}</b><div class="small">${esc((s.body || "").slice(0, 160))}${s.local ? " · " + esc(s.local) : ""}</div>
        ${s.relator ? `<div class="small muted">Relator(a): ${esc(s.relator)}</div>` : ""}</li>`;
    }).join("") || '<li class="muted">Sem entradas na agenda.</li>'}</ol>
    <h2>Votações</h2>
    ${d.votes.length ? `<table><tr><th>Data</th><th>Resultado</th><th>A favor</th><th>Contra</th><th>Abstenção</th></tr>${d.votes.map((v) => `<tr><td>${fmtDate(v.date)}</td><td>${esc(v.result)}</td><td>${esc(v.favor)}</td><td>${esc(v.against)}</td><td>${esc(v.abstention)}</td></tr>`).join("")}</table>`
      : '<div class="card"><p class="muted">Votações por partido ainda indisponíveis para esta iniciativa (dependem dos dados abertos do Parlamento).</p></div>'}
    <p class="small muted">Fonte dos passos acima: ${esc([...new Set(d.steps.map((s) => s.source))].join(", ") || "—")}.</p>`;
}

/* ---------- Partidos ---------- */
const SEAT_ORDER = ["B.E.", "PCP", "L", "PAN", "PS", "JPP", "IL", "PSD", "CDS–PP", "CH"];
function hemicycle(parties) {
  const total = parties.reduce((a, p) => a + p.seats, 0), rows = 7, R0 = 80, R1 = 190;
  const radii = Array.from({ length: rows }, (_, r) => R0 + ((R1 - R0) * r) / (rows - 1));
  const sum = radii.reduce((a, b) => a + b, 0);
  let counts = radii.map((r) => Math.round((total * r) / sum));
  counts[rows - 1] += total - counts.reduce((a, b) => a + b, 0);
  const seats = [];
  radii.forEach((r, ri) => { for (let k = 0; k < counts[ri]; k++) { const a = Math.PI * (1 - (counts[ri] === 1 ? 0.5 : k / (counts[ri] - 1))); seats.push({ a, x: 200 + r * Math.cos(a), y: 200 - r * Math.sin(a) }); } });
  seats.sort((s, t) => t.a - s.a);
  const ord = [...parties].sort((a, b) => SEAT_ORDER.indexOf(a.code) - SEAT_ORDER.indexOf(b.code));
  let idx = 0, dots = "";
  ord.forEach((p) => { for (let k = 0; k < p.seats; k++, idx++) { const s = seats[idx]; if (s) dots += `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="5.2" fill="${p.color}"><title>${esc(p.code)}</title></circle>`; } });
  return `<svg viewBox="0 0 400 215" role="img" aria-label="Composição do Parlamento" style="width:100%;max-width:560px;display:block;margin:auto">${dots}<text x="200" y="195" text-anchor="middle" font-size="26" font-weight="700">${total}</text><text x="200" y="210" text-anchor="middle" font-size="9" opacity=".7">deputados</text></svg>`;
}

async function pageParties() {
  const d = await api("parties");
  const gov = d.parties.filter((p) => p.bloc === "Governo").reduce((a, p) => a + p.seats, 0);
  $app.innerHTML = `
    <h1>Partidos e deputados</h1>
    <p class="lead">XVII Legislatura (desde junho de 2025). Nenhum partido tem maioria absoluta (116 lugares). O Governo é apoiado por ${gov} deputados.</p>
    <div class="card">${hemicycle(d.parties)}
      <div style="text-align:center;margin-top:.5rem">${d.parties.map((p) => pill(`${p.code} ${p.seats}`, p.color)).join("")}</div></div>
    <h2>Partidos com assento parlamentar</h2>
    <div class="grid">${d.parties.map((p) => `<div class="card" style="border-top:5px solid ${p.color}">
      <h3>${esc(p.name)} <span class="muted small">(${esc(p.code)})</span></h3>
      <p style="margin:0"><b style="font-size:1.6rem">${p.seats}</b> <span class="muted">${p.seats === 1 ? "deputado" : "deputados"} · ${esc(p.bloc || "")}</span></p>
      <p class="small muted">${esc(p.ideology || "")}</p>
      ${p.website ? `<a class="small" href="${esc(p.website)}" target="_blank" rel="noopener">Sítio oficial</a>` : ""}</div>`).join("")}</div>
    <h2>Deputados</h2>
    <div class="card"><p>A lista nominal dos 230 deputados, com círculo, comissões, iniciativas e presenças em plenário, está na secção <a href="#/deputados">Deputados</a> (fonte: parlamento.pt). Os números por partido acima vêm da Wikipédia (XVII Legislatura) e coincidem com a lista oficial.</p></div>`;
}

/* ---------- Governo ---------- */
async function pageGov() {
  const d = await api("government");
  const pm = d.members.find((m) => m.role === "Primeiro-Ministro"), mins = d.members.filter((m) => m !== pm);
  const person = (m, role) => `<div class="card person"><div class="avatar">${esc(initials(m.name))}</div><div><b>${esc(m.name)}</b><div class="small muted">${esc(role || m.role)}</div>${m.party ? `<span class="chip">${esc(m.party)}</span>` : ""}</div></div>`;
  $app.innerHTML = `
    <h1>Presidente e Governo</h1>
    <h2>Presidente da República</h2>
    <div class="grid">${person(d.president, "Presidente da República · em funções desde " + fmtDate(d.president.since))}</div>
    <p class="small"><a href="#/poderes/presidente">O que faz o Presidente →</a> · <a href="https://www.presidencia.pt" target="_blank" rel="noopener">presidencia.pt</a></p>
    <h2>XXV Governo Constitucional</h2>
    <div class="grid">${person(pm, "Primeiro-Ministro")}</div>
    <h2>Ministros</h2>
    <div class="grid">${mins.map((m) => person(m)).join("")}</div>
    <p class="small muted">Fontes: Wikidata (Presidente e PM) e Wikipédia (composição do Governo). Pode estar desfasado de remodelações recentes; confirme em <a href="https://www.portugal.gov.pt/pt/gc25" target="_blank" rel="noopener">portugal.gov.pt</a>.</p>`;
}

