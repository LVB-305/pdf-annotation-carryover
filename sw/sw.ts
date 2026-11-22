/// <reference lib="webworker" />
// Service worker: make the app available offline after the first visit.
export {}; // Makes this file a module so `self` can be typed locally.
declare const self: ServiceWorkerGlobalScope;
declare const __BUILD_ID__: string;

const CACHE = `annotation-carryover-${__BUILD_ID__}`;
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');

const PRECACHE = [
  '/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
  '/vendor/pdf.min.js', '/vendor/pdf.worker.min.js',
].map((p) => BASE + p);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(req: Request): Promise<Response> {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

async function networkFirst(req: Request): Promise<Response> {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await caches.match(req)) ?? (req.mode === 'navigate' ? await caches.match(`${BASE}/`) : undefined);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const immutable = url.pathname.startsWith(`${BASE}/_next/static/`) || url.pathname.startsWith(`${BASE}/vendor/`);
  event.respondWith(immutable ? cacheFirst(req) : networkFirst(req));
});
