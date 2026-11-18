'use strict';
// Wallet, manual QR payments, withdrawals, coupons check, referrals, ads.
const express = require('express');
const crypto = require('crypto');
const { q, tx, getSetting, getSecret, flag } = require('../db');
const { v, bad, notFound, requireAuth, requireVerified, audit, walletMove, notify, evaluateCoupon, IS_PROD } = require('../lib');
const { upload, saveFile } = require('../uploads');

const r = express.Router();

r.get('/wallet', requireAuth('parent', 'tutor'), (req, res) => {
  const u = q.get('SELECT wallet_balance FROM users WHERE id = ?', req.user.id);
  res.json({
    balance: u.wallet_balance,
    txns: q.all('SELECT * FROM wallet_txns WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id),
    manual: q.all('SELECT id, amount, utr, status, note, created_at FROM manual_payments WHERE user_id = ? ORDER BY id DESC LIMIT 20', req.user.id),
    withdrawals: q.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 20', req.user.id),
    upi_id: getSetting('admin_upi_id', ''),
    upi_name: getSetting('admin_upi_name', 'Edvitta'),
    qr_image: getSetting('admin_qr_image', ''),
    gateway_enabled: gatewayOn(),
    razorpay_key_id: gatewayOn() ? getSetting('razorpay_key_id', '') : '',
    demo_enabled: demoOn(),
  });
});

// ---------- Online payments (Razorpay) ----------
// Switched OFF by default. The admin turns it on in Config once a Razorpay account is ready.
const gatewayOn = () => flag('payment_gateway_enabled') && !!getSetting('razorpay_key_id', '') && !!getSecret('razorpay_key_secret');
// Demo top-up (instant credit) exists only for testing and is never available in production.
const demoOn = () => flag('demo_payments_enabled') && !(IS_PROD && process.env.ALLOW_DEMO_PAYMENTS !== '1');

r.post('/wallet/topup', requireAuth('parent', 'tutor'), (req, res) => {
  if (!demoOn()) throw bad('Online payments are not enabled yet. Please use the UPI QR payment.');
  const amount = v.rupees(req.body.amount, 'Amount', { min: 10, max: 50000 });
  const bal = tx(() => walletMove(req.user.id, 'credit', amount, 'Wallet top-up (demo payment)', 'demo:' + crypto.randomBytes(6).toString('hex')));
  audit(req, 'wallet_topup_demo', `user:${req.user.id}`, { amount });
  res.json({ balance: bal });
});

function rzpAuth() {
  return 'Basic ' + Buffer.from(`${getSetting('razorpay_key_id', '')}:${getSecret('razorpay_key_secret')}`).toString('base64');
}
function creditOrder(orderId, paymentId) {
  return tx(() => {
    const o = q.get('SELECT * FROM payment_orders WHERE order_id = ?', orderId);
    if (!o) throw bad('Unknown order');
    if (o.status === 'paid') return { already: true, user_id: o.user_id };
    q.run("UPDATE payment_orders SET status='paid', payment_id=? WHERE id=?", paymentId, o.id);
    walletMove(o.user_id, 'credit', o.amount, 'Wallet top-up (online payment)', `rzp:${paymentId}`);
    return { user_id: o.user_id, amount: o.amount };
  });
}

r.post('/wallet/order', requireAuth('parent', 'tutor'), async (req, res, next) => {
  try {
    if (!gatewayOn()) throw bad('Online payments are not enabled yet. Please use the UPI QR payment.');
    const amount = v.rupees(req.body.amount, 'Amount', { min: 10, max: 100000 });
    const resp = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { Authorization: rzpAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, currency: 'INR', receipt: `w${req.user.id}-${Date.now()}`, notes: { user_id: String(req.user.id) } }) });
    const j = await resp.json();
    if (!resp.ok) throw bad('Payment gateway error. Please try again.');
    q.run('INSERT INTO payment_orders(user_id, provider, order_id, amount) VALUES (?,?,?,?)', req.user.id, 'razorpay', j.id, amount);
    res.json({ key_id: getSetting('razorpay_key_id', ''), order_id: j.id, amount, name: req.user.name, email: req.user.email, phone: req.user.phone });
  } catch (e) { next(e); }
});

// Browser confirms the payment; we verify Razorpay's HMAC signature before crediting.
r.post('/wallet/order/verify', requireAuth('parent', 'tutor'), (req, res) => {
  const orderId = v.str(req.body.razorpay_order_id, 'Order', { max: 60 }), paymentId = v.str(req.body.razorpay_payment_id, 'Payment', { max: 60 });
  const sig = v.str(req.body.razorpay_signature, 'Signature', { max: 200 });
  // Never verify with an empty key (it would let anyone compute a valid signature).
  if (!getSecret('razorpay_key_secret')) throw bad('Online payments are not enabled');
  const expected = crypto.createHmac('sha256', getSecret('razorpay_key_secret')).update(`${orderId}|${paymentId}`).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw bad('Payment could not be verified');
  const o = q.get('SELECT user_id FROM payment_orders WHERE order_id = ?', orderId);
  if (!o || o.user_id !== req.user.id) throw bad('Unknown order');
  creditOrder(orderId, paymentId);
  audit(req, 'wallet_topup_online', `user:${req.user.id}`, { orderId });
  res.json({ ok: true, balance: q.get('SELECT wallet_balance FROM users WHERE id = ?', req.user.id).wallet_balance });
});

// Server-to-server webhook (backup in case the browser closes before verify). Raw body is required for the signature.
r.post('/payments/razorpay/webhook', express.raw({ type: '*/*', limit: '200kb' }), (req, res) => {
  const secret = getSecret('razorpay_webhook_secret');
  const sig = String(req.get('X-Razorpay-Signature') || '');
  const expected = secret ? crypto.createHmac('sha256', secret).update(req.body).digest('hex') : '';
  if (!secret || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.status(400).json({ error: 'bad signature' });
  let ev;
  try { ev = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'bad body' }); }
  if (ev.event === 'payment.captured' || ev.event === 'order.paid') {
    const p = ev.payload?.payment?.entity;
    const o = p?.order_id && q.get('SELECT amount FROM payment_orders WHERE order_id = ?', p.order_id);
    // Credit only the amount we created the order for, and only when Razorpay reports that exact amount in INR.
    if (o && Number(p.amount) === o.amount && (p.currency || 'INR') === 'INR') creditOrder(p.order_id, String(p.id).slice(0, 60));
  }
  res.json({ ok: true });
});

// Manual payment: user pays the admin UPI QR, then submits UTR / reference number + screenshot for verification.
r.post('/wallet/manual', requireAuth('parent', 'tutor'), upload.single('proof'), (req, res) => {
  const amount = v.rupees(req.body.amount, 'Amount', { min: 10, max: 100000 });
  const utr = v.str(req.body.utr, 'UTR / Transaction ID', { min: 6, max: 40 }).toUpperCase();
  if (!/^[A-Z0-9]+$/.test(utr)) throw bad('UTR should contain only letters and numbers');
  if (q.get('SELECT 1 FROM manual_payments WHERE utr = ?', utr)) throw bad('This transaction ID was already submitted');
  const proof = req.file ? saveFile(req.file, { visibility: 'private', imagesOnly: true }).stored_name : null;
  q.run('INSERT INTO manual_payments(user_id, amount, utr, proof_name) VALUES (?,?,?,?)', req.user.id, amount, utr, proof);
  audit(req, 'manual_payment_submit', `user:${req.user.id}`, { amount, utr });
  res.json({ ok: true });
});

r.post('/wallet/withdraw', requireAuth('tutor', 'parent'), requireVerified, (req, res) => {
  const amount = v.rupees(req.body.amount, 'Amount', { min: 100, max: 200000 });
  const upi = v.str(req.body.upi_id, 'UPI ID', { max: 60 });
  if (!/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upi)) throw bad('Enter a valid UPI ID (e.g. name@okbank)');
  // Reward money (referral / welcome bonus from the last 90 days) can be spent on classes but not withdrawn.
  const bonus = q.get(`SELECT COALESCE(SUM(amount),0) n FROM wallet_txns WHERE user_id = ? AND type = 'credit'
    AND reason IN ('Referral reward','Referral joining reward','Welcome bonus') AND created_at > unixepoch() - 90 * 86400`, req.user.id).n;
  const withdrawable = Math.max(0, q.get('SELECT wallet_balance FROM users WHERE id = ?', req.user.id).wallet_balance - bonus);
  if (amount > withdrawable) throw bad(`You can withdraw up to ₹${(withdrawable / 100).toFixed(2)}. Reward money can be used for classes but not withdrawn.`);
  tx(() => {
    walletMove(req.user.id, 'debit', amount, 'Withdrawal request (on hold)', 'withdrawal');
    q.run('INSERT INTO withdrawals(user_id, amount, upi_id) VALUES (?,?,?)', req.user.id, amount, upi);
  });
  audit(req, 'withdraw_request', `user:${req.user.id}`, { amount });
  res.json({ ok: true });
});

r.post('/coupons/check', requireAuth('parent'), (req, res) => {
  const amount = v.rupees(req.body.amount, 'Amount');
  const { coupon, discount } = evaluateCoupon(v.str(req.body.code, 'Coupon', { max: 30 }), req.user.id, amount);
  res.json({ code: coupon.code, discount });
});
r.get('/coupons/available', requireAuth('parent'), (_req, res) => {
  res.json({ items: q.all(`SELECT code, type, value, max_discount, min_amount, expires_at FROM coupons
    WHERE active = 1 AND (expires_at IS NULL OR expires_at >= date('now')) AND (usage_limit IS NULL OR used_count < usage_limit)`) });
});

r.get('/referrals', requireAuth('parent', 'tutor'), (req, res) => {
  const people = q.all('SELECT name, role, referral_rewarded, created_at FROM users WHERE referred_by = ? ORDER BY id DESC', req.user.id)
    .map((p) => ({ ...p, name: p.name.split(' ')[0] }));
  const earned = q.get("SELECT COALESCE(SUM(amount),0) s FROM wallet_txns WHERE user_id = ? AND reason = 'Referral reward'", req.user.id).s;
  res.json({ code: req.user.referral_code, people, earned,
    bonus_referrer: Number(getSetting('referral_bonus_referrer', '10000')), bonus_referee: Number(getSetting('referral_bonus_referee', '5000')) });
});

// ---------- Advertisements ----------
r.get('/ads', (req, res) => {
  const placement = ['home', 'search', 'community', 'dashboard'].includes(req.query.placement) ? req.query.placement : 'home';
  const now = Math.floor(Date.now() / 1000);
  q.run("UPDATE ads SET status='expired' WHERE status='active' AND ends_at < ?", now);
  const ads = q.all("SELECT id, title, body, image_url, link FROM ads WHERE status='active' AND placement=? ORDER BY RANDOM() LIMIT 2", placement);
  for (const a of ads) q.run('UPDATE ads SET impressions = impressions + 1 WHERE id = ?', a.id);
  res.json({ items: ads.map((a) => ({ ...a, link: a.link ? `/api/ads/${a.id}/click` : null })) });
});

r.get('/ads/:id/click', (req, res) => {
  const a = q.get("SELECT id, link FROM ads WHERE id = ? AND status='active'", Number(req.params.id));
  if (!a || !a.link) throw notFound();
  q.run('UPDATE ads SET clicks = clicks + 1 WHERE id = ?', a.id);
  res.redirect(302, a.link);
});

r.get('/ads/pricing', requireAuth(), (_req, res) => res.json({ prices: adPrices() }));
function adPrices() {
  return { home: Number(getSetting('ad_price_home', '20000')), search: Number(getSetting('ad_price_search', '15000')),
    community: Number(getSetting('ad_price_community', '10000')), dashboard: Number(getSetting('ad_price_dashboard', '10000')) };
}

r.get('/my-ads', requireAuth('parent', 'tutor'), (req, res) => {
  res.json({ items: q.all('SELECT * FROM ads WHERE advertiser_id = ? ORDER BY id DESC', req.user.id), prices: adPrices() });
});

// Anyone can buy an ad slot from their wallet. Admin reviews it before it goes live; rejected ads are refunded.
r.post('/my-ads', requireAuth('parent', 'tutor'), upload.single('image'), (req, res) => {
  const b = req.body;
  const placement = v.oneOf(b.placement, 'Placement', ['home', 'search', 'community', 'dashboard']);
  const days = v.int(b.days, 'Days', { min: 1, max: 90 });
  const price = adPrices()[placement] * days;
  const image = req.file ? '/uploads/' + saveFile(req.file, { visibility: 'public', imagesOnly: true }).stored_name : null;
  const id = tx(() => {
    const info = q.run('INSERT INTO ads(advertiser_id,title,body,image_url,link,placement,days,price) VALUES (?,?,?,?,?,?,?,?)',
      req.user.id, v.str(b.title, 'Title', { max: 80 }), v.str(b.body, 'Description', { max: 300, optional: true }), image,
      v.url(b.link, 'Link', { optional: true }), placement, days, price);
    const id = Number(info.lastInsertRowid);
    walletMove(req.user.id, 'debit', price, `Advertisement #${id} (${days} days, ${placement})`, `ad:${id}`);
    return id;
  });
  audit(req, 'ad_create', `ad:${id}`);
  res.json({ id });
});

module.exports = r;
