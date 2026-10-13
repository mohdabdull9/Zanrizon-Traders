"""DeepQr v4 browser tests: label check, online shop + shopper portal, payment
verification, completing online orders at the till, supplier portal, platform
team and smart suggestions.

Runs after tests/e2e_test.py on the same database (it uses the demo business
that suite builds):

    python3 tests/e2e_test.py <node_modules_dir> <screenshot_dir>
    python3 tests/e2e_v4_test.py <node_modules_dir> <screenshot_dir>
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_harness import *  # noqa: F401,F403
from e2e_harness import results, errors

DELL = '00000000-0000-4000-8000-000000000701'

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox'])

    # ================================================================== 1. public label check (smart QR link)
    serial = sql(f"select serial from product_items where product_id='{DELL}' and status='in_stock' order by serial limit 1")
    link = sql(f"select qr_payload from product_items where serial='{serial}'")
    v = new_page(browser, 420, 860)
    v.goto(BASE + '?' + link.split('?', 1)[1])
    v.wait_for_selector('.verifyCard', timeout=15000)
    txt = v.inner_text('#content')
    check('scanning a label link opens the public check page', 'Genuine' in txt and 'Dell 12' in txt and serial in txt, txt[:300])
    shot(v, '40-verify-genuine')
    v.fill('#vfIn', 'DQ1|DEM|S02|D12|999999999'); v.click('.searchLine button'); v.wait_for_selector('.verifyCard.bad', timeout=10000)
    check('unknown serial is flagged as not genuine', 'Not a known DeepQr label' in v.inner_text('#content'))
    v.context.close()

    # ================================================================== 2. owner opens the online shop
    ow = new_page(browser)
    login(ow, 'owner@demo.test')
    goto(ow, 'online'); ow.wait_for_selector('.storeIntro', timeout=10000)
    check('online orders page explains how to start', 'Sell online with DeepQr' in ow.inner_text('#content'))
    shot(ow, '41-online-intro')
    ow.click('.storeIntro button.primary'); ow.wait_for_selector('#stF')
    ow.check('#stOn'); ow.fill('#stSlug', 'demo-shop'); ow.fill('#stTag', 'Laptops, phones and groceries')
    ow.fill('#stArea', 'Kariakoo, Dar es Salaam'); ow.fill('#stHrs', 'Mon-Sat 8:00-20:00')
    ow.check('#stDel'); ow.fill('#stFee', '5000')
    ow.fill('#stAccs .searchLine >> nth=0 >> input.mono', '0754 123 456')
    if ow.is_visible('#stFop'): ow.fill('#stFop', '50')
    shot(ow, '42-store-settings')
    ow.click('#stF button.primary'); ow.wait_for_timeout(1200)
    check('online shop opened with delivery and an M-Pesa number',
          sql("select store_enabled||'/'||store_slug||'/'||store_delivery_fee::int||'/'||(store_payment_accounts->0->>'number') from businesses where code='DEM'") == 'true/demo-shop/5000/0754 123 456',
          sql("select store_enabled, store_slug, store_delivery_fee, store_payment_accounts from businesses where code='DEM'"))

    # ================================================================== 3. shopper registers and orders from a phone
    sh = new_page(browser, 400, 860)
    sh.goto(BASE + '?shops'); sh.wait_for_selector('.shopCard', timeout=15000)
    check('shop directory lists the open shop', 'DEMO' in sh.inner_text('#content'))
    shot(sh, '43-shop-directory')
    sh.click('.shopCard:has-text("DEMO")'); sh.wait_for_selector('.prodCard', timeout=15000)
    check('shop page shows products with live stock', 'Dell 12' in sh.inner_text('.prodCards') and 'In stock' in sh.inner_text('.prodCards'))
    sh.click('.prodCard:has-text("Dell 12") button:has-text("Add")'); sh.wait_for_timeout(300)
    check('basket bar appears', sh.is_visible('.basketBar') and '1 item' in sh.inner_text('.basketBar'))
    shot(sh, '44-store-basket')
    sh.click('.basketBar'); sh.wait_for_selector('#coSum')
    sh.click('#modal .seg.big button:has-text("Deliver to me")'); sh.wait_for_timeout(200)
    sh.fill('#coA', 'Mtaa wa Congo, Kariakoo')
    sh.click('#modal .seg.big button:has-text("M-Pesa")'); sh.wait_for_timeout(200)
    check('checkout shows the shop M-Pesa number and the total incl. delivery', '0754 123 456' in sh.inner_text('#modal') and '755,000' in sh.inner_text('#coSum'), sh.inner_text('#coSum'))
    sh.fill('#coR', 'QK72HT91XZ')
    shot(sh, '45-checkout')
    sh.click('#modal button:has-text("Sign in & place order")'); sh.wait_for_selector('#shF')
    sh.click('#modal .tabs button:has-text("New account")'); sh.wait_for_selector('#shN')
    sh.fill('#shN', 'Neema Said'); sh.fill('#shP', '0713 555 777'); sh.fill('#shW', 'secret1'); sh.fill('#shA', 'Kariakoo')
    sh.click('#shF button.primary')
    sh.wait_for_selector('#coSum', timeout=15000)   # checkout re-opens after sign-up
    sh.fill('#coR', 'QK72HT91XZ') if not sh.input_value('#coR') else None
    sh.click('#modal button:has-text("Place order")')
    sh.wait_for_selector('.orderCard', timeout=15000)
    ctext = sh.inner_text('#content')
    check('shopper sees the order with a progress track', 'sent!' in ctext and 'Payment being checked' in ctext and sh.is_visible('.track'), ctext[:300])
    oo = sql("select order_no||'/'||status||'/'||payment_status||'/'||total::int||'/'||delivery_fee::int from online_orders order by created_at desc limit 1")
    check('online order stored: delivery, payment waiting for verification', oo.endswith('/placed/pending_verification/755000/5000'), oo)
    shot(sh, '46-shopper-orders')

    # the same reference cannot be used twice
    dup = sh.evaluate("""async () => { try { await rpc('dq_place_online_order', { p: { slug: 'demo-shop', fulfilment: 'pickup', payment_method: 'M-Pesa', payment_reference: 'QK72HT91XZ', items: [{ product_id: '%s', qty: 1 }] } }); return 'accepted'; } catch (e) { return errMsg(e); } }""" % DELL)
    check('a payment reference can only be used once', dup != 'accepted', dup)

    # ================================================================== 4. business verifies, accepts and completes at the till
    goto(ow, 'online'); ow.wait_for_selector('.ooCard', timeout=10000)
    check('owner sees the new online order', 'Neema Said' in ow.inner_text('.ooGrid') and 'QK72HT91XZ' in ow.inner_text('.ooGrid'))
    check('menu shows a badge for new online orders', ow.is_visible('.nav button:has-text("Online orders") .badge'))
    shot(ow, '47-online-orders')
    ow.click('.ooCard button:has-text("Payment received")'); ow.wait_for_timeout(1000)
    ow.click('.ooCard button:has-text("Accept order")'); ow.wait_for_timeout(1200)
    check('payment verified and order accepted', sql("select status||'/'||payment_status||'/'||coalesce(payment_verified_by,'') from online_orders order by created_at desc limit 1").startswith('accepted/paid/'))
    check('shopper linked to the business customer record on accept', sql("select count(*) from customers c join customer_accounts a on a.id=c.account_id where a.phone like '%555%777%'") == '1')
    goto(ow, 'online', 'progress'); ow.wait_for_selector('.ooCard')
    ow.click('.ooCard button:has-text("Start preparing")'); ow.wait_for_timeout(1000)
    ow.click('.ooCard button:has-text("Out for delivery")'); ow.wait_for_timeout(1000)
    ow.click('.ooCard button:has-text("Complete at the till")'); ow.wait_for_selector('.onlineBanner', timeout=10000)
    check('till shows which labels to scan for the online order', 'Scan the label of' in ow.inner_text('.onlineBanner') and 'Dell 12' in ow.inner_text('.onlineBanner'))
    check('payment is blocked until every item is scanned', ow.is_disabled('#payBtn'))
    ow.focus('#scanInput'); scan_keys(ow, link)
    check('scanned label fills the online order', 'All items are in the cart' in ow.inner_text('.onlineBanner') and serial in cart_serials(ow), ow.inner_text('.onlineBanner'))
    check('delivery fee added to the till total', ow.evaluate('posTotals().total') == 755000, ow.evaluate('posTotals()'))
    shot(ow, '48-till-online-order')
    ow.click('#payBtn'); ow.wait_for_selector('#paySubmit')
    ow.click('#paySubmit'); ow.wait_for_timeout(1800)
    r = sql("select o.status||'/'||s.total::int||'/'||s.delivery_fee::int||'/'||o.points_earned from online_orders o join sales s on s.id=o.sale_id order by o.created_at desc limit 1")
    check('online order completed as a sale with the delivery fee', r.startswith('completed/755000/5000/'), r)
    check('label sold through the online order', sql(f"select status from product_items where serial='{serial}'") == 'sold')
    pts = sql("select points from customers c join customer_accounts a on a.id=c.account_id where a.phone like '%555%777%'")
    check('customer earned points (incl. first-order bonus)', int(pts or 0) > 50, pts)
    ow.keyboard.press('Escape'); ow.wait_for_timeout(300)

    # shopper sees completion + points
    sh.evaluate("viewParams.reload=1;renderView()"); sh.wait_for_timeout(1500)
    check('shopper sees the order completed with points earned', 'points earned' in sh.inner_text('#content'))
    sh.evaluate("chTab('points')"); sh.wait_for_timeout(500)
    check('shopper points card for the shop', 'DEMO' in sh.inner_text('#content') and sh.is_visible('.loyaltyCard'))
    shot(sh, '49-shopper-points')
    sh.context.close()

    # payments centre
    goto(ow, 'payments'); ow.wait_for_timeout(800)
    ptxt = ow.inner_text('#content')
    check('payments centre shows what to verify and money in', 'To verify' in ptxt and 'Money in (30 days)' in ptxt and 'Supplier payments' in ptxt, ptxt[:300])
    shot(ow, '50-payments-centre')

    # ================================================================== 5. supplier registers
    sp = new_page(browser)
    sp.goto(BASE); sp.wait_for_selector('#loginForm')
    sp.click('[data-mode=supplier]'); sp.wait_for_selector('#supRegForm')
    sp.fill('#sr1', 'Bakhresa Wholesale Ltd'); sp.fill('#sr2', 'Hamisi Ali'); sp.fill('#sr3', '0715 000 999')
    sp.fill('#re', 'sales@bakhresa-wholesale.test'); sp.fill('#rp', 'secret1'); sp.fill('#rp2', 'secret1')
    sp.fill('#sr4', 'Dar es Salaam'); sp.fill('#sr5', '123-456-789')
    sp.click('#supRegForm .groupCard >> nth=0')
    shot(sp, '51-supplier-register')
    sp.click('#supRegForm button.primary'); sp.wait_for_selector('.app .side', timeout=15000); sp.wait_for_timeout(800)
    check('supplier account created and lands in the supplier portal', sql("select count(*) from supplier_accounts where company_name='Bakhresa Wholesale Ltd'") == '1' and 'Supplier' in sp.inner_text('.side'))
    shot(sp, '52-supplier-portal')

    # ================================================================== 6. business finds the supplier and orders
    goto(ow, 'orders', 'suppliers'); ow.wait_for_timeout(500)
    ow.click('button:has-text("Find suppliers on DeepQr")'); ow.wait_for_selector('.supCard', timeout=10000)
    check('supplier directory lists the new supplier', 'Bakhresa Wholesale Ltd' in ow.inner_text('#sdList'))
    shot(ow, '53-supplier-directory')
    ow.click('.supCard:has-text("Bakhresa") button:has-text("Add supplier")'); ow.wait_for_timeout(1200)
    sup_id = sql("select id from suppliers where name='Bakhresa Wholesale Ltd' and supplier_account_id is not null")
    check('supplier linked to the business', len(sup_id) == 36, sup_id)
    ow.keyboard.press('Escape'); ow.wait_for_timeout(300)
    ow.evaluate(f"openOrderEditor(null, {{ supplier_id: '{sup_id}', items: [{{ product_id: '{DELL}', qty_ordered: 4, unit_cost: 600000 }}] }})")
    ow.wait_for_selector('#poForm'); ow.click('#poSave'); ow.wait_for_timeout(1500)
    po = sql(f"select order_no||'/'||supplier_status from orders where supplier_id='{sup_id}' order by created_at desc limit 1")
    check('purchase order sent to the supplier on DeepQr', po.endswith('/sent'), po)

    # ================================================================== 7. supplier confirms (with a price change) and dispatches
    sp.evaluate("loadSupplier().then(()=>go('sup_orders'))"); sp.wait_for_timeout(1200)
    check('supplier sees the new order', 'DEMO' in sp.inner_text('#content'))
    sp.click('tr.clickRow:has-text("DEMO")'); sp.wait_for_selector('.s_q')
    sp.fill('.s_q', '3'); sp.fill('.s_p', '610000'); sp.fill('#soN', 'Only 3 in stock this week')
    shot(sp, '54-supplier-answer')
    sp.click('#modal button:has-text("Confirm order")'); sp.wait_for_timeout(1500)
    check('supplier confirmed with changed quantity and price', sql(f"select o.supplier_status||'/'||i.supplier_qty::int||'/'||i.supplier_price::int from orders o join order_items i on i.order_id=o.id where o.supplier_id='{sup_id}' order by o.created_at desc limit 1") == 'confirmed/3/610000')
    sp.click('.pill:has-text("Confirmed")'); sp.wait_for_timeout(300)
    sp.click('tr.clickRow:has-text("DEMO")'); sp.wait_for_selector('#modal button:has-text("Mark dispatched")')
    sp.click('#modal button:has-text("Mark dispatched")'); sp.wait_for_selector('#sdF')
    sp.fill('#sdI', 'BW-2041'); sp.fill('#sdN', 'Driver Juma, T123 ABC')
    sp.click('#sdF button.primary'); sp.wait_for_timeout(1500)
    check('supplier dispatched with an invoice', sql(f"select supplier_status||'/'||invoice_no||'/'||invoice_amount::int from orders where supplier_id='{sup_id}' order by created_at desc limit 1") == 'dispatched/BW-2041/1830000')
    goto(ow, 'orders'); ow.wait_for_timeout(400)
    ow.evaluate(f"openOrder((cache.orders.find(o=>o.supplier_id==='{sup_id}')||{{}}).id)"); ow.wait_for_timeout(800)
    dtxt = ow.inner_text('body')
    check('business sees the supplier answer and changes on the order', 'Driver Juma' in dtxt and 'changed 1 line' in dtxt and 'Dispatched' in dtxt, dtxt[-600:])
    shot(ow, '55-po-supplier-answer')
    sp.context.close()

    # ================================================================== 8. smart suggestions
    goto(ow, 'insights'); ow.wait_for_selector('.kpi', timeout=15000); ow.wait_for_timeout(500)
    check('smart suggestions page analyses the business', 'Stock forecast' in ow.inner_text('#content') and 'Learning from' in ow.inner_text('#content'))
    if ow.locator('.sugCard').count():
        n0 = ow.locator('.sugCard').count()
        ow.click('.sugCard >> nth=0 >> button[title="Not useful"]'); ow.wait_for_timeout(1200)
        check('dismissed suggestion is learned and hidden', sql("select count(*) from insight_feedback") != '0' and ow.locator('.sugCard').count() == n0 - 1)
    shot(ow, '56-insights')
    goto(ow, 'dashboard'); ow.wait_for_timeout(1500)
    shot(ow, '57-dashboard-v4')
    ow.context.close()

    # ================================================================== 9. platform portal: vertical menu, team, suppliers, payments
    ad = new_page(browser)
    login(ad, 'mohdabdull129@gmail.com')
    ad.wait_for_selector('.nav button:has-text("Team & roles")', timeout=10000)
    check('portal tabs are in the left menu', all(ad.is_visible(f'.side .nav button:has-text("{t}")') for t in ['Overview', 'Businesses', 'Suppliers', 'Payment checks', 'Team & roles']))
    ad.click('.nav button:has-text("Suppliers")'); ad.wait_for_timeout(500)
    check('portal lists suppliers', 'Bakhresa Wholesale Ltd' in ad.inner_text('#content'))
    ad.click('tr:has-text("Bakhresa") button:has-text("Verify")'); ad.wait_for_timeout(1000)
    check('admin verifies a supplier', sql("select verified from supplier_accounts where company_name='Bakhresa Wholesale Ltd'") == 't')
    shot(ad, '58-portal-suppliers')
    ad.click('.nav button:has-text("Payment checks")'); ad.wait_for_timeout(500)
    check('portal payments explains verification', 'How DeepQr verifies money' in ad.inner_text('#content'))
    ad.click('.nav button:has-text("Shoppers & online")'); ad.wait_for_timeout(500)
    check('portal shows online orders across shops', 'Neema Said' in ad.inner_text('#content'))
    ad.click('.nav button:has-text("Team & roles")'); ad.wait_for_timeout(500)
    ad.click('button:has-text("Add team member")'); ad.wait_for_selector('#psF')
    ad.fill('#psN', 'Rehema Support'); ad.fill('#psE', 'rehema@deepqr.test'); ad.select_option('#psR', 'support')
    ad.click('#psF button.primary'); ad.wait_for_selector('.mono-big', timeout=10000)
    code = ad.inner_text('.mono-big').strip()
    check('team member invited with a one-time code', re.match(r'^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$', code) is not None
          and sql("select role from platform_admins where email='rehema@deepqr.test'") == 'support', code)
    shot(ad, '59-portal-team-invite')
    ad.context.close()

    # the assistant signs in with the code and only sees support tabs
    st = new_page(browser)
    st.goto(BASE); st.wait_for_selector('#loginForm')
    st.click('text=Open the platform portal'); st.wait_for_selector('#adminForm')
    st.fill('#ae', 'rehema@deepqr.test'); st.fill('#ap', 'secret1'); st.fill('#ac', code)
    st.click('#adminForm button.primary'); st.wait_for_selector('.app .side', timeout=15000); st.wait_for_timeout(800)
    nav = st.inner_text('.side')
    check('support assistant signs in with the code', 'Businesses' in nav, nav[:300])
    st.click('.nav button:has-text("Team & roles")'); st.wait_for_timeout(400)
    check('support assistant cannot manage the team or top-ups', 'Top-ups' not in nav and 'Ledger' not in nav and not st.is_visible('button:has-text("Add team member")'), nav[:300])
    denied = st.evaluate("""async () => { const { error } = await sb.rpc('dq_admin_invite_staff', { p_email: 'x@y.test', p_name: 'X', p_role: 'admin' }); return error ? errMsg(error) : 'allowed'; }""")
    check('support assistant blocked from staff actions on the server', denied != 'allowed', denied)
    shot(st, '60-portal-support-role')
    st.context.close()

    # ================================================================== 10. phone layout of the shop
    m = new_page(browser, 390, 844)
    m.goto(BASE + '?shop=demo-shop'); m.wait_for_selector('.prodCard', timeout=15000)
    check('shop fits a phone screen (no sideways scroll)', m.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    shot(m, '61-store-phone')
    m.context.close()

    check('no JavaScript errors', not errors, errors[:5])
    browser.close()

fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)}/{len(results)} passed')
sys.exit(1 if fails else 0)
