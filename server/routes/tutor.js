'use strict';
const express = require('express');
const { q, getSetting, flag } = require('../db');
const { v, bad, notFound, requireAuth, requireVerified, audit, distanceKm, tutorDistanceKm } = require('../lib');
const { upload, saveFile } = require('../uploads');

const r = express.Router();
const KYC_TYPES = ['aadhaar_front', 'aadhaar_back', 'pan', 'photo', 'qualification', 'police_verification', 'address_proof'];
const REQUIRED_KYC = ['aadhaar_front', 'aadhaar_back', 'pan', 'photo'];

// ---------- Public: categories & tutor search ----------
r.get('/categories', (_req, res) => res.json({ items: q.all('SELECT * FROM categories ORDER BY grp, name') }));

function tutorCard(t, from) {
  const cats = JSON.parse(t.categories);
  const card = {
    id: t.user_id, name: t.name, bio: t.bio, categories: cats, experience_years: t.experience_years,
    qualification: t.qualification, rate_per_session: t.rate_per_session, mode: t.mode, gender: t.gender,
    rating: t.rating_count ? +(t.rating_sum / t.rating_count).toFixed(1) : null, reviews: t.rating_count,
    police_verified: !!t.police_verification, background_clear: t.background_check === 'clear',
    // "Verified" badge = KYC approved + police verification + background check cleared.
    fully_verified: t.kyc_status === 'approved' && !!t.police_verification && t.background_check === 'clear',
    offers_trial: flag('trial_enabled', '1') && !!t.offers_trial, trial_fee: t.trial_fee, available: !!t.available, area: t.address ? t.address.split(',').slice(-2).join(',').trim() : '',
  };
  // Never expose a tutor's exact coordinates in search, only a rounded distance.
  if (from && t.lat != null) card.distance_km = Math.round(tutorDistanceKm(from.lat, from.lng, t) * 2) / 2;
  return card;
}

const searchLimiter = require('express-rate-limit')({ windowMs: 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many searches. Please wait a minute.' } });
r.get('/tutors', requireAuth(), searchLimiter, (req, res) => {
  const radius = Number(getSetting('search_radius_km', '3'));
  const category = req.query.category ? String(req.query.category) : null;
  const mode = v.oneOf(req.query.mode || 'offline', 'Mode', ['online', 'offline']);
  const lat = v.num(req.query.lat, 'Latitude', { min: -90, max: 90, optional: true });
  const lng = v.num(req.query.lng, 'Longitude', { min: -180, max: 180, optional: true });
  let rows = q.all(`SELECT t.*, u.name FROM tutor_profiles t JOIN users u ON u.id = t.user_id
    WHERE t.kyc_status = 'approved' AND t.background_check != 'flagged' AND u.status = 'active' AND t.available = 1 AND t.mode IN (?, 'both')`, mode);
  if (category) rows = rows.filter((t) => JSON.parse(t.categories).includes(category));
  const from = lat != null && lng != null ? { lat, lng } : null;
  let items = rows.map((t) => tutorCard(t, from));
  if (mode === 'offline') {
    if (!from) throw bad('Location is required to find home tutors near you');
    items = items.filter((t) => t.distance_km != null && t.distance_km <= radius).sort((a, b) => a.distance_km - b.distance_km);
  } else {
    items.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }
  res.json({ items, radius_km: radius });
});

r.get('/tutors/:id', requireAuth(), (req, res) => {
  const t = q.get(`SELECT t.*, u.name FROM tutor_profiles t JOIN users u ON u.id = t.user_id
    WHERE t.user_id = ? AND t.kyc_status = 'approved' AND u.status = 'active'`, Number(req.params.id));
  if (!t) throw notFound('Tutor not found');
  const reviews = q.all(`SELECT * FROM (SELECT r.rating, r.comment, r.created_at, u.name, NULL punctuality, NULL teaching FROM reviews r JOIN users u ON u.id = r.parent_id WHERE r.tutor_id = ?
    UNION ALL SELECT r.rating, r.comment, r.created_at, u.name, r.punctuality, r.teaching FROM session_reviews r JOIN users u ON u.id = r.parent_id WHERE r.tutor_id = ?)
    ORDER BY created_at DESC LIMIT 30`, t.user_id, t.user_id)
    .map((x) => ({ ...x, name: x.name.split(' ')[0] }));
  res.json({ tutor: tutorCard(t), reviews });
});

// ---------- Tutor self-service ----------
const tutorOnly = requireAuth('tutor');

r.get('/me/profile', tutorOnly, (req, res) => {
  const p = q.get('SELECT * FROM tutor_profiles WHERE user_id = ?', req.user.id);
  const docs = q.all('SELECT id, doc_type, original_name, mime, uploaded_at FROM kyc_documents WHERE tutor_id = ?', req.user.id);
  res.json({ profile: { ...p, categories: JSON.parse(p.categories) }, docs, kyc_types: KYC_TYPES, required: REQUIRED_KYC });
});

r.put('/me/profile', tutorOnly, (req, res) => {
  const b = req.body || {};
  const allCats = q.all('SELECT slug FROM categories').map((c) => c.slug);
  const cats = Array.isArray(b.categories) ? b.categories.filter((c) => allCats.includes(c)) : [];
  if (!cats.length) throw bad('Pick at least one subject or skill you teach');
  q.run(`UPDATE tutor_profiles SET bio=?, categories=?, experience_years=?, qualification=?, rate_per_session=?, mode=?, gender=?,
      lat=?, lng=?, address=?, offers_trial=?, trial_fee=?, pan_number=?, gstin=? WHERE user_id=?`,
    v.str(b.bio, 'About you', { max: 1000, optional: true }) || '',
    JSON.stringify(cats),
    v.int(b.experience_years, 'Experience', { min: 0, max: 60, optional: true }) || 0,
    v.str(b.qualification, 'Qualification', { max: 200, optional: true }) || '',
    v.rupees(b.rate_per_session, 'Fee per session', { min: 50, max: 20000 }),
    v.oneOf(b.mode, 'Teaching mode', ['online', 'offline', 'both']),
    v.oneOf(b.gender || '', 'Gender', ['', 'female', 'male', 'other']),
    v.num(b.lat, 'Latitude', { min: -90, max: 90, optional: true }),
    v.num(b.lng, 'Longitude', { min: -180, max: 180, optional: true }),
    v.str(b.address, 'Address', { max: 300, optional: true }),
    b.offers_trial ? 1 : 0,
    v.rupees(b.trial_fee || 0, 'Trial class fee', { max: 5000 }),
    (() => { const p = v.str(b.pan_number, 'PAN', { max: 10, optional: true }); if (p && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p.toUpperCase())) throw bad('PAN should look like ABCDE1234F'); return p ? p.toUpperCase() : null; })(),
    (() => { const g = v.str(b.gstin, 'GSTIN', { max: 15, optional: true }); if (g && !/^[0-9]{2}[A-Z0-9]{13}$/.test(g.toUpperCase())) throw bad('GSTIN should be 15 characters'); return g ? g.toUpperCase() : null; })(),
    req.user.id);
  res.json({ ok: true });
});

r.post('/me/availability', tutorOnly, (req, res) => {
  const p = q.get('SELECT kyc_status, lat FROM tutor_profiles WHERE user_id = ?', req.user.id);
  const on = !!req.body.available;
  if (on && p.kyc_status !== 'approved') throw bad('Your KYC must be approved before you can go online');
  if (on && p.lat == null) throw bad('Set your teaching location in your profile first');
  q.run('UPDATE tutor_profiles SET available = ? WHERE user_id = ?', on ? 1 : 0, req.user.id);
  res.json({ available: on });
});

r.post('/me/kyc', tutorOnly, upload.single('file'), (req, res) => {
  const type = v.oneOf(req.body.doc_type, 'Document type', KYC_TYPES);
  const p = q.get('SELECT kyc_status FROM tutor_profiles WHERE user_id = ?', req.user.id);
  if (p.kyc_status === 'approved') throw bad('Your KYC is already approved. Contact support to change documents.');
  const f = saveFile(req.file, { visibility: 'private' });
  q.run('DELETE FROM kyc_documents WHERE tutor_id = ? AND doc_type = ?', req.user.id, type);
  q.run('INSERT INTO kyc_documents(tutor_id, doc_type, stored_name, original_name, mime) VALUES (?,?,?,?,?)',
    req.user.id, type, f.stored_name, f.original_name, f.mime);
  audit(req, 'kyc_upload', `user:${req.user.id}`, { type });
  res.json({ ok: true });
});

r.post('/me/kyc/submit', tutorOnly, requireVerified, (req, res) => {
  const have = q.all('SELECT doc_type FROM kyc_documents WHERE tutor_id = ?', req.user.id).map((d) => d.doc_type);
  const missing = REQUIRED_KYC.filter((t) => !have.includes(t));
  if (missing.length) throw bad('Please upload: ' + missing.join(', ').replace(/_/g, ' '));
  const p = q.get('SELECT * FROM tutor_profiles WHERE user_id = ?', req.user.id);
  if (JSON.parse(p.categories).length === 0 || p.lat == null) throw bad('Complete your profile (subjects and location) before submitting');
  q.run("UPDATE tutor_profiles SET kyc_status = 'submitted', kyc_note = NULL WHERE user_id = ?", req.user.id);
  audit(req, 'kyc_submit', `user:${req.user.id}`);
  res.json({ ok: true });
});

module.exports = r;
