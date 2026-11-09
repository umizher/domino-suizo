/* Service worker: network-first (sin caché del navegador) con fallback a caché.
 * Online siempre sirve lo último; sin internet la app sigue funcionando. */
const CACHE = "domino-torneo-v21";
const ASSETS = [
  "./",
  "index.html",
  "torneo.html",
  "publico.html",
  "js/swiss-engine.js?v=17",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
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
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const nav = req.mode === "navigate";
  // Copia guardada: las páginas se buscan sin "?continuar" y similares;
  // si no hay ninguna, el Inicio.
  const fromCache = () => caches.match(req, { ignoreSearch: nav })
    .then(hit => hit || (nav ? caches.match("index.html") : undefined));
  e.respondWith(
    // cache: "no-cache" → siempre pregunta al servidor si hay versión nueva
    // (antes podía usar una copia guardada por el navegador hasta 10 minutos).
    fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
      .then(res => {
        // Solo se guardan respuestas buenas: una página de error de GitHub
        // (404/500) no debe reemplazar la copia que sirve sin internet.
        if (!res.ok) return fromCache().then(hit => hit || res);
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => fromCache().then(hit => hit || Response.error()))
  );
});
