/* MetaStrip service worker: offline support + Android share target.
   Network-first so updates land immediately, cache fallback offline. */

const CACHE = "metastrip-v2";
const CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/app.js",
  "./js/exif.js",
  "./js/video.js",
  "./js/storage.js",
  "./js/stripper.js",
  "./js/motion.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== "share-inbox").map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Android share sheet posts shared photos here
  if (event.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(
      (async () => {
        const data = await event.request.formData();
        const files = data.getAll("photos").filter((f) => f && f.size);
        const inbox = await caches.open("share-inbox");
        await Promise.all(
          files.map((f, i) =>
            inbox.put(
              `./shared-photo-${i}`,
              new Response(f, {
                headers: {
                  "Content-Type": f.type || "application/octet-stream",
                  "X-Name": encodeURIComponent(f.name || `shared-${i}`),
                },
              })
            )
          )
        );
        return Response.redirect("./?shared=" + files.length, 303);
      })()
    );
    return;
  }

  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: url.pathname.endsWith("/") }))
  );
});
