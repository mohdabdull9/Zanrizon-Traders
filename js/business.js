/* =============================================================================
   Dashboard, expenses, stores, staff & permissions, devices & scanners,
   QR wallet (credits, bonuses, promo, referral) and business settings
   ============================================================================= */

/* ---------------- dashboard ---------------- */
PAGES.dashboard = {
  title: 'Dashboard', sub: () => `${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })} · ${esc(business.name)}`,
  actions: () => `${me.role !== 'inventory' && me.role !== 'main_operator' ? `<button class="btn primary" onclick="go('pos')">${icon('scan')}Scan &amp; Sell</button>` : ''}${canQR() ? `<button class="btn" onclick="go('qr')">${icon('qr')}QR codes</button>` : ''}`,
  render: () => {
    const today = dateOnly(), shops = visibleStores().map(s => s.id);
    const sales = cache.sales.filter(s => shops.includes(s.shop_id));
    const tSales = sales.filter(s => s.date === today), ySales = sales.filter(s => s.date === addDays(-1));
    const net = l => sum(l, s => Number(s.total) - Number(s.refunded_amount || 0));
    const lineProfit = ids => { const set = new Set(ids); return sum(cache.saleLines.filter(l => set.has(l.sale_id)), l => (Number(l.qty) - Number(l.refunded_qty || 0)) * (Number(l.price) - Number(l.cost ?? productById(l.product_id)?.cost ?? 0))); };
    const owed = sum(cache.customers, c => Math.max(0, Number(c.balance)));
    const low = [], out = [];
    visibleStores().forEach(st => cache.products.filter(p => p.active !== false).forEach(p => { const q = stock(st.id, p.code); if (q <= 0) out.push({ p, st }); else if (q <= threshold(p)) low.push({ p, st, q }); }));
    const alertDays = Number(business.expiry_alert_days || 30);
    const expired = cache.items.filter(i => i.status === 'in_stock' && i.expiry_date && daysUntil(i.expiry_date) < 0 && shops.includes(i.shop_id));
    const soon = cache.items.filter(i => i.status === 'in_stock' && i.expiry_date && daysUntil(i.expiry_date) >= 0 && daysUntil(i.expiry_date) <= alertDays && shops.includes(i.shop_id));
    const lateOrders = cache.orders.filter(o => OPEN_ORDER.includes(o.status) && o.expected_date && daysUntil(o.expected_date) < 0);
    const pendingDev = cache.devices.filter(d => d.status === 'pending');
    const incoming = cache.transfers.filter(t => t.status === 'pending' && shops.includes(t.to_shop));
    const supDue = cache.orders.filter(o => !['draft', 'cancelled'].includes(o.status) && Number(o.received_value) > 0 && orderBalance(o) > 0).filter(o => { const s = supplierById(o.supplier_id); const g = cache.receipts.find(r => r.order_id === o.id); return g && daysUntil(addDays(Number(s?.payment_terms_days || 0), dateOnly(g.received_at))) < 0; });
    const openShifts = cache.shifts.filter(s => s.status === 'open' && dateOnly(s.opened_at) < today);
    const lowBal = wallet && Number(wallet.balance || 0) + Number(wallet.bonus_balance || 0) < Number(wallet.low_balance_threshold || 500);
    const unlabelled = sum(cache.recs, 'recommended');
    const attention = [
      !(business.business_groups || []).length && isMgr() && ['Choose your business type to get ready-made products', 'info', 'catalog', 'Choose'],
      expired.length && [`${expired.length} expired item(s) still on the shelf`, 'bad', 'expiry', 'Remove them'],
      out.length && [`${out.length} product(s) out of stock`, 'bad', 'inventory', 'Reorder'],
      low.length && [`${low.length} product(s) running low`, 'warn', 'inventory', 'See list'],
      soon.length && [`${soon.length} item(s) expire within ${alertDays} days`, 'warn', 'expiry', 'Plan sales'],
      lateOrders.length && [`${lateOrders.length} purchase order(s) are late`, 'warn', 'orders', 'Follow up'],
      supDue.length && isMgr() && [`${supDue.length} supplier invoice(s) overdue (${money(sum(supDue, orderBalance))})`, 'bad', 'orders', 'Pay'],
      incoming.length && [`${incoming.length} transfer(s) waiting to be received`, 'info', 'transfers', 'Receive'],
      pendingDev.length && isMgr() && [`${pendingDev.length} device(s) waiting for approval`, 'info', 'devices', 'Review'],
      openShifts.length && isMgr() && [`${openShifts.length} till shift(s) left open from an earlier day`, 'warn', 'sales', 'Check'],
      unlabelled > 0 && canQR() && [`${num(unlabelled)} item(s) in stock have no QR label`, 'info', 'qr', 'Generate'],
      (cache.printOrders || []).filter(o => o.status === 'ready').length && [`${(cache.printOrders || []).filter(o => o.status === 'ready').length} printed label order(s) ready from DeepQr`, 'ok', 'qr', 'View', "{tab:'print'}"],
      lowBal && isMgr() && [`QR wallet is low (${money(Number(wallet.balance) + Number(wallet.bonus_balance), wallet.currency)})`, 'warn', 'wallet', 'Top up']
    ].filter(Boolean);
    const days = Array.from({ length: 14 }, (_, i) => addDays(i - 13)).map(d => { const l = sales.filter(s => s.date === d); return { label: fmtD(d), short: d.slice(8), sales: net(l), profit: lineProfit(l.map(s => s.id)) }; });
    const weekIds = new Set(sales.filter(s => s.date >= addDays(-6)).map(s => s.id));
    const top = Object.values(groupBy(cache.saleLines.filter(l => weekIds.has(l.sale_id)), l => l.product_id || l.code)).map(g => ({ name: g[0].name, qty: sum(g, l => l.qty - (l.refunded_qty || 0)), revenue: sum(g, l => (l.qty - (l.refunded_qty || 0)) * l.price) })).sort((a, b) => b.revenue - a.revenue).slice(0, 6);
    const stockVal = sum(visibleStores(), st => sum(cache.products, p => stock(st.id, p.code) * Number(p.cost || 0)));
    const seeSales = me.role !== 'inventory' && me.role !== 'main_operator';
    if (!insights && (isMgr() || isStoreOp())) loadInsights().then(() => { if (view === 'dashboard') { const el = document.getElementById('dashSug'); if (el) el.innerHTML = dashSuggestions(); } }).catch(() => {});
    return `${gettingStarted()}<div class="grid g4">
      ${seeSales ? kpi('cart', 'Sales today', money(net(tSales)), `${tSales.length} receipt(s) · yesterday ${money(net(ySales))}`) : kpi('box', 'Products', cache.products.filter(p => p.active !== false).length, `${cache.shops.length} location(s)`)}
      ${seeSales ? kpi('chart', 'Profit today', money(lineProfit(tSales.map(s => s.id))), 'before expenses', 'teal') : kpi('qr', 'Labelled items', num(cache.items.filter(i => i.status === 'in_stock').length), 'in stock with a QR', 'teal')}
      ${seeSales ? kpi('coins', 'Customers owe', money(owed), `${cache.customers.filter(c => Number(c.balance) > 0).length} customer(s)`, owed > 0 ? 'warn' : '') : kpi('truck', 'Open orders', cache.orders.filter(o => OPEN_ORDER.includes(o.status)).length, `${lateOrders.length} late`, lateOrders.length ? 'warn' : '')}
      ${kpi('layers', 'Stock value', money(stockVal), `${low.length} low · ${out.length} out`, out.length ? 'bad' : low.length ? 'warn' : '')}
     </div>
     <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="cardHead"><div><h3>Needs attention</h3><p>${attention.length ? 'Handle these to keep the business running smoothly.' : 'All clear — nothing needs you right now.'}</p></div></div>
       ${attention.map(a => `<div class="row"><span><span class="statusDot ${a[1]}"></span>${esc(a[0])}</span><button class="btn small" onclick="go('${a[2]}',${a[4] || '{}'})">${a[3]} ${icon('arrowRight')}</button></div>`).join('') || emptyState('check', 'Everything looks good', 'No low stock, expired items or late orders.')}</div>
      ${isMgr() && wallet ? `<div class="walletCard"><div class="lbl">QR wallet</div><div class="big">${money(Number(wallet.balance || 0) + Number(wallet.bonus_balance || 0), wallet.currency)}</div>
        <div class="row2"><span>Main ${money(wallet.balance, wallet.currency)}</span><span>Bonus ${money(wallet.bonus_balance, wallet.currency)}</span><span>${wallet.free_remaining || 0} free QR left this month</span></div>
        <div class="row2"><span>≈ ${num(Math.floor((Number(wallet.balance || 0) + Number(wallet.bonus_balance || 0)) / Math.max(Number(wallet.fee || 25), 0.01)) + Number(wallet.free_remaining || 0))} labels at ${money(wallet.fee, wallet.currency)} each</span></div>
        <div class="actions" style="margin-top:14px"><button class="btn" onclick="go('wallet')">${icon('plus')}Top up</button>${unlabelled ? `<button class="btn" onclick="go('qr')">${icon('qr')}Label ${num(unlabelled)} item(s)</button>` : ''}</div></div>`
      : `<div class="card"><div class="cardHead"><div><h3>Recent activity</h3></div></div>${activityHtml(8)}</div>`}
     </div>
     ${seeSales ? `<div class="grid g2"><div class="card"><div class="cardHead"><div><h3>Last 14 days</h3><p>Sales ${money(sum(days, 'sales'))} · profit ${money(sum(days, 'profit'))}</p></div>${can('can_view_reports') ? `<button class="btn small ghost" onclick="go('reports')">Reports ${icon('arrowRight')}</button>` : ''}</div>${barChart(days, [['sales', '#2F5BEA', 'Sales'], ['profit', '#14B8A6', 'Profit']], { h: 200, labels: 14 })}</div>
      <div class="card"><div class="cardHead"><div><h3>Best sellers this week</h3></div></div>${top.length ? hBars(top, 'name', 'revenue') : '<p class="muted">No sales this week yet.</p>'}</div></div>` : ''}
     ${isMgr() || isStoreOp() ? `<div class="card"><div class="cardHead"><div><h3>${icon('spark')} Smart suggestions</h3><p>What DeepQr recommends today, learned from your sales.</p></div><button class="btn small ghost" onclick="go('insights')">All suggestions ${icon('arrowRight')}</button></div><div id="dashSug">${dashSuggestions()}</div></div>` : ''}
     ${low.length || out.length ? `<div class="card"><div class="cardHead"><div><h3>Low and out of stock</h3></div><button class="btn small" onclick="go('inventory',{tab:'reorder'})">${icon('truck')}Reorder</button></div><div class="tableWrap"><table><thead><tr><th>Product</th><th>Location</th><th class="right">On hand</th><th class="right">Reorder at</th><th>Status</th></tr></thead><tbody>${out.slice(0, 6).map(x => `<tr><td>${esc(x.p.name)}</td><td>${esc(x.st.name)}</td><td class="right num">0</td><td class="right num">${threshold(x.p)}</td><td><span class="tag out">Out</span></td></tr>`).join('')}${low.slice(0, 8).map(x => `<tr><td>${esc(x.p.name)}</td><td>${esc(x.st.name)}</td><td class="right num">${x.q}</td><td class="right num">${threshold(x.p)}</td><td><span class="tag low">Low</span></td></tr>`).join('')}</tbody></table></div></div>` : ''}
     ${isMgr() && wallet ? `<div class="card"><div class="cardHead"><div><h3>Recent activity</h3></div></div>${activityHtml(10)}</div>` : ''}`;
  }
};
function dashSuggestions() { if (!insights) return '<p class="muted"><span class="spinner"></span> Analysing…</p>'; const l = buildSuggestions().slice(0, 3); return l.map(suggestionCard).join('') || '<p class="muted">No urgent suggestions — nice work.</p>'; }
function activityHtml(n) { return `<ul class="timeline">${cache.activity.slice(0, n).map(a => `<li>${esc(a.description)}<small>${esc(a.by_name || '')} · ${ago(a.created_at)}</small></li>`).join('') || '<li>No activity yet.<small>Sales, deliveries and changes appear here.</small></li>'}</ul>`; }

/* ---------------- expenses ---------------- */
const EXPENSE_CATS = ['Rent', 'Salaries & wages', 'Transport', 'Electricity & water', 'Airtime & internet', 'Repairs', 'Marketing', 'Taxes & licences', 'Bank & mobile-money fees', 'Supplies', 'Other'];
let expF = { range: 'month', cat: '', shop: '' };
PAGES.expenses = {
  title: 'Expenses', sub: 'Running costs that reduce your profit', searchable: true,
  actions: () => `<button class="btn" onclick="downloadCSV('expenses-${dateOnly()}.csv',[['Date','Category','Location','Amount','Description','By']].concat(filteredExpenses().map(e=>[e.date,e.category,shopObj(e.shop_id)?.name||'',e.amount,e.description,e.by_name])))">${icon('download')}Export</button>`,
  render: () => {
    const list = filteredExpenses(), byCat = Object.entries(groupBy(list, e => e.category || 'Other')).map(([k, v]) => ({ category: k, amount: sum(v, 'amount') })).sort((a, b) => b.amount - a.amount);
    const [from, to] = rangeDates(expF.range);
    const salesNet = sum(cache.sales.filter(s => s.date >= from && s.date <= to), s => Number(s.total) - Number(s.refunded_amount || 0));
    const cats = [...new Set([...EXPENSE_CATS, ...cache.expenses.map(e => e.category).filter(Boolean)])];
    return `<div class="grid g3">${kpi('minus', 'Total expenses', money(sum(list, 'amount')), `${list.length} record(s)`)}${kpi('chart', 'Share of sales', pct(sum(list, 'amount'), salesNet) + '%', `sales ${money(salesNet)}`, pct(sum(list, 'amount'), salesNet) > 30 ? 'warn' : '')}${kpi('tag', 'Biggest cost', esc(byCat[0]?.category || '—'), byCat[0] ? money(byCat[0].amount) : '')}</div>
    <div class="grid g2" style="margin-top:16px"><div class="card"><div class="cardHead"><div><h3>Record an expense</h3></div></div>
     <form id="expForm"><div class="formGrid"><div class="field"><label for="exC">Category *</label><input id="exC" list="exCats" required value="Rent"><datalist id="exCats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div><div class="field"><label for="exA">Amount *</label><input id="exA" type="number" min="1" step="any" required></div><div class="field"><label for="exD">Date</label><input id="exD" type="date" value="${dateOnly()}" max="${dateOnly()}"></div><div class="field"><label for="exS">Location</label>${selectShops('exS', me.shop_id || '', { all: true, any: 'Whole business' }).replace('id="exS"', 'id="exS"')}</div></div>
     <div class="field" style="margin-top:10px"><label for="exN">Description</label><input id="exN" placeholder="e.g. October rent, Kariakoo shop"></div><div class="actions" style="margin-top:12px"><button class="btn primary">${icon('plus')}Add expense</button></div></form></div>
     <div class="card"><div class="cardHead"><div><h3>By category</h3></div></div>${hBars(byCat, 'category', 'amount')}</div></div>
    <div class="card"><div class="toolbar"><input class="input grow" id="expSearch" value="${esc(search)}" oninput="liveSearch(this)" placeholder="Search description…"><select class="input" onchange="expF.range=this.value;renderView()">${RANGES.map(([k, l]) => `<option value="${k}" ${expF.range === k ? 'selected' : ''}>${l}</option>`).join('')}</select><select class="input" onchange="expF.cat=this.value;renderView()"><option value="">All categories</option>${cats.map(c => `<option ${expF.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>${selectShops('expShop', expF.shop, { all: true, any: 'All locations', onchange: 'expF.shop=this.value;renderView()' })}</div>
     <div class="tableWrap"><table><thead><tr><th>Date</th><th>Category</th><th>Location</th><th>Description</th><th class="right">Amount</th><th>By</th><th></th></tr></thead><tbody>${list.map(e => `<tr><td>${fmtD(e.date)}</td><td><span class="tag gray">${esc(e.category)}</span></td><td>${esc(shopObj(e.shop_id)?.name || 'Business')}</td><td>${esc(e.description || '')}</td><td class="right num">${money(e.amount)}</td><td>${esc(e.by_name || '')}</td><td>${isMgr() ? `<button class="btn small ghost" onclick="deleteExpense('${e.id}')" title="Delete">${icon('trash')}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No expenses in this period.</td></tr>'}</tbody></table></div></div>`;
  },
  after: () => {
    const f = document.getElementById('expForm'); if (!f) return;
    f.onsubmit = async e => {
      e.preventDefault();
      const row = { business_id: me.business_id, category: document.getElementById('exC').value.trim() || 'Other', amount: Number(document.getElementById('exA').value), date: document.getElementById('exD').value || dateOnly(), shop_id: document.getElementById('exS').value || null, description: document.getElementById('exN').value.trim(), by_name: me.name };
      if (!(row.amount > 0)) { toast('Enter the amount', 'bad'); return; }
      await withBusy(e.submitter, async () => {
        const { data, error } = await sb.from('expenses').insert(row).select().single();
        if (error) { toast(errMsg(error), 'bad'); return; }
        cache.expenses.unshift(data); await logActivity('expense', `Expense ${row.category}: ${money(row.amount)}`); renderView(); toast('Expense recorded', 'ok');
      });
    };
  }
};
function filteredExpenses() {
  const [from, to] = rangeDates(expF.range);
  let l = cache.expenses.filter(e => e.date >= from && e.date <= to);
  if (expF.cat) l = l.filter(e => e.category === expF.cat);
  if (expF.shop) l = l.filter(e => e.shop_id === expF.shop);
  if (search) { const q = search.toLowerCase(); l = l.filter(e => (e.description + ' ' + e.category).toLowerCase().includes(q)); }
  return l;
}
function deleteExpense(id) { confirmBox('Delete this expense?', 'It will be removed from reports.', 'Delete', async btn => { await withBusy(btn, async () => { const { error } = await sb.from('expenses').delete().eq('id', id); if (error) { toast(errMsg(error), 'bad'); return; } cache.expenses = cache.expenses.filter(e => e.id !== id); closeModal(); renderView(); }); }, 'danger'); }

/* ---------------- stores & shops ---------------- */
PAGES.stores = {
  title: 'Stores & shops', sub: 'Warehouses hold stock; shops sell it. Each has a short code printed in its QR labels.',
  actions: () => `<button class="btn primary" onclick="editShop()">${icon('plus')}Add location</button>`,
  render: () => `<div class="grid g3">${cache.shops.map(s => {
    const units = sum(cache.products, p => stock(s.id, p.code)), val = sum(cache.products, p => stock(s.id, p.code) * Number(p.cost || 0));
    const staff = cache.members.filter(m => m.shop_id === s.id && m.active !== false).length;
    const sales30 = sum(cache.sales.filter(x => x.shop_id === s.id && x.date >= addDays(-29)), x => Number(x.total) - Number(x.refunded_amount || 0));
    return `<div class="card" style="margin:0"><div class="cardHead"><div><h3>${icon(s.type === 'warehouse' ? 'layers' : 'store')} ${esc(s.name)}</h3><p>${s.type === 'warehouse' ? 'Warehouse / store' : 'Shop'} · code <b class="mono">${esc(s.code || '—')}</b></p></div>${s.blocked_by_platform ? '<span class="tag bad">Blocked by DeepQr</span>' : s.active === false ? '<span class="tag gray">Inactive</span>' : '<span class="tag ok">Active</span>'}</div>
     <dl class="kv"><dt>Stock</dt><dd>${num(units)} unit(s) · ${money(val)}</dd><dt>Labels</dt><dd>${num(cache.items.filter(i => i.shop_id === s.id && i.status === 'in_stock').length)} QR item(s)</dd>${s.type !== 'warehouse' ? `<dt>Sales 30 days</dt><dd>${money(sales30)}</dd>` : ''}<dt>Staff</dt><dd>${staff}</dd>${s.phone ? `<dt>Phone</dt><dd>${esc(s.phone)}</dd>` : ''}${s.address ? `<dt>Address</dt><dd>${esc(s.address)}</dd>` : ''}${s.blocked_by_platform && s.blocked_reason ? `<dt>Reason</dt><dd class="bad">${esc(s.blocked_reason)}</dd>` : ''}</dl>
     <div class="actions" style="margin-top:12px"><button class="btn small" onclick="editShop('${s.id}')">${icon('edit')}Edit</button><button class="btn small" onclick="go('inventory');invF.shop='${s.id}';renderView()">${icon('layers')}Stock</button></div></div>`;
  }).join('')}</div>`
};
function editShop(id) {
  const s = id ? shopObj(id) : { type: 'shop', active: true };
  modal(`<form id="shopF"><div class="cardHead"><div><h3>${id ? 'Edit location' : 'New location'}</h3><p>${id ? `Code <b class="mono">${esc(s.code || '')}</b> cannot change — it is printed on labels.` : 'A short code (S1, S2…) is given automatically.'}</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="formGrid"><div class="field"><label for="shN">Name *</label><input id="shN" required value="${esc(s.name || '')}" autofocus></div><div class="field"><label for="shT">Type</label><select id="shT"><option value="shop" ${s.type === 'shop' ? 'selected' : ''}>Shop (sells)</option><option value="warehouse" ${s.type === 'warehouse' ? 'selected' : ''}>Warehouse / store</option></select></div><div class="field"><label for="shP">Phone</label><input id="shP" value="${esc(s.phone || '')}"></div><div class="field"><label for="shA">Address</label><input id="shA" value="${esc(s.address || '')}"></div></div>
   ${id ? `<label class="chk" style="margin-top:10px"><input type="checkbox" id="shAct" ${s.active !== false ? 'checked' : ''}>Active (inactive locations stay in reports but cannot sell)</label>` : ''}
   <div class="actions" style="margin-top:14px"><button class="btn primary">${icon('check')}Save</button></div></form>`, 'narrow');
  document.getElementById('shopF').onsubmit = async e => {
    e.preventDefault();
    const row = { name: document.getElementById('shN').value.trim(), type: document.getElementById('shT').value, phone: document.getElementById('shP').value.trim() || null, address: document.getElementById('shA').value.trim() || null };
    if (id) row.active = document.getElementById('shAct').checked;
    await withBusy(e.submitter, async () => {
      const r = id ? await sb.from('shops').update(row).eq('id', id).select().single() : await sb.from('shops').insert({ ...row, business_id: me.business_id }).select().single();
      if (r.error) { toast(errMsg(r.error), 'bad'); return; }
      if (id) Object.assign(shopObj(id), r.data); else cache.shops.push(r.data);
      await logActivity('shop', `${id ? 'Updated' : 'Added'} location ${row.name}`); closeModal(); renderView(); toast('Location saved', 'ok');
    });
  };
}

/* ---------------- staff & permissions ---------------- */
const PERM_LIST = [
  ['can_edit_price', 'Change prices at the till', 'Override the selling price of an item'],
  ['can_sell_credit', 'Sell on credit', 'Let a customer pay later (adds to their debt)'],
  ['can_refund', 'Refunds and returns', 'Take items back and give money back'],
  ['can_view_reports', 'See reports', 'Sales, profit and payment reports'],
  ['can_receive_orders', 'Receive deliveries', 'Record goods arriving on purchase orders'],
  ['can_manage_stock', 'Manage stock', 'Corrections, stock takes, transfers and QR labels']
];
function permsOf(m) {
  if (m.role === 'owner' || m.role === 'manager') return { can_edit_price: true, can_sell_credit: true, can_refund: true, can_view_reports: true, can_receive_orders: true, can_manage_stock: true, max_discount_pct: 100 };
  return { can_edit_price: false, max_discount_pct: 10, can_sell_credit: true, can_refund: false, can_view_reports: false, can_receive_orders: true, can_manage_stock: ['inventory', 'main_operator'].includes(m.role), ...(m.permissions || {}) };
}
PAGES.users = {
  title: 'Staff', sub: 'Accounts, roles, shops and what each person may do',
  actions: () => `<button class="btn primary" onclick="addStaff()">${icon('plus')}Add staff</button>`,
  render: () => {
    const list = cache.members.slice().sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || a.name.localeCompare(b.name));
    const sales30 = id => { const m = cache.members.find(x => x.id === id); return sum(cache.sales.filter(s => s.cashier_name === m.name && s.date >= addDays(-29)), s => Number(s.total) - Number(s.refunded_amount || 0)); };
    return `<div class="grid g4">${kpi('users', 'Staff', list.filter(m => m.active !== false).length, `${list.filter(m => m.active === false).length} disabled`)}${kpi('scan', 'Cashiers', list.filter(m => m.role === 'cashier').length)}${kpi('layers', 'Store operators', list.filter(m => isStoreOpRole(m.role)).length)}${kpi('shield', 'Managers', list.filter(m => m.role === 'manager').length + 1, 'including the owner')}</div>
    <div class="card" style="margin-top:16px"><div class="tableWrap"><table><thead><tr><th>Name</th><th>Login</th><th>Role</th><th>Location</th><th>Permissions</th><th class="right">Sales 30d</th><th>Last seen</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(m => { const p = permsOf(m); const on = PERM_LIST.filter(x => p[x[0]]).length; return `<tr><td><div style="display:flex;gap:10px;align-items:center">${m.avatar ? `<img class="avatar" src="${m.avatar}" alt="">` : `<div class="avatar">${esc((m.name || 'U').slice(0, 1).toUpperCase())}</div>`}<div><b>${esc(m.name)}</b>${m.id === me.id ? ' <span class="tag info">You</span>' : ''}<br><small class="muted">${esc(m.phone || '')}</small></div></div></td><td class="mono">${esc(m.username || '(email login)')}</td><td><span class="tag info">${roleName(m.role)}</span></td><td>${esc(shopObj(m.shop_id)?.name || 'All locations')}</td><td>${m.role === 'owner' || m.role === 'manager' ? '<span class="muted">Full access</span>' : `${on}/${PERM_LIST.length} · discount ≤${p.max_discount_pct}%`}</td><td class="right num">${money(sales30(m.id))}</td><td>${m.last_seen ? ago(m.last_seen) : '—'}</td><td>${m.blocked_by_platform ? '<span class="tag bad">Blocked by DeepQr</span>' : m.active === false ? '<span class="tag gray">Disabled</span>' : '<span class="tag ok">Active</span>'}</td>
     <td>${canEditMember(m) ? `<div class="actions" style="flex-wrap:nowrap"><button class="btn small" onclick="editStaff('${m.id}')">${icon('edit')}Edit</button><button class="btn small ${m.active === false ? 'success' : 'ghost'}" onclick="toggleStaff('${m.id}')">${m.active === false ? icon('unlock') + 'Enable' : icon('ban')}</button></div>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div></div>
    <div class="card"><div class="cardHead"><div><h3>What each role can do</h3><p>Fine-tune any cashier or store operator with Edit → Permissions.</p></div></div><div class="tableWrap"><table style="min-width:0"><thead><tr><th></th><th>Owner</th><th>Manager</th><th>Store operator</th><th>Cashier</th></tr></thead><tbody>
     ${[['Sell, hold sales, take debt payments', 1, 1, 1, 1], ['Products, QR labels, stock, transfers', 1, 1, 1, 0], ['Purchase orders & suppliers', 1, 1, 1, 'receive only'], ['Pay suppliers, expenses', 1, 1, 0, 0], ['Staff, devices, settings, wallet', 1, 'not managers', 0, 0], ['Reports', 1, 1, 'if allowed', 'if allowed']].map(r => `<tr><td>${r[0]}</td>${r.slice(1).map(v => `<td>${v === 1 ? `<span class="ok">${icon('check')}</span>` : v === 0 ? '<span class="muted">—</span>' : `<small>${v}</small>`}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div></div>`;
  }
};
function isStoreOpRole(r) { return r === 'inventory' || r === 'main_operator'; }
function canEditMember(m) { if (m.role === 'owner' || m.id === me.id) return false; if (me.role === 'owner') return true; return me.role === 'manager' && m.role !== 'manager'; }
function rolesICanGive() { return me.role === 'owner' ? ['manager', 'inventory', 'cashier'] : ['inventory', 'cashier']; }
function readImageAsDataURL(file) { return new Promise((res, rej) => { if (!file) { res(null); return; } if (file.size > 1500000) { rej(new Error('Photo too large — use an image under 1.5 MB.')); return; } const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
function staffFormHtml(m) {
  const p = permsOf(m || { role: 'cashier' });
  return `<div class="formGrid"><div class="field"><label for="stN">Full name *</label><input id="stN" required value="${esc(m?.name || '')}"></div><div class="field"><label for="stPh">Phone</label><input id="stPh" type="tel" value="${esc(m?.phone || '')}"></div>
   ${m ? '' : `<div class="field"><label for="stU">Username *</label><input id="stU" required autocomplete="off" pattern="[a-zA-Z0-9._-]{3,30}" placeholder="e.g. amina"></div><div class="field"><label for="stP">Password *</label><input id="stP" type="text" required minlength="6" autocomplete="new-password" value="${Math.random().toString(36).slice(2, 6)}${Math.floor(1000 + Math.random() * 9000)}"></div>`}
   <div class="field"><label for="stR">Role *</label><select id="stR" onchange="document.getElementById('permBox').classList.toggle('hidden',this.value==='manager')">${rolesICanGive().map(r => `<option value="${r}" ${(m?.role === r || (r === 'inventory' && m?.role === 'main_operator')) ? 'selected' : ''}>${roleName(r)}</option>`).join('')}</select></div>
   <div class="field"><label for="stS">Location</label><select id="stS"><option value="">All locations</option>${cache.shops.map(s => `<option value="${s.id}" ${m?.shop_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select><small class="muted">Cashiers must have a shop.</small></div>
   <div class="field"><label for="stA">Photo</label><input id="stA" type="file" accept="image/*"></div></div>
   <div id="permBox" class="${m?.role === 'manager' ? 'hidden' : ''}"><h3 style="margin:18px 0 8px">Permissions</h3><div class="permGrid">${PERM_LIST.map(x => `<label class="chk" title="${esc(x[2])}"><input type="checkbox" id="pm_${x[0]}" ${p[x[0]] ? 'checked' : ''}><span>${x[1]}<br><small class="muted" style="font-weight:500">${x[2]}</small></span></label>`).join('')}</div>
   <div class="field" style="margin-top:10px;max-width:260px"><label for="pm_disc">Maximum discount at the till (%)</label><input id="pm_disc" type="number" min="0" max="100" value="${p.max_discount_pct}"></div></div>`;
}
function readPerms() { const o = {}; PERM_LIST.forEach(x => { o[x[0]] = document.getElementById('pm_' + x[0]).checked; }); o.max_discount_pct = Math.min(100, Math.max(0, Number(document.getElementById('pm_disc').value || 0))); return o; }
function addStaff() {
  modal(`<form id="staffF"><div class="cardHead"><div><h3>Add staff</h3><p>They sign in with the username and password — no email needed. Write the password down and give it to them.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>${staffFormHtml(null)}<div id="stErr" class="bad" style="min-height:20px;margin-top:10px"></div><div class="actions"><button class="btn primary">${icon('check')}Create account</button></div></form>`);
  document.getElementById('staffF').onsubmit = async e => {
    e.preventDefault();
    const err = document.getElementById('stErr'); err.textContent = '';
    const name = document.getElementById('stN').value.trim(), username = document.getElementById('stU').value.trim().toLowerCase().replace(/\s+/g, ''), password = document.getElementById('stP').value, role = document.getElementById('stR').value, shopId = document.getElementById('stS').value || null;
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) { err.textContent = 'Username: 3–30 letters, numbers, dot, dash or underscore.'; return; }
    if (role === 'cashier' && !shopId) { err.textContent = 'Choose the shop this cashier works at.'; return; }
    await withBusy(e.submitter, async () => {
      let avatar = null; try { avatar = await readImageAsDataURL(document.getElementById('stA').files[0]); } catch (x) { err.textContent = x.message; return; }
      const taken = await sb.rpc('dq_login_email', { p_username: username });
      if (taken.data) { err.textContent = 'That username is already taken. Try another (e.g. add a number).'; return; }
      const email = `${username}.${me.business_id.slice(0, 8)}@staff.local`;
      const temp = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'sb-temp-' + Date.now() } });
      const { data: sd, error: se } = await temp.auth.signUp({ email, password });
      if (se || !sd?.user) { err.textContent = se?.message?.includes('registered') ? 'That username is already taken.' : (se?.message || 'Could not create the login'); return; }
      const row = { business_id: me.business_id, auth_user_id: sd.user.id, name, username, role, shop_id: shopId, phone: document.getElementById('stPh').value.trim() || null, theme: 'light', avatar, permissions: role === 'manager' ? {} : readPerms() };
      const { data: mem, error: me2 } = await sb.from('members').insert(row).select().single();
      if (me2) { err.textContent = errMsg(me2); return; }
      await sb.from('username_directory').insert({ username, email, business_id: me.business_id });
      cache.members.push(mem); await logActivity('staff', `Staff account created: ${name} (${roleName(role)})`);
      modal(`<div class="cardHead"><div><h3>${icon('check')} Account ready</h3><p>Share these with ${esc(name)}. The password is not shown again.</p></div></div><dl class="kv"><dt>Username</dt><dd class="mono-big">${esc(username)}</dd><dt>Password</dt><dd class="mono-big">${esc(password)}</dd><dt>Sign-in page</dt><dd>${esc(location.origin + location.pathname)}</dd></dl><div class="actions" style="margin-top:14px"><button class="btn" onclick="copyText('Username: ${jsq(username)}  Password: ${jsq(password)}  Link: ${jsq(location.origin + location.pathname)}','Login copied')">${icon('copy')}Copy</button><button class="btn primary" onclick="closeModal();renderView()">Done</button></div>`, 'narrow');
    });
  };
}
function editStaff(id) {
  const m = cache.members.find(x => x.id === id);
  modal(`<form id="staffF"><div class="cardHead"><div><h3>Edit ${esc(m.name)}</h3><p>Login <b class="mono">${esc(m.username || '')}</b>. To reset a forgotten password, disable this account and create a new one.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>${staffFormHtml(m)}<div id="stErr" class="bad" style="min-height:20px;margin-top:10px"></div><div class="actions"><button class="btn primary">${icon('check')}Save</button><button type="button" class="btn danger" onclick="removeStaff('${id}')">${icon('trash')}Remove account</button></div></form>`);
  document.getElementById('staffF').onsubmit = async e => {
    e.preventDefault();
    const role = document.getElementById('stR').value, shopId = document.getElementById('stS').value || null;
    if (role === 'cashier' && !shopId) { document.getElementById('stErr').textContent = 'Choose the shop this cashier works at.'; return; }
    const patch = { name: document.getElementById('stN').value.trim(), phone: document.getElementById('stPh').value.trim() || null, role, shop_id: shopId, permissions: role === 'manager' ? {} : readPerms() };
    const f = document.getElementById('stA').files[0]; if (f) { try { patch.avatar = await readImageAsDataURL(f); } catch (x) { toast(x.message, 'bad'); return; } }
    await withBusy(e.submitter, async () => {
      const { error } = await sb.from('members').update(patch).eq('id', id);
      if (error) { document.getElementById('stErr').textContent = errMsg(error); return; }
      Object.assign(m, patch); await logActivity('staff', `Updated ${m.name}: ${roleName(role)}`); closeModal(); renderView(); toast('Saved', 'ok');
    });
  };
}
async function toggleStaff(id) {
  const m = cache.members.find(x => x.id === id), next = m.active === false;
  const { error } = await sb.from('members').update({ active: next }).eq('id', id);
  if (error) { toast(errMsg(error), 'bad'); return; }
  m.active = next; await logActivity('staff', `${next ? 'Enabled' : 'Disabled'} ${m.name}`); renderView(); toast(`${m.name} ${next ? 'can sign in again' : 'can no longer sign in'}`, 'ok');
}
function removeStaff(id) {
  const m = cache.members.find(x => x.id === id);
  confirmBox(`Remove ${esc(m.name)}?`, 'They will no longer be able to sign in. Their past sales stay in reports. Disabling is usually better.', 'Remove', async btn => {
    await withBusy(btn, async () => {
      const { error } = await sb.from('members').delete().eq('id', id); if (error) { toast(errMsg(error), 'bad'); return; }
      if (m.username) await sb.from('username_directory').delete().eq('username', m.username);
      cache.members = cache.members.filter(x => x.id !== id); await logActivity('staff', 'Removed ' + m.name); closeModal(); renderView();
    });
  }, 'danger');
}

/* ---------------- devices & scanners ---------------- */
PAGES.devices = {
  title: 'Devices & scanners', sub: 'Approve the phones, tablets and scanners that can sell, and set up scanning',
  render: () => {
    const tab = viewParams.tab || 'devices';
    return tabbar('devTabs', [['devices', 'Devices', 'phone', cache.devices.filter(d => d.status === 'pending').length || '', true], ['setup', 'Setup guide', 'info'], ['test', 'Test scanner', 'scan'], ['settings', 'Scanner settings', 'settings']], tab, 'devTab') +
      (tab === 'setup' ? devSetupView() : tab === 'test' ? devTestView() : tab === 'settings' ? devSettingsView() : devListView());
  },
  after: () => {
    if ((viewParams.tab || 'devices') === 'test') {
      const inp = document.getElementById('testInput'); if (inp) { Scanner.bindInput(inp); inp.focus(); }
      Scanner.pushHandler('devices', devTestScan);
    }
  }
};
function devTab(t) { Scanner.popHandler('devices'); setTab('tab', t); }
function devListView() {
  const mine = myDevice;
  return `<div class="card"><div class="cardHead"><div><h3>Rules for selling devices</h3><p>Choose who may sell and how items are scanned.</p></div></div>
   <div class="grid g2"><label class="chk" style="align-items:flex-start"><input type="checkbox" id="dvLock" ${business.device_lock ? 'checked' : ''} ${me.role === 'owner' || me.role === 'manager' ? '' : 'disabled'} onchange="saveBiz({device_lock:this.checked})"><span><b>Only approved devices can sell</b><br><small class="muted">Stops staff selling from their personal phones. New devices register and wait for your approval.</small></span></label>
    <div class="field"><label for="dvMode">Allowed scanning</label><select id="dvMode" onchange="saveBiz({scan_mode:this.value})"><option value="both" ${business.scan_mode === 'both' ? 'selected' : ''}>Camera and hardware scanners</option><option value="hardware" ${business.scan_mode === 'hardware' ? 'selected' : ''}>Hardware scanners only (USB / Bluetooth / POS)</option><option value="camera" ${business.scan_mode === 'camera' ? 'selected' : ''}>Phone / tablet camera only</option></select></div></div></div>
  <div class="card"><div class="cardHead"><div><h3>This device</h3><p>${mine ? `Registered as <b>${esc(mine.name)}</b> — ${devStatusTag(mine.status)}` : 'Not registered yet.'}</p></div>${mine ? `<button class="btn small" onclick="recheckDevice()">${icon('refund')}Refresh</button>` : ''}</div>${mine ? '' : registerDeviceForm()}</div>
  <div class="card"><div class="tableWrap"><table><thead><tr><th>Device</th><th>Type</th><th>Location</th><th>Registered by</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>
   ${cache.devices.map(d => `<tr><td><b>${esc(d.name)}</b>${mine && d.id === mine.id ? ' <span class="tag info">This device</span>' : ''}<br><small class="muted" title="${esc(d.user_agent || '')}">${esc(uaShort(d.user_agent))}</small></td><td>${devKind(d.kind)}</td><td><select class="input" style="padding:5px 8px" onchange="updDevice('${d.id}','${d.status}',null,this.value)"><option value="">Any location</option>${cache.shops.map(s => `<option value="${s.id}" ${d.shop_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></td><td>${esc(d.registered_by || '')}<br><small class="muted">${fmtD(d.created_at)}</small></td><td>${d.last_seen ? ago(d.last_seen) : '—'}</td><td>${devStatusTag(d.status)}</td>
    <td><div class="actions" style="flex-wrap:nowrap">${d.status !== 'approved' ? `<button class="btn small success" onclick="updDevice('${d.id}','approved')">${icon('check')}Approve</button>` : ''}${d.status !== 'blocked' ? `<button class="btn small" onclick="updDevice('${d.id}','blocked')">${icon('ban')}Block</button>` : ''}<button class="btn small ghost" onclick="delDevice('${d.id}')" title="Remove">${icon('trash')}</button></div></td></tr>`).join('') || `<tr><td colspan="7">${emptyState('phone', 'No devices yet', 'Register this device above. Staff devices appear here when they open Scan & Sell.')}</td></tr>`}
  </tbody></table></div></div>`;
}
function uaShort(ua) { ua = ua || ''; const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : ''; const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''; return [br, os].filter(Boolean).join(' on ') || 'Browser'; }
function devKind(k) { return { smartphone: `${icon('camera')} Phone / tablet camera`, scanner: `${icon('keyboard')} Hardware scanner`, both: `${icon('scan')} Camera + scanner` }[k] || k; }
function devStatusTag(s) { return s === 'approved' ? '<span class="tag ok">Approved</span>' : s === 'blocked' ? '<span class="tag bad">Blocked</span>' : '<span class="tag warn">Waiting approval</span>'; }
function registerDeviceForm() {
  const guess = /Android|iPhone|iPad/i.test(navigator.userAgent) ? 'smartphone' : 'scanner';
  const defName = (me.name.split(' ')[0] + "'s " + (/iPhone/i.test(navigator.userAgent) ? 'iPhone' : /iPad/i.test(navigator.userAgent) ? 'iPad' : /Android/i.test(navigator.userAgent) ? 'Android' : 'computer')).slice(0, 40);
  return `<form id="devRegF" class="formGrid" style="text-align:left;margin-top:12px" onsubmit="registerDevice(event)"><div class="field"><label for="dvN">Device name</label><input id="dvN" required value="${esc(defName)}" placeholder="e.g. Till 1 – Sunmi V2"></div>
   <div class="field"><label for="dvK">How this device scans</label><select id="dvK"><option value="smartphone" ${guess === 'smartphone' ? 'selected' : ''}>Its camera (phone / tablet)</option><option value="scanner" ${guess === 'scanner' ? 'selected' : ''}>A USB / Bluetooth / built-in scanner</option><option value="both">Both</option></select></div>
   <div class="field"><label for="dvS">Used at</label><select id="dvS"><option value="">Any location</option>${cache.shops.map(s => `<option value="${s.id}" ${me.shop_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
   <button class="btn primary">${icon('phone')}Register this device</button></form>`;
}
async function registerDevice(e) {
  e.preventDefault();
  await withBusy(e.submitter, async () => {
    const d = await rpcToast('dq_register_device', { p_key: deviceKey(), p_name: document.getElementById('dvN').value, p_kind: document.getElementById('dvK').value, p_shop_id: document.getElementById('dvS').value || null, p_ua: navigator.userAgent }, null);
    if (!d) return;
    myDevice = d; const { data } = await sb.from('devices').select('*').order('created_at', { ascending: false }); cache.devices = data || cache.devices;
    toast(d.status === 'approved' ? 'Device registered and approved' : 'Device registered — waiting for approval', 'ok'); render();
  });
}
async function recheckDevice() {
  const { data } = await sb.rpc('dq_device_status', { p_key: deviceKey() }); myDevice = data || null;
  const r = await sb.from('devices').select('*').order('created_at', { ascending: false }); cache.devices = r.data || cache.devices;
  render(); toast(myDevice ? 'Device status: ' + myDevice.status : 'This device is not registered', myDevice?.status === 'approved' ? 'ok' : '');
}
async function updDevice(id, status, kind, shopId) {
  const d = cache.devices.find(x => x.id === id);
  const r = await sb.rpc('dq_update_device', { p_id: id, p_status: status, p_kind: kind || d.kind, p_shop_id: shopId === undefined ? d.shop_id : (shopId || null) });
  if (r.error) { toast(errMsg(r.error), 'bad'); return; }
  toast('Device updated', 'ok');
  const { data } = await sb.from('devices').select('*').order('created_at', { ascending: false }); cache.devices = data || [];
  if (myDevice?.id === id) await recheckDevice(); else renderView();
}
function delDevice(id) { confirmBox('Remove this device?', 'It will have to register again (and be approved) before it can sell.', 'Remove', async btn => { await withBusy(btn, async () => { await rpcToast('dq_update_device', { p_id: id, p_status: 'blocked', p_delete: true }, 'Device removed'); cache.devices = cache.devices.filter(d => d.id !== id); if (myDevice?.id === id) myDevice = null; closeModal(); renderView(); }); }, 'danger'); }
async function saveBiz(patch, msg) {
  const { data, error } = await sb.from('businesses').update(patch).eq('id', business.id).select().single();
  if (error) { toast(errMsg(error), 'bad'); renderView(); return false; }
  business = data; toast(msg || 'Saved', 'ok'); renderView(); return true;
}
function devSetupView() {
  const g = (ic, t, sub, steps, tip) => `<div class="card"><h3 style="margin:0">${icon(ic)} ${t}</h3><p class="muted" style="margin:4px 0 0;font-size:13px">${sub}</p><ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>${tip ? `<p style="font-size:12.5px;margin:8px 0 0"><b>Tip:</b> ${tip}</p>` : ''}</div>`;
  return `<div class="banner info">${icon('info')}<div><b>Every scanner works the same way in DeepQr</b><p>Hardware scanners "type" the code like a keyboard. DeepQr catches that typing on Scan &amp; Sell, Stock take and Transfers — even when the scan box is not selected. Cameras read the QR directly. After setting up, use the <b>Test scanner</b> tab.</p></div></div>
  <div class="guide">
   ${g('camera', 'Phone or tablet camera', 'Any Android or iPhone with Chrome or Safari.', ['Open DeepQr with the <b>https://</b> link (the camera does not work on http).', 'Go to <b>Scan &amp; Sell</b> and tap <b>Scan with camera</b>.', 'Allow the camera when asked. The back camera is chosen automatically; use <b>Switch</b> if not.', 'Hold the label 10–20 cm away inside the square. Each code is added once; keep scanning, then tap <b>Done</b>.', 'Use the <b>Torch</b> button in poor light.'], 'If you refused the camera, tap the padlock next to the address and allow Camera, then reload.')}
   ${g('keyboard', 'USB barcode / QR scanner', 'Plug-and-play 2D scanners (Honeywell, Zebra, Netum, Eyoyo…).', ['Plug it into the computer. No driver is needed — it works as a keyboard.', 'Make sure it is a <b>2D</b> scanner: 1D-only scanners cannot read QR codes.', 'Set the scanner suffix to <b>Enter (CR)</b> using the setup barcodes in its manual (most are already set).', 'Set the scanner keyboard language to <b>US English</b> so symbols are not changed.', 'Open Scan &amp; Sell and scan a label. It goes straight into the cart.'], 'If codes arrive with strange symbols, DeepQr still reads the serial — but fixing the keyboard language makes them clean.')}
   ${g('bluetooth', 'Bluetooth scanner', 'Pocket or ring scanners used with a phone or tablet.', ['Put the scanner in <b>HID / keyboard</b> mode (not SPP), using the barcode in its manual.', 'Pair it in the phone\'s Bluetooth settings.', 'In <b>Scanner settings</b> turn on <b>Hide the on-screen keyboard</b> so the screen stays clear.', 'Open Scan &amp; Sell and scan. If nothing happens, tap the scan box once and try again.'], 'On iPhone/iPad the on-screen keyboard is hidden automatically when a Bluetooth keyboard is connected.')}
   ${g('terminal', 'Android POS terminal', 'Sunmi, Urovo, iData, Newland, Zebra handhelds with a built-in scanner.', ['Open the device\'s <b>Scanner</b> settings app.', 'Set output mode to <b>Keyboard / wedge / "input to text box"</b> — not "broadcast" or "intent".', 'Turn on <b>Add Enter (suffix)</b> and turn off any prefix.', 'Open DeepQr in Chrome, then menu → <b>Add to Home screen</b> for a full-screen till.', 'Register the device under <b>Devices</b> as "USB / Bluetooth / built-in scanner".'], 'If the side button opens a different app, set the scan key to "trigger scanner only".')}
  </div>
  <div class="card"><div class="cardHead"><div><h3>Labels that scan well</h3></div></div><ul style="margin:0;padding-left:18px;color:var(--muted);font-size:13.5px"><li>Print at <b>100% scale</b> (not "fit to page") on matte labels.</li><li>Keep labels flat and clean — curved bottles scan better with the QR across the curve, not around it.</li><li>Each QR is one item: it can only be sold once. Scanning it again shows "already sold".</li><li>Product barcodes (EAN/UPC) also work — they add one of that product.</li></ul></div>`;
}
let devTestLog = [];
function devTestView() {
  const sample = cache.items.find(i => i.status === 'in_stock');
  const p = sample ? productById(sample.product_id) : cache.products[0];
  const payload = sample?.qr_payload || `DQ1|${business.code || 'BIZ'}|${shopObj(me.shop_id)?.code || 'S1'}|${p?.code || 'D12'}|${new Date().getFullYear()}12001`;
  return `<div class="grid g2"><div class="card"><div class="scanZone" id="scanZone"><div class="bigIco">${icon('scan')}</div><b style="font-size:16px">Scan anything to test</b><div class="muted" style="font-size:13px">Nothing is sold here. Use a hardware scanner, the camera or type a code.</div>
    <form class="scanInput" onsubmit="event.preventDefault()"><input id="testInput" autocomplete="off" placeholder="Scanner ready…" aria-label="Test scan"><button type="button" class="btn primary" onclick="const i=document.getElementById('testInput');Scanner.emit(i.value,'typed');i.value=''">Test</button></form>
    <div class="actions" style="justify-content:center;margin-top:10px"><button class="btn" onclick="Scanner.openCamera({title:'Camera test',hint:'Scan the sample label on the other screen, or any label.'})">${icon('camera')}Test camera</button><button class="btn ghost" onclick="devTestLog=[];renderView()">Clear</button></div><div class="lastScan" id="lastScan"></div></div>
    <div id="testResult" style="margin-top:12px">${devTestResult()}</div></div>
   <div class="card"><div class="cardHead"><div><h3>Sample label</h3><p>Scan this from another device's camera or a scanner to check everything works.</p></div></div><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div style="width:150px;background:#fff;padding:6px;border-radius:8px">${qrSvg(payload, 3)}</div><div><div class="mono" style="font-size:12px;word-break:break-all">${esc(payload)}</div>${p?.barcode ? `<svg class="barcode-svg" data-barcode="${esc(p.barcode)}" data-height="40"></svg>` : ''}</div></div>
    <h3 style="margin:16px 0 8px">Recent scans on this device</h3><div class="scanLog" id="testLog">${testLogHtml()}</div></div></div>`;
}
function testLogHtml() {
  return `${Scanner.log.slice(0, 12).map(l => `<div><b>${esc(l.source)}</b> <span class="mono">${esc(l.code.slice(0, 60))}</span><small class="muted"> · ${l.parsed.type} · ${l.at.toLocaleTimeString()}</small></div>`).join('') || '<p class="muted">Nothing scanned yet.</p>'}`;
}
function devTestResult() {
  const l = devTestLog[0]; if (!l) return '';
  const p = l.parsed, rows = [['Read by', l.source], ['Raw text', l.code], ['Type', { qr: 'DeepQr item label', serial: 'Serial number', receipt: 'Receipt', code: 'Product code / barcode' }[p.type] || p.type]];
  if (p.type === 'qr') rows.push(['Business', p.biz + (p.biz === business.code ? ' ✓ yours' : ' ✗ another business')], ['Serial', p.serial], ...(p.sep && p.sep !== '|' ? [['Note', `The scanner changed "|" into "${p.sep}" — DeepQr handled it. Set the scanner keyboard to US English to fix.`]] : []));
  if (l.item) rows.push(['Item', l.item]);
  if (p.type === 'code') { const pr = product(l.code); rows.push(['Product', pr ? pr.name : 'not found — add this barcode to a product']); }
  return `<div class="banner ${l.ok && !l.msg ? 'ok' : 'warn'}">${icon(l.ok ? 'check' : 'alert')}<div><b>${l.ok ? 'Scanner works' : 'Scan received, check the details'}</b><p>${l.ok ? (l.msg ? esc(l.msg) + ' The scanner itself is working.' : 'This code will scan correctly at the till.') : esc(l.msg || '')}</p></div></div><dl class="kv">${rows.map(r => `<dt>${esc(r[0])}</dt><dd class="${r[0] === 'Raw text' ? 'mono' : ''}">${esc(r[1])}</dd>`).join('')}</dl>`;
}
async function devTestScan(code, source, parsed) {
  lsSet('dq_scan_tested', '1');
  const entry = { code, source, parsed, ok: false };
  try {
    if (parsed.type !== 'receipt') {
      const r = await rpc('dq_lookup_item', { p_code: code, p_shop_id: null, p_device_key: deviceKey() });
      const why = { SOLD: 'This label was already sold.', VOID: 'This label was cancelled.', IN_TRANSIT: 'This item is in transit between locations.', EXPIRED: 'This item has expired.', OTHER_BUSINESS: 'This label belongs to another business.', NOT_FOUND: 'Read correctly, but no label, product code or barcode matches it.' };
      if (r?.kind === 'item') { entry.ok = true; entry.item = `${r.product?.name || ''} · serial ${r.item?.serial || ''} · ${r.shop_name || ''}${r.reason ? ' · ' + r.reason.toLowerCase().replace('_', ' ') : ' · in stock'}`; entry.msg = r.reason ? why[r.reason] : ''; }
      else if (r?.kind === 'product') { entry.ok = true; entry.item = `Product ${r.product?.name} (${r.product?.code}) — adds one at the till`; }
      else { entry.ok = false; entry.msg = why[r?.reason] || r?.message || 'Not recognised.'; }
    }
    else entry.ok = true;
  } catch (e) { entry.msg = errMsg(e); }
  devTestLog.unshift(entry); Scanner.feedback(entry.ok, entry.ok ? 'Read: ' + code.slice(0, 40) : (entry.msg || 'Check details'));
  const el = document.getElementById('testResult'); if (el) el.innerHTML = devTestResult();
  const lg = document.getElementById('testLog'); if (lg) lg.innerHTML = testLogHtml();
}
function devSettingsView() {
  const c = Scanner.cfg();
  const sw = (id, label, sub, on) => `<label class="chk" style="align-items:flex-start;margin:8px 0"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} onchange="saveScanCfg()"><span><b>${label}</b><br><small class="muted" style="font-weight:500">${sub}</small></span></label>`;
  return `<div class="card"><div class="cardHead"><div><h3>Scanner settings for this device</h3><p>Saved on this device only. The defaults suit almost every scanner.</p></div><button class="btn small ghost" onclick="['dq_scan_min','dq_scan_gap','dq_scan_auto','dq_scan_cooldown','dq_scan_hidekb','dq_beep','dq_vibrate'].forEach(k=>{try{localStorage.removeItem(k)}catch(e){}});renderView();toast('Defaults restored','ok')">Restore defaults</button></div>
   <div class="formGrid"><div class="field"><label for="scMin">Shortest code (characters)</label><input id="scMin" type="number" min="3" max="30" value="${c.minLen}" onchange="saveScanCfg()"></div>
    <div class="field"><label for="scGap">Scanner typing speed (ms between characters)</label><input id="scGap" type="number" min="10" max="200" value="${c.gap}" onchange="saveScanCfg()"><small class="muted">Raise to 80–120 for slow Bluetooth scanners.</small></div>
    <div class="field"><label for="scCool">Ignore the same code again for (ms)</label><input id="scCool" type="number" min="200" max="5000" step="100" value="${c.cooldown}" onchange="saveScanCfg()"><small class="muted">Stops the camera adding one label twice.</small></div></div>
   ${sw('scAuto', 'Scanners without Enter', 'Accept a scan when fast typing stops, even if the scanner sends no Enter/Tab at the end.', c.autoSubmit)}
   ${sw('scKb', 'Hide the on-screen keyboard', 'For phones with a Bluetooth scanner or POS terminals: the scan box will not open the keyboard.', lsGet('dq_scan_hidekb') === '1')}
   ${sw('scBeep', 'Beep on scan', 'A short high beep for success, a low buzz for problems.', lsGet('dq_beep') !== '0')}
   ${sw('scVib', 'Vibrate on scan', 'On phones that support it.', lsGet('dq_vibrate') !== '0')}
   <div class="field" style="max-width:340px;margin-top:8px"><label>Preferred camera</label><div class="searchLine" style="margin:0"><input class="input" readonly value="${esc(lsGet('dq_cam_id') ? 'Saved (chosen in the camera window)' : 'Automatic (back camera)')}"><button class="btn" onclick="try{localStorage.removeItem('dq_cam_id')}catch(e){};renderView()">Reset</button></div></div></div>`;
}
function saveScanCfg() {
  const v = id => document.getElementById(id);
  lsSet('dq_scan_min', String(Math.max(3, Number(v('scMin').value) || 5))); lsSet('dq_scan_gap', String(Math.max(10, Number(v('scGap').value) || 50))); lsSet('dq_scan_cooldown', String(Math.max(200, Number(v('scCool').value) || 900)));
  lsSet('dq_scan_auto', v('scAuto').checked ? '1' : '0'); lsSet('dq_scan_hidekb', v('scKb').checked ? '1' : '0'); lsSet('dq_beep', v('scBeep').checked ? '1' : '0'); lsSet('dq_vibrate', v('scVib').checked ? '1' : '0');
  toast('Scanner settings saved on this device', 'ok');
}

/* ---------------- QR wallet ---------------- */
let topSel = { pkg: null, amount: '' };
PAGES.wallet = {
  title: 'QR Wallet', sub: () => `Credits pay for QR labels: ${money(wallet?.fee ?? platform.qr_fee, wallet?.currency)} per label${Number(wallet?.free_allowance) ? ` · ${wallet.free_allowance} free every month` : ''}`,
  actions: () => `<button class="btn" onclick="refreshWallet().then(()=>loadDeepQr()).then(renderView)">${icon('refund')}Refresh</button>`,
  render: () => {
    const w = wallet || {}, tab = viewParams.tab || 'topup';
    const total = Number(w.balance || 0) + Number(w.bonus_balance || 0);
    const labels = Math.floor(total / Math.max(Number(w.fee || 25), 0.01)) + Number(w.free_remaining || 0);
    const pend = cache.topups.filter(t => t.status === 'pending');
    const monthStart = dateOnly(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const used = cache.generations.filter(g => dateOnly(g.created_at) >= monthStart);
    return `${w.status === 'suspended' ? '' : ''}<div class="walletHero"><div class="walletCard"><div class="lbl">Available for QR labels</div><div class="big">${money(total, w.currency)}</div><div class="row2"><span>≈ ${num(labels)} labels</span><span>${num(w.total_qr || 0)} printed all-time</span>${Number(w.credit_limit) ? `<span>credit allowed ${money(w.credit_limit, w.currency)}</span>` : ''}</div>${w.plan && w.plan !== 'standard' ? `<div class="row2"><span class="chip teal" style="color:#fff">${esc(w.plan)} plan</span>${Number(w.fee) < Number(w.standard_fee) ? `<span>special price ${money(w.fee, w.currency)}/label</span>` : ''}</div>` : ''}</div>
     ${kpi('wallet', 'Main balance', money(w.balance, w.currency), 'from your top-ups', Number(w.balance) < 0 ? 'bad' : '')}
     ${kpi('gift', 'Bonus credits', money(w.bonus_balance, w.currency), w.bonus_expires_at ? 'use by ' + fmtD(w.bonus_expires_at) : 'used before main balance', 'teal')}</div>
    <div class="grid g3" style="margin-top:12px">${kpi('qr', 'Free labels this month', `${w.free_remaining || 0} / ${w.free_allowance || 0}`, 'used first, before credits')}${kpi('history', 'Labels this month', num(sum(used, 'qty')), money(sum(used, g => Number(g.paid_amount ?? g.total) + Number(g.bonus_used || 0)), w.currency) + ' charged')}${kpi('clock', 'Pending top-ups', pend.length, pend.length ? money(sum(pend, 'amount'), w.currency) + ' waiting for DeepQr' : 'none', pend.length ? 'warn' : '')}</div>
    <div style="margin-top:16px">${tabbar('walTabs', [['topup', 'Top up', 'plus'], ['requests', 'Requests', 'clock', pend.length || ''], ['statement', 'Statement', 'history'], ['rewards', 'Promo & referral', 'gift']], tab, 'walTab')}</div>
    ${tab === 'requests' ? walletRequests() : tab === 'statement' ? walletStatement() : tab === 'rewards' ? walletRewards() : walletTopup()}`;
  }
};
function walTab(t) { setTab('tab', t); }
function walletTopup() {
  const w = wallet || {}, pk = w.packages || [], accts = (w.payment_accounts || []).filter(a => a && (a.number || a.account));
  const methods = [...new Set(accts.map(a => a.method).filter(Boolean).concat(['M-Pesa', 'Tigo Pesa', 'Airtel Money', 'HaloPesa', 'Bank']))];
  const amt = topSel.pkg ? Number(pk.find(p => p.id === topSel.pkg)?.amount || 0) : Number(topSel.amount || 0);
  const bonus = topSel.pkg ? Number(pk.find(p => p.id === topSel.pkg)?.bonus || 0) : 0;
  return `<div class="grid g2"><div class="card"><div class="cardHead"><div><h3>1. Choose an amount</h3><p>Bigger packages include bonus credits.</p></div></div>
    <div class="pkgGrid">${pk.map(p => `<button type="button" class="pkg ${topSel.pkg === p.id ? 'sel' : ''}" onclick="topSel={pkg:'${p.id}',amount:''};renderView()">${p.badge ? `<span class="badge2">${esc(p.badge)}</span>` : ''}<div class="muted" style="font-weight:700">${esc(p.name)}</div><div class="amt">${money(p.amount, w.currency)}</div>${Number(p.bonus) ? `<div class="bonus">+ ${money(p.bonus, w.currency)} bonus</div>` : '<div class="muted" style="font-size:13px">no bonus</div>'}<small class="muted">≈ ${num(Math.floor((Number(p.amount) + Number(p.bonus)) / Math.max(Number(w.fee || 25), .01)))} labels</small></button>`).join('')}</div>
    <div class="field" style="margin-top:12px"><label for="tuAmt">Or another amount (minimum ${money(w.min_topup, w.currency)})</label><input id="tuAmt" type="number" min="${Number(w.min_topup || 0)}" step="any" value="${esc(topSel.amount)}" oninput="topSel={pkg:null,amount:this.value};document.querySelectorAll('.pkg').forEach(b=>b.classList.remove('sel'));document.getElementById('tuSum').innerHTML=topSumHtml()"></div>
    <div class="totals" id="tuSum">${topSumHtml(amt, bonus)}</div></div>
   <div class="card"><div class="cardHead"><div><h3>2. Pay DeepQr</h3><p>${esc(w.payment_instructions || 'Pay to one of these accounts, then send the transaction reference below.')}</p></div></div>
    <div class="stack-sm">${accts.map(a => `<div class="payAcct">${icon(/bank/i.test(a.method || '') ? 'wallet' : 'phone')}<div style="flex:1"><small class="muted">${esc(a.method || '')}${a.name ? ' · ' + esc(a.name) : ''}</small><div class="num">${esc(a.number || a.account)}</div>${a.note ? `<small class="muted">${esc(a.note)}</small>` : ''}</div><button class="btn small" onclick="copyText('${jsq(a.number || a.account)}','Copied')">${icon('copy')}Copy</button></div>`).join('') || '<p class="muted">DeepQr has not published payment accounts yet. Contact support.</p>'}</div>
    ${w.support_phone || w.support_email ? `<p class="muted" style="font-size:12.5px;margin-top:10px">Help: ${esc(w.support_phone || '')} ${esc(w.support_email || '')}</p>` : ''}
    <h3 style="margin:16px 0 8px">3. Tell us you paid</h3>
    <form id="tuForm"><div class="formGrid"><div class="field"><label for="tuM">Paid with *</label><select id="tuM">${methods.map(m => `<option>${esc(m)}</option>`).join('')}</select></div><div class="field"><label for="tuRef">Transaction reference *</label><input id="tuRef" class="mono" required minlength="4" placeholder="e.g. QK72HT91XZ" style="text-transform:uppercase"></div><div class="field"><label for="tuPh">Paid from (phone / account) *</label><input id="tuPh" type="tel" required placeholder="07XX XXX XXX"></div><div class="field"><label for="tuNm">Name on the payment</label><input id="tuNm" value="${esc(me.name)}"></div></div>
     <div id="tuErr" class="bad" style="min-height:20px;margin-top:8px"></div><button class="btn primary lg wide">${icon('check')}Submit top-up request</button><p class="muted" style="font-size:12.5px">DeepQr checks the payment and adds the credits — usually within a few hours. You can track it under Requests.</p></form></div></div>`;
}
function topSumHtml(amt, bonus) {
  const w = wallet || {};
  if (amt === undefined) { amt = Number(topSel.amount || 0); bonus = 0; }
  const fee = Math.max(Number(w.fee || 25), .01);
  return `<div class="row"><span>You pay</span><b>${money(amt, w.currency)}</b></div><div class="row"><span>Bonus credits</span><b class="ok">+ ${money(bonus, w.currency)}</b></div><div class="row grand"><span>You get</span><span>${money(amt + bonus, w.currency)}</span></div><div class="row"><span>Enough for about</span><b>${num(Math.floor((amt + bonus) / fee))} QR labels</b></div>`;
}
function walletRequests() {
  return `<div class="card"><div class="tableWrap"><table><thead><tr><th>Date</th><th class="right">Amount</th><th class="right">Bonus</th><th>Method</th><th>Reference</th><th>From</th><th>Status</th><th>Receipt</th><th></th></tr></thead><tbody>
   ${cache.topups.map(t => `<tr><td>${fmtDT(t.created_at)}</td><td class="right num">${money(t.amount, wallet?.currency)}</td><td class="right num ok">${Number(t.bonus) ? '+' + money(t.bonus, wallet?.currency) : ''}</td><td>${esc(t.method)}</td><td class="mono">${esc(t.reference)}</td><td>${esc(t.sender_phone || '')}${t.sender_name ? '<br><small class="muted">' + esc(t.sender_name) + '</small>' : ''}</td><td>${t.status === 'approved' ? '<span class="tag ok">Approved</span>' : t.status === 'rejected' ? `<span class="tag bad">Rejected</span>${t.review_note ? `<br><small class="muted">${esc(t.review_note)}</small>` : ''}` : '<span class="tag warn">Waiting</span>'}</td><td class="mono">${esc(t.receipt_no || '')}</td><td>${t.status === 'pending' ? `<button class="btn small ghost" onclick="cancelTopup('${t.id}')">Cancel</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="9" class="empty">No top-up requests yet.</td></tr>`}
  </tbody></table></div></div>`;
}
function cancelTopup(id) { confirmBox('Cancel this request?', 'Only do this if you submitted it by mistake.', 'Cancel request', async btn => { await withBusy(btn, async () => { await rpcToast('dq_cancel_topup', { p_id: id }, 'Request cancelled'); closeModal(); await loadDeepQr(); renderView(); }); }); }
const TX_NAMES = { topup: 'Top-up', qr_charge: 'QR labels', adjustment: 'Adjustment', refund: 'Refund', bonus: 'Bonus', promo: 'Promo code', referral: 'Referral bonus', welcome: 'Welcome credit', bonus_expired: 'Bonus expired' };
function walletStatement() {
  const tx = cache.walletTx;
  return `<div class="card"><div class="cardHead"><div><h3>Wallet statement</h3><p>Every credit and charge, newest first.</p></div><button class="btn small" onclick="downloadCSV('wallet-statement.csv',[['Date','Type','Main','Bonus','Free labels','Main after','Bonus after','Reference','Note','By']].concat(cache.walletTx.map(t=>[t.created_at,t.type,t.amount,t.bonus_amount,t.free_count,t.balance_after,t.bonus_balance_after,t.reference,t.note,t.by_name])))">${icon('download')}CSV</button></div>
  <div class="tableWrap"><table><thead><tr><th>Date</th><th>Type</th><th>Details</th><th class="right">Main</th><th class="right">Bonus</th><th class="right">Free</th><th class="right">Main balance</th><th class="right">Bonus balance</th></tr></thead><tbody>
  ${tx.map(t => `<tr><td>${fmtDT(t.created_at)}</td><td><span class="tag ${Number(t.amount) + Number(t.bonus_amount || 0) >= 0 ? 'ok' : 'gray'}">${esc(TX_NAMES[t.type] || t.type)}</span></td><td>${esc(t.note || '')}${t.reference ? ` <small class="muted mono">${esc(t.reference)}</small>` : ''}</td><td class="right num ${Number(t.amount) < 0 ? 'bad' : Number(t.amount) > 0 ? 'ok' : 'muted'}">${Number(t.amount) ? (t.amount > 0 ? '+' : '') + num(t.amount) : '—'}</td><td class="right num ${Number(t.bonus_amount) < 0 ? 'bad' : Number(t.bonus_amount) > 0 ? 'ok' : 'muted'}">${Number(t.bonus_amount) ? (t.bonus_amount > 0 ? '+' : '') + num(t.bonus_amount) : '—'}</td><td class="right num">${Number(t.free_count) ? t.free_count : '—'}</td><td class="right num">${num(t.balance_after)}</td><td class="right num">${t.bonus_balance_after != null ? num(t.bonus_balance_after) : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No transactions yet.</td></tr>'}
  </tbody></table></div></div>`;
}
function walletRewards() {
  const w = wallet || {};
  const link = location.origin + location.pathname + '?ref=' + encodeURIComponent(w.referral_code || '');
  return `<div class="grid g2"><div class="card"><div class="cardHead"><div><h3>${icon('gift')} Redeem a promo code</h3><p>Promo credits are added as bonus credits.</p></div></div><form id="promoF" class="searchLine"><input class="input mono" id="promoC" placeholder="PROMO CODE" style="text-transform:uppercase" required><button class="btn primary">Redeem</button></form></div>
   <div class="card"><div class="cardHead"><div><h3>${icon('users')} Invite another business</h3><p>${Number(w.referral_bonus) ? `You get <b>${money(w.referral_bonus, w.currency)}</b> bonus when they make their first top-up` : 'Share DeepQr with other businesses'}${Number(w.referee_bonus) ? `, and they get <b>${money(w.referee_bonus, w.currency)}</b> to start.` : '.'}</p></div></div>
    ${w.referral_code ? `<div class="payAcct"><div style="flex:1"><small class="muted">Your referral code</small><div class="num">${esc(w.referral_code)}</div></div><button class="btn small" onclick="copyText('${jsq(link)}','Invite link copied')">${icon('copy')}Copy link</button><a class="btn small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Ninatumia DeepQr kwa mauzo na stoo kwa QR codes. Jisajili hapa: ${link}`)}">${icon('whatsapp')}Share</a></div>` : '<p class="muted">Your referral code will appear after the DeepQr update.</p>'}
    ${!w.referred && me.role === 'owner' && daysSince(dateOnly(business.created_at)) <= 30 ? `<form id="refF" class="searchLine" style="margin-top:12px"><input class="input mono" id="refC" placeholder="Were you invited? Enter their code"><button class="btn">Apply</button></form>` : ''}</div></div>`;
}
document.addEventListener('submit', async e => {
  const id = e.target.id;
  if (id === 'tuForm') {
    e.preventDefault();
    const err = document.getElementById('tuErr'); err.textContent = '';
    const p = { package_id: topSel.pkg, amount: topSel.pkg ? null : Number(document.getElementById('tuAmt').value || topSel.amount || 0), method: document.getElementById('tuM').value, reference: document.getElementById('tuRef').value.trim(), sender_phone: document.getElementById('tuPh').value.trim(), sender_name: document.getElementById('tuNm').value.trim() };
    if (!p.package_id && !(p.amount >= Number(wallet?.min_topup || 0)) ) { err.textContent = `Choose a package or enter at least ${money(wallet?.min_topup || 0, wallet?.currency)}.`; return; }
    if (!p.package_id && !p.amount) { err.textContent = 'Choose a package or enter an amount.'; return; }
    await withBusy(e.submitter, async () => {
      try { await rpc('dq_request_topup2', { p }); topSel = { pkg: null, amount: '' }; await loadDeepQr(); toast('Top-up request sent — DeepQr will confirm it soon', 'ok'); go('wallet', { tab: 'requests' }); }
      catch (x) { err.textContent = errMsg(x); beep(false); }
    });
  } else if (id === 'promoF') {
    e.preventDefault();
    await withBusy(e.submitter, async () => { const r = await rpcToast('dq_redeem_promo', { p_code: document.getElementById('promoC').value }); if (r) { await loadDeepQr(); renderView(); toast(`${money(r.credits, wallet?.currency)} bonus added 🎉`, 'ok'); } });
  } else if (id === 'refF') {
    e.preventDefault();
    await withBusy(e.submitter, async () => { const r = await rpcToast('dq_apply_referral', { p_code: document.getElementById('refC').value }); if (r) { await loadDeepQr(); renderView(); toast(Number(r.bonus) ? `Welcome bonus of ${money(r.bonus, wallet?.currency)} added` : 'Referral applied', 'ok'); } });
  }
});

/* ---------------- settings ---------------- */
PAGES.settings = {
  title: 'Settings', sub: () => `Business ID <b class="mono">${esc(business.code || '—')}</b> — printed in every QR label`,
  render: () => {
    const b = business, methods = (b.payment_methods || []).map(m => m.name || m);
    const tzs = ['Africa/Dar_es_Salaam', 'Africa/Nairobi', 'Africa/Kampala', 'Africa/Kigali', 'Africa/Lusaka', 'Africa/Johannesburg', 'Africa/Lagos', 'UTC'];
    const sw = (id, label, sub, on) => `<label class="chk" style="align-items:flex-start;margin:8px 0"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span><b>${label}</b><br><small class="muted" style="font-weight:500">${sub}</small></span></label>`;
    const gs = b.business_groups || [];
    return `<div class="card"><div class="cardHead"><div><h3>${icon('store')} Business type</h3><p>The groups of goods you sell. They decide your categories, the units shown first and the products suggested from the DeepQr catalogue.</p></div><button class="btn" onclick="openBusinessType()">${icon('edit')}Change</button></div>
     <div class="groupPills">${gs.length ? gs.map(g => `<span class="chip" style="border-color:${GROUP_TONES[g]}">${groupDot(g)}${esc(groupName(g))}</span>`).join('') : '<span class="muted">Not set yet — choose what you sell.</span>'}</div>
     <p class="muted" style="font-size:12.5px;margin:10px 0 0">Units used first: ${(b.units || []).length ? b.units.map(u => `<b class="mono">${esc(u)}</b>`).join(', ') : 'all master units'} · <button class="priceBtn" onclick="go('catalog')">Open the product catalogue</button></p></div>
    <form id="setF"><div class="grid g2">
     <div class="card" style="margin:0"><div class="cardHead"><div><h3>Business details</h3><p>Shown on receipts and purchase orders.</p></div></div><div class="formGrid">
      <div class="field"><label for="bN">Business name *</label><input id="bN" required value="${esc(b.name)}"></div><div class="field"><label for="bTin">TIN</label><input id="bTin" value="${esc(b.tin || '')}"></div>
      <div class="field"><label for="bPh">Phone</label><input id="bPh" value="${esc(b.phone || '')}"></div><div class="field"><label for="bEm">Email</label><input id="bEm" type="email" value="${esc(b.email || '')}"></div>
      <div class="field"><label for="bAd">Address</label><input id="bAd" value="${esc(b.address || '')}"></div>
      <div class="field"><label for="bCur">Currency</label><select id="bCur">${['TZS', 'KES', 'UGX', 'RWF', 'ZMW', 'USD'].map(c => `<option ${b.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label for="bTz">Time zone</label><select id="bTz">${tzs.map(t => `<option ${b.timezone === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label for="bTax">Default tax / VAT (%)</label><input id="bTax" type="number" min="0" max="100" step="any" value="${Number(b.tax || 0)}"></div></div></div>
     <div class="card" style="margin:0"><div class="cardHead"><div><h3>Receipts</h3></div></div>
      <div class="field"><label for="bRh">Receipt header</label><input id="bRh" value="${esc(b.receipt_header || '')}" placeholder="e.g. Karibu! Open 8am–9pm"></div>
      <div class="field" style="margin-top:10px"><label for="bRf">Receipt footer</label><input id="bRf" value="${esc(b.receipt_footer || '')}"></div>
      ${sw('bRq', 'Print a QR on receipts', 'Customers can scan it to show the receipt for returns.', b.receipt_show_qr !== false)}
      <div class="field"><label for="bLs">QR label size</label><select id="bLs">${[['small', 'Small (25 mm)'], ['medium', 'Medium (38 mm)'], ['large', 'Large (50 mm)']].map(([k, l]) => `<option value="${k}" ${b.label_size === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
     <div class="card" style="margin:0"><div class="cardHead"><div><h3>Payments at the till</h3></div></div>
      <div class="field"><label for="bPm">Payment methods (one per line)</label><textarea id="bPm" rows="6">${esc(methods.join('\n'))}</textarea><small class="muted">"Cash" counts toward the till drawer. Credit (pay later) is separate.</small></div>
      ${sw('bRef', 'Require a reference for mobile money and bank', 'The cashier must type the transaction code. Stops fake "I paid" claims.', b.require_payment_ref !== false)}
      ${sw('bCr', 'Allow credit sales (pay later)', 'Only staff with the "Sell on credit" permission, for customers with a name and phone.', b.allow_credit_sales !== false)}
      ${sw('bSh', 'Require an open till shift to sell', 'Cashiers count the float at the start and the cash at the end of each shift.', !!b.require_shift)}</div>
     <div class="card" style="margin:0"><div class="cardHead"><div><h3>Loyalty points</h3></div></div>
      ${sw('bLo', 'Reward customers with points', 'Customers earn points on every purchase and pay with them later.', !!b.loyalty_enabled)}
      <div class="formGrid"><div class="field"><label for="bPpa">1 point for every</label><input id="bPpa" type="number" min="1" value="${Number(b.points_per_amount || 1000)}"><small class="muted">${esc(b.currency)} spent</small></div><div class="field"><label for="bPv">1 point is worth</label><input id="bPv" type="number" min="0" step="any" value="${Number(b.point_value || 10)}"><small class="muted">${esc(b.currency)} discount</small></div><div class="field"><label for="bMr">Minimum points to redeem</label><input id="bMr" type="number" min="0" value="${Number(b.min_redeem_points || 50)}"></div></div>
      <p class="muted" style="font-size:12.5px">Example: a ${money(Number(b.points_per_amount || 1000) * 50)} purchase earns 50 points = ${money(50 * Number(b.point_value || 10))} off the next sale (${pct(Number(b.point_value || 10), Number(b.points_per_amount || 1000))}% back).</p></div>
     <div class="card" style="margin:0"><div class="cardHead"><div><h3>Stock &amp; expiry</h3></div></div><div class="formGrid">
      <div class="field"><label for="bLow">Default reorder level</label><input id="bLow" type="number" min="0" value="${Number(b.low_stock || 0)}"></div><div class="field"><label for="bEx">Warn about expiry (days before)</label><input id="bEx" type="number" min="1" value="${Number(b.expiry_alert_days || 30)}"></div></div>
      ${sw('bBx', 'Block selling expired items', 'Scanning an expired label is refused at the till.', b.block_expired_sales !== false)}
      <div class="field" style="margin-top:8px"><label>QR label format for new labels</label><div class="seg wrap" role="radiogroup"><button type="button" class="${(b.qr_format || 'link') === 'link' ? 'active' : ''}" onclick="this.parentNode.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===this));document.getElementById('bQf').value='link'">${icon('qr')}Smart link (recommended)</button><button type="button" class="${b.qr_format === 'dq1' ? 'active' : ''}" onclick="this.parentNode.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===this));document.getElementById('bQf').value='dq1'">Classic DQ1 code</button></div><input type="hidden" id="bQf" value="${esc(b.qr_format || 'link')}"><small class="muted">Smart links open a “genuine product” check in any phone camera, and still scan at your till. Old labels keep working.</small></div></div>
     <div class="card" style="margin:0"><div class="cardHead"><div><h3>Product categories</h3></div></div><div id="catList">${cache.categories.map(c => `<span class="chip" style="margin:3px">${esc(c.name)} <button type="button" class="iconBtn" style="width:20px;height:20px" onclick="delCategory('${c.id}')" title="Remove">${icon('x')}</button></span>`).join('')}</div><div class="searchLine"><input class="input" id="newCat" placeholder="New category"><button type="button" class="btn" onclick="addCategory()">${icon('plus')}Add</button></div></div>
    </div><div class="actions" style="position:sticky;bottom:0;background:var(--bg);padding:12px 0;margin-top:12px"><button class="btn primary lg">${icon('check')}Save settings</button></div></form>
    ${me.role === 'owner' ? `<div class="card" style="margin-top:16px"><div class="cardHead"><div><h3>Your password</h3><p>Signed in as ${esc(session?.user?.email || '')}</p></div></div><form id="pwF" class="searchLine"><input class="input" id="pw1" type="password" minlength="6" required placeholder="New password" autocomplete="new-password"><button class="btn">Change password</button></form></div>` : ''}`;
  },
  after: () => {
    document.getElementById('setF').onsubmit = async e => {
      e.preventDefault();
      const v = id => document.getElementById(id), c = id => v(id).checked;
      const methods = v('bPm').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!methods.some(m => /^cash$/i.test(m))) methods.unshift('Cash');
      const patch = { name: v('bN').value.trim(), tin: v('bTin').value.trim(), phone: v('bPh').value.trim(), email: v('bEm').value.trim(), address: v('bAd').value.trim(), currency: v('bCur').value, timezone: v('bTz').value, tax: Number(v('bTax').value || 0),
        receipt_header: v('bRh').value, receipt_footer: v('bRf').value, receipt_show_qr: c('bRq'), label_size: v('bLs').value, payment_methods: [...new Set(methods)], require_payment_ref: c('bRef'), allow_credit_sales: c('bCr'), require_shift: c('bSh'),
        loyalty_enabled: c('bLo'), points_per_amount: Math.max(1, Number(v('bPpa').value || 1000)), point_value: Math.max(0, Number(v('bPv').value || 0)), min_redeem_points: Math.max(0, Number(v('bMr').value || 0)), low_stock: Math.max(0, Number(v('bLow').value || 0)), expiry_alert_days: Math.max(1, Number(v('bEx').value || 30)), block_expired_sales: c('bBx'), qr_format: v('bQf').value };
      await withBusy(e.submitter, async () => { if (await saveBiz(patch, 'Settings saved')) logActivity('settings', 'Business settings updated'); });
    };
    const pw = document.getElementById('pwF'); if (pw) pw.onsubmit = async e => { e.preventDefault(); const { error } = await sb.auth.updateUser({ password: document.getElementById('pw1').value }); toast(error ? errMsg(error) : 'Password changed', error ? 'bad' : 'ok'); if (!error) pw.reset(); };
  }
};
async function addCategory() {
  const n = document.getElementById('newCat').value.trim(); if (!n) return;
  if (cache.categories.some(c => c.name.toLowerCase() === n.toLowerCase())) { toast('That category exists', 'bad'); return; }
  const { data, error } = await sb.from('categories').insert({ business_id: me.business_id, name: n }).select().single();
  if (error) { toast(errMsg(error), 'bad'); return; }
  cache.categories.push(data); document.getElementById('catList').insertAdjacentHTML('beforeend', `<span class="chip" style="margin:3px">${esc(n)}</span>`); document.getElementById('newCat').value = ''; toast('Category added', 'ok');
}
async function delCategory(id) {
  const c = cache.categories.find(x => x.id === id);
  if (cache.products.some(p => p.category === c.name)) { toast('Products still use this category', 'bad'); return; }
  const { error } = await sb.from('categories').delete().eq('id', id); if (error) { toast(errMsg(error), 'bad'); return; }
  cache.categories = cache.categories.filter(x => x.id !== id); renderView();
}
