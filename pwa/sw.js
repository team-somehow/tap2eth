// Minimal service worker so the app is installable. Network-first; API calls are never cached.
const CACHE = "tap2eth-v2";
const SHELL = ["/", "/index.html", "/app.js", "/manifest.json", "/icon.svg", "/style.css"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener("fetch", (e) => {
  if (e.request.url.includes("/api/")) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
