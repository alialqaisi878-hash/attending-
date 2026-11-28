// يضيف صلاحيات الموقع والكاميرا والإشعارات لمشاريع أندرويد وآيفون بعد إنشائها
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const manifest = path.join(root, 'android/app/src/main/AndroidManifest.xml');
if (fs.existsSync(manifest)) {
  let x = fs.readFileSync(manifest, 'utf8');
  const perms = ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'CAMERA', 'POST_NOTIFICATIONS', 'SCHEDULE_EXACT_ALARM', 'RECEIVE_BOOT_COMPLETED']
    .filter((p) => !x.includes(`android.permission.${p}"`))
    .map((p) => `    <uses-permission android:name="android.permission.${p}" />`).join('\n');
  if (perms) x = x.replace('</manifest>', perms + '\n</manifest>');
  if (!x.includes('android.hardware.location.gps')) x = x.replace('</manifest>', '    <uses-feature android:name="android.hardware.location.gps" android:required="false" />\n</manifest>');
  fs.writeFileSync(manifest, x);
  console.log('android permissions ok');
}

// قارئ الـ QR يحتاج أندرويد 8 (API 26) أو أحدث
const vars = path.join(root, 'android/variables.gradle');
if (fs.existsSync(vars)) {
  fs.writeFileSync(vars, fs.readFileSync(vars, 'utf8').replace(/minSdkVersion = \d+/, 'minSdkVersion = 26'));
  console.log('android minSdk 26');
}

const plist = path.join(root, 'ios/App/App/Info.plist');
if (fs.existsSync(plist)) {
  let x = fs.readFileSync(plist, 'utf8');
  const keys = {
    NSLocationWhenInUseUsageDescription: 'نحتاج موقعك حتى نتأكد إن البصمة من مكان العمل.',
    NSCameraUsageDescription: 'نحتاج الكاميرا حتى تصوّر QR كود الشركة، وسيلفي البصمة إذا شركتك مفعّلتها.',
  };
  for (const [k, v] of Object.entries(keys)) if (!x.includes(`<key>${k}</key>`)) x = x.replace('<dict>', `<dict>\n\t<key>${k}</key>\n\t<string>${v}</string>`);
  if (!x.includes('<key>CFBundleDevelopmentRegion</key>\n\t<string>ar</string>')) x = x.replace(/<key>CFBundleDevelopmentRegion<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleDevelopmentRegion</key>\n\t<string>ar</string>');
  fs.writeFileSync(plist, x);
  console.log('ios permissions ok');
}
