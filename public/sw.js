// خدمة الإشعارات
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (x) { d = { title: 'الحضور والانصراف', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'الحضور والانصراف', {
    body: d.body || '', icon: '/icon.svg', badge: '/icon.svg', dir: 'rtl', lang: 'ar', data: { url: d.url || '/' },
    tag: 'attendance', renotify: true,
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return self.clients.openWindow(e.notification.data.url || '/');
  }));
});
