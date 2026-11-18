import { state, api, route, go, esc, rs, fmtDate, fmtDT, toast, onSubmit, act, modal, confirmBox, catName, badge, makeMap, pinIcon, onLeave } from './core.js';
import { shell } from './layout.js';
import { ticketView } from './common.js';

const A = { roles: ['admin', 'staff'] };
const ADMIN = { roles: ['admin'] };
const can = (p) => state.user.role === 'admin' || state.user.permissions.includes(p);
const tabs = (base, cur, list) => `<div class="tabs">${list.map(([k, l]) => `<a href="${base}?status=${k}" class="${cur === k ? 'on' : ''}">${l}</a>`).join('')}</div>`;

// ---------- Dashboard ----------
route('/admin', async () => {
  const v = shell(state.user.role === 'admin' ? 'Admin dashboard' : 'Staff dashboard');
  const s = await api('/admin/stats');
  const tile = (n, l, href, warn) => `<a class="card stat" style="color:inherit;${warn ? 'border-color:var(--accent)' : ''}" href="${href || '#/admin'}"><div class="n">${n}</div><div class="l">${l}</div></a>`;
  v.innerHTML = `${s.sos_open && can('sos') ? `<div class="alert bad">🚨 <strong>${s.sos_open} open SOS alert(s).</strong> <a href="#/admin/sos">Respond now</a></div>` : ''}
    <h3>Needs action</h3><div class="grid g4">
    ${can('kyc') ? tile(s.kyc_pending, 'KYC to review', '#/admin/kyc', s.kyc_pending) : ''}
    ${can('payments') ? tile(s.payments_pending, 'UPI payments to verify', '#/admin/payments', s.payments_pending) : ''}
    ${can('payments') ? tile(s.withdrawals_pending, 'Withdrawals to pay', '#/admin/payments?status=pending', s.withdrawals_pending) : ''}
    ${can('tickets') ? tile(s.tickets_open, 'Open helpline tickets', '#/admin/tickets', s.tickets_open) : ''}
    ${can('ads') ? tile(s.ads_pending, 'Ads to approve', '#/admin/ads', s.ads_pending) : ''}</div>
    <h3>Platform</h3><div class="grid g4">${tile(s.parents, 'Parents')}${tile(s.tutors_active + ' / ' + s.tutors, 'Verified tutors')}${tile(s.tutors_online, 'Tutors online now')}
    ${tile(s.bookings_active, 'Active bookings', '#/admin/bookings')}${tile(s.sessions_today, 'Sessions today')}${tile(s.live_now, 'Live right now', '#/admin/sos')}${tile(s.groups, 'Community groups', '#/admin/groups')}</div>
    ${state.user.role === 'admin' ? `<h3>Money</h3><div class="grid g4">${tile(rs(s.gmv), 'Booking value (GMV)')}${tile(rs(s.payouts), 'Paid to tutors')}${tile(rs(s.ad_revenue), 'Ad revenue')}${tile(rs(s.wallet_float), 'User wallet balances')}</div>` : ''}`;
}, A);

// ---------- KYC ----------
route('/admin/kyc', async ({ query }) => {
  const v = shell('Tutor KYC');
  const st = query.status || 'submitted';
  const { items } = await api('/admin/kyc?status=' + st);
  v.innerHTML = tabs('#/admin/kyc', st, [['submitted', 'To review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['not_submitted', 'Not submitted']]) +
    `<div class="card table-wrap"><table><thead><tr><th>Tutor</th><th>Teaches</th><th>Area</th><th>Joined</th><th></th></tr></thead><tbody>${items.map((t) => `<tr><td><strong>${esc(t.name)}</strong><div class="small muted">${esc(t.phone)} · ${esc(t.email)}</div></td>
    <td class="small">${JSON.parse(t.categories).map(catName).map(esc).join(', ')}</td><td class="small">${esc(t.address || '')}</td><td class="small">${fmtDate(t.created_at)}</td>
    <td><a class="btn sm" href="#/admin/kyc/${t.id}">Review</a></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing here</td></tr>'}</tbody></table></div>`;
}, A);

route('/admin/kyc/:id', async ({ params }) => {
  const v = shell('Review tutor');
  const { tutor: t, docs } = await api('/admin/kyc/' + params.id);
  v.innerHTML = `<div class="grid g2"><div class="card"><div class="row between"><h2>${esc(t.name)}</h2>${badge(t.kyc_status)}</div><dl class="kv">
    <dt>Phone</dt><dd>${esc(t.phone)}</dd><dt>Email</dt><dd>${esc(t.email)}</dd><dt>Address</dt><dd>${esc(t.address || '')}</dd>
    <dt>Teaches</dt><dd>${t.categories.map(catName).map(esc).join(', ')}</dd><dt>Qualification</dt><dd>${esc(t.qualification)}</dd>
    <dt>Experience</dt><dd>${t.experience_years} years</dd><dt>Rate</dt><dd>${rs(t.rate_per_session)}/hr</dd><dt>Mode</dt><dd>${esc(t.mode)}</dd><dt>Bio</dt><dd>${esc(t.bio)}</dd></dl>
    ${t.kyc_note ? `<p class="small">Last note: ${esc(t.kyc_note)}</p>` : ''}</div>
    <div class="card"><h3>Decision</h3><p class="small muted">Check that the photo matches the ID, the name matches across documents, and documents are not edited. Every view is logged.</p>
    <form id="d"><label class="chk"><input type="checkbox" name="police_verified" value="1" ${t.police_verification ? 'checked' : ''}> Police verification checked</label>
    <label>Note to tutor (required when rejecting)</label><textarea name="note"></textarea>
    <div class="row" style="margin-top:10px"><button class="btn ok" type="submit" name="decision" value="approved">Approve & activate</button><button class="btn bad" type="submit" name="decision" value="rejected">Reject</button></div></form></div></div>
    <div class="card"><h3>Background check</h3><p class="small">Current: ${badge(t.background_check)} ${t.background_note ? '· ' + esc(t.background_note) : ''}</p>
    <p class="small muted">Tutors get the green "Verified" badge when KYC is approved, police verification is checked and the background check is clear. A flagged tutor is hidden from search.</p>
    <form id="bg"><select name="status">${['not_started', 'in_progress', 'clear', 'flagged'].map((x) => `<option value="${x}" ${t.background_check === x ? 'selected' : ''}>${x.replace('_', ' ')}</option>`).join('')}</select>
    <label class="chk"><input type="checkbox" name="police_verified" value="1" ${t.police_verification ? 'checked' : ''}> Police verification certificate checked</label>
    <label>Note (references called, records checked; required if flagged)</label><textarea name="note">${esc(t.background_note || '')}</textarea>
    <button class="btn" type="submit" style="margin-top:8px">Save background check</button></form></div>
    <div class="card"><h3>Documents</h3><div class="docs">${docs.map((d) => `<figure><a href="/api/admin/kyc-doc/${d.id}" target="_blank" rel="noopener">${d.mime === 'application/pdf' ? '<div class="empty">📄 Open PDF</div>' : `<img src="/api/admin/kyc-doc/${d.id}" alt="">`}</a>
    <figcaption>${esc(d.doc_type.replace(/_/g, ' '))}<br><span class="muted">${fmtDT(d.uploaded_at)}</span></figcaption></figure>`).join('') || '<p class="muted">No documents uploaded</p>'}</div></div>`;
  onSubmit(v, '#bg', async (d) => { await api(`/admin/kyc/${t.id}/background`, { method: 'POST', body: { ...d, police_verified: !!d.police_verified } }); toast('Background check saved'); go('#/admin/kyc/' + t.id); });
  const f = v.querySelector('#d');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/admin/kyc/${t.id}/decision`, { method: 'POST', body: { decision: e.submitter.value, note: f.note.value, police_verified: f.police_verified.checked } });
      toast('Saved'); go('#/admin/kyc');
    } catch (err) { toast(err.message, true); }
  });
}, A);

// ---------- Payments ----------
route('/admin/payments', async ({ query }) => {
  const v = shell('Payments');
  const st = query.status || 'pending';
  const { items, withdrawals } = await api('/admin/payments?status=' + st);
  v.innerHTML = tabs('#/admin/payments', st, [['pending', 'Pending'], ['approved', 'Approved / paid'], ['rejected', 'Rejected']]) +
    `<div class="card"><h3>UPI QR top-ups</h3><p class="small muted">Match the UTR and amount with your bank / UPI statement before approving.</p><div class="table-wrap"><table><thead><tr><th>User</th><th>Amount</th><th>UTR</th><th>Proof</th><th>Submitted</th><th></th></tr></thead><tbody>
    ${items.map((m) => `<tr><td>${esc(m.name)} ${badge(m.role)}<div class="small muted">${esc(m.phone)}</div></td><td><strong>${rs(m.amount)}</strong></td><td><code>${esc(m.utr)}</code></td>
    <td>${m.proof_name ? `<a href="/api/admin/payments/${m.id}/proof" target="_blank" rel="noopener">View</a>` : '–'}</td><td class="small">${fmtDT(m.created_at)}</td>
    <td>${m.status === 'pending' ? `<div class="row"><button class="btn ok sm" data-p="${m.id}" data-d="approved" data-a="${m.amount / 100}">Approve</button><button class="btn ghost sm" data-p="${m.id}" data-d="rejected">Reject</button></div>` : badge(m.status)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">None</td></tr>'}
    </tbody></table></div></div>
    <div class="card"><h3>Withdrawals</h3><div class="table-wrap"><table><thead><tr><th>User</th><th>Amount</th><th>UPI ID</th><th>Requested</th><th></th></tr></thead><tbody>
    ${withdrawals.map((w) => `<tr><td>${esc(w.name)} ${badge(w.role)}<div class="small muted">${esc(w.phone)}</div></td><td><strong>${rs(w.amount)}</strong></td><td><code>${esc(w.upi_id)}</code></td><td class="small">${fmtDT(w.created_at)}</td>
    <td>${w.status === 'pending' ? `<div class="row"><button class="btn ok sm" data-w="${w.id}" data-d="paid">Mark paid</button><button class="btn ghost sm" data-w="${w.id}" data-d="rejected">Reject</button></div>` : badge(w.status)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">None</td></tr>'}
    </tbody></table></div></div>`;
  act(v, '[data-p]', async (_e, el) => {
    if (el.dataset.d === 'approved') {
      modal(`<h3>Approve payment</h3><form id="ap"><label>Amount received (₹)</label><input name="amount" type="number" step="0.01" value="${el.dataset.a}" required>
        <label>Note</label><input name="note"><div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn ok" type="submit">Approve & credit wallet</button></div></form>`,
      (m, close) => onSubmit(m, '#ap', async (d) => { await api(`/admin/payments/${el.dataset.p}/decision`, { method: 'POST', body: { decision: 'approved', ...d } }); close(); toast('Approved'); go('#/admin/payments'); }));
    } else if (await confirmBox('Reject this payment?', 'Reject')) { await api(`/admin/payments/${el.dataset.p}/decision`, { method: 'POST', body: { decision: 'rejected' } }); go('#/admin/payments'); }
  });
  act(v, '[data-w]', async (_e, el) => {
    if (await confirmBox(el.dataset.d === 'paid' ? 'Confirm you have sent this money to the UPI ID?' : 'Reject and return the amount to the wallet?')) {
      await api(`/admin/withdrawals/${el.dataset.w}/decision`, { method: 'POST', body: { decision: el.dataset.d } }); go('#/admin/payments');
    }
  });
}, A);

// ---------- Helpline tickets ----------
route('/admin/tickets', async ({ query }) => {
  const v = shell('Customer helpline');
  const st = query.status || 'open';
  const { items } = await api(`/tickets?status=${st}${query.mine ? '&mine=1' : ''}`);
  v.innerHTML = tabs('#/admin/tickets', st, [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed']]) +
    `<div class="row" style="margin-bottom:10px"><a class="btn ghost sm" href="#/admin/tickets?status=${st}&mine=1">Assigned to me</a><a class="btn ghost sm" href="#/admin/tickets?status=${st}">All</a></div>
    <div class="card table-wrap"><table><thead><tr><th>#</th><th>Subject</th><th>From</th><th>Priority</th><th>Assignee</th><th>Updated</th></tr></thead><tbody>
    ${items.map((t) => `<tr><td>${t.id}</td><td><a href="#/admin/tickets/${t.id}"><strong>${esc(t.subject)}</strong></a><div class="small muted">${esc(t.category)}</div></td><td>${esc(t.user_name)} ${badge(t.user_role)}</td>
    <td>${badge(t.priority)}</td><td class="small">${esc(t.assignee || '–')}</td><td class="small">${fmtDT(t.updated_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No tickets</td></tr>'}</tbody></table></div>`;
}, A);
route('/admin/tickets/:id', ({ params }) => ticketView(params.id, true), A);

// ---------- SOS & live map ----------
route('/admin/sos', async () => {
  const v = shell('SOS & live sessions');
  const [{ items: sos }, { items: live }] = await Promise.all([api('/admin/sos'), api('/admin/live')]);
  v.innerHTML = `<div class="card"><h3>SOS alerts</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>From</th><th>Booking</th><th>Message</th><th>Location</th><th></th></tr></thead><tbody>
    ${sos.map((a) => `<tr style="${a.status === 'open' ? 'background:var(--bad-soft)' : ''}"><td class="small">${fmtDT(a.created_at)}</td><td>${esc(a.name)} ${badge(a.role)}<div><a href="tel:${esc(a.phone)}">📞 ${esc(a.phone)}</a></div></td>
    <td>${a.booking_id ? '#' + a.booking_id : '–'}</td><td>${esc(a.message || '')}</td><td>${a.lat ? `<a target="_blank" rel="noopener" href="https://maps.google.com/?q=${a.lat},${a.lng}">Map ↗</a>` : '–'}</td>
    <td>${a.status === 'open' ? `<button class="btn sm" data-h="${a.id}">Mark handled</button>` : badge('handled')}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No alerts</td></tr>'}</tbody></table></div></div>
    <div class="card"><h3>Live home sessions (${live.length})</h3><div class="map tall" id="map"></div></div>`;
  act(v, '[data-h]', async (_e, el) => { await api(`/admin/sos/${el.dataset.h}/handle`, { method: 'POST' }); go('#/admin/sos'); });
  const map = makeMap(v.querySelector('#map'), live[0]?.lat ? { lat: live[0].lat, lng: live[0].lng } : undefined, 13);
  if (!map) return;
  const markers = {};
  for (const s of live) {
    if (s.dest_lat) L.marker([s.dest_lat, s.dest_lng], { icon: pinIcon('🏠', '#f59e0b') }).addTo(map).bindPopup(`Booking #${s.booking_id} · ${esc(s.parent)}`);
    if (s.lat) markers[s.tutor] = L.marker([s.lat, s.lng], { icon: pinIcon('🧑‍🏫') }).addTo(map).bindPopup(`${esc(s.tutor)} · ${s.status.replace(/_/g, ' ')}`);
  }
  const sock = state.socket;
  if (sock) { const h = () => go('#/admin/sos'); sock.on('sos', h); onLeave(() => sock.off('sos', h)); }
}, A);

// ---------- Bookings ----------
route('/admin/bookings', async () => {
  const v = shell('All bookings');
  const { items } = await api('/admin/bookings');
  v.innerHTML = `<div class="card table-wrap"><table><thead><tr><th>#</th><th>Subject</th><th>Parent</th><th>Tutor</th><th>Dates</th><th>Amount</th><th>Status</th></tr></thead><tbody>
    ${items.map((b) => `<tr><td>${b.id}</td><td>${esc(catName(b.category))}<div class="small muted">${b.mode}</div></td><td>${esc(b.parent)}</td><td>${esc(b.tutor)}</td>
    <td class="small">${fmtDate(b.start_date)} → ${fmtDate(b.end_date)}<br>${esc(b.time)} · ${b.total_sessions} sessions</td><td>${rs(b.amount)}</td><td>${badge(b.status)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No bookings</td></tr>'}</tbody></table></div>`;
}, A);

// ---------- Users ----------
route('/admin/users', async ({ query }) => {
  const v = shell('Users');
  const role = query.role || '';
  const { items } = await api(`/admin/users?role=${role}&search=${encodeURIComponent(query.q || '')}`);
  v.innerHTML = `<div class="tabs">${[['', 'All'], ['parent', 'Parents'], ['tutor', 'Tutors'], ['staff', 'Staff']].map(([k, l]) => `<a href="#/admin/users?role=${k}" class="${role === k ? 'on' : ''}">${l}</a>`).join('')}</div>
    <form id="s" class="row" style="margin-bottom:10px"><input name="q" value="${esc(query.q || '')}" placeholder="Search name, email, phone" style="flex:1"><button class="btn ghost">Search</button></form>
    <div class="card table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Wallet</th><th>Joined</th><th>Status</th><th></th></tr></thead><tbody>
    ${items.map((u) => `<tr><td><strong>${esc(u.name)}</strong><div class="small muted">${esc(u.phone)} · ${esc(u.email)}</div></td><td>${badge(u.role)}</td><td>${rs(u.wallet_balance)}</td><td class="small">${fmtDate(u.created_at)}</td><td>${badge(u.status)}</td>
    <td><div class="row">${u.role !== 'admin' ? `<button class="btn ghost sm" data-st="${u.id}" data-to="${u.status === 'active' ? 'suspended' : 'active'}">${u.status === 'active' ? 'Suspend' : 'Activate'}</button>` : ''}
    ${state.user.role === 'admin' && ['parent', 'tutor'].includes(u.role) ? `<button class="btn ghost sm" data-wa="${u.id}">Adjust wallet</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No users</td></tr>'}</tbody></table></div>`;
  v.querySelector('#s').onsubmit = (e) => { e.preventDefault(); go(`#/admin/users?role=${role}&q=${encodeURIComponent(e.target.q.value)}`); };
  act(v, '[data-st]', async (_e, el) => { if (await confirmBox(`${el.dataset.to === 'suspended' ? 'Suspend' : 'Re-activate'} this account? They will be logged out everywhere.`)) { await api(`/admin/users/${el.dataset.st}/status`, { method: 'POST', body: { status: el.dataset.to } }); go(location.hash); } });
  act(v, '[data-wa]', (_e, el) => modal(`<h3>Adjust wallet</h3><form id="w"><select name="type"><option value="credit">Credit (add)</option><option value="debit">Debit (remove)</option></select>
    <label>Amount (₹)</label><input name="amount" type="number" min="1" required><label>Reason (shown to user)</label><input name="reason" required maxlength="120">
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Save</button></div></form>`,
  (m, close) => onSubmit(m, '#w', async (d) => { await api(`/admin/users/${el.dataset.wa}/wallet-adjust`, { method: 'POST', body: d }); close(); toast('Wallet updated'); go(location.hash); })));
}, A);

// ---------- Staff ----------
const PERM_LABEL = { tickets: 'Helpline tickets', kyc: 'KYC verification', payments: 'Payments & withdrawals', sos: 'SOS & live tracking', bookings: 'Bookings', ads: 'Ads', community: 'Community', users: 'Users' };
route('/admin/staff', async () => {
  const v = shell('Staff accounts');
  const { items } = await api('/admin/users?role=staff');
  v.innerHTML = `<div class="grid g2"><div class="card"><h3>Add staff member</h3><form id="f"><label>Name</label><input name="name" required><label>Email</label><input name="email" type="email" required>
    <label>Phone</label><input name="phone" required><label>Temporary password</label><input name="password" required minlength="8">
    <label>Permissions</label>${Object.entries(PERM_LABEL).map(([k, l]) => `<label class="chk"><input type="checkbox" name="permissions[]" value="${k}" ${k === 'tickets' ? 'checked' : ''}> ${l}</label>`).join('')}
    <button class="btn" type="submit" style="margin-top:12px">Create staff login</button></form></div>
    <div class="card"><h3>Team</h3>${items.map((s) => { const p = JSON.parse(s.staff_permissions || '[]'); return `<div class="msg"><div class="row between"><strong>${esc(s.name)}</strong>${badge(s.status)}</div><div class="small muted">${esc(s.email)} · ${esc(s.phone)}</div>
      <form data-pf="${s.id}">${Object.entries(PERM_LABEL).map(([k, l]) => `<label class="chk small"><input type="checkbox" name="permissions[]" value="${k}" ${p.includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}<button class="btn ghost sm">Save permissions</button></form></div>`; }).join('') || '<p class="muted">No staff yet</p>'}</div></div>`;
  onSubmit(v, '#f', async (d) => { await api('/admin/staff', { method: 'POST', body: { ...d, permissions: d.permissions || [] } }); toast('Staff account created'); go('#/admin/staff'); });
  v.querySelectorAll('[data-pf]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const perms = [...f.querySelectorAll('input:checked')].map((i) => i.value);
    try { await api(`/admin/staff/${f.dataset.pf}/permissions`, { method: 'POST', body: { permissions: perms } }); toast('Permissions saved'); } catch (err) { toast(err.message, true); }
  }));
}, ADMIN);

// ---------- Coupons ----------
route('/admin/coupons', async () => {
  const v = shell('Coupons');
  const { items } = await api('/admin/coupons');
  v.innerHTML = `<div class="grid g2"><div class="card"><h3>Create / update coupon</h3><form id="f"><div class="grid g2"><div><label>Code</label><input name="code" required style="text-transform:uppercase"></div>
    <div><label>Type</label><select name="type"><option value="percent">% off</option><option value="flat">Flat ₹ off</option></select></div>
    <div><label>Value (% or ₹)</label><input name="value" type="number" min="1" required></div><div><label>Max discount (₹)</label><input name="max_discount" type="number" min="1"></div>
    <div><label>Min booking (₹)</label><input name="min_amount" type="number" min="0" value="0"></div><div><label>Total uses</label><input name="usage_limit" type="number" min="1" placeholder="Unlimited"></div>
    <div><label>Uses per user</label><input name="per_user_limit" type="number" min="1" value="1"></div><div><label>Expires on</label><input name="expires_at" type="date"></div></div>
    <button class="btn" type="submit" style="margin-top:12px">Save coupon</button></form></div>
    <div class="card table-wrap"><table><thead><tr><th>Code</th><th>Offer</th><th>Used</th><th>Expires</th><th></th></tr></thead><tbody>${items.map((c) => `<tr><td><code>${esc(c.code)}</code></td>
    <td class="small">${c.type === 'percent' ? c.value + '%' : rs(c.value)} off${c.max_discount ? ' (max ' + rs(c.max_discount) + ')' : ''}${c.min_amount ? ', min ' + rs(c.min_amount) : ''}</td><td>${c.used_count}${c.usage_limit ? '/' + c.usage_limit : ''}</td>
    <td class="small">${c.expires_at ? fmtDate(c.expires_at) : 'Never'}</td><td><button class="btn ghost sm" data-c="${esc(c.code)}">${c.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No coupons</td></tr>'}</tbody></table></div></div>`;
  onSubmit(v, '#f', async (d) => { await api('/admin/coupons', { method: 'POST', body: d }); toast('Coupon saved'); go('#/admin/coupons'); });
  act(v, '[data-c]', async (_e, el) => { await api(`/admin/coupons/${encodeURIComponent(el.dataset.c)}/toggle`, { method: 'POST' }); go('#/admin/coupons'); });
}, ADMIN);

// ---------- Ads ----------
route('/admin/ads', async () => {
  const v = shell('Advertisements');
  const { items } = await api('/admin/ads');
  v.innerHTML = `<div class="grid g2"><div class="card"><h3>Add an ad (direct sale)</h3><p class="small muted">For advertisers who paid you directly (schools, camps, stores). Goes live immediately.</p>
    <form id="f"><label>Title</label><input name="title" required maxlength="80"><label>Description</label><textarea name="body" maxlength="300"></textarea>
    <label>Link</label><input name="link" type="url" placeholder="https://"><label>Image</label><input name="image" type="file" accept="image/*">
    <div class="grid g2"><div><label>Placement</label><select name="placement"><option>home</option><option>search</option><option>community</option><option>dashboard</option></select></div>
    <div><label>Days</label><input name="days" type="number" min="1" max="365" value="30" required></div><div><label>Amount received (₹)</label><input name="price" type="number" min="0" value="0"></div></div>
    <button class="btn" type="submit" style="margin-top:12px">Publish ad</button></form></div>
    <div class="card"><h3>All ads</h3>${items.map((a) => `<div class="msg"><div class="row between"><strong>${esc(a.title)}</strong>${badge(a.status)}</div>
    <div class="small muted">${esc(a.advertiser || 'Direct')} · ${esc(a.placement)} · ${a.days} days · ${rs(a.price)} · 👁 ${a.impressions} · 🖱 ${a.clicks}${a.ends_at ? ' · ends ' + fmtDate(a.ends_at) : ''}</div>
    <div class="row" style="margin-top:6px">${a.status === 'pending' ? `<button class="btn ok sm" data-a="${a.id}" data-x="approve">Approve</button><button class="btn ghost sm" data-a="${a.id}" data-x="reject">Reject & refund</button>` : ''}
    ${a.status === 'active' ? `<button class="btn ghost sm" data-a="${a.id}" data-x="pause">Pause</button>` : ''}${a.status === 'paused' ? `<button class="btn ghost sm" data-a="${a.id}" data-x="resume">Resume</button>` : ''}</div></div>`).join('') || '<p class="muted">No ads</p>'}</div></div>`;
  onSubmit(v, '#f', async (_d, f) => { await api('/admin/ads', { method: 'POST', form: new FormData(f) }); toast('Ad published'); go('#/admin/ads'); });
  act(v, '[data-a]', async (_e, el) => { await api(`/admin/ads/${el.dataset.a}/decision`, { method: 'POST', body: { action: el.dataset.x } }); go('#/admin/ads'); });
}, A);

// ---------- Community moderation ----------
route('/admin/groups', async () => {
  const v = shell('Community groups');
  const { items } = await api('/admin/groups');
  v.innerHTML = `<div class="card table-wrap"><table><thead><tr><th>Group</th><th>Apartment</th><th>Creator</th><th>Tutor</th><th>Members</th><th>Fee</th><th>Held</th><th></th></tr></thead><tbody>
    ${items.map((g) => `<tr><td><a href="#/community/${g.id}">${esc(g.name)}</a><div class="small muted">${esc(catName(g.category))}</div></td><td class="small">${esc(g.apartment)}</td><td>${esc(g.creator)}</td><td>${esc(g.tutor || '–')}</td>
    <td>${g.members}/${g.max_members}</td><td>${rs(g.fee)}</td><td>${rs(g.escrow)}</td><td>${g.status !== 'closed' ? `<button class="btn ghost sm" data-g="${g.id}">Close</button>` : badge('closed')}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No groups</td></tr>'}</tbody></table></div>`;
  act(v, '[data-g]', async (_e, el) => { if (await confirmBox('Close this group? Members are refunded if no tutor was assigned.')) { await api(`/admin/groups/${el.dataset.g}/close`, { method: 'POST' }); go('#/admin/groups'); } });
}, A);

// ---------- Config ----------
route('/admin/config', async ({ query }) => {
  const v = shell('Config');
  const { items, email_configured, whatsapp_configured, admin_qr_image } = await api('/admin/config');
  const groups = [...new Set(items.map((i) => i.group))];
  const cur = groups.includes(query.tab) ? query.tab : groups[0];
  const field = (i) => {
    if (i.type === 'bool') return `<div class="row between" style="padding:10px 0;border-bottom:1px solid var(--line)"><div><strong>${esc(i.label)}</strong></div>
      <label class="switch"><input type="checkbox" name="${i.key}" ${i.value === '1' ? 'checked' : ''}><span class="t"></span></label></div>`;
    if (i.type === 'secret') return `<label>${esc(i.label)} ${i.is_set ? '<span class="badge ok">saved</span>' : '<span class="badge grey">not set</span>'}</label>
      <div class="row"><input type="password" name="${i.key}" autocomplete="new-password" placeholder="${i.is_set ? '•••••••• (leave blank to keep)' : ''}" style="flex:1">
      ${i.is_set ? `<button type="button" class="btn ghost sm" data-clear="${i.key}">Clear</button>` : ''}</div>`;
    if (i.type.startsWith('choice:')) return `<label>${esc(i.label)}</label><select name="${i.key}">${i.type.slice(7).split('|').map((o) => `<option ${o === i.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    const type = ['pct', 'int', 'num', 'rupees', 'count'].includes(i.type) ? 'number' : 'text';
    return `<label>${esc(i.label)}</label><input name="${i.key}" type="${type}" ${type === 'number' ? 'step="any" min="0"' : ''} value="${esc(i.value)}">`;
  };
  const help = {
    'Email (Hostinger)': `<div class="alert small">Hostinger: hPanel → Emails → create a mailbox (e.g. no-reply@yourdomain.in). Use server <b>smtp.hostinger.com</b>, port <b>465</b>, the full email as user and the mailbox password. Then turn on "Send emails" and send a test. ${email_configured ? '<span class="badge ok">configured</span>' : '<span class="badge warn">not configured</span>'}</div>`,
    Payments: '<div class="alert warn small">Online payments stay OFF until you add Razorpay keys and switch them on. Until then parents add money with your UPI QR, verified by staff in Payments.</div>',
    'Invoices & GST': '<div class="alert small">Commission % (in Business) is deducted from every class fee and shown on each tutor invoice. Turn on GST only after you have a GSTIN; it is then charged on the commission.</div>',
    WhatsApp: `<div class="alert warn small">WhatsApp alerts stay OFF until you switch them on. Setup: create a Meta Business account → WhatsApp Manager → add your business number → create a <b>Utility</b> message template named <b>edvitta_alert</b> with body <code>Edvitta: {{1}}</code> and wait for approval → copy the <b>Phone number ID</b> and a <b>permanent access token</b> here → send a test. Meta charges per message, so "important only" is recommended. Users can turn WhatsApp off in Account. ${whatsapp_configured ? '<span class="badge ok">configured</span>' : '<span class="badge warn">not configured</span>'}</div>`,
    Payouts: '<div class="alert small">Tutors earn into their wallet after every class. The weekly report (Admin → Payouts) lists each tutor\'s week. With automatic settlement on, every Monday last week\'s earnings become payout requests to the tutor\'s saved UPI; you still send the money and mark each one paid in Payments.</div>',
    Classes: '<div class="alert small">A class the tutor misses, or that nobody marks by the next day, gets a free make-up class at the end of the plan automatically. Holidays and leave days move classes the same way.</div>',
    'Privacy & calls': '<div class="alert small">With number masking on, parents and tutors never see each other\'s phone numbers. They talk through in-app chat (numbers typed in chat are hidden automatically) and, if you enable Exotel, masked calls.</div>',
  };
  v.innerHTML = `<div class="tabs">${groups.map((g) => `<a href="#/admin/config?tab=${encodeURIComponent(g)}" class="${g === cur ? 'on' : ''}">${esc(g)}</a>`).join('')}<a href="#/admin/config?tab=More" class="${query.tab === 'More' ? 'on' : ''}">QR & subjects</a></div>
    ${query.tab === 'More' ? '' : `<form id="f" class="card">${help[cur] || ''}${items.filter((i) => i.group === cur).map(field).join('')}
    <div class="row" style="margin-top:14px"><button class="btn" type="submit">Save ${esc(cur)}</button>${cur === 'Email (Hostinger)' ? '<input id="tto" type="email" placeholder="Send test to (email)" style="flex:1;min-width:180px"><button type="button" class="btn ghost" id="test">Send test email</button>' : ''}${cur === 'WhatsApp' ? '<input id="wto" inputmode="numeric" placeholder="Send test to (10-digit mobile)" style="flex:1;min-width:180px"><button type="button" class="btn ghost" id="wtest">Send test WhatsApp</button>' : ''}</div></form>`}
    ${query.tab === 'More' ? `<div class="grid g2"><div class="card"><h3>UPI QR image</h3><p class="small muted">Shown in users' wallets for manual payments. If none is uploaded, a QR is generated from your UPI ID.</p>
      ${admin_qr_image ? `<img src="${esc(admin_qr_image)}" alt="QR" style="width:160px;border-radius:10px">` : ''}<br><label class="btn ghost sm" style="margin-top:8px">Upload QR image<input type="file" accept="image/*" id="qr" hidden></label></div>
      <div class="card"><h3>Add subject / skill</h3><form id="c"><input name="name" placeholder="e.g. Violin" required><select name="grp" style="margin-top:8px">${['Academics', 'Arts', 'Music', 'Dance', 'Sports & Fitness', 'Languages', 'Technology', 'Other'].map((g) => `<option>${g}</option>`).join('')}</select>
      <input name="icon" placeholder="Emoji (optional)" maxlength="4" style="margin-top:8px"><button class="btn ghost" style="margin-top:8px">Add</button></form></div></div>` : ''}`;
  const f = v.querySelector('#f');
  if (f) f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const i of items.filter((x) => x.group === cur)) {
      const el = f.elements[i.key];
      if (!el) continue;
      body[i.key] = i.type === 'bool' ? (el.checked ? '1' : '0') : el.value;
    }
    try { await api('/admin/config', { method: 'POST', body }); state.config = await api('/config'); toast('Saved'); go('#/admin/config?tab=' + encodeURIComponent(cur)); } catch (err) { toast(err.message, true); }
  });
  act(v, '[data-clear]', async (_e, el) => { if (await confirmBox('Remove this saved secret?')) { await api('/admin/config', { method: 'POST', body: { clear_secrets: [el.dataset.clear] } }); go(location.hash); } });
  act(v, '#wtest', async () => { await api('/admin/config/test-whatsapp', { method: 'POST', body: { to: v.querySelector('#wto').value || undefined } }); toast('Test WhatsApp sent ✅'); });
  act(v, '#test', async () => { await api('/admin/config/test-email', { method: 'POST', body: { to: v.querySelector('#tto').value || undefined } }); toast('Test email sent ✅'); });
  onSubmit(v, '#c', async (d) => { await api('/admin/categories', { method: 'POST', body: d }); state.categories = (await api('/categories')).items; toast('Category added'); });
  v.querySelector('#qr')?.addEventListener('change', async (e) => { const fd = new FormData(); fd.append('qr', e.target.files[0]); try { await api('/admin/settings/qr', { method: 'POST', form: fd }); toast('QR updated'); go(location.hash); } catch (err) { toast(err.message, true); } });
}, ADMIN);
route('/admin/settings', () => go('#/admin/config'), ADMIN);

// ---------- Packages ----------
route('/admin/packages', async () => {
  const v = shell('Subscription packages');
  const { items } = await api('/admin/packages');
  v.innerHTML = `<div class="grid g2"><div class="card"><h3>New package</h3><form id="f"><label>Name</label><input name="name" required placeholder="e.g. Pro: 20 classes">
    <div class="grid g2"><div><label>Number of classes</label><input name="sessions" type="number" min="2" max="120" required value="20"></div>
    <div><label>Valid for (days)</label><input name="validity_days" type="number" min="7" max="365" value="30" required></div>
    <div><label>Discount (%)</label><input name="discount_percent" type="number" min="0" max="60" value="10" required></div></div>
    <label>Description</label><input name="description" maxlength="200"><button class="btn" type="submit" style="margin-top:12px">Create package</button></form>
    <p class="small muted">The package discount lowers the per-class fee. Your commission (Config) is still taken from each class.</p></div>
    <div class="card table-wrap"><table><thead><tr><th>Package</th><th>Classes</th><th>Validity</th><th>Discount</th><th></th></tr></thead><tbody>
    ${items.map((p) => `<tr><td><strong>${esc(p.name)}</strong><div class="small muted">${esc(p.description || '')}</div></td><td>${p.sessions}</td><td>${p.validity_days} days</td><td>${p.discount_percent}%</td>
    <td><button class="btn ghost sm" data-p="${p.id}">${p.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No packages</td></tr>'}</tbody></table></div></div>`;
  onSubmit(v, '#f', async (d) => { await api('/admin/packages', { method: 'POST', body: d }); toast('Package created'); go('#/admin/packages'); });
  act(v, '[data-p]', async (_e, el) => { await api(`/admin/packages/${el.dataset.p}/toggle`, { method: 'POST' }); go('#/admin/packages'); });
}, ADMIN);

// ---------- Invoices ----------
route('/admin/invoices', async ({ query }) => {
  const v = shell('Invoices & commission');
  const type = query.type === 'booking' ? 'booking' : 'commission';
  const d = await api(`/admin/invoices?type=${type}${query.month ? '&month=' + query.month : ''}`);
  v.innerHTML = `<div class="tabs"><a href="#/admin/invoices?type=commission" class="${type === 'commission' ? 'on' : ''}">Tutor commission invoices</a><a href="#/admin/invoices?type=booking" class="${type === 'booking' ? 'on' : ''}">Parent receipts</a></div>
    <div class="row" style="margin-bottom:10px"><select id="m" style="width:auto"><option value="">All months</option>${d.months.map((m) => `<option ${m === query.month ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
    <div class="grid g4">${type === 'commission' ? `<div class="card stat"><div class="n">${rs(d.totals.gross)}</div><div class="l">Class fees</div></div><div class="card stat"><div class="n">${rs(d.totals.commission)}</div><div class="l">Commission earned</div></div>
    <div class="card stat"><div class="n">${rs(d.totals.gst)}</div><div class="l">GST collected</div></div><div class="card stat"><div class="n">${rs(d.totals.net)}</div><div class="l">Paid to tutors</div></div>`
    : `<div class="card stat"><div class="n">${d.totals.n}</div><div class="l">Receipts</div></div><div class="card stat"><div class="n">${rs(d.totals.net)}</div><div class="l">Collected from parents</div></div>`}</div>
    <div class="card table-wrap"><table><thead><tr><th>Number</th><th>${type === 'commission' ? 'Tutor' : 'Parent'}</th><th>Date</th><th>Amount</th>${type === 'commission' ? '<th>Commission</th><th>GST</th><th>Net</th>' : ''}<th></th></tr></thead><tbody>
    ${d.items.map((i) => `<tr><td><code>${esc(i.number)}</code></td><td>${esc(i.name)}</td><td class="small">${fmtDate(i.created_at)}</td><td>${rs(i.gross)}</td>
    ${type === 'commission' ? `<td>${rs(i.commission)}</td><td>${rs(i.gst)}</td><td>${rs(i.net)}</td>` : ''}<td><a class="btn ghost sm" href="#/invoice/${i.id}">View</a></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No invoices yet</td></tr>'}</tbody></table></div>`;
  v.querySelector('#m').onchange = (e) => go(`#/admin/invoices?type=${type}${e.target.value ? '&month=' + e.target.value : ''}`);
}, A);

// ---------- Communication logs ----------
route('/admin/comms', async () => {
  const v = shell('Communication logs');
  const d = await api('/admin/comms');
  v.innerHTML = `<div class="card"><h3>Chat messages with hidden phone numbers or emails</h3><p class="small muted">Someone tried to share contact details in chat. Review for safety.</p><div class="table-wrap"><table><thead><tr><th>When</th><th>From</th><th>Booking</th><th>Message</th></tr></thead><tbody>
    ${d.flagged.map((m) => `<tr><td class="small">${fmtDT(m.created_at)}</td><td>${esc(m.name)}</td><td>#${m.booking_id}</td><td>${esc(m.body)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">None</td></tr>'}</tbody></table></div></div>
    <div class="card"><h3>Calls & video classes</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Booking</th><th>Type</th><th>Status</th><th>Ended</th></tr></thead><tbody>
    ${d.calls.map((c) => `<tr><td class="small">${fmtDT(c.started_at)}</td><td>${esc(c.name)}</td><td>#${c.booking_id}</td><td>${esc(c.kind.replace('_', ' '))}</td><td>${esc(c.status)}</td><td class="small">${c.ended_at ? fmtDT(c.ended_at) : '–'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">None</td></tr>'}</tbody></table></div></div>
    <div class="card"><h3>WhatsApp</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>To</th><th>Status</th></tr></thead><tbody>
    ${(d.whatsapp || []).map((m) => `<tr><td class="small">${fmtDT(m.created_at)}</td><td class="small">${esc(m.to_phone)}</td><td><span class="badge ${m.status === 'sent' ? 'ok' : 'bad'}">${esc(m.status)}</span>${m.error ? `<div class="small muted">${esc(m.error)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">None (WhatsApp alerts are off or nothing was sent yet)</td></tr>'}</tbody></table></div></div>
    <div class="card"><h3>Emails</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>
    ${d.emails.map((m) => `<tr><td class="small">${fmtDT(m.created_at)}</td><td class="small">${esc(m.to_email)}</td><td class="small">${esc(m.subject)}</td><td><span class="badge ${m.status === 'sent' ? 'ok' : m.status === 'failed' ? 'bad' : 'grey'}">${esc(m.status)}</span>${m.error ? `<div class="small muted">${esc(m.error)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">None</td></tr>'}</tbody></table></div></div>`;
}, A);

route('/admin/audit', async () => {
  const v = shell('Audit log');
  const { items } = await api('/admin/audit');
  v.innerHTML = `<div class="card table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>IP</th></tr></thead><tbody>${items.map((a) => `<tr><td class="small">${fmtDT(a.created_at)}</td><td>${esc(a.actor || '–')}</td><td><code>${esc(a.action)}</code></td><td class="small">${esc(a.target || '')}</td><td class="small muted">${esc(a.ip || '')}</td></tr>`).join('')}</tbody></table></div>`;
}, ADMIN);
