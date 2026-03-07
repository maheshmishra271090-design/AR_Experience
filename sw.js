// ── ExpRE Service Worker ──────────────────────────────────────────────────────
// Strategy:
//   • Shell assets (HTML, manifest, offline page) → Cache First
//     Cached on install, served instantly from cache, network never touched.
//
//   • Campaign API (JSON) → Network First with cache fallback
//     Always tries network so campaign data stays fresh.
//     Falls back to last cached version if offline.
//
//   • AR libraries (A-Frame, MindAR) → Cache First
//     Large files that never change for a given URL (versioned CDN).
//     Cached on first load, served from cache every subsequent visit.
//
//   • Everything else → Network Only
//     Camera feed, target images, videos — never cache these.

const CACHE_VERSION   = 'expre-v1';
const SHELL_CACHE     = `${CACHE_VERSION}-shell`;
const API_CACHE       = `${CACHE_VERSION}-api`;
const LIBRARY_CACHE   = `${CACHE_VERSION}-libs`;

// Files cached immediately on install (app shell)
const SHELL_ASSETS = [
    './ar-experience.html',
    './manifest.json',
    './offline.html'
];

// CDN libraries — large, versioned, never change
const LIBRARY_URLS = [
    'https://aframe.io/releases/1.6.0/aframe.min.js',
    'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-aframe.prod.js'
];

// Campaign API URL
const API_URL = 'https://akm-img-a-in.tosshub.com/app/at-app/at_dev/newicons/AR_expierence.json';

// ── Install: pre-cache shell assets ──────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        Promise.all([
            // Cache shell
            caches.open(SHELL_CACHE).then(cache =>
                cache.addAll(SHELL_ASSETS).catch(err =>
                    console.warn('[SW] Shell cache partial failure:', err)
                )
            ),
            // Cache libraries (best-effort — don't block install if CDN is slow)
            caches.open(LIBRARY_CACHE).then(cache =>
                Promise.allSettled(
                    LIBRARY_URLS.map(url => cache.add(url))
                )
            )
        ]).then(() => self.skipWaiting()) // activate immediately, don't wait for old SW to die
    );
});

// ── Activate: clean up old caches from previous versions ─────────────────────
self.addEventListener('activate', event => {
    const validCaches = [SHELL_CACHE, API_CACHE, LIBRARY_CACHE];
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => !validCaches.includes(key))
                    .map(key => {
                        console.log('[SW] Deleting old cache:', key);
                        return caches.delete(key);
                    })
            ))
            .then(() => self.clients.claim()) // take control of all open tabs immediately
    );
});

// ── Fetch: route requests to the right strategy ──────────────────────────────
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // Only handle GET requests
    if (request.method !== 'GET') return;

    // ── Strategy 1: Campaign API → Network First, cache fallback ──────────────
    if (request.url.startsWith(API_URL)) {
        event.respondWith(networkFirstWithCache(request, API_CACHE));
        return;
    }

    // ── Strategy 2: AR libraries → Cache First (versioned CDN URLs) ───────────
    if (LIBRARY_URLS.some(u => request.url.startsWith(u.split('?')[0]))) {
        event.respondWith(cacheFirstWithNetwork(request, LIBRARY_CACHE));
        return;
    }

    // ── Strategy 3: App shell (HTML + manifest) → Cache First ─────────────────
    if (
        url.pathname.endsWith('ar-experience.html') ||
        url.pathname.endsWith('manifest.json') ||
        url.pathname.endsWith('offline.html') ||
        url.pathname === '/' ||
        url.pathname === '/index.html'
    ) {
        event.respondWith(cacheFirstWithOfflineFallback(request, SHELL_CACHE));
        return;
    }

    // ── Strategy 4: Everything else (videos, images, camera) → Network Only ───
    // Don't intercept — let browser handle naturally
});

// ── Strategy helpers ──────────────────────────────────────────────────────────

// Network first: try network, store response in cache, fall back to cache
async function networkFirstWithCache(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            cache.put(request, networkResponse.clone()); // update cache in background
        }
        return networkResponse;
    } catch {
        const cached = await cache.match(request);
        return cached || new Response(JSON.stringify([]), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// Cache first: serve from cache if available, else fetch and cache
async function cacheFirstWithNetwork(request, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) cache.put(request, networkResponse.clone());
        return networkResponse;
    } catch {
        return new Response('Network error', { status: 503 });
    }
}

// Cache first with offline.html fallback for navigation requests
async function cacheFirstWithOfflineFallback(request, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) cache.put(request, networkResponse.clone());
        return networkResponse;
    } catch {
        // Return offline page for navigation failures
        const offline = await cache.match('./offline.html');
        return offline || new Response('<h1>You are offline</h1>', {
            headers: { 'Content-Type': 'text/html' }
        });
    }
}
