// Round-2 features: in-app chat, video classes, progress reports & homework, per-class ratings,
// tutor earnings dashboard, GST invoices and monthly statements.
import { state, api, route, go, esc, rs, fmtDate, fmtDT, toast, onSubmit, act, modal, confirmBox, catName, badge, onLeave, todayLocal } from './core.js';
import { shell } from './layout.js';

const PT = { roles: ['parent', 'tutor'] };
const stars = (n) => (n ? '⭐'.repeat(n) : '');
const backTo = (b) => (state.user.role === 'tutor' ? `#/tutor/bookings/${b}` : `#/parent/bookings/${b}`);

// ---------- Booking extras block (shown on parent & tutor booking pages) ----------
export function bookingExtras(b) {
  const tutor = state.user.role === 'tutor';
  const f = b.features || {};
  const completed = b.sessions.filter((s) => s.status === 'completed');
  const rated = new Set(b.session_reviews.map((r) => r.session_id));
  const live = ['accepted', 'completed'].includes(b.status);
  return `<div class="card"><div class="row">
      ${f.chat && !['rejected', 'cancelled'].includes(b.status) ? `<a class="btn ghost" href="#/chat/${b.id}">💬 Chat${b.unread_messages ? ` <span class="badge bad">${b.unread_messages}</span>` : ''}</a>` : ''}
      ${f.masked_calls ? '<button class="btn ghost" id="mcall">📞 Call</button>' : ''}
      ${f.video && b.status === 'accepted' ? `<a class="btn ok" href="#/class/${b.id}">🎥 Join video class</a>` : ''}
    </div>${f.phone_masked && live ? '<p class="small muted" style="margin:8px 0 0">🔒 Phone numbers are private. Use chat or calls inside Edvitta.</p>' : ''}</div>
    ${!tutor && completed.some((s) => !rated.has(s.id)) ? `<div class="card"><h3>Rate this class</h3>
      <form id="rate"><select name="session_id">${completed.filter((s) => !rated.has(s.id)).map((s) => `<option value="${s.id}">${fmtDate(s.date)}</option>`).join('')}</select>
      <div class="grid g3">${[['rating', 'Overall'], ['punctuality', 'Punctuality'], ['teaching', 'Teaching']].map(([k, l]) => `<div><label>${l}</label><select name="${k}">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${stars(n)}</option>`).join('')}</select></div>`).join('')}</div>
      <textarea name="comment" placeholder="How was the class?" style="margin-top:8px"></textarea><button class="btn" type="submit" style="margin-top:8px">Submit</button></form></div>` : ''}
    ${b.session_reviews.length ? `<div class="card"><h3>Reviews</h3>${b.session_reviews.map((r) => `<div class="msg"><strong>${stars(r.rating)}</strong> <span class="small muted">${fmtDate(b.sessions.find((s) => s.id === r.session_id)?.date)}
      ${r.punctuality ? ` · Punctuality ${r.punctuality}/5` : ''}${r.teaching ? ` · Teaching ${r.teaching}/5` : ''}</span><div class="msg-body">${esc(r.comment || '')}</div></div>`).join('')}</div>` : ''}
    <div class="grid g2"><div class="card"><div class="row between"><h3 style="margin:0">Progress reports</h3>${tutor && live ? '<button class="btn sm" id="addpr">+ Add progress report</button>' : ''}</div>
      ${b.progress.map((p) => `<div class="msg"><div class="small muted">${fmtDT(p.created_at)} ${p.understanding ? '· Understanding ' + stars(p.understanding) : ''}</div>
        <div class="msg-body"><strong>${esc(p.topics)}</strong>${p.strengths ? `<div>👍 ${esc(p.strengths)}</div>` : ''}${p.improve ? `<div>🎯 ${esc(p.improve)}</div>` : ''}${p.notes ? `<div class="small">${esc(p.notes)}</div>` : ''}</div></div>`).join('') || '<p class="muted small">No reports yet</p>'}</div>
    <div class="card"><div class="row between"><h3 style="margin:0">Homework</h3>${tutor && b.status === 'accepted' ? '<button class="btn sm" id="addhw">+ Give homework</button>' : ''}</div>
      ${b.homework.map((h) => `<div class="msg"><div class="row between"><strong>${esc(h.title)}</strong>${badge(h.status)}</div>
        <div class="small muted">${h.due_date ? 'Due ' + fmtDate(h.due_date) : ''}</div><div class="msg-body" style="white-space:pre-wrap">${esc(h.details || '')}</div>
        ${h.parent_note ? `<div class="small">Parent: ${esc(h.parent_note)}</div>` : ''}${h.tutor_feedback ? `<div class="small">Tutor: ${esc(h.tutor_feedback)}</div>` : ''}
        ${!tutor && h.status === 'assigned' ? `<button class="btn ghost sm" data-hw="${h.id}">✅ Mark done</button>` : ''}${tutor && h.status === 'done' ? `<button class="btn ghost sm" data-hwr="${h.id}">Review</button>` : ''}</div>`).join('') || '<p class="muted small">No homework yet</p>'}</div></div>`;
}

export function bindBookingExtras(v, b, reload) {
  act(v, '#mcall', async () => { const r = await api(`/bookings/${b.id}/call`, { method: 'POST' }); toast(r.message); });
  onSubmit(v, '#rate', async (d) => { await api(`/sessions/${d.session_id}/review`, { method: 'POST', body: d }); toast('Thanks for rating!'); reload(); });
  act(v, '#addpr', () => modal(`<h3>Progress report</h3><form id="p"><label>Class</label><select name="session_id"><option value="">General</option>${b.sessions.filter((s) => s.status === 'completed' || s.status === 'in_progress').map((s) => `<option value="${s.id}">${fmtDate(s.date)}</option>`).join('')}</select>
    <label>Topics covered</label><input name="topics" required maxlength="500"><label>Understanding</label><select name="understanding">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${stars(n)}</option>`).join('')}</select>
    <label>Strengths</label><input name="strengths" maxlength="500"><label>Needs improvement</label><input name="improve" maxlength="500"><label>Notes</label><textarea name="notes" maxlength="1000"></textarea>
    <div class="row" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Send to parent</button></div></form>`,
  (m, close) => onSubmit(m, '#p', async (d) => { await api(`/bookings/${b.id}/progress`, { method: 'POST', body: d }); close(); toast('Report sent'); reload(); })));
  act(v, '#addhw', () => modal(`<h3>Give homework</h3><form id="h"><label>Title</label><input name="title" required maxlength="120"><label>Details</label><textarea name="details" maxlength="2000"></textarea>
    <label>Due date</label><input type="date" name="due_date"><div class="row" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Assign</button></div></form>`,
  (m, close) => onSubmit(m, '#h', async (d) => { await api(`/bookings/${b.id}/homework`, { method: 'POST', body: d }); close(); toast('Homework assigned'); reload(); })));
  act(v, '[data-hw]', (_e, el) => modal(`<h3>Mark homework done</h3><form id="d"><label>Note for tutor (optional)</label><textarea name="note"></textarea><button class="btn" type="submit" style="margin-top:8px">Mark done</button></form>`,
    (m, close) => onSubmit(m, '#d', async (d) => { await api(`/homework/${el.dataset.hw}`, { method: 'POST', body: d }); close(); reload(); })));
  act(v, '[data-hwr]', (_e, el) => modal(`<h3>Review homework</h3><form id="d"><label>Feedback</label><textarea name="feedback"></textarea><button class="btn" type="submit" style="margin-top:8px">Save</button></form>`,
    (m, close) => onSubmit(m, '#d', async (d) => { await api(`/homework/${el.dataset.hwr}`, { method: 'POST', body: d }); close(); reload(); })));
}

// ---------- Chat ----------
route('/chat/:id', async ({ params }) => {
  const id = Number(params.id);
  const v = shell('Chat');
  const { booking: b } = await api('/bookings/' + id);
  const other = state.user.id === b.parent_id ? b.tutor.name : b.parent.name;
  v.innerHTML = `<a href="${backTo(id)}" class="small">← Back to booking #${id}</a>
    <div class="card" style="margin-top:8px"><div class="row between"><h3 style="margin:0">💬 ${esc(other)}</h3><span class="small muted">${esc(catName(b.category))}</span></div>
    <p class="small muted">🔒 For your child's safety, phone numbers and emails are hidden in chat and messages are kept for our safety team.</p>
    <div id="msgs" style="height:min(55vh,460px);overflow:auto;display:flex;flex-direction:column;gap:6px;padding:6px 0"></div>
    <form id="send" class="row"><input name="body" placeholder="Type a message…" maxlength="1000" autocomplete="off" required style="flex:1"><button class="btn" type="submit">Send</button></form></div>`;
  const box = v.querySelector('#msgs');
  const bubble = (m) => { const mine = m.sender_id === state.user.id;
    return `<div style="align-self:${mine ? 'flex-end' : 'flex-start'};max-width:80%;background:${mine ? 'var(--brand)' : 'var(--bg)'};color:${mine ? '#fff' : 'inherit'};padding:8px 12px;border-radius:14px;border:1px solid var(--line)">
      <div class="msg-body" style="white-space:pre-wrap;word-break:break-word">${esc(m.body)}</div><div style="font-size:11px;opacity:.7;text-align:right">${fmtDT(m.created_at)}</div></div>`; };
  const add = (m) => { box.insertAdjacentHTML('beforeend', bubble(m)); box.scrollTop = box.scrollHeight; };
  (await api(`/bookings/${id}/messages`)).items.forEach(add);
  const f = v.querySelector('#send');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = f.body.value.trim(); if (!body) return;
    f.body.value = '';
    try { const r = await api(`/bookings/${id}/messages`, { method: 'POST', body: { body } }); if (r.notice) toast(r.notice, true); } catch (err) { toast(err.message, true); }
  });
  const sock = state.socket;
  if (sock) { const h = (m) => { if (m.booking_id === id) { add(m); if (m.sender_id !== state.user.id) api(`/bookings/${id}/messages`).catch(() => {}); } }; sock.on('chat', h); onLeave(() => sock.off('chat', h)); }
}, PT);

// ---------- Video class (WebRTC, 1:1 between tutor and the parent's device) ----------
route('/class/:id', async ({ params }) => {
  const id = Number(params.id);
  const v = shell('Video class');
  let cfg;
  try { cfg = await api(`/video/${id}/config`); } catch (e) { v.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = `<a href="${backTo(id)}" class="small">← Back to booking #${id}</a>
    <div class="card" style="margin-top:8px;background:#0b1020;color:#fff"><div class="row between"><strong>🎥 Class with ${esc(cfg.other_name)}</strong><span id="vs" class="badge grey">Waiting for ${esc(cfg.other_name.split(' ')[0])}…</span></div>
    <div style="position:relative;margin-top:10px;background:#000;border-radius:12px;overflow:hidden;aspect-ratio:16/10">
      <video id="remote" autoplay playsinline style="width:100%;height:100%;object-fit:cover"></video>
      <video id="local" autoplay playsinline muted style="position:absolute;right:10px;bottom:10px;width:28%;max-width:200px;border-radius:10px;border:2px solid #fff;background:#222"></video></div>
    <div class="row" style="justify-content:center;margin-top:12px"><button class="btn ghost" style="color:#fff" id="mic">🎙️ Mute</button><button class="btn ghost" style="color:#fff" id="cam">📷 Camera off</button><button class="btn bad" id="end">Leave class</button></div>
    <p class="small" style="opacity:.75;text-align:center;margin-top:8px">Video goes directly between the two devices. Join times are logged for safety.</p></div>`;
  const sock = state.socket;
  if (!sock || !navigator.mediaDevices?.getUserMedia) { toast('Video is not supported on this device/browser', true); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true }); }
  catch { v.querySelector('#vs').textContent = 'Allow camera & microphone to join'; return; }
  v.querySelector('#local').srcObject = stream;
  let pc = null;
  const status = (t, cls = 'grey') => { const el = v.querySelector('#vs'); if (el) { el.textContent = t; el.className = 'badge ' + cls; } };
  const makePc = () => {
    pc?.close();
    pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
    stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
    pc.ontrack = (e) => { v.querySelector('#remote').srcObject = e.streams[0]; status('Connected', 'ok'); };
    pc.onicecandidate = (e) => { if (e.candidate) sock.emit('video:signal', { bookingId: id, data: { candidate: e.candidate } }); };
    pc.onconnectionstatechange = () => { if (['failed', 'disconnected'].includes(pc.connectionState)) status('Connection lost. Waiting…', 'warn'); };
  };
  const onSignal = async ({ data }) => {
    try {
      if (data.offer) { makePc(); await pc.setRemoteDescription(data.offer); const ans = await pc.createAnswer(); await pc.setLocalDescription(ans); sock.emit('video:signal', { bookingId: id, data: { answer: pc.localDescription } }); }
      else if (data.answer && pc) await pc.setRemoteDescription(data.answer);
      else if (data.candidate && pc) await pc.addIceCandidate(data.candidate).catch(() => {});
    } catch { status('Could not connect', 'bad'); }
  };
  // The person already in the room makes the offer when the other one joins.
  const onPeer = async () => { status('Connecting…', 'warn'); makePc(); const offer = await pc.createOffer(); await pc.setLocalDescription(offer); sock.emit('video:signal', { bookingId: id, data: { offer: pc.localDescription } }); };
  const onLeft = () => { status('The other person left', 'grey'); v.querySelector('#remote').srcObject = null; };
  const onErr = (msg) => { status(msg, 'bad'); toast(msg, true); };
  sock.on('video:signal', onSignal); sock.on('video:peer-joined', onPeer); sock.on('video:peer-left', onLeft); sock.on('video:error', onErr);
  sock.emit('video:join', id);
  const cleanup = () => { sock.emit('video:leave', id); sock.off('video:signal', onSignal); sock.off('video:peer-joined', onPeer); sock.off('video:peer-left', onLeft); sock.off('video:error', onErr); pc?.close(); stream.getTracks().forEach((tr) => tr.stop()); };
  onLeave(cleanup);
  act(v, '#mic', (_e, el) => { const a = stream.getAudioTracks()[0]; a.enabled = !a.enabled; el.textContent = a.enabled ? '🎙️ Mute' : '🔇 Unmute'; });
  act(v, '#cam', (_e, el) => { const c = stream.getVideoTracks()[0]; c.enabled = !c.enabled; el.textContent = c.enabled ? '📷 Camera off' : '📷 Camera on'; });
  act(v, '#end', () => go(backTo(id)));
}, PT);

// ---------- Tutor earnings dashboard ----------
route('/tutor/earnings', async () => {
  const v = shell('Earnings');
  const [e, wk] = await Promise.all([api('/earnings'), api('/tutor/payouts')]);
  const max = Math.max(1, ...e.by_month.map((m) => m.gross));
  const tile = (n, l) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  v.innerHTML = `<p class="muted small">Edvitta keeps <strong>${e.commission_percent}%</strong> commission${e.gst_enabled ? ` + ${e.gst_percent}% GST on the commission` : ''} from each class fee. The rest goes to your wallet as soon as you mark a class complete.</p>
    <h3>This month</h3><div class="grid g4">${tile(e.this_month.classes, 'Classes')}${tile(rs(e.this_month.gross), 'Class fees')}${tile(rs(e.this_month.commission + e.this_month.gst), 'Commission' + (e.gst_enabled ? ' + GST' : ''))}${tile(rs(e.this_month.net), 'You received')}</div>
    <h3>All time</h3><div class="grid g4">${tile(e.total.classes, 'Classes')}${tile(rs(e.total.net), 'You received')}${tile(rs(e.group_income), 'Community group income')}${tile(`${e.upcoming.n} · ${rs(e.upcoming.value)}`, 'Upcoming classes (fees)')}</div>
    <div class="card"><div class="row between"><h3 style="margin:0">Weekly payouts</h3>
      <form id="upi" class="row"><input name="upi_id" value="${esc(wk.payout_upi)}" placeholder="Payout UPI e.g. name@okbank" style="width:220px"><button class="btn sm" type="submit">Save UPI</button></form></div>
      <p class="small muted">Weeks run Monday to Sunday. Save your UPI ID so Edvitta can send your weekly payout. You can also withdraw any time from Wallet.</p>
      <div class="table-wrap"><table><thead><tr><th>Week</th><th>Classes</th><th>Fees</th><th>Commission + GST</th><th>Earned</th><th>Missed by you</th></tr></thead><tbody>
      ${wk.weeks.map((w) => `<tr><td>${fmtDate(w.week_start)} – ${fmtDate(w.week_end)}${w.current ? ' <span class="badge">this week</span>' : ''}</td><td>${w.classes}</td><td>${rs(w.gross)}</td><td>${rs(w.commission + w.gst)}</td><td><strong>${rs(w.net)}</strong></td><td>${w.missed_by_tutor ? `<span class="badge bad">${w.missed_by_tutor}</span>` : '0'}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><h3>Monthly statement</h3>${e.by_month.length ? `<div class="table-wrap"><table><thead><tr><th>Month</th><th>Classes</th><th></th><th>Fees</th><th>Commission</th><th>GST</th><th>Received</th><th></th></tr></thead><tbody>
      ${e.by_month.map((m) => `<tr><td>${esc(m.month)}</td><td>${m.classes}</td><td style="width:22%"><div style="height:10px;border-radius:6px;background:var(--brand);width:${Math.round((m.gross / max) * 100)}%"></div></td>
      <td>${rs(m.gross)}</td><td>${rs(m.commission)}</td><td>${rs(m.gst)}</td><td><strong>${rs(m.net)}</strong></td><td><a class="btn ghost sm" href="#/statement/${m.month}">Statement</a></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No completed classes yet</p>'}</div>
    <div class="card"><h3>Invoices</h3><div class="table-wrap"><table><thead><tr><th>Number</th><th>Date</th><th>Fee</th><th>Commission</th><th>GST</th><th>Net</th><th></th></tr></thead><tbody>
      ${e.invoices.map((i) => `<tr><td><code>${esc(i.number)}</code></td><td class="small">${fmtDate(i.created_at)}</td><td>${rs(i.gross)}</td><td>${rs(i.commission)}</td><td>${rs(i.gst)}</td><td>${rs(i.net)}</td><td><a class="btn ghost sm" href="#/invoice/${i.id}">View</a></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No invoices yet</td></tr>'}</tbody></table></div>
      <p class="small muted">Add your PAN (and GSTIN if you have one) in your profile so they appear on invoices.</p></div>`;
  onSubmit(v, '#upi', async (d) => { await api('/tutor/payout-upi', { method: 'PUT', body: d }); toast('Payout UPI saved'); });
}, { roles: ['tutor'] });

// ---------- Printable invoice / receipt ----------
const words = (n) => `Rupees ${(n / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} only`;
function printableShell(title, inner) {
  const v = shell(title);
  v.innerHTML = `<div class="row" style="margin-bottom:10px" data-noprint><button class="btn" id="pr">🖨️ Print / save PDF</button><button class="btn ghost" id="bk">Back</button></div>
    <div class="card" id="doc" style="max-width:820px;background:#fff;color:#111">${inner}</div>
    <style>@media print { .side,.tabbar,.topbar,[data-noprint] { display:none !important } .main { padding:0 } #doc { border:0; box-shadow:none } }</style>`;
  v.querySelector('#pr').onclick = () => window.print();
  v.querySelector('#bk').onclick = () => history.back();
}
route('/invoice/:id', async ({ params }) => {
  const { invoice: i, party, platform: p } = await api('/invoices/' + params.id);
  const isComm = i.type === 'commission';
  const head = `<div class="row between" style="align-items:flex-start"><div><div style="font-size:1.4rem;font-weight:800;color:#4f46e5">${esc(p.name)}</div>
    <div class="small">${esc(p.address || '')}${p.state ? '<br>State: ' + esc(p.state) : ''}${p.gstin ? '<br>GSTIN: ' + esc(p.gstin) : ''}</div></div>
    <div style="text-align:right"><div style="font-weight:800">${isComm ? (i.gst ? 'TAX INVOICE' : 'COMMISSION INVOICE') : 'PAYMENT RECEIPT'}</div><div class="small">No. ${esc(i.number)}<br>Date: ${fmtDate(i.created_at)}</div></div></div><hr>
    <div class="small"><strong>${isComm ? 'Billed to (tutor)' : 'Received from'}:</strong> ${esc(party.name)}<br>${esc(party.email)}${party.address ? '<br>' + esc(party.address) : ''}${party.pan ? '<br>PAN: ' + esc(party.pan) : ''}${party.gstin ? '<br>GSTIN: ' + esc(party.gstin) : ''}</div><hr>`;
  const body = isComm ? `<table><thead><tr><th>Description</th><th>SAC</th><th style="text-align:right">Amount</th></tr></thead><tbody>
      <tr><td>Class fee collected on your behalf${i.meta.date ? ' (class on ' + fmtDate(i.meta.date) + ')' : ''}${i.booking_id ? ', booking #' + i.booking_id : ''}${i.meta.group ? ', group "' + esc(i.meta.group) + '"' : ''}</td><td></td><td style="text-align:right">${rs(i.gross)}</td></tr>
      <tr><td>Edvitta platform commission @ ${i.commission_percent}%</td><td>${esc(p.sac || '')}</td><td style="text-align:right">${rs(i.commission)}</td></tr>
      ${i.gst ? `<tr><td>GST @ ${i.gst_percent}% on commission</td><td></td><td style="text-align:right">${rs(i.gst)}</td></tr>` : ''}
      <tr><td><strong>Total charged by Edvitta (commission${i.gst ? ' + GST' : ''})</strong></td><td></td><td style="text-align:right"><strong>${rs(i.commission + i.gst)}</strong></td></tr>
      <tr><td><strong>Net amount credited to your wallet</strong></td><td></td><td style="text-align:right"><strong>${rs(i.net)}</strong></td></tr></tbody></table>
      <p class="small">${words(i.commission + i.gst)} charged as commission${i.gst ? ' including GST' : ''}.</p>`
    : `<table><thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead><tbody>
      <tr><td>${esc(catName(i.meta.category || ''))} classes: ${i.meta.sessions} × ${rs(i.meta.rate)}${i.meta.package ? ' (package: ' + esc(i.meta.package) + ')' : ''}${i.meta.trial ? ' (trial class)' : ''}, booking #${i.booking_id}</td><td style="text-align:right">${rs(i.gross)}</td></tr>
      ${i.meta.discount ? `<tr><td>Coupon ${esc(i.meta.coupon || '')}</td><td style="text-align:right">−${rs(i.meta.discount)}</td></tr>` : ''}
      <tr><td><strong>Paid from Edvitta wallet</strong></td><td style="text-align:right"><strong>${rs(i.net)}</strong></td></tr></tbody></table><p class="small">${words(i.net)}. Unused classes are refunded to your wallet if you cancel.</p>`;
  printableShell(isComm ? 'Invoice' : 'Receipt', head + body + '<p class="small muted" style="margin-top:20px">This is a computer-generated document and does not need a signature.</p>');
}, { roles: ['parent', 'tutor', 'admin', 'staff'] });

route('/statement/:month', async ({ params }) => {
  const s = await api('/statements/' + params.month);
  const p = s.platform;
  printableShell('Monthly statement', `<div class="row between"><div><div style="font-size:1.4rem;font-weight:800;color:#4f46e5">${esc(p.name)}</div><div class="small">${esc(p.address || '')}${p.gstin ? '<br>GSTIN: ' + esc(p.gstin) : ''}</div></div>
    <div style="text-align:right"><strong>EARNINGS STATEMENT</strong><div class="small">${esc(s.month)}</div></div></div><hr>
    <div class="small"><strong>Tutor:</strong> ${esc(s.party.name)} · ${esc(s.party.email)}${s.party.pan ? ' · PAN ' + esc(s.party.pan) : ''}${s.party.gstin ? ' · GSTIN ' + esc(s.party.gstin) : ''}</div><hr>
    <table><thead><tr><th>Invoice</th><th>Date</th><th>Fee</th><th>Commission</th><th>GST</th><th>Net</th></tr></thead><tbody>
    ${s.rows.map((r) => `<tr><td>${esc(r.number)}</td><td>${fmtDate(r.created_at)}</td><td>${rs(r.gross)}</td><td>${rs(r.commission)}</td><td>${rs(r.gst)}</td><td>${rs(r.net)}</td></tr>`).join('')}
    <tr><td colspan="2"><strong>Total</strong></td><td><strong>${rs(s.total.gross)}</strong></td><td><strong>${rs(s.total.commission)}</strong></td><td><strong>${rs(s.total.gst)}</strong></td><td><strong>${rs(s.total.net)}</strong></td></tr></tbody></table>`);
}, { roles: ['tutor'] });

// ---------- Receipts list for parents ----------
route('/receipts', async () => {
  const v = shell('Receipts');
  const { items } = await api('/invoices');
  v.innerHTML = `<div class="card table-wrap"><table><thead><tr><th>Number</th><th>Date</th><th>Booking</th><th>Amount</th><th></th></tr></thead><tbody>
    ${items.map((i) => `<tr><td><code>${esc(i.number)}</code></td><td class="small">${fmtDate(i.created_at)}</td><td>#${i.booking_id || '–'}</td><td>${rs(i.net)}</td><td><a class="btn ghost sm" href="#/invoice/${i.id}">View</a></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No receipts yet</td></tr>'}</tbody></table></div>`;
}, PT);

// ---------- Attendance (parent & tutor booking pages) ----------
const ATT = { present: 'Attended', tutor_absent: 'Tutor absent', student_absent: 'Student absent', not_marked: 'Not marked' };
export function attendanceCard(b) {
  const tutor = state.user.role === 'tutor';
  const today = todayLocal();
  const ss = b.sessions;
  const count = (fn) => ss.filter(fn).length;
  const sum = { present: count((s) => s.status === 'completed'), tutor_absent: count((s) => s.attendance === 'tutor_absent'),
    student_absent: count((s) => s.attendance === 'student_absent'), not_marked: count((s) => s.attendance === 'not_marked'),
    moved: count((s) => s.original_date && !s.makeup_for), makeups: count((s) => s.makeup_for) };
  const active = b.status === 'accepted';
  const actions = (s) => {
    if (!active || !['scheduled', 'on_the_way'].includes(s.status)) return '';
    if (tutor) return s.date <= today ? `<button class="btn ghost sm" data-miss="${s.id}">Mark missed</button>` : '';
    if (s.date <= today) return `<button class="btn ghost sm" data-noshow="${s.id}">Tutor didn't come</button>`;
    return s.status === 'scheduled' ? `<button class="btn ghost sm" data-leave="${s.date}">Child on leave</button>` : '';
  };
  const note = (s) => [s.makeup_for ? `🔁 Make-up for ${fmtDate(s.original_date)}` : s.original_date ? `📅 Moved from ${fmtDate(s.original_date)}` : '',
    s.attendance && s.attendance !== 'present' ? esc(ATT[s.attendance] || s.attendance) + (s.attendance_note ? ': ' + esc(s.attendance_note) : '') : ''].filter(Boolean).join('<br>');
  return `<div class="card"><div class="row between"><h3 style="margin:0">Attendance (${sum.present}/${b.total_sessions} classes done)</h3>
    ${!tutor && active ? '<span class="small muted">Going on a trip? Mark leave days and the classes move to the end of the plan.</span>' : ''}</div>
    <div class="pills" style="margin:10px 0">${[['✅', 'Attended', sum.present], ['🚫', 'Tutor absent', sum.tutor_absent], ['🙋', 'Student absent', sum.student_absent], ['❔', 'Not marked', sum.not_marked], ['📅', 'Moved', sum.moved], ['🔁', 'Make-up classes', sum.makeups]]
      .filter(([, , n], i) => n || i === 0).map(([e, l, n]) => `<span class="pill">${e} ${l}: <strong>${n}</strong></span>`).join('')}</div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Status</th><th>${tutor ? 'Payout' : 'Start code'}</th><th>Notes</th><th></th></tr></thead><tbody>
    ${ss.map((s) => `<tr><td>${fmtDate(s.date)}</td><td>${badge(s.attendance && s.status === 'missed' ? s.attendance : s.status)}</td>
      <td>${tutor ? (s.payout != null ? rs(s.payout) : '–') : (b.mode === 'offline' && ['scheduled', 'on_the_way'].includes(s.status) ? `<code>${esc(s.start_otp)}</code>` : '–')}</td>
      <td class="small">${note(s)}</td><td>${actions(s)}</td></tr>`).join('') || `<tr><td colspan="5" class="muted">${tutor ? 'Accept the booking to create sessions' : 'Sessions appear after the tutor accepts'}</td></tr>`}</tbody></table></div>
    ${active ? `<p class="small muted" style="margin-top:8px">${tutor ? 'If a class did not happen, mark it missed. If you were absent, the parent gets a free make-up class. Plan leave in advance under <a href="#/tutor/leave">Leave days</a>.'
      : `If the tutor misses a class, you get a free make-up class at the end of the plan. ${state.config.student_absent_policy === 'charge' ? 'If your child is absent without marking leave, the class is counted.' : 'If your child is absent, a make-up class is added too.'}`}</p>` : ''}</div>`;
}

export function bindAttendance(v, b, reload) {
  act(v, '[data-miss]', (_e, el) => modal(`<h3>Mark class missed</h3><form id="m"><label>What happened?</label>
    <label class="chk"><input type="radio" name="status" value="tutor_absent" required> I could not take the class</label>
    <label class="chk"><input type="radio" name="status" value="student_absent"> The student was absent / not available</label>
    <label>Note (optional)</label><input name="note" maxlength="300" placeholder="e.g. Unwell, family function">
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn ghost" data-close>Back</button><button class="btn" type="submit">Save</button></div></form>`,
  (m, close) => onSubmit(m, '#m', async (d) => {
    const r = await api(`/sessions/${el.dataset.miss}/attendance`, { method: 'POST', body: d });
    close(); toast(r.makeup_date ? `Saved. Make-up class booked on ${fmtDate(r.makeup_date)}` : 'Saved. The class is counted as per policy.'); reload();
  })));
  act(v, '[data-noshow]', async (_e, el) => {
    if (!(await confirmBox("Report that the tutor didn't come for this class? You get a free make-up class and our team is informed.", 'Report'))) return;
    const r = await api(`/sessions/${el.dataset.noshow}/report-absent`, { method: 'POST', body: {} });
    toast(`Reported. Make-up class on ${fmtDate(r.makeup_date)}`); reload();
  });
  act(v, '[data-leave]', (_e, el) => modal(`<h3>Child on leave: ${fmtDate(el.dataset.leave)}</h3><p class="small muted">The class on this day moves to the end of your plan. The tutor is told right away.</p>
    <form id="l"><label>Reason (optional)</label><input name="reason" maxlength="120" placeholder="e.g. Exams, travel">
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn ghost" data-close>Back</button><button class="btn" type="submit">Mark leave</button></div></form>`,
  (m, close) => onSubmit(m, '#l', async (d) => { await api(`/bookings/${b.id}/leave`, { method: 'POST', body: { ...d, date: el.dataset.leave } }); close(); toast('Leave marked. Class moved.'); reload(); })));
}

// ---------- Tutor leave days ----------
route('/tutor/leave', async () => {
  const v = shell('Leave days');
  const d = await api('/tutor/leave');
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA');
  v.innerHTML = `<div class="grid g2"><div class="card"><h3>Plan a leave day</h3><p class="small muted">All your classes on that day move to the end of each plan, and parents are told right away. You can take up to ${d.max_per_month} leave days a month.</p>
    <form id="f"><label>Date</label><input type="date" name="date" min="${tomorrow}" required><label>Reason (optional)</label><input name="reason" maxlength="120" placeholder="e.g. Exam, family function">
    <button class="btn" type="submit" style="margin-top:12px">Mark leave</button></form></div>
    <div class="card"><h3>Your upcoming leave</h3>${d.items.map((h) => `<div class="row between msg"><div><strong>${fmtDate(h.date)}</strong> <span class="small muted">${esc(h.reason || '')}</span><div class="small muted">${h.moved} class${h.moved === 1 ? '' : 'es'} moved</div></div>
      <button class="btn ghost sm" data-del="${h.id}">Remove</button></div>`).join('') || '<p class="muted small">No leave planned</p>'}
    <h3 style="margin-top:14px">Platform holidays</h3>${d.holidays.map((h) => `<div class="small">🎉 ${fmtDate(h.date)}: ${esc(h.reason || 'Holiday')}</div>`).join('') || '<p class="muted small">None announced</p>'}</div></div>`;
  onSubmit(v, '#f', async (x) => { const r = await api('/tutor/leave', { method: 'POST', body: x }); toast(`Leave marked. ${r.moved} class${r.moved === 1 ? '' : 'es'} moved.`); go('#/tutor/leave'); });
  act(v, '[data-del]', async (_e, el) => { if (await confirmBox('Remove this leave day? Classes already moved stay on their new dates.', 'Remove')) { await api('/tutor/leave/' + el.dataset.del, { method: 'DELETE' }); go('#/tutor/leave'); } });
}, { roles: ['tutor'] });
