const test = require('node:test');
const assert = require('node:assert');
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'secret';
const { app, db, reminderTick } = require('../server');

let srv, base, adminToken;
const call = (method, u, b, t) => fetch(base + u, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (t || '') }, body: b ? JSON.stringify(b) : undefined });
const post = (u, b, t) => call('POST', u, b, t);
const put = (u, b, t) => call('PUT', u, b, t);
const get = async (u, t) => (await call('GET', u, null, t)).json();

test.before(async () => {
  srv = app.listen(0); base = `http://localhost:${srv.address().port}`;
  assert.equal((await post('/api/admin/login', { password: 'bad' })).status, 401);
  adminToken = (await (await post('/api/admin/login', { password: 'secret' })).json()).token;
  assert.ok((await put('/api/admin/settings', { device_lock: false }, adminToken)).ok); // other tests don't send a device id
});
test.after(() => srv.close());

test('employee account, login, punch', async () => {
  const r = await post('/api/admin/employees', { username: 'ahmed', name: 'أحمد', password: 'pass1234', salary: 300000,
    shift_start: '08:00', shift_end: '16:00', overtime_after: '16:00', overtime_rate: 1.5 }, adminToken);
  assert.ok(r.ok, await r.text());
  assert.equal((await post('/api/admin/employees', { username: 'ahmed', name: 'x', password: 'pass1234' }, adminToken)).status, 400);
  assert.equal((await post('/api/login', { username: 'ahmed', password: 'wrong' })).status, 401);
  const { token } = await (await post('/api/login', { username: 'ahmed', password: 'pass1234' })).json();
  assert.ok(token);
  assert.equal((await post('/api/punch', { action: 'out' }, token)).status, 400);
  assert.ok((await post('/api/punch', { action: 'in' }, token)).ok); // no location configured -> allowed
  assert.equal((await post('/api/punch', { action: 'in' }, token)).status, 400);
  assert.ok((await post('/api/punch', { action: 'out' }, token)).ok);
  const me = await get('/api/me', token);
  assert.equal(me.employee.name, 'أحمد'); assert.ok(me.today.check_out);
  assert.equal((await call('GET', '/api/me', null, adminToken)).status, 401); // admin token is not an employee token
});

test('location fence', async () => {
  await post('/api/admin/employees', { username: 'zainab', name: 'زينب', password: 'pass1234' }, adminToken);
  const { token } = await (await post('/api/login', { username: 'zainab', password: 'pass1234' })).json();
  assert.ok((await put('/api/admin/settings', { location_lat: 33.3152, location_lng: 44.3661, location_radius: 100 }, adminToken)).ok);
  assert.equal((await post('/api/punch', { action: 'in' }, token)).status, 400);                         // no GPS
  const far = await post('/api/punch', { action: 'in', lat: 33.33, lng: 44.40 }, token);                 // ~3.5 km away
  assert.equal(far.status, 403); assert.match((await far.json()).error, /بعيد/);
  assert.ok((await post('/api/punch', { action: 'in', lat: 33.3155, lng: 44.3663 }, token)).ok);          // ~40 m away
  await put('/api/admin/settings', { location_lat: '', location_lng: '' }, adminToken);
});

test('payroll follows the Excel model', async () => {
  const emp = db.prepare("SELECT id FROM employees WHERE username = 'ahmed'").get();
  const ins = db.prepare('INSERT INTO attendance(employee_id, work_date, check_in, check_out) VALUES (?, ?, ?, ?)');
  ins.run(emp.id, '2026-10-01', '08:00:00', '18:00:00'); // 2h overtime after 16:00
  ins.run(emp.id, '2026-10-03', '08:30:00', null);       // 30 min late
  ins.run(emp.id, '2026-10-06', '10:30:00', null);       // 150 min late
  assert.ok((await post('/api/admin/leaves', { employee_id: emp.id, from: '2026-10-04', paid: 1 }, adminToken)).ok);
  assert.ok((await post('/api/admin/leaves', { employee_id: emp.id, from: '2026-10-05', paid: 0, note: 'ظرف' }, adminToken)).ok);
  assert.ok((await put('/api/admin/adjustments', { employee_id: emp.id, month: '2026-10', advance: 20000, bonus: 5000 }, adminToken)).ok);
  const s = (await get(`/api/admin/payslip?employee_id=${emp.id}&month=2026-10`, adminToken)).summary;
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
  const list = await get('/api/admin/payroll?month=2026-10', adminToken);
  assert.equal(list.rows.length, 2); assert.equal(list.totals.net_salary, list.rows.reduce((a, r) => a + r.summary.net_salary, 0));
  const csv = await (await call('GET', '/api/admin/payroll.csv?month=2026-10', null, adminToken)).text();
  assert.match(csv, /صافي الراتب/); assert.match(csv, /المجموع/);
});

test('shifts and leave for all employees', async () => {
  const shifts = await get('/api/admin/shifts', adminToken);
  assert.equal(shifts.length, 2);
  const early = shifts.find((x) => x.start === '07:00');
  const emp = db.prepare("SELECT id FROM employees WHERE username = 'zainab'").get();
  assert.ok((await put('/api/admin/employees/' + emp.id, { shift_id: early.id }, adminToken)).ok);
  const list = await get('/api/admin/employees', adminToken);
  const z = list.find((e) => e.id === emp.id);
  assert.equal(z.shift_start, '07:00'); assert.equal(z.shift_name, '7:00 - 3:30');
  assert.equal((await call('DELETE', '/api/admin/shifts/' + early.id, null, adminToken)).status, 400); // in use
  const r = await (await post('/api/admin/leaves', { employee_id: 'all', from: '2026-10-20', to: '2026-10-21', paid: 1, note: 'عطلة رسمية' }, adminToken)).json();
  assert.equal(r.employees, 2); assert.equal(r.count, 2);
});

test('csv and auth', async () => {
  const today = await get('/api/admin/today', adminToken);
  const csv = await call('GET', `/api/admin/report.csv?from=${today.date}&to=${today.date}`, null, adminToken);
  assert.match(await csv.text(), /أحمد/);
  assert.equal((await call('GET', '/api/admin/today')).status, 401);
  const settings = await get('/api/admin/settings', adminToken);
  assert.equal(settings.vapid_private, undefined);
});

test('offline punch is accepted with device time and flagged', async () => {
  await post('/api/admin/employees', { username: 'sara', name: 'سارة', password: 'pass1234' }, adminToken);
  const { token } = await (await post('/api/login', { username: 'sara', password: 'pass1234' })).json();
  const twoHoursAgo = Date.now() - 5 * 60 * 1000;
  const r = await post('/api/punch', { action: 'in', offline_at: twoHoursAgo, queued: true }, token);
  const dup = await (await post('/api/punch', { action: 'in', offline_at: twoHoursAgo, queued: true }, token)).json();
  assert.equal(dup.duplicate, true);
  assert.ok(r.ok, await r.text());
  const me = await get('/api/me', token);
  const rec = db.prepare("SELECT a.* FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE e.username = 'sara'").get();
  assert.equal(rec.in_offline, 1); assert.ok(rec.in_synced_at);
  assert.ok(me.days.some((d) => d.in_offline));
  // a fresh punch (sent right away) is not flagged
  assert.ok((await post('/api/punch', { action: 'out', offline_at: Date.now() - 5000 }, token)).ok);
  const rec2 = db.prepare('SELECT * FROM attendance WHERE id = ?').get(rec.id);
  assert.equal(rec2.out_offline, 0);
  // future and too-old punches are refused
  assert.equal((await post('/api/punch', { action: 'in', offline_at: Date.now() + 3600 * 1000 }, token)).status, 400);
  assert.equal((await post('/api/punch', { action: 'in', offline_at: Date.now() - 10 * 24 * 3600 * 1000 }, token)).status, 400);
  const csv = await call('GET', `/api/admin/report.csv?from=${me.date}&to=${me.date}`, null, adminToken);
  assert.match(await csv.text(), /حضور \(وصلت/);
});

test('device lock: one phone per account, one account per phone', async () => {
  const dev = (t, d) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + (t || ''), 'X-Device-Id': d });
  const req = (u, b, t, d, method = 'POST') => fetch(base + u, { method, headers: dev(t, d), body: JSON.stringify(b) });
  const A = 'aaaaaaaa-1111-2222-3333-444444444444', B = 'bbbbbbbb-1111-2222-3333-444444444444';
  assert.ok((await put('/api/admin/settings', { device_lock: true }, adminToken)).ok);
  const r1 = await post('/api/admin/employees', { username: 'dev1', name: 'جهاز1', password: 'pass1234' }, adminToken);
  const r2 = await post('/api/admin/employees', { username: 'dev2', name: 'جهاز2', password: 'pass1234' }, adminToken);
  assert.ok(r1.ok && r2.ok);
  const id1 = (await get('/api/admin/employees', adminToken)).find((e) => e.username === 'dev1').id;
  assert.equal((await post('/api/login', { username: 'dev1', password: 'pass1234' })).status, 403); // no device id
  const ok1 = await req('/api/login', { username: 'dev1', password: 'pass1234' }, '', A);
  assert.ok(ok1.ok); const t1 = (await ok1.json()).token;
  // same account from another phone -> refused
  assert.equal((await req('/api/login', { username: 'dev1', password: 'pass1234' }, '', B)).status, 403);
  // another account from the first phone -> refused
  assert.equal((await req('/api/login', { username: 'dev2', password: 'pass1234' }, '', A)).status, 403);
  // punch with the token copied to another phone -> refused
  assert.equal((await req('/api/punch', { action: 'in' }, t1, B)).status, 403);
  assert.ok((await req('/api/punch', { action: 'in' }, t1, A)).ok);
  const emps = await get('/api/admin/employees', adminToken);
  assert.ok(emps.find((e) => e.id === id1).device_bound);
  // admin resets -> new phone can log in, old session is gone
  assert.ok((await put('/api/admin/employees/' + id1, { reset_device: true }, adminToken)).ok);
  assert.equal((await req('/api/punch', { action: 'out' }, t1, A)).status, 401);
  assert.ok((await req('/api/login', { username: 'dev1', password: 'pass1234' }, '', B)).ok);
  assert.ok((await req('/api/login', { username: 'dev2', password: 'pass1234' }, '', A)).ok);
  assert.ok((await put('/api/admin/settings', { device_lock: false }, adminToken)).ok);
});

test('accountant can read and print payroll but not change leaves, employees or settings', async () => {
  assert.equal((await put('/api/admin/settings', { accountant_user: 'acc', accountant_password: '123' }, adminToken)).status, 400); // too short
  assert.ok((await put('/api/admin/settings', { accountant_user: 'acc', accountant_password: 'acc12345' }, adminToken)).ok);
  const st = await get('/api/admin/settings', adminToken);
  assert.equal(st.accountant_hash, undefined); assert.ok(st.accountant_has_password);
  assert.equal((await post('/api/admin/login', { username: 'acc', password: 'wrong' })).status, 401);
  const lr = await (await post('/api/admin/login', { username: 'acc', password: 'acc12345' })).json();
  assert.equal(lr.role, 'accountant'); const t = lr.token;
  assert.equal((await get('/api/admin/whoami', t)).role, 'accountant');
  const month = new Date().toISOString().slice(0, 7);
  assert.ok((await call('GET', '/api/admin/payroll?month=' + month, null, t)).ok);
  assert.ok((await call('GET', '/api/admin/payroll.csv?month=' + month, null, t)).ok);
  const emp = (await get('/api/admin/employees', t))[0];
  assert.ok((await call('GET', `/api/admin/payslip?employee_id=${emp.id}&month=${month}`, null, t)).ok);
  assert.ok((await put('/api/admin/adjustments', { employee_id: emp.id, month, bonus: 1000, advance: 0 }, t)).ok);
  // forbidden for the accountant
  assert.equal((await post('/api/admin/leaves', { employee_id: emp.id, from: month + '-01', paid: 1 }, t)).status, 401);
  assert.equal((await call('GET', '/api/admin/leaves?month=' + month, null, t)).status, 401);
  // the accountant may add and edit employees, but not unbind a phone
  assert.ok((await post('/api/admin/employees', { username: 'x1', name: 'x', password: 'pass1234', salary: 500000 }, t)).ok);
  assert.ok((await put('/api/admin/employees/' + emp.id, { salary: emp.salary }, t)).ok);
  assert.equal((await put('/api/admin/employees/' + emp.id, { reset_device: true }, t)).status, 403);
  assert.equal((await put('/api/admin/settings', { accountant_adjust: true }, t)).status, 401);
  assert.equal((await post('/api/admin/shifts', { name: 'x', start: '08:00', end: '15:00', overtime_after: '16:00' }, t)).status, 401);
  // admin turns off bonus/advance editing for the accountant
  assert.ok((await put('/api/admin/settings', { accountant_adjust: false }, adminToken)).ok);
  assert.equal((await put('/api/admin/adjustments', { employee_id: emp.id, month, bonus: 2000, advance: 0 }, t)).status, 403);
  // changing the accountant password logs them out
  assert.ok((await put('/api/admin/settings', { accountant_password: 'new12345' }, adminToken)).ok);
  assert.equal((await call('GET', '/api/admin/payroll?month=' + month, null, t)).status, 401);
  // admin still logs in with an empty username
  assert.ok((await post('/api/admin/login', { password: 'secret' })).ok);
});

test('reminder tick runs', async () => { await reminderTick(); });
