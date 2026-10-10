"""DeepQr browser test-suite.

Drives the real index.html in headless Chromium against tests/mock-supabase.js
(an in-memory copy of the database + DeepQr functions), so nothing touches the
live Supabase project.

    pip install playwright && python -m playwright install chromium
    npm i jsbarcode@3.11.6 html5-qrcode@2.3.8 qrcode-generator@1.4.4 jsqr   (in LIBS dir)
    python tests/e2e_test.py <libs_node_modules_dir> <screenshot_dir>
"""
import http.server, socketserver, threading, sys, os, re, functools, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'node_modules')
SHOTS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'tests', 'screens')
os.makedirs(SHOTS, exist_ok=True)

results = []
def check(name, ok, info=''):
    results.append((name, bool(ok), info))
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  -> {info}'))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{port}/index.html'

LIBMAP = {
    'supabase.js': os.path.join(ROOT, 'tests', 'mock-supabase.js'),
    'JsBarcode.all.min.js': os.path.join(LIBS, 'jsbarcode/dist/JsBarcode.all.min.js'),
    'html5-qrcode.min.js': os.path.join(LIBS, 'html5-qrcode/html5-qrcode.min.js'),
    'qrcode.js': os.path.join(LIBS, 'qrcode-generator/qrcode.js'),
}

def route(r):
    url = r.request.url
    if url.startswith(f'http://127.0.0.1:{port}'):
        return r.continue_()
    for k, path in LIBMAP.items():
        if url.split('?')[0].endswith(k):
            return r.fulfill(path=path, content_type='application/javascript')
    if 'fonts.g' in url:
        return r.fulfill(body='', content_type='text/css')
    return r.abort()

DECODE_JS = """async (sel) => {
  const svg = document.querySelector(sel); if (!svg) return null;
  const xml = new XMLSerializer().serializeToString(svg);
  const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
  await img.decode();
  const c = document.createElement('canvas'); c.width = 400; c.height = 400;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 400); g.drawImage(img, 0, 0, 400, 400);
  const d = g.getImageData(0, 0, 400, 400); const r = jsQR(d.data, 400, 400); return r ? r.data : null;
}"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1440, 'height': 960})
    ctx.route('**/*', route)
    page = ctx.new_page(); page.set_default_timeout(8000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('dialog', lambda d: d.accept(d.default_value or ''))
    toast = lambda: page.locator('#toast').inner_text()
    db = lambda expr: page.evaluate(f'() => JSON.parse(JSON.stringify({expr}))')

    # ---------------- login screen
    page.goto(BASE); page.wait_for_selector('#loginForm')
    check('login screen shows DeepQr branding', 'DeepQr' in page.title() and page.locator('.authHero .word').count() == 1)
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/01-login.png')

    # ---------------- owner login + dashboard
    page.fill('#lu', 'owner@zanrizon.test'); page.fill('#lp', 'secret1'); page.click('#loginForm button')
    page.wait_for_selector('.side')
    check('owner lands on dashboard', page.locator('.pageHead h1').inner_text() == 'Dashboard')
    check('sidebar shows business ID', 'ID ZT' in page.locator('.sideBiz').inner_text())
    check('dashboard recommends QR codes for untagged stock', 'have no QR code yet' in page.inner_text('#content'))
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/02-dashboard.png', full_page=True)

    # ---------------- every page renders without errors
    for v in ['pos','sales','products','qr','expiry','inventory','transfers','purchases','orders','stores','expenses','reports','users','devices','wallet','settings']:
        page.evaluate(f"go('{v}')")
        page.wait_for_timeout(80)
        check(f'page "{v}" renders', page.locator('.pageHead h1').count() == 1 and not errors, errors[-1:] if errors else '')

    # ---------------- QR recommendations + generation billing
    page.evaluate("go('qr')"); page.wait_for_selector('#qrSum')
    rec = page.locator('tbody tr', has_text='Dell 12').filter(has_text='Darajani').first
    check('recommendation for Dell 12 @ Darajani = 5', '5' in rec.locator('td').nth(4).inner_text(), rec.inner_text())
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/03-qr-recommendations.png', full_page=True)
    page.evaluate("openGenerate('p0000000-0000-4000-8000-000000000001','s0000000-0000-4000-8000-000000000001')")
    page.wait_for_selector('#genForm')
    check('generate dialog pre-fills recommended quantity', page.input_value('#gq') == '5')
    check('generate dialog shows cost 125 TZS', '125 TZS' in page.inner_text('#genInfo'))
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/04-generate-dialog.png')
    page.click('#genBtn'); page.wait_for_selector('.labelSheet .qrLabel')
    serials = page.locator('.qrLabel .lbSerial').all_inner_texts()
    yr = str(__import__('datetime').date.today().year)
    check('5 labels with serials YYYY+12+001..005', serials == [f'{yr}12{n:03d}' for n in range(1, 6)], serials)
    page.add_script_tag(path=os.path.join(LIBS, 'jsqr/dist/jsQR.js'))
    decoded = page.evaluate(DECODE_JS, '.qrLabel svg')
    check('printed QR decodes to business|shop|product|serial', decoded == f'DQ1|ZT|S01|D12|{yr}12001', decoded)
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/05-qr-labels.png')
    page.evaluate('closeModal()')
    check('wallet charged 125 (2000 -> 1875)', db('__db.dq_accounts[0].balance') == 1875)
    check('wallet statement records the charge', db('__db.wallet_transactions.length') == 1)

    # expiring batch for milk: one already expired, two expiring in 3 days
    page.evaluate("sb.rpc('dq_generate_items',{p_product_id:'p0000000-0000-4000-8000-000000000002',p_shop_id:'s0000000-0000-4000-8000-000000000001',p_qty:1,p_expiry:(()=>{const d=new Date();d.setDate(d.getDate()-2);return dateOnly(d)})()})")
    page.evaluate("sb.rpc('dq_generate_items',{p_product_id:'p0000000-0000-4000-8000-000000000002',p_shop_id:'s0000000-0000-4000-8000-000000000001',p_qty:2,p_expiry:addDays(3)})")
    page.evaluate('loadDeepQr().then(()=>go("expiry"))'); page.wait_for_timeout(200)
    txt = page.inner_text('#content')
    check('expiry tracker shows expired item', 'Expired 2d ago' in txt, txt[:300])
    page.evaluate("expiryFilter='all';renderView()")
    check('expiry tracker shows soon-to-expire items', '3 day(s) left' in page.inner_text('#content'))
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/06-expiry.png', full_page=True)

    # generation refused when balance is too low
    page.evaluate("__db.dq_accounts[0].balance=10")
    r = page.evaluate("sb.rpc('dq_generate_items',{p_product_id:'p0000000-0000-4000-8000-000000000003',p_shop_id:'s0000000-0000-4000-8000-000000000001',p_qty:5}).then(r=>r.error&&r.error.message)")
    check('generation blocked when wallet balance is too low', r and 'INSUFFICIENT_BALANCE' in r, r)
    page.evaluate("__db.dq_accounts[0].balance=1875; loadDeepQr()")

    # ---------------- scan -> cart -> receipt
    page.evaluate("go('pos')"); page.wait_for_selector('#scanInput')
    milk = db("__db.product_items.filter(i=>i.product_id==='p0000000-0000-4000-8000-000000000002').map(i=>i.qr_payload)")
    def scan(code):
        page.fill('#scanInput', code); page.press('#scanInput', 'Enter'); page.wait_for_timeout(120)
    scan(f'DQ1|ZT|S01|D12|{yr}12001'); scan(f'DQ1|ZT|S01|D12|{yr}12002')
    check('two Dell items scanned into cart', page.locator('.serialChip').count() == 2)
    scan(f'DQ1|ZT|S01|D12|{yr}12002')
    check('duplicate scan rejected', 'Already in the cart' in page.inner_text('#lastScan'))
    scan(milk[0])
    check('expired item refused at scan', 'EXPIRED' in page.inner_text('#lastScan'), page.inner_text('#lastScan'))
    scan(milk[1])
    check('valid milk item added (warns expiring soon)', 'expires in 3 day' in page.inner_text('#lastScan'), page.inner_text('#lastScan'))
    scan('DQ1|OTHER|S01|X|202612001')
    check("another business's QR rejected", 'another business' in page.inner_text('#lastScan'))
    scan(f'{yr}12003')
    check('typing a bare serial works', page.locator('.serialChip').count() == 4)
    page.click('.prodBtn:has-text("Bar Soap")'); page.click('.prodBtn:has-text("Bar Soap")')
    check('untagged product added by quantity', page.locator('.cartLine', has_text='Bar Soap').locator('input').input_value() == '2')
    total_txt = page.locator('.totals .grand').inner_text()
    check('cart total = 3x1,200,000 + 2,500 + 2x800', '3,604,100' in total_txt, total_txt)
    page.fill('#cName', 'Asha Mohamed'); page.fill('#cPaid', '3700000'); page.wait_for_timeout(50)
    check('change due calculated', '95,900' in page.inner_text('#cChange'), page.inner_text('#cChange'))
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/07-pos-cart.png', full_page=True)
    page.click('#cartCard .btn.lg.wide'); page.wait_for_selector('.receipt')
    rtxt = page.inner_text('.receipt')
    check('receipt lists scanned serials', f'{yr}12001' in rtxt and f'{yr}12003' in rtxt, rtxt[:400])
    check('receipt shows total and change', '3,604,100' in rtxt and '95,900' in rtxt)
    check('receipt number uses business code', re.search(r'ZT-\d{6}-0001', rtxt) is not None)
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/08-receipt.png')
    page.evaluate('closeModal()')
    check('scanned items marked sold in database', db(f"__db.product_items.filter(i=>i.status==='sold').length") == 4)
    check('stock reduced (Dell 5->2, soap 30->28)', db("__db.stock_levels[0].qty") == 2 and db("__db.stock_levels[2].qty") == 28)
    page.evaluate("sessionStorage.clear()"); page.goto(BASE); page.wait_for_selector("#loginForm")  # mock DB resets on reload

    # ---------------- second session: refunds, device lock, wallet, cashier, portal
    page.fill('#lu', 'owner@zanrizon.test'); page.fill('#lp', 'secret1'); page.click('#loginForm button'); page.wait_for_selector('.side')
    page.evaluate("sb.rpc('dq_generate_items',{p_product_id:'p0000000-0000-4000-8000-000000000001',p_shop_id:'s0000000-0000-4000-8000-000000000001',p_qty:2}).then(()=>loadDeepQr()).then(()=>go('pos'))")
    page.wait_for_selector('#scanInput'); page.wait_for_timeout(150)
    scan(f'DQ1|ZT|S01|D12|{yr}12001'); page.click('#cartCard .btn.lg.wide'); page.wait_for_selector('.receipt'); page.evaluate('closeModal()')
    sold_again = page.evaluate(f"sb.rpc('dq_checkout',{{p_shop_id:'s0000000-0000-4000-8000-000000000001',p_lines:[{{item_id:__db.product_items[0].id}}]}}).then(r=>r.error&&r.error.message)")
    check('server refuses to sell the same QR twice', sold_again and 'ALREADY_SOLD' in sold_again, sold_again)
    page.evaluate("go('sales')"); page.click('td button:has-text("Refund")'); page.wait_for_timeout(250)
    check('refund marks sale refunded', page.locator('td .tag.bad', has_text='refunded').count() == 1)
    check('refunded item is sellable again', db("__db.product_items[0].status") == 'in_stock')
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/09-sales.png', full_page=True)

    # device lock
    page.evaluate("go('devices')"); page.check('#dlock'); page.click('#devRulesForm button'); page.wait_for_timeout(150)
    page.evaluate("go('pos')")
    check('unregistered device sees lock screen', page.locator('.lockScreen').count() == 1)
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/10-device-lock.png')
    page.click('#devRegForm button'); page.wait_for_timeout(200)
    check('owner device auto-approved and can scan', page.locator('#scanZone').count() == 1)
    page.evaluate("myDevice=null; sessionStorage; localStorage.setItem('dq_device_key','dqd_other_device_key_000000000000'); recheckDevice()"); page.wait_for_timeout(150)
    r = page.evaluate("sb.rpc('dq_checkout',{p_shop_id:'s0000000-0000-4000-8000-000000000001',p_lines:[{item_id:__db.product_items[0].id}],p_device_key:'dqd_other_device_key_000000000000'}).then(r=>r.error&&r.error.message)")
    check('server rejects sale from unregistered device', r and 'DEVICE_NOT_REGISTERED' in r, r)
    page.evaluate("go('devices')"); page.wait_for_timeout(100)
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/11-devices.png', full_page=True)
    page.evaluate("__db.businesses[0].device_lock=false; business.device_lock=false")

    # wallet top-up request
    page.evaluate("go('wallet')"); page.fill('#tua', '5000'); page.fill('#tur', 'QK7H2XLM1P'); page.click('#topupForm button'); page.wait_for_timeout(150)
    check('top-up request submitted', 'pending' in page.inner_text('#content'))
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/12-wallet.png', full_page=True)

    # cashier: only own shop, no QR generation menu
    page.evaluate('logout()'); page.wait_for_selector('#loginForm')
    page.fill('#lu', 'asha'); page.fill('#lp', 'secret1'); page.click('#loginForm button'); page.wait_for_selector('.side')
    check('cashier lands on Scan & Sell', page.locator('.pageHead h1').inner_text() == 'Scan & Sell')
    check('cashier has no QR Codes / Wallet menu', page.locator('.nav button:has-text("QR Codes")').count() == 0 and page.locator('.nav button:has-text("QR Wallet")').count() == 0)
    r = page.evaluate("sb.rpc('dq_generate_items',{p_product_id:'p0000000-0000-4000-8000-000000000003',p_shop_id:'s0000000-0000-4000-8000-000000000001',p_qty:1}).then(r=>r.error&&r.error.message)")
    check('cashier blocked from generating QR codes', r and 'cannot generate' in r, r)
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/13-cashier-pos.png')

    # platform owner portal: wrong code refused, right code activates
    page.evaluate('logout()'); page.wait_for_selector('#loginForm')
    page.click('[data-mode="admin"]'); page.fill('#ae', 'mohdabdull129@gmail.com'); page.fill('#ap', 'secret1'); page.fill('#ac', 'WRONG-CODE'); page.click('#adminForm button'); page.wait_for_timeout(250)
    check('portal refuses wrong activation code', 'not valid' in page.inner_text('#admErr'), page.inner_text('#admErr'))
    page.fill('#ap', 'secret1'); page.fill('#ac', 'abcd-efgh-jklm'); page.click('#adminForm button'); page.wait_for_selector('.side')
    check('portal opens after activation', page.locator('.pageHead h1').inner_text() == 'Owner portal')
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/14-portal.png', full_page=True)
    page.evaluate("adminTab='businesses';renderView()")
    check('portal lists businesses with wallet', 'Zanrizon Traders' in page.inner_text('#content'))
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/15-portal-businesses.png', full_page=True)
    page.evaluate("adminTab='topups';renderView()"); page.click('button:has-text("Approve")'); page.wait_for_timeout(200)
    check('approving top-up credits the business wallet', db('__db.dq_accounts[0].balance') == 2000 - 50 + 5000, db('__db.dq_accounts[0].balance'))
    page.evaluate("adminTab='settings';renderView()"); page.fill('#sfee', '30'); page.click('#admSettings button'); page.wait_for_timeout(150)
    check('owner can change the QR fee', db('__db.platform_settings[0].qr_fee') == 30)
    page.wait_for_timeout(450); page.screenshot(path=f'{SHOTS}/16-portal-settings.png', full_page=True)
    page.evaluate("adminTab='businesses';renderView()"); page.click('button:has-text("Suspend")'); page.wait_for_timeout(150)
    check('owner can suspend a business', db('__db.dq_accounts[0].status') == 'suspended')

    # mobile layout
    m = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True); m.route('**/*', route)
    mp = m.new_page(); merr = []; mp.on('pageerror', lambda e: merr.append(str(e)))
    mp.goto(BASE); mp.wait_for_selector('#loginForm'); mp.fill('#lu', 'owner@zanrizon.test'); mp.fill('#lp', 'secret1'); mp.click('#loginForm button'); mp.wait_for_selector('.side')
    mp.evaluate("go('pos')"); mp.wait_for_timeout(100)
    sw = mp.evaluate('document.documentElement.scrollWidth')
    check('mobile: no horizontal page scroll', sw <= 392, sw)
    mp.wait_for_timeout(450); mp.screenshot(path=f'{SHOTS}/17-mobile-pos.png', full_page=True)
    check('mobile: no script errors', not merr, merr)

    check('no JavaScript errors during the whole run', not errors, errors[:5])
    browser.close()

passed = sum(1 for r in results if r[1])
print(f'\n{passed}/{len(results)} checks passed')
sys.exit(0 if passed == len(results) else 1)
