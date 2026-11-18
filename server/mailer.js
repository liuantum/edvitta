'use strict';
// Email via SMTP (default: Hostinger Email, smtp.hostinger.com:465 SSL). Configured by the admin in Config.
// Used for login OTPs, email verification and notifications (bookings, tutor arrival, payments, tickets).
const nodemailer = require('nodemailer');
const { q, getSetting, getSecret, flag } = require('./db');

let cached = null, cacheKey = '';
function transport() {
  const cfg = {
    host: getSetting('smtp_host', 'smtp.hostinger.com'),
    port: Number(getSetting('smtp_port', '465')),
    user: getSetting('smtp_user', ''),
    pass: getSecret('smtp_pass'),
  };
  if (!cfg.user || !cfg.pass) return null;
  const key = JSON.stringify(cfg);
  if (key !== cacheKey) {
    cached = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
      tls: { minVersion: 'TLSv1.2' },
    });
    cacheKey = key;
  }
  return cached;
}
const isConfigured = () => !!(getSetting('smtp_user', '') && getSecret('smtp_pass'));
const emailEnabled = () => flag('email_enabled') && isConfigured();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, bodyHtml) {
  const app = esc(getSetting('app_url', ''));
  return `<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px">
    <div style="font-weight:800;font-size:22px;color:#4f46e5;margin-bottom:14px">Edvitta</div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:22px">
      <h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>${bodyHtml}
      ${app ? `<p style="margin-top:18px"><a href="${app}" style="background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Open Edvitta</a></p>` : ''}
    </div>
    <p style="font-size:12px;color:#64748b;margin-top:14px">You received this because you have an Edvitta account. For safety, Edvitta staff will never ask for your password or OTP.</p>
  </div></body></html>`;
}

async function sendMail(to, subject, title, bodyHtml, { force = false } = {}) {
  if (!force && !emailEnabled()) { q.run('INSERT INTO email_log(to_email,subject,status) VALUES (?,?,?)', to, subject, 'skipped'); return { skipped: true }; }
  const t = transport();
  if (!t) { q.run('INSERT INTO email_log(to_email,subject,status,error) VALUES (?,?,?,?)', to, subject, 'failed', 'SMTP not configured'); return { skipped: true }; }
  const fromName = getSetting('smtp_from_name', 'Edvitta');
  try {
    await t.sendMail({ from: `"${fromName.replace(/"/g, '')}" <${getSetting('smtp_user', '')}>`, to, subject, html: layout(title, bodyHtml),
      text: bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
    q.run('INSERT INTO email_log(to_email,subject,status) VALUES (?,?,?)', to, subject, 'sent');
    return { sent: true };
  } catch (e) {
    q.run('INSERT INTO email_log(to_email,subject,status,error) VALUES (?,?,?,?)', to, subject, 'failed', String(e.message).slice(0, 300));
    console.error('[edvitta] email failed:', e.message);
    return { error: e.message };
  }
}

// Fire-and-forget notification email. Never blocks or fails the request that triggered it.
function notifyEmail(userId, text) {
  if (!emailEnabled() || !flag('email_notifications_enabled', '1')) return;
  const u = q.get('SELECT email, name, email_notifications, email_verified FROM users WHERE id = ?', userId);
  if (!u || !u.email_notifications) return;
  setImmediate(() => sendMail(u.email, 'Edvitta: ' + text.slice(0, 70), `Hi ${u.name.split(' ')[0]},`, `<p style="font-size:15px">${esc(text)}</p>`).catch(() => {}));
}

module.exports = { sendMail, notifyEmail, emailEnabled, isConfigured, esc };
