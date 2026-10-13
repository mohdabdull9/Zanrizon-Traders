/* =============================================================================
   v4 portals outside a business workspace:
     * public pages (no login): online shop directory, a shop, label verification
     * shopper portal: basket, checkout with pickup/delivery, payment proof, points
     * supplier portal: orders from businesses, price list, payments, profile
   ============================================================================= */
let pub = null;               // { view, params } when a public / shopper page is shown
let supplierAcc = null, customerAcc = null, adminRole = null, supData = null;
const PUBLIC_VIEWS = ['shops', 'store', 'verify', 'c_home'];
function inPublic() { return !!pub || (!!customerAcc && !me && !isAdmin && !supplierAcc); }
function shopperEmail(phone) { let d = String(phone || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '255' + d.slice(1); return `c${d}@shoppers.deepqr.local`; }
function looksLikePhone(v) { return /^[+0-9][0-9 ()-]{8,}$/.test(String(v || '').trim()) && String(v).replace(/\D/g, '').length >= 9; }
function pubUrl(v, params = {}) {
  const base = location.pathname;
  if (v === 'store') return `${base}?shop=${encodeURIComponent(params.slug)}`;
  if (v === 'shops') return `${base}?shops`;
  if (v === 'c_home') return `${base}?me`;
  if (v === 'verify') return `${base}?dq=${encodeURIComponent(params.code || '')}`;
  return base;
}
function goPublic(v, params = {}) {
  pub = { view: v, params }; view = v; viewParams = params; search = '';
  try { history.replaceState(null, '', pubUrl(v, params)); } catch (e) {}
  render(); window.scrollTo(0, 0);
}
function leavePublic() { pub = null; try { history.replaceState(null, '', location.pathname); } catch (e) {} if (me) go(me.role === 'cashier' ? 'pos' : 'dashboard'); else if (supplierAcc) go('sup_home'); else if (isAdmin) go('portal'); else { view = 'login'; render(); } }
function readPublicRoute() {
  const u = new URLSearchParams(location.search);
  if (u.get('dq')) return { view: 'verify', params: { code: location.href } };
  if (u.get('shop')) return { view: 'store', params: { slug: u.get('shop') } };
  if (u.has('shops')) return { view: 'shops', params: {} };
  if (u.has('me')) return { view: 'c_home', params: {} };
  return null;
}
function publicLayout() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const n = basketCount();
  return `<div class="pubApp"><header class="pubTop"><button class="pubBrand" onclick="goPublic('shops')">${logoMark(32)}${wordmark()}<span class="pubTag">Shop</span></button>
   <nav class="pubNav"><button class="${view === 'shops' ? 'active' : ''}" onclick="goPublic('shops')">${icon('store')}<span>Shops</span></button>
    ${customerAcc ? `<button class="${view === 'c_home' ? 'active' : ''}" onclick="goPublic('c_home')">${icon('gift')}<span>My orders &amp; points</span></button>` : ''}
    ${pub?.view === 'store' || view === 'store' ? `<button class="basketBtn" onclick="openBasket()">${icon('cart')}<span>Basket</span>${n ? `<b>${n}</b>` : ''}</button>` : ''}
    <button class="iconBtn" onclick="toggleTheme()" aria-label="Dark mode">${icon(dark ? 'sun' : 'moon')}</button>
    ${customerAcc ? `<button class="btn small ghost" onclick="logout()">${icon('logout')}<span class="hideSm">Sign out</span></button>`
      : (me || isAdmin || supplierAcc) ? `<button class="btn small" onclick="leavePublic()">${icon('dashboard')}<span class="hideSm">Back to my DeepQr</span></button>`
      : `<button class="btn small primary" onclick="shopperAuth()">${icon('user')}<span class="pubSignIn">Sign in</span></button>`}</nav></header>
   <main class="pubMain"><section class="content" id="content"></section></main>
   <footer class="pubFoot">${logoMark(20)} DeepQr · smart QR shopping · <button class="priceBtn" onclick="leaveToBusiness()">For businesses &amp; suppliers</button></footer></div>`;
}
function leaveToBusiness() { pub = null; try { history.replaceState(null, '', location.pathname); } catch (e) {} if (!session) { view = 'login'; authMode = 'login'; } render(); }

/* ---------------- public: label verification ---------------- */
PAGES.verify = {
  title: 'Check a DeepQr label', sub: 'Every DeepQr label is unique. Scan it with any phone camera to see if it is genuine.',
  render: () => {
    const code = viewParams.code || '';
    if (!viewParams.result) { sb.rpc('dq_verify_label', { p_code: code }).then(({ data, error }) => { viewParams.result = error ? { found: false, reason: errMsg(error) } : data; if (view === 'verify') renderView(); }); return `<div class="card"><div class="empty"><span class="spinner"></span> Checking the label…</div></div>`; }
    const r = viewParams.result;
    if (!r.found) return `<div class="verifyCard bad">${icon('alert')}<div><h2>Not a known DeepQr label</h2><p>${r.reason === 'UNKNOWN_SERIAL' ? `This serial is not registered by ${esc(r.business || 'the business')}. The label may be fake — ask the seller.` : r.reason === 'UNKNOWN_BUSINESS' ? 'The business on this label is not registered on DeepQr.' : 'This code was not made by DeepQr.'}</p></div></div>${verifyScanBox()}`;
    const st = { in_stock: ['Genuine — available', 'ok', 'check', 'This item is registered and has not been sold yet.'], sold: ['Genuine — sold', 'info', 'receipt', `Sold on ${fmtD(r.sold_on)}. If someone offers it to you as new, ask for the receipt.`], void: ['Cancelled label', 'bad', 'ban', 'The business cancelled this label. Do not accept it as proof of purchase.'], transit: ['Genuine — being moved', 'info', 'transfer', 'This item is being moved between the business’s locations.'] }[r.status] || ['Genuine', 'ok', 'check', ''];
    const exp = r.expired ? `<div class="banner bad">${icon('clock')}<div><b>Expired on ${fmtD(r.expiry_date)}</b><p>Do not use or sell this item.</p></div></div>` : r.expiry_date ? `<p class="muted">Use before <b>${fmtD(r.expiry_date)}</b></p>` : '';
    return `<div class="verifyCard ${st[1]}">${icon(st[2])}<div><small>DeepQr label check</small><h2>${st[0]}</h2><p>${st[3]}</p></div></div>
     <div class="card"><div class="verifyGrid"><div><small class="muted">PRODUCT</small><h3 style="margin:2px 0 4px">${esc(r.product)}</h3><p class="muted" style="margin:0">${esc([r.brand, r.pack_size, r.unit].filter(Boolean).join(' · '))}</p>${r.price != null ? `<p style="margin:8px 0 0"><b>${money(r.price)}</b> at this shop</p>` : ''}${exp}</div>
      <dl class="kv"><dt>Seller</dt><dd>${esc(r.business)}${r.business_phone ? ` · <a href="tel:${esc(r.business_phone)}">${esc(r.business_phone)}</a>` : ''}</dd><dt>Serial</dt><dd class="mono">${esc(r.serial)}</dd><dt>Location</dt><dd>${esc(r.shop || '')}</dd><dt>Labelled</dt><dd>${fmtD(r.printed)}</dd></dl></div>
      <div class="actions" style="margin-top:14px">${r.store_slug ? `<button class="btn primary" onclick="goPublic('store',{slug:'${jsq(r.store_slug)}'})">${icon('store')}Visit ${esc(r.business)} online</button>` : ''}${me && r.status === 'in_stock' && r.business_code === business?.code ? `<button class="btn" onclick="sellScanned('${jsq(viewParams.code)}')">${icon('cart')}Sell this item</button>` : ''}</div></div>${verifyScanBox()}`;
  }
};
function verifyScanBox() { return `<div class="card"><form class="searchLine" onsubmit="event.preventDefault();goPublic('verify',{code:document.getElementById('vfIn').value})" style="margin:0"><input class="input mono" id="vfIn" placeholder="Type a serial or paste a label link"><button class="btn">${icon('search')}Check</button></form></div>`; }
function sellScanned(code) { pub = null; try { history.replaceState(null, '', location.pathname); } catch (e) {} go('pos'); setTimeout(() => Scanner.emit(code, 'link'), 400); }

/* ---------------- public: shops directory ---------------- */
let shopsQ = '', shopsG = '';
PAGES.shops = {
  title: 'Shop online', sub: 'Order from shops near you. Collect at the shop or get it delivered — and earn points every time.',
  render: () => {
    if (!viewParams.list) { sb.rpc('dq_store_directory', { p: { q: shopsQ, group: shopsG } }).then(({ data }) => { viewParams.list = data || []; if (view === 'shops') renderView(); }); return `<div class="card"><div class="empty"><span class="spinner"></span> Finding shops…</div></div>`; }
    const l = viewParams.list;
    return `<div class="card"><div class="toolbar" style="margin:0"><input class="input grow" id="shQ" value="${esc(shopsQ)}" placeholder="Search a shop or area, e.g. Kariakoo" onkeydown="if(event.key==='Enter'){shopsQ=this.value;viewParams.list=null;renderView()}"><button class="btn primary" onclick="shopsQ=document.getElementById('shQ').value;viewParams.list=null;renderView()">${icon('search')}Search</button></div>
     <div class="pillRow" style="margin:12px 0 0"><button class="pill ${!shopsG ? 'active' : ''}" onclick="shopsG='';viewParams.list=null;renderView()">All</button>${REF.groups.map(g => `<button class="pill ${shopsG === g.code ? 'active' : ''}" onclick="shopsG='${g.code}';viewParams.list=null;renderView()">${esc(g.name)}</button>`).join('')}</div></div>
     <div class="shopGrid">${l.map(s => `<button class="shopCard" onclick="goPublic('store',{slug:'${jsq(s.slug)}'})"><div class="shopLogo">${esc((s.name || 'S').slice(0, 2).toUpperCase())}</div><div><b>${esc(s.name)}</b><small>${esc(s.tagline || (s.groups || []).map(groupName).join(' · '))}</small><div class="shopMeta">${s.area ? `<span>${icon('store')}${esc(s.area)}</span>` : ''}<span>${icon('box')}${s.products} products</span>${s.delivery ? `<span>${icon('truck')}Delivery</span>` : ''}${s.pickup ? `<span>${icon('check')}Pickup</span>` : ''}${s.loyalty ? `<span class="ok">${icon('gift')}Points</span>` : ''}</div></div></button>`).join('') || `<div class="card" style="grid-column:1/-1">${emptyState('store', 'No shops found', 'Try another search. Shops appear here when they open their DeepQr online shop.')}</div>`}</div>`;
  }
};

/* ---------------- public: one shop + basket ---------------- */
let storeData = null, storeCat = '', storeQ = '';
function basketKey(slug) { return 'dq_basket_' + (slug || viewParams.slug || pub?.params?.slug || ''); }
function basket(slug) { return lsJson(basketKey(slug), []); }
function saveBasket(b, slug) { lsSet(basketKey(slug), JSON.stringify(b)); }
function basketCount() { return sum(basket(), 'qty'); }
PAGES.store = {
  title: 'Shop', sub: '', noHead: true,
  render: () => {
    const slug = viewParams.slug;
    if (!storeData || storeData.store.slug !== slug) {
      sb.rpc('dq_store_catalog', { p_slug: slug }).then(({ data, error }) => { if (error) { storeData = { error: errMsg(error), store: { slug } }; } else storeData = data; if (view === 'store') renderView(); });
      return `<div class="card"><div class="empty"><span class="spinner"></span> Opening the shop…</div></div>`;
    }
    if (storeData.error) return `<div class="card">${emptyState('store', 'This shop is not open online', esc(storeData.error), `<button class="btn primary" onclick="goPublic('shops')">See other shops</button>`)}</div>`;
    const s = storeData.store, cur2 = s.currency;
    document.title = s.name + ' · DeepQr';
    let list = storeData.products;
    const cats = [...new Set(list.map(p => p.category || 'Other'))].sort();
    if (storeCat) list = list.filter(p => (p.category || 'Other') === storeCat);
    if (storeQ) { const q = storeQ.toLowerCase(); list = list.filter(p => (p.name + ' ' + (p.brand || '') + ' ' + (p.category || '')).toLowerCase().includes(q)); }
    const b = basket(slug);
    const inB = id => b.find(x => x.id === id)?.qty || 0;
    return `<div class="storeHero"><div class="shopLogo lg">${esc(s.name.slice(0, 2).toUpperCase())}</div><div style="flex:1;min-width:0"><h1>${esc(s.name)}</h1><p>${esc(s.tagline || '')}</p>
       <div class="shopMeta">${s.area ? `<span>${icon('store')}${esc(s.area)}</span>` : ''}${s.hours ? `<span>${icon('clock')}${esc(s.hours)}</span>` : ''}${s.pickup ? `<span>${icon('check')}Pickup${s.pickup_shop ? ' at ' + esc(s.pickup_shop) : ''}</span>` : ''}${s.delivery ? `<span>${icon('truck')}Delivery ${Number(s.delivery_fee) ? money(s.delivery_fee, cur2) : 'free'}${s.free_delivery_over ? ` · free over ${money(s.free_delivery_over, cur2)}` : ''}</span>` : ''}${Number(s.min_order) ? `<span>Min. order ${money(s.min_order, cur2)}</span>` : ''}</div></div>
       ${s.loyalty ? `<div class="pointsBadge">${icon('gift')}<div><b>${storeData.me ? num(storeData.me.points) + ' points' : 'Earn points'}</b><small>${storeData.me ? 'worth ' + money(storeData.me.points * s.point_value, cur2) : `1 point per ${money(s.points_per_amount, cur2)}${s.first_order_points ? ` · +${s.first_order_points} on your first online order` : ''}`}</small></div></div>` : ''}</div>
     <div class="card"><div class="toolbar" style="margin:0"><input class="input grow" id="stQ" value="${esc(storeQ)}" placeholder="Search products…" oninput="storeQ=this.value;const p=this.selectionStart;renderView();const e=document.getElementById('stQ');e.focus();e.setSelectionRange(p,p)"></div>
      <div class="pillRow" style="margin:12px 0 0"><button class="pill ${!storeCat ? 'active' : ''}" onclick="storeCat='';renderView()">All</button>${cats.map(c => `<button class="pill ${storeCat === c ? 'active' : ''}" onclick="storeCat='${jsq(c)}';renderView()">${esc(c)}</button>`).join('')}</div></div>
     <div class="prodCards">${list.map(p => { const q = inB(p.id), out = Number(p.stock) <= 0, few = !out && Number(p.stock) <= 5; return `<div class="prodCard ${out ? 'out' : ''}"><div class="pcTop">${groupDot(p.group_code)}<small>${esc(p.category || '')}</small>${out ? '<span class="tag gray">Sold out</span>' : few ? `<span class="tag warn">Only ${num(p.stock)} left</span>` : '<span class="tag ok">In stock</span>'}</div>
        <b class="pcName">${esc(p.name)}</b><small class="muted">${esc([p.pack_size, p.unit].filter(Boolean).join(' · '))}</small><div class="pcPrice">${money(p.price, cur2)}</div>
        ${out ? '' : q ? `<div class="qtyBox"><button onclick="basketAdd('${p.id}',-1)" aria-label="Less">−</button><input value="${q}" readonly aria-label="Quantity"><button onclick="basketAdd('${p.id}',1)" aria-label="More">+</button></div>` : `<button class="btn primary wide" onclick="basketAdd('${p.id}',1)">${icon('plus')}Add</button>`}</div>`; }).join('') || `<div class="card" style="grid-column:1/-1">${emptyState('search', 'Nothing here', 'Try another search or category.')}</div>`}</div>
     ${b.length ? `<button class="basketBar" onclick="openBasket()"><span>${icon('cart')} ${basketCount()} item(s) in your basket</span><b>${money(basketTotal(), cur2)} · Checkout ${icon('arrowRight')}</b></button>` : ''}`;
  }
};
function basketTotal() { return sum(basket(), x => x.qty * (storeData?.products.find(p => p.id === x.id)?.price || 0)); }
function basketAdd(id, d) {
  const b = basket(), p = storeData.products.find(x => x.id === id); let l = b.find(x => x.id === id);
  if (!l) { l = { id, qty: 0 }; b.push(l); }
  l.qty = Math.max(0, l.qty + d);
  if (l.qty > Number(p.stock)) { l.qty = Number(p.stock); toast(`Only ${num(p.stock)} ${p.name} available`, 'bad'); }
  saveBasket(b.filter(x => x.qty > 0)); renderView();
  const top = document.querySelector('.basketBtn'); if (top) top.outerHTML = `<button class="basketBtn" onclick="openBasket()">${icon('cart')}<span>Basket</span>${basketCount() ? `<b>${basketCount()}</b>` : ''}</button>`;
}
let coState = null;
function openBasket() {
  if (!storeData || storeData.error) return;
  const s = storeData.store, b = basket(), cur2 = s.currency;
  if (!b.length) { toast('Your basket is empty'); return; }
  coState = coState && coState.slug === s.slug ? coState : { slug: s.slug, fulfilment: s.pickup ? 'pickup' : 'delivery', method: s.pay_on_collection ? 'Pay on collection' : (s.payment_accounts[0]?.method || 'M-Pesa'), points: 0, address: customerAcc?.address || '', ref: '', note: '' };
  drawCheckout();
}
function coTotals() {
  const s = storeData.store, sub = basketTotal();
  const fee = coState.fulfilment === 'delivery' ? (s.free_delivery_over && sub >= Number(s.free_delivery_over) ? 0 : Number(s.delivery_fee || 0)) : 0;
  const pv = Math.min(Math.round(Number(coState.points || 0) * Number(s.point_value || 0) * 100) / 100, sub);
  return { sub, fee, pv, total: Math.max(0, Math.round((sub + fee - pv) * 100) / 100) };
}
function drawCheckout() {
  const s = storeData.store, cur2 = s.currency, b = basket(), t = coTotals(), pts = storeData.me?.points || 0;
  const methods = [...(s.pay_on_collection ? ['Pay on collection'] : []), ...new Set((s.payment_accounts || []).map(a => a.method).filter(Boolean))];
  const acct = (s.payment_accounts || []).filter(a => a.method === coState.method);
  modal(`<div class="cardHead"><div><h3>${icon('cart')} Your order at ${esc(s.name)}</h3><p>Check your basket, choose how to get it and how to pay.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="coLines">${b.map(x => { const p = storeData.products.find(y => y.id === x.id); if (!p) return ''; return `<div class="row"><span><b>${esc(p.name)}</b><small class="muted"> × ${x.qty}</small></span><span class="actions" style="flex-wrap:nowrap"><b class="num">${money(x.qty * p.price, cur2)}</b><button class="btn small ghost" onclick="basketAdd('${p.id}',-${x.qty});openBasket()" aria-label="Remove">${icon('trash')}</button></span></div>`; }).join('')}</div>
   <h3 style="margin:16px 0 8px">1. How do you want it?</h3><div class="seg big">${s.pickup ? `<button class="${coState.fulfilment === 'pickup' ? 'active' : ''}" onclick="coState.fulfilment='pickup';drawCheckout()">${icon('store')}Collect at the shop</button>` : ''}${s.delivery ? `<button class="${coState.fulfilment === 'delivery' ? 'active' : ''}" onclick="coState.fulfilment='delivery';drawCheckout()">${icon('truck')}Deliver to me${Number(s.delivery_fee) ? ' · ' + money(s.delivery_fee, cur2) : ''}</button>` : ''}</div>
   ${coState.fulfilment === 'delivery' ? `<div class="field" style="margin-top:10px"><label for="coA">Delivery address *</label><input id="coA" value="${esc(coState.address)}" placeholder="Street, area, landmark" oninput="coState.address=this.value"></div>` : `<p class="muted" style="font-size:13px;margin:8px 0 0">Collect at ${esc(s.pickup_shop || s.name)}${s.address ? ', ' + esc(s.address) : ''}. The shop tells you when it is ready.</p>`}
   <div class="field" style="margin-top:10px"><label for="coW">When do you want it? (optional)</label><input id="coW" value="${esc(coState.wanted || '')}" placeholder="e.g. Today after 5 pm" oninput="coState.wanted=this.value"></div>
   <h3 style="margin:16px 0 8px">2. How will you pay?</h3><div class="seg big wrap">${methods.map(m => `<button class="${coState.method === m ? 'active' : ''}" onclick="coState.method='${jsq(m)}';drawCheckout()">${icon(m === 'Pay on collection' ? 'coins' : 'phone')}${esc(m === 'Pay on collection' ? (coState.fulfilment === 'delivery' ? 'Pay on delivery' : 'Pay at the shop') : m)}</button>`).join('')}</div>
   ${coState.method !== 'Pay on collection' ? `<div class="payBox">${acct.map(a => `<div class="payAcct">${icon('phone')}<div style="flex:1"><small class="muted">${esc(a.method)}${a.name ? ' · ' + esc(a.name) : ''}</small><div class="num">${esc(a.number)}</div></div><button class="btn small" onclick="copyText('${jsq(a.number)}','Number copied')">${icon('copy')}Copy</button></div>`).join('')}
     <ol class="steps2"><li>Send <b>${money(t.total, cur2)}</b> to the number above.</li><li>Type the transaction reference from the confirmation SMS.</li><li>The shop checks the payment and starts your order.</li></ol>
     <div class="field"><label for="coR">Transaction reference *</label><input id="coR" class="mono" value="${esc(coState.ref)}" placeholder="e.g. QK72HT91XZ" oninput="coState.ref=this.value" style="text-transform:uppercase"></div></div>` : ''}
   ${s.loyalty && pts >= Number(s.min_redeem_points || 0) && pts > 0 ? `<div class="row" style="margin-top:12px"><span>${icon('gift')} Use your points <small class="muted">(${num(pts)} available, worth ${money(pts * s.point_value, cur2)})</small></span><span class="actions"><input class="input" type="number" min="0" max="${pts}" value="${coState.points || ''}" placeholder="Points" style="width:110px" oninput="coState.points=Math.min(${pts},Math.max(0,Number(this.value)||0));document.getElementById('coSum').innerHTML=coSumHtml()"></span></div>` : s.loyalty ? `<p class="muted" style="font-size:12.5px;margin-top:10px">${icon('gift')} You will earn about <b>${num(Math.floor(t.total / Math.max(Number(s.points_per_amount || 1000), 1)))}</b> points with this order.</p>` : ''}
   <div class="field" style="margin-top:10px"><label for="coN">Note to the shop</label><input id="coN" value="${esc(coState.note)}" oninput="coState.note=this.value"></div>
   <div class="totals" id="coSum">${coSumHtml()}</div>
   <div id="coErr" class="bad" style="min-height:20px;margin-top:8px"></div>
   <div class="actions"><button class="btn primary lg wide" onclick="placeOrder(this)">${icon('check')}${customerAcc ? 'Place order' : 'Sign in & place order'}</button></div>`);
}
function coSumHtml() { const s = storeData.store, t = coTotals(), c = s.currency; return `<div class="row"><span>Products</span><b>${money(t.sub, c)}</b></div>${t.fee ? `<div class="row"><span>Delivery</span><b>${money(t.fee, c)}</b></div>` : ''}${t.pv ? `<div class="row ok"><span>Points</span><b>− ${money(t.pv, c)}</b></div>` : ''}<div class="row grand"><span>Total</span><span>${money(t.total, c)}</span></div>`; }
async function placeOrder(btn) {
  const err = document.getElementById('coErr'); err.textContent = '';
  if (!customerAcc) { closeModal(); shopperAuth(() => openBasket()); return; }
  const s = storeData.store;
  if (coState.fulfilment === 'delivery' && !coState.address.trim()) { err.textContent = 'Enter the delivery address.'; return; }
  if (coState.method !== 'Pay on collection' && coState.ref.trim().length < 4) { err.textContent = 'Enter the transaction reference from your payment message.'; return; }
  if (coTotals().sub < Number(s.min_order || 0)) { err.textContent = `The minimum order is ${money(s.min_order, s.currency)}.`; return; }
  await withBusy(btn, async () => {
    try {
      const o = await rpc('dq_place_online_order', { p: { slug: s.slug, fulfilment: coState.fulfilment, delivery_address: coState.address, payment_method: coState.method, payment_reference: coState.ref, points_redeem: coState.points || 0, note: coState.note, wanted_at: coState.wanted, items: basket().map(x => ({ product_id: x.id, qty: x.qty })) } });
      saveBasket([]); coState = null; storeData = null; closeModal(); beep(true);
      goPublic('c_home', { tab: 'orders', placed: o.order_no });
    } catch (x) { err.textContent = errMsg(x); }
  });
}

/* ---------------- shopper sign in / register ---------------- */
function shopperAuth(after, mode = 'login') {
  window.__afterShopper = after || null;
  modal(`<div class="cardHead"><div><h3>${mode === 'login' ? 'Sign in to order' : 'Create your shopper account'}</h3><p>${mode === 'login' ? 'Use your phone number and password.' : 'Free. Track your orders and collect points at every DeepQr shop.'}</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="tabs" style="margin-bottom:14px"><button class="${mode === 'login' ? 'active' : ''}" onclick="shopperAuth(window.__afterShopper,'login')">Sign in</button><button class="${mode === 'register' ? 'active' : ''}" onclick="shopperAuth(window.__afterShopper,'register')">New account</button></div>
   <form id="shF" class="stack">${mode === 'register' ? `<div class="field"><label for="shN">Your name *</label><input id="shN" required autocomplete="name"></div>` : ''}
    <div class="field"><label for="shP">Mobile number *</label><input id="shP" type="tel" required placeholder="07XX XXX XXX" autocomplete="tel"></div>
    <div class="field"><label for="shW">Password *</label><input id="shW" type="password" required minlength="6" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></div>
    ${mode === 'register' ? `<div class="field"><label for="shA">Area (optional)</label><input id="shA" placeholder="e.g. Kariakoo, Dar es Salaam"></div>` : ''}
    <div id="shErr" class="bad" style="min-height:20px"></div><button class="btn primary lg wide">${mode === 'login' ? 'Sign in' : 'Create account'}</button></form>`, 'narrow');
  document.getElementById('shF').onsubmit = async e => {
    e.preventDefault(); const er = document.getElementById('shErr'); er.textContent = '';
    const phone = document.getElementById('shP').value, pass = document.getElementById('shW').value, email = shopperEmail(phone);
    if (String(phone).replace(/\D/g, '').length < 9) { er.textContent = 'Enter your full mobile number.'; return; }
    await withBusy(e.submitter, async () => {
      try {
        if (mode === 'register') {
          const r = await sb.auth.signUp({ email, password: pass });
          if (r.error) { er.textContent = /registered/i.test(r.error.message) ? 'This number already has an account — sign in instead.' : r.error.message; return; }
          if (!r.data.session) { const s2 = await sb.auth.signInWithPassword({ email, password: pass }); if (s2.error) { er.textContent = 'Account created, but sign-in needs email confirmation to be switched off for shoppers. Contact DeepQr support.'; return; } }
          await rpc('dq_customer_register', { p: { name: document.getElementById('shN').value, phone, area: document.getElementById('shA').value } });
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password: pass });
          if (error) { er.textContent = 'Wrong phone number or password.'; return; }
        }
        const { data: { session: s } } = await sb.auth.getSession(); session = s;
        const w = await rpc('dq_whoami'); customerAcc = w?.customer || null;
        if (!customerAcc) { er.textContent = 'This login is not a shopper account.'; return; }
        const { data: acc } = await sb.from('customer_accounts').select('*').eq('auth_user_id', session.user.id).maybeSingle(); if (acc) Object.assign(customerAcc, acc);
        closeModal(); toast(`Karibu, ${customerAcc.name}!`, 'ok'); storeData = null; render();
        const after = window.__afterShopper; window.__afterShopper = null; if (after) setTimeout(after, 500);
      } catch (x) { er.textContent = errMsg(x); }
    });
  };
}

/* ---------------- shopper home: orders, points, profile ---------------- */
const OO_STEPS = { pickup: ['placed', 'accepted', 'preparing', 'ready', 'completed'], delivery: ['placed', 'accepted', 'preparing', 'out_for_delivery', 'completed'] };
const OO_LABEL = { placed: 'Order sent', accepted: 'Accepted', preparing: 'Preparing', ready: 'Ready to collect', out_for_delivery: 'On the way', completed: 'Completed', cancelled: 'Cancelled', rejected: 'Not accepted', payment_verified: 'Payment confirmed', payment_rejected: 'Payment not found' };
const PAY_LABEL = { unpaid: ['Pay on collection', 'gray'], pending_verification: ['Payment being checked', 'warn'], paid: ['Paid', 'ok'], rejected: ['Payment not found', 'bad'], refunded: ['Refunded', 'info'] };
let cHomeData = null, cHomeTimer = null;
PAGES.c_home = {
  title: 'My orders & points', sub: () => customerAcc ? `${esc(customerAcc.name)} · ${esc(customerAcc.phone || '')}` : '',
  render: () => {
    if (!customerAcc) { setTimeout(() => shopperAuth(() => renderView()), 50); return `<div class="card">${emptyState('user', 'Sign in to see your orders', 'Use your phone number and password.')}</div>`; }
    if (!cHomeData || viewParams.reload) { viewParams.reload = 0; rpc('dq_customer_home').then(d => { cHomeData = d; if (view === 'c_home') renderView(); }).catch(e => toast(errMsg(e), 'bad')); if (!cHomeData) return `<div class="card"><div class="empty"><span class="spinner"></span> Loading…</div></div>`; }
    clearInterval(cHomeTimer); cHomeTimer = setInterval(() => { if (view === 'c_home' && !modalOpen()) { viewParams.reload = 1; renderView(); } else if (view !== 'c_home') clearInterval(cHomeTimer); }, 30000);
    const d = cHomeData, tab = viewParams.tab || 'orders';
    const totalPts = sum(d.loyalty, 'points');
    return `${viewParams.placed ? `<div class="banner ok">${icon('check')}<div><b>Order ${esc(viewParams.placed)} sent!</b><p>The shop will confirm it shortly. This page updates by itself.</p></div></div>` : ''}
     <div class="grid g3">${kpi('cart', 'Orders', d.orders.length, `${d.orders.filter(o => !['completed', 'cancelled', 'rejected'].includes(o.status)).length} in progress`)}${kpi('gift', 'Points', num(totalPts), `at ${d.loyalty.length} shop(s)`, 'teal')}${kpi('store', 'Shops', d.loyalty.length, 'where you shop')}</div>
     <div style="margin-top:16px">${tabbar('chTabs', [['orders', 'Orders', 'cart'], ['points', 'Points & rewards', 'gift'], ['profile', 'Profile', 'user']], tab, 'chTab')}</div>
     ${tab === 'points' ? cPoints(d) : tab === 'profile' ? cProfile(d) : cOrders(d)}`;
  }
};
function chTab(t) { setTab('tab', t); }
function cOrders(d) {
  return d.orders.map(o => { const steps = OO_STEPS[o.fulfilment], at = steps.indexOf(o.status), stopped = ['cancelled', 'rejected'].includes(o.status), pay = PAY_LABEL[o.payment_status] || [o.payment_status, 'gray'];
    return `<div class="card orderCard"><div class="cardHead" style="margin-bottom:8px"><div><h3>${esc(o.business_name)} <span class="mono muted" style="font-size:12px">${esc(o.order_no)}</span></h3><p>${fmtDT(o.created_at)} · ${o.fulfilment === 'delivery' ? 'Delivery to ' + esc(o.delivery_address || '') : 'Collect at the shop'}</p></div><div style="text-align:right"><b>${money(o.total, o.currency)}</b><br><span class="tag ${pay[1]}">${pay[0]}</span></div></div>
      ${stopped ? `<div class="banner bad">${icon('x')}<div><b>${OO_LABEL[o.status]}</b><p>${esc(o.staff_note || '')}</p></div></div>` : `<div class="track">${steps.map((s, i) => `<div class="${i < at ? 'done' : i === at ? 'now' : ''}"><i></i><span>${OO_LABEL[s]}</span></div>`).join('')}</div>`}
      ${o.payment_status === 'rejected' ? `<div class="banner warn">${icon('alert')}<div><b>The shop could not find your payment</b><p>${esc((o.timeline || []).filter(t => t.status === 'payment_rejected').pop()?.note || '')} Call the shop${o.business_phone ? ' on ' + esc(o.business_phone) : ''}.</p></div></div>` : ''}
      ${o.staff_note && !stopped ? `<p class="muted" style="margin:8px 0 0">${icon('info')} ${esc(o.staff_note)}</p>` : ''}
      <details style="margin-top:10px"><summary class="muted">${(o.items || []).length} product(s)</summary>${(o.items || []).map(i => `<div class="row" style="padding:5px 0"><span>${esc(i.name)} × ${num(i.qty)}</span><span>${money(i.qty * i.price, o.currency)}</span></div>`).join('')}${Number(o.delivery_fee) ? `<div class="row" style="padding:5px 0"><span>Delivery</span><span>${money(o.delivery_fee, o.currency)}</span></div>` : ''}${Number(o.points_value) ? `<div class="row ok" style="padding:5px 0"><span>${o.points_redeem} points</span><span>− ${money(o.points_value, o.currency)}</span></div>` : ''}</details>
      <div class="actions" style="margin-top:10px">${o.status === 'completed' && o.points_earned ? `<span class="tag ok">${icon('gift')} +${o.points_earned} points earned</span>` : ''}${['placed', 'accepted'].includes(o.status) ? `<button class="btn small ghost" onclick="cCancel('${o.id}')">Cancel order</button>` : ''}${o.slug ? `<button class="btn small" onclick="goPublic('store',{slug:'${jsq(o.slug)}'})">${icon('cart')}Order again</button>` : ''}${o.business_phone ? `<a class="btn small" href="tel:${esc(o.business_phone)}">${icon('phone')}Call shop</a>` : ''}</div></div>`; }).join('') || `<div class="card">${emptyState('cart', 'No orders yet', 'Find a shop and place your first order.', `<button class="btn primary" onclick="goPublic('shops')">${icon('store')}Browse shops</button>`)}</div>`;
}
function cCancel(id) { askBox('Cancel this order?', 'The shop will be told straight away.', { label: 'Reason (optional)' }, 'Cancel order', async (v, b) => { await withBusy(b, async () => { const r = await rpcToast('dq_customer_cancel_order', { p_id: id, p_reason: v }, 'Order cancelled'); if (r) { closeModal(); viewParams.reload = 1; renderView(); } }); }); }
function cPoints(d) {
  return `<div class="grid g3">${d.loyalty.map(l => `<div class="loyaltyCard"><small>${esc(l.business)}</small><div class="big">${num(l.points)} <span>points</span></div><p>worth ${money(l.worth, l.currency)}${l.min_redeem ? ` · use from ${l.min_redeem}` : ''}</p>${Number(l.owes) > 0 ? `<p class="warn">You owe ${money(l.owes, l.currency)}</p>` : ''}${l.slug ? `<button class="btn small" onclick="goPublic('store',{slug:'${jsq(l.slug)}'})">${icon('cart')}Shop &amp; use points</button>` : ''}</div>`).join('') || `<div class="card" style="grid-column:1/-1">${emptyState('gift', 'No points yet', 'Points appear after a shop accepts your first order. Every purchase earns points you can spend next time.')}</div>`}</div>
   ${d.history.length ? `<div class="card" style="margin-top:16px"><div class="cardHead"><div><h3>Points history</h3></div></div><ul class="timeline">${d.history.map(h => `<li class="${h.points > 0 ? 'ok' : ''}">${h.points ? `<b>${h.points > 0 ? '+' : ''}${h.points} points</b> · ` : ''}${esc(h.business)} — ${esc(h.note || h.type.replace('_', ' '))}<small>${fmtDT(h.created_at)}</small></li>`).join('')}</ul></div>` : ''}`;
}
function cProfile(d) {
  const a = d.account;
  return `<div class="card"><form id="cpF" class="formGrid"><div class="field"><label>Name</label><input id="cpN" value="${esc(a.name)}"></div><div class="field"><label>Mobile number</label><input value="${esc(a.phone)}" disabled></div><div class="field"><label>Default delivery address</label><input id="cpA" value="${esc(a.address || '')}"></div><div class="field"><label>Area</label><input id="cpR" value="${esc(a.area || '')}"></div><button class="btn primary">${icon('check')}Save</button></form></div>`;
}
document.addEventListener('submit', async e => {
  if (e.target.id !== 'cpF') return; e.preventDefault();
  await withBusy(e.submitter, async () => { const r = await rpcToast('dq_customer_update', { p: { name: document.getElementById('cpN').value, address: document.getElementById('cpA').value, area: document.getElementById('cpR').value } }, 'Profile saved'); if (r) { Object.assign(customerAcc, r); viewParams.reload = 1; renderView(); } });
});

/* =============================================================================
   Supplier portal
   ============================================================================= */
const SUP_ST = { sent: ['New order', 'warn'], confirmed: ['Confirmed', 'info'], dispatched: ['Dispatched', 'info'], delivered: ['Delivered', 'ok'], rejected: ['Declined', 'bad'] };
function supTag(s) { const x = SUP_ST[s] || [s, 'gray']; return `<span class="tag ${x[1]}">${x[0]}</span>`; }
async function loadSupplier() { supData = await rpc('dq_supplier_orders'); supplierAcc = { ...supplierAcc, ...supData.account }; }
function supNav() { const n = (supData?.orders || []).filter(o => o.supplier_status === 'sent').length, p = (supData?.payments || []).filter(x => x.verification === 'unverified').length;
  return [['Supplier', [['sup_home', 'Dashboard', 'dashboard'], ['sup_orders', 'Orders', 'truck', n], ['sup_products', 'My price list', 'tag'], ['sup_payments', 'Payments', 'coins', p], ['sup_customers', 'My businesses', 'store'], ['sup_profile', 'Company profile', 'settings']]]]; }
function supNeedData(r) { if (!supData) { loadSupplier().then(() => renderView()).catch(e => toast(errMsg(e), 'bad')); return `<div class="card"><div class="empty"><span class="spinner"></span> Loading…</div></div>`; } return r(); }
PAGES.sup_home = {
  title: 'Supplier dashboard', sub: () => `${esc(supplierAcc?.company_name || '')} · ${esc(supplierAcc?.code || '')}${supplierAcc?.verified ? ' · ✔ verified by DeepQr' : ''}`,
  render: () => supNeedData(() => {
    const o = supData.orders, monthStart = dateOnly(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const nw = o.filter(x => x.supplier_status === 'sent'), toShip = o.filter(x => x.supplier_status === 'confirmed');
    const owed = sum(supData.customers, c => Math.max(0, Number(c.owed_to_you))), unver = supData.payments.filter(p => p.verification === 'unverified');
    const a = supplierAcc, complete = [a.contact_person, a.tin, a.address, a.region, (a.groups || []).length, a.payment_details, supData.products.length].filter(Boolean).length;
    return `${!a.verified ? `<div class="banner info">${icon('shield')}<div><b>Get the “Verified” badge</b><p>Complete your profile (TIN, address, payment details) and list your products. DeepQr checks your details; verified suppliers appear first when businesses search.</p></div><button class="btn small" onclick="go('sup_profile')">Complete profile (${complete}/7)</button></div>` : ''}
     <div class="grid g4">${kpi('truck', 'New orders', nw.length, 'waiting for your answer', nw.length ? 'warn' : '')}${kpi('box', 'To dispatch', toShip.length, 'confirmed orders')}${kpi('coins', 'Businesses owe you', money(owed), `${supData.customers.length} business(es)`, owed ? 'warn' : '')}${kpi('check', 'Payments to confirm', unver.length, money(sum(unver, 'amount')), unver.length ? 'warn' : 'teal')}</div>
     <div class="grid g2" style="margin-top:16px"><div class="card"><div class="cardHead"><div><h3>New orders</h3><p>Confirm what you can supply and when.</p></div><button class="btn small ghost" onclick="go('sup_orders')">All orders ${icon('arrowRight')}</button></div>${nw.slice(0, 6).map(supOrderRow).join('') || '<p class="muted">No new orders right now.</p>'}</div>
      <div class="card"><div class="cardHead"><div><h3>Payments to confirm</h3><p>Businesses recorded these payments to you. Confirm when the money is in your account.</p></div></div>${unver.slice(0, 6).map(p => `<div class="row"><span><b>${money(p.amount)}</b> · ${esc(p.business_name)}<small class="muted"> ${esc(p.method)} ${esc(p.reference || '')}</small></span><span class="actions" style="flex-wrap:nowrap"><button class="btn small success" onclick="supVerifyPay('${p.id}',true)">${icon('check')}Received</button><button class="btn small ghost" onclick="supVerifyPay('${p.id}',false)">Not received</button></span></div>`).join('') || '<p class="muted">Nothing to confirm.</p>'}</div></div>
     <div class="card"><div class="cardHead"><div><h3>This month</h3></div></div><div class="grid g3">${kpi('check', 'Delivered', o.filter(x => x.supplier_status === 'delivered' && (x.sent_at || '') >= monthStart).length)}${kpi('chart', 'Goods received by businesses', money(sum(o.filter(x => (x.sent_at || '') >= monthStart), 'received_value')))}${kpi('ban', 'Declined', o.filter(x => x.supplier_status === 'rejected').length, 'all time')}</div></div>`;
  })
};
function supOrderRow(o) { return `<div class="row clickRow" onclick="supOpenOrder('${o.id}')"><span><b>${esc(o.business_name)}</b> <span class="mono muted" style="font-size:12px">${esc(o.order_no || '')}</span><small class="muted" style="display:block">${(o.items || []).length} product(s) · ${money(o.total_cost)} · needed ${o.expected_date ? fmtD(o.expected_date) : 'soon'}</small></span>${supTag(o.supplier_status)}</div>`; }
let supF = 'sent';
PAGES.sup_orders = {
  title: 'Orders from businesses', sub: 'Answer each order: confirm what you can supply, then mark it dispatched with your invoice.',
  render: () => supNeedData(() => {
    const l = supData.orders.filter(o => supF === 'all' || o.supplier_status === supF);
    return `<div class="card"><div class="pillRow">${[['sent', 'New'], ['confirmed', 'Confirmed'], ['dispatched', 'Dispatched'], ['delivered', 'Delivered'], ['rejected', 'Declined'], ['all', 'All']].map(([k, lb]) => `<button class="pill ${supF === k ? 'active' : ''}" onclick="supF='${k}';renderView()">${lb} <small>${supData.orders.filter(o => k === 'all' || o.supplier_status === k).length}</small></button>`).join('')}</div>
     <div class="tableWrap"><table><thead><tr><th>Order</th><th>Business</th><th>Deliver to</th><th>Needed by</th><th class="right">Products</th><th class="right">Value</th><th>Status</th><th></th></tr></thead><tbody>
     ${l.map(o => `<tr class="clickRow" onclick="supOpenOrder('${o.id}')"><td class="mono"><b>${esc(o.order_no || '')}</b><span class="sub">${fmtD(o.sent_at)}</span></td><td><b>${esc(o.business_name)}</b><span class="sub">${esc(o.business_phone || '')}</span></td><td>${esc(o.deliver_to || '')}<span class="sub">${esc(o.deliver_address || '')}</span></td><td>${o.expected_date ? fmtD(o.expected_date) : '—'}${o.supplier_eta ? `<span class="sub">you: ${fmtD(o.supplier_eta)}</span>` : ''}</td><td class="right num">${(o.items || []).length}</td><td class="right num">${money(o.total_cost)}</td><td>${supTag(o.supplier_status)}</td><td><button class="btn small ${o.supplier_status === 'sent' ? 'primary' : ''}">${o.supplier_status === 'sent' ? 'Answer' : 'Open'}</button></td></tr>`).join('') || `<tr><td colspan="8">${emptyState('truck', 'No orders here', 'When a business orders from you on DeepQr, it appears here instantly.')}</td></tr>`}
     </tbody></table></div></div>`;
  })
};
let supFiles = [];
function supOpenOrder(id) {
  const o = supData.orders.find(x => x.id === id); if (!o) return;
  const canAnswer = ['sent', 'confirmed'].includes(o.supplier_status) && !['cancelled', 'closed'].includes(o.status);
  supFiles = [];
  modal(`<div class="cardHead"><div><h3>${esc(o.order_no || 'Order')} · ${esc(o.business_name)} ${supTag(o.supplier_status)}</h3><p>Deliver to <b>${esc(o.deliver_to || '')}</b>${o.deliver_address ? ', ' + esc(o.deliver_address) : ''}${o.deliver_phone ? ' · ' + esc(o.deliver_phone) : ''} · needed by ${o.expected_date ? fmtD(o.expected_date) : '—'}</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   ${o.note ? `<div class="banner info">${icon('info')}<div><b>Note from the business</b><p>${esc(o.note)}</p></div></div>` : ''}
   ${o.status === 'cancelled' ? `<div class="banner bad">${icon('ban')}<div><b>The business cancelled this order</b></div></div>` : ''}
   <div class="tableWrap"><table style="min-width:620px"><thead><tr><th>Product</th><th class="right">Ordered</th><th class="right">Their price</th><th style="width:110px">You can supply</th><th style="width:130px">Your price</th><th class="right">Received</th></tr></thead><tbody>
   ${(o.items || []).map(i => `<tr data-id="${i.id}"><td><b>${esc(i.product)}</b><span class="sub">${esc(i.code || '')} · ${esc(i.unit || '')}</span></td><td class="right num">${num(i.qty_ordered)}</td><td class="right num">${money(i.unit_cost)}</td><td>${canAnswer ? `<input class="input s_q" type="number" min="0" step="any" value="${i.supplier_qty ?? i.qty_ordered}">` : num(i.supplier_qty ?? i.qty_ordered)}</td><td>${canAnswer ? `<input class="input s_p" type="number" min="0" step="any" value="${i.supplier_price ?? i.unit_cost}">` : money(i.supplier_price ?? i.unit_cost)}</td><td class="right num">${num(i.qty_received)}${Number(i.qty_damaged) ? ` <small class="bad">${num(i.qty_damaged)} damaged</small>` : ''}</td></tr>`).join('')}
   </tbody></table></div>
   ${canAnswer ? `<div class="formGrid" style="margin-top:12px"><div class="field"><label for="soE">You will deliver on</label><input id="soE" type="date" value="${esc(o.supplier_eta || o.expected_date || addDays(2))}"></div><div class="field"><label for="soN">Message to the business</label><input id="soN" value="${esc(o.supplier_note || '')}" placeholder="e.g. 2 cartons arrive next week"></div></div>
     <div class="actions" style="margin-top:12px">${o.supplier_status === 'sent' ? `<button class="btn primary" onclick="supAnswer('${o.id}','confirm',this)">${icon('check')}Confirm order</button>` : `<button class="btn" onclick="supAnswer('${o.id}','confirm',this)">${icon('edit')}Update confirmation</button>`}<button class="btn" onclick="supDispatchForm('${o.id}')">${icon('truck')}Mark dispatched</button>${o.supplier_status === 'sent' ? `<button class="btn ghost" onclick="supAnswer('${o.id}','reject',this)">${icon('x')}Decline</button>` : ''}</div>`
     : `<dl class="kv" style="margin-top:12px"><dt>Your message</dt><dd>${esc(o.supplier_note || '—')}</dd><dt>Delivery date</dt><dd>${o.supplier_eta ? fmtD(o.supplier_eta) : '—'}</dd><dt>Invoice</dt><dd>${esc(o.invoice_no || '—')}${o.invoice_amount ? ' · ' + money(o.invoice_amount) : ''}</dd><dt>Paid</dt><dd>${money(o.paid_amount)} (${esc(o.payment_status || '')})</dd></dl>${docListHtml(o.supplier_attachments || [])}`}
   <div class="actions" style="margin-top:10px;justify-content:flex-end"><button class="btn ghost" onclick="supDeliveryNote('${o.id}')">${icon('printer')}Delivery note</button></div>`, 'wide');
}
async function supAnswer(id, action, btn) {
  const lines = [...document.querySelectorAll('tr[data-id]')].map(tr => ({ id: tr.dataset.id, qty: Number(tr.querySelector('.s_q')?.value), price: Number(tr.querySelector('.s_p')?.value) }));
  let note = document.getElementById('soN')?.value || '';
  if (action === 'reject' && !note.trim()) { note = prompt('Why can you not supply this order?') || ''; if (!note.trim()) return; }
  await withBusy(btn, async () => { const r = await rpcToast('dq_supplier_respond', { p: { order_id: id, action, lines, eta: document.getElementById('soE')?.value, note } }, action === 'reject' ? 'Order declined' : 'Order confirmed — the business has been told'); if (r) { closeModal(); await loadSupplier(); renderView(); } });
}
function supDispatchForm(id) {
  const o = supData.orders.find(x => x.id === id); supFiles = [];
  modal(`<form id="sdF"><div class="cardHead"><div><h3>Dispatch ${esc(o.order_no || '')}</h3><p>Tell ${esc(o.business_name)} the goods are on the way and attach your invoice.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="formGrid"><div class="field"><label>Invoice number</label><input id="sdI" value="${esc(o.invoice_no || '')}"></div><div class="field"><label>Invoice amount</label><input id="sdA" type="number" min="0" step="any" value="${o.invoice_amount ?? sum(o.items || [], i => (i.supplier_qty ?? i.qty_ordered) * (i.supplier_price ?? i.unit_cost))}"></div><div class="field"><label>Arrives on</label><input id="sdE" type="date" value="${esc(o.supplier_eta || addDays(1))}"></div></div>
   <div class="field" style="margin-top:10px"><label>Note (driver, vehicle, what is coming)</label><input id="sdN"></div>
   <div style="margin-top:10px">${dropzoneHtml('sdUp', 'Attach the invoice / delivery note')}<div id="sdDocs"></div></div>
   <div id="sdErr" class="bad" style="min-height:20px;margin-top:8px"></div><div class="actions"><button class="btn primary">${icon('truck')}Mark dispatched</button></div></form>`);
  bindDropzone('sdUp', fs => { supFiles.push(...fs); document.getElementById('sdDocs').innerHTML = docListHtml(supFiles.map(f => ({ name: f.name, size: f.size, type: f.type, kind: 'invoice' }))); });
  document.getElementById('sdF').onsubmit = async e => {
    e.preventDefault();
    await withBusy(e.submitter, async () => {
      try {
        const bucket = CFG.docsBucket || 'dq-docs', att = [];
        for (const f of supFiles) { const path = `sup/${supplierAcc.id}/${uid()}-${f.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)}`; const { error } = await sb.storage.from(bucket).upload(path, f, { contentType: f.type }); if (error) throw error; att.push({ path, name: f.name, size: f.size, type: f.type, kind: 'invoice', by: supplierAcc.company_name, uploaded_at: new Date().toISOString() }); }
        await rpc('dq_supplier_respond', { p: { order_id: id, action: 'dispatch', invoice_no: document.getElementById('sdI').value, invoice_amount: document.getElementById('sdA').value, eta: document.getElementById('sdE').value, note: document.getElementById('sdN').value, attachments: att } });
        closeModal(); await loadSupplier(); renderView(); toast('Marked dispatched — the business can now receive the goods', 'ok');
      } catch (x) { document.getElementById('sdErr').textContent = errMsg(x); }
    });
  };
}
function supDeliveryNote(id) {
  const o = supData.orders.find(x => x.id === id), a = supplierAcc;
  modal(`<div class="actions noPrint" style="justify-content:flex-end"><button class="btn primary" onclick="printModal()">${icon('printer')}Print</button><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="receipt" style="max-width:none;font-family:inherit"><div style="display:flex;justify-content:space-between;gap:16px"><div><h2 style="margin:0">${esc(a.company_name)}</h2><small class="muted">${esc([a.address, a.region, a.phone].filter(Boolean).join(' · '))}${a.tin ? '<br>TIN ' + esc(a.tin) : ''}</small></div><div style="text-align:right"><h2 style="margin:0">DELIVERY NOTE</h2><b class="mono">${esc(o.order_no || '')}</b><br><small>${fmtD(o.supplier_eta || dateOnly())}</small></div></div>
   <p style="margin:16px 0"><small class="muted">DELIVER TO</small><br><b>${esc(o.business_name)}</b> — ${esc(o.deliver_to || '')}<br>${esc(o.deliver_address || '')} ${esc(o.deliver_phone || '')}</p>
   <table style="width:100%;min-width:0"><thead><tr><th>#</th><th>Product</th><th class="right">Qty</th><th class="right">Unit price</th><th class="right">Total</th></tr></thead><tbody>${(o.items || []).map((i, n) => { const q = i.supplier_qty ?? i.qty_ordered, pr = i.supplier_price ?? i.unit_cost; return `<tr><td>${n + 1}</td><td>${esc(i.product)}</td><td class="right">${num(q)}</td><td class="right">${num(pr)}</td><td class="right">${num(q * pr)}</td></tr>`; }).join('')}</tbody></table>
   <p style="margin-top:40px">Received by: ____________________ Signature: __________ Date: ________</p></div>`, 'wide');
}
async function supVerifyPay(id, ok) {
  let note = null;
  if (!ok) { note = prompt('What is wrong? (e.g. "No money received for this reference")'); if (!note) return; }
  const r = await rpcToast('dq_supplier_verify_payment', { p_id: id, p_confirm: ok, p_note: note }, ok ? 'Payment confirmed' : 'The business has been told the payment was not received');
  if (r) { await loadSupplier(); renderView(); }
}
PAGES.sup_payments = {
  title: 'Payments', sub: 'Every payment a business records to you waits for your confirmation — so both sides agree on the balance.',
  render: () => supNeedData(() => `<div class="card"><div class="tableWrap"><table><thead><tr><th>Date</th><th>Business</th><th>Order</th><th>Method</th><th>Reference</th><th class="right">Amount</th><th>Status</th><th></th></tr></thead><tbody>
   ${supData.payments.map(p => `<tr><td>${fmtD(p.paid_on)}</td><td>${esc(p.business_name)}</td><td class="mono">${esc(p.order_no || 'on account')}</td><td>${esc(p.method)}</td><td class="mono">${esc(p.reference || '')}</td><td class="right num"><b>${money(p.amount)}</b></td><td>${p.verification === 'confirmed' ? '<span class="tag ok">Confirmed</span>' : p.verification === 'disputed' ? `<span class="tag bad">Not received</span><span class="sub">${esc(p.verify_note || '')}</span>` : '<span class="tag warn">To confirm</span>'}</td><td>${p.verification === 'unverified' ? `<div class="actions" style="flex-wrap:nowrap"><button class="btn small success" onclick="supVerifyPay('${p.id}',true)">${icon('check')}Received</button><button class="btn small ghost" onclick="supVerifyPay('${p.id}',false)">Not received</button></div>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No payments recorded yet.</td></tr>'}
   </tbody></table></div></div>`)
};
PAGES.sup_customers = {
  title: 'My businesses', sub: 'Businesses that buy from you on DeepQr',
  render: () => supNeedData(() => `<div class="card"><div class="tableWrap"><table><thead><tr><th>Business</th><th>Phone</th><th class="right">Orders</th><th class="right">Bought</th><th class="right">Owes you</th></tr></thead><tbody>
   ${supData.customers.map(c => `<tr><td><b>${esc(c.name)}</b> <small class="mono muted">${esc(c.code || '')}</small></td><td>${esc(c.phone || '')}</td><td class="right num">${c.orders}</td><td class="right num">${money(c.bought)}</td><td class="right num ${Number(c.owed_to_you) > 0 ? 'warn' : ''}"><b>${money(c.owed_to_you)}</b></td></tr>`).join('') || `<tr><td colspan="5">${emptyState('store', 'No businesses yet', 'Businesses find you in the DeepQr supplier directory. A complete profile and price list help them choose you.')}</td></tr>`}
   </tbody></table></div></div>`)
};
let supCatQ = '';
PAGES.sup_products = {
  title: 'My price list', sub: 'Products you supply, with your price and minimum order. Businesses see this when they choose a supplier.',
  actions: () => `<button class="btn primary" onclick="supEditProduct()">${icon('plus')}Add product</button>`,
  render: () => supNeedData(() => `<div class="card"><div class="tableWrap"><table><thead><tr><th>Product</th><th>Unit</th><th class="right">Price</th><th class="right">Min. order</th><th class="right">Lead time</th><th>Status</th><th></th></tr></thead><tbody>
   ${supData.products.map(p => `<tr><td><b>${esc(p.name)}</b><span class="sub">${esc([p.sku, p.pack_size].filter(Boolean).join(' · '))}${p.catalog_id ? ' · catalogue product' : ''}</span></td><td><span class="tag gray">${esc(p.unit_code)}</span></td><td class="right num"><b>${money(p.price)}</b></td><td class="right num">${num(p.min_order_qty)}</td><td class="right num">${p.lead_days} day(s)</td><td>${p.available ? '<span class="tag ok">Available</span>' : '<span class="tag gray">Out of stock</span>'}</td><td><button class="btn small" onclick="supEditProduct('${p.id}')">${icon('edit')}</button></td></tr>`).join('') || `<tr><td colspan="7">${emptyState('tag', 'Your price list is empty', 'Add the products you supply. Pick them from the DeepQr catalogue so businesses can match them to their own products.', `<button class="btn primary" onclick="supEditProduct()">${icon('plus')}Add product</button>`)}</td></tr>`}
   </tbody></table></div></div>`)
};
async function supEditProduct(id) {
  const p = id ? supData.products.find(x => x.id === id) : { unit_code: 'PCS', min_order_qty: 1, lead_days: 1, available: true };
  if (!id && !catData) { try { await loadCatalog(); } catch (e) {} }
  modal(`<form id="spF"><div class="cardHead"><div><h3>${id ? 'Edit product' : 'Add a product you supply'}</h3><p>Pick from the catalogue (recommended) or type your own.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   ${id ? '' : `<div class="field"><label>From the DeepQr catalogue</label><input class="input" list="spCat" id="spC" placeholder="Search, e.g. cement, sugar, charger…" oninput="const c=(catData||[]).find(x=>(x.code+' — '+x.name)===this.value);if(c){document.getElementById('spN').value=(c.brand&&!c.name.toLowerCase().includes(c.brand.toLowerCase())?c.brand+' ':'')+c.name;document.getElementById('spU').value=c.unit_code;document.getElementById('spK').value=c.pack_size||'';this.dataset.id=c.id}"><datalist id="spCat">${(catData || []).filter(c => c.status === 'approved' && (!(supplierAcc.groups || []).length || supplierAcc.groups.includes(c.group_code))).map(c => `<option value="${esc(c.code + ' — ' + c.name)}">`).join('')}</datalist></div>`}
   <div class="formGrid" style="margin-top:10px"><div class="field"><label>Product name *</label><input id="spN" required value="${esc(p.name || '')}"></div><div class="field"><label>Your SKU</label><input id="spS" value="${esc(p.sku || '')}"></div><div class="field"><label>Unit</label><select id="spU">${REF.units.map(u => `<option value="${esc(u.code)}" ${p.unit_code === u.code ? 'selected' : ''}>${esc(u.code)} — ${esc(u.name)}</option>`).join('')}</select></div><div class="field"><label>Pack size</label><input id="spK" value="${esc(p.pack_size || '')}"></div>
    <div class="field"><label>Your price *</label><input id="spP" type="number" min="0" step="any" required value="${p.price ?? ''}"></div><div class="field"><label>Minimum order</label><input id="spM" type="number" min="0" step="any" value="${p.min_order_qty}"></div><div class="field"><label>Delivery time (days)</label><input id="spL" type="number" min="0" value="${p.lead_days}"></div></div>
   ${id ? `<label class="chk" style="margin-top:10px"><input type="checkbox" id="spA" ${p.available ? 'checked' : ''}>Available now</label>` : ''}
   <div id="spErr" class="bad" style="min-height:20px;margin-top:8px"></div><div class="actions"><button class="btn primary">${icon('check')}Save</button>${id ? `<button type="button" class="btn danger" onclick="supDelProduct('${id}')">${icon('trash')}Remove</button>` : ''}</div></form>`);
  document.getElementById('spF').onsubmit = async e => {
    e.preventDefault(); const v = x => document.getElementById(x).value;
    await withBusy(e.submitter, async () => { try { await rpc('dq_supplier_save_product', { p: { id: id || null, catalog_id: document.getElementById('spC')?.dataset.id || null, name: v('spN'), sku: v('spS'), unit_code: v('spU'), pack_size: v('spK'), price: Number(v('spP')), min_order_qty: Number(v('spM')), lead_days: Number(v('spL')), available: document.getElementById('spA') ? document.getElementById('spA').checked : true } }); closeModal(); await loadSupplier(); renderView(); toast('Price list updated', 'ok'); } catch (x) { document.getElementById('spErr').textContent = errMsg(x); } });
  };
}
async function supDelProduct(id) { await rpcToast('dq_supplier_save_product', { p: { id, delete: true } }, 'Removed'); closeModal(); await loadSupplier(); renderView(); }
PAGES.sup_profile = {
  title: 'Company profile', sub: 'What businesses see in the DeepQr supplier directory',
  render: () => supNeedData(() => { const a = supplierAcc; return `<form id="supPF"><div class="card"><div class="formGrid">
    <div class="field"><label>Company name *</label><input id="pfN" required value="${esc(a.company_name)}"></div><div class="field"><label>Contact person</label><input id="pfC" value="${esc(a.contact_person || '')}"></div><div class="field"><label>Phone *</label><input id="pfP" value="${esc(a.phone || '')}"></div><div class="field"><label>TIN</label><input id="pfT" value="${esc(a.tin || '')}"></div>
    <div class="field"><label>Address</label><input id="pfA" value="${esc(a.address || '')}"></div><div class="field"><label>Region / city</label><input id="pfR" value="${esc(a.region || '')}"></div><div class="field"><label>Payment terms (days)</label><input id="pfD" type="number" min="0" value="${a.payment_terms_days || 0}"></div><div class="field"><label>Areas you deliver to</label><input id="pfDA" value="${esc(a.delivery_areas || '')}" placeholder="e.g. Dar es Salaam, Pwani"></div></div>
    <div class="field" style="margin-top:10px"><label>About your company</label><textarea id="pfX" rows="2">${esc(a.description || '')}</textarea></div>
    <div class="field" style="margin-top:10px"><label>How businesses pay you (bank / M-Pesa details)</label><textarea id="pfPay" rows="2">${esc(a.payment_details || '')}</textarea></div>
    <h3 style="margin:16px 0 8px">What you supply</h3>${groupCardsHtml(a.groups || [], 'pfG')}
    <div class="actions" style="margin-top:14px"><button class="btn primary lg">${icon('check')}Save profile</button></div></div></form>`; })
};
document.addEventListener('submit', async e => {
  if (e.target.id !== 'supPF') return; e.preventDefault(); const v = x => document.getElementById(x).value;
  await withBusy(e.submitter, async () => { const r = await rpcToast('dq_supplier_update_profile', { p: { company_name: v('pfN'), contact_person: v('pfC'), phone: v('pfP'), tin: v('pfT'), address: v('pfA'), region: v('pfR'), payment_terms_days: Number(v('pfD')), delivery_areas: v('pfDA'), description: v('pfX'), payment_details: v('pfPay'), groups: checkedValues('pfG') } }, 'Profile saved'); if (r) { Object.assign(supplierAcc, r); render(); } });
});
