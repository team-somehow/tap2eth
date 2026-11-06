// One public URL, one route per network. Each network keeps its own single-chain relayer process (its own chain, factory,
// wallets and state file); this small front door forwards by the first part of the path:
//
//   /whitechain/api/...  ->  the Whitechain relayer
//   /sepolia/api/...     ->  the Ethereum Sepolia relayer
//   /api/...             ->  the default network (DEFAULT_NETWORK), so apps and terminals that know nothing about routes keep working
//   /api/networks        ->  the list of networks and whether each is up (for the settings screens on the Pi and in the app)
//
// Usage: node gateway.js            (started by ./backend.sh both)
// Env:   PORT (8787), DEFAULT_NETWORK (whitechain), WHITECHAIN_PORT (8788), SEPOLIA_PORT (8791)
const http = require("http");

const PORT = Number(process.env.PORT || 8787);
const NETWORKS = {
  whitechain: { name: "Whitechain testnet", port: Number(process.env.WHITECHAIN_PORT || 8788) },
  sepolia: { name: "Ethereum Sepolia", port: Number(process.env.SEPOLIA_PORT || 8791) },
};
const DEFAULT = (process.env.DEFAULT_NETWORK || "whitechain").toLowerCase();
if (!NETWORKS[DEFAULT]) { console.error(`DEFAULT_NETWORK must be one of: ${Object.keys(NETWORKS).join(", ")}`); process.exit(1); }

const ping = (port) => new Promise((resolve) => {
  const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 2500 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
  req.on("timeout", () => { req.destroy(); resolve(false); });
  req.on("error", () => resolve(false));
});

function pick(url) {
  const m = /^\/([a-z]+)(\/.*)?$/.exec(url.split("?")[0]);
  if (m && NETWORKS[m[1]]) return { id: m[1], path: url.slice(m[1].length + 1) || "/" };
  return { id: DEFAULT, path: url };
}

http.createServer(async (req, res) => {
  if (req.url.split("?")[0] === "/api/networks") {
    const list = await Promise.all(Object.entries(NETWORKS).map(async ([id, n]) => ({ id, name: n.name, route: `/${id}`, default: id === DEFAULT, online: await ping(n.port) })));
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    return res.end(JSON.stringify({ networks: list }));
  }
  const { id, path } = pick(req.url);
  const up = http.request({ host: "127.0.0.1", port: NETWORKS[id].port, path, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `The ${NETWORKS[id].name} backend is not running. Start it with ./backend.sh both.` }));
  });
  req.pipe(up);
}).listen(PORT, "0.0.0.0", () => console.log(`gateway on :${PORT}  routes: ${Object.keys(NETWORKS).map((k) => `/${k}`).join(" ")}  default: ${DEFAULT}`));
