// شركة تجريبية (محاكاة): أي واحد يجربها بدون تسجيل. تنمسح وترجع لبياناتها كل يوم.
const DEMO_SLUG = 'demo';
const EMPLOYEES = [
  ['ahmed', 'أحمد كريم', 'الهندسة', 'مهندس موقع', 950000],
  ['zainab', 'زينب علي', 'المحاسبة', 'محاسبة', 800000],
  ['omar', 'عمر حسن', 'المبيعات', 'مندوب مبيعات', 650000],
  ['huda', 'هدى سامي', 'الإدارة', 'سكرتيرة', 700000],
  ['mustafa', 'مصطفى جاسم', 'المخزن', 'أمين مخزن', 600000],
  ['sara', 'سارة محمود', 'المبيعات', 'مندوبة مبيعات', 650000],
];

function seedDemo(t) {
  const db = t.db;
  if (db.prepare('SELECT COUNT(*) n FROM employees').get().n) return;
  db.prepare("UPDATE settings SET value = 'شركة المستقبل (تجريبية)' WHERE key = 'company_name'").run();
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'device_lock'").run();
  db.prepare("UPDATE settings SET value = '#0f766e' WHERE key = 'brand_color'").run();
  db.prepare("UPDATE settings SET value = 'هذي شركة تجريبية. جرّب بأي حساب: ahmed / 12345678' WHERE key = 'support_note'").run();
  const { hashPassword } = require('./util');
  const hash = hashPassword('12345678');
  const ins = db.prepare(`INSERT INTO employees(username, name, department, job_title, password_hash, salary, shift_start, shift_end, overtime_after, shift_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '08:00', '16:00', '16:00', 1, ?)`);
  const { date } = t.nowParts();
  const month = date.slice(0, 7);
  for (const e of EMPLOYEES) ins.run(...e.slice(0, 4), hash, e[4], month + '-01 00:00:00');
  // بصمات الشهر الحالي لحد أمس، بشكل واقعي: تأخير أحياناً، إضافي أحياناً، غياب قليل
  const emps = db.prepare('SELECT id FROM employees ORDER BY id').all();
  const att = db.prepare('INSERT OR IGNORE INTO attendance(employee_id, work_date, check_in, check_out, in_offline, in_synced_at) VALUES (?, ?, ?, ?, ?, ?)');
  const day = Number(date.slice(8, 10));
  const pad = (n) => String(n).padStart(2, '0');
  for (let d = 1; d < day; d++) {
    const ds = `${month}-${pad(d)}`;
    if (new Date(ds + 'T00:00:00Z').getUTCDay() === 5) continue;
    emps.forEach((e, i) => {
      const r = (d * 7 + i * 13) % 23;
      if (r === 0) return; // غياب
      const late = r % 6 === 0 ? 10 + r : 0;
      const early = r % 4 === 0 ? 5 : 0;
      const inMin = 8 * 60 + late - (late ? 0 : early);
      const ot = r % 5 === 0 ? 30 + r * 3 : 0;
      const outMin = 16 * 60 + ot + (r % 3);
      const t2 = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`;
      const offline = r === 11 ? 1 : 0;
      att.run(e.id, ds, t2(inMin), t2(outMin), offline, offline ? `${ds} ${t2(inMin + 40)}` : null);
    });
  }
  // اليوم: بعضهم بصم حضور
  const now = t.nowParts().time.slice(0, 5);
  if (now > '08:20' && new Date(date + 'T00:00:00Z').getUTCDay() !== 5) {
    att.run(emps[0].id, date, '07:56:00', null, 0, null);
    att.run(emps[1].id, date, '08:02:00', null, 0, null);
    att.run(emps[3].id, date, '08:19:00', null, 0, null);
  }
  // مواقع عمل وفني يتنقل بينها (أحمد)، ويا زياراته وتقاريره
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('skip_location', '1')").run();
  const sites = [['موقع الكرادة - برج النخيل', 33.3062, 44.4209], ['موقع المنصور - مول الزيتون', 33.3203, 44.3497], ['مخزن الدورة', 33.2489, 44.3986]]
    .map(([n, la, ln]) => Number(db.prepare('INSERT INTO sites(name, lat, lng, radius) VALUES (?, ?, ?, 200)').run(n, la, ln).lastInsertRowid));
  for (const sid of sites) db.prepare('INSERT INTO employee_sites(employee_id, site_id) VALUES (?, ?)').run(emps[0].id, sid);
  const reports = ['صيانة مولدة الطابق الثاني وتبديل فلتر الزيت', 'فحص لوحة الكهرباء الرئيسية، كلشي سليم', 'تركيب 4 كاميرات بالمدخل وربطها على الشاشة',
    'تبديل مضخة الماء، المضخة القديمة رجعت للمخزن', 'استلام مواد (20 كيبل + 6 قواطع) وتسليمها للموقع', 'متابعة شغل المقاول، باقي التشطيب يومين'];
  const vis = db.prepare('INSERT INTO visits(employee_id, site_id, work_date, arrived_at, left_at, left_date, report, arr_offline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (let d = Math.max(1, day - 6); d < day; d++) {
    const ds = `${month}-${pad(d)}`;
    if (new Date(ds + 'T00:00:00Z').getUTCDay() === 5) continue;
    vis.run(emps[0].id, sites[d % 3], ds, '08:40:00', '11:15:00', ds, reports[d % 6], 0);
    vis.run(emps[0].id, sites[(d + 1) % 3], ds, '11:50:00', '14:05:00', ds, reports[(d + 2) % 6], d % 4 === 0 ? 1 : 0);
  }
  db.prepare("INSERT OR IGNORE INTO leaves(employee_id, leave_date, note, paid) VALUES (?, ?, 'إجازة مرضية', 1)").run(emps[4].id, `${month}-02`);
  db.prepare("INSERT OR REPLACE INTO adjustments(employee_id, month, advance, bonus, note) VALUES (?, ?, 50000, 0, 'سلفة'), (?, ?, 0, 75000, 'مكافأة مبيعات')")
    .run(emps[2].id, month, emps[5].id, month);
  // مكان بصمات اليوم (للخريطة)، وطلبات تنتظر الرد، وتعميم
  const spots = [[33.3064, 44.4211], [33.3152, 44.3661], [33.3149, 44.3667], [33.3155, 44.3659]];
  [0, 1, 3].forEach((i, k) => db.prepare('UPDATE attendance SET in_lat = ?, in_lng = ? WHERE employee_id = ? AND work_date = ?').run(...spots[k], emps[i].id, date));
  const next = (n) => { const x = new Date(date + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  db.prepare("INSERT INTO requests(employee_id, kind, from_date, to_date, note) VALUES (?, 'leave', ?, ?, 'مراجعة مستشفى ويا الوالدة')").run(emps[2].id, next(2), next(3));
  db.prepare("INSERT INTO requests(employee_id, kind, amount, note) VALUES (?, 'advance', 150000, 'تصليح سيارة')").run(emps[5].id);
  db.prepare("INSERT INTO requests(employee_id, kind, from_date, to_date, note, status, reply, decided_at) VALUES (?, 'leave', ?, ?, 'ظرف عائلي', 'approved', 'الله يسهّل', datetime('now'))").run(emps[0].id, `${month}-02`, `${month}-02`);
  db.prepare("INSERT INTO announcements(title, body) VALUES ('اجتماع الخميس الساعة 1 الظهر', 'كل الأقسام بقاعة الاجتماعات. نراجع شغل الشهر وخطة الشهر الجاي.')").run();
  db.prepare("UPDATE settings SET value = '10:00' WHERE key = 'summary_time'").run();
}
module.exports = { DEMO_SLUG, seedDemo };
