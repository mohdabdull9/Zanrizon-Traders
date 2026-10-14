-- DeepQr v5 database tests: online shop products (price, photos, visibility), every selling
-- branch online with its own stock, delivery priced by distance, product showcase.
--   (echo "begin;"; cat deepqr_v5_test.sql) | psql ... dqtest
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
select pg_temp.put('wh',    '00000000-0000-4000-8000-000000000501');   -- Main Store (warehouse)
select pg_temp.put('mz1',   '00000000-0000-4000-8000-000000000502');   -- MZ1 (shop)
select pg_temp.put('dell',  '00000000-0000-4000-8000-000000000701');
select pg_temp.put('hp',    '00000000-0000-4000-8000-000000000702');
select pg_temp.put('milk',  '00000000-0000-4000-8000-000000000703');
insert into auth.users(id, email) values ('00000000-0000-4000-8000-0000000000d1', 'c255755111222@shoppers.deepqr.local');
-- a second selling branch with its own stock
insert into shops(id, business_id, name, type, code) values ('00000000-0000-4000-8000-000000000509', '00000000-0000-4000-8000-00000000b001', 'Mbezi Branch', 'shop', 'S03');
insert into stock_levels(business_id, shop_id, product_id, qty) values ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-000000000509', '00000000-0000-4000-8000-000000000703', 4)
  on conflict do nothing;
select pg_temp.put('mbezi', '00000000-0000-4000-8000-000000000509');
update products set price = 0 where id = '00000000-0000-4000-8000-000000000703';  -- milk has no price yet

set local role authenticated;
select pg_temp.ok('database version 5', dq_version() = 5);

-- ============ shop settings: branches and delivery by distance ============
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.err('a warehouse cannot be the online branch', format($$select dq_store_settings(jsonb_build_object('store_shop_id', %L))$$, pg_temp.c('wh')), '%not a warehouse%');
select pg_temp.err('distance pricing needs a branch on the map', $$select dq_store_settings(jsonb_build_object('store_enabled', true, 'store_slug', 'demo-shop',
   'store_delivery', true, 'store_delivery_mode', 'distance', 'store_base_fee', 1000, 'store_base_km', 2, 'store_per_km', 500, 'store_max_km', 15))$$, 'LOCATION%');
select pg_temp.err('delivery prices cannot be negative', $$select dq_store_settings('{"store_per_km": -5}')$$, '%negative%');
do $$ declare r json; begin
  r := dq_store_settings(jsonb_build_object('store_enabled', true, 'store_slug', 'demo-shop', 'store_pickup', true, 'store_delivery', true,
        'store_delivery_mode', 'distance', 'store_base_fee', 1000, 'store_base_km', 2, 'store_per_km', 500, 'store_max_km', 15, 'store_fee_round', 100,
        'store_shop_id', pg_temp.c('mz1'), 'store_pay_on_collection', true,
        'branches', jsonb_build_array(
          jsonb_build_object('id', pg_temp.c('mz1'), 'online', true, 'lat', -6.8190, 'lng', 39.2730, 'address', 'Msimbazi St, Kariakoo'),
          jsonb_build_object('id', pg_temp.c('mbezi'), 'online', true, 'lat', -6.7300, 'lng', 39.1500, 'per_km', 800),
          jsonb_build_object('id', pg_temp.c('wh'), 'online', true))));
  perform pg_temp.ok('shop opened with delivery priced by distance', r->'business'->>'store_delivery_mode' = 'distance'
     and (r->'business'->>'store_per_km')::numeric = 500 and (r->'business'->>'store_base_km')::numeric = 2, r::text);
end $$;
select pg_temp.ok('branch location and own per-km price saved', (select lat = -6.8190 and lng = 39.2730 and address = 'Msimbazi St, Kariakoo' from shops where id = pg_temp.c('mz1')::uuid)
   and (select delivery_per_km from shops where id = pg_temp.c('mbezi')::uuid) = 800);
select pg_temp.ok('a warehouse never takes online orders', not (select online from shops where id = pg_temp.c('wh')::uuid));
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('cashiers cannot change delivery prices', $$select dq_store_settings('{"store_per_km": 100}')$$, '%cannot do this%');

-- ============ shop products: prices, photos, visibility ============
select pg_temp.err('cashiers cannot edit shop products', format($$select dq_store_products_save(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', %L, 'price', 1))))$$, pg_temp.c('milk')), '%cannot do this%');
select pg_temp.as_user(pg_temp.c('owner'));
reset role; set local role anon;
select pg_temp.ok('products without a price are hidden from customers', not exists (select 1 from json_array_elements(dq_store_catalog('demo-shop')->'products') x where x->>'id' = pg_temp.c('milk')));
reset role; set local role authenticated;
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.err('photos must be uploaded through DeepQr', format($$select dq_store_products_save(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', %L, 'photos', jsonb_build_array('https://evil.example/x.jpg')))))$$, pg_temp.c('milk')), 'PHOTO%');
select pg_temp.err('photos of another business are refused', format($$select dq_store_products_save(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', %L, 'photos', jsonb_build_array('https://x.supabase.co/storage/v1/object/public/dq-public/p/00000000-0000-4000-8000-00000000b002/a.jpg')))))$$, pg_temp.c('milk')), 'PHOTO%');
select pg_temp.err('negative prices refused', format($$select dq_store_products_save(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', %L, 'price', -1))))$$, pg_temp.c('milk')), '%negative%');
do $$ declare r json; v_url text := 'https://x.supabase.co/storage/v1/object/public/dq-public/p/' || pg_temp.c('biz') || '/milk-1.jpg'; begin
  r := dq_store_products_save(jsonb_build_object('items', jsonb_build_array(
         jsonb_build_object('id', pg_temp.c('milk'), 'price', 2800, 'online', true, 'featured', true, 'description', 'Fresh full-cream milk',
                            'photos', jsonb_build_array(v_url, replace(v_url, '-1', '-2'))),
         jsonb_build_object('id', pg_temp.c('hp'), 'online', false))));
  perform pg_temp.ok('owner sets price, photos, description and featured in one save', json_array_length(r) = 2
     and (select price = 2800 and image_url = v_url and jsonb_array_length(photos) = 2 and online_featured and description = 'Fresh full-cream milk'
            from products where id = pg_temp.c('milk')::uuid), r::text);
end $$;
select pg_temp.ok('the save is logged', exists (select 1 from activity_log where business_id = pg_temp.c('biz')::uuid and description like 'Online shop products updated: 2 product(s), 1 price change(s)%'));
select pg_temp.as_user(pg_temp.c('owner2'));
select pg_temp.err('another business cannot edit these products', format($$select dq_store_products_save(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', %L, 'price', 1))))$$, pg_temp.c('milk')), 'Product not found%');

-- ============ the public shop ============
reset role; set local role anon;
do $$ declare c json; m json; begin
  c := dq_store_catalog('demo-shop');
  perform pg_temp.ok('shop lists selling branches only (no warehouse)', (select count(*) from json_array_elements(c->'branches')) = 2
     and not exists (select 1 from json_array_elements(c->'branches') x where x->>'id' = pg_temp.c('wh')), (c->'branches')::text);
  perform pg_temp.ok('default branch is the chosen one', c->>'branch' = pg_temp.c('mz1'));
  select x into m from json_array_elements(c->'products') x where x->>'id' = pg_temp.c('milk');
  perform pg_temp.ok('product shows price, photo and stock per branch', (m->>'price')::numeric = 2800 and m->>'image_url' like '%milk-1.jpg'
     and (m->>'stock')::numeric = 30 and (m->'stock_by'->>pg_temp.c('mbezi'))::numeric = 4, m::text);
  perform pg_temp.ok('featured products come first', (c->'products'->0->>'id') = pg_temp.c('milk'));
  perform pg_temp.ok('hidden products are not shown', not exists (select 1 from json_array_elements(c->'products') x where x->>'id' = pg_temp.c('hp')));
  c := dq_store_catalog('demo-shop', pg_temp.c('mbezi')::uuid);
  perform pg_temp.ok('choosing a branch shows that branch''s stock', c->>'branch' = pg_temp.c('mbezi')
     and (select (x->>'stock')::numeric from json_array_elements(c->'products') x where x->>'id' = pg_temp.c('milk')) = 4);
end $$;
select pg_temp.err('a warehouse cannot be chosen as a branch', format($$select dq_store_catalog('demo-shop', %L)$$, pg_temp.c('wh')), 'BRANCH%');
select pg_temp.ok('directory shows product photos and branches', (select (x->>'branches')::int = 2 and (x->'images'->>0) like '%milk-1.jpg'
   from json_array_elements(dq_store_directory()) x where x->>'slug' = 'demo-shop'));
select pg_temp.ok('sign-in showcase shows real products with photos', exists (select 1 from json_array_elements(dq_store_showcase()) x where x->>'name' = 'Milk 1L' and x->>'slug' = 'demo-shop'));

-- ============ delivery quotes ============
do $$ declare q json; v_km numeric; begin
  q := dq_delivery_quote(jsonb_build_object('slug', 'demo-shop'));
  perform pg_temp.ok('delivery by distance asks for the location', not (q->>'ok')::boolean and (q->>'need_location')::boolean, q::text);
  q := dq_delivery_quote(jsonb_build_object('slug', 'demo-shop', 'lat', -6.8195, 'lng', 39.2735, 'subtotal', 5000));
  perform pg_temp.ok('next door: base fee only', (q->>'ok')::boolean and (q->>'fee')::numeric = 1000 and (q->>'km')::numeric < 1, q::text);
  q := dq_delivery_quote(jsonb_build_object('slug', 'demo-shop', 'lat', -6.7920, 'lng', 39.2730, 'subtotal', 5000));
  v_km := round(dq_km(-6.8190, 39.2730, -6.7920, 39.2730) * 1.3, 1);
  perform pg_temp.ok('about 3 km away: base + each km after the first 2, rounded up to 100',
     (q->>'km')::numeric = v_km and (q->>'fee')::numeric = ceil((1000 + ceil(v_km - 2) * 500) / 100) * 100 and (q->>'fee')::numeric = 2000, q::text);
  q := dq_delivery_quote(jsonb_build_object('slug', 'demo-shop', 'shop_id', pg_temp.c('mbezi'), 'lat', -6.7030, 'lng', 39.1500, 'subtotal', 5000));
  v_km := round(dq_km(-6.7300, 39.1500, -6.7030, 39.1500) * 1.3, 1);
  perform pg_temp.ok('a branch can charge its own price per km', (q->>'fee')::numeric = ceil((1000 + ceil(v_km - 2) * 800) / 100) * 100, q::text);
  q := dq_delivery_quote(jsonb_build_object('slug', 'demo-shop', 'lat', -6.6500, 'lng', 39.2730, 'subtotal', 5000));
  perform pg_temp.ok('too far away is refused with the distance', not (q->>'ok')::boolean and q->>'reason' like '%delivers up to 15 km%', q::text);
end $$;

-- ============ placing orders ============
reset role; set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select dq_customer_register('{"name":"Asha Juma","phone":"0755 111 222"}');
select pg_temp.err('delivery by distance needs the customer''s location', format($$select dq_place_online_order(jsonb_build_object('slug','demo-shop','fulfilment','delivery','delivery_address','Upanga','items',jsonb_build_array(jsonb_build_object('product_id',%L,'qty',1))))$$, pg_temp.c('milk')), 'DELIVERY: Set your delivery location%');
select pg_temp.err('stock is checked at the chosen branch', format($$select dq_place_online_order(jsonb_build_object('slug','demo-shop','shop_id',%L,'items',jsonb_build_array(jsonb_build_object('product_id',%L,'qty',5))))$$, pg_temp.c('mbezi'), pg_temp.c('milk')), 'OUT_OF_STOCK: only 4 % at Mbezi Branch');
do $$ declare r json; begin
  r := dq_place_online_order(jsonb_build_object('slug','demo-shop','fulfilment','delivery','delivery_address','Mtaa wa Congo','lat',-6.7920,'lng',39.2730,
        'items', jsonb_build_array(jsonb_build_object('product_id', pg_temp.c('milk'), 'qty', 2))));
  perform pg_temp.ok('order priced by distance: fee, km and location stored', (r->>'delivery_fee')::numeric = 2000 and (r->>'delivery_km')::numeric > 3
     and (r->>'delivery_lat')::numeric = -6.7920 and (r->>'subtotal')::numeric = 5600 and (r->>'total')::numeric = 7600 and r->>'shop_id' = pg_temp.c('mz1'), r::text);
  r := dq_place_online_order(jsonb_build_object('slug','demo-shop','shop_id', pg_temp.c('mbezi'),
        'items', jsonb_build_array(jsonb_build_object('product_id', pg_temp.c('milk'), 'qty', 4))));
  perform pg_temp.ok('pickup at the branch the customer chose', r->>'shop_id' = pg_temp.c('mbezi') and (r->>'delivery_fee')::numeric = 0, r::text);
end $$;
select pg_temp.as_user(pg_temp.c('owner'));
select dq_store_settings('{"store_free_delivery_over": 5000}');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
do $$ declare r json; begin
  r := dq_place_online_order(jsonb_build_object('slug','demo-shop','fulfilment','delivery','delivery_address','Mtaa wa Congo','lat',-6.7920,'lng',39.2730,
        'items', jsonb_build_array(jsonb_build_object('product_id', pg_temp.c('milk'), 'qty', 2))));
  perform pg_temp.ok('free delivery above the threshold', (r->>'delivery_fee')::numeric = 0, r::text);
end $$;
select pg_temp.as_user(pg_temp.c('owner'));
select dq_store_settings('{"store_delivery_mode": "flat", "store_delivery_fee": 3000, "store_free_delivery_over": null, "branches": [{"id": "00000000-0000-4000-8000-000000000509", "base_fee": 4500}]}');
reset role; set local role anon;
select pg_temp.ok('flat fee, with a branch''s own fee', (dq_delivery_quote('{"slug":"demo-shop"}')->>'fee')::numeric = 3000
   and (dq_delivery_quote('{"slug":"demo-shop","shop_id":"00000000-0000-4000-8000-000000000509"}')->>'fee')::numeric = 4500);
reset role; set local role authenticated;
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.err('closing every branch is refused while the shop is open', format($$select dq_store_settings(jsonb_build_object('branches', jsonb_build_array(jsonb_build_object('id', %L, 'online', false), jsonb_build_object('id', %L, 'online', false))))$$, pg_temp.c('mz1'), pg_temp.c('mbezi')), '%at least one selling branch%');

do $$ declare rep text; begin
  select format(E'%s/%s passed\n', count(*) filter (where ok), count(*)) ||
         string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || coalesce(' — ' || case when ok then null else info end, ''), E'\n' order by n)
    into rep from t_res;
  raise exception E'TEST REPORT (rolled back)\n%', rep;
end $$;
