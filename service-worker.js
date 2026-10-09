const CACHE = "bet-analyzer-2-v8";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith("bet-analyzer-") && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.url.includes("/api/")) return;

  const url = new URL(event.request.url);
  const isAppShell = url.origin === self.location.origin &&
    (event.request.mode === "navigate" ||
      url.pathname.endsWith("/index.html") ||
      url.pathname.endsWith("/app.js") ||
      url.pathname.endsWith("/service-worker.js"));

  if (isAppShell) {
    // Prefer the latest deployed app shell; use cache only when offline.
    event.respondWith(
      fetch(event.request, { cache: "no-store" }).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match(event.request).then(cached => cached || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match("./index.html"));
    })
  );
});
