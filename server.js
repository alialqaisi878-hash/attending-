// برنامج الحضور والانصراف - الخادم
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const TZ = process.env.APP_TZ || 'Asia/Baghdad';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'attendance.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    department TEXT DEFAULT '',
    pin_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    work_date TEXT NOT NULL,
    check_in TEXT,
    check_out TEXT,
    in_lat REAL, in_lng REAL,
    out_lat REAL, out_lng REAL,
    UNIQUE(employee_id, work_date)
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);
const defaults = { work_start: '08:00', work_end: '16:00', grace_minutes: '10' };
for (const [k, v] of Object.entries(defaults)) {
  db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(k, v);
}

// ---------- أدوات ----------
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
// التاريخ والوقت حسب توقيت العراق
function nowParts() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

function enrich(row, s) {
  const out = { ...row, worked_minutes: null, late_minutes: 0, status: 'غائب' };
  if (row.check_in) {
    const late = toMin(row.check_in) - toMin(s.work_start);
    out.late_minutes = late > Number(s.grace_minutes) ? late : 0;
    out.status = out.late_minutes ? 'متأخر' : 'حاضر';
  }
  if (row.check_in && row.check_out) {
    out.worked_minutes = Math.max(0, toMin(row.check_out) - toMin(row.check_in));
  }
  return out;
}

// ---------- التطبيق ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function findEmployee(code, pin) {
  const emp = db.prepare('SELECT * FROM employees WHERE code = ? AND active = 1').get(String(code || '').trim());
  if (!emp || !checkPin(pin || '', emp.pin_hash)) return null;
  return emp;
}

// حالة الموظف اليوم
app.post('/api/status', (req, res) => {
  const emp = findEmployee(req.body.code, req.body.pin);
  if (!emp) return res.status(401).json({ error: 'كود الموظف أو الرمز السري غير صحيح' });
  const { date } = nowParts();
  const rec = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?').get(emp.id, date);
  res.json({ name: emp.name, date, record: rec || null });
});

// تسجيل حضور / انصراف
app.post('/api/punch', (req, res) => {
  const { code, pin, action, lat, lng } = req.body;
  const emp = findEmployee(code, pin);
  if (!emp) return res.status(401).json({ error: 'كود الموظف أو الرمز السري غير صحيح' });
  const { date, time } = nowParts();
  const la = typeof lat === 'number' ? lat : null;
  const ln = typeof lng === 'number' ? lng : null;
  const rec = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?').get(emp.id, date);

  if (action === 'in') {
    if (rec && rec.check_in) return res.status(400).json({ error: `مسجّل حضورك اليوم من الساعة ${rec.check_in.slice(0, 5)}` });
    db.prepare('INSERT INTO attendance(employee_id, work_date, check_in, in_lat, in_lng) VALUES (?, ?, ?, ?, ?)')
      .run(emp.id, date, time, la, ln);
    return res.json({ ok: true, message: `أهلاً ${emp.name}، تم تسجيل حضورك الساعة ${time.slice(0, 5)}` });
  }
  if (action === 'out') {
    if (!rec || !rec.check_in) return res.status(400).json({ error: 'لازم تسجّل حضور أول' });
    if (rec.check_out) return res.status(400).json({ error: `مسجّل انصرافك اليوم الساعة ${rec.check_out.slice(0, 5)}` });
    db.prepare('UPDATE attendance SET check_out = ?, out_lat = ?, out_lng = ? WHERE id = ?').run(time, la, ln, rec.id);
    return res.json({ ok: true, message: `مع السلامة ${emp.name}، تم تسجيل انصرافك الساعة ${time.slice(0, 5)}` });
  }
  res.status(400).json({ error: 'عملية غير معروفة' });
});

// ---------- المدير ----------
const sessions = new Map(); // token -> expiry
function adminAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'سجّل دخول المدير' });
  next();
}
app.post('/api/admin/login', (req, res) => {
  const a = Buffer.from(String(req.body.password || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + 12 * 3600 * 1000);
  res.json({ token });
});

app.get('/api/admin/employees', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT id, code, name, department, active FROM employees ORDER BY active DESC, name').all());
});
app.post('/api/admin/employees', adminAuth, (req, res) => {
  const { code, name, department, pin } = req.body;
  if (!code || !name || !pin) return res.status(400).json({ error: 'الكود والاسم والرمز السري مطلوبة' });
  if (!/^\d{4,8}$/.test(String(pin))) return res.status(400).json({ error: 'الرمز السري لازم يكون من 4 إلى 8 أرقام' });
  try {
    db.prepare('INSERT INTO employees(code, name, department, pin_hash) VALUES (?, ?, ?, ?)')
      .run(String(code).trim(), name.trim(), (department || '').trim(), hashPin(pin));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'كود الموظف مستخدم مسبقاً' });
  }
});
app.put('/api/admin/employees/:id', adminAuth, (req, res) => {
  const { name, department, pin, active } = req.body;
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
  if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });
  if (pin && !/^\d{4,8}$/.test(String(pin))) return res.status(400).json({ error: 'الرمز السري لازم يكون من 4 إلى 8 أرقام' });
  db.prepare('UPDATE employees SET name = ?, department = ?, active = ?, pin_hash = ? WHERE id = ?').run(
    name ?? emp.name, department ?? emp.department,
    active === undefined ? emp.active : (active ? 1 : 0),
    pin ? hashPin(pin) : emp.pin_hash, emp.id);
  res.json({ ok: true });
});

function report(from, to, employeeId) {
  const s = getSettings();
  const emps = db.prepare('SELECT id, code, name, department FROM employees WHERE active = 1' +
    (employeeId ? ' AND id = ?' : '') + ' ORDER BY name').all(...(employeeId ? [Number(employeeId)] : []));
  const recs = db.prepare('SELECT * FROM attendance WHERE work_date BETWEEN ? AND ?').all(from, to);
  const byKey = new Map(recs.map((r) => [r.employee_id + '|' + r.work_date, r]));
  const rows = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    for (const e of emps) {
      const r = byKey.get(e.id + '|' + date) || { work_date: date, check_in: null, check_out: null };
      rows.push({ ...enrich(r, s), employee_id: e.id, code: e.code, name: e.name, department: e.department });
    }
  }
  return rows;
}
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

app.get('/api/admin/today', adminAuth, (req, res) => {
  const { date } = nowParts();
  res.json({ date, rows: report(date, date) });
});
app.get('/api/admin/report', adminAuth, (req, res) => {
  const { from, to, employee_id } = req.query;
  if (!validDate(from) || !validDate(to) || from > to) return res.status(400).json({ error: 'حدد فترة صحيحة' });
  res.json(report(from, to, employee_id));
});
app.get('/api/admin/report.csv', adminAuth, (req, res) => {
  const { from, to, employee_id } = req.query;
  if (!validDate(from) || !validDate(to) || from > to) return res.status(400).send('bad range');
  const rows = report(from, to, employee_id);
  const head = ['التاريخ', 'الكود', 'الاسم', 'القسم', 'الحضور', 'الانصراف', 'الحالة', 'دقائق التأخير', 'ساعات العمل'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [r.work_date, r.code, r.name, r.department, r.check_in || '', r.check_out || '', r.status,
    r.late_minutes, r.worked_minutes == null ? '' : (r.worked_minutes / 60).toFixed(2)].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_${to}.csv"`);
  res.send('﻿' + [head.map(esc).join(','), ...lines].join('\n'));
});

app.get('/api/admin/settings', adminAuth, (req, res) => res.json(getSettings()));
app.put('/api/admin/settings', adminAuth, (req, res) => {
  const { work_start, work_end, grace_minutes } = req.body;
  const t = /^\d{2}:\d{2}$/;
  if (!t.test(work_start) || !t.test(work_end) || !(Number(grace_minutes) >= 0)) return res.status(400).json({ error: 'قيم غير صحيحة' });
  const up = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  up.run(work_start, 'work_start'); up.run(work_end, 'work_end'); up.run(String(Number(grace_minutes)), 'grace_minutes');
  res.json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Attendance app running on http://localhost:${PORT}`));
}
module.exports = { app, db };
