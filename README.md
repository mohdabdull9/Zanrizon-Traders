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
| **Item QR codes** | `DQ1 \| business \| shop \| product \| serial`. The serial is `year + product number + item number`, e.g. **202612001**. Labels move with transfers, can be voided, and show a full history. Recommendations show how many labels are still needed. |
| **Purchase orders** | Suppliers with payment terms. POs carry invoice number, amount and attached documents (PDF or photo, stored privately). Receive goods in several deliveries (GRNs), each line tracked as ordered / received / damaged / not received. The app warns when the invoice and delivery don't match, shows supplier balances and due dates, records supplier payments with receipts, lets you close an order short or cancel it, prints the PO, sends it by WhatsApp, and offers to print QR labels for received goods. |
| **Inventory** | Stock levels and value; reorder suggestions turned into POs; stock takes by scanning; corrections with reasons; quick stock-in; transfers with in-transit tracking; expiry tracking with write-off; a product stock card. |
| **Reports** | Overview with charts, profit & loss, products (including items that aren't selling), staff and shops, payment reconciliation, debtor aging, stock valuation, shift cash-ups. Every report has CSV export and print. |
| **Staff & devices** | Roles plus per-person permissions (price edits, credit, refunds, reports, receiving, stock, max discount). Staff can be disabled. Devices are approved per shop. There is a scanner setup guide, a live scanner test page and per-device scanner settings. |
| **QR wallet (credits)** | Main balance plus bonus credits (with expiry) and a free monthly quota. Top-up packages include bonuses. Top-ups are made by mobile money with a reference and confirmed manually; duplicate references are blocked. There are also promo codes, referral rewards and a full statement. |
| **Owner portal** | Every business, with full control: users, shops and devices can be blocked or unblocked. Per business you can adjust the wallet (with a required note), grant bonuses, set a custom QR price, free quota, credit limit, plan and private notes, and suspend the business. The portal also covers top-up approval (with receipt numbers) and rejection (with a reason), packages, promo codes, bulk bonuses, referral/welcome settings, QR batch refunds, announcements, ledger, audit log, payment accounts and support contacts. |

## Setup / upgrade

Run the SQL files in Supabase → **SQL Editor** (paste the whole file into a new query and click **Run**). They only add things; no data is removed.

1. `supabase/migrations/20261010120000_deepqr_core.sql` (v1; skip it if you already ran it)
2. `supabase/migrations/20261011120000_deepqr_v2.sql` (v2: credits, till, orders, documents, permissions, portal)
3. `supabase/migrations/20261012120000_deepqr_v3.sql` (v3: business groups, units, catalogue, print orders, data export)
4. Publish the app (merge to `main` for GitHub Pages).
5. `supabase/migrations/20261011130000_deepqr_v2_hardening.sql`. Run this **after** the v2 app is live. It closes the old public username list.

**Portal activation code.** The platform owner email is seeded as `mohdabdull129@gmail.com`. Set a one-time activation code (keep it private):

```sql
update platform_admins
   set claim_code_hash = encode(extensions.digest(upper('YOUR-CODE-HERE'), 'sha256'), 'hex')
 where email = 'mohdabdull129@gmail.com';
```

Then open the app, choose **Platform owner** and sign in with that email, your password and the code.

The Supabase URL and anon key are in `js/config.js`. If the database is older than the app, the app shows a "database update" screen instead of failing.

## Tests

* `supabase/tests/deepqr_db_test.sql` (v1), `supabase/tests/deepqr_v2_test.sql` (v2, 115 checks) and `supabase/tests/deepqr_v3_test.sql` (v3, 52 checks) test the database: credits, scanning, checkout, credit, loyalty, shifts, orders and receipts, transfers, stock takes, reports, the portal, permissions and tenant isolation. Run each in a transaction (`begin;` + file). It ends by raising the report, which rolls everything back.
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

  ```
  supabase/tests/local/run.sh                    # fresh local database (Postgres on /tmp/pg:5433)
  python3 tests/local_backend.py --port 54321 &
  python3 tests/e2e_test.py <node_modules_dir> <screenshot_dir>
  ```
