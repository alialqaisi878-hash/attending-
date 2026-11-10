// أدوات مشتركة للواجهات
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const t5 = (t) => (t ? t.slice(0, 5) : '—');
const hrs = (m) => (m == null ? '—' : `${Math.floor(m / 60)}س ${m % 60}د`);
const money = (n) => Number(n || 0).toLocaleString('en-US') + ' د.ع';
const badge = (s) => `<span class="badge b-${s}">${s}</span>`;
const mapLink = (lat, lng) => (lat != null ? ` <a class="loc" target="_blank" href="https://maps.google.com/?q=${lat},${lng}">📍</a>` : '');
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  del: (k) => { try { localStorage.removeItem(k); } catch (e) {} },
};
function msg(id, text, ok) { const m = $(id); m.textContent = text; m.className = 'msg ' + (ok ? 'ok' : 'err'); }
function makeApi(tokenKey, onUnauthorized) {
  return async (url, opts = {}) => {
    const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + store.get(tokenKey) } });
    if (r.status === 401 && !url.endsWith('/login')) { onUnauthorized(); throw new Error('سجّل دخول من جديد'); }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'خطأ');
    return d;
  };
}
function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve({}), { timeout: 10000, enableHighAccuracy: true, maximumAge: 0 });
  });
}
