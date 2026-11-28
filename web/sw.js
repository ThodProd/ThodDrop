'use strict';
const CACHE = 'thoddrop-shell-2.0.10';
const SHELL = ['/', '/style.css', '/common.js', '/phone.js', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('thoddrop-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(url.pathname)) || Response.error()));
});
self.addEventListener('push', event => {
  let data;
  try { data = event.data?.json(); } catch {}
  event.waitUntil(self.registration.showNotification(data?.title || 'Входящие ThodDrop', {
    body:data?.body || 'Откройте ThodDrop, чтобы посмотреть передачу.',
    icon:'/icon-192.png',
    tag:data?.tag,
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    const app = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (app) {
      app.postMessage('open-inbox');
      await app.focus();
    } else {
      await self.clients.openWindow('/?inbox=1');
    }
  })());
});
