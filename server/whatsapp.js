'use strict';
// WhatsApp alerts through the Meta WhatsApp Cloud API. OFF by default (admin Config → WhatsApp).
// Business-started WhatsApp messages must use a template that Meta has approved. Create one template
// (default name "edvitta_alert", category Utility) whose body is a single variable, for example:
//   "Edvitta: {{1}}"
// Every alert fills {{1}} with the notification text. Never blocks or fails the request that triggered it.
const { q, getSetting, getSecret, flag } = require('./db');

const isConfigured = () => !!(getSetting('whatsapp_phone_number_id', '') && getSecret('whatsapp_token'));
const enabled = () => flag('whatsapp_enabled') && isConfigured();

// Template parameters can't contain new lines, tabs or more than 4 spaces in a row, and are capped in length.
const clean = (t) => String(t).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 900);
const toE164 = (phone) => { const d = String(phone || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d.length === 12 && d.startsWith('91') ? d : null; };

async function sendText(phone, text, { force = false } = {}) {
  const to = toE164(phone);
  if (!to) return { error: 'Invalid phone number' };
  if (!force && !enabled()) return { skipped: true };
  if (!isConfigured()) return { error: 'WhatsApp is not configured' };
  const template = getSetting('whatsapp_template', 'edvitta_alert');
  const lang = getSetting('whatsapp_template_lang', 'en');
  const phoneId = getSetting('whatsapp_phone_number_id', '');
  if (!/^\d{5,25}$/.test(phoneId)) return { error: 'Phone number ID must be digits only' };
  const log = (status, error) => q.run('INSERT INTO whatsapp_log(to_phone, template, status, error) VALUES (?,?,?,?)', to.slice(0, 4) + '****' + to.slice(-3), template, status, error ? String(error).slice(0, 300) : null);
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getSecret('whatsapp_token')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template',
        template: { name: template, language: { code: lang }, components: [{ type: 'body', parameters: [{ type: 'text', text: clean(text) }] }] } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); const err = j.error?.message || `HTTP ${res.status}`; log('failed', err); return { error: err }; }
    log('sent'); return { sent: true };
  } catch (e) { log('failed', e.message); return { error: e.message }; }
}

// Called from notify(). Sends only "important" alerts unless the admin chose to send everything.
function notifyWhatsApp(userId, text, important) {
  if (!enabled()) return;
  if (!important && flag('whatsapp_important_only', '1')) return;
  const u = q.get("SELECT phone, whatsapp_alerts, status FROM users WHERE id = ?", userId);
  if (!u || !u.whatsapp_alerts || u.status !== 'active') return;
  setImmediate(() => sendText(u.phone, text).catch(() => {}));
}

module.exports = { sendText, notifyWhatsApp, enabled, isConfigured, toE164, clean };
