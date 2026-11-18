'use strict';
const express = require('express');
const { q, tx, getSetting, flag } = require('../db');
const finance = require('../finance');
const schedule = require('../schedule');
const { v, bad, forbidden, notFound, requireAuth, requireVerified, audit, walletMove, commissionPct, notify, distanceKm, tutorDistanceKm, evaluateCoupon, otp4 } = require('../lib');

const r = express.Router();
const MAX_SESSIONS = 120;

// ---------- Children ----------
r.get('/children', requireAuth('parent'), (req, res) => {
  res.json({ items: q.all('SELECT * FROM children WHERE parent_id = ?', req.user.id) });
});
r.post('/children', requireAuth('parent'), (req, res) => {
  const b = req.body || {};
  const info = q.run('INSERT INTO children(parent_id, name, grade, age) VALUES (?,?,?,?)', req.user.id,
    v.str(b.name, 'Child name', { max: 60 }), v.str(b.grade, 'Class / level', { max: 30, optional: true }),
    v.int(b.age, 'Age', { min: 2, max: 20, optional: true }));
  res.json({ id: Number(info.lastInsertRowid) });
});
r.delete('/children/:id', requireAuth('parent'), (req, res) => {
  const c = q.get('SELECT * FROM children WHERE id = ? AND parent_id = ?', Number(req.params.id), req.user.id);
  if (!c) throw notFound();
  if (q.get('SELECT 1 FROM bookings WHERE child_id = ? UNION SELECT 1 FROM group_members WHERE child_id = ?', c.id, c.id)) throw bad('This child has bookings and cannot be removed');
  q.run('DELETE FROM children WHERE id = ?', c.id);
  res.json({ ok: true });
});

// ---------- Schedule helpers ----------
// limit: for packages, keep adding matching days until the package's class count is reached.
function sessionDates(type, start, end, days, limit = null) {
  if (type === 'once' || type === 'trial') return [start];
  const out = [];
  const d = new Date(start + 'T00:00:00Z'), e = limit ? new Date(Date.parse(start) + 400 * 86400000) : new Date(end + 'T00:00:00Z');
  while (d <= e && out.length <= MAX_SESSIONS && (!limit || out.length < limit)) {
    if (type === 'daily' || days.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function quote(req) {
  const b = req.body || {};
  const tutorId = v.int(b.tutor_id, 'Tutor', { min: 1 });
  const t = q.get(`SELECT t.*, u.status FROM tutor_profiles t JOIN users u ON u.id = t.user_id WHERE t.user_id = ?`, tutorId);
  if (!t || t.kyc_status !== 'approved' || t.status !== 'active') throw bad('This tutor is not available');
  const category = v.str(b.category, 'Subject / skill', { max: 40 });
  if (!JSON.parse(t.categories).includes(category)) throw bad('This tutor does not teach that subject');
  const mode = v.oneOf(b.mode, 'Mode', ['online', 'offline']);
  if (t.mode !== 'both' && t.mode !== mode) throw bad(`This tutor teaches ${t.mode} only`);
  const schedule_type = v.oneOf(b.schedule_type, 'Schedule', ['once', 'daily', 'custom', 'trial']);
  const start_date = v.date(b.start_date, 'Start date');
  const today = schedule.todayIST();
  if (start_date < today) throw bad('Start date cannot be in the past');
  const isTrial = schedule_type === 'trial';
  if (isTrial) {
    if (!flag('trial_enabled', '1')) throw bad('Trial classes are not available right now');
    if (!t.offers_trial) throw bad('This tutor does not offer a trial class');
    if (q.get("SELECT 1 FROM bookings WHERE parent_id = ? AND tutor_id = ? AND is_trial = 1 AND status != 'rejected'", req.user.id, tutorId))
      throw bad('You have already taken a trial class with this tutor');
  }
  // Subscription package: a fixed number of classes at a discount, scheduled on the chosen days.
  let pkg = null;
  if (b.package_id && !isTrial) {
    if (!flag('packages_enabled', '1')) throw bad('Packages are not available right now');
    pkg = q.get('SELECT * FROM packages WHERE id = ? AND active = 1', v.int(b.package_id, 'Package', { min: 1 }));
    if (!pkg) throw bad('This package is no longer available');
    if (!['daily', 'custom'].includes(schedule_type)) throw bad('Packages need Daily or Custom days');
  }
  const days = schedule_type === 'custom' ? (Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((d) => d >= 0 && d <= 6))] : []) : [];
  if (schedule_type === 'custom' && !days.length) throw bad('Pick at least one weekday');
  let end_date = ['once', 'trial'].includes(schedule_type) || pkg ? start_date : v.date(b.end_date, 'End date');
  if (end_date < start_date) throw bad('End date must be after start date');
  const dates = sessionDates(schedule_type, start_date, end_date, days, pkg ? pkg.sessions : null);
  if (pkg) {
    end_date = dates[dates.length - 1];
    const lastAllowed = new Date(Date.parse(start_date) + (pkg.validity_days - 1) * 86400000).toISOString().slice(0, 10);
    if (end_date > lastAllowed) throw bad(`${pkg.sessions} classes don't fit in ${pkg.validity_days} days on these weekdays. Pick more days.`);
  }
  if (!dates.length) throw bad('No sessions fall in the chosen dates');
  if (dates.length > MAX_SESSIONS) throw bad(`A booking can have at most ${MAX_SESSIONS} sessions`);
  const time = v.time(b.time, 'Time');
  const duration_min = isTrial ? Math.min(v.int(b.duration_min ?? 30, 'Duration', { min: 30, max: 240 }), 60)
    : v.int(b.duration_min ?? 60, 'Duration', { min: 30, max: 240 });
  let lat = null, lng = null, address = null;
  if (mode === 'offline') {
    lat = v.num(b.lat, 'Location', { min: -90, max: 90 });
    lng = v.num(b.lng, 'Location', { min: -180, max: 180 });
    address = v.str(b.address, 'Address', { min: 5, max: 300 });
    const radius = Number(getSetting('search_radius_km', '3'));
    if (t.lat == null || tutorDistanceKm(lat, lng, t) > radius) throw bad(`This tutor is outside the ${radius} km radius of your address`);
  }
  const baseRate = Math.round(t.rate_per_session * (duration_min / 60));
  // Package discount lowers the per-class fee (shared with the tutor). Coupon discounts are funded by the platform.
  const rate = isTrial ? t.trial_fee : pkg ? Math.round((baseRate * (100 - pkg.discount_percent)) / 100) : baseRate;
  const gross = rate * dates.length;
  let discount = 0, coupon = null;
  if (b.coupon && isTrial) throw bad('Coupons cannot be used on trial classes');
  if (b.coupon) {
    const c = evaluateCoupon(v.str(b.coupon, 'Coupon', { max: 30 }), req.user.id, gross);
    discount = c.discount; coupon = c.coupon.code;
  }
  return { tutorId, category, mode, schedule_type, start_date, end_date, days, time, duration_min, lat, lng, address,
    rate, base_rate: baseRate, package: pkg, is_trial: isTrial, dates, gross, discount, amount: gross - discount, coupon, notes: v.str(b.notes, 'Notes', { max: 500, optional: true }) };
}

r.post('/bookings/quote', requireAuth('parent'), (req, res) => {
  const x = quote(req);
  res.json({ sessions: x.dates.length, dates: x.dates.slice(0, 10), end_date: x.dates[x.dates.length - 1], rate: x.rate, base_rate: x.base_rate,
    package: x.package && { name: x.package.name, discount_percent: x.package.discount_percent }, is_trial: x.is_trial, gross: x.gross, discount: x.discount, amount: x.amount, wallet_balance: req.user.wallet_balance });
});

r.post('/bookings', requireAuth('parent'), requireVerified, (req, res) => {
  const x = quote(req);
  const childId = v.int(req.body.child_id, 'Child', { min: 1 });
  if (!q.get('SELECT 1 FROM children WHERE id = ? AND parent_id = ?', childId, req.user.id)) throw bad('Select your child');
  const id = tx(() => {
    const info = q.run(`INSERT INTO bookings(parent_id,tutor_id,child_id,category,mode,schedule_type,start_date,end_date,days,time,duration_min,
        address,lat,lng,notes,rate,total_sessions,gross_amount,discount,amount,coupon_code,package_id,is_trial) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      req.user.id, x.tutorId, childId, x.category, x.mode, x.is_trial ? 'once' : x.schedule_type, x.start_date, x.dates[x.dates.length - 1], JSON.stringify(x.days), x.time,
      x.duration_min, x.address, x.lat, x.lng, x.notes, x.rate, x.dates.length, x.gross, x.discount, x.amount, x.coupon, x.package?.id ?? null, x.is_trial ? 1 : 0);
    const id = Number(info.lastInsertRowid);
    // Money is held from the parent's wallet (escrow) and released to the tutor session by session.
    if (x.amount > 0) walletMove(req.user.id, 'debit', x.amount, `Booking #${id} payment (held until sessions complete)`, `booking:${id}`);
    finance.createInvoice({ type: 'booking', user_id: req.user.id, booking_id: id,
      s: { gross: x.gross, commission_percent: 0, commission: 0, gst_percent: 0, gst: 0, net: x.amount },
      meta: { discount: x.discount, coupon: x.coupon, sessions: x.dates.length, rate: x.rate, category: x.category, package: x.package?.name || null, trial: x.is_trial } });
    if (x.coupon) {
      q.run('INSERT INTO coupon_redemptions(code,user_id,booking_id,discount) VALUES (?,?,?,?)', x.coupon, req.user.id, id, x.discount);
      q.run('UPDATE coupons SET used_count = used_count + 1 WHERE code = ?', x.coupon);
    }
    return id;
  });
  notify(x.tutorId, `New ${x.is_trial ? 'TRIAL ' : ''}${x.mode} booking request for ${x.category} (${x.dates.length} sessions)`, `#/tutor/bookings/${id}`, { important: true });
  audit(req, 'booking_create', `booking:${id}`);
  res.json({ id });
});

function loadBookingFor(req, id) {
  const b = q.get('SELECT * FROM bookings WHERE id = ?', id);
  if (!b) throw notFound('Booking not found');
  const isStaff = req.user.role === 'admin' || (req.user.role === 'staff' && req.user.permissions.includes('bookings'));
  if (b.parent_id !== req.user.id && b.tutor_id !== req.user.id && !isStaff) throw forbidden();
  return b;
}

function shapeBooking(b, viewer) {
  const tutor = q.get('SELECT id, name, phone FROM users WHERE id = ?', b.tutor_id);
  const parent = q.get('SELECT id, name, phone FROM users WHERE id = ?', b.parent_id);
  const child = q.get('SELECT name, grade, age FROM children WHERE id = ?', b.child_id);
  const confirmed = ['accepted', 'completed'].includes(b.status);
  const masked = flag('mask_phone_numbers', '1');
  const out = { ...b, days: JSON.parse(b.days), tutor: { id: tutor.id, name: tutor.name }, parent: { id: parent.id, name: parent.name.split(' ')[0] },
    child: child ? { grade: child.grade, age: child.age, name: child.name } : null };
  // Contact details and the home address are only revealed once a booking is confirmed.
  const isStaff = viewer.role === 'admin' || viewer.role === 'staff';
  if (confirmed || isStaff) {
    out.parent.name = parent.name;
    // With number masking on, parents and tutors talk through in-app chat / masked calls and never see each other's number.
    if (!masked || isStaff) { out.tutor.phone = tutor.phone; out.parent.phone = parent.phone; }
  } else if (viewer.id === b.tutor_id) {
    out.address = b.address ? b.address.split(',').slice(-2).join(',').trim() : null; out.lat = null; out.lng = null;
    if (out.child) out.child.name = out.child.name.charAt(0) + '.';
  }
  const sessions = q.all('SELECT * FROM sessions WHERE booking_id = ? ORDER BY date', b.id);
  // The start OTP is shown only to the parent. The tutor must get it from the parent in person.
  out.sessions = sessions.map((s) => (viewer.id === b.parent_id ? s : { ...s, start_otp: undefined }));
  out.review = q.get('SELECT rating, comment FROM reviews WHERE booking_id = ?', b.id) || null;
  out.session_reviews = q.all('SELECT session_id, rating, punctuality, teaching, comment, created_at FROM session_reviews WHERE booking_id = ?', b.id);
  out.progress = q.all('SELECT * FROM progress_reports WHERE booking_id = ? ORDER BY id DESC', b.id);
  out.homework = q.all('SELECT * FROM homework WHERE booking_id = ? ORDER BY id DESC', b.id);
  out.unread_messages = q.get('SELECT COUNT(*) n FROM messages WHERE booking_id = ? AND sender_id != ? AND read = 0', b.id, viewer.id).n;
  out.package = b.package_id ? q.get('SELECT name, sessions, discount_percent FROM packages WHERE id = ?', b.package_id) : null;
  out.features = { chat: flag('chat_enabled', '1'), masked_calls: flag('masked_calls_enabled') && confirmed, video: flag('video_enabled', '1') && b.mode === 'online',
    phone_masked: masked };
  return out;
}

r.get('/bookings', requireAuth('parent', 'tutor'), (req, res) => {
  const col = req.user.role === 'parent' ? 'parent_id' : 'tutor_id';
  const rows = q.all(`SELECT b.*, t.name tutor_name, p.name parent_name,
      (SELECT COUNT(*) FROM sessions s WHERE s.booking_id=b.id AND s.status='completed') done
    FROM bookings b JOIN users t ON t.id=b.tutor_id JOIN users p ON p.id=b.parent_id WHERE b.${col} = ? ORDER BY b.id DESC`, req.user.id);
  res.json({ items: rows.map((b) => ({ id: b.id, category: b.category, mode: b.mode, status: b.status, start_date: b.start_date, end_date: b.end_date,
    time: b.time, total_sessions: b.total_sessions, done: b.done, amount: b.amount, schedule_type: b.schedule_type,
    tutor_name: b.tutor_name, parent_name: b.parent_name.split(' ')[0] })) });
});

r.get('/bookings/:id', requireAuth(), (req, res) => {
  const b = loadBookingFor(req, Number(req.params.id));
  res.json({ booking: shapeBooking(b, req.user) });
});

r.post('/bookings/:id/respond', requireAuth('tutor'), (req, res) => {
  const b = loadBookingFor(req, Number(req.params.id));
  if (b.tutor_id !== req.user.id) throw forbidden();
  if (b.status !== 'requested') throw bad('This booking was already answered');
  const accept = !!req.body.accept;
  let link = null;
  if (accept && b.mode === 'online') link = v.url(req.body.meeting_link, 'Online class link', { optional: true });
  tx(() => {
    if (accept) {
      q.run("UPDATE bookings SET status='accepted', meeting_link=? WHERE id=?", link, b.id);
      const dates = sessionDates(b.schedule_type, b.start_date, b.end_date, JSON.parse(b.days));
      for (const d of dates) q.run('INSERT INTO sessions(booking_id, date, start_otp) VALUES (?,?,?)', b.id, d, otp4());
      // Classes that fall on a holiday or a leave day already marked are moved to the end of the plan.
      for (const s of q.all("SELECT * FROM sessions WHERE booking_id = ? AND status = 'scheduled'", b.id))
        if (schedule.isHoliday(s.date, b.tutor_id, b.id)) schedule.moveSession(s, b);
      rewardReferral(b.parent_id);
    } else {
      q.run("UPDATE bookings SET status='rejected' WHERE id=?", b.id);
      if (b.amount > 0) walletMove(b.parent_id, 'credit', b.amount, `Refund: booking #${b.id} declined by tutor`, `booking:${b.id}`);
    }
  });
  notify(b.parent_id, accept ? `Your booking #${b.id} was accepted by the tutor` : `Your booking #${b.id} was declined. The full amount was refunded to your wallet.`, `#/parent/bookings/${b.id}`, { important: true });
  audit(req, accept ? 'booking_accept' : 'booking_reject', `booking:${b.id}`);
  res.json({ ok: true });
});

// Referral reward: given once, when the referred user's first booking is accepted (or a tutor's KYC is approved).
function rewardReferral(userId) {
  const u = q.get('SELECT id, referred_by, referral_rewarded FROM users WHERE id = ?', userId);
  if (!u || !u.referred_by || u.referral_rewarded) return;
  const toReferrer = Number(getSetting('referral_bonus_referrer', '10000'));
  const toReferee = Number(getSetting('referral_bonus_referee', '5000'));
  q.run('UPDATE users SET referral_rewarded = 1 WHERE id = ?', u.id);
  if (toReferrer > 0) walletMove(u.referred_by, 'credit', toReferrer, 'Referral reward', `referral:${u.id}`);
  if (toReferee > 0) walletMove(u.id, 'credit', toReferee, 'Referral joining reward', `referral:${u.id}`);
  notify(u.referred_by, `You earned ₹${toReferrer / 100} referral reward!`, '#/wallet');
}

r.post('/bookings/:id/link', requireAuth('tutor'), (req, res) => {
  const b = loadBookingFor(req, Number(req.params.id));
  if (b.tutor_id !== req.user.id || b.mode !== 'online') throw bad('Only for online bookings');
  const link = v.url(req.body.meeting_link, 'Online class link');
  q.run('UPDATE bookings SET meeting_link = ? WHERE id = ?', link, b.id);
  notify(b.parent_id, `Your tutor shared the online class link for booking #${b.id}`, `#/parent/bookings/${b.id}`);
  res.json({ ok: true });
});

r.post('/bookings/:id/cancel', requireAuth('parent', 'tutor'), (req, res) => {
  const b = loadBookingFor(req, Number(req.params.id));
  if (!['requested', 'accepted'].includes(b.status)) throw bad('This booking cannot be cancelled');
  const refund = tx(() => {
    const total = b.total_sessions;
    const remaining = b.status === 'requested' ? total
      : q.get("SELECT COUNT(*) n FROM sessions WHERE booking_id=? AND status='scheduled'", b.id).n;
    q.run("UPDATE sessions SET status='cancelled' WHERE booking_id=? AND status='scheduled'", b.id);
    const done = q.get("SELECT COUNT(*) n FROM sessions WHERE booking_id=? AND status IN ('completed','in_progress','on_the_way')", b.id).n;
    q.run(`UPDATE bookings SET status=? WHERE id=?`, done > 0 ? 'completed' : 'cancelled', b.id);
    const amt = Math.floor((b.amount * remaining) / total);
    if (amt > 0) walletMove(b.parent_id, 'credit', amt, `Refund: booking #${b.id} cancelled (${remaining} sessions)`, `booking:${b.id}`);
    return amt;
  });
  const other = req.user.id === b.parent_id ? b.tutor_id : b.parent_id;
  notify(other, `Booking #${b.id} was cancelled`, req.user.id === b.parent_id ? `#/tutor/bookings/${b.id}` : `#/parent/bookings/${b.id}`);
  audit(req, 'booking_cancel', `booking:${b.id}`, { refund });
  res.json({ ok: true, refund });
});

// ---------- Session lifecycle (tutor) ----------
function loadSession(req) {
  const s = q.get('SELECT * FROM sessions WHERE id = ?', Number(req.params.sid));
  if (!s) throw notFound('Session not found');
  const b = loadBookingFor(req, s.booking_id);
  if (b.tutor_id !== req.user.id) throw forbidden();
  if (b.status !== 'accepted') throw bad('Booking is not active');
  return { s, b };
}

r.post('/sessions/:sid/on-the-way', requireAuth('tutor'), (req, res) => {
  const { s, b } = loadSession(req);
  if (b.mode !== 'offline') throw bad('Only for home tuition');
  if (s.status !== 'scheduled') throw bad('Session already started');
  if (s.date !== schedule.todayIST()) throw bad(`This class is on ${s.date}.`);
  q.run("UPDATE sessions SET status='on_the_way' WHERE id=?", s.id);
  notify(b.parent_id, 'Your tutor is on the way. Track them live in the app.', `#/parent/bookings/${b.id}`, { important: true });
  res.json({ ok: true });
});

r.post('/sessions/:sid/start', requireAuth('tutor'), (req, res) => {
  const { s, b } = loadSession(req);
  if (!['scheduled', 'on_the_way'].includes(s.status)) throw bad('Session cannot be started');
  // A class can only be started on its own day (stops early "completion" and payout of future classes).
  if (s.date !== schedule.todayIST()) throw bad(`This class is on ${s.date}. It can be started on that day only.`);
  // For home tuition the tutor must enter the 4-digit code that only the parent has (proves arrival).
  if (b.mode === 'offline' && String(req.body.otp || '') !== s.start_otp) throw bad('Wrong start code. Ask the parent for the 4-digit code.');
  q.run("UPDATE sessions SET status='in_progress', started_at=unixepoch() WHERE id=?", s.id);
  notify(b.parent_id, b.mode === 'offline' ? `Your tutor has arrived and the class has started (booking #${b.id})` : `Online class started for booking #${b.id}`, `#/parent/bookings/${b.id}`, { important: true });
  audit(req, 'session_start', `session:${s.id}`);
  res.json({ ok: true });
});

r.post('/sessions/:sid/complete', requireAuth('tutor'), (req, res) => {
  const { s, b } = loadSession(req);
  if (s.status !== 'in_progress') throw bad('Start the session first');
  // Tutor earns the class fee minus the admin-set commission (and GST on commission when enabled).
  const payout = tx(() => schedule.settleSession(s, b, { status: 'completed', attendance: 'present' }));
  notify(b.parent_id, `Session on ${s.date} completed. Rate this class and see the tutor's progress notes.`, `#/parent/bookings/${b.id}`);
  res.json({ ok: true, payout });
});

// ---------- Attendance ----------
// Tutor marks a class that did not happen (on the day or after). Tutor absent -> free make-up class.
// Student absent -> make-up class, or the class is counted if the admin set that policy.
r.post('/sessions/:sid/attendance', requireAuth('tutor'), (req, res) => {
  const { s, b } = loadSession(req);
  const reason = v.oneOf(req.body.status, 'Attendance', ['tutor_absent', 'student_absent']);
  if (s.date > schedule.todayIST()) throw bad('You can mark attendance on the day of the class. For future days, add a leave day instead.');
  try {
    const out = schedule.markMissed(s, b, reason, req.user.id, v.str(req.body.note, 'Note', { max: 300, optional: true }));
    audit(req, 'attendance_' + reason, `session:${s.id}`, out);
    res.json({ ok: true, ...out });
  } catch (e) { if (e.status) throw e; throw bad(e.message); }
});

// Parent reports that the tutor did not come. The class gets a free make-up date and staff can see the report.
r.post('/sessions/:sid/report-absent', requireAuth('parent'), (req, res) => {
  const s = q.get('SELECT * FROM sessions WHERE id = ?', Number(req.params.sid));
  if (!s) throw notFound('Session not found');
  const b = loadBookingFor(req, s.booking_id);
  if (b.parent_id !== req.user.id) throw forbidden();
  if (b.status !== 'accepted') throw bad('Booking is not active');
  if (s.date > schedule.todayIST()) throw bad('You can report this on the day of the class. For future days, add a leave day instead.');
  if (s.date === schedule.todayIST()) {
    const [hh, mm] = b.time.split(':').map(Number);
    const nowMin = Math.floor(((Date.now() + 330 * 60000) % 86400000) / 60000);
    if (nowMin < hh * 60 + mm + 15) throw bad('You can report this 15 minutes after the class start time.');
  }
  try {
    const out = schedule.markMissed(s, b, 'tutor_absent', req.user.id, v.str(req.body.note, 'Note', { max: 300, optional: true }) || 'Reported by parent');
    audit(req, 'attendance_reported_by_parent', `session:${s.id}`, out);
    res.json({ ok: true, ...out });
  } catch (e) { if (e.status) throw e; throw bad(e.message); }
});

// Parent marks a leave day for their child on one booking. Classes that day move to the end of the plan.
r.post('/bookings/:id/leave', requireAuth('parent'), (req, res) => {
  const b = loadBookingFor(req, Number(req.params.id));
  if (b.parent_id !== req.user.id) throw forbidden();
  if (b.status !== 'accepted') throw bad('Leave days can be added to active bookings only');
  const date = v.date(req.body.date, 'Date');
  if (date <= schedule.todayIST()) throw bad('Pick a future date. For today, ask the tutor to mark the class.');
  const max = Number(getSetting('parent_leave_days_per_booking', '6'));
  if (q.get("SELECT COUNT(*) n FROM holidays WHERE scope = 'booking' AND ref_id = ?", b.id).n >= max) throw bad(`You can add up to ${max} leave days on one booking`);
  if (!q.get("SELECT 1 FROM sessions WHERE booking_id = ? AND date = ? AND status = 'scheduled'", b.id, date)) throw bad('There is no class on that day');
  try {
    const out = schedule.addHoliday({ scope: 'booking', ref_id: b.id, date, reason: v.str(req.body.reason, 'Reason', { max: 120, optional: true }), created_by: req.user.id });
    audit(req, 'booking_leave', `booking:${b.id}`, { date });
    res.json({ ok: true, ...out });
  } catch (e) { if (e.status) throw e; throw bad(e.message); }
});

r.post('/bookings/:id/review', requireAuth('parent'), (req, res) => {
  const b = loadBookingFor(req, Number(req.params.id));
  if (b.parent_id !== req.user.id) throw forbidden();
  if (!q.get("SELECT 1 FROM sessions WHERE booking_id=? AND status='completed'", b.id)) throw bad('You can review after a session is completed');
  if (q.get('SELECT 1 FROM reviews WHERE booking_id=?', b.id)) throw bad('You already reviewed this booking');
  const rating = v.int(req.body.rating, 'Rating', { min: 1, max: 5 });
  tx(() => {
    q.run('INSERT INTO reviews(booking_id,parent_id,tutor_id,rating,comment) VALUES (?,?,?,?,?)', b.id, req.user.id, b.tutor_id, rating,
      v.str(req.body.comment, 'Comment', { max: 500, optional: true }));
    q.run('UPDATE tutor_profiles SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE user_id = ?', rating, b.tutor_id);
  });
  res.json({ ok: true });
});

// Rate each completed class (overall, punctuality, teaching).
r.post('/sessions/:sid/review', requireAuth('parent'), (req, res) => {
  const s = q.get('SELECT * FROM sessions WHERE id = ?', Number(req.params.sid));
  if (!s) throw notFound('Session not found');
  const b = loadBookingFor(req, s.booking_id);
  if (b.parent_id !== req.user.id) throw forbidden();
  if (s.status !== 'completed') throw bad('You can rate a class after it is completed');
  if (q.get('SELECT 1 FROM session_reviews WHERE session_id = ?', s.id)) throw bad('You already rated this class');
  const rating = v.int(req.body.rating, 'Rating', { min: 1, max: 5 });
  tx(() => {
    q.run('INSERT INTO session_reviews(session_id,booking_id,parent_id,tutor_id,rating,punctuality,teaching,comment) VALUES (?,?,?,?,?,?,?,?)',
      s.id, b.id, req.user.id, b.tutor_id, rating, v.int(req.body.punctuality, 'Punctuality', { min: 1, max: 5, optional: true }),
      v.int(req.body.teaching, 'Teaching', { min: 1, max: 5, optional: true }), v.str(req.body.comment, 'Comment', { max: 500, optional: true }));
    q.run('UPDATE tutor_profiles SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE user_id = ?', rating, b.tutor_id);
  });
  if (rating <= 2) notify(b.tutor_id, `A parent rated your class on ${s.date} ${rating}/5. Please check the feedback.`, `#/tutor/bookings/${b.id}`);
  res.json({ ok: true });
});

// Last known tutor location, only for the booking's parent while a home session is live.
r.get('/bookings/:id/location', requireAuth(), (req, res) => {
  const b = loadBookingFor(req, Number(req.params.id));
  const live = q.get("SELECT 1 FROM sessions WHERE booking_id=? AND status IN ('on_the_way','in_progress')", b.id);
  if (!live && req.user.role !== 'admin') return res.json({ live: false });
  const loc = q.get('SELECT lat, lng, accuracy, updated_at FROM tutor_locations WHERE tutor_id = ?', b.tutor_id);
  res.json({ live: !!live, location: loc || null, destination: b.lat != null ? { lat: b.lat, lng: b.lng } : null });
});

// ---------- SOS ----------
r.post('/sos', requireAuth('parent', 'tutor'), (req, res) => {
  const bookingId = v.int(req.body.booking_id, 'Booking', { min: 1, optional: true });
  if (bookingId) loadBookingFor(req, bookingId);
  const info = q.run('INSERT INTO sos_alerts(user_id, booking_id, lat, lng, message) VALUES (?,?,?,?,?)', req.user.id, bookingId,
    v.num(req.body.lat, 'Lat', { optional: true }), v.num(req.body.lng, 'Lng', { optional: true }),
    v.str(req.body.message, 'Message', { max: 500, optional: true }));
  const responders = q.all(`SELECT id FROM users WHERE status='active' AND (role='admin' OR (role='staff' AND staff_permissions LIKE '%"sos"%'))`);
  for (const u of responders) notify(u.id, `🚨 SOS from ${req.user.name} (${req.user.phone})`, '#/admin/sos', { important: true });
  const io = require('../lib').io;
  if (io) io.to('responders').emit('sos', { id: Number(info.lastInsertRowid), name: req.user.name });
  audit(req, 'sos', `sos:${info.lastInsertRowid}`);
  res.json({ ok: true, helpline: getSetting('helpline_phone', '') });
});

module.exports = { router: r, rewardReferral, loadBookingFor };
