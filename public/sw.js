// Service worker: caches only this app's own files so it opens instantly (and offline).
// It never touches cross-origin requests, so GitHub API calls and the token are not cached.
const CACHE = 'pr-dashboard-v4';
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

// On a cold launch the phone's radio is often still waking up, so a request can hang instead of
// failing. Waiting on it would leave the installed app on its launch screen, so after this long
// we open the cached page instead.
const NAV_TIMEOUT_MS = 3500;

/** Only real, complete pages from this site are worth keeping (no errors, redirects or opaque responses). */
const cacheable = (res) => res.ok && res.type === 'basic' && !res.redirected;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Pages: network first so new versions show up right away, but never wait more than
  // NAV_TIMEOUT_MS when a cached copy exists. A slow network still refreshes the cache afterwards.
  if (req.mode === 'navigate') {
    let saved = Promise.resolve();
    const network = fetch(req).then((res) => {
      if (cacheable(res)) {
        const copy = res.clone();
        saved = caches.open(CACHE).then((c) => c.put('./', copy));
      }
      return res;
    });
    // Keep the worker alive until the network answer is stored, even if the cached page won.
    event.waitUntil(network.then(() => saved).catch(() => undefined));
    event.respondWith(navigationResponse(network));
    return;
  }

  // Built assets have content hashes in their names: safe to serve from cache first.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (cacheable(res)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});

/** Network answer if it comes quickly, else the cached page; with nothing cached, keep waiting. */
async function navigationResponse(network) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, NAV_TIMEOUT_MS, 'timeout'); });
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== 'timeout' && first.ok) return first;
    // Slow or an error page (e.g. 404/5xx): prefer the last good copy.
    const cached = await caches.match('./');
    if (cached) return cached;
    return first === 'timeout' ? await network : first;
  } catch (e) {
    // Offline or the request failed outright.
    const cached = await caches.match('./');
    if (cached) return cached;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
