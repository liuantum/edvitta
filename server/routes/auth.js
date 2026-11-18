'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { q, tx, getSetting, flag, LOCAL_SECRET } = require('../db');
const mailer = require('../mailer');
const { v, bad, HttpError, COOKIE, IS_PROD, setAuthCookie, requireAuth, audit, randomCode, walletMove, notify, kickUser } = require('../lib');
const STAFF_ROLES = ['admin', 'staff'];

const r = express.Router();
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 12);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.AUTH_RATE_LIMIT || 20), standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' } });

function publicUser(u) {
  return { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, email_verified: !!u.email_verified, lang: u.lang || 'en',
    email_notifications: u.email_notifications !== 0, whatsapp_alerts: u.whatsapp_alerts !== 0, wallet_balance: u.wallet_balance, referral_code: u.referral_code, permissions: u.permissions || [] };
}

// ---------- Email OTP (login, email verification, password reset) ----------
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many code requests. Please wait 15 minutes.' } });
const hashCode = (email, code) => crypto.createHmac('sha256', LOCAL_SECRET).update(email + ':' + code).digest('hex');
const PURPOSE_TEXT = { login: 'Your login code', verify: 'Verify your email', reset: 'Reset your password', mfa: 'Your admin sign-in code' };

async function issueOtp(email, purpose) {
  const recent = q.get('SELECT created_at FROM otps WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1', email, purpose);
  if (recent && Date.now() / 1000 - recent.created_at < 45) throw bad('Please wait a few seconds before requesting another code');
  // Caps guessing: at most 10 codes per email per day (5 tries each).
  if (q.get('SELECT COUNT(*) n FROM otps WHERE email = ? AND created_at > unixepoch() - 86400', email).n >= 10) throw new HttpError(429, 'Too many codes requested today. Please try again tomorrow or use your password.');
  const code = String(crypto.randomInt(100000, 1000000));
  q.run('UPDATE otps SET used = 1 WHERE email = ? AND purpose = ? AND used = 0', email, purpose);
  q.run('INSERT INTO otps(email, purpose, code_hash, expires_at) VALUES (?,?,?,?)', email, purpose, hashCode(email, code), Math.floor(Date.now() / 1000) + 600);
  const r = await mailer.sendMail(email, `${code} is your Edvitta code`, PURPOSE_TEXT[purpose],
    `<p>Use this code to ${purpose === 'login' || purpose === 'mfa' ? 'log in' : purpose === 'verify' ? 'verify your email' : 'reset your password'}. It expires in 10 minutes.</p>
     <p style="font-size:30px;font-weight:800;letter-spacing:6px;color:#4f46e5">${code}</p><p>Never share this code with anyone, including Edvitta staff.</p>`,
    { force: mailer.isConfigured() });
  // Development convenience: without SMTP the code is printed in the server console (never in production).
  if (!r.sent && !IS_PROD) { console.log(`[edvitta] DEV OTP for ${email} (${purpose}): ${code}`); return { dev_code: code }; }
  if (!r.sent) throw new HttpError(503, 'Could not send the email right now. Please try again or use your password.');
  return {};
}
function checkOtp(email, purpose, code) {
  const o = q.get('SELECT * FROM otps WHERE email = ? AND purpose = ? AND used = 0 ORDER BY id DESC LIMIT 1', email, purpose);
  if (!o || o.expires_at < Date.now() / 1000) throw bad('Code expired. Please request a new one.');
  if (o.attempts >= 5) { q.run('UPDATE otps SET used = 1 WHERE id = ?', o.id); throw bad('Too many wrong attempts. Request a new code.'); }
  const ok = crypto.timingSafeEqual(Buffer.from(o.code_hash), Buffer.from(hashCode(email, String(code || '').trim())));
  if (!ok) { q.run('UPDATE otps SET attempts = attempts + 1 WHERE id = ?', o.id); throw bad('Incorrect code'); }
  q.run('UPDATE otps SET used = 1 WHERE id = ?', o.id);
}

r.post('/otp/request', otpLimiter, async (req, res, next) => {
  try {
    const email = v.email(req.body.email);
    const purpose = v.oneOf(req.body.purpose, 'Purpose', ['login', 'reset']);
    if (purpose === 'login' && !flag('otp_login_enabled', '1')) throw bad('Login with email code is turned off');
    const u = q.get("SELECT id, role, status FROM users WHERE email = ?", email);
    // Same answer whether or not the account exists, so emails can't be probed.
    // Admin and staff can't log in with an email code alone: they need their password plus a code (2-step).
    let extra = {};
    if (u && u.status === 'active' && !(purpose === 'login' && STAFF_ROLES.includes(u.role))) extra = await issueOtp(email, purpose);
    res.json({ ok: true, message: 'If this email has an account, a 6-digit code has been sent.', ...extra });
  } catch (e) { next(e); }
});

r.post('/otp/login', authLimiter, (req, res) => {
  const email = v.email(req.body.email);
  if (!flag('otp_login_enabled', '1')) throw bad('Login with email code is turned off');
  const u = q.get('SELECT * FROM users WHERE email = ?', email);
  if (!u || STAFF_ROLES.includes(u.role)) throw bad('Incorrect code');
  checkOtp(email, 'login', req.body.code);
  if (u.status !== 'active') throw new HttpError(403, 'This account is suspended. Please contact support.');
  q.run('UPDATE users SET email_verified = 1, failed_logins = 0, locked_until = NULL WHERE id = ?', u.id);
  audit({ user: u, ip: req.ip }, 'login_otp', `user:${u.id}`);
  setAuthCookie(res, u);
  res.json({ user: publicUser({ ...u, email_verified: 1, permissions: u.staff_permissions ? JSON.parse(u.staff_permissions) : [] }) });
});

r.post('/password/reset', authLimiter, (req, res) => {
  const email = v.email(req.body.email);
  const u = q.get('SELECT id FROM users WHERE email = ?', email);
  const pw = v.password(req.body.password);
  if (!u) throw bad('Incorrect code');
  checkOtp(email, 'reset', req.body.code);
  q.run('UPDATE users SET password_hash = ?, token_version = token_version + 1, failed_logins = 0, locked_until = NULL, email_verified = 1 WHERE id = ?', bcrypt.hashSync(pw, 12), u.id);
  audit({ user: u, ip: req.ip }, 'password_reset', `user:${u.id}`);
  kickUser(u.id);
  notify(u.id, 'Your Edvitta password was reset. If this was not you, contact support immediately.', '#/account', { important: true });
  res.json({ ok: true });
});

r.post('/verify-email/send', otpLimiter, async (req, res, next) => {
  try {
    if (!req.user) throw new HttpError(401, 'Please log in');
    res.json({ ok: true, ...(await issueOtp(req.user.email, 'verify')) });
  } catch (e) { next(e); }
});
r.post('/verify-email', (req, res) => {
  if (!req.user) throw new HttpError(401, 'Please log in');
  checkOtp(req.user.email, 'verify', req.body.code);
  q.run('UPDATE users SET email_verified = 1 WHERE id = ?', req.user.id);
  res.json({ ok: true });
});

r.put('/prefs', (req, res) => {
  if (!req.user) throw new HttpError(401, 'Please log in');
  const b = req.body || {};
  if (b.lang !== undefined) q.run('UPDATE users SET lang = ? WHERE id = ?', v.oneOf(b.lang, 'Language', ['en', 'hi', 'kn', 'te']), req.user.id);
  if (b.email_notifications !== undefined) q.run('UPDATE users SET email_notifications = ? WHERE id = ?', b.email_notifications ? 1 : 0, req.user.id);
  if (b.whatsapp_alerts !== undefined) q.run('UPDATE users SET whatsapp_alerts = ? WHERE id = ?', b.whatsapp_alerts ? 1 : 0, req.user.id);
  res.json({ ok: true });
});

r.post('/register', authLimiter, (req, res) => {
  const b = req.body || {};
  const role = v.oneOf(b.role, 'Role', ['parent', 'tutor']); // admin/staff can never self-register
  const name = v.str(b.name, 'Name', { min: 2, max: 80 });
  const email = v.email(b.email);
  const phone = v.phone(b.phone);
  const password = v.password(b.password);
  const refCode = v.str(b.referral_code, 'Referral code', { optional: true, max: 20 });
  if (q.get('SELECT 1 FROM users WHERE email = ? OR phone = ?', email, phone)) throw bad('An account with this email or phone already exists');
  let referrer = null;
  if (refCode) {
    referrer = q.get('SELECT id FROM users WHERE referral_code = ? COLLATE NOCASE', refCode);
    if (!referrer) throw bad('Referral code not found');
  }
  const hash = bcrypt.hashSync(password, 12);
  const user = tx(() => {
    let code; do { code = randomCode(8); } while (q.get('SELECT 1 FROM users WHERE referral_code = ?', code));
    const info = q.run('INSERT INTO users(role,name,email,phone,password_hash,referral_code,referred_by) VALUES (?,?,?,?,?,?,?)',
      role, name, email, phone, hash, code, referrer?.id ?? null);
    const id = Number(info.lastInsertRowid);
    if (role === 'tutor') q.run('INSERT INTO tutor_profiles(user_id) VALUES (?)', id);
    const welcome = Number(getSetting('welcome_bonus', '0'));
    if (welcome > 0) walletMove(id, 'credit', welcome, 'Welcome bonus');
    return q.get('SELECT * FROM users WHERE id = ?', id);
  });
  notify(user.id, role === 'tutor'
    ? 'Welcome to Edvitta! Complete your profile and upload KYC documents to get activated.'
    : 'Welcome to Edvitta! Add your child and find verified tutors near you.', role === 'tutor' ? '#/tutor/kyc' : '#/parent/children');
  audit({ user, ip: req.ip }, 'register', `user:${user.id}`);
  if (mailer.isConfigured()) issueOtp(user.email, 'verify').catch(() => {});
  setAuthCookie(res, user);
  res.json({ user: publicUser(user) });
});

r.post('/login', authLimiter, (req, res, next) => {
  const b = req.body || {};
  const id = v.str(b.login, 'Email or phone', { max: 120 }).toLowerCase();
  const password = v.str(b.password, 'Password', { max: 128 });
  const u = q.get('SELECT * FROM users WHERE email = ? OR phone = ?', id, id.replace(/\D/g, '').slice(-10) || '-');
  const now = Math.floor(Date.now() / 1000);
  if (u && u.locked_until && u.locked_until > now) throw new HttpError(429, 'Account temporarily locked after failed attempts. Try again in 15 minutes.');
  // Always run bcrypt to keep timing similar whether or not the user exists.
  const ok = bcrypt.compareSync(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) {
    if (u) {
      const fails = u.failed_logins + 1;
      q.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', fails >= 5 ? 0 : fails, fails >= 5 ? now + 900 : null, u.id);
      audit({ user: u, ip: req.ip }, 'login_failed', `user:${u.id}`);
    }
    throw new HttpError(401, 'Incorrect email/phone or password');
  }
  if (u.status !== 'active') throw new HttpError(403, 'This account is suspended. Please contact support.');
  q.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', u.id);
  // 2-step sign-in for admin and staff (they can see children's data and KYC): password, then an email code.
  if (STAFF_ROLES.includes(u.role) && flag('staff_2fa_enabled', '1') && mailer.isConfigured()) {
    return Promise.resolve(issueOtp(u.email, 'mfa')).then((extra) => {
      audit({ user: u, ip: req.ip }, 'login_password_ok_mfa_sent', `user:${u.id}`);
      res.json({ mfa: true, email: u.email, message: 'Enter the 6-digit code sent to your email', ...extra });
    }).catch(next);
  }
  audit({ user: u, ip: req.ip }, 'login', `user:${u.id}`);
  setAuthCookie(res, u);
  u.permissions = u.staff_permissions ? JSON.parse(u.staff_permissions) : [];
  res.json({ user: publicUser(u) });
});

// Second step of admin/staff sign-in. The code is only ever sent after the right password.
r.post('/mfa', authLimiter, (req, res) => {
  const email = v.email(req.body.email);
  const u = q.get('SELECT * FROM users WHERE email = ?', email);
  if (!u || !STAFF_ROLES.includes(u.role)) throw bad('Incorrect code');
  checkOtp(email, 'mfa', req.body.code);
  if (u.status !== 'active') throw new HttpError(403, 'This account is suspended. Please contact support.');
  audit({ user: u, ip: req.ip }, 'login', `user:${u.id}`, { mfa: true });
  setAuthCookie(res, u);
  u.permissions = u.staff_permissions ? JSON.parse(u.staff_permissions) : [];
  res.json({ user: publicUser(u) });
});

r.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: IS_PROD, path: '/' });
  res.json({ ok: true });
});

// Logs out every device by bumping the token version.
r.post('/logout-all', requireAuth(), (req, res) => {
  q.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', req.user.id);
  kickUser(req.user.id);
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: IS_PROD, path: '/' });
  res.json({ ok: true });
});

r.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const u = publicUser(req.user);
  u.unread = q.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', req.user.id).n;
  res.json({ user: u });
});

r.post('/change-password', requireAuth(), (req, res) => {
  const u = q.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!bcrypt.compareSync(String(req.body.current || ''), u.password_hash)) throw bad('Current password is incorrect');
  const pw = v.password(req.body.password);
  q.run('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', bcrypt.hashSync(pw, 12), u.id);
  audit(req, 'password_changed', `user:${u.id}`);
  kickUser(u.id);
  setAuthCookie(res, q.get('SELECT * FROM users WHERE id = ?', u.id));
  res.json({ ok: true });
});

r.get('/notifications', requireAuth(), (req, res) => {
  const items = q.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id);
  q.run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id);
  res.json({ items });
});

module.exports = { router: r, publicUser };
