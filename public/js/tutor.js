import { state, api, route, go, esc, rs, fmtDate, toast, onSubmit, act, modal, confirmBox, catName, catIcon, badge, locationPicker, DAYS, todayLocal } from './core.js';
import { shell } from './layout.js';
import { bookingExtras, bindBookingExtras, attendanceCard, bindAttendance } from './features.js';
import { sos } from './parent.js';

const T = { roles: ['tutor'] };

// ---------- Live GPS sharing (tutor phone -> server -> parent) ----------
let watchId = null;
export function startSharing() {
  if (watchId !== null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(
    (p) => state.socket?.emit('location', { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    () => toast('Turn on location so the parent can track your arrival', true),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  toast('📍 Sharing live location with the parent');
}
export function stopSharing() { if (watchId !== null) navigator.geolocation.clearWatch(watchId); watchId = null; }

// ---------- Dashboard ----------
route('/tutor', async () => {
  const v = shell(`Hi ${state.user.name.split(' ')[0]} 👋`);
  const [{ profile: p }, { items: bookings }, w] = await Promise.all([api('/me/profile'), api('/bookings'), api('/wallet')]);
  const requests = bookings.filter((b) => b.status === 'requested');
  const active = bookings.filter((b) => b.status === 'accepted');
  const kycMsg = { not_submitted: ['warn', 'Upload your KYC documents to get verified and start receiving bookings.', '#/tutor/kyc', 'Upload KYC'],
    submitted: ['', '⏳ Your documents are under review. We usually verify within 24 hours.', null],
    rejected: ['bad', `KYC not approved: ${p.kyc_note || ''}. Please re-upload.`, '#/tutor/kyc', 'Fix KYC'] }[p.kyc_status];
  v.innerHTML = `${kycMsg ? `<div class="alert ${kycMsg[0]}">${esc(kycMsg[1])} ${kycMsg[2] ? `<a class="btn sm" href="${kycMsg[2]}">${kycMsg[3]}</a>` : ''}</div>` : ''}
    <div class="grid g3"><div class="card"><div class="row between"><div><strong>You are ${p.available ? 'online' : 'offline'}</strong><div class="small muted">${p.available ? 'Parents within 3 km can book you' : 'Go online to receive bookings'}</div></div>
      <label class="switch"><input type="checkbox" id="av" ${p.available ? 'checked' : ''} ${p.kyc_status !== 'approved' ? 'disabled' : ''}><span class="t"></span></label></div></div>
      <div class="card stat"><div class="n">${rs(w.balance)}</div><div class="l">Wallet balance · <a href="#/wallet">withdraw</a></div></div>
      <div class="card stat"><div class="n">${p.kyc_status === 'approved' && p.police_verification && p.background_check === 'clear' ? '🛡️ Verified' : badge(p.background_check)}</div><div class="l">Background check · <a href="#/tutor/earnings">earnings</a></div></div>
      <div class="card stat"><div class="n">⭐ ${p.rating_count ? (p.rating_sum / p.rating_count).toFixed(1) : 'New'}</div><div class="l">${p.rating_count} reviews</div></div></div>
    <h3>New requests (${requests.length})</h3>${requests.map(row).join('') || '<div class="card empty">No new requests</div>'}
    <h3>Active bookings</h3>${active.map(row).join('') || '<div class="card empty">No active bookings</div>'}`;
  v.querySelector('#av')?.addEventListener('change', async (e) => {
    try { await api('/me/availability', { method: 'POST', body: { available: e.target.checked } }); go('#/tutor'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message, true); }
  });
}, T);

const row = (b) => `<a class="card" style="display:block;color:inherit" href="#/tutor/bookings/${b.id}"><div class="row between"><strong>${catIcon(b.category)} ${esc(catName(b.category))} · ${esc(b.parent_name)}</strong>${badge(b.status)}</div>
  <div class="small muted">#${b.id} · ${b.mode === 'online' ? '💻 Online' : '🏠 Home'} · ${b.schedule_type} · from ${fmtDate(b.start_date)} at ${esc(b.time)} · ${b.done}/${b.total_sessions} done</div></a>`;

// ---------- Profile ----------
route('/tutor/profile', async () => {
  const v = shell('Teaching profile');
  const { profile: p } = await api('/me/profile');
  let loc = p.lat != null ? { lat: p.lat, lng: p.lng, address: p.address } : null;
  const groups = {};
  for (const c of state.categories) (groups[c.grp] ||= []).push(c);
  v.innerHTML = `<div class="card"><form id="f"><h3>What do you teach?</h3>${Object.entries(groups).map(([g, cs]) => `<div class="small muted" style="margin-top:8px">${esc(g)}</div><div>${cs.map((c) =>
    `<label class="chk"><input type="checkbox" name="categories[]" value="${c.slug}" ${p.categories.includes(c.slug) ? 'checked' : ''}> ${c.icon} ${esc(c.name)}</label>`).join('')}</div>`).join('')}
    <div class="grid g2"><div><label>Fee per hour (₹)</label><input name="rate_per_session" type="number" min="50" max="20000" value="${p.rate_per_session / 100}" required></div>
    <div><label>Teaching mode</label><select name="mode">${[['both', 'Home & online'], ['offline', 'Home tuition only'], ['online', 'Online only']].map(([k, l]) => `<option value="${k}" ${p.mode === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div><label>Experience (years)</label><input name="experience_years" type="number" min="0" max="60" value="${p.experience_years}"></div>
    <div><label>Highest qualification / certification</label><input name="qualification" value="${esc(p.qualification)}"></div>
    <div><label>Gender</label><select name="gender">${['', 'female', 'male', 'other'].map((g) => `<option value="${g}" ${p.gender === g ? 'selected' : ''}>${g || 'Prefer not to say'}</option>`).join('')}</select></div></div>
    <label>About you</label><textarea name="bio" maxlength="1000">${esc(p.bio)}</textarea>
    <div class="grid g2"><div><label class="chk" style="margin-top:14px"><input type="checkbox" name="offers_trial" value="1" ${p.offers_trial ? 'checked' : ''}> Offer a trial / demo class to new students</label></div>
    <div><label>Trial class fee (₹, 0 = free)</label><input name="trial_fee" type="number" min="0" max="5000" value="${p.trial_fee / 100}"></div>
    <div><label>PAN (for invoices)</label><input name="pan_number" maxlength="10" value="${esc(p.pan_number || '')}" style="text-transform:uppercase"></div>
    <div><label>GSTIN (optional)</label><input name="gstin" maxlength="15" value="${esc(p.gstin || '')}" style="text-transform:uppercase"></div></div>
    <label>Your base location (parents within 3 km of this point can find you)</label><div id="lp"></div>
    <button class="btn" type="submit" style="margin-top:12px">Save profile</button></form></div>`;
  locationPicker(v.querySelector('#lp'), loc, (x) => (loc = x));
  onSubmit(v, '#f', async (d) => {
    if (!loc) throw new Error('Set your location on the map');
    await api('/me/profile', { method: 'PUT', body: { ...d, offers_trial: !!d.offers_trial, categories: d.categories || [], lat: loc.lat, lng: loc.lng, address: loc.address || p.address } });
    toast('Profile saved'); go(p.kyc_status === 'approved' ? '#/tutor' : '#/tutor/kyc');
  });
}, T);

// ---------- KYC ----------
const DOC_LABEL = { aadhaar_front: 'Aadhaar (front)', aadhaar_back: 'Aadhaar (back)', pan: 'PAN card', photo: 'Your clear photo (selfie)',
  qualification: 'Qualification certificate', police_verification: 'Police verification certificate', address_proof: 'Address proof' };
route('/tutor/kyc', async () => {
  const v = shell('KYC verification');
  const { profile: p, docs, kyc_types, required } = await api('/me/profile');
  const have = Object.fromEntries(docs.map((d) => [d.doc_type, d]));
  const locked = p.kyc_status === 'approved' || p.kyc_status === 'submitted';
  v.innerHTML = `<div class="alert ${p.kyc_status === 'approved' ? 'ok' : p.kyc_status === 'rejected' ? 'bad' : ''}">Status: ${badge(p.kyc_status)}
    ${p.kyc_status === 'rejected' ? `<div>Reason: ${esc(p.kyc_note || '')}</div>` : ''}
    <div class="small" style="margin-top:4px">Because Edvitta tutors work with children, every tutor's identity is verified by our team. Your documents are stored privately and only visible to authorised verification staff.</div></div>
    <div class="card"><div class="table-wrap"><table><tbody>${kyc_types.map((t) => `<tr><td><strong>${DOC_LABEL[t]}</strong>${required.includes(t) ? ' <span class="badge warn">required</span>' : ' <span class="badge grey">optional</span>'}</td>
    <td>${have[t] ? '✅ Uploaded' : '<span class="muted">Not uploaded</span>'}</td>
    <td>${locked ? '' : `<label class="btn ghost sm">${have[t] ? 'Replace' : 'Upload'}<input type="file" accept="image/*,application/pdf" data-t="${t}" hidden></label>`}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted">JPG, PNG or PDF up to 5 MB. Make sure all text is readable.</p>
    ${!locked ? '<button class="btn" id="sub">Submit for verification</button>' : ''}</div>`;
  v.querySelectorAll('input[type=file]').forEach((inp) => inp.addEventListener('change', async () => {
    const fd = new FormData(); fd.append('doc_type', inp.dataset.t); fd.append('file', inp.files[0]);
    try { await api('/me/kyc', { method: 'POST', form: fd }); toast('Uploaded'); go('#/tutor/kyc'); } catch (e) { toast(e.message, true); }
  }));
  act(v, '#sub', async () => { await api('/me/kyc/submit', { method: 'POST' }); toast('Submitted for verification'); go('#/tutor/kyc'); });
}, T);

// ---------- Bookings ----------
route('/tutor/bookings', async () => {
  const v = shell('Bookings');
  const { items } = await api('/bookings');
  v.innerHTML = items.map(row).join('') || '<div class="card empty">No bookings yet. Stay online to get requests.</div>';
}, T);

route('/tutor/bookings/:id', async ({ params }) => {
  const v = shell(`Booking #${params.id}`);
  const { booking: b } = await api('/bookings/' + params.id);
  const live = b.sessions.find((s) => ['on_the_way', 'in_progress'].includes(s.status));
  if (live && b.mode === 'offline') startSharing();
  const next = b.sessions.find((s) => ['scheduled', 'on_the_way', 'in_progress'].includes(s.status));
  const mapsLink = b.lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}` : null;
  v.innerHTML = `<div class="grid g2"><div class="card"><div class="row between"><h2>${catIcon(b.category)} ${esc(catName(b.category))}</h2>${badge(b.status)}</div>
    <dl class="kv"><dt>Parent</dt><dd>${esc(b.parent.name)} ${b.parent.phone ? `· <a href="tel:${esc(b.parent.phone)}">📞 ${esc(b.parent.phone)}</a>` : ''}</dd>
    <dt>Student</dt><dd>${esc(b.child?.name || '')} ${b.child?.grade ? '· ' + esc(b.child.grade) : ''} ${b.child?.age ? '· ' + b.child.age + ' yrs' : ''}</dd>
    <dt>Mode</dt><dd>${b.mode === 'online' ? '💻 Online' : '🏠 Home: ' + esc(b.address || '')} ${mapsLink ? `<a href="${mapsLink}" target="_blank" rel="noopener">Directions ↗</a>` : ''}</dd>
    <dt>Schedule</dt><dd>${b.is_trial ? '🎁 Trial class · ' : ''}${b.package ? '📦 ' + esc(b.package.name) + ' · ' : ''}${esc(b.schedule_type)}${b.days.length ? ' (' + b.days.map((d) => DAYS[d]).join(', ') + ')' : ''} · ${esc(b.time)} · ${b.duration_min} min</dd>
    <dt>Dates</dt><dd>${fmtDate(b.start_date)} → ${fmtDate(b.end_date)} (${b.total_sessions} sessions)</dd><dt>Your rate</dt><dd>${rs(b.rate)} / session</dd>
    <dt>Notes</dt><dd>${esc(b.notes || '-')}</dd></dl>
    ${b.status === 'requested' ? `<hr>${b.mode === 'online' ? '<label>Online class link (Google Meet / Zoom)</label><input id="link" placeholder="https://meet.google.com/...">' : ''}
      <div class="row" style="margin-top:10px"><button class="btn ok" id="acc">Accept</button><button class="btn ghost" id="rej">Decline</button></div>` : ''}
    ${b.status === 'accepted' && b.mode === 'online' ? `<hr><form id="lk"><label>Online class link</label><div class="row"><input name="meeting_link" value="${esc(b.meeting_link || '')}" placeholder="https://meet.google.com/..." style="flex:1"><button class="btn sm" type="submit">${b.meeting_link ? 'Update' : 'Send link'}</button></div></form>
      ${b.meeting_link ? `<a class="btn ok" style="margin-top:8px" href="${esc(b.meeting_link)}" target="_blank" rel="noopener noreferrer">🎥 Open class</a>` : ''}` : ''}
    <div class="row" style="margin-top:12px">${['requested', 'accepted'].includes(b.status) ? '<button class="btn ghost" id="cancel">Cancel booking</button>' : ''}<button class="btn sos" id="sos">🚨 SOS</button></div></div>
    <div class="card"><h3>${next ? 'Next session: ' + fmtDate(next.date) : 'Sessions'}</h3>
    ${next && b.status === 'accepted' ? sessionActions(b, next) : '<p class="muted">No upcoming sessions</p>'}
    ${live && b.mode === 'offline' ? '<div class="alert ok small" style="margin-top:10px">📍 Your live location is being shared with this parent. Keep this app open while travelling.</div>' : ''}</div></div>
    ${b.status !== 'requested' ? bookingExtras(b) : ''}
    ${attendanceCard(b)}`;

  bindBookingExtras(v, b, () => go('#/tutor/bookings/' + b.id));
  bindAttendance(v, b, () => go('#/tutor/bookings/' + b.id));
  act(v, '#acc', async () => { await api(`/bookings/${b.id}/respond`, { method: 'POST', body: { accept: true, meeting_link: v.querySelector('#link')?.value || undefined } }); toast('Booking accepted'); go('#/tutor/bookings/' + b.id); });
  act(v, '#rej', async () => { if (await confirmBox('Decline this booking? The parent gets a full refund.', 'Decline')) { await api(`/bookings/${b.id}/respond`, { method: 'POST', body: { accept: false } }); go('#/tutor/bookings'); } });
  act(v, '#cancel', async () => { if (await confirmBox('Cancel this booking? Frequent cancellations affect your rating.', 'Cancel booking')) { await api(`/bookings/${b.id}/cancel`, { method: 'POST' }); go('#/tutor/bookings/' + b.id); } });
  act(v, '#sos', () => sos(b.id));
  onSubmit(v, '#lk', async (d) => { await api(`/bookings/${b.id}/link`, { method: 'POST', body: d }); toast('Link shared with parent'); go('#/tutor/bookings/' + b.id); });
  act(v, '[data-s]', async (_e, el) => {
    const sid = el.dataset.id, step = el.dataset.s;
    if (step === 'otw') { await api(`/sessions/${sid}/on-the-way`, { method: 'POST' }); startSharing(); }
    if (step === 'start') {
      return modal(`<h3>Enter start code</h3><p class="small muted">Ask the parent for the 4-digit code shown in their app.</p><form id="o"><input name="otp" inputmode="numeric" maxlength="4" pattern="\\d{4}" required class="otp" style="text-align:center">
        <button class="btn block" type="submit" style="margin-top:10px">Start session</button></form>`,
      (m, close) => onSubmit(m, '#o', async (d) => { await api(`/sessions/${sid}/start`, { method: 'POST', body: d }); close(); toast('Session started'); go('#/tutor/bookings/' + b.id); }));
    }
    if (step === 'start-online') await api(`/sessions/${sid}/start`, { method: 'POST' });
    if (step === 'done') { const r = await api(`/sessions/${sid}/complete`, { method: 'POST' }); stopSharing(); toast(`Session completed. ${rs(r.payout)} added to your wallet.`); }
    go('#/tutor/bookings/' + b.id);
  });
}, T);

function sessionActions(b, s) {
  const today = todayLocal();
  if (s.date > today && s.status === 'scheduled') return `<p class="muted">Scheduled for ${fmtDate(s.date)} at ${esc(b.time)}.</p>`;
  if (b.mode === 'online') {
    return s.status === 'in_progress' ? `<button class="btn ok block" data-s="done" data-id="${s.id}">✅ Mark session complete</button>`
      : `<button class="btn block" data-s="start-online" data-id="${s.id}">▶ Start online session</button>`;
  }
  if (s.status === 'scheduled') return `<button class="btn block" data-s="otw" data-id="${s.id}">🛵 I'm on the way (share live location)</button>
    <button class="btn ghost block" style="margin-top:8px" data-s="start" data-id="${s.id}">I've arrived: enter start code</button>`;
  if (s.status === 'on_the_way') return `<button class="btn block" data-s="start" data-id="${s.id}">📍 I've arrived: enter start code</button>`;
  return `<button class="btn ok block" data-s="done" data-id="${s.id}">✅ Mark session complete</button>`;
}
