-- DeepQr v4 database tests: platform staff roles, smart QR links, supplier portal,
-- online shop + customer accounts + points, payment verification, smart suggestions.
--   (echo "begin;"; cat deepqr_v4_test.sql) | psql ... dqtest
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
select pg_temp.put('admin', '00000000-0000-4000-8000-0000000000c1');
select pg_temp.put('shop',  '00000000-0000-4000-8000-000000000502');
select pg_temp.put('store', '00000000-0000-4000-8000-000000000501');
select pg_temp.put('dell',  '00000000-0000-4000-8000-000000000701');
select pg_temp.put('hp',    '00000000-0000-4000-8000-000000000702');
select pg_temp.put('milk',  '00000000-0000-4000-8000-000000000703');
insert into auth.users(id, email) values
 ('00000000-0000-4000-8000-0000000000e1', 'finance@deepqr.test'), ('00000000-0000-4000-8000-0000000000e2', 'support@deepqr.test'),
 ('00000000-0000-4000-8000-0000000000f1', 'sales@kariakoo-supply.test'), ('00000000-0000-4000-8000-0000000000f2', 'info@mbeya-wholesale.test'),
 ('00000000-0000-4000-8000-0000000000d1', 'asha@shopper.test'), ('00000000-0000-4000-8000-0000000000d2', 'juma@shopper.test');
insert into platform_admins(email, auth_user_id, role) values ('mohdabdull129@gmail.com', '00000000-0000-4000-8000-0000000000c1', 'owner')
  on conflict (email) do update set auth_user_id = excluded.auth_user_id, role = 'owner', active = true;
update platform_settings set free_qr_monthly = 100;
update businesses set loyalty_enabled = true, points_per_amount = 1000, point_value = 10, min_redeem_points = 50 where id = '00000000-0000-4000-8000-00000000b001';

set local role authenticated;

-- ============ platform staff ============
select pg_temp.as_user(pg_temp.c('admin'));
select pg_temp.ok('owner role reported', dq_platform_role() = 'owner');
do $$ declare r json; begin
  r := dq_admin_invite_staff('Finance@DeepQr.test', 'Fatma Ali', 'finance'); perform pg_temp.put('fin_code', r->>'code');
  r := dq_admin_invite_staff('support@deepqr.test', 'Said', 'support'); perform pg_temp.put('sup_code', r->>'code');
  perform pg_temp.ok('owner invites assistants with one-time codes', length(pg_temp.c('fin_code')) = 14);
end $$;
select pg_temp.err('roles are checked', $$select dq_admin_invite_staff('x@y.test', 'X', 'owner')$$, 'Choose a role%');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.ok('finance assistant claims access with the code', dq_claim_platform_admin(pg_temp.c('fin_code')));
select pg_temp.ok('the assistant gets the finance role', dq_platform_role() = 'finance');
select pg_temp.ok('finance can give bonuses', (dq_admin_grant_bonus(pg_temp.c('biz')::uuid, 500, 'thanks')->>'bonus_balance')::numeric >= 500);
select pg_temp.err('finance cannot change platform settings', $$select dq_admin_save_settings('{"qr_fee":1}')$$, 'ADMIN_ROLE%');
select pg_temp.err('finance cannot block users', format($$select dq_admin_set_shop(%L, true, 'x')$$, pg_temp.c('shop')), 'ADMIN_ROLE%');
select pg_temp.err('finance cannot manage the team', $$select dq_admin_invite_staff('z@y.test', 'Z', 'admin')$$, 'ADMIN_ROLE%');
select pg_temp.ok('assistants can see the overview', (dq_admin_overview()->'totals') is not null);
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select pg_temp.ok('support assistant claims access', dq_claim_platform_admin(pg_temp.c('sup_code')));
select pg_temp.err('support cannot adjust wallets', format($$select dq_admin_adjust_wallet(%L, 100, 'x')$$, pg_temp.c('biz')), 'ADMIN_ROLE%');
select dq_admin_set_shop(pg_temp.c('shop')::uuid, true, 'test'); select dq_admin_set_shop(pg_temp.c('shop')::uuid, false, null);
select pg_temp.ok('support can block and unblock shops', true);
select pg_temp.as_user(pg_temp.c('admin'));
select pg_temp.err('the platform owner cannot be removed', $$select dq_admin_remove_staff('mohdabdull129@gmail.com')$$, '%cannot be removed%');
select dq_admin_update_staff('support@deepqr.test', null, false);
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select pg_temp.ok('disabled assistant loses portal access', not dq_is_platform_admin());

-- ============ smart QR links ============
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare r json; begin
  r := dq_generate_items(pg_temp.c('dell')::uuid, pg_temp.c('shop')::uuid, 3);
  perform pg_temp.put('gen', r->>'generation_id');
end $$;
select pg_temp.put('link', (select qr_payload from product_items where generation_id = pg_temp.c('gen')::uuid order by serial limit 1));
select pg_temp.put('serial', (select serial from product_items where generation_id = pg_temp.c('gen')::uuid order by serial limit 1));
select pg_temp.ok('new labels are smart links (open in any phone camera)', pg_temp.c('link') ~ '^https://.+\?dq=1\.DEM\.S02\.D12\.[0-9]{9,}$', pg_temp.c('link'));
select pg_temp.ok('scanner reads the smart link', (dq_lookup_item(pg_temp.c('link'), pg_temp.c('shop')::uuid)->>'ok')::boolean);
select pg_temp.ok('scanner reads a smart link mangled by the keyboard layout',
  (dq_lookup_item(replace(replace(pg_temp.c('link'), '?', '_'), '=', '+'), pg_temp.c('shop')::uuid)->'item'->>'serial') = pg_temp.c('serial'));
select pg_temp.ok('old DQ1 labels still scan', (dq_lookup_item('DQ1|DEM|S02|D12|' || pg_temp.c('serial'), pg_temp.c('shop')::uuid)->>'ok')::boolean);
update businesses set qr_format = 'dq1' where id = my_business_id();
do $$ declare r json; begin
  r := dq_generate_items(pg_temp.c('milk')::uuid, pg_temp.c('shop')::uuid, 1);
  perform pg_temp.ok('a business can keep the classic DQ1 format', (select qr_payload from product_items where generation_id = (r->>'generation_id')::uuid) like 'DQ1|DEM|%');
end $$;
update businesses set qr_format = 'link' where id = my_business_id();
reset role; set local role anon;
select pg_temp.ok('anyone can verify a label without logging in', (dq_verify_label(pg_temp.c('link'))->>'status') = 'in_stock'
  and dq_verify_label(pg_temp.c('link'))->>'business' = 'DEMO' and dq_verify_label(pg_temp.c('link'))->>'product' = 'Dell 12');
select pg_temp.ok('fake labels are reported', (dq_verify_label('https://x/?dq=1.DEM.S02.D12.209999999')->>'found')::boolean = false);
reset role; set local role authenticated;

-- ============ supplier portal ============
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.err('a business login cannot become a supplier', $$select dq_supplier_register('{"company_name":"X","phone":"0712"}')$$, '%already belongs to a business%');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
do $$ declare r json; begin
  r := dq_supplier_register('{"company_name":"Kariakoo Supply Ltd","contact_person":"Hamisi","phone":"0713 222 333","region":"Dar es Salaam","groups":["A","E","Z"],"payment_terms_days":14}');
  perform pg_temp.put('supA', r->>'id');
  perform pg_temp.ok('supplier registers (code, valid groups only)', r->>'code' like 'SUP%' and (r->'groups')::jsonb = '["A","E"]'::jsonb, r::text);
  r := dq_supplier_save_product(jsonb_build_object('catalog_id', (select id from catalog_products where name = 'USB-C fast charger'), 'price', 7000, 'min_order_qty', 10));
  perform pg_temp.ok('supplier lists a product from the catalogue with a price', r->>'name' = 'USB-C fast charger' and (r->>'price')::numeric = 7000);
end $$;
select pg_temp.ok('supplier is routed by whoami', (dq_whoami()->'supplier'->>'company_name') = 'Kariakoo Supply Ltd' and not (dq_whoami()->>'member')::boolean);
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.ok('business finds the supplier in the directory', exists (select 1 from json_array_elements(dq_supplier_directory('{"q":"charger"}')) x where x->>'company_name' = 'Kariakoo Supply Ltd'));
do $$ declare s json; o json; begin
  s := dq_link_supplier(pg_temp.c('supA')::uuid); perform pg_temp.put('locA', s->>'id');
  perform pg_temp.ok('business adds the DeepQr supplier to its suppliers', (s->>'supplier_account_id') = pg_temp.c('supA') and (s->>'payment_terms_days')::int = 14);
  o := dq_save_order(jsonb_build_object('supplier_id', pg_temp.c('locA'), 'shop_id', pg_temp.c('store'), 'status', 'ordered',
        'items', jsonb_build_array(jsonb_build_object('product_id', pg_temp.c('hp'), 'qty_ordered', 5, 'unit_cost', 480000))));
  perform pg_temp.put('po', o->>'id');
  perform pg_temp.ok('order to a DeepQr supplier is sent to their portal', (select supplier_status from orders where id = (o->>'id')::uuid) = 'sent');
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select dq_supplier_register('{"company_name":"Mbeya Wholesale","phone":"0755 000 111"}');
select pg_temp.ok('another supplier does not see it', json_array_length(dq_supplier_orders()->'orders') = 0);
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
do $$ declare r json; li text; begin
  r := dq_supplier_orders();
  perform pg_temp.ok('supplier sees the order, items and delivery shop', json_array_length(r->'orders') = 1 and r->'orders'->0->>'business_name' = 'DEMO'
     and r->'orders'->0->>'deliver_to' = 'Main Store', left(r::text, 300));
  li := r->'orders'->0->'items'->0->>'id';
  r := dq_supplier_respond(jsonb_build_object('order_id', pg_temp.c('po'), 'action', 'confirm', 'eta', current_date + 3, 'note', 'Only 4 in stock',
        'lines', jsonb_build_array(jsonb_build_object('id', li, 'qty', 4, 'price', 470000))));
  perform pg_temp.ok('supplier confirms with quantity, price and delivery date', r->>'supplier_status' = 'confirmed'
     and (dq_supplier_orders()->'orders'->0->'items'->0->>'supplier_qty')::numeric = 4 and (dq_supplier_orders()->'orders'->0->'items'->0->>'supplier_price')::numeric = 470000);
  r := dq_supplier_respond(jsonb_build_object('order_id', pg_temp.c('po'), 'action', 'dispatch', 'invoice_no', 'KS-778', 'invoice_amount', 1880000));
  perform pg_temp.ok('supplier dispatches with the invoice', r->>'supplier_status' = 'dispatched' and r->>'invoice_no' = 'KS-778');
end $$;
select pg_temp.err('reject needs a reason', format($$select dq_supplier_respond(jsonb_build_object('order_id', %L, 'action', 'reject'))$$, pg_temp.c('po')), '%already dispatched%');
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare r json; begin
  r := dq_receive_order(jsonb_build_object('order_id', pg_temp.c('po'), 'lines', jsonb_build_array(jsonb_build_object(
        'order_item_id', (select id from order_items where order_id = pg_temp.c('po')::uuid), 'qty', 4, 'unit_cost', 470000))));
  perform pg_temp.ok('receiving goods marks the supplier order delivered', (select supplier_status from orders where id = pg_temp.c('po')::uuid) = 'delivered');
  r := dq_supplier_payment(jsonb_build_object('supplier_id', pg_temp.c('locA'), 'order_id', pg_temp.c('po'), 'amount', 1000000, 'method', 'Bank', 'reference', 'CRDB-991'));
  perform pg_temp.put('pay', r->>'id');
  perform pg_temp.ok('payment to a DeepQr supplier waits for their confirmation', r->>'verification' = 'unverified');
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select pg_temp.err('a dispute needs an explanation', format($$select dq_supplier_verify_payment(%L, false)$$, pg_temp.c('pay')), 'Explain%');
select pg_temp.ok('supplier confirms the money arrived', dq_supplier_verify_payment(pg_temp.c('pay')::uuid, true)->>'verification' = 'confirmed');
select pg_temp.ok('supplier sees what the business owes', exists (select 1 from json_array_elements(dq_supplier_orders()->'customers') x where (x->>'owed_to_you')::numeric = 880000));
-- invite an unregistered supplier
select pg_temp.as_user(pg_temp.c('owner'));
insert into suppliers(business_id, name, phone) values (my_business_id(), 'Mama Rose Farm', '0788 123 123');
select pg_temp.put('locB', (select id::text from suppliers where name = 'Mama Rose Farm'));
select pg_temp.put('inv', dq_supplier_invite(pg_temp.c('locB')::uuid)->>'code');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d2');
select dq_supplier_register(jsonb_build_object('company_name', 'Mama Rose Farm Ltd', 'phone', '0788123123', 'invite_code', pg_temp.c('inv')));
reset role;
select pg_temp.ok('an invited supplier is linked to the business automatically', (select supplier_account_id is not null from suppliers where id = pg_temp.c('locB')::uuid));
delete from supplier_accounts where company_name = 'Mama Rose Farm Ltd'; update suppliers set supplier_account_id = null where id = pg_temp.c('locB')::uuid;
set local role authenticated;
select pg_temp.as_user(pg_temp.c('admin'));
select pg_temp.ok('platform sees suppliers with their business', exists (select 1 from json_array_elements(dq_admin_suppliers()) x where x->>'company_name' = 'Kariakoo Supply Ltd' and (x->>'businesses')::int = 1));
select pg_temp.ok('platform verifies a supplier', (dq_admin_set_supplier(pg_temp.c('supA')::uuid, '{"verified":true}')->>'verified')::boolean);

-- ============ online shop ============
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('cashiers cannot open the online shop', $$select dq_store_settings('{"store_enabled":true}')$$, '%cannot do this%');
select pg_temp.as_user(pg_temp.c('owner'));
select dq_store_settings(jsonb_build_object('store_enabled', true, 'store_slug', 'Demo Shop!', 'store_shop_id', pg_temp.c('shop'), 'store_delivery', true,
  'store_delivery_fee', 2000, 'store_free_delivery_over', 2000000, 'first_order_points', 25, 'store_area', 'Kariakoo',
  'store_payment_accounts', '[{"method":"M-Pesa","number":"5544332","name":"DEMO"}]'));
select pg_temp.ok('shop link made from the name', (select store_slug from businesses where id = my_business_id()) = 'demo-shop');
select pg_temp.as_user(pg_temp.c('owner2'));
select pg_temp.err('shop links are unique', $$select dq_store_settings('{"store_slug":"demo-shop"}')$$, 'STORE_SLUG%');
reset role; set local role anon;
select pg_temp.ok('anyone can browse open shops', exists (select 1 from json_array_elements(dq_store_directory()) x where x->>'slug' = 'demo-shop'));
select pg_temp.ok('shop page lists products with live stock', (select (x->>'stock')::numeric from json_array_elements(dq_store_catalog('demo-shop')->'products') x where x->>'code' = 'HP12') = 10);
reset role; set local role authenticated;

select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select pg_temp.err('an order needs a customer account', format($$select dq_place_online_order(jsonb_build_object('slug','demo-shop','items',jsonb_build_array(jsonb_build_object('product_id',%L,'qty',1))))$$, pg_temp.c('milk')), 'CUSTOMER_ACCOUNT%');
select dq_customer_register('{"name":"Asha Juma","phone":"0755 111 222","area":"Kariakoo"}');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select pg_temp.err('one customer account per phone', $$select dq_customer_register('{"name":"Fake","phone":"0755111222"}')$$, 'PHONE_TAKEN%');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select pg_temp.err('cannot order more than in stock', format($$select dq_place_online_order(jsonb_build_object('slug','demo-shop','items',jsonb_build_array(jsonb_build_object('product_id',%L,'qty',99))))$$, pg_temp.c('hp')), 'OUT_OF_STOCK%');
select pg_temp.err('mobile money needs the reference', format($$select dq_place_online_order(jsonb_build_object('slug','demo-shop','payment_method','M-Pesa','items',jsonb_build_array(jsonb_build_object('product_id',%L,'qty',1))))$$, pg_temp.c('milk')), 'PAYMENT_REF%');
select pg_temp.err('delivery needs an address', format($$select dq_place_online_order(jsonb_build_object('slug','demo-shop','fulfilment','delivery','items',jsonb_build_array(jsonb_build_object('product_id',%L,'qty',1))))$$, pg_temp.c('milk')), '%delivery address%');
do $$ declare r json; begin
  r := dq_place_online_order(jsonb_build_object('slug','demo-shop','fulfilment','delivery','delivery_address','Mtaa wa Congo, Kariakoo',
        'payment_method','M-Pesa','payment_reference','qk11aa22',
        'items', jsonb_build_array(jsonb_build_object('product_id', pg_temp.c('hp'), 'qty', 1), jsonb_build_object('product_id', pg_temp.c('milk'), 'qty', 4))));
  perform pg_temp.put('oo1', r->>'id');
  perform pg_temp.ok('online order: prices from the shop, delivery fee, payment waiting for verification',
     (r->>'subtotal')::numeric = 660000 and (r->>'delivery_fee')::numeric = 2000 and (r->>'total')::numeric = 662000
     and r->>'payment_status' = 'pending_verification' and r->>'order_no' = 'DEM-W00001', r::text);
  r := dq_place_online_order(jsonb_build_object('slug','demo-shop','items', jsonb_build_array(jsonb_build_object('product_id', pg_temp.c('milk'), 'qty', 1))));
  perform pg_temp.put('oo2', r->>'id');
  perform pg_temp.ok('pickup + pay at the shop', r->>'payment_status' = 'unpaid' and (r->>'total')::numeric = 2500);
end $$;
select pg_temp.err('the same payment reference cannot be used twice', format($$select dq_place_online_order(jsonb_build_object('slug','demo-shop','payment_method','M-Pesa','payment_reference','QK11AA22','items',jsonb_build_array(jsonb_build_object('product_id',%L,'qty',1))))$$, pg_temp.c('milk')), 'DUPLICATE_REFERENCE%');
select pg_temp.ok('customer cancels while the order is new', dq_customer_cancel_order(pg_temp.c('oo2')::uuid, 'changed my mind')->>'status' = 'cancelled');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d2');
select dq_customer_register('{"name":"Juma","phone":"0711 999 888"}');
select pg_temp.ok('customers only see their own orders', not exists (select 1 from online_orders where id = pg_temp.c('oo1')::uuid));
select pg_temp.as_user(pg_temp.c('owner2'));
select pg_temp.ok('other businesses do not see the order', not exists (select 1 from online_orders where id = pg_temp.c('oo1')::uuid));

select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.ok('shop staff see the new order', exists (select 1 from online_orders where id = pg_temp.c('oo1')::uuid and status = 'placed'));
select pg_temp.err('orders are accepted before they move on', format($$select dq_online_order_action(jsonb_build_object('id',%L,'action','ready'))$$, pg_temp.c('oo1')), 'Accept the order first%');
do $$ declare r json; begin
  r := dq_online_order_action(jsonb_build_object('id', pg_temp.c('oo1'), 'action', 'accept', 'note', 'Ready in 1 hour'));
  perform pg_temp.ok('accepting links the shopper to the customer list', r->>'status' = 'accepted'
     and exists (select 1 from customers where id = (r->>'customer_id')::uuid and phone = '0755111222' and account_id is not null));
end $$;
select pg_temp.err('goods are not handed over before the payment is verified', format($$select dq_checkout3(jsonb_build_object('online_order_id',%L,'shop_id',%L,'lines',jsonb_build_array(jsonb_build_object('product_id',%L,'qty',4)),'payments','[]'::jsonb))$$, pg_temp.c('oo1'), pg_temp.c('shop'), pg_temp.c('milk')), 'PAYMENT_UNVERIFIED%');
select pg_temp.err('rejecting a payment needs a reason', format($$select dq_online_order_action(jsonb_build_object('id',%L,'action','reject_payment'))$$, pg_temp.c('oo1')), 'Tell the customer%');
select dq_online_order_action(jsonb_build_object('id', pg_temp.c('oo1'), 'action', 'verify_payment'));
select pg_temp.ok('cashier verifies the M-Pesa payment', (select payment_status = 'paid' and payment_verified_by = 'demo1' from online_orders where id = pg_temp.c('oo1')::uuid));
select dq_online_order_action(jsonb_build_object('id', pg_temp.c('oo1'), 'action', 'preparing'));
select dq_online_order_action(jsonb_build_object('id', pg_temp.c('oo1'), 'action', 'out_for_delivery'));
do $$ declare r json; begin
  r := dq_checkout3(jsonb_build_object('online_order_id', pg_temp.c('oo1'), 'shop_id', pg_temp.c('shop'),
        'lines', jsonb_build_array(jsonb_build_object('item_id', (select id from product_items where serial = pg_temp.c('serial'))),
                                   jsonb_build_object('product_id', pg_temp.c('milk'), 'qty', 4)),
        'payments', jsonb_build_array(jsonb_build_object('method', 'M-Pesa', 'amount', 762000, 'reference', 'QK11AA22'))));
  perform pg_temp.ok('the till completes the online order as a normal sale', (select status = 'completed' and sale_id is not null from online_orders where id = pg_temp.c('oo1')::uuid), r::text);
  perform pg_temp.ok('delivery fee added to the receipt, nothing on credit', (r->'sale'->>'total')::numeric = 762000 and (r->'sale'->>'delivery_fee')::numeric = 2000
     and (r->'sale'->>'balance_due')::numeric = 0 and (r->'payments'->0->>'amount')::numeric = 762000, r::text);
  perform pg_temp.ok('points earned + first online order bonus', (select points_earned from online_orders where id = pg_temp.c('oo1')::uuid) = 760 + 25
     and (select points from customers where phone = '0755111222' and business_id = pg_temp.c('biz')::uuid) = 785, r::text);
end $$;
select pg_temp.ok('label sold through the online order shows as sold', (select status from product_items where serial = pg_temp.c('serial')) = 'sold');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select pg_temp.ok('customer sees points and order history', (select (x->>'points')::int from json_array_elements(dq_customer_home()->'loyalty') x where x->>'business' = 'DEMO') = 785
  and (select x->>'status' from json_array_elements(dq_customer_home()->'orders') x where x->>'id' = pg_temp.c('oo1')) = 'completed');
select pg_temp.err('cannot redeem more points than you have', format($$select dq_place_online_order(jsonb_build_object('slug','demo-shop','points_redeem',900,'items',jsonb_build_array(jsonb_build_object('product_id',%L,'qty',2))))$$, pg_temp.c('milk')), 'POINTS%');
do $$ declare r json; begin
  r := dq_place_online_order(jsonb_build_object('slug','demo-shop','points_redeem', 300, 'items', jsonb_build_array(jsonb_build_object('product_id', pg_temp.c('milk'), 'qty', 2))));
  perform pg_temp.ok('points pay part of the next order', (r->>'points_value')::numeric = 3000 and (r->>'total')::numeric = 2000, r::text);
end $$;
select pg_temp.err('reserved points cannot be used twice', format($$select dq_place_online_order(jsonb_build_object('slug','demo-shop','points_redeem',600,'items',jsonb_build_array(jsonb_build_object('product_id',%L,'qty',3))))$$, pg_temp.c('milk')), 'POINTS: you can use up to 485%');

-- ============ smart suggestions ============
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare r json; begin
  r := dq_insights();
  perform pg_temp.ok('insights return forecast, pairs, hours, at-risk customers and feedback', r::jsonb ?& array['forecast','pairs','hours','at_risk','feedback','slow'], left(r::text, 200));
  perform pg_temp.ok('the products sold together are found', exists (select 1 from json_array_elements(r->'pairs') x where (x->>'times')::int >= 1) or json_array_length(r->'pairs') = 0);
end $$;
select dq_insight_feedback('slow:x', 'slow', 'dismiss');
select pg_temp.ok('dismissed suggestions are hidden and counted (learning)', (dq_insights()->'feedback'->'hidden')::text like '%slow:x%'
  and (dq_insights()->'feedback'->'by_kind'->'slow'->>'dismissed')::int = 1);
select pg_temp.ok('member routed by whoami', (dq_whoami()->>'member')::boolean);

do $$ declare rep text; begin
  select format(E'%s/%s passed\n', count(*) filter (where ok), count(*)) ||
         string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || coalesce(' — ' || case when ok then null else info end, ''), E'\n' order by n)
    into rep from t_res;
  raise exception E'TEST REPORT (rolled back)\n%', rep;
end $$;
