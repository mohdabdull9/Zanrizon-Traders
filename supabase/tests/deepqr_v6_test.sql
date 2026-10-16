-- DeepQr v6 database tests: offline sales upload (idempotent, conflicts, manager fix),
-- digital receipts, shop logo/cover, "was" prices, reviews, customer home.
--   (echo "begin;"; cat deepqr_v6_test.sql) | psql ... dqtest
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

select pg_temp.put('biz',   '00000000-0000-4000-8000-00000000b001');
select pg_temp.put('owner', '00000000-0000-4000-8000-0000000000a1');
select pg_temp.put('cashier', '00000000-0000-4000-8000-0000000000a2');
select pg_temp.put('owner2','00000000-0000-4000-8000-0000000000b1');
select pg_temp.put('shop',  '00000000-0000-4000-8000-000000000502');
select pg_temp.put('dell',  '00000000-0000-4000-8000-000000000701');
select pg_temp.put('milk',  '00000000-0000-4000-8000-000000000703');
update platform_settings set free_qr_monthly = 100;
update businesses set store_enabled = true, store_slug = 'demo-shop', store_pickup = true, loyalty_enabled = true where id = '00000000-0000-4000-8000-00000000b001';
insert into auth.users(id, email) values ('00000000-0000-4000-8000-0000000000d1', 'c255755111222@shoppers.deepqr.local'), ('00000000-0000-4000-8000-0000000000d2', 'c255711999888@shoppers.deepqr.local');

set local role authenticated;
select pg_temp.ok('database version 6', dq_version() = 6);
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare r json; begin
  r := dq_generate_items(pg_temp.c('dell')::uuid, pg_temp.c('shop')::uuid, 3);
  perform pg_temp.put('gen', r->>'generation_id');
end $$;
select pg_temp.put('item1', (select id::text from product_items where generation_id = pg_temp.c('gen')::uuid order by serial limit 1));
select pg_temp.put('item2', (select id::text from product_items where generation_id = pg_temp.c('gen')::uuid order by serial offset 1 limit 1));
select pg_temp.put('item3', (select id::text from product_items where generation_id = pg_temp.c('gen')::uuid order by serial offset 2 limit 1));

-- ============ sales get a public receipt reference ============
select pg_temp.ok('older sales got a receipt reference', not exists (select 1 from sales where public_ref is null));
select pg_temp.as_user(pg_temp.c('cashier'));
do $$ declare r json; v_ref uuid := gen_random_uuid(); begin
  r := dq_checkout4(jsonb_build_object('shop_id', pg_temp.c('shop'), 'client_ref', v_ref,
        'lines', jsonb_build_array(jsonb_build_object('item_id', pg_temp.c('item1'), 'price', 750000)),
        'payments', jsonb_build_array(jsonb_build_object('method', 'Cash', 'amount', 800000))));
  perform pg_temp.put('ref1', v_ref::text); perform pg_temp.put('sale1', r->'sale'->>'id');
  perform pg_temp.ok('online sale keeps the till''s reference', (r->'sale'->>'public_ref')::uuid = v_ref and not (r->'sale'->>'offline')::boolean
     and (r->'sale'->>'change_due')::numeric = 50000, r::text);
end $$;
select pg_temp.err('online sale errors still reach the cashier', format($$select dq_checkout4(jsonb_build_object('shop_id', %L, 'lines', jsonb_build_array(jsonb_build_object('item_id', %L, 'price', 750000)), 'payments', jsonb_build_array(jsonb_build_object('method','Cash','amount',750000))))$$, pg_temp.c('shop'), pg_temp.c('item1')), 'ITEM_ALREADY_SOLD%');

-- ============ offline sales ============
do $$ declare r json; v_ref uuid := gen_random_uuid(); n0 int; begin
  select count(*) into n0 from sales;
  r := dq_checkout4(jsonb_build_object('shop_id', pg_temp.c('shop'), 'client_ref', v_ref, 'offline', true, 'sold_at', (now() - interval '2 hours')::text,
        'date', current_date, 'time', '09:15',
        'lines', jsonb_build_array(jsonb_build_object('item_id', pg_temp.c('item2'), 'price', 750000), jsonb_build_object('product_id', pg_temp.c('milk'), 'qty', 2, 'price', 2500)),
        'payments', jsonb_build_array(jsonb_build_object('method', 'M-Pesa', 'amount', 755000, 'reference', 'OFF123'))));
  perform pg_temp.put('ref2', v_ref::text);
  perform pg_temp.ok('offline sale uploads as a normal sale', (r->'sale'->>'offline')::boolean and (r->'sale'->>'total')::numeric = 755000
     and r->'sale'->>'time' = '09:15' and (r->'sale'->>'sold_at')::timestamptz < now() - interval '1 hour' and (r->'sale'->>'synced_at') is not null, r::text);
  perform pg_temp.ok('label sold and stock reduced by the offline sale', (select status from product_items where id = pg_temp.c('item2')::uuid) = 'sold');
  r := dq_checkout4(jsonb_build_object('shop_id', pg_temp.c('shop'), 'client_ref', v_ref, 'offline', true,
        'lines', jsonb_build_array(jsonb_build_object('item_id', pg_temp.c('item2'), 'price', 750000)), 'payments', '[]'::jsonb));
  perform pg_temp.ok('uploading the same offline sale twice does not record it twice', (r->>'duplicate')::boolean and (select count(*) from sales) = n0 + 1
     and (r->'sale'->>'public_ref')::uuid = v_ref, r::text);
end $$;
-- a label sold online meanwhile, then the offline upload arrives
do $$ declare r json; v_ref uuid := gen_random_uuid(); begin
  r := dq_checkout4(jsonb_build_object('shop_id', pg_temp.c('shop'), 'client_ref', v_ref, 'offline', true, 'total', 750000, 'sold_at', now()::text,
        'lines', jsonb_build_array(jsonb_build_object('item_id', pg_temp.c('item1'), 'price', 750000)),
        'payments', jsonb_build_array(jsonb_build_object('method', 'Cash', 'amount', 750000))));
  perform pg_temp.put('ref3', v_ref::text);
  perform pg_temp.ok('a clash is kept as a conflict, not lost', (r->>'conflict')::boolean and r->>'error' like 'ITEM_ALREADY_SOLD%'
     and exists (select 1 from offline_conflicts where client_ref = v_ref and status = 'open' and total = 750000), r::text);
  r := dq_checkout4(jsonb_build_object('shop_id', pg_temp.c('shop'), 'client_ref', v_ref, 'offline', true, 'lines', '[]'::jsonb));
  perform pg_temp.ok('sending the conflict again does not duplicate it', (r->>'conflict')::boolean and (select count(*) from offline_conflicts where client_ref = v_ref) = 1);
end $$;
select pg_temp.ok('the conflict is visible to the business', exists (select 1 from offline_conflicts where client_ref = pg_temp.c('ref3')::uuid));
select pg_temp.err('offline sales cannot complete online orders', $$select dq_checkout4(jsonb_build_object('offline', true, 'online_order_id', gen_random_uuid()))$$, 'Online orders are completed online only%');
select pg_temp.put('conf', (select id::text from offline_conflicts where client_ref = pg_temp.c('ref3')::uuid));
select pg_temp.err('cashiers cannot resolve conflicts', format($$select dq_resolve_offline_conflict(%L, 'discard', 'x')$$, pg_temp.c('conf')), '%cannot do this%');
select pg_temp.as_user(pg_temp.c('owner2'));
select pg_temp.ok('other businesses do not see the conflict', not exists (select 1 from offline_conflicts where client_ref = pg_temp.c('ref3')::uuid));
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.err('discarding needs a reason', format($$select dq_resolve_offline_conflict(%L, 'discard', '')$$, pg_temp.c('conf')), '%Say why%');
do $$ declare r json; v_stock numeric; v_sale uuid; begin
  select qty into v_stock from stock_levels where shop_id = pg_temp.c('shop')::uuid and product_id = pg_temp.c('dell')::uuid;
  r := dq_resolve_offline_conflict(pg_temp.c('conf')::uuid, 'retry', 'Customer paid cash, label was a duplicate');
  v_sale := (r->>'sale_id')::uuid;
  perform pg_temp.ok('manager records the clashing sale from stock without the label', r->>'status' = 'resolved'
     and (select item_id is null and qty = 1 from sale_lines where sale_id = v_sale)
     and (select qty from stock_levels where shop_id = pg_temp.c('shop')::uuid and product_id = pg_temp.c('dell')::uuid) = v_stock - 1, r::text);
  perform pg_temp.ok('the recorded sale keeps the offline reference and cashier', (select public_ref = pg_temp.c('ref3')::uuid and offline and note like '%Offline sale recorded by%' from sales where id = v_sale));
end $$;
select pg_temp.err('a conflict is handled only once', format($$select dq_resolve_offline_conflict(%L, 'discard', 'again')$$, pg_temp.c('conf')), '%already handled%');

-- ============ digital receipt ============
reset role; set local role anon;
do $$ declare r json; begin
  r := dq_public_receipt(pg_temp.c('ref2')::uuid);
  perform pg_temp.ok('anyone with the link sees the receipt', (r->>'found')::boolean and r->'business'->>'name' = 'DEMO' and (r->'sale'->>'total')::numeric = 755000
     and json_array_length(r->'lines') = 2 and (r->'sale'->>'offline')::boolean, r::text);
  perform pg_temp.ok('receipt shows the label serial for proof of purchase', exists (select 1 from json_array_elements(r->'lines') x where x->>'serial' is not null));
  perform pg_temp.ok('receipt hides payment references', position('OFF123' in r::text) = 0);
  perform pg_temp.ok('unknown receipt link says not found', not (dq_public_receipt(gen_random_uuid())->>'found')::boolean);
end $$;
reset role; set local role authenticated;

-- ============ logo, cover, was price ============
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.err('logo must be uploaded through DeepQr', $$select dq_store_branding('{"logo_url":"https://evil.example/logo.png"}')$$, 'PHOTO%');
do $$ declare r json; u text := 'https://x.supabase.co/storage/v1/object/public/dq-public/p/' || pg_temp.c('biz') || '/brand/'; begin
  r := dq_store_branding(jsonb_build_object('logo_url', u || 'logo.jpg', 'store_cover_url', u || 'cover.jpg'));
  perform pg_temp.ok('shop logo and cover saved', r->>'logo_url' like '%logo.jpg' and r->>'store_cover_url' like '%cover.jpg');
end $$;
select pg_temp.err('"was" price must be above the price', format($$select dq_store_products_save(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', %L, 'compare_at', 100))))$$, pg_temp.c('milk')), 'WAS_PRICE%');
select dq_store_products_save(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', pg_temp.c('milk'), 'price', 2500, 'compare_at', 3000))));
select pg_temp.ok('"was" price saved', (select compare_at_price from products where id = pg_temp.c('milk')::uuid) = 3000);
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('cashiers cannot set "was" prices', format($$select dq_store_products_save(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', %L, 'compare_at', 4000))))$$, pg_temp.c('milk')), '%cannot do this%');
reset role; set local role anon;
do $$ declare c json; m json; d json; begin
  c := dq_store_catalog('demo-shop');
  select x into m from json_array_elements(c->'products') x where x->>'id' = pg_temp.c('milk');
  perform pg_temp.ok('shop shows logo, cover and the "was" price', c->'store'->>'logo' like '%logo.jpg' and c->'store'->>'cover' like '%cover.jpg' and (m->>'was')::numeric = 3000, m::text);
  select x into d from json_array_elements(dq_store_directory()) x where x->>'slug' = 'demo-shop';
  perform pg_temp.ok('directory shows logo and deals', d->>'logo' like '%logo.jpg' and (d->>'deals')::int = 1, d::text);
  perform pg_temp.ok('directory search finds shops by product name', exists (select 1 from json_array_elements(dq_store_directory('{"q":"milk"}')) x where x->>'slug' = 'demo-shop'));
end $$;
reset role; set local role authenticated;

-- ============ reviews ============
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select dq_customer_register('{"name":"Asha Juma","phone":"0755 111 222"}');
do $$ declare r json; begin
  r := dq_place_online_order(jsonb_build_object('slug','demo-shop','items', jsonb_build_array(jsonb_build_object('product_id', pg_temp.c('milk'), 'qty', 1))));
  perform pg_temp.put('oo', r->>'id');
end $$;
select pg_temp.err('no review before the order is completed', format($$select dq_review_order(jsonb_build_object('order_id', %L, 'rating', 5))$$, pg_temp.c('oo')), '%after your order is completed%');
reset role;
update online_orders set status = 'completed' where id = pg_temp.c('oo')::uuid;
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select pg_temp.err('rating must be 1 to 5', format($$select dq_review_order(jsonb_build_object('order_id', %L, 'rating', 9))$$, pg_temp.c('oo')), '%1 to 5 stars%');
select dq_review_order(jsonb_build_object('order_id', pg_temp.c('oo'), 'rating', 4, 'comment', 'Fast and friendly'));
select dq_review_order(jsonb_build_object('order_id', pg_temp.c('oo'), 'rating', 5, 'comment', 'Fast and friendly!'));
select pg_temp.ok('one review per order, the customer can update it', (select count(*) = 1 and max(rating) = 5 from store_reviews where order_id = pg_temp.c('oo')::uuid));
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d2');
select dq_customer_register('{"name":"Juma","phone":"0711 999 888"}');
select pg_temp.err('only the customer who ordered can review', format($$select dq_review_order(jsonb_build_object('order_id', %L, 'rating', 1))$$, pg_temp.c('oo')), 'Order not found%');
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.put('rev', (select id::text from store_reviews where order_id = pg_temp.c('oo')::uuid));
select pg_temp.ok('shop replies to a review', dq_review_reply(pg_temp.c('rev')::uuid, 'Asante sana!')->>'reply' = 'Asante sana!');
reset role; set local role anon;
do $$ declare c json; begin
  c := dq_store_catalog('demo-shop');
  perform pg_temp.ok('shop page shows the rating and the review with the reply', (c->'rating'->>'avg')::numeric = 5 and (c->'rating'->>'count')::int = 1
     and c->'reviews'->0->>'name' = 'Asha' and c->'reviews'->0->>'reply' = 'Asante sana!', (c->'reviews')::text);
end $$;
reset role; set local role authenticated;
select pg_temp.as_user(pg_temp.c('owner'));
select dq_review_reply(pg_temp.c('rev')::uuid, null, true);
reset role; set local role anon;
select pg_temp.ok('hidden reviews are not shown', (dq_store_catalog('demo-shop')->'rating'->>'count')::int = 0);
reset role; set local role authenticated;

-- ============ customer home ============
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
do $$ declare h json; begin
  h := dq_customer_home();
  perform pg_temp.ok('customer home shows product photos, the review and the shop logo', h->'orders'->0->'review'->>'rating' = '5'
     and h->'orders'->0->>'business_logo' like '%logo.jpg' and (h->'orders'->0->'items'->0)::jsonb ? 'image', (h->'orders'->0)::text);
end $$;

do $$ declare rep text; begin
  select format(E'%s/%s passed\n', count(*) filter (where ok), count(*)) ||
         string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || coalesce(' — ' || case when ok then null else info end, ''), E'\n' order by n)
    into rep from t_res;
  raise exception E'TEST REPORT (rolled back)\n%', rep;
end $$;
