"""DeepQr v2 browser test-suite.

Drives the real app (index.html + js/*.js) in headless Chromium against a real
Postgres database with every migration applied, through tests/local_backend.py
(a small stand-in for Supabase's REST, Auth and Storage APIs). The real
supabase-js client is used, so RLS policies, triggers and RPCs are exercised.

    supabase/tests/local/run.sh                    # fresh local database
    python3 tests/local_backend.py --port 54321 &  # Supabase stand-in
    python3 tests/e2e_test.py <node_modules_dir> <screenshot_dir>

<node_modules_dir> must contain @supabase/supabase-js@2.45.4, jsbarcode@3.11.6,
html5-qrcode@2.3.8 and qrcode-generator@1.4.4. ffmpeg is used for the camera test.
"""
import http.server, socketserver, threading, sys, os, functools, subprocess, time, re
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'node_modules')
SHOTS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'tests', 'screens')
API = os.environ.get('DQ_API', 'http://127.0.0.1:54321')
PSQL = ['psql', '-h', '/tmp/pg', '-p', '5433', '-U', 'postgres', '-d', 'dqtest', '-Atq', '-c']
os.makedirs(SHOTS, exist_ok=True)

results = []
def check(name, ok, info=''):
    results.append((name, bool(ok), info))
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  -> {info}'), flush=True)
def sql(q):
    return subprocess.run(PSQL + [q], capture_output=True, text=True, check=True).stdout.strip()

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f'http://localhost:{port}/index.html'   # "localhost" is a secure context, so the camera works

CONFIG = f"window.DQ_CONFIG={{supabaseUrl:'{API}',supabaseKey:'anon-key',docsBucket:'dq-docs',version:'test'}};"
LIBMAP = {
    'supabase.js': os.path.join(LIBS, '@supabase/supabase-js/dist/umd/supabase.js'),
    'JsBarcode.all.min.js': os.path.join(LIBS, 'jsbarcode/dist/JsBarcode.all.min.js'),
    'html5-qrcode.min.js': os.path.join(LIBS, 'html5-qrcode/html5-qrcode.min.js'),
    'qrcode.js': os.path.join(LIBS, 'qrcode-generator/qrcode.js'),
}
def route(r):
    url = r.request.url
    if '/js/config.js' in url:
        return r.fulfill(body=CONFIG, content_type='application/javascript')
    if url.startswith(f'http://localhost:{port}') or url.startswith(API):
        return r.continue_()
    for k, path in LIBMAP.items():
        if url.split('?')[0].endswith(k):
            return r.fulfill(path=path, content_type='application/javascript')
    if 'fonts.g' in url:
        return r.fulfill(body='', content_type='text/css')
    return r.abort()

errors = []
def new_page(browser, w=1360, h=900):
    ctx = browser.new_context(viewport={'width': w, 'height': h})
    ctx.route('**/*', route)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('dialog', lambda d: d.accept())
    return pg

def login(pg, user, pw='secret1'):
    pg.goto(BASE)
    pg.wait_for_selector('#loginForm')
    pg.fill('#lu', user); pg.fill('#lp', pw); pg.click('#loginForm button.primary')
    pg.wait_for_selector('.app .side', timeout=15000)
    pg.wait_for_timeout(400)

def goto(pg, view, tab=None):
    pg.evaluate(f"go('{view}'{', {tab:' + repr(tab) + '}' if tab else ''})")
    pg.wait_for_timeout(500)

def toast_text(pg):
    return pg.inner_text('#toast') if pg.is_visible('#toast') else ''

def shot(pg, name):
    pg.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=False)

def scan_keys(pg, text, delay=8):
    """type like a keyboard-wedge scanner: fast keystrokes then Enter"""
    pg.keyboard.type(text, delay=delay)
    pg.keyboard.press('Enter')
    pg.wait_for_timeout(900)

def cart_serials(pg):
    return pg.eval_on_selector_all('#cartCard .serialChip', 'els => els.map(e => e.textContent.replace("×","").trim())')

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox'])

    # ------------------------------------------------------------------ admin setup data
    sql("insert into platform_admins(email, auth_user_id) values ('mohdabdull129@gmail.com','00000000-0000-4000-8000-0000000000c1') on conflict (email) do update set auth_user_id = excluded.auth_user_id")

    # ================================================================== 1. owner: dashboard + wallet top-up
    pg = new_page(browser)
    login(pg, 'owner@demo.test')
    check('owner lands on dashboard', 'Needs attention' in pg.inner_text('#content'), pg.inner_text('#content')[:200])
    shot(pg, '01-dashboard')

    goto(pg, 'wallet')
    pg.click('.pkg:has-text("Business")')
    pg.fill('#tuRef', 'QK72HT91XZ'); pg.fill('#tuPh', '0712 345 678'); pg.fill('#tuNm', 'Muham Abdull')
    shot(pg, '02-wallet-topup')
    pg.click('#tuForm button.primary'); pg.wait_for_timeout(1200)
    check('top-up request submitted', sql("select amount||'/'||bonus||'/'||status from topup_requests where reference='QK72HT91XZ'") == '20000/2000/pending')
    check('requests tab shows waiting request', 'Waiting' in pg.inner_text('#content'))
    # duplicate reference refused
    goto(pg, 'wallet', 'topup'); pg.fill('#tuAmt', '5000'); pg.fill('#tuRef', 'qk72ht91xz'); pg.fill('#tuPh', '0712345678')
    pg.click('#tuForm button.primary'); pg.wait_for_timeout(800)
    check('duplicate top-up reference refused', 'already submitted' in pg.inner_text('#tuErr'), pg.inner_text('#tuErr'))
    pg.context.close()

    # ================================================================== 2. platform owner portal
    ad = new_page(browser)
    login(ad, 'mohdabdull129@gmail.com')
    ad.wait_for_selector('#portalTabs', timeout=10000)
    check('admin opens owner portal', 'Owner portal' in ad.inner_text('#content'))
    shot(ad, '03-portal-overview')
    ad.evaluate("pTab('topups')"); ad.wait_for_timeout(300)
    shot(ad, '04-portal-topups')
    ad.click('tr:has-text("QK72HT91XZ") button:has-text("Approve")'); ad.wait_for_selector('#cfOk'); ad.click('#cfOk'); ad.wait_for_timeout(1200)
    check('admin approved top-up (main + package bonus)', sql("select balance||'/'||bonus_balance from dq_accounts where business_id='00000000-0000-4000-8000-00000000b001'") in ('20000/2000', '20000.00/2000.00'), sql("select balance||'/'||bonus_balance from dq_accounts where business_id='00000000-0000-4000-8000-00000000b001'"))
    check('top-up receipt number issued', sql("select receipt_no from topup_requests where reference='QK72HT91XZ'").startswith('TU-'))
    # promo code
    ad.evaluate("pTab('credits')"); ad.wait_for_timeout(300)
    ad.evaluate("pPromo()"); ad.fill('#prC', 'KARIBU5'); ad.fill('#prA', '5000'); ad.fill('#prM', '10'); ad.click('#prF button.primary'); ad.wait_for_timeout(800)
    check('admin created promo code', sql("select credits::int from promo_codes where code='KARIBU5'") == '5000')
    # programme + payment accounts
    ad.fill('#ppF', '10'); ad.click('#pProg button.primary'); ad.wait_for_timeout(700)
    check('free monthly QR quota saved', sql('select free_qr_monthly from platform_settings') == '10')
    ad.evaluate("pTab('settings')"); ad.wait_for_timeout(300)
    ad.click('button:has-text("Add account")'); ad.wait_for_timeout(200)
    ad.fill('#pSet tbody tr:first-child td:nth-child(2) input', '5544332'); ad.fill('#pSet tbody tr:first-child td:nth-child(3) input', 'DEEPQR LTD')
    ad.click('#pSet button.primary.lg'); ad.wait_for_timeout(800)
    check('payment account saved', '5544332' in sql('select payment_accounts::text from platform_settings'))
    # business drawer: bonus + plan
    ad.evaluate("pTab('businesses')"); ad.wait_for_timeout(300)
    ad.click('tr:has-text("DEMO")'); ad.wait_for_selector('#pBon', timeout=8000)
    shot(ad, '05-portal-business')
    ad.fill('#pBonA', '1000'); ad.click('#pBon button'); ad.wait_for_timeout(1200)
    check('admin granted bonus to one business', sql("select bonus_balance::int from dq_accounts where business_id='00000000-0000-4000-8000-00000000b001'") == '3000')
    ad.wait_for_selector('#paFee'); ad.fill('#paFee', '20'); ad.click('#pAcc button.primary'); ad.wait_for_timeout(1000)
    check('custom QR price for business saved', sql("select fee_override::int from dq_accounts where business_id='00000000-0000-4000-8000-00000000b001'") == '20')
    check('portal actions are audited', int(sql("select count(*) from platform_audit")) >= 4)
    # block + unblock a user
    ad.wait_for_selector('tr:has-text("demo1") button:has-text("Block")')
    ad.click('tr:has-text("demo1") button:has-text("Block")'); ad.fill('#askV', 'Testing block'); ad.click('#askF button.primary'); ad.wait_for_timeout(1200)
    check('admin blocked a user', sql("select blocked_by_platform from members where username='demo1'") == 't')
    blocked = new_page(browser)
    blocked.goto(BASE); blocked.fill('#lu', 'demo1'); blocked.fill('#lp', 'secret1'); blocked.click('#loginForm button.primary'); blocked.wait_for_timeout(2500)
    check('blocked user sees the block screen', 'blocked by DeepQr' in blocked.inner_text('#root'), blocked.inner_text('#root')[:200])
    blocked.context.close()
    ad.wait_for_selector('tr:has-text("demo1") button:has-text("Unblock")'); ad.click('tr:has-text("demo1") button:has-text("Unblock")'); ad.wait_for_timeout(1000)
    check('admin unblocked the user', sql("select blocked_by_platform from members where username='demo1'") == 'f')
    ad.context.close()

    # ================================================================== 3. owner: promo, QR generation
    pg = new_page(browser)
    login(pg, 'owner@demo.test')
    goto(pg, 'wallet', 'rewards'); pg.fill('#promoC', 'karibu5'); pg.click('#promoF button'); pg.wait_for_timeout(1000)
    check('promo code redeemed as bonus', sql("select bonus_balance::int from dq_accounts where business_id='00000000-0000-4000-8000-00000000b001'") == '8000')
    pg.fill('#promoC', 'KARIBU5'); pg.click('#promoF button'); pg.wait_for_timeout(800)
    check('promo code cannot be used twice', 'already used' in toast_text(pg), toast_text(pg))
    goto(pg, 'wallet'); shot(pg, '06-wallet')

    goto(pg, 'qr')
    pg.evaluate("openGenerate('00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000502',14)")
    pg.wait_for_selector('#genForm'); pg.wait_for_timeout(300)
    pg.click('#genForm button.primary'); pg.wait_for_timeout(1800)
    n_items = int(sql("select count(*) from product_items where status='in_stock' and product_id='00000000-0000-4000-8000-000000000701'"))
    check('14 Dell labels generated', n_items == 14, n_items)
    g = sql("select free_qty||'/'||bonus_used::int||'/'||paid_amount::int from qr_generations order by created_at desc limit 1")
    check('QR charge used free quota first, then bonus (10 free + 4x20 from bonus)', g == '10/80/0', g)
    pg.keyboard.press('Escape')
    serials = sql("select serial from product_items where product_id='00000000-0000-4000-8000-000000000701' order by serial").split('\n')
    payload = sql(f"select qr_payload from product_items where serial='{serials[0]}'")
    check('QR payload carries business + shop + product + serial', re.match(r'^DQ1\|DEM\|S02\|D12\|\d{9,}$', payload) is not None, payload)
    pg.context.close()

    # ================================================================== 4. cashier: scan & sell
    pg = new_page(browser, 1280, 860)
    login(pg, 'demo1')
    check('cashier lands on Scan & Sell', pg.is_visible('#scanInput'))
    # a) scanner with Enter suffix, scan box focused
    pg.focus('#scanInput'); scan_keys(pg, payload)
    check('USB scan (Enter suffix) adds item', serials[0] in cart_serials(pg), cart_serials(pg))
    # b) scanner whose keyboard layout mangles "|" (e.g. "~"), and no field focused
    p2 = sql(f"select qr_payload from product_items where serial='{serials[1]}'").replace('|', '~')
    pg.click('.posTop'); pg.wait_for_timeout(100)
    pg.evaluate("document.activeElement && document.activeElement.blur()")
    scan_keys(pg, p2)
    check('scan with mangled separators, no field focused, adds item', serials[1] in cart_serials(pg), cart_serials(pg))
    # c) scanner without Enter suffix (auto-submit on pause)
    pg.focus('#scanInput'); pg.keyboard.type(serials[2], delay=8); pg.wait_for_timeout(900)
    check('scanner without Enter suffix (auto-submit) adds item', serials[2] in cart_serials(pg), cart_serials(pg))
    # d) same label again is refused
    pg.focus('#scanInput'); scan_keys(pg, payload)
    check('same label twice is refused', 'Already in the cart' in pg.inner_text('#lastScan'), pg.inner_text('#lastScan'))
    # e) product barcode
    pg.focus('#scanInput'); scan_keys(pg, 'B-MLK')
    check('product barcode adds a non-labelled product', 'Milk 1L' in pg.inner_text('#cartCard'))
    # f) other business label
    pg.focus('#scanInput'); scan_keys(pg, 'DQ1|MZS|S01|X|202699001')
    check('label from another business refused', 'another business' in pg.inner_text('#lastScan'), pg.inner_text('#lastScan'))
    shot(pg, '07-pos-cart')
    # hold + resume
    pg.click('#cartCard button:has-text("Hold")'); pg.wait_for_timeout(300)
    if pg.is_visible('#askV'): pg.fill('#askV', 'Table 4'); pg.click('#askF button.primary')
    pg.wait_for_timeout(900)
    check('sale parked (hold)', sql('select count(*) from held_carts') == '1' and 'Cart is empty' in pg.inner_text('#cartCard'))
    pg.evaluate('openHeld()'); pg.wait_for_timeout(400); pg.click('#modal button:has-text("Resume")'); pg.wait_for_timeout(900)
    check('held sale resumed', len(cart_serials(pg)) == 3, cart_serials(pg))
    # split payment: cash + M-Pesa
    total = pg.evaluate('posTotals().total')
    pg.click('#payBtn'); pg.wait_for_selector('#paySubmit')
    pg.fill('#pa0', str(int(total - 1000000)))
    pg.click('.payGrid button:has-text("M-Pesa")'); pg.wait_for_timeout(200)
    pg.fill('#pr1', 'MP77AA')
    shot(pg, '08-pos-split-payment')
    pg.click('#paySubmit'); pg.wait_for_timeout(1500)
    check('split-payment sale completed', sql("select count(*) from sale_payments where kind='sale'") == '2', sql('select method, amount from sale_payments'))
    check('labels marked sold', sql(f"select string_agg(status, ',' order by serial) from product_items where serial in ('{serials[0]}','{serials[1]}','{serials[2]}')") == 'sold,sold,sold')
    check('receipt shown', pg.is_visible('.receipt'))
    shot(pg, '09-receipt')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    # sold label scanned again
    pg.focus('#scanInput'); scan_keys(pg, payload)
    check('sold label refused at the till', 'already sold' in pg.inner_text('#lastScan'), pg.inner_text('#lastScan'))
    # credit sale to a new customer
    pg.focus('#scanInput'); scan_keys(pg, serials[3])
    pg.click('.custChip'); pg.wait_for_selector('#custNew'); pg.fill('#cnN', 'Asha Juma'); pg.fill('#cnP', '0755 111 222'); pg.click('#custNew button'); pg.wait_for_timeout(800)
    pg.click('#payBtn'); pg.wait_for_selector('#paySubmit'); pg.fill('#pa0', '250000'); pg.wait_for_timeout(200)
    check('credit warning shown', 'goes on Asha Juma' in pg.inner_text('#payNote'), pg.inner_text('#payNote'))
    pg.click('#paySubmit'); pg.wait_for_timeout(1500)
    check('credit sale recorded as customer debt', sql("select balance::int from customers where name='Asha Juma'") == '500000', sql("select balance from customers"))
    pg.keyboard.press('Escape')
    # debt payment
    pg.evaluate("openCustomerPayment()"); pg.wait_for_timeout(500)
    shot(pg, '10-debt-payment')
    pg.context.close()

    # ================================================================== 5. owner: orders with invoice upload and partial receipt
    pg = new_page(browser)
    login(pg, 'owner@demo.test')
    goto(pg, 'orders')
    pg.evaluate("editSupplier()"); pg.fill('#spN', 'Kariakoo Electronics'); pg.fill('#spP', '0713000111'); pg.fill('#spD', '14'); pg.click('#supForm button.primary'); pg.wait_for_timeout(800)
    check('supplier created', sql("select payment_terms_days from suppliers where name='Kariakoo Electronics'") == '14')
    pg.evaluate("openOrderEditor()"); pg.wait_for_selector('#poForm')
    pg.select_option('#poSup', label='Kariakoo Electronics')
    pg.fill('#pol_p_0', 'HP12'); pg.dispatch_event('#pol_p_0', 'change'); pg.wait_for_timeout(300)
    pg.fill('#pol_q_0', '10'); pg.fill('#pol_c_0', '480000')
    pg.click('button:has-text("Add product")'); pg.wait_for_timeout(200)
    pg.fill('#pol_p_1', 'MLK'); pg.dispatch_event('#pol_p_1', 'change'); pg.wait_for_timeout(300)
    pg.fill('#pol_q_1', '100'); pg.fill('#pol_c_1', '1700')
    pg.fill('#poExp', '2026-10-01'); pg.fill('#poDate', '2026-10-05')
    pg.click('#poSave'); pg.wait_for_timeout(500)
    check('expected date before order date refused', 'before the order date' in pg.inner_text('#poErr'), pg.inner_text('#poErr'))
    pg.fill('#poExp', '2026-10-20'); pg.fill('#poInv', 'INV-2041')
    pg.set_input_files('#poFiles', files=[{'name': 'proforma.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 test proforma'}]); pg.wait_for_timeout(400)
    check('attachment listed before upload', 'proforma.pdf' in pg.inner_text('#poDocList'))
    shot(pg, '11-po-editor')
    pg.click('#poSave'); pg.wait_for_timeout(2000)
    check('PO saved with number and total', sql("select order_no||'/'||total_cost::int||'/'||status from orders where invoice_no='INV-2041'").endswith('/4970000/ordered'), sql("select order_no, total_cost, status from orders"))
    check('invoice uploaded to private storage', sql("select count(*) from storage.objects where bucket_id='dq-docs' and name like '00000000-0000-4000-8000-00000000b001/orders/%'") == '1')
    check('PO detail drawer opened', pg.is_visible('.drawer') and 'not received' in pg.inner_text('.drawer').lower())
    shot(pg, '12-po-detail')
    oid = sql("select id from orders where invoice_no='INV-2041'")
    pg.evaluate(f"openReceive('{oid}')"); pg.wait_for_selector('#grnForm')
    rows = pg.query_selector_all('#grnForm tr[data-id]')
    rows[0].query_selector('.g_q').fill('6'); rows[0].query_selector('.g_d').fill('1')
    rows[1].query_selector('.g_q').fill('100'); rows[1].query_selector('.g_e').fill('2027-01-31')
    pg.uncheck('#grnQr'); pg.fill('#grnDn', 'DN-778')
    pg.set_input_files('#grnUp', files=[{'name': 'delivery.jpg', 'mimeType': 'image/jpeg', 'buffer': b'\xff\xd8\xff test'}]); pg.wait_for_timeout(300)
    pg.evaluate('grnCheck()')
    shot(pg, '13-receive-goods')
    pg.click('#grnForm button.primary.lg'); pg.wait_for_timeout(2000)
    st = sql(f"select status||'/'||received_value::int from orders where id='{oid}'")
    check('partial delivery: status partial, value of good items only', st == 'partial/3050000', st)
    check('received / damaged / outstanding tracked per line', sql(f"select string_agg(qty_received::int||'-'||qty_damaged::int||'-'||(qty_ordered-qty_received-qty_damaged)::int, ',' order by product_name) from order_items where order_id='{oid}'") == '6-1-3,100-0-0')
    check('stock increased by good items only', sql("select qty::int from stock_levels where product_id='00000000-0000-4000-8000-000000000702' and shop_id='00000000-0000-4000-8000-000000000501'") == '6')
    check('supplier balance = value received', sql("select balance::int from suppliers where name='Kariakoo Electronics'") == '3050000')
    check('GRN with delivery-note photo', sql(f"select grn_no||'/'||jsonb_array_length(attachments) from order_receipts where order_id='{oid}'") == 'GRN-00001/1')
    # pay supplier partly
    pg.evaluate(f"openSupplierPayment((cache.suppliers.find(s=>s.name==='Kariakoo Electronics')).id, '{oid}')"); pg.wait_for_selector('#spayF')
    pg.fill('#spAmt', '1000000'); pg.fill('#spR', 'BANK-001'); pg.click('#spayF button.success'); pg.wait_for_timeout(1500)
    check('supplier payment recorded against PO', sql(f"select paid_amount::int||'/'||payment_status from orders where id='{oid}'") == '1000000/partial')
    check('signed URL opens uploaded document', pg.evaluate("(async()=>{const o=cache.orders.find(x=>x.invoice_no==='INV-2041');const {data}=await sb.storage.from('dq-docs').createSignedUrl(o.attachments[0].path,60);const r=await fetch(data.signedUrl);return (await r.text()).includes('proforma')})()"))
    # close the rest as short-shipped
    pg.evaluate(f"closeOrder('{oid}')"); pg.wait_for_selector('#askF'); pg.click('#askF button.primary'); pg.wait_for_timeout(1200)
    check('order closed with outstanding short delivery', sql(f"select status from orders where id='{oid}'") == 'closed')
    goto(pg, 'orders'); pg.evaluate("ordF.status='all';renderView()"); pg.wait_for_timeout(300)
    shot(pg, '14-orders-list')

    # ================================================================== 6. reports, inventory, devices, staff
    goto(pg, 'reports'); pg.wait_for_selector('.svgChart', timeout=10000)
    check('reports overview shows net sales', '1,000,000' in pg.inner_text('#content') or '1.000.000' in pg.inner_text('#content') or 'Net sales' in pg.inner_text('#content'))
    shot(pg, '15-reports')
    for t in ['pl', 'products', 'people', 'payments', 'debts', 'stock', 'shifts']:
        pg.evaluate(f"repTab('{t}')"); pg.wait_for_timeout(250)
    check('all report tabs render without errors', not errors, errors[-3:])
    pg.evaluate("repTab('debts')"); pg.wait_for_timeout(250)
    check('debtors aging lists the credit customer', 'Asha Juma' in pg.inner_text('#content'))
    shot(pg, '16-report-debtors')
    pg.evaluate("repTab('pl')"); pg.wait_for_timeout(250); shot(pg, '17-report-pl')

    goto(pg, 'inventory', 'reorder'); shot(pg, '18-inventory-reorder')
    goto(pg, 'devices', 'test'); pg.wait_for_selector('#testInput')
    pg.focus('#testInput'); scan_keys(pg, serials[5])
    check('scanner test page reads a label', 'Scanner works' in pg.inner_text('#testResult'), pg.inner_text('#testResult'))
    shot(pg, '19-device-test')
    goto(pg, 'devices', 'setup'); shot(pg, '20-device-setup')
    goto(pg, 'devices'); pg.click('#devRegF button'); pg.wait_for_timeout(1000)
    check('owner device registered + auto-approved', sql("select status from devices limit 1") == 'approved')

    goto(pg, 'users'); pg.evaluate('addStaff()'); pg.wait_for_selector('#staffF')
    pg.fill('#stN', 'Amina Said'); pg.fill('#stU', 'amina'); pg.fill('#stP', 'pass1234'); pg.select_option('#stR', 'cashier'); pg.select_option('#stS', label='MZ1')
    pg.check('#pm_can_refund'); pg.fill('#pm_disc', '5')
    pg.click('#staffF button.primary'); pg.wait_for_timeout(2000)
    check('staff account created with permissions', sql("select role||'/'||(permissions->>'can_refund')||'/'||(permissions->>'max_discount_pct') from members where username='amina'") == 'cashier/true/5')
    shot(pg, '21-staff-created')
    goto(pg, 'settings'); shot(pg, '22-settings')
    pg.check('#bLo'); pg.click('#setF button.primary.lg'); pg.wait_for_timeout(900)
    check('loyalty switched on in settings', sql("select loyalty_enabled from businesses where code='DEM'") == 't')
    goto(pg, 'dashboard'); shot(pg, '23-dashboard-after')
    pg.context.close()

    st = new_page(browser, 390, 844)
    login(st, 'amina', 'pass1234')
    check('new staff can sign in with username', st.is_visible('#scanInput'))
    shot(st, '24-mobile-pos')
    st.context.close()

    # ================================================================== 7. phone camera scanning (fake camera showing a label)
    qr_png = os.path.join(SHOTS, '_qr.png'); y4m = os.path.join(SHOTS, '_qr.y4m')
    q = new_page(browser, 480, 480)
    q.goto(BASE); q.wait_for_function('window.qrcode')
    cam_payload = sql(f"select qr_payload from product_items where serial='{serials[6]}'")
    q.evaluate(f"document.body.innerHTML='<div id=q style=\"background:#fff;padding:30px;width:420px\">'+qrSvg('{cam_payload}',8)+'</div>'")
    q.locator('#q').screenshot(path=qr_png); q.context.close()
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-i', qr_png, '-vf', 'scale=300:300,pad=640:480:170:90:white,format=yuv420p', '-t', '2', '-r', '10', y4m], check=True)
    cb = p.chromium.launch(args=['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={y4m}'])
    cpg = new_page(cb, 1100, 800)
    login(cpg, 'demo1')
    cpg.click('button:has-text("Scan with camera")')
    try:
        cpg.wait_for_function(f"posState.cart.some(l => (l.items||[]).some(i => i.serial === '{serials[6]}'))", timeout=20000)
        ok = True
    except Exception as e:
        ok = False
    check('phone camera reads the QR label into the cart', ok, cpg.inner_text('#camResult') if cpg.is_visible('#camResult') else '')
    shot(cpg, '25-camera-scan')
    cpg.click('#modal button:has-text("Done")'); cpg.wait_for_timeout(300)
    check('camera stopped when the window closes', cpg.evaluate("!document.querySelector('#reader')"))
    cpg.context.close(); cb.close()

    check('no JavaScript errors', not errors, errors[:5])
    browser.close()

fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)}/{len(results)} passed')
sys.exit(1 if fails else 0)
