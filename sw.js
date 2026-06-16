// Maya chat — service worker for Web Push notifications.
// Registered by chat.html. Handles inbound push events (sent server-side by
// api/whatsapp-webhook.js when an agent messages the Maya WhatsApp number)
// and routes notification taps back into the installed app.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

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
    data: { url: data.url || '/chat.html', agentId: data.agentId || null },
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // Reflect unread on the app icon if the count was provided.
    if (typeof data.badge_count === 'number' && self.registration.navigationPreload) {
      try { await self.navigator.setAppBadge?.(data.badge_count); } catch (_) {}
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/chat.html';
  const agentId = event.notification.data && event.notification.data.agentId;
  const url = agentId ? `${target}#agent=${agentId}` : target;

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/chat.html') && 'focus' in c) {
        c.postMessage({ type: 'open-agent', agentId });
        return c.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});
