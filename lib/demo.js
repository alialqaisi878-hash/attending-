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
  db.prepare("INSERT OR IGNORE INTO leaves(employee_id, leave_date, note, paid) VALUES (?, ?, 'إجازة مرضية', 1)").run(emps[4].id, `${month}-02`);
  db.prepare("INSERT OR REPLACE INTO adjustments(employee_id, month, advance, bonus, note) VALUES (?, ?, 50000, 0, 'سلفة'), (?, ?, 0, 75000, 'مكافأة مبيعات')")
    .run(emps[2].id, month, emps[5].id, month);
}
module.exports = { DEMO_SLUG, seedDemo };
