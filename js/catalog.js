/* =============================================================================
   v3: business groups, unit master, shared product catalogue, QR print orders
   and the analysis-ready data export (Excel / CSV)
   ============================================================================= */
const REF_FALLBACK = {
  groups: [['A', 'Food & Beverage', 'Groceries, fresh produce, meat, dairy, bakery, drinks, grains', 'cart'], ['B', 'Health & Pharmacy', 'Drugs, medical consumables, supplements, baby care, equipment', 'shield'],
    ['C', 'Household & General Merchandise', 'Cleaning, kitchenware, stationery, hardware, tools, electrical', 'store'], ['D', 'Fashion & Personal Care', 'Clothing, footwear, bags, cosmetics, textiles', 'tag'],
    ['E', 'Electronics & Technology', 'Phones, computers, appliances, gadgets', 'phone'], ['F', 'Agro, Industrial & Bulk Commodities', 'Farm inputs, construction materials, fuel, raw/wholesale goods', 'truck']]
    .map(([code, name, covers, ic], i) => ({ code, name, covers, icon: ic, sort: i + 1 })),
  units: [['PCS', 'Piece'], ['DOZEN', '12 pieces'], ['PACK', 'Fixed small pack'], ['BOX', 'Box/carton (small)'], ['CARTON', 'Bulk carton'], ['SET', 'Grouped item'], ['BAG', 'Sack/bag'], ['KG', 'Kilogram'], ['G', 'Gram'],
    ['TON', 'Metric ton'], ['LTR', 'Liter'], ['ML', 'Milliliter'], ['MTR', 'Meter'], ['STRIP', 'Strip (pharma)'], ['BOTTLE', 'Bottle'], ['VIAL/AMPOULE', 'Small sealed dose']].map(([code, name], i) => ({ code, name, used_for: '', sort: i + 1 }))
};
const REF = { groups: REF_FALLBACK.groups, subs: [], units: REF_FALLBACK.units, loaded: false };
const GROUP_TONES = { A: '#16A34A', B: '#DC2626', C: '#2F5BEA', D: '#DB2777', E: '#7C3AED', F: '#B45309' };
async function loadRef() {
  try {
    const [g, s, u] = await Promise.all([sb.from('dq_groups').select('*').order('sort'), sb.from('dq_subcategories').select('*').order('group_code').order('sort'), sb.from('dq_units').select('*').order('sort')]);
    if (!g.error && g.data?.length) REF.groups = g.data;
    if (!s.error) REF.subs = s.data || [];
    if (!u.error && u.data?.length) REF.units = u.data;
    REF.loaded = !g.error;
  } catch (e) {}
}
function groupObj(code) { return REF.groups.find(g => g.code === code); }
function groupName(code) { return groupObj(code)?.name || ''; }
function subByName(name) { return REF.subs.find(s => s.name === name); }
function subObj(code) { return REF.subs.find(s => s.code === code); }
function myGroups() { return business?.business_groups || []; }
function groupDot(code) { return code ? `<i class="gDot" style="background:${GROUP_TONES[code] || 'var(--muted)'}" title="${esc(groupName(code))}"></i>` : ''; }
function unitName(code) { return REF.units.find(u => u.code === code)?.name || code || ''; }
function unitOptions(selected) {
  const mine = business?.units?.length ? business.units : null;
  const sel = (selected === 'unit' || !selected) ? 'PCS' : selected;
  const list = mine ? [...REF.units.filter(u => mine.includes(u.code)), ...REF.units.filter(u => !mine.includes(u.code))] : REF.units;
  const known = REF.units.some(u => u.code === sel);
  return (known ? '' : `<option value="${esc(sel)}" selected>${esc(sel)}</option>`) + list.map((u, i) => `${mine && i === mine.length ? '<option disabled>──────────</option>' : ''}<option value="${esc(u.code)}" ${u.code === sel ? 'selected' : ''}>${esc(u.code)} — ${esc(u.name)}</option>`).join('');
}
function groupCardsHtml(selected, inputName) {
  return `<div class="groupGrid">${REF.groups.map(g => `<label class="groupCard ${selected.includes(g.code) ? 'sel' : ''}" style="--gc:${GROUP_TONES[g.code]}"><input type="checkbox" name="${inputName}" value="${g.code}" ${selected.includes(g.code) ? 'checked' : ''} onchange="this.closest('.groupCard').classList.toggle('sel',this.checked)"><span class="gIco">${icon(g.icon || 'box')}</span><span><b>${esc(g.name)}</b><small>${esc(g.covers)}</small></span><span class="gTick">${icon('check')}</span></label>`).join('')}</div>`;
}
function checkedValues(name) { return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value); }

/* ---------------- business type (groups) and units ---------------- */
function openBusinessType(after) {
  const sel = myGroups();
  const units = business?.units?.length ? business.units : [];
  modal(`<form id="btF"><div class="cardHead"><div><h3>What does your business sell?</h3><p>Choose one or more groups. DeepQr adds matching categories and shows you ready-made products for them.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   ${groupCardsHtml(sel, 'btG')}
   <h3 style="margin:18px 0 6px">Units you use</h3><p class="muted" style="margin:0 0 8px;font-size:13px">These appear first when you create a product. Leave all unticked to show every unit.</p>
   <div class="unitChips">${REF.units.map(u => `<label class="unitChip"><input type="checkbox" name="btU" value="${esc(u.code)}" ${units.includes(u.code) ? 'checked' : ''}><b>${esc(u.code)}</b><small>${esc(u.name)}</small></label>`).join('')}</div>
   <div id="btErr" class="bad" style="min-height:20px;margin-top:8px"></div>
   <div class="actions"><button class="btn primary lg">${icon('check')}Save business type</button></div></form>`, 'wide');
  document.getElementById('btF').onsubmit = async e => {
    e.preventDefault();
    const groups = checkedValues('btG'), u = checkedValues('btU');
    if (!groups.length) { document.getElementById('btErr').textContent = 'Choose at least one group.'; return; }
    await withBusy(e.submitter, async () => {
      try {
        const r = await rpc('dq_set_business_groups', { p_groups: groups, p_units: u });
        business.business_groups = r.groups; business.units = u;
        const { data } = await sb.from('categories').select('*').order('name'); cache.categories = data || cache.categories;
        closeModal(); toast(`Business type saved${r.categories_added ? ` · ${r.categories_added} categories added` : ''}`, 'ok');
        if (after) after(); else renderView();
      } catch (x) { document.getElementById('btErr').textContent = errMsg(x); }
    });
  };
}

/* ---------------- product catalogue ---------------- */
let catData = null, catF = { group: '', sub: '', q: '', show: 'all' }, catSel = {};
async function loadCatalog(force) {
  if (catData && !force) return catData;
  const all = []; let from = 0;
  for (;;) { const { data, error } = await sb.from('catalog_products').select('*').order('code', { nullsFirst: false }).range(from, from + 999); if (error) throw error; all.push(...(data || [])); if (!data || data.length < 1000) break; from += 1000; }
  catData = all; return catData;
}
PAGES.catalog = {
  title: 'Product catalogue', searchable: false,
  sub: () => `Ready-made products sold in Tanzania. Tick the ones you sell, set your price and add them in one go. You can edit them later.`,
  actions: () => `<button class="btn" onclick="openBusinessType(()=>{catF.group='';renderView()})">${icon('store')}Business type</button><button class="btn" onclick="submitCatalogProduct()">${icon('plus')}Suggest a product</button>`,
  render: () => {
    if (!catData) { loadCatalog().then(() => view === 'catalog' && renderView()).catch(e => toast(errMsg(e), 'bad')); return `<div class="card"><div class="empty"><span class="spinner"></span> Loading the catalogue…</div></div>`; }
    const mine = myGroups();
    if (!catF.group && !catF.init) { catF.group = mine[0] || ''; catF.init = true; }
    const adopted = new Set(cache.products.map(p => p.catalog_id).filter(Boolean));
    const approved = catData.filter(c => c.status === 'approved' && c.active);
    const pend = catData.filter(c => c.status !== 'approved' && c.submitted_by_business === me.business_id);
    let list = approved.filter(c => !catF.group || c.group_code === catF.group);
    if (catF.sub) list = list.filter(c => c.subcategory_code === catF.sub);
    if (catF.q) { const q = catF.q.toLowerCase(); list = list.filter(c => [c.name, c.brand, c.code, subObj(c.subcategory_code)?.name].join(' ').toLowerCase().includes(q)); }
    if (catF.show === 'new') list = list.filter(c => !adopted.has(c.id));
    const subs = REF.subs.filter(s => !catF.group || s.group_code === catF.group);
    const nSel = Object.keys(catSel).length;
    const welcome = viewParams.welcome ? `<div class="banner ok">${icon('gift')}<div><b>Welcome to DeepQr, ${esc(business.name)}!</b><p>Here are products other ${mine.map(groupName).join(' / ') || ''} businesses sell. Tick what you sell and set your selling price — they become your products instantly, ready for QR labels and sales. Skip this and add your own products any time.</p></div><button class="btn small" onclick="viewParams.welcome=0;go('dashboard')">Skip for now</button></div>` : '';
    const groupTabs = `<div class="groupTabs">${REF.groups.map(g => { const n = approved.filter(c => c.group_code === g.code).length; return `<button class="${catF.group === g.code ? 'active' : ''} ${mine.includes(g.code) ? 'mine' : ''}" style="--gc:${GROUP_TONES[g.code]}" onclick="catF.group='${g.code}';catF.sub='';renderView()">${icon(g.icon || 'box')}<span><b>${esc(g.name)}</b><small>${n} products${mine.includes(g.code) ? ' · your group' : ''}</small></span></button>`; }).join('')}<button class="${!catF.group ? 'active' : ''}" onclick="catF.group='';catF.sub='';renderView()">${icon('layers')}<span><b>All groups</b><small>${approved.length} products</small></span></button></div>`;
    return `${welcome}${!mine.length ? `<div class="banner info">${icon('store')}<div><b>Tell DeepQr what your business sells</b><p>Choosing your business groups adds the right categories and puts your products first.</p></div><button class="btn small primary" onclick="openBusinessType(()=>{catF.init=false;renderView()})">Choose business type</button></div>` : ''}
     ${groupTabs}
     <div class="card" style="margin-top:14px"><div class="toolbar"><input class="input grow" id="catQ" value="${esc(catF.q)}" oninput="catF.q=this.value;const p=this.selectionStart;renderView();const e=document.getElementById('catQ');e.focus();e.setSelectionRange(p,p)" placeholder="Search name, brand or code…" aria-label="Search catalogue">
       <select class="input" onchange="catF.show=this.value;renderView()"><option value="all" ${catF.show === 'all' ? 'selected' : ''}>All products</option><option value="new" ${catF.show === 'new' ? 'selected' : ''}>Not yet in my products</option></select></div>
      <div class="pillRow"><button class="pill ${!catF.sub ? 'active' : ''}" onclick="catF.sub='';renderView()">All subcategories</button>${subs.map(s => `<button class="pill ${catF.sub === s.code ? 'active' : ''}" onclick="catF.sub='${s.code}';renderView()">${esc(s.name)} <small>${approved.filter(c => c.subcategory_code === s.code).length}</small></button>`).join('')}</div>
      <div class="tableWrap"><table><thead><tr><th style="width:34px"><input type="checkbox" aria-label="Select all shown" onchange="catSelectAll(this.checked)"></th><th>Product</th><th>Subcategory</th><th>Unit</th><th style="width:120px">Your code</th><th style="width:120px">Cost</th><th style="width:130px">Selling price</th><th></th></tr></thead><tbody>
      ${list.slice(0, 400).map(c => { const have = adopted.has(c.id), s = catSel[c.id]; return `<tr class="${have ? 'muted' : ''} ${s ? 'selRow' : ''}"><td>${have ? icon('check', 'ok') : `<input type="checkbox" class="catChk" data-id="${c.id}" ${s ? 'checked' : ''} onchange="catToggle('${c.id}',this.checked)" aria-label="Select ${esc(c.name)}">`}</td>
        <td>${groupDot(c.group_code)}<b>${esc(c.brand && !c.name.toLowerCase().includes(c.brand.toLowerCase()) ? c.brand + ' ' + c.name : c.name)}</b><span class="sub">${esc(c.pack_size || '')}${c.adopted_count ? ` · used by ${c.adopted_count} business${c.adopted_count > 1 ? 'es' : ''}` : ''}${c.source === 'business' ? ' · suggested by a business' : ''}</span></td>
        <td>${esc(subObj(c.subcategory_code)?.name || '')}</td><td><span class="tag gray">${esc(c.unit_code)}</span></td>
        <td>${have ? `<span class="mono">${esc(cache.products.find(p => p.catalog_id === c.id)?.code || c.code)}</span>` : `<input class="input mono" value="${esc(s?.code ?? c.code)}" maxlength="16" oninput="catEdit('${c.id}','code',this.value)" aria-label="Code">`}</td>
        <td>${have ? '' : `<input class="input" type="number" min="0" step="any" value="${esc(s?.cost ?? '')}" placeholder="optional" oninput="catEdit('${c.id}','cost',this.value)" aria-label="Cost">`}</td>
        <td>${have ? `<span class="tag ok">In my products</span>` : `<input class="input" type="number" min="0" step="any" value="${esc(s?.price ?? c.suggested_price)}" oninput="catEdit('${c.id}','price',this.value)" aria-label="Price"><span class="sub">suggested ${money(c.suggested_price)}</span>`}</td>
        <td>${have ? `<button class="btn small" onclick="openProduct('${jsq(cache.products.find(p => p.catalog_id === c.id)?.code || '')}')">${icon('edit')}</button>` : ''}</td></tr>`; }).join('') || `<tr><td colspan="8">${emptyState('search', 'No catalogue products here', 'Try another group or search. Missing something? Suggest it and DeepQr will add it for everyone.', `<button class="btn primary" onclick="submitCatalogProduct()">${icon('plus')}Suggest a product</button>`)}</td></tr>`}
      </tbody></table></div>${list.length > 400 ? `<p class="muted">Showing 400 of ${list.length}. Search or pick a subcategory to narrow down.</p>` : ''}</div>
     ${pend.length ? `<div class="card"><div class="cardHead"><div><h3>Your suggestions</h3><p>Products you proposed for the shared catalogue.</p></div></div><div class="tableWrap"><table><tbody>${pend.map(c => `<tr><td><b>${esc(c.name)}</b>${c.brand ? ` <span class="muted">${esc(c.brand)}</span>` : ''}</td><td>${esc(subObj(c.subcategory_code)?.name || '')}</td><td>${c.status === 'pending' ? '<span class="tag warn">Waiting for DeepQr</span>' : `<span class="tag bad">Not accepted</span> <small class="muted">${esc(c.review_note || '')}</small>`}</td><td>${fmtD(c.created_at)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
     <div class="stickyBar ${nSel ? 'show' : ''}" id="catBar">${catBarHtml()}</div>`;
  }
};
function catBarHtml() {
  const ids = Object.keys(catSel), n = ids.length;
  const val = sum(ids, id => Number(catSel[id].price || 0));
  return `<span><b>${n}</b> product(s) selected${n ? ` · total of prices ${money(val)}` : ''}</span><span class="actions"><button class="btn ghost" onclick="catSel={};renderView()">Clear</button><button class="btn primary" onclick="adoptSelected(this)" ${n ? '' : 'disabled'}>${icon('plus')}Add ${n} to my products</button></span>`;
}
function catRefreshBar() { const b = document.getElementById('catBar'); if (b) { b.innerHTML = catBarHtml(); b.classList.toggle('show', Object.keys(catSel).length > 0); } }
function catToggle(id, on) {
  const c = catData.find(x => x.id === id);
  if (on) catSel[id] = catSel[id] || { code: c.code, price: c.suggested_price, cost: '' }; else delete catSel[id];
  document.querySelector(`.catChk[data-id="${id}"]`)?.closest('tr')?.classList.toggle('selRow', on);
  catRefreshBar();
}
function catEdit(id, k, v) { const c = catData.find(x => x.id === id); if (!catSel[id]) { catSel[id] = { code: c.code, price: c.suggested_price, cost: '' }; const cb = document.querySelector(`.catChk[data-id="${id}"]`); if (cb) cb.checked = true; cb?.closest('tr')?.classList.add('selRow'); } catSel[id][k] = v; catRefreshBar(); }
function catSelectAll(on) { document.querySelectorAll('.catChk').forEach(cb => { cb.checked = on; catToggle(cb.dataset.id, on); }); }
async function adoptSelected(btn) {
  const ids = Object.keys(catSel); if (!ids.length) return;
  const codes = ids.map(id => String(catSel[id].code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const dup = codes.find((c, i) => !c || codes.indexOf(c) !== i || cache.products.some(p => p.code.toUpperCase() === c));
  if (dup !== undefined) { toast(dup ? `Code ${dup} is already used — change it before adding` : 'Every product needs a code', 'bad'); return; }
  await withBusy(btn, async () => {
    try {
      const r = await rpc('dq_adopt_catalog', { p: { items: ids.map(id => ({ catalog_id: id, code: catSel[id].code, price: catSel[id].price === '' ? null : Number(catSel[id].price), cost: catSel[id].cost === '' ? null : Number(catSel[id].cost) })) } });
      cache.products.push(...(r.products || [])); cache.products.sort((a, b) => a.name.localeCompare(b.name));
      const { data } = await sb.from('categories').select('*').order('name'); cache.categories = data || cache.categories;
      catSel = {}; await loadCatalog(true); renderView();
      toast(`${r.added} product(s) added to your products${r.skipped?.length ? ` · ${r.skipped.length} skipped` : ''}`, 'ok');
      if (r.added && canQR()) setTimeout(() => toast('Next: receive stock for them, then generate QR labels', ''), 3600);
    } catch (e) { toast(errMsg(e), 'bad'); }
  });
}
function submitCatalogProduct(productId) {
  const p = productId ? productById(productId) : null;
  const sub = p ? subByName(p.category) : null;
  modal(`<form id="scF"><div class="cardHead"><div><h3>Suggest a product for the catalogue</h3><p>DeepQr checks it and adds it to the shared catalogue so other businesses can use it too. Your own product list is not affected.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="formGrid"><div class="field"><label for="scN">Product name *</label><input id="scN" required value="${esc(p?.name || '')}" placeholder="e.g. Ukwaju juice 300ml"></div><div class="field"><label for="scB">Brand</label><input id="scB" value="${esc(p?.brand || '')}"></div>
    <div class="field"><label for="scS">Subcategory *</label><select id="scS" required>${REF.groups.map(g => `<optgroup label="${esc(g.code + '. ' + g.name)}">${REF.subs.filter(s => s.group_code === g.code).map(s => `<option value="${s.code}" ${(sub?.code === s.code) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</optgroup>`).join('')}</select></div>
    <div class="field"><label for="scU">Unit *</label><select id="scU">${unitOptions(p?.unit || 'PCS')}</select></div><div class="field"><label for="scP">Pack size</label><input id="scP" value="${esc(p?.pack_size || '')}" placeholder="e.g. 300ml, 50kg"></div><div class="field"><label for="scPr">Typical selling price</label><input id="scPr" type="number" min="0" step="any" value="${p?.price || ''}"></div>
    <div class="field"><label for="scBc">Barcode (EAN) if printed on it</label><input id="scBc" class="mono" value="${esc(p && !/^2\d{11}$/.test(p.barcode || '') ? p.barcode : '')}"></div></div>
   <div id="scErr" class="bad" style="min-height:20px;margin-top:8px"></div><div class="actions"><button class="btn primary">${icon('check')}Send suggestion</button></div></form>`);
  document.getElementById('scF').onsubmit = async e => {
    e.preventDefault(); const v = id => document.getElementById(id).value;
    await withBusy(e.submitter, async () => {
      try { await rpc('dq_submit_catalog_product', { p: { name: v('scN'), brand: v('scB'), subcategory_code: v('scS'), unit_code: v('scU'), pack_size: v('scP'), price: v('scPr') || 0, barcode: v('scBc'), product_id: productId || null } }); closeModal(); toast('Thank you — DeepQr will review your suggestion', 'ok'); if (catData) { await loadCatalog(true); if (view === 'catalog') renderView(); } }
      catch (x) { document.getElementById('scErr').textContent = errMsg(x); }
    });
  };
}

/* ---------------- QR label print orders ---------------- */
const PRINT_STATUS = { requested: ['Requested', 'warn'], accepted: ['Accepted', 'info'], printing: ['Printing', 'info'], ready: ['Ready', 'ok'], delivered: ['Delivered', 'ok'], cancelled: ['Cancelled', 'gray'], rejected: ['Rejected', 'bad'] };
const PRINT_FLOW = ['requested', 'accepted', 'printing', 'ready', 'delivered'];
function printTag(s) { const x = PRINT_STATUS[s] || [s, 'gray']; return `<span class="tag ${x[1]}">${x[0]}</span>`; }
function printSteps(o) {
  if (['cancelled', 'rejected'].includes(o.status)) return printTag(o.status);
  const at = PRINT_FLOW.indexOf(o.status);
  return `<div class="steps">${PRINT_FLOW.map((s, i) => `<span class="${i < at ? 'done' : i === at ? 'now' : ''}" title="${PRINT_STATUS[s][0]}"></span>`).join('')}<small>${PRINT_STATUS[o.status][0]}</small></div>`;
}
let printSettings = null;
async function loadPrintSettings() { if (printSettings) return printSettings; const { data } = await sb.from('platform_settings').select('print_fee_per_label,print_delivery_fee,print_lead_days,print_note,support_phone,currency').eq('id', 1).maybeSingle(); printSettings = data || { print_fee_per_label: 20, print_delivery_fee: 0, print_lead_days: 2 }; return printSettings; }
async function openPrintOrder(genIds) {
  const st = await loadPrintSettings();
  const gens = cache.generations.filter(g => genIds.includes(g.id));
  const inStock = id => cache.items.filter(i => i.generation_id === id).length;
  const labels = sum(gens, g => inStock(g.id));
  if (!labels) { toast('These batches have no unsold labels left to print', 'bad'); return; }
  const minDate = addDays(Number(st.print_lead_days || 2));
  const fee = Number(st.print_fee_per_label || 0), dfee = Number(st.print_delivery_fee || 0);
  modal(`<form id="poPrF"><div class="cardHead"><div><h3>Order printed labels from DeepQr</h3><p>${esc(st.print_note || '')}</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="tableWrap"><table style="min-width:0"><thead><tr><th>Batch</th><th>Location</th><th>Serials</th><th class="right">Labels to print</th></tr></thead><tbody>${gens.map(g => `<tr><td><b>${esc(productById(g.product_id)?.name || '')}</b></td><td>${esc(shopObj(g.shop_id)?.name || '')}</td><td class="mono" style="font-size:12px">${esc(g.first_serial || '')} → ${esc(g.last_serial || '')}</td><td class="right num">${inStock(g.id)}</td></tr>`).join('')}</tbody></table></div>
   <div class="formGrid" style="margin-top:12px">
    <div class="field"><label for="prD">Needed by *</label><input id="prD" type="date" min="${minDate}" value="${minDate}" required><small class="muted">Earliest ${fmtD(minDate)}</small></div>
    <div class="field"><label for="prC">Copies of each label</label><select id="prC" onchange="prCalc()">${[1, 2, 3].map(n => `<option>${n}</option>`).join('')}</select></div>
    <div class="field"><label for="prS">Label size</label><select id="prS">${[['small', 'Small 25 mm'], ['medium', 'Medium 38 mm'], ['large', 'Large 50 mm']].map(([k, l]) => `<option value="${k}" ${(business.label_size || 'medium') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label for="prM">Collection</label><select id="prM" onchange="document.getElementById('prAddrBox').classList.toggle('hidden',this.value!=='delivery');prCalc()"><option value="pickup">I will collect from DeepQr</option><option value="delivery">Deliver to my shop${dfee ? ` (+${money(dfee)})` : ''}</option></select></div>
    <div class="field"><label for="prPh">Contact phone *</label><input id="prPh" type="tel" required value="${esc(business.phone || me.phone || '')}"></div>
    <div class="field"><label for="prNm">Contact name</label><input id="prNm" value="${esc(me.name)}"></div></div>
   <div class="field hidden" id="prAddrBox" style="margin-top:10px"><label for="prA">Delivery address *</label><input id="prA" value="${esc(business.address || '')}" placeholder="Street, area, town"></div>
   <div class="field" style="margin-top:10px"><label for="prN">Note to DeepQr</label><input id="prN" placeholder="Optional"></div>
   <div class="totals" id="prSum" data-labels="${labels}" data-fee="${fee}" data-dfee="${dfee}"></div>
   <div id="prErr" class="bad" style="min-height:20px;margin-top:8px"></div>
   <div class="actions"><button class="btn primary lg">${icon('printer')}Send print order</button><button type="button" class="btn" onclick="closeModal();printGeneration('${genIds[0]}')">Print them myself instead</button></div></form>`);
  window.__printGens = genIds; prCalc();
  document.getElementById('poPrF').onsubmit = async e => {
    e.preventDefault(); const v = id => document.getElementById(id).value;
    await withBusy(e.submitter, async () => {
      try {
        const o = await rpc('dq_request_print', { p: { generation_ids: window.__printGens, copies: Number(v('prC')), label_size: v('prS'), delivery_method: v('prM'), delivery_address: v('prA'), contact_phone: v('prPh'), contact_name: v('prNm'), requested_date: v('prD'), note: v('prN') } });
        closeModal(); await loadDeepQr(); go('qr', { tab: 'print' }); toast(`${o.order_no} sent to DeepQr · ${money(o.total_fee)}`, 'ok');
      } catch (x) { document.getElementById('prErr').textContent = errMsg(x); }
    });
  };
}
function prCalc() {
  const el = document.getElementById('prSum'); if (!el) return;
  const n = Number(el.dataset.labels), c = Number(document.getElementById('prC').value), fee = Number(el.dataset.fee), d = document.getElementById('prM').value === 'delivery' ? Number(el.dataset.dfee) : 0;
  el.innerHTML = `<div class="row"><span>${num(n)} label(s) × ${c} cop${c > 1 ? 'ies' : 'y'} × ${money(fee)}</span><b>${money(n * c * fee)}</b></div>${d ? `<div class="row"><span>Delivery</span><b>${money(d)}</b></div>` : ''}<div class="row grand"><span>Paid from your QR wallet</span><span>${money(n * c * fee + d)}</span></div>`;
}
function printOrdersView() {
  const list = cache.printOrders || [];
  return `<div class="card"><div class="cardHead"><div><h3>Print orders</h3><p>Labels you asked DeepQr to print. To order, open <button class="priceBtn" onclick="qrTab('batches')">Batches</button>, tick the batches and choose “Order printing”.</p></div></div>
  <div class="tableWrap"><table><thead><tr><th>Order</th><th>Products</th><th class="right">Labels</th><th>Needed by</th><th>DeepQr date</th><th>Collection</th><th class="right">Fee</th><th style="width:170px">Progress</th><th></th></tr></thead><tbody>
  ${list.map(o => `<tr><td class="mono"><b>${esc(o.order_no)}</b><span class="sub">${fmtD(o.created_at)} · ${esc(o.requested_by || '')}</span></td><td>${esc([...new Set(cache.generations.filter(g => (o.generation_ids || []).includes(g.id)).map(g => productById(g.product_id)?.name))].filter(Boolean).join(', ') || '—')}</td><td class="right num">${num(o.label_count)}${o.copies > 1 ? ` × ${o.copies}` : ''}</td><td>${fmtD(o.requested_date)}</td><td>${o.promised_date ? fmtD(o.promised_date) : '—'}</td><td>${o.delivery_method === 'delivery' ? `Delivery<span class="sub">${esc(o.delivery_address || '')}</span>` : 'Collect'}</td><td class="right num">${money(o.total_fee)}</td><td>${printSteps(o)}${o.admin_note ? `<span class="sub">${esc(o.admin_note)}</span>` : ''}</td><td>${o.status === 'requested' ? `<button class="btn small ghost" onclick="cancelPrint('${o.id}')">Cancel</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="9">${emptyState('printer', 'No print orders yet', 'Print labels yourself on any printer, or let DeepQr print durable sticker labels and have them ready on your chosen date.')}</td></tr>`}
  </tbody></table></div></div>`;
}
function cancelPrint(id) { confirmBox('Cancel this print order?', 'The fee goes back to your QR wallet.', 'Cancel order', async b => { await withBusy(b, async () => { const r = await rpcToast('dq_cancel_print', { p_id: id }, 'Print order cancelled, fee refunded'); if (r) { closeModal(); await loadDeepQr(); renderView(); } }); }); }

/* ---------------- analysis-ready data export ---------------- */
const EXPORT_TYPES = [['sale', 'Sales (one row per item sold)', 'cart'], ['payment', 'Payments received & debt payments', 'coins'], ['refund', 'Refunds paid', 'refund'], ['purchase', 'Stock received (purchases)', 'truck'],
  ['damaged', 'Damaged on delivery', 'alert'], ['supplier_payment', 'Supplier payments', 'wallet'], ['expense', 'Expenses', 'minus'], ['adjustment', 'Stock corrections', 'edit'],
  ['transfer', 'Transfers between locations', 'transfer'], ['qr_fee', 'DeepQr fees', 'qr'], ['stock', 'Stock on hand today', 'layers']];
let dlF = null;
function openExport() {
  dlF = dlF || { range: 'month', from: '', to: '', shop: '', types: EXPORT_TYPES.map(t => t[0]), groups: [], format: 'xlsx', extras: true };
  const [f, t] = rangeDates(dlF.range);
  modal(`<form id="exF"><div class="cardHead"><div><h3>${icon('download')} Download business data</h3><p>One tidy table with every sale, purchase, payment, expense and stock movement — ready for Excel pivot tables, filters and charts.</p></div><button type="button" class="btn ghost" onclick="closeModal()">${icon('x')}</button></div>
   <div class="formGrid"><div class="field"><label for="exR">Period</label><select id="exR" onchange="dlF.range=this.value;document.getElementById('exCustom').classList.toggle('hidden',this.value!=='custom')">${RANGES.map(([k, l]) => `<option value="${k}" ${dlF.range === k ? 'selected' : ''}>${l}</option>`).join('')}<option value="custom" ${dlF.range === 'custom' ? 'selected' : ''}>Custom dates…</option></select></div>
    <div class="field ${dlF.range === 'custom' ? '' : 'hidden'}" id="exCustom"><label>From – to</label><div class="searchLine" style="margin:0"><input id="exFrom" type="date" value="${esc(dlF.from || f)}"><input id="exTo" type="date" value="${esc(dlF.to || t)}" max="${dateOnly()}"></div></div>
    ${me.role !== 'cashier' ? `<div class="field"><label for="exS">Location</label>${selectShops('exS', dlF.shop, { all: true, any: 'All locations' })}</div>` : ''}
    <div class="field"><label>File type</label><div class="seg" role="radiogroup"><button type="button" class="${dlF.format === 'xlsx' ? 'active' : ''}" onclick="dlF.format='xlsx';this.parentNode.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b===this))">Excel (.xlsx)</button><button type="button" class="${dlF.format === 'csv' ? 'active' : ''}" onclick="dlF.format='csv';this.parentNode.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b===this))">CSV</button></div></div></div>
   <h3 style="margin:16px 0 8px">What to include</h3><div class="permGrid">${EXPORT_TYPES.map(([k, l, ic]) => `<label class="chk"><input type="checkbox" name="exT" value="${k}" ${dlF.types.includes(k) ? 'checked' : ''}>${icon(ic)} ${l}</label>`).join('')}</div>
   <div class="actions" style="margin-top:6px"><button type="button" class="btn small ghost" onclick="document.querySelectorAll('input[name=exT]').forEach(c=>c.checked=true)">Select all</button><button type="button" class="btn small ghost" onclick="document.querySelectorAll('input[name=exT]').forEach(c=>c.checked=false)">None</button></div>
   ${REF.groups.length ? `<h3 style="margin:16px 0 8px">Product groups <small class="muted" style="font-weight:500">(leave empty for all)</small></h3><div class="unitChips">${REF.groups.map(g => `<label class="unitChip"><input type="checkbox" name="exG" value="${g.code}" ${dlF.groups.includes(g.code) ? 'checked' : ''}>${groupDot(g.code)}<b>${esc(g.name)}</b></label>`).join('')}<label class="unitChip"><input type="checkbox" name="exG" value="none" ${dlF.groups.includes('none') ? 'checked' : ''}><b>Money rows (expenses, payments)</b></label></div>` : ''}
   <label class="chk" style="margin-top:14px"><input type="checkbox" id="exX" ${dlF.extras ? 'checked' : ''}>Excel: add Summary, Monthly and “How to analyse” sheets (the data stays on one sheet)</label>
   <div id="exMsg" class="muted" style="min-height:20px;margin-top:10px"></div>
   <div class="actions"><button class="btn primary lg">${icon('download')}Download</button></div></form>`, 'wide');
  document.getElementById('exF').onsubmit = e => { e.preventDefault(); runExport(e.submitter); };
}
async function runExport(btn) {
  const msg = document.getElementById('exMsg');
  dlF.types = checkedValues('exT'); dlF.groups = checkedValues('exG'); dlF.extras = document.getElementById('exX').checked;
  dlF.shop = document.getElementById('exS')?.value || '';
  if (dlF.range === 'custom') { dlF.from = document.getElementById('exFrom').value; dlF.to = document.getElementById('exTo').value; }
  if (!dlF.types.length) { msg.innerHTML = '<span class="bad">Tick at least one kind of data.</span>'; return; }
  const [from, to] = dlF.range === 'custom' ? [dlF.from, dlF.to] : rangeDates(dlF.range);
  await withBusy(btn, async () => {
    try {
      msg.innerHTML = '<span class="spinner"></span> Collecting data…';
      const r = await rpc('dq_export', { p: { from, to, shop_id: dlF.shop || null, types: dlF.types, groups: dlF.groups.length ? dlF.groups : null } });
      const rows = exportRows(r);
      if (!rows.length) { msg.innerHTML = '<span class="warn">No records for these filters. Try a longer period or more data types.</span>'; return; }
      const base = `DeepQr_${(r.business_code || 'data')}_${r.from}_to_${r.to}`;
      if (dlF.format === 'csv') { downloadCSV(base + '.csv', [EXPORT_COLS.map(c => c[0])].concat(rows.map(x => EXPORT_COLS.map(c => x[c[1]])))); }
      else { msg.innerHTML = '<span class="spinner"></span> Building the Excel file…'; await buildXlsx(r, rows, base + '.xlsx', dlF.extras); }
      msg.innerHTML = `<span class="ok">${icon('check')} ${num(rows.length)} rows downloaded.</span>`;
      logActivity('export', `Data downloaded: ${rows.length} rows (${r.from} – ${r.to})`);
    } catch (e) { msg.innerHTML = `<span class="bad">${esc(errMsg(e))}</span>`; }
  });
}
const EXPORT_COLS = [['Date', 'date', 'date', 12], ['Time', 'time', 's', 7], ['Year', 'year', 'int', 7], ['Month', 'month', 's', 9], ['Month name', 'monthName', 's', 11], ['Week', 'week', 's', 10], ['Weekday', 'weekday', 's', 11],
  ['Type', 'type', 's', 18], ['Location', 'location', 's', 16], ['Product / item', 'product', 's', 30], ['Code', 'code', 's', 10], ['Category', 'category', 's', 20], ['Group', 'group', 's', 22], ['Unit', 'unit', 's', 8],
  ['Qty in', 'qty_in', 'num', 9], ['Qty out', 'qty_out', 'num', 9], ['Net qty', 'net_qty', 'num', 9], ['Unit price', 'unit_price', 'money', 12], ['Value', 'value', 'money', 14], ['Cost', 'cost', 'money', 14], ['Profit', 'profit', 'money', 14],
  ['Money in', 'money_in', 'money', 14], ['Money out', 'money_out', 'money', 14], ['Net cash', 'net_cash', 'money', 14], ['Payment method', 'method', 's', 14], ['Customer / supplier', 'party', 's', 22], ['Staff', 'staff', 's', 16],
  ['Reference', 'reference', 's', 18], ['Status', 'status', 's', 16], ['Notes', 'notes', 's', 30], ['Serial', 'serial', 's', 12]];
function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return t.getUTCFullYear() + '-W' + String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0'); }
function exportRows(r) {
  return (r.rows || []).map(x => {
    const d = new Date(x.date + 'T00:00:00');
    const n = k => x[k] === null || x[k] === undefined || x[k] === '' ? null : Number(x[k]);
    return { ...x, time: ['Expense', 'Supplier payment'].includes(x.type) ? '' : x.time, year: d.getFullYear(), month: x.date.slice(0, 7), monthName: d.toLocaleString('en', { month: 'short' }) + ' ' + d.getFullYear(), week: isoWeek(d), weekday: d.toLocaleString('en', { weekday: 'long' }),
      qty_in: n('qty_in') || 0, qty_out: n('qty_out') || 0, net_qty: (n('qty_in') || 0) - (n('qty_out') || 0), unit_price: n('unit_price'), value: n('value') || 0, cost: n('cost') || 0, profit: n('profit'),
      money_in: n('money_in') || 0, money_out: n('money_out') || 0, net_cash: (n('money_in') || 0) - (n('money_out') || 0) };
  });
}
function loadScript(src) { return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) { const t = setInterval(() => { if (window.ExcelJS) { clearInterval(t); res(); } }, 50); return; } const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the Excel library. Check the internet connection or download CSV.')); document.head.appendChild(s); }); }
async function buildXlsx(r, rows, name, extras) {
  if (!window.ExcelJS) await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js');
  const wb = new ExcelJS.Workbook(); wb.creator = 'DeepQr'; wb.created = new Date();
  const C = r.currency || cur(), moneyFmt = '#,##0;[Red]-#,##0', numFmt = '#,##0.##';
  const navy = 'FF0A1A44', blue = 'FF1D3FB8', soft = 'FFEEF2FF';
  // ---- Data: one flat table, header at A1 (pivot-ready)
  const ws = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }], properties: { tabColor: { argb: blue } } });
  ws.columns = EXPORT_COLS.map(c => ({ key: c[1], width: c[3] }));
  ws.addTable({ name: 'DeepQrData', ref: 'A1', headerRow: true, totalsRow: false, style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: EXPORT_COLS.map(c => ({ name: c[0], filterButton: true })),
    rows: rows.map(x => EXPORT_COLS.map(c => c[2] === 'date' ? new Date(x.date + 'T00:00:00Z') : (c[2] === 's' ? (x[c[1]] ?? '') : x[c[1]]))) });
  EXPORT_COLS.forEach((c, i) => { const col = ws.getColumn(i + 1); if (c[2] === 'date') col.numFmt = 'dd mmm yyyy'; else if (c[2] === 'money') col.numFmt = moneyFmt; else if (c[2] === 'num') col.numFmt = numFmt; });
  ws.getRow(1).height = 22;
  ws.getRow(1).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }; c.alignment = { vertical: 'middle' }; });
  if (extras) {
    // ---- Summary by type
    const sm = wb.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF14B8A6' } } });
    sm.columns = [{ width: 26 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }];
    sm.mergeCells('A1:H1'); sm.getCell('A1').value = `${r.business} — business data`; sm.getCell('A1').font = { bold: true, size: 16, color: { argb: navy } };
    sm.getCell('A2').value = `Period ${fmtD(r.from)} – ${fmtD(r.to)}${r.shop ? ' · ' + r.shop : ' · all locations'} · amounts in ${C} · generated ${fmtDT(r.generated_at)} by ${r.generated_by}`; sm.getCell('A2').font = { color: { argb: 'FF64748B' } };
    const head = ['Type', 'Rows', 'Qty in', 'Qty out', 'Value', 'Profit', 'Money in', 'Money out'];
    sm.addRow([]); const hr = sm.addRow(head);
    hr.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }; });
    const by = groupBy(rows, x => x.type);
    Object.entries(by).sort((a, b) => b[1].length - a[1].length).forEach(([t, l]) => sm.addRow([t, l.length, sum(l, 'qty_in'), sum(l, 'qty_out'), sum(l, 'value'), t === 'Sale' ? sum(l, x => x.profit || 0) : null, sum(l, 'money_in'), sum(l, 'money_out')]));
    const tr = sm.addRow(['Total', rows.length, null, null, null, null, sum(rows, 'money_in'), sum(rows, 'money_out')]); tr.font = { bold: true }; tr.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: soft } }; });
    [2, 3, 4].forEach(i => sm.getColumn(i).numFmt = numFmt); [5, 6, 7, 8].forEach(i => sm.getColumn(i).numFmt = moneyFmt);
    const sales = rows.filter(x => x.type === 'Sale');
    if (sales.length) {
      sm.addRow([]); const t2 = sm.addRow(['Top products by sales', 'Qty', '', '', 'Sales', 'Profit']); t2.font = { bold: true, color: { argb: blue } };
      Object.values(groupBy(sales, x => x.code || x.product)).map(l => ({ p: l[0].product, q: sum(l, 'qty_out'), v: sum(l, 'value'), pr: sum(l, x => x.profit || 0) })).sort((a, b) => b.v - a.v).slice(0, 15).forEach(x => sm.addRow([x.p, x.q, null, null, x.v, x.pr]));
    }
    // ---- Monthly
    const mo = wb.addWorksheet('Monthly', { properties: { tabColor: { argb: 'FFF59E0B' } } });
    mo.columns = [{ header: 'Month', width: 12 }, { header: 'Sales', width: 16 }, { header: 'Cost of sales', width: 16 }, { header: 'Gross profit', width: 16 }, { header: 'Expenses', width: 16 }, { header: 'Stock received', width: 16 }, { header: 'Money in', width: 16 }, { header: 'Money out', width: 16 }, { header: 'Net cash', width: 16 }];
    mo.getRow(1).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }; });
    Object.entries(groupBy(rows.filter(x => x.type !== 'Stock on hand'), x => x.month)).sort().forEach(([m, l]) => { const s = l.filter(x => x.type === 'Sale'); mo.addRow([m, sum(s, 'value'), sum(s, 'cost'), sum(s, x => x.profit || 0), sum(l.filter(x => x.type === 'Expense'), 'money_out'), sum(l.filter(x => x.type === 'Stock received'), 'value'), sum(l, 'money_in'), sum(l, 'money_out'), sum(l, 'net_cash')]); });
    for (let i = 2; i <= 9; i++) mo.getColumn(i).numFmt = moneyFmt;
    mo.views = [{ state: 'frozen', ySplit: 1 }];
    // ---- How to analyse
    const hw = wb.addWorksheet('How to analyse');
    hw.getColumn(1).width = 110;
    [['How to analyse this file', 'h'], ['All records are on the “Data” sheet as one Excel table named DeepQrData. Each row is one event: a sale line, a payment, a delivery, an expense, a transfer or today’s stock.', ''],
     ['Pivot table: click any cell in Data → Insert → PivotTable → OK. Drag “Type” to Filters, “Month” to Rows, “Group” or “Location” to Columns and “Value” or “Profit” to Values.', ''],
     ['Sales and profit: filter Type = Sale. Value = net sales after discounts and returns. Cost = cost of goods sold. Profit = Value − Cost.', ''],
     ['Cash flow: use Money in and Money out (or Net cash). Sales rows have no money columns — the money is in “Payment received” and “Debt payment” rows, so nothing is counted twice.', ''],
     ['Stock: “Stock received” and “Transfer in” are Qty in; sales, “Transfer out” and “Damaged on delivery” are Qty out. “Stock on hand” rows show today’s quantity (Value at selling price, Cost at cost price).', ''],
     ['Dates: Year, Month, Week and Weekday columns are ready for grouping. The table filters (▼ in the header row) work like Excel filters.', ''],
     [`Generated by DeepQr for ${r.business} (${r.business_code || ''}).`, 'm']].forEach(([t, k]) => { const row = hw.addRow([t]); row.getCell(1).alignment = { wrapText: true, vertical: 'top' }; if (k === 'h') row.font = { bold: true, size: 15, color: { argb: navy } }; if (k === 'm') row.font = { italic: true, color: { argb: 'FF64748B' } }; });
  }
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
