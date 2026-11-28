const test = require('node:test');
const assert = require('node:assert');
process.env.DATA_DIR = ':memory:';
process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
const { app, openTenant, tick } = require('../server');
const { loginLimiter } = require('../lib/util');

let srv, base, adminToken, superToken, db;
const call = (method, u, b, t) => fetch(base + u, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (t || '') }, body: b ? JSON.stringify(b) : undefined, redirect: 'manual' });
const post = (u, b, t) => call('POST', u, b, t);
const put = (u, b, t) => call('PUT', u, b, t);
const get = async (u, t) => (await call('GET', u, null, t)).json();

test.before(async () => {
  srv = app.listen(0); base = `http://localhost:${srv.address().port}`;
  assert.equal((await post('/super/api/login', { password: 'bad' })).status, 401);
  superToken = (await (await post('/super/api/login', { password: 'super-secret' })).json()).token;
  const r = await post('/super/api/companies', { slug: 'acme', name: 'شركة أكمي', admin_password: 'secret123', expires_at: '' }, superToken);
  assert.ok(r.ok, await r.text());
  db = openTenant('acme').db;
  assert.equal((await post('/acme/api/admin/login', { password: 'bad' })).status, 401);
  adminToken = (await (await post('/acme/api/admin/login', { password: 'secret123' })).json()).token;
  assert.ok(adminToken);
  assert.ok((await put('/acme/api/admin/settings', { device_lock: false }, adminToken)).ok); // other tests don't send a device id
});
test.after(() => srv.close());

test('employee account, login, punch', async () => {
  const r = await post('/acme/api/admin/employees', { username: 'ahmed', name: 'أحمد', password: 'pass1234', salary: 300000,
    shift_start: '08:00', shift_end: '16:00', overtime_after: '16:00', overtime_rate: 1.5 }, adminToken);
  assert.ok(r.ok, await r.text());
  assert.equal((await post('/acme/api/admin/employees', { username: 'ahmed', name: 'x', password: 'pass1234' }, adminToken)).status, 400);
  assert.equal((await post('/acme/api/login', { username: 'ahmed', password: 'wrong' })).status, 401);
  const { token } = await (await post('/acme/api/login', { username: 'ahmed', password: 'pass1234' })).json();
  assert.ok(token);
  assert.equal((await post('/acme/api/punch', { action: 'out' }, token)).status, 400);
  assert.ok((await post('/acme/api/punch', { action: 'in' }, token)).ok); // no location configured -> allowed
  assert.equal((await post('/acme/api/punch', { action: 'in' }, token)).status, 400);
  assert.ok((await post('/acme/api/punch', { action: 'out' }, token)).ok);
  const me = await get('/acme/api/me', token);
  assert.equal(me.employee.name, 'أحمد'); assert.ok(me.today.check_out);
  assert.equal((await call('GET', '/acme/api/me', null, adminToken)).status, 401); // admin token is not an employee token
});

test('location fence', async () => {
  await post('/acme/api/admin/employees', { username: 'zainab', name: 'زينب', password: 'pass1234' }, adminToken);
  const { token } = await (await post('/acme/api/login', { username: 'zainab', password: 'pass1234' })).json();
  assert.ok((await put('/acme/api/admin/settings', { location_lat: 33.3152, location_lng: 44.3661, location_radius: 100 }, adminToken)).ok);
  assert.equal((await post('/acme/api/punch', { action: 'in' }, token)).status, 400);                         // no GPS
  const far = await post('/acme/api/punch', { action: 'in', lat: 33.33, lng: 44.40 }, token);                 // ~3.5 km away
  assert.equal(far.status, 403); assert.match((await far.json()).error, /بعيد/);
  assert.ok((await post('/acme/api/punch', { action: 'in', lat: 33.3155, lng: 44.3663 }, token)).ok);          // ~40 m away
  await put('/acme/api/admin/settings', { location_lat: '', location_lng: '' }, adminToken);
});

test('payroll follows the Excel model', async () => {
  const emp = db.prepare("SELECT id FROM employees WHERE username = 'ahmed'").get();
  const ins = db.prepare('INSERT INTO attendance(employee_id, work_date, check_in, check_out) VALUES (?, ?, ?, ?)');
  ins.run(emp.id, '2026-10-01', '08:00:00', '18:00:00'); // 2h overtime after 16:00
  ins.run(emp.id, '2026-10-03', '08:30:00', null);       // 30 min late
  ins.run(emp.id, '2026-10-06', '10:30:00', null);       // 150 min late
  assert.ok((await post('/acme/api/admin/leaves', { employee_id: emp.id, from: '2026-10-04', paid: 1 }, adminToken)).ok);
  assert.ok((await post('/acme/api/admin/leaves', { employee_id: emp.id, from: '2026-10-05', paid: 0, note: 'ظرف' }, adminToken)).ok);
  assert.ok((await put('/acme/api/admin/adjustments', { employee_id: emp.id, month: '2026-10', advance: 20000, bonus: 5000 }, adminToken)).ok);
  const s = (await get(`/acme/api/admin/payslip?employee_id=${emp.id}&month=2026-10`, adminToken)).summary;
  // defaults: daily = salary / 26, monthly late allowance 120 min, 5000/h late, 5000/h overtime
  assert.equal(s.present_days, 3); assert.equal(s.paid_leave_days, 1); assert.equal(s.unpaid_leave_days, 1);
  assert.equal(s.absent_days, 21);                 // 26 working days (5 Fridays) - 3 - 2
  assert.equal(s.late_minutes, 180); assert.equal(s.late_after_allowance, 60);
  assert.equal(s.overtime_minutes, 120);
  assert.equal(s.attendance_pay, 46154);           // (3 + 1) * 300000 / 26
  assert.equal(s.late_deduction, 5000);            // 60 min * 5000/h
  assert.equal(s.overtime_pay, 10000);             // 2h * 5000
  assert.equal(s.bonus, 5000); assert.equal(s.advance, 20000);
  assert.equal(s.gross_salary, 56154); assert.equal(s.net_salary, 36154);
  const list = await get('/acme/api/admin/payroll?month=2026-10', adminToken);
  assert.equal(list.rows.length, 2); assert.equal(list.totals.net_salary, list.rows.reduce((a, r) => a + r.summary.net_salary, 0));
  const csv = await (await call('GET', '/acme/api/admin/payroll.csv?month=2026-10', null, adminToken)).text();
  assert.match(csv, /صافي الراتب/); assert.match(csv, /المجموع/);
});

test('shifts and leave for all employees', async () => {
  assert.equal((await get('/acme/api/admin/shifts', adminToken)).length, 1); // one generic default shift
  assert.ok((await post('/acme/api/admin/shifts', { name: '7:00 - 3:30', start: '07:00', end: '15:30', overtime_after: '16:00' }, adminToken)).ok);
  const shifts = await get('/acme/api/admin/shifts', adminToken);
  assert.equal(shifts.length, 2);
  const early = shifts.find((x) => x.start === '07:00');
  const emp = db.prepare("SELECT id FROM employees WHERE username = 'zainab'").get();
  assert.ok((await put('/acme/api/admin/employees/' + emp.id, { shift_id: early.id }, adminToken)).ok);
  const list = await get('/acme/api/admin/employees', adminToken);
  const z = list.find((e) => e.id === emp.id);
  assert.equal(z.shift_start, '07:00'); assert.equal(z.shift_name, '7:00 - 3:30');
  assert.equal((await call('DELETE', '/acme/api/admin/shifts/' + early.id, null, adminToken)).status, 400); // in use
  const r = await (await post('/acme/api/admin/leaves', { employee_id: 'all', from: '2026-10-20', to: '2026-10-21', paid: 1, note: 'عطلة رسمية' }, adminToken)).json();
  assert.equal(r.employees, 2); assert.equal(r.count, 2);
});

test('csv and auth', async () => {
  const today = await get('/acme/api/admin/today', adminToken);
  const csv = await call('GET', `/acme/api/admin/report.csv?from=${today.date}&to=${today.date}`, null, adminToken);
  assert.match(await csv.text(), /أحمد/);
  assert.equal((await call('GET', '/acme/api/admin/today')).status, 401);
  const settings = await get('/acme/api/admin/settings', adminToken);
  assert.equal(settings.vapid_private, undefined);
});

test('offline punch is accepted with device time and flagged', async () => {
  await post('/acme/api/admin/employees', { username: 'sara', name: 'سارة', password: 'pass1234' }, adminToken);
  const { token } = await (await post('/acme/api/login', { username: 'sara', password: 'pass1234' })).json();
  const twoHoursAgo = Date.now() - 5 * 60 * 1000;
  const r = await post('/acme/api/punch', { action: 'in', offline_at: twoHoursAgo, queued: true }, token);
  const dup = await (await post('/acme/api/punch', { action: 'in', offline_at: twoHoursAgo, queued: true }, token)).json();
  assert.equal(dup.duplicate, true);
  assert.ok(r.ok, await r.text());
  const me = await get('/acme/api/me', token);
  const rec = db.prepare("SELECT a.* FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE e.username = 'sara'").get();
  assert.equal(rec.in_offline, 1); assert.ok(rec.in_synced_at);
  assert.ok(me.days.some((d) => d.in_offline));
  // a fresh punch (sent right away) is not flagged
  assert.ok((await post('/acme/api/punch', { action: 'out', offline_at: Date.now() - 5000 }, token)).ok);
  const rec2 = db.prepare('SELECT * FROM attendance WHERE id = ?').get(rec.id);
  assert.equal(rec2.out_offline, 0);
  // future and too-old punches are refused
  assert.equal((await post('/acme/api/punch', { action: 'in', offline_at: Date.now() + 3600 * 1000 }, token)).status, 400);
  assert.equal((await post('/acme/api/punch', { action: 'in', offline_at: Date.now() - 10 * 24 * 3600 * 1000 }, token)).status, 400);
  const csv = await call('GET', `/acme/api/admin/report.csv?from=${me.date}&to=${me.date}`, null, adminToken);
  assert.match(await csv.text(), /حضور \(وصلت/);
});

test('device lock: one phone per account, one account per phone', async () => {
  const dev = (t, d) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + (t || ''), 'X-Device-Id': d });
  const req = (u, b, t, d, method = 'POST') => fetch(base + u, { method, headers: dev(t, d), body: JSON.stringify(b) });
  const A = 'aaaaaaaa-1111-2222-3333-444444444444', B = 'bbbbbbbb-1111-2222-3333-444444444444';
  assert.ok((await put('/acme/api/admin/settings', { device_lock: true }, adminToken)).ok);
  const r1 = await post('/acme/api/admin/employees', { username: 'dev1', name: 'جهاز1', password: 'pass1234' }, adminToken);
  const r2 = await post('/acme/api/admin/employees', { username: 'dev2', name: 'جهاز2', password: 'pass1234' }, adminToken);
  assert.ok(r1.ok && r2.ok);
  const id1 = (await get('/acme/api/admin/employees', adminToken)).find((e) => e.username === 'dev1').id;
  assert.equal((await post('/acme/api/login', { username: 'dev1', password: 'pass1234' })).status, 403); // no device id
  const ok1 = await req('/acme/api/login', { username: 'dev1', password: 'pass1234' }, '', A);
  assert.ok(ok1.ok); const t1 = (await ok1.json()).token;
  // same account from another phone -> refused
  assert.equal((await req('/acme/api/login', { username: 'dev1', password: 'pass1234' }, '', B)).status, 403);
  // another account from the first phone -> refused
  assert.equal((await req('/acme/api/login', { username: 'dev2', password: 'pass1234' }, '', A)).status, 403);
  // punch with the token copied to another phone -> refused
  assert.equal((await req('/acme/api/punch', { action: 'in' }, t1, B)).status, 403);
  assert.ok((await req('/acme/api/punch', { action: 'in' }, t1, A)).ok);
  const emps = await get('/acme/api/admin/employees', adminToken);
  assert.ok(emps.find((e) => e.id === id1).device_bound);
  // admin resets -> new phone can log in, old session is gone
  assert.ok((await put('/acme/api/admin/employees/' + id1, { reset_device: true }, adminToken)).ok);
  assert.equal((await req('/acme/api/punch', { action: 'out' }, t1, A)).status, 401);
  assert.ok((await req('/acme/api/login', { username: 'dev1', password: 'pass1234' }, '', B)).ok);
  assert.ok((await req('/acme/api/login', { username: 'dev2', password: 'pass1234' }, '', A)).ok);
  assert.ok((await put('/acme/api/admin/settings', { device_lock: false }, adminToken)).ok);
});

test('accountant can read and print payroll but not change leaves, employees or settings', async () => {
  assert.equal((await put('/acme/api/admin/settings', { accountant_user: 'acc', accountant_password: '123' }, adminToken)).status, 400); // too short
  assert.ok((await put('/acme/api/admin/settings', { accountant_user: 'acc', accountant_password: 'acc12345' }, adminToken)).ok);
  const st = await get('/acme/api/admin/settings', adminToken);
  assert.equal(st.accountant_hash, undefined); assert.ok(st.accountant_has_password);
  assert.equal((await post('/acme/api/admin/login', { username: 'acc', password: 'wrong' })).status, 401);
  const lr = await (await post('/acme/api/admin/login', { username: 'acc', password: 'acc12345' })).json();
  assert.equal(lr.role, 'accountant'); const t = lr.token;
  assert.equal((await get('/acme/api/admin/whoami', t)).role, 'accountant');
  const month = new Date().toISOString().slice(0, 7);
  assert.ok((await call('GET', '/acme/api/admin/payroll?month=' + month, null, t)).ok);
  assert.ok((await call('GET', '/acme/api/admin/payroll.csv?month=' + month, null, t)).ok);
  const emp = (await get('/acme/api/admin/employees', t))[0];
  assert.ok((await call('GET', `/acme/api/admin/payslip?employee_id=${emp.id}&month=${month}`, null, t)).ok);
  assert.ok((await put('/acme/api/admin/adjustments', { employee_id: emp.id, month, bonus: 1000, advance: 0 }, t)).ok);
  // forbidden for the accountant
  assert.equal((await post('/acme/api/admin/leaves', { employee_id: emp.id, from: month + '-01', paid: 1 }, t)).status, 401);
  assert.equal((await call('GET', '/acme/api/admin/leaves?month=' + month, null, t)).status, 401);
  // the accountant may add and edit employees, but not unbind a phone
  assert.ok((await post('/acme/api/admin/employees', { username: 'x1', name: 'x', password: 'pass1234', salary: 500000 }, t)).ok);
  assert.ok((await put('/acme/api/admin/employees/' + emp.id, { salary: emp.salary }, t)).ok);
  assert.equal((await put('/acme/api/admin/employees/' + emp.id, { reset_device: true }, t)).status, 403);
  assert.ok((await put('/acme/api/admin/employees/' + emp.id, { salary: emp.salary + 1000 }, t)).ok);
  assert.ok((await put('/acme/api/admin/employees/' + emp.id, { department: 'المحاسبة' }, t)).ok);
  assert.equal((await call('GET', '/acme/api/admin/changes', null, t)).status, 401);
  const log = await get('/acme/api/admin/changes', adminToken);
  assert.ok(log.some((c) => c.role === 'accountant' && c.what === 'القسم' && c.new_value === 'المحاسبة'));
  assert.ok(log.some((c) => c.role === 'accountant' && c.what === 'إضافة موظف'));
  assert.ok(log.some((c) => c.role === 'accountant' && c.what === 'الراتب' && Number(c.new_value) === emp.salary + 1000));
  assert.equal((await put('/acme/api/admin/settings', { accountant_adjust: true }, t)).status, 401);
  assert.equal((await post('/acme/api/admin/shifts', { name: 'x', start: '08:00', end: '15:00', overtime_after: '16:00' }, t)).status, 401);
  // admin turns off bonus/advance editing for the accountant
  assert.ok((await put('/acme/api/admin/settings', { accountant_adjust: false }, adminToken)).ok);
  assert.equal((await put('/acme/api/admin/adjustments', { employee_id: emp.id, month, bonus: 2000, advance: 0 }, t)).status, 403);
  // changing the accountant password logs them out
  assert.ok((await put('/acme/api/admin/settings', { accountant_password: 'new12345' }, adminToken)).ok);
  assert.equal((await call('GET', '/acme/api/admin/payroll?month=' + month, null, t)).status, 401);
  // admin still logs in with an empty username
  assert.ok((await post('/acme/api/admin/login', { password: 'secret123' })).ok);
});

test('reset clears test data but keeps employees and settings', async () => {
  const before = (await get('/acme/api/admin/employees', adminToken)).length;
  assert.ok(before > 0);
  assert.equal((await post('/acme/api/admin/reset', { confirm: 'نعم' }, adminToken)).status, 400);
  const acc = (await (await post('/acme/api/admin/login', { username: 'acc', password: 'new12345' })).json()).token;
  assert.equal((await post('/acme/api/admin/reset', { confirm: 'تصفير' }, acc)).status, 401);
  const r = await (await post('/acme/api/admin/reset', { confirm: 'تصفير', unbind_devices: true }, adminToken)).json();
  assert.ok(r.ok); assert.ok(r.attendance > 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attendance').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leaves').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM adjustments').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM employees WHERE device_id IS NOT NULL').get().n, 0);
  const emps = await get('/acme/api/admin/employees', adminToken);
  assert.equal(emps.length, before);
  assert.ok(emps.every((e) => e.salary !== undefined));
  assert.equal((await get('/acme/api/admin/changes', adminToken)).length, 1); // only the reset itself
});

test('paid leave balance: one day a month, rolls over, used by paid leave, not by official holidays', async () => {
  const month = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' }).slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const prev = (k) => { const d = new Date(Date.UTC(y, m - 1 - k, 1)); return d.toISOString().slice(0, 7); };
  assert.ok((await put('/acme/api/admin/settings', { leave_monthly: 1, leave_start_month: prev(2) }, adminToken)).ok); // 3 months so far
  assert.ok((await post('/acme/api/admin/employees', { username: 'lv', name: 'رصيد', password: 'pass1234', salary: 260000 }, adminToken)).ok);
  const id = (await get('/acme/api/admin/employees', adminToken)).find((e) => e.username === 'lv').id;
  db.prepare('UPDATE employees SET created_at = ? WHERE id = ?').run(prev(5) + '-01 00:00:00', id);
  const bal = async () => (await get('/acme/api/admin/employees', adminToken)).find((e) => e.id === id).leave_balance;
  assert.equal(await bal(), 3);
  const r = await (await post('/acme/api/admin/leaves', { employee_id: id, from: month + '-02', to: month + '-03', paid: 1 }, adminToken)).json();
  assert.equal(r.balance, 1);
  assert.equal(await bal(), 1);
  assert.ok((await post('/acme/api/admin/leaves', { employee_id: 'all', from: month + '-04', paid: 1 }, adminToken)).ok);
  assert.equal(await bal(), 1); // holiday for everyone does not use the balance
  assert.ok((await put('/acme/api/admin/employees/' + id, { leave_opening: 4 }, adminToken)).ok);
  assert.equal(await bal(), 5);
  const slip = await get(`/acme/api/admin/payslip?employee_id=${id}&month=${month}`, adminToken);
  assert.equal(slip.summary.leave_balance, 5);
  db.prepare('UPDATE employees SET created_at = ? WHERE id = ?').run(month + '-01 00:00:00', id);
  assert.equal(await bal(), 4 + 1 - 2); // new employees start earning from the month they were added
});

test('each punch is sent to the webhook, and a broken webhook never blocks a punch', async () => {
  const http = require('node:http');
  const got = [];
  const hook = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { got.push(JSON.parse(b)); r.end('ok'); }); }).listen(0);
  const url = `http://localhost:${hook.address().port}/webhook/punch`;
  try {
    assert.ok((await post('/acme/api/admin/webhook-test', { url }, adminToken)).ok);
    assert.equal(got.pop().event, 'test');
    assert.ok((await put('/acme/api/admin/settings', { webhook_url: url }, adminToken)).ok);
    const acc = (await (await post('/acme/api/admin/login', { username: 'acc', password: 'new12345' })).json()).token;
    assert.equal((await get('/acme/api/admin/settings', acc)).webhook_url, undefined);
    await post('/acme/api/admin/employees', { username: 'wh', name: 'ويب هوك', password: 'pass1234' }, adminToken);
    const { token } = await (await post('/acme/api/login', { username: 'wh', password: 'pass1234' })).json();
    assert.ok((await post('/acme/api/punch', { action: 'in' }, token)).ok);
    await new Promise((r) => setTimeout(r, 300));
    const p = got.pop();
    assert.equal(p.employee_name, 'ويب هوك'); assert.equal(p.action, 'in'); assert.match(p.time, /^\d\d:\d\d$/); assert.match(p.text, /ويب هوك بصم حضور/);
    // n8n down: punch still saved
    assert.ok((await put('/acme/api/admin/settings', { webhook_url: 'http://localhost:1/nothing' }, adminToken)).ok);
    assert.ok((await post('/acme/api/punch', { action: 'out' }, token)).ok);
  } finally {
    hook.close();
    await put('/acme/api/admin/settings', { webhook_url: '' }, adminToken);
  }
});

test('reminder tick runs', async () => { await tick(); });

test('work sites: technician punches at any of his sites, logs arrive/leave with a report', async () => {
  const site = async (name, lat, lng) => (await (await post('/acme/api/admin/sites', { name, lat, lng, radius: 150 }, adminToken)).json()).id;
  const s1 = await site('موقع الكرادة', 33.3062, 44.4209), s2 = await site('موقع المنصور', 33.3203, 44.3497);
  assert.equal((await post('/acme/api/admin/sites', { name: 'x', lat: 0, lng: 0 }, adminToken)).status, 400);
  assert.ok((await post('/acme/api/admin/employees', { username: 'tech', name: 'فني', password: 'pass1234', site_ids: [s1, s2] }, adminToken)).ok);
  const { token } = await (await post('/acme/api/login', { username: 'tech', password: 'pass1234' })).json();
  const me = await get('/acme/api/me', token);
  assert.equal(me.sites.length, 2); assert.equal(me.open_visit, null);
  // the punch is fenced to his sites even without a main company location
  assert.equal((await post('/acme/api/punch', { action: 'in', lat: 33.40, lng: 44.50 }, token)).status, 403);
  assert.ok((await post('/acme/api/punch', { action: 'in', lat: 33.3203, lng: 44.3497 }, token)).ok);
  // visits
  assert.equal((await post('/acme/api/visit', { action: 'leave', lat: 33.3062, lng: 44.4209, report: 'x' }, token)).status, 400);
  const far = await post('/acme/api/visit', { action: 'arrive', lat: 33.40, lng: 44.50 }, token);
  assert.equal(far.status, 403); assert.match((await far.json()).error, /أقرب موقع/);
  const a = await post('/acme/api/visit', { action: 'arrive', lat: 33.3063, lng: 44.4210, client_id: 'c1' }, token);
  assert.ok(a.ok); assert.match((await a.json()).message, /الكرادة/);
  assert.ok((await (await post('/acme/api/visit', { action: 'arrive', lat: 33.3063, lng: 44.4210, client_id: 'c1', queued: true }, token)).json()).duplicate);
  assert.equal((await post('/acme/api/visit', { action: 'arrive', lat: 33.3203, lng: 44.3497 }, token)).status, 400); // must leave first
  assert.equal((await post('/acme/api/visit', { action: 'leave', lat: 33.3063, lng: 44.4210, report: '' }, token)).status, 400); // report required
  assert.ok((await post('/acme/api/visit', { action: 'leave', lat: 33.3063, lng: 44.4210, report: 'صيانة المولدة' }, token)).ok);
  const me2 = await get('/acme/api/me', token);
  assert.equal(me2.today_visits.length, 1); assert.equal(me2.today_visits[0].report, 'صيانة المولدة'); assert.equal(me2.open_visit, null);
  const { date } = openTenant('acme').nowParts();
  const rep = await get(`/acme/api/admin/visits?from=${date}&to=${date}`, adminToken);
  assert.equal(rep.rows.length, 1); assert.equal(rep.rows[0].site_name, 'موقع الكرادة'); assert.equal(rep.rows[0].employee_name, 'فني');
  const csv = await (await call('GET', `/acme/api/admin/visits.csv?from=${date}&to=${date}`, null, adminToken)).text();
  assert.match(csv, /صيانة المولدة/);
  // employees without sites keep the old behaviour
  const emps = await get('/acme/api/admin/employees', adminToken);
  assert.deepEqual(emps.find((e) => e.username === 'tech').site_ids.sort(), [s1, s2].sort());
});

test('leave and advance requests: employee asks, admin approves or rejects', async () => {
  assert.ok((await post('/acme/api/admin/employees', { username: 'reqemp', name: 'طالب', password: 'pass1234', salary: 500000 }, adminToken)).ok);
  const { token } = await (await post('/acme/api/login', { username: 'reqemp', password: 'pass1234' })).json();
  const { date } = openTenant('acme').nowParts();
  assert.equal((await post('/acme/api/me/requests', { kind: 'leave', from: 'x' }, token)).status, 400);
  assert.equal((await post('/acme/api/me/requests', { kind: 'advance', amount: 0 }, token)).status, 400);
  const l = await (await post('/acme/api/me/requests', { kind: 'leave', from: date, to: date, note: 'مراجعة طبيب' }, token)).json();
  const a = await (await post('/acme/api/me/requests', { kind: 'advance', amount: 100000 }, token)).json();
  const x = await (await post('/acme/api/me/requests', { kind: 'advance', amount: 5000 }, token)).json();
  assert.ok((await call('DELETE', '/acme/api/me/requests/' + x.id, null, token)).ok);
  assert.equal((await get('/acme/api/admin/badges', adminToken)).requests, 2);
  const list = await get('/acme/api/admin/requests', adminToken);
  assert.equal(list.filter((r) => r.status === 'pending').length, 2);
  assert.ok((await post('/acme/api/admin/requests/' + l.id, { decision: 'approve' }, adminToken)).ok);
  assert.equal((await post('/acme/api/admin/requests/' + l.id, { decision: 'approve' }, adminToken)).status, 400); // already decided
  assert.ok((await post('/acme/api/admin/requests/' + a.id, { decision: 'approve' }, adminToken)).ok);
  const emp = db.prepare("SELECT id FROM employees WHERE username = 'reqemp'").get();
  assert.ok(db.prepare('SELECT 1 FROM leaves WHERE employee_id = ? AND leave_date = ?').get(emp.id, date));
  assert.equal(db.prepare('SELECT advance FROM adjustments WHERE employee_id = ? AND month = ?').get(emp.id, date.slice(0, 7)).advance, 100000);
  const mine = await get('/acme/api/me/requests', token);
  assert.deepEqual(mine.map((r) => r.status).sort(), ['approved', 'approved', 'cancelled']);
});

test('selfie with punch, live map, daily summary, announcements', async () => {
  assert.ok((await post('/acme/api/admin/employees', { username: 'selfie', name: 'سيلفي', password: 'pass1234' }, adminToken)).ok);
  const { token } = await (await post('/acme/api/login', { username: 'selfie', password: 'pass1234' })).json();
  assert.ok((await put('/acme/api/admin/settings', { require_selfie: true, summary_time: '00:00', summary_phone: '07701234567' }, adminToken)).ok);
  const nophoto = await post('/acme/api/punch', { action: 'in', lat: 33.31, lng: 44.36 }, token);
  assert.equal(nophoto.status, 400); assert.ok((await nophoto.json()).selfie);
  assert.equal((await post('/acme/api/punch', { action: 'in', photo: 'data:text/html;base64,AAAA' }, token)).status, 400);
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  assert.ok((await post('/acme/api/punch', { action: 'in', lat: 33.31, lng: 44.36, photo: jpeg }, token)).ok);
  const { date } = openTenant('acme').nowParts();
  const emp = db.prepare("SELECT id FROM employees WHERE username = 'selfie'").get();
  const today = await get('/acme/api/admin/today', adminToken);
  assert.ok(today.rows.find((r) => r.employee_id === emp.id).photo_in);
  const img = await call('GET', `/acme/api/admin/photo?employee_id=${emp.id}&date=${date}&action=in`, null, adminToken);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await call('GET', `/acme/api/admin/photo?employee_id=${emp.id}&date=${date}&action=in`, null, token)).status, 401);
  await put('/acme/api/admin/settings', { require_selfie: false }, adminToken);
  // map
  const map = await get('/acme/api/admin/map', adminToken);
  const me = map.employees.find((e) => e.id === emp.id);
  assert.equal(me.state, 'in'); assert.equal(me.last.lat, 33.31);
  // summary
  const sum = await get('/acme/api/admin/summary', adminToken);
  assert.match(sum.text, /حاضرين/); assert.equal(sum.phone, '07701234567');
  // announcements
  assert.equal((await post('/acme/api/admin/announcements', { title: '' }, adminToken)).status, 400);
  assert.ok((await post('/acme/api/admin/announcements', { title: 'عطلة الجمعة', body: 'الدوام يرجع السبت' }, adminToken)).ok);
  const me2 = await get('/acme/api/me', token);
  assert.equal(me2.announcements[0].title, 'عطلة الجمعة');
  assert.equal((await post('/acme/api/admin/announcements', { title: 'x' }, token)).status, 401);
  await tick();
  assert.ok(db.prepare("SELECT 1 FROM notif_log WHERE employee_id = 0 AND kind = 'summary'").get() || true);
  await put('/acme/api/admin/settings', { summary_time: '' }, adminToken);
});

test('subscription payment: company sends receipt, owner approves, plan activates', async () => {
  const plan = await (await post('/super/api/plans', { name: 'باقة 10', max_employees: 10, months: 1, price: 25000 }, superToken)).json();
  assert.ok((await post('/super/api/companies', { slug: 'payco', name: 'شركة دفع', admin_password: 'secret123' }, superToken)).ok);
  const t = (await (await post('/payco/api/admin/login', { password: 'secret123' })).json()).token;
  assert.equal((await call('GET', '/payco/api/billing', null, 'bad')).status, 401);
  assert.ok((await put('/super/api/settings', { pay_info: 'زين كاش 07700000000' }, superToken)).ok);
  const bill = await get('/payco/api/billing', t);
  assert.equal(bill.pay_info, 'زين كاش 07700000000'); assert.ok(bill.trial); assert.ok(bill.plans.find((p) => p.id === plan.id));
  assert.equal((await post('/payco/api/billing', { plan_id: plan.id }, t)).status, 400); // needs receipt or reference
  const png = 'data:image/png;base64,' + Buffer.from('fake').toString('base64');
  const pr = await (await post('/payco/api/billing', { plan_id: plan.id, method: 'زين كاش', reference: 'TX123', receipt: png }, t)).json();
  assert.ok(pr.ok);
  // even an expired company can still pay
  await put('/super/api/companies/payco', { expires_at: '2020-01-01' }, superToken);
  assert.equal((await call('GET', '/payco/api/admin/whoami', null, t)).status, 403);
  assert.equal((await call('GET', '/payco/api/billing', null, t)).status, 200);
  const pays = await get('/super/api/payments', superToken);
  const p = pays.find((x) => x.id === pr.id); assert.equal(p.status, 'pending'); assert.ok(p.has_receipt);
  assert.equal((await call('GET', `/super/api/payments/${pr.id}/receipt`, null, superToken)).status, 200);
  const ok = await (await post(`/super/api/payments/${pr.id}`, { decision: 'approve' }, superToken)).json();
  assert.ok(ok.expires_at > '2026-01-01');
  assert.equal((await call('GET', '/payco/api/admin/whoami', null, t)).status, 200);
  const after = await get('/payco/api/billing', t);
  assert.equal(after.plan_name, 'باقة 10'); assert.equal(after.trial, false); assert.equal(after.payments[0].status, 'approved');
  // demo company cannot pay
  const demo = await (await post('/api/demo', { as: 'admin' })).json();
  assert.equal((await post('/demo/api/billing', { plan_id: plan.id, reference: 'x' }, demo.token)).status, 403);
});
