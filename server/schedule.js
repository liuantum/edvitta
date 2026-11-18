'use strict';
// Attendance, holidays and automatic rescheduling.
// - A class the tutor missed (or that nobody marked) gets a free make-up class on the next free day of the plan.
// - Holidays and leave days (platform-wide, a tutor's leave, or a child's leave on one booking) move the classes
//   on that day to the end of the plan, so the parent never loses a paid class.
const { q, tx, getSetting } = require('./db');
const finance = require('./finance');
const { walletMove, notify, otp4 } = require('./lib');

// India time. Dates are stored as YYYY-MM-DD in local (IST) terms.
const IST_MS = 330 * 60000;
const todayIST = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

function isHoliday(date, tutorId, bookingId) {
  return !!q.get(`SELECT 1 FROM holidays WHERE date = ? AND (scope = 'platform' OR (scope = 'tutor' AND ref_id = ?) OR (scope = 'booking' AND ref_id = ?))`,
    date, tutorId, bookingId);
}

// The next free class day for a booking after its current last class (and never before tomorrow).
function nextSlot(b) {
  const last = q.get("SELECT MAX(date) d FROM sessions WHERE booking_id = ? AND status != 'cancelled'", b.id).d || b.end_date;
  const tomorrow = addDays(todayIST(), 1);
  let d = addDays(last > tomorrow ? last : addDays(tomorrow, -1), 1);
  const days = JSON.parse(b.days || '[]');
  for (let i = 0; i < 366; i++, d = addDays(d, 1)) {
    if (b.schedule_type === 'custom' && days.length && !days.includes(dow(d))) continue;
    if (isHoliday(d, b.tutor_id, b.id)) continue;
    if (q.get("SELECT 1 FROM sessions WHERE booking_id = ? AND date = ? AND status != 'cancelled'", b.id, d)) continue;
    return d;
  }
  throw new Error('No free day found to reschedule');
}

function extendEnd(b, date) {
  q.run('UPDATE bookings SET end_date = ? WHERE id = ? AND end_date < ?', date, b.id, date);
}

// Missed class -> new make-up class row (the missed one stays in the attendance history). Call inside tx().
function makeup(s, b) {
  const date = nextSlot(b);
  q.run('INSERT INTO sessions(booking_id, date, start_otp, makeup_for, original_date) VALUES (?,?,?,?,?)', b.id, date, otp4(), s.id, s.date);
  extendEnd(b, date);
  return date;
}

// Holiday / leave -> the class itself moves to a new date. Call inside tx().
function moveSession(s, b) {
  const date = nextSlot(b);
  q.run('UPDATE sessions SET date = ?, original_date = COALESCE(original_date, ?) WHERE id = ?', date, s.date, s.id);
  extendEnd(b, date);
  return date;
}

// Pays the tutor for one class (fee minus commission and GST), with a commission invoice. Call inside tx().
function settleSession(s, b, { status = 'completed', attendance = 'present' } = {}) {
  const sp = finance.split(b.rate);
  q.run(`UPDATE sessions SET status = ?, attendance = ?, ended_at = COALESCE(ended_at, unixepoch()), payout = ?, gross = ?, commission = ?, gst = ? WHERE id = ?`,
    status, attendance, sp.net, sp.gross, sp.commission, sp.gst, s.id);
  if (sp.gross > 0) finance.createInvoice({ type: 'commission', user_id: b.tutor_id, booking_id: b.id, session_id: s.id, s: sp, meta: { date: s.date, category: b.category, attendance } });
  if (sp.net > 0) walletMove(b.tutor_id, 'credit', sp.net, `Session payout: booking #${b.id} (${s.date})`, `session:${s.id}`);
  closeIfDone(b);
  return sp.net;
}

function closeIfDone(b) {
  const left = q.get("SELECT COUNT(*) n FROM sessions WHERE booking_id = ? AND status IN ('scheduled','on_the_way','in_progress')", b.id).n;
  if (left === 0) q.run("UPDATE bookings SET status = 'completed' WHERE id = ? AND status = 'accepted'", b.id);
}

const LABEL = { tutor_absent: 'the tutor could not come', student_absent: 'the student was absent', not_marked: 'nobody marked attendance' };

// Marks a class as missed. Returns { makeup_date } or { paid } depending on the reason and the admin's policy.
function markMissed(s, b, reason, byUserId, note) {
  if (!['scheduled', 'on_the_way'].includes(s.status)) throw new Error('This class is already ' + s.status.replace(/_/g, ' '));
  const chargeStudentAbsent = reason === 'student_absent' && getSetting('student_absent_policy', 'makeup') === 'charge';
  const out = tx(() => {
    q.run('UPDATE sessions SET marked_by = ?, marked_at = unixepoch(), attendance_note = ? WHERE id = ?', byUserId, note || null, s.id);
    if (chargeStudentAbsent) return { paid: settleSession(s, b, { status: 'missed', attendance: 'student_absent' }) };
    q.run("UPDATE sessions SET status = 'missed', attendance = ? WHERE id = ?", reason, s.id);
    return { makeup_date: makeup(s, b) };
  });
  const msg = out.makeup_date
    ? `Class on ${s.date} (booking #${b.id}) was missed because ${LABEL[reason]}. A free make-up class is booked on ${out.makeup_date}.`
    : `Class on ${s.date} (booking #${b.id}) was marked "student absent". As per policy, the class is counted.`;
  notify(b.parent_id, msg, `#/parent/bookings/${b.id}`, { important: true });
  notify(b.tutor_id, msg, `#/tutor/bookings/${b.id}`, { important: true });
  return out;
}

// Applies a holiday: every scheduled class on that day (for its scope) moves to the end of its plan.
function applyHoliday(h) {
  const where = h.scope === 'platform' ? '' : h.scope === 'tutor' ? 'AND b.tutor_id = ?' : 'AND b.id = ?';
  const args = h.scope === 'platform' ? [h.date] : [h.date, h.ref_id];
  const rows = q.all(`SELECT s.* FROM sessions s JOIN bookings b ON b.id = s.booking_id
    WHERE s.date = ? AND s.status = 'scheduled' AND b.status = 'accepted' ${where}`, ...args);
  const moved = [];
  tx(() => {
    for (const s of rows) {
      const b = q.get('SELECT * FROM bookings WHERE id = ?', s.booking_id);
      moved.push({ b, from: s.date, to: moveSession(s, b) });
    }
    q.run('UPDATE holidays SET moved = moved + ? WHERE id = ?', rows.length, h.id);
  });
  const why = h.scope === 'platform' ? `holiday${h.reason ? ' (' + h.reason + ')' : ''}` : h.scope === 'tutor' ? "the tutor's leave" : "your child's leave";
  for (const m of moved) {
    const text = `Class on ${m.from} (booking #${m.b.id}) moved to ${m.to} because of ${why}.`;
    if (h.scope !== 'booking') notify(m.b.parent_id, text, `#/parent/bookings/${m.b.id}`, { important: true });
    if (h.scope !== 'tutor') notify(m.b.tutor_id, text.replace("your child's leave", "the child's leave"), `#/tutor/bookings/${m.b.id}`, { important: true });
  }
  return moved.length;
}

function addHoliday({ scope, ref_id = null, date, reason, created_by }) {
  if (q.get('SELECT 1 FROM holidays WHERE scope = ? AND ref_id IS ? AND date = ?', scope, ref_id, date)) throw new Error('That day is already marked');
  const info = q.run('INSERT INTO holidays(scope, ref_id, date, reason, created_by) VALUES (?,?,?,?,?)', scope, ref_id, date, reason || null, created_by);
  const h = q.get('SELECT * FROM holidays WHERE id = ?', Number(info.lastInsertRowid));
  return { id: h.id, moved: applyHoliday(h) };
}

// Daily job: classes from earlier days that were never started are marked "not marked" and get a make-up class.
function autoMarkPast() {
  const rows = q.all(`SELECT s.* FROM sessions s JOIN bookings b ON b.id = s.booking_id
    WHERE s.date < ? AND s.status IN ('scheduled','on_the_way') AND b.status = 'accepted' LIMIT 500`, todayIST());
  let n = 0;
  for (const s of rows) {
    const b = q.get('SELECT * FROM bookings WHERE id = ?', s.booking_id);
    try { markMissed(s, b, 'not_marked', null, 'Marked automatically'); n++; } catch (e) { console.error('[edvitta] auto-mark failed for session', s.id, e.message); }
  }
  return n;
}

module.exports = { todayIST, addDays, isHoliday, nextSlot, makeup, moveSession, settleSession, closeIfDone, markMissed, applyHoliday, addHoliday, autoMarkPast };
