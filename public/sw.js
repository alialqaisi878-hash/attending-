// خدمة الإشعارات
// كل شركة إلها خدمة منفصلة بنطاق رابطها (/رمز-الشركة/)
const SCOPE = new URL(self.registration.scope).pathname;
const CACHE = 'hudoor-v1:' + SCOPE;
const SHELL = ['./', 'index.html', 'style.css', 'common.js', 'icon.svg', 'manifest.json'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k.endsWith(':' + SCOPE) && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
// الصفحات: من النت أولاً، وإذا ماكو نت من النسخة المحفوظة. الـ API دائماً من النت.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(SCOPE) || url.pathname.includes('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.open(CACHE).then((c) => c.match(e.request, { ignoreSearch: true }).then((r) => r || c.match('index.html')))));
});
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (x) { d = { title: 'الحضور والانصراف', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'الحضور والانصراف', {
    body: d.body || '', icon: SCOPE + 'logo', badge: SCOPE + 'icon.svg', dir: 'rtl', lang: 'ar', data: { url: d.url || SCOPE },
    tag: 'attendance', renotify: true,
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return self.clients.openWindow(e.notification.data.url || SCOPE);
  }));
});
