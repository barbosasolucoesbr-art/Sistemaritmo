'use strict';
const CACHE = 'ritmo-shell-v2-20261116-4';
const ROOT = new URL('./', self.location.href);
const FILES = ['./','./index.html','./styles.css','./app.js','./data.js','./supabase.js','./manifest.webmanifest','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];
const ASSETS = new Set(FILES.map(f => new URL(f, ROOT).pathname));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(f => new Request(new URL(f, ROOT), {cache:'reload'})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('ritmo-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if(request.method !== 'GET' || url.origin !== ROOT.origin || !ASSETS.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(url.pathname);
    return cached || fetch(request);
  })());
});
