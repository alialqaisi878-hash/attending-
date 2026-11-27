// أدوات مشتركة للواجهات
// كل شركة إلها رابط: /رمز-الشركة/ ، والبيانات المحفوظة بالمتصفح منفصلة لكل شركة
const SLUG = location.pathname.split('/')[1] || '';
let APP_TZ = 'Asia/Baghdad', CUR = 'د.ع';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const t5 = (t) => (t ? t.slice(0, 5) : '—');
const hrs = (m) => (m == null ? '—' : `${Math.floor(m / 60)}س ${m % 60}د`);
const money = (n) => Number(n || 0).toLocaleString('en-US') + ' ' + CUR;
const badge = (s) => `<span class="badge b-${s}">${s}</span>`;
const mapLink = (lat, lng) => (lat != null ? ` <a class="loc" target="_blank" href="https://maps.google.com/?q=${lat},${lng}">📍</a>` : '');
const skey = (k) => (k === 'device_id' ? k : SLUG + ':' + k);
const store = {
  get: (k) => { try { return localStorage.getItem(skey(k)) || ''; } catch (e) { return ''; } },
  set: (k, v) => { try { localStorage.setItem(skey(k), v); } catch (e) {} },
  del: (k) => { try { localStorage.removeItem(skey(k)); } catch (e) {} },
};
function msg(id, text, ok) { const m = $(id); m.textContent = text; m.className = 'msg ' + (ok ? 'ok' : 'err'); }
// رقم ثابت لهذا الجهاز (المتصفح) حتى نربط كل موظف بتلفونه
function deviceId() {
  let d = store.get('device_id');
  if (!d) {
    d = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
    store.set('device_id', d);
  }
  return d;
}
function makeApi(tokenKey, onUnauthorized) {
  return async (url, opts = {}) => {
    const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + store.get(tokenKey), 'X-Device-Id': deviceId() } });
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

// اسم الشركة وشعارها ولونها وعملتها، وحالة الاشتراك
function applyInfo(i) {
  if (!i) return;
  APP_TZ = i.timezone || APP_TZ; CUR = i.currency || CUR;
  if (i.brand_color) {
    document.documentElement.style.setProperty('--primary', i.brand_color);
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = i.brand_color;
  }
  document.querySelectorAll('.company-name').forEach((el) => { el.textContent = i.company_name; });
  document.querySelectorAll('.company-logo').forEach((el) => {
    if (i.has_logo) { el.src = 'logo'; el.classList.remove('hidden'); } else el.classList.add('hidden');
  });
  const bar = document.getElementById('subBar');
  if (bar) { bar.textContent = i.subscription_message || ''; bar.classList.toggle('hidden', !i.subscription_message); }
}
async function loadInfo() {
  let i = null;
  try { i = await (await fetch('api/info')).json(); store.set('info', JSON.stringify(i)); }
  catch (e) { try { i = JSON.parse(store.get('info') || 'null'); } catch (x) {} }
  applyInfo(i);
  return i || {};
}
