# DeepQr

<img src="assets/deepqr-logo.svg" width="72" alt="DeepQr logo">

**DeepQr** (formerly Zanrizon Traders) is a multi-business POS and business management system. Every physical item gets its own secure QR code. One scan identifies the business, the shop and the product, and records the sale.

It is a static single-page app (`index.html` + `css/` + `js/`) backed by Supabase (Postgres, Auth, Storage and row-level security). Host it on GitHub Pages, Netlify or any static host.

## What's inside

| Area | What it does |
|---|---|
| **Any goods business** | The owner picks one or more of six groups at sign-up: Food & Beverage, Health & Pharmacy, Household & General Merchandise, Fashion & Personal Care, Electronics & Technology, and Agro, Industrial & Bulk. Together they cover 31 subcategories. One shared unit list is used everywhere (PCS, DOZEN, PACK, BOX, CARTON, SET, BAG, KG, G, TON, LTR, ML, MTR, STRIP, BOTTLE, VIAL/AMPOULE). |
| **Product catalogue** | 221 ready-made products sold in Tanzania, each with a code (e.g. `BEV001`), unit, pack size and suggested price. New businesses see the products for their groups, tick the ones they sell, set prices and add them in one step. They can still create and edit their own products, and suggest new ones. The platform owner approves suggestions, adds products and imports a CSV. QR labels still carry the business code, so a label only works for the business that printed it. |
| **Label printing service** | Print labels yourself, or order printed labels from DeepQr: pick batches, copies, label size, collection or delivery, and a date. The fee comes from the QR wallet and is refunded if the order is cancelled or rejected. The owner portal has a print queue with a label sheet per client and a status timeline (requested → accepted → printing → ready → delivered). |
| **Data download** | A single Excel table (or CSV) holds every sale line, payment, refund, delivery, damaged item, supplier payment, expense, stock correction, transfer, DeepQr fee and today's stock. Date, year, month, week and weekday columns make it ready for pivot tables. Filter by period, location, data type and product group. The Excel file can also include Summary, Monthly and "How to analyse" sheets. |
| **Scan & Sell** | USB, Bluetooth and Android POS scanners (keyboard mode, with or without an Enter suffix, even when no field is selected), and phone/tablet cameras (back camera chosen automatically, camera switcher, torch). Labels that a scanner's keyboard layout mangles are still read. Scan into a cart, then take a split payment (cash + mobile money/card/bank, with a required reference). Also supports credit sales, loyalty points, discounts within each cashier's limit, held/parked sales, receipts by print or WhatsApp, and returns. |
| **Till shifts** | Open a shift with a float, record cash in/out, and close with a counted cash-up. The difference is shown. Owners can require a shift before selling. |
| **Customers & debts** | Customer accounts with a credit limit, a debt ledger, debt payments, a WhatsApp reminder and points. |
| **Smart QR labels** | New labels are web links: `https://<your site>/?dq=1.BIZ.SHOP.PRODUCT.SERIAL`. Any phone camera opens a public "Check a DeepQr label" page that shows whether the item is genuine, sold, cancelled or expired, and who sells it. The till scanners read the same link, including when a keyboard layout mangles it. A business can keep the classic `DQ1\|business\|shop\|product\|serial` format in Settings, and old labels keep working. The serial is `year + product number + item number`, e.g. **202612001**. Labels move with transfers, can be voided, and show a full history. Product barcodes are checked against the GS1 check digit. |
| **Online shop & shoppers** | A business opens its online shop in one dialog: link (`?shop=your-name`), pickup and/or delivery, delivery fee, free-delivery threshold, minimum order, opening hours and the M-Pesa / bank numbers customers pay to. Products marked "Show in online shop" appear with live stock. Shoppers sign up with their phone number, browse shops, fill a basket, choose pickup or delivery, and pay at the shop or by mobile money with the transaction reference. They follow each order on a progress track and collect points at every shop. Points can pay part of the next order, and a shop can give bonus points on a first online order. |
| **Shop products** | One screen to get products ready for the online shop: a score of how many products customers can buy, with filters for those that need a price, have no photo, are out of stock at online branches or are hidden. Prices are edited in place and saved together, and missing prices can be filled from DeepQr's suggested catalogue prices. Products can be marked popular (shown first) and shown or hidden in bulk. Up to 6 photos per product, taken with the phone camera or chosen from the gallery; they are shrunk on the device before upload. Each product has a description for customers. |
| **Branches & delivery by distance** | Every selling branch takes online orders from its own stock; warehouses never do. Each branch is put on the map (stand in the shop and tap "Use my location here", or drag the pin). Delivery is either one fee everywhere or priced by distance: a base fee covering the first km, a price for each extra km, the furthest distance and rounding, with a live example table. A branch can charge its own prices. Customers choose a branch or let DeepQr find the nearest one, and at checkout share their location or drop a pin. The server measures the distance (straight line + 30% for roads) and works out the fee, so it cannot be changed in the browser. Staff see the distance, directions and a location link to send to the rider. |
| **Online orders (business side)** | New orders arrive with a sound and a menu badge. Staff check the payment reference on their statement and mark it received or not found, accept or decline the order, mark it preparing / ready / out for delivery, then complete it at the till. The till shows which labels to scan, adds the delivery fee, and records a normal sale with a receipt and points. A shopper becomes the shop's customer when the shop accepts their first order. |
| **Supplier portal** | Suppliers register for free, list their products and prices (picked from the catalogue), and see every order businesses send them. They confirm what they can supply (quantity, price, delivery date), decline with a reason, or dispatch with an invoice and attachments. They print a delivery note, see what each business owes them, and confirm or dispute every payment a business records. Businesses find suppliers in a directory, add them in one click, or invite a supplier who is not on DeepQr yet with a link. Suppliers who are not on DeepQr still work as before (WhatsApp / print). |
| **Payments centre** | One place for money in and out: online payments to verify, supplier payments with the supplier's confirmation, and money in by method. A payment reference can only be used once. |
| **Smart suggestions** | DeepQr studies each business's own sales, stock and customers: when products will run out and how much to reorder, slow movers, low margins, products sold together, busy hours and days, customers who stopped buying, debts and expiring stock. Each suggestion has a one-click action. "Done" and "Not useful" teach it what to show more or less of. |
| **Purchase orders** | Suppliers with payment terms. POs carry invoice number, amount and attached documents (PDF or photo, stored privately). Receive goods in several deliveries (GRNs), each line tracked as ordered / received / damaged / not received. The app warns when the invoice and delivery don't match, shows supplier balances and due dates, records supplier payments with receipts, lets you close an order short or cancel it, prints the PO, sends it by WhatsApp, and offers to print QR labels for received goods. |
| **Inventory** | Stock levels and value; reorder suggestions turned into POs; stock takes by scanning; corrections with reasons; quick stock-in; transfers with in-transit tracking; expiry tracking with write-off; a product stock card. |
| **Reports** | Overview with charts, profit & loss, products (including items that aren't selling), staff and shops, payment reconciliation, debtor aging, stock valuation, shift cash-ups. Every report has CSV export and print. |
| **Staff & devices** | Roles plus per-person permissions (price edits, credit, refunds, reports, receiving, stock, max discount). Staff can be disabled. Devices are approved per shop. There is a scanner setup guide, a live scanner test page and per-device scanner settings. |
| **QR wallet (credits)** | Main balance plus bonus credits (with expiry) and a free monthly quota. Top-up packages include bonuses. Top-ups are made by mobile money with a reference and confirmed manually; duplicate references are blocked. There are also promo codes, referral rewards and a full statement. |
| **Owner portal** | A left-side menu grouped into Overview, Clients (businesses, suppliers, shoppers & online orders), Money (top-ups, payment checks, credits, ledger), Operations and Platform (team & roles, audit log, settings). **Team & roles**: the owner adds assistants, each with their own login and a role: admin, finance, support or catalogue. Each role only sees and does what it is allowed to, and the server checks it too. Covers every business, with full control: users, shops and devices can be blocked or unblocked. Per business you can adjust the wallet (with a required note), grant bonuses, set a custom QR price, free quota, credit limit, plan and private notes, and suspend the business. The portal also covers top-up approval (with receipt numbers) and rejection (with a reason), packages, promo codes, bulk bonuses, referral/welcome settings, QR batch refunds, announcements, ledger, audit log, payment accounts and support contacts. |

| **Sign-in page** | A moving checkout counter shows items riding a belt past the scanner and printing on a receipt, with a strip of real products (with photos) from open shops that links straight to them. The headline changes for businesses, suppliers and shoppers. On phones the counter sits above the form and the products below it. It stays still when the device asks for reduced motion. |

## Setup / upgrade

Run the SQL files in Supabase → **SQL Editor** (paste the whole file into a new query and click **Run**). They only add things; no data is removed.

1. `supabase/migrations/20261010120000_deepqr_core.sql` (v1; skip it if you already ran it)
2. `supabase/migrations/20261011120000_deepqr_v2.sql` (v2: credits, till, orders, documents, permissions, portal)
3. `supabase/migrations/20261012120000_deepqr_v3.sql` (v3: business groups, units, catalogue, print orders, data export)
4. `supabase/migrations/20261013120000_deepqr_v4.sql` (v4: smart QR links, online shop and shoppers, supplier portal, payment verification, platform team, smart suggestions). Safe to run twice.
5. `supabase/migrations/20261014120000_deepqr_v5.sql` (v5: shop products with photos, branches on the map, delivery per km, sign-in showcase). It also creates the public `dq-public` storage bucket for product photos. Safe to run twice.
6. Publish the app (merge to `main` for GitHub Pages).
7. In **Owner portal → Settings → Smart QR address**, check that the address is your live site (default `https://mohdabdull9.github.io/Zanrizon-Traders/`). New labels use it.
8. `supabase/migrations/20261011130000_deepqr_v2_hardening.sql`. Run this **after** the v2 app is live. It closes the old public username list.

**Portal activation code.** The platform owner email is seeded as `mohdabdull129@gmail.com`. Set a one-time activation code (keep it private):

```sql
update platform_admins
   set claim_code_hash = encode(extensions.digest(upper('YOUR-CODE-HERE'), 'sha256'), 'hex')
 where email = 'mohdabdull129@gmail.com';
```

Then open the app, click **DeepQr team? Open the platform portal** and sign in with that email, your password and the code.

**Shopper sign-up.** Shoppers sign in with their phone number. In Supabase → Authentication → Providers → Email, switch off **Confirm email**, because shopper accounts have no real inbox.

**Payments.** Mobile-money and bank payments are confirmed by the receiver against their statement, using the transaction reference. Automatic confirmation needs a merchant account with a provider (e.g. M-Pesa, Airtel Money, Selcom, AzamPay) and a server callback; the payment status fields are ready for that.

The Supabase URL and anon key are in `js/config.js`. If the database is older than the app, the app shows a "database update" screen instead of failing.

## Tests

* `supabase/tests/deepqr_db_test.sql` (v1), `supabase/tests/deepqr_v2_test.sql` (v2, 115 checks) `supabase/tests/deepqr_v3_test.sql` (v3, 52 checks) `supabase/tests/deepqr_v4_test.sql` (v4, 76 checks) and `supabase/tests/deepqr_v5_test.sql` (v5, 37 checks) test the database: credits, scanning, checkout, credit, loyalty, shifts, orders and receipts, transfers, stock takes, reports, the portal, permissions and tenant isolation. Run each in a transaction (`begin;` + file). It ends by raising the report, which rolls everything back.
* `tests/e2e_test.py` runs browser tests (Playwright, 85 checks). They drive the real app against a real Postgres database through `tests/local_backend.py`, a small stand-in for the Supabase REST, Auth and Storage APIs. Coverage includes:
  * top-up → portal approval
  * promo codes, custom pricing, blocking users
  * QR generation charged to free quota and then bonus
  * USB / no-suffix / mangled-separator scanning
  * phone-camera scanning, using a fake camera that shows a printed label
  * hold/resume, split and credit payments
  * POs with an invoice upload, partial delivery with damaged items, and supplier payment
  * reports, the scanner test page, staff creation and settings
  * registering with business groups, adding catalogue products, suggesting a product and the owner approving it
  * ordering printed labels and the owner's print queue
  * Excel and CSV downloads, opened and checked
* `tests/e2e_v5_test.py` (38 checks) covers shop products (suggested prices, popular, a photo upload checked for size), shop setup with a branch on the map and delivery per km, a shopper ordering with their location (fee from the distance), a customer too far away, the order card with directions, and the sign-in page (moving till, real products, phone layout, reduced motion).
* `tests/e2e_v4_test.py` (46 checks) runs after it on the same database: the public label check, opening the online shop, a shopper signing up and ordering on a phone, verifying the payment, completing the order at the till with points, a supplier registering, being found and receiving a PO, confirming with changes and dispatching, smart suggestions, and the platform team (inviting a support assistant whose access is limited).

  ```
  supabase/tests/local/run.sh                    # fresh local database (Postgres on /tmp/pg:5433)
  python3 tests/local_backend.py --port 54321 &
  python3 tests/e2e_test.py <node_modules_dir> <screenshot_dir>
  python3 tests/e2e_v4_test.py <node_modules_dir> <screenshot_dir>
  python3 tests/e2e_v5_test.py <node_modules_dir> <screenshot_dir>   # also needs leaflet@1.9.4
  ```
