import { state, api, render } from './core.js';
import { refreshMe } from './layout.js';
import { startTranslator, setLang, getLang } from './i18n.js';
import './common.js';
import './parent.js';
import './tutor.js';
import './admin.js';
import './features.js';
import './ops.js';

async function boot() {
  try { state.categories = (await api('/categories')).items; } catch { /* offline */ }
  try { state.config = await api('/config'); } catch { state.config = {}; }
  const u = await refreshMe().catch(() => null);
  if (u && u.lang && u.lang !== getLang()) setLang(u.lang);
  startTranslator();
  window.addEventListener('hashchange', render);
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
boot();
