/* =============================================================================
   Sales history, shifts, customers & debts
   ============================================================================= */
let salesF = { range: 'last30', status: 'all', shop: '', cashier: '' };
function rangeDates(r) {
  const t = dateOnly(), d = new Date();
  const mStart = dateOnly(new Date(d.getFullYear(), d.getMonth(), 1));
  const lmStart = dateOnly(new Date(d.getFullYear(), d.getMonth() - 1, 1)), lmEnd = dateOnly(new Date(d.getFullYear(), d.getMonth(), 0));
  const wk = new Date(d); wk.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return ({ today: [t, t], yesterday: [addDays(-1), addDays(-1)], week: [dateOnly(wk), t], last7: [addDays(-6), t], month: [mStart, t], lastmonth: [lmStart, lmEnd], last30: [addDays(-29), t], last90: [addDays(-89), t], year: [d.getFullYear() + '-01-01', t] })[r] || [addDays(-29), t];
}
const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['last7', 'Last 7 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['last30', 'Last 30 days'], ['last90', 'Last 90 days'], ['year', 'This year']];
function payStatusTag(s) {
  if (s.status === 'refunded') return '<span class="tag bad">Refunded</span>';
  const parts = [];
  if (s.status === 'partially_refunded') parts.push('<span class="tag warn">Part returned</span>');
  parts.push(Number(s.balance_due) > 0 ? (s.payment_status === 'unpaid' ? '<span class="tag bad">Unpaid</span>' : '<span class="tag warn">Part paid</span>') : '<span class="tag ok">Paid</span>');
  return parts.join(' ');
}

PAGES.sales = {
  title: 'Sales', sub: 'Receipts, returns, unpaid balances and till shifts', searchable: true,
  actions: () => `<button class="btn" onclick="exportSales()">${icon('download')}Export CSV</button>`,
  render: () => {
    const tab = viewParams.tab || 'receipts';
    const openShifts = cache.shifts.filter(s => s.status === 'open').length;
    return tabbar('salesTabs', [['receipts', 'Receipts', 'receipt'], ['shifts', 'Till shifts', 'clock', openShifts || '']], tab, 'salesTab') + (tab === 'shifts' ? shiftsView() : receiptsView());
  }
};
function salesTab(t) { setTab('tab', t); }
function filteredSales() {
  const [from, to] = rangeDates(salesF.range);
  let list = cache.sales.filter(s => s.date >= from && s.date <= to);
  if (me.role === 'cashier') list = list.filter(s => s.shop_id === me.shop_id);
  if (salesF.shop) list = list.filter(s => s.shop_id === salesF.shop);
  if (salesF.cashier) list = list.filter(s => s.cashier_name === salesF.cashier);
  if (salesF.status === 'unpaid') list = list.filter(s => Number(s.balance_due) > 0);
  if (salesF.status === 'paid') list = list.filter(s => Number(s.balance_due) <= 0 && s.status === 'completed');
  if (salesF.status === 'refunded') list = list.filter(s => s.status !== 'completed');
  if (search) { const q = search.toLowerCase(); list = list.filter(s => (s.receipt + ' ' + s.customer + ' ' + (s.customer_phone || '') + ' ' + s.cashier_name + ' ' + cache.saleLines.filter(l => l.sale_id === s.id).map(l => l.name + ' ' + (l.serial || '')).join(' ')).toLowerCase().includes(q)); }
  return list;
}
function receiptsView() {
  const list = filteredSales();
  const net = sum(list, s => Number(s.total) - Number(s.refunded_amount || 0)), due = sum(list, 'balance_due');
  const cashiers = [...new Set(cache.sales.map(s => s.cashier_name).filter(Boolean))];
  return `<div class="grid g4">${kpi('receipt', 'Receipts', list.length, `${list.filter(s => s.status !== 'completed').length} with returns`)}${kpi('chart', 'Net sales', money(net), 'after returns', 'teal')}${kpi('coins', 'Unpaid on these', `<span class="${due ? 'warn' : ''}">${money(due)}</span>`, `${list.filter(s => Number(s.balance_due) > 0).length} receipt(s)`, due ? 'warn' : '')}${kpi('cart', 'Average receipt', money(list.length ? net / list.length : 0), '')}</div>
  <div class="card" style="margin-top:16px"><div class="toolbar">
   <input class="input grow" id="salesSearch" value="${esc(search)}" oninput="liveSearch(this)" placeholder="Receipt, customer, phone, cashier, product or serial…" aria-label="Search sales">
   <select class="input" aria-label="Period" onchange="salesF.range=this.value;renderView()">${RANGES.map(([k, l]) => `<option value="${k}" ${salesF.range === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
   <select class="input" aria-label="Status" onchange="salesF.status=this.value;renderView()">${[['all', 'All receipts'], ['paid', 'Fully paid'], ['unpaid', 'With balance due'], ['refunded', 'With returns']].map(([k, l]) => `<option value="${k}" ${salesF.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
   ${me.role !== 'cashier' ? `<select class="input" aria-label="Shop" onchange="salesF.shop=this.value;renderView()"><option value="">All shops</option>${cache.shops.map(s => `<option value="${s.id}" ${salesF.shop === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select><select class="input" aria-label="Cashier" onchange="salesF.cashier=this.value;renderView()"><option value="">All cashiers</option>${cashiers.map(c => `<option ${salesF.cashier === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>` : ''}
  </div>
  <div class="tableWrap"><table><thead><tr><th>Receipt</th><th>Date</th><th>Shop</th><th>Customer</th><th>Cashier</th><th class="right">Items</th><th>Payment</th><th>Status</th><th class="right">Total</th><th class="right">Due</th><th></th></tr></thead><tbody>
  ${list.slice(0, 400).map(s => { const lines = cache.saleLines.filter(l => l.sale_id === s.id); return `<tr><td class="mono"><b>${esc(s.receipt)}</b></td><td>${fmtD(s.date)}<span class="sub">${esc(s.time || '')}</span></td><td>${esc(shopObj(s.shop_id)?.name || '')}</td><td>${s.customer_id ? `<button class="priceBtn" onclick="openCustomer('${s.customer_id}')">${esc(s.customer)}</button>` : esc(s.customer)}${s.customer_phone ? `<span class="sub">${esc(s.customer_phone)}</span>` : ''}</td><td>${esc(s.cashier_name || '')}</td><td class="right num">${sum(lines, 'qty')}${lines.some(l => l.serial) ? ' <span class="tag info">QR</span>' : ''}</td><td>${esc(s.payment)}</td><td>${payStatusTag(s)}</td><td class="right num"><b>${money(s.total)}</b>${Number(s.refunded_amount) ? `<span class="sub">− ${money(s.refunded_amount)} returned</span>` : ''}</td><td class="right num ${Number(s.balance_due) > 0 ? 'warn' : ''}">${Number(s.balance_due) > 0 ? money(s.balance_due) : '—'}</td>
   <td><div class="actions" style="justify-content:flex-end;flex-wrap:nowrap"><button class="btn small" onclick="showReceiptById('${s.id}')">Receipt</button>${Number(s.balance_due) > 0 && s.customer_id ? `<button class="btn small success" onclick="openCustomerPayment('${s.customer_id}')">Collect</button>` : ''}${can('can_refund') && s.status !== 'refunded' ? `<button class="btn small danger" onclick="openRefund('${s.id}')">${icon('refund')}Return</button>` : ''}</div></td></tr>`; }).join('') || `<tr><td colspan="11" class="empty">No receipts in this period.</td></tr>`}
  </tbody></table></div>${list.length > 400 ? `<p class="muted" style="font-size:12px">Showing the latest 400 — narrow the period or export CSV for all.</p>` : ''}</div>`;
}
function shiftsView() {
  const list = me.role === 'cashier' ? cache.shifts.filter(s => s.member_id === me.id) : cache.shifts;
  return `<div class="card"><div class="cardHead"><div><h3>Till shifts</h3><p>Opening float, cash taken and the count at closing. Differences show shortages (−) and excess (+).</p></div>${!myShift ? `<button class="btn primary" onclick="openShiftModal()">${icon('unlock')}Open my shift</button>` : `<button class="btn" onclick="closeShiftModal()">${icon('lock')}Close my shift</button>`}</div>
  <div class="tableWrap"><table><thead><tr><th>Cashier</th><th>Shop</th><th>Opened</th><th>Closed</th><th class="right">Float</th><th class="right">Expected</th><th class="right">Counted</th><th class="right">Difference</th><th>Status</th><th></th></tr></thead><tbody>
  ${list.map(s => `<tr><td><b>${esc(s.member_name || '')}</b></td><td>${esc(shopObj(s.shop_id)?.name || '')}</td><td>${fmtDT(s.opened_at)}</td><td>${s.closed_at ? fmtDT(s.closed_at) : '—'}</td><td class="right num">${money(s.opening_float)}</td><td class="right num">${s.expected_cash != null ? money(s.expected_cash) : '—'}</td><td class="right num">${s.counted_cash != null ? money(s.counted_cash) : '—'}</td><td class="right num ${Number(s.difference) < 0 ? 'bad' : Number(s.difference) > 0 ? 'warn' : ''}">${s.difference != null ? (Number(s.difference) > 0 ? '+' : '') + money(s.difference) : '—'}</td><td>${s.status === 'open' ? '<span class="tag info">Open</span>' : '<span class="tag gray">Closed</span>'}</td><td><button class="btn small" onclick="viewShift('${s.id}')">Report</button></td></tr>`).join('') || `<tr><td colspan="10" class="empty">No shifts yet. Open a shift from Scan &amp; Sell to start cash-up tracking.</td></tr>`}
  </tbody></table></div></div>`;
}
function exportSales() {
  const rows = [['Receipt', 'Date', 'Time', 'Shop', 'Customer', 'Phone', 'Cashier', 'Payment', 'Status', 'Product', 'Code', 'Serial', 'Qty', 'Returned', 'Price', 'Line total', 'Receipt total', 'Balance due']];
  filteredSales().forEach(s => cache.saleLines.filter(l => l.sale_id === s.id).forEach(l => rows.push([s.receipt, s.date, s.time, shopObj(s.shop_id)?.name || '', s.customer, s.customer_phone || '', s.cashier_name, s.payment, s.status + '/' + s.payment_status, l.name, l.code, l.serial || '', l.qty, l.refunded_qty || 0, l.price, Number(l.qty) * Number(l.price), s.total, s.balance_due])));
  downloadCSV(`deepqr-sales-${dateOnly()}.csv`, rows);
}

/* ---------------- customers ---------------- */
let custF = 'all';
PAGES.customers = {
  title: 'Customers', sub: 'Shoppers, their debts and loyalty points', searchable: true,
  actions: () => `<button class="btn" onclick="exportCustomers()">${icon('download')}Export</button><button class="btn primary" onclick="editCustomer()">${icon('plus')}New customer</button>`,
  render: () => {
    let list = cache.customers.slice();
    if (custF === 'owing') list = list.filter(c => Number(c.balance) > 0);
    if (custF === 'points') list = list.filter(c => Number(c.points) > 0);
    if (search) { const q = search.toLowerCase(), qp = phoneClean(search); list = list.filter(c => c.name.toLowerCase().includes(q) || (qp && (c.phone || '').includes(qp))); }
    list.sort((a, b) => custF === 'owing' ? b.balance - a.balance : custF === 'top' ? b.total_spent - a.total_spent : a.name.localeCompare(b.name));
    if (custF === 'top') list = list.slice(0, 50);
    const owing = cache.customers.filter(c => Number(c.balance) > 0);
    return `<div class="grid g4">${kpi('users', 'Customers', cache.customers.length, `${cache.customers.filter(c => c.last_visit && daysSince(dateOnly(c.last_visit)) <= 30).length} visited in 30 days`)}${kpi('coins', 'Owed to you', `<span class="${owing.length ? 'warn' : ''}">${money(sum(owing, 'balance'))}</span>`, `${owing.length} customer(s) with debt`, owing.length ? 'warn' : '')}${kpi('gift', 'Loyalty points', num(sum(cache.customers, 'points')), business.loyalty_enabled ? `worth ${money(sum(cache.customers, 'points') * business.point_value)}` : 'loyalty is off — Settings', 'teal')}${kpi('chart', 'Top spender', esc(cache.customers.slice().sort((a, b) => b.total_spent - a.total_spent)[0]?.name || '—'), '')}</div>
    <div class="card" style="margin-top:16px"><div class="toolbar"><input class="input grow" id="custSearch" value="${esc(search)}" oninput="liveSearch(this)" placeholder="Search name or phone…" aria-label="Search customers"><div class="seg">${[['all', 'All'], ['owing', 'Owing'], ['points', 'With points'], ['top', 'Top spenders']].map(([k, l]) => `<button class="${custF === k ? 'active' : ''}" onclick="custF='${k}';renderView()">${l}</button>`).join('')}</div></div>
    <div class="tableWrap"><table><thead><tr><th>Customer</th><th>Phone</th><th class="right">Visits</th><th class="right">Total spent</th><th>Last visit</th>${business.loyalty_enabled ? '<th class="right">Points</th>' : ''}<th class="right">Owes</th><th class="right">Credit limit</th><th></th></tr></thead><tbody>
    ${list.map(c => `<tr class="clickRow" onclick="openCustomer('${c.id}')"><td><b>${esc(c.name)}</b>${c.active === false ? ' <span class="tag gray">inactive</span>' : ''}</td><td class="mono">${esc(c.phone || '')}</td><td class="right num">${c.visits}</td><td class="right num">${money(c.total_spent)}</td><td>${c.last_visit ? ago(c.last_visit) : '—'}</td>${business.loyalty_enabled ? `<td class="right num">${c.points}</td>` : ''}<td class="right num ${Number(c.balance) > 0 ? 'warn' : ''}"><b>${Number(c.balance) > 0 ? money(c.balance) : '—'}</b></td><td class="right num">${Number(c.credit_limit) ? money(c.credit_limit) : '<span class="muted">none</span>'}</td><td onclick="event.stopPropagation()">${Number(c.balance) > 0 ? `<button class="btn small success" onclick="openCustomerPayment('${c.id}')">Collect</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="9" class="empty">${custF === 'owing' ? 'Nobody owes you money.' : 'No customers yet. They are added automatically when you enter a phone number at the till.'}</td></tr>`}
    </tbody></table></div></div>`;
  }
};
function exportCustomers() { downloadCSV(`deepqr-customers-${dateOnly()}.csv`, [['Name', 'Phone', 'Email', 'Visits', 'Total spent', 'Points', 'Owes', 'Credit limit', 'Last visit'], ...cache.customers.map(c => [c.name, c.phone, c.email, c.visits, c.total_spent, c.points, c.balance, c.credit_limit, c.last_visit])]); }
function editCustomer(id) {
  const c = id ? customerById(id) : { name: '', phone: '', email: '', address: '', notes: '', credit_limit: 0, active: true };
  modal(`<form id="ecF"><div class="cardHead"><div><h3>${id ? 'Edit customer' : 'New customer'}</h3><p>Phone numbers must be unique — the till finds customers by phone.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
  <div class="formGrid"><div class="field"><label for="ecN">Name</label><input id="ecN" value="${esc(c.name)}" required></div><div class="field"><label for="ecP">Phone</label><input id="ecP" inputmode="tel" value="${esc(c.phone || '')}"></div><div class="field"><label for="ecE">Email</label><input id="ecE" type="email" value="${esc(c.email || '')}"></div><div class="field"><label for="ecA">Address</label><input id="ecA" value="${esc(c.address || '')}"></div>
  ${isMgr() ? `<div class="field"><label for="ecL">Credit limit (0 = no limit)</label><input id="ecL" type="number" min="0" step="any" value="${c.credit_limit || 0}"></div>` : ''}</div>
  <div class="field" style="margin-top:10px"><label for="ecNo">Notes</label><textarea id="ecNo" rows="2">${esc(c.notes || '')}</textarea></div>
  ${id ? `<label class="chk" style="margin-top:10px"><input type="checkbox" id="ecAct" ${c.active !== false ? 'checked' : ''}> Active</label>` : ''}
  <div class="actions" style="margin-top:14px"><button class="btn primary">Save</button></div></form>`, 'narrow');
  document.getElementById('ecF').onsubmit = async (e) => {
    e.preventDefault();
    const row = { name: document.getElementById('ecN').value.trim(), phone: phoneClean(document.getElementById('ecP').value) || null, email: document.getElementById('ecE').value.trim() || null, address: document.getElementById('ecA').value.trim() || null, notes: document.getElementById('ecNo').value.trim() || null };
    if (isMgr()) row.credit_limit = Math.max(0, Number(document.getElementById('ecL').value || 0));
    if (id) row.active = document.getElementById('ecAct').checked;
    const res = id ? await sb.from('customers').update(row).eq('id', id).select().single() : await sb.from('customers').insert({ ...row, business_id: me.business_id }).select().single();
    if (res.error) { toast(res.error.message.includes('duplicate') || res.error.code === '23505' ? 'Another customer already has that phone number.' : errMsg(res.error), 'bad'); return; }
    if (id) Object.assign(c, res.data); else cache.customers.push(res.data);
    closeModal(); if (id && drawerOpen()) openCustomer(id); renderView(); toast('Customer saved', 'ok');
  };
}
async function openCustomer(id) {
  const c = customerById(id) || (await sb.from('customers').select('*').eq('id', id).single()).data; if (!c) return;
  const [{ data: ledger }, { data: sales }] = await Promise.all([
    sb.from('customer_ledger').select('*').eq('customer_id', id).order('created_at', { ascending: false }).limit(100),
    sb.from('sales').select('*').eq('customer_id', id).order('created_at', { ascending: false }).limit(100)
  ]);
  const unpaid = (sales || []).filter(s => Number(s.balance_due) > 0);
  const label = { credit_sale: 'Bought on credit', payment: 'Paid', refund: 'Return', points_earned: 'Points earned', points_redeemed: 'Points used', points_reversed: 'Points reversed', adjustment: 'Adjustment' };
  drawer(`<div class="drawerHead"><div><h2>${esc(c.name)}</h2><p>${esc(c.phone || 'no phone')}${c.email ? ' · ' + esc(c.email) : ''} · customer since ${fmtD(c.created_at)}</p></div><div class="actions"><button class="btn small" onclick="editCustomer('${c.id}')">${icon('edit')}Edit</button><button class="btn ghost" onclick="closeDrawer()" aria-label="Close">${icon('x')}</button></div></div>
  <div class="drawerBody">
   <div class="grid g3">${kpi('coins', 'Owes', `<span class="${Number(c.balance) > 0 ? 'warn' : ''}">${money(c.balance)}</span>`, Number(c.credit_limit) ? 'limit ' + money(c.credit_limit) : 'no credit limit', Number(c.balance) > 0 ? 'warn' : '')}${kpi('chart', 'Total spent', money(c.total_spent), `${c.visits} visit(s)`)}${kpi('gift', 'Points', c.points, business.loyalty_enabled ? 'worth ' + money(c.points * business.point_value) : 'loyalty off', 'teal')}</div>
   <div class="actions" style="margin:16px 0">${Number(c.balance) > 0 ? `<button class="btn success" onclick="openCustomerPayment('${c.id}')">${icon('coins')}Record payment</button>` : ''}<button class="btn" onclick="posState.customer={id:'${c.id}',name:'${jsq(c.name)}',phone:'${jsq(c.phone || '')}',points:${c.points},balance:${c.balance},credit_limit:${c.credit_limit}};posSave();closeDrawer();go('pos')">${icon('cart')}New sale</button>${isMgr() ? `<button class="btn" onclick="adjustCustomer('${c.id}')">${icon('edit')}Adjust balance/points</button>` : ''}${c.phone && Number(c.balance) > 0 ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${phoneClean(c.phone).replace(/^0/, '255')}?text=${encodeURIComponent(`Habari ${c.name}, salio lako ${business.name} ni ${money(c.balance)}. Asante.`)}">${icon('whatsapp')}Remind</a>` : ''}</div>
   ${unpaid.length ? `<h3 style="margin:0 0 8px">Unpaid receipts</h3><div class="tableWrap"><table style="min-width:0"><thead><tr><th>Receipt</th><th>Date</th><th class="right">Total</th><th class="right">Due</th><th>Age</th></tr></thead><tbody>${unpaid.map(s => `<tr class="clickRow" onclick="showReceiptById('${s.id}')"><td class="mono">${esc(s.receipt)}</td><td>${fmtD(s.date)}</td><td class="right num">${money(s.total)}</td><td class="right num warn"><b>${money(s.balance_due)}</b></td><td>${daysSince(s.date)} days</td></tr>`).join('')}</tbody></table></div>` : ''}
   <h3 style="margin:18px 0 8px">Account history</h3>
   <ul class="timeline">${(ledger || []).map(l => `<li class="${l.type === 'payment' ? 'ok' : l.type === 'credit_sale' ? 'bad' : ''}"><b>${label[l.type] || l.type}${Number(l.amount) ? ' · ' + money(Math.abs(l.amount)) : ''}${l.points ? ` · ${l.points > 0 ? '+' : ''}${l.points} pts` : ''}</b><small>${fmtDT(l.created_at)} · ${esc(l.by_name || '')}${l.method ? ' · ' + esc(l.method) : ''}${l.reference ? ' · ' + esc(l.reference) : ''}${l.note ? ' · ' + esc(l.note) : ''} · balance ${money(l.balance_after)}${business.loyalty_enabled ? ` · ${l.points_after} pts` : ''}</small></li>`).join('') || '<p class="muted">No credit or points history yet.</p>'}</ul>
   <h3 style="margin:18px 0 8px">Receipts</h3>
   ${(sales || []).map(s => `<div class="row clickRow" onclick="showReceiptById('${s.id}')"><span><span class="mono">${esc(s.receipt)}</span> <span class="sub">${fmtD(s.date)} · ${esc(s.payment)}</span></span><span>${payStatusTag(s)} <b>${money(s.total)}</b></span></div>`).join('') || '<p class="muted">No receipts yet.</p>'}
  </div>`);
}
function adjustCustomer(id) {
  const c = customerById(id);
  modal(`<form id="acF"><div class="cardHead"><div><h3>Adjust ${esc(c.name)}</h3><p>For corrections and opening balances (e.g. old debts from your notebook). Every adjustment is recorded with your name.</p></div></div>
  <div class="formGrid"><div class="field"><label for="acA">Change debt by (+ adds, − removes)</label><input id="acA" type="number" step="any" value="0"></div>${business.loyalty_enabled ? `<div class="field"><label for="acP">Change points by</label><input id="acP" type="number" step="1" value="0"></div>` : ''}</div>
  <div class="field" style="margin-top:10px"><label for="acN">Reason</label><input id="acN" required placeholder="e.g. Opening balance from notebook"></div>
  <div class="actions" style="margin-top:14px"><button class="btn primary">Save adjustment</button><button type="button" class="btn" onclick="closeModal()">Cancel</button></div></form>`, 'narrow');
  document.getElementById('acF').onsubmit = async (e) => {
    e.preventDefault();
    const r = await rpcToast('dq_adjust_customer', { p: { customer_id: id, amount: Number(document.getElementById('acA').value || 0), points: Number(document.getElementById('acP')?.value || 0), note: document.getElementById('acN').value } }, 'Adjustment saved');
    if (!r) return; c.balance = r.balance; c.points = r.points; closeModal(); openCustomer(id); renderView();
  };
}
