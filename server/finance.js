'use strict';
// Commission, GST and invoices. The admin sets the commission % (and optional GST on commission) in Config.
// Every tutor payout produces a commission tax invoice; every booking produces a payment receipt for the parent.
const { q, getSetting, flag } = require('./db');

function split(gross) {
  const pct = Number(getSetting('commission_percent', '15'));
  const gstOn = flag('gst_enabled');
  const gstPct = gstOn ? Number(getSetting('gst_percent', '18')) : 0;
  const commission = Math.round((gross * pct) / 100);
  const gst = Math.round((commission * gstPct) / 100);
  return { gross, commission_percent: pct, commission, gst_percent: gstPct, gst, net: gross - commission - gst };
}

function fy(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

// Must be called inside a transaction so numbering stays sequential.
function nextNumber(type) {
  const prefix = (getSetting('invoice_prefix', 'EDV') || 'EDV').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const f = fy();
  const key = `${prefix}/${type === 'commission' ? 'C' : 'R'}/${f}/`;
  const last = q.get('SELECT number FROM invoices WHERE number LIKE ? ORDER BY id DESC LIMIT 1', key + '%');
  const n = last ? Number(last.number.split('/').pop()) + 1 : 1;
  return key + String(n).padStart(5, '0');
}

function platformInfo() {
  return {
    name: getSetting('platform_legal_name', 'Edvitta'), gstin: getSetting('platform_gstin', ''),
    address: getSetting('platform_address', ''), state: getSetting('platform_state', 'Karnataka'),
    sac: getSetting('platform_sac', '998599'), email: getSetting('smtp_user', ''),
  };
}

function createInvoice({ type, user_id, booking_id = null, session_id = null, s, meta = {} }) {
  const number = nextNumber(type);
  const info = q.run(`INSERT INTO invoices(number,type,user_id,booking_id,session_id,period,gross,commission_percent,commission,gst_percent,gst,net,meta)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, number, type, user_id, booking_id, session_id, new Date().toISOString().slice(0, 7),
  s.gross, s.commission_percent, s.commission, s.gst_percent, s.gst, s.net, JSON.stringify({ platform: platformInfo(), ...meta }));
  return Number(info.lastInsertRowid);
}

module.exports = { split, createInvoice, platformInfo, fy };
