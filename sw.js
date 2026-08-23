// PROMISE PRO SCANNER — Service Worker
// Handles incoming Web Push events and notification taps. Does not run any
// trading logic itself — it only displays what the backend already decided.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (err) { data = {}; }

  const title = data.title || '🚨 PROMISE PRO — ENTRY';
  const body = data.body || 'A new entry setup is ready.';
  const url = data.url || '/';

  const options = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.signalId || 'promise-pro-alert',
    renotify: false,
    data: { url, signalId: data.signalId || null, test: !!data.test }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
