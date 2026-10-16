"""DeepQr v6 browser tests: selling offline (and starting the app with no internet),
automatic upload, conflicts for the manager, digital receipts, shop logo/cover,
deals ("was" prices), the fast price list with scan-to-price, reviews, and the
customer's receipts.

Runs after tests/e2e_test.py, e2e_v4_test.py and e2e_v5_test.py on the same database.
"""
import io, os, sys
os.environ['PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS'] = '1'   # lets the test routes serve the service worker's requests
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_harness import *  # noqa: F401,F403
from e2e_harness import results, errors
from PIL import Image, ImageDraw

DELL = '00000000-0000-4000-8000-000000000701'
MILK = '00000000-0000-4000-8000-000000000703'
def in_stock():
    return sql("select serial from product_items where product_id='%s' and status='in_stock' order by serial" % DELL).split('\n')
def outbox(pg):
    return pg.evaluate("obAll().then(l => l.length)")
def wait_js(pg, expr, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pg.evaluate(expr): return True
        pg.wait_for_timeout(250)
    return False
def img(path, color, size=(1600, 900)):
    im = Image.new('RGB', size, color); d = ImageDraw.Draw(im); d.ellipse([size[0] * .3, size[1] * .2, size[0] * .7, size[1] * .8], fill=(255, 255, 255)); im.save(path); return path
logo = img(os.path.join(SHOTS, '_logo.png'), (20, 60, 160), (800, 800))
cover = img(os.path.join(SHOTS, '_cover.png'), (16, 120, 90))

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox'])

    # ================================================================== 1. the internet drops while selling
    c = new_page(browser, 1280, 860, service_workers='allow')
    login(c, 'demo1')
    c.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller", timeout=15000)
    check('the till keeps its products and labels on the device', wait_js(c, "kvGet('snap_' + session.user.id).then(s => !!s && s.items.length > 0)"))
    s1 = in_stock()[0]
    sales0 = sql('select count(*) from sales')
    c.context.set_offline(True); c.wait_for_timeout(600)
    check('the top bar says the till is offline', 'Offline' in c.inner_text('#netChip'), c.inner_text('#netChip'))
    c.focus('#scanInput'); scan_keys(c, s1)
    check('a label scans from the device list while offline', s1 in cart_serials(c), c.inner_text('#lastScan'))
    c.focus('#scanInput'); scan_keys(c, '999999999')
    check('an unknown label is refused offline', 'not in this device' in c.inner_text('#lastScan'), c.inner_text('#lastScan'))
    c.click('#payBtn'); c.wait_for_selector('#paySubmit')
    check('payment explains the offline rules', 'Offline sale' in c.inner_text('#modal'))
    c.fill('#pa0', '100000'); c.wait_for_timeout(200)
    check('credit is not allowed offline', c.is_disabled('#paySubmit') and 'need the internet' in c.inner_text('#payNote'), c.inner_text('#payNote'))
    c.fill('#pa0', '800000'); c.wait_for_timeout(200)
    shot(c, '74-offline-payment')
    c.click('#paySubmit'); c.wait_for_selector('.receipt', timeout=10000)
    check('offline receipt is printed with a note', 'Saved offline' in c.inner_text('.receipt') and '-OFF-' in c.inner_text('.receipt'))
    ref1 = c.evaluate("obAll().then(l => l[0] && l[0].client_ref)")
    check('the sale waits on the device, not yet on the server', outbox(c) == 1 and sql('select count(*) from sales') == sales0 and '1 sale waiting' in c.inner_text('#netChip'))
    shot(c, '75-offline-receipt')
    c.keyboard.press('Escape'); c.wait_for_timeout(300)
    c.focus('#scanInput'); scan_keys(c, s1)
    check('the same label cannot be sold twice offline', s1 not in cart_serials(c))
    c.evaluate("go('reports')"); c.wait_for_timeout(300)
    check('other pages wait for the internet', 'only Scan & Sell works' in toast_text(c))
    # back online: upload by itself
    c.context.set_offline(False)
    c.wait_for_function("outboxN === 0 && !isOffline", timeout=30000)
    up = sql(f"select offline||'/'||total::int||'/'||(synced_at is not null)||'/'||(note like '%Offline receipt%') from sales where public_ref='{ref1}'")
    check('back online the sale uploads by itself', up == 'true/750000/true/true', up)
    check('the label is sold on the server', sql(f"select status from product_items where serial='{s1}'") == 'sold')
    c.evaluate("syncOutbox(true)"); c.wait_for_timeout(800)
    check('uploading again never records the sale twice', sql(f"select count(*) from sales where public_ref='{ref1}'") == '1')

    # ================================================================== 2. starting the app with no internet at all
    c.context.set_offline(True)
    c.reload(); c.wait_for_selector('#scanInput', timeout=15000); c.wait_for_timeout(500)
    check('the app opens with no internet, straight into Scan & Sell', c.evaluate('isOffline') and c.is_visible('#scanInput') and 'Offline' in c.inner_text('#netChip'))
    shot(c, '76-offline-start')
    s2, s3 = in_stock()[0], in_stock()[1]
    c.focus('#scanInput'); scan_keys(c, s2)
    c.click('#payBtn'); c.wait_for_selector('#paySubmit'); c.fill('#pa0', '750000'); c.wait_for_timeout(150); c.click('#paySubmit'); c.wait_for_selector('.receipt')
    c.keyboard.press('Escape'); c.wait_for_timeout(200)
    c.focus('#scanInput'); scan_keys(c, s3)
    c.click('#payBtn'); c.wait_for_selector('#paySubmit')
    c.click('.payGrid button:has-text("M-Pesa")'); c.wait_for_timeout(150); c.fill('#pr0' if c.is_visible('#pr0') else '#pr1', 'MPOFF77')
    c.click('#paySubmit'); c.wait_for_selector('.receipt'); c.keyboard.press('Escape')
    check('two more sales saved offline', outbox(c) == 2)
    # meanwhile another device sold s3 online
    sql(f"update product_items set status='sold' where serial='{s3}'")
    c.context.set_offline(False)
    c.wait_for_function("outboxN === 0 && !isOffline", timeout=40000); c.wait_for_timeout(1500)
    check('the good offline sale uploads', sql(f"select count(*) from sales s join sale_lines l on l.sale_id=s.id where l.serial='{s2}' and s.offline") == '1')
    conf = sql("select count(*)||'/'||max(error) from offline_conflicts where status='open'")
    check('the clashing sale is kept as a conflict, not lost', conf.startswith('1/ITEM_ALREADY_SOLD'), conf)
    c.context.close()

    # ================================================================== 3. the manager decides
    ow = new_page(browser)
    login(ow, 'owner@demo.test')
    goto(ow, 'dashboard'); ow.wait_for_timeout(800)
    check('dashboard tells the manager an offline sale needs a decision', 'could not be recorded automatically' in ow.inner_text('#content'))
    ow.click('.banner button:has-text("Review")'); ow.wait_for_selector('.conflict')
    check('the conflict shows the money taken and the reason', '750,000' in ow.inner_text('.conflict') and 'already' in ow.inner_text('.conflict'))
    shot(ow, '77-offline-conflict')
    ow.click('.conflict button:has-text("Record the sale")'); ow.wait_for_timeout(2500)
    check('manager records it from stock', sql("select status from offline_conflicts limit 1") == 'resolved' and sql("select count(*) from sales where note like '%Offline sale recorded by%'") == '1')
    goto(ow, 'sales'); ow.wait_for_timeout(500)
    check('offline sales are tagged in the sales list', ow.locator('#content .tag:has-text("offline")').count() >= 3)

    # ================================================================== 4. digital receipt
    d = new_page(browser, 400, 860)
    d.goto(BASE.replace('index.html', '') + '?r=' + ref1); d.wait_for_selector('.dReceipt .drLines', timeout=15000)
    rt = d.inner_text('.dReceipt')
    check('the receipt QR opens a digital receipt', 'Verified purchase' in rt and 'DEMO' in rt and '750,000' in rt and s1 in rt, rt[:300])
    check('the digital receipt says it was sold offline', 'sold offline' in rt)
    shot(d, '78-digital-receipt')
    d.click('.drSerial'); d.wait_for_selector('.verifyCard', timeout=10000)
    check('a serial on the receipt opens the label check', 'Genuine' in d.inner_text('#content'))
    d.goto(BASE.replace('index.html', '') + '?r=00000000-0000-4000-8000-00000000dead'); d.wait_for_selector('.dReceipt', timeout=10000)
    check('an unknown receipt says it is not uploaded yet', 'not uploaded yet' in d.inner_text('.dReceipt'))
    d.context.close()

    # ================================================================== 5. shop logo, cover, deals, fast prices
    goto(ow, 'shopsetup'); ow.wait_for_selector('.brandBox')
    ow.set_input_files('#ssLogoFile', logo); ow.wait_for_function("!!business.logo_url", timeout=15000)
    ow.set_input_files('.brandCover input[type=file]', cover); ow.wait_for_function("!!business.store_cover_url", timeout=15000); ow.wait_for_timeout(600)
    check('logo and cover photo uploaded', sql("select (logo_url like '%/brand/logo-%')||'/'||(store_cover_url like '%/brand/cover-%') from businesses where code='DEM'") == 'true/true')
    check('logo shows in the menu', ow.locator('.sideLogo').count() == 1)
    shot(ow, '79-shop-branding')
    goto(ow, 'shopprod'); ow.wait_for_selector('.spGrid')
    ow.click(f'#sp_{MILK} .spWas summary'); ow.fill(f'#sp_{MILK} .spWas input', '3200'); ow.dispatch_event(f'#sp_{MILK} .spWas input', 'change'); ow.wait_for_timeout(300)
    ow.click('#spSaveBtn'); ow.wait_for_timeout(1500)
    check('"was" price saved for a deal', sql(f"select compare_at_price::int from products where id='{MILK}'") == '3200')
    ow.click('#spListBtn'); ow.wait_for_selector('.spList')
    ins = ow.locator('.spIn'); ins.nth(0).fill('751000'); ins.nth(0).press('Enter'); ow.wait_for_timeout(200)
    check('Enter moves to the next price', ow.evaluate("document.activeElement === document.querySelectorAll('.spIn')[1]"))
    ow.evaluate("document.activeElement.blur()")
    ow.evaluate("Scanner.emit('B-MLK', 'test')"); ow.wait_for_timeout(700)
    check('scanning a barcode jumps to that product', ow.evaluate(f"document.activeElement === document.querySelector('#spr_{MILK} .spIn')"))
    shot(ow, '80-fast-price-list')
    ow.evaluate("spDraft = {}; renderView()")

    # ================================================================== 6. the shopper: deals, photos, reviews, receipts
    sh = new_page(browser, 400, 860)
    sh.goto(BASE + '?shops'); sh.wait_for_selector('.shopCard.v6', timeout=15000)
    check('directory card shows cover, logo and deals', sh.locator('.shopCard.v6:has-text("DEMO") .shopPics img').count() >= 1 and sh.locator('.shopCard.v6:has-text("DEMO") .shopLogo.img').count() == 1 and '1 deal' in sh.inner_text('.shopCard.v6:has-text("DEMO")'))
    sh.fill('#shQ', 'milk'); sh.press('#shQ', 'Enter'); sh.wait_for_timeout(1200)
    check('searching a product finds the shop', 'DEMO' in sh.inner_text('.shopGrid'))
    shot(sh, '81-directory-v6')
    sh.click('.shopCard.v6:has-text("DEMO")'); sh.wait_for_selector('.prodCards .prodCard', timeout=15000)
    check('shop page has the cover photo and logo', sh.locator('.storeCover img').count() == 1 and sh.locator('.storeHero .shopLogo.img').count() == 1)
    check('deals row with the discount', sh.is_visible('.dealsRow') and '−22%' in sh.inner_text('.dealsRow') and '3,200' in sh.inner_text('.dealsRow'), sh.inner_text('.dealsRow') if sh.is_visible('.dealsRow') else '')
    shot(sh, '82-store-v6')
    sh.click('.prodCards .prodCard:has-text("Dell 12") .pcImg'); sh.wait_for_selector('.sheetMain')
    sh.click('.sheetMain'); sh.wait_for_selector('.viewer img')
    check('tapping the photo opens it full screen', sh.is_visible('.viewer'))
    shot(sh, '83-photo-viewer')
    sh.keyboard.press('Escape'); sh.wait_for_timeout(300)
    check('closing the viewer', not sh.is_visible('.viewer'))
    # sign in as the shopper from v4 and rate the completed order
    sh.goto(BASE + '?me'); sh.wait_for_selector('#shF', timeout=15000)
    sh.fill('#shP', '0713 555 777'); sh.fill('#shW', 'secret1'); sh.click('#shF button.primary'); sh.wait_for_selector('.orderCard', timeout=15000)
    card = sh.locator('.orderCard:has-text("DEM-W00001")')
    check('completed order shows product photos, receipt and rating buttons', card.locator('.ocThumbs img').count() >= 1 and card.locator('button:has-text("Receipt")').count() == 1 and card.locator('button:has-text("Rate the shop")').count() == 1)
    card.locator('button:has-text("Rate the shop")').click(); sh.wait_for_selector('.rateRow')
    sh.click('.rateRow button >> nth=4'); sh.fill('#rateC', 'Laptop arrived the same day. Very good service!')
    shot(sh, '84-rate-shop')
    sh.click('#rateSave'); sh.wait_for_timeout(1500)
    check('review saved for the completed order', sql("select rating||'/'||comment from store_reviews") == '5/Laptop arrived the same day. Very good service!')
    sh.locator('.orderCard:has-text("DEM-W00001") button:has-text("Receipt")').click(); sh.wait_for_selector('.dReceipt .drLines', timeout=15000)
    check('the online order has a digital receipt', 'Verified purchase' in sh.inner_text('.dReceipt') and 'Dell 12' in sh.inner_text('.dReceipt'))
    sh.goto(BASE + '?me'); sh.wait_for_selector('.orderCard', timeout=15000)
    sh.evaluate("chTab('receipts')"); sh.wait_for_timeout(500)
    check('receipts tab lists the purchases', sh.locator('.rcRow').count() >= 1)
    sh.context.close()

    # shop replies, the store page shows rating + reply
    goto(ow, 'online', 'reviews'); ow.wait_for_selector('.review', timeout=10000)
    check('the business sees the review', 'Very good service' in ow.inner_text('.review') and 'Neema' in ow.inner_text('.review'))
    ow.click('.review button:has-text("Reply")'); ow.wait_for_selector('#askV'); ow.fill('#askV', 'Asante sana Neema!'); ow.click('#askF button.primary'); ow.wait_for_timeout(1200)
    check('the business replies', sql("select reply from store_reviews") == 'Asante sana Neema!')
    shot(ow, '85-reviews')
    pv = new_page(browser, 400, 860)
    pv.goto(BASE + '?shop=demo-shop'); pv.wait_for_selector('#storeReviews .review', timeout=15000)
    check('shop page shows the rating and the reply', '5.0' in pv.inner_text('.storeHero') and 'Asante sana Neema!' in pv.inner_text('#storeReviews'))
    pv.locator('#storeReviews').scroll_into_view_if_needed(); shot(pv, '86-store-reviews')
    pv.context.close()
    ow.context.close()

    # ================================================================== 7. installable app
    m = new_page(browser)
    m.goto(BASE); m.wait_for_selector('#loginForm')
    man = m.evaluate("fetch(document.querySelector('link[rel=manifest]').href).then(r => r.json())")
    check('app can be installed on the home screen (manifest with icons)', man.get('display') == 'standalone' and len(man.get('icons', [])) >= 3)
    m.context.close()

    check('no JavaScript errors', not errors, errors[:5])
    browser.close()

fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)}/{len(results)} passed')
sys.exit(1 if fails else 0)
