'use strict';
// Customer helpline tickets. Users raise tickets; staff with the "tickets" permission (and admins) solve them.
const express = require('express');
const { q } = require('../db');
const { v, bad, forbidden, notFound, requireAuth, audit, notify } = require('../lib');

const r = express.Router();
const CATS = ['booking', 'payment', 'wallet', 'safety', 'tutor', 'kyc', 'community', 'account', 'general'];
const canHandle = (u) => u.role === 'admin' || (u.role === 'staff' && u.permissions.includes('tickets'));

r.get('/tickets', requireAuth(), (req, res) => {
  const staff = canHandle(req.user);
  const status = req.query.status && ['open', 'in_progress', 'resolved', 'closed'].includes(req.query.status) ? req.query.status : null;
  let sql = `SELECT t.*, u.name user_name, u.role user_role, a.name assignee FROM tickets t JOIN users u ON u.id=t.user_id
    LEFT JOIN users a ON a.id = t.assigned_to WHERE 1=1`;
  const p = [];
  if (!staff) { sql += ' AND t.user_id = ?'; p.push(req.user.id); }
  if (status) { sql += ' AND t.status = ?'; p.push(status); }
  if (staff && req.query.mine === '1') { sql += ' AND t.assigned_to = ?'; p.push(req.user.id); }
  sql += " ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC LIMIT 200";
  res.json({ items: q.all(sql, ...p) });
});

r.post('/tickets', requireAuth('parent', 'tutor'), (req, res) => {
  const b = req.body || {};
  const category = v.oneOf(b.category || 'general', 'Category', CATS);
  const bookingId = v.int(b.booking_id, 'Booking', { min: 1, optional: true });
  if (bookingId && !q.get('SELECT 1 FROM bookings WHERE id=? AND (parent_id=? OR tutor_id=?)', bookingId, req.user.id, req.user.id)) throw bad('Booking not found');
  const info = q.run('INSERT INTO tickets(user_id, subject, category, priority, booking_id) VALUES (?,?,?,?,?)', req.user.id,
    v.str(b.subject, 'Subject', { max: 120 }), category, category === 'safety' ? 'urgent' : 'normal', bookingId);
  const id = Number(info.lastInsertRowid);
  q.run('INSERT INTO ticket_messages(ticket_id, author_id, body) VALUES (?,?,?)', id, req.user.id, v.str(b.message, 'Message', { max: 3000 }));
  res.json({ id });
});

function loadTicket(req) {
  const t = q.get(`SELECT t.*, u.name user_name, u.phone user_phone, u.email user_email, u.role user_role FROM tickets t
    JOIN users u ON u.id = t.user_id WHERE t.id = ?`, Number(req.params.id));
  if (!t) throw notFound();
  if (t.user_id !== req.user.id && !canHandle(req.user)) throw forbidden();
  return t;
}

r.get('/tickets/:id', requireAuth(), (req, res) => {
  const t = loadTicket(req);
  const staff = canHandle(req.user);
  const msgs = q.all(`SELECT m.*, u.name author, u.role author_role FROM ticket_messages m JOIN users u ON u.id = m.author_id
    WHERE m.ticket_id = ? ${staff ? '' : 'AND m.internal = 0'} ORDER BY m.id`, t.id);
  if (!staff) { delete t.user_phone; delete t.user_email; }
  const staffList = staff ? q.all("SELECT id, name FROM users WHERE role IN ('admin','staff') AND status='active'") : [];
  res.json({ ticket: t, messages: msgs.map((m) => ({ ...m, author: m.author_role === 'staff' || m.author_role === 'admin' ? `${m.author} (Edvitta Support)` : m.author })), staff: staffList });
});

r.post('/tickets/:id/reply', requireAuth(), (req, res) => {
  const t = loadTicket(req);
  if (t.status === 'closed') throw bad('This ticket is closed. Please open a new one.');
  const staff = canHandle(req.user);
  const internal = staff && !!req.body.internal;
  q.run('INSERT INTO ticket_messages(ticket_id, author_id, body, internal) VALUES (?,?,?,?)', t.id, req.user.id, v.str(req.body.body, 'Message', { max: 3000 }), internal ? 1 : 0);
  let status = t.status;
  if (staff && !internal && t.status === 'open') status = 'in_progress';
  if (!staff && t.status === 'resolved') status = 'open';
  q.run('UPDATE tickets SET status = ?, updated_at = unixepoch(), assigned_to = COALESCE(assigned_to, ?) WHERE id = ?', status, staff ? req.user.id : null, t.id);
  if (staff && !internal) notify(t.user_id, `Support replied to your ticket #${t.id}`, `#/support/${t.id}`);
  res.json({ ok: true });
});

r.post('/tickets/:id/update', requireAuth('admin', 'staff'), (req, res) => {
  if (!canHandle(req.user)) throw forbidden();
  const t = loadTicket(req);
  const b = req.body || {};
  const status = v.oneOf(b.status || t.status, 'Status', ['open', 'in_progress', 'resolved', 'closed']);
  const priority = v.oneOf(b.priority || t.priority, 'Priority', ['low', 'normal', 'high', 'urgent']);
  let assigned = t.assigned_to;
  if (b.assigned_to !== undefined) {
    assigned = b.assigned_to ? v.int(b.assigned_to, 'Assignee', { min: 1 }) : null;
    if (assigned && !q.get("SELECT 1 FROM users WHERE id=? AND role IN ('admin','staff')", assigned)) throw bad('Invalid assignee');
  }
  q.run('UPDATE tickets SET status=?, priority=?, assigned_to=?, updated_at=unixepoch() WHERE id=?', status, priority, assigned, t.id);
  if (status !== t.status) notify(t.user_id, `Your ticket #${t.id} is now ${status.replace('_', ' ')}`, `#/support/${t.id}`);
  audit(req, 'ticket_update', `ticket:${t.id}`, { status, priority, assigned });
  res.json({ ok: true });
});

module.exports = r;
