import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [fixtures, optDir] = process.argv.slice(2);
const port = Number(process.env.STUB_PORT || 3170);

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/api/status") {
    const ok = fs.existsSync(path.join(optDir, "current", "HEALTHY"));
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok }));
  }
  if (/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(url)) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(fs.readFileSync(path.join(fixtures, "latest.json")));
  }
  const m = url.match(/^\/assets\/([\w.\-]+)$/);
  if (m && fs.existsSync(path.join(fixtures, "assets", m[1]))) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(fs.readFileSync(path.join(fixtures, "assets", m[1])));
  }
  res.writeHead(404);
  res.end();
}).listen(port, "127.0.0.1");
