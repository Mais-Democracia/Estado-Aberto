import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const files = [pub, path.join(pub, "modules")].flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".js")).map((f) => path.join(d, f)));
const src = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
const portal = fs.readFileSync(path.join(pub, "portal.js"), "utf8");

const m = portal.match(/const NAV_GROUPS = (\[[\s\S]*?\n\]);/);
if (!m) { console.error("NAV_GROUPS not found"); process.exit(1); }
const groups = vm.runInNewContext(m[1]);
const pages = new Set([...src.matchAll(/Portal\.page\("([a-z0-9-]+)"/g)].map((x) => x[1]));
const exempt = new Set(["", "edicao", "painel", "painel-classico", "artigo", "contrato", "entidade", "historia"]);

const errors = [];
const seen = new Map();
for (const [label, , items] of groups) for (const [r] of items) {
  seen.set(r, [...(seen.get(r) || []), label]);
  if (!pages.has(r)) errors.push(`nav route without page: ${r}`);
}
for (const [r, ls] of seen) if (ls.length > 1) errors.push(`${r} in several groups: ${ls.join(", ")}`);
for (const p of pages) if (!exempt.has(p) && !seen.has(p)) errors.push(`page not in menu: ${p}`);
if (groups.some(([l]) => /^mais$/i.test(l))) errors.push("Mais group present");
if (/["']Mais["']/.test(portal)) errors.push("Mais string in portal.js");
if (!/Portal\.NAV_GROUPS\s*=\s*NAV_GROUPS/.test(portal)) errors.push("Portal.NAV_GROUPS not exported");

if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log(`ok: ${groups.length} groups, ${seen.size} pages`);
