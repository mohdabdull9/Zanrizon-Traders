/* =============================================================================
   Reports: sales, profit & loss, products, staff, payments, debts, stock value
   All figures come from one server call (dq_report) so they always agree.
   ============================================================================= */
let repF = { range: 'last30', from: '', to: '', shop: '' };
let repData = null, repKey = '', repLoading = false;

/* ---------------- tiny SVG charts ---------------- */
function niceMax(v) { if (v <= 4) return 4; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
function shortNum(v) { v = Number(v || 0); const a = Math.abs(v); if (a > 0 && a < 10 && v % 1) return v.toFixed(1); return a >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k' : String(Math.round(v)); }
function barChart(rows, series, opts = {}) {
  // rows: [{label, a, b}], series: [[key, colour, name]]
  const W = 720, H = opts.h || 220, L = 44, B = 26, T = 10, R = 8;
  const max = niceMax(Math.max(1, ...rows.flatMap(r => series.map(s => Number(r[s[0]] || 0)))));
  const n = rows.length || 1, gw = (W - L - R) / n, bw = Math.max(2, Math.min(28, (gw - 4) / series.length));
  const y = v => T + (H - T - B) * (1 - Math.max(0, v) / max);
  const ticks = [0, .25, .5, .75, 1].map(f => max * f);
  const every = Math.ceil(n / (opts.labels || 12));
  return `<svg class="svgChart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || 'chart')}">
   ${ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${shortNum(t)}</text>`).join('')}
   ${rows.map((r, i) => { const x0 = L + i * gw + (gw - bw * series.length) / 2; return series.map((s, j) => { const v = Number(r[s[0]] || 0); return `<rect x="${x0 + j * bw}" y="${y(v)}" width="${bw - 1}" height="${Math.max(0, H - B - y(v))}" rx="2" fill="${s[1]}"><title>${esc(r.label)} · ${esc(s[2])}: ${num(v)}</title></rect>`; }).join('') + (i % every === 0 ? `<text x="${L + i * gw + gw / 2}" y="${H - 8}" text-anchor="middle">${esc(r.short || r.label)}</text>` : ''); }).join('')}
  </svg><div class="legendRow">${series.map(s => `<span><i style="background:${s[1]}"></i>${esc(s[2])}</span>`).join('')}</div>`;
}
function hBars(list, label, value, fmt = money, max) {
  const m = max || Math.max(1, ...list.map(x => Number(x[value] || 0)));
  return list.map(x => `<div class="barH"><span class="lbl" title="${esc(x[label])}">${esc(x[label] || '—')}</span><span class="trk"><i style="width:${Math.max(1, Number(x[value] || 0) / m * 100)}%"></i></span><span class="val">${fmt(x[value])}</span></div>`).join('') || '<p class="muted">No data for this period.</p>';
}
function donut(parts, size = 150) {
  const total = sum(parts, 'v') || 1; let a = -Math.PI / 2; const r = size / 2 - 10, c = size / 2;
  const arcs = parts.filter(p => p.v > 0).map(p => {
    const f = p.v / total, a2 = a + f * Math.PI * 2, large = f > .5 ? 1 : 0;
    const d = f >= .999 ? `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - .01} ${c - r}` : `M ${c + r * Math.cos(a)} ${c + r * Math.sin(a)} A ${r} ${r} 0 ${large} 1 ${c + r * Math.cos(a2)} ${c + r * Math.sin(a2)}`;
    a = a2; return `<path d="${d}" stroke="${p.c}" stroke-width="18" fill="none"><title>${esc(p.l)}: ${num(p.v)}</title></path>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">${arcs || `<circle cx="${c}" cy="${c}" r="${r}" stroke="var(--line)" stroke-width="18" fill="none"/>`}</svg>`;
}
const PALETTE = ['#2F5BEA', '#14B8A6', '#F59E0B', '#EF4444', '#8B5CF6', '#10B981', '#EC4899', '#64748B'];

/* ---------------- page ---------------- */
PAGES.reports = {
  title: 'Reports', sub: () => repData ? `${fmtD(repData.from)} – ${fmtD(repData.to)}${repF.shop ? ' · ' + esc(shopObj(repF.shop)?.name || '') : me.role === 'cashier' ? ' · ' + esc(shopObj(me.shop_id)?.name || '') : ' · all locations'}` : 'Sales, profit, stock and money in one place',
  actions: () => `<button class="btn primary" onclick="openExport()">${icon('download')}Download data (Excel)</button><button class="btn" onclick="exportReport()">${icon('download')}This report (CSV)</button><button class="btn" onclick="window.print()">${icon('printer')}Print</button>`,
  render: () => {
    const tab = viewParams.tab || 'overview';
    const [from, to] = repDates();
    const key = [from, to, repF.shop].join('|');
    const head = `<div class="card noPrint"><div class="toolbar" style="margin:0">
      <select class="input" aria-label="Period" onchange="repF.range=this.value;renderView()">${RANGES.map(([k, l]) => `<option value="${k}" ${repF.range === k ? 'selected' : ''}>${l}</option>`).join('')}<option value="custom" ${repF.range === 'custom' ? 'selected' : ''}>Custom dates…</option></select>
      ${repF.range === 'custom' ? `<input class="input" type="date" value="${esc(repF.from || from)}" onchange="repF.from=this.value;renderView()" aria-label="From"><input class="input" type="date" value="${esc(repF.to || to)}" onchange="repF.to=this.value;renderView()" aria-label="To">` : ''}
      ${me.role !== 'cashier' ? selectShops('repShop', repF.shop, { all: true, any: 'All locations', onchange: 'repF.shop=this.value;renderView()' }) : ''}
      <button class="btn ghost" onclick="repKey='';renderView()" title="Refresh">${icon('refund')}Refresh</button></div></div>`;
    const tabs = tabbar('repTabs', [['overview', 'Overview', 'dashboard'], ['pl', 'Profit & loss', 'coins'], ['products', 'Products', 'box'], ['people', 'Staff & shops', 'users'], ['payments', 'Payments', 'wallet'], ['debts', 'Debtors', 'alert'], ['stock', 'Stock value', 'layers'], ['shifts', 'Shifts', 'clock']], tab, 'repTab');
    if (repKey !== key || !repData) { if (!repLoading) loadReport(key, from, to); return head + tabs + `<div class="card"><div class="empty"><span class="spinner"></span> Building your report…</div></div>`; }
    const views = { overview: repOverview, pl: repPL, products: repProducts, people: repPeople, payments: repPayments, debts: repDebts, stock: repStock, shifts: repShifts };
    return head + tabs + (views[tab] || repOverview)();
  }
};
function repTab(t) { setTab('tab', t); }
function repDates() { if (repF.range === 'custom') { const t = dateOnly(); const f = repF.from || addDays(-29); const to = repF.to || t; return f <= to ? [f, to] : [to, f]; } return rangeDates(repF.range); }
async function loadReport(key, from, to) {
  repLoading = true;
  try { repData = await rpc('dq_report', { p: { from, to, shop_id: repF.shop || null } }); repKey = key; }
  catch (e) { toast(errMsg(e), 'bad'); repData = null; repKey = key; }
  finally { repLoading = false; if (view === 'reports') renderView(); }
}
function prevDelta(cur, prev) { if (!prev) return ''; const d = (cur - prev) / Math.abs(prev) * 100; return `<span class="${d >= 0 ? 'ok' : 'bad'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}%</span>`; }

function repOverview() {
  if (!repData) return '';
  const s = repData.summary, days = repData.by_day || [];
  const margin = pct(s.profit, s.net_sales);
  const half = Math.floor(days.length / 2), first = sum(days.slice(0, half), 'sales'), second = sum(days.slice(half), 'sales');
  const best = days.slice().sort((a, b) => b.sales - a.sales)[0];
  const hours = Array.from({ length: 24 }, (_, h) => ({ label: pad(h) + ':00', short: h % 3 === 0 ? pad(h) : '', ...(repData.by_hour.find(x => x.h === h) || { sales: 0, receipts: 0 }) })).filter((x, i, a) => i >= 6 && i <= 22 || x.sales > 0);
  const busiest = hours.slice().sort((a, b) => b.receipts - a.receipts)[0];
  return `<div class="grid g4">
    ${kpi('cart', 'Net sales', money(s.net_sales), `${num(s.receipts)} receipt(s) · ${days.length > 6 ? 'trend ' + prevDelta(second, first) : ''}`)}
    ${kpi('chart', 'Gross profit', money(s.profit), `${margin}% margin`, 'teal')}
    ${kpi('receipt', 'Average receipt', money(s.avg_receipt), `${num(s.items)} item(s) sold · ${num(s.qr_items)} by QR`)}
    ${kpi('coins', 'Cash collected', money(s.collected), `credit given ${money(s.credit_issued)}`, Number(s.credit_issued) > 0 ? 'warn' : '')}
   </div>
   <div class="grid g4" style="margin-top:12px">
    ${kpi('tag', 'Discounts', money(s.discounts), `points redeemed ${money(s.points_value)}`)}
    ${kpi('refund', 'Returns', money(s.refunds), s.net_sales ? pct(s.refunds, Number(s.net_sales) + Number(s.refunds)) + '% of sales' : '', Number(s.refunds) > 0 ? 'bad' : '')}
    ${kpi('minus', 'Expenses', money(s.expenses), 'recorded in the period')}
    ${kpi('spark', 'Net profit', money(Number(s.profit) - Number(s.expenses) - Number(repData.qr_spend || 0)), 'after expenses & QR labels', Number(s.profit) - Number(s.expenses) < 0 ? 'bad' : 'teal')}
   </div>
   <div class="card" style="margin-top:16px"><div class="cardHead"><div><h3>Sales and profit by day</h3><p>${best && best.sales > 0 ? `Best day: <b>${fmtD(best.d)}</b> with ${money(best.sales)}` : 'No sales in this period yet.'}</p></div></div>
    ${barChart(days.map(d => ({ label: fmtD(d.d), short: days.length > 40 ? String(d.d).slice(5) : String(d.d).slice(8), sales: d.sales, profit: d.profit })), [['sales', '#2F5BEA', 'Sales'], ['profit', '#14B8A6', 'Gross profit']], { labels: 14, title: 'Sales by day' })}</div>
   <div class="grid g2">
    <div class="card"><div class="cardHead"><div><h3>Busiest hours</h3><p>${busiest && busiest.receipts ? `Most customers around <b>${busiest.label}</b>. Plan staff and restocking around it.` : 'No sales yet.'}</p></div></div>${barChart(hours, [['receipts', '#8B5CF6', 'Receipts']], { h: 180, labels: 24 })}</div>
    <div class="card"><div class="cardHead"><div><h3>Top products</h3><p>By revenue</p></div><button class="btn small ghost" onclick="repTab('products')">All products</button></div>${hBars((repData.by_product || []).slice(0, 8), 'name', 'revenue')}</div>
   </div>
   <div class="grid g2">
    <div class="card"><div class="cardHead"><div><h3>How customers paid</h3></div><button class="btn small ghost" onclick="repTab('payments')">Details</button></div>${payMix()}</div>
    <div class="card"><div class="cardHead"><div><h3>Categories</h3></div></div>${hBars(repData.by_category || [], 'category', 'revenue')}</div>
   </div>`;
}
function payMix() {
  const m = groupBy((repData.by_method || []).filter(x => x.kind !== 'refund'), x => x.method);
  const parts = Object.entries(m).map(([k, v], i) => ({ l: k, v: sum(v, 'amount'), c: PALETTE[i % PALETTE.length] })).sort((a, b) => b.v - a.v);
  const t = sum(parts, 'v');
  return `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">${donut(parts)}<div style="flex:1;min-width:180px">${parts.map(p => `<div class="row" style="padding:6px 0"><span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${p.c};margin-right:6px"></i>${esc(p.l)}</span><b>${money(p.v)} <small class="muted">${pct(p.v, t)}%</small></b></div>`).join('') || '<p class="muted">No payments yet.</p>'}</div></div>`;
}
function repPL() {
  const s = repData.summary, qr = Number(repData.qr_spend || 0), exp = repData.expenses || [];
  const gross = Number(s.gross), net = Number(s.net_sales), cogs = Number(s.cost), gp = Number(s.profit), opex = Number(s.expenses), np = gp - opex - qr;
  const line = (l, v, cls = '', strong) => `<div class="row" style="${strong ? 'font-weight:800;font-size:15px' : ''}"><span class="${cls}">${l}</span><span class="num ${cls}">${money(v)}</span></div>`;
  return `<div class="grid g2"><div class="card"><div class="cardHead"><div><h3>Profit &amp; loss statement</h3><p>${fmtD(repData.from)} – ${fmtD(repData.to)}</p></div></div>
    ${line('Gross sales (before discounts)', gross)}${line('− Discounts', -Number(s.discounts), 'muted')}${line('− Loyalty points redeemed', -Number(s.points_value), 'muted')}${line('− Returns / refunds', -Number(s.refunds), 'muted')}
    ${line('Net sales', net, '', true)}${line('− Cost of goods sold', -cogs, 'muted')}${line('Gross profit', gp, gp >= 0 ? 'ok' : 'bad', true)}
    <div class="muted" style="font-size:12px;margin:8px 0 2px">OPERATING EXPENSES</div>${exp.map(e => line('− ' + esc(e.category || 'Other'), -e.amount, 'muted')).join('') || '<p class="muted" style="margin:4px 0">No expenses recorded.</p>'}${line('− QR labels (DeepQr)', -qr, 'muted')}
    ${line('Net profit', np, np >= 0 ? 'ok' : 'bad', true)}
    <p class="muted" style="font-size:12px">Gross margin ${pct(gp, net)}% · net margin ${pct(np, net)}%. Cost of goods uses the cost saved on each sale line (or the product cost for older sales).</p></div>
   <div class="card"><div class="cardHead"><div><h3>Where the money went</h3></div></div>
    <div style="display:flex;justify-content:center">${donut([{ l: 'Cost of goods', v: cogs, c: '#64748B' }, { l: 'Expenses', v: opex, c: '#F59E0B' }, { l: 'QR labels', v: qr, c: '#8B5CF6' }, { l: 'Net profit', v: Math.max(0, np), c: '#14B8A6' }], 190)}</div>
    <div class="legendRow" style="justify-content:center"><span><i style="background:#64748B"></i>Cost of goods</span><span><i style="background:#F59E0B"></i>Expenses</span><span><i style="background:#8B5CF6"></i>QR labels</span><span><i style="background:#14B8A6"></i>Net profit</span></div>
    <h3 style="margin:18px 0 8px">Money still to collect</h3>${line('Credit given in the period', s.credit_issued, Number(s.credit_issued) ? 'warn' : '')}${line('Total owed by customers today', sum(repData.debtors || [], 'balance'), 'warn')}${line('Owed to suppliers today', sum(repData.supplier_balances || [], x => Math.max(0, x.balance)), 'bad')}
   </div></div>`;
}
let repProdSort = 'revenue';
function repProducts() {
  const list = (repData.by_product || []).slice().sort((a, b) => Number(b[repProdSort]) - Number(a[repProdSort]));
  const sold = new Set(list.map(x => x.code));
  const dead = cache.products.filter(p => p.active !== false && !sold.has(p.code) && totalStock(p) > 0);
  return `<div class="card"><div class="cardHead"><div><h3>Product performance</h3><p>Sorted by <select class="input" style="display:inline-block;width:auto;padding:4px 8px" onchange="repProdSort=this.value;renderView()">${[['revenue', 'revenue'], ['profit', 'profit'], ['qty', 'quantity']].map(([k, l]) => `<option value="${k}" ${repProdSort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></p></div></div>
   <div class="tableWrap"><table><thead><tr><th>#</th><th>Product</th><th>Code</th><th class="right">Qty sold</th><th class="right">Revenue</th><th class="right">Cost</th><th class="right">Profit</th><th class="right">Margin</th><th class="right">Share</th></tr></thead><tbody>
   ${list.map((x, i) => `<tr><td class="muted">${i + 1}</td><td><b>${esc(x.name)}</b></td><td class="mono">${esc(x.code || '')}</td><td class="right num">${num(x.qty)}</td><td class="right num">${money(x.revenue)}</td><td class="right num muted">${money(x.cost)}</td><td class="right num ${Number(x.profit) < 0 ? 'bad' : 'ok'}">${money(x.profit)}</td><td class="right num">${pct(x.profit, x.revenue)}%</td><td class="right num">${pct(x.revenue, repData.summary.net_sales)}%</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No sales in this period.</td></tr>'}
   </tbody></table></div></div>
   ${dead.length ? `<div class="card"><div class="cardHead"><div><h3>Not selling (${dead.length})</h3><p>In stock but no sales in this period — consider a promotion, a transfer to another shop or not reordering.</p></div></div><div class="tableWrap"><table><thead><tr><th>Product</th><th class="right">On hand</th><th class="right">Value at cost</th></tr></thead><tbody>${dead.slice(0, 40).map(p => `<tr><td>${esc(p.name)} <small class="muted mono">${esc(p.code)}</small></td><td class="right num">${num(totalStock(p))}</td><td class="right num">${money(totalStock(p) * p.cost)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
}
function repPeople() {
  const c = repData.by_cashier || [], sh = repData.by_shop || [];
  return `<div class="grid g2"><div class="card"><div class="cardHead"><div><h3>Sales by staff</h3></div></div>${hBars(c, 'name', 'sales')}
    <div class="tableWrap" style="margin-top:12px"><table style="min-width:0"><thead><tr><th>Staff</th><th class="right">Receipts</th><th class="right">Sales</th><th class="right">Avg</th><th class="right">Discounts</th></tr></thead><tbody>${c.map(x => `<tr><td>${esc(x.name || '—')}</td><td class="right num">${x.receipts}</td><td class="right num">${money(x.sales)}</td><td class="right num">${money(x.receipts ? x.sales / x.receipts : 0)}</td><td class="right num ${Number(x.discounts) > 0 ? 'warn' : ''}">${money(x.discounts)}</td></tr>`).join('')}</tbody></table></div></div>
   <div class="card"><div class="cardHead"><div><h3>Sales by location</h3></div></div>${hBars(sh, 'name', 'sales')}
    <div class="tableWrap" style="margin-top:12px"><table style="min-width:0"><thead><tr><th>Location</th><th class="right">Receipts</th><th class="right">Sales</th><th class="right">Share</th></tr></thead><tbody>${sh.map(x => `<tr><td>${esc(x.name || '—')}</td><td class="right num">${x.receipts}</td><td class="right num">${money(x.sales)}</td><td class="right num">${pct(x.sales, repData.summary.net_sales)}%</td></tr>`).join('')}</tbody></table></div></div></div>`;
}
function repPayments() {
  const rows = repData.by_method || [];
  const kinds = { sale: 'At the till', debt_payment: 'Debt payments', refund: 'Refunds paid out' };
  const byKind = groupBy(rows, r => r.kind);
  return `<div class="grid g3">${Object.keys(kinds).map(k => kpi(k === 'refund' ? 'refund' : k === 'sale' ? 'cart' : 'coins', kinds[k], money(Math.abs(sum(byKind[k] || [], 'amount'))), `${sum(byKind[k] || [], 'count')} payment(s)`, k === 'refund' ? 'bad' : k === 'debt_payment' ? 'teal' : '')).join('')}</div>
   <div class="grid g2" style="margin-top:16px"><div class="card"><div class="cardHead"><div><h3>Payment mix</h3></div></div>${payMix()}</div>
   <div class="card"><div class="cardHead"><div><h3>All payment lines</h3><p>Match these totals with your till, bank and mobile-money statements.</p></div></div><div class="tableWrap"><table style="min-width:0"><thead><tr><th>Method</th><th>Type</th><th class="right">Count</th><th class="right">Amount</th></tr></thead><tbody>${rows.map(r => `<tr><td><b>${esc(r.method)}</b></td><td>${esc(kinds[r.kind] || r.kind)}</td><td class="right num">${r.count}</td><td class="right num ${r.amount < 0 ? 'bad' : ''}">${money(r.amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No payments in this period.</td></tr>'}</tbody><tfoot><tr><th colspan="3">Net money in</th><th class="right">${money(sum(rows, 'amount'))}</th></tr></tfoot></table></div></div></div>`;
}
function repDebts() {
  const d = repData.debtors || [];
  const tot = k => sum(d, k);
  return `<div class="grid g4">${kpi('alert', 'Total owed', money(tot('balance')), `${d.length} customer(s)`, 'warn')}${kpi('clock', '0–30 days', money(tot('d30')))}${kpi('clock', '31–90 days', money(tot('d60') + tot('d90')), '', tot('d60') + tot('d90') > 0 ? 'warn' : '')}${kpi('ban', 'Over 90 days', money(tot('d90plus')), 'hard to collect', tot('d90plus') > 0 ? 'bad' : '')}</div>
   <div class="card" style="margin-top:16px"><div class="cardHead"><div><h3>Debtors aging</h3><p>Based on the date of each unpaid receipt. Over-limit customers are highlighted.</p></div></div><div class="tableWrap"><table><thead><tr><th>Customer</th><th>Phone</th><th class="right">0–30</th><th class="right">31–60</th><th class="right">61–90</th><th class="right">90+</th><th class="right">Total</th><th>Oldest</th><th></th></tr></thead><tbody>
   ${d.map(x => `<tr class="clickRow" onclick="openCustomer('${x.id}')"><td><b>${esc(x.name)}</b>${Number(x.credit_limit) && Number(x.balance) > Number(x.credit_limit) ? ' <span class="tag bad">Over limit</span>' : ''}</td><td>${esc(x.phone || '')}</td><td class="right num">${money(x.d30)}</td><td class="right num">${money(x.d60)}</td><td class="right num ${Number(x.d90) ? 'warn' : ''}">${money(x.d90)}</td><td class="right num ${Number(x.d90plus) ? 'bad' : ''}">${money(x.d90plus)}</td><td class="right num"><b>${money(x.balance)}</b></td><td>${x.oldest ? daysSince(x.oldest) + ' days' : ''}</td><td onclick="event.stopPropagation()">${x.phone ? `<a class="btn small" target="_blank" rel="noopener" href="https://wa.me/${phoneClean(x.phone).replace(/^0/, '255').replace('+', '')}?text=${encodeURIComponent(`Habari ${x.name}, salio lako ${business.name} ni ${money(x.balance)}. Asante.`)}">${icon('whatsapp')}</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Nobody owes you money. 🎉</td></tr>'}
   </tbody></table></div></div>`;
}
function repStock() {
  const v = repData.valuation || [], vc = repData.valuation_by_category || [];
  const cost = sum(v, 'cost'), retail = sum(v, 'retail');
  const expiring = cache.items.filter(i => i.status === 'in_stock' && i.expiry_date && daysUntil(i.expiry_date) <= 30 && (!repF.shop || i.shop_id === repF.shop));
  const expVal = sum(expiring, i => Number(productById(i.product_id)?.cost || 0));
  return `<div class="grid g4">${kpi('layers', 'Stock at cost', money(cost), `${num(sum(v, 'units'))} unit(s)`)}${kpi('tag', 'Stock at retail', money(retail), 'if everything sells at list price', 'teal')}${kpi('chart', 'Potential profit', money(retail - cost), pct(retail - cost, retail) + '% margin')}${kpi('clock', 'Expiring ≤30 days', money(expVal), `${expiring.length} labelled item(s)`, expiring.length ? 'warn' : '')}</div>
   <div class="grid g2" style="margin-top:16px"><div class="card"><div class="cardHead"><div><h3>By location</h3></div></div><div class="tableWrap"><table style="min-width:0"><thead><tr><th>Location</th><th class="right">Products</th><th class="right">Units</th><th class="right">Cost</th><th class="right">Retail</th></tr></thead><tbody>${v.map(x => `<tr><td>${esc(x.shop)}</td><td class="right num">${x.products}</td><td class="right num">${num(x.units)}</td><td class="right num">${money(x.cost)}</td><td class="right num">${money(x.retail)}</td></tr>`).join('')}</tbody></table></div></div>
   <div class="card"><div class="cardHead"><div><h3>By category</h3></div></div>${hBars(vc, 'category', 'cost')}</div></div>
   <div class="card"><div class="cardHead"><div><h3>Supplier balances</h3><p>What you owe today.</p></div><button class="btn small ghost" onclick="go('orders',{tab:'suppliers'})">Suppliers</button></div>${hBars((repData.supplier_balances || []).filter(x => x.balance > 0), 'name', 'balance')}</div>`;
}
function repShifts() {
  const s = repData.shifts || [];
  const short = s.filter(x => Number(x.difference) < 0);
  return `<div class="grid g3">${kpi('clock', 'Shifts', s.length, `${s.filter(x => x.status === 'open').length} still open`)}${kpi('alert', 'Cash short', money(-sum(short, 'difference')), `${short.length} shift(s)`, short.length ? 'bad' : '')}${kpi('coins', 'Cash over', money(sum(s.filter(x => Number(x.difference) > 0), 'difference')), '')}</div>
   <div class="card" style="margin-top:16px"><div class="tableWrap"><table><thead><tr><th>Cashier</th><th>Location</th><th>Opened</th><th>Closed</th><th class="right">Float</th><th class="right">Expected cash</th><th class="right">Counted</th><th class="right">Difference</th><th></th></tr></thead><tbody>
   ${s.map(x => `<tr><td>${esc(x.member_name)}</td><td>${esc(x.shop || '')}</td><td>${fmtDT(x.opened_at)}</td><td>${x.closed_at ? fmtDT(x.closed_at) : '<span class="tag info">Open</span>'}</td><td class="right num">${money(x.opening_float)}</td><td class="right num">${x.expected_cash != null ? money(x.expected_cash) : '—'}</td><td class="right num">${x.counted_cash != null ? money(x.counted_cash) : '—'}</td><td class="right num ${Number(x.difference) < 0 ? 'bad' : Number(x.difference) > 0 ? 'warn' : 'ok'}"><b>${x.difference != null ? money(x.difference) : '—'}</b></td><td><button class="btn small" onclick="viewShift('${x.id}')">${icon('eye')}</button></td></tr>`).join('') || '<tr><td colspan="9" class="empty">No shifts in this period.</td></tr>'}
   </tbody></table></div></div>`;
}
function exportReport() {
  if (!repData) return;
  const tab = viewParams.tab || 'overview', f = `deepqr-${tab}-${repData.from}_${repData.to}.csv`;
  const s = repData.summary;
  const map = {
    overview: [['Date', 'Receipts', 'Sales', 'Gross profit']].concat((repData.by_day || []).map(d => [d.d, d.receipts, d.sales, d.profit])),
    pl: [['Line', 'Amount'], ['Gross sales', s.gross], ['Discounts', -s.discounts], ['Points redeemed', -s.points_value], ['Refunds', -s.refunds], ['Net sales', s.net_sales], ['Cost of goods', -s.cost], ['Gross profit', s.profit], ...(repData.expenses || []).map(e => ['Expense: ' + e.category, -e.amount]), ['QR labels', -repData.qr_spend], ['Net profit', s.profit - s.expenses - repData.qr_spend]],
    products: [['Product', 'Code', 'Qty', 'Revenue', 'Cost', 'Profit']].concat((repData.by_product || []).map(x => [x.name, x.code, x.qty, x.revenue, x.cost, x.profit])),
    people: [['Staff', 'Receipts', 'Sales', 'Discounts']].concat((repData.by_cashier || []).map(x => [x.name, x.receipts, x.sales, x.discounts])),
    payments: [['Method', 'Type', 'Count', 'Amount']].concat((repData.by_method || []).map(x => [x.method, x.kind, x.count, x.amount])),
    debts: [['Customer', 'Phone', '0-30', '31-60', '61-90', '90+', 'Total', 'Oldest']].concat((repData.debtors || []).map(x => [x.name, x.phone, x.d30, x.d60, x.d90, x.d90plus, x.balance, x.oldest])),
    stock: [['Location', 'Products', 'Units', 'Cost', 'Retail']].concat((repData.valuation || []).map(x => [x.shop, x.products, x.units, x.cost, x.retail])),
    shifts: [['Cashier', 'Location', 'Opened', 'Closed', 'Float', 'Expected', 'Counted', 'Difference']].concat((repData.shifts || []).map(x => [x.member_name, x.shop, x.opened_at, x.closed_at, x.opening_float, x.expected_cash, x.counted_cash, x.difference]))
  };
  downloadCSV(f, map[tab] || map.overview);
}
