/* =============================================================================
   v4 inside a business: online orders, online shop setup, payments centre,
   supplier directory & invites, smart suggestions and the getting-started guide
   ============================================================================= */
const OO_TABS = [['new', 'New', ['placed']], ['progress', 'In progress', ['accepted', 'preparing', 'ready', 'out_for_delivery']], ['done', 'Completed', ['completed']], ['closed', 'Cancelled', ['cancelled', 'rejected']]];
let ooTimer = null, ooSeen = null;
async function loadOnlineOrders() {
  const { data } = await sb.from('online_orders').select('*').order('created_at', { ascending: false }).limit(300);
  cache.online = data || []; cache.onlineAt = Date.now();
  const ids = cache.online.map(o => o.id);
  cache.onlineItems = [];
  for (let i = 0; i < ids.length; i += 150) { const r = await sb.from('online_order_items').select('*').in('order_id', ids.slice(i, i + 150)); cache.onlineItems.push(...(r.data || [])); }
}
function onlineWatch() {
  clearInterval(ooTimer);
  if (!me || !business?.store_enabled) return;
  ooTimer = setInterval(async () => {
    if (!me) { clearInterval(ooTimer); return; }
    const { data } = await sb.from('online_orders').select('id,status').eq('status', 'placed');
    const n = (data || []).length;
    if (ooSeen !== null && n > ooSeen) { beep(true); setTimeout(() => beep(true), 220); toast(`New online order${n - ooSeen > 1 ? 's' : ''} — open Online orders`, 'ok'); await loadOnlineOrders(); if (view === 'online') renderView(); else { const nav = document.querySelector('.nav'); if (nav) render(); } }
    ooSeen = n;
  }, 45000);
}
function ooItems(id) { return (cache.onlineItems || []).filter(i => i.order_id === id); }
PAGES.online = {
  title: 'Online orders', sub: () => business.store_enabled ? `Your shop is open at <button class="priceBtn" onclick="copyText('${jsq(location.origin + location.pathname + '?shop=' + business.store_slug)}','Shop link copied')">${esc(location.host + location.pathname)}?shop=${esc(business.store_slug)} ${icon('copy')}</button>` : 'Let customers order from their phones, then pick up or get it delivered',
  actions: () => `${business.store_enabled ? `<button class="btn" onclick="goPublic('store',{slug:'${jsq(business.store_slug)}'})">${icon('eye')}View my shop</button>` : ''}${isMgr() ? `<button class="btn ${business.store_enabled ? '' : 'primary'}" onclick="openStoreSettings()">${icon('settings')}${business.store_enabled ? 'Shop settings' : 'Open my online shop'}</button>` : ''}`,
  render: () => {
    if (!cache.online) { loadOnlineOrders().then(() => view === 'online' && renderView()); return `<div class="card"><div class="empty"><span class="spinner"></span> Loading orders…</div></div>`; }
    if (Date.now() - (cache.onlineAt || 0) > 5000) { cache.onlineAt = Date.now(); const n0 = cache.online.filter(o => o.status === 'placed').length; loadOnlineOrders().then(() => { if (view !== 'online' || modalOpen()) return; if (cache.online.filter(o => o.status === 'placed').length !== n0) render(); else renderView(); }); }
    if (!business.store_enabled && !cache.online.length) return storeIntro();
    const tab = viewParams.tab || 'new';
    const mine = cache.online.filter(o => me.role !== 'cashier' || !o.shop_id || o.shop_id === me.shop_id);
    const list = mine.filter(o => OO_TABS.find(t => t[0] === tab)[2].includes(o.status));
    const unver = mine.filter(o => o.payment_status === 'pending_verification' && !['cancelled', 'rejected'].includes(o.status));
    return `<div class="grid g4">${kpi('cart', 'New orders', mine.filter(o => o.status === 'placed').length, 'accept or decline', mine.some(o => o.status === 'placed') ? 'warn' : '')}${kpi('clock', 'In progress', mine.filter(o => OO_TABS[1][2].includes(o.status)).length)}${kpi('shield', 'Payments to verify', unver.length, money(sum(unver, 'total')), unver.length ? 'warn' : 'teal')}${kpi('chart', 'Online sales (30 days)', money(sum(mine.filter(o => o.status === 'completed' && o.created_at >= addDays(-29)), 'total')), `${mine.filter(o => o.status === 'completed').length} completed`)}</div>
     <div style="margin-top:16px">${tabbar('ooTabs', OO_TABS.map(t => [t[0], t[1], t[0] === 'new' ? 'bolt' : t[0] === 'progress' ? 'clock' : t[0] === 'done' ? 'check' : 'x', mine.filter(o => t[2].includes(o.status)).length || '', t[0] === 'new']), tab, 'ooTab')}</div>
     <div class="ooGrid">${list.map(ooCard).join('') || `<div class="card" style="grid-column:1/-1">${emptyState('cart', tab === 'new' ? 'No new orders' : 'Nothing here', tab === 'new' ? 'New orders appear here with a sound. Share your shop link so customers can order.' : '')}</div>`}</div>`;
  },
  after: () => { ooSeen = (cache.online || []).filter(o => o.status === 'placed').length; }
};
function ooTab(t) { setTab('tab', t); }
function storeIntro() {
  return `<div class="card storeIntro"><div><h2>Sell online with DeepQr</h2><p class="muted">Your products, prices and live stock become a mobile shop. Customers order, choose pickup or delivery and pay at the shop or by mobile money — you verify the payment, prepare the goods and complete the sale at the till. Every completed order earns them loyalty points.</p>
   <ol class="steps2"><li>Turn on the online shop and choose pickup and/or delivery.</li><li>Add your M-Pesa / Tigo Pesa / bank numbers for payments.</li><li>Share your shop link on WhatsApp, Instagram and your receipts.</li></ol>
   ${isMgr() ? `<button class="btn primary lg" onclick="openStoreSettings()">${icon('store')}Open my online shop</button>` : '<p class="muted">Ask the owner or a manager to open the online shop.</p>'}</div><div class="phoneMock">${icon('store')}<b>${esc(business.name)}</b><small>Order online · Pickup · Delivery · Points</small></div></div>`;
}
function ooCard(o) {
  const items = ooItems(o.id), pay = PAY_LABEL[o.payment_status] || [o.payment_status, 'gray'];
  const age = Math.round((Date.now() - new Date(o.created_at)) / 60000);
  const next = { placed: ['accept', 'Accept order', 'check'], accepted: ['preparing', 'Start preparing', 'box'], preparing: o.fulfilment === 'delivery' ? ['out_for_delivery', 'Out for delivery', 'truck'] : ['ready', 'Ready for pickup', 'bell'], ready: null, out_for_delivery: null }[o.status];
  const open = !['completed', 'cancelled', 'rejected'].includes(o.status);
  return `<div class="card ooCard ${o.status === 'placed' ? 'hot' : ''}"><div class="cardHead" style="margin-bottom:6px"><div><h3><span class="mono">${esc(o.order_no)}</span> · ${esc(o.customer_name)}</h3><p>${o.status === 'placed' ? `<b class="warn">${age < 60 ? age + ' min ago' : ago(o.created_at)}</b>` : fmtDT(o.created_at)} · <a href="tel:${esc(o.customer_phone)}">${esc(o.customer_phone)}</a>${o.wanted_at ? ` · wants it: <b>${esc(o.wanted_at)}</b>` : ''}</p></div><div style="text-align:right"><b>${money(o.total)}</b><br><span class="tag ${o.fulfilment === 'delivery' ? 'info' : 'gray'}">${o.fulfilment === 'delivery' ? icon('truck') + 'Delivery' : icon('store') + 'Pickup'}</span></div></div>
   ${o.fulfilment === 'delivery' ? `<p class="ooAddr">${icon('store')} ${esc(o.delivery_address || '')}</p>` : ''}
   <div class="ooItems">${items.map(i => `<div><span>${num(i.qty)} × ${esc(i.name)}</span><b>${money(i.qty * i.price)}</b></div>`).join('')}${Number(o.delivery_fee) ? `<div><span>Delivery fee</span><b>${money(o.delivery_fee)}</b></div>` : ''}${o.points_redeem ? `<div class="ok"><span>${o.points_redeem} points used</span><b>− ${money(o.points_value)}</b></div>` : ''}</div>
   ${o.note ? `<p class="muted" style="font-size:13px;margin:8px 0 0">“${esc(o.note)}”</p>` : ''}
   <div class="ooPay"><span class="tag ${pay[1]}">${pay[0]}</span>${o.payment_method !== 'Pay on collection' ? `<span>${esc(o.payment_method)} · <b class="mono">${esc(o.payment_reference || '')}</b></span>` : ''}${o.payment_status === 'pending_verification' && open ? `<span class="actions" style="flex-wrap:nowrap"><button class="btn small success" onclick="ooAct('${o.id}','verify_payment',this)">${icon('check')}Payment received</button><button class="btn small ghost" onclick="ooAsk('${o.id}','reject_payment','Payment not found','Tell the customer what is wrong (e.g. no payment with this reference).')">Not found</button></span>` : ''}${o.payment_verified_by ? `<small class="muted">checked by ${esc(o.payment_verified_by)}</small>` : ''}</div>
   ${open ? `<div class="actions" style="margin-top:10px">${next ? `<button class="btn ${o.status === 'placed' ? 'primary' : ''}" onclick="ooAct('${o.id}','${next[0]}',this)">${icon(next[2])}${next[1]}</button>` : ''}${o.status !== 'placed' ? `<button class="btn primary" onclick="fulfilAtTill('${o.id}')">${icon('scan')}Complete at the till</button>` : ''}${o.status === 'placed' ? `<button class="btn ghost" onclick="ooAsk('${o.id}','reject','Decline this order?','Tell the customer why (e.g. out of stock, closed today).')">Decline</button>` : `<button class="btn ghost" onclick="ooAsk('${o.id}','cancel','Cancel this order?','Tell the customer why.')">Cancel</button>`}<a class="btn ghost" target="_blank" rel="noopener" href="https://wa.me/${phoneClean(o.customer_phone).replace(/^0/, '255').replace('+', '')}?text=${encodeURIComponent(`Habari ${o.customer_name}, ${business.name}: order ${o.order_no} — `)}">${icon('whatsapp')}</a></div>` : o.status === 'completed' ? `<p class="muted" style="margin:10px 0 0">${icon('check', 'ok')} Completed${o.points_earned ? ` · ${o.points_earned} points given` : ''}${o.sale_id ? ` · <button class="priceBtn" onclick="showReceiptById('${o.sale_id}')">receipt</button>` : ''}</p>` : `<p class="muted" style="margin:10px 0 0">${esc(o.staff_note || '')}</p>`}</div>`;
}
async function ooAct(id, action, btn, note) {
  await withBusy(btn, async () => {
    const r = await rpcToast('dq_online_order_action', { p: { id, action, note: note || null } }, { accept: 'Order accepted — the customer can see it', verify_payment: 'Payment marked as received', preparing: 'Preparing', ready: 'Customer told it is ready', out_for_delivery: 'Out for delivery', reject: 'Order declined', cancel: 'Order cancelled', reject_payment: 'Customer told the payment was not found' }[action]);
    if (r) { closeModal(); await loadOnlineOrders(); if (action === 'accept') { const { data } = await sb.from('customers').select('*').order('name'); cache.customers = data || cache.customers; } renderView(); }
  });
}
function ooAsk(id, action, title, text) { askBox(title, text, { label: 'Message to the customer', required: true, textarea: true }, 'Send', (v, b) => ooAct(id, action, b, v)); }
async function fulfilAtTill(id) {
  const o = cache.online.find(x => x.id === id); if (!o) return;
  if (o.payment_status === 'pending_verification') { toast('Verify the customer’s payment first', 'bad'); return; }
  const shopId = o.shop_id || posShopId();
  if (me.role !== 'cashier') posState.shopId = shopId;
  const { data: cu } = await sb.from('customers').select('*').eq('id', o.customer_id).maybeSingle();
  if (cu) { const c = customerById(cu.id); if (c) Object.assign(c, cu); else cache.customers.push(cu); }
  posState.cart = []; posState.discount = 0; posState.note = 'Online order ' + o.order_no;
  posState.customer = cu ? { id: cu.id, name: cu.name, phone: cu.phone, points: cu.points, balance: cu.balance, credit_limit: cu.credit_limit } : null;
  posState.points = o.points_redeem || 0;
  const pending = {};
  ooItems(id).forEach(i => {
    const p = productById(i.product_id); if (!p) return;
    if (itemsFor(p.id, shopId).length >= i.qty) pending[p.id] = (pending[p.id] || 0) + Number(i.qty);
    else posState.cart.push({ product_id: p.id, code: p.code, name: p.name, price: Number(i.price), base_price: Number(p.price), tax: Number(p.tax || 0), qty: Number(i.qty) });
  });
  posState.online = { id: o.id, no: o.order_no, pending, fee: Number(o.delivery_fee || 0), total: Number(o.total), paid: o.payment_status === 'paid' && o.payment_method !== 'Pay on collection', method: o.payment_method, reference: o.payment_reference || '', customer: o.customer_name };
  posSave(); go('pos');
  toast(Object.keys(pending).length ? 'Scan the QR label of each item, then take payment' : 'Check the items, then take payment');
}
function onlineBanner() {
  const on = posState.online; if (!on) return '';
  const left = Object.entries(on.pending).filter(([, q]) => q > 0);
  return `<div class="banner info onlineBanner">${icon('cart')}<div style="flex:1"><b>Completing online order ${esc(on.no)} for ${esc(on.customer)}</b><p>${left.length ? 'Scan the label of: ' + left.map(([pid, q]) => `<b>${esc(productById(pid)?.name || '')} × ${q}</b>`).join(', ') + ` · <button class="priceBtn" onclick="onlineAddUnscanned()">add without scanning</button>` : 'All items are in the cart.'} ${on.paid ? `· Paid by ${esc(on.method)} (${esc(on.reference)}) ✓` : '· Collect payment now'}${on.fee ? ` · delivery fee ${money(on.fee)}` : ''}</p></div><button class="btn small ghost" onclick="posState.online=null;posState.cart=[];posState.points=0;posState.customer=null;posSave();renderView()">${icon('x')}Stop</button></div>`;
}
function onlineAddUnscanned() {
  const on = posState.online;
  Object.entries(on.pending).forEach(([pid, q]) => { if (q > 0) { const p = productById(pid); const it = cache.onlineItems.find(i => i.order_id === on.id && i.product_id === pid); posState.cart.push({ product_id: p.id, code: p.code, name: p.name, price: Number(it?.price ?? p.price), base_price: Number(p.price), tax: Number(p.tax || 0), qty: q }); on.pending[pid] = 0; } });
  posSave(); renderView();
}
function openStoreSettings() {
  const b = business, accts = (b.store_payment_accounts || []).length ? b.store_payment_accounts : (b.payment_methods || []).filter(m => !/cash|card|credit/i.test(m.name || m)).slice(0, 2).map(m => ({ method: m.name || m, number: '', name: b.name }));
  window.__stAccts = JSON.parse(JSON.stringify(accts));
  const drawAcc = () => window.__stAccts.map((a, i) => `<div class="searchLine" style="margin:0 0 6px"><input class="input" style="max-width:150px" value="${esc(a.method || '')}" placeholder="M-Pesa" oninput="__stAccts[${i}].method=this.value"><input class="input mono" value="${esc(a.number || '')}" placeholder="Number / Lipa namba" oninput="__stAccts[${i}].number=this.value"><input class="input" value="${esc(a.name || '')}" placeholder="Account name" oninput="__stAccts[${i}].name=this.value"><button type="button" class="btn ghost" onclick="__stAccts.splice(${i},1);document.getElementById('stAccs').innerHTML=window.__stDraw()">${icon('trash')}</button></div>`).join('');
  window.__stDraw = drawAcc;
  modal(`<form id="stF"><div class="cardHead"><div><h3>${icon('store')} Online shop settings</h3><p>Products marked “Show in online shop” with a price appear automatically with live stock.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <label class="chk switchRow"><input type="checkbox" id="stOn" ${b.store_enabled ? 'checked' : ''}><span><b>Shop is open for online orders</b><br><small class="muted">Customers can find you under “Shop online”.</small></span></label>
   <div class="formGrid" style="margin-top:12px"><div class="field"><label>Shop link</label><div class="searchLine" style="margin:0"><span class="muted" style="align-self:center;font-size:12px">?shop=</span><input id="stSlug" class="mono" value="${esc(b.store_slug || b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}"></div></div><div class="field"><label>Short description</label><input id="stTag" value="${esc(b.store_tagline || '')}" placeholder="e.g. Fresh groceries & household goods"></div>
    <div class="field"><label>Orders are prepared at</label>${selectShops('stShop', b.store_shop_id || cache.shops.find(s => s.type === 'shop')?.id, { all: true })}</div><div class="field"><label>Area / town</label><input id="stArea" value="${esc(b.store_area || '')}" placeholder="e.g. Kariakoo, Dar es Salaam"></div><div class="field"><label>Opening hours</label><input id="stHrs" value="${esc(b.store_hours || '')}" placeholder="Mon–Sat 8:00–20:00"></div><div class="field"><label>Minimum order</label><input id="stMin" type="number" min="0" value="${Number(b.store_min_order || 0)}"></div></div>
   <h3 style="margin:16px 0 8px">Getting the goods</h3><div class="grid g2"><label class="chk"><input type="checkbox" id="stPick" ${b.store_pickup !== false ? 'checked' : ''}>Customers collect at the shop</label><label class="chk"><input type="checkbox" id="stDel" ${b.store_delivery ? 'checked' : ''}>We deliver</label></div>
   <div class="formGrid" style="margin-top:8px"><div class="field"><label>Delivery fee</label><input id="stFee" type="number" min="0" value="${Number(b.store_delivery_fee || 0)}"></div><div class="field"><label>Free delivery above</label><input id="stFree" type="number" min="0" value="${b.store_free_delivery_over ?? ''}" placeholder="optional"></div></div>
   <h3 style="margin:16px 0 8px">Payments</h3><label class="chk"><input type="checkbox" id="stPoc" ${b.store_pay_on_collection !== false ? 'checked' : ''}>Allow “pay at the shop / on delivery”</label>
   <p class="muted" style="font-size:12.5px;margin:6px 0">Mobile-money / bank numbers customers pay to. Every payment comes with its transaction reference; you confirm it on your statement before handing over the goods (a reference can only be used once).</p><div id="stAccs">${drawAcc()}</div><button type="button" class="btn small" onclick="__stAccts.push({method:'M-Pesa',number:'',name:''});document.getElementById('stAccs').innerHTML=window.__stDraw()">${icon('plus')}Add number</button>
   ${b.loyalty_enabled ? `<div class="field" style="margin-top:12px;max-width:320px"><label>Bonus points on a customer's first online order</label><input id="stFop" type="number" min="0" value="${Number(b.first_order_points || 0)}"></div>` : `<p class="muted" style="font-size:12.5px;margin-top:12px">${icon('gift')} Turn on loyalty points in Settings to reward online customers.</p>`}
   <div id="stErr" class="bad" style="min-height:20px;margin-top:8px"></div><div class="actions"><button class="btn primary lg">${icon('check')}Save shop</button></div></form>`, 'wide');
  document.getElementById('stF').onsubmit = async e => {
    e.preventDefault(); const v = x => document.getElementById(x)?.value, c = x => document.getElementById(x)?.checked;
    await withBusy(e.submitter, async () => {
      try {
        const r = await rpc('dq_store_settings', { p: { store_enabled: c('stOn'), store_slug: v('stSlug'), store_tagline: v('stTag'), store_shop_id: v('stShop'), store_area: v('stArea'), store_hours: v('stHrs'), store_min_order: Number(v('stMin') || 0), store_pickup: c('stPick'), store_delivery: c('stDel'), store_delivery_fee: Number(v('stFee') || 0), store_free_delivery_over: v('stFree'), store_pay_on_collection: c('stPoc'), store_payment_accounts: window.__stAccts.filter(a => (a.number || '').trim()), first_order_points: Number(v('stFop') || business.first_order_points || 0) } });
        business = { ...business, ...r }; closeModal(); toast(business.store_enabled ? 'Your online shop is open' : 'Online shop saved (closed)', 'ok'); onlineWatch(); render();
      } catch (x) { document.getElementById('stErr').textContent = errMsg(x); }
    });
  };
}

/* ---------------- payments centre ---------------- */
PAGES.payments = {
  title: 'Payments', sub: 'Every shilling in and out, with verification on both sides',
  render: () => {
    if (!cache.online) { loadOnlineOrders().then(() => view === 'payments' && renderView()); }
    const tab = viewParams.tab || 'verify';
    const unver = (cache.online || []).filter(o => o.payment_status === 'pending_verification' && !['cancelled', 'rejected'].includes(o.status));
    const supPays = cache.supplierPayments.filter(p => supplierById(p.supplier_id)?.supplier_account_id);
    const from = addDays(-29), sp = cache.sales.filter(s => s.date >= from);
    return `<div class="grid g4">${kpi('shield', 'To verify', unver.length, money(sum(unver, 'total')) + ' from online orders', unver.length ? 'warn' : 'teal')}${kpi('check', 'Supplier confirmations', supPays.filter(p => p.verification === 'confirmed').length + '/' + supPays.length, supPays.some(p => p.verification === 'disputed') ? `<span class="bad">${supPays.filter(p => p.verification === 'disputed').length} disputed</span>` : 'confirmed by suppliers')}${kpi('coins', 'Money in (30 days)', money(sum(sp, 'paid_total')), `${sp.length} receipts`)}${kpi('minus', 'Paid to suppliers (30 days)', money(sum(cache.supplierPayments.filter(p => p.paid_on >= from), 'amount')))}</div>
     <div style="margin-top:16px">${tabbar('payTabs', [['verify', 'To verify', 'shield', unver.length || '', true], ['suppliers', 'Supplier payments', 'truck'], ['methods', 'Money in by method', 'chart']], tab, 'payTab')}</div>
     ${tab === 'suppliers' ? `<div class="card"><p class="muted" style="margin-top:0">Suppliers on DeepQr confirm each payment you record. Disputed payments need a phone call before you pay again.</p><div class="tableWrap"><table><thead><tr><th>Date</th><th>Supplier</th><th>Order</th><th>Method</th><th>Reference</th><th class="right">Amount</th><th>Supplier says</th></tr></thead><tbody>${cache.supplierPayments.map(p => { const s = supplierById(p.supplier_id); return `<tr><td>${fmtD(p.paid_on)}</td><td>${esc(s?.name || '')}${s?.supplier_account_id ? ' <span class="tag info">DeepQr</span>' : ''}</td><td class="mono">${esc(cache.orders.find(o => o.id === p.order_id)?.order_no || '—')}</td><td>${esc(p.method)}</td><td class="mono">${esc(p.reference || '')}</td><td class="right num">${money(p.amount)}</td><td>${!s?.supplier_account_id ? '<span class="muted">not on DeepQr</span>' : p.verification === 'confirmed' ? '<span class="tag ok">Received ✓</span>' : p.verification === 'disputed' ? `<span class="tag bad">Not received</span><span class="sub">${esc(p.verify_note || '')}</span>` : '<span class="tag warn">Waiting</span>'}</td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">No supplier payments yet.</td></tr>'}</tbody></table></div></div>`
      : tab === 'methods' ? `<div class="card"><div class="cardHead"><div><h3>Last 30 days by payment method</h3><p>Match these with your M-Pesa, bank and cash records.</p></div><button class="btn small" onclick="go('reports',{tab:'payments'})">Full report</button></div>${hBars(Object.entries(groupBy(sp, s => s.payment)).map(([k, l]) => ({ m: k, v: sum(l, 'paid_total') })).sort((a, b) => b.v - a.v), 'm', 'v')}</div>`
      : `<div class="card"><p class="muted" style="margin-top:0">${icon('info')} Check each reference in your M-Pesa / bank statement. Only mark it received if the money is really there — DeepQr blocks the same reference from being used twice.</p>${unver.map(o => `<div class="row"><span><b>${money(o.total)}</b> · ${esc(o.customer_name)} <span class="mono muted">${esc(o.order_no)}</span><small class="muted" style="display:block">${esc(o.payment_method)} · reference <b class="mono">${esc(o.payment_reference)}</b> · ${ago(o.created_at)}</small></span><span class="actions" style="flex-wrap:nowrap"><button class="btn small success" onclick="ooAct('${o.id}','verify_payment',this)">${icon('check')}Received</button><button class="btn small ghost" onclick="ooAsk('${o.id}','reject_payment','Payment not found','Tell the customer what is wrong.')">Not found</button></span></div>`).join('') || emptyState('check', 'Nothing to verify', 'Mobile-money payments for online orders appear here until you confirm them.')}</div>`}`;
  }
};
function payTab(t) { setTab('tab', t); }

/* ---------------- supplier directory + invites ---------------- */
let sdQ = '', sdG = '';
async function openSupplierDirectory() {
  modal(`<div class="cardHead"><div><h3>${icon('search')} Find suppliers on DeepQr</h3><p>Order directly: they get your purchase order instantly, confirm quantities and prices, and dispatch with their invoice.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="toolbar"><input class="input grow" id="sdQ" value="${esc(sdQ)}" placeholder="Supplier, product or region…" onkeydown="if(event.key==='Enter'){sdQ=this.value;sdLoad()}"><select class="input" onchange="sdG=this.value;sdLoad()"><option value="">All groups</option>${REF.groups.map(g => `<option value="${g.code}" ${sdG === g.code ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select><button class="btn primary" onclick="sdQ=document.getElementById('sdQ').value;sdLoad()">${icon('search')}Search</button></div><div id="sdList"><div class="empty"><span class="spinner"></span></div></div>`, 'wide');
  sdLoad();
}
async function sdLoad() {
  const el = document.getElementById('sdList'); if (!el) return;
  const r = await rpcToast('dq_supplier_directory', { p: { q: sdQ, group: sdG } }); if (!r) return;
  window.__sd = r;
  el.innerHTML = r.map(s => { const resp = s.answered_orders ? Math.round((s.answered_orders - s.rejected_orders) / s.answered_orders * 100) : null; return `<div class="supCard"><div class="shopLogo">${esc(s.company_name.slice(0, 2).toUpperCase())}</div><div style="flex:1;min-width:0"><b>${esc(s.company_name)}</b> ${s.verified ? '<span class="tag ok">✔ Verified</span>' : ''}<small class="muted" style="display:block">${esc([s.region, (s.groups || []).map(groupName).join(', ')].filter(Boolean).join(' · '))}</small><p style="margin:4px 0;font-size:13px">${esc(s.description || '')}</p><div class="shopMeta"><span>${icon('tag')}${s.products} products</span><span>${icon('store')}${s.businesses} business(es)</span>${resp !== null ? `<span>${icon('check')}${resp}% orders fulfilled</span>` : ''}${s.payment_terms_days ? `<span>${icon('clock')}${s.payment_terms_days}-day terms</span>` : ''}</div></div><div class="actions" style="flex-direction:column;align-items:stretch">${s.my_supplier_id ? `<button class="btn small" onclick="closeModal();openOrderEditor(null,{supplier_id:'${s.my_supplier_id}'})">${icon('truck')}Order</button>` : `<button class="btn small primary" onclick="sdLink('${s.id}',this)">${icon('plus')}Add supplier</button>`}<button class="btn small ghost" onclick="sdPrices('${s.id}')">Price list</button></div></div>`; }).join('') || emptyState('search', 'No suppliers found', 'Try another search — or invite your own suppliers to DeepQr from the Suppliers tab.');
}
async function sdLink(id, btn) { await withBusy(btn, async () => { const r = await rpcToast('dq_link_supplier', { p_account: id }, 'Supplier added — you can order from them now'); if (r) { const i = cache.suppliers.findIndex(s => s.id === r.id); if (i >= 0) cache.suppliers[i] = r; else cache.suppliers.push(r); cache.suppliers.sort((a, b) => a.name.localeCompare(b.name)); sdLoad(); renderView(); } }); }
async function sdPrices(id) {
  const s = window.__sd.find(x => x.id === id);
  const { data } = await sb.from('supplier_products').select('*').eq('supplier_account_id', id).eq('available', true).order('name');
  modal(`<div class="cardHead"><div><h3>${esc(s.company_name)} — price list</h3><p>${esc(s.phone || '')} ${esc(s.email || '')} · delivers to ${esc(s.delivery_areas || s.region || '—')}</p></div><button class="btn ghost" onclick="openSupplierDirectory()">${icon('arrowRight')}Back</button></div>
   <div class="tableWrap"><table style="min-width:0"><thead><tr><th>Product</th><th>Unit</th><th class="right">Price</th><th class="right">Min. order</th><th class="right">Delivery</th><th>Your product</th></tr></thead><tbody>${(data || []).map(p => { const mine = cache.products.find(x => x.catalog_id && x.catalog_id === p.catalog_id); return `<tr><td><b>${esc(p.name)}</b><span class="sub">${esc(p.pack_size || '')}</span></td><td>${esc(p.unit_code)}</td><td class="right num">${money(p.price)}</td><td class="right num">${num(p.min_order_qty)}</td><td class="right">${p.lead_days} day(s)</td><td>${mine ? `<span class="tag ok">${esc(mine.code)}</span>${Number(mine.cost) && Number(p.price) < Number(mine.cost) ? ` <span class="tag ok">cheaper by ${money(mine.cost - p.price)}</span>` : ''}` : '<span class="muted">—</span>'}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">No products listed yet.</td></tr>'}</tbody></table></div>`, 'wide');
}
async function inviteSupplier(id) {
  const r = await rpcToast('dq_supplier_invite', { p_supplier_id: id }); if (!r) return;
  const link = `${location.origin}${location.pathname}?supplier_invite=${r.code}`;
  modal(`<div class="cardHead"><div><h3>Invite ${esc(r.supplier)} to DeepQr</h3><p>When they join with this link, your purchase orders reach them instantly and they can confirm, dispatch and confirm your payments. It is free for suppliers.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="payAcct"><div style="flex:1"><small class="muted">Invite link</small><div class="num" style="font-size:13px;word-break:break-all">${esc(link)}</div></div><button class="btn small" onclick="copyText('${jsq(link)}','Invite link copied')">${icon('copy')}Copy</button></div>
   <div class="actions" style="margin-top:12px">${r.phone ? `<a class="btn primary" target="_blank" rel="noopener" href="https://wa.me/${phoneClean(r.phone).replace(/^0/, '255').replace('+', '')}?text=${encodeURIComponent(`Habari, ${business.name} inatumia DeepQr kutuma oda (purchase orders). Jiunge bure hapa upokee oda zetu moja kwa moja: ${link}`)}">${icon('whatsapp')}Send on WhatsApp</a>` : ''}<button class="btn" onclick="closeModal()">Done</button></div>`, 'narrow');
}

/* ---------------- smart suggestions ---------------- */
let insights = null, insightsAt = 0;
async function loadInsights(force) { if (insights && !force && Date.now() - insightsAt < 300000) return insights; insights = await rpc('dq_insights'); insightsAt = Date.now(); return insights; }
function learnFactor(kind) { const f = insights?.feedback?.by_kind?.[kind]; if (!f) return 1; return Math.max(0.35, Math.min(1.8, (Number(f.done) + 1) / (Number(f.done) + Number(f.dismissed) + 2) * 2)); }
function buildSuggestions() {
  const d = insights; if (!d) return [];
  const out = [], hidden = new Set(d.feedback?.hidden || []);
  const add = (key, kind, prio, tone, ic, title, text, actions = '') => { if (!hidden.has(key)) out.push({ key, kind, score: prio * learnFactor(kind), tone, ic, title, text, actions }); };
  if (Number(d.days_of_data) < 14) add('learning', 'learning', 40, 'info', 'spark', 'DeepQr is still learning your business', `Suggestions are based on ${d.days_of_data || 0} day(s) of sales. They get sharper every day you sell through DeepQr — after about 2 weeks forecasts become reliable.`);
  (d.forecast || []).forEach(f => { const days = Number(f.days_left); add('reorder:' + f.id, 'reorder', days <= 3 ? 95 : days <= 7 ? 80 : 60, days <= 3 ? 'bad' : 'warn', 'truck', `${esc(f.name)} runs out in about ${num(Math.max(0, Math.round(days)))} day(s)`, `You sell about ${num(f.rate)} ${esc((f.unit || 'pcs').toLowerCase())} a day${f.trend === 'up' ? ' and demand is rising' : f.trend === 'down' ? ' (slowing down)' : ''}. ${num(f.stock)} left; expected sales next 7 days: ${num(f.next7)}. Order about <b>${num(f.suggest_qty)}</b> to cover 3 weeks.`, `<button class="btn small primary" onclick="sugReorder('${f.id}',${Number(f.suggest_qty)},'${f.supplier_id || ''}')">${icon('truck')}Create order</button>`); });
  (d.expiring || []).forEach(x => add('expiry:' + x.id, 'expiry', 85, 'warn', 'clock', `Sell ${num(x.items)} × ${esc(x.name)} before ${fmtD(x.first_expiry)}`, `${money(x.value)} of stock will expire soon. A <b>${x.discount_pct}% discount</b> now usually costs less than throwing it away.`, `<button class="btn small" onclick="go('expiry')">${icon('clock')}See items</button>`));
  (d.margins || []).forEach(x => add('margin:' + x.id, 'margin', Number(x.price) <= Number(x.cost) ? 88 : 55, Number(x.price) <= Number(x.cost) ? 'bad' : 'warn', 'tag', Number(x.price) <= Number(x.cost) ? `${esc(x.name)} sells below cost` : `${esc(x.name)} earns only ${x.margin}%`, `Cost ${money(x.cost)}, price ${money(x.price)}. Check the price or find a cheaper supplier.`, `<button class="btn small" onclick="openProduct('${jsq(x.code)}')">${icon('edit')}Edit price</button>${cache.suppliers.some(s => s.supplier_account_id) || true ? `<button class="btn small ghost" onclick="go('orders',{tab:'suppliers'});setTimeout(openSupplierDirectory,300)">Compare suppliers</button>` : ''}`));
  (d.slow || []).slice(0, 5).forEach(x => add('slow:' + x.id, 'slow', Math.min(70, 30 + Number(x.value) / 100000), 'info', 'layers', `${esc(x.name)} is not selling`, `${num(x.stock)} in stock (${money(x.value)} of your money) and no sales in 4 weeks${x.last_sold ? ' — last sold ' + fmtD(x.last_sold) : ''}. Try a promotion, move it to another shop, or stop reordering it.`, `<button class="btn small" onclick="go('transfers')">${icon('transfer')}Move stock</button>`));
  (d.pairs || []).slice(0, 3).forEach(x => add('pair:' + x.a_id + ':' + x.b_id, 'pair', 45, 'ok', 'spark', `Customers buy ${esc(x.a_name)} with ${esc(x.b_name)}`, `Bought together ${x.times} times recently. Place them side by side, suggest the second item at the till, or offer them as a bundle.`));
  (d.at_risk || []).slice(0, 4).forEach(c => add('risk:' + c.id, 'customer', 50 + Math.min(30, Number(c.spent) / 200000), 'info', 'users', `${esc(c.name)} has not been back for ${c.days_away} days`, `A loyal customer (${c.visits} visits, ${money(c.spent)} spent${c.points ? `, ${c.points} points waiting` : ''}). A friendly message brings many customers back.`, c.phone ? `<a class="btn small" target="_blank" rel="noopener" href="https://wa.me/${phoneClean(c.phone).replace(/^0/, '255').replace('+', '')}?text=${encodeURIComponent(`Habari ${c.name}, tunakukumbuka hapa ${business.name}!${c.points ? ` Una pointi ${c.points} — zitumie kwenye ununuzi ujao.` : ''} Karibu tena.`)}" onclick="sugFeedback('risk:${c.id}','customer','done')">${icon('whatsapp')}Send message</a>` : ''));
  if (d.debts && Number(d.debts.amount) > 0) add('debts', 'debt', 75, 'warn', 'coins', `${money(d.debts.amount)} owed for more than 30 days`, `${d.debts.count} customer(s) have old unpaid receipts. Old debts are the hardest to collect — follow up this week.`, `<button class="btn small" onclick="go('reports',{tab:'debts'})">${icon('alert')}See debtors</button>`);
  const hrs = (d.hours || []).filter(h => h.receipts > 0);
  if (hrs.length >= 4) { const best = hrs.slice().sort((a, b) => b.receipts - a.receipts)[0], low = hrs.slice().sort((a, b) => a.receipts - b.receipts)[0]; add('hours', 'staffing', 35, 'info', 'clock', `Your busiest time is ${pad(best.h)}:00–${pad(best.h + 1)}:00`, `About ${Math.round(best.receipts / Math.max(1, Math.min(56, Number(d.days_of_data))) * 7)} receipts a week at that hour. Have your best cashier and full shelves ready then; use quiet hours (around ${pad(low.h)}:00) for restocking and stock takes.`); }
  const wk = d.week || {}; if (Number(wk.last) > 0) { const ch = Math.round((Number(wk.this) - Number(wk.last)) / Number(wk.last) * 100); if (Math.abs(ch) >= 15) add('week:' + dateOnly().slice(0, 8), 'trend', 40, ch > 0 ? 'ok' : 'warn', 'chart', `Sales ${ch > 0 ? 'up' : 'down'} ${Math.abs(ch)}% this week`, `${money(wk.this)} in the last 7 days vs ${money(wk.last)} the week before.${ch < 0 ? ' Check for out-of-stock best sellers and slow hours.' : ' Make sure your best sellers stay in stock.'}`, `<button class="btn small" onclick="go('reports')">${icon('chart')}Reports</button>`); }
  return out.sort((a, b) => b.score - a.score);
}
function suggestionCard(s) { return `<div class="sugCard ${s.tone}" id="sug_${s.key.replace(/[^A-Za-z0-9]/g, '_')}"><span class="sugIco">${icon(s.ic)}</span><div style="flex:1;min-width:0"><b>${s.title}</b><p>${s.text}</p><div class="actions">${s.actions}<button class="btn small ghost" onclick="sugFeedback('${jsq(s.key)}','${s.kind}','done')" title="I did this">${icon('check')}Done</button><button class="btn small ghost" onclick="sugFeedback('${jsq(s.key)}','${s.kind}','dismiss')" title="Not useful">${icon('x')}</button></div></div></div>`; }
async function sugFeedback(key, kind, action) {
  document.getElementById('sug_' + key.replace(/[^A-Za-z0-9]/g, '_'))?.remove();
  await sb.rpc('dq_insight_feedback', { p_key: key, p_kind: kind, p_action: action });
  if (insights) { insights.feedback.hidden = [...(insights.feedback.hidden || []), key]; const f = insights.feedback.by_kind[kind] = insights.feedback.by_kind[kind] || { done: 0, dismissed: 0 }; if (action === 'dismiss') f.dismissed++; else f.done++; }
  toast(action === 'dismiss' ? 'Got it — DeepQr will show fewer suggestions like this' : 'Nice work!', 'ok');
}
function sugReorder(pid, qty, supplierId) { const p = productById(pid); openOrderEditor(null, { supplier_id: supplierId || p?.supplier_id || '', items: [{ product_id: pid, qty_ordered: Math.max(1, Math.ceil(qty)), unit_cost: Number(p?.cost || 0) }] }); sugFeedback('reorder:' + pid, 'reorder', 'done'); }
PAGES.insights = {
  title: 'Smart suggestions', sub: 'DeepQr studies your own sales, stock and customers and tells you what to do next. It learns from what you mark as done or not useful.',
  actions: () => `<button class="btn" onclick="loadInsights(true).then(renderView)">${icon('refund')}Refresh</button>`,
  render: () => {
    if (!insights) { loadInsights().then(() => view === 'insights' && renderView()).catch(e => toast(errMsg(e), 'bad')); return `<div class="card"><div class="empty"><span class="spinner"></span> Analysing your business…</div></div>`; }
    const s = buildSuggestions(), d = insights;
    const days = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return `<div class="grid g4">${kpi('spark', 'Suggestions', s.length, 'ranked by impact and your feedback')}${kpi('chart', 'This week', money(d.week?.this), Number(d.week?.last) ? `last week ${money(d.week.last)}` : '')}${kpi('truck', 'Running low soon', (d.forecast || []).filter(f => Number(f.days_left) <= 7).length, 'within 7 days', (d.forecast || []).some(f => Number(f.days_left) <= 3) ? 'bad' : '')}${kpi('history', 'Learning from', `${d.days_of_data || 0} day${Number(d.days_of_data) === 1 ? '' : 's'}`, 'of your sales')}</div>
     <div class="grid g2" style="margin-top:16px;align-items:start"><div>${s.map(suggestionCard).join('') || `<div class="card">${emptyState('check', 'All good for now', 'No urgent suggestions. DeepQr checks again every time you open this page.')}</div>`}</div>
      <div><div class="card"><div class="cardHead"><div><h3>Stock forecast</h3><p>Expected sales from your last 4 weeks (recent days count more).</p></div></div><div class="tableWrap"><table style="min-width:0"><thead><tr><th>Product</th><th class="right">Per day</th><th class="right">Next 7 days</th><th class="right">In stock</th><th class="right">Days left</th></tr></thead><tbody>${(d.forecast || []).slice(0, 12).map(f => `<tr><td>${esc(f.name)} ${f.trend === 'up' ? '<span class="ok">▲</span>' : f.trend === 'down' ? '<span class="bad">▼</span>' : ''}</td><td class="right num">${num(f.rate)}</td><td class="right num">${num(f.next7)}</td><td class="right num">${num(f.stock)}</td><td class="right num ${Number(f.days_left) <= 3 ? 'bad' : 'warn'}"><b>${num(Math.round(f.days_left))}</b></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing is about to run out.</td></tr>'}</tbody></table></div></div>
       <div class="card"><div class="cardHead"><div><h3>Best days</h3><p>Average sales per day of the week</p></div></div>${hBars((d.weekdays || []).map(w => ({ d: days[w.dow], v: w.avg_day })), 'd', 'v')}</div>
       <div class="card"><div class="cardHead"><div><h3>Top products (4 weeks)</h3></div></div>${hBars(d.top || [], 'name', 'revenue')}</div></div></div>`;
  }
};

/* ---------------- getting started guide (dashboard) ---------------- */
function gettingStarted() {
  if (!isMgr() || lsGet('dq_gs_hide_' + business.id) === '1') return '';
  const steps = [
    ['Choose what you sell', (business.business_groups || []).length > 0, "openBusinessType()", 'store'],
    ['Add products (from the catalogue)', cache.products.length > 0, "go('catalog')", 'box'],
    ['Receive stock', cache.purchases.length > 0 || Object.values(cache.stock).some(s => Object.values(s).some(q => q > 0)), "go('inventory',{tab:'stockin'})", 'truck'],
    ['Print QR labels', cache.generations.length > 0, "go('qr')", 'qr'],
    ['Test your scanner', lsGet('dq_scan_tested') === '1' || Scanner.log.length > 0, "go('devices',{tab:'test'})", 'scan'],
    ['Make your first sale', cache.sales.length > 0, "go('pos')", 'cart'],
    ['Add a cashier', cache.members.length > 1, "go('users')", 'users'],
    ['Open your online shop', !!business.store_enabled, "go('online')", 'phone']
  ];
  const done = steps.filter(s => s[1]).length; if (done === steps.length) return '';
  const nextI = steps.findIndex(s => !s[1]);
  return `<div class="card gsCard"><div class="cardHead"><div><h3>${icon('spark')} Getting started — ${done}/${steps.length}</h3><p>Follow these steps and DeepQr is ready to run your business.</p></div><button class="btn small ghost" onclick="lsSet('dq_gs_hide_${business.id}','1');renderView()">Hide</button></div>${progressBar(done, steps.length)}
   <div class="gsSteps">${steps.map((s, i) => `<button class="gsStep ${s[1] ? 'done' : ''} ${i === nextI ? 'next' : ''}" onclick="${s[2]}">${icon(s[1] ? 'check' : s[3])}<span>${s[0]}</span></button>`).join('')}</div></div>`;
}
