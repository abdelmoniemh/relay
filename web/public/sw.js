// Relay service worker: only for reminders. Pushes carry no content; ask the server what's starting.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function secret() {
  try { const r = await (await caches.open('relay-push')).match('/__push_secret'); return r ? await r.text() : ''; } catch { return ''; }
}

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let due = [];
    try { due = await (await fetch(`/api/push/due?k=${encodeURIComponent(await secret())}`, { cache: 'no-store' })).json(); } catch {}
    if (!Array.isArray(due) || !due.length) due = [{ id: 'relay', title: 'Starting soon', channel: 'Relay' }];
    // iOS requires every push to show a notification
    await Promise.all(due.map((r) => self.registration.showNotification(r.title, {
      body: `Starting now on ${String(r.channel).replace(/^([A-Z0-9]{2,4}|4K)\s*[|:]\s*/, '')}`,
      tag: r.id, icon: r.icon || '/apple-touch-icon.png', data: { id: r.id },
    })));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins[0]) return wins[0].focus();
    return self.clients.openWindow('/');
  })());
});
