/* =============================================================================
   Purchase orders, goods received (GRN), suppliers, supplier payments, documents
   ============================================================================= */
const ORDER_STATUS = {
  draft: ['Draft', 'gray'], pending: ['Ordered', 'info'], ordered: ['Ordered', 'info'], partial: ['Part received', 'warn'],
  received: ['Received', 'ok'], closed: ['Closed', 'gray'], cancelled: ['Cancelled', 'bad']
};
const OPEN_ORDER = ['ordered', 'pending', 'partial'];
let ordF = { status: 'open', supplier: '', shop: '' };
let poDraft = null;

function canManageOrders() { return me && ['owner', 'manager', 'inventory', 'main_operator'].includes(me.role); }
function canReceive() { return isMgr() || !!perms.can_receive_orders; }
function orderTag(o) {
  const s = ORDER_STATUS[o.status] || [o.status, 'gray'];
  const late = OPEN_ORDER.includes(o.status) && o.expected_date && daysUntil(o.expected_date) < 0;
  return `<span class="tag ${s[1]}">${s[0]}</span>${late ? ` <span class="tag bad">${-daysUntil(o.expected_date)}d late</span>` : ''}`;
}
function payTag(o) {
  if (['draft', 'cancelled'].includes(o.status)) return '';
  return o.payment_status === 'paid' ? '<span class="tag ok">Paid</span>' : o.payment_status === 'partial' ? '<span class="tag warn">Part paid</span>' : '<span class="tag gray">Unpaid</span>';
}
function orderLines(id) { return cache.orderItems.filter(i => i.order_id === id); }
function lineOutstanding(i) { return i.status === 'cancelled' ? 0 : Math.max(0, Number(i.qty_ordered) - Number(i.qty_received) - Number(i.qty_damaged || 0)); }
function orderOutstanding(o) { return sum(orderLines(o.id), lineOutstanding); }
function orderOutstandingValue(o) { return sum(orderLines(o.id), i => lineOutstanding(i) * Number(i.unit_cost || 0)); }
function orderUnits(o) { const l = orderLines(o.id); return { ordered: sum(l, 'qty_ordered'), received: sum(l, 'qty_received'), damaged: sum(l, 'qty_damaged') }; }
function orderPayable(o) { return Number(o.invoice_amount ?? 0) || Number(o.received_value || 0) || Number(o.total_cost || 0); }
function orderBalance(o) { return Math.max(0, Math.round((orderPayable(o) - Number(o.paid_amount || 0)) * 100) / 100); }
function supName(o) { return o.supplier_name || supplierById(o.supplier_id)?.name || '—'; }

/* ---------------- documents (Supabase Storage, private bucket) ---------------- */
const DOC_KINDS = [['invoice', 'Supplier invoice'], ['delivery_note', 'Delivery note'], ['proforma', 'Proforma / quotation'], ['receipt', 'Payment receipt'], ['other', 'Other']];
function docKindName(k) { return (DOC_KINDS.find(x => x[0] === k) || [k, 'Document'])[1]; }
async function uploadDocs(files, folder, kind) {
  const bucket = CFG.docsBucket || 'dq-docs', out = [];
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) { toast(`${f.name} is larger than 10 MB`, 'bad'); continue; }
    if (!/^(application\/pdf|image\/)/.test(f.type || '')) { toast(`${f.name}: only PDF and photos are accepted`, 'bad'); continue; }
    const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
    const path = `${me.business_id}/${folder}/${uid()}-${safe}`;
    const { error } = await sb.storage.from(bucket).upload(path, f, { contentType: f.type, upsert: false });
    if (error) throw new Error(`Upload of ${f.name} failed: ${error.message}`);
    out.push({ path, name: f.name, size: f.size, type: f.type, kind: kind || 'other', uploaded_at: new Date().toISOString(), by: me.name });
  }
  return out;
}
async function openDoc(path) {
  const w = window.open('', '_blank');
  const { data, error } = await sb.storage.from(CFG.docsBucket || 'dq-docs').createSignedUrl(path, 600);
  if (error || !data?.signedUrl) { if (w) w.close(); toast('Could not open the document: ' + (error?.message || 'not found'), 'bad'); return; }
  if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
}
function fileSize(b) { b = Number(b || 0); return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
function docListHtml(docs, removeFn) {
  if (!docs?.length) return '<p class="muted" style="margin:6px 0">No documents attached.</p>';
  return `<div class="fileList">${docs.map((d, i) => `<div class="fileItem">${icon(d.type === 'application/pdf' ? 'file' : 'eye')}<div style="flex:1;min-width:0"><b style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</b><small class="muted">${esc(docKindName(d.kind))} · ${fileSize(d.size)}${d.by ? ' · ' + esc(d.by) : ''}${d.uploaded_at ? ' · ' + fmtD(d.uploaded_at) : ''}</small></div>${d.path ? `<button type="button" class="btn small" onclick="openDoc('${jsq(d.path)}')">${icon('eye')}Open</button>` : '<span class="tag info">New</span>'}${removeFn ? `<button type="button" class="btn small ghost" onclick="${removeFn}(${i})" title="Remove">${icon('trash')}</button>` : ''}</div>`).join('')}</div>`;
}
function dropzoneHtml(id, label) {
  return `<label class="dropzone" id="${id}Zone" for="${id}">${icon('upload')}<div><b>${label || 'Attach invoice or delivery note'}</b></div><small>PDF or photo, up to 10 MB each. On a phone you can take a picture.</small><input type="file" id="${id}" multiple accept="application/pdf,image/*" class="hidden"></label>`;
}
function bindDropzone(id, onFiles) {
  const inp = document.getElementById(id), z = document.getElementById(id + 'Zone'); if (!inp || !z) return;
  inp.onchange = () => { onFiles([...inp.files]); inp.value = ''; };
  z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', e => { e.preventDefault(); z.classList.remove('over'); onFiles([...e.dataTransfer.files]); });
}

/* ---------------- page ---------------- */
PAGES.orders = {
  title: 'Purchase orders', searchable: true,
  sub: () => me.role === 'cashier' ? 'Deliveries for your shop — count what arrived and record it' : 'Order from suppliers, receive deliveries, track what is still outstanding and what you owe',
  actions: () => canManageOrders() ? `<button class="btn" onclick="exportOrders()">${icon('download')}Export</button><button class="btn" onclick="editSupplier()">${icon('plus')}Supplier</button><button class="btn primary" onclick="openOrderEditor()">${icon('plus')}New order</button>` : '',
  render: () => {
    if (me.role === 'cashier' || !canManageOrders()) return deliveriesView();
    const tab = viewParams.tab || 'orders';
    const open = cache.orders.filter(o => OPEN_ORDER.includes(o.status));
    const late = open.filter(o => o.expected_date && daysUntil(o.expected_date) < 0);
    const owed = sum(cache.suppliers, s => Math.max(0, Number(s.balance)));
    const monthStart = dateOnly(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const recvMonth = sum(cache.receipts.filter(r => dateOnly(r.received_at) >= monthStart), 'total_value');
    return `<div class="grid g4">${kpi('truck', 'Open orders', open.length, `${num(sum(open, orderOutstanding))} unit(s) still to arrive`)}${kpi('clock', 'Overdue', `<span class="${late.length ? 'bad' : ''}">${late.length}</span>`, late.length ? 'past the expected date' : 'all on time', late.length ? 'bad' : '')}${kpi('box', 'Outstanding value', money(sum(open, orderOutstandingValue)), 'ordered, not yet received')}${kpi('coins', 'Owed to suppliers', money(owed), `received this month ${money(recvMonth)}`, owed > 0 ? 'warn' : '')}</div>
    <div style="margin-top:16px">${tabbar('ordTabs', [['orders', 'Orders', 'truck', open.length || ''], ['suppliers', 'Suppliers', 'users', cache.suppliers.length], ['grn', 'Goods received', 'check'], ['payments', 'Supplier payments', 'coins']], tab, 'ordTab')}</div>
    ${tab === 'suppliers' ? suppliersView() : tab === 'grn' ? grnView() : tab === 'payments' ? supPaymentsView() : ordersView()}`;
  }
};
function ordTab(t) { setTab('tab', t); }

function filteredOrders() {
  let list = cache.orders.slice();
  const st = ordF.status;
  if (st === 'open') list = list.filter(o => OPEN_ORDER.includes(o.status) || o.status === 'draft');
  else if (st === 'late') list = list.filter(o => OPEN_ORDER.includes(o.status) && o.expected_date && daysUntil(o.expected_date) < 0);
  else if (st === 'unpaid') list = list.filter(o => !['draft', 'cancelled'].includes(o.status) && Number(o.received_value) > 0 && o.payment_status !== 'paid');
  else if (st !== 'all') list = list.filter(o => o.status === st);
  if (ordF.supplier) list = list.filter(o => o.supplier_id === ordF.supplier);
  if (ordF.shop) list = list.filter(o => o.shop_id === ordF.shop);
  if (search) { const q = search.toLowerCase(); list = list.filter(o => [o.order_no, o.ref, o.invoice_no, supName(o), o.note, ...orderLines(o.id).map(i => i.product_name || productById(i.product_id)?.name)].join(' ').toLowerCase().includes(q)); }
  return list;
}
function ordersView() {
  const list = filteredOrders();
  const pills = [['open', 'Open'], ['late', 'Overdue'], ['draft', 'Drafts'], ['partial', 'Part received'], ['received', 'Received'], ['unpaid', 'Unpaid'], ['closed', 'Closed'], ['cancelled', 'Cancelled'], ['all', 'All']];
  return `<div class="card"><div class="toolbar"><input class="input grow" id="ordSearch" value="${esc(search)}" oninput="liveSearch(this)" placeholder="Search order no, supplier, invoice or product…">
    <select class="input" onchange="ordF.supplier=this.value;renderView()" aria-label="Supplier"><option value="">All suppliers</option>${cache.suppliers.map(s => `<option value="${s.id}" ${ordF.supplier === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    ${selectShops('ordShop', ordF.shop, { all: true, any: 'All locations', onchange: "ordF.shop=this.value;renderView()" })}</div>
   <div class="pillRow">${pills.map(([k, l]) => `<button class="pill ${ordF.status === k ? 'active' : ''}" onclick="ordF.status='${k}';renderView()">${l}</button>`).join('')}</div>
   <div class="tableWrap"><table><thead><tr><th>Order</th><th>Supplier</th><th>Deliver to</th><th>Ordered</th><th>Expected</th><th style="width:150px">Received</th><th class="right">Value</th><th class="right">Balance</th><th>Status</th><th>Docs</th></tr></thead><tbody>
   ${list.map(o => { const u = orderUnits(o); const docs = (o.attachments || []).length; return `<tr class="clickRow" onclick="openOrder('${o.id}')"><td><b class="mono">${esc(o.order_no || o.ref || 'PO')}</b>${o.invoice_no ? `<br><small class="muted">Inv ${esc(o.invoice_no)}</small>` : ''}</td><td>${esc(supName(o))}</td><td>${esc(shopObj(o.shop_id)?.name || '')}</td><td>${fmtD(o.order_date || o.created_at)}</td><td>${o.expected_date ? fmtD(o.expected_date) : '—'}</td><td>${progressBar(u.received + u.damaged, u.ordered)}<small class="muted">${num(u.received)} / ${num(u.ordered)}${u.damaged ? ` · <span class="bad">${num(u.damaged)} damaged</span>` : ''}</small></td><td class="right num">${money(Number(o.received_value) || o.total_cost)}</td><td class="right num ${orderBalance(o) > 0 && Number(o.received_value) > 0 ? 'warn' : ''}">${['draft', 'cancelled'].includes(o.status) ? '—' : money(orderBalance(o))}</td><td>${orderTag(o)} ${payTag(o)}</td><td>${docs ? `<span class="tag info">${icon('file')}${docs}</span>` : '<span class="muted">—</span>'}</td></tr>`; }).join('') || `<tr><td colspan="10">${emptyState('truck', 'No purchase orders here', 'Create an order to tell your supplier what you need, then receive the goods against it.', `<button class="btn primary" onclick="openOrderEditor()">${icon('plus')}New order</button>`)}</td></tr>`}
   </tbody></table></div></div>`;
}

/* ---------------- cashier / store view: deliveries for my shop ---------------- */
function deliveriesView() {
  const mine = cache.orders.filter(o => (me.role !== 'cashier' || o.shop_id === me.shop_id));
  const open = mine.filter(o => OPEN_ORDER.includes(o.status));
  const done = mine.filter(o => ['received', 'closed'].includes(o.status)).slice(0, 30);
  return `<div class="card"><div class="cardHead"><div><h3>Expected deliveries</h3><p>When goods arrive, open the order, count each product and record what arrived and what was damaged. Attach the delivery note photo.</p></div></div>
   <div class="tableWrap"><table><thead><tr><th>Order</th><th>Supplier</th><th>Expected</th><th style="width:150px">Arrived so far</th><th>Status</th><th></th></tr></thead><tbody>
   ${open.map(o => { const u = orderUnits(o); return `<tr><td class="mono"><b>${esc(o.order_no || 'PO')}</b></td><td>${esc(supName(o))}</td><td>${o.expected_date ? fmtD(o.expected_date) : '—'}</td><td>${progressBar(u.received + u.damaged, u.ordered)}<small class="muted">${num(u.received)} / ${num(u.ordered)}</small></td><td>${orderTag(o)}</td><td><div class="actions"><button class="btn small" onclick="openOrder('${o.id}')">${icon('eye')}View</button>${canReceive() ? `<button class="btn small primary" onclick="openReceive('${o.id}')">${icon('check')}Receive</button>` : ''}</div></td></tr>`; }).join('') || `<tr><td colspan="6">${emptyState('truck', 'No deliveries expected', 'Purchase orders for your shop appear here when the manager places them.')}</td></tr>`}
   </tbody></table></div></div>
   ${done.length ? `<div class="card"><div class="cardHead"><div><h3>Recently received</h3></div></div><div class="tableWrap"><table><thead><tr><th>Order</th><th>Supplier</th><th>Received</th><th>Status</th></tr></thead><tbody>${done.map(o => `<tr class="clickRow" onclick="openOrder('${o.id}')"><td class="mono">${esc(o.order_no || '')}</td><td>${esc(supName(o))}</td><td>${num(orderUnits(o).received)} unit(s)</td><td>${orderTag(o)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
}

/* ---------------- order editor ---------------- */
function openOrderEditor(id, prefill) {
  if (!canManageOrders()) return;
  if (!cache.suppliers.length) { toast('Add your first supplier, then create the order', 'bad'); editSupplier(null, () => openOrderEditor(id, prefill)); return; }
  const o = id ? cache.orders.find(x => x.id === id) : null;
  const lines = o ? orderLines(o.id).map(i => ({ id: i.id, product_id: i.product_id, qty_ordered: Number(i.qty_ordered), unit_cost: Number(i.unit_cost), note: i.note || '', received: Number(i.qty_received) + Number(i.qty_damaged || 0) }))
    : (prefill?.items || []).map(i => ({ ...i, received: 0 }));
  const defShop = (cache.shops.find(s => s.type === 'warehouse') || cache.shops[0])?.id;
  poDraft = { id: o?.id || null, status: o?.status || 'new', supplier_id: o?.supplier_id || prefill?.supplier_id || '', shop_id: o?.shop_id || prefill?.shop_id || defShop,
    order_date: o?.order_date || dateOnly(), expected_date: o?.expected_date || '', invoice_no: o?.invoice_no || '', invoice_amount: o?.invoice_amount ?? '',
    ref: o?.ref || '', note: o?.note || '', lines, attachments: [...(o?.attachments || [])], newFiles: [], docKind: 'proforma' };
  if (!poDraft.supplier_id && cache.suppliers.length === 1) poDraft.supplier_id = cache.suppliers[0].id;
  if (!poDraft.lines.length) poDraft.lines.push({ product_id: '', qty_ordered: 1, unit_cost: 0, note: '', received: 0 });
  drawPoEditor();
}
function drawPoEditor() {
  const d = poDraft, editing = !!d.id;
  const sup = supplierById(d.supplier_id);
  modal(`<form id="poForm" novalidate><div class="cardHead"><div><h3>${editing ? 'Edit order ' + esc(cache.orders.find(x => x.id === d.id)?.order_no || '') : 'New purchase order'}</h3><p>Fields marked * are required. Quantities already received cannot go below what arrived.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="formGrid">
    <div class="field"><label for="poSup">Supplier *</label><div class="searchLine" style="margin:0"><select id="poSup" class="grow" required onchange="poDraft.supplier_id=this.value;poSupHint()"><option value="">Choose supplier…</option>${cache.suppliers.filter(s => s.active !== false || s.id === d.supplier_id).map(s => `<option value="${s.id}" ${s.id === d.supplier_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select><button type="button" class="btn" onclick="poSync();editSupplier(null,()=>drawPoEditor())" title="New supplier">${icon('plus')}</button></div><small class="muted" id="poSupHint">${sup ? supHint(sup) : ''}</small></div>
    <div class="field"><label for="poShop">Deliver to *</label>${selectShops('poShop', d.shop_id, { all: true })}</div>
    <div class="field"><label for="poDate">Order date *</label><input id="poDate" type="date" required value="${esc(d.order_date)}"></div>
    <div class="field"><label for="poExp">Expected delivery</label><input id="poExp" type="date" value="${esc(d.expected_date || '')}"></div>
    <div class="field"><label for="poInv">Supplier invoice no.</label><input id="poInv" value="${esc(d.invoice_no || '')}" placeholder="e.g. INV-2041"></div>
    <div class="field"><label for="poInvAmt">Invoice amount</label><input id="poInvAmt" type="number" min="0" step="any" value="${esc(d.invoice_amount ?? '')}" placeholder="as on the invoice"></div>
    <div class="field"><label for="poRef">Your reference</label><input id="poRef" value="${esc(d.ref || '')}" placeholder="optional"></div>
   </div>
   <h3 style="margin:18px 0 8px">Products</h3>
   <div class="tableWrap"><table style="min-width:620px"><thead><tr><th>Product *</th><th style="width:100px">Qty *</th><th style="width:130px">Unit cost *</th><th class="right">Line total</th><th></th></tr></thead><tbody id="poLines">${poLinesHtml()}</tbody></table></div>
   <div class="actions" style="margin-top:8px"><button type="button" class="btn small" onclick="poSync();poDraft.lines.push({product_id:'',qty_ordered:1,unit_cost:0,received:0});drawPoEditor()">${icon('plus')}Add product</button><button type="button" class="btn small" onclick="poAddLowStock()">${icon('spark')}Add low-stock items</button></div>
   <div class="totals" id="poTotals" style="margin-top:10px">${poTotalsHtml()}</div>
   <div class="field" style="margin-top:12px"><label for="poNote">Note to supplier / internal note</label><textarea id="poNote" rows="2">${esc(d.note || '')}</textarea></div>
   <h3 style="margin:18px 0 8px">Documents</h3>
   <div class="toolbar" style="margin-bottom:8px"><label class="muted" for="poKind">Type of the next upload</label><select id="poKind" class="input" onchange="poDraft.docKind=this.value">${DOC_KINDS.map(k => `<option value="${k[0]}" ${d.docKind === k[0] ? 'selected' : ''}>${k[1]}</option>`).join('')}</select></div>
   ${dropzoneHtml('poFiles', 'Attach the proforma, invoice or quotation')}
   <div id="poDocList">${docListHtml([...d.attachments, ...d.newFiles.map(f => ({ name: f.name, size: f.size, type: f.type, kind: f.__kind }))], 'poRemoveDoc')}</div>
   <div id="poErr" class="bad" style="min-height:20px;margin-top:10px"></div>
   <div class="actions" style="justify-content:flex-end">${!editing || d.status === 'draft' ? `<button type="button" class="btn" id="poDraftBtn" onclick="savePo('draft',this)">Save as draft</button>` : ''}<button type="button" class="btn primary" id="poSave" onclick="savePo('ordered',this)">${icon('check')}${editing && d.status !== 'draft' ? 'Save changes' : 'Place order'}</button></div>
   ${productOptions('poProdList')}</form>`, 'wide');
  bindDropzone('poFiles', files => { poSync(); files.forEach(f => { f.__kind = poDraft.docKind; poDraft.newFiles.push(f); }); drawPoEditor(); });
}
function supHint(s) { return [s.phone, s.payment_terms_days ? `pays in ${s.payment_terms_days} days` : 'cash on delivery', Number(s.balance) > 0 ? `you owe ${money(s.balance)}` : ''].filter(Boolean).map(esc).join(' · '); }
function poSupHint() { const s = supplierById(poDraft.supplier_id); const h = document.getElementById('poSupHint'); if (h) h.innerHTML = s ? supHint(s) : ''; }
function poLinesHtml() {
  return poDraft.lines.map((l, i) => { const p = productById(l.product_id); return `<tr><td><input class="input" list="poProdList" id="pol_p_${i}" value="${esc(p ? p.code : '')}" placeholder="Code or name" onchange="poPickProduct(${i},this.value)" style="width:100%">${p ? `<small class="muted">${esc(p.name)} · on hand ${num(totalStock(p))}${l.received ? ` · <b>${num(l.received)} already received</b>` : ''}</small>` : ''}</td><td><input class="input" type="number" min="${l.received || 1}" step="any" id="pol_q_${i}" value="${l.qty_ordered}" oninput="poRecalc()"></td><td><input class="input" type="number" min="0" step="any" id="pol_c_${i}" value="${l.unit_cost}" oninput="poRecalc()"></td><td class="right num" id="pol_t_${i}">${money(l.qty_ordered * l.unit_cost)}</td><td>${l.received ? '' : `<button type="button" class="btn small ghost" onclick="poSync();poDraft.lines.splice(${i},1);drawPoEditor()" title="Remove">${icon('trash')}</button>`}</td></tr>`; }).join('');
}
function poPickProduct(i, v) { setTimeout(() => poPickProductNow(i, v), 0); }   // deferred: runs on blur, so never redraw inside the blur
function poPickProductNow(i, v) {
  if (!document.getElementById('poForm')) return;
  poSync();
  const p = product(v) || cache.products.find(x => x.name.toLowerCase() === String(v).trim().toLowerCase());
  if (!p) { toast('Product not found — create it under Products first', 'bad'); return; }
  if (poDraft.lines.some((l, j) => j !== i && l.product_id === p.id)) { toast(p.name + ' is already on this order', 'bad'); return; }
  poDraft.lines[i].product_id = p.id; if (!Number(poDraft.lines[i].unit_cost)) poDraft.lines[i].unit_cost = Number(p.cost || 0);
  if (!poDraft.supplier_id && p.supplier_id) poDraft.supplier_id = p.supplier_id;
  drawPoEditor();
}
function poSync() {
  const d = poDraft, g = id => document.getElementById(id);
  if (!g('poForm')) return;
  d.supplier_id = g('poSup').value; d.shop_id = g('poShop').value; d.order_date = g('poDate').value; d.expected_date = g('poExp').value;
  d.invoice_no = g('poInv').value; d.invoice_amount = g('poInvAmt').value; d.ref = g('poRef').value; d.note = g('poNote').value;
  d.lines.forEach((l, i) => { if (g('pol_q_' + i)) { l.qty_ordered = Number(g('pol_q_' + i).value || 0); l.unit_cost = Number(g('pol_c_' + i).value || 0); } });
}
function poTotalsHtml() {
  const t = sum(poDraft.lines, l => Number(l.qty_ordered) * Number(l.unit_cost));
  const inv = Number(poDraft.invoice_amount || 0);
  return `<div class="row"><span>${poDraft.lines.filter(l => l.product_id).length} product(s) · ${num(sum(poDraft.lines, 'qty_ordered'))} unit(s)</span><b>${money(t)}</b></div>${inv && Math.abs(inv - t) > 0.5 ? `<div class="row warn"><span>Invoice differs from the order by</span><b>${money(inv - t)}</b></div>` : ''}`;
}
function poRecalc() { poSync(); poDraft.lines.forEach((l, i) => { const e = document.getElementById('pol_t_' + i); if (e) e.textContent = money(l.qty_ordered * l.unit_cost); }); document.getElementById('poTotals').innerHTML = poTotalsHtml(); }
function poRemoveDoc(i) {
  poSync();
  const n = poDraft.attachments.length;
  if (i < n) { if (!isMgr()) { toast('Only the owner or a manager can remove saved documents', 'bad'); return; } const [d] = poDraft.attachments.splice(i, 1); (poDraft.removed = poDraft.removed || []).push(d); }
  else poDraft.newFiles.splice(i - n, 1);
  drawPoEditor();
}
function poAddLowStock() {
  poSync();
  const shop = poDraft.shop_id; let added = 0;
  cache.products.filter(p => p.active !== false && (!poDraft.supplier_id || !p.supplier_id || p.supplier_id === poDraft.supplier_id)).forEach(p => {
    const q = stock(shop, p.code); if (q > threshold(p) || poDraft.lines.some(l => l.product_id === p.id)) return;
    const need = Math.max(Number(p.reorder_qty || 0), threshold(p) * 2 - q, 1) - onOrder(p.id, shop);
    if (need <= 0) return;
    poDraft.lines = poDraft.lines.filter(l => l.product_id); poDraft.lines.push({ product_id: p.id, qty_ordered: Math.ceil(need), unit_cost: Number(p.cost || 0), received: 0 }); added++;
  });
  if (!poDraft.lines.length) poDraft.lines.push({ product_id: '', qty_ordered: 1, unit_cost: 0, received: 0 });
  toast(added ? `${added} low-stock product(s) added` : 'Nothing is low at this location' + (poDraft.supplier_id ? ' for this supplier' : ''), added ? 'ok' : '');
  drawPoEditor();
}
async function savePo(status, btn) {
  poSync();
  const d = poDraft, err = document.getElementById('poErr'); err.textContent = '';
  const lines = d.lines.filter(l => l.product_id);
  const problems = [];
  if (!d.supplier_id) problems.push('choose a supplier');
  if (!d.shop_id) problems.push('choose where the goods will be delivered');
  if (!d.order_date) problems.push('enter the order date');
  if (d.expected_date && d.expected_date < d.order_date) problems.push('the expected date is before the order date');
  if (!lines.length) problems.push('add at least one product');
  lines.forEach(l => { const p = productById(l.product_id); if (!(l.qty_ordered > 0)) problems.push(`enter a quantity for ${p.name}`); if (l.qty_ordered < l.received) problems.push(`${p.name} already has ${l.received} received`); if (!(l.unit_cost >= 0)) problems.push(`enter the unit cost for ${p.name}`); });
  if (d.invoice_amount !== '' && Number(d.invoice_amount) < 0) problems.push('the invoice amount cannot be negative');
  if (problems.length) { err.textContent = 'Please ' + problems.join('; ') + '.'; beep(false); return; }
  await withBusy(btn, async () => {
    try {
      const uploaded = d.newFiles.length ? await uploadDocs(d.newFiles, 'orders', null) : [];
      uploaded.forEach((u, i) => { u.kind = d.newFiles[i]?.__kind || 'other'; });
      const attachments = [...d.attachments, ...uploaded];
      const o = await rpc('dq_save_order', { p: { id: d.id, status: d.id && d.status !== 'draft' ? 'ordered' : status, supplier_id: d.supplier_id, shop_id: d.shop_id, order_date: d.order_date, expected_date: d.expected_date || null, invoice_no: d.invoice_no, invoice_amount: d.invoice_amount === '' ? null : Number(d.invoice_amount), ref: d.ref, note: d.note, attachments, items: lines.map(l => ({ id: l.id || null, product_id: l.product_id, qty_ordered: l.qty_ordered, unit_cost: l.unit_cost, note: l.note || null })) } });
      if (d.id) await sb.from('orders').update({ attachments }).eq('id', d.id);
      for (const r of d.removed || []) await sb.storage.from(CFG.docsBucket || 'dq-docs').remove([r.path]);
      closeModal();
      await loadAllData();
      toast(`${o.order_no} ${status === 'draft' ? 'saved as draft' : d.id ? 'updated' : 'placed'}`, 'ok');
      const next = (window.__poQueue || []).shift();
      if (next) { renderView(); openOrderEditor(null, { supplier_id: next[0] || '', items: next[1].map(x => ({ product_id: x.pid, qty_ordered: x.qty, unit_cost: productById(x.pid)?.cost || 0 })) }); toast(`Next supplier: ${window.__poQueue.length + 1} order(s) left`); return; }
      go('orders', { tab: 'orders' }); openOrder(o.id);
    } catch (e) { err.textContent = errMsg(e); beep(false); }
  });
}

/* ---------------- order detail ---------------- */
async function openOrder(id) {
  let o = cache.orders.find(x => x.id === id); if (!o) return;
  if (supplierById(o.supplier_id)?.supplier_account_id) {   // supplier on DeepQr: fetch their latest answer
    const [{ data: fo }, { data: fi }] = await Promise.all([sb.from('orders').select('*').eq('id', id).maybeSingle(), sb.from('order_items').select('*').eq('order_id', id)]);
    if (fo) { Object.assign(o, fo); if (fi) cache.orderItems = cache.orderItems.filter(i => i.order_id !== id).concat(fi); }
  }
  const items = orderLines(id), grns = cache.receipts.filter(r => r.order_id === id), pays = cache.supplierPayments.filter(p => p.order_id === id);
  let rl = [];
  if (grns.length) { const { data } = await sb.from('order_receipt_lines').select('*').in('receipt_id', grns.map(g => g.id)); rl = data || []; }
  const u = orderUnits(o), sup = supplierById(o.supplier_id);
  const payable = orderPayable(o), bal = orderBalance(o);
  const variance = o.invoice_amount != null && Number(o.received_value) > 0 ? Number(o.invoice_amount) - Number(o.received_value) : 0;
  const canEdit = canManageOrders() && ['draft', 'ordered', 'pending', 'partial'].includes(o.status);
  const docs = [...(o.attachments || []).map(a => ({ ...a, from: 'Order' })), ...grns.flatMap(g => (g.attachments || []).map(a => ({ ...a, from: g.grn_no }))), ...pays.flatMap(p => (p.attachments || []).map(a => ({ ...a, from: 'Payment' })))];
  const timeline = [
    { at: o.created_at, t: `Order ${o.status === 'draft' ? 'drafted' : 'created'} by ${o.created_by || '—'}`, cls: '' },
    ...grns.map(g => ({ at: g.received_at, t: `${g.grn_no}: received ${money(g.total_value)}${g.delivery_note_no ? ' · DN ' + g.delivery_note_no : ''} by ${g.received_by || ''}`, cls: 'ok' })),
    ...pays.map(p => ({ at: p.created_at, t: `Paid ${money(p.amount)} by ${p.method}${p.reference ? ' (' + p.reference + ')' : ''}`, cls: 'ok' })),
    ...(o.closed_at ? [{ at: o.closed_at, t: 'Order closed', cls: '' }] : []),
    ...(o.status === 'cancelled' ? [{ at: o.updated_at, t: 'Cancelled: ' + (o.cancelled_reason || ''), cls: 'bad' }] : [])
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  drawer(`<div class="drawerHead"><div><h2>${esc(o.order_no || 'Purchase order')} ${orderTag(o)} ${payTag(o)}</h2><p>${esc(supName(o))} → ${esc(shopObj(o.shop_id)?.name || '')} · ordered ${fmtD(o.order_date || o.created_at)}${o.expected_date ? ' · expected ' + fmtD(o.expected_date) : ''}</p></div><button class="btn ghost" onclick="closeDrawer()" aria-label="Close">${icon('x')}</button></div>
  <div class="drawerBody">
   <div class="actions" style="margin-bottom:14px">
    ${OPEN_ORDER.includes(o.status) && canReceive() ? `<button class="btn primary" onclick="openReceive('${o.id}')">${icon('check')}Receive goods</button>` : ''}
    ${o.status === 'draft' && canManageOrders() ? `<button class="btn primary" onclick="setOrderStatus('${o.id}','ordered')">${icon('truck')}Place order</button>` : ''}
    ${isMgr() && sup && !['draft', 'cancelled'].includes(o.status) && bal > 0 ? `<button class="btn success" onclick="openSupplierPayment('${sup.id}','${o.id}')">${icon('coins')}Record payment</button>` : ''}
    ${canEdit ? `<button class="btn" onclick="closeDrawer();openOrderEditor('${o.id}')">${icon('edit')}Edit</button>` : ''}
    ${canManageOrders() ? `<button class="btn" onclick="addOrderDocs('${o.id}')">${icon('upload')}Add document</button>` : ''}
    <button class="btn" onclick="printOrder('${o.id}')">${icon('printer')}Print</button>
    ${sup?.phone && !['draft', 'cancelled'].includes(o.status) ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${phoneClean(sup.phone).replace(/^0/, '255').replace('+', '')}?text=${encodeURIComponent(orderText(o))}">${icon('whatsapp')}Send</a>` : ''}
    ${canManageOrders() && OPEN_ORDER.includes(o.status) && u.received + u.damaged > 0 ? `<button class="btn" onclick="closeOrder('${o.id}')">${icon('lock')}Close (short delivery)</button>` : ''}
    ${canManageOrders() && ['draft', 'ordered', 'pending'].includes(o.status) && u.received + u.damaged === 0 ? `<button class="btn ghost" onclick="cancelOrder('${o.id}')">${icon('ban')}Cancel order</button>` : ''}
    ${canManageOrders() && o.status === 'closed' ? `<button class="btn" onclick="setOrderStatus('${o.id}','ordered')">${icon('unlock')}Reopen</button>` : ''}
   </div>
   <div class="grid g4">${kpi('box', 'Ordered', money(o.total_cost), `${num(u.ordered)} unit(s)`)}${kpi('check', 'Received', money(o.received_value), `${num(u.received)} good${u.damaged ? `, <span class="bad">${num(u.damaged)} damaged</span>` : ''}`, 'teal')}${kpi('clock', 'Not received', num(orderOutstanding(o)), money(orderOutstandingValue(o)), orderOutstanding(o) && OPEN_ORDER.includes(o.status) ? 'warn' : '')}${kpi('coins', 'Balance to pay', money(bal), `paid ${money(o.paid_amount)} of ${money(payable)}`, bal > 0 ? 'warn' : '')}</div>
   ${supplierBlock(o, items, sup)}
   ${variance && Math.abs(variance) > 0.5 ? `<div class="banner warn" style="margin-top:12px">${icon('alert')}<div><b>Invoice and delivery do not match</b><p>The invoice (${money(o.invoice_amount)}) is ${variance > 0 ? 'higher' : 'lower'} than the value of goods received (${money(o.received_value)}) by ${money(Math.abs(variance))}. Check for missing or damaged items before paying.</p></div></div>` : ''}
   <h3 style="margin:18px 0 8px">Products — received vs. not received</h3>
   <div class="tableWrap"><table style="min-width:0"><thead><tr><th>Product</th><th class="right">Ordered</th><th class="right">Received</th><th class="right">Damaged</th><th class="right">Not received</th><th class="right">Unit cost</th><th class="right">Total</th><th>Status</th></tr></thead><tbody>
    ${items.map(i => { const out = lineOutstanding(i); return `<tr><td><b>${esc(i.product_name || productById(i.product_id)?.name || '')}</b><br><small class="muted mono">${esc(productById(i.product_id)?.code || '')}</small></td><td class="right num">${num(i.qty_ordered)}</td><td class="right num ok">${num(i.qty_received)}</td><td class="right num ${Number(i.qty_damaged) ? 'bad' : ''}">${num(i.qty_damaged || 0)}</td><td class="right num ${out ? 'warn' : ''}"><b>${num(out)}</b></td><td class="right num">${money(i.unit_cost)}</td><td class="right num">${money(i.qty_ordered * i.unit_cost)}</td><td>${i.status === 'received' ? '<span class="tag ok">Complete</span>' : i.status === 'partial' ? '<span class="tag warn">Partial</span>' : i.status === 'cancelled' ? '<span class="tag gray">Cancelled</span>' : '<span class="tag gray">Waiting</span>'}</td></tr>`; }).join('')}
   </tbody></table></div>
   <div class="grid g2" style="margin-top:16px">
    <div class="card" style="margin:0"><h3 style="margin:0 0 10px">Details</h3><dl class="kv"><dt>Supplier</dt><dd>${esc(supName(o))}${sup?.phone ? ' · ' + esc(sup.phone) : ''}</dd><dt>Invoice no.</dt><dd>${esc(o.invoice_no || '—')}</dd><dt>Invoice amount</dt><dd>${o.invoice_amount != null ? money(o.invoice_amount) : '—'}</dd><dt>Payment terms</dt><dd>${sup?.payment_terms_days ? sup.payment_terms_days + ' days' + (grns[0] ? ' · due ' + fmtD(addDays(sup.payment_terms_days, dateOnly(grns[0].received_at))) : '') : 'Cash on delivery'}</dd><dt>Reference</dt><dd>${esc(o.ref || '—')}</dd><dt>Created by</dt><dd>${esc(o.created_by || '—')}</dd>${o.note ? `<dt>Note</dt><dd style="white-space:pre-wrap">${esc(o.note)}</dd>` : ''}</dl></div>
    <div class="card" style="margin:0"><h3 style="margin:0 0 10px">History</h3><ul class="timeline">${timeline.map(t => `<li class="${t.cls}">${esc(t.t)}<small>${fmtDT(t.at)}</small></li>`).join('')}</ul></div>
   </div>
   ${grns.length ? `<h3 style="margin:18px 0 8px">Goods received notes</h3>${grns.map(g => `<div class="card" style="margin:0 0 10px"><div class="cardHead" style="margin-bottom:6px"><div><h3 class="mono">${esc(g.grn_no)}</h3><p>${fmtDT(g.received_at)} · ${esc(shopObj(g.shop_id)?.name || '')} · by ${esc(g.received_by || '')}${g.delivery_note_no ? ' · delivery note ' + esc(g.delivery_note_no) : ''}</p></div><b>${money(g.total_value)}</b></div>
     <div class="tableWrap"><table style="min-width:0"><tbody>${rl.filter(x => x.receipt_id === g.id).map(x => `<tr><td>${esc(productById(x.product_id)?.name || '')}</td><td class="right num ok">+${num(x.qty_received)}</td><td class="right num ${Number(x.qty_damaged) ? 'bad' : 'muted'}">${Number(x.qty_damaged) ? num(x.qty_damaged) + ' damaged' : ''}</td><td class="right">${money(x.unit_cost)}</td><td>${x.expiry_date ? 'exp ' + fmtD(x.expiry_date) : ''}</td><td>${canQR() && Number(x.qty_received) > 0 ? `<button class="btn small" onclick="closeDrawer();openGenerate('${x.product_id}','${g.shop_id}',${Number(x.qty_received)})">${icon('qr')}Labels</button>` : ''}</td></tr>`).join('')}</tbody></table></div>${g.note ? `<p class="muted" style="margin:6px 0 0">${esc(g.note)}</p>` : ''}</div>`).join('')}` : ''}
   ${pays.length ? `<h3 style="margin:18px 0 8px">Payments</h3><div class="tableWrap"><table style="min-width:0"><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="right">Amount</th><th>By</th></tr></thead><tbody>${pays.map(p => `<tr><td>${fmtD(p.paid_on)}</td><td>${esc(p.method)}</td><td class="mono">${esc(p.reference || '')}</td><td class="right num">${money(p.amount)}</td><td>${esc(p.by_name || '')}${sup?.supplier_account_id ? (p.verification === 'confirmed' ? ' <span class="tag ok">confirmed</span>' : p.verification === 'disputed' ? ` <span class="tag bad">disputed</span> <small>${esc(p.verify_note || '')}</small>` : ' <span class="tag warn">waiting</span>') : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
   <h3 style="margin:18px 0 8px">Documents (${docs.length})</h3>${docListHtml(docs.map(d => ({ ...d, kind: d.kind, by: (d.by || '') + (d.from && d.from !== 'Order' ? ' · ' + d.from : '') })))}
  </div>`);
}
function supplierBlock(o, items, sup) {
  if (!sup?.supplier_account_id || !o.supplier_status) return '';
  const st = { sent: ['Sent — waiting for the supplier', 'warn'], confirmed: ['Confirmed by the supplier', 'info'], dispatched: ['Dispatched — on the way', 'info'], delivered: ['Delivered', 'ok'], rejected: ['Declined by the supplier', 'bad'] }[o.supplier_status] || [o.supplier_status, 'gray'];
  const diff = items.filter(i => (i.supplier_qty != null && Number(i.supplier_qty) !== Number(i.qty_ordered)) || (i.supplier_price != null && Number(i.supplier_price) !== Number(i.unit_cost)));
  const flow = ['sent', 'confirmed', 'dispatched', 'delivered'], at = flow.indexOf(o.supplier_status);
  return `<div class="card supBlock" style="margin-top:14px"><div class="cardHead" style="margin-bottom:8px"><div><h3>${icon('truck')} ${esc(sup.name)} on DeepQr</h3><p>${st[0]}${o.supplier_eta ? ' · delivery ' + fmtD(o.supplier_eta) : ''}${o.supplier_updated_at ? ' · ' + ago(o.supplier_updated_at) : ''}</p></div><span class="tag ${st[1]}">${esc(o.supplier_status)}</span></div>
   ${o.supplier_status === 'rejected' ? '' : `<div class="track">${flow.map((s, i) => `<div class="${i < at ? 'done' : i === at ? 'now' : ''}"><i></i><span>${{ sent: 'Sent', confirmed: 'Confirmed', dispatched: 'Dispatched', delivered: 'Delivered' }[s]}</span></div>`).join('')}</div>`}
   ${o.supplier_note ? `<p style="margin:8px 0 0">${icon('info')} “${esc(o.supplier_note)}”</p>` : ''}
   ${diff.length ? `<div class="banner warn" style="margin:10px 0 0">${icon('alert')}<div><b>The supplier changed ${diff.length} line(s)</b><p>${diff.map(i => `${esc(i.product_name || productById(i.product_id)?.name || '')}: ${i.supplier_qty != null && Number(i.supplier_qty) !== Number(i.qty_ordered) ? `qty ${num(i.qty_ordered)} → <b>${num(i.supplier_qty)}</b> ` : ''}${i.supplier_price != null && Number(i.supplier_price) !== Number(i.unit_cost) ? `price ${money(i.unit_cost)} → <b>${money(i.supplier_price)}</b>` : ''}`).join(' · ')}</p>${canManageOrders() && ['ordered', 'pending', 'partial'].includes(o.status) ? `<button class="btn small" onclick="acceptSupplierChanges('${o.id}')">Accept their quantities &amp; prices</button>` : ''}</div></div>` : ''}
   ${(o.supplier_attachments || []).length ? `<div style="margin-top:8px">${docListHtml(o.supplier_attachments)}</div>` : ''}</div>`;
}
async function acceptSupplierChanges(id) {
  const o = cache.orders.find(x => x.id === id), lines = orderLines(id);
  try {
    await rpc('dq_save_order', { p: { id, status: 'ordered', supplier_id: o.supplier_id, shop_id: o.shop_id, order_date: o.order_date, expected_date: o.supplier_eta || o.expected_date, invoice_no: o.invoice_no, invoice_amount: o.invoice_amount, ref: o.ref, note: o.note,
      items: lines.map(i => ({ id: i.id, product_id: i.product_id, qty_ordered: Math.max(Number(i.supplier_qty ?? i.qty_ordered), Number(i.qty_received) + Number(i.qty_damaged || 0), 0.0001), unit_cost: Number(i.supplier_price ?? i.unit_cost) })) } });
    await loadAllData(); renderView(); openOrder(id); toast('Order updated to the supplier’s quantities and prices', 'ok');
  } catch (e) { toast(errMsg(e), 'bad'); }
}
function orderText(o) {
  const items = orderLines(o.id);
  return `${business.name} — Purchase order ${o.order_no}\nDate: ${fmtD(o.order_date)}${o.expected_date ? '\nDeliver by: ' + fmtD(o.expected_date) : ''}\nDeliver to: ${shopObj(o.shop_id)?.name || ''}\n\n` + items.map(i => `• ${i.product_name || productById(i.product_id)?.name} × ${num(i.qty_ordered)} @ ${num(i.unit_cost)}`).join('\n') + `\n\nTotal: ${money(o.total_cost)}${o.note ? '\nNote: ' + o.note : ''}`;
}
function printOrder(id) {
  const o = cache.orders.find(x => x.id === id), sup = supplierById(o.supplier_id), items = orderLines(id);
  modal(`<div class="actions noPrint" style="justify-content:flex-end"><button class="btn primary" onclick="printModal()">${icon('printer')}Print</button><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
  <div class="receipt" style="max-width:none;font-family:inherit">
   <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start"><div><h2 style="margin:0">${esc(business.name)}</h2><small class="muted">${esc(business.address || '')}${business.phone ? ' · ' + esc(business.phone) : ''}${business.tin ? '<br>TIN ' + esc(business.tin) : ''}</small></div><div style="text-align:right"><h2 style="margin:0">PURCHASE ORDER</h2><b class="mono">${esc(o.order_no || '')}</b><br><small>Date ${fmtD(o.order_date)}${o.expected_date ? '<br>Deliver by ' + fmtD(o.expected_date) : ''}</small></div></div>
   <div class="grid g2" style="margin:16px 0"><div><small class="muted">SUPPLIER</small><br><b>${esc(supName(o))}</b><br>${esc(sup?.contact_person || '')}<br>${esc(sup?.phone || '')} ${esc(sup?.email || '')}<br>${esc(sup?.address || '')}</div><div><small class="muted">DELIVER TO</small><br><b>${esc(shopObj(o.shop_id)?.name || '')}</b><br>${esc(shopObj(o.shop_id)?.address || '')}</div></div>
   <table style="width:100%;min-width:0"><thead><tr><th>#</th><th>Product</th><th>Code</th><th class="right">Qty</th><th class="right">Unit cost</th><th class="right">Total</th></tr></thead><tbody>${items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.product_name || productById(i.product_id)?.name || '')}</td><td class="mono">${esc(productById(i.product_id)?.code || '')}</td><td class="right">${num(i.qty_ordered)}</td><td class="right">${num(i.unit_cost)}</td><td class="right">${num(i.qty_ordered * i.unit_cost)}</td></tr>`).join('')}</tbody><tfoot><tr><th colspan="5" class="right">TOTAL (${esc(cur())})</th><th class="right">${num(o.total_cost)}</th></tr></tfoot></table>
   ${o.note ? `<p><b>Note:</b> ${esc(o.note)}</p>` : ''}<p style="margin-top:40px">Authorised by: ____________________ &nbsp; Date: __________</p>
  </div>`, 'wide');
}
function setOrderStatus(id, st) { withBusy(null, async () => { const r = await rpcToast('dq_set_order_status', { p_order_id: id, p_status: st }, st === 'ordered' ? 'Order placed' : 'Order updated'); if (r) { await loadAllData(); renderView(); openOrder(id); } }); }
function cancelOrder(id) { askBox('Cancel this order?', 'Nothing has been received on it. The supplier should be told separately.', { label: 'Reason', required: true, textarea: true }, 'Cancel order', async (v, btn) => { await withBusy(btn, async () => { const r = await rpcToast('dq_set_order_status', { p_order_id: id, p_status: 'cancelled', p_reason: v }, 'Order cancelled'); if (r) { closeModal(); await loadAllData(); renderView(); openOrder(id); } }); }); }
function closeOrder(id) {
  const o = cache.orders.find(x => x.id === id);
  askBox('Close this order?', `${num(orderOutstanding(o))} unit(s) (${money(orderOutstandingValue(o))}) were never delivered. Closing stops waiting for them. You can reopen it later.`, { label: 'Reason', value: 'Supplier could not deliver the rest', required: true }, 'Close order', async (v, btn) => { await withBusy(btn, async () => { const r = await rpcToast('dq_set_order_status', { p_order_id: id, p_status: 'closed', p_reason: v }, 'Order closed'); if (r) { closeModal(); await loadAllData(); renderView(); openOrder(id); } }); });
}
function addOrderDocs(id) {
  modal(`<div class="cardHead"><div><h3>Add documents</h3><p>Invoices, delivery notes and receipts are stored privately for your business.</p></div><button class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="field"><label for="adKind">Document type</label><select id="adKind">${DOC_KINDS.map(k => `<option value="${k[0]}">${k[1]}</option>`).join('')}</select></div>${dropzoneHtml('adFiles', 'Choose files or drop them here')}<div id="adMsg" class="muted" style="margin-top:8px"></div>`, 'narrow');
  bindDropzone('adFiles', async files => {
    const msg = document.getElementById('adMsg'); msg.innerHTML = '<span class="spinner"></span> Uploading…';
    try {
      const up = await uploadDocs(files, 'orders', document.getElementById('adKind').value);
      if (!up.length) { msg.textContent = ''; return; }
      const o = cache.orders.find(x => x.id === id);
      const attachments = [...(o.attachments || []), ...up];
      const { error } = await sb.from('orders').update({ attachments, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      o.attachments = attachments; closeModal(); toast(`${up.length} document(s) attached`, 'ok'); openOrder(id); renderView();
    } catch (e) { msg.innerHTML = `<span class="bad">${esc(errMsg(e))}</span>`; }
  });
}

/* ---------------- receive goods (GRN) ---------------- */
let grnFiles = [];
function openReceive(id) {
  const o = cache.orders.find(x => x.id === id); if (!o) return;
  const lines = orderLines(id).filter(i => lineOutstanding(i) > 0);
  if (!lines.length) { toast('Everything on this order has been received', 'ok'); return; }
  grnFiles = [];
  modal(`<form id="grnForm"><div class="cardHead"><div><h3>Receive goods — ${esc(o.order_no || '')}</h3><p>${esc(supName(o))}. Count what physically arrived. Good items go into stock at <b>${esc(shopObj(o.shop_id)?.name || '')}</b>; damaged items are recorded but not added.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="toolbar" style="margin-bottom:8px"><button type="button" class="btn small" onclick="grnAll(true)">${icon('check')}Everything arrived</button><button type="button" class="btn small ghost" onclick="grnAll(false)">Clear</button></div>
   <div class="tableWrap"><table style="min-width:700px"><thead><tr><th>Product</th><th class="right">Waiting</th><th style="width:95px">Good *</th><th style="width:95px">Damaged</th><th style="width:120px">Unit cost</th><th style="width:150px">Expiry</th><th style="width:110px">Batch</th></tr></thead><tbody>
   ${lines.map(i => { const p = productById(i.product_id); return `<tr data-id="${i.id}" data-out="${lineOutstanding(i)}"><td><b>${esc(i.product_name || p?.name || '')}</b><br><small class="muted">ordered ${num(i.qty_ordered)}, received ${num(i.qty_received)}</small></td><td class="right num"><b>${num(lineOutstanding(i))}</b></td><td><input class="input g_q" type="number" min="0" step="any" value="0" oninput="grnCheck()"></td><td><input class="input g_d" type="number" min="0" step="any" value="0" oninput="grnCheck()"></td><td><input class="input g_c" type="number" min="0" step="any" value="${Number(i.unit_cost)}" oninput="grnCheck()"></td><td><input class="input g_e" type="date" ${business.expiry_required ? '' : ''}></td><td><input class="input g_b" placeholder="optional"></td></tr>`; }).join('')}
   </tbody></table></div>
   <div class="formGrid" style="margin-top:12px"><div class="field"><label for="grnDn">Delivery note no.</label><input id="grnDn" placeholder="From the supplier's paper"></div><div class="field"><label for="grnInv">Invoice no.</label><input id="grnInv" value="${esc(o.invoice_no || '')}"></div><div class="field"><label for="grnInvAmt">Invoice amount</label><input id="grnInvAmt" type="number" min="0" step="any" value="${esc(o.invoice_amount ?? '')}"></div></div>
   <div class="field" style="margin-top:10px"><label for="grnNote">Note (e.g. what was damaged, who delivered)</label><input id="grnNote"></div>
   <div style="margin-top:10px">${dropzoneHtml('grnUp', 'Photo of the delivery note / invoice')}<div id="grnDocs"></div></div>
   <div style="margin-top:10px;display:flex;gap:16px;flex-wrap:wrap"><label class="chk"><input type="checkbox" id="grnCost" checked>Update product cost to the new unit cost</label>${canQR() ? `<label class="chk"><input type="checkbox" id="grnQr" checked>Print QR labels for the good items next</label>` : ''}<label class="chk"><input type="checkbox" id="grnOver">Allow more than ordered</label></div>
   <div class="totals" id="grnSum" style="margin-top:10px"></div>
   <div id="grnErr" class="bad" style="min-height:20px"></div>
   <div class="actions" style="justify-content:flex-end"><button type="button" class="btn primary lg" onclick="submitReceive('${o.id}',this)">${icon('check')}Record delivery</button></div></form>`, 'wide');
  bindDropzone('grnUp', files => { grnFiles.push(...files); document.getElementById('grnDocs').innerHTML = docListHtml(grnFiles.map(f => ({ name: f.name, size: f.size, type: f.type, kind: 'delivery_note' })), 'grnRemoveFile'); });
  grnCheck();
}
function grnRemoveFile(i) { grnFiles.splice(i, 1); document.getElementById('grnDocs').innerHTML = docListHtml(grnFiles.map(f => ({ name: f.name, size: f.size, type: f.type, kind: 'delivery_note' })), 'grnRemoveFile'); }
function grnRows() { return [...document.querySelectorAll('#grnForm tr[data-id]')].map(tr => ({ tr, id: tr.dataset.id, out: Number(tr.dataset.out), qty: Number(tr.querySelector('.g_q').value || 0), damaged: Number(tr.querySelector('.g_d').value || 0), cost: Number(tr.querySelector('.g_c').value || 0), expiry: tr.querySelector('.g_e').value, batch: tr.querySelector('.g_b').value.trim() })); }
function grnAll(on) { grnRows().forEach(r => { r.tr.querySelector('.g_q').value = on ? r.out : 0; r.tr.querySelector('.g_d').value = 0; }); grnCheck(); }
function grnCheck() {
  const rows = grnRows(), over = document.getElementById('grnOver')?.checked;
  let bad = 0;
  rows.forEach(r => { const o = r.qty + r.damaged > r.out && !over; r.tr.querySelector('.g_q').classList.toggle('bad', o); if (o) bad++; });
  const good = sum(rows, 'qty'), dmg = sum(rows, 'damaged'), val = sum(rows, r => r.qty * r.cost), left = sum(rows, r => Math.max(0, r.out - r.qty - r.damaged));
  document.getElementById('grnSum').innerHTML = `<div class="row"><span>Good units into stock</span><b class="ok">${num(good)}</b></div><div class="row"><span>Damaged / rejected</span><b class="${dmg ? 'bad' : ''}">${num(dmg)}</b></div><div class="row"><span>Still not received after this</span><b class="${left ? 'warn' : ''}">${num(left)}</b></div><div class="row"><span>Value of goods received</span><b>${money(val)}</b></div>${bad ? `<div class="row bad"><span>${bad} line(s) are more than what is waiting</span></div>` : ''}`;
}
async function submitReceive(id, btn) {
  const rows = grnRows().filter(r => r.qty > 0 || r.damaged > 0), err = document.getElementById('grnErr'); err.textContent = '';
  const over = document.getElementById('grnOver').checked;
  if (!rows.length) { err.textContent = 'Enter how many arrived for at least one product.'; beep(false); return; }
  if (rows.some(r => r.qty < 0 || r.damaged < 0 || r.cost < 0)) { err.textContent = 'Quantities and costs cannot be negative.'; return; }
  if (!over && rows.some(r => r.qty + r.damaged > r.out)) { err.textContent = 'Some lines are more than what is waiting. Tick "Allow more than ordered" if the supplier really sent extra.'; return; }
  const expired = rows.find(r => r.expiry && daysUntil(r.expiry) < 0);
  if (expired) { err.textContent = 'One of the expiry dates is already in the past — record those items as damaged instead.'; return; }
  const o = cache.orders.find(x => x.id === id);
  await withBusy(btn, async () => {
    try {
      const attachments = grnFiles.length ? await uploadDocs(grnFiles, 'receipts', 'delivery_note') : [];
      const inv = document.getElementById('grnInv').value.trim(), invAmt = document.getElementById('grnInvAmt').value;
      if (inv !== (o.invoice_no || '') || String(invAmt) !== String(o.invoice_amount ?? '')) await sb.from('orders').update({ invoice_no: inv || null, invoice_amount: invAmt === '' ? null : Number(invAmt) }).eq('id', id);
      const r = await rpc('dq_receive_order', { p: { order_id: id, delivery_note_no: document.getElementById('grnDn').value, note: document.getElementById('grnNote').value, attachments, allow_over: over, update_cost: document.getElementById('grnCost').checked, lines: rows.map(x => ({ order_item_id: x.id, qty: x.qty, damaged: x.damaged, unit_cost: x.cost, expiry_date: x.expiry || null, batch: x.batch || null })) } });
      const wantQr = document.getElementById('grnQr')?.checked;
      closeModal(); beep(true);
      await loadAllData(); renderView();
      toast(`${r.receipt.grn_no}: delivery recorded (${money(r.receipt.total_value)})`, 'ok');
      const goodRows = rows.filter(x => x.qty > 0);
      if (wantQr && goodRows.length) {
        const first = orderLines(id).find(i => i.id === goodRows[0].id);
        openGenerate(first.product_id, o.shop_id, goodRows[0].qty);
        if (goodRows.length > 1) toast(`Generate labels for the other ${goodRows.length - 1} product(s) from the order's goods received note`, '');
      } else openOrder(id);
    } catch (e) { err.textContent = errMsg(e); beep(false); }
  });
}

/* ---------------- GRN list ---------------- */
function grnView() {
  let list = cache.receipts;
  if (search) { const q = search.toLowerCase(); list = list.filter(g => [g.grn_no, g.delivery_note_no, g.received_by, cache.orders.find(o => o.id === g.order_id)?.order_no, supName(cache.orders.find(o => o.id === g.order_id) || {})].join(' ').toLowerCase().includes(q)); }
  return `<div class="card"><div class="toolbar"><input class="input grow" id="grnSearch" value="${esc(search)}" oninput="liveSearch(this)" placeholder="Search GRN, delivery note, order or supplier…"></div><div class="tableWrap"><table><thead><tr><th>GRN</th><th>Date</th><th>Order</th><th>Supplier</th><th>Location</th><th>Delivery note</th><th class="right">Value</th><th>Docs</th><th>Received by</th></tr></thead><tbody>
  ${list.map(g => { const o = cache.orders.find(x => x.id === g.order_id) || {}; return `<tr class="clickRow" onclick="openOrder('${g.order_id}')"><td class="mono"><b>${esc(g.grn_no)}</b></td><td>${fmtDT(g.received_at)}</td><td class="mono">${esc(o.order_no || '')}</td><td>${esc(supName(o))}</td><td>${esc(shopObj(g.shop_id)?.name || '')}</td><td>${esc(g.delivery_note_no || '—')}</td><td class="right num">${money(g.total_value)}</td><td>${(g.attachments || []).length ? `<span class="tag info">${icon('file')}${g.attachments.length}</span>` : '—'}</td><td>${esc(g.received_by || '')}</td></tr>`; }).join('') || `<tr><td colspan="9" class="empty">No deliveries recorded yet.</td></tr>`}
  </tbody></table></div></div>`;
}

/* ---------------- suppliers ---------------- */
function suppliersView() {
  let list = cache.suppliers;
  if (search) { const q = search.toLowerCase(); list = list.filter(s => [s.name, s.contact_person, s.phone, s.email, s.tin].join(' ').toLowerCase().includes(q)); }
  return `<div class="card"><div class="toolbar"><input class="input grow" id="supSearch" value="${esc(search)}" oninput="liveSearch(this)" placeholder="Search supplier, contact or phone…"><button class="btn" onclick="openSupplierDirectory()">${icon('search')}Find suppliers on DeepQr</button><button class="btn primary" onclick="editSupplier()">${icon('plus')}Add supplier</button></div>
  <p class="muted" style="margin:0 0 10px;font-size:13px">${icon('info')} Suppliers on DeepQr receive your orders instantly, confirm quantities and prices, dispatch with their invoice and confirm your payments. Invite the others with one tap.</p>
  <div class="tableWrap"><table><thead><tr><th>Supplier</th><th>Contact</th><th>Terms</th><th class="right">Open orders</th><th class="right">Bought (all time)</th><th class="right">We owe</th><th>Status</th><th></th></tr></thead><tbody>
  ${list.map(s => { const os = cache.orders.filter(o => o.supplier_id === s.id); return `<tr class="clickRow" onclick="openSupplier('${s.id}')"><td><b>${esc(s.name)}</b>${s.supplier_account_id ? ' <span class="tag info">On DeepQr</span>' : ''}${s.tin ? `<br><small class="muted">TIN ${esc(s.tin)}</small>` : ''}</td><td>${esc(s.contact_person || '')}<br><small class="muted">${esc(s.phone || '')} ${esc(s.email || '')}</small></td><td>${s.payment_terms_days ? s.payment_terms_days + ' days' : 'Cash'}</td><td class="right num">${os.filter(o => OPEN_ORDER.includes(o.status)).length}</td><td class="right num">${money(sum(os, 'received_value'))}</td><td class="right num ${Number(s.balance) > 0 ? 'warn' : ''}"><b>${money(s.balance)}</b></td><td>${s.active === false ? '<span class="tag gray">Inactive</span>' : '<span class="tag ok">Active</span>'}</td><td onclick="event.stopPropagation()"><div class="actions" style="flex-wrap:nowrap">${isMgr() && Number(s.balance) > 0 ? `<button class="btn small success" onclick="openSupplierPayment('${s.id}')">${icon('coins')}Pay</button>` : ''}${!s.supplier_account_id && canManageOrders() ? `<button class="btn small ghost" onclick="inviteSupplier('${s.id}')" title="Invite to DeepQr">${icon('megaphone')}Invite</button>` : ''}<button class="btn small" onclick="editSupplier('${s.id}')">${icon('edit')}</button></div></td></tr>`; }).join('') || `<tr><td colspan="8">${emptyState('users', 'No suppliers yet', 'Add the companies you buy from to create purchase orders and track what you owe them.', `<button class="btn primary" onclick="editSupplier()">${icon('plus')}Add supplier</button>`)}</td></tr>`}
  </tbody></table></div></div>`;
}
function editSupplier(id, after) {
  const s = id ? supplierById(id) : {};
  modal(`<form id="supForm"><div class="cardHead"><div><h3>${id ? 'Edit supplier' : 'New supplier'}</h3><p>Payment terms decide when an invoice is due.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="formGrid"><div class="field"><label for="spN">Company name *</label><input id="spN" required value="${esc(s.name || '')}" autofocus></div><div class="field"><label for="spC">Contact person</label><input id="spC" value="${esc(s.contact_person || '')}"></div><div class="field"><label for="spP">Phone</label><input id="spP" type="tel" value="${esc(s.phone || '')}" placeholder="07XX XXX XXX"></div><div class="field"><label for="spE">Email</label><input id="spE" type="email" value="${esc(s.email || '')}"></div><div class="field"><label for="spT">TIN</label><input id="spT" value="${esc(s.tin || '')}"></div><div class="field"><label for="spD">Payment terms (days)</label><input id="spD" type="number" min="0" value="${Number(s.payment_terms_days || 0)}"></div></div>
   <div class="field" style="margin-top:10px"><label for="spA">Address</label><input id="spA" value="${esc(s.address || '')}"></div><div class="field" style="margin-top:10px"><label for="spNo">Notes (bank details, what they supply…)</label><textarea id="spNo" rows="2">${esc(s.notes || '')}</textarea></div>
   ${id ? `<label class="chk" style="margin-top:10px"><input type="checkbox" id="spAct" ${s.active !== false ? 'checked' : ''}>Active</label>` : ''}
   <div id="spErr" class="bad" style="min-height:20px;margin-top:8px"></div><div class="actions"><button class="btn primary">${icon('check')}Save supplier</button><button type="button" class="btn" onclick="closeModal()">Cancel</button></div></form>`);
  document.getElementById('supForm').onsubmit = async e => {
    e.preventDefault();
    const g = x => document.getElementById(x).value.trim();
    const row = { name: g('spN'), contact_person: g('spC') || null, phone: g('spP') || null, email: g('spE') || null, tin: g('spT') || null, payment_terms_days: Number(g('spD') || 0), address: g('spA') || null, notes: g('spNo') || null };
    if (id) row.active = document.getElementById('spAct').checked;
    if (!row.name) return;
    if (cache.suppliers.some(x => x.id !== id && x.name.toLowerCase() === row.name.toLowerCase())) { document.getElementById('spErr').textContent = 'A supplier with this name already exists.'; return; }
    await withBusy(e.submitter, async () => {
      const res = id ? await sb.from('suppliers').update(row).eq('id', id).select().single() : await sb.from('suppliers').insert({ ...row, business_id: me.business_id }).select().single();
      if (res.error) { document.getElementById('spErr').textContent = errMsg(res.error); return; }
      if (id) Object.assign(supplierById(id), res.data); else cache.suppliers.push(res.data);
      cache.suppliers.sort((a, b) => a.name.localeCompare(b.name));
      toast('Supplier saved', 'ok'); closeModal();
      if (poDraft && !id && after) poDraft.supplier_id = res.data.id;
      if (after) after(res.data); else renderView();
    });
  };
}
function openSupplier(id) {
  const s = supplierById(id); if (!s) return;
  const os = cache.orders.filter(o => o.supplier_id === id), pays = cache.supplierPayments.filter(p => p.supplier_id === id);
  const unpaid = os.filter(o => !['draft', 'cancelled'].includes(o.status) && Number(o.received_value) > 0 && orderBalance(o) > 0);
  const products = cache.products.filter(p => p.supplier_id === id);
  drawer(`<div class="drawerHead"><div><h2>${esc(s.name)}</h2><p>${esc([s.contact_person, s.phone, s.email].filter(Boolean).join(' · ') || 'no contact details')}${s.tin ? ' · TIN ' + esc(s.tin) : ''}</p></div><div class="actions"><button class="btn small" onclick="editSupplier('${id}',()=>openSupplier('${id}'))">${icon('edit')}Edit</button><button class="btn ghost" onclick="closeDrawer()">${icon('x')}</button></div></div>
  <div class="drawerBody">
   <div class="grid g3">${kpi('coins', 'We owe', money(s.balance), s.payment_terms_days ? `terms ${s.payment_terms_days} days` : 'cash on delivery', Number(s.balance) > 0 ? 'warn' : '')}${kpi('truck', 'Orders', os.length, `${os.filter(o => OPEN_ORDER.includes(o.status)).length} open`)}${kpi('box', 'Bought', money(sum(os, 'received_value')), `paid ${money(sum(pays, 'amount'))}`, 'teal')}</div>
   <div class="actions" style="margin:14px 0">${canManageOrders() ? `<button class="btn primary" onclick="closeDrawer();openOrderEditor(null,{supplier_id:'${id}'})">${icon('plus')}New order</button>` : ''}${isMgr() ? `<button class="btn success" onclick="openSupplierPayment('${id}')">${icon('coins')}Record payment</button>` : ''}${s.phone ? `<a class="btn" href="tel:${esc(phoneClean(s.phone))}">${icon('phone')}Call</a>` : ''}</div>
   ${unpaid.length ? `<h3 style="margin:0 0 8px">Unpaid deliveries</h3><div class="tableWrap"><table style="min-width:0"><thead><tr><th>Order</th><th>Invoice</th><th>Received</th><th>Due</th><th class="right">Balance</th></tr></thead><tbody>${unpaid.map(o => { const g = cache.receipts.find(r => r.order_id === o.id); const due = g ? addDays(Number(s.payment_terms_days || 0), dateOnly(g.received_at)) : null; return `<tr class="clickRow" onclick="openOrder('${o.id}')"><td class="mono">${esc(o.order_no)}</td><td>${esc(o.invoice_no || '—')}</td><td>${g ? fmtD(g.received_at) : ''}</td><td>${due ? (daysUntil(due) < 0 ? `<span class="tag bad">${-daysUntil(due)}d overdue</span>` : fmtD(due)) : ''}</td><td class="right num warn"><b>${money(orderBalance(o))}</b></td></tr>`; }).join('')}</tbody></table></div>` : ''}
   <h3 style="margin:18px 0 8px">Orders</h3><div class="tableWrap"><table style="min-width:0"><tbody>${os.slice(0, 30).map(o => `<tr class="clickRow" onclick="openOrder('${o.id}')"><td class="mono">${esc(o.order_no || '')}</td><td>${fmtD(o.order_date)}</td><td class="right">${money(o.total_cost)}</td><td>${orderTag(o)}</td></tr>`).join('') || '<tr><td class="empty">No orders yet.</td></tr>'}</tbody></table></div>
   <h3 style="margin:18px 0 8px">Payments</h3><div class="tableWrap"><table style="min-width:0"><tbody>${pays.map(p => `<tr><td>${fmtD(p.paid_on)}</td><td>${esc(p.method)}</td><td class="mono">${esc(p.reference || '')}</td><td>${esc(cache.orders.find(o => o.id === p.order_id)?.order_no || 'on account')}</td><td class="right num">${money(p.amount)}</td></tr>`).join('') || '<tr><td class="empty">No payments yet.</td></tr>'}</tbody></table></div>
   ${products.length ? `<h3 style="margin:18px 0 8px">Products from this supplier</h3><p>${products.map(p => `<span class="chip">${esc(p.name)}</span>`).join(' ')}</p>` : ''}
   ${s.notes ? `<h3 style="margin:18px 0 8px">Notes</h3><p style="white-space:pre-wrap">${esc(s.notes)}</p>` : ''}
  </div>`);
}
let spFiles = [];
function openSupplierPayment(supplierId, orderId) {
  const s = supplierById(supplierId); if (!s) return;
  const unpaid = cache.orders.filter(o => o.supplier_id === supplierId && !['draft', 'cancelled'].includes(o.status) && orderBalance(o) > 0 && Number(o.received_value) > 0);
  const o = orderId ? cache.orders.find(x => x.id === orderId) : unpaid[0];
  const methods = (business.payment_methods && business.payment_methods.length ? business.payment_methods.map(m => m.name || m) : ['Cash', 'Bank', 'M-Pesa', 'Tigo Pesa', 'Airtel Money', 'Cheque']).filter(m => !/credit/i.test(m));
  spFiles = [];
  modal(`<form id="spayF"><div class="cardHead"><div><h3>Pay ${esc(s.name)}</h3><p>Total owed: <b>${money(s.balance)}</b>. Link the payment to an order so its balance updates.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="formGrid"><div class="field"><label for="spO">For order</label><select id="spO" onchange="const o=cache.orders.find(x=>x.id===this.value);if(o)document.getElementById('spAmt').value=orderBalance(o)"><option value="">On account (no specific order)</option>${unpaid.concat(o && !unpaid.includes(o) ? [o] : []).map(x => `<option value="${x.id}" ${o && x.id === o.id ? 'selected' : ''}>${esc(x.order_no)} — balance ${money(orderBalance(x))}</option>`).join('')}</select></div>
   <div class="field"><label for="spAmt">Amount *</label><input id="spAmt" type="number" min="1" step="any" required value="${o ? orderBalance(o) : Math.max(0, Number(s.balance))}"></div>
   <div class="field"><label for="spM">Method *</label><select id="spM">${methods.map(m => `<option>${esc(m)}</option>`).join('')}</select></div>
   <div class="field"><label for="spR">Reference${business.require_payment_ref ? ' *' : ''}</label><input id="spR" placeholder="Transaction / cheque no." ${business.require_payment_ref ? 'required' : ''}></div>
   <div class="field"><label for="spDt">Date</label><input id="spDt" type="date" value="${dateOnly()}" max="${dateOnly()}"></div></div>
   <div class="field" style="margin-top:10px"><label for="spNt">Note</label><input id="spNt"></div>
   <div style="margin-top:10px">${dropzoneHtml('spUp', 'Attach payment receipt (optional)')}<div id="spDocs"></div></div>
   <div id="spPErr" class="bad" style="min-height:20px"></div><div class="actions"><button class="btn success lg">${icon('check')}Record payment</button></div></form>`);
  bindDropzone('spUp', files => { spFiles.push(...files); document.getElementById('spDocs').innerHTML = docListHtml(spFiles.map(f => ({ name: f.name, size: f.size, type: f.type, kind: 'receipt' }))); });
  document.getElementById('spayF').onsubmit = async e => {
    e.preventDefault();
    const amt = Number(document.getElementById('spAmt').value), oid = document.getElementById('spO').value, err = document.getElementById('spPErr');
    if (!(amt > 0)) { err.textContent = 'Enter the amount paid.'; return; }
    const ord = oid ? cache.orders.find(x => x.id === oid) : null;
    if (ord && amt > orderBalance(ord) + 0.01 && !confirm(`This is more than the order balance (${money(orderBalance(ord))}). Record it anyway?`)) return;
    await withBusy(e.submitter, async () => {
      try {
        const attachments = spFiles.length ? await uploadDocs(spFiles, 'payments', 'receipt') : [];
        await rpc('dq_supplier_payment', { p: { supplier_id: supplierId, order_id: oid || null, amount: amt, method: document.getElementById('spM').value, reference: document.getElementById('spR').value, paid_on: document.getElementById('spDt').value, note: document.getElementById('spNt').value, attachments } });
        closeModal(); await loadAllData(); renderView(); toast(`Payment of ${money(amt)} to ${s.name} recorded`, 'ok');
        if (oid) openOrder(oid); else openSupplier(supplierId);
      } catch (x) { err.textContent = errMsg(x); }
    });
  };
}
function supPaymentsView() {
  const list = cache.supplierPayments;
  const monthStart = dateOnly(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  return `<div class="grid g3" style="margin-bottom:16px">${kpi('coins', 'Paid this month', money(sum(list.filter(p => p.paid_on >= monthStart), 'amount')))}${kpi('alert', 'Still owed', money(sum(cache.suppliers, s => Math.max(0, Number(s.balance)))), `${cache.suppliers.filter(s => Number(s.balance) > 0).length} supplier(s)`, 'warn')}${kpi('history', 'Payments recorded', list.length)}</div>
  <div class="card"><div class="tableWrap"><table><thead><tr><th>Date</th><th>Supplier</th><th>Order</th><th>Method</th><th>Reference</th><th class="right">Amount</th><th>Receipt</th><th>By</th></tr></thead><tbody>
  ${list.map(p => `<tr><td>${fmtD(p.paid_on)}</td><td>${esc(supplierById(p.supplier_id)?.name || '—')}</td><td class="mono">${p.order_id ? `<button class="priceBtn" onclick="openOrder('${p.order_id}')">${esc(cache.orders.find(o => o.id === p.order_id)?.order_no || 'order')}</button>` : 'on account'}</td><td>${esc(p.method)}</td><td class="mono">${esc(p.reference || '')}</td><td class="right num">${money(p.amount)}</td><td>${(p.attachments || [])[0] ? `<button class="btn small" onclick="openDoc('${jsq(p.attachments[0].path)}')">${icon('eye')}</button>` : '—'}</td><td>${esc(p.by_name || '')}</td></tr>`).join('') || `<tr><td colspan="8" class="empty">No supplier payments yet.</td></tr>`}
  </tbody></table></div></div>`;
}
function exportOrders() {
  downloadCSV('purchase-orders-' + dateOnly() + '.csv', [['Order', 'Status', 'Payment', 'Supplier', 'Location', 'Order date', 'Expected', 'Invoice', 'Invoice amount', 'Ordered value', 'Received value', 'Paid', 'Balance', 'Units ordered', 'Units received', 'Units damaged', 'Units outstanding']]
    .concat(filteredOrders().map(o => { const u = orderUnits(o); return [o.order_no, o.status, o.payment_status, supName(o), shopObj(o.shop_id)?.name || '', o.order_date, o.expected_date || '', o.invoice_no || '', o.invoice_amount ?? '', o.total_cost, o.received_value, o.paid_amount, orderBalance(o), u.ordered, u.received, u.damaged, orderOutstanding(o)]; })));
}
