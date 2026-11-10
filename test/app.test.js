const test = require('node:test');
const assert = require('node:assert');
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'secret';
const { app } = require('../server');

test('full flow', async () => {
  const srv = app.listen(0); const base = `http://localhost:${srv.address().port}`;
  const post = (u, b, t) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (t || '') }, body: JSON.stringify(b) });
  assert.equal((await post('/api/admin/login', { password: 'bad' })).status, 401);
  const { token } = await (await post('/api/admin/login', { password: 'secret' })).json();
  assert.ok((await post('/api/admin/employees', { code: '101', name: 'أحمد', pin: '1234' }, token)).ok);
  assert.equal((await post('/api/admin/employees', { code: '101', name: 'x', pin: '1234' }, token)).status, 400);
  assert.equal((await post('/api/punch', { code: '101', pin: '0000', action: 'in' })).status, 401);
  assert.equal((await post('/api/punch', { code: '101', pin: '1234', action: 'out' })).status, 400);
  assert.ok((await post('/api/punch', { code: '101', pin: '1234', action: 'in', lat: 33.3, lng: 44.4 })).ok);
  assert.equal((await post('/api/punch', { code: '101', pin: '1234', action: 'in' })).status, 400);
  assert.ok((await post('/api/punch', { code: '101', pin: '1234', action: 'out' })).ok);
  const today = await (await fetch(base + '/api/admin/today', { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.equal(today.rows.length, 1); assert.ok(today.rows[0].check_out); assert.notEqual(today.rows[0].status, 'غائب');
  const csv = await fetch(base + `/api/admin/report.csv?from=${today.date}&to=${today.date}`, { headers: { Authorization: 'Bearer ' + token } });
  assert.match(await csv.text(), /أحمد/);
  assert.equal((await fetch(base + '/api/admin/today')).status, 401);
  srv.close();
});
