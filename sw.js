// Maya chat — service worker for Web Push notifications.
// Registered by chat.html. Handles inbound push events (sent server-side by
// api/whatsapp-webhook.js when an agent messages the Maya WhatsApp number)
// and routes notification taps back into the installed app.

// App shell cache — the inbox opens instantly and works offline with the
// last-loaded shell. Network-first so deploys are picked up immediately;
// the cache only serves when the network is down.
const SHELL_CACHE = 'maya-shell-v1';
const SHELL_URLS = ['/chat.html', '/manifest.webmanifest', '/maya-icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('maya-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const isShell = e.request.mode === 'navigate' || SHELL_URLS.includes(url.pathname);
  if (!isShell) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      const cache = await caches.open(SHELL_CACHE);
      cache.put(e.request.mode === 'navigate' ? '/chat.html' : e.request, res.clone());
      return res;
    } catch (_) {
      return (await caches.match(e.request.mode === 'navigate' ? '/chat.html' : e.request)) || Response.error();
    }
  })());
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { title: 'Maya', body: event.data ? event.data.text() : 'New message' }; }

  const title = data.title || 'New message';
  const options = {
    body: data.body || '',
    icon: '/maya-icon.svg',
    badge: '/maya-icon.svg',
    tag: data.tag || ('maya-' + (data.agentId || 'msg')),
    renotify: true,
    data: { url: data.url || '/chat.html', agentId: data.agentId || null, review: !!data.review },
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // Reflect unread on the app icon (iOS sets the home-screen badge from here).
    if (typeof data.badge_count === 'number') {
      try { await self.navigator.setAppBadge(data.badge_count); } catch (_) {}
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const d = event.notification.data || {};
  const isReview = !!d.review;
  const target = d.url || '/chat.html';
  const agentId = d.agentId;
  const url = isReview ? target : (agentId ? `${target}#agent=${agentId}` : target);

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/chat.html') && 'focus' in c) {
        c.postMessage(isReview ? { type: 'open-review' } : { type: 'open-agent', agentId });
        return c.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});
