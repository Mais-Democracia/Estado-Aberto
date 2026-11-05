import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const found = {
  VERSION: read("VERSION").trim(),
  "package.json": JSON.parse(read("package.json")).version,
  "public/sw.js": (read("public/sw.js").match(/^const VERSION = "([^"]*)";/m) || [])[1],
  "public/index.html": (read("public/index.html").match(/<meta name="ea-version" content="([^"]*)">/) || [])[1],
  "ops/release-manifest.json": JSON.parse(read("ops/release-manifest.json")).version,
};
const want = found.VERSION;
const bad = Object.entries(found).filter(([, v]) => v !== want);
if (bad.length) {
  console.error("version mismatch (VERSION=" + want + "): " + bad.map(([k, v]) => k + "=" + v).join(", "));
  process.exit(1);
}
