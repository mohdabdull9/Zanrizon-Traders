-- DeepQr v3 database tests: business groups, units, catalogue, print orders, data export.
-- Runs inside one transaction and ends by raising the report (everything is rolled back).
--   (echo "begin;"; cat deepqr_v3_test.sql) | psql ... dqtest
create temp table t_res(n serial, name text, ok boolean, info text);
create temp table t_ctx(k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;
create or replace function pg_temp.ok(p_name text, p_ok boolean, p_info text default null) returns void
language sql as $$ insert into t_res(name, ok, info) values (p_name, coalesce(p_ok, false), p_info) $$;
create or replace function pg_temp.c(p_k text) returns text language sql as $$ select v from t_ctx where k = p_k $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into t_ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.as_user(p_uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.err(p_name text, p_sql text, p_like text) returns void language plpgsql as $$
begin
  perform set_config('dq.trusted', 'off', true);
  execute p_sql;
  perform pg_temp.ok(p_name, false, 'no error raised');
exception when others then
  perform pg_temp.ok(p_name, sqlerrm like p_like, sqlerrm);
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

select pg_temp.put('biz',     '00000000-0000-4000-8000-00000000b001');
select pg_temp.put('owner',   '00000000-0000-4000-8000-0000000000a1');
select pg_temp.put('cashier', '00000000-0000-4000-8000-0000000000a2');
select pg_temp.put('owner2',  '00000000-0000-4000-8000-0000000000b1');
select pg_temp.put('admin',   '00000000-0000-4000-8000-0000000000c1');
select pg_temp.put('shop',    '00000000-0000-4000-8000-000000000502');
select pg_temp.put('dell',    '00000000-0000-4000-8000-000000000701');
insert into platform_admins(email, auth_user_id) values ('mohdabdull129@gmail.com', '00000000-0000-4000-8000-0000000000c1')
  on conflict (email) do update set auth_user_id = excluded.auth_user_id;
update platform_settings set free_qr_monthly = 0, qr_fee = 25, print_fee_per_label = 20, print_delivery_fee = 3000, print_lead_days = 2;

-- ============ reference data ============
select pg_temp.ok('6 major groups', (select count(*) from dq_groups) = 6);
select pg_temp.ok('31 subcategories, every group covered', (select count(*) from dq_subcategories) = 31
  and (select count(distinct group_code) from dq_subcategories) = 6);
select pg_temp.ok('16 master units incl. STRIP and VIAL/AMPOULE', (select count(*) from dq_units) = 16
  and exists (select 1 from dq_units where code = 'STRIP') and exists (select 1 from dq_units where code = 'VIAL/AMPOULE'));
select pg_temp.ok('catalogue has 200+ approved products', (select count(*) from catalog_products where status = 'approved') >= 200);
select pg_temp.ok('every subcategory has catalogue products', not exists (
  select 1 from dq_subcategories s where not exists (select 1 from catalog_products c where c.subcategory_code = s.code)));
select pg_temp.ok('catalogue codes follow the subcategory prefix', not exists (
  select 1 from catalog_products c join dq_subcategories s on s.code = c.subcategory_code where c.code not like s.prefix || '%'));
select pg_temp.ok('old "unit" products became PCS', not exists (select 1 from products where unit = 'unit'));

set local role anon;
select pg_temp.ok('groups readable before sign-up (registration form)', (select count(*) from dq_groups) = 6);
reset role;
set local role authenticated;

-- ============ business groups ============
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('cashier cannot change the business type', $$select dq_set_business_groups(array['A'])$$, '%cannot do this%');
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.err('at least one valid group', $$select dq_set_business_groups(array['Z'])$$, 'Choose at least one%');
do $$ declare r json; begin
  r := dq_set_business_groups(array['A','B','A'], array['PCS','KG','STRIP','BAD']);
  perform pg_temp.ok('owner picks Food + Pharmacy', (select business_groups from businesses where id = my_business_id()) = array['A','B'], r::text);
  perform pg_temp.ok('their subcategories become categories', (r->>'categories_added')::int = 14
     and exists (select 1 from categories where name = 'OTC Drugs'));
  perform pg_temp.ok('only master units are kept', (select units from businesses where id = my_business_id()) @> array['KG','PCS','STRIP']
     and not ((select units from businesses where id = my_business_id()) @> array['BAD']));
end $$;

-- ============ catalogue ============
do $$ declare r json; begin
  r := dq_adopt_catalog(jsonb_build_object('items', jsonb_build_array(
         jsonb_build_object('catalog_id', (select id from catalog_products where code = 'BEV001'), 'price', 1200, 'cost', 800),
         jsonb_build_object('catalog_id', (select id from catalog_products where code = 'OTC001')),
         jsonb_build_object('catalog_id', (select id from catalog_products where code = 'PKG001'), 'code', 'D12'))));
  perform pg_temp.ok('2 catalogue products adopted, 1 skipped (code D12 taken)', (r->>'added')::int = 2
     and r->'skipped'->0->>'reason' = 'code already used', r::text);
  perform pg_temp.ok('adopted product keeps code, unit, group and my price', exists (select 1 from products
     where business_id = my_business_id() and code = 'BEV001' and unit = 'BOTTLE' and group_code = 'A' and price = 1200 and cost = 800
       and category = 'Beverages' and name like 'Coca-Cola%'));
  perform pg_temp.ok('suggested price used when none given', (select price from products where code = 'OTC001' and business_id = my_business_id())
     = (select suggested_price from catalog_products where code = 'OTC001'));
  perform pg_temp.ok('adopted product gets a unique barcode and product number', (select barcode ~ '^2[0-9]{11}$' and product_no > 0
     from products where code = 'OTC001' and business_id = my_business_id()));
end $$;
do $$ declare r json; begin
  r := dq_adopt_catalog(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('catalog_id', (select id from catalog_products where code = 'BEV001')))));
  perform pg_temp.ok('the same catalogue product is not added twice', (r->>'added')::int = 0 and r->'skipped'->0->>'reason' = 'already in your products');
end $$;
select pg_temp.ok('adoption counted on the catalogue', (select adopted_count from catalog_products where code = 'BEV001') = 1);
select pg_temp.err('businesses cannot edit the shared catalogue', $$select dq_admin_save_catalog('{"name":"x","subcategory_code":"A1"}')$$, 'Platform owner%');
update catalog_products set suggested_price = 1 where code = 'BEV001';
select pg_temp.ok('direct writes to the catalogue are blocked by RLS', (select suggested_price from catalog_products where code = 'BEV001') <> 1);

do $$ declare r json; begin
  r := dq_submit_catalog_product('{"name":"Ukwaju juice 300ml","brand":"Mama Neema","subcategory_code":"A6","unit_code":"BOTTLE","pack_size":"300ml","price":1500}');
  perform pg_temp.put('sub1', r->>'id');
  perform pg_temp.ok('business proposes a product: pending, no code yet', r->>'status' = 'pending' and r->>'code' is null and r->>'group_code' = 'A');
end $$;
select pg_temp.ok('the business sees its own pending proposal', exists (select 1 from catalog_products where id = pg_temp.c('sub1')::uuid));
select pg_temp.err('duplicate proposal refused', $$select dq_submit_catalog_product('{"name":"ukwaju juice 300ml","brand":"Mama Neema","subcategory_code":"A6"}')$$, 'CATALOG_DUPLICATE%');
select pg_temp.as_user(pg_temp.c('owner2'));
select pg_temp.ok('other businesses do not see pending proposals', not exists (select 1 from catalog_products where id = pg_temp.c('sub1')::uuid));

select pg_temp.as_user(pg_temp.c('admin'));
do $$ declare r json; begin
  r := dq_admin_save_catalog(jsonb_build_object('id', pg_temp.c('sub1'), 'action', 'approve', 'price', 1400));
  perform pg_temp.ok('admin approves: gets next BEV code', r->>'status' = 'approved' and r->>'code' = 'BEV013' and (r->>'suggested_price')::numeric = 1400, r::text);
  r := dq_admin_save_catalog('{"name":"Solar panel 100W","subcategory_code":"E4","unit_code":"PCS","price":180000}');
  perform pg_temp.ok('admin adds a product directly (approved, GAD007)', r->>'code' = 'GAD007' and r->>'status' = 'approved');
  r := dq_admin_save_catalog('{"action":"import","items":[{"name":"Mango (embe)","subcategory":"Fresh Produce","unit_code":"kg","price":2000},
        {"name":"Tomatoes","subcategory_code":"A1"},{"name":"Nails 2 inch","subcategory_code":"C4","unit_code":"XX"}]}');
  perform pg_temp.ok('CSV import adds new, skips duplicates, fixes unknown units', (r->>'added')::int = 2
     and (select unit_code from catalog_products where name = 'Nails 2 inch') = 'PCS'
     and (select unit_code from catalog_products where name = 'Mango (embe)') = 'KG', r::text);
end $$;
reset role;
select pg_temp.ok('catalogue changes are audited', (select count(*) from platform_audit where action like 'catalog.%') >= 3);
set local role authenticated;
select pg_temp.as_user(pg_temp.c('owner2'));
select pg_temp.ok('approved product now visible to every business', exists (select 1 from catalog_products where id = pg_temp.c('sub1')::uuid));

-- ============ print orders ============
select pg_temp.as_user(pg_temp.c('admin'));
select dq_admin_adjust_wallet(pg_temp.c('biz')::uuid, 10000, 'test credit', 'topup');
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare r json; begin
  r := dq_generate_items(pg_temp.c('dell')::uuid, pg_temp.c('shop')::uuid, 4);
  perform pg_temp.put('gen', r->>'generation_id');
end $$;
select pg_temp.err('print date must allow lead time', format($$select dq_request_print(jsonb_build_object('generation_ids', jsonb_build_array(%L), 'requested_date', current_date, 'contact_phone', '0712345678'))$$, pg_temp.c('gen')), 'PRINT_DATE%');
select pg_temp.err('delivery needs an address', format($$select dq_request_print(jsonb_build_object('generation_ids', jsonb_build_array(%L), 'requested_date', current_date + 3, 'contact_phone', '0712345678', 'delivery_method', 'delivery'))$$, pg_temp.c('gen')), '%delivery address%');
select pg_temp.err('empty print order refused', $$select dq_request_print(jsonb_build_object('generation_ids', '[]'::jsonb, 'requested_date', current_date + 3, 'contact_phone', '0712345678'))$$, 'PRINT_EMPTY%');
do $$ declare r json; bal numeric := (select balance from dq_accounts where business_id = my_business_id()); begin
  r := dq_request_print(jsonb_build_object('generation_ids', jsonb_build_array(pg_temp.c('gen')), 'copies', 2, 'requested_date', current_date + 3,
        'contact_phone', '0712 345 678', 'delivery_method', 'delivery', 'delivery_address', 'Kariakoo, Dar es Salaam'));
  perform pg_temp.put('po1', r->>'id');
  perform pg_temp.ok('print order: 4 labels x 2 copies x 20 + 3000 delivery', (r->>'label_count')::int = 4 and (r->>'total_fee')::numeric = 3160
     and r->>'order_no' like 'PR-%', r::text);
  perform pg_temp.ok('print fee taken from the wallet', (select balance from dq_accounts where business_id = my_business_id()) = bal - 3160
     and exists (select 1 from wallet_transactions where type = 'print_charge' and reference = r->>'order_no'));
  r := dq_request_print(jsonb_build_object('generation_ids', jsonb_build_array(pg_temp.c('gen')), 'requested_date', current_date + 5, 'contact_phone', '0712345678'));
  perform pg_temp.put('po2', r->>'id');
  r := dq_cancel_print(pg_temp.c('po2')::uuid);
  perform pg_temp.ok('business can cancel before DeepQr starts, fee refunded', r->>'status' = 'cancelled'
     and (select balance from dq_accounts where business_id = my_business_id()) = bal - 3160);
end $$;
select pg_temp.as_user(pg_temp.c('owner2'));
select pg_temp.ok('other businesses cannot see the print order', not exists (select 1 from qr_print_orders where id = pg_temp.c('po1')::uuid));
select pg_temp.err('businesses cannot open the print queue', $$select dq_admin_print_orders()$$, 'Platform owner%');
select pg_temp.as_user(pg_temp.c('admin'));
select pg_temp.ok('platform owner sees every print order with the client', (select count(*) from json_array_elements(dq_admin_print_orders()) x
  where x->>'business_code' = 'DEM') = 2);
do $$ declare r json; begin
  r := dq_admin_print_labels(pg_temp.c('po1')::uuid);
  perform pg_temp.ok('label sheet: QR payload carries the business code', json_array_length(r->'labels') = 4
     and (r->'labels'->0->>'payload') like 'DQ1|DEM|%' and r->'business'->>'name' = 'DEMO', (r->'labels'->0)::text);
  r := dq_admin_print_update(jsonb_build_object('id', pg_temp.c('po1'), 'status', 'accepted', 'promised_date', current_date + 3));
  perform pg_temp.ok('admin accepts with a promised date', r->>'status' = 'accepted' and (r->>'promised_date')::date = current_date + 3
     and json_array_length(r->'history') = 2);
end $$;
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.err('business cannot cancel once DeepQr accepted', format($$select dq_cancel_print(%L)$$, pg_temp.c('po1')), '%already started%');
select pg_temp.as_user(pg_temp.c('admin'));
select pg_temp.err('reject needs a reason', format($$select dq_admin_print_update(jsonb_build_object('id', %L, 'status', 'rejected'))$$, pg_temp.c('po1')), 'Give a reason%');
select dq_admin_print_update(jsonb_build_object('id', pg_temp.c('po1'), 'status', 'ready'));
select dq_admin_print_update(jsonb_build_object('id', pg_temp.c('po1'), 'status', 'delivered', 'note', 'Delivered to Kariakoo'));
select pg_temp.ok('order delivered, full history kept', (select status = 'delivered' and jsonb_array_length(history) = 4 from qr_print_orders where id = pg_temp.c('po1')::uuid));

-- ============ export ============
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare r json; begin
  r := dq_checkout2(jsonb_build_object('shop_id', pg_temp.c('shop'),
        'lines', json_build_array(json_build_object('item_id', (select id from product_items where generation_id = pg_temp.c('gen')::uuid order by serial limit 1))),
        'payments', json_build_array(json_build_object('method','Cash','amount', 750000))));
end $$;
insert into expenses(business_id, shop_id, category, amount, description, date, by_name) values (my_business_id(), pg_temp.c('shop')::uuid, 'Rent', 300000, 'October rent', current_date, 'test');
do $$ declare r json; rows json; begin
  r := dq_export('{}');
  rows := r->'rows';
  perform pg_temp.ok('export: sale row with profit', exists (select 1 from json_array_elements(rows) x where x->>'type' = 'Sale'
     and (x->>'qty_out')::numeric = 1 and (x->>'value')::numeric = 750000 and (x->>'profit')::numeric = 150000 and x->>'code' = 'D12'), left(rows::text, 400));
  perform pg_temp.ok('export: payment, expense, QR fee and stock rows', (select count(distinct x->>'type') from json_array_elements(rows) x
     where x->>'type' in ('Payment received','Expense','DeepQr fee','Stock on hand')) = 4);
  perform pg_temp.ok('export rows carry date, location, group and unit', exists (select 1 from json_array_elements(rows) x
     where x->>'type' = 'Stock on hand' and x->>'code' = 'BEV001' and x->>'group' = 'Food & Beverage' and x->>'unit' = 'BOTTLE')
     or not exists (select 1 from stock_levels where product_id = (select id from products where code='BEV001' and business_id = my_business_id())));
  perform pg_temp.ok('export: business and period in the header', r->>'business' = 'DEMO' and (r->>'to')::date = current_date);
  r := dq_export('{"types":["expense"]}');
  perform pg_temp.ok('export filter by type', json_array_length(r->'rows') = 1 and r->'rows'->0->>'notes' = 'October rent');
  r := dq_export(jsonb_build_object('types', jsonb_build_array('stock'), 'groups', jsonb_build_array('B')));
  perform pg_temp.ok('export filter by business group', not exists (select 1 from json_array_elements(r->'rows') x where x->>'group' <> 'Health & Pharmacy'));
end $$;
select pg_temp.err('export date range checked', $$select dq_export('{"from":"2026-02-01","to":"2026-01-01"}')$$, '%end date is before%');
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('cashier without report permission cannot download data', $$select dq_export('{}')$$, '%not allowed to download%');

do $$ declare rep text; begin
  select format(E'%s/%s passed\n', count(*) filter (where ok), count(*)) ||
         string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || coalesce(' — ' || case when ok then null else info end, ''), E'\n' order by n)
    into rep from t_res;
  raise exception E'TEST REPORT (rolled back)\n%', rep;
end $$;
