'use strict';
// Admin + staff panel. Admin has every permission; staff get only the permissions an admin grants them.
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, tx, getSetting, setSetting, getSecret, setSecret } = require('../db');
const mailer = require('../mailer');
const { v, bad, notFound, requireAuth, requirePerm, STAFF_PERMS, audit, walletMove, notify, randomCode, kickUser } = require('../lib');
const { upload, saveFile, sendPrivate } = require('../uploads');
const { rewardReferral } = require('./bookings');

const r = express.Router();
const adminOnly = requireAuth('admin');
r.use(requireAuth('admin', 'staff'));

r.get('/stats', (req, res) => {
  const one = (sql, ...p) => Object.values(q.get(sql, ...p))[0];
  res.json({
    parents: one("SELECT COUNT(*) FROM users WHERE role='parent'"),
    tutors: one("SELECT COUNT(*) FROM users WHERE role='tutor'"),
    tutors_active: one("SELECT COUNT(*) FROM tutor_profiles WHERE kyc_status='approved'"),
    tutors_online: one("SELECT COUNT(*) FROM tutor_profiles WHERE available=1 AND kyc_status='approved'"),
    kyc_pending: one("SELECT COUNT(*) FROM tutor_profiles WHERE kyc_status='submitted'"),
    bookings: one('SELECT COUNT(*) FROM bookings'),
    bookings_active: one("SELECT COUNT(*) FROM bookings WHERE status='accepted'"),
    sessions_today: one("SELECT COUNT(*) FROM sessions WHERE date = date('now')"),
    live_now: one("SELECT COUNT(*) FROM sessions WHERE status IN ('on_the_way','in_progress')"),
    gmv: one("SELECT COALESCE(SUM(amount),0) FROM bookings WHERE status IN ('accepted','completed')"),
    payouts: one('SELECT COALESCE(SUM(payout),0) FROM sessions WHERE payout IS NOT NULL'),
    ad_revenue: one("SELECT COALESCE(SUM(price),0) FROM ads WHERE status IN ('active','expired','paused')"),
    payments_pending: one("SELECT COUNT(*) FROM manual_payments WHERE status='pending'"),
    withdrawals_pending: one("SELECT COUNT(*) FROM withdrawals WHERE status='pending'"),
    tickets_open: one("SELECT COUNT(*) FROM tickets WHERE status IN ('open','in_progress')"),
    sos_open: one("SELECT COUNT(*) FROM sos_alerts WHERE status='open'"),
    groups: one("SELECT COUNT(*) FROM community_groups WHERE status != 'closed'"),
    ads_pending: one("SELECT COUNT(*) FROM ads WHERE status='pending'"),
    wallet_float: one("SELECT COALESCE(SUM(wallet_balance),0) FROM users WHERE role IN ('parent','tutor')"),
  });
});

// ---------- KYC ----------
r.get('/kyc', requirePerm('kyc'), (req, res) => {
  const status = ['submitted', 'approved', 'rejected', 'not_submitted'].includes(req.query.status) ? req.query.status : 'submitted';
  res.json({ items: q.all(`SELECT u.id, u.name, u.email, u.phone, u.created_at, t.kyc_status, t.kyc_note, t.categories, t.address, t.qualification,
      t.experience_years, t.police_verification FROM users u JOIN tutor_profiles t ON t.user_id = u.id WHERE t.kyc_status = ? ORDER BY u.id DESC`, status) });
});
r.get('/kyc/:id', requirePerm('kyc'), (req, res) => {
  const u = q.get(`SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at, t.* FROM users u JOIN tutor_profiles t ON t.user_id=u.id WHERE u.id = ?`, Number(req.params.id));
  if (!u) throw notFound();
  audit(req, 'kyc_view', `user:${u.id}`);
  res.json({ tutor: { ...u, categories: JSON.parse(u.categories) },
    docs: q.all('SELECT id, doc_type, original_name, mime, uploaded_at FROM kyc_documents WHERE tutor_id = ?', u.id) });
});
r.get('/kyc-doc/:docId', requirePerm('kyc'), (req, res) => {
  const d = q.get('SELECT * FROM kyc_documents WHERE id = ?', Number(req.params.docId));
  if (!d) throw notFound();
  audit(req, 'kyc_doc_view', `kycdoc:${d.id}`);
  sendPrivate(res, d.stored_name, d.mime);
});
r.post('/kyc/:id/decision', requirePerm('kyc'), (req, res) => {
  const id = Number(req.params.id);
  const t = q.get('SELECT * FROM tutor_profiles WHERE user_id = ?', id);
  if (!t) throw notFound();
  const decision = v.oneOf(req.body.decision, 'Decision', ['approved', 'rejected']);
  const note = v.str(req.body.note, 'Note', { max: 500, optional: decision === 'approved' });
  tx(() => {
    q.run(`UPDATE tutor_profiles SET kyc_status=?, kyc_note=?, kyc_reviewed_by=?, kyc_reviewed_at=unixepoch(), police_verification=?,
      available = CASE WHEN ? = 'approved' THEN available ELSE 0 END WHERE user_id=?`,
      decision, note, req.user.id, req.body.police_verified ? 1 : t.police_verification, decision, id);
    if (decision === 'approved') rewardReferral(id);
  });
  notify(id, decision === 'approved' ? '🎉 Your KYC is approved! Your account is now active. Go online to receive bookings.' :
    `Your KYC was not approved: ${note}. Please re-upload the documents.`, '#/tutor/kyc');
  audit(req, 'kyc_' + decision, `user:${id}`, { note });
  res.json({ ok: true });
});

// ---------- Manual payments & withdrawals ----------
r.get('/payments', requirePerm('payments'), (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({
    items: q.all(`SELECT m.*, u.name, u.phone, u.role FROM manual_payments m JOIN users u ON u.id = m.user_id WHERE m.status = ? ORDER BY m.id DESC LIMIT 200`, status),
    withdrawals: q.all(`SELECT w.*, u.name, u.phone, u.role FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = ? ORDER BY w.id DESC LIMIT 200`,
      status === 'approved' ? 'paid' : status),
  });
});
r.get('/payments/:id/proof', requirePerm('payments'), (req, res) => {
  const m = q.get('SELECT proof_name FROM manual_payments WHERE id = ?', Number(req.params.id));
  if (!m || !m.proof_name) throw notFound();
  sendPrivate(res, m.proof_name, m.proof_name.endsWith('.png') ? 'image/png' : m.proof_name.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
});
r.post('/payments/:id/decision', requirePerm('payments'), (req, res) => {
  const m = q.get('SELECT * FROM manual_payments WHERE id = ?', Number(req.params.id));
  if (!m) throw notFound();
  if (m.status !== 'pending') throw bad('Already reviewed');
  const decision = v.oneOf(req.body.decision, 'Decision', ['approved', 'rejected']);
  // Admin may correct the amount to what actually arrived in the bank.
  const amount = req.body.amount ? v.rupees(req.body.amount, 'Amount', { min: 1 }) : m.amount;
  tx(() => {
    q.run('UPDATE manual_payments SET status=?, reviewed_by=?, note=?, amount=? WHERE id=?', decision, req.user.id,
      v.str(req.body.note, 'Note', { max: 300, optional: true }), amount, m.id);
    if (decision === 'approved') walletMove(m.user_id, 'credit', amount, `Wallet top-up via UPI (UTR ${m.utr})`, `manual:${m.id}`);
  });
  notify(m.user_id, decision === 'approved' ? `₹${amount / 100} added to your wallet (UTR ${m.utr})` : `Your payment UTR ${m.utr} could not be verified`, '#/wallet', { important: true });
  audit(req, 'manual_payment_' + decision, `manual:${m.id}`, { amount });
  res.json({ ok: true });
});
r.post('/withdrawals/:id/decision', requirePerm('payments'), (req, res) => {
  const w = q.get('SELECT * FROM withdrawals WHERE id = ?', Number(req.params.id));
  if (!w) throw notFound();
  if (w.status !== 'pending') throw bad('Already processed');
  const decision = v.oneOf(req.body.decision, 'Decision', ['paid', 'rejected']);
  tx(() => {
    q.run('UPDATE withdrawals SET status=?, reviewed_by=? WHERE id=?', decision, req.user.id, w.id);
    if (decision === 'rejected') walletMove(w.user_id, 'credit', w.amount, 'Withdrawal rejected: amount returned', `withdrawal:${w.id}`);
  });
  notify(w.user_id, decision === 'paid' ? `₹${w.amount / 100} was sent to ${w.upi_id}` : 'Your withdrawal request was rejected and the amount returned to your wallet', '#/wallet', { important: true });
  audit(req, 'withdrawal_' + decision, `withdrawal:${w.id}`);
  res.json({ ok: true });
});

// ---------- Users & staff ----------
r.get('/users', requirePerm('users'), (req, res) => {
  const role = ['parent', 'tutor', 'staff', 'admin'].includes(req.query.role) ? req.query.role : null;
  const s = req.query.search ? `%${String(req.query.search).slice(0, 60)}%` : null;
  let sql = 'SELECT id, role, name, email, phone, status, wallet_balance, referral_code, staff_permissions, created_at FROM users WHERE 1=1';
  const p = [];
  if (role) { sql += ' AND role = ?'; p.push(role); }
  if (s) { sql += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)'; p.push(s, s, s); }
  res.json({ items: q.all(sql + ' ORDER BY id DESC LIMIT 300', ...p), perms: STAFF_PERMS });
});
r.post('/users/:id/status', requirePerm('users'), (req, res) => {
  const u = q.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) throw notFound();
  if (u.role === 'admin' || (u.role === 'staff' && req.user.role !== 'admin')) throw bad('Not allowed for this account');
  const status = v.oneOf(req.body.status, 'Status', ['active', 'suspended']);
  q.run('UPDATE users SET status=?, token_version = token_version + 1 WHERE id=?', status, u.id);
  if (status === 'suspended' && u.role === 'tutor') q.run('UPDATE tutor_profiles SET available = 0 WHERE user_id = ?', u.id);
  if (status === 'suspended') kickUser(u.id);
  audit(req, 'user_' + status, `user:${u.id}`, { reason: req.body.reason });
  res.json({ ok: true });
});
r.post('/users/:id/wallet-adjust', adminOnly, (req, res) => {
  const amount = v.rupees(req.body.amount, 'Amount', { min: 1 });
  const type = v.oneOf(req.body.type, 'Type', ['credit', 'debit']);
  const reason = v.str(req.body.reason, 'Reason', { max: 120 });
  tx(() => walletMove(Number(req.params.id), type, amount, `Admin adjustment: ${reason}`, `admin:${req.user.id}`));
  audit(req, 'wallet_adjust', `user:${req.params.id}`, { amount, type, reason });
  res.json({ ok: true });
});
r.post('/staff', adminOnly, (req, res) => {
  const b = req.body || {};
  const email = v.email(b.email), phone = v.phone(b.phone);
  if (q.get('SELECT 1 FROM users WHERE email=? OR phone=?', email, phone)) throw bad('Email or phone already in use');
  const perms = Array.isArray(b.permissions) ? b.permissions.filter((p) => STAFF_PERMS.includes(p)) : ['tickets'];
  const info = q.run('INSERT INTO users(role,name,email,phone,password_hash,staff_permissions,referral_code) VALUES (?,?,?,?,?,?,?)', 'staff',
    v.str(b.name, 'Name', { max: 80 }), email, phone, bcrypt.hashSync(v.password(b.password), 12), JSON.stringify(perms), 'S' + randomCode(7));
  audit(req, 'staff_create', `user:${info.lastInsertRowid}`, { perms });
  res.json({ id: Number(info.lastInsertRowid) });
});
r.post('/staff/:id/permissions', adminOnly, (req, res) => {
  const perms = Array.isArray(req.body.permissions) ? req.body.permissions.filter((p) => STAFF_PERMS.includes(p)) : [];
  q.run("UPDATE users SET staff_permissions = ?, token_version = token_version + 1 WHERE id = ? AND role = 'staff'", JSON.stringify(perms), Number(req.params.id));
  kickUser(Number(req.params.id));
  audit(req, 'staff_perms', `user:${req.params.id}`, { perms });
  res.json({ ok: true });
});

// ---------- Bookings & live tracking ----------
r.get('/bookings', requirePerm('bookings'), (req, res) => {
  res.json({ items: q.all(`SELECT b.id, b.category, b.mode, b.status, b.start_date, b.end_date, b.time, b.amount, b.total_sessions,
    p.name parent, t.name tutor FROM bookings b JOIN users p ON p.id=b.parent_id JOIN users t ON t.id=b.tutor_id ORDER BY b.id DESC LIMIT 300`) });
});
r.get('/live', requirePerm('sos'), (_req, res) => {
  res.json({ items: q.all(`SELECT s.id session_id, s.status, b.id booking_id, b.lat dest_lat, b.lng dest_lng, t.name tutor, p.name parent,
      l.lat, l.lng, l.updated_at FROM sessions s JOIN bookings b ON b.id=s.booking_id JOIN users t ON t.id=b.tutor_id
      JOIN users p ON p.id=b.parent_id LEFT JOIN tutor_locations l ON l.tutor_id=b.tutor_id WHERE s.status IN ('on_the_way','in_progress')`) });
});
r.get('/sos', requirePerm('sos'), (_req, res) => {
  res.json({ items: q.all(`SELECT a.*, u.name, u.phone, u.role FROM sos_alerts a JOIN users u ON u.id=a.user_id ORDER BY a.status='open' DESC, a.id DESC LIMIT 100`) });
});
r.post('/sos/:id/handle', requirePerm('sos'), (req, res) => {
  q.run("UPDATE sos_alerts SET status='handled', handled_by=? WHERE id=?", req.user.id, Number(req.params.id));
  audit(req, 'sos_handled', `sos:${req.params.id}`);
  res.json({ ok: true });
});

// ---------- Coupons ----------
r.get('/coupons', adminOnly, (_req, res) => res.json({ items: q.all('SELECT * FROM coupons ORDER BY rowid DESC') }));
r.post('/coupons', adminOnly, (req, res) => {
  const b = req.body || {};
  const code = v.str(b.code, 'Code', { min: 3, max: 20 }).toUpperCase();
  if (!/^[A-Z0-9]+$/.test(code)) throw bad('Code: letters and numbers only');
  const type = v.oneOf(b.type, 'Type', ['percent', 'flat']);
  const value = type === 'percent' ? v.int(b.value, 'Percent', { min: 1, max: 100 }) : v.rupees(b.value, 'Amount', { min: 1 });
  q.run(`INSERT INTO coupons(code,type,value,max_discount,min_amount,usage_limit,per_user_limit,expires_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET type=excluded.type, value=excluded.value, max_discount=excluded.max_discount, min_amount=excluded.min_amount,
    usage_limit=excluded.usage_limit, per_user_limit=excluded.per_user_limit, expires_at=excluded.expires_at, active=1`,
    code, type, value, v.rupees(b.max_discount, 'Max discount', { optional: true }), v.rupees(b.min_amount || 0, 'Min amount'),
    v.int(b.usage_limit, 'Usage limit', { min: 1, optional: true }), v.int(b.per_user_limit || 1, 'Per user', { min: 1, max: 100 }),
    b.expires_at ? v.date(b.expires_at, 'Expiry') : null);
  audit(req, 'coupon_save', `coupon:${code}`);
  res.json({ ok: true });
});
r.post('/coupons/:code/toggle', adminOnly, (req, res) => {
  q.run('UPDATE coupons SET active = 1 - active WHERE code = ?', req.params.code);
  res.json({ ok: true });
});

// ---------- Ads ----------
r.get('/ads', requirePerm('ads'), (_req, res) => {
  res.json({ items: q.all('SELECT a.*, u.name advertiser FROM ads a LEFT JOIN users u ON u.id = a.advertiser_id ORDER BY a.id DESC') });
});
r.post('/ads', requirePerm('ads'), upload.single('image'), (req, res) => {
  const b = req.body;
  const days = v.int(b.days, 'Days', { min: 1, max: 365 });
  const image = req.file ? '/uploads/' + saveFile(req.file, { visibility: 'public', imagesOnly: true }).stored_name : null;
  const now = Math.floor(Date.now() / 1000);
  q.run(`INSERT INTO ads(title,body,image_url,link,placement,days,price,status,starts_at,ends_at) VALUES (?,?,?,?,?,?,?,'active',?,?)`,
    v.str(b.title, 'Title', { max: 80 }), v.str(b.body, 'Description', { max: 300, optional: true }), image, v.url(b.link, 'Link', { optional: true }),
    v.oneOf(b.placement, 'Placement', ['home', 'search', 'community', 'dashboard']), days, v.rupees(b.price || 0, 'Price received'), now, now + days * 86400);
  audit(req, 'ad_create_admin', 'ad');
  res.json({ ok: true });
});
r.post('/ads/:id/decision', requirePerm('ads'), (req, res) => {
  const a = q.get('SELECT * FROM ads WHERE id = ?', Number(req.params.id));
  if (!a) throw notFound();
  const action = v.oneOf(req.body.action, 'Action', ['approve', 'reject', 'pause', 'resume']);
  const now = Math.floor(Date.now() / 1000);
  tx(() => {
    if (action === 'approve' && a.status === 'pending') q.run("UPDATE ads SET status='active', starts_at=?, ends_at=? WHERE id=?", now, now + a.days * 86400, a.id);
    else if (action === 'reject' && a.status === 'pending') {
      q.run("UPDATE ads SET status='rejected' WHERE id=?", a.id);
      if (a.advertiser_id && a.price > 0) walletMove(a.advertiser_id, 'credit', a.price, `Refund: advertisement #${a.id} rejected`, `ad:${a.id}`);
    } else if (action === 'pause' && a.status === 'active') q.run("UPDATE ads SET status='paused' WHERE id=?", a.id);
    else if (action === 'resume' && a.status === 'paused') q.run("UPDATE ads SET status='active' WHERE id=?", a.id);
    else throw bad('Action not possible in the current state');
  });
  if (a.advertiser_id) notify(a.advertiser_id, `Your advertisement "${a.title}" was ${action === 'approve' ? 'approved and is live' : action + 'd'}`, '#/ads');
  audit(req, 'ad_' + action, `ad:${a.id}`);
  res.json({ ok: true });
});

// ---------- Community moderation ----------
r.get('/groups', requirePerm('community'), (_req, res) => {
  res.json({ items: q.all(`SELECT g.*, u.name creator, t.name tutor, (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) members
    FROM community_groups g JOIN users u ON u.id=g.creator_id LEFT JOIN users t ON t.id=g.tutor_id ORDER BY g.id DESC`) });
});
r.post('/groups/:id/close', requirePerm('community'), (req, res) => {
  const g = q.get('SELECT * FROM community_groups WHERE id = ?', Number(req.params.id));
  if (!g) throw notFound();
  tx(() => {
    if (!g.tutor_id && g.escrow > 0) {
      for (const m of q.all('SELECT parent_id, paid FROM group_members WHERE group_id = ?', g.id))
        walletMove(m.parent_id, 'credit', m.paid, `Refund: community group "${g.name}" closed by Edvitta`, `group:${g.id}`);
      q.run('UPDATE community_groups SET escrow = 0 WHERE id = ?', g.id);
    }
    q.run("UPDATE community_groups SET status='closed' WHERE id=?", g.id);
  });
  audit(req, 'group_close', `group:${g.id}`);
  res.json({ ok: true });
});

// ---------- Settings ----------
const SETTING_KEYS = {
  commission_percent: 'int', search_radius_km: 'num', referral_bonus_referrer: 'rupees', referral_bonus_referee: 'rupees',
  welcome_bonus: 'rupees', admin_upi_id: 'str', admin_upi_name: 'str', helpline_phone: 'str',
  ad_price_home: 'rupees', ad_price_search: 'rupees', ad_price_community: 'rupees', ad_price_dashboard: 'rupees',
};
r.get('/settings', adminOnly, (_req, res) => {
  const out = {};
  for (const k of Object.keys(SETTING_KEYS)) out[k] = getSetting(k, '');
  out.admin_qr_image = getSetting('admin_qr_image', '');
  res.json({ settings: out });
});
r.post('/settings', adminOnly, (req, res) => {
  const b = req.body || {};
  for (const [k, type] of Object.entries(SETTING_KEYS)) {
    if (b[k] === undefined) continue;
    let val;
    if (type === 'int') val = v.int(b[k], k, { min: 0, max: 50 });
    else if (type === 'num') val = v.num(b[k], k, { min: 0.5, max: 50 });
    else if (type === 'rupees') val = v.rupees(b[k], k);
    else val = v.str(b[k], k, { max: 100, optional: true }) || '';
    setSetting(k, val);
  }
  audit(req, 'settings_update', 'settings', b);
  res.json({ ok: true });
});
r.post('/settings/qr', adminOnly, upload.single('qr'), (req, res) => {
  const f = saveFile(req.file, { visibility: 'public', imagesOnly: true });
  setSetting('admin_qr_image', '/uploads/' + f.stored_name);
  audit(req, 'qr_update', 'settings');
  res.json({ ok: true });
});
r.post('/categories', adminOnly, (req, res) => {
  const name = v.str(req.body.name, 'Name', { max: 40 });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  q.run('INSERT OR IGNORE INTO categories(slug,name,grp,icon) VALUES (?,?,?,?)', slug, name,
    v.oneOf(req.body.grp, 'Group', ['Academics', 'Arts', 'Music', 'Dance', 'Sports & Fitness', 'Languages', 'Technology', 'Other']),
    v.str(req.body.icon, 'Icon', { max: 4, optional: true }) || '📘');
  res.json({ ok: true });
});

// ---------- Config: feature switches, commission & GST, email (Hostinger), payments, calls, video ----------
// type: bool | int | pct | num | rupees | str | email | secret. Secrets are encrypted and never sent back to the browser.
const CONFIG = [
  ['Business', 'commission_percent', 'pct', '15', 'Platform commission (%) on every class and community group fee'],
  ['Business', 'search_radius_km', 'num', '3', 'Home tutor search radius (km)'],
  ['Business', 'helpline_phone', 'str', '', 'Helpline phone shown after SOS'],
  ['Business', 'app_url', 'str', '', 'Public app link used in emails (e.g. https://edvitta.in)'],
  ['Invoices & GST', 'gst_enabled', 'bool', '0', 'Charge GST on commission (turn on after GST registration)'],
  ['Invoices & GST', 'gst_percent', 'pct', '18', 'GST rate on commission (%)'],
  ['Invoices & GST', 'platform_legal_name', 'str', 'Edvitta', 'Legal business name on invoices'],
  ['Invoices & GST', 'platform_gstin', 'str', '', 'Your GSTIN'],
  ['Invoices & GST', 'platform_address', 'str', '', 'Registered address'],
  ['Invoices & GST', 'platform_state', 'str', 'Karnataka', 'State'],
  ['Invoices & GST', 'platform_sac', 'str', '998599', 'SAC code for commission service'],
  ['Invoices & GST', 'invoice_prefix', 'str', 'EDV', 'Invoice number prefix'],
  ['Email (Hostinger)', 'email_enabled', 'bool', '0', 'Send emails'],
  ['Email (Hostinger)', 'smtp_host', 'str', 'smtp.hostinger.com', 'SMTP server'],
  ['Email (Hostinger)', 'smtp_port', 'int', '465', 'SMTP port (465 = SSL)'],
  ['Email (Hostinger)', 'smtp_user', 'str', '', 'Mailbox (e.g. no-reply@yourdomain.in)'],
  ['Email (Hostinger)', 'smtp_pass', 'secret', '', 'Mailbox password'],
  ['Email (Hostinger)', 'smtp_from_name', 'str', 'Edvitta', 'Sender name'],
  ['Login & security', 'otp_login_enabled', 'bool', '1', 'Allow login with a 6-digit email code'],
  ['Login & security', 'staff_2fa_enabled', 'bool', '1', '2-step sign-in for admin and staff: password + a code sent to their email (works once email is set up)'],
  ['Login & security', 'require_email_verification', 'bool', '0', 'Require a verified email before booking, KYC submit, joining groups and withdrawals'],
  ['Notifications', 'email_notifications_enabled', 'bool', '1', 'Email notifications (bookings, tutor arrival, payments, tickets)'],
  ['Payments', 'payment_gateway_enabled', 'bool', '0', 'Online payments via Razorpay (keep OFF until your account is ready)'],
  ['Payments', 'razorpay_key_id', 'str', '', 'Razorpay Key ID'],
  ['Payments', 'razorpay_key_secret', 'secret', '', 'Razorpay Key Secret'],
  ['Payments', 'razorpay_webhook_secret', 'secret', '', 'Razorpay Webhook Secret (webhook URL: /api/payments/razorpay/webhook)'],
  ['Payments', 'demo_payments_enabled', 'bool', '0', 'Demo top-up for testing (disabled in production)'],
  ['Payments', 'admin_upi_id', 'str', 'edvitta@upi', 'UPI ID for manual QR payments'],
  ['Payments', 'admin_upi_name', 'str', 'Edvitta', 'UPI payee name'],
  ['Privacy & calls', 'mask_phone_numbers', 'bool', '1', 'Hide phone numbers between parents and tutors'],
  ['Privacy & calls', 'chat_enabled', 'bool', '1', 'In-app chat (numbers and emails are hidden automatically)'],
  ['Privacy & calls', 'masked_calls_enabled', 'bool', '0', 'Masked calls through Exotel'],
  ['Privacy & calls', 'exotel_sid', 'str', '', 'Exotel Account SID'],
  ['Privacy & calls', 'exotel_api_key', 'str', '', 'Exotel API key'],
  ['Privacy & calls', 'exotel_api_token', 'secret', '', 'Exotel API token'],
  ['Privacy & calls', 'exotel_caller_id', 'str', '', 'Exotel virtual number (ExoPhone)'],
  ['Privacy & calls', 'exotel_subdomain', 'str', 'api.exotel.com', 'Exotel API host'],
  ['Classes', 'video_enabled', 'bool', '1', 'In-app video classes for online bookings'],
  ['Classes', 'turn_url', 'str', '', 'TURN server URL (optional, improves video on strict networks)'],
  ['Classes', 'turn_username', 'str', '', 'TURN username'],
  ['Classes', 'turn_credential', 'secret', '', 'TURN password'],
  ['Classes', 'trial_enabled', 'bool', '1', 'Free / low-cost trial class before booking a plan'],
  ['Classes', 'packages_enabled', 'bool', '1', 'Subscription packages (e.g. 20 classes a month)'],
  ['Rewards', 'referral_bonus_referrer', 'rupees', '10000', 'Referral reward to the person who invites (₹)'],
  ['Rewards', 'referral_bonus_referee', 'rupees', '5000', 'Referral reward to the new user (₹)'],
  ['Rewards', 'welcome_bonus', 'rupees', '0', 'Welcome bonus on signup (₹)'],
  ['Classes', 'student_absent_policy', 'choice:makeup|charge', 'makeup', 'When a student is absent: makeup = free make-up class, charge = class is counted and the tutor is paid'],
  ['Classes', 'tutor_leave_days_per_month', 'count', '4', 'Leave days a tutor can take each month (classes move to the end of the plan)'],
  ['Classes', 'parent_leave_days_per_booking', 'count', '6', 'Leave days a parent can add on one booking'],
  ['Payouts', 'weekly_payout_report_enabled', 'bool', '1', 'Send every tutor a weekly earnings summary on Monday'],
  ['Payouts', 'auto_weekly_settlement', 'bool', '0', 'Every Monday, move last week\'s earnings into payout requests to each tutor\'s saved UPI'],
  ['WhatsApp', 'whatsapp_enabled', 'bool', '0', 'WhatsApp alerts through the Meta WhatsApp Cloud API (keep OFF until your account and template are approved)'],
  ['WhatsApp', 'whatsapp_important_only', 'bool', '1', 'Send only important alerts (bookings, tutor on the way, class moved, payments, SOS)'],
  ['WhatsApp', 'whatsapp_phone_number_id', 'str', '', 'Phone number ID (from Meta WhatsApp Manager → API setup)'],
  ['WhatsApp', 'whatsapp_token', 'secret', '', 'Permanent access token (system user token)'],
  ['WhatsApp', 'whatsapp_template', 'str', 'edvitta_alert', 'Approved template name. Its body must have one variable, e.g. "Edvitta: {{1}}"'],
  ['WhatsApp', 'whatsapp_template_lang', 'str', 'en', 'Template language code (e.g. en, en_US, hi)'],
  ['Advertising', 'ad_price_home', 'rupees', '20000', 'Home screen ad price per day (₹)'],
  ['Advertising', 'ad_price_search', 'rupees', '15000', 'Search screen ad price per day (₹)'],
  ['Advertising', 'ad_price_community', 'rupees', '10000', 'Community ad price per day (₹)'],
  ['Advertising', 'ad_price_dashboard', 'rupees', '10000', 'Dashboard ad price per day (₹)'],
];
r.get('/config', adminOnly, (_req, res) => {
  res.json({
    items: CONFIG.map(([group, key, type, def, label]) => ({ group, key, type, label,
      value: type === 'secret' ? '' : type === 'rupees' ? Number(getSetting(key, def)) / 100 : getSetting(key, def),
      is_set: type === 'secret' ? !!getSecret(key) : undefined })),
    email_configured: mailer.isConfigured(), whatsapp_configured: require('../whatsapp').isConfigured(), admin_qr_image: getSetting('admin_qr_image', ''),
  });
});
r.post('/config', adminOnly, (req, res) => {
  const b = req.body || {};
  const changed = [];
  for (const [, key, type, , label] of CONFIG) {
    if (b[key] === undefined) continue;
    const val = b[key];
    if (type === 'secret') { if (val === '' || val === null) continue; setSecret(key, v.str(val, label, { max: 300 })); changed.push(key); continue; }
    let out;
    if (type === 'bool') out = val === true || val === '1' || val === 1 || val === 'on' ? '1' : '0';
    else if (type === 'pct') out = String(v.num(val, label, { min: 0, max: 100 }));
    else if (type === 'int') out = String(v.int(val, label, { min: 1, max: 65535 }));
    else if (type === 'num') out = String(v.num(val, label, { min: 0.5, max: 50 }));
    else if (type === 'rupees') out = String(v.rupees(val, label));
    else if (type === 'count') out = String(v.int(val, label, { min: 0, max: 31 }));
    else if (type.startsWith('choice:')) out = v.oneOf(String(val), label, type.slice(7).split('|'));
    else out = v.str(String(val), label, { max: 300, optional: true }) || '';
    if (key === 'app_url' && out) v.url(out, label);
    if (key === 'whatsapp_phone_number_id' && out && !/^\d{5,25}$/.test(out)) throw bad('Phone number ID must be digits only');
    if (key === 'whatsapp_template' && out && !/^[a-z0-9_]{1,512}$/.test(out)) throw bad('Template name can have only lowercase letters, numbers and _');
    if (key === 'whatsapp_template_lang' && out && !/^[a-z]{2}(_[A-Z]{2})?$/.test(out)) throw bad('Language code looks wrong (e.g. en or en_US)');
    setSetting(key, out); changed.push(key);
  }
  for (const k of Array.isArray(b.clear_secrets) ? b.clear_secrets : []) if (CONFIG.some((c) => c[1] === k && c[2] === 'secret')) { setSecret(k, ''); changed.push(k); }
  audit(req, 'config_update', 'config', { changed });
  res.json({ ok: true, changed });
});
r.post('/config/test-email', adminOnly, async (req, res, next) => {
  try {
    const to = v.email(req.body.to || req.user.email);
    const r2 = await mailer.sendMail(to, 'Edvitta test email', 'Email is working ✅', '<p>Your Hostinger email settings are correct. OTPs and notifications will be sent from this mailbox.</p>', { force: true });
    if (!r2.sent) throw bad('Email failed: ' + (r2.error || 'SMTP is not configured'));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.post('/config/test-whatsapp', adminOnly, async (req, res, next) => {
  try {
    const phone = v.phone(req.body.to || req.user.phone);
    const r2 = await require('../whatsapp').sendText(phone, 'This is a test alert. WhatsApp alerts are working.', { force: true });
    if (!r2.sent) throw bad('WhatsApp failed: ' + (r2.error || 'not configured'));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Background checks ----------
r.post('/kyc/:id/background', requirePerm('kyc'), (req, res) => {
  const id = Number(req.params.id);
  if (!q.get('SELECT 1 FROM tutor_profiles WHERE user_id = ?', id)) throw notFound();
  const status = v.oneOf(req.body.status, 'Background check', ['not_started', 'in_progress', 'clear', 'flagged']);
  const note = v.str(req.body.note, 'Note', { max: 500, optional: status !== 'flagged' });
  q.run(`UPDATE tutor_profiles SET background_check=?, background_note=?, background_checked_at=unixepoch(), police_verification=?,
    available = CASE WHEN ? = 'flagged' THEN 0 ELSE available END WHERE user_id=?`, status, note, req.body.police_verified ? 1 : 0, status, id);
  if (status === 'clear' && req.body.police_verified) notify(id, '✅ Your background check is complete. You now have the "Verified" badge.', '#/tutor');
  if (status === 'flagged') notify(id, 'Your profile is on hold after the background check. Our team will contact you.', '#/support');
  audit(req, 'background_' + status, `user:${id}`, { note });
  res.json({ ok: true });
});

// ---------- Packages ----------
r.get('/packages', adminOnly, (_req, res) => res.json({ items: q.all('SELECT * FROM packages ORDER BY sessions') }));
r.post('/packages', adminOnly, (req, res) => {
  const b = req.body || {};
  q.run('INSERT INTO packages(name, sessions, validity_days, discount_percent, description) VALUES (?,?,?,?,?)',
    v.str(b.name, 'Name', { max: 60 }), v.int(b.sessions, 'Classes', { min: 2, max: 120 }), v.int(b.validity_days, 'Validity', { min: 7, max: 365 }),
    v.int(b.discount_percent, 'Discount', { min: 0, max: 60 }), v.str(b.description, 'Description', { max: 200, optional: true }));
  audit(req, 'package_create', 'package');
  res.json({ ok: true });
});
r.post('/packages/:id/toggle', adminOnly, (req, res) => { q.run('UPDATE packages SET active = 1 - active WHERE id = ?', Number(req.params.id)); res.json({ ok: true }); });

// ---------- Invoices & commission report ----------
r.get('/invoices', requirePerm('payments'), (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  const type = ['commission', 'booking'].includes(req.query.type) ? req.query.type : 'commission';
  const where = 'WHERE i.type = ?' + (month ? ' AND i.period = ?' : '');
  const p = month ? [type, month] : [type];
  res.json({
    items: q.all(`SELECT i.id, i.number, i.type, i.gross, i.commission, i.gst, i.net, i.created_at, u.name FROM invoices i JOIN users u ON u.id = i.user_id ${where} ORDER BY i.id DESC LIMIT 300`, ...p),
    totals: q.get(`SELECT COUNT(*) n, COALESCE(SUM(gross),0) gross, COALESCE(SUM(commission),0) commission, COALESCE(SUM(gst),0) gst, COALESCE(SUM(net),0) net FROM invoices i ${where}`, ...p),
    months: q.all('SELECT DISTINCT period FROM invoices ORDER BY period DESC LIMIT 24').map((x) => x.period),
  });
});

// ---------- Communication logs (email, calls, video, chat moderation) ----------
r.get('/comms', requirePerm('bookings'), (_req, res) => {
  res.json({
    emails: q.all('SELECT * FROM email_log ORDER BY id DESC LIMIT 100'),
    whatsapp: q.all('SELECT * FROM whatsapp_log ORDER BY id DESC LIMIT 100'),
    calls: q.all(`SELECT c.*, u.name FROM call_logs c JOIN users u ON u.id = c.caller_id ORDER BY c.id DESC LIMIT 100`),
    flagged: q.all(`SELECT m.id, m.booking_id, m.body, m.created_at, u.name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.flagged = 1 ORDER BY m.id DESC LIMIT 100`),
  });
});

r.get('/audit', adminOnly, (_req, res) => {
  res.json({ items: q.all('SELECT a.*, u.name actor FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 300') });
});

module.exports = r;
