'use strict';
// Community groups: a parent in an apartment creates a group for a class/skill; other parents pay to add their child.
const express = require('express');
const { q, tx, getSetting } = require('../db');
const { v, bad, forbidden, notFound, requireAuth, requireVerified, audit, walletMove, notify, distanceKm } = require('../lib');
const finance = require('../finance');

const r = express.Router();

function shape(g, viewerId) {
  const members = q.all(`SELECT gm.child_id, gm.parent_id, c.name child_name, c.grade, u.name parent_name FROM group_members gm
    JOIN children c ON c.id = gm.child_id JOIN users u ON u.id = gm.parent_id WHERE gm.group_id = ?`, g.id);
  const isMember = members.some((m) => m.parent_id === viewerId) || g.creator_id === viewerId;
  const tutor = g.tutor_id ? q.get('SELECT id, name FROM users WHERE id = ?', g.tutor_id) : null;
  return {
    id: g.id, name: g.name, apartment: g.apartment, category: g.category, grade: g.grade, description: g.description,
    fee: g.fee, max_members: g.max_members, schedule: g.schedule, status: g.status, created_at: g.created_at,
    creator: q.get('SELECT name FROM users WHERE id = ?', g.creator_id).name.split(' ')[0], is_creator: g.creator_id === viewerId,
    tutor, member_count: members.length, is_member: isMember,
    // Children's names are only visible to other members of the group.
    members: isMember ? members.map((m) => ({ child: m.child_name, grade: m.grade, parent: m.parent_name.split(' ')[0], mine: m.parent_id === viewerId })) : [],
  };
}

r.get('/groups', requireAuth('parent', 'tutor'), (req, res) => {
  const lat = v.num(req.query.lat, 'Lat', { optional: true, min: -90, max: 90 });
  const lng = v.num(req.query.lng, 'Lng', { optional: true, min: -180, max: 180 });
  const search = req.query.search ? String(req.query.search).slice(0, 60).toLowerCase() : '';
  const radius = Number(getSetting('search_radius_km', '3'));
  let rows = q.all("SELECT * FROM community_groups WHERE status != 'closed' ORDER BY id DESC LIMIT 300");
  if (search) rows = rows.filter((g) => (g.apartment + ' ' + g.name + ' ' + g.category).toLowerCase().includes(search));
  else if (lat != null && lng != null) rows = rows.filter((g) => g.lat != null && distanceKm(lat, lng, g.lat, g.lng) <= radius);
  res.json({ items: rows.map((g) => shape(g, req.user.id)) });
});

r.get('/groups/mine', requireAuth('parent', 'tutor'), (req, res) => {
  const rows = q.all(`SELECT * FROM community_groups WHERE creator_id = ? OR tutor_id = ?
     OR id IN (SELECT group_id FROM group_members WHERE parent_id = ?) ORDER BY id DESC`, req.user.id, req.user.id, req.user.id);
  res.json({ items: rows.map((g) => shape(g, req.user.id)) });
});

r.get('/groups/:id', requireAuth(), (req, res) => {
  const g = q.get('SELECT * FROM community_groups WHERE id = ?', Number(req.params.id));
  if (!g) throw notFound();
  res.json({ group: shape(g, req.user.id) });
});

r.post('/groups', requireAuth('parent'), (req, res) => {
  const b = req.body || {};
  const cats = q.all('SELECT slug FROM categories').map((c) => c.slug);
  const info = q.run(`INSERT INTO community_groups(creator_id,name,apartment,category,grade,description,fee,max_members,schedule,lat,lng)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, req.user.id,
    v.str(b.name, 'Group name', { max: 80 }), v.str(b.apartment, 'Apartment / society', { max: 120 }),
    v.oneOf(b.category, 'Subject / skill', cats), v.str(b.grade, 'Class / level', { max: 30, optional: true }),
    v.str(b.description, 'Description', { max: 800, optional: true }), v.rupees(b.fee, 'Joining fee per child', { min: 1, max: 100000 }),
    v.int(b.max_members, 'Max children', { min: 2, max: 50 }), v.str(b.schedule, 'Schedule', { max: 120, optional: true }),
    v.num(b.lat, 'Location', { min: -90, max: 90 }), v.num(b.lng, 'Location', { min: -180, max: 180 }));
  audit(req, 'group_create', `group:${info.lastInsertRowid}`);
  res.json({ id: Number(info.lastInsertRowid) });
});

function payTutorFromEscrow(g) {
  if (!g.tutor_id || g.escrow <= 0) return;
  const sp = finance.split(g.escrow);
  q.run('UPDATE community_groups SET escrow = 0 WHERE id = ?', g.id);
  if (sp.net > 0) walletMove(g.tutor_id, 'credit', sp.net, `Community group "${g.name}" fees`, `group:${g.id}`);
  finance.createInvoice({ type: 'commission', user_id: g.tutor_id, s: sp, meta: { group: g.name, apartment: g.apartment, category: g.category } });
}

r.post('/groups/:id/join', requireAuth('parent'), requireVerified, (req, res) => {
  const g = q.get('SELECT * FROM community_groups WHERE id = ?', Number(req.params.id));
  if (!g) throw notFound();
  if (g.status !== 'open') throw bad('This group is not accepting new members');
  const childId = v.int(req.body.child_id, 'Child', { min: 1 });
  if (!q.get('SELECT 1 FROM children WHERE id = ? AND parent_id = ?', childId, req.user.id)) throw bad('Select your child');
  if (q.get('SELECT 1 FROM group_members WHERE group_id = ? AND child_id = ?', g.id, childId)) throw bad('Your child is already in this group');
  tx(() => {
    walletMove(req.user.id, 'debit', g.fee, `Joined community group "${g.name}"`, `group:${g.id}`);
    q.run('INSERT INTO group_members(group_id,parent_id,child_id,paid) VALUES (?,?,?,?)', g.id, req.user.id, childId, g.fee);
    q.run('UPDATE community_groups SET escrow = escrow + ? WHERE id = ?', g.fee, g.id);
    const count = q.get('SELECT COUNT(*) n FROM group_members WHERE group_id = ?', g.id).n;
    if (count >= g.max_members) q.run("UPDATE community_groups SET status='full' WHERE id = ?", g.id);
    payTutorFromEscrow(q.get('SELECT * FROM community_groups WHERE id = ?', g.id));
  });
  if (g.creator_id !== req.user.id) notify(g.creator_id, `A new child joined your group "${g.name}"`, `#/community/${g.id}`);
  audit(req, 'group_join', `group:${g.id}`);
  res.json({ ok: true });
});

// The creator picks a verified tutor for the group. Collected fees (minus commission) are paid to that tutor.
r.post('/groups/:id/tutor', requireAuth('parent'), (req, res) => {
  const g = q.get('SELECT * FROM community_groups WHERE id = ?', Number(req.params.id));
  if (!g) throw notFound();
  if (g.creator_id !== req.user.id) throw forbidden('Only the group creator can choose the tutor');
  if (g.tutor_id) throw bad('A tutor is already assigned');
  const tutorId = v.int(req.body.tutor_id, 'Tutor', { min: 1 });
  const t = q.get("SELECT t.categories FROM tutor_profiles t JOIN users u ON u.id=t.user_id WHERE t.user_id = ? AND t.kyc_status='approved' AND u.status='active'", tutorId);
  if (!t) throw bad('Tutor not found or not verified');
  tx(() => {
    q.run('UPDATE community_groups SET tutor_id = ? WHERE id = ?', tutorId, g.id);
    payTutorFromEscrow(q.get('SELECT * FROM community_groups WHERE id = ?', g.id));
  });
  notify(tutorId, `You were chosen as tutor for the community group "${g.name}" at ${g.apartment}`, `#/community/${g.id}`);
  res.json({ ok: true });
});

r.post('/groups/:id/close', requireAuth('parent'), (req, res) => {
  const g = q.get('SELECT * FROM community_groups WHERE id = ?', Number(req.params.id));
  if (!g || g.creator_id !== req.user.id) throw forbidden();
  tx(() => {
    // If no tutor was ever assigned, refund everyone who paid.
    if (!g.tutor_id && g.escrow > 0) {
      for (const m of q.all('SELECT parent_id, paid FROM group_members WHERE group_id = ?', g.id)) {
        walletMove(m.parent_id, 'credit', m.paid, `Refund: community group "${g.name}" closed`, `group:${g.id}`);
      }
      q.run('UPDATE community_groups SET escrow = 0 WHERE id = ?', g.id);
    }
    q.run("UPDATE community_groups SET status='closed' WHERE id = ?", g.id);
  });
  res.json({ ok: true });
});

module.exports = r;
