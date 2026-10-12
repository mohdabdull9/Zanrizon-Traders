/* =============================================================================
   Products, QR codes, expiry, inventory (levels, reorder, stock takes,
   stock-in, adjustments), transfers
   ============================================================================= */
function itemsFor(pid, shopId) { return cache.items.filter(i => i.product_id === pid && i.status === 'in_stock' && (!shopId || i.shop_id === shopId)); }
function salesQty30(pid, shopId) { const from = addDays(-29); const ids = new Set(cache.sales.filter(s => s.date >= from && (!shopId || s.shop_id === shopId)).map(s => s.id)); return sum(cache.saleLines.filter(l => l.product_id === pid && ids.has(l.sale_id)), l => Number(l.qty) - Number(l.refunded_qty || 0)); }
function onOrder(pid, shopId) { const open = new Set(cache.orders.filter(o => ['ordered', 'pending', 'partial'].includes(o.status)).map(o => o.id)); return sum(cache.orderItems.filter(i => i.product_id === pid && open.has(i.order_id) && (!shopId || i.shop_id === shopId)), i => Math.max(0, Number(i.qty_ordered) - Number(i.qty_received) - Number(i.qty_damaged || 0))); }

/* ---------------- products ---------------- */
let prodF = { cat: '', status: '' };
function categoryOptions(selected) {
  const names = cache.categories.map(c => c.name);
  const bySub = REF.groups.map(g => [g, names.filter(n => subByName(n)?.group_code === g.code)]).filter(x => x[1].length);
  const other = names.filter(n => !subByName(n));
  if (selected && !names.includes(selected)) other.unshift(selected);
  return bySub.map(([g, l]) => `<optgroup label="${esc(g.name)}">${l.map(n => `<option ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>`).join('') + (other.length ? `<optgroup label="Other">${other.map(n => `<option ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>` : '');
}
PAGES.products = {
  title: 'Products', sub: 'Catalogue, prices, suppliers and reorder levels', searchable: true,
  actions: () => can('manager') || can('can_manage_stock') ? `<button class="btn" onclick="go('catalog')">${icon('spark')}Add from catalogue</button><button class="btn" onclick="importProducts()">${icon('upload')}Import CSV</button><button class="btn primary" onclick="openProduct()">${icon('plus')}New product</button>` : '',
  render: () => {
    let list = cache.products.slice();
    if (prodF.cat) list = list.filter(p => (p.category || 'General') === prodF.cat);
    if (prodF.status === 'inactive') list = list.filter(p => p.active === false); else list = list.filter(p => p.active !== false);
    if (prodF.status === 'low') list = list.filter(p => totalStock(p) <= threshold(p));
    if (prodF.status === 'untagged') list = list.filter(p => totalStock(p) > itemsFor(p.id).length);
    if (search) { const q = search.toLowerCase(); list = list.filter(p => (p.name + ' ' + p.code + ' ' + p.barcode + ' ' + p.category).toLowerCase().includes(q)); }
    const cats = cache.categories.map(c => c.name);
    return `<div class="card"><div class="toolbar"><input class="input grow" id="prodSearch" value="${esc(search)}" oninput="liveSearch(this)" placeholder="Search name, code, category or barcode…" aria-label="Search products">
     <select class="input" aria-label="Category" onchange="prodF.cat=this.value;renderView()"><option value="">All categories</option>${cats.map(c => `<option ${prodF.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
     <select class="input" aria-label="Filter" onchange="prodF.status=this.value;renderView()">${[['', 'Active products'], ['low', 'Low / out of stock'], ['untagged', 'Stock without QR labels'], ['inactive', 'Inactive']].map(([k, l]) => `<option value="${k}" ${prodF.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="tableWrap"><table><thead><tr><th>Product</th><th>Code</th><th>Category</th><th>Supplier</th><th class="right">Cost</th><th class="right">Price</th><th class="right">Margin</th><th class="right">Stock</th><th class="right">QR labels</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(p => { const total = totalStock(p), tg = itemsFor(p.id).length, mg = Number(p.price) ? pct(Number(p.price) - Number(p.cost), Number(p.price)) : 0; return `<tr class="clickRow" onclick="openProductCard('${p.id}')"><td>${groupDot(p.group_code || subByName(p.category)?.group_code)}<b>${esc(p.name)}</b><span class="sub">${esc(p.unit || 'PCS')}${p.pack_size ? ' · ' + esc(p.pack_size) : ''} · No. ${String(p.product_no || 0).padStart(2, '0')}${p.expiry_tracking ? ' · tracks expiry' : ''}</span></td><td class="mono">${esc(p.code)}</td><td>${esc(p.category)}</td><td>${esc(supplierById(p.supplier_id)?.name || '—')}</td><td class="right num">${money(p.cost)}</td><td class="right num"><b>${money(p.price)}</b></td><td class="right num ${mg < 10 ? 'warn' : ''}">${mg}%</td><td class="right num">${total}</td><td class="right num">${tg}${total > tg ? ` <span class="tag warn">+${total - tg}</span>` : ''}</td><td>${statusTag(total, p)}</td>
     <td onclick="event.stopPropagation()"><div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">${canQR() ? `<button class="btn small" onclick="openGenerate('${p.id}')">${icon('qr')}QR</button>` : ''}${can('manager') ? `<button class="btn small" onclick="openProduct('${jsq(p.code)}')">Edit</button>` : ''}</div></td></tr>`; }).join('') || `<tr><td colspan="11" class="empty">No products here. ${can('manager') ? 'Click “New product” or import a CSV.' : ''}</td></tr>`}
    </tbody></table></div></div>`;
  }
};
function openProduct(code = '') {
  const editing = code || null;
  const p = code ? product(code) : { code: '', name: '', category: cache.categories[0]?.name || 'General', barcode: makeBarcode(), cost: 0, price: 0, unit: (business.units || [])[0] || 'PCS', tax: business.tax, active: true };
  modal(`<div class="cardHead"><div><h3>${code ? 'Edit product' : 'New product'}</h3><p>The product code (e.g. <span class="mono">D12</span>) appears inside every QR label for this product.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
  <form id="productForm"><div class="formGrid"><div class="field"><label for="pn">Product name</label><input id="pn" value="${esc(p.name)}" required placeholder="e.g. Dell 12"></div><div class="field"><label for="pc">Product code</label><input id="pc" class="mono" value="${esc(p.code)}" required ${code ? 'readonly' : ''} placeholder="e.g. D12" maxlength="16"></div><div class="field"><label for="pct">Category</label><select id="pct">${categoryOptions(p.category)}</select></div><div class="field"><label for="pu">Unit (master list)</label><select id="pu">${unitOptions(p.unit)}</select></div>
  <div class="field"><label for="pbr">Brand</label><input id="pbr" value="${esc(p.brand || '')}" placeholder="optional"></div><div class="field"><label for="ppk">Pack size</label><input id="ppk" value="${esc(p.pack_size || '')}" placeholder="e.g. 500ml, 50kg, 10 tablets"></div>
  <div class="field"><label for="pco">Cost price</label><input id="pco" type="number" min="0" step="any" value="${p.cost || 0}"></div><div class="field"><label for="pp">Selling price</label><input id="pp" type="number" min="0" step="any" value="${p.price || 0}"></div><div class="field"><label for="pt">Tax %</label><input id="pt" type="number" min="0" step="any" value="${p.tax ?? business.tax}"></div><div class="field"><label for="psup">Main supplier</label><select id="psup"><option value="">—</option>${cache.suppliers.map(s => `<option value="${s.id}" ${p.supplier_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
  <div class="field"><label for="pls">Reorder level (low stock at)</label><input id="pls" type="number" min="0" value="${p.low_stock ?? ''}" placeholder="Default ${business.low_stock}"></div><div class="field"><label for="prq">Reorder quantity</label><input id="prq" type="number" min="0" value="${p.reorder_qty ?? ''}" placeholder="Suggested order size"></div><div class="field"><label for="pb">Barcode on the package</label><input id="pb" class="mono" value="${esc(p.barcode)}"></div></div>
  <div class="field" style="margin-top:10px"><label for="pdesc">Description (optional)</label><input id="pdesc" value="${esc(p.description || '')}"></div>
  <div class="actions" style="margin-top:12px"><label class="chk"><input type="checkbox" id="pexp" ${p.expiry_tracking ? 'checked' : ''}> This product expires (ask for expiry dates)</label>${code ? `<label class="chk"><input type="checkbox" id="pact" ${p.active !== false ? 'checked' : ''}> Active (sellable)</label>` : ''}</div>
  <div class="actions" style="margin-top:18px"><button class="btn primary">Save product</button><button type="button" class="btn" onclick="closeModal()">Cancel</button>${code && !p.catalog_id ? `<button type="button" class="btn ghost" onclick="closeModal();submitCatalogProduct('${p.id}')" title="Share with other businesses">${icon('megaphone')}Suggest to catalogue</button>` : ''}</div></form>`);
  document.getElementById('productForm').onsubmit = async (e) => {
    e.preventDefault();
    const codeV = document.getElementById('pc').value.trim().replace(/\|/g, ''), lsRaw = document.getElementById('pls').value.trim(), rq = document.getElementById('prq').value.trim();
    const obj = { code: codeV, name: document.getElementById('pn').value.trim(), category: document.getElementById('pct').value, unit: document.getElementById('pu').value || 'PCS', brand: document.getElementById('pbr').value.trim() || null, pack_size: document.getElementById('ppk').value.trim() || null, group_code: subByName(document.getElementById('pct').value)?.group_code || p.group_code || null, cost: Number(document.getElementById('pco').value), price: Number(document.getElementById('pp').value), barcode: document.getElementById('pb').value.trim() || makeBarcode(), tax: Number(document.getElementById('pt').value) || 0, low_stock: lsRaw === '' ? null : Number(lsRaw), reorder_qty: rq === '' ? null : Number(rq), supplier_id: document.getElementById('psup').value || null, description: document.getElementById('pdesc').value.trim() || null, expiry_tracking: document.getElementById('pexp').checked, active: code ? document.getElementById('pact').checked : true, business_id: me.business_id };
    if (obj.price < obj.cost && !confirm('The selling price is below cost. Save anyway?')) return;
    if (!editing && product(codeV)) { toast('That product code already exists', 'bad'); return; }
    const res = editing ? await sb.from('products').update(obj).eq('id', p.id).select().single() : await sb.from('products').insert(obj).select().single();
    if (res.error) { toast(res.error.code === '23505' ? 'That code or barcode already exists.' : errMsg(res.error), 'bad'); return; }
    if (editing) Object.assign(p, res.data); else cache.products.push(res.data);
    await logActivity('product', (editing ? 'Product updated: ' : 'Product created: ') + obj.name);
    closeModal(); renderView(); toast('Product saved', 'ok');
  };
}
async function openProductCard(pid) {
  const p = productById(pid); if (!p) return;
  const card = await rpc('dq_stock_card', { p_product_id: pid, p_shop_id: null, p_limit: 60 }).catch(() => []);
  const s30 = salesQty30(pid);
  drawer(`<div class="drawerHead"><div><h2>${esc(p.name)}</h2><p><span class="mono">${esc(p.code)}</span> · ${esc(p.category)} · ${money(p.price)} (cost ${money(p.cost)})</p></div><div class="actions">${can('manager') ? `<button class="btn small" onclick="closeDrawer();openProduct('${jsq(p.code)}')">${icon('edit')}Edit</button>` : ''}${canQR() ? `<button class="btn small" onclick="closeDrawer();openGenerate('${p.id}')">${icon('qr')}QR codes</button>` : ''}<button class="btn ghost" onclick="closeDrawer()">${icon('x')}</button></div></div>
  <div class="drawerBody"><div class="grid g3">${kpi('layers', 'In stock', totalStock(p), `${itemsFor(pid).length} with QR labels`)}${kpi('chart', 'Sold (30 days)', s30, s30 ? `≈ ${Math.max(1, Math.round(totalStock(p) / (s30 / 30)))} days of cover` : 'no recent sales', 'teal')}${kpi('truck', 'On order', onOrder(pid), supplierById(p.supplier_id)?.name || 'no supplier set')}</div>
  <h3 style="margin:18px 0 8px">Stock by location</h3><div class="tableWrap"><table style="min-width:0"><thead><tr><th>Location</th><th class="right">On hand</th><th class="right">QR labels</th><th class="right">Value (cost)</th></tr></thead><tbody>${cache.shops.map(s => `<tr><td>${esc(s.name)}</td><td class="right num">${stock(s.id, p.code)}</td><td class="right num">${itemsFor(pid, s.id).length}</td><td class="right num">${money(stock(s.id, p.code) * p.cost)}</td></tr>`).join('')}</tbody></table></div>
  <h3 style="margin:18px 0 8px">Stock card (latest movements)</h3><div class="tableWrap"><table style="min-width:0"><thead><tr><th>When</th><th>Movement</th><th>Location</th><th class="right">Qty</th><th>Reference</th><th>By</th></tr></thead><tbody>${(card || []).map(m => `<tr><td>${fmtDT(m.ts)}</td><td>${esc(m.kind)}</td><td>${esc(shopObj(m.shop_id)?.name || '')}</td><td class="right num ${m.qty < 0 ? 'bad' : 'ok'}">${m.qty > 0 ? '+' : ''}${num(m.qty)}</td><td>${esc(m.ref || '')}</td><td>${esc(m.by_name || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No movements yet.</td></tr>'}</tbody></table></div></div>`);
}
function importProducts() {
  modal(`<div class="cardHead"><div><h3>Import products from CSV</h3><p>Columns (first row = headers): <span class="mono">name, code, category, cost, price, unit, barcode, reorder_level</span>. Existing codes are skipped.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
  <label class="dropzone" for="impFile">${icon('upload')}<br>Choose a .csv file (save Excel as CSV)</label><input id="impFile" type="file" accept=".csv,text/csv" class="hidden">
  <div id="impPreview" style="margin-top:12px"></div>`);
  document.getElementById('impFile').onchange = async (e) => {
    const text = await e.target.files[0].text();
    const rows = text.split(/\r?\n/).filter(r => r.trim()).map(r => r.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim()));
    const head = rows.shift().map(h => h.toLowerCase());
    const ix = k => head.indexOf(k);
    const items = rows.map(r => ({ name: r[ix('name')], code: (r[ix('code')] || '').replace(/\|/g, ''), category: r[ix('category')] || 'General', cost: Number(r[ix('cost')] || 0), price: Number(r[ix('price')] || 0), unit: (String(r[ix('unit')] || '').toUpperCase().trim() || 'PCS').replace(/^UNITS?$/, 'PCS'), barcode: r[ix('barcode')] || makeBarcode() + Math.floor(Math.random() * 9), low_stock: ix('reorder_level') >= 0 && r[ix('reorder_level')] !== '' ? Number(r[ix('reorder_level')]) : null })).filter(x => x.name && x.code);
    const fresh = items.filter(x => !product(x.code));
    document.getElementById('impPreview').innerHTML = `<p><b>${fresh.length}</b> new product(s), ${items.length - fresh.length} skipped (code exists).</p><div class="tableWrap" style="max-height:240px"><table style="min-width:0"><tbody>${fresh.slice(0, 50).map(x => `<tr><td>${esc(x.name)}</td><td class="mono">${esc(x.code)}</td><td>${esc(x.category)}</td><td class="right">${money(x.price)}</td></tr>`).join('')}</tbody></table></div><button class="btn primary" style="margin-top:12px" id="impGo" ${fresh.length ? '' : 'disabled'}>Import ${fresh.length} product(s)</button>`;
    const go2 = document.getElementById('impGo'); if (go2) go2.onclick = async () => {
      const newCats = [...new Set(fresh.map(x => x.category))].filter(c => !cache.categories.some(k => k.name === c));
      if (newCats.length) { const { data } = await sb.from('categories').insert(newCats.map(name => ({ business_id: me.business_id, name }))).select(); cache.categories.push(...(data || [])); }
      const { data, error } = await sb.from('products').insert(fresh.map(x => ({ ...x, business_id: me.business_id }))).select();
      if (error) { toast(errMsg(error), 'bad'); return; }
      cache.products.push(...data); await logActivity('product', `${data.length} products imported`); closeModal(); renderView(); toast(`${data.length} products imported`, 'ok');
    };
  };
}

/* ---------------- QR codes ---------------- */
let qrSel = {};
PAGES.qr = {
  title: 'QR Codes', sub: 'One unique label per item — generated from your QR wallet', searchable: true,
  actions: () => canQR() ? `<button class="btn" onclick="labelSettings()">${icon('settings')}Label settings</button><button class="btn primary" onclick="openGenerate()">${icon('qr')}Generate QR codes</button>` : '',
  render: () => {
    const tab = viewParams.tab || 'recs';
    const recN = sum(cache.recs, 'recommended');
    const openPr = (cache.printOrders || []).filter(o => !['delivered', 'cancelled', 'rejected'].includes(o.status)).length;
    return walletStrip() + tabbar('qrTabs', [['recs', 'Recommendations', 'spark', recN || '', recN > 0], ['batches', 'Batches', 'layers', cache.generations.length || ''], ['print', 'Print orders', 'printer', openPr || ''], ['find', 'Find a label', 'search']], tab, 'qrTab') + (tab === 'batches' ? batchesView() : tab === 'print' ? printOrdersView() : tab === 'find' ? findLabelView() : recsView());
  },
  after: () => { if ((viewParams.tab || 'recs') === 'find') { Scanner.pushHandler('qr', (code) => { document.getElementById('findIn').value = code; findLabel(); }); const fi = document.getElementById('findIn'); if (fi) Scanner.bindInput(fi); if (viewParams.code) { fi.value = viewParams.code; viewParams.code = ''; findLabel(); } } }
};
function qrTab(t) { setTab('tab', t); }
function walletStrip() {
  const w = wallet || {};
  return `<div class="grid g4">${kpi('wallet', 'Wallet balance', money(w.balance, w.currency), w.credit_limit ? `credit limit ${money(w.credit_limit, w.currency)}` : 'main credits', Number(w.balance) < Number(w.fee || 25) * 20 ? 'warn' : 'teal')}${kpi('gift', 'Bonus credits', money(w.bonus_balance, w.currency), w.bonus_expires_at && Number(w.bonus_balance) > 0 ? 'expire ' + fmtD(w.bonus_expires_at) : 'used before your balance', 'teal')}${kpi('spark', 'Free this month', `${w.free_remaining || 0} QR`, `of ${w.free_allowance || 0} included`)}${kpi('tag', 'Price per QR', money(w.fee, w.currency), Number(w.fee) < Number(w.standard_fee) ? `special price (normally ${money(w.standard_fee, w.currency)})` : 'set by DeepQr')}</div>
  ${isMgr() ? `<div class="actions" style="margin:-4px 0 16px;justify-content:flex-end"><button class="btn small" onclick="go('wallet')">${icon('wallet')}Top up or redeem a promo code</button></div>` : '<div style="height:12px"></div>'}`;
}
function qrCostBreakdown(n) {
  const w = wallet || {}; const free = Math.min(n, Number(w.free_remaining || 0)); const cost = (n - free) * Number(w.fee || 0);
  const bonus = Math.min(Number(w.bonus_balance || 0), cost); const main = cost - bonus;
  return { free, cost, bonus, main, ok: main <= Number(w.balance || 0) + Number(w.credit_limit || 0) };
}
function recRows() { return cache.recs.map(r => ({ ...r, p: productById(r.product_id), s: shopObj(r.shop_id) })).filter(r => r.p && r.s && (!search || (r.p.name + ' ' + r.p.code + ' ' + r.s.name).toLowerCase().includes(search.toLowerCase()))); }
function recsView() {
  const rows = recRows();
  return `<div class="card"><div class="cardHead"><div><h3>Recommended labels</h3><p>Stock on hand minus items that already have a QR label. Adjust quantities and generate in one go.</p></div><div class="actions"><button class="btn small" onclick="qrSelectAll()">Select all recommended</button><button class="btn small ghost" onclick="qrSel={};renderView()">Clear</button></div></div>
   <div class="tableWrap"><table><thead><tr><th>Product</th><th>Location</th><th class="right">In stock</th><th class="right">Labelled</th><th class="right">Recommended</th><th style="width:120px">Generate</th><th class="right">Cost</th></tr></thead><tbody>
   ${rows.sort((a, b) => b.recommended - a.recommended).map(r => { const k = r.product_id + '|' + r.shop_id; return `<tr><td><b>${esc(r.p.name)}</b> <span class="mono muted">${esc(r.p.code)}</span>${r.p.expiry_tracking ? ' <span class="tag warn">needs expiry</span>' : ''}</td><td>${esc(r.s.name)} <span class="mono muted">${esc(r.s.code || '')}</span></td><td class="right num">${num(r.stock_qty)}</td><td class="right num">${r.tagged}</td><td class="right num">${r.recommended ? `<span class="tag warn">${r.recommended}</span>` : '<span class="tag ok">Covered</span>'}</td><td>${canQR() ? `<input class="input" style="padding:6px 8px" type="number" min="0" max="5000" value="${qrSel[k] ?? ''}" placeholder="0" aria-label="Quantity for ${esc(r.p.name)}" oninput="qrSel['${k}']=this.value;updateQrSum()">` : ''}</td><td class="right num">${money(r.recommended * Number(r.fee))}</td></tr>`; }).join('') || `<tr><td colspan="7" class="empty">No stock recorded yet. Receive stock first.</td></tr>`}
   </tbody></table></div><div class="totals" id="qrSum">${qrSumHtml()}</div></div>`;
}
function qrSumHtml() {
  const n = Object.values(qrSel).reduce((a, v) => a + Math.max(0, Math.floor(Number(v) || 0)), 0); const b = qrCostBreakdown(n), w = wallet || {};
  return `<div class="row"><span>Selected QR codes</span><b class="num">${n}</b></div>${b.free ? `<div class="row"><span>Free this month</span><b class="num ok">${b.free}</b></div>` : ''}<div class="row"><span>Cost (${money(w.fee, w.currency)} each)</span><b class="num">${money(b.cost, w.currency)}</b></div>${b.bonus ? `<div class="row"><span>Paid from bonus</span><b class="num">${money(b.bonus, w.currency)}</b></div>` : ''}<div class="row"><span>From your balance</span><b class="num ${b.ok ? '' : 'bad'}">${money(b.main, w.currency)}</b></div>
  <div class="actions" style="margin-top:10px">${n && !b.ok ? `<span class="bad" style="font-weight:700">Not enough credit — </span><button class="btn small accent" onclick="go('wallet')">Top up</button>` : ''}<button class="btn primary" ${n && b.ok && canQR() ? '' : 'disabled'} onclick="generateSelected(this)">${icon('qr')}Generate ${n || ''} QR code(s)</button></div>`;
}
function updateQrSum() { const el = document.getElementById('qrSum'); if (el) el.innerHTML = qrSumHtml(); }
function qrSelectAll() { qrSel = {}; recRows().forEach(r => { if (r.recommended > 0) qrSel[r.product_id + '|' + r.shop_id] = r.recommended; }); renderView(); }
async function generateSelected(btn) {
  const jobs = Object.entries(qrSel).map(([k, v]) => ({ pid: k.split('|')[0], sid: k.split('|')[1], n: Math.max(0, Math.floor(Number(v) || 0)) })).filter(j => j.n > 0);
  const needsExp = jobs.filter(j => productById(j.pid)?.expiry_tracking);
  if (needsExp.length) { toast('Products that expire need an expiry date — generate them one at a time.', 'bad'); openGenerate(needsExp[0].pid, needsExp[0].sid, needsExp[0].n); return; }
  const total = sum(jobs, 'n'), b = qrCostBreakdown(total);
  confirmBox(`Generate ${total} QR code(s)?`, `${b.free ? b.free + ' free, ' : ''}${money(b.cost)} total${b.bonus ? `, ${money(b.bonus)} from bonus` : ''}. ${money(b.main)} comes from your wallet balance.`, 'Generate', async (ok) => {
    await withBusy(ok, async () => {
      const done = [];
      for (const j of jobs) {
        const r = await rpcToast('dq_generate_items', { p_product_id: j.pid, p_shop_id: j.sid, p_qty: j.n, p_expiry: null, p_batch: null });
        if (!r) break; done.push(r);
      }
      qrSel = {}; await loadDeepQr(); closeModal(); renderView();
      if (done.length) { toast(`${sum(done, 'qty')} QR code(s) generated`, 'ok'); if (done.length === 1) printGeneration(done[0].generation_id); }
    });
  });
}
function openGenerate(pid = '', sid = '', qty = '') {
  if (!canQR()) return;
  modal(`<div class="cardHead"><div><h3>Generate item QR codes</h3><p>Each code is unique to one item: <span class="mono">DQ1 | ${esc(business.code)} | shop | product | serial</span></p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
  <form id="genForm"><div class="formGrid">
   <div class="field"><label for="gp">Product</label><select id="gp" required>${cache.products.filter(p => p.active !== false).map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)} (${esc(p.code)})</option>`).join('')}</select></div>
   <div class="field"><label for="gs">Location the labels are for</label><select id="gs">${cache.shops.map(s => `<option value="${s.id}" ${s.id === sid ? 'selected' : ''}>${esc(s.name)} · ${esc(s.code || '')}</option>`).join('')}</select></div>
   <div class="field"><label for="gq">Number of QR codes</label><input id="gq" type="number" min="1" max="5000" value="${qty}" required></div>
   <div class="field"><label for="ge">Expiry date <span id="gexpReq" class="muted"></span></label><input id="ge" type="date" min="${dateOnly()}"></div>
   <div class="field"><label for="gb">Batch / lot (optional)</label><input id="gb" placeholder="e.g. LOT-0925"></div></div>
  <div class="grid g2" style="margin-top:16px;align-items:center"><div class="totals" id="genInfo" style="margin:0"></div><div style="text-align:center"><div class="qrPreview" id="genPreview"></div><div class="mono muted" id="genPreviewTxt" style="font-size:11px;margin-top:6px;word-break:break-all"></div></div></div>
  <div class="actions" style="margin-top:18px"><button class="btn primary lg" id="genBtn">${icon('qr')}Generate</button><button type="button" class="btn" onclick="closeModal()">Cancel</button></div></form>`);
  const upd = () => {
    const p = productById(document.getElementById('gp').value), s = shopObj(document.getElementById('gs').value);
    const rec = cache.recs.find(r => r.product_id === p?.id && r.shop_id === s?.id);
    const gq = document.getElementById('gq'); if (!gq.dataset.touched && !qty) gq.value = rec?.recommended || '';
    const n = Math.max(0, Number(gq.value) || 0), b = qrCostBreakdown(n), w = wallet || {};
    document.getElementById('gexpReq').textContent = p?.expiry_tracking ? '(required)' : '(optional)';
    document.getElementById('ge').required = !!p?.expiry_tracking;
    document.getElementById('genInfo').innerHTML = `<div class="row"><span>In stock here</span><b>${p && s ? stock(s.id, p.code) : 0}</b></div><div class="row"><span>Already labelled</span><b>${rec?.tagged ?? itemsFor(p?.id, s?.id).length}</b></div><div class="row"><span>Recommended</span><b class="warn">${rec?.recommended ?? 0} <button type="button" class="btn small" onclick="const g=document.getElementById('gq');g.value=${rec?.recommended || 0};g.dispatchEvent(new Event('input'))">Use</button></b></div>${b.free ? `<div class="row"><span>Free this month</span><b class="ok">${b.free}</b></div>` : ''}<div class="row"><span>Cost</span><b>${money(b.cost, w.currency)}</b></div>${b.bonus ? `<div class="row"><span>From bonus</span><b>${money(b.bonus, w.currency)}</b></div>` : ''}<div class="row"><span>From balance</span><b class="${b.ok ? '' : 'bad'}">${money(b.main, w.currency)}</b></div>`;
    document.getElementById('genBtn').disabled = !n || !b.ok;
    const yr = new Date().getFullYear(), next = cache.items.filter(i => i.product_id === p?.id && String(i.serial).startsWith(String(yr))).length + 1;
    const payload = `DQ1|${business.code}|${s?.code || ''}|${p?.code || ''}|${yr}${String(p?.product_no || 0).padStart(2, '0')}${String(next).padStart(3, '0')}`;
    document.getElementById('genPreview').innerHTML = qrSvg(payload, 3); document.getElementById('genPreviewTxt').textContent = 'Example: ' + payload;
  };
  ['gp', 'gs'].forEach(id => document.getElementById(id).addEventListener('change', () => { document.getElementById('gq').dataset.touched = ''; upd(); }));
  document.getElementById('gq').addEventListener('input', e => { e.target.dataset.touched = '1'; upd(); });
  upd();
  document.getElementById('genForm').onsubmit = async (e) => {
    e.preventDefault();
    await withBusy(document.getElementById('genBtn'), async () => {
      const r = await rpcToast('dq_generate_items', { p_product_id: document.getElementById('gp').value, p_shop_id: document.getElementById('gs').value, p_qty: Number(document.getElementById('gq').value), p_expiry: document.getElementById('ge').value || null, p_batch: document.getElementById('gb').value.trim() || null });
      if (!r) return;
      await loadDeepQr();
      toast(`${r.qty} QR code(s) generated${r.free ? ` (${r.free} free)` : ''} · ${money(r.total, r.currency)}`, 'ok');
      renderView(); printGeneration(r.generation_id);
    });
  };
}
function labelSettings() {
  const ls = lsJson('dq_label', { cols: 4, price: true, biz: true, expiry: true });
  modal(`<form id="lsF"><div class="cardHead"><div><h3>Label settings</h3><p>Saved on this device. Print at 100% scale.</p></div></div>
  <div class="formGrid"><div class="field"><label for="lsC">Labels per row (A4)</label><select id="lsC">${[2, 3, 4, 5, 6].map(c => `<option ${Number(ls.cols) === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>
  <div class="actions" style="margin-top:12px"><label class="chk"><input type="checkbox" id="lsP" ${ls.price ? 'checked' : ''}> Show price</label><label class="chk"><input type="checkbox" id="lsB" ${ls.biz ? 'checked' : ''}> Show business name</label><label class="chk"><input type="checkbox" id="lsE" ${ls.expiry ? 'checked' : ''}> Show expiry date</label></div>
  <div class="actions" style="margin-top:14px"><button class="btn primary">Save</button></div></form>`, 'narrow');
  document.getElementById('lsF').onsubmit = (e) => { e.preventDefault(); lsSet('dq_label', JSON.stringify({ cols: Number(document.getElementById('lsC').value), price: document.getElementById('lsP').checked, biz: document.getElementById('lsB').checked, expiry: document.getElementById('lsE').checked })); closeModal(); toast('Label settings saved', 'ok'); };
}
function labelHtml(it, p, s) {
  const ls = lsJson('dq_label', { cols: 4, price: true, biz: true, expiry: true });
  return `<div class="qrLabel">${ls.biz ? `<div class="lbBiz">${esc(business.name)}</div>` : ''}<div class="lbName">${esc(p?.name || '')}</div>${qrSvg(it.qr_payload, 3)}<div class="lbSerial">${esc(it.serial)}</div><div class="lbMeta">${esc(p?.code || '')} · ${esc(s?.code || '')}${ls.price ? ' · ' + money(p?.price) : ''}${ls.expiry && it.expiry_date ? ' · EXP ' + esc(it.expiry_date) : ''}${it.status && it.status !== 'in_stock' ? ' · ' + it.status.toUpperCase() : ''}</div></div>`;
}
async function printGeneration(genId, onlyIds) {
  const g = cache.generations.find(x => x.id === genId);
  let qy = sb.from('product_items').select('*').eq('generation_id', genId).order('serial_seq');
  const { data: items, error } = await qy; if (error) { toast(error.message, 'bad'); return; }
  const list = (items || []).filter(i => !onlyIds || onlyIds.includes(i.id));
  const p = productById(g?.product_id || list[0]?.product_id), s = shopObj(g?.shop_id || list[0]?.shop_id);
  const cols = lsJson('dq_label', { cols: 4 }).cols || 4;
  modal(`<div class="cardHead noPrint"><div><h3>${list.length} QR label(s) — ${esc(p?.name || '')}</h3><p>Stick one label on each item. Serials ${esc(g?.first_serial || '')} → ${esc(g?.last_serial || '')}.</p></div><div class="actions"><button class="btn" onclick="labelSettings()">${icon('settings')}</button><button class="btn primary" onclick="printModal()">${icon('printer')}Print labels</button><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div></div>
   <div class="labelSheet cols${cols}">${list.map(it => labelHtml(it, p, s)).join('') || '<p class="muted">No labels in this batch.</p>'}</div>`, 'wide');
}
function batchesView() {
  const list = cache.generations.filter(g => !search || ((productById(g.product_id)?.name || '') + ' ' + g.first_serial + ' ' + g.last_serial + ' ' + (g.batch_ref || '')).toLowerCase().includes(search.toLowerCase()));
  const unsold = id => cache.items.filter(i => i.generation_id === id).length;
  return `<div class="card"><div class="toolbar"><input class="input grow" id="batchSearch" value="${esc(search)}" oninput="liveSearch(this)" placeholder="Search product, serial or batch…">${canQR() ? `<button class="btn primary" id="orderPrintBtn" onclick="const ids=[...document.querySelectorAll('.genChk:checked')].map(c=>c.value);if(!ids.length){toast('Tick the batches you want DeepQr to print','bad');return}openPrintOrder(ids)">${icon('printer')}Order printing from DeepQr</button>` : ''}</div>
  <p class="muted" style="margin:0 0 10px;font-size:13px">Print labels yourself with <b>Labels</b>, or tick batches and let DeepQr print durable sticker labels for you by a date you choose.</p><div class="tableWrap"><table><thead><tr><th style="width:30px"></th><th>Date</th><th>Product</th><th>Location</th><th class="right">Qty</th><th>Serials</th><th>Expiry</th><th class="right">Charged</th><th>By</th><th></th></tr></thead><tbody>
  ${list.map(g => `<tr><td>${unsold(g.id) ? `<input type="checkbox" class="genChk" value="${g.id}" aria-label="Select batch">` : ''}</td><td>${fmtDT(g.created_at)}</td><td><b>${esc(productById(g.product_id)?.name || '—')}</b>${g.batch_ref ? `<span class="sub">Lot ${esc(g.batch_ref)}</span>` : ''}</td><td>${esc(shopObj(g.shop_id)?.name || '—')}</td><td class="right num">${g.qty}<span class="sub">${unsold(g.id)} unsold</span></td><td class="mono" style="font-size:12px">${esc(g.first_serial || '')} → ${esc(g.last_serial || '')}</td><td>${g.expiry_date ? expiryTag(g.expiry_date) : '—'}</td><td class="right num">${money(g.total)}${g.free_qty ? `<span class="sub">${g.free_qty} free</span>` : ''}${Number(g.bonus_used) ? `<span class="sub">${money(g.bonus_used)} bonus</span>` : ''}${g.refunded_qty ? `<span class="sub ok">${g.refunded_qty} refunded</span>` : ''}</td><td>${esc(g.by_name || '')}</td>
  <td><div class="actions" style="justify-content:flex-end;flex-wrap:nowrap"><button class="btn small" onclick="printGeneration('${g.id}')">${icon('printer')}Labels</button>${isMgr() ? `<button class="btn small ghost" title="Cancel unsold labels" onclick="voidBatch('${g.id}')">${icon('ban')}</button>` : ''}</div></td></tr>`).join('') || `<tr><td colspan="10" class="empty">No QR codes generated yet.</td></tr>`}
  </tbody></table></div></div>`;
}
function voidBatch(id) {
  askBox('Cancel unsold labels in this batch?', 'Labels that are lost, damaged or printed by mistake can be cancelled so nobody can sell with them. Sold labels are not affected. Ask DeepQr if you want the unused labels refunded.', { label: 'Reason', required: true }, 'Cancel labels', async (reason) => {
    const n = await rpcToast('dq_void_generation', { p_generation_id: id, p_reason: reason }); if (n === undefined) return;
    closeModal(); await loadDeepQr(); renderView(); toast(`${n} label(s) cancelled`, 'ok');
  });
}
function findLabelView() {
  return `<div class="card"><div class="cardHead"><div><h3>Find a label</h3><p>Scan or type a QR / serial to see its full history: when it was printed, moved, sold and returned.</p></div></div>
  <form class="searchLine" onsubmit="event.preventDefault();findLabel()"><input class="input mono" id="findIn" placeholder="Scan a label or type a serial (e.g. 202612001)" aria-label="Serial or QR"><button class="btn primary">${icon('search')}Find</button>${Scanner.camSupported() ? `<button type="button" class="btn" onclick="Scanner.openCamera({title:'Scan a label to look it up',hint:'Point at one label.'})">${icon('camera')}</button>` : ''}</form>
  <div id="findOut"></div></div>`;
}
async function findLabel() {
  const v = document.getElementById('findIn').value.trim(); if (!v) return; const out = document.getElementById('findOut');
  const h = await rpc('dq_item_history', { p_serial: v }).catch(e => { out.innerHTML = `<p class="bad">${esc(errMsg(e))}</p>`; });
  if (!h) { if (out && !out.innerHTML) out.innerHTML = `<div class="banner warn">${icon('alert')}<div><b>No label found for “${esc(v)}”</b><p>Check the serial. Labels from another business cannot be looked up.</p></div></div>`; Scanner.feedback(false, 'Not found'); return; }
  closeModal(); Scanner.feedback(true, 'Found ' + h.item.serial);
  const it = h.item, p = h.product, st = { in_stock: ['ok', 'In stock'], sold: ['info', 'Sold'], void: ['bad', 'Cancelled'], transit: ['warn', 'On a transfer'] }[it.status] || ['gray', it.status];
  out.innerHTML = `<div class="grid g2" style="margin-top:12px"><div><div class="qrPreview">${qrSvg(it.qr_payload, 3)}</div><div class="mono-big" style="margin-top:8px">${esc(it.serial)}</div><p><span class="tag ${st[0]}">${st[1]}</span> ${it.expiry_date ? expiryTag(it.expiry_date) : ''}</p></div>
  <dl class="kv"><dt>Product</dt><dd>${esc(p?.name || '')} <span class="mono muted">${esc(p?.code || '')}</span></dd><dt>Location</dt><dd>${esc(h.shop || '—')}</dd><dt>Batch</dt><dd>${h.generation ? `${fmtDT(h.generation.created_at)} by ${esc(h.generation.by_name || '')}${h.generation.batch_ref ? ' · lot ' + esc(h.generation.batch_ref) : ''}` : '—'}</dd><dt>Sale</dt><dd>${h.sale ? `<button class="priceBtn" onclick="showReceiptById('${h.sale.id}')">${esc(h.sale.receipt)}</button> · ${fmtD(h.sale.date)} · ${esc(h.sale.customer || '')} · ${esc(h.sale.status)}` : '—'}</dd><dt>Transfers</dt><dd>${(h.transfers || []).map(t => `${fmtD(t.date)}: ${esc(t.from)} → ${esc(t.to)} (${t.status})`).join('<br>') || '—'}</dd></dl></div>
  <div class="actions" style="margin-top:12px"><button class="btn" onclick="printGeneration('${it.generation_id}',['${it.id}'])">${icon('printer')}Reprint this label</button>${isMgr() && it.status === 'in_stock' ? `<button class="btn danger" onclick="voidOne('${it.id}')">${icon('ban')}Cancel this label</button>` : ''}</div>`;
}
function voidOne(id) { askBox('Cancel this label?', 'Use this when a label is lost or damaged. Print a replacement from a new batch.', { label: 'Reason', required: true }, 'Cancel label', async (reason) => { const n = await rpcToast('dq_void_items', { p_item_ids: [id], p_reason: reason }, 'Label cancelled'); if (n !== undefined) { closeModal(); await loadDeepQr(); findLabel(); } }); }

/* ---------------- expiry ---------------- */
let expiryFilter = 'attention';
function expiryTag(ds) { const d = daysUntil(ds); if (d === null) return ''; if (d < 0) return `<span class="tag bad">Expired ${-d}d ago</span>`; if (d === 0) return `<span class="tag bad">Expires today</span>`; if (d <= 7) return `<span class="tag warn">${d} day(s) left</span>`; if (d <= Number(business?.expiry_alert_days || 30)) return `<span class="tag warn">${d} days left</span>`; return `<span class="tag ok">${fmtD(ds)}</span>`; }
function expiryGroups() {
  const map = {};
  cache.items.filter(i => i.expiry_date && i.status === 'in_stock' && (me.role !== 'cashier' || i.shop_id === me.shop_id)).forEach(i => { const k = i.product_id + '|' + i.shop_id + '|' + i.expiry_date; (map[k] = map[k] || { product_id: i.product_id, shop_id: i.shop_id, expiry_date: i.expiry_date, items: [] }).items.push(i); });
  const lot = {}; cache.purchases.filter(p => p.expiry_date && (me.role !== 'cashier' || p.shop_id === me.shop_id)).forEach(p => { const k = p.product_id + '|' + p.shop_id + '|' + p.expiry_date; if (!map[k]) (lot[k] = lot[k] || { product_id: p.product_id, shop_id: p.shop_id, expiry_date: p.expiry_date, items: [], qty: 0 }).qty += Number(p.qty); });
  return [...Object.values(map), ...Object.values(lot)].sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
}
PAGES.expiry = {
  title: 'Expiry tracker', sub: 'Find expired and soon-to-expire stock before it reaches a customer',
  render: () => {
    const days = Number(business?.expiry_alert_days || 30), all = expiryGroups();
    const exp = all.filter(g => daysUntil(g.expiry_date) < 0), week = all.filter(g => { const d = daysUntil(g.expiry_date); return d >= 0 && d <= 7; }), soon = all.filter(g => { const d = daysUntil(g.expiry_date); return d > 7 && d <= days; });
    const list = { attention: [...exp, ...week, ...soon], expired: exp, week, soon: [...week, ...soon], all }[expiryFilter] || all;
    const cnt = a => a.reduce((s, g) => s + (g.items.length || g.qty || 0), 0);
    const val = a => a.reduce((s, g) => s + (g.items.length || g.qty || 0) * Number(productById(g.product_id)?.cost || 0), 0);
    return `<div class="grid g4">${kpi('alert', 'Expired', `<span class="bad">${cnt(exp)}</span>`, `${money(val(exp))} at cost`, 'bad')}${kpi('clock', 'Within 7 days', `<span class="warn">${cnt(week)}</span>`, 'sell or discount now', 'warn')}${kpi('clock', `Within ${days} days`, cnt(soon) + cnt(week), 'alert window')}${kpi('shield', 'Expired sales', business.block_expired_sales ? 'Blocked' : 'Allowed', business.block_expired_sales ? 'the till refuses expired items' : 'warning only', 'teal')}</div>
    <div class="card" style="margin-top:16px"><div class="pillRow">${[['attention', 'Needs attention'], ['expired', 'Expired'], ['week', 'Next 7 days'], ['soon', `Next ${days} days`], ['all', 'All dated stock']].map(([k, l]) => `<button class="pill ${expiryFilter === k ? 'active' : ''}" onclick="expiryFilter='${k}';renderView()">${l}</button>`).join('')}</div>
    <div class="tableWrap"><table><thead><tr><th>Product</th><th>Location</th><th>Expiry</th><th>Status</th><th class="right">Items</th><th>Serials</th><th class="right">Value</th><th></th></tr></thead><tbody>
    ${list.map(g => { const p = productById(g.product_id), n = g.items.length || g.qty || 0; return `<tr><td><b>${esc(p?.name || '—')}</b> <span class="mono muted">${esc(p?.code || '')}</span></td><td>${esc(shopObj(g.shop_id)?.name || '—')}</td><td>${fmtD(g.expiry_date)}</td><td>${expiryTag(g.expiry_date)}</td><td class="right num">${n}</td><td class="mono" style="font-size:11.5px;max-width:240px">${g.items.length ? esc(g.items.slice(0, 4).map(i => i.serial).join(', ')) + (g.items.length > 4 ? ` +${g.items.length - 4}` : '') : '<span class="muted">from a delivery (no labels)</span>'}</td><td class="right num">${money(n * Number(p?.price || 0))}</td><td>${g.items.length && isMgr() && daysUntil(g.expiry_date) < 0 ? `<button class="btn small danger" onclick="writeOffExpired('${g.items.map(i => i.id).join(',')}','${jsq(p?.name || '')}')">${icon('trash')}Write off</button>` : ''}</td></tr>`; }).join('') || `<tr><td colspan="8" class="empty">Nothing here. Dates come from QR batches and from deliveries with an expiry date.</td></tr>`}
    </tbody></table></div></div>`;
  }
};
function writeOffExpired(ids, name) {
  const arr = ids.split(',').filter(Boolean);
  confirmBox(`Write off ${arr.length} expired ${esc(name)}?`, 'Their labels are cancelled and stock is reduced, with an adjustment record.', 'Write off', async (b) => {
    await withBusy(b, async () => {
      const n = await rpcToast('dq_void_items', { p_item_ids: arr, p_reason: 'Expired — written off' }); if (n === undefined) return;
      const byShop = {}; cache.items.filter(i => arr.includes(i.id)).forEach(i => { byShop[i.shop_id + '|' + i.product_id] = (byShop[i.shop_id + '|' + i.product_id] || 0) + 1; });
      for (const [k, c] of Object.entries(byShop)) { const [sid, pid] = k.split('|'); const p = productById(pid); if (!p) continue; const old = stock(sid, p.code), nq = Math.max(0, old - c); setStockLocal(sid, p.code, nq); await persistStock(sid, p.code, nq); await sb.from('adjustments').insert({ business_id: me.business_id, shop_id: sid, product_id: pid, old_qty: old, new_qty: nq, reason: 'Expired items written off', by_name: me.name }); }
      closeModal(); await reloadAndRender(`${n} expired item(s) written off`);
    });
  }, 'danger');
}

/* ---------------- inventory ---------------- */
let invF = { shop: '', cat: '', status: '' };
PAGES.inventory = {
  title: 'Inventory', sub: 'Stock at every location, reorder suggestions, stock takes and corrections', searchable: true,
  actions: () => `<button class="btn" onclick="exportInventory()">${icon('download')}Export</button>`,
  render: () => {
    const tab = viewParams.tab || 'levels';
    const openCount = cache.counts.filter(c => c.status === 'open').length;
    const reorderN = reorderRows().length;
    const tabs = [['levels', 'Stock levels', 'layers'], ['reorder', 'Reorder', 'truck', reorderN || '', reorderN > 0], ['counts', 'Stock takes', 'clipboard', openCount || ''], ['stockin', 'Stock in', 'plus'], ['adjust', 'Corrections', 'edit']];
    const body = { levels: levelsView, reorder: reorderView, counts: countsView, stockin: stockInView, adjust: adjustView }[tab] || levelsView;
    return tabbar('invTabs', tabs.filter(t => t[0] !== 'reorder' || me.role !== 'cashier'), tab, 'invTab') + body();
  },
  after: () => { if (viewParams.tab === 'counts' && viewParams.count) bindCountScanner(); }
};
function invTab(t) { setTab('tab', t); }
function levelsView() {
  const stores = visibleStores().filter(s => !invF.shop || s.id === invF.shop); let rows = [];
  stores.forEach(s => cache.products.filter(p => p.active !== false && (!invF.cat || p.category === invF.cat)).forEach(p => rows.push({ s, p, q: stock(s.id, p.code), t: itemsFor(p.id, s.id).length })));
  if (invF.status === 'low') rows = rows.filter(x => x.q > 0 && x.q <= threshold(x.p)); if (invF.status === 'out') rows = rows.filter(x => x.q <= 0); if (invF.status === 'in') rows = rows.filter(x => x.q > 0);
  if (search) { const q = search.toLowerCase(); rows = rows.filter(x => (x.p.name + ' ' + x.p.code + ' ' + x.p.barcode + ' ' + x.s.name).toLowerCase().includes(q)); }
  const cost = sum(rows, x => x.q * x.p.cost), retail = sum(rows, x => x.q * x.p.price);
  return `<div class="grid g4">${kpi('layers', 'Units', num(sum(rows, 'q')), `${rows.filter(x => x.q > 0).length} product-locations in stock`)}${kpi('coins', 'Value at cost', money(cost), '')}${kpi('chart', 'Value at retail', money(retail), `potential profit ${money(retail - cost)}`, 'teal')}${kpi('alert', 'Low / out', rows.filter(x => x.q <= threshold(x.p)).length, 'at or below reorder level', 'warn')}</div>
  <div class="card" style="margin-top:16px"><div class="toolbar"><input class="input grow" id="invSearch" value="${esc(search)}" oninput="liveSearch(this)" placeholder="Search product, code or location…">
   ${me.role !== 'cashier' ? `<select class="input" onchange="invF.shop=this.value;renderView()" aria-label="Location"><option value="">All locations</option>${cache.shops.map(s => `<option value="${s.id}" ${invF.shop === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : ''}
   <select class="input" onchange="invF.cat=this.value;renderView()" aria-label="Category"><option value="">All categories</option>${cache.categories.map(c => `<option ${invF.cat === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
   <select class="input" onchange="invF.status=this.value;renderView()" aria-label="Status">${[['', 'Everything'], ['in', 'In stock'], ['low', 'Low'], ['out', 'Out of stock']].map(([k, l]) => `<option value="${k}" ${invF.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
  <div class="tableWrap"><table><thead><tr><th>Location</th><th>Product</th><th>Code</th><th class="right">On hand</th><th class="right">Labelled</th><th class="right">Reorder at</th><th class="right">Cost value</th><th class="right">Retail value</th><th>Status</th></tr></thead><tbody>
  ${rows.slice(0, 600).map(x => `<tr class="clickRow" onclick="openProductCard('${x.p.id}')"><td>${esc(x.s.name)}</td><td><b>${esc(x.p.name)}</b></td><td class="mono">${esc(x.p.code)}</td><td class="right num">${num(x.q)}</td><td class="right num">${x.t}</td><td class="right num">${threshold(x.p)}</td><td class="right num">${money(x.q * x.p.cost)}</td><td class="right num">${money(x.q * x.p.price)}</td><td>${statusTag(x.q, x.p)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No stock records.</td></tr>'}
  </tbody></table></div></div>`;
}
function exportInventory() {
  const rows = [['Location', 'Shop code', 'Product', 'Code', 'Category', 'On hand', 'Labelled', 'Reorder level', 'Cost', 'Price', 'Cost value', 'Retail value']];
  visibleStores().forEach(s => cache.products.forEach(p => { const qq = stock(s.id, p.code); rows.push([s.name, s.code || '', p.name, p.code, p.category, qq, itemsFor(p.id, s.id).length, threshold(p), p.cost, p.price, qq * p.cost, qq * p.price]); }));
  downloadCSV(`deepqr-inventory-${dateOnly()}.csv`, rows);
}
function reorderRows() {
  return cache.products.filter(p => p.active !== false).map(p => {
    const onHand = totalStock(p), lvl = threshold(p), s30 = salesQty30(p.id), daily = s30 / 30, incoming = onOrder(p.id);
    const target = Math.max(Number(p.reorder_qty || 0), Math.ceil(daily * 30), lvl * 2);
    const suggest = Math.max(0, Math.ceil(target - onHand - incoming));
    return { p, onHand, lvl, s30, daily, incoming, suggest, cover: daily ? Math.floor(onHand / daily) : null };
  }).filter(r => r.onHand <= r.lvl && r.suggest > 0).sort((a, b) => (a.cover ?? 999) - (b.cover ?? 999));
}
let reorderSel = {};
function reorderView() {
  const rows = reorderRows();
  return `<div class="card"><div class="cardHead"><div><h3>Reorder suggestions</h3><p>Products at or below their reorder level. Suggested quantity covers about 30 days of sales (or the product's reorder quantity), minus what is already on order.</p></div><button class="btn primary" onclick="reorderToPO()" ${rows.length ? '' : 'disabled'}>${icon('truck')}Create purchase order(s)</button></div>
  <div class="tableWrap"><table><thead><tr><th><input type="checkbox" aria-label="Select all" onchange="document.querySelectorAll('.roChk').forEach(c=>{c.checked=this.checked})" checked></th><th>Product</th><th>Supplier</th><th class="right">On hand</th><th class="right">Reorder at</th><th class="right">Sold 30d</th><th class="right">Days left</th><th class="right">On order</th><th style="width:110px">Order qty</th><th class="right">Cost</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td><input type="checkbox" class="roChk" data-id="${r.p.id}" checked aria-label="Select ${esc(r.p.name)}"></td><td><b>${esc(r.p.name)}</b> <span class="mono muted">${esc(r.p.code)}</span></td><td>${esc(supplierById(r.p.supplier_id)?.name || '—')}</td><td class="right num ${r.onHand <= 0 ? 'bad' : 'warn'}">${num(r.onHand)}</td><td class="right num">${r.lvl}</td><td class="right num">${num(r.s30)}</td><td class="right num">${r.cover ?? '—'}</td><td class="right num">${num(r.incoming)}</td><td><input class="input roQty" data-id="${r.p.id}" type="number" min="1" value="${r.suggest}" style="padding:5px 8px" aria-label="Order quantity"></td><td class="right num">${money(r.suggest * r.p.cost)}</td></tr>`).join('') || `<tr><td colspan="10" class="empty">Nothing needs reordering right now.</td></tr>`}
  </tbody></table></div></div>`;
}
function reorderToPO() {
  const picks = [...document.querySelectorAll('.roChk:checked')].map(c => ({ pid: c.dataset.id, qty: Number(document.querySelector(`.roQty[data-id="${c.dataset.id}"]`).value || 0) })).filter(x => x.qty > 0);
  if (!picks.length) { toast('Select at least one product', 'bad'); return; }
  const bySup = groupBy(picks, x => productById(x.pid)?.supplier_id || '');
  const first = Object.entries(bySup)[0];
  window.__poQueue = Object.entries(bySup).slice(1);
  openOrderEditor(null, { supplier_id: first[0] || '', items: first[1].map(x => ({ product_id: x.pid, qty_ordered: x.qty, unit_cost: productById(x.pid).cost })) });
  if (Object.keys(bySup).length > 1) toast(`${Object.keys(bySup).length} suppliers — one purchase order each. Save this one to open the next.`);
}
function stockInView() {
  const locked = me.role === 'cashier';
  const list = (locked ? cache.purchases.filter(x => x.shop_id === me.shop_id) : cache.purchases);
  return `<div class="card"><div class="cardHead"><div><h3>Quick stock in</h3><p>For goods that arrive without a purchase order (cash purchases, returns from customers you put back on the shelf). Use <button class="priceBtn" onclick="go('orders')">Purchase orders</button> for supplier deliveries.</p></div></div>
  <form id="purchaseForm" class="formGrid"><div class="field"><label for="ps">Location</label>${locked ? `<select id="ps" disabled><option value="${me.shop_id}">${esc(shopObj(me.shop_id)?.name)}</option></select>` : selectShops('ps')}</div><div class="field"><label for="pprod">Product</label><input id="pprod" list="p2" required placeholder="Code or name">${productOptions('p2')}</div><div class="field"><label for="pqty">Quantity</label><input id="pqty" type="number" min="1" required></div><div class="field"><label for="pcost">Cost / unit</label><input id="pcost" type="number" min="0" step="any" required></div><div class="field"><label for="pexpd">Expiry date</label><input id="pexpd" type="date"></div><div class="field"><label for="psup2">Supplier / source</label><input id="psup2" list="supList">${`<datalist id="supList">${cache.suppliers.map(s => `<option>${esc(s.name)}</option>`).join('')}</datalist>`}</div><div class="field"><label for="pref">Reference</label><input id="pref"></div><button class="btn primary">${icon('plus')}Receive</button></form></div>
  <div class="card"><div class="cardHead"><div><h3>Stock received</h3><p>Deliveries from purchase orders and quick stock-ins.</p></div></div><div class="tableWrap"><table><thead><tr><th>Date</th><th>Location</th><th>Product</th><th class="right">Qty</th><th class="right">Cost/unit</th><th class="right">Total</th><th>Expiry</th><th>Supplier</th><th>Reference</th><th>By</th></tr></thead><tbody>
  ${list.slice(0, 200).map(x => `<tr><td>${fmtD(x.date)}</td><td>${esc(shopObj(x.shop_id)?.name)}</td><td>${esc(productById(x.product_id)?.name || '')}</td><td class="right num">${x.qty}</td><td class="right num">${money(x.cost)}</td><td class="right num">${money(x.qty * x.cost)}</td><td>${x.expiry_date ? expiryTag(x.expiry_date) : '—'}</td><td>${esc(x.supplier || '')}</td><td>${esc(x.ref || '')}</td><td>${esc(x.by_name)}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">Nothing received yet.</td></tr>'}</tbody></table></div></div>`;
}
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'purchaseForm') return;
  e.preventDefault();
  const s = me.role === 'cashier' ? me.shop_id : document.getElementById('ps').value;
  const raw = document.getElementById('pprod').value.trim(); const p = product(raw) || cache.products.find(x => x.name.toLowerCase() === raw.toLowerCase());
  const qq = Number(document.getElementById('pqty').value), cost = Number(document.getElementById('pcost').value);
  if (!p || qq < 1) { toast('Choose a product from the list', 'bad'); return; }
  setStockLocal(s, p.code, stock(s, p.code) + qq); await persistStock(s, p.code, stock(s, p.code));
  const row = { business_id: me.business_id, shop_id: s, product_id: p.id, qty: qq, cost, supplier: document.getElementById('psup2').value.trim(), ref: document.getElementById('pref').value.trim(), by_name: me.name };
  const ed = document.getElementById('pexpd').value; if (ed) row.expiry_date = ed;
  const { data, error } = await sb.from('purchases').insert(row).select().single();
  if (error) { toast(errMsg(error), 'bad'); return; }
  cache.purchases.unshift(data); await logActivity('purchase', `${qq} × ${p.name} received at ${shopObj(s)?.name}`); await refreshRecs();
  renderView(); toast('Stock received', 'ok');
  if (canQR()) confirmBox(`Label these ${qq} ${esc(p.name)}?`, `Generate ${qq} QR code(s) now so every unit can be scanned at the till.`, 'Generate QR codes', () => { closeModal(); openGenerate(p.id, s, qq); });
});
function adjustView() {
  const stores = visibleStores(); let rows = [...cache.adjustments]; if (me.role === 'cashier') rows = rows.filter(a => a.shop_id === me.shop_id);
  return `${isMgr() ? `<div class="card"><div class="cardHead"><div><h3>Correct a stock count</h3><p>For one product. Use a stock take to count many products at once.</p></div></div>
  <form id="adjForm" class="formGrid"><div class="field"><label for="as">Location</label>${selectShops('as')}</div><div class="field"><label for="ap">Product</label><input id="ap" list="adjPlist" required placeholder="Code or name">${productOptions('adjPlist')}</div><div class="field"><label for="aq">Physical quantity now</label><input id="aq" type="number" min="0" required></div><div class="field"><label for="ar">Reason</label><select id="ar"><option>Count correction</option><option>Damaged</option><option>Stolen / missing</option><option>Expired</option><option>Used in shop</option><option>Found</option></select></div><button class="btn primary">Save correction</button></form></div>` : ''}
  <div class="card"><div class="cardHead"><div><h3>Correction history</h3><p>Every change with the reason and who made it.</p></div></div><div class="tableWrap"><table><thead><tr><th>Date</th><th>Location</th><th>Product</th><th class="right">Before</th><th class="right">After</th><th class="right">Change</th><th class="right">Value</th><th>Reason</th><th>By</th></tr></thead><tbody>
  ${rows.slice(0, 300).map(a => { const d = Number(a.new_qty) - Number(a.old_qty), p = productById(a.product_id); return `<tr><td>${fmtDT(a.created_at)}</td><td>${esc(shopObj(a.shop_id)?.name || '')}</td><td>${esc(p?.name || '')}</td><td class="right num">${num(a.old_qty)}</td><td class="right num">${num(a.new_qty)}</td><td class="right num ${d < 0 ? 'bad' : d > 0 ? 'ok' : ''}">${d > 0 ? '+' : ''}${num(d)}</td><td class="right num">${money(d * Number(p?.cost || 0))}</td><td>${esc(a.reason || '')}</td><td>${esc(a.by_name)}</td></tr>`; }).join('') || '<tr><td colspan="9" class="empty">No corrections yet.</td></tr>'}</tbody></table></div></div>`;
}
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'adjForm') return;
  e.preventDefault();
  const s = document.getElementById('as').value, raw = document.getElementById('ap').value.trim();
  const p = product(raw) || cache.products.find(x => x.name.toLowerCase() === raw.toLowerCase());
  if (!p) { toast('Choose a product from the list', 'bad'); return; }
  const n = Number(document.getElementById('aq').value), old = stock(s, p.code);
  setStockLocal(s, p.code, n); await persistStock(s, p.code, n);
  const { data: adj } = await sb.from('adjustments').insert({ business_id: me.business_id, shop_id: s, product_id: p.id, old_qty: old, new_qty: n, reason: document.getElementById('ar').value, by_name: me.name }).select().single();
  if (adj) cache.adjustments.unshift(adj);
  await logActivity('adjustment', `Stock corrected: ${p.name} at ${shopObj(s)?.name} (${old} → ${n})`); await refreshRecs();
  renderView(); toast('Correction saved', 'ok');
});

/* ---------------- stock takes ---------------- */
let countLines = [];
function countsView() {
  if (viewParams.count) return countScreen();
  const open = cache.counts.filter(c => c.status === 'open');
  return `<div class="card"><div class="cardHead"><div><h3>Start a stock take</h3><p>Count a whole location (or one category) by scanning labels and barcodes. DeepQr compares with the system and applies corrections in one step.</p></div></div>
  <form id="startCountF" class="formGrid"><div class="field"><label for="scS">Location</label>${me.role === 'cashier' ? `<select id="scS" disabled><option value="${me.shop_id}">${esc(shopObj(me.shop_id)?.name)}</option></select>` : selectShops('scS')}</div><div class="field"><label for="scC">Category</label><select id="scC"><option value="">All categories</option>${cache.categories.map(c => `<option>${esc(c.name)}</option>`).join('')}</select></div><div class="field"><label for="scN">Name</label><input id="scN" placeholder="Stock take ${fmtD(dateOnly())}"></div><button class="btn primary">${icon('clipboard')}Start</button></form></div>
  <div class="card"><div class="tableWrap"><table><thead><tr><th>Name</th><th>Location</th><th>Category</th><th>Status</th><th>Started</th><th>Applied</th><th></th></tr></thead><tbody>
  ${cache.counts.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(shopObj(c.shop_id)?.name || '')}</td><td>${esc(c.category || 'All')}</td><td>${c.status === 'open' ? '<span class="tag info">Open</span>' : c.status === 'applied' ? '<span class="tag ok">Applied</span>' : '<span class="tag gray">Cancelled</span>'}</td><td>${fmtDT(c.started_at)} · ${esc(c.started_by || '')}</td><td>${c.applied_at ? fmtDT(c.applied_at) + ' · ' + esc(c.applied_by || '') : '—'}</td><td><button class="btn small ${c.status === 'open' ? 'primary' : ''}" onclick="openCount('${c.id}')">${c.status === 'open' ? 'Continue counting' : 'View'}</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No stock takes yet.</td></tr>'}</tbody></table></div></div>`;
}
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'startCountF') return; e.preventDefault();
  const c = await rpcToast('dq_start_count', { p: { shop_id: document.getElementById('scS').value, category: document.getElementById('scC').value || null, name: document.getElementById('scN').value } }, 'Stock take started');
  if (c) { cache.counts.unshift(c); openCount(c.id); }
});
async function openCount(id) {
  const { data } = await sb.from('stock_count_lines').select('*').eq('count_id', id); countLines = data || [];
  viewParams.tab = 'counts'; viewParams.count = id; renderView();
}
function countScreen() {
  const c = cache.counts.find(x => x.id === viewParams.count); if (!c) return '';
  const open = c.status === 'open';
  const lines = countLines.map(l => ({ ...l, p: productById(l.product_id) })).filter(l => l.p).sort((a, b) => (a.counted === null) - (b.counted === null) || a.p.name.localeCompare(b.p.name));
  const counted = lines.filter(l => l.counted !== null), diff = counted.filter(l => Number(l.counted) !== Number(l.expected));
  const val = sum(diff, l => (Number(l.counted) - Number(l.expected)) * Number(l.p.cost || 0));
  return `<div class="actions" style="margin-bottom:12px"><button class="btn small" onclick="viewParams.count='';renderView()">← All stock takes</button><span class="chip">${esc(c.name)} · ${esc(shopObj(c.shop_id)?.name || '')}</span></div>
  <div class="grid g4">${kpi('clipboard', 'Counted', `${counted.length} / ${lines.length}`, 'products')}${kpi('alert', 'Differences', diff.length, 'products with a variance', diff.length ? 'warn' : '')}${kpi('coins', 'Value change', `<span class="${val < 0 ? 'bad' : val > 0 ? 'ok' : ''}">${money(val)}</span>`, 'at cost')}${kpi('qr', 'Labels scanned', sum(lines, l => (l.serials || []).length), 'unique serials')}</div>
  ${open ? `<div class="card" style="margin-top:16px"><div class="scanZone" id="scanZone" style="padding:14px"><b>Scan labels or barcodes to count</b><div class="muted" style="font-size:13px">Each label counts once. A product barcode adds 1 (or the quantity you set).</div>
  <form class="scanInput" onsubmit="event.preventDefault()"><input id="countIn" class="mono" autocomplete="off" placeholder="Scan or type a code, press Enter" aria-label="Scan to count"><input id="countQty" class="input" type="number" min="1" value="1" style="max-width:90px" aria-label="Quantity per barcode scan">${Scanner.camSupported() ? `<button type="button" class="btn" onclick="Scanner.openCamera({title:'Count with camera'})">${icon('camera')}</button>` : ''}</form><div class="lastScan" id="lastScan"></div></div></div>` : ''}
  <div class="card"><div class="tableWrap"><table><thead><tr><th>Product</th><th class="right">System</th><th style="width:120px">Counted</th><th class="right">Difference</th><th class="right">Value</th><th>Labels scanned</th></tr></thead><tbody>
  ${lines.map(l => { const d = l.counted === null ? null : Number(l.counted) - Number(l.expected); return `<tr><td><b>${esc(l.p.name)}</b> <span class="mono muted">${esc(l.p.code)}</span></td><td class="right num">${num(l.expected)}</td><td>${open ? `<input class="input" type="number" min="0" step="any" value="${l.counted ?? ''}" placeholder="—" style="padding:5px 8px" aria-label="Counted ${esc(l.p.name)}" onchange="setCount('${l.product_id}',this.value)">` : num(l.counted ?? '—')}</td><td class="right num ${d < 0 ? 'bad' : d > 0 ? 'ok' : ''}">${d === null ? '—' : (d > 0 ? '+' : '') + num(d)}</td><td class="right num">${d === null ? '' : money(d * Number(l.p.cost || 0))}</td><td class="mono" style="font-size:11px">${(l.serials || []).length ? esc(l.serials.slice(-3).join(', ')) + ((l.serials.length > 3) ? ` +${l.serials.length - 3}` : '') : ''}</td></tr>`; }).join('')}
  </tbody></table></div>
  ${open ? `<div class="actions" style="margin-top:14px"><button class="btn primary" onclick="applyCount()">${icon('check')}Apply ${diff.length} correction(s)</button><button class="btn" onclick="cancelCount()">Cancel stock take</button><span class="muted" style="font-size:12px">Products left blank are not changed. Sales during the count are taken into account.</span></div>` : ''}</div>`;
}
function bindCountScanner() {
  const inp = document.getElementById('countIn'); if (!inp) return; Scanner.bindInput(inp); setTimeout(() => inp.focus(), 30);
  Scanner.pushHandler('inventory', async (code) => {
    const r = await rpc('dq_count_scan', { p: { count_id: viewParams.count, code, qty: Number(document.getElementById('countQty')?.value || 1) } }).catch(e => { Scanner.feedback(false, errMsg(e)); });
    if (!r) return;
    if (r.duplicate) { Scanner.feedback(false, `${r.serial} already counted (${r.product})`); return; }
    if (!r.ok) { Scanner.feedback(false, r.reason === 'NOT_FOUND' ? 'Unknown code: ' + code : `${r.serial}: label is ${String(r.reason).toLowerCase()} — not counted`); return; }
    Scanner.feedback(true, `${r.product}: counted ${num(r.counted)} (system ${num(r.expected)})`);
    const { data } = await sb.from('stock_count_lines').select('*').eq('count_id', viewParams.count); countLines = data || [];
    const keep = document.getElementById('lastScan')?.innerHTML; renderView(); const l = document.getElementById('lastScan'); if (l && keep) l.innerHTML = keep;
  });
}
async function setCount(pid, v) { await rpcToast('dq_set_count', { p: { count_id: viewParams.count, product_id: pid, counted: v === '' ? null : Number(v) } }); const l = countLines.find(x => x.product_id === pid); if (l) l.counted = v === '' ? null : Number(v); renderView(); }
function applyCount() {
  confirmBox('Apply the stock take?', 'Stock levels are corrected for every counted product, with an adjustment record for each difference.', 'Apply corrections', async (b) => {
    await withBusy(b, async () => {
      const r = await rpcToast('dq_apply_count', { p: { count_id: viewParams.count } }); if (!r) return;
      closeModal(); viewParams.count = ''; await reloadAndRender(`${r.adjusted} product(s) corrected · value change ${money(r.value_change)}`);
    });
  });
}
function cancelCount() { confirmBox('Cancel this stock take?', 'Nothing is changed.', 'Cancel stock take', async () => { await rpcToast('dq_apply_count', { p: { count_id: viewParams.count, cancel: true } }); closeModal(); viewParams.count = ''; await reloadAndRender('Stock take cancelled'); }, 'danger'); }

/* ---------------- transfers ---------------- */
let trSerials = [];
PAGES.transfers = {
  title: 'Stock transfers', sub: 'Move stock and its QR labels between locations',
  render: () => {
    const locked = me.role === 'cashier';
    const list = locked ? cache.transfers.filter(t => t.from_shop === me.shop_id || t.to_shop === me.shop_id) : cache.transfers;
    const pending = list.filter(t => t.status === 'pending'), done = list.filter(t => t.status !== 'pending');
    const canReceive = t => isMgr() || t.to_shop === me.shop_id || can('can_manage_stock');
    return `<div class="card"><div class="cardHead"><div><h3>Send stock</h3><p>Stock leaves the sender straight away and arrives when the receiver confirms. Scan the labels you put in the box so they move with the goods.</p></div></div>
    <form id="transferForm"><div class="formGrid">
    <div class="field"><label for="tf">From</label>${locked ? `<select id="tf" disabled><option value="${me.shop_id}">${esc(shopObj(me.shop_id)?.name)}</option></select>` : selectShops('tf', null, { all: true })}</div>
    <div class="field"><label for="tt">To</label><select id="tt">${cache.shops.filter(s => !locked || s.id !== me.shop_id).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="tp">Product</label><input id="tp" list="plist" required placeholder="Code or name">${productOptions('plist')}</div>
    <div class="field"><label for="tq">Quantity</label><input id="tq" type="number" min="1" placeholder="or scan labels below"></div><div class="field"><label for="tn">Note</label><input id="tn"></div></div>
    <div class="scanZone" id="scanZone" style="margin-top:12px;padding:14px"><b>Labels in this transfer (optional)</b><div class="scanInput"><input id="trScan" class="mono" placeholder="Scan labels going in the box" aria-label="Scan labels for transfer">${Scanner.camSupported() ? `<button type="button" class="btn" onclick="Scanner.openCamera({title:'Scan labels for the transfer'})">${icon('camera')}</button>` : ''}</div><div class="serials" id="trSerials" style="justify-content:center;margin-top:8px">${trSerials.map((s, i) => `<span class="serialChip">${esc(s)}<button type="button" onclick="trSerials.splice(${i},1);renderView()">×</button></span>`).join('')}</div><div class="lastScan" id="lastScan"></div></div>
    <div class="actions" style="margin-top:12px"><button class="btn accent">${icon('transfer')}Send transfer</button></div></form></div>
    ${pending.length ? `<div class="card"><div class="cardHead"><div><h3>In transit</h3><p>Waiting for the receiving location to confirm. Enter the quantity that actually arrived.</p></div></div><div class="tableWrap"><table><thead><tr><th>Date</th><th>From</th><th>To</th><th>Product</th><th class="right">Sent</th><th>Labels</th><th>Sent by</th><th></th></tr></thead><tbody>${pending.map(t => `<tr><td>${fmtD(t.date)}</td><td>${esc(shopObj(t.from_shop)?.name)}</td><td>${esc(shopObj(t.to_shop)?.name)}</td><td>${esc(productById(t.product_id)?.name || '')}</td><td class="right num">${t.qty}</td><td>${(t.item_ids || []).length || '—'}</td><td>${esc(t.by_name)}</td><td><div class="actions" style="flex-wrap:nowrap">${canReceive(t) ? `<input class="input" id="rq_${t.id}" type="number" min="0" max="${t.qty}" value="${t.qty}" style="width:80px;padding:5px 8px" aria-label="Quantity received"><button class="btn small primary" onclick="receiveTransfer('${t.id}',this)">${icon('check')}Received</button>` : '<span class="muted">Waiting</span>'}${isMgr() || t.from_shop === me.shop_id ? `<button class="btn small ghost" onclick="cancelTransfer('${t.id}')" title="Cancel">${icon('x')}</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="card"><div class="cardHead"><div><h3>History</h3></div></div><div class="tableWrap"><table><thead><tr><th>Date</th><th>From</th><th>To</th><th>Product</th><th class="right">Sent</th><th class="right">Arrived</th><th>Status</th><th>Sent by</th><th>Received by</th><th>Note</th></tr></thead><tbody>${done.slice(0, 150).map(t => `<tr><td>${fmtD(t.date)}</td><td>${esc(shopObj(t.from_shop)?.name)}</td><td>${esc(shopObj(t.to_shop)?.name)}</td><td>${esc(productById(t.product_id)?.name || '')}</td><td class="right num">${t.qty}</td><td class="right num ${t.received_qty != null && Number(t.received_qty) < Number(t.qty) ? 'bad' : ''}">${t.status === 'cancelled' ? '—' : (t.received_qty ?? t.qty)}</td><td>${t.status === 'cancelled' ? '<span class="tag gray">Cancelled</span>' : '<span class="tag ok">Completed</span>'}</td><td>${esc(t.by_name)}</td><td>${esc(t.received_by || '—')}</td><td>${esc(t.note || '')}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">No transfers yet.</td></tr>'}</tbody></table></div></div>`;
  },
  after: () => {
    const inp = document.getElementById('trScan'); if (inp) Scanner.bindInput(inp);
    Scanner.pushHandler('transfers', async (code, src, parsed) => {
      if (!parsed.serial) { Scanner.feedback(false, 'Scan a DeepQr label (not a product barcode)'); return; }
      if (trSerials.includes(parsed.serial)) { Scanner.feedback(false, 'Already added: ' + parsed.serial); return; }
      const { data } = await sb.rpc('dq_lookup_item', { p_code: code });
      if (!data || data.kind !== 'item') { Scanner.feedback(false, 'Unknown label'); return; }
      if (data.item.status !== 'in_stock') { Scanner.feedback(false, `${data.item.serial} is ${data.item.status}`); return; }
      const tp = document.getElementById('tp'); const cp = product(tp.value);
      if (cp && cp.id !== data.product.id) { Scanner.feedback(false, `${data.item.serial} is ${data.product.name}, not ${cp.name}`); return; }
      tp.value = data.product.code; trSerials.push(data.item.serial);
      document.getElementById('tq').value = trSerials.length;
      document.getElementById('trSerials').innerHTML = trSerials.map((s, i) => `<span class="serialChip">${esc(s)}<button type="button" onclick="trSerials.splice(${i},1);renderView()">×</button></span>`).join('');
      Scanner.feedback(true, `${data.product.name} ${data.item.serial} added (${trSerials.length})`);
    });
  }
};
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'transferForm') return; e.preventDefault();
  const from = me.role === 'cashier' ? me.shop_id : document.getElementById('tf').value, to = document.getElementById('tt').value;
  const p = product(document.getElementById('tp').value.trim()) || cache.products.find(x => x.name.toLowerCase() === document.getElementById('tp').value.trim().toLowerCase());
  if (!p) { toast('Choose a product', 'bad'); return; }
  const t = await rpcToast('dq_send_transfer', { p: { from_shop: from, to_shop: to, product_id: p.id, qty: Number(document.getElementById('tq').value || 0), serials: trSerials, note: document.getElementById('tn').value } }, 'Transfer sent');
  if (!t) return; trSerials = []; await reloadAndRender();
});
async function receiveTransfer(id, btn) { await withBusy(btn, async () => { const r = await rpcToast('dq_receive_transfer', { p: { transfer_id: id, received_qty: Number(document.getElementById('rq_' + id)?.value) } }, 'Transfer received — stock updated'); if (r) await reloadAndRender(); }); }
function cancelTransfer(id) { confirmBox('Cancel this transfer?', 'The stock and any labels go back to the sending location.', 'Cancel transfer', async (b) => { await withBusy(b, async () => { const r = await rpcToast('dq_cancel_transfer', { p_id: id }, 'Transfer cancelled'); if (r) { closeModal(); await reloadAndRender(); } }); }, 'danger'); }
