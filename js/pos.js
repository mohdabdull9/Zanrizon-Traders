/* =============================================================================
   DeepQr till: scan → cart → payment → receipt, customers, credit, loyalty,
   held sales, shifts / cash-up, refunds
   ============================================================================= */
const posState = { cart: [], customer: null, discount: 0, points: 0, note: '', shopId: null };
let payState = null;

function posKey() { return 'dq_cart_' + (me?.business_id || '') + '_' + (me?.id || ''); }
function posSave() { lsSet(posKey(), JSON.stringify({ cart: posState.cart, customer: posState.customer, discount: posState.discount, shopId: posState.shopId, online: posState.online || null, points: posState.points || 0 })); }
function posLoad() { const s = lsJson(posKey(), null); if (s) { posState.cart = s.cart || []; posState.online = s.online || null; if (s.online) posState.points = s.points || 0; posState.customer = s.customer || null; posState.discount = Number(s.discount || 0); posState.shopId = s.shopId || null; } }
function posShopId() {
  if (me.role === 'cashier') return me.shop_id;
  if (posState.shopId && shopObj(posState.shopId)) return posState.shopId;
  return (cache.shops.find(s => s.type === 'shop' && !s.blocked_by_platform) || cache.shops[0])?.id;
}
function posTotals() {
  const sub = sum(posState.cart, l => l.qty * l.price);
  const tax = sum(posState.cart, l => l.qty * l.price * (l.tax || 0) / 100);
  const disc = Math.min(Number(posState.discount || 0), sub + tax);
  const ptsVal = Math.round(Number(posState.points || 0) * Number(business.point_value || 0) * 100) / 100;
  const fee = posState.online ? Number(posState.online.fee || 0) : 0;
  const total = Math.max(0, Math.round((sub + tax - disc - ptsVal + fee) * 100) / 100);
  return { sub, tax, disc, ptsVal, fee, total, items: sum(posState.cart, 'qty') };
}
function deviceBlocked() {
  if (!business?.device_lock) return null;
  if (!myDevice) return 'unregistered';
  if (myDevice.status !== 'approved') return myDevice.status;
  if (myDevice.shop_id && me.role === 'cashier' && myDevice.shop_id !== me.shop_id) return 'wrongshop';
  return null;
}
function allowedModes() {
  const bm = business?.scan_mode || 'both';
  let cam = bm !== 'hardware', hw = bm !== 'camera';
  if (business?.device_lock && myDevice?.status === 'approved') { if (myDevice.kind === 'smartphone') hw = false; if (myDevice.kind === 'scanner') cam = false; }
  return { cam, hw };
}

PAGES.pos = {
  title: 'Scan & Sell', sub: 'Scan item QR codes or barcodes into the cart, then take payment',
  actions: () => `<button class="btn" onclick="openHeld()">${icon('pause')}Held sales${cache.held.length ? ` <span class="tag info">${cache.held.length}</span>` : ''}</button><button class="btn" onclick="openCustomerPayment()">${icon('coins')}Debt payment</button>`,
  render: posView,
  after: () => {
    const inp = document.getElementById('scanInput'); if (inp) { Scanner.bindInput(inp); setTimeout(() => inp.focus(), 30); }
    Scanner.pushHandler('pos', posScan);
    const ps = document.getElementById('posSearchInput'); if (ps) ps.addEventListener('input', () => { document.getElementById('posProducts').innerHTML = posProducts(ps.value); });
  }
};

let posCat = '';
function posView() {
  if (!posState.__loaded) { posLoad(); posState.__loaded = true; }
  const shop = shopObj(posShopId());
  if (!shop) return `<div class="card">${emptyState('store', 'No shop yet', 'Create a shop under Stores & shops first.')}</div>`;
  const block = deviceBlocked(); if (block) return deviceLockScreen(block);
  if (shop.blocked_by_platform) return `<div class="card"><div class="lockScreen"><div class="bigIco">${icon('lock')}</div><h2>${esc(shop.name)} is disabled by DeepQr</h2><p class="muted">Contact DeepQr support to re-enable selling at this shop.</p></div></div>`;
  if (business.require_shift && !myShift) return shiftGate(shop);
  const m = allowedModes();
  const shopPick = me.role !== 'cashier' && cache.shops.length > 1 ? `<select class="input" style="width:auto" aria-label="Selling at" onchange="posState.shopId=this.value;posState.cart=[];posSave();renderView()">${cache.shops.map(s => `<option value="${s.id}" ${s.id === shop.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : `<span class="chip">${icon('store')}${esc(shop.name)}</span>`;
  const shiftBar = myShift
    ? `<span class="shiftChip"><span class="dot"></span>Shift since ${new Date(myShift.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · float ${money(myShift.opening_float)}</span><button class="btn small" onclick="cashMoveModal()">${icon('coins')}Cash in/out</button><button class="btn small" onclick="closeShiftModal()">${icon('lock')}Close shift</button>`
    : `<span class="shiftChip off"><span class="dot"></span>No shift open</span><button class="btn small" onclick="openShiftModal()">${icon('unlock')}Open shift</button>`;
  const cats = [...new Set(cache.products.filter(p => p.active !== false && stock(shop.id, p.code) > 0).map(p => p.category || 'General'))].sort();
  return `${onlineBanner()}<div class="posTop">${shopPick}${shiftBar}${myDevice ? `<span class="chip ${myDevice.status === 'approved' ? 'ok' : 'warn'}" title="This device">${icon('phone')}${esc(myDevice.name)}</span>` : ''}</div>
  <div class="posGrid"><div>
   <div class="card"><div class="scanZone" id="scanZone"><div class="bigIco">${icon('qr')}</div><b style="font-size:16px">Scan an item</b><div class="muted" style="font-size:13px">QR labels, product barcodes or a typed serial. Each scan goes straight into the cart.</div>
     <form id="scanForm" class="scanInput" onsubmit="event.preventDefault()"><input id="scanInput" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Scan or type a code" placeholder="${m.hw ? 'Scanner ready — scan, or type a serial and press Enter' : 'Type a serial or code and press Enter'}"><button type="button" class="btn primary" onclick="const i=document.getElementById('scanInput');Scanner.emit(i.value,'typed');i.value='';i.focus()">Add</button></form>
     <div class="actions" style="justify-content:center;margin-top:12px">${m.cam ? `<button class="btn ${m.hw ? '' : 'primary'} lg" onclick="Scanner.openCamera({title:'Scan items into the cart'})">${icon('camera')}Scan with camera</button>` : ''}</div>
     <div class="lastScan" id="lastScan"></div></div></div>
   <div class="card"><div class="cardHead"><div><h3>Quick add</h3><p>For products without QR labels: tap to add by quantity.</p></div></div>
    <div class="catRow"><button class="pill ${posCat === '' ? 'active' : ''}" onclick="posCat='';document.getElementById('posProducts').innerHTML=posProducts(document.getElementById('posSearchInput').value);this.parentNode.querySelectorAll('.pill').forEach(b=>b.classList.remove('active'));this.classList.add('active')">All</button>${cats.map(c => `<button class="pill ${posCat === c ? 'active' : ''}" onclick="posCat='${jsq(c)}';document.getElementById('posProducts').innerHTML=posProducts(document.getElementById('posSearchInput').value);this.parentNode.querySelectorAll('.pill').forEach(b=>b.classList.remove('active'));this.classList.add('active')">${esc(c)}</button>`).join('')}</div>
    <div class="searchLine"><input class="input" id="posSearchInput" placeholder="Search products…" aria-label="Search products"></div><div class="prodGrid" id="posProducts">${posProducts('')}</div></div>
  </div>
  <div class="card cart" id="cartCard">${cartHtml()}</div></div>
  <button class="mobileCartBar" id="mobileCartBar" onclick="document.getElementById('cartCard').scrollIntoView({behavior:'smooth'})">${mobileBarHtml()}</button>`;
}
function mobileBarHtml() { const t = posTotals(); return `<span>${icon('cart')} Cart · ${t.items} item(s)</span><span>${money(t.total)} →</span>`; }
function posProducts(qv) {
  const shop = shopObj(posShopId()); if (!shop) return '';
  const s = (qv || '').toLowerCase();
  const list = cache.products.filter(p => p.active !== false && stock(shop.id, p.code) > 0 && (!posCat || (p.category || 'General') === posCat) && (p.name + ' ' + p.code + ' ' + p.barcode).toLowerCase().includes(s)).slice(0, 36);
  return list.map(p => `<button class="prodBtn" onclick="posAddProduct('${p.id}')"><b>${esc(p.name)}</b><small>${esc(p.code)} · ${stock(shop.id, p.code)} left</small><div style="font-weight:800;margin-top:4px">${money(p.price)}</div></button>`).join('') || '<p class="muted">No matching stock at this shop.</p>';
}
function cartHtml() {
  const t = posTotals(), c = posState.customer;
  const loyalty = business.loyalty_enabled;
  return `<div class="cardHead"><div><h3>Cart</h3><p>${t.items} item(s) · ${posState.cart.length} line(s)</p></div><div class="actions">${posState.cart.length ? `<button class="btn small" onclick="posHold()">${icon('pause')}Hold</button><button class="btn small danger" onclick="posClear()">${icon('trash')}Clear</button>` : ''}</div></div>
  <div class="custChip ${c ? 'set' : ''}" onclick="openCustomerPicker()" role="button" tabindex="0">${icon('user')}<div style="flex:1;min-width:0"><b>${c ? esc(c.name) : 'Walk-in customer'}</b><div class="meta">${c ? `${esc(c.phone || '')}${Number(c.balance) > 0 ? ` · owes ${money(c.balance)}` : ''}${loyalty ? ` · ${c.points || 0} pts` : ''}` : 'Tap to add a customer (needed for credit and points)'}</div></div>${c ? `<button class="btn small ghost" onclick="event.stopPropagation();posState.customer=null;posState.points=0;posSave();updateCart()" title="Remove customer">${icon('x')}</button>` : icon('arrowRight')}</div>
  ${posState.cart.length ? posState.cart.map((l, i) => `<div class="cartLine"><div style="min-width:0"><b>${esc(l.name)}</b><div class="muted" style="font-size:12px">${esc(l.code)} · ${can('can_edit_price') ? `<button class="priceBtn" onclick="posEditPrice(${i})" title="Change price">${money(l.price)}</button>` : money(l.price)}${l.price !== l.base_price ? ` <span class="tag warn">was ${money(l.base_price)}</span>` : ''}</div>${l.items ? `<div class="serials">${l.items.map(it => `<span class="serialChip">${esc(it.serial)}<button onclick="posRemoveSerial(${i},'${it.id}')" aria-label="Remove ${esc(it.serial)}">×</button></span>`).join('')}</div>` : ''}</div>
   ${l.items ? `<span class="tag info">${l.qty} scanned</span>` : `<div class="qtyBox"><button onclick="posQty(${i},${l.qty - 1})" aria-label="Less">−</button><input value="${l.qty}" inputmode="numeric" aria-label="Quantity" onchange="posQty(${i},this.value)"><button onclick="posQty(${i},${l.qty + 1})" aria-label="More">+</button></div>`}
   <b class="num right">${money(l.qty * l.price)}</b></div>`).join('') : `<div class="empty-state" style="padding:26px 10px">${icon('cart')}<br>Cart is empty — scan an item to start.</div>`}
  <div class="totals"><div class="row"><span>Subtotal</span><b class="num">${money(t.sub)}</b></div>${t.tax ? `<div class="row"><span>Tax</span><b class="num">${money(t.tax)}</b></div>` : ''}<div class="row"><span>Discount <button class="priceBtn muted" onclick="posDiscount()">${t.disc ? 'change' : 'add'}</button></span><b class="num">− ${money(t.disc)}</b></div>${t.ptsVal ? `<div class="row"><span>Points (${posState.points})</span><b class="num">− ${money(t.ptsVal)}</b></div>` : ''}${t.fee ? `<div class="row"><span>Delivery fee</span><b class="num">${money(t.fee)}</b></div>` : ''}<div class="row grand"><span>Total</span><span class="num">${money(t.total)}</span></div></div>
  <button class="btn primary lg wide" style="margin-top:14px" ${posState.cart.length ? '' : 'disabled'} onclick="openPayment()" id="payBtn">${icon('wallet')}Take payment · ${money(t.total)}</button>`;
}
function updateCart() { const c = document.getElementById('cartCard'); if (c) c.innerHTML = cartHtml(); const mb = document.getElementById('mobileCartBar'); if (mb) mb.innerHTML = mobileBarHtml(); posSave(); }
function posClear() { if (!posState.cart.length) return; confirmBox('Clear the cart?', 'All scanned items will be removed from this sale.', 'Clear cart', () => { posState.cart = []; posState.discount = 0; posState.points = 0; closeModal(); updateCart(); }, 'danger'); }
function cartQtyFor(pid) { return sum(posState.cart.filter(l => l.product_id === pid), 'qty'); }

let scanLock = false;
async function posScan(code, source, parsed) {
  if (scanLock) { setTimeout(() => posScan(code, source, parsed), 150); return; }
  const shopId = posShopId();
  if (parsed.type === 'receipt') { Scanner.feedback(false, 'That is a receipt QR. Open it under Sales to return items.'); return; }
  if ((parsed.type === 'qr' || parsed.type === 'serial') && posState.cart.some(l => l.items?.some(it => it.serial === parsed.serial))) {
    Scanner.feedback(false, 'Already in the cart: ' + parsed.serial); return;
  }
  if (parsed.type === 'code') { const p = product(code); if (p) { posAddProduct(p.id, true); return; } }
  if (isOffline) { offlineScan(code, parsed); return; }
  scanLock = true;
  try {
    const { data, error } = await sb.rpc('dq_lookup_item', { p_code: code, p_shop_id: shopId, p_device_key: deviceKey() });
    if (error) { if (netDown(error)) { goOffline(); offlineScan(code, parsed); return; } Scanner.feedback(false, errMsg(error)); return; }
    if (data.kind === 'product') { posAddProduct(data.product.id, true); return; }
    if (data.reason === 'NOT_FOUND') { Scanner.feedback(false, 'Not found: ' + code + ' — check the label belongs to this business'); return; }
    if (data.reason === 'OTHER_BUSINESS') { Scanner.feedback(false, data.message); return; }
    const it = data.item, p = data.product;
    if (data.reason === 'SOLD') { Scanner.feedback(false, `${p.name} ${it.serial} was already sold`); return; }
    if (data.reason === 'VOID') { Scanner.feedback(false, `${it.serial}: this label was cancelled (void)`); return; }
    if (data.reason === 'IN_TRANSIT') { Scanner.feedback(false, `${it.serial} is on a transfer — confirm the transfer under Transfers first`); return; }
    if (data.expired && !data.ok) { Scanner.feedback(false, `${p.name} ${it.serial} EXPIRED on ${fmtD(it.expiry_date)} — do not sell`); return; }
    if (posState.cart.some(l => l.items?.some(x => x.id === it.id))) { Scanner.feedback(false, 'Already in the cart: ' + it.serial); return; }
    if (cartQtyFor(p.id) + 1 > stockOf(shopId, p.id)) { Scanner.feedback(false, `Stock record shows ${stockOf(shopId, p.id)} ${p.name} at ${shopObj(shopId)?.name}. Receive or transfer stock first.`); return; }
    let line = posState.cart.find(l => l.product_id === p.id && l.items && l.price === Number(p.price));
    if (!line) { line = { product_id: p.id, code: p.code, name: p.name, price: Number(p.price), base_price: Number(p.price), tax: Number(p.tax || 0), qty: 0, items: [] }; posState.cart.push(line); }
    line.items.push({ id: it.id, serial: it.serial }); line.qty = line.items.length;
    if (posState.online?.pending?.[p.id] > 0) { posState.online.pending[p.id]--; setTimeout(() => { const b = document.querySelector('.onlineBanner'); if (b) b.outerHTML = onlineBanner(); }, 0); }
    const dd = it.expiry_date ? daysUntil(it.expiry_date) : null;
    Scanner.feedback(true, `${p.name} · ${it.serial} · ${money(p.price)}${data.other_shop ? ` (labelled for ${data.shop_name || 'another shop'})` : ''}${dd !== null && dd <= 7 ? ` · expires in ${dd} day(s)` : ''}`);
    updateCart();
  } finally { scanLock = false; }
}
function posAddProduct(pid, fromScan) {
  const p = productById(pid); const shopId = posShopId(); if (!p) return;
  if (cartQtyFor(p.id) + 1 > stockOf(shopId, p.id)) { Scanner.feedback(false, `Only ${stockOf(shopId, p.id)} ${p.name} in stock at ${shopObj(shopId)?.name}`); return; }
  let line = posState.cart.find(l => l.product_id === p.id && !l.items);
  if (line) line.qty++; else posState.cart.push({ product_id: p.id, code: p.code, name: p.name, price: Number(p.price), base_price: Number(p.price), tax: Number(p.tax || 0), qty: 1 });
  Scanner.feedback(true, `${p.name} added${fromScan ? ' (barcode)' : ''} · ${money(p.price)}`);
  updateCart();
}
function posRemoveSerial(i, id) { const l = posState.cart[i]; l.items = l.items.filter(x => x.id !== id); l.qty = l.items.length; if (!l.qty) posState.cart.splice(i, 1); updateCart(); }
function posQty(i, v) {
  const l = posState.cart[i], n = Math.max(0, Math.floor(Number(v) || 0));
  if (!n) { posState.cart.splice(i, 1); updateCart(); return; }
  const other = cartQtyFor(l.product_id) - l.qty;
  if (n + other > stockOf(posShopId(), l.product_id)) { toast(`Only ${stockOf(posShopId(), l.product_id)} in stock`, 'bad'); updateCart(); return; }
  l.qty = n; updateCart();
}
function posEditPrice(i) {
  const l = posState.cart[i];
  askBox('Change price', `${esc(l.name)} — normal price ${money(l.base_price)}`, { label: 'New unit price', type: 'number', value: l.price, min: 0, required: true }, 'Set price', (v) => { l.price = Math.max(0, Number(v) || 0); closeModal(); updateCart(); });
}
function posDiscount() {
  const t = posTotals(); const max = Number(perms.max_discount_pct ?? 100);
  modal(`<form id="discF"><div class="cardHead"><div><h3>Discount</h3><p>Your limit: ${max}% of the sale (${money((t.sub + t.tax) * max / 100)}).</p></div></div>
   <div class="formGrid"><div class="field"><label for="discA">Amount (${cur()})</label><input id="discA" type="number" min="0" step="any" value="${posState.discount || ''}" autofocus></div><div class="field"><label for="discP">or percent</label><input id="discP" type="number" min="0" max="${max}" step="any" placeholder="%"></div></div>
   <div class="actions" style="margin-top:14px"><button class="btn primary">Apply</button><button type="button" class="btn" onclick="posState.discount=0;closeModal();updateCart()">Remove discount</button></div></form>`, 'narrow');
  document.getElementById('discP').oninput = (e) => { document.getElementById('discA').value = Math.round((t.sub + t.tax) * Number(e.target.value || 0)) / 100; };
  document.getElementById('discF').onsubmit = (e) => {
    e.preventDefault(); const a = Math.max(0, Number(document.getElementById('discA').value || 0));
    if (a > (t.sub + t.tax) * max / 100 + 0.001) { toast(`Your discount limit is ${max}%`, 'bad'); return; }
    posState.discount = a; closeModal(); updateCart();
  };
}

/* ---------- customers at the till ---------- */
function openCustomerPicker(onPick) {
  const pick = onPick || ((c) => { posState.customer = { id: c.id, name: c.name, phone: c.phone, points: c.points, balance: c.balance, credit_limit: c.credit_limit }; posState.points = 0; closeModal(); updateCart(); });
  window.__pickCustomer = pick;
  modal(`<div class="cardHead"><div><h3>Customer</h3><p>Search by name or phone, or add a new customer.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="searchLine"><input class="input" id="custQ" placeholder="Name or phone…" autofocus aria-label="Search customers"></div>
   <div id="custList" style="max-height:300px;overflow:auto"></div>
   <form id="custNew" class="card flat" style="margin-top:14px"><b>New customer</b><div class="formGrid" style="margin-top:10px"><div class="field"><label for="cnN">Name</label><input id="cnN" required></div><div class="field"><label for="cnP">Phone</label><input id="cnP" inputmode="tel" required placeholder="07…"></div><button class="btn primary">${icon('plus')}Add &amp; select</button></div></form>`, 'narrow');
  const draw = () => {
    const s = (document.getElementById('custQ')?.value || '').toLowerCase(), sp = phoneClean(s);
    const list = cache.customers.filter(c => c.active !== false && (!s || c.name.toLowerCase().includes(s) || (sp && (c.phone || '').includes(sp)))).slice(0, 40);
    document.getElementById('custList').innerHTML = list.map(c => `<div class="row clickRow" onclick="window.__pickCustomer(customerById('${c.id}'))"><div><b>${esc(c.name)}</b><span class="sub">${esc(c.phone || '')}${business.loyalty_enabled ? ` · ${c.points} pts` : ''}</span></div>${Number(c.balance) > 0 ? `<span class="tag warn">owes ${money(c.balance)}</span>` : '<span class="tag ok">no debt</span>'}</div>`).join('') || '<p class="muted">No customers match.</p>';
  };
  document.getElementById('custQ').oninput = draw; draw();
  document.getElementById('custNew').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('cnN').value.trim(), phone = phoneClean(document.getElementById('cnP').value);
    const existing = cache.customers.find(c => c.phone === phone);
    if (existing) { toast('That phone already belongs to ' + existing.name, 'bad'); window.__pickCustomer(existing); return; }
    const { data, error } = await sb.from('customers').insert({ business_id: me.business_id, name, phone }).select().single();
    if (error) { toast(errMsg(error), 'bad'); return; }
    cache.customers.push(data); window.__pickCustomer(data);
  };
}

/* ---------- payment ---------- */
function openPayment() {
  if (!posState.cart.length) return;
  const on = posState.online;
  if (on && Object.values(on.pending || {}).some(q => q > 0)) { toast('Scan the remaining labelled items first (or choose “add without scanning”)', 'bad'); return; }
  if (isOffline && on) { toast('Online orders are completed when the internet is back', 'bad'); return; }
  if (isOffline && posState.points) { posState.points = 0; updateCart(); }
  payState = { ref: uid(), lines: on && on.paid ? [{ method: on.method, amount: posTotals().total, reference: on.reference }] : [{ method: 'Cash', amount: '', reference: '' }] };
  drawPayment();
}
function payCalc() {
  const t = posTotals();
  const paid = sum(payState.lines, l => Number(l.amount || 0));
  const cash = sum(payState.lines.filter(l => l.method === 'Cash'), l => Number(l.amount || 0));
  const nonCash = paid - cash;
  const change = Math.max(0, paid - t.total);
  const remaining = Math.max(0, t.total - paid);
  return { ...t, paid, cash, nonCash, change, remaining };
}
function drawPayment() {
  const c = payCalc(), cust = posState.customer;
  const methods = (business.payment_methods || ['Cash', 'M-Pesa', 'Tigo Pesa', 'Airtel Money', 'Card', 'Bank']);
  const loyalty = business.loyalty_enabled && cust && !isOffline;
  const credit = c.remaining > 0.004;
  const nonCashOver = c.nonCash > c.total + 0.004;
  const okToSell = !nonCashOver && (!credit || (!isOffline && business.allow_credit_sales && cust && can('can_sell_credit')));
  const roundUps = [...new Set([c.total, Math.ceil(c.total / 1000) * 1000, Math.ceil(c.total / 5000) * 5000, Math.ceil(c.total / 10000) * 10000])].filter(v => v > 0).slice(0, 4);
  modal(`${isOffline ? `<div class="banner warn">${icon('cloudOff')}<div><b>Offline sale</b><p>Take the full amount (cash or mobile money with its reference). Credit and points need the internet. The sale uploads by itself later.</p></div></div>` : ''}<div class="cardHead"><div><h3>Take payment</h3><p>${c.items} item(s)${cust ? ' · ' + esc(cust.name) : ''}. Add one or more payments; anything unpaid becomes the customer's debt.</p></div><button class="btn ghost" onclick="closeModal()" aria-label="Close">${icon('x')}</button></div>
   <div class="dueBox ${c.remaining <= 0.004 ? 'ok' : credit && cust ? 'warn' : ''}"><div><div class="muted" style="font-size:12px;font-weight:700">TOTAL</div><div class="v">${money(c.total)}</div></div><div class="right"><div class="muted" style="font-size:12px;font-weight:700">${c.remaining > 0.004 ? 'STILL TO PAY' : 'CHANGE'}</div><div class="v">${money(c.remaining > 0.004 ? c.remaining : c.change)}</div></div></div>
   ${loyalty ? `<div class="row" style="margin-top:10px"><span>${icon('gift')} ${esc(cust.name)} has <b>${cust.points}</b> points (worth ${money(cust.points * business.point_value)})</span><span class="actions"><input class="input" id="ptsIn" type="number" min="0" max="${cust.points}" step="1" style="width:110px" value="${posState.points || ''}" placeholder="Points"><button class="btn small" onclick="posState.points=Math.min(${cust.points},Number(document.getElementById('ptsIn').value||0));if(posState.points&&posState.points<${business.min_redeem_points}){toast('Redeem at least ${business.min_redeem_points} points','bad');posState.points=0}drawPayment();updateCart()">Use</button></span></div>` : ''}
   <div style="margin-top:14px"><div class="muted" style="font-size:12px;font-weight:700;margin-bottom:6px">ADD A PAYMENT</div><div class="payGrid">${methods.map(mt => `<button type="button" onclick="payAdd('${jsq(mt)}')">${esc(mt)}</button>`).join('')}</div></div>
   <div style="margin-top:12px">${payState.lines.map((l, i) => `<div class="payLine"><b>${esc(l.method)}</b><input class="input num" type="number" min="0" step="any" id="pa${i}" aria-label="${esc(l.method)} amount" value="${l.amount}" placeholder="${Math.max(0, c.remaining + Number(l.amount || 0))}" oninput="payState.lines[${i}].amount=this.value;payRefresh()">${l.method === 'Cash' ? `<div class="quickCash">${roundUps.map(v => `<button type="button" onclick="payState.lines[${i}].amount=${v};drawPayment()">${num(v)}</button>`).join('')}</div>` : `<input class="input mono" id="pr${i}" placeholder="Transaction ref${business.require_payment_ref ? ' (required)' : ''}" value="${esc(l.reference)}" oninput="payState.lines[${i}].reference=this.value">`}<button type="button" class="btn small ghost" onclick="payState.lines.splice(${i},1);drawPayment()" aria-label="Remove payment">${icon('x')}</button></div>`).join('') || '<p class="muted">No payment added — the full amount will be credit.</p>'}</div>
   <div id="payNote" style="margin-top:12px">${payNote(c)}</div>
   <div class="field" style="margin-top:10px"><label for="saleNote">Note on receipt (optional)</label><input id="saleNote" value="${esc(posState.note || '')}" oninput="posState.note=this.value"></div>
   <div class="actions" style="margin-top:16px"><button class="btn primary lg" id="paySubmit" ${okToSell ? '' : 'disabled'} onclick="completeSale(this)">${icon('check')}${credit ? 'Complete sale on credit' : 'Complete sale'}</button><button class="btn" onclick="closeModal()">Back to cart</button></div>`);
  const firstEmpty = payState.lines.findIndex(l => l.amount === '');
  if (firstEmpty >= 0) setTimeout(() => document.getElementById('pa' + firstEmpty)?.focus(), 40);
}
function payNote(c) {
  const cust = posState.customer;
  if (c.nonCash > c.total + 0.004) return `<div class="banner bad">${icon('alert')}<div><b>Mobile money, card and bank cannot be more than the total</b><p>Only cash can give change.</p></div></div>`;
  if (c.remaining > 0.004) {
    if (isOffline) return `<div class="banner bad">${icon('alert')}<div><b>Collect ${money(c.remaining)} more</b><p>Credit sales need the internet.</p></div></div>`;
    if (!business.allow_credit_sales) return `<div class="banner bad">${icon('alert')}<div><b>Collect ${money(c.remaining)} more</b><p>Credit sales are switched off in Settings.</p></div></div>`;
    if (!can('can_sell_credit')) return `<div class="banner bad">${icon('alert')}<div><b>Collect ${money(c.remaining)} more</b><p>You are not allowed to sell on credit.</p></div></div>`;
    if (!cust) return `<div class="banner warn">${icon('user')}<div><b>${money(c.remaining)} unpaid</b><p>Choose the customer to sell on credit. <button class="btn small" onclick="openCustomerPicker((cc)=>{posState.customer={id:cc.id,name:cc.name,phone:cc.phone,points:cc.points,balance:cc.balance,credit_limit:cc.credit_limit};updateCart();drawPayment()})">Choose customer</button></p></div></div>`;
    const lim = Number(cust.credit_limit || 0), after = Number(cust.balance || 0) + c.remaining;
    return `<div class="banner warn">${icon('coins')}<div><b>${money(c.remaining)} goes on ${esc(cust.name)}'s account</b><p>They will owe ${money(after)}${lim ? ` (limit ${money(lim)})` : ''}.</p></div></div>`;
  }
  return c.change > 0 ? `<div class="banner ok">${icon('coins')}<div><b>Give ${money(c.change)} change</b></div></div>` : '';
}
function payRefresh() {
  const c = payCalc(); const box = document.querySelector('.dueBox'); if (!box) return;
  box.className = 'dueBox ' + (c.remaining <= 0.004 ? 'ok' : c.remaining > 0 && posState.customer ? 'warn' : '');
  box.innerHTML = `<div><div class="muted" style="font-size:12px;font-weight:700">TOTAL</div><div class="v">${money(c.total)}</div></div><div class="right"><div class="muted" style="font-size:12px;font-weight:700">${c.remaining > 0.004 ? 'STILL TO PAY' : 'CHANGE'}</div><div class="v">${money(c.remaining > 0.004 ? c.remaining : c.change)}</div></div>`;
  document.getElementById('payNote').innerHTML = payNote(c);
  const credit = c.remaining > 0.004;
  const ok = !(c.nonCash > c.total + 0.004) && (!credit || (!isOffline && business.allow_credit_sales && posState.customer && can('can_sell_credit')));
  const b = document.getElementById('paySubmit'); b.disabled = !ok; b.innerHTML = icon('check') + (credit ? 'Complete sale on credit' : 'Complete sale');
}
function payAdd(method) {
  const c = payCalc();
  const existing = payState.lines.find(l => l.method === method && (l.amount === '' || Number(l.amount) === 0));
  if (existing) { existing.amount = c.remaining || ''; }
  else { const empty = payState.lines.findIndex(l => l.amount === '' || Number(l.amount) === 0); if (empty >= 0) payState.lines.splice(empty, 1); payState.lines.push({ method, amount: c.remaining > 0 ? c.remaining : '', reference: '' }); }
  drawPayment();
}
async function completeSale(btn) {
  const c = payCalc();
  for (const l of payState.lines) if (l.method !== 'Cash' && Number(l.amount) > 0 && business.require_payment_ref && !String(l.reference || '').trim()) { toast(`Enter the ${l.method} transaction reference`, 'bad'); return; }
  await withBusy(btn, async () => {
    const lines = [];
    posState.cart.forEach(l => { if (l.items) l.items.forEach(it => lines.push({ item_id: it.id, price: l.price })); else lines.push({ product_id: l.product_id, qty: l.qty, price: l.price }); });
    const payload = {
      client_ref: payState.ref || uid(), shop_id: posShopId(), lines, discount: c.disc, points_redeem: posState.points || 0, device_key: deviceKey(), shift_id: myShift?.id || null,
      customer_id: posState.customer?.id || null, note: posState.note || '', date: dateOnly(), time: timeNow(),
      payments: payState.lines.filter(l => Number(l.amount) > 0).map(l => ({ method: l.method, amount: Number(l.amount), reference: (l.reference || '').trim() }))
    };
    let r;
    if (posState.online) payload.online_order_id = posState.online.id;
    if (isOffline) r = await queueOfflineSale(payload, c);
    else {
      try { r = await rpc('dq_checkout4', { p: payload }); }
      catch (e) {
        if (netDown(e) && !posState.online) { goOffline(); r = await queueOfflineSale(payload, c); }
        else { toast(errMsg(e), 'bad'); beep(false); return; }
      }
    }
    if (r.sale?.pending) {
      posState.cart = []; posState.discount = 0; posState.points = 0; posState.note = ''; posState.customer = null; posSave();
      beep(true); renderView(); showReceipt(r.sale, r.lines, r.payments, null); return;
    }
    // local cache updates
    const sale = r.sale; cache.sales.unshift(sale); cache.saleLines.push(...(r.lines || []));
    const byProd = groupBy(r.lines || [], l => l.product_id);
    Object.entries(byProd).forEach(([pid, ls]) => { const p = productById(pid); if (p) setStockLocal(sale.shop_id, p.code, stock(sale.shop_id, p.code) - sum(ls, 'qty')); });
    const sold = new Set((r.lines || []).filter(l => l.item_id).map(l => l.item_id)); cache.items = cache.items.filter(i => !sold.has(i.id));
    if (r.customer) { const cc = customerById(r.customer.id); if (cc) Object.assign(cc, r.customer); else cache.customers.push(r.customer); }
    cache.activity.unshift({ description: `Sale ${sale.receipt}: ${money(sale.total)}`, by_name: me.name, created_at: new Date().toISOString() });
    if (posState.online) { toast(`Online order ${posState.online.no} completed${r.bonus_points ? ` · +${r.bonus_points} bonus points` : ''}`, 'ok'); if (cache.online) { const oo = cache.online.find(x => x.id === posState.online.id); if (oo) oo.status = 'completed'; } }
    posState.cart = []; posState.discount = 0; posState.points = 0; posState.note = ''; posState.customer = null; posState.online = null; posSave();
    beep(true); renderView(); showReceipt(sale, r.lines, r.payments, r.customer);
    refreshRecs(); snapSave();
  });
}

/* ---------- receipt ---------- */
function receiptHtml(s, lines, payments, customer) {
  const l = lines || cache.saleLines.filter(x => x.sale_id === s.id);
  const groups = {}; l.forEach(x => { const k = x.product_id + '|' + x.price; (groups[k] = groups[k] || { name: x.name, price: Number(x.price), qty: 0, refunded: 0, serials: [] }); groups[k].qty += Number(x.qty); groups[k].refunded += Number(x.refunded_qty || 0); if (x.serial) groups[k].serials.push(x.serial); });
  const pays = payments || [];
  const row = (a, b, strong) => `<tr><td>${strong ? `<b>${a}</b>` : a}</td><td class="right">${strong ? `<b>${b}</b>` : b}</td></tr>`;
  return `<div class="receipt"><div style="text-align:center">${business.logo_url ? `<img src="${esc(business.logo_url)}" alt="" class="rcLogo">` : logoMark(30)}</div><h2>${esc(business.name)}</h2><div style="text-align:center;font-size:11.5px;color:#475569">${business.receipt_header ? esc(business.receipt_header) + '<br>' : ''}${esc(shopObj(s.shop_id)?.name || '')}${business.address ? ' · ' + esc(business.address) : ''}${business.phone ? '<br>' + esc(business.phone) : ''}${business.tin ? '<br>TIN ' + esc(business.tin) : ''}</div>
  <div class="dash"></div><table>${row('Receipt', `<span class="mono">${esc(s.receipt)}</span>`)}${row('Date', `${fmtD(s.date)} ${esc(s.time || '')}`)}${row('Cashier', esc(s.cashier_name || ''))}${row('Customer', esc(s.customer || 'Walk-in') + (s.customer_phone ? ' · ' + esc(s.customer_phone) : ''))}</table>
  <div class="dash"></div><table>${Object.values(groups).map(g => `<tr><td>${esc(g.name)}<br><span class="ser">${g.qty} × ${money(g.price)}${g.refunded ? ` · ${g.refunded} returned` : ''}${g.serials.length ? '<br>SN ' + g.serials.map(esc).join(', ') : ''}</span></td><td class="right" style="vertical-align:top">${money(g.qty * g.price)}</td></tr>`).join('')}</table>
  <div class="dash"></div><table>${row('Subtotal', money(s.subtotal))}${Number(s.tax) ? row('Tax', money(s.tax)) : ''}${Number(s.discount) ? row('Discount', '− ' + money(s.discount)) : ''}${Number(s.points_value) ? row(`Points (${s.points_redeemed})`, '− ' + money(s.points_value)) : ''}${row('TOTAL', money(s.total), true)}
   ${pays.filter(p => p.kind !== 'refund').map(p => row(esc(p.method) + (p.reference ? ` <span class="ser">${esc(p.reference)}</span>` : ''), money(p.amount))).join('')}
   ${s.change_due != null && Number(s.change_due) > 0 ? row('Change', money(s.change_due)) : ''}${Number(s.balance_due) > 0 ? row('Balance due', money(s.balance_due), true) : ''}${Number(s.refunded_amount) > 0 ? row('Refunded', '− ' + money(s.refunded_amount)) : ''}</table>
  ${s.status === 'refunded' ? '<div style="text-align:center;font-weight:800;color:#DC2626;margin-top:8px">REFUNDED</div>' : s.status === 'partially_refunded' ? '<div style="text-align:center;font-weight:800;color:#B45309;margin-top:8px">PARTLY REFUNDED</div>' : ''}
  ${customer && business.loyalty_enabled ? `<div class="dash"></div><div style="text-align:center;font-size:12px">${s.points_earned ? `+${s.points_earned} points · ` : ''}Points balance: <b>${customer.points}</b>${Number(customer.balance) > 0 ? `<br>Account balance owed: <b>${money(customer.balance)}</b>` : ''}</div>` : ''}
  ${s.note ? `<div class="dash"></div><div style="font-size:12px">${esc(s.note)}</div>` : ''}
  ${s.pending ? `<div class="offStamp">${icon('cloudOff')} Saved offline · uploads when the internet is back</div>` : ''}
  <div class="dash"></div><div style="text-align:center">${business.receipt_show_qr !== false ? `<div class="qrPreview">${qrSvg(s.public_ref ? receiptLink(s.public_ref) : 'DQR|' + (business.code || '') + '|' + s.receipt + '|' + s.total, 2)}</div>${s.public_ref ? '<div style="font-size:10.5px;color:#475569">Scan for your digital receipt</div>' : ''}` : ''}<div style="font-size:11.5px;margin-top:6px">${esc(business.receipt_footer || 'Thank you')}</div><div style="font-size:10px;color:#94A3B8;margin-top:4px">Powered by DeepQr</div></div></div>`;
}
function receiptText(s, lines) {
  const l = lines || cache.saleLines.filter(x => x.sale_id === s.id);
  return `${business.name}\nReceipt ${s.receipt} · ${fmtD(s.date)} ${s.time || ''}\n` + l.map(x => `${x.name} x${x.qty} = ${money(x.qty * x.price)}${x.serial ? ' (SN ' + x.serial + ')' : ''}`).join('\n') + `\nTOTAL ${money(s.total)}${Number(s.balance_due) > 0 ? `\nBalance due ${money(s.balance_due)}` : ''}\n${business.receipt_footer || 'Thank you'}`;
}
function receiptLink(ref) { return location.origin + location.pathname.replace(/index\.html?$/, '') + '?r=' + ref; }
async function showReceipt(s, lines, payments, customer) {
  if (!payments && s.pending) payments = [];
  if (!payments) { const { data } = await sb.from('sale_payments').select('*').eq('sale_id', s.id); payments = data || []; }
  if (!lines) { lines = cache.saleLines.filter(x => x.sale_id === s.id); if (!lines.length) { const { data } = await sb.from('sale_lines').select('*').eq('sale_id', s.id); lines = data || []; } }
  if (!customer && s.customer_id) customer = customerById(s.customer_id);
  const phone = phoneClean(s.customer_phone || customer?.phone || '').replace(/^0/, '255');
  modal(`<div class="actions noPrint" style="justify-content:flex-end;margin-bottom:12px">${phone ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${phone}?text=${encodeURIComponent(receiptText(s, lines) + (s.public_ref ? '\n' + receiptLink(s.public_ref) : ''))}">${icon('whatsapp')}WhatsApp</a>` : ''}${s.public_ref ? `<button class="btn" onclick="copyText('${receiptLink(s.public_ref)}','Receipt link copied')">${icon('copy')}Link</button>` : ''}<button class="btn" onclick="printModal()">${icon('printer')}Print</button>${view === 'pos' ? `<button class="btn primary" onclick="closeModal()">${icon('plus')}New sale</button>` : `<button class="btn" onclick="closeModal()">Close</button>`}</div>${receiptHtml(s, lines, payments, customer)}`, 'narrow');
}
async function showReceiptById(id) { const s = cache.sales.find(x => x.id === id) || (await sb.from('sales').select('*').eq('id', id).single()).data; if (s) showReceipt(s); }

/* ---------- held sales ---------- */
async function posHold() {
  if (!posState.cart.length) return;
  const label = posState.customer?.name || ('Sale ' + timeNow());
  const { data, error } = await sb.from('held_carts').insert({ business_id: me.business_id, shop_id: posShopId(), label, cart: posState.cart, customer: posState.customer, created_by: me.name }).select().single();
  if (error) { toast(errMsg(error), 'bad'); return; }
  cache.held.unshift(data); posState.cart = []; posState.customer = null; posState.discount = 0; posState.points = 0; posSave();
  toast(`Held "${label}" — serve the next customer`, 'ok'); renderView();
}
function openHeld() {
  const list = cache.held.filter(h => me.role !== 'cashier' || h.shop_id === me.shop_id);
  modal(`<div class="cardHead"><div><h3>Held sales</h3><p>Paused carts from this business. Resume one to continue selling.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
  ${list.length ? list.map(h => `<div class="row"><div><b>${esc(h.label)}</b><span class="sub">${sum(h.cart || [], 'qty')} item(s) · ${money(sum(h.cart || [], l => l.qty * l.price))} · ${esc(h.created_by || '')} · ${ago(h.created_at)}${h.shop_id ? ' · ' + esc(shopObj(h.shop_id)?.name || '') : ''}</span></div><div class="actions"><button class="btn small primary" onclick="resumeHeld('${h.id}')">Resume</button><button class="btn small ghost" onclick="deleteHeld('${h.id}')" aria-label="Delete">${icon('trash')}</button></div></div>`).join('') : emptyState('pause', 'No held sales', 'Use Hold in the cart to pause a sale and serve the next customer.')}`, 'narrow');
}
async function resumeHeld(id) {
  const h = cache.held.find(x => x.id === id); if (!h) return;
  if (posState.cart.length) await posHold();
  await sb.from('held_carts').delete().eq('id', id);
  cache.held = cache.held.filter(x => x.id !== id);
  posState.cart = h.cart || []; posState.customer = h.customer || null; if (h.shop_id) posState.shopId = h.shop_id; posSave();
  closeModal(); if (view !== 'pos') go('pos'); else renderView(); toast('Resumed ' + h.label, 'ok');
}
async function deleteHeld(id) { await sb.from('held_carts').delete().eq('id', id); cache.held = cache.held.filter(x => x.id !== id); openHeld(); }

/* ---------- shifts ---------- */
function shiftGate(shop) {
  return `<div class="card"><div class="lockScreen"><div class="bigIco" style="background:var(--info-bg);color:var(--primary)">${icon('unlock')}</div><h2>Open your till shift</h2><p class="muted">Count the cash in the drawer before your first sale at ${esc(shop.name)}. At the end of the day you close the shift and DeepQr shows any shortage or excess.</p>
  <form onsubmit="event.preventDefault();openShift(document.getElementById('gFloat').value,this.querySelector('button'))" class="searchLine" style="max-width:360px;margin:0 auto"><input class="input" id="gFloat" type="number" min="0" step="any" placeholder="Opening cash (float)" required aria-label="Opening cash"><button class="btn primary">Open shift</button></form></div></div>`;
}
function openShiftModal() { askBox('Open till shift', 'Count the cash in the drawer before you start selling.', { label: 'Opening cash (float)', type: 'number', min: 0, required: true }, 'Open shift', (v, b) => openShift(v, b)); }
async function openShift(v, btn) {
  await withBusy(btn, async () => {
    const r = await rpcToast('dq_open_shift', { p: { shop_id: posShopId(), opening_float: Number(v || 0) } }, 'Shift opened');
    if (r) { myShift = r; cache.shifts.unshift(r); closeModal(); render(); }
  });
}
function cashMoveModal() {
  if (!myShift) return;
  modal(`<form id="cmF"><div class="cardHead"><div><h3>Cash in / cash out</h3><p>Record money added to or taken from the drawer that is not a sale (change float, petty cash, banking).</p></div></div>
  <div class="formGrid"><div class="field"><label for="cmT">Type</label><select id="cmT"><option value="out">Cash out (payout)</option><option value="in">Cash in</option></select></div><div class="field"><label for="cmA">Amount</label><input id="cmA" type="number" min="1" step="any" required></div></div>
  <div class="field" style="margin-top:10px"><label for="cmR">Reason</label><input id="cmR" required placeholder="e.g. Bodaboda delivery, banking"></div>
  <div class="actions" style="margin-top:14px"><button class="btn primary">Save</button><button type="button" class="btn" onclick="closeModal()">Cancel</button></div></form>`, 'narrow');
  document.getElementById('cmF').onsubmit = async (e) => { e.preventDefault(); const r = await rpcToast('dq_cash_move', { p: { shift_id: myShift.id, type: document.getElementById('cmT').value, amount: Number(document.getElementById('cmA').value), reason: document.getElementById('cmR').value } }, 'Saved'); if (r) closeModal(); };
}
function shiftReportHtml(r, closing) {
  const s = r.shift;
  const byM = groupBy(r.by_method || [], x => x.method);
  return `<dl class="kv"><dt>Cashier</dt><dd>${esc(s.member_name)}</dd><dt>Shop</dt><dd>${esc(r.shop || '')}</dd><dt>Opened</dt><dd>${fmtDT(s.opened_at)}</dd>${s.closed_at ? `<dt>Closed</dt><dd>${fmtDT(s.closed_at)} by ${esc(s.closed_by || '')}</dd>` : ''}<dt>Receipts</dt><dd>${r.receipts} · ${money(r.sales_total)}</dd><dt>Credit given</dt><dd>${money(r.credit_given)}</dd></dl>
  <table style="min-width:0;margin-top:12px"><thead><tr><th>Payment</th><th class="right">Sales</th><th class="right">Debt paid</th><th class="right">Refunds</th></tr></thead><tbody>${Object.entries(byM).map(([m, rows]) => `<tr><td>${esc(m)}</td><td class="right num">${money(sum(rows.filter(x => x.kind === 'sale'), 'amount'))}</td><td class="right num">${money(sum(rows.filter(x => x.kind === 'debt_payment'), 'amount'))}</td><td class="right num">${money(-sum(rows.filter(x => x.kind === 'refund'), 'amount'))}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No payments yet</td></tr>'}</tbody></table>
  <div class="totals"><div class="row"><span>Opening float</span><b class="num">${money(s.opening_float)}</b></div><div class="row"><span>Cash taken (net of change &amp; refunds)</span><b class="num">${money(r.cash_sales)}</b></div><div class="row"><span>Cash in</span><b class="num">${money(r.cash_in)}</b></div><div class="row"><span>Cash out</span><b class="num">− ${money(r.cash_out)}</b></div><div class="row grand"><span>Expected in drawer</span><span class="num">${money(r.expected_cash)}</span></div>
  ${s.counted_cash != null ? `<div class="row"><span>Counted</span><b class="num">${money(s.counted_cash)}</b></div><div class="row"><span>Difference</span><b class="num ${Number(s.difference) < 0 ? 'bad' : Number(s.difference) > 0 ? 'warn' : 'ok'}">${Number(s.difference) > 0 ? '+' : ''}${money(s.difference)}</b></div>` : ''}</div>
  ${(r.movements || []).length ? `<h4 style="margin:14px 0 6px">Cash in / out</h4>${r.movements.map(m => `<div class="row"><span>${m.type === 'in' ? 'In' : 'Out'} · ${esc(m.reason)} <span class="sub">${esc(m.by_name || '')} · ${fmtDT(m.created_at)}</span></span><b>${money(m.amount)}</b></div>`).join('')}` : ''}`;
}
async function closeShiftModal(shiftId) {
  const id = shiftId || myShift?.id; if (!id) return;
  if (isOffline) { toast('Close the shift when the internet is back, so the offline sales are counted', 'bad'); return; }
  if (outboxN > 0) { toast(`Uploading ${outboxN} offline sale(s) first…`); await syncOutbox(true); if (outboxN > 0) { toast('Some offline sales are not uploaded yet. Check the connection, then close the shift.', 'bad'); return; } }
  const r = await rpcToast('dq_shift_report', { p_shift_id: id }); if (!r) return;
  modal(`<div class="cardHead"><div><h3>Close shift</h3><p>Count the cash in the drawer and enter the total. DeepQr compares it with what should be there.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>${shiftReportHtml(r)}
   <form id="csF" class="formGrid" style="margin-top:14px"><div class="field"><label for="csC">Cash counted in drawer</label><input id="csC" type="number" min="0" step="any" required autofocus></div><div class="field"><label for="csN">Note (optional)</label><input id="csN"></div><button class="btn primary">${icon('lock')}Close shift</button></form>`);
  document.getElementById('csF').onsubmit = async (e) => {
    e.preventDefault();
    const z = await rpcToast('dq_close_shift', { p: { shift_id: id, counted_cash: Number(document.getElementById('csC').value), note: document.getElementById('csN').value } }, 'Shift closed');
    if (!z) return;
    if (myShift?.id === id) myShift = null;
    const sh = cache.shifts.find(x => x.id === id); if (sh) Object.assign(sh, z.shift);
    modal(`<div class="actions noPrint" style="justify-content:flex-end;margin-bottom:10px"><button class="btn" onclick="printModal()">${icon('printer')}Print</button><button class="btn primary" onclick="closeModal();render()">Done</button></div><h3>End of shift report</h3>${shiftReportHtml(z, true)}`);
  };
}
async function viewShift(id) { const r = await rpcToast('dq_shift_report', { p_shift_id: id }); if (r) modal(`<div class="actions noPrint" style="justify-content:flex-end;margin-bottom:10px"><button class="btn" onclick="printModal()">${icon('printer')}Print</button><button class="btn" onclick="closeModal()">Close</button></div><h3>Shift report</h3>${shiftReportHtml(r)}${r.shift.status === 'open' && isMgr() ? `<button class="btn" style="margin-top:12px" onclick="closeShiftModal('${id}')">${icon('lock')}Close this shift</button>` : ''}`); }

/* ---------- debt payments ---------- */
function openCustomerPayment(customerId) {
  const c = customerId ? customerById(customerId) : null;
  if (!c) { openCustomerPicker((cc) => openCustomerPayment(cc.id)); return; }
  const methods = business.payment_methods || ['Cash', 'M-Pesa'];
  modal(`<form id="cpF"><div class="cardHead"><div><h3>Debt payment — ${esc(c.name)}</h3><p>${esc(c.phone || '')} · owes <b>${money(c.balance)}</b>. The oldest unpaid receipts are settled first.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
  ${Number(c.balance) <= 0 ? `<div class="banner ok">${icon('check')}<div><b>${esc(c.name)} owes nothing</b></div></div>` : `<div class="formGrid"><div class="field"><label for="cpA">Amount paid</label><input id="cpA" type="number" min="1" max="${c.balance}" step="any" value="${c.balance}" required autofocus></div><div class="field"><label for="cpM">Method</label><select id="cpM">${methods.map(m => `<option>${esc(m)}</option>`).join('')}</select></div><div class="field"><label for="cpR">Reference</label><input id="cpR" class="mono" placeholder="Mobile money / bank ref"></div></div>
  <div class="actions" style="margin-top:14px"><button class="btn primary">${icon('check')}Record payment</button></div>`}</form>`, 'narrow');
  const f = document.getElementById('cpF'); if (Number(c.balance) <= 0) return;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const r = await rpcToast('dq_customer_payment', { p: { customer_id: c.id, amount: Number(document.getElementById('cpA').value), method: document.getElementById('cpM').value, reference: document.getElementById('cpR').value, shift_id: myShift?.id || null } }, 'Payment recorded');
    if (!r) return;
    c.balance = r.balance; closeModal();
    const { data } = await sb.from('sales').select('*').eq('customer_id', c.id); (data || []).forEach(s => { const x = cache.sales.find(y => y.id === s.id); if (x) Object.assign(x, s); });
    renderView();
  };
}

/* ---------- refunds / returns ---------- */
async function openRefund(saleId) {
  const s = cache.sales.find(x => x.id === saleId) || (await sb.from('sales').select('*').eq('id', saleId).single()).data;
  let lines = cache.saleLines.filter(l => l.sale_id === saleId);
  if (!lines.length) lines = (await sb.from('sale_lines').select('*').eq('sale_id', saleId)).data || [];
  const methods = business.payment_methods || ['Cash'];
  modal(`<form id="rfF"><div class="cardHead"><div><h3>Return items — ${esc(s.receipt)}</h3><p>Tick what the customer is returning. Labelled items become sellable again and stock goes back to ${esc(shopObj(s.shop_id)?.name || 'the shop')}.${Number(s.balance_due) > 0 ? ` This receipt still has ${money(s.balance_due)} unpaid — that debt is cancelled first.` : ''}</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
  <div class="tableWrap"><table style="min-width:0"><thead><tr><th></th><th>Item</th><th class="right">Sold</th><th class="right">Returned</th><th style="width:110px">Return now</th></tr></thead><tbody>
  ${lines.map(l => { const left = Number(l.qty) - Number(l.refunded_qty || 0); return `<tr><td><input type="checkbox" class="rfChk" data-id="${l.id}" ${left > 0 ? '' : 'disabled'} aria-label="Return ${esc(l.name)}"></td><td><b>${esc(l.name)}</b>${l.serial ? `<span class="sub mono">SN ${esc(l.serial)}</span>` : ''}</td><td class="right num">${l.qty}</td><td class="right num">${l.refunded_qty || 0}</td><td>${left > 0 ? (l.item_id ? '<span class="muted">1</span>' : `<input class="input rfQty" data-id="${l.id}" type="number" min="1" max="${left}" value="${left}" style="padding:5px 8px">`) : '—'}</td></tr>`; }).join('')}
  </tbody></table></div>
  <div class="formGrid" style="margin-top:12px"><div class="field"><label for="rfM">Pay back with</label><select id="rfM">${methods.map(m => `<option>${esc(m)}</option>`).join('')}</select></div><div class="field"><label for="rfRef">Reference</label><input id="rfRef" class="mono"></div><div class="field"><label for="rfR">Reason</label><input id="rfR" required placeholder="e.g. faulty, wrong size"></div></div>
  <div class="actions" style="margin-top:14px"><button class="btn danger">${icon('refund')}Return selected</button><button type="button" class="btn" onclick="document.querySelectorAll('.rfChk:not(:disabled)').forEach(c=>c.checked=true)">Select all</button></div></form>`);
  document.getElementById('rfF').onsubmit = async (e) => {
    e.preventDefault();
    const sel = [...document.querySelectorAll('.rfChk:checked')].map(c => { const q = document.querySelector(`.rfQty[data-id="${c.dataset.id}"]`); return { line_id: c.dataset.id, qty: q ? Number(q.value) : 1 }; });
    if (!sel.length) { toast('Tick at least one item', 'bad'); return; }
    const r = await rpcToast('dq_refund2', { p: { sale_id: saleId, lines: sel, reason: document.getElementById('rfR').value, method: document.getElementById('rfM').value, reference: document.getElementById('rfRef').value, shift_id: myShift?.id || null } });
    if (!r) return;
    closeModal();
    modal(`<div class="cardHead"><div><h3>Return recorded</h3><p>${esc(s.receipt)}</p></div></div><div class="totals"><div class="row"><span>Value returned</span><b>${money(r.refund_value)}</b></div>${r.debt_cancelled ? `<div class="row"><span>Debt cancelled</span><b>${money(r.debt_cancelled)}</b></div>` : ''}<div class="row grand"><span>Give back to customer</span><span>${money(r.cash_back)}</span></div></div><div class="actions" style="margin-top:14px"><button class="btn primary" onclick="closeModal()">Done</button></div>`, 'narrow');
    await reloadAndRender();
  };
}

/* ---------- device lock screen ---------- */
function deviceLockScreen(reason) {
  const msg = {
    unregistered: ['This device is not authorised to sell', 'Your business only allows approved scanners and phones. Register this device, then ask the owner or a manager to approve it under Devices & scanners.'],
    pending: ['Waiting for approval', 'This device is registered and waiting for the owner or a manager to approve it under Devices & scanners.'],
    blocked: ['This device is blocked', 'The owner (or DeepQr) blocked this device from selling.'],
    wrongshop: ['Device assigned to another shop', 'This device is approved for a different shop.']
  }[reason] || ['Device not authorised', ''];
  return `<div class="card"><div class="lockScreen"><div class="bigIco">${icon('lock')}</div><h2 style="margin:0 0 8px">${msg[0]}</h2><p class="muted">${msg[1]}</p>${reason === 'unregistered' ? registerDeviceForm() : `<button class="btn" onclick="recheckDevice()">${icon('refund')}Check again</button>`}</div></div>`;
}
