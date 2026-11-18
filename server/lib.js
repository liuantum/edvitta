'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { q, tx, getSetting } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production');
  return require('./db').LOCAL_SECRET;
})();
const COOKIE = 'edv_session';
const IS_PROD = process.env.NODE_ENV === 'production';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const forbidden = (msg = 'Not allowed') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);

// ---------- Validation helpers ----------
const v = {
  str(val, name, { min = 1, max = 200, optional = false } = {}) {
    if (val === undefined || val === null || val === '') {
      if (optional) return null;
      throw bad(`${name} is required`);
    }
    if (typeof val !== 'string') throw bad(`${name} must be text`);
    const s = val.trim();
    if (s.length < min || s.length > max) throw bad(`${name} must be ${min}-${max} characters`);
    return s;
  },
  int(val, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
    if (val === undefined || val === null || val === '') {
      if (optional) return null;
      throw bad(`${name} is required`);
    }
    const n = Number(val);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number between ${min} and ${max}`);
    return n;
  },
  num(val, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
    if (val === undefined || val === null || val === '') {
      if (optional) return null;
      throw bad(`${name} is required`);
    }
    const n = Number(val);
    if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} is invalid`);
    return n;
  },
  rupees(val, name, opts = {}) { // accepts rupees, returns paise
    const n = v.num(val, name, { min: 0, max: 10000000, ...opts });
    return n === null ? null : Math.round(n * 100);
  },
  oneOf(val, name, list, { optional = false } = {}) {
    if ((val === undefined || val === null || val === '') && optional) return null;
    if (!list.includes(val)) throw bad(`${name} must be one of: ${list.join(', ')}`);
    return val;
  },
  email(val) {
    const s = v.str(val, 'Email', { max: 120 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw bad('Email is invalid');
    return s;
  },
  phone(val) {
    const s = v.str(val, 'Phone', { max: 20 }).replace(/[\s-]/g, '');
    if (!/^(\+91)?[6-9]\d{9}$/.test(s)) throw bad('Enter a valid 10-digit Indian mobile number');
    return s.slice(-10);
  },
  password(val) {
    const s = v.str(val, 'Password', { min: 8, max: 128 });
    if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw bad('Password needs at least 8 characters with letters and numbers');
    return s;
  },
  date(val, name) {
    const s = v.str(val, name, { max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw bad(`${name} must be a date (YYYY-MM-DD)`);
    return s;
  },
  time(val, name) {
    const s = v.str(val, name, { max: 5 });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw bad(`${name} must be a time (HH:MM)`);
    return s;
  },
  url(val, name, { optional = false } = {}) {
    const s = v.str(val, name, { max: 500, optional });
    if (s === null) return null;
    let u;
    try { u = new URL(s); } catch { throw bad(`${name} must be a valid link`); }
    if (u.protocol !== 'https:') throw bad(`${name} must start with https://`);
    return u.toString();
  },
};

// ---------- Auth ----------
function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, tv: user.token_version }, JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' });
}
function setAuthCookie(res, user) {
  res.cookie(COOKIE, signToken(user), {
    httpOnly: true, sameSite: 'strict', secure: IS_PROD, maxAge: 7 * 24 * 3600 * 1000, path: '/',
  });
}
function userFromToken(token) {
  if (!token) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const u = q.get('SELECT id, role, name, email, phone, status, token_version, staff_permissions, wallet_balance, referral_code, email_verified, lang, email_notifications, whatsapp_alerts FROM users WHERE id = ?', p.sub);
    if (!u || u.status !== 'active' || u.token_version !== p.tv) return null;
    u.permissions = u.staff_permissions ? JSON.parse(u.staff_permissions) : [];
    return u;
  } catch { return null; }
}
function loadUser(req, _res, next) {
  req.user = userFromToken(req.cookies?.[COOKIE]);
  next();
}
function requireAuth(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    if (roles.length && !roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}
// Admin always passes; staff need the specific permission.
const STAFF_PERMS = ['tickets', 'kyc', 'payments', 'sos', 'bookings', 'ads', 'community', 'users'];
function requirePerm(perm) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    if (req.user.role === 'admin') return next();
    if (req.user.role === 'staff' && req.user.permissions.includes(perm)) return next();
    next(forbidden());
  };
}

// When the admin turns on "require verified email", sensitive actions need a verified email first.
function requireVerified(req, _res, next) {
  if (req.user && !req.user.email_verified && require('./db').flag('require_email_verification')) {
    return next(new HttpError(403, 'Please verify your email first (Account page).'));
  }
  next();
}

// CSRF defence in depth: SameSite=strict cookie + require a custom header on state-changing requests
// (browsers will not send custom headers cross-site without a CORS preflight, which we never allow).
function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'edvitta') return next(forbidden('Missing request header'));
  next();
}

function audit(req, action, target, detail) {
  q.run('INSERT INTO audit_logs(actor_id, action, target, detail, ip) VALUES (?,?,?,?,?)',
    req?.user?.id ?? null, action, target ?? null, detail ? JSON.stringify(detail) : null, req?.ip ?? null);
}

// ---------- Wallet (all amounts in paise; must be called inside tx()) ----------
function walletMove(userId, type, amount, reason, ref) {
  if (!Number.isInteger(amount) || amount <= 0) throw bad('Invalid amount');
  const u = q.get('SELECT wallet_balance FROM users WHERE id = ?', userId);
  if (!u) throw notFound('User not found');
  const next = type === 'credit' ? u.wallet_balance + amount : u.wallet_balance - amount;
  if (next < 0) throw bad('Insufficient wallet balance. Please add money to your wallet.');
  q.run('UPDATE users SET wallet_balance = ? WHERE id = ?', next, userId);
  q.run('INSERT INTO wallet_txns(user_id,type,amount,balance_after,reason,ref) VALUES (?,?,?,?,?,?)',
    userId, type, amount, next, reason, ref ?? null);
  return next;
}
// Platform revenue is tracked against the first admin account's ledger.
function platformAccountId() {
  return q.get("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")?.id;
}
const commissionPct = () => Number(getSetting('commission_percent', '15'));

// important: also sent on WhatsApp when WhatsApp alerts are switched on (bookings, arrival, SOS, payments, reschedules).
function notify(userId, text, link, { email = true, important = false } = {}) {
  q.run('INSERT INTO notifications(user_id, text, link) VALUES (?,?,?)', userId, text, link ?? null);
  if (email) require('./mailer').notifyEmail(userId, text);
  require('./whatsapp').notifyWhatsApp(userId, text, important);
  const io = module.exports.io;
  if (io) io.to(`user:${userId}`).emit('notification', { text, link });
}

// Closes a user's live connections (after logout-all, password change, suspension or permission change).
function kickUser(userId) {
  const io = module.exports.io;
  if (io) io.in(`user:${userId}`).disconnectSockets(true);
}

// ---------- Geo ----------
function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// A tutor's home is never used directly for search distances: it is snapped to a ~550 m grid first,
// so repeated searches from different points can't pinpoint where a tutor lives.
const blurCoord = (x) => Math.round(Number(x) / 0.005) * 0.005;
const tutorDistanceKm = (lat, lng, t) => distanceKm(lat, lng, blurCoord(t.lat), blurCoord(t.lng));

// ---------- Coupons ----------
function evaluateCoupon(code, userId, amount) {
  const c = q.get('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE', code);
  if (!c || !c.active) throw bad('Coupon is not valid');
  if (c.expires_at && new Date(c.expires_at + 'T23:59:59') < new Date()) throw bad('Coupon has expired');
  if (c.usage_limit !== null && c.used_count >= c.usage_limit) throw bad('Coupon usage limit reached');
  const used = q.get('SELECT COUNT(*) n FROM coupon_redemptions WHERE code = ? AND user_id = ?', c.code, userId).n;
  if (used >= c.per_user_limit) throw bad('You have already used this coupon');
  if (amount < c.min_amount) throw bad(`Coupon needs a minimum order of ₹${c.min_amount / 100}`);
  let d = c.type === 'percent' ? Math.floor((amount * c.value) / 100) : c.value;
  if (c.max_discount) d = Math.min(d, c.max_discount);
  d = Math.min(d, amount);
  return { coupon: c, discount: d };
}

const randomCode = (len = 8) => crypto.randomBytes(len).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, len).toUpperCase();
const otp4 = () => String(crypto.randomInt(1000, 10000));

module.exports = {
  HttpError, bad, forbidden, notFound, v,
  COOKIE, IS_PROD, setAuthCookie, requireVerified, userFromToken, loadUser, requireAuth, requirePerm, STAFF_PERMS, csrfGuard, audit,
  walletMove, platformAccountId, commissionPct, notify, kickUser, distanceKm, tutorDistanceKm, blurCoord, evaluateCoupon, randomCode, otp4, tx,
  io: null,
};
