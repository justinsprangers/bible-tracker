// Offline support: serve the app from cache, refresh the cache in the background.
// Bump CACHE when shipping changes so old files are cleared out.
const CACHE = "bible-tracker-v4";
const SHELL = [
  "./", "index.html", "styles.css", "bible.js", "snapshot.js", "app.js", "manifest.webmanifest",
  "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png",
];

self.addEventListener("install", e => {
  // Cache files one by one so an optional file (snapshot.js) being absent doesn't break offline mode.
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.allSettled(SHELL.map(f => c.add(f))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  // Only handle this app's own files; sync requests to Google go straight to the network.
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true }) ||
        (req.mode === "navigate" ? await cache.match("index.html") : undefined);
      const fresh = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      if (cached) { e.waitUntil(fresh); return cached; }
      return fresh;
    })
  );
});
