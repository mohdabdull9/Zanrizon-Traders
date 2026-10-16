/* =============================================================================
   v5 online shop for the business: products (price, photos, visibility),
   shop setup (branches on the map, delivery priced per km), map picker, photos
   ============================================================================= */
const PUB_BUCKET = 'dq-public';
const DAR = { lat: -6.7924, lng: 39.2083 };

/* ---------------- map (Leaflet + OpenStreetMap, loaded only when needed) ---------------- */
let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletP) return leafletP;
  leafletP = new Promise((res, rej) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; document.head.appendChild(l);
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = () => window.L ? res(window.L) : rej(new Error('Map could not load'));
    s.onerror = () => { leafletP = null; rej(new Error('Map could not load')); };
    document.head.appendChild(s);
  });
  return leafletP;
}
function myLocation() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('This device cannot share its location'));
    navigator.geolocation.getCurrentPosition(p => res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) }),
      e => rej(new Error(e.code === 1 ? 'Location is blocked. Allow location for this site in your browser, or move the pin on the map.' : 'Could not find your location. Move the pin on the map instead.')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
}
function kmBetween(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 1.3 * 10) / 10;
}
function fmtKm(v) { return Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
function mapsLink(lat, lng) { return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`; }
/* a map with one draggable pin. onMove({lat,lng}) fires when the pin moves. Returns {set(point)} */
function mountMap(elId, point, onMove, opts = {}) {
  const el = document.getElementById(elId); if (!el) return { set() {} };
  const ctl = { map: null, marker: null, set(p) { if (this.map && p) { this.marker.setLatLng([p.lat, p.lng]); this.map.setView([p.lat, p.lng], Math.max(this.map.getZoom(), 15)); } } };
  el.innerHTML = `<div class="mapFallback">${icon('pin')}<span>Loading map…</span></div>`;
  loadLeaflet().then(L => {
    if (!document.getElementById(elId)) return;
    el.innerHTML = '';
    const start = point && point.lat != null ? point : DAR;
    const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([start.lat, start.lng], point && point.lat != null ? 15 : 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    const pinIcon = L.divIcon({ className: 'dqPin', html: `<span>${icon(opts.shop ? 'store' : 'pin')}</span>`, iconSize: [36, 44], iconAnchor: [18, 42] });
    const marker = L.marker([start.lat, start.lng], { draggable: true, icon: pinIcon }).addTo(map);
    const fire = () => { const ll = marker.getLatLng(); onMove({ lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }); };
    marker.on('dragend', fire);
    map.on('click', e => { marker.setLatLng(e.latlng); fire(); });
    (opts.others || []).forEach(o => { if (o.lat != null) L.marker([o.lat, o.lng], { icon: L.divIcon({ className: 'dqPin other', html: `<span>${icon('store')}</span>`, iconSize: [30, 36], iconAnchor: [15, 34] }) }).addTo(map).bindTooltip(esc(o.name)); });
    ctl.map = map; ctl.marker = marker;
    setTimeout(() => map.invalidateSize(), 200);
  }).catch(() => { el.innerHTML = `<div class="mapFallback">${icon('pin')}<span>The map could not load on this connection. Use <b>${opts.shop ? 'Use my location here' : 'Use my current location'}</b> instead.</span></div>`; });
  return ctl;
}

/* ---------------- photos: shrink on the phone, upload to the public bucket ---------------- */
/* load, optionally square-crop, shrink and auto-correct light/colour (levels stretch per channel) */
async function processImage(file, o = {}) {
  const { max = 1400, square = false, enhance = true, q = 0.84, aspect = 0 } = o;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(file.name + ' is not a photo DeepQr can read (use JPG or PNG)')); i.src = url; });
    let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
    const want = square ? 1 : aspect;
    if (want) { if (sw / sh > want) { const w2 = Math.round(sh * want); sx = Math.round((sw - w2) / 2); sw = w2; } else { const h2 = Math.round(sw / want); sy = Math.round((sh - h2) / 2); sh = h2; } }
    const k = Math.min(1, max / Math.max(sw, sh));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    const g = c.getContext('2d', { willReadFrequently: enhance }); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high'; g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    if (enhance) autoLevels(g, c.width, c.height);
    return await new Promise(res => c.toBlob(b => res(b), 'image/jpeg', q));
  } finally { URL.revokeObjectURL(url); }
}
function autoLevels(g, w, h) {
  const d = g.getImageData(0, 0, w, h), px = d.data, hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)], n = w * h;
  for (let i = 0; i < px.length; i += 16) { hist[0][px[i]]++; hist[1][px[i + 1]]++; hist[2][px[i + 2]]++; }
  const total = Math.ceil(px.length / 16), lo = [], hi = [];
  for (let ch = 0; ch < 3; ch++) { let acc = 0, a = 0, b = 255; for (let v = 0; v < 256; v++) { acc += hist[ch][v]; if (acc > total * 0.006) { a = v; break; } } acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[ch][v]; if (acc > total * 0.006) { b = v; break; } } lo.push(a); hi.push(b); }
  // keep it gentle: never stretch more than ~35%, blend 75% towards the corrected value
  const lut = [0, 1, 2].map(ch => { const a = Math.min(lo[ch], 60), b = Math.max(hi[ch], 195), t = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) { const s = (v - a) * 255 / Math.max(b - a, 1); t[v] = Math.round(v * 0.25 + s * 0.75); } return t; });
  if (n > 0) for (let i = 0; i < px.length; i += 4) { px[i] = lut[0][px[i]]; px[i + 1] = lut[1][px[i + 1]]; px[i + 2] = lut[2][px[i + 2]]; }
  g.putImageData(d, 0, 0);
}
async function uploadPublic(path, blob) {
  const { error } = await sb.storage.from(PUB_BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
  if (error) throw error;
  return sb.storage.from(PUB_BUCKET).getPublicUrl(path).data.publicUrl;
}
/* every product photo is saved twice: the full photo and a small square thumbnail (-t.jpg) for fast grids */
async function uploadProductPhoto(pid, file, o = {}) {
  const base = `p/${business.id}/${pid}/${uid()}`;
  const [full, thumb] = await Promise.all([processImage(file, { max: 1400, square: !!o.square, enhance: o.enhance !== false }), processImage(file, { max: 480, square: true, enhance: o.enhance !== false, q: 0.8 })]);
  await uploadPublic(base + '-t.jpg', thumb);
  return uploadPublic(base + '.jpg', full);
}
function photoPath(url) { const i = String(url || '').indexOf('/' + PUB_BUCKET + '/'); return i < 0 ? null : decodeURIComponent(url.slice(i + PUB_BUCKET.length + 2).split('?')[0]); }
function prodThumb(p, size = 44) {
  return p?.image_url ? `<img class="pThumb" src="${esc(thumbOf(p.image_url))}" data-f="${esc(p.image_url)}" onerror="if(this.dataset.f&&this.src!==this.dataset.f)this.src=this.dataset.f" alt="" loading="lazy" style="width:${size}px;height:${size}px">`
    : `<span class="pThumb ph" style="width:${size}px;height:${size}px;--g:${GROUP_TONES[p?.group_code] || 'var(--primary-2)'}">${esc(String(p?.name || '?').slice(0, 2).toUpperCase())}</span>`;
}

/* ---------------- shop readiness: what customers can see ---------------- */
function onlineBranches() { return cache.shops.filter(s => s.type !== 'warehouse' && s.online !== false && s.active !== false && !s.blocked_by_platform); }
function onlineStock(p) { return onlineBranches().reduce((a, s) => a + stock(s.id, p.code), 0); }
function storeStats() {
  const all = cache.products.filter(p => p.active !== false);
  const shown = all.filter(p => p.online !== false && Number(p.price) > 0);
  return { all: all.length, shown: shown.length, noPrice: all.filter(p => p.online !== false && !(Number(p.price) > 0)).length,
           hidden: all.filter(p => p.online === false).length, noPhoto: shown.filter(p => !p.image_url).length,
           out: shown.filter(p => onlineStock(p) <= 0).length, sellable: shown.filter(p => onlineStock(p) > 0).length };
}
function storeHealthBanner() {
  if (!business.store_enabled || !isMgr() && !isStoreOp()) return '';
  const st = storeStats();
  if (st.sellable >= Math.min(5, st.all) && !st.noPrice) return '';
  const why = [st.noPrice ? `<b>${st.noPrice}</b> have no price` : '', st.out ? `<b>${st.out}</b> are out of stock at your online branches` : '', st.hidden ? `<b>${st.hidden}</b> are hidden` : ''].filter(Boolean).join(', ');
  return `<div class="banner warn">${icon('alert')}<div style="flex:1"><b>Customers can buy ${st.sellable} of your ${st.all} products</b><p>${why || 'Add more products to your shop.'}. Fix it in a few taps: add prices and photos, and choose what to show.</p></div><button class="btn small primary" onclick="go('shopprod',{f:'${st.noPrice ? 'price' : st.out ? 'out' : 'all'}'})">${icon('tag')}Fix shop products</button></div>`;
}

/* =============================================================================
   Shop products page
   ============================================================================= */
let spDraft = {}, spQ = '', spCat = '', spMode = lsGet('dq_spmode') || 'cards';
const SP_FILTERS = [['all', 'All'], ['shown', 'Visible to customers'], ['price', 'Needs a price'], ['photo', 'No photo'], ['out', 'Out of stock online'], ['hidden', 'Hidden']];
function spOrig(p, k) { return k === 'featured' ? !!p.online_featured : k === 'online' ? p.online !== false : k === 'compare_at' ? (p.compare_at_price ?? null) : p[k]; }
function spVal(p, k) { return spDraft[p.id] && k in spDraft[p.id] ? spDraft[p.id][k] : spOrig(p, k); }
function spSet(id, k, v) {
  const p = productById(id); spDraft[id] = spDraft[id] || {};
  const orig = spOrig(p, k);
  if (k === 'price' || k === 'compare_at') v = v === '' || v === null ? null : Number(v);
  if (String(orig ?? '') === String(v ?? '')) delete spDraft[id][k]; else spDraft[id][k] = v;
  if (!Object.keys(spDraft[id]).length) delete spDraft[id];
  spSaveBar();
}
function spDirty() { return Object.keys(spDraft).length; }
function spSaveBar() {
  const el = document.getElementById('spSave'); if (!el) return;
  const n = spDirty();
  el.className = 'saveBar' + (n ? ' show' : '');
  el.innerHTML = n ? `<span>${icon('edit')} <b>${n}</b> product${n > 1 ? 's' : ''} changed</span><span class="actions" style="flex-wrap:nowrap"><button class="btn ghost" onclick="spDraft={};renderView()">Discard</button><button class="btn primary" id="spSaveBtn" onclick="spSave(this)">${icon('check')}Save changes</button></span>` : '';
}
function spMatches(p, f) {
  const shown = spVal(p, 'online') && Number(spVal(p, 'price')) > 0;
  if (f === 'shown') return shown; if (f === 'price') return spVal(p, 'online') && !(Number(spVal(p, 'price')) > 0);
  if (f === 'photo') return !p.image_url; if (f === 'out') return shown && onlineStock(p) <= 0; if (f === 'hidden') return !spVal(p, 'online');
  return true;
}
PAGES.shopprod = {
  title: 'Shop products', sub: 'Choose what customers see in your online shop, with prices and photos',
  actions: () => `${business.store_enabled ? `<button class="btn" onclick="goPublic('store',{slug:'${jsq(business.store_slug)}'})">${icon('eye')}View my shop</button>` : ''}<button class="btn" onclick="go('shopsetup')">${icon('settings')}Shop setup</button>`,
  render: () => {
    const f = viewParams.f || 'all', st = storeStats();
    const all = cache.products.filter(p => p.active !== false);
    const cats = [...new Set(all.map(p => p.category || 'Other'))].sort();
    let list = all.filter(p => spMatches(p, f));
    if (spCat) list = list.filter(p => (p.category || 'Other') === spCat);
    if (spQ) { const q = spQ.toLowerCase(); list = list.filter(p => (p.name + ' ' + p.code + ' ' + (p.brand || '') + ' ' + (p.barcode || '')).toLowerCase().includes(q)); }
    const needPrice = all.filter(p => !(Number(spVal(p, 'price')) > 0) && p.catalog_id);
    const pct2 = st.all ? Math.round(st.sellable / st.all * 100) : 0;
    const canPrice = isMgr() || perms.can_edit_price;
    return `${!business.store_enabled ? `<div class="banner info">${icon('store')}<div style="flex:1"><b>Your online shop is closed</b><p>Prepare your products here, then open the shop in Shop setup.</p></div><button class="btn small primary" onclick="go('shopsetup')">Open my shop</button></div>` : ''}
     <div class="card shopHealth"><div class="healthRing" style="--p:${pct2}"><b>${pct2}%</b></div><div style="flex:1;min-width:220px"><h3 style="margin:0 0 4px">Customers can buy ${st.sellable} of ${st.all} products</h3>
       <p class="muted" style="margin:0">A product appears in your shop when it is <b>shown</b>, has a <b>price</b> and has <b>stock</b> at a branch that takes online orders (${onlineBranches().map(s => esc(s.name)).join(', ') || 'none yet'}). Photos help customers choose.</p></div>
       <div class="healthChips">${[['price', st.noPrice, 'need a price', 'warn'], ['out', st.out, 'out of stock online', 'warn'], ['photo', st.noPhoto, 'without a photo', 'info'], ['hidden', st.hidden, 'hidden', 'gray']].map(([k, n, t, tone]) => n ? `<button class="tag ${tone}" onclick="setTab('f','${k}')">${n} ${t}</button>` : '').join('')}</div></div>
     ${needPrice.length && canPrice ? `<div class="banner info">${icon('spark')}<div style="flex:1"><b>${needPrice.length} catalogue product${needPrice.length > 1 ? 's have' : ' has'} no price</b><p>Fill in DeepQr's suggested Tanzania prices as a starting point. You can change any of them before saving.</p></div><button class="btn small" onclick="spSuggestPrices(this)">${icon('spark')}Use suggested prices</button></div>` : ''}
     <div class="card"><div class="toolbar" style="margin:0"><input class="input grow" id="spQ" value="${esc(spQ)}" placeholder="Search name, code or barcode…" oninput="spQ=this.value;const p=this.selectionStart;renderView();const e=document.getElementById('spQ');e.focus();e.setSelectionRange(p,p)">
       <select class="input" onchange="spCat=this.value;renderView()"><option value="">All categories</option>${cats.map(c => `<option ${spCat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="pillRow" style="margin:12px 0 0">${SP_FILTERS.map(([k, lb]) => `<button class="pill ${f === k ? 'active' : ''}" onclick="setTab('f','${k}')">${lb} <small>${all.filter(p => spMatches(p, k)).length}</small></button>`).join('')}</div>
      <div class="spTools"><div class="seg" role="group" aria-label="View"><button class="${spMode === 'cards' ? 'active' : ''}" onclick="spMode='cards';lsSet('dq_spmode','cards');renderView()">${icon('image')}Photos</button><button class="${spMode === 'list' ? 'active' : ''}" id="spListBtn" onclick="spMode='list';lsSet('dq_spmode','list');renderView()">${icon('edit')}Fast price list</button></div>
       ${list.length > 1 ? `<button class="btn small ghost" onclick="spBulk('online',true)">${icon('eye')}Show these ${list.length}</button><button class="btn small ghost" onclick="spBulk('online',false)">${icon('ban')}Hide these ${list.length}</button>` : ''}${canPrice ? `<button class="btn small ghost" onclick="spMarkup()">${icon('coins')}Price from cost</button>` : ''}<span class="muted spScanHint">${icon('scan')} Scan a label or barcode to jump to that product</span></div></div>
     ${spMode === 'list' ? spListHtml(list, canPrice) : `<div class="spGrid">${list.map(spCard).join('') || `<div class="card" style="grid-column:1/-1">${emptyState('tag', 'Nothing here', f === 'price' ? 'Every product shown in your shop has a price.' : 'Try another filter or search.')}</div>`}</div>`}
     <div id="spSave"></div>`;
  },
  after: () => { window.__spList = null; spSaveBar(); Scanner.pushHandler('shopprod', spScan); }
};
function spCard(p) {
  const on = spVal(p, 'online'), price = spVal(p, 'price'), fe = spVal(p, 'featured'), s = onlineStock(p), dirty = !!spDraft[p.id];
  const state = !on ? ['Hidden', 'gray'] : !(Number(price) > 0) ? ['Needs a price', 'warn'] : s <= 0 ? ['Out of stock online', 'warn'] : ['Visible', 'ok'];
  const canPrice = isMgr() || perms.can_edit_price;
  return `<div class="spCard ${on ? '' : 'off'} ${dirty ? 'dirty' : ''}" id="sp_${p.id}">
    <button class="spPhoto" onclick="spPhotos('${p.id}')" aria-label="Photos of ${esc(p.name)}">${p.image_url ? `${imgTag(p.image_url, '')}${(p.photos || []).length > 1 ? `<i class="spCount">${(p.photos || []).length}</i>` : ''}` : `<span class="spAdd">${icon('camera')}<b>Add photo</b></span>`}</button>
    <div class="spBody"><div class="spTop"><span class="tag ${state[1]}">${state[0]}</span><button class="spStar ${fe ? 'on' : ''}" onclick="spSet('${p.id}','featured',${!fe});renderView()" title="${fe ? 'Popular — shown first' : 'Mark as popular (shown first)'}" aria-pressed="${fe}">${icon('star')}</button></div>
     <b class="spName">${esc(p.name)}</b><small class="muted">${esc(p.code)}${p.category ? ' · ' + esc(p.category) : ''}${p.pack_size ? ' · ' + esc(p.pack_size) : ''}</small>
     <div class="spPrice"><input class="input num" type="number" min="0" step="any" inputmode="decimal" value="${price ?? ''}" placeholder="Price" aria-label="Price of ${esc(p.name)}" ${canPrice ? '' : 'disabled title="You cannot change prices"'} onchange="spSet('${p.id}','price',this.value);renderView()"><span class="muted">${esc(cur())}</span></div>
     <details class="spWas" ${spVal(p, 'compare_at') ? 'open' : ''}><summary>${spVal(p, 'compare_at') ? `${icon('tag')} Deal: was ${money(spVal(p, 'compare_at'))}` : `${icon('tag')} Make it a deal`}</summary><input class="input num" type="number" min="0" step="any" inputmode="decimal" value="${spVal(p, 'compare_at') ?? ''}" placeholder="Old price (higher)" aria-label="Was price of ${esc(p.name)}" ${canPrice ? '' : 'disabled'} onchange="spSet('${p.id}','compare_at',this.value);renderView()"></details>
     <div class="spFoot"><small class="${s > 0 ? '' : 'warn'}">${s > 0 ? num(s) + ' in stock online' : 'No stock at online branches'}</small><label class="switch"><input type="checkbox" ${on ? 'checked' : ''} onchange="spSet('${p.id}','online',this.checked);renderView()"><i></i><span>Show</span></label></div></div></div>`;
}
function spListHtml(list, canPrice) {
  return `<div class="card"><p class="muted" style="margin:0 0 10px;font-size:13px">${icon('keyboard')} Type a price and press <b>Enter</b> to jump to the next product. Changes are kept until you press <b>Save changes</b>.</p>
   <div class="tableWrap"><table class="spList"><thead><tr><th>Product</th><th class="right">Stock online</th><th style="width:150px">Price (${esc(cur())})</th><th style="width:140px">Was (deal)</th><th>Show</th></tr></thead><tbody>
   ${list.map((p, i) => { const on = spVal(p, 'online'), pr = spVal(p, 'price'), st = onlineStock(p); return `<tr id="spr_${p.id}" class="${spDraft[p.id] ? 'dirty' : ''} ${on ? '' : 'off'}"><td><div class="prodCell">${prodThumb(p, 36)}<div><b>${esc(p.name)}</b><span class="sub">${esc(p.code)}${p.barcode ? ' · ' + esc(p.barcode) : ''}${Number(p.cost) ? ' · cost ' + money(p.cost) : ''}</span></div></div></td>
     <td class="right num ${st > 0 ? '' : 'warn'}">${num(st)}</td>
     <td><input class="input num spIn" data-i="${i}" type="number" min="0" step="any" inputmode="decimal" value="${pr ?? ''}" placeholder="—" ${canPrice ? '' : 'disabled'} onchange="spSet('${p.id}','price',this.value);this.closest('tr').classList.toggle('dirty',!!spDraft['${p.id}'])" onkeydown="spKey(event,this)" aria-label="Price of ${esc(p.name)}"></td>
     <td><input class="input num" type="number" min="0" step="any" value="${spVal(p, 'compare_at') ?? ''}" placeholder="—" ${canPrice ? '' : 'disabled'} onchange="spSet('${p.id}','compare_at',this.value);this.closest('tr').classList.toggle('dirty',!!spDraft['${p.id}'])" aria-label="Was price of ${esc(p.name)}"></td>
     <td><label class="switch"><input type="checkbox" ${on ? 'checked' : ''} onchange="spSet('${p.id}','online',this.checked);this.closest('tr').classList.toggle('off',!this.checked)"><i></i></label></td></tr>`; }).join('') || `<tr><td colspan="5" class="empty">Nothing here.</td></tr>`}</tbody></table></div></div>`;
}
function spKey(e, el) {
  if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault(); el.dispatchEvent(new Event('change'));
  const all = [...document.querySelectorAll('.spIn')], i = all.indexOf(el), nx = all[e.key === 'ArrowUp' ? i - 1 : i + 1];
  if (nx) { nx.focus(); nx.select(); } else spSaveBar();
}
function spScan(code, src, parsed) {
  let p = (parsed.type === 'qr' || parsed.type === 'serial') ? productById(cache.items.find(i => i.serial === parsed.serial)?.product_id) : product(code);
  if (!p) { Scanner.feedback(false, 'No product found for ' + code); return; }
  spQ = ''; spCat = ''; viewParams.f = 'all'; spMode = 'list'; renderView();
  const row = document.getElementById('spr_' + p.id); if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600);
  const inp = row.querySelector('.spIn'); if (inp && !inp.disabled) { inp.focus(); inp.select(); }
  Scanner.feedback(true, `${p.name} — type the price`);
}
function spMarkup() {
  const withCost = cache.products.filter(p => p.active !== false && Number(p.cost) > 0);
  if (!withCost.length) { toast('No product has a cost yet. Costs come from purchase orders and the product editor.', 'bad'); return; }
  askBox('Set prices from the cost', `${withCost.length} product(s) have a cost. DeepQr adds your margin and rounds the price up. You can still change each price before saving.`, { label: 'Margin on top of the cost (%)', type: 'number', min: 0, value: lsGet('dq_markup') || '30', required: true }, 'Fill prices', (v, b) => {
    const m = Number(v); lsSet('dq_markup', String(m)); let n = 0;
    withCost.forEach(p => { if (Number(spVal(p, 'price')) > 0 && !document.getElementById('mkAll')?.checked) return; const raw = Number(p.cost) * (1 + m / 100), step = raw >= 10000 ? 500 : raw >= 1000 ? 100 : 50; spSet(p.id, 'price', Math.ceil(raw / step) * step); n++; });
    closeModal(); renderView(); toast(`${n} price${n === 1 ? '' : 's'} filled in — check them, then Save changes`, n ? 'ok' : '');
  });
  setTimeout(() => { const f = document.getElementById('askV')?.closest('.field'); if (f) f.insertAdjacentHTML('afterend', `<label class="chk" style="margin-top:8px"><input type="checkbox" id="mkAll"> Also replace prices that are already set</label>`); }, 30);
}
function spBulk(k, v) { const f = viewParams.f || 'all'; cache.products.filter(p => p.active !== false && spMatches(p, f) && (!spCat || (p.category || 'Other') === spCat) && (!spQ || (p.name + ' ' + p.code).toLowerCase().includes(spQ.toLowerCase()))).forEach(p => spSet(p.id, k, v)); renderView(); }
async function spSuggestPrices(btn) {
  await withBusy(btn, async () => {
    const need = cache.products.filter(p => p.active !== false && !(Number(spVal(p, 'price')) > 0) && p.catalog_id);
    const { data, error } = await sb.from('catalog_products').select('id,suggested_price').in('id', [...new Set(need.map(p => p.catalog_id))]);
    if (error) { toast(errMsg(error), 'bad'); return; }
    let n = 0; need.forEach(p => { const c = (data || []).find(x => x.id === p.catalog_id); if (c && Number(c.suggested_price) > 0) { spSet(p.id, 'price', Number(c.suggested_price)); n++; } });
    setTab('f', 'all');
    toast(n ? `${n} suggested price${n > 1 ? 's' : ''} filled in — check them, then Save changes` : 'No suggested prices for these products — type your own', n ? 'ok' : '');
  });
}
async function spSave(btn) {
  const items = Object.entries(spDraft).map(([id, d]) => ({ id, ...d }));
  if (!items.length) return;
  const bad = items.find(i => 'price' in i && i.price !== null && i.price < 0); if (bad) { toast('Prices cannot be negative', 'bad'); return; }
  await withBusy(btn, async () => {
    try {
      for (let i = 0; i < items.length; i += 200) {
        const r = await rpc('dq_store_products_save', { p: { items: items.slice(i, i + 200) } });
        (r || []).forEach(u => { const p = productById(u.id); if (p) Object.assign(p, u); });
      }
      spDraft = {}; toast(`${items.length} product${items.length > 1 ? 's' : ''} saved`, 'ok'); render();
    } catch (x) { toast(errMsg(x), 'bad'); }
  });
}

/* photo manager */
let ppState = null;
function spPhotos(id) {
  const p = productById(id); if (!p) return;
  ppState = { id, photos: [...(p.photos || [])], adds: [], removed: [], desc: p.description || '', enhance: lsGet('dq_pp_enh') !== '0', square: lsGet('dq_pp_sq') === '1' };
  drawPhotos();
}
function drawPhotos() {
  const p = productById(ppState.id), all = [...ppState.photos.map(u => ({ u })), ...ppState.adds.map(a => ({ u: a.preview, add: a }))];
  modal(`<div class="cardHead"><div><h3>${icon('camera')} ${esc(p.name)}</h3><p>Up to 6 photos. The first one is shown in your shop. Photos are made smaller automatically so they load fast on phones.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="ppGrid">${all.map((x, i) => `<div class="ppItem ${i === 0 ? 'main' : ''}"><img src="${esc(x.u)}" alt="">${i === 0 ? '<span class="tag ok">Main photo</span>' : `<button class="btn small" onclick="ppMain(${i})">Make main</button>`}<button class="ppDel" onclick="ppDel(${i})" aria-label="Remove photo">${icon('trash')}</button></div>`).join('')}
    ${all.length < 6 ? `<label class="ppAddBtn">${icon('camera')}<b>Take photo</b><small>uses the camera</small><input type="file" accept="image/*" capture="environment" onchange="ppAdd(this.files)" hidden></label><label class="ppAddBtn">${icon('upload')}<b>Choose photos</b><small>from the gallery or computer</small><input type="file" accept="image/*" multiple onchange="ppAdd(this.files)" hidden id="ppFile"></label>` : ''}</div>
   <div class="ppOpts"><label class="switch"><input type="checkbox" id="ppEnh" ${ppState.enhance ? 'checked' : ''} onchange="ppState.enhance=this.checked;lsSet('dq_pp_enh',this.checked?'1':'0')"><i></i><span>Improve light &amp; colour automatically</span></label>
    <label class="switch"><input type="checkbox" id="ppSq" ${ppState.square ? 'checked' : ''} onchange="ppState.square=this.checked;lsSet('dq_pp_sq',this.checked?'1':'0')"><i></i><span>Crop to a square (fills the shop tile)</span></label></div>
   <p class="ppTips">${icon('info')} For photos that sell: daylight or a bright room, a plain light background, the whole product in the middle, one product per photo.</p>
   <div class="field" style="margin-top:14px"><label for="ppD">Description for customers</label><textarea id="ppD" rows="3" maxlength="1000" placeholder="Size, colour, what is in the pack, how to use…" oninput="ppState.desc=this.value">${esc(ppState.desc)}</textarea></div>
   <div id="ppErr" class="bad" style="min-height:20px;margin-top:8px"></div>
   <div class="actions"><button class="btn primary" id="ppSave" onclick="ppSave(this)">${icon('check')}Save photos</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`, 'wide');
}
function ppAdd(files) {
  const room = 6 - ppState.photos.length - ppState.adds.length;
  [...files].slice(0, room).forEach(f => { if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp|heic)$/i.test(f.name)) return; ppState.adds.push({ file: f, preview: URL.createObjectURL(f) }); });
  if (files.length > room) toast('Only 6 photos per product', 'bad');
  drawPhotos();
}
function ppMain(i) { const n = ppState.photos.length; if (i < n) { const [x] = ppState.photos.splice(i, 1); ppState.photos.unshift(x); } else { const [x] = ppState.adds.splice(i - n, 1); ppState.adds.unshift(x); ppState.addsFirst = true; } drawPhotos(); }
function ppDel(i) { const n = ppState.photos.length; if (i < n) ppState.removed.push(...ppState.photos.splice(i, 1)); else ppState.adds.splice(i - n, 1); drawPhotos(); }
async function ppSave(btn) {
  const er = document.getElementById('ppErr');
  await withBusy(btn, async () => {
    try {
      const urls = [];
      for (const a of ppState.adds) urls.push(await uploadProductPhoto(ppState.id, a.file, { enhance: ppState.enhance, square: ppState.square }));
      const photos = ppState.addsFirst ? [...urls, ...ppState.photos] : [...ppState.photos, ...urls];
      const r = await rpc('dq_store_products_save', { p: { items: [{ id: ppState.id, photos, description: ppState.desc }] } });
      const p = productById(ppState.id); if (p && r?.[0]) Object.assign(p, r[0]);
      const rm = ppState.removed.flatMap(u => [photoPath(u), photoPath(thumbOf(u))]).filter(Boolean); if (rm.length) sb.storage.from(PUB_BUCKET).remove([...new Set(rm)]);
      closeModal(); toast('Photos saved', 'ok'); render();
    } catch (x) { er.textContent = errMsg(x); }
  });
}

/* =============================================================================
   Shop setup page (replaces the v4 dialog)
   ============================================================================= */
let ssDraft = null;
function openStoreSettings() { go('shopsetup'); }
function ssInit() {
  const b = business;
  const accts = (b.store_payment_accounts || []).length ? b.store_payment_accounts : (b.payment_methods || []).filter(m => !/cash|card|credit/i.test(m.name || m)).slice(0, 2).map(m => ({ method: m.name || m, number: '', name: b.name }));
  ssDraft = { store_enabled: b.store_enabled || !b.store_slug, store_slug: b.store_slug || b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''), store_tagline: b.store_tagline || '', store_area: b.store_area || '',
    store_hours: b.store_hours || '', store_min_order: Number(b.store_min_order || 0), store_pickup: b.store_pickup !== false, store_delivery: !!b.store_delivery,
    store_delivery_mode: b.store_delivery_mode || 'flat', store_delivery_fee: Number(b.store_delivery_fee || 0), store_base_fee: Number(b.store_base_fee || 0), store_base_km: Number(b.store_base_km || 0),
    store_per_km: Number(b.store_per_km || 0), store_max_km: Number(b.store_max_km ?? 20), store_fee_round: Number(b.store_fee_round ?? 100), store_free_delivery_over: b.store_free_delivery_over ?? '',
    store_pay_on_collection: b.store_pay_on_collection !== false, store_payment_accounts: JSON.parse(JSON.stringify(accts)), first_order_points: Number(b.first_order_points || 0),
    store_shop_id: (shopObj(b.store_shop_id)?.type !== 'warehouse' && b.store_shop_id) || '',
    branches: cache.shops.filter(s => s.type !== 'warehouse').map(s => ({ id: s.id, name: s.name, online: s.online !== false, lat: s.lat ?? null, lng: s.lng ?? null, address: s.address || '', base_fee: s.delivery_base_fee ?? '', per_km: s.delivery_per_km ?? '', max_km: s.delivery_max_km ?? '', own: s.delivery_base_fee != null || s.delivery_per_km != null || s.delivery_max_km != null })) };
}
function ssFee(km, br) {
  const d = ssDraft, base = br && br.own && br.base_fee !== '' ? Number(br.base_fee) : Number(d.store_base_fee || 0), per = br && br.own && br.per_km !== '' ? Number(br.per_km) : Number(d.store_per_km || 0);
  let f = base + Math.max(Math.ceil(km - Number(d.store_base_km || 0)), 0) * per; const r = Number(d.store_fee_round || 0); if (r > 0) f = Math.ceil(f / r) * r; return f;
}
function ssExamples() { const d = ssDraft, max = Number(d.store_max_km || 0); return [1, 3, 5, 10, 15].filter(k => !max || k <= max).map(k => `<div><b>${k} km</b><span>${money(ssFee(k))}</span></div>`).join('') + (max ? `<div class="muted"><b>over ${max} km</b><span>no delivery</span></div>` : ''); }
const ssSet = (k, v, redraw) => { ssDraft[k] = v; if (redraw) renderView(); else { const e = document.getElementById('ssEx'); if (e) e.innerHTML = ssExamples(); } };
PAGES.shopsetup = {
  title: 'Shop setup', sub: 'Your online shop: link, branches, pickup and delivery prices, payments',
  actions: () => `${business.store_enabled ? `<button class="btn" onclick="goPublic('store',{slug:'${jsq(business.store_slug)}'})">${icon('eye')}View my shop</button>` : ''}<button class="btn" onclick="go('shopprod')">${icon('tag')}Shop products</button>`,
  render: () => {
    if (!isMgr()) return `<div class="card">${emptyState('lock', 'Only the owner or a manager can set up the shop', '')}</div>`;
    if (!ssDraft) ssInit();
    const d = ssDraft, st = storeStats(), link = location.origin + location.pathname + '?shop=' + (d.store_slug || '');
    const onBr = d.branches.filter(b => b.online), located = onBr.filter(b => b.lat != null);
    const steps = [[d.store_enabled, 'Shop is open'], [st.sellable > 0, `${st.sellable} product${st.sellable === 1 ? '' : 's'} customers can buy`], [onBr.length > 0, `${onBr.length} branch${onBr.length === 1 ? '' : 'es'} taking orders`],
      [!d.store_delivery || d.store_delivery_mode === 'flat' || located.length > 0, d.store_delivery && d.store_delivery_mode === 'distance' ? `${located.length} branch${located.length === 1 ? '' : 'es'} on the map` : 'Delivery price set'],
      [d.store_pay_on_collection || d.store_payment_accounts.some(a => (a.number || '').trim()), 'Customers can pay']];
    return `<div class="ssSteps">${steps.map(([ok, t]) => `<div class="${ok ? 'ok' : ''}">${icon(ok ? 'check' : 'alert')}<span>${t}</span></div>`).join('')}${st.sellable < st.all ? `<button class="btn small" onclick="go('shopprod')">${icon('tag')}Add prices &amp; photos</button>` : ''}</div>
     <div class="ssGrid"><div>
      <section class="card"><div class="cardHead"><div><h3>${icon('store')} Your shop</h3><p>The link customers open, and what they see first.</p></div></div>
       <div class="brandBox"><div class="brandCover ${business.store_cover_url ? '' : 'empty'}">${business.store_cover_url ? `<img src="${esc(business.store_cover_url)}" alt="">` : `<span>${icon('image')}Cover photo · wide picture of your shop or products</span>`}
         <label class="btn small brandBtn">${icon('camera')}${business.store_cover_url ? 'Change cover' : 'Add cover'}<input type="file" accept="image/*" hidden onchange="ssBrand('store_cover_url',this.files[0],this)"></label></div>
        <div class="brandLogo">${shopLogoHtml(business.name, business.logo_url, 'lg')}<label class="btn small">${icon('upload')}${business.logo_url ? 'Change logo' : 'Add logo'}<input type="file" accept="image/*" hidden id="ssLogoFile" onchange="ssBrand('logo_url',this.files[0],this)"></label>${business.logo_url || business.store_cover_url ? `<button class="btn small ghost" onclick="ssBrandClear()">Remove</button>` : ''}</div>
        <small class="muted">Your logo also appears on receipts and digital receipts.</small></div>
       <label class="switchRow big"><span class="switch"><input type="checkbox" id="ssOn" ${d.store_enabled ? 'checked' : ''} onchange="ssSet('store_enabled',this.checked,true)"><i></i></span><span><b>${d.store_enabled ? 'Open for online orders' : 'Closed'}</b><br><small class="muted">${d.store_enabled ? 'Customers can find and order from your shop.' : 'Customers see that the shop is not taking orders.'}</small></span></label>
       <div class="formGrid" style="margin-top:12px"><div class="field"><label for="ssSlug">Shop link</label><div class="slugBox"><span>?shop=</span><input id="ssSlug" class="mono" value="${esc(d.store_slug)}" oninput="ssDraft.store_slug=this.value.toLowerCase().replace(/[^a-z0-9-]+/g,'-')"></div><small class="muted"><button class="priceBtn" onclick="copyText('${jsq(link)}','Shop link copied')">${icon('copy')}Copy link</button></small></div>
        <div class="field"><label for="ssTag">Short description</label><input id="ssTag" value="${esc(d.store_tagline)}" maxlength="120" placeholder="e.g. Fresh groceries &amp; household goods" oninput="ssDraft.store_tagline=this.value"></div>
        <div class="field"><label for="ssArea">Area / town</label><input id="ssArea" value="${esc(d.store_area)}" placeholder="e.g. Kariakoo, Dar es Salaam" oninput="ssDraft.store_area=this.value"></div>
        <div class="field"><label for="ssHrs">Opening hours</label><input id="ssHrs" value="${esc(d.store_hours)}" placeholder="Mon–Sat 8:00–20:00" oninput="ssDraft.store_hours=this.value"></div>
        <div class="field"><label for="ssMin">Minimum order (${esc(cur())})</label><input id="ssMin" type="number" min="0" value="${d.store_min_order}" oninput="ssDraft.store_min_order=Number(this.value||0)"></div></div></section>

      <section class="card"><div class="cardHead"><div><h3>${icon('pin')} Branches</h3><p>Each branch sells from its own stock. Customers choose a branch, or DeepQr picks the nearest one. Put each branch on the map to price delivery by distance.</p></div></div>
       ${d.branches.map((b, i) => `<div class="brRow ${b.online ? '' : 'off'}"><label class="switch"><input type="checkbox" ${b.online ? 'checked' : ''} onchange="ssDraft.branches[${i}].online=this.checked;renderView()"><i></i></label>
         <div style="flex:1;min-width:0"><b>${esc(b.name)}</b> ${d.store_shop_id === b.id ? '<span class="tag info">Default</span>' : ''}<small class="muted" style="display:block">${b.lat != null ? `${icon('pin')} On the map${b.address ? ' · ' + esc(b.address) : ''}` : '<span class="warn">Not on the map yet</span>'} · ${num(cache.products.reduce((a, p) => a + (stock(b.id, p.code) > 0 ? 1 : 0), 0))} products in stock</small>
          ${b.own ? `<div class="brOwn"><div class="field"><label>${d.store_delivery_mode === 'distance' ? 'Base fee' : 'Delivery fee'}</label><input type="number" min="0" value="${b.base_fee}" oninput="ssDraft.branches[${i}].base_fee=this.value"></div>${d.store_delivery_mode === 'distance' ? `<div class="field"><label>Per km</label><input type="number" min="0" value="${b.per_km}" oninput="ssDraft.branches[${i}].per_km=this.value"></div><div class="field"><label>Max km</label><input type="number" min="0" value="${b.max_km}" oninput="ssDraft.branches[${i}].max_km=this.value"></div>` : ''}<button class="btn small ghost" onclick="Object.assign(ssDraft.branches[${i}],{own:false,base_fee:'',per_km:'',max_km:''});renderView()">Use shop prices</button></div>` : ''}</div>
         <div class="actions" style="flex-wrap:nowrap"><button class="btn small ${b.lat == null ? 'primary' : ''}" onclick="ssMap(${i})">${icon('pin')}${b.lat == null ? 'Set location' : 'Move'}</button>${b.online && d.store_shop_id !== b.id ? `<button class="btn small ghost" onclick="ssDraft.store_shop_id='${b.id}';renderView()" title="Make default branch">Default</button>` : ''}${!b.own && d.store_delivery ? `<button class="btn small ghost" onclick="ssDraft.branches[${i}].own=true;renderView()" title="This branch charges its own delivery price">Own price</button>` : ''}</div></div>`).join('') || '<p class="muted">Add a shop in Stores &amp; shops first.</p>'}
       ${cache.shops.some(s => s.type === 'warehouse') ? `<p class="muted" style="font-size:12.5px;margin:10px 0 0">${icon('info')} Warehouses (${cache.shops.filter(s => s.type === 'warehouse').map(s => esc(s.name)).join(', ')}) don't take online orders. Transfer stock to a branch to sell it online.</p>` : ''}</section>
     </div><div>
      <section class="card"><div class="cardHead"><div><h3>${icon('truck')} Pickup &amp; delivery</h3><p>How customers get their order.</p></div></div>
       <div class="grid g2"><label class="choice ${d.store_pickup ? 'on' : ''}"><input type="checkbox" id="ssPick" ${d.store_pickup ? 'checked' : ''} onchange="ssSet('store_pickup',this.checked,true)">${icon('store')}<b>Customers collect</b><small>at the branch they choose</small></label>
        <label class="choice ${d.store_delivery ? 'on' : ''}"><input type="checkbox" id="ssDel" ${d.store_delivery ? 'checked' : ''} onchange="ssSet('store_delivery',this.checked,true)">${icon('truck')}<b>We deliver</b><small>to the customer's location</small></label></div>
       ${d.store_delivery ? `<h4 style="margin:16px 0 8px">Delivery price</h4><div class="seg big" id="ssMode"><button class="${d.store_delivery_mode === 'flat' ? 'active' : ''}" onclick="ssSet('store_delivery_mode','flat',true)">${icon('coins')}Same fee everywhere</button><button class="${d.store_delivery_mode === 'distance' ? 'active' : ''}" onclick="ssSet('store_delivery_mode','distance',true)">${icon('pin')}By distance (per km)</button></div>
        ${d.store_delivery_mode === 'flat' ? `<div class="formGrid" style="margin-top:10px"><div class="field"><label for="ssFee">Delivery fee (${esc(cur())})</label><input id="ssFee" type="number" min="0" value="${d.store_delivery_fee}" oninput="ssDraft.store_delivery_fee=Number(this.value||0)"></div><div class="field"><label for="ssFree">Free delivery above</label><input id="ssFree" type="number" min="0" value="${d.store_free_delivery_over}" placeholder="optional" oninput="ssDraft.store_free_delivery_over=this.value"></div></div>`
        : `<div class="formGrid" style="margin-top:10px"><div class="field"><label for="ssBase">Base fee (${esc(cur())})</label><input id="ssBase" type="number" min="0" value="${d.store_base_fee}" oninput="ssSet('store_base_fee',Number(this.value||0))"></div>
          <div class="field"><label for="ssBaseKm">Km included in the base fee</label><input id="ssBaseKm" type="number" min="0" step="0.5" value="${d.store_base_km}" oninput="ssSet('store_base_km',Number(this.value||0))"></div>
          <div class="field"><label for="ssPerKm">Price for each extra km</label><input id="ssPerKm" type="number" min="0" value="${d.store_per_km}" oninput="ssSet('store_per_km',Number(this.value||0))"></div>
          <div class="field"><label for="ssMax">Furthest delivery (km)</label><input id="ssMax" type="number" min="0" value="${d.store_max_km}" placeholder="0 = no limit" oninput="ssSet('store_max_km',Number(this.value||0))"></div>
          <div class="field"><label for="ssRound">Round the fee up to</label><select id="ssRound" onchange="ssSet('store_fee_round',Number(this.value))">${[0, 50, 100, 500, 1000].map(v => `<option value="${v}" ${Number(d.store_fee_round) === v ? 'selected' : ''}>${v ? money(v) : 'No rounding'}</option>`).join('')}</select></div>
          <div class="field"><label for="ssFree">Free delivery above</label><input id="ssFree" type="number" min="0" value="${d.store_free_delivery_over}" placeholder="optional" oninput="ssDraft.store_free_delivery_over=this.value"></div></div>
          <div class="feeTable" id="ssEx">${ssExamples()}</div><p class="muted" style="font-size:12.5px;margin:8px 0 0">${icon('info')} The customer drops a pin or shares their location at checkout. DeepQr measures from the branch and adds about 30% for roads, so the fee is close to the real trip.</p>`}` : ''}</section>

      <section class="card"><div class="cardHead"><div><h3>${icon('coins')} Payments</h3><p>Customers send money to these numbers and type the transaction reference. You confirm it on your statement before handing over the goods.</p></div></div>
       <label class="chk"><input type="checkbox" id="ssPoc" ${d.store_pay_on_collection ? 'checked' : ''} onchange="ssDraft.store_pay_on_collection=this.checked">Allow paying at the shop or on delivery</label>
       <div id="ssAccs" style="margin-top:10px">${d.store_payment_accounts.map((a, i) => `<div class="accRow"><input class="input" value="${esc(a.method || '')}" placeholder="M-Pesa" oninput="ssDraft.store_payment_accounts[${i}].method=this.value"><input class="input mono" value="${esc(a.number || '')}" placeholder="Number or Lipa namba" inputmode="numeric" oninput="ssDraft.store_payment_accounts[${i}].number=this.value"><input class="input" value="${esc(a.name || '')}" placeholder="Account name" oninput="ssDraft.store_payment_accounts[${i}].name=this.value"><button class="btn ghost" onclick="ssDraft.store_payment_accounts.splice(${i},1);renderView()" aria-label="Remove">${icon('trash')}</button></div>`).join('')}</div>
       <button class="btn small" onclick="ssDraft.store_payment_accounts.push({method:'M-Pesa',number:'',name:business.name});renderView()">${icon('plus')}Add number</button>
       ${business.loyalty_enabled ? `<div class="field" style="margin-top:14px;max-width:320px"><label for="ssFop">Bonus points on a customer's first online order</label><input id="ssFop" type="number" min="0" value="${d.first_order_points}" oninput="ssDraft.first_order_points=Number(this.value||0)"></div>` : `<p class="muted" style="font-size:12.5px;margin-top:12px">${icon('gift')} Turn on loyalty points in Settings to reward online customers.</p>`}</section>
     </div></div>
     <div class="saveBar show sticky"><span id="ssErr" class="bad"></span><span class="actions" style="flex-wrap:nowrap"><button class="btn ghost" onclick="ssDraft=null;renderView()">Undo changes</button><button class="btn primary lg" id="ssSave" onclick="ssSave(this)">${icon('check')}Save shop</button></span></div>`;
  }
};
async function ssBrand(k, file, inp) {
  if (!file) return;
  const lab = inp.closest('label'); lab?.classList.add('busy');
  try {
    const blob = await processImage(file, k === 'logo_url' ? { max: 512, square: true, enhance: true } : { max: 1800, aspect: 3, enhance: true });
    const url = await uploadPublic(`p/${business.id}/brand/${k === 'logo_url' ? 'logo' : 'cover'}-${uid()}.jpg`, blob);
    const old = business[k];
    const r = await rpc('dq_store_branding', { p: { [k]: url } });
    business = { ...business, ...r }; if (old && photoPath(old)) sb.storage.from(PUB_BUCKET).remove([photoPath(old)]);
    toast(k === 'logo_url' ? 'Logo saved' : 'Cover photo saved', 'ok'); render();
  } catch (x) { toast(errMsg(x), 'bad'); } finally { lab?.classList.remove('busy'); }
}
function ssBrandClear() { confirmBox('Remove the logo and cover photo?', 'Your shop shows its initials and a plain banner instead.', 'Remove', async b => { await withBusy(b, async () => { const r = await rpcToast('dq_store_branding', { p: { logo_url: '', store_cover_url: '' } }, 'Removed'); if (r) { business = { ...business, ...r }; closeModal(); render(); } }); }, 'danger'); }
function ssMap(i) {
  const b = ssDraft.branches[i]; let pt = b.lat != null ? { lat: b.lat, lng: b.lng } : null;
  modal(`<div class="cardHead"><div><h3>${icon('pin')} Where is ${esc(b.name)}?</h3><p>Stand in the branch and tap <b>Use my location here</b>, or drag the pin to the right place.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div id="ssMapBox" class="mapBox"></div>
   <div class="actions" style="margin-top:10px"><button class="btn" id="ssHere" onclick="ssHere(this)">${icon('pin')}Use my location here</button><span class="muted" id="ssPt" style="align-self:center;font-size:12.5px">${pt ? `${pt.lat}, ${pt.lng}` : 'No location yet'}</span></div>
   <div class="field" style="margin-top:10px"><label for="ssAddr">Street address customers see</label><input id="ssAddr" value="${esc(b.address)}" placeholder="e.g. Msimbazi St, opposite the market"></div>
   <div class="actions" style="margin-top:12px"><button class="btn primary" onclick="ssMapDone(${i})">${icon('check')}Use this location</button></div>`, 'wide');
  window.__ssPt = pt;
  window.__ssMap = mountMap('ssMapBox', pt, p => { window.__ssPt = p; document.getElementById('ssPt').textContent = `${p.lat}, ${p.lng}`; }, { shop: true, others: ssDraft.branches.filter((x, j) => j !== i && x.lat != null) });
}
async function ssHere(btn) { await withBusy(btn, async () => { try { const p = await myLocation(); window.__ssPt = p; window.__ssMap.set(p); document.getElementById('ssPt').textContent = `${p.lat}, ${p.lng} (±${p.acc} m)`; } catch (x) { toast(x.message, 'bad'); } }); }
function ssMapDone(i) { const p = window.__ssPt; if (!p) { toast('Set the location first', 'bad'); return; } Object.assign(ssDraft.branches[i], { lat: p.lat, lng: p.lng, address: document.getElementById('ssAddr').value.trim() }); closeModal(); renderView(); }
async function ssSave(btn) {
  const d = ssDraft, er = document.getElementById('ssErr'); er.textContent = '';
  if (d.store_enabled && !d.store_pickup && !d.store_delivery) { er.textContent = 'Choose pickup, delivery or both.'; return; }
  if (d.store_enabled && !d.branches.some(b => b.online)) { er.textContent = 'Turn on at least one branch.'; return; }
  if (d.store_enabled && d.store_delivery && d.store_delivery_mode === 'distance' && !d.branches.some(b => b.online && b.lat != null)) { er.textContent = 'Put at least one branch on the map to price delivery by distance.'; return; }
  await withBusy(btn, async () => {
    try {
      const r = await rpc('dq_store_settings', { p: { ...d, store_shop_id: d.store_shop_id || (d.branches.find(b => b.online)?.id ?? ''),
        store_payment_accounts: d.store_payment_accounts.filter(a => (a.number || '').trim()), store_free_delivery_over: d.store_free_delivery_over === '' ? null : d.store_free_delivery_over,
        branches: d.branches.map(b => ({ id: b.id, online: b.online, lat: b.lat, lng: b.lng, address: b.address, base_fee: b.own ? b.base_fee : '', per_km: b.own ? b.per_km : '', max_km: b.own ? b.max_km : '' })) } });
      business = { ...business, ...r.business };
      (r.branches || []).forEach(s => { const x = shopObj(s.id); if (x) Object.assign(x, s); });
      ssDraft = null; onlineWatch();
      const st = storeStats();
      toast(business.store_enabled ? 'Shop saved — it is open' : 'Shop saved (closed)', 'ok');
      if (business.store_enabled && st.sellable < Math.min(5, st.all)) go('shopprod', { f: st.noPrice ? 'price' : 'all' }); else render();
    } catch (x) { er.textContent = errMsg(x); }
  });
}
