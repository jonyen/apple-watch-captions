#!/usr/bin/env node
// Health links for everything running on the iMac. Serves one HTML page on
// 127.0.0.1:8120 (put behind `tailscale serve` so it is tailnet-only) that
// probes each service live and links to the ones with a browsable URL.
import http from "node:http";
import net from "node:net";

const HOST = "imac.tailb6f6c9.ts.net";

// kind "http": GET the probe path and expect any response; kind "tcp": a
// successful connect is healthy. `link` is what the row points at (absent =
// internal-only service).
const SERVICES = [
  { name: "Caption relay", kind: "http", port: 8080, path: "/healthz", link: `https://${HOST}:10000/` },
  { name: "Transcriber sidecar (Apple STT)", kind: "tcp", port: 8790 },
  { name: "Doorlog app", kind: "tcp", port: 8787, link: `https://${HOST}/` },
  { name: "Doorlog web log", kind: "tcp", port: 8099, link: `https://${HOST}:4443/` },
  { name: "Ring token exchange", kind: "tcp", port: 8096, link: `https://${HOST}/ring/token-exchange` },
  { name: "Service on :8443", kind: "tcp", port: 8100, link: `https://${HOST}:8443/` },
  { name: "Service on :9443", kind: "tcp", port: 8110, link: `https://${HOST}:9443/` },
  { name: "Bible quiz admin", kind: "tcp", port: 18789 },
  { name: "Ollama", kind: "http", port: 11434, path: "/api/version" },
];

function probeTCP(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (up) => { sock.destroy(); resolve({ up, ms: Date.now() - started }); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function probeHTTP(port, path, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get({ host: "127.0.0.1", port, path, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ up: res.statusCode > 0 && res.statusCode < 500, ms: Date.now() - started });
    });
    req.on("timeout", () => { req.destroy(); resolve({ up: false, ms: timeoutMs }); });
    req.on("error", () => resolve({ up: false, ms: Date.now() - started }));
  });
}

async function render() {
  const results = await Promise.all(SERVICES.map(async (s) => ({
    ...s,
    ...(s.kind === "http" ? await probeHTTP(s.port, s.path ?? "/") : await probeTCP(s.port)),
  })));
  const rows = results.map((r) => {
    const dot = r.up ? "🟢" : "🔴";
    const title = r.link ? `<a href="${r.link}">${r.name}</a>` : r.name;
    const note = r.link ? "" : " · internal";
    return `<li>${dot} ${title} <small>:${r.port} · ${r.ms} ms${note}</small></li>`;
  });
  const upCount = results.filter((r) => r.up).length;
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>iMac services</title>
<style>
  body { font: 16px -apple-system, sans-serif; margin: 2rem auto; max-width: 34rem; padding: 0 1rem;
         background: #fff; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } a { color: #8cf; } }
  li { margin: .55rem 0; list-style: none; }
  ul { padding: 0; }
  small { opacity: .6; }
</style>
<h2>iMac services · ${upCount}/${results.length} up</h2>
<ul>${rows.join("\n")}</ul>
<small>Probed live from the iMac at ${new Date().toLocaleTimeString()} · refreshes every 30 s</small>`;
}

http.createServer(async (req, res) => {
  if (req.url !== "/" && req.url !== "/index.html") { res.writeHead(404); res.end(); return; }
  try {
    const body = await render();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err));
  }
}).listen(8120, "127.0.0.1", () => {
  console.error("status page on http://127.0.0.1:8120");
});
