// Round-3 admin screens: analytics, weekly payouts, holidays.
import { state, api, route, go, esc, rs, fmtDate, toast, onSubmit, act, confirmBox, catName, catIcon } from './core.js';
import { shell } from './layout.js';

const A = { roles: ['admin', 'staff'] };
const ADMIN = { roles: ['admin'] };
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');
const tile = (n, l, sub) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>`;

// Single-series column chart (one hue, rounded tops on the baseline, hover shows the exact value).
function barChart(series, key, fmt, title) {
  const W = 720, H = 180, pad = { l: 8, r: 8, t: 10, b: 22 };
  const max = Math.max(1, ...series.map((d) => d[key]));
  const bw = (W - pad.l - pad.r) / series.length;
  const gap = Math.min(2, bw * 0.2);
  const total = series.reduce((a, d) => a + d[key], 0);
  const labelEvery = Math.ceil(series.length / 8);
  const bars = series.map((d, i) => {
    const h = d[key] ? Math.max(2, ((H - pad.t - pad.b) * d[key]) / max) : 0;
    const x = pad.l + i * bw, y = H - pad.b - h;
    return `<g class="bar"><rect x="${x}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" fill="transparent"><title>${esc(fmtDate(d.d))}: ${esc(fmt(d[key]))}</title></rect>
      ${h ? `<path d="M${x + gap / 2},${y + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, bw / 2)},-${Math.min(4, h)} h${Math.max(0, bw - gap - 2 * Math.min(4, bw / 2))} q${Math.min(4, bw / 2)},0 ${Math.min(4, bw / 2)},${Math.min(4, h)} V${H - pad.b} H${x + gap / 2} Z" fill="var(--brand)" pointer-events="none"/>` : ''}
      ${i % labelEvery === 0 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(d.d.slice(5))}</text>` : ''}</g>`;
  }).join('');
  return `<div class="card"><div class="row between"><h3 style="margin:0">${esc(title)}</h3><span class="small muted">Total ${esc(fmt(total))} · peak ${esc(fmt(max === 1 && !total ? 0 : max))}</span></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(title)}" style="display:block;margin-top:8px">
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}" stroke="var(--line)"/>${bars}</svg></div>`;
}

// ---------- Analytics ----------
route('/admin/analytics', async ({ query }) => {
  const v = shell('Analytics');
  const days = [7, 30, 90, 365].includes(Number(query.days)) ? Number(query.days) : 30;
  const d = await api('/admin/analytics?days=' + days);
  const t = d.totals, f = d.funnel, a = d.attendance;
  v.innerHTML = `<div class="tabs">${[[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']].map(([n, l]) => `<a href="#/admin/analytics?days=${n}" class="${n === days ? 'on' : ''}">${l}</a>`).join('')}</div>
    <div class="grid g4">${tile(t.bookings, 'Booking requests')}${tile(rs(t.booking_value), 'Booking value (accepted)')}${tile(rs(t.revenue), 'Commission earned', t.gst ? `+ ${rs(t.gst)} GST` : '')}${tile(rs(t.ad_revenue), 'Ad revenue')}
    ${tile(t.classes, 'Classes completed')}${tile(t.new_parents, 'New parents')}${tile(t.new_tutors, 'New tutors')}${tile(t.repeat_parents, 'Parents with 2+ bookings', 'all time')}</div>
    ${barChart(d.series, 'bookings', String, 'Booking requests per day')}
    ${barChart(d.series, 'revenue', rs, 'Commission earned per day')}
    <div class="grid g2"><div class="card"><h3>Booking funnel</h3><dl class="kv">
      <dt>Requests</dt><dd>${f.requests}</dd><dt>Accepted</dt><dd>${f.accepted} <span class="muted small">(${pct(f.accepted, f.requests)})</span></dd>
      <dt>Declined by tutor</dt><dd>${f.rejected} <span class="muted small">(${pct(f.rejected, f.requests)})</span></dd><dt>Cancelled</dt><dd>${f.cancelled}</dd><dt>Waiting for tutor</dt><dd>${f.pending}</dd>
      <dt>Trial classes</dt><dd>${f.trials}</dd><dt>Trial → paid plan</dt><dd>${f.trials_converted} <span class="muted small">(${pct(f.trials_converted, f.trials)})</span></dd></dl></div>
    <div class="card"><h3>Attendance</h3><dl class="kv"><dt>Classes due</dt><dd>${a.total}</dd><dt>Attended</dt><dd>${a.present} <span class="muted small">(${pct(a.present, a.total)})</span></dd>
      <dt>Tutor absent</dt><dd>${a.tutor_absent} <span class="muted small">(${pct(a.tutor_absent, a.total)})</span></dd><dt>Student absent</dt><dd>${a.student_absent}</dd><dt>Not marked</dt><dd>${a.not_marked}</dd></dl>
      <p class="small muted">Missed classes get a free make-up class automatically.</p></div></div>
    <div class="card"><h3>Top areas (home tuition)</h3><div class="table-wrap"><table><thead><tr><th>Area</th><th>Bookings</th><th>Value</th><th>Parents</th><th>Verified tutors based here</th></tr></thead><tbody>
      ${d.top_areas.map((x) => `<tr><td>${esc(x.area)}</td><td>${x.bookings}</td><td>${rs(x.value)}</td><td>${x.parents}</td><td>${x.tutors}${x.bookings > 3 && x.tutors < 2 ? ' <span class="badge warn">recruit tutors</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No home bookings in this period</td></tr>'}</tbody></table></div></div>
    <div class="grid g2"><div class="card"><h3>Top subjects & skills</h3><div class="table-wrap"><table><thead><tr><th>Subject</th><th>Bookings</th><th>Value</th></tr></thead><tbody>
      ${d.top_categories.map((x) => `<tr><td>${catIcon(x.category)} ${esc(catName(x.category))}</td><td>${x.bookings}</td><td>${rs(x.value)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No bookings yet</td></tr>'}</tbody></table></div></div>
    <div class="card"><h3>Top tutors</h3><div class="table-wrap"><table><thead><tr><th>Tutor</th><th>Classes</th><th>Fees</th><th>Rating</th><th>Missed</th></tr></thead><tbody>
      ${d.top_tutors.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.classes}</td><td>${rs(x.fees)}</td><td>${x.rating ? '⭐ ' + x.rating : '–'}</td><td>${x.missed ? `<span class="badge bad">${x.missed}</span>` : '0'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No classes yet</td></tr>'}</tbody></table></div></div></div>`;
}, ADMIN);

// ---------- Weekly payouts ----------
const monday = (d) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toLocaleDateString('en-CA'); };
route('/admin/payouts', async ({ query }) => {
  const v = shell('Weekly tutor payouts');
  const d = await api('/admin/payouts' + (query.week ? '?week=' + encodeURIComponent(query.week) : ''));
  const t = d.totals;
  const prev = new Date(d.week_start + 'T00:00:00'); prev.setDate(prev.getDate() - 7);
  const next = new Date(d.week_start + 'T00:00:00'); next.setDate(next.getDate() + 7);
  const thisWeek = monday(new Date().toLocaleDateString('en-CA'));
  const nextW = next.toLocaleDateString('en-CA');
  v.innerHTML = `<div class="row between" style="margin-bottom:12px"><div class="row"><a class="btn ghost sm" href="#/admin/payouts?week=${prev.toLocaleDateString('en-CA')}">← Previous</a>
      <strong>${fmtDate(d.week_start)} – ${fmtDate(d.week_end)}</strong>${nextW <= thisWeek ? `<a class="btn ghost sm" href="#/admin/payouts?week=${nextW}">Next →</a>` : ''}</div>
      <div class="row"><a class="btn ghost sm" href="/api/admin/payouts.csv?week=${d.week_start}" download>⬇ Download CSV</a>
      ${state.user.role === 'admin' && !d.batch && d.week_start < thisWeek ? '<button class="btn sm" id="settle">Settle this week</button>' : ''}</div></div>
    ${d.batch ? `<div class="alert ok small">✔ Settled on ${fmtDate(d.batch.created_at)}${d.batch.withdrawals_created ? `. ${d.batch.withdrawals_created} payout request(s) created: pay them in <a href="#/admin/payments?status=pending">Payments → Withdrawals</a>.` : '.'}</div>`
      : d.week_start >= thisWeek ? '<div class="alert small">This week is still running. Numbers update as classes finish.</div>' : ''}
    <div class="grid g4">${tile(t.tutors, 'Tutors paid')}${tile(t.classes, 'Classes')}${tile(rs(t.gross), 'Class fees')}${tile(rs(t.commission), 'Commission', t.gst ? `+ ${rs(t.gst)} GST` : '')}${tile(rs(t.net), 'Tutors earned')}</div>
    <div class="card table-wrap"><table><thead><tr><th>Tutor</th><th>Payout UPI</th><th>Classes</th><th>Fees</th><th>Commission</th><th>GST</th><th>Earned</th><th>Wallet now</th><th>Missed</th></tr></thead><tbody>
    ${d.rows.map((x) => `<tr><td><strong>${esc(x.name)}</strong><div class="small muted">${esc(x.phone)}</div></td><td class="small">${x.payout_upi ? esc(x.payout_upi) : '<span class="badge warn">not set</span>'}</td>
      <td>${x.classes}</td><td>${rs(x.gross)}</td><td>${rs(x.commission)}</td><td>${rs(x.gst)}</td><td><strong>${rs(x.net)}</strong></td><td>${rs(x.wallet_balance)}${x.withdrawals_pending ? `<div class="small muted">${rs(x.withdrawals_pending)} requested</div>` : ''}</td>
      <td>${x.missed_by_tutor ? `<span class="badge bad">${x.missed_by_tutor}</span>` : '0'}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No tutor earnings this week</td></tr>'}</tbody></table></div>
    <p class="small muted">Tutors are credited to their wallet after every class. Settling closes the week; with "create payout requests" each tutor's earnings for the week move from their wallet into a payout to their saved UPI (minimum ₹100).</p>`;
  act(v, '#settle', async () => {
    const make = await confirmBox(`Settle ${fmtDate(d.week_start)} – ${fmtDate(d.week_end)} and create payout requests for tutors with a saved UPI?`, 'Settle & create payouts');
    if (!make) return;
    const r = await api('/admin/payouts/settle', { method: 'POST', body: { week: d.week_start, create_withdrawals: true } });
    toast(`Week settled. ${r.withdrawals_created} payout request(s) created.`); go('#/admin/payouts?week=' + d.week_start);
  });
}, { roles: ['admin', 'staff'] });

// ---------- Holidays ----------
route('/admin/holidays', async () => {
  const v = shell('Holidays & leave');
  const { items } = await api('/admin/holidays');
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA');
  const scope = { platform: '🎉 Platform holiday', tutor: '🧑‍🏫 Tutor leave', booking: '🧒 Child leave' };
  v.innerHTML = `<div class="grid g2">${state.user.role === 'admin' ? `<div class="card"><h3>Add a platform holiday</h3><p class="small muted">Every class on this day (all tutors) moves to the end of its plan, and parents and tutors are told right away.</p>
    <form id="f"><label>Date</label><input type="date" name="date" min="${tomorrow}" required><label>Holiday name</label><input name="reason" required maxlength="80" placeholder="e.g. Diwali">
    <button class="btn" type="submit" style="margin-top:12px">Add holiday</button></form></div>` : ''}
    <div class="card table-wrap"><h3>Upcoming and recent</h3><table><thead><tr><th>Date</th><th>Type</th><th>Reason</th><th>Classes moved</th><th></th></tr></thead><tbody>
    ${items.map((h) => `<tr><td>${fmtDate(h.date)}</td><td class="small">${scope[h.scope]}${h.who ? '<br>' + esc(h.who) : h.scope === 'booking' ? '<br>Booking #' + h.ref_id : ''}</td><td class="small">${esc(h.reason || '')}</td><td>${h.moved}</td>
      <td>${state.user.role === 'admin' && h.scope === 'platform' ? `<button class="btn ghost sm" data-del="${h.id}">Remove</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing yet</td></tr>'}</tbody></table></div></div>`;
  onSubmit(v, '#f', async (d) => { const r = await api('/admin/holidays', { method: 'POST', body: d }); toast(`Holiday added. ${r.moved} class(es) moved.`); go('#/admin/holidays'); });
  act(v, '[data-del]', async (_e, el) => { if (await confirmBox('Remove this holiday? Classes already moved stay on their new dates.', 'Remove')) { await api('/admin/holidays/' + el.dataset.del, { method: 'DELETE' }); go('#/admin/holidays'); } });
}, A);
