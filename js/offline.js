/* =============================================================================
   v6 offline till: keeps products, stock, labels and customers on the device,
   starts without internet, sells by scanning, and uploads the sales later.
   Every sale carries a client_ref (uuid) so an upload can never be recorded twice.
   ============================================================================= */
let isOffline = false, outboxN = 0, syncing = false, syncErr = '', netTimer = null, snapAt = null;

/* ---------------- device storage (IndexedDB, with a localStorage fallback) ---------------- */
let idbP = null;
function idb() {
  if (idbP) return idbP;
  idbP = new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('IndexedDB not available'));
    const r = indexedDB.open('deepqr', 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'client_ref' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return idbP;
}
async function idbDo(store, mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => { const tx = d.transaction(store, mode); let out; const rq = fn(tx.objectStore(store)); if (rq) rq.onsuccess = () => { out = rq.result; }; tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
const kvGet = k => idbDo('kv', 'readonly', s => s.get(k)).catch(() => lsJson('dqkv_' + k, null));
const kvSet = (k, v) => idbDo('kv', 'readwrite', s => s.put(v, k)).catch(() => lsSet('dqkv_' + k, JSON.stringify(v)));
const obAll = () => idbDo('outbox', 'readonly', s => s.getAll()).then(x => x || []).catch(() => lsJson('dq_outbox', []));
const obPut = v => idbDo('outbox', 'readwrite', s => s.put(v)).catch(() => { const l = lsJson('dq_outbox', []).filter(x => x.client_ref !== v.client_ref); l.push(v); lsSet('dq_outbox', JSON.stringify(l)); });
const obDel = k => idbDo('outbox', 'readwrite', s => s.delete(k)).catch(() => lsSet('dq_outbox', JSON.stringify(lsJson('dq_outbox', []).filter(x => x.client_ref !== k))));

function netDown(e) { return !navigator.onLine || /failed to fetch|networkerror|load failed|network request failed|err_internet|fetch failed|timeout/i.test(String(e?.message || e || '')); }
function storedUserId() {
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^sb-.*-auth-token$/.test(k)) { const v = JSON.parse(localStorage.getItem(k)); const u = v?.user?.id || v?.currentSession?.user?.id; if (u) return u; } } } catch (e) {}
  return null;
}

/* ---------------- snapshot: what the till needs without internet ---------------- */
async function snapSaveNow() {
  if (!me || !business) return;
  const uidv = session?.user?.id || storedUserId(); if (!uidv) return;
  const shops = me.role === 'cashier' ? cache.shops.filter(s => s.id === me.shop_id) : cache.shops;
  const ids = new Set(shops.map(s => s.id));
  const snap = { v: 1, at: new Date().toISOString(), me, perms, business, myShift, myDevice, wallet, shops: cache.shops, categories: cache.categories,
    products: cache.products.map(p => ({ id: p.id, code: p.code, name: p.name, price: p.price, cost: p.cost, tax: p.tax, barcode: p.barcode, category: p.category, unit: p.unit, active: p.active, image_url: p.image_url, group_code: p.group_code, low_stock: p.low_stock })),
    stock: cache.stock, items: cache.items.filter(i => ids.has(i.shop_id)).map(i => ({ id: i.id, product_id: i.product_id, shop_id: i.shop_id, serial: i.serial, expiry_date: i.expiry_date, status: i.status })),
    customers: cache.customers.map(c => ({ id: c.id, name: c.name, phone: c.phone, points: c.points, balance: c.balance, credit_limit: c.credit_limit })), held: [] };
  await kvSet('snap_' + uidv, snap); snapAt = snap.at;
}
const snapSave = debounce(snapSaveNow, 800);
async function offlineBoot() {
  const uidv = session?.user?.id || storedUserId(); if (!uidv) return false;
  const snap = await kvGet('snap_' + uidv); if (!snap?.me) return false;
  me = snap.me; perms = snap.perms || {}; business = snap.business; myShift = snap.myShift; myDevice = snap.myDevice; wallet = snap.wallet; snapAt = snap.at;
  Object.assign(cache, { shops: snap.shops || [], categories: snap.categories || [], products: snap.products || [], stock: snap.stock || {}, items: snap.items || [], customers: snap.customers || [],
    sales: [], saleLines: [], purchases: [], transfers: [], adjustments: [], expenses: [], activity: [], members: [me], orders: [], orderItems: [], suppliers: [], held: [], announcements: [],
    receipts: [], supplierPayments: [], counts: [], shifts: myShift ? [myShift] : [], generations: [], devices: myDevice ? [myDevice] : [], topups: [], walletTx: [], recs: [], printOrders: [], conflicts: [] });
  document.documentElement.setAttribute('data-theme', me.theme || 'light');
  goOffline(true); view = 'pos'; render();
  toast('No internet — the till works offline. Sales are saved on this device and upload by themselves.', 'ok');
  return true;
}
function goOffline(silent) {
  if (!isOffline && !silent && me) toast('Internet lost — keep selling, sales are saved on this device', 'bad');
  isOffline = true; netChip(); clearInterval(netTimer); netTimer = setInterval(netCheck, 12000);
}
async function netCheck() {
  if (!navigator.onLine) return;
  const { error } = await sb.rpc('dq_version');
  if (error) return;
  clearInterval(netTimer); netTimer = null;
  const wasBooted = !cache.sales.length && isOffline;
  isOffline = false; netChip();
  await syncOutbox();
  if (wasBooted) { const { data: { session: s } } = await sb.auth.getSession(); session = s; if (session) { await loadMember(); return; } }
  toast('Back online', 'ok'); render();
}
window.addEventListener('offline', () => { if (me) goOffline(); });
window.addEventListener('online', () => { if (me) setTimeout(netCheck, 800); });

/* ---------------- status chip in the top bar ---------------- */
function netChipHtml() {
  if (!me) return '';
  if (isOffline) return `<button class="chip bad netChip" onclick="offlineInfo()" title="Working offline">${icon('cloudOff')}<span>Offline${outboxN ? ` · ${outboxN} sale${outboxN > 1 ? 's' : ''} waiting` : ''}</span></button>`;
  if (syncing) return `<span class="chip info netChip"><span class="spinner sm"></span>Uploading ${outboxN} offline sale${outboxN > 1 ? 's' : ''}…</span>`;
  if (outboxN) return `<button class="chip warn netChip" onclick="syncOutbox(true)" title="${esc(syncErr)}">${icon('cloud')}<span>${outboxN} offline sale${outboxN > 1 ? 's' : ''} to upload</span></button>`;
  if ((cache.conflicts || []).length && isMgr()) return `<button class="chip warn netChip" onclick="openConflicts()">${icon('alert')}<span>${cache.conflicts.length} offline sale${cache.conflicts.length > 1 ? 's' : ''} to check</span></button>`;
  return '';
}
function netChip() { const el = document.getElementById('netChip'); if (el) el.innerHTML = netChipHtml(); document.body.classList.toggle('isOffline', isOffline); }
function offlineInfo() {
  modal(`<div class="cardHead"><div><h3>${icon('cloudOff')} Working offline</h3><p>Scan &amp; Sell keeps working. Everything else opens when the internet is back.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <ul class="offList"><li>${icon('check', 'ok')}<span><b>Scan labels and barcodes</b> from the list saved on this device${snapAt ? ` (saved ${ago(snapAt)})` : ''}.</span></li><li>${icon('check', 'ok')}<span><b>Cash, M-Pesa and other payments</b> with their reference.</span></li>
    <li>${icon('check', 'ok')}<span><b>Receipts</b> print as usual. The QR on the receipt works once the sale is uploaded.</span></li><li>${icon('x', 'bad')}<span><b>Credit sales and using points</b> need the internet, because balances must be current.</span></li>
    <li>${icon('info')}<span>${outboxN ? `<b>${outboxN} sale${outboxN > 1 ? 's' : ''}</b> saved on this device. They upload by themselves when the internet is back.` : 'No sales waiting.'} Don't sign out or clear the browser until they are uploaded.</span></li></ul>
   <div class="actions"><button class="btn primary" onclick="closeModal();netCheck()">${icon('refund')}Check the connection</button></div>`, 'narrow');
}

/* ---------------- offline scan ---------------- */
function offlineScan(code, parsed) {
  const shopId = posShopId();
  if (parsed.type === 'code') { const p = product(code); if (p) { posAddProduct(p.id, true); return; } Scanner.feedback(false, 'Not found on this device: ' + code); return; }
  if (parsed.biz && business.code && parsed.biz !== business.code) { Scanner.feedback(false, `This label belongs to another business (${parsed.biz})`); return; }
  const serial = parsed.serial;
  if (posState.cart.some(l => l.items?.some(it => it.serial === serial))) { Scanner.feedback(false, 'Already in the cart: ' + serial); return; }
  const it = cache.items.find(i => i.serial === serial);
  if (!it) { Scanner.feedback(false, `${serial} is not in this device's list: it was sold, or labelled after you went offline. Sell it by barcode or quick add.`); return; }
  if (it.status === 'transit') { Scanner.feedback(false, `${serial} is on a transfer`); return; }
  const p = productById(it.product_id); if (!p) { Scanner.feedback(false, 'Unknown product for ' + serial); return; }
  if (it.expiry_date && daysUntil(it.expiry_date) < 0 && business.block_expired_sales) { Scanner.feedback(false, `${p.name} ${serial} EXPIRED on ${fmtD(it.expiry_date)} — do not sell`); return; }
  if (cartQtyFor(p.id) + 1 > stockOf(shopId, p.id)) { Scanner.feedback(false, `Stock record shows ${stockOf(shopId, p.id)} ${p.name} at ${shopObj(shopId)?.name}`); return; }
  let line = posState.cart.find(l => l.product_id === p.id && l.items && l.price === Number(p.price));
  if (!line) { line = { product_id: p.id, code: p.code, name: p.name, price: Number(p.price), base_price: Number(p.price), tax: Number(p.tax || 0), qty: 0, items: [] }; posState.cart.push(line); }
  line.items.push({ id: it.id, serial: it.serial }); line.qty = line.items.length;
  Scanner.feedback(true, `${p.name} · ${it.serial} · ${money(p.price)} (offline)`);
  updateCart();
}

/* ---------------- queue a sale on the device ---------------- */
async function queueOfflineSale(payload, c) {
  const ref = payload.client_ref, n = Number(lsGet('dq_offn_' + business.id) || 0) + 1; lsSet('dq_offn_' + business.id, String(n));
  const dev = (myDevice?.name || deviceKey() || 'DEV').replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase() || 'DEV';
  const rcpt = `${business.code}-OFF-${dev}-${String(n).padStart(4, '0')}`;
  payload.offline = true; payload.sold_at = new Date().toISOString(); payload.total = c.total;
  payload.note = [payload.note, 'Offline receipt ' + rcpt].filter(Boolean).join(' · ');
  const lines = [];
  posState.cart.forEach(l => { if (l.items) l.items.forEach(it => lines.push({ product_id: l.product_id, name: l.name, qty: 1, price: l.price, serial: it.serial, item_id: it.id })); else lines.push({ product_id: l.product_id, name: l.name, qty: l.qty, price: l.price }); });
  const sale = { id: 'off-' + ref, public_ref: ref, receipt: rcpt, date: payload.date, time: payload.time, shop_id: payload.shop_id, subtotal: c.sub, tax: c.tax, discount: c.disc, points_value: 0,
    total: c.total, paid_total: c.paid, change_due: c.change, balance_due: 0, cashier_name: me.name, customer: posState.customer?.name || 'Walk-in', customer_phone: posState.customer?.phone || '',
    customer_id: posState.customer?.id || null, status: 'completed', offline: true, pending: true, note: payload.note };
  await obPut({ client_ref: ref, created_at: payload.sold_at, payload, sale, lines, payments: payload.payments });
  // the device's own picture of stock: this label is gone, the quantity is lower
  const shopId = payload.shop_id;
  Object.entries(groupBy(lines, l => l.product_id)).forEach(([pid, ls]) => { const p = productById(pid); if (p) setStockLocal(shopId, p.code, stock(shopId, p.code) - sum(ls, 'qty')); });
  const sold = new Set(lines.filter(l => l.item_id).map(l => l.item_id)); cache.items = cache.items.filter(i => !sold.has(i.id));
  outboxN = (await obAll()).length; netChip(); await snapSaveNow();
  return { sale, lines, payments: payload.payments };
}
/* ---------------- upload ---------------- */
async function syncOutbox(manual) {
  if (syncing || !me) return;
  const list = (await obAll()).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  outboxN = list.length; netChip();
  if (!list.length || isOffline) { if (manual && isOffline) netCheck(); return; }
  syncing = true; syncErr = ''; netChip();
  let ok = 0, conf = 0;
  try {
    for (const e of list) {
      const { data, error } = await sb.rpc('dq_checkout4', { p: e.payload });
      if (error) { if (netDown(error)) { goOffline(true); break; } syncErr = errMsg(error); break; }
      await obDel(e.client_ref);
      if (data.conflict) conf++;
      else { ok++; if (data.sale && !cache.sales.some(s => s.id === data.sale.id)) { cache.sales.unshift(data.sale); cache.saleLines.push(...(data.lines || [])); } }
    }
  } finally { syncing = false; outboxN = (await obAll()).length; netChip(); }
  if (ok) toast(`${ok} offline sale${ok > 1 ? 's' : ''} uploaded`, 'ok');
  if (conf) { toast(`${conf} offline sale${conf > 1 ? 's' : ''} need a manager's decision (a label or stock changed while offline)`, 'bad'); loadConflicts(); }
  if (syncErr && manual) toast(syncErr, 'bad');
  if ((ok || conf) && ['sales', 'dashboard'].includes(view)) renderView();
}
setInterval(() => { if (me && !isOffline && outboxN && navigator.onLine) syncOutbox(); }, 20000);
async function offlineAfterLoad() {
  outboxN = (await obAll()).length; netChip();
  await snapSaveNow();
  if (outboxN) syncOutbox();
  loadConflicts();
}

/* ---------------- conflicts: managers decide ---------------- */
async function loadConflicts() {
  if (!me || isOffline) return;
  const { data } = await sb.from('offline_conflicts').select('*').eq('status', 'open').order('created_at', { ascending: false });
  cache.conflicts = data || []; netChip();
}
function conflictBanner() {
  const n = (cache.conflicts || []).length; if (!n || !isMgr()) return '';
  return `<div class="banner warn">${icon('alert')}<div style="flex:1"><b>${n} offline sale${n > 1 ? 's' : ''} could not be recorded automatically</b><p>A label was sold on another device, or the stock changed, while the till was offline. The money was taken, so choose what to do.</p></div><button class="btn small primary" onclick="openConflicts()">Review</button></div>`;
}
function openConflicts() {
  const l = cache.conflicts || [];
  modal(`<div class="cardHead"><div><h3>${icon('cloud')} Offline sales to check</h3><p>Record the sale from stock (the label is ignored), or discard it with a reason, e.g. the goods came back.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   ${l.map(c => { const p = c.payload || {}; return `<div class="conflict"><div class="row" style="border:0;padding:0"><span><b>${money(c.total ?? sum(p.payments || [], 'amount'))}</b> · ${esc(c.member_name || '')} · ${esc(shopObj(c.shop_id)?.name || '')}<small class="muted" style="display:block">${fmtDT(c.sold_at || c.created_at)} · ${esc((p.note || '').split('Offline receipt ').pop() || '')}</small></span></div>
     <p class="bad" style="margin:6px 0">${icon('alert')} ${esc(errMsg(c.error))}</p><div class="muted" style="font-size:12.5px">${(p.lines || []).map(x => esc(productById(x.product_id)?.name || cache.items.find(i => i.id === x.item_id)?.serial || 'Item') + (x.qty ? ' × ' + x.qty : '')).join(', ')} · paid ${(p.payments || []).map(x => esc(x.method) + ' ' + money(x.amount)).join(', ') || '—'}</div>
     <div class="actions" style="margin-top:8px"><button class="btn small primary" onclick="resolveConflict('${c.id}','retry',this)">${icon('check')}Record the sale</button><button class="btn small ghost" onclick="askBox('Discard this offline sale?','It will not be counted. Say why, for the records.',{label:'Reason',required:true},'Discard',(v,b)=>resolveConflict('${c.id}','discard',b,v))">Discard</button></div></div>`; }).join('') || '<p class="muted">Nothing to check.</p>'}`, 'wide');
}
async function resolveConflict(id, action, btn, note) {
  await withBusy(btn, async () => {
    const r = await rpcToast('dq_resolve_offline_conflict', { p_id: id, p_action: action, p_note: note || null }, action === 'retry' ? 'Sale recorded' : 'Discarded');
    if (r) { cache.conflicts = cache.conflicts.filter(c => c.id !== id); if (action === 'retry') await loadAllData(); netChip(); if (cache.conflicts.length) openConflicts(); else { closeModal(); render(); } }
  });
}

/* ---------------- installable app (works from the home screen, opens offline) ---------------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; const b = document.getElementById('installBtn'); if (b) b.hidden = false; });
async function installApp() { if (!installEvt) { toast('Use your browser menu → "Add to Home screen" / "Install app"'); return; } installEvt.prompt(); await installEvt.userChoice; installEvt = null; const b = document.getElementById('installBtn'); if (b) b.hidden = true; }
function registerSW() {
  if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost')) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
