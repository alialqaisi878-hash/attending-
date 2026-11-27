// يجهز ملفات التطبيق (www) من صفحات البرنامج نفسها، حتى التطبيق يشتغل بدون رابط وبدون نت
// الاستعمال: HUDOOR_SERVER=https://example.com node scripts/build-www.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pub = path.join(root, '..', 'public');
const out = path.join(root, 'www');
const server = (process.env.HUDOOR_SERVER || require('../app.json').server).replace(/\/+$/, '');
if (!/^https:\/\//.test(server)) { console.error('HUDOOR_SERVER لازم يبدي بـ https://'); process.exit(1); }
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of ['style.css', 'app.css', 'common.js', 'icon.svg']) fs.copyFileSync(path.join(pub, f), path.join(out, f));
fs.cpSync(path.join(pub, 'fonts'), path.join(out, 'fonts'), { recursive: true });
for (const f of ['index.html', 'admin.html', 'payslip.html']) {
  let html = fs.readFileSync(path.join(pub, f), 'utf8');
  html = html.replace('<script src="common.js"></script>', '<script src="app-config.js"></script>\n<script src="common.js"></script>');
  html = html.replace(/<link rel="manifest"[^>]*>\n?/, '');
  html = html.replace('<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
  fs.writeFileSync(path.join(out, f), html);
}
fs.copyFileSync(path.join(root, 'src', 'start.html'), path.join(out, 'start.html'));
fs.writeFileSync(path.join(out, 'app-config.js'), `window.HUDOOR_SERVER = ${JSON.stringify(server)};\n`);
console.log('www ready for', server);
