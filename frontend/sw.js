const CACHE_NAME = "adaptive-fit-shell-v3";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./api.js",
  "./config.js",
  "./vision.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Only intercept requests for our own app-shell files. Everything else
// (the backend API, the MediaPipe CDN model, jsQR) goes straight to the
// network untouched — the app needs those to be live, not cached.
self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname.includes("/api/") || new URL(event.request.url).pathname.startsWith("/auth/")) return;
  const url = new URL(event.request.url);
  const isOwnOrigin = url.origin === self.location.origin;
  const isShellFile = SHELL_ASSETS.some((asset) => url.pathname.endsWith(asset.replace("./", "/")));

  if (!isOwnOrigin || !isShellFile) return; // let the browser handle it normally

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse.clone()));
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
