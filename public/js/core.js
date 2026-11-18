// Core helpers: API client, escaping, router, toast, modals, maps, location.
export const state = { user: null, categories: [], socket: null, config: {} };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const rs = (paise) => { const r = Number(paise || 0) / 100; return '₹' + r.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 }); };
export const toRupees = (paise) => (Number(paise || 0) / 100);
export const fmtDate = (s) => (s ? new Date(typeof s === 'number' ? s * 1000 : s + (String(s).length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const fmtDT = (ts) => new Date(ts * 1000).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const initials = (n) => String(n || '?').replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export const catName = (slug) => state.categories.find((c) => c.slug === slug)?.name || slug;
export const catIcon = (slug) => state.categories.find((c) => c.slug === slug)?.icon || '📘';
export const todayLocal = () => new Date().toLocaleDateString('en-CA');
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const BADGE = { approved: 'ok', accepted: 'ok', completed: 'ok', active: 'ok', paid: 'ok', resolved: 'ok', open: 'warn', handled: 'ok',
  requested: 'warn', submitted: 'warn', pending: 'warn', in_progress: 'warn', on_the_way: 'warn', scheduled: '', full: 'grey',
  rejected: 'bad', cancelled: 'grey', suspended: 'bad', urgent: 'bad', high: 'warn', closed: 'grey', expired: 'grey', paused: 'grey', not_submitted: 'grey', missed: 'bad', clear: 'ok', flagged: 'bad', not_started: 'grey', assigned: 'warn', done: 'ok', reviewed: 'ok', present: 'ok', tutor_absent: 'bad', student_absent: 'warn', not_marked: 'grey' };
export const badge = (s) => `<span class="badge ${BADGE[s] ?? ''}">${esc(String(s).replace(/_/g, ' '))}</span>`;

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'edvitta' }, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; go('#/login'); }
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

let toastTimer;
export function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3200);
}

export function formData(form) {
  const o = {};
  for (const [k, v] of new FormData(form).entries()) {
    if (v instanceof File) continue;
    if (k.endsWith('[]')) (o[k.slice(0, -2)] ||= []).push(v); else o[k] = v;
  }
  return o;
}

// Wire a form: disables the button while submitting and shows errors as a toast.
export function onSubmit(root, sel, fn) {
  const f = root.querySelector(sel);
  if (!f) return;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try { await fn(formData(f), f); } catch (err) { toast(err.message, true); } finally { if (btn) btn.disabled = false; }
  });
}
export function on(root, sel, evt, fn) {
  root.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, async (e) => {
    try { await fn(e, el); } catch (err) { toast(err.message, true); }
  }));
}
export const act = (root, sel, fn) => on(root, sel, 'click', fn);

export function modal(html, bindFn) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
  const close = () => (root.innerHTML = '');
  root.querySelector('.modal-bg').addEventListener('click', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  bindFn?.(root.querySelector('.modal'), close);
  return close;
}
export function confirmBox(text, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    modal(`<p>${esc(text)}</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="cb-ok">${esc(okLabel)}</button></div>`,
      (m, close) => { m.querySelector('#cb-ok').onclick = () => { close(); resolve(true); }; m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(false))); });
  });
}

// ---------- Router ----------
const routes = [];
export function route(pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ re, keys, handler, opts });
}
export const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
let cleanup = [];
export const onLeave = (fn) => cleanup.push(fn);

export async function render() {
  cleanup.forEach((f) => { try { f(); } catch { /* */ } }); cleanup = [];
  document.getElementById('modal-root').innerHTML = '';
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = hash.split('?');
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    if (r.opts.roles && (!state.user || !r.opts.roles.includes(state.user.role))) return go(state.user ? homeFor(state.user) : '#/login');
    return r.handler({ params, query });
  }
  go(state.user ? homeFor(state.user) : '#/');
}
export const homeFor = (u) => ({ parent: '#/parent', tutor: '#/tutor', admin: '#/admin', staff: '#/admin' }[u.role] || '#/');

// ---------- Location & maps ----------
export function myLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not supported on this device'));
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error('Please allow location access, or search your area instead')), { enableHighAccuracy: true, timeout: 10000 });
  });
}
export async function geocode(text) {
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&countrycodes=in&limit=1&q=' + encodeURIComponent(text));
  const j = await r.json();
  if (!j[0]) throw new Error('Place not found. Try a nearby landmark or area name.');
  return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name };
}
export async function reverseGeocode({ lat, lng }) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=17`);
    return (await r.json()).display_name || '';
  } catch { return ''; }
}
export function makeMap(el, center = { lat: 12.9352, lng: 77.6245 }, zoom = 14) {
  if (!window.L) { el.innerHTML = '<div class="empty">Map could not load (offline?)</div>'; return null; }
  const map = L.map(el).setView([center.lat, center.lng], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  setTimeout(() => map.invalidateSize(), 100);
  return map;
}
export const pinIcon = (emoji, bg = '#4f46e5') => window.L && L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17],
  html: `<div style="width:34px;height:34px;border-radius:50%;background:${bg};display:grid;place-items:center;font-size:18px;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)">${emoji}</div>` });

// Location picker: a map with a draggable pin, "use my location" and an area search box.
export function locationPicker(container, initial, onChange) {
  container.innerHTML = `<div class="row" style="margin-bottom:8px"><input class="lp-q" placeholder="Search area, apartment or landmark" style="flex:1;min-width:180px">
    <button type="button" class="btn ghost sm lp-s">Search</button><button type="button" class="btn ghost sm lp-me">📍 My location</button></div>
    <div class="map lp-map"></div><p class="small muted lp-l">Drag the pin to your exact location.</p>`;
  const start = initial && initial.lat != null ? initial : { lat: 12.9352, lng: 77.6245 };
  const map = makeMap(container.querySelector('.lp-map'), start, 15);
  if (!map) return;
  const marker = L.marker([start.lat, start.lng], { draggable: true }).addTo(map);
  const set = async (p, label) => {
    marker.setLatLng([p.lat, p.lng]); map.setView([p.lat, p.lng], 16);
    const addr = label || (await reverseGeocode(p));
    container.querySelector('.lp-l').textContent = addr ? '📍 ' + addr : 'Location set';
    onChange({ ...p, address: addr });
  };
  marker.on('dragend', () => { const ll = marker.getLatLng(); set({ lat: ll.lat, lng: ll.lng }); });
  map.on('click', (e) => set({ lat: e.latlng.lat, lng: e.latlng.lng }));
  container.querySelector('.lp-me').onclick = async () => { try { await set(await myLocation()); } catch (e) { toast(e.message, true); } };
  const search = async () => { try { const r = await geocode(container.querySelector('.lp-q').value); await set(r, r.label); } catch (e) { toast(e.message, true); } };
  container.querySelector('.lp-s').onclick = search;
  container.querySelector('.lp-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  if (initial && initial.lat != null) onChange({ ...initial });
}

export async function adSlot(placement) {
  try {
    const { items } = await api('/ads?placement=' + placement);
    return items.map((a) => `<div class="ad"><span class="tag">AD</span>${a.image_url ? `<img src="${esc(a.image_url)}" alt="">` : '<div style="font-size:2rem">📣</div>'}
      <div><strong>${esc(a.title)}</strong><div class="small">${esc(a.body || '')}</div>${a.link ? `<a href="${esc(a.link)}" target="_blank" rel="noopener sponsored">Learn more →</a>` : ''}</div></div>`).join('');
  } catch { return ''; }
}
