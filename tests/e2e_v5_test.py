"""DeepQr v5 browser tests: shop products (prices, photos, popular), shop setup with
branches on the map and delivery priced per km, the customer's checkout with a
location pin, and the animated sign-in page with the real-product showcase.

Runs after tests/e2e_test.py and tests/e2e_v4_test.py on the same database.
"""
import io, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_harness import *  # noqa: F401,F403
from e2e_harness import results, errors
from PIL import Image, ImageDraw

DELL = '00000000-0000-4000-8000-000000000701'
MILK = '00000000-0000-4000-8000-000000000703'
SHOP = (-6.8190, 39.2730)      # MZ1, Kariakoo
CUSTOMER = (-6.7920, 39.2730)  # about 3 km north

photo = os.path.join(SHOTS, '_dell.png')
im = Image.new('RGB', (1600, 1200), (235, 240, 250)); d = ImageDraw.Draw(im)
d.rectangle([300, 250, 1300, 900], fill=(40, 60, 110)); d.rectangle([360, 300, 1240, 820], fill=(120, 170, 255)); d.rectangle([200, 900, 1400, 960], fill=(30, 40, 70))
im.save(photo)

biz = sql("select id from businesses where code='DEM'")
cat = sql("select id||'|'||suggested_price::int from catalog_products where status='approved' and suggested_price > 0 order by code limit 1").split('|')
sql(f"""insert into products(business_id, code, name, category, unit, price, cost, catalog_id, online, barcode)
        values ('{biz}', 'SUG1', 'Sugar 1 kg', 'General', 'PCS', 0, 2000, '{cat[0]}', true, '2000000000017')""")
sugar = sql("select id from products where code='SUG1'")
sql(f"insert into stock_levels(business_id, shop_id, product_id, qty) values ('{biz}', '00000000-0000-4000-8000-000000000502', '{sugar}', 12)")

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox'])

    # ================================================================== 1. shop products: price, photo, popular
    ow = new_page(browser, geolocation={'latitude': SHOP[0], 'longitude': SHOP[1]}, permissions=['geolocation'])
    login(ow, 'owner@demo.test')
    goto(ow, 'online'); ow.wait_for_timeout(800)
    check('online orders warns that a product has no price', 'have no price' in ow.inner_text('#content') or 'has no price' in ow.inner_text('#content'), ow.inner_text('#content')[:300])
    ow.click('button:has-text("Fix shop products")'); ow.wait_for_selector('.spGrid')
    check('shop products shows how many products customers can buy', 'Customers can buy' in ow.inner_text('.shopHealth') and ow.is_visible('.healthRing'))
    check('needs-a-price filter lists the product', 'Sugar 1 kg' in ow.inner_text('.spGrid'), ow.inner_text('.spGrid')[:200])
    shot(ow, '62-shop-products-need-price')
    ow.click('button:has-text("Use suggested prices")'); ow.wait_for_timeout(800)
    check('suggested catalogue price filled in before saving', ow.input_value(f'#sp_{sugar} .spPrice input') == cat[1] and ow.is_visible('.saveBar.show'), ow.input_value(f'#sp_{sugar} .spPrice input'))
    ow.click(f'#sp_{MILK} .spStar'); ow.wait_for_timeout(200)
    check('save bar counts the changes', '2 products changed' in ow.inner_text('#spSave'), ow.inner_text('#spSave'))
    ow.click('#spSaveBtn'); ow.wait_for_timeout(1500)
    check('prices and popular saved', sql(f"select price::int from products where id='{sugar}'") == cat[1] and sql(f"select online_featured from products where id='{MILK}'") == 't')
    # photos
    ow.click(f'#sp_{DELL} .spPhoto'); ow.wait_for_selector('#ppFile', state='attached')
    ow.set_input_files('#ppFile', photo); ow.wait_for_selector('.ppItem img')
    ow.fill('#ppD', '12-inch laptop, 8 GB RAM, 256 GB SSD. One year warranty.')
    shot(ow, '63-photo-manager')
    ow.click('#ppSave'); ow.wait_for_timeout(2500)
    url = sql(f"select image_url from products where id='{DELL}'")
    check('photo uploaded, shrunk and saved with the description', '/storage/v1/object/public/dq-public/p/' in url and sql(f"select jsonb_array_length(photos) from products where id='{DELL}'") == '1'
          and sql(f"select description from products where id='{DELL}'").startswith('12-inch laptop'), url)
    resp = ow.request.get(url)
    w = Image.open(io.BytesIO(resp.body())).size[0] if resp.ok else 0
    tresp = ow.request.get(url.replace('.jpg', '-t.jpg'))
    tw = Image.open(io.BytesIO(tresp.body())).size if tresp.ok else (0, 0)
    check('photo is public and resized for phones, with a square thumbnail', resp.ok and resp.headers.get('content-type', '').startswith('image/jpeg') and w <= 1400 and tw[0] == tw[1] and tw[0] <= 480, (resp.status, w, tw))
    check('shop products card shows the photo', ow.is_visible(f'#sp_{DELL} .spPhoto img'))
    shot(ow, '64-shop-products')
    goto(ow, 'products'); ow.wait_for_timeout(500)
    check('products list shows the photo thumbnail', ow.locator('tr:has-text("Dell 12") img.pThumb').count() == 1)

    # ================================================================== 2. shop setup: branch on the map, delivery per km
    goto(ow, 'shopsetup'); ow.wait_for_selector('.brRow')
    check('shop setup explains warehouses do not sell online', 'Warehouses' in ow.inner_text('#content') and 'Main Store' in ow.inner_text('#content'))
    check('shop setup lists selling branches only', ow.locator('.brRow').count() == 1 and 'MZ1' in ow.inner_text('.brRow'))
    ow.click('#ssMode button:has-text("By distance")'); ow.wait_for_selector('#ssPerKm')
    ow.fill('#ssBase', '1000'); ow.fill('#ssBaseKm', '2'); ow.fill('#ssPerKm', '500'); ow.fill('#ssMax', '15'); ow.fill('#ssFree', '')
    ow.evaluate("ssDraft.store_free_delivery_over=''")
    check('fee examples update live', '2,500 TZS' in ow.inner_text('#ssEx') and '1,000 TZS' in ow.inner_text('#ssEx'), ow.inner_text('#ssEx'))
    ow.click('.brRow button:has-text("Set location")'); ow.wait_for_selector('#ssMapBox')
    ow.wait_for_selector('#ssMapBox.leaflet-container', timeout=10000)
    check('map with a draggable pin opens', ow.locator('#ssMapBox .dqPin').count() >= 1)
    ow.click('#ssHere'); ow.wait_for_function("document.getElementById('ssPt').textContent.includes('-6.819')", timeout=10000)
    ow.fill('#ssAddr', 'Msimbazi St, Kariakoo')
    shot(ow, '65-branch-map')
    ow.click('button:has-text("Use this location")'); ow.wait_for_timeout(400)
    check('branch shows it is on the map', 'On the map' in ow.inner_text('.brRow'))
    shot(ow, '66-shop-setup')
    ow.click('#ssSave'); ow.wait_for_timeout(1800)
    r = sql("select store_delivery_mode||'/'||store_base_fee::int||'/'||store_base_km::int||'/'||store_per_km::int||'/'||store_max_km::int from businesses where code='DEM'")
    check('delivery by distance saved', r == 'distance/1000/2/500/15', r)
    check('branch location saved', sql("select round(lat::numeric,3)||','||round(lng::numeric,3)||'/'||address from shops where code='S02' and business_id=(select id from businesses where code='DEM')") == '-6.819,39.273/Msimbazi St, Kariakoo')

    # ================================================================== 3. shopper: photos, product sheet, delivery priced by the pin
    sh = new_page(browser, 400, 860, geolocation={'latitude': CUSTOMER[0], 'longitude': CUSTOMER[1]}, permissions=['geolocation'])
    sh.goto(BASE + '?shops'); sh.wait_for_selector('.shopCard', timeout=15000)
    check('shop directory shows product photos', sh.locator('.shopCard:has-text("DEMO") .shopPics img').count() >= 1)
    sh.click('.shopCard:has-text("DEMO")'); sh.wait_for_selector('.prodCard', timeout=15000)
    check('shop shows the product photo', sh.locator('.prodCard:has-text("Dell 12") .pcImg img').count() == 1)
    check('popular product comes first with a tag', 'Popular' in sh.inner_text('.prodCard >> nth=0') and 'Milk' in sh.inner_text('.prodCard >> nth=0'), sh.inner_text('.prodCard >> nth=0'))
    check('products without a photo get a clean placeholder', sh.locator('.prodCard .noImg').count() >= 1)
    check('branch bar shows where you are shopping', 'MZ1' in sh.inner_text('.branchBar'))
    shot(sh, '67-store-photos')
    sh.click('.prodCard:has-text("Dell 12") .pcImg'); sh.wait_for_selector('.sheetPics img')
    check('product sheet shows photo, price and description', '12-inch laptop' in sh.inner_text('#modal') and '750,000' in sh.inner_text('#modal'))
    shot(sh, '68-product-sheet')
    sh.click('#modal button:has-text("Add to basket")'); sh.wait_for_timeout(300)
    sh.click('#modal button:has-text("Checkout")'); sh.wait_for_selector('#coSum')
    sh.click('#modal .seg.big button:has-text("Deliver to me")'); sh.wait_for_selector('#coFee')
    sh.wait_for_function("document.getElementById('coFee')?.innerText.includes('Set your delivery location')", timeout=8000)
    check('checkout asks for the delivery location', True)
    sh.click('#coLoc'); sh.wait_for_function("document.getElementById('coFee')?.innerText.includes('km from')", timeout=10000)
    fee_txt = sh.inner_text('#coFee')
    check('delivery fee worked out from the distance', 'About 3.9 km from MZ1' in fee_txt and '2,000 TZS' in fee_txt, fee_txt)
    check('total includes the distance fee', '752,000' in sh.inner_text('#coSum'), sh.inner_text('#coSum'))
    sh.fill('#coA', 'Mtaa wa Congo, blue gate')
    sh.click('#modal .seg.big button:has-text("Pay on delivery")'); sh.wait_for_timeout(300)
    shot(sh, '69-checkout-distance')
    sh.click('#coPlace'); sh.wait_for_selector('#shF')
    sh.fill('#shP', '0713 555 777'); sh.fill('#shW', 'secret1'); sh.click('#shF button.primary')
    sh.wait_for_selector('#coPlace', timeout=15000); sh.wait_for_timeout(800)
    if 'Place order' not in sh.inner_text('#coPlace'): sh.wait_for_timeout(1000)
    sh.click('#coPlace'); sh.wait_for_selector('.orderCard', timeout=15000)
    o = sql("select delivery_fee::int||'/'||round(delivery_km,1)||'/'||round(delivery_lat::numeric,3)||'/'||total::int||'/'||(select code from shops where id=shop_id) from online_orders order by created_at desc limit 1")
    check('order stored with the km, the pin and the fee', o == '2000/3.9/-6.792/752000/S02', o)
    sh.context.close()

    # far away customer is refused
    far = new_page(browser, 400, 860, geolocation={'latitude': -6.55, 'longitude': 39.2730}, permissions=['geolocation'])
    far.goto(BASE + '?shop=demo-shop'); far.wait_for_selector('.prodCard', timeout=15000)
    far.click('.prodCard:has-text("Milk") button:has-text("Add")'); far.wait_for_timeout(200)
    far.click('.basketBar'); far.wait_for_selector('#coSum')
    far.click('#modal .seg.big button:has-text("Deliver to me")'); far.wait_for_selector('#coLoc')
    far.click('#coLoc'); far.wait_for_function("document.getElementById('coFee')?.innerText.includes('delivers up to')", timeout=10000)
    check('too far away: the customer sees the limit', '15 km' in far.inner_text('#coFee'), far.inner_text('#coFee'))
    far.context.close()

    # ================================================================== 4. staff see the distance and directions
    goto(ow, 'online'); ow.wait_for_selector('.ooCard', timeout=10000); ow.wait_for_timeout(800)
    card = ow.inner_text('.ooGrid')
    check('order card shows the branch, distance and directions', 'MZ1' in card and 'about 3.9 km' in card and ow.locator('.ooCard a:has-text("Directions")').count() >= 1, card[:300])
    shot(ow, '70-online-order-distance')
    ow.context.close()

    # ================================================================== 5. sign-in page: moving till + real products
    a = new_page(browser)
    a.goto(BASE); a.wait_for_selector('#loginForm'); a.wait_for_timeout(300)
    check('sign-in page shows the moving till', a.is_visible('.till') and a.locator('.parcel').count() >= 1)
    a.wait_for_function("document.querySelectorAll('#rcLines .rcLine').length >= 2", timeout=8000)
    check('scanned items print on the receipt', a.locator('#rcLines .rcLine').count() >= 2 and 'TZS' in a.inner_text('#rcTotal'))
    a.wait_for_selector('.showTile', timeout=8000)
    check('sign-in page shows real products from open shops', 'Dell 12' in a.inner_text('#heroShow') and 'DEMO' in a.inner_text('#heroShow'))
    a.wait_for_timeout(700)
    shot(a, '71-signin-desktop')
    a.click('[data-mode=customer]'); a.wait_for_timeout(1500)
    check('shopper tab changes the headline', 'Order from shops near you' in a.inner_text('.heroMain h1'))
    shot(a, '72-signin-shopper')
    a.click('.showTile:has-text("Dell 12")'); a.wait_for_selector('.prodCard', timeout=15000)
    check('a showcase product opens its shop', 'DEMO' in a.inner_text('.storeHero'))
    a.context.close()
    m = new_page(browser, 390, 844)
    m.goto(BASE); m.wait_for_selector('#loginForm'); m.wait_for_timeout(2600)
    check('phone sign-in shows the till above the form', m.is_visible('.till') and m.is_visible('#loginForm'))
    check('phone sign-in has no sideways scroll', m.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    shot(m, '73-signin-phone')
    m.context.close()
    rm = new_page(browser, reduced_motion='reduce')
    rm.goto(BASE); rm.wait_for_selector('#loginForm'); rm.wait_for_timeout(500)
    check('reduced motion: still receipt, nothing moving', rm.locator('.parcel').count() == 0 and rm.locator('#rcLines .rcLine').count() == 3)
    rm.context.close()

    check('no JavaScript errors', not errors, errors[:5])
    browser.close()

fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)}/{len(results)} passed')
sys.exit(1 if fails else 0)
