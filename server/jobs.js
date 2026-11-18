'use strict';
// Background jobs (run inside the app; each runs at most once per day / week, even across restarts).
const { q, flag } = require('./db');
const schedule = require('./schedule');
const { notify } = require('./lib');

function once(name, key, fn) {
  const row = q.get('SELECT last_key FROM job_runs WHERE name = ?', name);
  if (row && row.last_key === key) return;
  q.run('INSERT INTO job_runs(name, last_key, ran_at) VALUES (?,?,unixepoch()) ON CONFLICT(name) DO UPDATE SET last_key = excluded.last_key, ran_at = excluded.ran_at', name, key);
  try { fn(); } catch (e) { console.error(`[edvitta] job ${name} failed:`, e.message); }
}

function tick() {
  const today = schedule.todayIST();
  // Classes from earlier days that never started get "not marked" and a free make-up class.
  once('auto_mark_missed', today, () => { const n = schedule.autoMarkPast(); if (n) console.log(`[edvitta] ${n} unmarked classes rescheduled`); });
  // Every Monday: weekly earnings summary to each tutor, and (if switched on) automatic weekly settlement.
  const ops = require('./routes/ops');
  const thisWeek = ops.weekOf(today);
  if (today === thisWeek) once('weekly_payouts', thisWeek, () => {
    const week = ops.lastWeek();
    const rep = ops.payoutReport(week);
    if (flag('weekly_payout_report_enabled', '1')) for (const x of rep.rows)
      notify(x.tutor_id, `Your earnings for ${week} to ${rep.week_end}: ${x.classes} classes, ₹${(x.net / 100).toFixed(2)} after commission.`, '#/tutor/earnings');
    if (flag('auto_weekly_settlement')) {
      const admin = q.get("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
      try { ops.settleWeek(week, admin?.id ?? null, true); } catch (e) { console.error('[edvitta] weekly settlement:', e.message); }
    }
  });
}

function start() {
  if (process.env.DISABLE_JOBS === '1') return;
  setTimeout(tick, 5000).unref();
  setInterval(tick, 30 * 60 * 1000).unref();
}

module.exports = { start, tick };
