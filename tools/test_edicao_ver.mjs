import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.ESTADO_ABERTO_DIARIO_FLOOR = "2026-10-01";
process.env.ESTADO_ABERTO_TODAY = "2026-11-06";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edicao-ver-"));
const db = new DatabaseSync(path.join(tmp, "diario.db"));
db.exec(`
CREATE TABLE edicoes (numero INTEGER, data TEXT, estado TEXT, fechada_em TEXT);
CREATE TABLE cursores (fonte TEXT, max_data TEXT, atualizado_em TEXT);
CREATE TABLE eventos (id INTEGER PRIMARY KEY, data_evento TEXT, ingerido_em TEXT, edicao_data TEXT, secao TEXT, tipo TEXT, titulo TEXT, resumo_curto TEXT, fonte_modulo TEXT, fonte_ref TEXT, entidades TEXT, rota TEXT, source_url TEXT, score REAL, atrasado INTEGER, ia_artigo_id INTEGER);
CREATE TABLE artigos_ia (id INTEGER PRIMARY KEY, evidence_hash TEXT, edicao_data TEXT, estado TEXT, evento_ids TEXT, titulo TEXT, lead TEXT, corpo TEXT, pontos_chave TEXT, fontes TEXT, entidades TEXT, numeros_citados TEXT, confianca REAL, modelo TEXT, revisor TEXT, verificacao TEXT, criado_em TEXT, revisao INTEGER, blocos TEXT, explicacao TEXT);
`);
const D = "2026-11-06";
const ev = (id, o) => db.prepare("INSERT INTO eventos VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, o.data || "2026-11-05", "2026-11-06 07:10:00", o.ed || D, o.secao || "governo", o.tipo, o.titulo || "t" + id, "", o.mod, o.ref, JSON.stringify(o.ents || []), o.rota ?? "", null, o.score || 10, o.late || 0, o.ia ?? null);
ev(1, { tipo: "decreto_lei", mod: "dre", ref: "1191346239", rota: "#/dre", titulo: "Decreto-Lei n.º 213/2026" });
ev(2, { tipo: "lei_publicada", mod: "dre", ref: "1191346238", rota: "#/dre", titulo: "Lei n.º 65/2026", secao: "parlamento" });
ev(3, { tipo: "promulgacao", mod: "presidencia", ref: "77", rota: "#/atos-presidente/77" });
ev(4, { tipo: "votacao_final", mod: "votacoes", ref: "900", rota: "#/votacoes", ents: [{ tipo: "iniciativa", id: "271828" }], secao: "parlamento" });
ev(5, { tipo: "presidencia_dia", mod: "presidencia", ref: "2026-11-05", rota: "#/presidencia" });
ev(6, { tipo: "contrato_grande", mod: "politica", ref: "5555", rota: "#/contratos", secao: "dinheiro", data: "2026-10-16", late: 1 });
ev(7, { tipo: "apoio", mod: "apoios", ref: "9", rota: "#/apoios", secao: "dinheiro", data: "2026-11-04", late: 0 });
ev(8, { tipo: "debate", mod: "intervencoes", ref: "314159", rota: "#/votacoes", secao: "parlamento" });
ev(9, { tipo: "votacao", mod: "votacoes", ref: "901", rota: "#/votacoes", ents: [{ tipo: "iniciativa", id: "314159" }], secao: "parlamento" });
ev(10, { tipo: "indicador_ine", mod: "ine_series", ref: "0008074", rota: "#/indicadores", secao: "indicadores" });
ev(11, { tipo: "nomeacao", mod: "responsaveis", ref: "x1", rota: "#/responsaveis", secao: "nomeacoes", ed: "2026-11-05" });
db.prepare("INSERT INTO edicoes VALUES (1, ?, 'preliminar', NULL)").run(D);
const art = (id, ids, extra = {}) => db.prepare("INSERT INTO artigos_ia VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, "h" + id, D, "publicado", JSON.stringify(ids), "A" + id, "lead", "corpo", "[]", "[]", "[]", "[]", 0.9, "m", "r", "{}", "2026-11-06 08:00:00", 1, extra.blocos ? JSON.stringify(extra.blocos) : null, null);
art(1, [1], { blocos: { lei: { titulo: "DL", tipo: "Decreto-Lei", numero: "213/2026", rota: "#/dre" } } });
art(2, [2], { blocos: { lei: { titulo: "Lei", rota: "#/leis" } } });
art(3, [3]);
art(4, [4]);
art(5, [5]);
art(6, [8, 9]);
art(7, [8]);
art(8, [10]);
db.prepare("UPDATE eventos SET ia_artigo_id = 1 WHERE id = 1").run();

const routes = {};
const mod = await import(pathToFileURL(path.join(root, "server", "modules", "edicao.mjs")).href);
mod.default({ routes, all: () => [], one: () => null, openData: (n) => (n === "diario" ? db : null), unavailable: () => ({}), dataDir: tmp });

const day = routes["/api/edicao/dia"](new URLSearchParams({ data: D }));
assert.equal(day.fonte, "diario");
const byId = new Map(day.ia.map((a) => [a.id, a]));
const ver = (id) => byId.get(id)?.ver;
assert.deepEqual(ver(1), { rota: "#/dre/1191346239", rotulo: "Ver a lei" });
assert.equal(byId.get(1).blocos.lei.rota, "#/dre/1191346239");
assert.deepEqual(ver(2), { rota: "#/dre/1191346238", rotulo: "Ver a lei" });
assert.equal(byId.get(2).blocos.lei.rota, "#/dre/1191346238");
assert.deepEqual(ver(3), { rota: "#/atos-presidente/77", rotulo: "Ver o ato" });
assert.deepEqual(ver(4), { rota: "#/votacoes/271828", rotulo: "Ver a votação" });
assert.deepEqual(ver(5), { rota: "#/presidencia", rotulo: "Ver o registo" });
assert.deepEqual(ver(8), { rota: "#/indicadores/0008074", rotulo: "Ver o registo" });
for (const a of day.ia) if (a.ver) assert.match(a.ver.rota, /^#\/[\w\-.%/?=&]+$/);

assert.ok(!byId.has(6), "older article on same initiative is dropped");
assert.equal(byId.get(7).versao_anterior.id, 6);
assert.deepEqual(ver(7), { rota: "#/votacoes/314159", rotulo: "Ver a votação" });

const ledgerIds = day.secoes.flatMap((s) => s.itens.map((i) => i.id));
for (const covered of [1, 2, 3, 4, 5, 8, 9, 10]) assert.ok(!ledgerIds.includes(covered), "event " + covered + " is covered");
assert.deepEqual(ledgerIds.sort((a, b) => a - b), [6, 7]);

const it6 = day.secoes.flatMap((s) => s.itens).find((i) => i.id === 6);
assert.equal(it6.atraso, "Em arquivo · ocorreu a 16 de outubro de 2026");
assert.equal(it6.arquivo, true);
const it7 = day.secoes.flatMap((s) => s.itens).find((i) => i.id === 7);
assert.equal(it7.atrasado, false);
assert.equal(it7.atraso, undefined);

const rawTudo = routes["/api/edicao/dia"](new URLSearchParams({ data: D, vista: "tudo" }));
const t5 = rawTudo.tudo.flatMap((s) => s.itens).find((i) => i.id === 5);
assert.equal(t5.rota, "#/presidencia");

const detail = routes["/api/edicao/artigo"](new URLSearchParams({ id: "2" }));
assert.deepEqual(detail.ver, { rota: "#/dre/1191346238", rotulo: "Ver a lei" });
assert.equal(detail.blocos.lei.rota, "#/dre/1191346238");
const detail3 = routes["/api/edicao/artigo"](new URLSearchParams({ id: "3" }));
assert.equal(detail3.ver.rota, "#/atos-presidente/77");

const src = fs.readFileSync(path.join(root, "public", "edicao.js"), "utf8");
const m = /const TIPO_LABEL = \{[\s\S]*?\n  \};\n  const tipoLabel = [\s\S]*?\n  \};/.exec(src);
assert.ok(m, "label map not found");
const ctx = vm.createContext({});
vm.runInContext(m[0] + "\nthis.tipoLabel = tipoLabel; this.TIPO_LABEL = TIPO_LABEL;", ctx);
assert.equal(ctx.tipoLabel("votacao"), "Votação");
assert.equal(ctx.tipoLabel("promulgacao"), "Promulgação");
assert.equal(ctx.tipoLabel("presidencia_dia"), "Presidência · atos do dia");
assert.equal(ctx.tipoLabel("algo_novo"), "Algo novo");
assert.equal(ctx.tipoLabel(""), "Registo");
const py = fs.readFileSync(path.join(root, "ingest", "jobs", "diario.py"), "utf8") + fs.readFileSync(path.join(root, "ingest", "diario_score.py"), "utf8");
const tipos = new Set();
for (const x of py.matchAll(/c\.ev\("[a-z_]+", [^,]+, (?:"([a-z_]+)" if [^"]+ else "([a-z_]+)"|"([a-z_]+)")/g)) [1, 2, 3].forEach((i) => x[i] && tipos.add(x[i]));
for (const x of py.matchAll(/summary_event\(c, "[a-z_]+", "([a-z_]+)"/g)) tipos.add(x[1]);
for (const ln of py.split("\n")) if (/\btipo = /.test(ln) && !/DRE_KINDS|\["tipo"\]\)? *$/.test(ln)) for (const x of ln.replace(/startswith\("[^"]*"\)/g, "").replace(/\w+\["[a-z_]+"\]/g, "").matchAll(/(?<![\w.])"([a-z_]+)"/g)) tipos.add(x[1]);
for (const x of py.matchAll(/^\s+"[^"]+": \("[a-z-]+", "([a-z_]+)"\)/gm)) tipos.add(x[1]);
for (const x of py.matchAll(/^    "([a-z_]+)": \d+,$/gm)) tipos.add(x[1]);
for (const t of ["votacao", "votacao_final", "promulgacao", "presidencia_dia", "contrato_grande", "decreto_lei"]) assert.ok(tipos.has(t), "extractor missed " + t);
for (const t of tipos) assert.ok(Object.hasOwn(ctx.TIPO_LABEL, t), "missing label for " + t);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("edicao ver ok");
