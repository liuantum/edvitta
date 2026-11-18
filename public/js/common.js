import { state, api, route, go, esc, rs, toRupees, fmtDate, fmtDT, toast, onSubmit, act, modal, confirmBox, homeFor, catName, catIcon,
  badge, adSlot, locationPicker, myLocation, initials } from './core.js';
import { shell, refreshMe } from './layout.js';

// ---------- Landing ----------
route('/', async () => {
  if (state.user) return go(homeFor(state.user));
  const app = document.getElementById('app');
  const groups = {};
  for (const c of state.categories) (groups[c.grp] ||= []).push(c);
  app.innerHTML = `<div class="main" style="margin:0 auto">
    <div class="row between" style="margin-bottom:14px"><a class="brand" href="#/"><img src="/icon.svg" alt="">Edvitta</a>
      <div class="row"><a class="btn ghost sm" href="#/login">Log in</a><a class="btn sm" href="#/register">Sign up</a></div></div>
    <section class="hero"><h1>Verified tutors at your doorstep,<br>within 3 km.</h1>
      <p style="max-width:560px;opacity:.95">Book home or online classes for school subjects, drawing, singing, dance, music, chess and more. Daily or on your own schedule. Track your tutor live.</p>
      <div class="row" style="margin-top:16px"><a class="btn" href="#/register?role=parent">I'm a parent</a><a class="btn ghost" href="#/register?role=tutor">Become a tutor</a></div>
      <div class="trust"><span>🛡️ KYC & ID-verified tutors</span><span>📍 Live tutor tracking</span><span>🔐 Start code for every visit</span><span>🚨 SOS & 24×7 helpline</span></div></section>
    <div id="ad"></div>
    ${Object.entries(groups).map(([g, cs]) => `<h3 style="margin-top:18px">${esc(g)}</h3><div class="grid g4">${cs.map((c) =>
      `<a class="cat" href="#/register?role=parent"><span class="e">${c.icon}</span>${esc(c.name)}</a>`).join('')}</div>`).join('')}
    <div class="grid g3" style="margin-top:22px">
      <div class="card"><h3>1. Find nearby</h3><p class="muted">Set your home location and see verified tutors within 3 km, or pick online tutors from anywhere.</p></div>
      <div class="card"><h3>2. Book your way</h3><p class="muted">One class, daily, or custom weekdays. Pay securely from your Edvitta wallet. Coupons apply.</p></div>
      <div class="card"><h3>3. Learn safely</h3><p class="muted">Tutor shares a start code check, live location on the way, and you can raise SOS anytime.</p></div>
    </div>
    <p class="center small muted" style="margin-top:30px">© Edvitta · <a href="#/login">Staff & admin login</a></p></div>`;
  app.querySelector('#ad').innerHTML = await adSlot('home');
});

// ---------- Auth ----------
route('/login', ({ query }) => {
  if (state.user) return go(homeFor(state.user));
  const app = document.getElementById('app');
  const otpOn = state.config.otp_login !== false;
  const mode = query.m === 'otp' && otpOn ? 'otp' : query.m === 'reset' ? 'reset' : 'pw';
  const tabs = `<div class="tabs"><a href="#/login" class="${mode === 'pw' ? 'on' : ''}">Password</a>${otpOn ? `<a href="#/login?m=otp" class="${mode === 'otp' ? 'on' : ''}">Email code</a>` : ''}</div>`;
  const forms = {
    pw: `<form id="f"><label>Email or mobile number</label><input name="login" autocomplete="username" required>
      <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
      <button class="btn block" style="margin-top:16px" type="submit">Log in</button></form><p class="small center" style="margin-top:10px"><a href="#/login?m=reset">Forgot password?</a></p>`,
    otp: `<form id="o1"><label>Email</label><input name="email" type="email" required autocomplete="email"><button class="btn block" style="margin-top:12px" type="submit">Send code</button></form>
      <form id="o2" style="display:none"><label>6-digit code</label><input name="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" required class="otp" style="text-align:center">
      <button class="btn block" style="margin-top:12px" type="submit">Log in</button></form>`,
    reset: `<h3>Reset password</h3><form id="r1"><label>Email</label><input name="email" type="email" required><button class="btn block" style="margin-top:12px" type="submit">Send code</button></form>
      <form id="r2" style="display:none"><label>6-digit code</label><input name="code" inputmode="numeric" maxlength="6" required><label>New password</label><input name="password" type="password" minlength="8" required autocomplete="new-password">
      <button class="btn block" style="margin-top:12px" type="submit">Reset password</button></form><p class="small center"><a href="#/login">Back</a></p>`,
  };
  app.innerHTML = `<div class="auth"><a class="brand" href="#/"><img src="/icon.svg" alt="">Edvitta</a><div class="card"><h2>Welcome back</h2>${mode !== 'reset' ? tabs : ''}${forms[mode]}
    <p class="small muted center" style="margin-top:12px">New here? <a href="#/register">Create an account</a></p></div></div>`;
  let email = '';
  const sent = (r) => { toast(r.message || 'Code sent to your email'); if (r.dev_code) toast('Dev mode code: ' + r.dev_code); };
  onSubmit(app, '#f', async (d) => {
    const r = await api('/auth/login', { method: 'POST', body: d });
    if (r.mfa) return mfaStep(app, r);
    go(homeFor(await refreshMe()));
  });
  onSubmit(app, '#o1', async (d) => { email = d.email; sent(await api('/auth/otp/request', { method: 'POST', body: { email, purpose: 'login' } })); app.querySelector('#o1').style.display = 'none'; app.querySelector('#o2').style.display = ''; });
  onSubmit(app, '#o2', async (d) => { await api('/auth/otp/login', { method: 'POST', body: { email, code: d.code } }); go(homeFor(await refreshMe())); });
  onSubmit(app, '#r1', async (d) => { email = d.email; sent(await api('/auth/otp/request', { method: 'POST', body: { email, purpose: 'reset' } })); app.querySelector('#r1').style.display = 'none'; app.querySelector('#r2').style.display = ''; });
  onSubmit(app, '#r2', async (d) => { await api('/auth/password/reset', { method: 'POST', body: { email, ...d } }); toast('Password changed. Please log in.'); go('#/login'); });
});

// Admin & staff 2-step sign-in: after the right password, a 6-digit code is emailed.
function mfaStep(app, r) {
  const f = app.querySelector('#f');
  f.innerHTML = `<div class="alert small">🔐 ${esc(r.message)} (${esc(r.email)}).</div><label>Sign-in code</label>
    <input name="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" required autocomplete="one-time-code"><button class="btn block" type="submit" style="margin-top:12px">Verify and sign in</button>`;
  if (r.dev_code) toast('Dev mode code: ' + r.dev_code);
  const nf = f.cloneNode(true); f.replaceWith(nf);
  onSubmit(app, '#f', async (d) => { await api('/auth/mfa', { method: 'POST', body: { email: r.email, code: d.code } }); go(homeFor(await refreshMe())); });
}

route('/register', ({ query }) => {
  const app = document.getElementById('app');
  let role = query.role === 'tutor' ? 'tutor' : 'parent';
  const draw = () => {
    app.innerHTML = `<div class="auth"><a class="brand" href="#/"><img src="/icon.svg" alt="">Edvitta</a><div class="card"><h2>Create your account</h2>
    <div class="pills" style="margin:8px 0 6px"><button class="pill ${role === 'parent' ? 'on' : ''}" data-r="parent">👨‍👩‍👧 Parent</button><button class="pill ${role === 'tutor' ? 'on' : ''}" data-r="tutor">🧑‍🏫 Tutor</button></div>
    <form id="f"><label>Full name</label><input name="name" required maxlength="80" autocomplete="name">
    <label>Mobile number</label><input name="phone" required inputmode="tel" placeholder="10-digit mobile" autocomplete="tel">
    <label>Email</label><input name="email" type="email" required autocomplete="email">
    <label>Password</label><input name="password" type="password" required minlength="8" autocomplete="new-password" placeholder="8+ characters, letters and numbers">
    <label>Referral code (optional)</label><input name="referral_code" value="${esc(query.ref || '')}" maxlength="20">
    ${role === 'tutor' ? '<p class="alert small">After signing up you will upload Aadhaar, PAN and a photo. Your account goes live only after our team verifies them.</p>' : ''}
    <label class="chk"><input type="checkbox" required> I agree to the Terms and the Child Safety Policy</label>
    <button class="btn block" style="margin-top:12px" type="submit">Sign up as ${role}</button></form>
    <p class="small muted center" style="margin-top:12px">Already have an account? <a href="#/login">Log in</a></p></div></div>`;
    act(app, '[data-r]', (_e, el) => { role = el.dataset.r; draw(); });
    onSubmit(app, '#f', async (d) => {
      await api('/auth/register', { method: 'POST', body: { ...d, role } });
      const u = await refreshMe();
      toast('Account created!');
      go(u.role === 'tutor' ? '#/tutor/profile' : '#/parent/children');
    });
  };
  draw();
});

// ---------- Notifications ----------
route('/notifications', async () => {
  const v = shell('Notifications');
  const { items } = await api('/auth/notifications');
  state.user.unread = 0;
  v.innerHTML = `<div class="card">${items.length ? items.map((n) => `<div class="row between" style="padding:10px 0;border-bottom:1px solid var(--line)">
    <div>${n.link ? `<a href="${esc(n.link)}">${esc(n.text)}</a>` : esc(n.text)}<div class="small muted">${fmtDT(n.created_at)}</div></div>${n.read ? '' : '<span class="badge">new</span>'}</div>`).join('')
    : '<div class="empty">No notifications yet</div>'}</div>`;
}, { roles: ['parent', 'tutor', 'admin', 'staff'] });

// ---------- Account ----------
route('/account', () => {
  const u = state.user;
  const v = shell('Account');
  v.innerHTML = `<div class="grid g2"><div class="card"><div class="row"><div class="avatar">${esc(initials(u.name))}</div><div><h3 style="margin:0">${esc(u.name)}</h3>
    <div class="muted small">${esc(u.email)} · ${esc(u.phone)}</div>${badge(u.role)}</div></div></div>
    <div class="card"><h3>Email & notifications</h3>${u.email_verified ? '<p><span class="badge ok">✔ Email verified</span></p>'
      : `<div class="alert warn small">Your email is not verified.${state.config.require_email_verification ? ' You need it to book classes and withdraw money.' : ''}</div>
      <div class="row"><button class="btn ghost sm" id="vsend">Send code</button><input id="vcode" placeholder="6-digit code" maxlength="6" inputmode="numeric" style="width:140px"><button class="btn sm" id="vok">Verify</button></div>`}
      <label class="chk" style="margin-top:10px"><input type="checkbox" id="en" ${u.email_notifications ? 'checked' : ''}> Email notifications</label>
      <p class="small muted">Booking updates, tutor arrival, payments and help tickets.</p>
      ${state.config.whatsapp ? `<label class="chk"><input type="checkbox" id="wa" ${u.whatsapp_alerts ? 'checked' : ''}> WhatsApp alerts</label>
      <p class="small muted">Important alerts only: booking accepted, tutor on the way, class moved, payments.</p>` : ''}</div>
    <div class="card"><h3>Change password</h3><form id="pw"><label>Current password</label><input type="password" name="current" required>
    <label>New password</label><input type="password" name="password" required minlength="8"><button class="btn" type="submit" style="margin-top:12px">Update password</button></form></div>
    <div class="card"><h3>Security</h3><p class="muted small">Lost your phone or shared your login? Sign out of every device right away.</p>
    <button class="btn bad" id="all">Log out of all devices</button></div></div>`;
  onSubmit(v, '#pw', async (d, f) => { await api('/auth/change-password', { method: 'POST', body: d }); f.reset(); toast('Password updated'); });
  act(v, '#vsend', async () => { const r = await api('/auth/verify-email/send', { method: 'POST' }); toast('Code sent to ' + u.email); if (r.dev_code) toast('Dev mode code: ' + r.dev_code); });
  act(v, '#vok', async () => { await api('/auth/verify-email', { method: 'POST', body: { code: v.querySelector('#vcode').value } }); await refreshMe(); toast('Email verified'); go('#/account'); });
  v.querySelector('#wa')?.addEventListener('change', async (e) => { await api('/auth/prefs', { method: 'PUT', body: { whatsapp_alerts: e.target.checked } }); state.user.whatsapp_alerts = e.target.checked; toast('Saved'); });
  v.querySelector('#en').addEventListener('change', async (e) => { await api('/auth/prefs', { method: 'PUT', body: { email_notifications: e.target.checked } }); state.user.email_notifications = e.target.checked; toast('Saved'); });
  act(v, '#all', async () => { if (await confirmBox('Log out from all devices?')) { await api('/auth/logout-all', { method: 'POST' }); state.user = null; go('#/login'); } });
}, { roles: ['parent', 'tutor', 'admin', 'staff'] });

// ---------- Wallet ----------
route('/wallet', async () => {
  const v = shell(state.user.role === 'tutor' ? 'Earnings & wallet' : 'Wallet');
  const w = await api('/wallet');
  const tutor = state.user.role === 'tutor';
  v.innerHTML = `<div class="grid g2">
    <div class="card" style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff"><div class="small" style="opacity:.85">Available balance</div>
      <div style="font-size:2.2rem;font-weight:800">${rs(w.balance)}</div>
      <div class="row" style="margin-top:10px">${w.gateway_enabled ? '<button class="btn warn" id="rzp">+ Add money online</button>' : ''}${w.demo_enabled ? '<button class="btn warn" id="topup">+ Add money (demo)</button>' : ''}
      <button class="btn ghost" style="color:#fff;border-color:rgba(255,255,255,.5)" id="qr">Pay via UPI QR</button>
      <button class="btn ghost" style="color:#fff;border-color:rgba(255,255,255,.5)" id="wd">Withdraw</button></div>
      ${w.demo_enabled ? '<p class="small" style="opacity:.8;margin-top:8px">Demo payments are on (money is added instantly for testing).</p>' : ''}
      <p class="small" style="margin-top:8px"><a style="color:#fde68a" href="${state.user.role === 'tutor' ? '#/tutor/earnings' : '#/receipts'}">🧾 ${state.user.role === 'tutor' ? 'Invoices' : 'Receipts'}</a></p></div>
    <div class="card"><h3>Pending</h3>${[...w.manual.filter((m) => m.status === 'pending').map((m) => `<div class="row between small"><span>UPI top-up · UTR ${esc(m.utr)}</span><span>${rs(m.amount)} ${badge('pending')}</span></div>`),
      ...w.withdrawals.filter((x) => x.status === 'pending').map((x) => `<div class="row between small"><span>Withdrawal to ${esc(x.upi_id)}</span><span>${rs(x.amount)} ${badge('pending')}</span></div>`)].join('') || '<p class="muted small">Nothing pending</p>'}
      ${tutor ? '<p class="small muted">Session payouts are credited here automatically after each completed class (minus platform commission).</p>' : ''}</div></div>
    <div class="card"><h3>Transactions</h3><div class="table-wrap"><table><thead><tr><th>Date</th><th>Details</th><th>Amount</th><th>Balance</th></tr></thead><tbody>
    ${w.txns.map((t) => `<tr><td class="small">${fmtDT(t.created_at)}</td><td>${esc(t.reason)}</td><td style="color:${t.type === 'credit' ? 'var(--ok)' : 'var(--bad)'};font-weight:700">${t.type === 'credit' ? '+' : '−'}${rs(t.amount)}</td><td>${rs(t.balance_after)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No transactions yet</td></tr>'}
    </tbody></table></div></div>`;
  act(v, '#topup', () => modal(`<h3>Add money</h3><form id="t"><label>Amount (₹)</label><input name="amount" type="number" min="10" max="50000" required value="1000">
    <div class="pills" style="margin-top:8px">${[500, 1000, 2000, 5000].map((a) => `<button type="button" class="pill" data-a="${a}">₹${a}</button>`).join('')}</div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Pay</button></div></form>`,
  (m, close) => {
    act(m, '[data-a]', (_e, el) => (m.querySelector('[name=amount]').value = el.dataset.a));
    onSubmit(m, '#t', async (d) => { await api('/wallet/topup', { method: 'POST', body: d }); close(); toast('Money added'); go('#/wallet'); });
  }));
  act(v, '#rzp', () => modal(`<h3>Add money online</h3><form id="z"><label>Amount (₹)</label><input name="amount" type="number" min="10" max="100000" required value="1000">
    <p class="small muted">Pay securely with UPI, card or net banking via Razorpay.</p><div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Pay</button></div></form>`,
  (m, close) => onSubmit(m, '#z', async (d) => {
    const o = await api('/wallet/order', { method: 'POST', body: d });
    await loadRazorpay();
    close();
    const rz = new window.Razorpay({ key: o.key_id, amount: o.amount, currency: 'INR', name: 'Edvitta', description: 'Wallet top-up', order_id: o.order_id,
      prefill: { name: o.name, email: o.email, contact: o.phone }, theme: { color: '#4f46e5' },
      handler: async (resp) => { try { await api('/wallet/order/verify', { method: 'POST', body: resp }); toast('Money added'); go('#/wallet'); } catch (e) { toast(e.message, true); } } });
    rz.open();
  })));
  act(v, '#qr', () => {
    const upiLink = `upi://pay?pa=${encodeURIComponent(w.upi_id)}&pn=${encodeURIComponent(w.upi_name)}&cu=INR`;
    const qrImg = w.qr_image || `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(upiLink)}`;
    modal(`<h3>Pay using any UPI app</h3><div class="center"><img src="${esc(qrImg)}" alt="Edvitta UPI QR" style="width:220px;height:220px;border-radius:12px;border:1px solid var(--line)">
      <p><strong>${esc(w.upi_name)}</strong><br><span class="muted">${esc(w.upi_id)}</span></p><a class="btn ghost sm" href="${esc(upiLink)}">Open UPI app</a></div>
      <hr><p class="small">After paying, enter the amount and the 12-digit UTR / transaction ID from your UPI app. Our team verifies it and adds the money to your wallet.</p>
      <form id="m"><label>Amount paid (₹)</label><input name="amount" type="number" min="10" required>
      <label>UTR / Transaction ID</label><input name="utr" required minlength="6" maxlength="40">
      <label>Payment screenshot (optional)</label><input name="proof" type="file" accept="image/*">
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Submit for verification</button></div></form>`,
    (m, close) => onSubmit(m, '#m', async (_d, f) => { await api('/wallet/manual', { method: 'POST', form: new FormData(f) }); close(); toast('Submitted. We will verify it shortly.'); go('#/wallet'); }));
  });
  act(v, '#wd', () => modal(`<h3>Withdraw to bank (UPI)</h3><form id="w"><label>Amount (₹)</label><input name="amount" type="number" min="100" max="${toRupees(w.balance)}" required>
    <label>Your UPI ID</label><input name="upi_id" placeholder="name@okbank" required><p class="small muted">Withdrawals are processed by our finance team within 24-48 hours.</p>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Request withdrawal</button></div></form>`,
  (m, close) => onSubmit(m, '#w', async (d) => { await api('/wallet/withdraw', { method: 'POST', body: d }); close(); toast('Withdrawal requested'); go('#/wallet'); })));
}, { roles: ['parent', 'tutor'] });

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://checkout.razorpay.com/v1/checkout.js'; sc.onload = res; sc.onerror = () => rej(new Error('Could not load payment page')); document.head.appendChild(sc); });
}

// ---------- Referrals ----------
route('/referrals', async () => {
  const v = shell('Refer & earn');
  const r = await api('/referrals');
  const link = `${location.origin}/#/register?ref=${r.code}`;
  v.innerHTML = `<div class="card" style="text-align:center"><div style="font-size:2.5rem">🎁</div><h2>Give ${rs(r.bonus_referee)}, get ${rs(r.bonus_referrer)}</h2>
    <p class="muted">Share your code. When your friend's first booking is confirmed (or a tutor you referred is verified), you both get wallet money.</p>
    <div class="otp" style="display:inline-block;margin:8px 0">${esc(r.code)}</div>
    <div class="row" style="justify-content:center"><button class="btn" id="cp">Copy invite link</button>
    <a class="btn ghost" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent('Join Edvitta for verified tutors near you! Use my code ' + r.code + ' ' + link)}">Share on WhatsApp</a></div>
    <p class="small muted" style="margin-top:10px">Total earned: <strong>${rs(r.earned)}</strong></p></div>
    <div class="card"><h3>Friends you invited (${r.people.length})</h3>${r.people.map((p) => `<div class="row between" style="padding:6px 0"><span>${esc(p.name)} ${badge(p.role)}</span>${p.referral_rewarded ? badge('paid') : '<span class="badge grey">waiting</span>'}</div>`).join('') || '<p class="muted">No invites yet</p>'}</div>`;
  act(v, '#cp', async () => { await navigator.clipboard.writeText(link); toast('Invite link copied'); });
}, { roles: ['parent', 'tutor'] });

// ---------- Advertise ----------
route('/ads', async () => {
  const v = shell('Advertise on Edvitta');
  const { items, prices } = await api('/my-ads');
  v.innerHTML = `<div class="grid g2"><div class="card"><h3>Promote your classes or business</h3>
    <p class="muted small">Your ad is shown to parents in your chosen section. Paid from your wallet; reviewed by our team before it goes live. Rejected ads are refunded.</p>
    <form id="f"><label>Title</label><input name="title" maxlength="80" required><label>Description</label><textarea name="body" maxlength="300"></textarea>
    <label>Link (optional, https://)</label><input name="link" type="url" placeholder="https://">
    <label>Image (optional)</label><input name="image" type="file" accept="image/*">
    <div class="grid g2"><div><label>Placement</label><select name="placement">${Object.entries(prices).map(([k, p]) => `<option value="${k}">${k} · ${rs(p)}/day</option>`).join('')}</select></div>
    <div><label>Days</label><input name="days" type="number" min="1" max="90" value="7" required></div></div>
    <p class="small" id="cost"></p><button class="btn" type="submit">Pay & submit for review</button></form></div>
    <div class="card"><h3>My ads</h3>${items.map((a) => `<div class="msg"><div class="row between"><strong>${esc(a.title)}</strong>${badge(a.status)}</div>
      <div class="small muted">${esc(a.placement)} · ${a.days} days · ${rs(a.price)} · 👁 ${a.impressions} · 🖱 ${a.clicks}</div></div>`).join('') || '<p class="muted">No ads yet</p>'}</div></div>`;
  const f = v.querySelector('#f');
  const cost = () => (v.querySelector('#cost').textContent = 'Total: ' + rs(prices[f.placement.value] * (+f.days.value || 0)));
  f.addEventListener('input', cost); cost();
  onSubmit(v, '#f', async (_d, form) => { await api('/my-ads', { method: 'POST', form: new FormData(form) }); toast('Ad submitted for review'); go('#/ads'); });
}, { roles: ['parent', 'tutor'] });

// ---------- Support / helpline tickets ----------
const TCATS = ['booking', 'payment', 'wallet', 'safety', 'tutor', 'kyc', 'community', 'account', 'general'];
route('/support', async () => {
  const v = shell('Help & support');
  const { items } = await api('/tickets');
  v.innerHTML = `<div class="alert bad"><strong>Child safety emergency?</strong> Use the red SOS button on your booking page, or call 112. Our team is alerted instantly.</div>
    <div class="grid g2"><div class="card"><h3>Raise a ticket</h3><form id="f"><label>Category</label><select name="category">${TCATS.map((c) => `<option>${c}</option>`).join('')}</select>
    <label>Subject</label><input name="subject" maxlength="120" required><label>Describe the issue</label><textarea name="message" required maxlength="3000"></textarea>
    <label>Booking number (optional)</label><input name="booking_id" type="number" min="1"><button class="btn" type="submit" style="margin-top:12px">Submit</button></form></div>
    <div class="card"><h3>My tickets</h3>${items.map((t) => `<a class="msg" style="display:block;color:inherit" href="#/support/${t.id}"><div class="row between"><strong>#${t.id} ${esc(t.subject)}</strong>${badge(t.status)}</div>
    <div class="small muted">${esc(t.category)} · updated ${fmtDT(t.updated_at)}</div></a>`).join('') || '<p class="muted">No tickets</p>'}</div></div>`;
  onSubmit(v, '#f', async (d) => { const { id } = await api('/tickets', { method: 'POST', body: d }); toast('Ticket created'); go('#/support/' + id); });
}, { roles: ['parent', 'tutor'] });

export async function ticketView(id, staffView) {
  const v = shell(`Ticket #${id}`);
  const { ticket: t, messages, staff } = await api('/tickets/' + id);
  v.innerHTML = `<div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(240px,1fr)"><div class="card"><div class="row between"><h3 style="margin:0">${esc(t.subject)}</h3>${badge(t.status)}</div>
    <p class="small muted">${esc(t.category)} · ${badge(t.priority)} · opened ${fmtDT(t.created_at)} ${t.booking_id ? `· booking #${t.booking_id}` : ''}</p><hr>
    ${messages.map((m) => `<div class="msg ${m.internal ? 'internal' : /Support/.test(m.author) ? 'staff' : ''}"><div class="small"><strong>${esc(m.author)}</strong> · ${fmtDT(m.created_at)}${m.internal ? ' · 🔒 internal note' : ''}</div><div style="white-space:pre-wrap">${esc(m.body)}</div></div>`).join('')}
    ${t.status !== 'closed' ? `<form id="r"><textarea name="body" required placeholder="Write a reply…"></textarea>${staffView ? '<label class="chk"><input type="checkbox" name="internal" value="1"> Internal note (not visible to user)</label>' : ''}
    <button class="btn" type="submit" style="margin-top:8px">Send</button></form>` : '<p class="muted">This ticket is closed.</p>'}</div>
    ${staffView ? `<div class="card"><h3>Customer</h3><dl class="kv"><dt>Name</dt><dd>${esc(t.user_name)} ${badge(t.user_role)}</dd><dt>Phone</dt><dd><a href="tel:${esc(t.user_phone)}">${esc(t.user_phone)}</a></dd><dt>Email</dt><dd>${esc(t.user_email)}</dd></dl><hr>
      <form id="u"><label>Status</label><select name="status">${['open', 'in_progress', 'resolved', 'closed'].map((s) => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <label>Priority</label><select name="priority">${['low', 'normal', 'high', 'urgent'].map((s) => `<option ${s === t.priority ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <label>Assigned to</label><select name="assigned_to"><option value="">Unassigned</option>${staff.map((s) => `<option value="${s.id}" ${s.id === t.assigned_to ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <button class="btn" type="submit" style="margin-top:12px">Update ticket</button></form></div>` : ''}</div>`;
  onSubmit(v, '#r', async (d) => { await api(`/tickets/${id}/reply`, { method: 'POST', body: { body: d.body, internal: !!d.internal } }); ticketView(id, staffView); });
  onSubmit(v, '#u', async (d) => { await api(`/tickets/${id}/update`, { method: 'POST', body: d }); toast('Ticket updated'); ticketView(id, staffView); });
}
route('/support/:id', ({ params }) => ticketView(params.id, false), { roles: ['parent', 'tutor'] });

// ---------- Community groups ----------
const groupCard = (g) => `<a class="card" style="display:block;color:inherit" href="#/community/${g.id}"><div class="row between"><strong>${catIcon(g.category)} ${esc(g.name)}</strong>${badge(g.status)}</div>
  <div class="small muted">🏢 ${esc(g.apartment)} · ${esc(catName(g.category))}${g.grade ? ' · ' + esc(g.grade) : ''}</div>
  <div class="row between small" style="margin-top:6px"><span>👧 ${g.member_count}/${g.max_members} children</span><strong>${rs(g.fee)} / child</strong></div>
  ${g.tutor ? `<div class="small">🧑‍🏫 Tutor: ${esc(g.tutor.name)}</div>` : '<div class="small muted">Tutor not chosen yet</div>'}</a>`;

route('/community', async ({ query }) => {
  const v = shell('Community groups');
  const isParent = state.user.role === 'parent';
  v.innerHTML = `<p class="muted">Apartment and society groups: one parent starts a batch for a class or skill, other parents join their children by paying the group fee.</p>
    <div class="tabs"><a href="#/community" class="${query.tab !== 'mine' ? 'on' : ''}">Near me</a><a href="#/community?tab=mine" class="${query.tab === 'mine' ? 'on' : ''}">My groups</a></div>
    <div class="row" style="margin-bottom:12px"><input id="s" placeholder="Search apartment, society or subject" style="flex:1;min-width:200px"><button class="btn ghost" id="sb">Search</button>
    ${isParent ? '<button class="btn" id="new">+ Create group</button>' : ''}</div><div id="ad"></div><div id="list" class="grid g2"><div class="empty">Loading…</div></div>`;
  const list = v.querySelector('#list');
  const load = async (search) => {
    let url = '/groups';
    if (query.tab === 'mine') url = '/groups/mine';
    else if (search) url += '?search=' + encodeURIComponent(search);
    else { try { const p = await myLocation(); url += `?lat=${p.lat}&lng=${p.lng}`; } catch { /* show all if no location */ } }
    const { items } = await api(url);
    list.innerHTML = items.map(groupCard).join('') || '<div class="empty card">No groups found. Try searching your apartment name.</div>';
  };
  act(v, '#sb', () => load(v.querySelector('#s').value.trim()));
  act(v, '#new', () => go('#/community/new'));
  v.querySelector('#ad').innerHTML = await adSlot('community');
  load();
}, { roles: ['parent', 'tutor'] });

route('/community/new', () => {
  const v = shell('Create a community group');
  let loc = null;
  v.innerHTML = `<div class="card"><form id="f"><div class="grid g2"><div><label>Group name</label><input name="name" required placeholder="e.g. Class 5 Maths Batch"></div>
    <div><label>Apartment / society</label><input name="apartment" required placeholder="e.g. Prestige Acropolis, Koramangala"></div>
    <div><label>Subject / skill</label><select name="category">${state.categories.map((c) => `<option value="${c.slug}">${c.icon} ${esc(c.name)}</option>`).join('')}</select></div>
    <div><label>Class / level</label><input name="grade" placeholder="e.g. Class 5, Beginners"></div>
    <div><label>Joining fee per child (₹)</label><input name="fee" type="number" min="1" required></div>
    <div><label>Max children</label><input name="max_members" type="number" min="2" max="50" value="10" required></div></div>
    <label>Schedule</label><input name="schedule" placeholder="e.g. Mon, Wed, Fri 5-6 PM at clubhouse">
    <label>Description</label><textarea name="description"></textarea>
    <label>Group location</label><div id="lp"></div>
    <p class="small muted">Fees are held safely by Edvitta and released to the tutor you choose. If the group closes before a tutor is chosen, everyone is refunded.</p>
    <button class="btn" type="submit">Create group</button></form></div>`;
  locationPicker(v.querySelector('#lp'), null, (p) => (loc = p));
  onSubmit(v, '#f', async (d) => {
    if (!loc) throw new Error('Set the group location on the map');
    const { id } = await api('/groups', { method: 'POST', body: { ...d, lat: loc.lat, lng: loc.lng } });
    toast('Group created! Join your own child to it too.'); go('#/community/' + id);
  });
}, { roles: ['parent'] });

route('/community/:id', async ({ params }) => {
  const v = shell('Community group');
  const { group: g } = await api('/groups/' + params.id);
  const isParent = state.user.role === 'parent';
  const kids = isParent ? (await api('/children')).items : [];
  v.innerHTML = `<div class="grid g2"><div class="card"><div class="row between"><h2>${catIcon(g.category)} ${esc(g.name)}</h2>${badge(g.status)}</div>
    <dl class="kv"><dt>Apartment</dt><dd>${esc(g.apartment)}</dd><dt>Subject</dt><dd>${esc(catName(g.category))}</dd><dt>Level</dt><dd>${esc(g.grade || '-')}</dd>
    <dt>Schedule</dt><dd>${esc(g.schedule || '-')}</dd><dt>Fee</dt><dd><strong>${rs(g.fee)}</strong> per child</dd><dt>Seats</dt><dd>${g.member_count}/${g.max_members}</dd>
    <dt>Started by</dt><dd>${esc(g.creator)}</dd><dt>Tutor</dt><dd>${g.tutor ? esc(g.tutor.name) : '<span class="muted">Not chosen yet</span>'}</dd></dl>
    <p style="white-space:pre-wrap">${esc(g.description || '')}</p>
    ${isParent && g.status === 'open' ? `<hr><h3>Join with your child</h3>${kids.length ? `<form id="j"><select name="child_id">${kids.map((k) => `<option value="${k.id}">${esc(k.name)} (${esc(k.grade || '')})</option>`).join('')}</select>
      <button class="btn" type="submit" style="margin-top:8px">Pay ${rs(g.fee)} from wallet & join</button></form>` : '<p><a href="#/parent/children">Add your child first</a></p>'}` : ''}
    ${g.is_creator && g.status !== 'closed' ? `<hr><div class="row">${!g.tutor ? '<button class="btn ghost" id="pick">Choose tutor</button>' : ''}<button class="btn bad sm" id="close">Close group</button></div>` : ''}</div>
    <div class="card"><h3>Children in this group</h3>${g.is_member ? (g.members.map((m) => `<div class="row" style="padding:4px 0"><div class="avatar sm">${esc(initials(m.child))}</div><div>${esc(m.child)} <span class="small muted">${esc(m.grade || '')} · parent ${esc(m.parent)}</span></div></div>`).join('') || '<p class="muted">No children yet</p>')
      : `<p class="muted">${g.member_count} children joined. Names are visible only to group members, for privacy.</p>`}</div></div>`;
  onSubmit(v, '#j', async (d) => { if (await confirmBox(`Pay ${rs(g.fee)} from your wallet to join?`, 'Pay & join')) { await api(`/groups/${g.id}/join`, { method: 'POST', body: d }); toast('Joined!'); go('#/community/' + g.id); } });
  act(v, '#close', async () => { if (await confirmBox('Close this group? If no tutor was chosen, all members are refunded.')) { await api(`/groups/${g.id}/close`, { method: 'POST' }); go('#/community/' + g.id); } });
  act(v, '#pick', async () => {
    let tutors = [];
    try { const p = await myLocation(); tutors = (await api(`/tutors?mode=offline&category=${g.category}&lat=${p.lat}&lng=${p.lng}`)).items; } catch (e) { toast(e.message, true); }
    modal(`<h3>Choose a verified tutor</h3>${tutors.map((t) => `<div class="row between msg"><div><strong>${esc(t.name)}</strong><div class="small muted">${t.distance_km} km · ⭐ ${t.rating ?? 'new'} · ${t.experience_years} yrs</div></div><button class="btn sm" data-t="${t.id}">Choose</button></div>`).join('') || '<p class="muted">No available tutors for this subject within range right now.</p>'}
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Close</button></div>`,
    (m, close) => act(m, '[data-t]', async (_e, el) => { await api(`/groups/${g.id}/tutor`, { method: 'POST', body: { tutor_id: +el.dataset.t } }); close(); toast('Tutor assigned'); go('#/community/' + g.id); }));
  });
}, { roles: ['parent', 'tutor', 'admin', 'staff'] });
