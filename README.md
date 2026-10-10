# DeepQr

<img src="assets/deepqr-logo.svg" width="72" alt="DeepQr logo">

**DeepQr** (formerly Zanrizon Traders) is a multi-business management system. Every physical item gets its own secure QR code. One scan identifies the business, the shop and the product, and records the sale.

It is a single-page app (`index.html`) backed by Supabase (Postgres, Auth and row-level security). Host it on GitHub Pages, Netlify or any static host.

## What's inside

| Area | What it does |
|---|---|
| **Item QR codes** | Each item gets a unique code: `DQ1 \| business \| shop \| product \| serial`. The serial is `year + product number + item number`, e.g. `2026` `12` `001` → **202612001**, then 202612002… |
| **Scan → cart → receipt** | Scan items one after another into the cart (QR or legacy barcode). Then create one receipt with discount, payment method, amount received and change. The same QR can never be sold twice. |
| **Expiry detection** | Enter an expiry date per QR batch or per purchase. The Expiry tracker and dashboard show expired items and items expiring soon. The scanner and the server refuse expired items (configurable). Expired items can be written off. |
| **Authorised devices** | Optionally only registered and approved smartphones or hardware scanners can sell. Choose camera-only, hardware-only or both. Device keys are stored hashed. |
| **QR billing** | Generating QR codes costs a fee per code (default **25 TZS**) taken from a prepaid wallet. Businesses submit mobile-money top-up requests, and the platform owner approves them. |
| **Recommendations** | For every product and shop: stock on hand − items already tagged = recommended QR codes and estimated cost. You can generate them all in one click. |
| **Platform owner portal** | See all businesses, their usage, sales and wallet. Approve top-ups, credit or debit wallets, suspend or activate businesses, set the QR fee, welcome credit and payment instructions, and view the ledger. |
| **Also** | Refunds (items and stock go back), CSV export of sales and inventory, receipt QR, dark mode, mobile layout, plus all the original stock, transfer, purchase, order, expense, staff and report features. |

## Setup

1. **Database:** in Supabase open **SQL Editor**, paste the contents of `supabase/migrations/20261010120000_deepqr_core.sql` and run it. It only adds things; no existing data is removed.
2. **Portal activation code:** the platform owner email is seeded as `mohdabdull129@gmail.com`. Set a one-time activation code (keep it private):
   ```sql
   update platform_admins
      set claim_code_hash = encode(extensions.digest(upper('YOUR-CODE-HERE'), 'sha256'), 'hex')
    where email = 'mohdabdull129@gmail.com';
   ```
   Then open the app, choose **Platform owner** and sign in with that email, your password and the code. The account is created if it doesn't exist. The code works once and binds the portal to that account.
3. **Host** `index.html` and the `assets/` folder. The Supabase URL and anon key are at the top of `index.html`.

Before step 1 is done, the app still runs as before and shows a "database update pending" banner.

## Tests

* `supabase/tests/deepqr_db_test.sql`: database tests for billing, serials, scanning, checkout, expiry, refunds, device lock, top-ups, the portal, suspension and tenant isolation. Run it in a transaction (`begin;` + file). It ends by raising the report, which rolls everything back.
* `tests/e2e_test.py`: browser tests (Playwright) that drive the real `index.html` against an in-memory mock (`tests/mock-supabase.js`). They cover all screens, QR generation, decoding a printed label, the scan-to-receipt flow, refunds, the device lock, the wallet, the cashier role, the owner portal and mobile layout.
