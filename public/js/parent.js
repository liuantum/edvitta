import { state, api, route, go, esc, rs, fmtDate, fmtDT, toast, onSubmit, act, modal, confirmBox, catName, catIcon, badge, adSlot,
  locationPicker, myLocation, geocode, makeMap, pinIcon, initials, DAYS, onLeave } from './core.js';
import { shell } from './layout.js';
import { bookingExtras, bindBookingExtras, attendanceCard, bindAttendance } from './features.js';

const P = { roles: ['parent'] };
const LOC_KEY = 'edv_parent_loc';
const savedLoc = () => { try { return JSON.parse(localStorage.getItem(LOC_KEY)); } catch { return null; } };
const saveLoc = (l) => { try { localStorage.setItem(LOC_KEY, JSON.stringify(l)); } catch { /* */ } };

// ---------- Home ----------
route('/parent', async () => {
  const v = shell(`Hi ${state.user.name.split(' ')[0]} 👋`);
  const [{ items: bookings }, { items: kids }] = await Promise.all([api('/bookings'), api('/children')]);
  const active = bookings.filter((b) => ['requested', 'accepted'].includes(b.status));
  v.innerHTML = `${!kids.length ? '<div class="alert warn">👧 <a href="#/parent/children">Add your child</a> to start booking tutors.</div>' : ''}
    <div class="card" style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff"><h2>What should your child learn?</h2>
    <div class="row"><a class="btn warn" href="#/parent/find?mode=offline">🏠 Home tutor (within 3 km)</a><a class="btn ghost" style="color:#fff;border-color:rgba(255,255,255,.5)" href="#/parent/find?mode=online">💻 Online class</a></div>
    <p class="small" style="margin-top:8px;opacity:.9">Wallet balance: <strong>${rs(state.user.wallet_balance)}</strong> · <a style="color:#fde68a" href="#/wallet">Add money</a></p></div>
    <div id="ad"></div>
    <h3>Popular</h3><div class="grid g4" style="margin-bottom:16px">${state.categories.slice(0, 12).map((c) => `<a class="cat" href="#/parent/find?category=${c.slug}"><span class="e">${c.icon}</span>${esc(c.name)}</a>`).join('')}</div>
    <h3>Active bookings</h3>${active.map(bookingRow).join('') || '<div class="card empty">No active bookings. Find a tutor to get started.</div>'}`;
  v.querySelector('#ad').innerHTML = await adSlot('dashboard');
}, P);

const bookingRow = (b) => `<a class="card" style="display:block;color:inherit" href="#/parent/bookings/${b.id}"><div class="row between"><strong>${catIcon(b.category)} ${esc(catName(b.category))} with ${esc(b.tutor_name)}</strong>${badge(b.status)}</div>
  <div class="small muted">#${b.id} · ${b.mode === 'online' ? '💻 Online' : '🏠 Home'} · ${b.schedule_type} · ${fmtDate(b.start_date)}${b.end_date !== b.start_date ? ' → ' + fmtDate(b.end_date) : ''} at ${esc(b.time)} · ${b.done}/${b.total_sessions} done · ${rs(b.amount)}</div></a>`;

// ---------- Children ----------
route('/parent/children', async () => {
  const v = shell('My children');
  const { items } = await api('/children');
  v.innerHTML = `<div class="grid g2"><div class="card"><h3>Add a child</h3><form id="f"><label>Name</label><input name="name" required maxlength="60">
    <div class="grid g2"><div><label>Class / level</label><input name="grade" placeholder="e.g. Class 4, Beginner"></div><div><label>Age</label><input name="age" type="number" min="2" max="20"></div></div>
    <button class="btn" type="submit" style="margin-top:12px">Add child</button></form><p class="small muted">Only your child's first initial and class are shown to tutors until you confirm a booking.</p></div>
    <div class="card"><h3>Children</h3>${items.map((c) => `<div class="row between" style="padding:6px 0"><div class="row"><div class="avatar sm">${esc(initials(c.name))}</div><div><strong>${esc(c.name)}</strong><div class="small muted">${esc(c.grade || '')} ${c.age ? '· ' + c.age + ' yrs' : ''}</div></div></div>
    <button class="btn ghost sm" data-del="${c.id}">Remove</button></div>`).join('') || '<p class="muted">No children added</p>'}</div></div>`;
  onSubmit(v, '#f', async (d) => { await api('/children', { method: 'POST', body: d }); toast('Child added'); go('#/parent/children'); });
  act(v, '[data-del]', async (_e, el) => { if (await confirmBox('Remove this child?')) { await api('/children/' + el.dataset.del, { method: 'DELETE' }); go('#/parent/children'); } });
}, P);

// ---------- Find tutors ----------
route('/parent/find', async ({ query }) => {
  const v = shell('Find tutors');
  const mode = query.mode === 'online' ? 'online' : 'offline';
  let category = query.category || '';
  let loc = savedLoc();
  v.innerHTML = `<div class="tabs"><a href="#/parent/find?mode=offline${category ? '&category=' + category : ''}" class="${mode === 'offline' ? 'on' : ''}">🏠 Home tuition</a>
    <a href="#/parent/find?mode=online${category ? '&category=' + category : ''}" class="${mode === 'online' ? 'on' : ''}">💻 Online</a></div>
    <div class="card"><div class="row"><select id="cat" style="flex:1;min-width:200px"><option value="">All subjects & skills</option>${state.categories.map((c) => `<option value="${c.slug}" ${c.slug === category ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('')}</select>
    ${mode === 'offline' ? `<input id="area" placeholder="Your area / apartment" style="flex:1;min-width:180px"><button class="btn ghost" id="me">📍 Use my location</button>` : ''}</div>
    ${mode === 'offline' ? `<p class="small muted" id="locl" style="margin:8px 0 0">${loc ? '📍 ' + esc(loc.address || 'Saved location') : 'Set your location to see tutors within 3 km.'}</p>` : ''}</div>
    <div id="ad"></div>${mode === 'offline' ? '<div class="map" id="map" style="margin-bottom:14px"></div>' : ''}<div id="list"></div>`;
  let map, layer;
  if (mode === 'offline') { map = makeMap(v.querySelector('#map'), loc || undefined, 14); if (map) layer = L.layerGroup().addTo(map); }
  const load = async () => {
    const list = v.querySelector('#list');
    if (mode === 'offline' && !loc) { list.innerHTML = '<div class="card empty">📍 Set your location to find home tutors near you.</div>'; return; }
    list.innerHTML = '<div class="empty">Searching…</div>';
    const qs = new URLSearchParams({ mode, ...(category && { category }), ...(loc && { lat: loc.lat, lng: loc.lng }) });
    const { items, radius_km } = await api('/tutors?' + qs);
    if (map && loc) {
      layer.clearLayers();
      L.marker([loc.lat, loc.lng], { icon: pinIcon('🏠', '#f59e0b') }).addTo(layer);
      L.circle([loc.lat, loc.lng], { radius: radius_km * 1000, color: '#4f46e5', fillOpacity: 0.05 }).addTo(layer);
      map.setView([loc.lat, loc.lng], 14);
    }
    list.innerHTML = `<p class="muted small">${items.length} verified tutor${items.length === 1 ? '' : 's'} ${mode === 'offline' ? `within ${radius_km} km` : 'available online'}</p>` +
      (items.map((t) => `<div class="card"><div class="tutor"><div class="avatar">${esc(initials(t.name))}</div><div style="flex:1">
      <div class="row between"><strong>${esc(t.name)}</strong><strong>${rs(t.rate_per_session)}<span class="small muted">/hr</span></strong></div>
      <div class="small muted">${t.distance_km != null ? `📍 ${t.distance_km} km · ` : ''}⭐ ${t.rating ?? 'New'} ${t.reviews ? `(${t.reviews})` : ''} · ${t.experience_years} yrs · ${esc(t.qualification)}</div>
      <div class="row small" style="margin:6px 0">${t.fully_verified ? '<span class="badge ok">🛡️ Verified</span>' : '<span class="badge ok">✔ KYC verified</span>'}${t.police_verified ? '<span class="badge ok">✔ Police verified</span>' : ''}${t.background_clear ? '<span class="badge ok">✔ Background checked</span>' : ''}${t.offers_trial ? `<span class="badge warn">${t.trial_fee ? 'Trial ' + rs(t.trial_fee) : 'Free trial'}</span>` : ''}${t.categories.slice(0, 4).map((c) => `<span class="badge">${catIcon(c)} ${esc(catName(c))}</span>`).join('')}</div>
      <a class="btn sm" href="#/parent/tutor/${t.id}?mode=${mode}${category ? '&category=' + category : ''}">View & book</a></div></div></div>`).join('') || '<div class="card empty">No tutors found. Try another subject or check back soon.</div>');
  };
  const setLoc = async (p) => { loc = p; saveLoc(p); const l = v.querySelector('#locl'); if (l) l.textContent = '📍 ' + (p.address || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`); await load(); };
  v.querySelector('#cat').onchange = (e) => { category = e.target.value; load(); };
  act(v, '#me', async () => setLoc(await myLocation()));
  v.querySelector('#area')?.addEventListener('keydown', async (e) => { if (e.key === 'Enter') { try { const r = await geocode(e.target.value); await setLoc({ lat: r.lat, lng: r.lng, address: r.label }); } catch (err) { toast(err.message, true); } } });
  v.querySelector('#ad').innerHTML = await adSlot('search');
  load();
}, P);

// ---------- Tutor profile + booking ----------
route('/parent/tutor/:id', async ({ params, query }) => {
  const v = shell('Book a session');
  const [{ tutor: t, reviews }, { items: kids }, { items: coupons }, { items: packages }] = await Promise.all([api('/tutors/' + params.id), api('/children'), api('/coupons/available'), api('/packages')]);
  const modes = t.mode === 'both' ? ['offline', 'online'] : [t.mode];
  let loc = savedLoc();
  const today = new Date().toISOString().slice(0, 10);
  v.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))"><div class="card"><div class="tutor"><div class="avatar">${esc(initials(t.name))}</div><div>
    <h2 style="margin:0">${esc(t.name)}</h2><div class="small muted">⭐ ${t.rating ?? 'New'} (${t.reviews}) · ${t.experience_years} yrs · ${esc(t.qualification)} ${t.area ? '· ' + esc(t.area) : ''}</div>
    <div class="row small" style="margin-top:6px">${t.fully_verified ? '<span class="badge ok">🛡️ Verified</span>' : '<span class="badge ok">✔ KYC verified</span>'}${t.police_verified ? '<span class="badge ok">✔ Police verified</span>' : ''}${t.background_clear ? '<span class="badge ok">✔ Background checked</span>' : ''}<span class="badge">${t.mode === 'both' ? 'Home & online' : t.mode}</span></div></div></div>
    <p style="margin-top:12px">${esc(t.bio)}</p><div class="pills">${t.categories.map((c) => `<span class="badge">${catIcon(c)} ${esc(catName(c))}</span>`).join('')}</div>
    <hr><h3>Reviews</h3>${reviews.map((r) => `<div class="msg"><strong>${'⭐'.repeat(r.rating)}</strong> <span class="small muted">${esc(r.name.split(' ')[0])} · ${fmtDate(r.created_at)}${r.punctuality ? ' · Punctuality ' + r.punctuality + '/5' : ''}${r.teaching ? ' · Teaching ' + r.teaching + '/5' : ''}</span><div class="msg-body">${esc(r.comment || '')}</div></div>`).join('') || '<p class="muted small">No reviews yet</p>'}</div>
    <div class="card"><h3>Book ${esc(t.name.split(' ')[0])} · ${rs(t.rate_per_session)}/hr</h3>
    ${!kids.length ? '<div class="alert warn"><a href="#/parent/children">Add your child</a> first.</div>' : ''}
    <form id="bk"><label>Child</label><select name="child_id" required>${kids.map((k) => `<option value="${k.id}">${esc(k.name)} ${k.grade ? '(' + esc(k.grade) + ')' : ''}</option>`).join('')}</select>
    <label>Subject / skill</label><select name="category">${t.categories.map((c) => `<option value="${c}" ${c === query.category ? 'selected' : ''}>${esc(catName(c))}</option>`).join('')}</select>
    <label>Mode</label><div class="pills">${modes.map((m) => `<label class="pill"><input type="radio" name="mode" value="${m}" ${(query.mode || modes[0]) === m || modes.length === 1 ? 'checked' : ''}> ${m === 'online' ? '💻 Online' : '🏠 Home'}</label>`).join('')}</div>
    <label>Plan</label><div class="pills"><label class="pill"><input type="radio" name="plan" value="" ${query.plan !== 'trial' ? 'checked' : ''}> Pay per class</label>
      ${packages.length ? '<label class="pill"><input type="radio" name="plan" value="package"> 📦 Package</label>' : ''}
      ${t.offers_trial ? `<label class="pill"><input type="radio" name="plan" value="trial" ${query.plan === 'trial' ? 'checked' : ''}> 🎁 ${t.trial_fee ? 'Trial class ' + rs(t.trial_fee) : 'Free trial'}</label>` : ''}</div>
    <div id="pkgw" style="display:none"><label>Package</label><select name="package_id">${packages.map((p) => `<option value="${p.id}">${esc(p.name)} · ${p.discount_percent}% off · valid ${p.validity_days} days</option>`).join('')}</select></div>
    <div id="schw"><label>Schedule</label><div class="pills">${[['once', 'One session'], ['daily', 'Daily'], ['custom', 'Custom days']].map(([k, l], i) => `<label class="pill" data-st="${k}"><input type="radio" name="schedule_type" value="${k}" ${i === 1 ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
    <div id="daysw" style="display:none"><label>Days of the week</label><div class="pills">${DAYS.map((d, i) => `<label class="pill"><input type="checkbox" name="days[]" value="${i}" ${[1, 3, 5].includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div></div>
    <div class="grid g2"><div><label>Start date</label><input type="date" name="start_date" min="${today}" value="${today}" required></div>
    <div id="endw"><label>End date</label><input type="date" name="end_date" min="${today}" value="${new Date(Date.now() + 29 * 86400000).toISOString().slice(0, 10)}"></div>
    <div><label>Time</label><input type="time" name="time" value="17:00" required></div>
    <div><label>Duration</label><select name="duration_min">${[30, 45, 60, 90, 120].map((m) => `<option value="${m}" ${m === 60 ? 'selected' : ''}>${m} min</option>`).join('')}</select></div></div>
    <div id="addrw"><label>Home address for classes</label><input name="address" placeholder="Flat no, building, street" value="${esc(loc?.address || '')}"><div id="lp" style="margin-top:8px"></div></div>
    <label>Notes for tutor (optional)</label><textarea name="notes" maxlength="500" placeholder="Syllabus, goals, anything the tutor should know"></textarea>
    <label>Coupon</label><div class="row"><input name="coupon" placeholder="Coupon code" style="flex:1">${coupons.slice(0, 3).map((c) => `<button type="button" class="pill" data-cp="${esc(c.code)}">${esc(c.code)}</button>`).join('')}</div>
    <div class="card" id="quote" style="margin-top:12px;background:var(--bg)"><span class="muted small">Fill the details to see the price</span></div>
    <button class="btn block" type="submit" ${kids.length ? '' : 'disabled'}>Confirm & pay from wallet</button>
    <p class="small muted center">Money is held safely and paid to the tutor only after each completed session. Cancel anytime for a refund of remaining sessions.</p></form></div></div>`;
  const f = v.querySelector('#bk');
  let pickerReady = false;
  const sync = () => {
    const plan = f.plan.value;
    if (plan === 'package' && f.schedule_type.value === 'once') f.querySelector('input[name=schedule_type][value=daily]').checked = true;
    v.querySelector('#pkgw').style.display = plan === 'package' ? '' : 'none';
    v.querySelector('#schw').style.display = plan === 'trial' ? 'none' : '';
    f.querySelector('[data-st=once]').style.display = plan === 'package' ? 'none' : '';
    const st = plan === 'trial' ? 'once' : f.schedule_type.value, mode = f.mode.value;
    v.querySelector('#daysw').style.display = st === 'custom' ? '' : 'none';
    v.querySelector('#endw').style.display = st === 'once' || plan === 'package' ? 'none' : '';
    v.querySelector('#addrw').style.display = mode === 'offline' ? '' : 'none';
    if (mode === 'offline' && !pickerReady) { pickerReady = true; locationPicker(v.querySelector('#lp'), loc, (p) => { loc = { ...loc, ...p }; if (p.address && !f.address.value) f.address.value = p.address; }); }
    f.querySelectorAll('.pill').forEach((p) => { const i = p.querySelector('input'); if (i) p.classList.toggle('on', i.checked); });
  };
  const body = () => { const d = Object.fromEntries(new FormData(f)); d.days = [...f.querySelectorAll('[name="days[]"]:checked')].map((x) => +x.value); delete d['days[]'];
    if (d.mode === 'offline' && loc) { d.lat = loc.lat; d.lng = loc.lng; } d.tutor_id = t.id; if (!d.coupon) delete d.coupon;
    if (d.plan === 'trial') { d.schedule_type = 'trial'; delete d.coupon; } if (d.plan !== 'package') delete d.package_id; delete d.plan; return d; };
  let qt;
  const quote = () => { clearTimeout(qt); qt = setTimeout(async () => {
    const box = v.querySelector('#quote');
    try { const qd = await api('/bookings/quote', { method: 'POST', body: body() });
      box.innerHTML = `${qd.is_trial ? '<div class="small" style="color:var(--ok)">🎁 Trial class: try the tutor before booking a plan</div>' : ''}
      ${qd.package ? `<div class="small" style="color:var(--ok)">📦 ${esc(qd.package.name)}: ${qd.package.discount_percent}% off (${rs(qd.base_rate)} → ${rs(qd.rate)} per class), last class ${fmtDate(qd.end_date)}</div>` : ''}
      <div class="row between"><span>${qd.sessions} session${qd.sessions > 1 ? 's' : ''} × ${rs(qd.rate)}</span><span>${rs(qd.gross)}</span></div>
      ${qd.discount ? `<div class="row between" style="color:var(--ok)"><span>Coupon discount</span><span>−${rs(qd.discount)}</span></div>` : ''}
      <div class="row between" style="font-weight:800;font-size:1.1rem"><span>Total</span><span>${rs(qd.amount)}</span></div>
      <div class="small ${qd.wallet_balance < qd.amount ? '' : 'muted'}" style="${qd.wallet_balance < qd.amount ? 'color:var(--bad)' : ''}">Wallet: ${rs(qd.wallet_balance)}${qd.wallet_balance < qd.amount ? ' · <a href="#/wallet">Add money</a>' : ''}</div>`;
    } catch (e) { box.innerHTML = `<span class="small" style="color:var(--bad)">${esc(e.message)}</span>`; }
  }, 350); };
  f.addEventListener('change', () => { sync(); quote(); });
  f.addEventListener('input', quote);
  act(v, '[data-cp]', (_e, el) => { f.coupon.value = el.dataset.cp; quote(); });
  sync(); quote();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const d = body(); if (loc) saveLoc(loc);
      const { id } = await api('/bookings', { method: 'POST', body: d });
      toast('Booking sent! The tutor will confirm shortly.'); go('#/parent/bookings/' + id);
    } catch (err) { toast(err.message, true); }
  });
}, P);

// ---------- Bookings ----------
route('/parent/bookings', async () => {
  const v = shell('My bookings');
  const { items } = await api('/bookings');
  v.innerHTML = items.map(bookingRow).join('') || '<div class="card empty">No bookings yet. <a href="#/parent/find">Find a tutor</a></div>';
}, P);

route('/parent/bookings/:id', async ({ params }) => {
  const v = shell(`Booking #${params.id}`);
  const { booking: b } = await api('/bookings/' + params.id);
  const live = b.sessions.find((s) => ['on_the_way', 'in_progress'].includes(s.status));
  const next = b.sessions.find((s) => ['scheduled', 'on_the_way', 'in_progress'].includes(s.status));
  const canReview = false;
  v.innerHTML = `<div class="grid g2"><div class="card"><div class="row between"><h2>${catIcon(b.category)} ${esc(catName(b.category))}</h2>${badge(b.status)}</div>
    <dl class="kv"><dt>Tutor</dt><dd>${esc(b.tutor.name)} ${b.tutor.phone ? `· <a href="tel:${esc(b.tutor.phone)}">📞 ${esc(b.tutor.phone)}</a>` : ''}</dd><dt>Child</dt><dd>${esc(b.child?.name || '')}</dd>
    <dt>Mode</dt><dd>${b.mode === 'online' ? '💻 Online' : '🏠 Home: ' + esc(b.address || '')}</dd><dt>Schedule</dt><dd>${b.is_trial ? '🎁 Trial class · ' : ''}${b.package ? '📦 ' + esc(b.package.name) + ' · ' : ''}${esc(b.schedule_type)}${b.days.length ? ' (' + b.days.map((d) => DAYS[d]).join(', ') + ')' : ''} · ${esc(b.time)} · ${b.duration_min} min</dd>
    <dt>Dates</dt><dd>${fmtDate(b.start_date)} → ${fmtDate(b.end_date)}</dd><dt>Paid</dt><dd>${rs(b.amount)} ${b.discount ? `<span class="small muted">(saved ${rs(b.discount)} with ${esc(b.coupon_code)})</span>` : ''}</dd></dl>
    ${b.mode === 'online' && b.status === 'accepted' ? (b.meeting_link ? `<a class="btn ok block" style="margin-top:12px" href="${esc(b.meeting_link)}" target="_blank" rel="noopener noreferrer">🎥 Join online class</a>` : (b.features?.video ? '' : '<div class="alert" style="margin-top:12px">The tutor will share the online class link here.</div>')) : ''}
    ${next && b.mode === 'offline' && b.status === 'accepted' ? `<div class="alert" style="margin-top:12px">🔐 Start code for ${fmtDate(next.date)}: <span class="otp">${esc(next.start_otp)}</span><div class="small">Share this code with the tutor only when they arrive at your door. Never share it on the phone.</div></div>` : ''}
    <div class="row" style="margin-top:12px">${['requested', 'accepted'].includes(b.status) ? '<button class="btn ghost" id="cancel" style="color:var(--bad)">Cancel booking</button>' : ''}
    <a class="btn ghost" href="#/support">Get help</a><button class="btn sos" id="sos">🚨 SOS</button></div></div>
    <div>${b.mode === 'offline' && b.status === 'accepted' ? `<div class="card"><div class="row between"><h3 style="margin:0">Live tracking</h3><span id="lstat" class="badge ${live ? 'warn' : 'grey'}">${live ? live.status.replace(/_/g, ' ') : 'not live'}</span></div>
      <p class="small muted">You can see the tutor's location while they are on the way and during class.</p><div class="map" id="map"></div></div>` : ''}
    ${canReview ? `<div class="card"><h3>Rate your tutor</h3><form id="rv"><div class="pills">${[5, 4, 3, 2, 1].map((n) => `<label class="pill"><input type="radio" name="rating" value="${n}" ${n === 5 ? 'checked' : ''}> ${'⭐'.repeat(n)}</label>`).join('')}</div>
      <textarea name="comment" placeholder="How was the class?" style="margin-top:8px"></textarea><button class="btn" type="submit" style="margin-top:8px">Submit review</button></form></div>` : ''}
    ${b.review ? `<div class="card"><h3>Your review</h3>${'⭐'.repeat(b.review.rating)}<p>${esc(b.review.comment || '')}</p></div>` : ''}</div></div>
    ${bookingExtras(b)}
    ${attendanceCard(b)}`;

  act(v, '#cancel', async () => { if (await confirmBox('Cancel this booking? Remaining sessions are refunded to your wallet.', 'Cancel booking')) { const r = await api(`/bookings/${b.id}/cancel`, { method: 'POST' }); toast(`Cancelled. ${rs(r.refund)} refunded.`); go('#/parent/bookings/' + b.id); } });
  act(v, '#sos', () => sos(b.id));
  bindBookingExtras(v, b, () => go('#/parent/bookings/' + b.id));
  bindAttendance(v, b, () => go('#/parent/bookings/' + b.id));
  onSubmit(v, '#rv', async (d) => { await api(`/bookings/${b.id}/review`, { method: 'POST', body: d }); toast('Thanks for the review!'); go('#/parent/bookings/' + b.id); });

  const mapEl = v.querySelector('#map');
  if (mapEl) {
    const dest = b.lat != null ? { lat: b.lat, lng: b.lng } : undefined;
    const map = makeMap(mapEl, dest, 15);
    if (!map) return;
    if (dest) L.marker([dest.lat, dest.lng], { icon: pinIcon('🏠', '#f59e0b') }).addTo(map).bindPopup('Your home');
    let tm = null;
    const place = (p) => {
      if (!tm) tm = L.marker([p.lat, p.lng], { icon: pinIcon('🧑‍🏫') }).addTo(map).bindPopup(b.tutor.name); else tm.setLatLng([p.lat, p.lng]);
      if (dest) map.fitBounds([[dest.lat, dest.lng], [p.lat, p.lng]], { padding: [40, 40], maxZoom: 16 });
    };
    const r = await api(`/bookings/${b.id}/location`);
    if (r.location) place(r.location);
    const sock = state.socket;
    if (sock) {
      sock.emit('track', b.id);
      const h = (p) => { if (p.booking_id === b.id) { place(p); const s = v.querySelector('#lstat'); if (s) { s.textContent = 'live'; s.className = 'badge warn'; } } };
      sock.on('tutor_location', h);
      onLeave(() => { sock.off('tutor_location', h); sock.emit('untrack', b.id); });
    }
  }
}, P);

export async function sos(bookingId) {
  modal(`<h2 style="color:var(--bad)">🚨 Emergency SOS</h2><p>This alerts the Edvitta safety team immediately with your location. For immediate danger, also call <a href="tel:112"><strong>112</strong></a>.</p>
    <form id="s"><textarea name="message" placeholder="What is happening? (optional)"></textarea><div class="row" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn bad" type="submit">Send SOS now</button></div></form>`,
  (m, close) => onSubmit(m, '#s', async (d) => {
    let p = {};
    try { p = await myLocation(); } catch { /* send without location */ }
    const r = await api('/sos', { method: 'POST', body: { booking_id: bookingId, message: d.message, ...p } });
    close(); toast('SOS sent. Our team will contact you right away.' + (r.helpline ? ' Helpline: ' + r.helpline : ''));
  }));
}
