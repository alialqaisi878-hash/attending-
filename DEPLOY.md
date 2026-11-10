# نشر البرنامج على الإنترنت (Railway)

1. افتح https://railway.com وسجّل دخول بحساب GitHub.
2. اضغط **New Project** ← **Deploy from GitHub repo** ← اختار `attending-`.
3. بعد ما ينشأ المشروع، اضغط على الخدمة ← **Variables** وضيف:
   - `ADMIN_PASSWORD` = كلمة مرور قوية للمدير
   - `DB_PATH` = `/data/attendance.db`
4. اضغط على الخدمة بزر الماوس اليمين (أو Ctrl+K) ← **Attach Volume** ← خلي مسار الربط `/data`.
   هذا مهم جداً: بدونه البيانات تنمسح كل ما يتحدث البرنامج.
5. روح **Settings** ← **Networking** ← **Generate Domain**. يطلعلك رابط مثل `https://attending-production.up.railway.app`.
6. افتح الرابط + `/admin.html` وادخل بكلمة مرور المدير.

## أول استعمال
1. **الإعدادات:** اكتب اسم الشركة، حدد أيام العطلة، وروح لمكان العمل واضغط "استخدم موقعي الحالي" ثم حفظ.
2. **الموظفين:** ضيف كل موظف باسم مستخدم وكلمة مرور وراتبه ووقت دوامه.
3. ابعث لكل موظف الرابط واسم المستخدم وكلمة المرور.
4. الموظف يفتح الرابط من موبايله، يدخل، يضغط "تفعيل التنبيهات"، ويسمح بالموقع.
   - آيفون: من Safari ← زر المشاركة ← "إضافة إلى الشاشة الرئيسية"، ويفتحه من الأيقونة.
   - أندرويد: من Chrome ← القائمة ← "إضافة إلى الشاشة الرئيسية".

---

# النشر على سيرفر VPS فيه Traefik (مثل Hostinger مع n8n)

1. بلوحة DNS مال الدومين ضيف سجل `A` للرابط الفرعي (مثلاً `hudoor`) يأشر على IP السيرفر.
2. افتح الـ Terminal مال السيرفر وشغّل (بدّل الدومين بدومينك):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/alialqaisi878-hash/attending-/main/deploy/install.sh -o /root/install-attendance.sh && bash /root/install-attendance.sh hudoor.example.com
   ```
3. بالنهاية يطبعلك الرابط وكلمة مرور المدير.

للتحديث بعدين: `bash /root/install-attendance.sh` (البيانات محفوظة بـ `/root/attendance-app/data`).
