import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dump = process.argv[2];
if (!dump) { console.error("uso: node tools/check_schema_compat.mjs <dump.sql> [--port N] [--keep]"); process.exit(2); }
const pi = process.argv.indexOf("--port");
const port = pi > -1 ? process.argv[pi + 1] : "3193";
const keep = process.argv.includes("--keep");

const sections = new Map();
let cur = null;
for (const line of fs.readFileSync(dump, "utf8").split("\n")) {
  const m = line.match(/^-- DB (\S+)/);
  if (m) { cur = m[1]; sections.set(cur, []); continue; }
  if (cur) sections.get(cur).push(line);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ea-schema-"));
const data = path.join(tmp, "data");
fs.mkdirSync(data);
const splitStatements = (lines) => {
  const out = [];
  let acc = "";
  for (const l of lines) {
    acc += l + "\n";
    if (/;\s*$/.test(l) && !/^\s*--/.test(l)) {
      const probe = new DatabaseSync(":memory:");
      let ok = true;
      try { probe.prepare(acc); } catch (e) { ok = !/incomplete input/i.test(String(e.message)); }
      probe.close();
      if (ok) { out.push(acc.trim()); acc = ""; }
    }
  }
  return out;
};
let built = 0;
for (const [name, lines] of sections) {
  const con = new DatabaseSync(path.join(data, name));
  let pend = splitStatements(lines).filter((s) => !/sqlite_sequence|sqlite_stat\d|_fts_(config|data|docsize|idx|content)\b/.test(s));
  for (let pass = 0; pass < 4 && pend.length; pass++) {
    const next = [];
    for (const s of pend) { try { con.exec(s); } catch { next.push(s); } }
    pend = next;
  }
  for (const s of pend) console.error(`aviso: ${name}: não aplicado: ${s.slice(0, 70)}`);
  con.close();
  built++;
}

const report = path.join(tmp, "report.json");
const r = spawnSync(process.execPath, ["--no-warnings", path.join(root, "tools", "smoke.mjs"), "--port", port, "--data", data, "--report", report], { cwd: root, encoding: "utf8", timeout: 600000 });
let rows = [];
try { rows = JSON.parse(fs.readFileSync(report, "utf8")); } catch { console.error(r.stdout.slice(-2000)); console.error(r.stderr.slice(-2000)); }
const bad = rows.filter((x) => x.status >= 500 && !(x.status === 503 && !/no such (table|column)/i.test(x.detail)));
const dbsWanted = new Set(rows.filter((x) => x.status === 503 && /dados_indisponiveis|não encontrada/.test(x.detail)).map((x) => x.route.split("/")[2]));
console.log(`bases no dump: ${built}  rotas varridas: ${rows.length}  incompatíveis: ${bad.length}`);
for (const x of bad) {
  const ident = (x.detail.match(/no such (?:table|column): ([\w.]+)/i) || [])[1];
  console.log(` - ${x.route} -> ${x.status}${ident ? ` falta ${ident}` : ""} ${ident ? "" : x.detail}`.trimEnd());
}
if (!keep) fs.rmSync(tmp, { recursive: true, force: true }); else console.log("dados em", data);
process.exit(bad.length ? 1 : 0);
