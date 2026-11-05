"use strict";
const VERSION = "0.1.2";
const CACHE = "ea-" + VERSION;
const SHELL = ["/", "/offline.html", "/style.css", "/edicao.css", "/routes.js", "/app.js", "/portal.js", "/edicao.js", "/boot.js", "/fonts/fraunces-latin-600-normal.woff2", "/fonts/Lora-Regular.woff2"];
const API_SKIP = /^\/api\/(follows|feed|search)(\/|$)/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("ea-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("message", (e) => { if (e.data === "skipWaiting") self.skipWaiting(); });

const put = (req, res) => { if (res && res.ok && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); } return res; };

const staleWhileRevalidate = async (req, e) => {
  const hit = await caches.match(req);
  const net = fetch(req).then((r) => put(req, r)).catch(() => null);
  e.waitUntil(net);
  if (hit) return hit;
  return (await net) || Response.error();
};

const networkFirst = async (req, key = req) => {
  try { return put(key, await fetch(req)); } catch { const hit = await caches.match(key); if (hit) return hit; throw new Error("offline"); }
};

const cacheFirst = async (req) => {
  const hit = await caches.match(req);
  if (hit) return hit;
  return put(req, await fetch(req));
};

const stamp = async (r) => {
  const h = new Headers({ "content-type": r.headers.get("content-type") || "text/html; charset=utf-8", "x-ea-cached-at": String(Date.now()) });
  return new Response(await r.clone().blob(), { status: r.status, statusText: r.statusText, headers: h });
};

const aged = async (hit) => {
  const t = Number(hit.headers.get("x-ea-cached-at")) || 0;
  const text = (await hit.text()).replace("</head>", `<script>window.__EA_AGE=${t ? Date.now() - t : 86400000}</script></head>`);
  return new Response(text, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
};

const navigate = async (req, e) => {
  const hit = await caches.match("/");
  const net = fetch(req).then(async (r) => { if (r.ok && r.status === 200) { const c = await caches.open(CACHE); await c.put("/", await stamp(r)); } return r; });
  if (hit) { e.waitUntil(net.catch(() => {})); return aged(hit); }
  try { return await net; } catch { return (await caches.match("/offline.html")) || Response.error(); }
};

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === "/sw.js") return;
  if (url.pathname.startsWith("/api/")) {
    if (API_SKIP.test(url.pathname)) return;
    e.respondWith(req.headers.get("x-ea-revalidate") ? networkFirst(req).catch(() => Response.error()) : staleWhileRevalidate(req, e));
    return;
  }
  if (req.mode === "navigate") { e.respondWith(navigate(req, e)); return; }
  if (url.searchParams.has("v") || url.pathname.startsWith("/fonts/")) { e.respondWith(cacheFirst(req).catch(() => Response.error())); return; }
  e.respondWith(staleWhileRevalidate(req, e));
});
