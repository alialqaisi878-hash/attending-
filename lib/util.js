// أدوات مشتركة
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 32);
  const want = Buffer.from(hash, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(test, want);
}
// كلمة مرور عشوائية سهلة القراءة (بدون حروف تتشابه)
function randomPassword(n = 10) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(n), (b) => abc[b % abc.length]).join('');
}

// حماية من تخمين الباسورد: 10 محاولات غلط خلال ربع ساعة لنفس العنوان توقف الدخول مؤقتاً
const loginLimiter = {
  max: 10, windowMs: 15 * 60 * 1000, hits: new Map(),
  blocked(key) {
    const h = this.hits.get(key);
    if (!h) return false;
    if (Date.now() - h.first > this.windowMs) { this.hits.delete(key); return false; }
    return h.n >= this.max;
  },
  fail(key) {
    const h = this.hits.get(key);
    if (!h || Date.now() - h.first > this.windowMs) this.hits.set(key, { n: 1, first: Date.now() });
    else h.n++;
    if (this.hits.size > 10000) this.hits.clear();
  },
  reset() { this.hits.clear(); },
};

// الرابط الخارجي لازم يكون عنوان عام بالإنترنت، مو السيرفر نفسه أو شبكته الداخلية
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
async function assertPublicUrl(url) {
  if (process.env.ALLOW_PRIVATE_WEBHOOKS === '1') return;
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error('الرابط لازم يكون عنوان عام بالإنترنت');
}

module.exports = { hashPassword, checkPassword, randomPassword, loginLimiter, assertPublicUrl, isPrivateIp };
