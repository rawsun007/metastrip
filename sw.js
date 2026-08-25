/* MetaStrip service worker: offline support + Android share target.

   Two strategies, chosen by what the thing is.

   HTML is network-first, so a new release lands immediately.

   Everything else is cache-first. The bundle, the stylesheet and the images
   are version-stamped and only change when the cache name changes, so asking
   the network about them again on every visit spends bandwidth to be told
   nothing changed. A returning visitor now costs close to zero requests,
   which is what keeps a traffic spike from taking the site off the air.

   CACHE carries the release version, so shipping a version retires the
   previous cache on activate. */

const CACHE = "metastrip-v1.2.2";
const CORE = ["./", "./index.html", "./styles.css", "./js/bundle.js"];

/* Things that never change without a new release, so once they are in the
   cache there is no reason to ask again. */
function isImmutable(url) {
  return /\.(css|js|png|jpg|jpeg|webp|avif|svg|woff2?|mp4)$/i.test(url.pathname);
}

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

  // cache-first for assets: a hit costs nothing and never reaches the network
  if (isImmutable(url)) {
    event.respondWith(
      caches.match(event.request).then((hit) => {
        if (hit) return hit;
        return fetch(event.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        });
      })
    );
    return;
  }

  // network-first for pages, so a new release is never held back by a cache
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
