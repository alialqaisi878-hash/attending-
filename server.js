// برنامج الحضور والانصراف للشركات - الخادم الرئيسي
// كل شركة إلها رابط خاص:  https://الدومين/رمز-الشركة/
// وصاحب البرنامج يدير الشركات والاشتراكات من:  https://الدومين/super
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const webpush = require('web-push');
const { createTenant } = require('./lib/tenant');
const { hashPassword, checkPassword, randomPassword, loginLimiter } = require('./lib/util');
const { DEMO_SLUG, seedDemo } = require('./lib/demo');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DELETED_DIR = path.join(DATA_DIR, 'deleted');
const MEMORY = DATA_DIR === ':memory:'; // للاختبارات
const SITE_DIR = path.join(__dirname, 'site');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BACKUP_KEEP_DAYS = 14;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;
const RESERVED = new Set([DEMO_SLUG, 'super', 'api', 'admin', 'www', 'app', 'static', 'assets', 'login', 'help', 'support', 'demo-admin']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

if (!MEMORY) for (const d of [DATA_DIR, TENANTS_DIR, BACKUP_DIR, DELETED_DIR]) fs.mkdirSync(d, { recursive: true });
const master = new DatabaseSync(MEMORY ? ':memory:' : path.join(DATA_DIR, 'master.db'));
master.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS companies (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,                 -- آخر يوم بالاشتراك (YYYY-MM-DD)، فارغ = بدون انتهاء
    max_employees INTEGER NOT NULL DEFAULT 0,  -- 0 = بدون حد
    price REAL NOT NULL DEFAULT 0,   -- سعر الاشتراك الشهري (للمتابعة بس)
    contact_name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    max_employees INTEGER NOT NULL DEFAULT 0,  -- 0 = مفتوح
    months INTEGER NOT NULL DEFAULT 1,         -- مدة الباقة
    price REAL NOT NULL DEFAULT 0,             -- سعر الباقة كاملة
    active INTEGER NOT NULL DEFAULT 1,         -- تطلع للزبائن
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS super_sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS master_settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS payments (     -- دفعات الاشتراك: الشركة ترسل الوصل وصاحب البرنامج يوافق
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL, plan_id INTEGER NOT NULL, plan_name TEXT, amount REAL,
    method TEXT DEFAULT '', reference TEXT DEFAULT '', receipt TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    reply TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS super_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime('now')), slug TEXT, what TEXT NOT NULL
  );
`);
{
  const cols = master.prepare('PRAGMA table_info(companies)').all().map((c) => c.name);
  for (const [c, def] of [['plan_id', 'INTEGER'], ['plan_name', "TEXT DEFAULT ''"], ['trial', 'INTEGER NOT NULL DEFAULT 0'], ['self_signup', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!cols.includes(c)) master.exec(`ALTER TABLE companies ADD COLUMN ${c} ${def}`);
  }
}
const mget = (k) => (master.prepare('SELECT value FROM master_settings WHERE key = ?').get(k) || {}).value;
const mset = (k, v) => master.prepare('INSERT INTO master_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
const MASTER_DEFAULTS = {
  product_name: process.env.PRODUCT_NAME || 'بصمة', support_phone: process.env.SUPPORT_PHONE || '',
  signup_enabled: '1',   // أي واحد يكدر يسجّل شركته من الصفحة الرئيسية
  trial_days: '14',      // مدة التجربة المجانية
  trial_employees: '1',  // عدد الموظفين بالتجربة
  pay_info: '',          // طرق الدفع اللي تطلع للشركات (زين كاش، كي كارد، تحويل...)
};
for (const [k, v] of Object.entries(MASTER_DEFAULTS)) {
  if (mget(k) === undefined) mset(k, v);
}
// باسورد صاحب البرنامج: من SUPER_PASSWORD أول مرة، وبعدين يتغير من اللوحة
if (!mget('super_hash')) {
  const pw = process.env.SUPER_PASSWORD || (MEMORY ? 'super-secret' : null);
  if (!pw) { console.error('SUPER_PASSWORD is required on first start'); process.exit(1); }
  mset('super_hash', hashPassword(pw));
}
// مفاتيح الإشعارات: وحدة لكل البرنامج (كل الشركات على نفس الدومين)
if (!mget('vapid_public')) { const k = webpush.generateVAPIDKeys(); mset('vapid_public', k.publicKey); mset('vapid_private', k.privateKey); }
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', mget('vapid_public'), mget('vapid_private'));

// ---------- الشركات ----------
const getCompany = (slug) => master.prepare('SELECT * FROM companies WHERE slug = ?').get(slug);
const tenants = new Map();
function tenantDbPath(slug) { return MEMORY ? ':memory:' : path.join(TENANTS_DIR, slug + '.db'); }
function openTenant(slug) {
  let t = tenants.get(slug);
  if (!t) {
    t = createTenant({ slug, dbPath: tenantDbPath(slug), company: () => ({ ...companyStatus(getCompany(slug) || {}, t), support_phone: mget('support_phone') }), vapidPublic: mget('vapid_public') });
    tenants.set(slug, t);
  }
  return t;
}
// حالة الاشتراك: active | suspended | expired
function companyStatus(c, t) {
  const today = t ? t.nowParts().date : new Date().toISOString().slice(0, 10);
  let status = 'active';
  if (!c.active) status = 'suspended';
  else if (c.expires_at && today > c.expires_at) status = 'expired';
  const days_left = c.expires_at ? Math.round((new Date(c.expires_at + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 864e5) : null;
  return { ...c, status, days_left };
}
function statusMessage(st) {
  const phone = mget('support_phone');
  const contact = phone ? ` تواصل ويانا على ${phone}.` : ' تواصل ويا الشركة المزودة للبرنامج.';
  if (st === 'suspended') return 'حساب الشركة موقوف حالياً.' + contact;
  if (st === 'expired') return 'انتهى اشتراك الشركة بالبرنامج. البيانات محفوظة وترجع أول ما يتجدد الاشتراك.' + contact;
  return '';
}

// ---------- الشركة التجريبية (محاكاة) ----------
function ensureDemo() {
  if (!getCompany(DEMO_SLUG)) {
    master.prepare("INSERT INTO companies(slug, name, max_employees, notes) VALUES (?, 'شركة المستقبل (تجريبية)', 10, 'شركة تجريبية للعرض، ترجع كل يوم')").run(DEMO_SLUG);
    openTenant(DEMO_SLUG).setAdminPassword(randomPassword(16));
  }
  seedDemo(openTenant(DEMO_SLUG));
}
// كل يوم نمسح الشركة التجريبية ونرجّع بياناتها
function resetDemo() {
  const t = tenants.get(DEMO_SLUG);
  if (t) { t.close(); tenants.delete(DEMO_SLUG); }
  if (!MEMORY) for (const ext of ['.db', '.db-wal', '.db-shm']) fs.rmSync(path.join(TENANTS_DIR, DEMO_SLUG + ext), { force: true });
  master.prepare('DELETE FROM companies WHERE slug = ?').run(DEMO_SLUG);
  ensureDemo();
}
ensureDemo();

// ---------- التطبيق ----------
const app = express();
app.set('trust proxy', 1); // ورا Traefik: نعرف عنوان الزبون الحقيقي لحماية الدخول
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// تطبيق التلفون (أندرويد/آيفون) يكلّم السيرفر من داخل التطبيق
const APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost', ...(process.env.EXTRA_ORIGINS || '').split(',').filter(Boolean)]);
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && APP_ORIGINS.has(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '1mb' }));

// الصفحة الرئيسية للبرنامج (تعريف + دخول برمز الشركة)
app.get('/', (req, res) => res.sendFile(path.join(SITE_DIR, 'index.html')));
app.get('/api/product', (req, res) => res.json({ product_name: mget('product_name'), support_phone: mget('support_phone') }));
app.get('/api/company/:slug', (req, res) => {
  const c = getCompany(String(req.params.slug).toLowerCase());
  if (!c) return res.status(404).json({ error: 'رمز الشركة غير موجود' });
  res.json({ slug: c.slug });
});
const publicPlans = () => master.prepare('SELECT id, name, max_employees, months, price FROM plans WHERE active = 1 ORDER BY sort, price').all();
app.get('/api/plans', (req, res) => res.json({ plans: publicPlans(), trial_days: Number(mget('trial_days')), trial_employees: Number(mget('trial_employees')), signup_enabled: mget('signup_enabled') === '1' }));

// تسجيل شركة جديدة من الصفحة الرئيسية: تفتح تجربة مجانية فوراً
const signupLimiter = { ...loginLimiter, max: 5, windowMs: 24 * 3600 * 1000, hits: new Map() };
function randomSlug() {
  for (;;) { const s = 'c' + crypto.randomBytes(3).toString('hex'); if (!getCompany(s)) return s; }
}
app.post('/api/signup', (req, res) => {
  if (mget('signup_enabled') !== '1') return res.status(403).json({ error: 'التسجيل متوقف حالياً. تواصل ويانا.' });
  const key = 'signup:' + req.ip;
  if (signupLimiter.blocked(key)) return res.status(429).json({ error: 'سجّلت أكثر من مرة اليوم. تواصل ويانا إذا تحتاج شركة ثانية.' });
  const b = req.body || {};
  const name = String(b.company_name || '').trim();
  const phone = String(b.phone || '').replace(/[^0-9+]/g, '');
  const password = String(b.password || '');
  let slug = String(b.slug || '').trim().toLowerCase();
  if (!name || name.length > 80) return res.status(400).json({ error: 'اكتب اسم الشركة' });
  if (!/^\+?[0-9]{7,15}$/.test(phone)) return res.status(400).json({ error: 'اكتب رقم تلفون صحيح' });
  if (password.length < 8) return res.status(400).json({ error: 'الباسورد لازم 8 أحرف على الأقل' });
  if (slug) {
    const err = validCompany({ slug, name }, true);
    if (err) return res.status(400).json({ error: err });
  } else slug = randomSlug();
  const d = new Date(today() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(mget('trial_days') || 14));
  const c = createCompany({ slug, name, expires_at: d.toISOString().slice(0, 10), max_employees: Number(mget('trial_employees') || 1),
    contact_name: String(b.contact_name || '').trim().slice(0, 80), phone, notes: '', trial: 1, self_signup: 1 }, password);
  signupLimiter.fail(key);
  slog(slug, `تسجيل ذاتي: ${name} (${phone})`);
  res.json({ ok: true, slug, expires_at: c.expires_at, token: openTenant(slug).supportSession(), url: `/${slug}/` });
});
for (const f of ['style.css', 'icon.svg']) app.get('/' + f, (req, res) => res.sendFile(path.join(PUBLIC_DIR, f)));
// زر «جرّب» بالصفحة الرئيسية والتطبيق: يفتح الشركة التجريبية كمدير أو كموظف
app.post('/api/demo', (req, res) => {
  const t = openTenant(DEMO_SLUG);
  const as = (req.body || {}).as === 'employee' ? 'employee' : 'admin';
  const token = as === 'employee' ? t.employeeSession('ahmed') : t.supportSession();
  res.json({ slug: DEMO_SLUG, as, token, url: as === 'employee' ? `/${DEMO_SLUG}/#emp=${token}` : `/${DEMO_SLUG}/admin.html#support=${token}` });
});
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ----- لوحة صاحب البرنامج -----
app.get('/super', (req, res) => res.sendFile(path.join(SITE_DIR, 'super.html')));
const superAuth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = master.prepare('SELECT * FROM super_sessions WHERE token = ?').get(token);
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'سجّل دخول' });
  req.token = token; next();
};
const slog = (slug, what) => master.prepare('INSERT INTO super_log(slug, what) VALUES (?, ?)').run(slug, what);
app.post('/super/api/login', (req, res) => {
  const key = 'super:' + req.ip;
  if (loginLimiter.blocked(key)) return res.status(429).json({ error: 'محاولات كثيرة. انتظر ربع ساعة.' });
  if (!checkPassword(String(req.body.password || ''), mget('super_hash'))) { loginLimiter.fail(key); return res.status(401).json({ error: 'كلمة المرور غير صحيحة' }); }
  const token = crypto.randomBytes(24).toString('hex');
  master.prepare('INSERT INTO super_sessions(token, expires) VALUES (?, ?)').run(token, Date.now() + 7 * 24 * 3600 * 1000);
  res.json({ token });
});
app.post('/super/api/logout', superAuth, (req, res) => { master.prepare('DELETE FROM super_sessions WHERE token = ?').run(req.token); res.json({ ok: true }); });

function companyRow(c) {
  const t = openTenant(c.slug);
  const st = companyStatus(c, t);
  let stats = {};
  try { stats = t.stats(); } catch (e) { stats = { error: e.message }; }
  return { ...st, ...stats, name: c.name };
}
app.get('/super/api/companies', superAuth, (req, res) => {
  const rows = master.prepare('SELECT * FROM companies WHERE slug != ? ORDER BY created_at DESC').all(DEMO_SLUG).map(companyRow);
  const live = rows.filter((r) => r.status === 'active');
  res.json({
    rows,
    totals: { companies: rows.length, active: live.length, employees: live.reduce((a, r) => a + (r.employees || 0), 0),
      monthly_income: live.filter((r) => !r.trial).reduce((a, r) => a + Number(r.price || 0), 0), trials: live.filter((r) => r.trial).length, expiring_soon: live.filter((r) => r.days_left != null && r.days_left <= 7).length },
  });
});
function validCompany(b, isNew) {
  if (isNew) {
    const slug = String(b.slug || '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) return 'رمز الشركة: حروف إنگليزية صغيرة وأرقام وشرطة (-)، من 2 إلى 30 حرف';
    if (RESERVED.has(slug)) return 'هذا الرمز محجوز، اختار غيره';
    if (getCompany(slug)) return 'الرمز مستعمل لشركة ثانية';
    if (!String(b.name || '').trim()) return 'اكتب اسم الشركة';
  }
  if (b.name !== undefined && !String(b.name).trim()) return 'اكتب اسم الشركة';
  if (b.expires_at !== undefined && b.expires_at !== '' && b.expires_at !== null && !DATE_RE.test(b.expires_at)) return 'تاريخ الانتهاء غير صحيح';
  if (b.max_employees !== undefined && !(Number(b.max_employees) >= 0)) return 'عدد الموظفين غير صحيح';
  if (b.price !== undefined && !(Number(b.price) >= 0)) return 'السعر غير صحيح';
  if (b.admin_password && String(b.admin_password).length < 8) return 'باسورد المدير لازم 8 أحرف على الأقل';
  return null;
}
const addMonths = (date, n) => {
  const d = new Date(date + 'T00:00:00Z'); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });

function createCompany(c, password) {
  master.prepare(`INSERT INTO companies(slug, name, expires_at, max_employees, price, contact_name, phone, notes, trial, self_signup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.slug, c.name, c.expires_at, c.max_employees, c.price || 0, c.contact_name || '', c.phone || '', c.notes || '', c.trial ? 1 : 0, c.self_signup ? 1 : 0);
  const t = openTenant(c.slug);
  t.db.prepare("UPDATE settings SET value = ? WHERE key = 'company_name'").run(c.name);
  t.setAdminPassword(password);
  return c;
}
app.post('/super/api/companies', superAuth, (req, res) => {
  const b = req.body || {};
  const err = validCompany(b, true);
  if (err) return res.status(400).json({ error: err });
  const slug = String(b.slug).trim().toLowerCase();
  const name = String(b.name).trim();
  // الافتراضي: تجربة مجانية حسب الإعدادات
  const trialEnd = () => { const d = new Date(today() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(mget('trial_days') || 14)); return d.toISOString().slice(0, 10); };
  const expires = b.expires_at === undefined ? trialEnd() : (b.expires_at || null);
  const password = b.admin_password ? String(b.admin_password) : randomPassword(10);
  createCompany({ slug, name, expires_at: expires, max_employees: Number(b.max_employees || 0), price: Number(b.price || 0),
    contact_name: String(b.contact_name || '').trim(), phone: String(b.phone || '').trim(), notes: String(b.notes || '').trim(), trial: b.expires_at === undefined && !Number(b.price || 0) ? 1 : 0 }, password);
  slog(slug, `إضافة شركة ${name}`);
  res.json({ ok: true, slug, admin_password: password, expires_at: expires });
});
// ----- الباقات -----
function validPlan(b) {
  if (!String(b.name || '').trim()) return 'اكتب اسم الباقة';
  if (!(Number(b.max_employees) >= 0)) return 'عدد الموظفين غير صحيح';
  if (!(Number(b.months) >= 1 && Number(b.months) <= 36)) return 'المدة من 1 إلى 36 شهر';
  if (!(Number(b.price) >= 0)) return 'السعر غير صحيح';
  return null;
}
app.get('/super/api/plans', superAuth, (req, res) => res.json(master.prepare(`SELECT p.*, (SELECT COUNT(*) FROM companies c WHERE c.plan_id = p.id) AS companies FROM plans p ORDER BY sort, price`).all()));
app.post('/super/api/plans', superAuth, (req, res) => {
  const b = req.body || {}; const err = validPlan(b); if (err) return res.status(400).json({ error: err });
  const r = master.prepare('INSERT INTO plans(name, max_employees, months, price, active, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(b.name).trim(), Number(b.max_employees), Number(b.months), Number(b.price), b.active === false || b.active === 0 ? 0 : 1, Number(b.sort || 0));
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
app.put('/super/api/plans/:id', superAuth, (req, res) => {
  const b = req.body || {}; const err = validPlan(b); if (err) return res.status(400).json({ error: err });
  const r = master.prepare('UPDATE plans SET name = ?, max_employees = ?, months = ?, price = ?, active = ?, sort = ? WHERE id = ?')
    .run(String(b.name).trim(), Number(b.max_employees), Number(b.months), Number(b.price), b.active === false || b.active === 0 ? 0 : 1, Number(b.sort || 0), Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'الباقة غير موجودة' });
  res.json({ ok: true });
});
app.delete('/super/api/plans/:id', superAuth, (req, res) => {
  // الشركات اللي عليها الباقة تبقى على نفس حدودها، بس الباقة ما تطلع بعد
  master.prepare('DELETE FROM plans WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
// تفعيل باقة: حد الموظفين وسعرها، والمدة تنضاف لنهاية الاشتراك (أو من اليوم إذا كان تجربة أو منتهي)
function applyPlan(n, c, p) {
  const from = !c.trial && n.expires_at && n.expires_at >= today() ? n.expires_at : today();
  n.expires_at = addMonths(from, p.months);
  n.max_employees = p.max_employees; n.price = p.months ? Math.round(p.price / p.months) : p.price;
  n.plan_id = p.id; n.plan_name = p.name; n.trial = 0; n.active = 1;
}
function activatePlan(slug, planId) {
  const c = getCompany(slug), p = master.prepare('SELECT * FROM plans WHERE id = ?').get(Number(planId));
  if (!c || !p) return null;
  const n = { ...c }; applyPlan(n, c, p);
  master.prepare('UPDATE companies SET expires_at = ?, max_employees = ?, price = ?, active = 1, plan_id = ?, plan_name = ?, trial = 0 WHERE slug = ?')
    .run(n.expires_at, n.max_employees, n.price, n.plan_id, n.plan_name, slug);
  slog(slug, `تفعيل باقة ${p.name} لحد ${n.expires_at}`);
  return n;
}
app.put('/super/api/companies/:slug', superAuth, (req, res) => {
  const c = getCompany(req.params.slug);
  if (!c) return res.status(404).json({ error: 'الشركة غير موجودة' });
  const b = req.body || {};
  const err = validCompany(b, false);
  if (err) return res.status(400).json({ error: err });
  const n = { ...c };
  for (const k of ['name', 'contact_name', 'phone', 'notes']) if (b[k] !== undefined) n[k] = String(b[k]).trim();
  if (b.expires_at !== undefined) n.expires_at = b.expires_at || null;
  if (b.max_employees !== undefined) n.max_employees = Number(b.max_employees);
  if (b.price !== undefined) n.price = Number(b.price);
  if (b.active !== undefined) n.active = b.active ? 1 : 0;
  if (b.plan_id) {
    const p = master.prepare('SELECT * FROM plans WHERE id = ?').get(Number(b.plan_id));
    if (!p) return res.status(400).json({ error: 'الباقة غير موجودة' });
    applyPlan(n, c, p);
  }
  if (b.extend_months) {
    const m = Number(b.extend_months);
    if (!(m >= 1 && m <= 36)) return res.status(400).json({ error: 'مدة التجديد غير صحيحة' });
    // التجديد يبدي من نهاية الاشتراك الحالي، أو من اليوم إذا كان منتهي
    const from = n.expires_at && n.expires_at >= today() ? n.expires_at : today();
    n.expires_at = addMonths(from, m);
    n.trial = 0; // تجديد يدوي = اشتراك مدفوع
  }
  master.prepare('UPDATE companies SET name = ?, contact_name = ?, phone = ?, notes = ?, expires_at = ?, max_employees = ?, price = ?, active = ?, plan_id = ?, plan_name = ?, trial = ? WHERE slug = ?')
    .run(n.name, n.contact_name, n.phone, n.notes, n.expires_at, n.max_employees, n.price, n.active, n.plan_id ?? null, n.plan_name || '', n.trial ? 1 : 0, c.slug);
  const changes = [];
  if (b.plan_id) changes.push(`تفعيل باقة ${n.plan_name}`);
  if (n.active !== c.active) changes.push(n.active ? 'تفعيل' : 'إيقاف');
  if (n.expires_at !== c.expires_at) changes.push(`الاشتراك لحد ${n.expires_at || 'بدون انتهاء'}`);
  if (n.max_employees !== c.max_employees) changes.push(`حد الموظفين ${n.max_employees || 'مفتوح'}`);
  let password = null;
  if (b.reset_password) {
    password = b.admin_password ? String(b.admin_password) : randomPassword(10);
    openTenant(c.slug).setAdminPassword(password);
    changes.push('باسورد مدير جديد');
  }
  if (changes.length) slog(c.slug, changes.join('، '));
  res.json({ ok: true, expires_at: n.expires_at, admin_password: password });
});
// دخول الدعم الفني: يفتح لوحة مدير الشركة بدون ما تعرف باسوردها
app.post('/super/api/companies/:slug/support-login', superAuth, (req, res) => {
  const c = getCompany(req.params.slug);
  if (!c) return res.status(404).json({ error: 'الشركة غير موجودة' });
  slog(c.slug, 'دخول دعم فني للوحة المدير');
  res.json({ url: `/${c.slug}/admin.html#support=${openTenant(c.slug).supportSession()}` });
});
// حذف شركة: لازم تكون موقوفة أول. ملفها ينحفظ بمجلد deleted وما ينمسح نهائياً.
app.delete('/super/api/companies/:slug', superAuth, (req, res) => {
  const c = getCompany(req.params.slug);
  if (!c) return res.status(404).json({ error: 'الشركة غير موجودة' });
  if (c.active) return res.status(400).json({ error: 'وقّف الشركة أول، وبعدين احذفها' });
  if (String((req.body || {}).confirm || '') !== c.slug) return res.status(400).json({ error: `اكتب رمز الشركة (${c.slug}) حتى نتأكد` });
  const t = tenants.get(c.slug);
  if (t) { t.close(); tenants.delete(c.slug); }
  if (!MEMORY) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    for (const ext of ['.db', '.db-wal', '.db-shm']) {
      const f = path.join(TENANTS_DIR, c.slug + ext);
      if (fs.existsSync(f)) fs.renameSync(f, path.join(DELETED_DIR, `${c.slug}-${stamp}${ext}`));
    }
  }
  master.prepare('DELETE FROM companies WHERE slug = ?').run(c.slug);
  slog(c.slug, `حذف شركة ${c.name}`);
  res.json({ ok: true });
});
// ----- الدفعات -----
const payRow = ({ receipt, ...p }) => ({ ...p, has_receipt: !!receipt, company_name: (getCompany(p.slug) || {}).name || p.slug });
app.get('/super/api/payments', superAuth, (req, res) => res.json(master.prepare("SELECT * FROM payments ORDER BY status = 'pending' DESC, id DESC LIMIT 200").all().map(payRow)));
app.get('/super/api/payments/:id/receipt', superAuth, (req, res) => {
  const p = master.prepare('SELECT receipt FROM payments WHERE id = ?').get(Number(req.params.id));
  const m = /^data:([^;]+);base64,(.*)$/.exec(p?.receipt || '');
  if (!m) return res.status(404).json({ error: 'ماكو وصل' });
  res.setHeader('Content-Type', m[1]); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.send(Buffer.from(m[2], 'base64'));
});
app.post('/super/api/payments/:id', superAuth, (req, res) => {
  const p = master.prepare('SELECT * FROM payments WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'الدفعة غير موجودة' });
  if (p.status !== 'pending') return res.status(400).json({ error: 'تم الرد عليها مسبقاً' });
  const approve = (req.body || {}).decision === 'approve';
  const reply = String((req.body || {}).reply || '').trim().slice(0, 300);
  let n = null;
  if (approve) { n = activatePlan(p.slug, p.plan_id); if (!n) return res.status(400).json({ error: 'الشركة أو الباقة غير موجودة' }); }
  master.prepare("UPDATE payments SET status = ?, reply = ?, decided_at = datetime('now') WHERE id = ?").run(approve ? 'approved' : 'rejected', reply, p.id);
  if (!approve) slog(p.slug, `رفض دفعة ${p.plan_name}${reply ? ': ' + reply : ''}`);
  res.json({ ok: true, expires_at: n?.expires_at || null });
});
app.get('/super/api/log', superAuth, (req, res) => res.json(master.prepare('SELECT * FROM super_log ORDER BY id DESC LIMIT 200').all()));
app.get('/super/api/settings', superAuth, (req, res) => res.json({ product_name: mget('product_name'), support_phone: mget('support_phone'),
  signup_enabled: mget('signup_enabled') === '1', trial_days: Number(mget('trial_days')), trial_employees: Number(mget('trial_employees')), pay_info: mget('pay_info') || '' }));
app.put('/super/api/settings', superAuth, (req, res) => {
  const b = req.body || {};
  if (b.product_name !== undefined) {
    if (!String(b.product_name).trim()) return res.status(400).json({ error: 'اكتب اسم البرنامج' });
    mset('product_name', String(b.product_name).trim().slice(0, 60));
  }
  if (b.support_phone !== undefined) mset('support_phone', String(b.support_phone).trim().slice(0, 40));
  if (b.signup_enabled !== undefined) mset('signup_enabled', b.signup_enabled ? '1' : '0');
  if (b.pay_info !== undefined) mset('pay_info', String(b.pay_info).trim().slice(0, 1000));
  if (b.trial_days !== undefined) {
    if (!(Number(b.trial_days) >= 1 && Number(b.trial_days) <= 90)) return res.status(400).json({ error: 'أيام التجربة من 1 إلى 90' });
    mset('trial_days', Number(b.trial_days));
  }
  if (b.trial_employees !== undefined) {
    if (!(Number(b.trial_employees) >= 1 && Number(b.trial_employees) <= 100)) return res.status(400).json({ error: 'موظفين التجربة من 1 إلى 100' });
    mset('trial_employees', Number(b.trial_employees));
  }
  if (b.new_password !== undefined) {
    if (!checkPassword(String(b.old_password || ''), mget('super_hash'))) return res.status(400).json({ error: 'الباسورد الحالي غير صحيح' });
    if (String(b.new_password).length < 10) return res.status(400).json({ error: 'الباسورد الجديد لازم 10 أحرف على الأقل' });
    mset('super_hash', hashPassword(String(b.new_password)));
    master.prepare('DELETE FROM super_sessions WHERE token != ?').run(req.token);
  }
  res.json({ ok: true });
});

// ----- دفع الاشتراك من لوحة مدير الشركة (يشتغل حتى لو الاشتراك منتهي) -----
function billing(req, res, c, t) {
  if (!t.isAdminToken((req.headers.authorization || '').replace('Bearer ', ''))) return res.status(401).json({ error: 'سجّل دخول كمدير' });
  if (req.method === 'GET') {
    const st = companyStatus(c, t);
    return res.json({ status: st.status, expires_at: c.expires_at, days_left: st.days_left, trial: !!c.trial, plan_name: c.plan_name || '', max_employees: c.max_employees,
      plans: publicPlans(), pay_info: mget('pay_info') || '', support_phone: mget('support_phone') || '',
      payments: master.prepare('SELECT * FROM payments WHERE slug = ? ORDER BY id DESC LIMIT 10').all(c.slug).map(({ receipt, ...p }) => ({ ...p, has_receipt: !!receipt })) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'غير مسموح' });
  if (c.slug === DEMO_SLUG) return res.status(403).json({ error: 'هذي شركة تجريبية. سجّل شركتك مجاناً حتى تشترك.' });
  const b = req.body || {};
  const p = master.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(Number(b.plan_id));
  if (!p) return res.status(400).json({ error: 'اختار الباقة' });
  const reference = String(b.reference || '').trim().slice(0, 100);
  const receipt = String(b.receipt || '');
  if (receipt && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(receipt) || receipt.length > 800 * 1024)) return res.status(400).json({ error: 'صورة الوصل لازم PNG أو JPG وأقل من 600 كيلوبايت' });
  if (!receipt && !reference) return res.status(400).json({ error: 'ارفع صورة الوصل أو اكتب رقم العملية' });
  if (master.prepare("SELECT COUNT(*) n FROM payments WHERE slug = ? AND status = 'pending'").get(c.slug).n >= 3) return res.status(400).json({ error: 'عندكم دفعات تنتظر التأكيد. نأكدها بأقرب وقت.' });
  const r = master.prepare('INSERT INTO payments(slug, plan_id, plan_name, amount, method, reference, receipt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(c.slug, p.id, p.name, p.price, String(b.method || '').trim().slice(0, 40), reference, receipt);
  slog(c.slug, `دفعة جديدة تنتظر التأكيد: ${p.name} (${p.price})`);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
}

// ----- مساحة كل شركة -----
app.use('/:slug', (req, res, next) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG_RE.test(slug)) return next();
  const c = getCompany(slug);
  if (!c) return next();
  // الروابط بالصفحات نسبية، فلازم الرابط ينتهي بـ /
  if (req.originalUrl === '/' + req.params.slug || req.originalUrl.startsWith('/' + req.params.slug + '?')) {
    return res.redirect(301, '/' + slug + '/' + req.originalUrl.slice(req.params.slug.length + 1));
  }
  const t = openTenant(slug);
  if (slug === DEMO_SLUG && req.method !== 'GET' && /^\/api\/(admin\/(reset|password|settings)|me\/password)/.test(req.path)) {
    return res.status(403).json({ error: 'هذي شركة تجريبية، هذا الخيار يشتغل بشركتك الحقيقية. سجّل شركتك مجاناً.' });
  }
  if (req.path === '/api/billing') return billing(req, res, c, t);
  const st = companyStatus(c, t);
  // إذا الاشتراك منتهي أو موقوف: الصفحات تفتح وتعرض الرسالة، بس الـ API يرفض
  // الاشتراك المنتهي: المدير يكدر يدخل بس حتى يدفع ويجدد من تبويب الاشتراك
  const payLogin = st.status === 'expired' && req.path === '/api/admin/login' && !String((req.body || {}).username || '').trim();
  if (st.status !== 'active' && req.path.startsWith('/api/') && req.path !== '/api/info' && !payLogin) {
    return res.status(403).json({ error: statusMessage(st.status), subscription: st.status });
  }
  if (req.path === '/api/info') {
    // نضيف حالة الاشتراك لمعلومات الشركة
    const send = res.json.bind(res);
    res.json = (body) => send({ ...body, subscription: st.status, subscription_message: statusMessage(st.status), product_name: mget('product_name') });
  }
  t.router(req, res, next);
});

app.use((req, res) => {
  if (req.path.includes('/api/')) return res.status(404).json({ error: 'غير موجود' });
  res.status(404).sendFile(path.join(SITE_DIR, 'notfound.html'));
});

// ---------- مهام دورية ----------
async function tick() {
  for (const c of master.prepare('SELECT * FROM companies WHERE active = 1').all()) {
    const t = openTenant(c.slug);
    if (companyStatus(c, t).status !== 'active') continue;
    await t.reminderTick().catch((e) => console.error(`reminder error [${c.slug}]`, e.message));
  }
}
// نسخة احتياطية يومية لكل شركة، ونخلي آخر 14 يوم
let demoDay = null;
function dailyBackup() {
  if (demoDay && demoDay !== today()) resetDemo();
  demoDay = today();
  if (MEMORY) return;
  const day = today();
  const dir = path.join(BACKUP_DIR, day);
  if (fs.existsSync(path.join(dir, '.done'))) return;
  fs.mkdirSync(dir, { recursive: true });
  master.exec(`VACUUM INTO '${path.join(dir, '_master.db').replace(/'/g, "''")}'`);
  for (const c of master.prepare('SELECT slug FROM companies').all()) {
    const f = path.join(dir, c.slug + '.db');
    if (!fs.existsSync(f)) { try { openTenant(c.slug).backup(f); } catch (e) { console.error('backup failed', c.slug, e.message); } }
  }
  fs.writeFileSync(path.join(dir, '.done'), new Date().toISOString());
  for (const d of fs.readdirSync(BACKUP_DIR)) {
    if (DATE_RE.test(d) && (new Date(day) - new Date(d)) / 864e5 > BACKUP_KEEP_DAYS) fs.rmSync(path.join(BACKUP_DIR, d), { recursive: true, force: true });
  }
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`Attendance SaaS running on http://localhost:${PORT}`));
  setInterval(() => tick().catch((e) => console.error('tick error', e)), 60 * 1000);
  const bk = () => { try { dailyBackup(); } catch (e) { console.error('backup error', e); } };
  bk(); setInterval(bk, 60 * 60 * 1000);
}
module.exports = { app, master, openTenant, tick, companyStatus };
