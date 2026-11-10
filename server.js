// برنامج الحضور والانصراف - الخادم
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const TZ = process.env.APP_TZ || 'Asia/Baghdad';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'attendance.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    department TEXT DEFAULT '',
    job_title TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    salary REAL NOT NULL DEFAULT 0,          -- الراتب الشهري
    shift_start TEXT NOT NULL DEFAULT '08:00',
    shift_end TEXT NOT NULL DEFAULT '16:00',
    overtime_after TEXT NOT NULL DEFAULT '16:00', -- الساعة الي يبدي بيها الأوفر تايم
    overtime_rate REAL NOT NULL DEFAULT 1.5,       -- مضاعف أجر ساعة الأوفر تايم
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    work_date TEXT NOT NULL,
    check_in TEXT, check_out TEXT,
    in_lat REAL, in_lng REAL, in_distance REAL,
    out_lat REAL, out_lng REAL, out_distance REAL,
    in_offline INTEGER NOT NULL DEFAULT 0, in_synced_at TEXT,   -- بصمة بدون نت: وقت وصولها للسيرفر
    out_offline INTEGER NOT NULL DEFAULT 0, out_synced_at TEXT,
    UNIQUE(employee_id, work_date)
  );
  CREATE TABLE IF NOT EXISTS leaves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    leave_date TEXT NOT NULL,
    note TEXT DEFAULT '',
    paid INTEGER NOT NULL DEFAULT 1,   -- 1 مدفوعة، 0 بقطع راتب
    UNIQUE(employee_id, leave_date)
  );
  CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    endpoint TEXT UNIQUE NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notif_log (
    employee_id INTEGER NOT NULL, work_date TEXT NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY (employee_id, work_date, kind)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    kind TEXT NOT NULL,            -- admin | employee
    employee_id INTEGER,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    overtime_after TEXT NOT NULL   -- يبدي الإضافي من هالساعة
  );
  CREATE TABLE IF NOT EXISTS adjustments (   -- السلف والمكافآت لكل موظف بكل شهر
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    month TEXT NOT NULL,
    advance REAL NOT NULL DEFAULT 0,
    bonus REAL NOT NULL DEFAULT 0,
    note TEXT DEFAULT '',
    PRIMARY KEY (employee_id, month)
  );
`);
// ترقية قاعدة بيانات قديمة
{
  const cols = db.prepare('PRAGMA table_info(attendance)').all().map((c) => c.name);
  for (const [c, def] of [['in_offline', 'INTEGER NOT NULL DEFAULT 0'], ['in_synced_at', 'TEXT'], ['out_offline', 'INTEGER NOT NULL DEFAULT 0'], ['out_synced_at', 'TEXT']]) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE attendance ADD COLUMN ${c} ${def}`);
  }
  const ecols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
  if (!ecols.includes('shift_id')) db.exec('ALTER TABLE employees ADD COLUMN shift_id INTEGER REFERENCES shifts(id)');
  if (!ecols.includes('device_id')) db.exec('ALTER TABLE employees ADD COLUMN device_id TEXT'); // الجهاز المربوط بالحساب
  if (!ecols.includes('device_at')) db.exec('ALTER TABLE employees ADD COLUMN device_at TEXT');
}
if (!db.prepare('SELECT COUNT(*) AS c FROM shifts').get().c) {
  db.prepare("INSERT INTO shifts(name, start, end, overtime_after) VALUES ('7:00 - 3:30', '07:00', '15:30', '16:00'), ('8:00 - 3:00', '08:00', '15:00', '16:00')").run();
}
const OFFLINE_MAX_DAYS = 7; // أقدم بصمة بدون نت مقبولة
const DEFAULT_SETTINGS = {
  company_name: 'اسم الشركة',
  grace_minutes: '0',       // (قديم) ما يُستعمل، السماحية صارت شهرية
  late_allowance: '120',    // سماحية التأخير الشهرية بالدقائق (توتل الشهر)
  late_hour_rate: '5000',   // سعر ساعة التأخير (دينار)
  overtime_hour_rate: '5000', // سعر ساعة الإضافي (دينار)
  weekend_days: '5',        // أيام العطلة الأسبوعية: 0=الأحد ... 5=الجمعة 6=السبت
  location_lat: '',
  location_lng: '',
  location_radius: '100',   // بالمتر
  device_lock: '1',         // كل حساب موظف ينربط بجهاز واحد، وكل جهاز لحساب واحد
  month_days: '26',         // اليومية = الراتب الشهري / هذا الرقم
  remind_before: '10',      // تنبيه قبل بداية الدوام بكم دقيقة
  remind_late: '15',        // تنبيه ثاني إذا ما بصم بعد بداية الدوام بكم دقيقة
  remind_out_after: '10',   // تنبيه الانصراف بعد نهاية الدوام بكم دقيقة
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(k, v);
}
// ترقية لمرة وحدة لطريقة حساب ملف الإكسل
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'model_excel_v1'").get()) {
  db.prepare("UPDATE settings SET value = '26' WHERE key = 'month_days' AND value = '30'").run();
  db.prepare("INSERT INTO settings(key, value) VALUES ('model_excel_v1', '1')").run();
}
// مفاتيح الإشعارات (تتولد مرة وحدة وتنحفظ)
if (!db.prepare("SELECT value FROM settings WHERE key = 'vapid_public'").get()) {
  const k = webpush.generateVAPIDKeys();
  db.prepare("INSERT INTO settings(key, value) VALUES ('vapid_public', ?), ('vapid_private', ?)").run(k.publicKey, k.privateKey);
}
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || db.prepare("SELECT value FROM settings WHERE key = 'vapid_public'").get().value;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || db.prepare("SELECT value FROM settings WHERE key = 'vapid_private'").get().value;
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

// ---------- أدوات ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
function nowParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

// المسافة بالمتر بين نقطتين
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function datesBetween(from, to) {
  const out = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

// حساب يوم واحد لموظف
function dayInfo(emp, date, rec, leave, s, today) {
  emp = withShift(emp);
  const weekend = s.weekend_days.split(',').filter(Boolean).map(Number);
  const isWeekend = weekend.includes(new Date(date + 'T00:00:00Z').getUTCDay());
  const r = {
    work_date: date, check_in: rec?.check_in || null, check_out: rec?.check_out || null,
    in_lat: rec?.in_lat ?? null, in_lng: rec?.in_lng ?? null, out_lat: rec?.out_lat ?? null, out_lng: rec?.out_lng ?? null,
    worked_minutes: null, late_minutes: 0, overtime_minutes: 0, status: '', leave_note: leave?.note || '',
    in_offline: !!rec?.in_offline, in_synced_at: rec?.in_synced_at || null,
    out_offline: !!rec?.out_offline, out_synced_at: rec?.out_synced_at || null,
  };
  if (r.check_in && r.check_out) r.worked_minutes = Math.max(0, toMin(r.check_out) - toMin(r.check_in));
  if (r.check_in) {
    if (isWeekend) {
      r.status = 'دوام بالعطلة'; // يوم حضور مدفوع، بدون تأخير
    } else {
      r.late_minutes = Math.max(0, toMin(r.check_in) - toMin(emp.shift_start));
      r.status = r.late_minutes ? 'متأخر' : 'حاضر';
    }
    if (r.check_out) {
      const otStart = Math.max(toMin(emp.overtime_after), toMin(r.check_in));
      r.overtime_minutes = Math.max(0, toMin(r.check_out) - otStart);
    }
  } else if (leave) r.status = leave.paid ? 'إجازة مدفوعة' : 'إجازة بدون راتب';
  else if (isWeekend) r.status = 'عطلة';
  else if (date > today) r.status = 'لم يأتِ بعد';
  else if (date === today) r.status = 'لم يسجّل بعد';
  else r.status = 'غائب';
  return r;
}

function employeeDays(emp, from, to) {
  const s = getSettings();
  const { date: today } = nowParts();
  const recs = new Map(db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ?')
    .all(emp.id, from, to).map((r) => [r.work_date, r]));
  const leaves = new Map(db.prepare('SELECT * FROM leaves WHERE employee_id = ? AND leave_date BETWEEN ? AND ?')
    .all(emp.id, from, to).map((r) => [r.leave_date, r]));
  return datesBetween(from, to).map((d) => dayInfo(emp, d, recs.get(d), leaves.get(d), s, today));
}

// كشف الراتب الشهري (نفس طريقة ملف الإكسل)
// اليومية = الراتب ÷ أيام القسمة
// راتب أيام الحضور = (أيام الحضور + الإجازة المدفوعة) × اليومية
// خصم التأخير = (مجموع التأخير − السماحية الشهرية) ÷ 60 × سعر ساعة التأخير
// مبلغ الإضافي = دقائق الإضافي ÷ 60 × سعر ساعة الإضافي
// الصافي = راتب الحضور − خصم التأخير + الإضافي + المكافآت − السلف
function payroll(emp, month) {
  const s = getSettings();
  const { from, to } = monthRange(month);
  const days = employeeDays(emp, from, to);
  const adj = db.prepare('SELECT * FROM adjustments WHERE employee_id = ? AND month = ?').get(emp.id, month) || { advance: 0, bonus: 0, note: '' };
  const dailyRate = emp.salary / Number(s.month_days || 26);
  const count = (st) => days.filter((d) => d.status === st).length;
  const presentDays = count('حاضر') + count('متأخر') + count('دوام بالعطلة');
  const paidLeave = count('إجازة مدفوعة');
  const overtimeMin = days.reduce((a, d) => a + d.overtime_minutes, 0);
  const lateMin = days.reduce((a, d) => a + d.late_minutes, 0);
  const allowance = Number(s.late_allowance || 0);
  const lateAfter = Math.max(0, lateMin - allowance);
  const attendancePay = (presentDays + paidLeave) * dailyRate;
  const lateDeduction = (lateAfter / 60) * Number(s.late_hour_rate || 0);
  const overtimePay = (overtimeMin / 60) * Number(s.overtime_hour_rate || 0);
  const gross = attendancePay - lateDeduction + overtimePay + Number(adj.bonus || 0);
  const round = (n) => Math.round(n);
  return {
    month, from, to, days,
    summary: {
      present_days: presentDays, late_days: count('متأخر'), late_minutes: lateMin,
      late_allowance: allowance, late_after_allowance: lateAfter,
      absent_days: count('غائب'), paid_leave_days: paidLeave, unpaid_leave_days: count('إجازة بدون راتب'),
      overtime_minutes: overtimeMin,
      worked_minutes: days.reduce((a, d) => a + (d.worked_minutes || 0), 0),
      base_salary: round(emp.salary), daily_rate: round(dailyRate), month_days: Number(s.month_days || 26),
      late_hour_rate: Number(s.late_hour_rate || 0), overtime_hour_rate: Number(s.overtime_hour_rate || 0),
      attendance_pay: round(attendancePay), late_deduction: round(lateDeduction), overtime_pay: round(overtimePay),
      bonus: round(adj.bonus || 0), advance: round(adj.advance || 0), adjustment_note: adj.note || '',
      gross_salary: round(gross), net_salary: round(gross - Number(adj.advance || 0)),
    },
  };
}

// الدوام: إذا للموظف دوام مختار نأخذ أوقاته منه
const shiftById = (id) => (id ? db.prepare('SELECT * FROM shifts WHERE id = ?').get(id) : null);
function withShift(e) {
  if (e._resolved) return e;
  const sh = shiftById(e.shift_id);
  return sh ? { ...e, shift_start: sh.start, shift_end: sh.end, overtime_after: sh.overtime_after, shift_name: sh.name, _resolved: true }
    : { ...e, shift_name: `${e.shift_start} - ${e.shift_end}`, _resolved: true };
}

const publicEmp = (e0) => { const e = withShift(e0); return {
  shift_id: e.shift_id || null, shift_name: e.shift_name,
  id: e.id, username: e.username, name: e.name, department: e.department, job_title: e.job_title,
  salary: e.salary, shift_start: e.shift_start, shift_end: e.shift_end,
  overtime_after: e.overtime_after, active: e.active, device_bound: !!e.device_id, device_at: e.device_at || null,
}; };

// ---------- قفل الجهاز ----------
// يرجع رسالة خطأ إذا الجهاز مو مسموح لهذا الموظف، أو يربط الجهاز إذا الحساب بعده مو مربوط
function checkDevice(emp, deviceId) {
  if (getSettings().device_lock !== '1') return null;
  const dev = String(deviceId || '').trim();
  if (!/^[A-Za-z0-9-]{16,64}$/.test(dev)) return 'حدّث الصفحة وحاول مرة ثانية.';
  if (emp.device_id && emp.device_id !== dev) return 'هذا الحساب مربوط بجهاز ثاني. البصمة لازم تكون من تلفونك انت. إذا غيّرت تلفونك راجع المدير.';
  const other = db.prepare('SELECT name FROM employees WHERE device_id = ? AND id != ? AND active = 1').get(dev, emp.id);
  if (other) return 'هذا الجهاز مسجّل لموظف ثاني. كل موظف يبصم من تلفونه بس.';
  if (!emp.device_id) {
    db.prepare("UPDATE employees SET device_id = ?, device_at = datetime('now') WHERE id = ?").run(dev, emp.id);
    emp.device_id = dev;
  }
  return null;
}

// ---------- الجلسات ----------
function newSession(kind, employeeId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token, kind, employee_id, expires) VALUES (?, ?, ?, ?)')
    .run(token, kind, employeeId ?? null, Date.now() + 30 * 24 * 3600 * 1000);
  return token;
}
function auth(kind) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!s || s.kind !== kind || s.expires < Date.now()) return res.status(401).json({ error: 'سجّل دخول' });
    if (kind === 'employee') {
      const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(s.employee_id);
      if (!emp) return res.status(401).json({ error: 'الحساب موقوف' });
      req.emp = emp;
    }
    req.token = token;
    next();
  };
}

// ---------- التطبيق ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.post('/api/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
});

// ----- الموظف -----
app.post('/api/login', (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE username = ? AND active = 1').get(String(req.body.username || '').trim());
  if (!emp || !checkPassword(req.body.password || '', emp.password_hash)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  const devErr = checkDevice(emp, req.headers['x-device-id']);
  if (devErr) return res.status(403).json({ error: devErr });
  res.json({ token: newSession('employee', emp.id), name: emp.name });
});

app.get('/api/me', auth('employee'), (req, res) => {
  const { date } = nowParts();
  const month = date.slice(0, 7);
  const s = getSettings();
  const p = payroll(req.emp, month);
  res.json({
    employee: publicEmp(req.emp), today: p.days.find((d) => d.work_date === date), date,
    month, summary: p.summary, days: p.days.filter((d) => d.work_date <= date).reverse(),
    location_required: !!(s.location_lat && s.location_lng), company_name: s.company_name,
  });
});

app.get('/api/me/payslip', auth('employee'), (req, res) => {
  const month = MONTH_RE.test(req.query.month || '') ? req.query.month : nowParts().date.slice(0, 7);
  res.json({ employee: publicEmp(req.emp), company_name: getSettings().company_name, ...payroll(req.emp, month) });
});

app.post('/api/me/password', auth('employee'), (req, res) => {
  const { old_password, new_password } = req.body;
  if (!checkPassword(old_password || '', req.emp.password_hash)) return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  if (String(new_password || '').length < 4) return res.status(400).json({ error: 'كلمة المرور لازم 4 أحرف على الأقل' });
  db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), req.emp.id);
  res.json({ ok: true });
});

app.post('/api/punch', auth('employee'), (req, res) => {
  const { action, lat, lng, offline_at, queued } = req.body;
  const emp = req.emp;
  const devErr = checkDevice(emp, req.headers['x-device-id']);
  if (devErr) return res.status(403).json({ error: devErr, device: true });
  // بصمة محفوظة بالموبايل وقت ما كان ماكو نت: نستعمل وقت الموبايل ونعلّمها للمراجعة
  let offline = false, when = new Date();
  if (offline_at !== undefined && offline_at !== null) {
    const t = new Date(Number(offline_at));
    if (isNaN(t)) return res.status(400).json({ error: 'وقت البصمة غير صحيح' });
    if (t.getTime() > Date.now() + 2 * 60 * 1000) return res.status(400).json({ error: 'وقت البصمة بالمستقبل، تأكد من ساعة الموبايل' });
    if (Date.now() - t.getTime() > OFFLINE_MAX_DAYS * 24 * 3600 * 1000) return res.status(400).json({ error: `البصمة أقدم من ${OFFLINE_MAX_DAYS} أيام وما تنقبل` });
    if (queued || Date.now() - t.getTime() > 60 * 1000) { offline = true; when = t; }
  }
  const synced = nowParts();
  const syncedAt = `${synced.date} ${synced.time}`;
  const s = getSettings();
  const la = typeof lat === 'number' ? lat : null;
  const ln = typeof lng === 'number' ? lng : null;

  // التحقق من الموقع
  let dist = null;
  if (s.location_lat && s.location_lng) {
    if (la == null || ln == null) return res.status(400).json({ error: 'لازم تسمح بالوصول للموقع حتى تكدر تبصم' });
    dist = distanceM(la, ln, Number(s.location_lat), Number(s.location_lng));
    if (dist > Number(s.location_radius)) {
      return res.status(403).json({ error: `أنت بعيد عن مكان العمل (${Math.round(dist)} متر). البصمة مسموحة بس داخل مكان العمل.` });
    }
  }

  const { date, time } = nowParts(when);
  const rec = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?').get(emp.id, date);
  const tag = offline ? ' (بصمة بدون نت)' : '';
  if (action === 'in') {
    if (rec && rec.check_in && queued) return res.json({ ok: true, duplicate: true, message: 'البصمة مسجّلة مسبقاً' });
    if (rec && rec.check_in) return res.status(400).json({ error: `مسجّل حضورك اليوم من الساعة ${rec.check_in.slice(0, 5)}` });
    if (rec) {
      db.prepare('UPDATE attendance SET check_in = ?, in_lat = ?, in_lng = ?, in_distance = ?, in_offline = ?, in_synced_at = ? WHERE id = ?')
        .run(time, la, ln, dist, offline ? 1 : 0, offline ? syncedAt : null, rec.id);
    } else {
      db.prepare('INSERT INTO attendance(employee_id, work_date, check_in, in_lat, in_lng, in_distance, in_offline, in_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(emp.id, date, time, la, ln, dist, offline ? 1 : 0, offline ? syncedAt : null);
    }
    return res.json({ ok: true, message: `أهلاً ${emp.name}، تم تسجيل حضورك الساعة ${time.slice(0, 5)}${tag}` });
  }
  if (action === 'out') {
    if (!rec || !rec.check_in) return res.status(400).json({ error: 'لازم تسجّل حضور أول' });
    if (rec.check_out && queued) return res.json({ ok: true, duplicate: true, message: 'البصمة مسجّلة مسبقاً' });
    if (rec.check_out) return res.status(400).json({ error: `مسجّل انصرافك اليوم الساعة ${rec.check_out.slice(0, 5)}` });
    if (time < rec.check_in) return res.status(400).json({ error: 'وقت الانصراف قبل وقت الحضور' });
    db.prepare('UPDATE attendance SET check_out = ?, out_lat = ?, out_lng = ?, out_distance = ?, out_offline = ?, out_synced_at = ? WHERE id = ?')
      .run(time, la, ln, dist, offline ? 1 : 0, offline ? syncedAt : null, rec.id);
    return res.json({ ok: true, message: `مع السلامة ${emp.name}، تم تسجيل انصرافك الساعة ${time.slice(0, 5)}${tag}` });
  }
  res.status(400).json({ error: 'عملية غير معروفة' });
});

// ----- المدير -----
const admin = auth('admin');
app.post('/api/admin/login', (req, res) => {
  const a = Buffer.from(String(req.body.password || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  res.json({ token: newSession('admin') });
});

function validateEmployee(body, isNew) {
  const { username, name, password, salary, shift_start, shift_end, overtime_after, shift_id } = body;
  if (shift_id && !shiftById(Number(shift_id))) return 'الدوام غير موجود';
  if (isNew && (!username || !name || !password)) return 'اسم المستخدم والاسم وكلمة المرور مطلوبة';
  if (username !== undefined && !/^[A-Za-z0-9_.-]{2,30}$/.test(String(username))) return 'اسم المستخدم لازم يكون بالإنكليزي أو أرقام بدون فراغات';
  if (password && String(password).length < 4) return 'كلمة المرور لازم 4 أحرف على الأقل';
  for (const t of [shift_start, shift_end, overtime_after]) if (t !== undefined && !TIME_RE.test(t)) return 'صيغة الوقت غير صحيحة';
  if (salary !== undefined && !(Number(salary) >= 0)) return 'الراتب غير صحيح';
  const ss = shift_start, se = shift_end;
  if (ss && se && toMin(se) <= toMin(ss)) return 'نهاية الدوام لازم تكون بعد بدايته';
  return null;
}

app.get('/api/admin/employees', admin, (req, res) => {
  res.json(db.prepare('SELECT * FROM employees ORDER BY active DESC, name').all().map(publicEmp));
});
app.post('/api/admin/employees', admin, (req, res) => {
  const b = req.body;
  const err = validateEmployee(b, true);
  if (err) return res.status(400).json({ error: err });
  try {
    db.prepare(`INSERT INTO employees(username, name, department, job_title, password_hash, salary, shift_start, shift_end, overtime_after, shift_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      String(b.username).trim(), b.name.trim(), (b.department || '').trim(), (b.job_title || '').trim(), hashPassword(b.password),
      Number(b.salary || 0), b.shift_start || '08:00', b.shift_end || '16:00', b.overtime_after || '16:00',
      b.shift_id ? Number(b.shift_id) : null);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'اسم المستخدم مستخدم مسبقاً' });
  }
});
app.put('/api/admin/employees/:id', admin, (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
  if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });
  const b = { ...req.body };
  delete b.username;
  const merged = { ...emp, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined && v !== '')) };
  if ('shift_id' in b) merged.shift_id = b.shift_id ? Number(b.shift_id) : null;
  const err = validateEmployee({ ...b, shift_start: merged.shift_start, shift_end: merged.shift_end }, false);
  if (err) return res.status(400).json({ error: err });
  db.prepare(`UPDATE employees SET name = ?, department = ?, job_title = ?, salary = ?, shift_start = ?, shift_end = ?,
    overtime_after = ?, shift_id = ?, active = ?, password_hash = ? WHERE id = ?`).run(
    merged.name, merged.department ?? '', merged.job_title ?? '', Number(merged.salary), merged.shift_start, merged.shift_end,
    merged.overtime_after, merged.shift_id ?? null, b.active === undefined ? emp.active : (b.active ? 1 : 0),
    b.password ? hashPassword(b.password) : emp.password_hash, emp.id);
  if (b.reset_device) db.prepare('UPDATE employees SET device_id = NULL, device_at = NULL WHERE id = ?').run(emp.id);
  if (b.active === 0 || b.active === false || b.password || b.reset_device) {
    db.prepare("DELETE FROM sessions WHERE kind = 'employee' AND employee_id = ?").run(emp.id);
  }
  res.json({ ok: true });
});

function activeEmployees(employeeId) {
  return db.prepare('SELECT * FROM employees WHERE active = 1' + (employeeId ? ' AND id = ?' : '') + ' ORDER BY name')
    .all(...(employeeId ? [Number(employeeId)] : []));
}
function report(from, to, employeeId) {
  const rows = [];
  const emps = activeEmployees(employeeId);
  const byEmp = emps.map((e) => [e, employeeDays(e, from, to)]);
  for (const date of datesBetween(from, to)) {
    for (const [e, days] of byEmp) {
      const d = days.find((x) => x.work_date === date);
      rows.push({ ...d, employee_id: e.id, username: e.username, name: e.name, department: e.department });
    }
  }
  return rows;
}

app.get('/api/admin/today', admin, (req, res) => {
  const { date } = nowParts();
  res.json({ date, rows: report(date, date) });
});
app.get('/api/admin/report', admin, (req, res) => {
  const { from, to, employee_id } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) return res.status(400).json({ error: 'حدد فترة صحيحة' });
  res.json(report(from, to, employee_id));
});
app.get('/api/admin/report.csv', admin, (req, res) => {
  const { from, to, employee_id } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) return res.status(400).send('bad range');
  const rows = report(from, to, employee_id);
  const head = ['التاريخ', 'المستخدم', 'الاسم', 'القسم', 'الحضور', 'الانصراف', 'الحالة', 'دقائق التأخير', 'ساعات العمل', 'ساعات الأوفر تايم', 'بصمة بدون نت'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const h = (m) => (m == null ? '' : (m / 60).toFixed(2));
  const lines = rows.map((r) => [r.work_date, r.username, r.name, r.department, r.check_in || '', r.check_out || '', r.status,
    r.late_minutes, h(r.worked_minutes), h(r.overtime_minutes),
    [r.in_offline ? `حضور (وصلت ${r.in_synced_at})` : '', r.out_offline ? `انصراف (وصلت ${r.out_synced_at})` : ''].filter(Boolean).join(' / ')].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_${to}.csv"`);
  res.send('﻿' + [head.map(esc).join(','), ...lines].join('\n'));
});

// الرواتب
function payrollList(month) {
  const rows = activeEmployees().map((e) => ({ employee: publicEmp(e), summary: payroll(e, month).summary }));
  const sum = (k) => rows.reduce((a, r) => a + (r.summary[k] || 0), 0);
  const totals = Object.fromEntries(['base_salary', 'attendance_pay', 'late_deduction', 'overtime_pay', 'bonus', 'gross_salary', 'advance', 'net_salary',
    'present_days', 'absent_days', 'paid_leave_days', 'late_after_allowance', 'overtime_minutes'].map((k) => [k, sum(k)]));
  return { rows, totals };
}
app.get('/api/admin/payroll', admin, (req, res) => {
  const month = req.query.month;
  if (!MONTH_RE.test(month || '')) return res.status(400).json({ error: 'حدد الشهر' });
  res.json(payrollList(month));
});
app.get('/api/admin/payroll.csv', admin, (req, res) => {
  const month = req.query.month;
  if (!MONTH_RE.test(month || '')) return res.status(400).send('bad month');
  const { rows, totals } = payrollList(month);
  const head = ['اسم الموظف', 'القسم', 'الراتب الشهري', 'الدوام', 'اليومية', 'أيام الحضور', 'أيام الغياب', 'أيام الإجازة المدفوعة', 'إجازة بدون راتب',
    'مجموع التأخير (دقيقة)', 'التأخير بعد السماحية (دقيقة)', 'الإضافي (دقيقة)', 'راتب أيام الحضور', 'خصم التأخير', 'مبلغ الإضافي', 'المكافآت',
    'إجمالي الراتب المستحق (قبل السلف)', 'السلف (تُستقطع)', 'صافي الراتب (المبلغ المدفوع)', 'ملاحظات'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map(({ employee: e, summary: s }) => [e.name, e.department, s.base_salary, e.shift_name, s.daily_rate, s.present_days, s.absent_days,
    s.paid_leave_days, s.unpaid_leave_days, s.late_minutes, s.late_after_allowance, s.overtime_minutes, s.attendance_pay, s.late_deduction,
    s.overtime_pay, s.bonus, s.gross_salary, s.advance, s.net_salary, s.adjustment_note].map(esc).join(','));
  lines.push(['المجموع', '', totals.base_salary, '', '', totals.present_days, totals.absent_days, totals.paid_leave_days, '', '', totals.late_after_allowance,
    totals.overtime_minutes, totals.attendance_pay, totals.late_deduction, totals.overtime_pay, totals.bonus, totals.gross_salary, totals.advance, totals.net_salary, '']
    .map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payroll_${month}.csv"`);
  res.send('\uFEFF' + [head.map(esc).join(','), ...lines].join('\n'));
});
// السلف والمكافآت
app.put('/api/admin/adjustments', admin, (req, res) => {
  const { employee_id, month, advance, bonus, note } = req.body;
  if (!MONTH_RE.test(month || '')) return res.status(400).json({ error: 'حدد الشهر' });
  if (!db.prepare('SELECT id FROM employees WHERE id = ?').get(Number(employee_id))) return res.status(400).json({ error: 'الموظف غير موجود' });
  if (!(Number(advance || 0) >= 0) || !(Number(bonus || 0) >= 0)) return res.status(400).json({ error: 'المبلغ غير صحيح' });
  db.prepare(`INSERT INTO adjustments(employee_id, month, advance, bonus, note) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(employee_id, month) DO UPDATE SET advance = excluded.advance, bonus = excluded.bonus, note = excluded.note`)
    .run(Number(employee_id), month, Number(advance || 0), Number(bonus || 0), String(note || '').trim());
  res.json({ ok: true });
});
// الدوامات
const validShift = (b) => {
  if (!String(b.name || '').trim()) return 'اكتب اسم الدوام';
  for (const t of [b.start, b.end, b.overtime_after]) if (!TIME_RE.test(t || '')) return 'صيغة الوقت غير صحيحة';
  if (toMin(b.end) <= toMin(b.start)) return 'نهاية الدوام لازم تكون بعد بدايته';
  return null;
};
app.get('/api/admin/shifts', admin, (req, res) => {
  res.json(db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM employees e WHERE e.shift_id = s.id AND e.active = 1) AS employees FROM shifts s ORDER BY start`).all());
});
app.post('/api/admin/shifts', admin, (req, res) => {
  const err = validShift(req.body); if (err) return res.status(400).json({ error: err });
  const b = req.body;
  db.prepare('INSERT INTO shifts(name, start, end, overtime_after) VALUES (?, ?, ?, ?)').run(b.name.trim(), b.start, b.end, b.overtime_after);
  res.json({ ok: true });
});
app.put('/api/admin/shifts/:id', admin, (req, res) => {
  const err = validShift(req.body); if (err) return res.status(400).json({ error: err });
  const b = req.body;
  const r = db.prepare('UPDATE shifts SET name = ?, start = ?, end = ?, overtime_after = ? WHERE id = ?').run(b.name.trim(), b.start, b.end, b.overtime_after, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'الدوام غير موجود' });
  res.json({ ok: true });
});
app.delete('/api/admin/shifts/:id', admin, (req, res) => {
  const used = db.prepare('SELECT COUNT(*) AS c FROM employees WHERE shift_id = ?').get(Number(req.params.id)).c;
  if (used) return res.status(400).json({ error: `الدوام مستعمل لـ ${used} موظف، غيّر دوامهم أول` });
  db.prepare('DELETE FROM shifts WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
app.get('/api/admin/payslip', admin, (req, res) => {
  const { month, employee_id } = req.query;
  if (!MONTH_RE.test(month || '')) return res.status(400).json({ error: 'حدد الشهر' });
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(employee_id));
  if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });
  res.json({ employee: publicEmp(emp), company_name: getSettings().company_name, ...payroll(emp, month) });
});

// الإجازات المدفوعة
app.get('/api/admin/leaves', admin, (req, res) => {
  const month = MONTH_RE.test(req.query.month || '') ? req.query.month : nowParts().date.slice(0, 7);
  const { from, to } = monthRange(month);
  res.json(db.prepare(`SELECT l.*, e.name FROM leaves l JOIN employees e ON e.id = l.employee_id
    WHERE leave_date BETWEEN ? AND ? ORDER BY leave_date, e.name`).all(from, to));
});
app.post('/api/admin/leaves', admin, (req, res) => {
  const { employee_id, from, to, note } = req.body;
  const paid = req.body.paid === false || req.body.paid === 0 || req.body.paid === '0' ? 0 : 1;
  const end = to || from;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(end) || from > end) return res.status(400).json({ error: 'حدد التاريخ' });
  const ids = employee_id === 'all' ? activeEmployees().map((e) => e.id) : [Number(employee_id)];
  if (employee_id !== 'all' && !db.prepare('SELECT id FROM employees WHERE id = ?').get(ids[0])) return res.status(400).json({ error: 'اختار الموظف' });
  const days = datesBetween(from, end);
  if (days.length > 60) return res.status(400).json({ error: 'الفترة طويلة جداً' });
  const ins = db.prepare('INSERT OR REPLACE INTO leaves(employee_id, leave_date, note, paid) VALUES (?, ?, ?, ?)');
  for (const id of ids) for (const d of days) ins.run(id, d, (note || '').trim(), paid);
  res.json({ ok: true, count: days.length, employees: ids.length });
});
app.delete('/api/admin/leaves/:id', admin, (req, res) => {
  db.prepare('DELETE FROM leaves WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// الإعدادات
app.get('/api/admin/settings', admin, (req, res) => {
  const s = getSettings(); delete s.vapid_private; res.json(s);
});
app.put('/api/admin/settings', admin, (req, res) => {
  const b = req.body;
  const s = { ...getSettings() };
  if (b.company_name !== undefined) s.company_name = String(b.company_name).trim();
  for (const [k, label] of [['late_allowance', 'السماحية الشهرية'], ['late_hour_rate', 'سعر ساعة التأخير'], ['overtime_hour_rate', 'سعر ساعة الإضافي']]) {
    if (b[k] === undefined) continue;
    if (!(Number(b[k]) >= 0)) return res.status(400).json({ error: `${label} غير صحيح` });
    s[k] = String(Number(b[k]));
  }
  if (b.weekend_days !== undefined) {
    if (!/^([0-6](,[0-6])*)?$/.test(b.weekend_days)) return res.status(400).json({ error: 'أيام العطلة غير صحيحة' });
    s.weekend_days = b.weekend_days;
  }
  if (b.month_days !== undefined) {
    if (!(Number(b.month_days) >= 1 && Number(b.month_days) <= 31)) return res.status(400).json({ error: 'عدد أيام الشهر غير صحيح' });
    s.month_days = String(Number(b.month_days));
  }
  if (b.location_lat !== undefined || b.location_lng !== undefined) {
    const la = b.location_lat === '' ? '' : Number(b.location_lat);
    const ln = b.location_lng === '' ? '' : Number(b.location_lng);
    if (la !== '' && !(la >= -90 && la <= 90)) return res.status(400).json({ error: 'خط العرض غير صحيح' });
    if (ln !== '' && !(ln >= -180 && ln <= 180)) return res.status(400).json({ error: 'خط الطول غير صحيح' });
    s.location_lat = String(la); s.location_lng = String(ln);
  }
  for (const k of ['remind_before', 'remind_late', 'remind_out_after']) {
    if (b[k] === undefined) continue;
    if (!(Number(b[k]) >= 0 && Number(b[k]) <= 240)) return res.status(400).json({ error: 'وقت التنبيه غير صحيح' });
    s[k] = String(Number(b[k]));
  }
  if (b.device_lock !== undefined) s.device_lock = b.device_lock ? '1' : '0';
  if (b.location_radius !== undefined) {
    if (!(Number(b.location_radius) >= 10)) return res.status(400).json({ error: 'نصف القطر لازم 10 متر أو أكثر' });
    s.location_radius = String(Number(b.location_radius));
  }
  const up = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  for (const k of Object.keys(DEFAULT_SETTINGS)) up.run(s[k], k);
  res.json({ ok: true });
});

// ---------- الإشعارات ----------
app.get('/api/push/key', (req, res) => res.json({ key: VAPID_PUBLIC }));
app.post('/api/me/push', auth('employee'), async (req, res) => {
  const sub = req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return res.status(400).json({ error: 'اشتراك غير صالح' });
  db.prepare('INSERT OR REPLACE INTO push_subs(employee_id, endpoint, data) VALUES (?, ?, ?)')
    .run(req.emp.id, sub.endpoint, JSON.stringify(sub));
  await sendPush(req.emp.id, 'تم تفعيل التنبيهات ✅', 'راح نذكّرك بالبصمة قبل الدوام وبعد نهايته.');
  res.json({ ok: true });
});
app.get('/api/me/push', auth('employee'), (req, res) => {
  res.json({ count: db.prepare('SELECT COUNT(*) AS c FROM push_subs WHERE employee_id = ?').get(req.emp.id).c });
});

async function sendPush(employeeId, title, body) {
  const subs = db.prepare('SELECT * FROM push_subs WHERE employee_id = ?').all(employeeId);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.data), JSON.stringify({ title, body, url: '/' }), { TTL: 3600 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
    }
  }
  return sent;
}

// يفحص كل دقيقة منو يحتاج تذكير
async function reminderTick() {
  const s = getSettings();
  const { date, time } = nowParts();
  const now = toMin(time);
  const weekend = s.weekend_days.split(',').filter(Boolean).map(Number);
  if (weekend.includes(new Date(date + 'T00:00:00Z').getUTCDay())) return;
  const emps = db.prepare(`SELECT e.* FROM employees e WHERE e.active = 1
    AND EXISTS (SELECT 1 FROM push_subs p WHERE p.employee_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM leaves l WHERE l.employee_id = e.id AND l.leave_date = ?)`).all(date);
  const logged = db.prepare('INSERT OR IGNORE INTO notif_log(employee_id, work_date, kind) VALUES (?, ?, ?)');
  for (const e0 of emps) {
    const e = withShift(e0);
    const rec = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?').get(e.id, date);
    const start = toMin(e.shift_start), end = toMin(e.shift_end);
    const jobs = [];
    if (!rec?.check_in && now >= start - Number(s.remind_before) && now < start) {
      jobs.push(['in_before', 'لا تنسى تبصم حضور ⏰', `دوامك يبدي الساعة ${e.shift_start}`]);
    }
    if (!rec?.check_in && now >= start + Number(s.remind_late) && now < end) {
      jobs.push(['in_late', 'ما مسجّل حضورك لحد الآن ⚠️', 'إذا إنت بالدوام، افتح البرنامج وبصم حضور.']);
    }
    if (rec?.check_in && !rec.check_out && now >= end + Number(s.remind_out_after) && now < 24 * 60) {
      jobs.push(['out', 'لا تنسى تبصم انصراف 👋', `دوامك خلص الساعة ${e.shift_end}`]);
    }
    for (const [kind, title, body] of jobs) {
      if (logged.run(e.id, date, kind).changes) await sendPush(e.id, title, body);
    }
  }
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`Attendance app running on http://localhost:${PORT}`));
  setInterval(() => reminderTick().catch((e) => console.error('reminder error', e)), 60 * 1000);
}
module.exports = { app, db, distanceM, nowParts, reminderTick };
