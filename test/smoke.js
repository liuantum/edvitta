'use strict';
// End-to-end API smoke test against a fresh temporary database.
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'edv-'));
process.env.SEED_DEMO = '1';
process.env.AUTH_RATE_LIMIT = '200';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
const { server } = require('../server/index.js');
const assert = require('assert');

function client(base) {
  let cookie = '';
  const fn = async (method, url, body, form) => {
    const headers = { 'X-Requested-With': 'edvitta', cookie };
    let payload;
    if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + '/api' + url, { method, headers, body: payload, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => ({}));
    fn.cookie = cookie;
    return { status: r.status, ...j };
  };
  return fn;
}
const ok = (r, msg) => { if (r.status >= 400) throw new Error(`${msg}: ${r.status} ${r.error}`); return r; };

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  let pass = 0; const t = (name) => { pass++; console.log('  ✓', name); };
  try {
    const anon = client(base);
    assert.equal((await fetch(base + '/api/auth/me', { method: 'POST' })).status, 403); t('CSRF header required on writes');
    assert.equal((await anon('GET', '/tutors?mode=online')).status, 401); t('Tutor search needs login');
    assert.equal((await anon('POST', '/auth/register', { role: 'admin', name: 'X', email: 'x@x.in', phone: '9111111111', password: 'abc12345' })).status, 400); t('Cannot self-register as admin');

    // Parent signs up with a referral code from the demo parent
    const demoParent = client(base); ok(await demoParent('POST', '/auth/login', { login: 'parent@demo.in', password: 'Demo@1234' }), 'demo login');
    const refCode = (await demoParent('GET', '/referrals')).code;
    const parent = client(base);
    ok(await parent('POST', '/auth/register', { role: 'parent', name: 'Test Parent', email: 'tp@test.in', phone: '9123456780', password: 'Passw0rd!', referral_code: refCode }), 'register');
    t('Parent registers with referral code');
    ok(await parent('POST', '/children', { name: 'Kid', grade: 'Class 3', age: 8 }), 'child');
    const kid = (await parent('GET', '/children')).items[0];
    ok(await parent('POST', '/wallet/topup', { amount: 5000 }), 'topup'); t('Wallet top-up (demo gateway)');

    // 3 km search
    const near = await parent('GET', '/tutors?mode=offline&category=maths&lat=12.934&lng=77.623');
    assert.ok(near.items.length >= 1 && near.items[0].distance_km <= 3); assert.equal(near.items[0].lat, undefined); t('Finds tutors within 3 km, hides exact coordinates');
    const far = await parent('GET', '/tutors?mode=offline&category=maths&lat=13.2&lng=77.7');
    assert.equal(far.items.length, 0); t('No tutors outside the radius');
    const tutorId = near.items[0].id;

    // Book with coupon, custom days
    const start = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 330 * 60000 + 13 * 86400000).toISOString().slice(0, 10);
    const bk = { tutor_id: tutorId, child_id: kid.id, category: 'maths', mode: 'offline', schedule_type: 'daily', start_date: start, end_date: start,
      time: '17:00', duration_min: 60, address: '12 Test Street, Koramangala', lat: 12.934, lng: 77.623, coupon: 'WELCOME20' };
    bk.schedule_type = 'custom'; bk.end_date = end; bk.days = [1, 3, 5];
    const qt = ok(await parent('POST', '/bookings/quote', bk), 'quote');
    assert.ok(qt.discount > 0 && qt.amount === qt.gross - qt.discount); t(`Quote: ${qt.sessions} sessions, coupon discount applied`);
    const before = (await parent('GET', '/wallet')).balance;
    const { id: bookingId } = ok(await parent('POST', '/bookings', bk), 'book');
    assert.equal((await parent('GET', '/wallet')).balance, before - qt.amount); t('Booking amount held from wallet');
    assert.equal((await parent('POST', '/bookings/quote', bk)).status, 400); t('Coupon cannot be reused');

    // Tutor sees masked details, accepts
    const tutor = client(base); ok(await tutor('POST', '/auth/login', { login: near.items[0].id === tutorId ? 'tutor@demo.in' : '', password: 'Demo@1234' }), 'tutor login');
    let tb = (await tutor('GET', '/bookings/' + bookingId)).booking;
    assert.equal(tb.parent.phone, undefined); assert.equal(tb.lat, null); t('Parent phone & exact address hidden before acceptance');
    ok(await tutor('POST', `/bookings/${bookingId}/respond`, { accept: true }), 'accept');
    tb = (await tutor('GET', '/bookings/' + bookingId)).booking;
    assert.ok(tb.parent.phone === undefined && tb.parent.name === 'Test Parent' && tb.sessions.length === qt.sessions && tb.sessions[0].start_otp === undefined); t('Accepted: sessions created, OTP hidden from tutor, phone stays masked');
    const refAfter = (await demoParent('GET', '/referrals'));
    assert.ok(refAfter.earned > 0); t('Referral reward paid on first accepted booking');

    // Session flow with OTP + live location
    const pb = (await parent('GET', '/bookings/' + bookingId)).booking;
    const s0 = pb.sessions[0];
    assert.equal((await tutor('POST', `/sessions/${pb.sessions[1].id}/start`, { otp: pb.sessions[1].start_otp })).status, 400); t('Future classes cannot be started early');
    require('../server/db').q.run('UPDATE sessions SET date = ? WHERE id = ?', start, s0.id); // make the first class "today"
    ok(await tutor('POST', `/sessions/${s0.id}/on-the-way`), 'otw');
    assert.equal((await tutor('POST', `/sessions/${s0.id}/start`, { otp: '0000' === s0.start_otp ? '1111' : '0000' })).status, 400); t('Wrong start code rejected');
    ok(await tutor('POST', `/sessions/${s0.id}/start`, { otp: s0.start_otp }), 'start'); t('Session starts with parent OTP');
    const stranger = client(base); ok(await stranger('POST', '/auth/login', { login: 'parent2@demo.in', password: 'Demo@1234' }), 'p2');
    assert.equal((await stranger('GET', `/bookings/${bookingId}/location`)).status, 403); t('Other parents cannot see tutor location');
    const tw0 = (await tutor('GET', '/wallet')).balance;
    const done = ok(await tutor('POST', `/sessions/${s0.id}/complete`), 'complete');
    assert.equal((await tutor('GET', '/wallet')).balance, tw0 + done.payout); t(`Tutor paid ${done.payout / 100} after session (minus commission)`);
    ok(await parent('POST', `/bookings/${bookingId}/review`, { rating: 5, comment: 'Great' }), 'review'); t('Parent reviews tutor');
    const pw0 = (await parent('GET', '/wallet')).balance;
    const c = ok(await parent('POST', `/bookings/${bookingId}/cancel`), 'cancel');
    assert.ok(c.refund > 0 && (await parent('GET', '/wallet')).balance === pw0 + c.refund); t('Cancel refunds remaining sessions');

    // Online booking with link
    const on = ok(await parent('POST', '/bookings', { tutor_id: tutorId, child_id: kid.id, category: 'maths', mode: 'online', schedule_type: 'once', start_date: start, time: '18:00' }), 'online');
    assert.equal((await tutor('POST', `/bookings/${on.id}/respond`, { accept: true, meeting_link: 'javascript:alert(1)' })).status, 400); t('Rejects unsafe meeting links');
    ok(await tutor('POST', `/bookings/${on.id}/respond`, { accept: true, meeting_link: 'https://meet.google.com/abc-defg-hij' }), 'accept online');
    assert.ok((await parent('GET', '/bookings/' + on.id)).booking.meeting_link.startsWith('https://meet')); t('Online class link shared');

    // KYC flow
    const nt = client(base);
    ok(await nt('POST', '/auth/register', { role: 'tutor', name: 'New Tutor', email: 'nt@test.in', phone: '9123456781', password: 'Passw0rd!' }), 'nt');
    ok(await nt('PUT', '/me/profile', { categories: ['drawing', 'bogus'], rate_per_session: 300, mode: 'both', lat: 12.93, lng: 77.62, address: 'HSR' }), 'profile');
    assert.equal((await nt('POST', '/me/availability', { available: true })).status, 400); t('Unverified tutor cannot go online');
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const fake = new FormData(); fake.append('doc_type', 'pan'); fake.append('file', new Blob([Buffer.from('<script>alert(1)</script>')]), 'x.png');
    assert.equal((await nt('POST', '/me/kyc', null, fake)).status, 400); t('Rejects non-image files disguised as PNG');
    for (const d of ['aadhaar_front', 'aadhaar_back', 'pan', 'photo']) { const f = new FormData(); f.append('doc_type', d); f.append('file', new Blob([png]), d + '.png'); ok(await nt('POST', '/me/kyc', null, f), 'upload ' + d); }
    ok(await nt('POST', '/me/kyc/submit'), 'submit'); t('Tutor uploads KYC & submits');
    const ntId = (await nt('GET', '/auth/me')).user.id;
    assert.equal((await parent('GET', '/admin/kyc')).status, 403); t('Parents blocked from admin APIs');
    const staff = client(base); ok(await staff('POST', '/auth/login', { login: 'staff@demo.in', password: 'Demo@1234' }), 'staff');
    const k = await staff('GET', '/admin/kyc/' + ntId); assert.equal(k.docs.length, 4);
    const docRes = await fetch(`${base}/api/admin/kyc-doc/${k.docs[0].id}`); assert.equal(docRes.status, 401); t('KYC documents not public');
    ok(await staff('POST', `/admin/kyc/${ntId}/decision`, { decision: 'approved' }), 'approve'); 
    ok(await nt('POST', '/me/availability', { available: true }), 'online'); t('Staff approves KYC, tutor goes online');
    assert.equal((await staff('GET', '/admin/coupons')).status, 403); t('Staff cannot access admin-only coupons');

    // Manual UPI payment
    ok(await parent('POST', '/wallet/manual', null, (() => { const f = new FormData(); f.append('amount', '750'); f.append('utr', 'UTR123456789'); return f; })()), 'manual');
    assert.equal((await parent('POST', '/wallet/manual', null, (() => { const f = new FormData(); f.append('amount', '750'); f.append('utr', 'UTR123456789'); return f; })())).status, 400); t('Duplicate UTR rejected');
    const pend = await staff('GET', '/admin/payments'); const mp = pend.items.find((m) => m.utr === 'UTR123456789');
    const pw1 = (await parent('GET', '/wallet')).balance;
    ok(await staff('POST', `/admin/payments/${mp.id}/decision`, { decision: 'approved' }), 'approve pay');
    assert.equal((await parent('GET', '/wallet')).balance, pw1 + 75000); t('Manual QR payment verified & credited');

    // Community group
    const grp = (await parent('GET', '/groups?search=Prestige')).items[0];
    assert.equal(grp.members.length, 0); t('Non-members cannot see children in a group');
    ok(await parent('POST', `/groups/${grp.id}/join`, { child_id: kid.id }), 'join');
    assert.equal((await parent('POST', `/groups/${grp.id}/join`, { child_id: kid.id })).status, 400); t('Parent pays & joins community group (once)');
    const admin = client(base); ok(await admin('POST', '/auth/login', { login: 'admin@edvitta.local', password: 'Admin@12345' }), 'admin');
    const ag = (await admin('GET', '/admin/groups')).items.find((g) => g.id === grp.id); assert.equal(ag.escrow, grp.fee); t('Group fee held in escrow');

    // Ads
    const adf = new FormData(); adf.append('title', 'My Art Class'); adf.append('placement', 'home'); adf.append('days', '1');
    const ad = ok(await tutor('POST', '/my-ads', null, adf), 'ad');
    ok(await admin('POST', `/admin/ads/${ad.id}/decision`, { action: 'approve' }), 'approve ad'); t('Paid ad created & approved');

    // Tickets
    const tk = ok(await parent('POST', '/tickets', { subject: 'Tutor late', message: 'Tutor was 30 min late', category: 'booking' }), 'ticket');
    ok(await staff('POST', `/tickets/${tk.id}/reply`, { body: 'Internal: check', internal: true }), 'internal');
    ok(await staff('POST', `/tickets/${tk.id}/reply`, { body: 'Sorry! We have spoken to the tutor.' }), 'reply');
    const pt = await parent('GET', '/tickets/' + tk.id);
    assert.equal(pt.messages.length, 2); assert.equal(pt.ticket.status, 'in_progress'); t('Staff solves ticket; internal notes hidden from parent');
    assert.equal((await stranger('GET', '/tickets/' + tk.id)).status, 403); t('Users cannot read others\' tickets');

    // SOS + withdrawal + lockout
    ok(await parent('POST', '/sos', { booking_id: bookingId, message: 'test' }), 'sos');
    assert.ok((await staff('GET', '/admin/sos')).items.length === 1); t('SOS alert reaches staff');
    ok(await tutor('POST', '/wallet/topup', { amount: 500 }), 'tutor topup');
    ok(await tutor('POST', '/wallet/withdraw', { amount: 100, upi_id: 'meera@okaxis' }), 'withdraw'); t('Tutor requests withdrawal');
    const bad = client(base);
    for (let i = 0; i < 5; i++) await bad('POST', '/auth/login', { login: 'parent2@demo.in', password: 'wrong' });
    assert.equal((await bad('POST', '/auth/login', { login: 'parent2@demo.in', password: 'Demo@1234' })).status, 429); t('Account locks after 5 failed logins');


    // ================= Round 2 features =================
    const cfg = await anon('GET', '/config');
    assert.equal(cfg.online_payments, false); assert.equal((await parent('POST', '/wallet/order', { amount: 100 })).status, 400); t('Online gateway is OFF by default');
    assert.equal((await fetch(base + '/api/payments/razorpay/webhook', { method: 'POST', body: '{}' })).status, 400); t('Webhook rejects unsigned calls');

    // Email OTP login + password reset (dev mode prints the code because SMTP isn't configured)
    const otpUser = client(base);
    const oreq = await otpUser('POST', '/auth/otp/request', { email: 'tp@test.in', purpose: 'login' });
    assert.ok(oreq.dev_code); assert.equal((await otpUser('POST', '/auth/otp/login', { email: 'tp@test.in', code: '000000' === oreq.dev_code ? '111111' : '000000' })).status, 400);
    ok(await otpUser('POST', '/auth/otp/login', { email: 'tp@test.in', code: oreq.dev_code }), 'otp login'); t('Login with 6-digit email code (wrong code rejected)');
    assert.ok((await otpUser('GET', '/auth/me')).user.email_verified); t('Email marked verified after OTP login');
    const ghost = await anon('POST', '/auth/otp/request', { email: 'nobody@nowhere.in', purpose: 'login' });
    assert.ok(ghost.ok && !ghost.dev_code); t('OTP request does not reveal whether an email exists');
    const rr = await anon('POST', '/auth/otp/request', { email: 'parent2@demo.in', purpose: 'reset' });
    ok(await anon('POST', '/auth/password/reset', { email: 'parent2@demo.in', code: rr.dev_code, password: 'NewPass123' }), 'reset');
    const p2b = client(base); ok(await p2b('POST', '/auth/login', { login: 'parent2@demo.in', password: 'NewPass123' }), 'login new pw'); t('Forgot-password reset by email code');

    // Admin config: secrets are write-only; require email verification
    ok(await admin('POST', '/admin/config', { smtp_user: 'no-reply@edvitta.in', smtp_pass: 'S3cret!', commission_percent: 20, gst_enabled: '1', gst_percent: 18 }), 'config');
    const ac = await admin('GET', '/admin/config');
    const smtpPass = ac.items.find((i) => i.key === 'smtp_pass'); assert.ok(smtpPass.is_set && smtpPass.value === ''); t('SMTP password saved encrypted and never sent back');
    assert.equal((await staff('GET', '/admin/config')).status, 403); t('Only admin can change config');
    ok(await admin('POST', '/admin/config', { smtp_pass: '', clear_secrets: ['smtp_pass'], smtp_user: '', require_email_verification: '1' }), 'cfg2');
    const unv = client(base); ok(await unv('POST', '/auth/register', { role: 'parent', name: 'Unverified P', email: 'uv@test.in', phone: '9123456782', password: 'Passw0rd!' }), 'reg uv');
    ok(await unv('POST', '/children', { name: 'K2' }), 'child2'); const k2 = (await unv('GET', '/children')).items[0];
    const onlineBk = { tutor_id: tutorId, child_id: k2.id, category: 'maths', mode: 'online', schedule_type: 'trial', start_date: start, time: '18:00' };
    assert.equal((await unv('POST', '/bookings', onlineBk)).status, 403); t('Unverified email blocked from booking when admin requires it');
    const vs = await unv('POST', '/auth/verify-email/send'); ok(await unv('POST', '/auth/verify-email', { code: vs.dev_code }), 'verify');
    // Trial class: free, one per tutor
    const trial = ok(await unv('POST', '/bookings', onlineBk), 'trial');
    assert.equal((await unv('GET', '/bookings/' + trial.id)).booking.amount, 0); t('Email verified, free trial class booked');
    assert.equal((await unv('POST', '/bookings', onlineBk)).status, 400); t('Only one trial per tutor');
    ok(await admin('POST', '/admin/config', { require_email_verification: '0' }), 'cfg3');

    // Packages
    const pk = (await parent('GET', '/packages')).items.find((x) => x.sessions === 8);
    const pq = ok(await parent('POST', '/bookings/quote', { tutor_id: tutorId, child_id: kid.id, category: 'maths', mode: 'online', schedule_type: 'custom', days: [1, 3], start_date: start, time: '19:00', package_id: pk.id }), 'pkg quote');
    assert.equal(pq.sessions, 8); assert.equal(pq.rate, Math.round(pq.base_rate * (100 - pk.discount_percent) / 100)); t(`Package: 8 classes at ${pk.discount_percent}% off`);
    const pkb = ok(await parent('POST', '/bookings', { tutor_id: tutorId, child_id: kid.id, category: 'maths', mode: 'online', schedule_type: 'custom', days: [1, 3], start_date: start, time: '19:00', package_id: pk.id }), 'pkg book');
    ok(await tutor('POST', `/bookings/${pkb.id}/respond`, { accept: true }), 'acc pkg');

    // Commission 20% + GST 18% applied to payout and invoice
    const ps = (await tutor('GET', '/bookings/' + pkb.id)).booking;
    const s1 = ps.sessions[0]; require('../server/db').q.run('UPDATE sessions SET date = ? WHERE id = ?', start, s1.id);
    ok(await tutor('POST', `/sessions/${s1.id}/start`), 'start online');
    const pay2 = ok(await tutor('POST', `/sessions/${s1.id}/complete`), 'complete2');
    const comm = Math.round(pq.rate * 0.2), gst = Math.round(comm * 0.18);
    assert.equal(pay2.payout, pq.rate - comm - gst);
    const earn = await tutor('GET', '/earnings');
    const inv = earn.invoices.find((i) => i.type === 'commission' && i.gross === pq.rate);
    assert.ok(inv && inv.commission === comm && inv.gst === gst); t(`Invoice uses admin commission 20% + 18% GST (payout ₹${pay2.payout / 100})`);
    const invView = await tutor('GET', '/invoices/' + inv.id); assert.ok(invView.invoice.number.includes('/C/'));
    assert.equal((await parent('GET', '/invoices/' + inv.id)).status, 403); t('Invoices private to their owner');
    assert.ok((await parent('GET', '/invoices')).items.some((i) => i.type === 'booking')); t('Parents get payment receipts');
    ok(await tutor('GET', '/statements/' + new Date().toISOString().slice(0, 7)), 'statement'); t('Monthly earnings statement');

    // Per-class rating
    ok(await parent('POST', `/sessions/${s1.id}/review`, { rating: 4, punctuality: 5, teaching: 4, comment: 'Good' }), 'sreview');
    assert.equal((await parent('POST', `/sessions/${s1.id}/review`, { rating: 4 })).status, 400); t('Rate each class once');

    // Chat masks phone numbers; strangers blocked
    const cm = ok(await parent('POST', `/bookings/${pkb.id}/messages`, { body: 'Call me on 98765 43210 or mail me@x.com' }), 'chat');
    assert.ok(!/98765/.test(cm.message.body) && !/me@x.com/.test(cm.message.body) && cm.notice); t('Chat hides phone numbers and emails');
    assert.equal((await tutor('GET', `/bookings/${pkb.id}/messages`)).items.length, 1);
    assert.equal((await p2b('GET', `/bookings/${pkb.id}/messages`)).status, 403); t('Only the booking parent & tutor can read chat');
    assert.equal((await parent('POST', `/bookings/${pkb.id}/call`)).status, 400); t('Masked calls stay off until configured');

    // Progress & homework
    ok(await tutor('POST', `/bookings/${pkb.id}/progress`, { session_id: s1.id, topics: 'Fractions', understanding: 4 }), 'progress');
    ok(await tutor('POST', `/bookings/${pkb.id}/homework`, { title: 'Worksheet 3', due_date: end }), 'hw');
    const pb2 = (await parent('GET', '/bookings/' + pkb.id)).booking;
    assert.equal(pb2.progress.length, 1); ok(await parent('POST', `/homework/${pb2.homework[0].id}`, { note: 'Done!' }), 'hw done');
    assert.equal((await p2b('POST', `/homework/${pb2.homework[0].id}`, {})).status, 403); t('Progress report + homework flow');

    // Video config: online only
    assert.ok((await parent('GET', `/video/${pkb.id}/config`)).iceServers.length); assert.equal((await parent('GET', `/video/${bookingId}/config`)).status, 400); t('Video class available for online bookings only');

    // Background check flagged -> hidden from search
    const before2 = (await parent('GET', '/tutors?mode=online&category=maths')).items.length;
    ok(await staff('POST', `/admin/kyc/${tutorId}/background`, { status: 'flagged', note: 'Reference mismatch' }), 'flag');
    assert.equal((await parent('GET', '/tutors?mode=online&category=maths')).items.length, before2 - 1); t('Flagged background check hides tutor');
    ok(await staff('POST', `/admin/kyc/${tutorId}/background`, { status: 'clear', police_verified: true }), 'clear');
    ok(await tutor('POST', '/me/availability', { available: true }), 'back online');
    assert.ok((await parent('GET', `/tutors/${tutorId}`)).tutor.fully_verified); t('KYC + police + background clear = Verified badge');


    // ---------- Round 3: attendance, holidays, rescheduling ----------
    const { q: dbq } = require('../server/db');
    const schedule = require('../server/schedule');
    const ist = (n = 0) => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);
    ok(await parent('POST', '/wallet/topup', { amount: 5000 }), 'topup2');
    const ab = ok(await parent('POST', '/bookings', { tutor_id: tutorId, child_id: kid.id, category: 'maths', mode: 'online', schedule_type: 'daily', start_date: ist(), end_date: ist(4), time: '07:00' }), 'att book');
    ok(await tutor('POST', `/bookings/${ab.id}/respond`, { accept: true }), 'att accept');
    let abk = (await tutor('GET', '/bookings/' + ab.id)).booking;
    assert.equal(abk.sessions.length, 5);
    const todayS = abk.sessions.find((x) => x.date === ist());
    const futureS = abk.sessions.find((x) => x.date === ist(2));
    assert.equal((await tutor('POST', `/sessions/${futureS.id}/attendance`, { status: 'tutor_absent' })).status, 400); t('Cannot mark a future class missed');
    const miss = ok(await tutor('POST', `/sessions/${todayS.id}/attendance`, { status: 'tutor_absent', note: 'Unwell' }), 'miss');
    abk = (await parent('GET', '/bookings/' + ab.id)).booking;
    assert.ok(miss.makeup_date > ist(4) && abk.sessions.length === 6 && abk.end_date === miss.makeup_date);
    assert.equal(abk.sessions.find((x) => x.id === todayS.id).attendance, 'tutor_absent');
    assert.ok(abk.sessions.some((x) => x.makeup_for === todayS.id)); t('Tutor absent -> free make-up class added at the end');
    assert.equal((await tutor('POST', `/sessions/${todayS.id}/attendance`, { status: 'student_absent' })).status, 400); t('A class can be marked only once');

    assert.equal((await p2b('POST', `/bookings/${ab.id}/leave`, { date: ist(2) })).status, 403); t('Only the booking parent can add leave');
    assert.equal((await parent('POST', `/bookings/${ab.id}/leave`, { date: ist() })).status, 400); t('Leave must be a future date');
    ok(await parent('POST', `/bookings/${ab.id}/leave`, { date: ist(2), reason: 'Exam' }), 'leave');
    abk = (await parent('GET', '/bookings/' + ab.id)).booking;
    const movedS = abk.sessions.find((x) => x.id === futureS.id);
    assert.ok(movedS.date > ist(4) && movedS.original_date === ist(2) && !abk.sessions.some((x) => x.date === ist(2) && x.status === 'scheduled')); t('Child leave moves that class to the end of the plan');

    const tl = ok(await tutor('POST', '/tutor/leave', { date: ist(3), reason: 'Family function' }), 'tutor leave');
    assert.ok(tl.moved >= 1); assert.equal((await tutor('POST', '/tutor/leave', { date: ist(3) })).status, 400); t(`Tutor leave moves ${tl.moved} class(es); no duplicate leave`);
    assert.equal((await staff('POST', '/admin/holidays', { date: ist(4), reason: 'Test' })).status, 403);
    const hol = ok(await admin('POST', '/admin/holidays', { date: ist(4), reason: 'Festival' }), 'holiday'); t(`Admin platform holiday moves ${hol.moved} class(es); staff cannot add holidays`);
    abk = (await parent('GET', '/bookings/' + ab.id)).booking;
    const blocked = new Set([ist(2), ist(3), ist(4)]);
    assert.ok(abk.sessions.filter((x) => x.status === 'scheduled').every((x) => !blocked.has(x.date))); t('No class is left on a holiday or leave day');

    // Auto-mark: a class from yesterday nobody marked -> not_marked + make-up
    const sched = abk.sessions.filter((x) => x.status === 'scheduled');
    dbq.run('UPDATE sessions SET date = ? WHERE id = ?', ist(-1), sched[0].id);
    const before3 = abk.sessions.length;
    assert.ok(schedule.autoMarkPast() >= 1);
    abk = (await parent('GET', '/bookings/' + ab.id)).booking;
    assert.equal(abk.sessions.find((x) => x.id === sched[0].id).attendance, 'not_marked'); assert.equal(abk.sessions.length, before3 + 1); t('Unmarked past classes are rescheduled automatically');

    // Student absent with "charge" policy pays the tutor; parent can report tutor no-show
    ok(await admin('POST', '/admin/config', { student_absent_policy: 'charge' }), 'policy');
    dbq.run('UPDATE sessions SET date = ? WHERE id = ?', ist(), sched[1].id);
    const tw = (await tutor('GET', '/wallet')).balance;
    const ch = ok(await tutor('POST', `/sessions/${sched[1].id}/attendance`, { status: 'student_absent' }), 'charge');
    assert.ok(ch.paid > 0 && (await tutor('GET', '/wallet')).balance === tw + ch.paid); t('Student absent + "charge" policy pays the tutor');
    ok(await admin('POST', '/admin/config', { student_absent_policy: 'makeup' }), 'policy back');
    assert.equal((await admin('POST', '/admin/config', { student_absent_policy: 'free' })).status, 400); t('Config choice values are validated');
    dbq.run('UPDATE sessions SET date = ? WHERE id = ?', ist(-1), sched[2].id);
    const rep = ok(await parent('POST', `/sessions/${sched[2].id}/report-absent`, {}), 'report');
    assert.ok(rep.makeup_date); assert.equal((await p2b('POST', `/sessions/${sched[2].id}/report-absent`, {})).status, 403); t('Parent can report a tutor no-show');

    // ---------- Weekly payouts ----------
    assert.equal((await tutor('PUT', '/tutor/payout-upi', { upi_id: 'not a upi' })).status, 400);
    ok(await tutor('PUT', '/tutor/payout-upi', { upi_id: 'tutor@okaxis' }), 'upi'); t('Tutor saves payout UPI (validated)');
    const tp = ok(await tutor('GET', '/tutor/payouts'), 'tutor payouts');
    assert.equal(tp.weeks.length, 8); assert.ok(tp.weeks[0].net > 0); t('Tutor sees weekly earnings');
    assert.equal((await parent('GET', '/admin/payouts')).status, 403);
    const thisMon = tp.weeks[0].week_start;
    const pr = ok(await staff('GET', '/admin/payouts?week=' + thisMon), 'payouts'); assert.ok(pr.rows.some((x) => x.tutor_id === tutorId)); t('Staff with payments permission see the payout report');
    assert.equal((await admin('POST', '/admin/payouts/settle', { week: thisMon })).status, 400); t('A running week cannot be settled');
    dbq.run("UPDATE users SET name = '=HYPERLINK(\"http://evil\")' WHERE id = ?", tutorId);
    const csvRes = await fetch(base + '/api/admin/payouts.csv?week=' + thisMon, { headers: { cookie: '' } });
    assert.equal(csvRes.status, 401);
    const csvTxt = await (await fetch(base + '/api/admin/payouts.csv?week=' + thisMon, { headers: { cookie: staff.cookie } })).text().catch(() => '');
    dbq.run("UPDATE users SET name = 'Demo Tutor' WHERE id = ?", tutorId);
    assert.ok(csvTxt.includes("'=HYPERLINK") && /^\ufeff?Tutor ID/.test(csvTxt)); t('CSV export needs login and blocks spreadsheet formulas');
    // Move this tutor's invoices into last week, then settle it with payout requests
    const lastMon = tp.weeks[1].week_start;
    dbq.run("UPDATE invoices SET created_at = created_at - 7 * 86400 WHERE user_id = ? AND type = 'commission'", tutorId);
    const st = ok(await admin('POST', '/admin/payouts/settle', { week: lastMon, create_withdrawals: true }), 'settle');
    assert.ok(st.withdrawals_created >= 1); assert.equal((await admin('POST', '/admin/payouts/settle', { week: lastMon })).status, 400); t('Settle a week -> payout requests to saved UPI, only once');
    assert.ok((await admin('GET', '/admin/payments?status=pending')).withdrawals.some((w) => w.upi_id === 'tutor@okaxis')); t('Weekly payouts appear in Withdrawals to pay');

    // ---------- Analytics ----------
    const an = ok(await admin('GET', '/admin/analytics?days=30'), 'analytics');
    assert.equal(an.series.length, 30); assert.ok(an.totals.bookings >= 1 && an.funnel.requests >= 1 && an.attendance.tutor_absent >= 1 && an.top_categories.length);
    assert.equal((await staff('GET', '/admin/analytics')).status, 403); t('Admin analytics: daily series, funnel, attendance, top areas (admin only)');

    // ---------- WhatsApp ----------
    const wa = require('../server/whatsapp');
    assert.equal(wa.toE164('98765 43210'), '919876543210'); assert.equal(wa.clean('a\n\tb     c'), 'a b c'); assert.equal(wa.enabled(), false);
    assert.equal((await admin('POST', '/admin/config', { whatsapp_phone_number_id: '12ab' })).status, 400);
    assert.equal((await admin('POST', '/admin/config/test-whatsapp', {})).status, 400); t('WhatsApp is off by default and validates its settings');
    ok(await parent('PUT', '/auth/prefs', { whatsapp_alerts: false }), 'wa pref');
    assert.equal((await parent('GET', '/auth/me')).user.whatsapp_alerts, false); t('Users can turn off WhatsApp alerts');
    assert.equal((await parent('GET', '/config')).whatsapp, false); t('Public config never exposes WhatsApp secrets');


    // ---------- Round 3 security review ----------
    const ar = await anon('POST', '/auth/otp/request', { email: 'admin@edvitta.local', purpose: 'login' });
    assert.ok(ar.ok && !ar.dev_code); assert.equal((await anon('POST', '/auth/otp/login', { email: 'admin@edvitta.local', code: '123456' })).status, 400); t('Admin/staff cannot log in with an email code alone');
    const near2 = await parent('GET', '/tutors?mode=offline&category=maths&lat=12.934&lng=77.623');
    assert.ok(near2.items.every((x) => (x.distance_km * 2) % 1 === 0)); t('Tutor distances are coarse (home location protected)');
    assert.equal((await anon('POST', '/wallet/order/verify', { razorpay_order_id: 'o', razorpay_payment_id: 'p', razorpay_signature: 'x' })).status, 401);
    assert.equal((await parent('POST', '/wallet/order/verify', { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: require('crypto').createHmac('sha256', '').update('order_1|pay_1').digest('hex') })).status, 400); t('Payment verify refuses signatures made with an empty key');
    const wh = await fetch(base + '/api/payments/razorpay/webhook', { method: 'POST', body: '{}', headers: { 'X-Razorpay-Signature': 'abc' } }); assert.equal(wh.status, 400); t('Webhook rejects unsigned calls');
    // Referral reward money can't be withdrawn (fresh referred parent with only bonus)
    const bonusP = client(base); ok(await bonusP('POST', '/auth/register', { role: 'parent', name: 'Bonus P', email: 'bp@test.in', phone: '9123456711', password: 'Passw0rd!' }), 'reg bp');
    dbq.run("UPDATE users SET wallet_balance = 15000 WHERE email = 'bp@test.in'");
    dbq.run("INSERT INTO wallet_txns(user_id,type,amount,balance_after,reason) SELECT id,'credit',15000,15000,'Referral reward' FROM users WHERE email='bp@test.in'");
    const wd = await bonusP('POST', '/wallet/withdraw', { amount: 100, upi_id: 'bp@okaxis' }); assert.equal(wd.status, 400); assert.ok(/Reward money/.test(wd.error)); t('Referral reward money cannot be withdrawn as cash');
    // Live connection from another website is refused
    const ioc = require('socket.io-client');
    const refused = await new Promise((res2) => { const so = ioc(base, { transports: ['websocket'], extraHeaders: { origin: 'https://evil.example', cookie: staff.cookie }, reconnection: false });
      so.on('connect', () => { so.close(); res2(false); }); so.on('connect_error', () => { so.close(); res2(true); }); });
    assert.ok(refused); t('Live connections from other websites are refused');
    // 2-step admin login once email is set up
    ok(await admin('POST', '/admin/config', { smtp_user: 'no-reply@example.com', smtp_pass: 'x', smtp_host: '127.0.0.1', smtp_port: 1 }), 'smtp');
    const a2 = client(base); const l2 = ok(await a2('POST', '/auth/login', { login: 'admin@edvitta.local', password: 'Admin@12345' }), 'admin pw');
    assert.ok(l2.mfa && l2.dev_code); assert.equal((await a2('GET', '/admin/stats')).status, 401);
    assert.equal((await a2('POST', '/auth/mfa', { email: 'admin@edvitta.local', code: '000000' === l2.dev_code ? '111111' : '000000' })).status, 400);
    ok(await a2('POST', '/auth/mfa', { email: 'admin@edvitta.local', code: l2.dev_code }), 'mfa'); ok(await a2('GET', '/admin/stats'), 'stats after mfa'); t('Admin sign-in needs password + email code (2-step)');
    ok(await admin('POST', '/admin/config', { clear_secrets: ['smtp_pass'] }), 'smtp off');
    console.log(`\nAll ${pass} checks passed.`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ FAILED:', e.message); process.exitCode = 1;
  } finally { server.close(); setTimeout(() => process.exit(), 100); }
});
