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

test('payroll with leaves and overtime', async () => {
  const emp = db.prepare("SELECT id FROM employees WHERE username = 'ahmed'").get();
  const ins = db.prepare('INSERT INTO attendance(employee_id, work_date, check_in, check_out) VALUES (?, ?, ?, ?)');
  ins.run(emp.id, '2026-10-01', '08:00:00', '18:00:00'); // 2h overtime
  ins.run(emp.id, '2026-10-03', '08:30:00', null);       // 30 min late
  assert.ok((await post('/api/admin/leaves', { employee_id: emp.id, from: '2026-10-04', paid: 1 }, adminToken)).ok);
  assert.ok((await post('/api/admin/leaves', { employee_id: emp.id, from: '2026-10-05', paid: 0, note: 'ظرف' }, adminToken)).ok);
  const slip = await get(`/api/admin/payslip?employee_id=${emp.id}&month=2026-10`, adminToken);
  const s = slip.summary;
  // Oct 2026 has 5 Fridays -> 26 working days: 2 worked, 1 paid leave, 1 unpaid leave, 22 absent
  assert.equal(s.present_days, 2); assert.equal(s.late_days, 1); assert.equal(s.late_minutes, 30);
  assert.equal(s.paid_leave_days, 1); assert.equal(s.unpaid_leave_days, 1); assert.equal(s.absent_days, 22);
  assert.equal(s.overtime_minutes, 120);
  assert.equal(s.absence_deduction, 230000);   // (22 + 1) * 10000
  assert.equal(s.overtime_pay, 3750);          // 2h * 1250 * 1.5
  assert.equal(s.net_salary, 73750);
  const leaves = await get('/api/admin/leaves?month=2026-10', adminToken);
  assert.equal(leaves.length, 2);
  const list = await get('/api/admin/payroll?month=2026-10', adminToken);
  assert.equal(list.length, 2);
});

test('csv and auth', async () => {
  const today = await get('/api/admin/today', adminToken);
  const csv = await call('GET', `/api/admin/report.csv?from=${today.date}&to=${today.date}`, null, adminToken);
  assert.match(await csv.text(), /أحمد/);
  assert.equal((await call('GET', '/api/admin/today')).status, 401);
  const settings = await get('/api/admin/settings', adminToken);
  assert.equal(settings.vapid_private, undefined);
});

test('reminder tick runs', async () => { await reminderTick(); });
