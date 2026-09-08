/* Bump CACHE on every deploy so clients pick up new code. */
const CACHE = "playtime-v35";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest",
               "favicon-32.png", "favicon-64.png", "apple-touch-icon.png", "icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Leave cross-origin requests alone — cover art comes from the PlayStation
  // CDN, and intercepting it turns a transient hiccup into a missing image.
  if (url.origin !== location.origin) return;
  // Data is always fetched fresh; the shell is cache-first.
  if (url.pathname.includes("/data/")) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
