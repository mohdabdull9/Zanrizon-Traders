/* =============================================================================
   DeepQr core: client, state, helpers, icons, auth, navigation, data loading
   ============================================================================= */
const CFG = window.DQ_CONFIG || {};
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);

let session = null, me = null, business = null, perms = {}, isAdmin = false;
let view = 'login', viewParams = {}, authMode = 'login', search = '', busy = false;
let wallet = null, platform = { currency: 'TZS', qr_fee: 25 }, adminData = null;
let myDevice = null, myShift = null, dbReady = true;
let cache = {
  shops: [], categories: [], products: [], stock: {}, sales: [], saleLines: [], purchases: [], transfers: [], adjustments: [],
  expenses: [], activity: [], members: [], orders: [], orderItems: [], items: [], generations: [], devices: [], topups: [],
  walletTx: [], recs: [], customers: [], suppliers: [], held: [], announcements: [], receipts: [], supplierPayments: [],
  counts: [], shifts: [], printOrders: []
};
let sidebarCollapsed = lsGet('dq_sidebar') === '1', mobileSidebarOpen = false;
const PAGES = {};

/* ---------------- small utilities ---------------- */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function lsJson(k, d) { try { return JSON.parse(lsGet(k)) ?? d; } catch (e) { return d; } }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function jsq(s) { return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' '); }
function cur() { return business?.currency || platform.currency || 'TZS'; }
function num(n) { const v = Number(n || 0); return v.toLocaleString(undefined, { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
function money(n, c) { return num(n) + ' ' + (c || cur()); }
function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : 0; }
function pad(n) { return String(n).padStart(2, '0'); }
function dateOnly(d = new Date()) { const x = new Date(d); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); }
function addDays(n, from) { const d = from ? new Date(from + 'T00:00:00') : new Date(); d.setDate(d.getDate() + n); return dateOnly(d); }
function daysUntil(ds) { if (!ds) return null; return Math.round((new Date(ds + 'T00:00:00') - new Date(dateOnly() + 'T00:00:00')) / 86400000); }
function daysSince(ds) { const d = daysUntil(ds); return d === null ? null : -d; }
function timeNow() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function fmtDT(s) { return s ? new Date(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''; }
function fmtD(s) { return s ? new Date(String(s).length === 10 ? s + 'T00:00:00' : s).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
function ago(s) { if (!s) return '—'; const m = Math.round((Date.now() - new Date(s)) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); if (h < 24) return h + ' h ago'; const d = Math.round(h / 24); return d + ' day' + (d > 1 ? 's' : '') + ' ago'; }
function roleName(r) { return { owner: 'Owner', manager: 'Manager', inventory: 'Store Operator', main_operator: 'Store Operator', cashier: 'Cashier' }[r] || r; }
function isStoreOp() { return me && (me.role === 'inventory' || me.role === 'main_operator'); }
function isMgr() { return me && (me.role === 'owner' || me.role === 'manager'); }
function can(p) { if (!me) return false; if (isMgr()) return true; if (p === 'manager') return false; if (p === 'inventory') return isStoreOp(); return !!perms[p]; }
function canQR() { return me && ['owner', 'manager', 'inventory', 'main_operator'].includes(me.role); }
function norm(s) { return String(s ?? '').trim().replace(/\s+/g, '').toLowerCase(); }
function product(codeOrBarcode) { const v = norm(codeOrBarcode); if (!v) return null; return cache.products.find(p => norm(p.code) === v || norm(p.barcode) === v); }
function productById(id) { return cache.products.find(p => p.id === id); }
function shopObj(id) { return cache.shops.find(s => s.id === id); }
function supplierById(id) { return cache.suppliers.find(s => s.id === id); }
function customerById(id) { return cache.customers.find(c => c.id === id); }
function stock(shopId, code) { return Number(cache.stock[shopId]?.[code] || 0); }
function stockOf(shopId, pid) { const p = productById(pid); return p ? stock(shopId, p.code) : 0; }
function totalStock(p) { return cache.shops.reduce((a, s) => a + stock(s.id, p.code), 0); }
function setStockLocal(shopId, code, q) { cache.stock[shopId] = cache.stock[shopId] || {}; cache.stock[shopId][code] = Math.max(0, Number(q || 0)); }
function threshold(p) { const v = p?.low_stock; return (v === null || v === undefined || v === '') ? Number(business?.low_stock || 0) : Number(v); }
function statusTag(q, p) { const t = p ? threshold(p) : business.low_stock; return q <= 0 ? '<span class="tag out">Out</span>' : q <= t ? '<span class="tag low">Low</span>' : '<span class="tag ok">In stock</span>'; }
function visibleStores() { return cache.shops.filter(s => me.role !== 'cashier' || s.id === me.shop_id); }
function makeBarcode() { return '2' + Date.now().toString().slice(-9) + Math.floor(Math.random() * 10); }
function errMsg(e) { const m = String(e?.message || e || 'Something went wrong'); return m.replace(/^[A-Z_]{3,}:\s*/, ''); }
function errCode(e) { const m = String(e?.message || ''); const x = m.match(/^([A-Z_]{3,}):/); return x ? x[1] : null; }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now() + Math.random().toString(16).slice(2)); }
function sum(arr, f) { return arr.reduce((a, x) => a + Number((typeof f === 'function' ? f(x) : x[f]) || 0), 0); }
function groupBy(arr, f) { const o = {}; arr.forEach(x => { const k = f(x); (o[k] = o[k] || []).push(x); }); return o; }
function phoneClean(p) { return String(p || '').replace(/[^0-9+]/g, ''); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function copyText(t, label) {
  const done = () => toast((label || 'Copied') + ': ' + t, 'ok');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(done).catch(() => prompt('Copy this:', t));
  else prompt('Copy this:', t);
}
function downloadCSV(name, rows) {
  const csv = rows.map(r => r.map(c => { const s = String(c ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
function toast(msg, kind) {
  const t = document.getElementById('toast');
  t.className = 'toast ' + (kind ? 't-' + kind : '');
  t.innerHTML = (kind === 'bad' ? icon('alert') : kind === 'ok' ? icon('check') : icon('info')) + '<span>' + esc(msg) + '</span>';
  clearTimeout(window.__toastT); window.__toastT = setTimeout(() => t.classList.add('hidden'), kind === 'bad' ? 5200 : 3400);
}
function beep(ok = true) {
  if (lsGet('dq_beep') === '0') return;
  try {
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    window.__ac = window.__ac || new C(); const o = window.__ac.createOscillator(), g = window.__ac.createGain();
    o.frequency.value = ok ? 1250 : 220; o.type = ok ? 'sine' : 'square'; g.gain.value = .06;
    o.connect(g); g.connect(window.__ac.destination); o.start(); o.stop(window.__ac.currentTime + (ok ? .09 : .25));
  } catch (e) {}
  try { if (lsGet('dq_vibrate') !== '0' && navigator.vibrate) navigator.vibrate(ok ? 40 : [80, 40, 80]); } catch (e) {}
}

/* server calls ----------------------------------------------------------- */
async function rpc(fn, args) { const { data, error } = await sb.rpc(fn, args || {}); if (error) throw error; return data; }
async function rpcToast(fn, args, okMsg) {
  try { const d = await rpc(fn, args); if (okMsg) toast(okMsg, 'ok'); return d; }
  catch (e) { toast(errMsg(e), 'bad'); beep(false); return undefined; }
}
async function q(table) { const { data, error } = await table; if (error) throw error; return data; }
async function withBusy(btn, fn) {
  if (busy) return; busy = true; const old = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="muted">Working…</span>'; }
  try { return await fn(); } finally { busy = false; if (btn && document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = old; } }
}

/* ---------------- icons ---------------- */
const ICONS = {
  pin: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v1M14 20h1M17 17h4v4h-4z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  store: '<path d="M4 10v10h16V10M3 4h18l-1.5 6h-15z"/><path d="M9 20v-6h6v6"/>',
  transfer: '<path d="M7 7h13l-4-4M17 17H4l4 4"/>',
  truck: '<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><circle cx="16" cy="14" r="1.2"/>',
  minus: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  camera: '<path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  printer: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  refund: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a1 1 0 0 0 1 .8h9.6a1 1 0 0 0 1-.8L21 7H6"/>',
  gift: '<rect x="3" y="8" width="18" height="13" rx="1.5"/><path d="M12 8v13M3 12h18M12 8S9 3 6.5 4.5 8 8 12 8zM12 8s3-5 5.5-3.5S16 8 12 8z"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  coins: '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v4c0 1.7 2.7 3 6 3s6-1.3 6-3V7M3 11v4c0 1.7 2.7 3 6 3 1.2 0 2.3-.2 3.2-.5"/><circle cx="17" cy="16" r="4"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l6 4V6L6 10H4a1 1 0 0 0-1 1zM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  flash: '<path d="M7 2h10l-3 7h4L9 22l2-9H7z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  bluetooth: '<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
  terminal: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8v5H8zM9 15h.01M12 15h.01M15 15h.01M9 18h.01M12 18h.01M15 18h.01"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  whatsapp: '<path d="M3 21l1.6-4.8A8.5 8.5 0 1 1 8 19.6z"/><path d="M9 9.5c.3 2 2.5 4.2 4.5 4.5l1.2-1.2 1.8.8-.3 1.4c-3.8.4-7.6-3.4-7.2-7.2L10.4 7l.8 1.8z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'
};
function icon(n, cls = '') { return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`; }
function logoMark(size = 42) {
  return `<svg class="mark" style="width:${size}px;height:${size}px" viewBox="0 0 64 64" aria-label="DeepQr"><defs><linearGradient id="lgA${size}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0A1A44"/><stop offset="1" stop-color="#1D3FB8"/></linearGradient><linearGradient id="lgB${size}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2EE6C5"/><stop offset="1" stop-color="#11A7D9"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#lgA${size})"/><path d="M15 15h18a17 17 0 0 1 17 17v0a17 17 0 0 1-17 17H15z" fill="none" stroke="#fff" stroke-width="5.5" stroke-linejoin="round"/><rect x="22" y="23" width="14" height="18" rx="3.5" fill="url(#lgB${size})"/><rect x="45" y="45" width="6" height="6" rx="1.5" fill="#2EE6C5" opacity=".95"/><rect x="52" y="52" width="4.5" height="4.5" rx="1.2" fill="#2EE6C5" opacity=".6"/><rect x="8" y="52" width="4.5" height="4.5" rx="1.2" fill="#fff" opacity=".35"/></svg>`;
}
function wordmark() { return `<span class="word">Deep<b>Qr</b></span>`; }
function qrSvg(text, cell = 4) {
  if (!window.qrcode) return '<span class="muted">QR library not loaded</span>';
  const qq = qrcode(0, 'M'); qq.addData(String(text)); qq.make();
  return qq.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}
function renderBarcodes() {
  document.querySelectorAll('.barcode-svg').forEach(el => {
    try { JsBarcode(el, el.dataset.barcode, { format: 'CODE128', displayValue: true, height: Number(el.dataset.height) || 40, width: Number(el.dataset.width) || 1.6, margin: 4, fontSize: 11 }); } catch (e) {}
  });
}
function kpi(ic, label, value, sub, tone = '') { return `<div class="kpi"><div class="k"><span class="ico ${tone}">${icon(ic)}</span>${label}</div><div class="v">${value}</div><div class="s">${sub || ''}</div></div>`; }
function emptyState(ic, title, text, action = '') { return `<div class="empty-state"><div class="ico">${icon(ic)}</div><b>${title}</b><p style="margin:6px 0 12px">${text}</p>${action}</div>`; }
function progressBar(v, max, tone) { const p = max ? Math.min(100, Math.round(v / max * 100)) : 0; return `<div class="progress" title="${p}%"><i class="${tone || (p >= 100 ? 'ok' : '')}" style="width:${p}%"></i></div>`; }
function tabbar(id, tabs, active, onclick) {
  return `<div class="tabbar" role="tablist" id="${id}">${tabs.map(t => `<button role="tab" class="${t[0] === active ? 'active' : ''}" onclick="${onclick}('${t[0]}')">${t[2] ? icon(t[2]) : ''}${t[1]}${t[3] !== undefined && t[3] !== null && t[3] !== '' ? `<span class="count ${t[4] ? 'hot' : ''}">${t[3]}</span>` : ''}</button>`).join('')}</div>`;
}
function selectShops(id, selected, opts = {}) {
  const shops = opts.all ? cache.shops : visibleStores();
  return `<select id="${id}" class="input" ${opts.onchange ? `onchange="${opts.onchange}"` : ''}>${opts.any ? `<option value="">${opts.any}</option>` : ''}${shops.map(s => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
}
function productOptions(listId) { return `<datalist id="${listId}">${cache.products.filter(p => p.active !== false).map(p => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join('')}</datalist>`; }

/* ---------------- modal + drawer ---------------- */
function modal(html, size = '') { const m = document.getElementById('modal'); m.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true">${html}</div>`; m.classList.remove('hidden'); renderBarcodes(); setTimeout(() => { if (!m.contains(document.activeElement)) m.querySelector('[autofocus]')?.focus(); }, 30); }
function closeModal() {
  const m = document.getElementById('modal'); m.classList.add('hidden'); m.innerHTML = '';
  if (window.Scanner) Scanner.stopCamera();
  if (window.Scanner) Scanner.popHandler('modal');
  if (view === 'pos') setTimeout(() => document.getElementById('scanInput')?.focus(), 50);
}
function modalOpen() { return !document.getElementById('modal').classList.contains('hidden'); }
function drawer(html) { document.getElementById('drawer').innerHTML = `<div class="drawerBack" onclick="closeDrawer()"></div><aside class="drawer" role="dialog" aria-modal="true">${html}</aside>`; renderBarcodes(); }
function closeDrawer() { document.getElementById('drawer').innerHTML = ''; }
function drawerOpen() { return !!document.getElementById('drawer').innerHTML; }
function printModal() { document.body.classList.add('printing-modal'); window.print(); setTimeout(() => document.body.classList.remove('printing-modal'), 500); }
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (modalOpen()) closeModal(); else if (drawerOpen()) closeDrawer();
});
function confirmBox(title, text, okLabel, onOk, tone = 'primary') {
  modal(`<div class="cardHead"><div><h3>${title}</h3><p>${text}</p></div></div><div class="actions"><button class="btn ${tone}" id="cfOk">${okLabel}</button><button class="btn" onclick="closeModal()">Cancel</button></div>`, 'narrow');
  document.getElementById('cfOk').onclick = async (e) => { await onOk(e.currentTarget); };
}
function askBox(title, text, field, okLabel, onOk) {
  modal(`<form id="askF"><div class="cardHead"><div><h3>${title}</h3><p>${text}</p></div></div><div class="field"><label>${field.label}</label>${field.textarea ? `<textarea id="askV" rows="3" ${field.required ? 'required' : ''}>${esc(field.value || '')}</textarea>` : `<input id="askV" type="${field.type || 'text'}" value="${esc(field.value || '')}" ${field.required ? 'required' : ''} ${field.min !== undefined ? `min="${field.min}"` : ''} step="any" autofocus>`}</div><div class="actions" style="margin-top:14px"><button class="btn primary">${okLabel}</button><button type="button" class="btn" onclick="closeModal()">Cancel</button></div></form>`, 'narrow');
  document.getElementById('askF').onsubmit = async (e) => { e.preventDefault(); await onOk(document.getElementById('askV').value, e.submitter); };
}

/* ---------------- device + data ---------------- */
function deviceKey() {
  let k = lsGet('dq_device_key');
  if (!k) { const a = new Uint8Array(24); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => a[i] = Math.random() * 256 | 0); k = 'dqd_' + Array.from(a, b => b.toString(16).padStart(2, '0')).join(''); lsSet('dq_device_key', k); }
  return k;
}
async function logActivity(type, description) {
  await sb.from('activity_log').insert({ business_id: me.business_id, type, description, by_name: me.name });
  cache.activity.unshift({ type, description, by_name: me.name, created_at: new Date().toISOString() });
}
async function persistStock(shopId, code, qty) {
  const p = product(code); if (!p) return;
  await sb.from('stock_levels').upsert({ business_id: me.business_id, shop_id: shopId, product_id: p.id, qty: Math.max(0, qty) });
}
async function loadAllData() {
  const t = (n) => sb.from(n).select('*');
  const since = addDays(-180);
  const res = await Promise.all([
    t('shops').order('created_at'), t('categories').order('name'), t('products').order('name'), t('stock_levels'),
    t('sales').gte('date', since).order('created_at', { ascending: false }).limit(5000), t('purchases').order('created_at', { ascending: false }).limit(500),
    t('transfers').order('created_at', { ascending: false }).limit(300), t('adjustments').order('created_at', { ascending: false }).limit(500),
    t('expenses').order('created_at', { ascending: false }).limit(500), t('activity_log').order('created_at', { ascending: false }).limit(80),
    t('members').order('created_at'), t('orders').order('created_at', { ascending: false }).limit(300), t('order_items'),
    t('customers').order('name'), t('suppliers').order('name'), t('held_carts').order('created_at', { ascending: false }),
    t('announcements').order('created_at', { ascending: false }), t('order_receipts').order('received_at', { ascending: false }).limit(300),
    t('supplier_payments').order('created_at', { ascending: false }).limit(300), t('stock_counts').order('started_at', { ascending: false }).limit(50),
    t('shifts').order('opened_at', { ascending: false }).limit(60)
  ]);
  const [shops, categories, products, stockRows, sales, purchases, transfers, adjustments, expenses, activity, members, orders, orderItems,
    customers, suppliers, held, ann, receipts, spays, counts, shifts] = res.map(r => r.data || []);
  Object.assign(cache, { shops, categories, products, sales, purchases, transfers, adjustments, expenses, activity, members, orders, orderItems,
    customers, suppliers, held, announcements: ann, receipts, supplierPayments: spays, counts, shifts });
  const saleIds = sales.slice(0, 1500).map(s => s.id);
  cache.saleLines = [];
  for (let i = 0; i < saleIds.length; i += 150) {
    const { data } = await sb.from('sale_lines').select('*').in('sale_id', saleIds.slice(i, i + 150));
    cache.saleLines.push(...(data || []));
  }
  cache.stock = {};
  stockRows.forEach(r => { const p = cache.products.find(x => x.id === r.product_id); if (p) { cache.stock[r.shop_id] = cache.stock[r.shop_id] || {}; cache.stock[r.shop_id][p.code] = Number(r.qty); } });
  myShift = cache.shifts.find(s => s.status === 'open' && s.member_id === me.id) || null;
  if (typeof repKey !== 'undefined') repKey = '';
  cache.online = null; cache.onlineItems = []; if (typeof insights !== 'undefined') insights = null;
  await loadDeepQr();
}
async function loadDeepQr() {
  const [w, items, gens, devs, tops, wtx, recs, prints] = await Promise.all([
    sb.rpc('dq_wallet'),
    sb.from('product_items').select('id,product_id,shop_id,serial,expiry_date,status,generation_id,qr_payload,batch_ref,created_at').in('status', ['in_stock', 'transit']).limit(20000),
    sb.from('qr_generations').select('*').order('created_at', { ascending: false }).limit(300),
    sb.from('devices').select('*').order('created_at', { ascending: false }),
    sb.from('topup_requests').select('*').order('created_at', { ascending: false }).limit(100),
    sb.from('wallet_transactions').select('*').order('created_at', { ascending: false }).limit(300),
    sb.rpc('dq_qr_recommendations'),
    sb.from('qr_print_orders').select('*').order('created_at', { ascending: false }).limit(100)
  ]);
  wallet = w.data || wallet || {};
  platform = { ...platform, currency: wallet.currency || platform.currency, qr_fee: wallet.fee ?? platform.qr_fee };
  cache.items = items.data || []; cache.generations = gens.data || []; cache.devices = devs.data || [];
  cache.topups = tops.data || []; cache.walletTx = wtx.data || []; cache.recs = recs.data || []; cache.printOrders = prints.data || [];
  const { data: d } = await sb.rpc('dq_device_status', { p_key: deviceKey() }); myDevice = d || null;
}
async function refreshRecs() { const { data } = await sb.rpc('dq_qr_recommendations'); cache.recs = data || []; }
async function refreshWallet() { const { data } = await sb.rpc('dq_wallet'); if (data) wallet = data; }
async function reloadAndRender(msg) { await loadAllData(); renderView(); if (msg) toast(msg, 'ok'); }

/* ---------------- boot / auth ---------------- */
async function boot() {
  try {
    const { data: { session: s } } = await sb.auth.getSession();
    session = s;
    await loadRef();
    const pr = readPublicRoute(); if (pr) { pub = pr; view = pr.view; viewParams = pr.params; }
    const inv = new URLSearchParams(location.search).get('supplier_invite'); if (inv && !session) { authMode = 'supplier'; window.__supInvite = inv.toUpperCase(); }
    if (session) await loadMember(); else render();
  } catch (e) {
    document.getElementById('root').innerHTML = `<div class="lockScreen"><div class="bigIco">${icon('alert')}</div><h2>Can't reach DeepQr</h2><p class="muted">${esc(errMsg(e))}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
  }
}
async function loadMember() {
  const v = await sb.rpc('dq_version');
  dbReady = !v.error && Number(v.data) >= 5;
  if (!dbReady) { me = null; view = 'needsUpdate'; render(); return; }
  const who = await rpc('dq_whoami') || {};
  isAdmin = !!who.admin; adminRole = who.admin?.role || null;
  supplierAcc = who.supplier || null; customerAcc = who.customer || null;
  const st = await rpc('dq_my_status');
  if (!st?.member) {
    me = null;
    if (pub) { if (customerAcc) { const { data: acc } = await sb.from('customer_accounts').select('*').eq('auth_user_id', session.user.id).maybeSingle(); if (acc) Object.assign(customerAcc, acc); } render(); return; }
    if (isAdmin) { view = 'portal'; await loadAdmin(); render(); return; }
    if (supplierAcc) { await loadSupplier(); const h = (location.hash || '').replace('#', ''); view = h.startsWith('sup_') && PAGES[h] ? h : 'sup_home'; render(); return; }
    if (customerAcc) { const { data: acc } = await sb.from('customer_accounts').select('*').eq('auth_user_id', session.user.id).maybeSingle(); if (acc) Object.assign(customerAcc, acc); pub = { view: 'c_home', params: {} }; view = 'c_home'; viewParams = {}; render(); return; }
    view = 'register'; render(); return;
  }
  if (st.member.blocked || !st.member.active) {
    me = null; view = 'blocked'; window.__blocked = st; render(); return;
  }
  const { data: m } = await sb.from('members').select('*').eq('auth_user_id', session.user.id).single();
  me = m; perms = st.permissions || {};
  document.documentElement.setAttribute('data-theme', me.theme || 'light');
  const { data: b } = await sb.from('businesses').select('*').eq('id', m.business_id).single();
  business = b;
  await loadAllData();
  sb.from('members').update({ last_seen: new Date().toISOString() }).eq('id', me.id).then(() => {});
  onlineWatch();
  if (pub) { render(); return; }
  const fromHash = (location.hash || '').replace('#', '');
  view = (fromHash && PAGES[fromHash] && pageAllowed(fromHash)) ? fromHash : (me.role === 'cashier' ? 'pos' : 'dashboard');
  render();
}
async function loginSubmit(e) {
  e.preventDefault(); if (busy) return; busy = true;
  const idf = document.getElementById('lu').value.trim(), pass = document.getElementById('lp').value;
  const err = document.getElementById('loginErr'); err.textContent = '';
  try {
    let email = idf;
    if (looksLikePhone(idf)) email = shopperEmail(idf);
    else if (!idf.includes('@')) {
      const r = await sb.rpc('dq_login_email', { p_username: idf.toLowerCase() });
      email = r.error ? (await sb.from('username_directory').select('email').eq('username', idf.toLowerCase()).maybeSingle()).data?.email : r.data;
      if (!email) { err.textContent = 'No account found with that username.'; return; }
    }
    const { error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) { err.textContent = 'Incorrect username/email or password.'; return; }
    const { data: { session: s } } = await sb.auth.getSession(); session = s;
    await loadMember();
  } catch (x) { err.textContent = errMsg(x); } finally { busy = false; }
}
async function registerSubmit(e) {
  e.preventDefault(); if (busy) return; busy = true;
  const err = document.getElementById('regErr'); err.textContent = '';
  try {
    const bizName = document.getElementById('rb').value.trim(), ownerName = document.getElementById('rn').value.trim();
    const ref = (document.getElementById('rref')?.value || '').trim();
    const groups = checkedValues('rg');
    if (!groups.length) { err.textContent = 'Choose at least one group that describes what you sell.'; return; }
    if (!session) {
      const email = document.getElementById('re').value.trim(), pass = document.getElementById('rp').value, pass2 = document.getElementById('rp2').value;
      if (pass !== pass2) { err.textContent = 'Passwords do not match.'; return; }
      if (pass.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }
      const { data: signData, error: signErr } = await sb.auth.signUp({ email, password: pass });
      if (signErr) { err.textContent = signErr.message; return; }
      if (!signData.session) { toast('Check your email to confirm your account, then sign in.'); authMode = 'login'; view = 'login'; render(); return; }
      session = signData.session;
    }
    const { data: biz, error: bizErr } = await sb.from('businesses').insert({ name: bizName, short: bizName.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'BIZ', owner_auth_id: session.user.id, currency: 'TZS' }).select().single();
    if (bizErr) { err.textContent = bizErr.message; return; }
    const { error: memErr } = await sb.from('members').insert({ business_id: biz.id, auth_user_id: session.user.id, name: ownerName, role: 'owner' });
    if (memErr) { err.textContent = memErr.message; return; }
    await sb.from('shops').insert([{ business_id: biz.id, name: 'Main Store', type: 'warehouse' }, { business_id: biz.id, name: 'Main Shop', type: 'shop' }]);
    await sb.from('categories').insert([{ business_id: biz.id, name: 'General' }]);
    if (ref) { const r = await sb.rpc('dq_apply_referral', { p_code: ref }); if (r.error) toast('Referral code: ' + errMsg(r.error), 'bad'); }
    const gr = await sb.rpc('dq_set_business_groups', { p_groups: groups });
    if (gr.error) toast('Business type: ' + errMsg(gr.error), 'bad');
    toast('Welcome to DeepQr! Setting up your workspace…', 'ok');
    await loadMember();
    if (me && me.role === 'owner') go('catalog', { welcome: 1 });
  } finally { busy = false; }
}
async function adminClaimSubmit(e) {
  e.preventDefault(); if (busy) return; busy = true;
  const err = document.getElementById('admErr'); err.textContent = '';
  try {
    const email = document.getElementById('ae').value.trim(), pass = document.getElementById('ap').value, code = document.getElementById('ac').value.trim();
    let { error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) {
      const r = await sb.auth.signUp({ email, password: pass });
      if (r.error) { err.textContent = r.error.message; return; }
      if (!r.data.session) { err.textContent = 'Account created — confirm your email, then come back and activate.'; return; }
    }
    const { data: { session: s } } = await sb.auth.getSession(); session = s;
    const { data: ok, error: cErr } = await sb.rpc('dq_claim_platform_admin', { p_code: code });
    if (cErr || !ok) { err.textContent = cErr ? errMsg(cErr) : 'That activation code is not valid for this email.'; await sb.auth.signOut(); session = null; return; }
    toast('Platform portal ready', 'ok');
    await loadMember();
  } finally { busy = false; }
}
async function logout() { if (window.Scanner) Scanner.stopCamera(); await sb.auth.signOut(); session = null; me = null; business = null; isAdmin = false; adminData = null; supplierAcc = null; customerAcc = null; adminRole = null; supData = null; cHomeData = null; clearInterval(ooTimer);
  if (pub && pub.view !== 'c_home') { render(); return; } pub = null; try { history.replaceState(null, '', location.pathname); } catch (e) {} if (window.posState) posState.cart = []; view = 'login'; authMode = 'login'; location.hash = ''; render(); }
async function toggleTheme() {
  const next = (document.documentElement.getAttribute('data-theme') || 'light') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  if (me) { me.theme = next; await sb.from('members').update({ theme: next }).eq('id', me.id); }
  render();
}

/* ---------------- render root ---------------- */
function render() {
  const root = document.getElementById('root');
  if (view === 'needsUpdate') { root.innerHTML = needsUpdateHtml(); return; }
  if (view === 'blocked') { root.innerHTML = blockedHtml(); return; }
  if (inPublic()) { if (pub) { view = pub.view; viewParams = viewParams && Object.keys(viewParams).length ? viewParams : pub.params; } else if (!PUBLIC_VIEWS.includes(view)) view = 'c_home'; root.innerHTML = publicLayout(); renderView(); return; }
  if (!session || (!me && !isAdmin && !supplierAcc)) { root.innerHTML = authHtml(); bindAuth(); return; }
  root.innerHTML = layout(); applySidebarState(); renderView();
}
function needsUpdateHtml() {
  return `<div class="lockScreen" style="padding-top:12vh">${logoMark(54)}<h2>DeepQr needs a database update</h2><p class="muted">This version of DeepQr needs the latest database update. The DeepQr admin should run <span class="mono">supabase/migrations/20261014120000_deepqr_v5.sql</span> (after the v2, v3 and v4 files) in the Supabase SQL Editor, then reload this page.</p><div class="actions" style="justify-content:center"><button class="btn primary" onclick="location.reload()">Reload</button><button class="btn" onclick="logout()">Sign out</button></div></div>`;
}
function blockedHtml() {
  const st = window.__blocked || {};
  const platformBlock = st.member?.blocked;
  return `<div class="lockScreen" style="padding-top:12vh"><div class="bigIco">${icon('lock')}</div><h2>${platformBlock ? 'Your account is blocked by DeepQr' : 'Your account is disabled'}</h2><p class="muted">${platformBlock ? esc(st.member.blocked_reason || 'Contact DeepQr support for help.') : 'Ask the owner or a manager of ' + esc(st.business?.name || 'your business') + ' to enable your account.'}</p><button class="btn" onclick="logout()">${icon('logout')}Sign out</button></div>`;
}
function authHtml() {
  const mode = view === 'register' && !['supplier', 'customer'].includes(authMode) ? 'register' : authMode;
  const refFromUrl = new URLSearchParams(location.search).get('ref') || '';
  const heroes = {
    supplier: ['Get orders from shops, and get paid on record.', 'Businesses on DeepQr find you, send purchase orders and record every payment. You confirm what you supply and what you received.', [['truck', 'Orders arrive instantly'], ['tag', 'Your own price list'], ['coins', 'You confirm each payment']]],
    customer: ['Order from shops near you. Collect it or get it delivered.', 'Real stock and prices from local shops, delivery priced by distance, and points you spend at the next visit.', [['pin', 'Nearest branch first'], ['truck', 'Delivery by the km'], ['gift', 'Points at every shop']]],
    register: ['Run every branch from one scan.', 'QR labels, the till, stock, suppliers and an online shop with delivery. Set up in minutes, from your phone.', [['qr', 'A QR label for every item'], ['store', 'Your own online shop'], ['spark', 'Suggestions from your sales']]],
    def: ['One scan sells it, tracks it and proves it is genuine.', 'Every item gets its own DeepQr label. Shops sell at the till and online, suppliers get orders, shoppers earn points.', [['qr', 'A QR label for every item'], ['phone', 'Online shop with delivery'], ['shield', 'Checked payments']]]
  };
  const h = heroes[mode] || heroes.def;
  const hero = `<div class="authHero v5"><div class="heroBrand">${logoMark(40)}${wordmark()}</div>
   <div class="heroMain"><h1>${h[0]}</h1><p>${h[1]}</p></div>
   <div class="till" aria-hidden="true"><div class="tillBelt" id="tillBelt"><div class="tillLane" id="tillLane"></div><div class="tillScan"><i class="beam"></i></div></div>
    <div class="tillReceipt"><div class="rcHead"><b>DeepQr till</b><small id="rcNo">Receipt</small></div><div class="rcLines" id="rcLines"></div><div class="rcTotal"><span>Total</span><b id="rcTotal">0 TZS</b></div><div class="rcStamp" id="rcStamp">Paid · M-Pesa</div></div></div>
   <ul class="heroPoints">${h[2].map(f => `<li>${icon(f[0])}${f[1]}</li>`).join('')}</ul>
   <div class="heroShow" id="heroShow"></div>
   <div class="heroLinks"><button onclick="goPublic('shops')">${icon('store')} Shop online</button><button onclick="goPublic('verify',{code:''})">${icon('qr')} Check a label</button></div>
   <div class="heroFoot">© ${new Date().getFullYear()} DeepQr · Built for retail across Tanzania &amp; East Africa</div></div>`;
  const tabs = `<div class="tabs tabs4"><button class="${mode === 'login' ? 'active' : ''}" data-mode="login">Sign in</button><button class="${mode === 'register' ? 'active' : ''}" data-mode="register">Business</button><button class="${mode === 'supplier' ? 'active' : ''}" data-mode="supplier">Supplier</button><button class="${mode === 'customer' ? 'active' : ''}" data-mode="customer">Shopper</button></div>`;
  const pw = session ? '' : `<div class="formGrid"><div class="field"><label for="rp">Password</label><input id="rp" type="password" required minlength="6" autocomplete="new-password"></div><div class="field"><label for="rp2">Confirm</label><input id="rp2" type="password" required minlength="6" autocomplete="new-password"></div></div>`;
  let form = '';
  if (mode === 'login') form = `<form id="loginForm" class="stack"><div><h2>Welcome back</h2><p class="muted">Business owners and suppliers: email. Staff: username. Shoppers: phone number.</p></div>
    <div class="field"><label for="lu">Email, username or phone</label><input id="lu" required autocomplete="username"></div>
    <div class="field"><label for="lp">Password</label><input id="lp" type="password" required autocomplete="current-password"></div>
    <div id="loginErr" class="bad" style="min-height:20px"></div><button class="btn primary lg wide">Sign in</button>
    <p class="muted" style="font-size:12.5px;text-align:center;margin:4px 0 0">DeepQr team? <button type="button" class="priceBtn" data-mode="admin">Open the platform portal</button></p></form>`;
  else if (mode === 'register') form = `<form id="registerForm" class="stack"><div><h2>Register your business</h2><p class="muted">Create your workspace. You'll be the owner and can add shops and staff after.</p></div>
    <div class="field"><label for="rb">Business name</label><input id="rb" required placeholder="e.g. Zanrizon Traders"></div>
    <div class="field"><label for="rn">Your full name</label><input id="rn" required></div>
    ${session ? '' : `<div class="field"><label for="re">Email</label><input id="re" type="email" required></div>${pw}`}
    <div class="field"><label>What does your business sell? <span class="muted">(choose one or more)</span></label>${groupCardsHtml([], 'rg')}</div>
    <div class="field"><label for="rref">Referral code <span class="muted">(optional)</span></label><input id="rref" class="mono" value="${esc(refFromUrl)}" placeholder="From another DeepQr business"></div>
    <div id="regErr" class="bad" style="min-height:20px"></div><button class="btn primary lg wide">Create my business</button>${session ? `<button type="button" class="btn ghost wide" onclick="logout()">Use a different account</button>` : ''}</form>`;
  else if (mode === 'supplier') form = `<form id="supRegForm" class="stack"><div><h2>Join as a supplier</h2><p class="muted">Free. Businesses on DeepQr find you, order from you and pay you — all tracked.</p></div>
    ${window.__supInvite ? `<div class="banner ok">${icon('gift')}<div><b>You were invited by a business</b><p>Their orders will appear in your portal as soon as you join.</p></div></div>` : ''}
    <div class="field"><label for="sr1">Company name</label><input id="sr1" required></div>
    <div class="formGrid"><div class="field"><label for="sr2">Contact person</label><input id="sr2" required></div><div class="field"><label for="sr3">Phone</label><input id="sr3" type="tel" required placeholder="07XX XXX XXX"></div></div>
    ${session ? '' : `<div class="field"><label for="re">Email (for signing in)</label><input id="re" type="email" required></div>${pw}`}
    <div class="formGrid"><div class="field"><label for="sr4">Region / city</label><input id="sr4" placeholder="e.g. Dar es Salaam"></div><div class="field"><label for="sr5">TIN <span class="muted">(optional)</span></label><input id="sr5"></div></div>
    <div class="field"><label>What do you supply?</label>${groupCardsHtml([], 'srg')}</div>
    <div class="field"><label for="sr6">Invite code <span class="muted">(optional)</span></label><input id="sr6" class="mono" value="${esc(window.__supInvite || '')}"></div>
    <div id="supErr" class="bad" style="min-height:20px"></div><button class="btn primary lg wide">${icon('truck')} Create supplier account</button>${session ? `<button type="button" class="btn ghost wide" onclick="logout()">Use a different account</button>` : ''}</form>`;
  else if (mode === 'customer') form = `<form id="custRegForm" class="stack"><div><h2>Create a shopper account</h2><p class="muted">Order from DeepQr shops and collect points. You sign in with your phone number.</p></div>
    <div class="field"><label for="cr1">Your name</label><input id="cr1" required autocomplete="name"></div>
    <div class="field"><label for="cr2">Mobile number</label><input id="cr2" type="tel" required placeholder="07XX XXX XXX" autocomplete="tel"></div>
    ${session ? '' : pw}
    <div class="field"><label for="cr3">Area <span class="muted">(optional)</span></label><input id="cr3" placeholder="e.g. Kariakoo, Dar es Salaam"></div>
    <div id="custErr" class="bad" style="min-height:20px"></div><button class="btn primary lg wide">${icon('gift')} Create account &amp; start shopping</button></form>`;
  else form = `<form id="adminForm" class="stack"><div><h2>DeepQr platform portal</h2><p class="muted">For the platform owner and DeepQr team members. First time? Enter the one-time code you were given.</p></div>
    <div class="field"><label for="ae">Email</label><input id="ae" type="email" required autocomplete="username"></div>
    <div class="field"><label for="ap">Password</label><input id="ap" type="password" required minlength="6" autocomplete="current-password"></div>
    <div class="field"><label for="ac">Activation code <span class="muted">(first time only)</span></label><input id="ac" class="mono" placeholder="XXXX-XXXX-XXXX"></div>
    <div id="admErr" class="bad" style="min-height:20px"></div><button class="btn primary lg wide">${icon('shield')} Open portal</button>
    <p class="muted" style="font-size:12.5px;text-align:center;margin:4px 0 0"><button type="button" class="priceBtn" data-mode="login">Back to sign in</button></p></form>`;
  return `<div class="auth">${hero}<div class="authBox"><div class="panel"><div class="panelBrand">${logoMark(38)}${wordmark()}</div>${mode === 'admin' ? '' : tabs}${form}</div>
   <div class="authExtras"><div class="heroShow" id="heroShow2"></div><div class="heroLinks"><button onclick="goPublic('shops')">${icon('store')} Shop online</button><button onclick="goPublic('verify',{code:''})">${icon('qr')} Check a label</button></div></div></div></div>`;
}
function bindAuth() {
  tillStart(); heroShowcase();
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { authMode = b.dataset.mode; view = authMode === 'register' ? 'register' : 'login'; render(); }));
  const lf = document.getElementById('loginForm'); if (lf) lf.addEventListener('submit', loginSubmit);
  const rf = document.getElementById('registerForm'); if (rf) rf.addEventListener('submit', registerSubmit);
  const af = document.getElementById('adminForm'); if (af) af.addEventListener('submit', adminClaimSubmit);
  const sf = document.getElementById('supRegForm'); if (sf) sf.addEventListener('submit', supplierRegisterSubmit);
  const cf = document.getElementById('custRegForm'); if (cf) cf.addEventListener('submit', customerRegisterSubmit);
}
/* ---------------- sign-in hero: a till that scans items into a receipt ---------------- */
const TILL_ITEMS = [['Mango juice 1 L', 3500, 'bottle', '#F59E0B'], ['Rice 5 kg', 16000, 'bag', '#10B981'], ['Smartphone', 285000, 'phone', '#6366F1'], ['Cooking oil 3 L', 14500, 'bottle', '#EAB308'],
  ['Kitenge fabric', 25000, 'cloth', '#EC4899'], ['Laundry soap', 2500, 'box', '#0EA5E9'], ['Paracetamol 10s', 1500, 'box', '#EF4444'], ['Solar lamp', 45000, 'phone', '#14B8A6']];
const TILL_GLYPH = {
  bottle: '<path d="M16 6h8v5l3 4v19a2 2 0 0 1-2 2H15a2 2 0 0 1-2-2V15l3-4z" fill="currentColor" opacity=".9"/><rect x="15" y="18" width="10" height="8" rx="1" fill="#fff" opacity=".85"/>',
  bag: '<path d="M10 12h20l2 22H8z" fill="currentColor" opacity=".9"/><path d="M15 12a5 5 0 0 1 10 0" stroke="currentColor" stroke-width="2.5" fill="none"/><rect x="13" y="20" width="14" height="7" rx="1" fill="#fff" opacity=".85"/>',
  phone: '<rect x="12" y="5" width="16" height="30" rx="3" fill="currentColor" opacity=".9"/><rect x="14.5" y="9" width="11" height="19" rx="1" fill="#fff" opacity=".85"/><circle cx="20" cy="31.5" r="1.5" fill="#fff"/>',
  box: '<path d="M7 13 20 7l13 6v15l-13 6-13-6z" fill="currentColor" opacity=".9"/><path d="m7 13 13 6 13-6M20 19v15" stroke="#fff" stroke-width="1.6" fill="none" opacity=".8"/>',
  cloth: '<path d="M8 10h24v20H8z" fill="currentColor" opacity=".9"/><path d="M8 15h24M8 20h24M8 25h24" stroke="#fff" stroke-width="1.6" opacity=".7"/><circle cx="14" cy="17.5" r="1.4" fill="#fff"/><circle cx="26" cy="22.5" r="1.4" fill="#fff"/>'
};
const MINI_QR = '<svg viewBox="0 0 7 7" class="miniQr"><path d="M0 0h3v3H0zM4 0h3v3H4zM0 4h3v3H0z" fill="#0A1A44"/><path d="M1 1h1v1H1zM5 1h1v1H5zM1 5h1v1H1z" fill="#fff"/><path d="M4 4h1v1H4zM6 4h1v1H6zM5 5h1v1H5zM4 6h1v1H4zM6 6h1v1H6z" fill="#0A1A44"/></svg>';
let tillT = null, tillN = 0;
function tillItems() {
  const real = (window.__showcase || []).filter(x => x.image_url).slice(0, 8).map(x => ({ name: x.name, price: Number(x.price), cur: x.currency, img: x.image_url }));
  return [...real, ...TILL_ITEMS.map(([name, price, g, c]) => ({ name, price, cur: 'TZS', g, c }))].slice(0, Math.max(real.length, 8));
}
function parcelHtml(it) { return `${it.img ? `<img src="${esc(it.img)}" alt="">` : `<svg viewBox="0 0 40 40" style="color:${it.c}">${TILL_GLYPH[it.g]}</svg>`}${MINI_QR}`; }
function tillStart() {
  clearTimeout(tillT);
  const lane = document.getElementById('tillLane'), lines = document.getElementById('rcLines'); if (!lane || !lines) return;
  const items = tillItems(); let i = 0, total = 0, count = 0;
  const totalEl = document.getElementById('rcTotal'), stamp = document.getElementById('rcStamp'), belt = document.getElementById('tillBelt');
  const addLine = it => {
    if (count === 0) { lines.innerHTML = ''; total = 0; stamp.classList.remove('show'); document.getElementById('rcNo').textContent = 'Receipt ' + String(1041 + (tillN++)).padStart(5, '0'); }
    const row = document.createElement('div'); row.className = 'rcLine'; row.innerHTML = `<span>${esc(it.name)}</span><b>${num(it.price)}</b>`; lines.appendChild(row);
    total += it.price; count++; totalEl.textContent = money(total, it.cur);
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { items.slice(0, 3).forEach(addLine); stamp.classList.add('show'); return; }
  const step = () => {
    if (!document.getElementById('tillLane')) return;
    if (document.hidden) { tillT = setTimeout(step, 1000); return; }
    if (count >= 4) { stamp.classList.add('show'); count = 0; tillT = setTimeout(step, 2200); return; }
    const it = items[i++ % items.length], el = document.createElement('div');
    el.className = 'parcel'; el.innerHTML = parcelHtml(it); lane.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('go')));
    setTimeout(() => { if (!belt.isConnected) return; belt.classList.add('hit'); el.classList.add('scanned'); addLine(it); setTimeout(() => belt.classList.remove('hit'), 380); }, 1250);
    setTimeout(() => el.remove(), 2700);
    tillT = setTimeout(step, 1650);
  };
  step();
}
function heroShowcase() {
  const fill = () => {
    const l = (window.__showcase || []).filter(x => x.image_url);
    if (!l.length) return;
    ['heroShow', 'heroShow2'].map(i => document.getElementById(i)).filter(Boolean).forEach(el => el.innerHTML = `<h3>Order now from shops on DeepQr</h3><div class="showRow">${l.slice(0, 10).map(x => `<button class="showTile" onclick="goPublic('store',{slug:'${jsq(x.slug)}'})"><img src="${esc(x.image_url)}" alt="" loading="lazy"><b>${esc(x.name)}</b><span>${money(x.price, x.currency)}</span><small>${esc(x.shop)}</small></button>`).join('')}</div>`);
  };
  if (window.__showcase) { fill(); return; }
  sb.rpc('dq_store_showcase').then(({ data }) => { window.__showcase = data || []; fill(); if (window.__showcase.some(x => x.image_url)) tillStart(); });
}
async function signUpIfNeeded(email, errEl) {
  if (session) return true;
  const pass = document.getElementById('rp').value, pass2 = document.getElementById('rp2').value;
  if (pass !== pass2) { errEl.textContent = 'Passwords do not match.'; return false; }
  if (pass.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return false; }
  const { data, error } = await sb.auth.signUp({ email, password: pass });
  if (error) { errEl.textContent = /registered/i.test(error.message) ? 'This login already exists — sign in instead.' : error.message; return false; }
  if (!data.session) { const r = await sb.auth.signInWithPassword({ email, password: pass }); if (r.error) { toast('Check your email to confirm your account, then sign in.'); authMode = 'login'; view = 'login'; render(); return false; } }
  const { data: { session: s } } = await sb.auth.getSession(); session = s; return true;
}
async function supplierRegisterSubmit(e) {
  e.preventDefault(); if (busy) return; busy = true;
  const err = document.getElementById('supErr'); err.textContent = '';
  try {
    const groups = checkedValues('srg');
    if (!groups.length) { err.textContent = 'Choose at least one group you supply.'; return; }
    if (!(await signUpIfNeeded(document.getElementById('re')?.value.trim(), err))) return;
    await rpc('dq_supplier_register', { p: { company_name: document.getElementById('sr1').value, contact_person: document.getElementById('sr2').value, phone: document.getElementById('sr3').value, region: document.getElementById('sr4').value, tin: document.getElementById('sr5').value, groups, invite_code: document.getElementById('sr6').value } });
    window.__supInvite = null; try { history.replaceState(null, '', location.pathname); } catch (x) {}
    toast('Welcome to DeepQr! Add your price list so businesses can order.', 'ok');
    await loadMember(); if (supplierAcc) go('sup_products');
  } catch (x) { err.textContent = errMsg(x); } finally { busy = false; }
}
async function customerRegisterSubmit(e) {
  e.preventDefault(); if (busy) return; busy = true;
  const err = document.getElementById('custErr'); err.textContent = '';
  try {
    const phone = document.getElementById('cr2').value;
    if (String(phone).replace(/\D/g, '').length < 9) { err.textContent = 'Enter your full mobile number.'; return; }
    if (!(await signUpIfNeeded(shopperEmail(phone), err))) return;
    await rpc('dq_customer_register', { p: { name: document.getElementById('cr1').value, phone, area: document.getElementById('cr3').value } });
    toast('Karibu! Find a shop and place your first order.', 'ok');
    pub = { view: 'shops', params: {} }; await loadMember();
  } catch (x) { err.textContent = errMsg(x); } finally { busy = false; }
}

/* ---------------- navigation ---------------- */
function navGroups() {
  if (!me) { if (supplierAcc) return supNav(); return portalSections().map(([gname, items]) => [gname, items.map(t => ['portal:' + t[0], t[1], t[2]])]); }
  const r = me.role; const g = [];
  if (r === 'cashier') {
    g.push(['Sell', [['pos', 'Scan & Sell', 'scan'], ['online', 'Online orders', 'phone'], ['sales', 'Sales', 'receipt'], ['customers', 'Customers', 'users']]]);
    g.push(['Stock', [['inventory', 'My stock', 'layers'], ['expiry', 'Expiry', 'clock'], ['transfers', 'Transfers', 'transfer'], ['orders', 'Deliveries', 'truck']]]);
    if (perms.can_view_reports) g.push(['Insights', [['reports', 'Reports', 'chart']]]);
  } else if (isStoreOp()) {
    g.push(['Overview', [['dashboard', 'Dashboard', 'dashboard'], ['insights', 'Smart suggestions', 'spark']]]);
    g.push(['Stock', [['products', 'Products', 'box'], ['shopprod', 'Shop products', 'tag'], ['catalog', 'Product catalogue', 'spark'], ['qr', 'QR Codes', 'qr'], ['inventory', 'Inventory', 'layers'], ['expiry', 'Expiry', 'clock'], ['transfers', 'Transfers', 'transfer'], ['orders', 'Purchase orders', 'truck']]]);
    if (perms.can_view_reports) g.push(['Insights', [['reports', 'Reports', 'chart']]]);
  } else {
    g.push(['Sell', [['dashboard', 'Dashboard', 'dashboard'], ['insights', 'Smart suggestions', 'spark'], ['pos', 'Scan & Sell', 'scan'], ['sales', 'Sales', 'receipt'], ['customers', 'Customers', 'users']]]);
    g.push(['Online shop', [['online', 'Online orders', 'phone'], ['shopprod', 'Shop products', 'tag'], ['shopsetup', 'Shop setup', 'store']]]);
    g.push(['Stock', [['products', 'Products', 'box'], ['catalog', 'Product catalogue', 'spark'], ['qr', 'QR Codes', 'qr'], ['inventory', 'Inventory', 'layers'], ['expiry', 'Expiry', 'clock'], ['transfers', 'Transfers', 'transfer'], ['orders', 'Purchase orders', 'truck']]]);
    g.push(['Business', [['reports', 'Reports', 'chart'], ['payments', 'Payments', 'coins'], ['expenses', 'Expenses', 'minus'], ['stores', 'Stores & shops', 'store'], ['users', 'Staff', 'user'], ['devices', 'Devices & scanners', 'phone'], ['wallet', 'QR Wallet', 'wallet'], ['settings', 'Settings', 'settings']]]);
  }
  if (isAdmin) g.push(['Platform', [['portal', 'Owner portal', 'shield']]]);
  return g;
}
function pageAllowed(v) { return navGroups().some(([, items]) => items.some(i => i[0] === v || i[0].startsWith(v + ':'))) || ['inventoryReport', 'needsUpdate'].includes(v); }
function expiredCount() { return cache.items.filter(i => i.expiry_date && daysUntil(i.expiry_date) < 0).length; }
function lowStockCount() { let n = 0; visibleStores().forEach(st => cache.products.forEach(p => { const qq = stock(st.id, p.code); if (qq <= threshold(p) && qq > 0) n++; })); return n; }
function navBadge(k) {
  const b = (n, cls = '') => n ? `<span class="badge ${cls}">${n}</span>` : '';
  if (k === 'expiry') return b(expiredCount());
  if (k === 'dashboard') return b(lowStockCount());
  if (k === 'devices') return b(cache.devices.filter(d => d.status === 'pending').length, 'teal');
  if (k === 'orders') return b(cache.orders.filter(o => ['ordered', 'pending', 'partial'].includes(o.status) && o.expected_date && daysUntil(o.expected_date) < 0).length);
  if (k === 'customers') return '';
  if (k === 'portal' && adminData) return b((adminData.topups || []).filter(t => t.status === 'pending').length, 'teal');
  if (k === 'pos' && cache.held.length) return b(cache.held.length, 'teal');
  if (k === 'shopprod') return business?.store_enabled && (isMgr() || isStoreOp()) ? b(storeStats().noPrice) : '';
  if (k === 'online') return b((cache.online || []).filter(o => o.status === 'placed').length || ooSeen || 0);
  if (k === 'payments') return b((cache.online || []).filter(o => o.payment_status === 'pending_verification' && !['cancelled', 'rejected'].includes(o.status)).length, 'teal');
  if (k.startsWith('portal:') && adminData) return b(portalCount(k.slice(7)) || 0, 'teal');
  return '';
}
function layout() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const bizCard = me ? `<div class="sideBiz"><b>${esc(business.name)}</b><small>${esc(roleName(me.role))}${me.shop_id ? ' · ' + esc(shopObj(me.shop_id)?.name || '') : ''}</small><br><span class="code">ID ${esc(business.code || '—')}</span></div>`
    : supplierAcc ? `<div class="sideBiz"><b>${esc(supplierAcc.company_name)}</b><small>Supplier${supplierAcc.verified ? ' · ✔ verified' : ''}</small><br><span class="code">${esc(supplierAcc.code || '')}</span></div>`
    : `<div class="sideBiz"><b>DeepQr Platform</b><small>${esc({ owner: 'Platform owner', admin: 'Administrator', finance: 'Finance', support: 'Support', catalog: 'Catalogue' }[adminRole] || 'Team')}</small></div>`;
  const lowBal = me && wallet && Number(wallet.balance || 0) + Number(wallet.bonus_balance || 0) < Number(wallet.low_balance_threshold || 500);
  return `<div class="app"><div class="sideOverlay" id="sideOverlay" onclick="closeMobileSidebar()"></div>
  <aside class="side"><div class="sideBrand">${logoMark(36)}${wordmark()}</div>${bizCard}
   <nav class="nav">${navGroups().map(([gname, items]) => `<div class="navSec">${gname}</div>` + items.map(x => `<button class="${view === x[0] || (view === 'portal' && x[0] === 'portal:' + (viewParams.tab || 'overview')) ? 'active' : ''}" onclick="go('${x[0]}');closeMobileSidebar()" title="${esc(x[1])}">${icon(x[2])}<span>${x[1]}</span>${x[3] ? `<span class="badge ${x[0] === 'sup_payments' ? 'teal' : ''}">${x[3]}</span>` : navBadge(x[0])}</button>`).join('')).join('')}</nav>
   <div class="sideFoot nav"><button onclick="logout()">${icon('logout')}<span>Sign out</span></button></div></aside>
  <main class="main"><header class="top"><button class="iconBtn" onclick="toggleSidebar()" title="Menu" aria-label="Menu">${icon('menu')}</button>
   ${me ? `<div class="topSearch">${icon('search')}<input id="globalSearch" value="${esc(search)}" oninput="globalSearch(this.value)" placeholder="Search products, serials, receipts, customers…" aria-label="Search"></div>` : ''}
   <div class="topRight">
    ${me && myShift ? `<button class="shiftChip hideSm" onclick="go('pos')" title="Your till shift"><span class="dot"></span>Shift open</button>` : ''}
    ${me && wallet && isMgr() ? `<button class="chip ${lowBal ? 'warn' : 'teal'} hideSm" onclick="go('wallet')" title="QR wallet">${icon('wallet')}${money(Number(wallet.balance || 0) + Number(wallet.bonus_balance || 0), wallet.currency)}</button>` : ''}
    ${me && wallet?.status === 'suspended' ? `<span class="chip bad">Suspended</span>` : ''}
    <button class="iconBtn" onclick="toggleTheme()" title="Dark mode" aria-label="Toggle dark mode">${icon(dark ? 'sun' : 'moon')}</button>
    ${me ? `<div class="who"><b>${esc(me.name)}</b><small>${esc(roleName(me.role))}</small></div>${me.avatar ? `<img class="avatar" src="${me.avatar}" alt="">` : `<div class="avatar">${esc((me.name || 'U').slice(0, 1).toUpperCase())}</div>`}` : supplierAcc ? `<div class="who"><b>${esc(supplierAcc.contact_person || supplierAcc.company_name)}</b><small>Supplier</small></div><div class="avatar">${icon('truck')}</div>` : `<div class="avatar">${icon('shield')}</div>`}
   </div></header>
  <section class="content" id="content"></section></main></div>`;
}
function toggleSidebar() {
  if (window.innerWidth <= 900) mobileSidebarOpen = !mobileSidebarOpen; else { sidebarCollapsed = !sidebarCollapsed; lsSet('dq_sidebar', sidebarCollapsed ? '1' : '0'); }
  applySidebarState();
}
function applySidebarState() {
  const side = document.querySelector('.side'), ov = document.getElementById('sideOverlay'); if (!side) return;
  side.classList.toggle('collapsed', sidebarCollapsed && window.innerWidth > 900);
  side.classList.toggle('mobileOpen', mobileSidebarOpen && window.innerWidth <= 900);
  if (ov) ov.classList.toggle('show', mobileSidebarOpen && window.innerWidth <= 900);
}
function closeMobileSidebar() { if (window.innerWidth <= 900) { mobileSidebarOpen = false; applySidebarState(); } }
function go(v, params = {}) {
  if (v.startsWith('portal:')) { params = { ...params, tab: v.slice(7) }; v = 'portal'; }
  if (PUBLIC_VIEWS.includes(v)) { goPublic(v, params); return; }
  if (pub) { pub = null; try { history.replaceState(null, '', location.pathname + '#' + v); } catch (e) {} }
  if (window.Scanner) { Scanner.stopCamera(); Scanner.popHandler(view); }
  if (modalOpen()) closeModal();
  closeDrawer();
  view = v; viewParams = params || {}; search = '';
  try { history.replaceState(null, '', '#' + v); } catch (e) {}
  render(); window.scrollTo(0, 0);
}
function globalSearch(v) {
  search = v;
  if (PAGES[view]?.searchable) renderView();
  else if (v.length >= 3 && /^\d{9,}$|^DQ1/i.test(v.trim())) { go('qr', { tab: 'find', code: v.trim() }); }
}
function liveSearch(el) { const pos = el.selectionStart, id = el.id; search = el.value; renderView(); const ne = document.getElementById(id); if (ne) { ne.focus(); try { ne.setSelectionRange(pos, pos); } catch (e) {} } }
function announcementsHtml() {
  const dismissed = lsJson('dq_dismissed', []);
  return cache.announcements.filter(a => !dismissed.includes(a.id)).map(a => `<div class="announce ${esc(a.level)}">${icon(a.level === 'success' ? 'gift' : a.level === 'info' ? 'megaphone' : 'alert')}<div><b>${esc(a.title)}</b>${a.body ? `<p>${esc(a.body)}</p>` : ''}</div><button class="x" onclick="dismissAnn('${a.id}')" title="Dismiss">${icon('x')}</button></div>`).join('');
}
function dismissAnn(id) { const d = lsJson('dq_dismissed', []); d.push(id); lsSet('dq_dismissed', JSON.stringify(d.slice(-50))); renderView(); }
function renderView() {
  const page = PAGES[view] || PAGES.dashboard;
  if (!page) return;
  document.title = page.title + ' · DeepQr';
  const actions = page.actions ? page.actions() : '';
  const banners = [];
  if (me && wallet?.status === 'suspended') banners.push(`<div class="banner bad">${icon('lock')}<div><b>Account suspended by DeepQr</b><p>${esc(wallet.status_note || 'Sales and QR generation are paused. Contact DeepQr support.')}</p></div></div>`);
  const c = document.getElementById('content'); if (!c) return;
  c.innerHTML = `<div class="pageHead ${page.noHead ? 'hidden' : ''}"><div><h1>${page.title}</h1><p>${typeof page.sub === 'function' ? page.sub() : (page.sub || '')}</p></div><div class="actions noPrint">${actions}</div></div>${me ? announcementsHtml() : ''}${banners.join('')}<div id="pageBody">${page.render()}</div>`;
  renderBarcodes();
  if (page.after) page.after();
}
function setTab(key, value) { viewParams[key] = value; renderView(); }
window.addEventListener('resize', applySidebarState);
window.addEventListener('hashchange', () => { const h = location.hash.replace('#', ''); if (me && h && h !== view && PAGES[h] && pageAllowed(h)) go(h); });
