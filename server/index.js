'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const cookie = require('cookie');

const lib = require('./lib');
const { q } = require('./db');
const { seedBase, seedDemo } = require('./seed');
const { PUBLIC_DIR } = require('./uploads');

seedBase();
if (process.env.SEED_DEMO === '1') seedDemo();

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", 'https://checkout.razorpay.com'],
      'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
      'media-src': ["'self'", 'blob:'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://api.qrserver.com'],
      'connect-src': ["'self'", 'ws:', 'wss:', 'https://nominatim.openstreetmap.org', 'https://lumberjack.razorpay.com', 'https://api.razorpay.com'],
      'upgrade-insecure-requests': lib.IS_PROD ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use((_req, res, next) => { res.set('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(self), payment=(self "https://checkout.razorpay.com")'); next(); });
// Razorpay webhook needs the raw body for its signature check, so it is parsed before express.json.
app.use('/api/payments/razorpay/webhook', express.raw({ type: '*/*', limit: '200kb' }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(lib.loadUser);
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use('/api', (req, res, next) => (req.path === '/payments/razorpay/webhook' ? next() : lib.csrfGuard(req, res, next)));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.use('/api/auth', require('./routes/auth').router);
app.use('/api', require('./routes/tutor'));
app.use('/api', require('./routes/bookings').router);
app.use('/api', require('./routes/money'));
app.use('/api', require('./routes/community'));
app.use('/api', require('./routes/tickets'));
app.use('/api', require('./routes/extras'));
app.use('/api', require('./routes/ops').router);
app.use('/api/admin', require('./routes/admin'));
app.use('/api', (_req, _res, next) => next(lib.notFound('Unknown API route')));

app.use('/uploads', express.static(PUBLIC_DIR, { maxAge: '7d', index: false, dotfiles: 'deny',
  setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff') }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: lib.IS_PROD ? '1h' : 0 }));

// Errors: friendly message for known errors, no stack traces leak to the client.
app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is too large (max 5 MB)' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message });
});

// ---------- Real-time: live tutor tracking & notifications ----------
const server = http.createServer(app);
// Live connections only from this site's own pages (blocks cross-site WebSocket hijacking).
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 1e4,
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    if (!origin) return cb(null, true); // native apps / same-origin polling without Origin
    try { const o = new URL(origin); cb(null, o.host === req.headers.host || (process.env.APP_ORIGIN && origin === process.env.APP_ORIGIN)); } catch { cb(null, false); }
  } });
lib.io = io;

io.use((socket, next) => {
  const cookies = cookie.parse(socket.handshake.headers.cookie || '');
  const user = lib.userFromToken(cookies[lib.COOKIE]);
  if (!user) return next(new Error('unauthorised'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const u = socket.user;
  socket.join(`user:${u.id}`);
  if (u.role === 'admin' || (u.role === 'staff' && u.permissions.includes('sos'))) socket.join('responders');

  // Parent (or admin) subscribes to a booking's live tutor location.
  // Re-checks the account on sensitive events, so a suspended or logged-out user's open connection stops working.
  const stillValid = () => { const x = q.get('SELECT status, token_version FROM users WHERE id = ?', u.id); return x && x.status === 'active' && x.token_version === u.token_version; };
  socket.on('track', (bookingId) => {
    if (!stillValid()) return socket.disconnect(true);
    const b = q.get("SELECT * FROM bookings WHERE id = ? AND status = 'accepted' AND mode = 'offline'", Number(bookingId));
    if (!b) return;
    const allowed = b.parent_id === u.id || u.role === 'admin' || (u.role === 'staff' && u.permissions.includes('sos'));
    if (allowed) socket.join(`booking:${b.id}`);
  });
  socket.on('untrack', (bookingId) => socket.leave(`booking:${Number(bookingId)}`));

  // ---------- Video class signalling (WebRTC offer/answer/ICE relayed between the parent and tutor only) ----------
  const videoRooms = new Set();
  const canVideo = (bookingId) => {
    if (require('./db').getSetting('video_enabled', '1') !== '1') return null;
    const b = q.get("SELECT * FROM bookings WHERE id = ? AND mode = 'online' AND status = 'accepted'", Number(bookingId));
    return b && (b.parent_id === u.id || b.tutor_id === u.id) ? b : null;
  };
  socket.on('video:join', (bookingId) => {
    if (!stillValid()) return socket.disconnect(true);
    const b = canVideo(bookingId);
    if (!b) return socket.emit('video:error', 'Not allowed to join this class');
    const room = `video:${b.id}`;
    const size = io.sockets.adapter.rooms.get(room)?.size || 0;
    if (size >= 2) return socket.emit('video:error', 'This class already has two participants');
    socket.join(room); videoRooms.add(b.id);
    q.run("INSERT INTO call_logs(booking_id, caller_id, kind, status) VALUES (?,?,'video','joined')", b.id, u.id);
    socket.to(room).emit('video:peer-joined', { name: u.name });
    socket.emit('video:joined', { others: size });
  });
  socket.on('video:signal', (p) => {
    if (!p || !videoRooms.has(Number(p.bookingId))) return;
    if (!canVideo(p.bookingId)) return leaveVideo(Number(p.bookingId)); // booking cancelled / video turned off mid-call
    const s = JSON.stringify(p.data || {});
    if (s.length > 20000) return;
    socket.to(`video:${Number(p.bookingId)}`).emit('video:signal', { data: p.data });
  });
  const leaveVideo = (bookingId) => {
    if (!videoRooms.has(bookingId)) return;
    videoRooms.delete(bookingId);
    socket.leave(`video:${bookingId}`);
    q.run("UPDATE call_logs SET ended_at = unixepoch(), status = 'left' WHERE booking_id = ? AND caller_id = ? AND kind = 'video' AND ended_at IS NULL", bookingId, u.id);
    socket.to(`video:${bookingId}`).emit('video:peer-left');
  };
  socket.on('video:leave', (id) => leaveVideo(Number(id)));
  socket.on('disconnect', () => { for (const id of [...videoRooms]) leaveVideo(id); });

  // Tutor phone sends GPS updates. Stored and forwarded ONLY to parents of bookings with a live session.
  let last = 0;
  socket.on('location', (p) => {
    if (u.role !== 'tutor' || !p || typeof p !== 'object') return;
    const now = Date.now();
    if (now - last < 3000) return; // throttle
    last = now;
    if (!stillValid()) return socket.disconnect(true);
    const lat = Number(p.lat), lng = Number(p.lng), acc = Number(p.accuracy) || null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    const live = q.all(`SELECT DISTINCT b.id FROM bookings b JOIN sessions s ON s.booking_id=b.id
      WHERE b.tutor_id=? AND b.status='accepted' AND s.status IN ('on_the_way','in_progress')`, u.id);
    if (!live.length) return;
    q.run(`INSERT INTO tutor_locations(tutor_id,lat,lng,accuracy,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(tutor_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, accuracy=excluded.accuracy, updated_at=excluded.updated_at`,
      u.id, lat, lng, acc, Math.floor(now / 1000));
    for (const b of live) io.to(`booking:${b.id}`).emit('tutor_location', { booking_id: b.id, lat, lng, accuracy: acc, at: now });
    io.to('responders').emit('live_update', { tutor_id: u.id, lat, lng });
  });
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  server.listen(PORT, () => console.log(`[edvitta] Running at http://localhost:${PORT}`));
  require('./jobs').start();
}
module.exports = { app, server };
