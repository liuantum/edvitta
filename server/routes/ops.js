'use strict';
// Round 3: tutor leave and platform holidays, weekly tutor payout reports, and admin analytics.
const express = require('express');
const { q, tx, getSetting } = require('../db');
const schedule = require('../schedule');
const { v, bad, notFound, requireAuth, requirePerm, audit, walletMove, notify } = require('../lib');

const r = express.Router();
const UPI_RE = /^[\w.\-]{2,}@[a-zA-Z]{2,}$/;
const wrap = (fn) => { try { return fn(); } catch (e) { if (e.status) throw e; throw bad(e.message); } };

// ---------- Tutor leave days ----------
r.get('/tutor/leave', requireAuth('tutor'), (req, res) => {
  res.json({ items: q.all("SELECT id, date, reason, moved FROM holidays WHERE scope = 'tutor' AND ref_id = ? AND date >= ? ORDER BY date", req.user.id, schedule.todayIST()),
    holidays: q.all("SELECT date, reason FROM holidays WHERE scope = 'platform' AND date >= ? ORDER BY date LIMIT 30", schedule.todayIST()),
    max_per_month: Number(getSetting('tutor_leave_days_per_month', '4')) });
});
r.post('/tutor/leave', requireAuth('tutor'), (req, res) => {
  const date = v.date(req.body.date, 'Date');
  if (date <= schedule.todayIST()) throw bad('Pick a future date. For today, mark the class as missed instead.');
  if (date > schedule.addDays(schedule.todayIST(), 180)) throw bad('Leave can be planned up to 6 months ahead');
  const max = Number(getSetting('tutor_leave_days_per_month', '4'));
  const used = q.get("SELECT COUNT(*) n FROM holidays WHERE scope = 'tutor' AND ref_id = ? AND substr(date,1,7) = ?", req.user.id, date.slice(0, 7)).n;
  if (used >= max) throw bad(`You can take up to ${max} leave days in a month. Contact support for longer leave.`);
  const out = wrap(() => schedule.addHoliday({ scope: 'tutor', ref_id: req.user.id, date, reason: v.str(req.body.reason, 'Reason', { max: 120, optional: true }), created_by: req.user.id }));
  audit(req, 'tutor_leave', `user:${req.user.id}`, { date, moved: out.moved });
  res.json({ ok: true, ...out });
});
// Removing a leave day only frees the date for new bookings. Classes already moved stay on their new dates.
r.delete('/tutor/leave/:id', requireAuth('tutor'), (req, res) => {
  const h = q.get("SELECT * FROM holidays WHERE id = ? AND scope = 'tutor' AND ref_id = ?", Number(req.params.id), req.user.id);
  if (!h) throw notFound();
  q.run('DELETE FROM holidays WHERE id = ?', h.id);
  res.json({ ok: true });
});

// ---------- Platform holidays (admin) ----------
r.get('/admin/holidays', requirePerm('bookings'), (_req, res) => {
  res.json({ items: q.all(`SELECT h.*, CASE h.scope WHEN 'tutor' THEN u.name ELSE NULL END who FROM holidays h LEFT JOIN users u ON u.id = h.ref_id
    WHERE h.date >= date('now','-30 day') ORDER BY h.date LIMIT 300`) });
});
r.post('/admin/holidays', requireAuth('admin'), (req, res) => {
  const date = v.date(req.body.date, 'Date');
  if (date <= schedule.todayIST()) throw bad('Pick a future date');
  const out = wrap(() => schedule.addHoliday({ scope: 'platform', date, reason: v.str(req.body.reason, 'Holiday name', { max: 80 }), created_by: req.user.id }));
  audit(req, 'holiday_add', `holiday:${out.id}`, { date, moved: out.moved });
  res.json({ ok: true, ...out });
});
r.delete('/admin/holidays/:id', requireAuth('admin'), (req, res) => {
  const h = q.get('SELECT * FROM holidays WHERE id = ?', Number(req.params.id));
  if (!h) throw notFound();
  q.run('DELETE FROM holidays WHERE id = ?', h.id);
  audit(req, 'holiday_delete', `holiday:${h.id}`, { date: h.date, scope: h.scope });
  res.json({ ok: true });
});

// ---------- Weekly payouts ----------
// Weeks run Monday to Sunday, India time.
function weekOf(d) { const x = new Date(d + 'T00:00:00Z'); const back = (x.getUTCDay() + 6) % 7; return schedule.addDays(d, -back); }
const weekRange = (start) => { const from = Date.parse(start + 'T00:00:00+05:30') / 1000; return [from, from + 7 * 86400]; };
const lastWeek = () => schedule.addDays(weekOf(schedule.todayIST()), -7);

function payoutReport(weekStart, tutorId = null) {
  const [from, to] = weekRange(weekStart);
  const rows = q.all(`SELECT i.user_id tutor_id, u.name, u.email, u.phone, u.wallet_balance, tp.payout_upi,
      COUNT(*) classes, SUM(i.gross) gross, SUM(i.commission) commission, SUM(i.gst) gst, SUM(i.net) net
    FROM invoices i JOIN users u ON u.id = i.user_id LEFT JOIN tutor_profiles tp ON tp.user_id = i.user_id
    WHERE i.type = 'commission' AND i.created_at >= ? AND i.created_at < ? ${tutorId ? 'AND i.user_id = ?' : ''}
    GROUP BY i.user_id ORDER BY net DESC`, from, to, ...(tutorId ? [tutorId] : []));
  for (const x of rows) {
    x.missed_by_tutor = q.get(`SELECT COUNT(*) n FROM sessions s JOIN bookings b ON b.id = s.booking_id
      WHERE b.tutor_id = ? AND s.attendance = 'tutor_absent' AND s.marked_at >= ? AND s.marked_at < ?`, x.tutor_id, from, to).n;
    x.withdrawals_pending = q.get("SELECT COALESCE(SUM(amount),0) n FROM withdrawals WHERE user_id = ? AND status = 'pending'", x.tutor_id).n;
  }
  const sum = (k) => rows.reduce((a, x) => a + x[k], 0);
  return { week_start: weekStart, week_end: schedule.addDays(weekStart, 6), rows,
    totals: { tutors: rows.length, classes: sum('classes'), gross: sum('gross'), commission: sum('commission'), gst: sum('gst'), net: sum('net') },
    batch: q.get('SELECT * FROM payout_batches WHERE week_start = ?', weekStart) || null };
}

const weekParam = (val) => weekOf(val ? v.date(val, 'Week') : lastWeek());

r.get('/admin/payouts', requirePerm('payments'), (req, res) => res.json(payoutReport(weekParam(req.query.week))));

// CSV for the bank / UPI bulk payout sheet. Cells are escaped and protected against spreadsheet formula injection.
const cell = (x) => { let s = String(x ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
r.get('/admin/payouts.csv', requirePerm('payments'), (req, res) => {
  const rep = payoutReport(weekParam(req.query.week));
  const head = ['Tutor ID', 'Name', 'Email', 'Phone', 'Payout UPI', 'Classes', 'Fees (Rs)', 'Commission (Rs)', 'GST (Rs)', 'Net earned (Rs)', 'Wallet balance (Rs)', 'Pending withdrawals (Rs)', 'Missed by tutor'];
  const rs = (p) => (p / 100).toFixed(2);
  const lines = [head, ...rep.rows.map((x) => [x.tutor_id, x.name, x.email, x.phone, x.payout_upi || '', x.classes, rs(x.gross), rs(x.commission), rs(x.gst), rs(x.net), rs(x.wallet_balance), rs(x.withdrawals_pending), x.missed_by_tutor])];
  audit(req, 'payout_csv', `week:${rep.week_start}`);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="edvitta-payouts-${rep.week_start}.csv"`);
  res.send('﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n'));
});

// Closes a week. Optionally moves each tutor's earnings for the week from their wallet into a payout request
// (to their saved UPI), so the team can pay them all from Admin → Payments → Withdrawals.
function settleWeek(weekStart, actorId, createWithdrawals) {
  if (weekStart >= weekOf(schedule.todayIST())) throw bad('You can settle a week after it ends');
  if (q.get('SELECT 1 FROM payout_batches WHERE week_start = ?', weekStart)) throw bad('This week is already settled');
  const rep = payoutReport(weekStart);
  let created = 0;
  const paid = [];
  tx(() => {
    if (createWithdrawals) for (const x of rep.rows) {
      const bal = q.get('SELECT wallet_balance FROM users WHERE id = ?', x.tutor_id).wallet_balance;
      const amount = Math.min(bal, x.net);
      if (!x.payout_upi || !UPI_RE.test(x.payout_upi) || amount < 10000) continue;
      walletMove(x.tutor_id, 'debit', amount, `Weekly payout for ${weekStart} (on hold until paid)`, 'withdrawal');
      q.run('INSERT INTO withdrawals(user_id, amount, upi_id) VALUES (?,?,?)', x.tutor_id, amount, x.payout_upi);
      created++; paid.push({ id: x.tutor_id, amount, upi: x.payout_upi });
    }
    const t = rep.totals;
    q.run('INSERT INTO payout_batches(week_start, tutors, gross, commission, gst, net, withdrawals_created, created_by) VALUES (?,?,?,?,?,?,?,?)',
      weekStart, t.tutors, t.gross, t.commission, t.gst, t.net, created, actorId);
  });
  for (const p of paid) notify(p.id, `Your weekly payout of ₹${(p.amount / 100).toFixed(2)} is being sent to ${p.upi}`, '#/tutor/earnings', { important: true });
  return { ok: true, withdrawals_created: created, totals: rep.totals };
}
r.post('/admin/payouts/settle', requireAuth('admin'), (req, res) => {
  const week = weekParam(req.body.week);
  const out = settleWeek(week, req.user.id, !!req.body.create_withdrawals);
  audit(req, 'payout_settle', `week:${week}`, out);
  res.json(out);
});

// Tutor: own weekly statements and saved payout UPI.
r.get('/tutor/payouts', requireAuth('tutor'), (req, res) => {
  const weeks = [];
  let w = weekOf(schedule.todayIST());
  for (let i = 0; i < 8; i++, w = schedule.addDays(w, -7)) {
    const rep = payoutReport(w, req.user.id);
    const x = rep.rows[0];
    weeks.push({ week_start: w, week_end: rep.week_end, classes: x?.classes || 0, gross: x?.gross || 0, commission: x?.commission || 0, gst: x?.gst || 0, net: x?.net || 0,
      missed_by_tutor: x?.missed_by_tutor || 0, current: i === 0 });
  }
  res.json({ weeks, payout_upi: q.get('SELECT payout_upi FROM tutor_profiles WHERE user_id = ?', req.user.id)?.payout_upi || '' });
});
r.put('/tutor/payout-upi', requireAuth('tutor'), (req, res) => {
  const upi = v.str(req.body.upi_id, 'UPI ID', { max: 60, optional: true }) || null;
  if (upi && !UPI_RE.test(upi)) throw bad('Enter a valid UPI ID (e.g. name@okbank)');
  q.run('UPDATE tutor_profiles SET payout_upi = ? WHERE user_id = ?', upi, req.user.id);
  audit(req, 'payout_upi_change', `user:${req.user.id}`);
  notify(req.user.id, upi ? `Your payout UPI was changed to ${upi}. If this wasn't you, contact support now.` : 'Your payout UPI was removed.', '#/tutor/earnings', { important: true });
  res.json({ ok: true });
});

// ---------- Analytics (admin) ----------
// Short area name from a geocoded address like "12, 5th Cross, Koramangala, Bengaluru, Karnataka, 560034, India".
function areaOf(address) {
  const parts = String(address || '').split(',').map((s) => s.trim()).filter((s) => s && !/^india$/i.test(s) && !/^\d[\d\s-]*$/.test(s));
  if (!parts.length) return 'Unknown';
  return parts.length >= 3 ? `${parts[parts.length - 3]}, ${parts[parts.length - 2]}` : parts.join(', ');
}

r.get('/admin/analytics', requireAuth('admin'), (req, res) => {
  const days = v.int(req.query.days ?? 30, 'Days', { min: 7, max: 365 });
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const day = "date(created_at + 19800, 'unixepoch')";
  const series = {};
  const put = (rows, key) => rows.forEach((r2) => { (series[r2.d] ||= { d: r2.d, bookings: 0, booking_value: 0, classes: 0, revenue: 0, parents: 0, tutors: 0 })[key] = r2.n; });
  put(q.all(`SELECT ${day} d, COUNT(*) n FROM bookings WHERE created_at >= ? GROUP BY d`, since), 'bookings');
  put(q.all(`SELECT ${day} d, SUM(amount) n FROM bookings WHERE created_at >= ? AND status IN ('accepted','completed') GROUP BY d`, since), 'booking_value');
  put(q.all(`SELECT ${day} d, COUNT(*) n FROM invoices WHERE type = 'commission' AND created_at >= ? GROUP BY d`, since), 'classes');
  put(q.all(`SELECT ${day} d, SUM(commission) n FROM invoices WHERE type = 'commission' AND created_at >= ? GROUP BY d`, since), 'revenue');
  put(q.all(`SELECT ${day} d, COUNT(*) n FROM users WHERE role = 'parent' AND created_at >= ? GROUP BY d`, since), 'parents');
  put(q.all(`SELECT ${day} d, COUNT(*) n FROM users WHERE role = 'tutor' AND created_at >= ? GROUP BY d`, since), 'tutors');
  const out = [];
  for (let d = schedule.addDays(schedule.todayIST(), -(days - 1)); d <= schedule.todayIST(); d = schedule.addDays(d, 1))
    out.push(series[d] || { d, bookings: 0, booking_value: 0, classes: 0, revenue: 0, parents: 0, tutors: 0 });

  const one = (sql, ...p) => Object.values(q.get(sql, ...p))[0] || 0;
  const status = Object.fromEntries(q.all('SELECT status, COUNT(*) n FROM bookings WHERE created_at >= ? GROUP BY status', since).map((x) => [x.status, x.n]));
  const requests = Object.values(status).reduce((a, n) => a + n, 0);
  const trials = q.all('SELECT DISTINCT parent_id, tutor_id FROM bookings WHERE is_trial = 1 AND created_at >= ?', since);
  const converted = trials.filter((t) => q.get('SELECT 1 FROM bookings WHERE parent_id = ? AND tutor_id = ? AND is_trial = 0 AND status IN (\'accepted\',\'completed\')', t.parent_id, t.tutor_id)).length;
  const sinceDate = schedule.addDays(schedule.todayIST(), -days);
  const att = Object.fromEntries(q.all(`SELECT COALESCE(attendance, status) a, COUNT(*) n FROM sessions WHERE date > ? AND date <= ? AND status IN ('completed','missed') GROUP BY a`, sinceDate, schedule.todayIST()).map((x) => [x.a, x.n]));
  const attTotal = Object.values(att).reduce((a, n) => a + n, 0);

  const areas = {};
  for (const b of q.all("SELECT address, amount, status, parent_id FROM bookings WHERE mode = 'offline' AND created_at >= ? AND status != 'rejected'", since)) {
    const a = (areas[areaOf(b.address)] ||= { area: areaOf(b.address), bookings: 0, value: 0, parents: new Set() });
    a.bookings++; a.value += b.amount; a.parents.add(b.parent_id);
  }
  const tutorsByArea = {};
  for (const t of q.all("SELECT address FROM tutor_profiles WHERE kyc_status = 'approved' AND address IS NOT NULL")) { const a = areaOf(t.address); tutorsByArea[a] = (tutorsByArea[a] || 0) + 1; }
  const topAreas = Object.values(areas).map((a) => ({ area: a.area, bookings: a.bookings, value: a.value, parents: a.parents.size, tutors: tutorsByArea[a.area] || 0 }))
    .sort((x, y) => y.bookings - x.bookings).slice(0, 10);

  res.json({
    days, series: out,
    totals: {
      bookings: requests, booking_value: one("SELECT COALESCE(SUM(amount),0) FROM bookings WHERE created_at >= ? AND status IN ('accepted','completed')", since),
      revenue: one("SELECT COALESCE(SUM(commission),0) FROM invoices WHERE type='commission' AND created_at >= ?", since),
      gst: one("SELECT COALESCE(SUM(gst),0) FROM invoices WHERE type='commission' AND created_at >= ?", since),
      ad_revenue: one("SELECT COALESCE(SUM(price),0) FROM ads WHERE created_at >= ? AND status IN ('active','expired','paused')", since),
      classes: one("SELECT COUNT(*) FROM invoices WHERE type='commission' AND created_at >= ?", since),
      new_parents: one("SELECT COUNT(*) FROM users WHERE role='parent' AND created_at >= ?", since),
      new_tutors: one("SELECT COUNT(*) FROM users WHERE role='tutor' AND created_at >= ?", since),
      repeat_parents: one("SELECT COUNT(*) FROM (SELECT parent_id FROM bookings WHERE status IN ('accepted','completed') GROUP BY parent_id HAVING COUNT(*) > 1)"),
    },
    funnel: { requests, accepted: (status.accepted || 0) + (status.completed || 0), rejected: status.rejected || 0, cancelled: status.cancelled || 0, pending: status.requested || 0,
      trials: trials.length, trials_converted: converted },
    attendance: { total: attTotal, present: att.present || att.completed || 0, tutor_absent: att.tutor_absent || 0, student_absent: att.student_absent || 0, not_marked: att.not_marked || 0 },
    top_areas: topAreas,
    top_categories: q.all(`SELECT category, COUNT(*) bookings, SUM(amount) value FROM bookings WHERE created_at >= ? AND status IN ('accepted','completed') GROUP BY category ORDER BY bookings DESC LIMIT 10`, since),
    top_tutors: q.all(`SELECT u.id, u.name, COUNT(*) classes, SUM(i.gross) fees,
        ROUND(CASE WHEN tp.rating_count > 0 THEN tp.rating_sum * 1.0 / tp.rating_count END, 1) rating,
        (SELECT COUNT(*) FROM sessions s JOIN bookings b ON b.id = s.booking_id WHERE b.tutor_id = u.id AND s.attendance = 'tutor_absent' AND s.marked_at >= ?) missed
      FROM invoices i JOIN users u ON u.id = i.user_id LEFT JOIN tutor_profiles tp ON tp.user_id = u.id
      WHERE i.type = 'commission' AND i.created_at >= ? GROUP BY u.id ORDER BY classes DESC LIMIT 10`, since, since),
  });
});

module.exports = { router: r, settleWeek, payoutReport, lastWeek, weekOf };
