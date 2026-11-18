import { state, api, go, homeFor, esc, initials, toast, route, render } from './core.js';
import { LANGS, getLang, setLang } from './i18n.js';

const NAV = {
  parent: [['#/parent', '🏠', 'Home'], ['#/parent/find', '🔍', 'Find tutors'], ['#/parent/bookings', '📅', 'Bookings'], ['#/community', '🏘️', 'Community'],
    ['#/wallet', '👛', 'Wallet'], ['#/parent/children', '🧒', 'My children'], ['#/referrals', '🎁', 'Refer & earn'], ['#/ads', '📣', 'Advertise'], ['#/support', '💬', 'Help'], ['#/account', '⚙️', 'Account']],
  tutor: [['#/tutor', '🏠', 'Home'], ['#/tutor/bookings', '📅', 'Bookings'], ['#/tutor/earnings', '📈', 'Earnings'], ['#/tutor/leave', '🗓️', 'Leave days'], ['#/tutor/profile', '👤', 'Profile'], ['#/tutor/kyc', '🛡️', 'KYC'],
    ['#/wallet', '👛', 'Wallet'], ['#/community', '🏘️', 'Community'], ['#/referrals', '🎁', 'Refer & earn'], ['#/ads', '📣', 'Advertise'], ['#/support', '💬', 'Help'], ['#/account', '⚙️', 'Account']],
  admin: [['#/admin', '📊', 'Dashboard'], ['#/admin/analytics', '📈', 'Analytics'], ['#/admin/kyc', '🛡️', 'KYC'], ['#/admin/payments', '💳', 'Payments'], ['#/admin/tickets', '🎧', 'Helpline'],
    ['#/admin/sos', '🚨', 'SOS & live'], ['#/admin/bookings', '📅', 'Bookings'], ['#/admin/users', '👥', 'Users'], ['#/admin/staff', '🧑‍💼', 'Staff'],
    ['#/admin/coupons', '🏷️', 'Coupons'], ['#/admin/packages', '📦', 'Packages'], ['#/admin/invoices', '🧾', 'Invoices'], ['#/admin/payouts', '💸', 'Payouts'], ['#/admin/holidays', '🗓️', 'Holidays'], ['#/admin/comms', '📨', 'Comms logs'], ['#/admin/ads', '📣', 'Ads'], ['#/admin/groups', '🏘️', 'Community'], ['#/admin/config', '🎛️', 'Config'], ['#/admin/audit', '📜', 'Audit log'], ['#/account', '🔑', 'Account']],
};
// Staff see only the sections their permissions allow.
const STAFF_SECTION = { '#/admin/kyc': 'kyc', '#/admin/payments': 'payments', '#/admin/tickets': 'tickets', '#/admin/sos': 'sos',
  '#/admin/bookings': 'bookings', '#/admin/invoices': 'payments', '#/admin/payouts': 'payments', '#/admin/holidays': 'bookings', '#/admin/comms': 'bookings', '#/admin/users': 'users', '#/admin/ads': 'ads', '#/admin/groups': 'community' };
const MOBILE_TABS = { parent: 5, tutor: 5, admin: 5 };

export function navFor(u) {
  if (u.role === 'staff') return NAV.admin.filter(([h]) => h === '#/admin' || h === '#/account' || (STAFF_SECTION[h] && u.permissions.includes(STAFF_SECTION[h])));
  return NAV[u.role] || [];
}

// Renders the app shell (sidebar + topbar + mobile tab bar) and returns the main content element.
export function shell(title, html = '') {
  const u = state.user;
  const app = document.getElementById('app');
  const nav = navFor(u);
  const cur = '#' + (location.hash.replace(/^#/, '').split('?')[0] || '/');
  const isActive = (h) => cur === h || (h.split('/').length > 2 && cur.startsWith(h + '/'));
  const link = ([h, i, l]) => `<a href="${h}" class="${isActive(h) ? 'active' : ''}"><span class="ico">${i}</span><span>${esc(l)}</span></a>`;
  app.innerHTML = `<div class="shell">
    <aside class="side"><a class="brand" href="${homeFor(u)}"><img src="/icon.svg" alt="">Edvitta</a><nav class="nav">${nav.map(link).join('')}
      <a href="#" id="logout"><span class="ico">🚪</span><span>Log out</span></a></nav></aside>
    <main class="main"><div class="topbar"><h1>${esc(title)}</h1><div class="who">
      <select id="langsel" aria-label="Language" style="width:auto;min-height:36px;padding:4px 8px">${Object.entries(LANGS).map(([k, l]) => `<option value="${k}" ${getLang() === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <a class="bell" href="#/notifications" title="Notifications">🔔${u.unread ? `<span class="dot">${u.unread}</span>` : ''}</a>
      <a href="#/account" class="avatar sm" title="${esc(u.name)}">${esc(initials(u.name))}</a></div></div>
      <div id="view">${html}</div></main>
    <nav class="tabbar">${nav.slice(0, MOBILE_TABS[u.role === 'staff' ? 'admin' : u.role]).map(link).join('')}<a href="#/more"><span class="ico">☰</span><span>More</span></a></nav>
  </div>`;
  app.querySelector('#langsel').onchange = async (e) => { setLang(e.target.value); await api('/auth/prefs', { method: 'PUT', body: { lang: e.target.value } }).catch(() => {}); location.reload(); };
  app.querySelector('#logout').onclick = async (e) => { e.preventDefault(); await api('/auth/logout', { method: 'POST' }); state.user = null; state.socket?.disconnect(); go('#/'); };
  return app.querySelector('#view');
}

route('/more', () => {
  const v = shell('Menu');
  v.innerHTML = `<div class="card nav">${navFor(state.user).map(([h, i, l]) => `<a href="${h}"><span class="ico">${i}</span>${esc(l)}</a>`).join('')}
    <a href="#" id="lo2"><span class="ico">🚪</span>Log out</a></div>`;
  v.querySelector('#lo2').onclick = async (e) => { e.preventDefault(); await api('/auth/logout', { method: 'POST' }); state.user = null; go('#/'); };
});

export function connectSocket() {
  if (!window.io || state.socket) return;
  state.socket = window.io({ withCredentials: true });
  state.socket.on('notification', (n) => {
    toast('🔔 ' + n.text);
    if (state.user) state.user.unread = (state.user.unread || 0) + 1;
    const bell = document.querySelector('.bell');
    if (bell) bell.innerHTML = `🔔<span class="dot">${state.user.unread}</span>`;
    // If the notification is about the page being viewed, refresh it so status changes show up live.
    if (n.link && location.hash.split('?')[0] === n.link) render();
  });
  state.socket.on('sos', (s) => toast(`🚨 SOS from ${s.name}! Open SOS & live.`, true));
}
export async function refreshMe() {
  const { user } = await api('/auth/me');
  state.user = user;
  if (user) connectSocket(); else { state.socket?.disconnect(); state.socket = null; }
  return user;
}

