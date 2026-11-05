import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("window.fetch = function"));
assert.ok(code, "fetch wrapper not found in index.html");

const hits = {};
const server = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;
  const n = hits[req.url];
  const send = (c, o) => { const b = JSON.stringify(o); res.writeHead(c, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(b); };
  if (req.url === "/api/slow") return n < 3 ? send(202, { status: "carregando", retry_after: 2 }) : send(200, { ok: true, n });
  if (req.url === "/api/post") return send(202, { status: "carregando" });
  send(200, { plain: true });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

const realFetch = globalThis.fetch;
const win = { fetch: (u, o) => realFetch(String(u).startsWith("/") ? base + u : u, o), Response };
vm.runInNewContext(code, { window: win, setTimeout, Date, Promise });

let t = Date.now();
let r = await win.fetch("/api/slow");
assert.equal(r.status, 200);
assert.deepEqual(await r.json(), { ok: true, n: 3 });
assert.equal(hits["/api/slow"], 3);
assert.ok(Date.now() - t >= 1200, "backoff 500 then 750 ms");

r = await win.fetch("/api/post", { method: "POST" });
assert.equal(r.status, 202);
assert.equal(hits["/api/post"], 1);

r = await win.fetch("/other");
assert.equal(r.status, 200);
assert.equal(hits["/other"], 1);

server.close();
console.log("retry202 ok");
