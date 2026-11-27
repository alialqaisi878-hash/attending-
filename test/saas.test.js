const test = require('node:test');
const assert = require('node:assert');
process.env.DATA_DIR = ':memory:';
const { app, openTenant } = require('../server');
const { loginLimiter, isPrivateIp, assertPublicUrl } = require('../lib/util');

let srv, base, sup;
const call = (method, u, b, t) => fetch(base + u, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (t || '') }, body: b ? JSON.stringify(b) : undefined, redirect: 'manual' });
const post = (u, b, t) => call('POST', u, b, t);
const put = (u, b, t) => call('PUT', u, b, t);
const get = async (u, t) => (await call('GET', u, null, t)).json();
const adminLogin = async (slug, password) => (await (await post(`/${slug}/api/admin/login`, { password })).json()).token;

test.before(async () => {
  srv = app.listen(0); base = `http://localhost:${srv.address().port}`;
  sup = (await (await post('/super/api/login', { password: 'super-secret' })).json()).token;
});
test.after(() => srv.close());
test.beforeEach(() => loginLimiter.reset());

test('super admin creates companies with their own link and admin password', async () => {
  assert.equal((await call('GET', '/super/api/companies')).status, 401);
  for (const bad of [{ slug: 'A B', name: 'x' }, { slug: 'super', name: 'x' }, { slug: 'ok-co', name: '' }, { slug: 'ok-co', name: 'x', admin_password: 'short' }]) {
    assert.equal((await post('/super/api/companies', bad, sup)).status, 400, JSON.stringify(bad));
  }
  const r = await (await post('/super/api/companies', { slug: 'noor', name: 'شركة النور', max_employees: 2, price: 50000, phone: '07700000000' }, sup)).json();
  assert.ok(r.ok); assert.match(r.admin_password, /^[a-z0-9]{10}$/);
  assert.ok(r.expires_at > new Date().toISOString().slice(0, 10)); // free trial by default
  assert.equal((await post('/super/api/companies', { slug: 'noor', name: 'x' }, sup)).status, 400); // duplicate
  const t = await adminLogin('noor', r.admin_password); assert.ok(t);
  const info = await get('/noor/api/info');
  assert.equal(info.company_name, 'شركة النور'); assert.equal(info.subscription, 'active');
  const list = await get('/super/api/companies', sup);
  const row = list.rows.find((c) => c.slug === 'noor');
  assert.equal(row.status, 'active'); assert.equal(row.employees, 0); assert.equal(list.totals.monthly_income, 50000);
  // pages are served under the company link, and /noor redirects to /noor/
  assert.equal((await call('GET', '/noor')).status, 301);
  assert.match(await (await call('GET', '/noor/')).text(), /تسجيل الدخول/);
  assert.match(await (await call('GET', '/noor/admin.html')).text(), /لوحة المدير/);
  const mf = await get('/noor/manifest.json');
  assert.equal(mf.start_url, '/noor/'); assert.equal(mf.scope, '/noor/'); assert.equal(mf.name, 'شركة النور');
  assert.equal((await call('GET', '/nothing-here/')).status, 404);
  assert.equal((await call('GET', '/api/company/noor')).status, 200);
  assert.equal((await call('GET', '/api/company/zzz')).status, 404);
});

test('companies are fully isolated from each other', async () => {
  const a = await (await post('/super/api/companies', { slug: 'iso-a', name: 'A' }, sup)).json();
  const b = await (await post('/super/api/companies', { slug: 'iso-b', name: 'B' }, sup)).json();
  const ta = await adminLogin('iso-a', a.admin_password), tb = await adminLogin('iso-b', b.admin_password);
  assert.ok((await post('/iso-a/api/admin/employees', { username: 'ali', name: 'علي', password: 'pass1234' }, ta)).ok);
  assert.equal((await get('/iso-b/api/admin/employees', tb)).length, 0);
  // a token from one company is useless in another
  assert.equal((await call('GET', '/iso-b/api/admin/employees', null, ta)).status, 401);
  // the same username can exist in both companies
  assert.ok((await post('/iso-b/api/admin/employees', { username: 'ali', name: 'علي ب', password: 'pass1234' }, tb)).ok);
  assert.equal((await adminLogin('iso-b', a.admin_password)), undefined);
  await put('/iso-a/api/admin/settings', { device_lock: false }, ta);
  const et = (await (await post('/iso-a/api/login', { username: 'ali', password: 'pass1234' })).json()).token;
  assert.equal((await call('GET', '/iso-b/api/me', null, et)).status, 401);
  assert.equal((await get('/iso-a/api/me', et)).employee.name, 'علي');
});

test('expired or suspended companies are blocked, renewal brings them back', async () => {
  const r = await (await post('/super/api/companies', { slug: 'exp', name: 'منتهية', expires_at: '2020-01-31' }, sup)).json();
  const res = await post('/exp/api/admin/login', { password: r.admin_password });
  assert.equal(res.status, 403); assert.match((await res.json()).error, /انتهى اشتراك/);
  assert.equal((await get('/exp/api/info')).subscription, 'expired'); // info still works so the page can show the message
  assert.equal((await call('GET', '/exp/')).status, 200);
  const ren = await (await put('/super/api/companies/exp', { extend_months: 1 }, sup)).json();
  assert.ok(ren.expires_at > new Date().toISOString().slice(0, 10));
  assert.ok((await post('/exp/api/admin/login', { password: r.admin_password })).ok);
  // renewing an active subscription adds to its current end date
  assert.equal((await (await put('/super/api/companies/exp', { expires_at: '2030-01-31' }, sup)).json()).ok, true);
  assert.equal((await (await put('/super/api/companies/exp', { extend_months: 1 }, sup)).json()).expires_at, '2030-02-28');
  // suspend
  assert.ok((await put('/super/api/companies/exp', { active: 0 }, sup)).ok);
  const s = await post('/exp/api/admin/login', { password: r.admin_password });
  assert.equal(s.status, 403); assert.match((await s.json()).error, /موقوف/);
  assert.ok((await put('/super/api/companies/exp', { active: 1 }, sup)).ok);
  assert.ok((await post('/exp/api/admin/login', { password: r.admin_password })).ok);
});

test('employee limit per plan', async () => {
  const r = await (await post('/super/api/companies', { slug: 'small', name: 'صغيرة', max_employees: 2 }, sup)).json();
  const t = await adminLogin('small', r.admin_password);
  assert.ok((await post('/small/api/admin/employees', { username: 'e1', name: '1', password: 'pass1234' }, t)).ok);
  assert.ok((await post('/small/api/admin/employees', { username: 'e2', name: '2', password: 'pass1234' }, t)).ok);
  const over = await post('/small/api/admin/employees', { username: 'e3', name: '3', password: 'pass1234' }, t);
  assert.equal(over.status, 400); assert.match((await over.json()).error, /للحد الأقصى/);
  const id = (await get('/small/api/admin/employees', t))[0].id;
  assert.ok((await put('/small/api/admin/employees/' + id, { active: 0 }, t)).ok);
  assert.ok((await post('/small/api/admin/employees', { username: 'e3', name: '3', password: 'pass1234' }, t)).ok);
  assert.equal((await put('/small/api/admin/employees/' + id, { active: 1 }, t)).status, 400); // re-activating goes over the limit
  const w = await get('/small/api/admin/whoami', t);
  assert.equal(w.subscription.max_employees, 2); assert.equal(w.subscription.employees, 2);
});

test('company branding: name, logo, color, currency, timezone', async () => {
  const r = await (await post('/super/api/companies', { slug: 'brand', name: 'براند' }, sup)).json();
  const t = await adminLogin('brand', r.admin_password);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await put('/brand/api/admin/settings', { brand_color: 'red' }, t)).status, 400);
  assert.equal((await put('/brand/api/admin/settings', { timezone: 'Mars/Base' }, t)).status, 400);
  assert.equal((await put('/brand/api/admin/settings', { logo: 'data:text/html;base64,PHNjcmlwdD4=' }, t)).status, 400);
  assert.ok((await put('/brand/api/admin/settings', { company_name: 'براند للتجارة', brand_color: '#aa3300', currency: 'ر.س', timezone: 'Asia/Riyadh', logo: png }, t)).ok);
  const i = await get('/brand/api/info');
  assert.deepEqual([i.company_name, i.brand_color, i.currency, i.timezone, i.has_logo], ['براند للتجارة', '#aa3300', 'ر.س', 'Asia/Riyadh', true]);
  const logo = await call('GET', '/brand/logo');
  assert.equal(logo.headers.get('content-type'), 'image/png'); assert.match(logo.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await get('/brand/manifest.json')).icons[0].src, '/brand/logo');
  const st = await get('/brand/api/admin/settings', t);
  assert.equal(st.admin_hash, undefined); assert.equal(st.logo, undefined);
  // admin changes own password
  assert.equal((await post('/brand/api/admin/password', { old_password: 'x', new_password: 'newpass123' }, t)).status, 400);
  assert.ok((await post('/brand/api/admin/password', { old_password: r.admin_password, new_password: 'newpass123' }, t)).ok);
  assert.ok((await get('/brand/api/admin/whoami', t)).role); // current session kept
  assert.equal((await adminLogin('brand', r.admin_password)), undefined);
  assert.ok(await adminLogin('brand', 'newpass123'));
});

test('support login, password reset and delete from the owner panel', async () => {
  const r = await (await post('/super/api/companies', { slug: 'sup-co', name: 'دعم' }, sup)).json();
  const { url } = await (await post('/super/api/companies/sup-co/support-login', {}, sup)).json();
  const tok = /support=([a-f0-9]+)/.exec(url)[1];
  assert.equal((await get('/sup-co/api/admin/whoami', tok)).role, 'admin');
  const old = await adminLogin('sup-co', r.admin_password);
  const np = (await (await put('/super/api/companies/sup-co', { reset_password: true }, sup)).json()).admin_password;
  assert.ok(np && np !== r.admin_password);
  assert.equal((await call('GET', '/sup-co/api/admin/whoami', null, old)).status, 401);
  assert.ok(await adminLogin('sup-co', np));
  assert.equal((await call('DELETE', '/super/api/companies/sup-co', { confirm: 'sup-co' }, sup)).status, 400); // still active
  await put('/super/api/companies/sup-co', { active: 0 }, sup);
  assert.equal((await call('DELETE', '/super/api/companies/sup-co', { confirm: 'wrong' }, sup)).status, 400);
  assert.ok((await call('DELETE', '/super/api/companies/sup-co', { confirm: 'sup-co' }, sup)).ok);
  assert.equal((await call('GET', '/sup-co/api/info')).status, 404);
  const log = await get('/super/api/log', sup);
  assert.ok(log.some((l) => l.slug === 'sup-co' && /دخول دعم/.test(l.what)));
});

test('login is throttled after many wrong passwords', async () => {
  await post('/super/api/companies', { slug: 'thr', name: 'ث' }, sup);
  for (let i = 0; i < 10; i++) assert.equal((await post('/thr/api/admin/login', { password: 'nope' })).status, 401);
  assert.equal((await post('/thr/api/admin/login', { password: 'nope' })).status, 429);
});

test('owner settings and password', async () => {
  assert.ok((await put('/super/api/settings', { product_name: 'حضوري', support_phone: '07801234567' }, sup)).ok);
  assert.equal((await get('/api/product')).product_name, 'حضوري');
  await post('/super/api/companies', { slug: 'msg', name: 'م', expires_at: '2020-01-01' }, sup);
  assert.match((await get('/msg/api/info')).subscription_message, /07801234567/);
  assert.equal((await put('/super/api/settings', { old_password: 'bad', new_password: 'abcdefghijk' }, sup)).status, 400);
  assert.equal((await put('/super/api/settings', { old_password: 'super-secret', new_password: 'short' }, sup)).status, 400);
});

test('webhooks cannot reach the server or its private network', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.18.0.2', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) assert.ok(isPrivateIp(ip), ip);
  assert.ok(!isPrivateIp('8.8.8.8'));
  await assert.rejects(assertPublicUrl('http://localhost:5678/webhook'));
  await assert.rejects(assertPublicUrl('http://172.18.0.3/'));
});
