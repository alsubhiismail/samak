// Offline support: the app shell is versioned; images, model and runtime live in a long-lived asset cache.
const VER = "202610210050";
const SHELL = "samak-shell-" + VER;
const ASSETS = "samak-assets-v1";
const SHELL_FILES = ["./", "index.html", "app.css", "app.js", "ml-worker.js", "manifest.webmanifest", "data/species.json", "data/meta.json", "data/refs.bin", "fonts/plex-ar-400.woff2", "fonts/plex-lat-400.woff2", "fonts/plex-ar-600.woff2", "fonts/plex-lat-600.woff2", "fonts/reem-kufi-700.woff2", "fonts/plex-serif-400i.woff2", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "data/assets.json"];

self.addEventListener("install", (e) => {
  // bypass the HTTP cache so an update never installs stale files
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("samak-shell-") && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    if (req.mode === "navigate") {
      const c = await caches.open(SHELL);
      const hit = await c.match("index.html");
      if (hit) return hit;
      return fetch(req);
    }
    const hit = (await caches.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r.ok && /\/(img|fonts)\//.test(url.pathname)) {
        const c = await caches.open(ASSETS);
        c.put(new Request(url.origin + url.pathname), r.clone());
      }
      return r;
    } catch (err) {
      return new Response("", { status: 504, statusText: "offline" });
    }
  })());
});
