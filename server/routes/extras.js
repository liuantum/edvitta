'use strict';
// Chat, masked calls, progress reports, homework, video class config, packages, earnings & invoices, public config.
const express = require('express');
const { q, tx, getSetting, getSecret, flag } = require('../db');
const lib = require('../lib');
const { v, bad, forbidden, notFound, requireAuth, audit, notify } = lib;
const { loadBookingFor } = require('./bookings');
const { platformInfo } = require('../finance');

const r = express.Router();

// ---------- Public feature flags (what the app should show) ----------
r.get('/config', (_req, res) => {
  res.json({
    otp_login: flag('otp_login_enabled', '1'), require_email_verification: flag('require_email_verification'),
    online_payments: flag('payment_gateway_enabled') && !!getSetting('razorpay_key_id', ''), demo_payments: flag('demo_payments_enabled'),
    chat: flag('chat_enabled', '1'), masked_calls: flag('masked_calls_enabled'), phone_masked: flag('mask_phone_numbers', '1'),
    video: flag('video_enabled', '1'), trial: flag('trial_enabled', '1'), packages: flag('packages_enabled', '1'),
    gst: flag('gst_enabled'), commission_percent: Number(getSetting('commission_percent', '15')),
    whatsapp: require('../whatsapp').enabled(), student_absent_policy: getSetting('student_absent_policy', 'makeup'),
    languages: ['en', 'hi', 'kn', 'te'],
  });
});

// ---------- In-app chat (keeps phone numbers private) ----------
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Spelled-out numbers ("nine eight seven six ...") and off-app contact attempts are caught too.
const NUM_WORDS = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|double|triple|ek|do|teen|char|paanch|chhe|saat|aath|nau|shunya)';
const SPELLED_RE = new RegExp(`\\b${NUM_WORDS}(?:[\\s,.\\-]+(?:${NUM_WORDS}|\\d)){5,}\\b`, 'gi');
const OFFAPP_RE = /\b(whats\s*app|wa\.me|telegram|t\.me|insta(gram)?|snap\s*chat|facebook|fb\.com|signal app|call me|my number|dm me)\b/i;
const LINK_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
function scrub(text) {
  let flagged = false;
  let out = text.replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? ((flagged = true), '[number hidden]') : m));
  out = out.replace(EMAIL_RE, () => ((flagged = true), '[email hidden]'));
  out = out.replace(SPELLED_RE, () => ((flagged = true), '[number hidden]'));
  // Links are hidden except class links on common meeting sites.
  out = out.replace(LINK_RE, (m) => (/^https:\/\/(meet\.google\.com|([\w-]+\.)?zoom\.us|teams\.microsoft\.com)\//i.test(m) ? m : ((flagged = true), '[link hidden]')));
  if (OFFAPP_RE.test(out)) flagged = true; // kept visible, but staff are alerted
  return { body: out, flagged };
}
function chatBooking(req) {
  if (!flag('chat_enabled', '1')) throw bad('Chat is turned off');
  const b = loadBookingFor(req, Number(req.params.id));
  if (['rejected', 'cancelled'].includes(b.status)) throw bad('Chat is closed for this booking');
  return b;
}
r.get('/bookings/:id/messages', requireAuth(), (req, res) => {
  const b = chatBooking(req);
  if (req.user.id === b.parent_id || req.user.id === b.tutor_id) q.run('UPDATE messages SET read = 1 WHERE booking_id = ? AND sender_id != ?', b.id, req.user.id);
  res.json({ items: q.all(`SELECT m.id, m.body, m.sender_id, m.flagged, m.created_at, u.name sender FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.booking_id = ? ORDER BY m.id DESC LIMIT 200`, b.id).reverse() });
});
r.post('/bookings/:id/messages', requireAuth('parent', 'tutor'), (req, res) => {
  const b = chatBooking(req);
  const { body, flagged } = scrub(v.str(req.body.body, 'Message', { max: 1000 }));
  const info = q.run('INSERT INTO messages(booking_id, sender_id, body, flagged) VALUES (?,?,?,?)', b.id, req.user.id, body, flagged ? 1 : 0);
  const other = req.user.id === b.parent_id ? b.tutor_id : b.parent_id;
  const msg = { id: Number(info.lastInsertRowid), booking_id: b.id, body, sender_id: req.user.id, sender: req.user.name, flagged, created_at: Math.floor(Date.now() / 1000) };
  lib.io?.to(`user:${other}`).to(`user:${req.user.id}`).emit('chat', msg);
  if (flagged) audit(req, 'chat_contact_hidden', `booking:${b.id}`);
  res.json({ message: msg, notice: flagged ? 'For safety, phone numbers and emails are hidden. Please use in-app chat and calls.' : null });
});

// ---------- Masked calls (Exotel click-to-call; both sides see only the Edvitta number) ----------
r.post('/bookings/:id/call', requireAuth('parent', 'tutor'), async (req, res, next) => {
  try {
    if (!flag('masked_calls_enabled')) throw bad('Calling is turned off. Please use chat.');
    const b = loadBookingFor(req, Number(req.params.id));
    if (b.status !== 'accepted') throw bad('Calls are available for confirmed bookings only');
    const sid = getSetting('exotel_sid', ''), key = getSetting('exotel_api_key', ''), token = getSecret('exotel_api_token'), callerId = getSetting('exotel_caller_id', '');
    const sub = getSetting('exotel_subdomain', 'api.exotel.com');
    if (!sid || !key || !token || !callerId) throw bad('Calling is not configured yet');
    const otherId = req.user.id === b.parent_id ? b.tutor_id : b.parent_id;
    const from = q.get('SELECT phone FROM users WHERE id = ?', req.user.id).phone;
    const to = q.get('SELECT phone FROM users WHERE id = ?', otherId).phone;
    const body = new URLSearchParams({ From: from, To: to, CallerId: callerId, Record: 'true', TimeLimit: '1800' });
    const resp = await fetch(`https://${sub}/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect.json`, {
      method: 'POST', body, headers: { Authorization: 'Basic ' + Buffer.from(`${key}:${token}`).toString('base64') } });
    const j = await resp.json().catch(() => ({}));
    q.run('INSERT INTO call_logs(booking_id, caller_id, kind, status, provider_ref) VALUES (?,?,?,?,?)', b.id, req.user.id, 'masked_call',
      resp.ok ? 'initiated' : 'failed', j?.Call?.Sid || null);
    if (!resp.ok) throw bad('Could not place the call right now. Please try chat.');
    res.json({ ok: true, message: 'You will get a call from the Edvitta number in a few seconds.' });
  } catch (e) { next(e); }
});

// ---------- Progress reports & homework ----------
r.post('/bookings/:id/progress', requireAuth('tutor'), (req, res) => {
  const b = loadBookingFor(req, Number(req.params.id));
  if (b.tutor_id !== req.user.id) throw forbidden();
  if (!['accepted', 'completed'].includes(b.status)) throw bad('Booking is not active');
  const sessionId = v.int(req.body.session_id, 'Session', { min: 1, optional: true });
  if (sessionId && !q.get('SELECT 1 FROM sessions WHERE id = ? AND booking_id = ?', sessionId, b.id)) throw bad('Session not found');
  q.run('INSERT INTO progress_reports(booking_id, session_id, tutor_id, topics, understanding, strengths, improve, notes) VALUES (?,?,?,?,?,?,?,?)',
    b.id, sessionId, req.user.id, v.str(req.body.topics, 'Topics covered', { max: 500 }), v.int(req.body.understanding, 'Understanding', { min: 1, max: 5, optional: true }),
    v.str(req.body.strengths, 'Strengths', { max: 500, optional: true }), v.str(req.body.improve, 'Needs improvement', { max: 500, optional: true }),
    v.str(req.body.notes, 'Notes', { max: 1000, optional: true }));
  notify(b.parent_id, `New progress report from your tutor for booking #${b.id}`, `#/parent/bookings/${b.id}`);
  res.json({ ok: true });
});

r.post('/bookings/:id/homework', requireAuth('tutor'), (req, res) => {
  const b = loadBookingFor(req, Number(req.params.id));
  if (b.tutor_id !== req.user.id) throw forbidden();
  if (b.status !== 'accepted') throw bad('Booking is not active');
  q.run('INSERT INTO homework(booking_id, tutor_id, title, details, due_date) VALUES (?,?,?,?,?)', b.id, req.user.id,
    v.str(req.body.title, 'Homework title', { max: 120 }), v.str(req.body.details, 'Details', { max: 2000, optional: true }),
    req.body.due_date ? v.date(req.body.due_date, 'Due date') : null);
  notify(b.parent_id, `New homework: ${String(req.body.title).slice(0, 60)}`, `#/parent/bookings/${b.id}`);
  res.json({ ok: true });
});

r.post('/homework/:hid', requireAuth('parent', 'tutor'), (req, res) => {
  const h = q.get('SELECT * FROM homework WHERE id = ?', Number(req.params.hid));
  if (!h) throw notFound();
  const b = loadBookingFor(req, h.booking_id);
  if (req.user.id === b.parent_id) {
    q.run("UPDATE homework SET status='done', parent_note=? WHERE id=?", v.str(req.body.note, 'Note', { max: 500, optional: true }), h.id);
    notify(b.tutor_id, `Homework "${h.title}" marked done`, `#/tutor/bookings/${b.id}`);
  } else if (req.user.id === b.tutor_id) {
    q.run("UPDATE homework SET status='reviewed', tutor_feedback=? WHERE id=?", v.str(req.body.feedback, 'Feedback', { max: 500, optional: true }), h.id);
    notify(b.parent_id, `Tutor reviewed homework "${h.title}"`, `#/parent/bookings/${b.id}`);
  } else throw forbidden();
  res.json({ ok: true });
});

// ---------- Video classes (WebRTC; signalling runs over the app's socket) ----------
r.get('/video/:id/config', requireAuth('parent', 'tutor', 'admin'), (req, res) => {
  if (!flag('video_enabled', '1')) throw bad('In-app video is turned off');
  const b = loadBookingFor(req, Number(req.params.id));
  if (b.mode !== 'online' || b.status !== 'accepted') throw bad('Video is available for confirmed online bookings');
  const ice = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const turn = getSetting('turn_url', '');
  if (turn) ice.push({ urls: turn, username: getSetting('turn_username', ''), credential: getSecret('turn_credential') });
  const other = req.user.id === b.parent_id ? b.tutor_id : b.parent_id;
  res.json({ iceServers: ice, booking_id: b.id, other_name: q.get('SELECT name FROM users WHERE id = ?', other)?.name || '' });
});

// ---------- Subscription packages ----------
r.get('/packages', requireAuth(), (_req, res) => {
  res.json({ items: flag('packages_enabled', '1') ? q.all('SELECT * FROM packages WHERE active = 1 ORDER BY sessions') : [] });
});

// ---------- Tutor earnings & invoices ----------
r.get('/earnings', requireAuth('tutor'), (req, res) => {
  const id = req.user.id;
  const sum = (where, ...p) => q.get(`SELECT COUNT(*) classes, COALESCE(SUM(gross),0) gross, COALESCE(SUM(commission),0) commission, COALESCE(SUM(gst),0) gst, COALESCE(SUM(payout),0) net
    FROM sessions s JOIN bookings b ON b.id = s.booking_id WHERE b.tutor_id = ? AND s.status = 'completed' ${where}`, id, ...p);
  const month = new Date().toISOString().slice(0, 7);
  res.json({
    total: sum(''), this_month: sum("AND substr(s.date,1,7) = ?", month),
    upcoming: q.get(`SELECT COUNT(*) n, COALESCE(SUM(b.rate),0) value FROM sessions s JOIN bookings b ON b.id=s.booking_id
      WHERE b.tutor_id=? AND b.status='accepted' AND s.status IN ('scheduled','on_the_way','in_progress')`, id),
    by_month: q.all(`SELECT substr(s.date,1,7) month, COUNT(*) classes, SUM(s.gross) gross, SUM(s.commission) commission, SUM(s.gst) gst, SUM(s.payout) net
      FROM sessions s JOIN bookings b ON b.id = s.booking_id WHERE b.tutor_id = ? AND s.status = 'completed' GROUP BY month ORDER BY month DESC LIMIT 12`, id),
    group_income: q.get("SELECT COALESCE(SUM(amount),0) n FROM wallet_txns WHERE user_id = ? AND ref LIKE 'group:%' AND type='credit'", id).n,
    commission_percent: Number(getSetting('commission_percent', '15')), gst_enabled: flag('gst_enabled'), gst_percent: Number(getSetting('gst_percent', '18')),
    invoices: q.all("SELECT id, number, type, gross, commission, gst, net, created_at, period FROM invoices WHERE user_id = ? ORDER BY id DESC LIMIT 100", id),
  });
});

r.get('/invoices', requireAuth('parent', 'tutor'), (req, res) => {
  res.json({ items: q.all('SELECT id, number, type, booking_id, gross, commission, gst, net, created_at, period FROM invoices WHERE user_id = ? ORDER BY id DESC LIMIT 200', req.user.id) });
});

function invoiceData(inv) {
  const u = q.get('SELECT id, name, email, phone, role FROM users WHERE id = ?', inv.user_id);
  const tp = u.role === 'tutor' ? q.get('SELECT address, pan_number, gstin FROM tutor_profiles WHERE user_id = ?', u.id) : null;
  return { invoice: { ...inv, meta: JSON.parse(inv.meta || '{}') }, party: { ...u, address: tp?.address || '', pan: tp?.pan_number || '', gstin: tp?.gstin || '' },
    platform: JSON.parse(inv.meta || '{}').platform || platformInfo() };
}
r.get('/invoices/:id', requireAuth(), (req, res) => {
  const inv = q.get('SELECT * FROM invoices WHERE id = ?', Number(req.params.id));
  if (!inv) throw notFound();
  if (inv.user_id !== req.user.id && !(req.user.role === 'admin' || (req.user.role === 'staff' && req.user.permissions.includes('payments')))) throw forbidden();
  res.json(invoiceData(inv));
});

// Monthly statement: all commission invoices of one month for a tutor, as one summary.
r.get('/statements/:month', requireAuth('tutor'), (req, res) => {
  const month = String(req.params.month);
  if (!/^\d{4}-\d{2}$/.test(month)) throw bad('Invalid month');
  const rows = q.all("SELECT * FROM invoices WHERE user_id = ? AND type = 'commission' AND period = ? ORDER BY id", req.user.id, month);
  const tot = rows.reduce((a, x) => ({ gross: a.gross + x.gross, commission: a.commission + x.commission, gst: a.gst + x.gst, net: a.net + x.net }), { gross: 0, commission: 0, gst: 0, net: 0 });
  const tp = q.get('SELECT address, pan_number, gstin FROM tutor_profiles WHERE user_id = ?', req.user.id);
  res.json({ month, rows, total: tot, platform: platformInfo(), party: { name: req.user.name, email: req.user.email, address: tp?.address, pan: tp?.pan_number, gstin: tp?.gstin } });
});

module.exports = r;
module.exports.scrub = scrub;
