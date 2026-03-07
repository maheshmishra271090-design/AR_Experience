// ── ExpRE Service Worker ──────────────────────────────────────────────────────
// Caching strategies:
//   HTML / manifest  → Network First, cache fallback   (always fresh when online)
//   Campaign API     → Network First, cache fallback   (always fresh when online)
//   AR libraries     → Cache First                     (large, versioned CDN files)
//   Videos / camera  → Network Only                    (never cache)

const CACHE_VERSION = 'expre-v2';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const API_CACHE     = `${CACHE_VERSION}-api`;
const LIB_CACHE     = `${CACHE_VERSION}-libs`;

const SHELL_FILES = [
    './index.html',
    './manifest.json',
    './offline.html'
];

const LIB_URLS = [
    'https://aframe.io/releases/1.6.0/aframe.min.js',
    'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-aframe.prod.js'
];

const API_ORIGIN = 'https://akm-img-a-in.tosshub.com';

// ── Install ───────────────────────────────────────────────────────────────────
// Cache each shell file individually so one 404 doesn't break the others.
// Libraries are best-effort — don't block install if CDN is slow.
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const shellCache = await caches.open(SHELL_CACHE);

        // Cache shell files one by one — ignore individual failures
        await Promise.allSettled(
            SHELL_FILES.map(url =>
                fetch(url, { cache: 'reload' })
                    .then(res => { if (res.ok) shellCache.put(url, res); })
                    .catch(err => console.warn('[SW] Could not cache', url, err))
            )
        );

        // Cache AR libraries in background (don't block install)
        caches.open(LIB_CACHE).then(libCache =>
            Promise.allSettled(LIB_URLS.map(url => libCache.add(url)))
        );

        await self.skipWaiting();
    })());
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const valid = [SHELL_CACHE, API_CACHE, LIB_CACHE];
        const keys  = await caches.keys();
        await Promise.all(
            keys.filter(k => !valid.includes(k)).map(k => caches.delete(k))
        );
        await self.clients.claim();
    })());
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // 1. AR libraries → Cache First (huge files, versioned URLs, never change)
    if (LIB_URLS.some(u => request.url.startsWith(u))) {
        event.respondWith(cacheFirst(request, LIB_CACHE));
        return;
    }

    // 2. Campaign API → Network First with cache fallback
    if (url.origin === API_ORIGIN) {
        event.respondWith(networkFirst(request, API_CACHE));
        return;
    }

    // 3. HTML navigation + manifest → Network First with offline fallback
    //    Catches: /, /index.html, /ar-experience.html, any same-origin HTML
    if (request.mode === 'navigate' ||
        url.pathname.endsWith('.html') ||
        url.pathname.endsWith('manifest.json')) {
        event.respondWith(networkFirstWithOfflineFallback(request));
        return;
    }

    // 4. Everything else (video, camera, images) → Network Only, no interception
});

// ── Strategy: Network First, cache fallback ───────────────────────────────────
async function networkFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
    } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        // Return empty JSON array as last resort for API calls
        return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }
}

// ── Strategy: Network First, offline.html fallback for navigation ─────────────
async function networkFirstWithOfflineFallback(request) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
    } catch {
        // Try to serve from cache first
        const cached = await cache.match(request)
                    || await cache.match('./index.html')
                    || await cache.match('./ar-experience.html');
        if (cached) return cached;
        // True offline fallback
        const offline = await cache.match('./offline.html');
        return offline || new Response('<h1>Offline</h1>', {
            headers: { 'Content-Type': 'text/html' }
        });
    }
}

// ── Strategy: Cache First, network fallback ───────────────────────────────────
async function cacheFirst(request, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
    } catch {
        return new Response('Network error', { status: 503 });
    }
}
