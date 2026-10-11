-- DeepQr v2 database tests. Runs inside one transaction and ends by raising the report,
-- which rolls everything back. Needs the local seed (supabase/tests/local/02_seed.sql).
--   begin; \i deepqr_v2_test.sql
create temp table t_res(n serial, name text, ok boolean, info text);
create temp table t_ctx(k text primary key, v text);
grant all on t_res, t_ctx to authenticated; grant usage on sequence t_res_n_seq to authenticated;
create or replace function pg_temp.ok(p_name text, p_ok boolean, p_info text default null) returns void
language sql as $$ insert into t_res(name, ok, info) values (p_name, coalesce(p_ok, false), p_info) $$;
create or replace function pg_temp.c(p_k text) returns text language sql as $$ select v from t_ctx where k = p_k $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into t_ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.as_user(p_uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true) $$;
-- expect an error whose message starts with p_like
create or replace function pg_temp.err(p_name text, p_sql text, p_like text) returns void language plpgsql as $$
begin
  -- each API request is its own transaction; drop the trusted flag a previous call left behind
  perform set_config('dq.trusted', 'off', true);
  execute p_sql;
  perform pg_temp.ok(p_name, false, 'no error raised');
exception when others then
  perform pg_temp.ok(p_name, sqlerrm like p_like, sqlerrm);
end $$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.put('biz',     '00000000-0000-4000-8000-00000000b001');
select pg_temp.put('biz2',    '00000000-0000-4000-8000-00000000b002');
select pg_temp.put('owner',   '00000000-0000-4000-8000-0000000000a1');
select pg_temp.put('cashier', '00000000-0000-4000-8000-0000000000a2');
select pg_temp.put('manager', '00000000-0000-4000-8000-0000000000a3');
select pg_temp.put('owner2',  '00000000-0000-4000-8000-0000000000b1');
select pg_temp.put('admin',   '00000000-0000-4000-8000-0000000000c1');
select pg_temp.put('store',   '00000000-0000-4000-8000-000000000501');
select pg_temp.put('shop',    '00000000-0000-4000-8000-000000000502');
select pg_temp.put('dell',    '00000000-0000-4000-8000-000000000701');
select pg_temp.put('hp',      '00000000-0000-4000-8000-000000000702');
select pg_temp.put('milk',    '00000000-0000-4000-8000-000000000703');
insert into auth.users(id, email) values ('00000000-0000-4000-8000-0000000000d1', 'hacker@evil.test');
select pg_temp.put('hacker',  '00000000-0000-4000-8000-0000000000d1');
insert into platform_admins(email, claim_code_hash) values ('mohdabdull129@gmail.com', encode(extensions.digest('CODE-1234','sha256'),'hex'))
  on conflict (email) do update set claim_code_hash = excluded.claim_code_hash, auth_user_id = null;

set local role authenticated;

-- ============ security ============
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('cashier cannot promote self', $$update members set role = 'owner' where auth_user_id = auth.uid()$$, '%Only owners and managers%');
select pg_temp.err('cashier cannot clear a platform block', $$update members set blocked_by_platform = true where auth_user_id = auth.uid()$$, 'Only DeepQr%');
update members set theme = 'dark' where auth_user_id = auth.uid();
select pg_temp.ok('cashier can still change own theme', (select theme from members where auth_user_id = auth.uid()) = 'dark');
select pg_temp.as_user(pg_temp.c('hacker'));
select pg_temp.err('outsider cannot join a business', format($$insert into members(business_id, auth_user_id, name, role) values (%L, auth.uid(), 'x', 'owner')$$, pg_temp.c('biz')), '%only create the owner account%');
select pg_temp.err('outsider cannot register a business for someone else', format($$insert into businesses(name, owner_auth_id) values ('Fake', %L)$$, pg_temp.c('owner')), '%your own account%');
select pg_temp.ok('username login lookup works through the function', dq_login_email('demo1') = 'cashier.demo@staff.local');

-- ============ platform admin + credits ============
select pg_temp.as_user(pg_temp.c('admin'));
select pg_temp.ok('platform owner activates portal', dq_claim_platform_admin('code-1234'));
select dq_admin_save_settings('{"qr_fee":25,"free_qr_monthly":5,"bonus_expiry_days":30,"referral_bonus":1000,"referee_bonus":500,"min_topup":1000,
  "payment_accounts":[{"method":"M-Pesa","number":"0777000111","name":"DeepQr Ltd"}]}');
select pg_temp.ok('settings saved', (select free_qr_monthly from platform_settings) = 5);
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.err('owner cannot use admin functions', $$select dq_admin_grant_bonus(my_business_id(), 999, 'x')$$, 'Platform owner%');
select pg_temp.ok('wallet shows 5 free QR this month', (dq_wallet()->>'free_remaining')::int = 5);
select pg_temp.ok('wallet lists payment numbers', (dq_wallet()->'payment_accounts'->0->>'number') = '0777000111');
do $$ declare r json; begin
  r := dq_generate_items(pg_temp.c('dell')::uuid, pg_temp.c('store')::uuid, 3);
  perform pg_temp.ok('3 QR codes use the free quota (cost 0)', (r->>'free')::int = 3 and (r->>'paid')::numeric = 0, r::text);
  perform pg_temp.put('gen1', r->>'generation_id');
end $$;
select pg_temp.err('4 more: 2 free + 2 paid fails on empty wallet',
  format($$select dq_generate_items(%L, %L, 4)$$, pg_temp.c('dell'), pg_temp.c('store')), 'INSUFFICIENT_BALANCE%');
select pg_temp.as_user(pg_temp.c('admin'));
select dq_admin_grant_bonus(pg_temp.c('biz')::uuid, 100, 'Launch gift');
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare r json; begin
  r := dq_generate_items(pg_temp.c('dell')::uuid, pg_temp.c('store')::uuid, 4);
  perform pg_temp.ok('then 2 free + 50 from bonus', (r->>'free')::int = 2 and (r->>'bonus_used')::numeric = 50 and (r->>'paid')::numeric = 0, r::text);
  perform pg_temp.ok('bonus balance left 50', (r->>'bonus_balance')::numeric = 50);
end $$;
select pg_temp.as_user(pg_temp.c('admin'));
select dq_admin_update_account(pg_temp.c('biz')::uuid, '{"fee_override":10,"plan":"gold"}');
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare r json; begin
  r := dq_generate_items(pg_temp.c('milk')::uuid, pg_temp.c('shop')::uuid, 2, current_date + 3, 'LOT1');
  perform pg_temp.ok('custom fee 10 applies (2 × 10 = 20 from bonus)', (r->>'total')::numeric = 20 and (r->>'bonus_used')::numeric = 20, r::text);
  perform pg_temp.put('gen_milk', r->>'generation_id');
end $$;
select pg_temp.ok('recommendations use the custom fee', (select max(fee) from dq_qr_recommendations()) = 10);

-- top-ups with packages, duplicates, approval
do $$ declare r json; k uuid; begin
  select id into k from topup_packages where name = 'Business';
  r := dq_request_topup2(jsonb_build_object('package_id', k, 'method', 'M-Pesa', 'reference', 'qk7h2xlm1p', 'sender_phone', '0777 123 456', 'sender_name', 'Muham'));
  perform pg_temp.put('topup', r->>'id');
  perform pg_temp.ok('package top-up carries its bonus', (r->>'amount')::numeric = 20000 and (r->>'bonus')::numeric = 2000, r::text);
  perform pg_temp.ok('reference is stored upper-case', r->>'reference' = 'QK7H2XLM1P');
end $$;
select pg_temp.err('same reference cannot be submitted twice',
  $$select dq_request_topup2('{"amount":5000,"method":"M-Pesa","reference":"QK7H2XLM1P","sender_phone":"0777"}')$$, 'DUPLICATE_REFERENCE%');
select pg_temp.err('sender phone is required', $$select dq_request_topup2('{"amount":5000,"method":"M-Pesa","reference":"ZZZ999"}')$$, '%phone number%');
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('cashier cannot request top-ups', $$select dq_request_topup2('{"amount":5000,"reference":"ABCD1","sender_phone":"07"}')$$, '%role%');
select pg_temp.as_user(pg_temp.c('admin'));
select pg_temp.err('rejecting needs a reason', format($$select dq_admin_review_topup(%L, false, null)$$, pg_temp.c('topup')), '%reason%');
select dq_admin_review_topup(pg_temp.c('topup')::uuid, true, 'Confirmed on M-Pesa');
reset role;
select pg_temp.ok('approved top-up credits 20000 main + 2000 bonus',
  (select balance from dq_accounts where business_id = pg_temp.c('biz')::uuid) = 20000
  and (select bonus_balance from dq_accounts where business_id = pg_temp.c('biz')::uuid) = 2030,
  (select balance || ' / ' || bonus_balance from dq_accounts where business_id = pg_temp.c('biz')::uuid));
select pg_temp.ok('approved top-up gets a receipt number', (select receipt_no from topup_requests where id = pg_temp.c('topup')::uuid) like 'TU-%');
select pg_temp.ok('bonus gets an expiry date', (select bonus_expires_at > now() + interval '29 days' from dq_accounts where business_id = pg_temp.c('biz')::uuid));
set local role authenticated;

-- promo codes
select pg_temp.as_user(pg_temp.c('admin'));
select dq_admin_save_promo('{"code":"karibu 10","credits":1000,"max_uses":1}');
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.ok('promo code credits bonus', (dq_redeem_promo('karibu10')->>'credits')::numeric = 1000);
select pg_temp.err('promo cannot be reused by the same business', $$select dq_redeem_promo('KARIBU10')$$, 'PROMO_ALREADY%');
select pg_temp.as_user(pg_temp.c('owner2'));
select pg_temp.err('promo respects max uses', $$select dq_redeem_promo('KARIBU10')$$, 'PROMO_USED_UP%');
select pg_temp.err('unknown promo is rejected', $$select dq_redeem_promo('NOPE1234')$$, 'PROMO_INVALID%');

-- referrals
reset role; select pg_temp.put('refcode', (select referral_code from dq_accounts where business_id = pg_temp.c('biz')::uuid)); set local role authenticated;
select pg_temp.ok('referee bonus on applying a referral code', (dq_apply_referral(pg_temp.c('refcode'))->>'bonus')::numeric = 500);
select pg_temp.err('referral code only once', format($$select dq_apply_referral(%L)$$, pg_temp.c('refcode')), '%already applied%');
select pg_temp.put('topup2', dq_request_topup2('{"amount":5000,"method":"Tigo Pesa","reference":"TP55501","sender_phone":"0655000000"}')->>'id');
select pg_temp.as_user(pg_temp.c('admin'));
reset role; select pg_temp.put('demo_bonus_before', (select bonus_balance::text from dq_accounts where business_id = pg_temp.c('biz')::uuid)); set local role authenticated;
select dq_admin_review_topup(pg_temp.c('topup2')::uuid, true, 'ok');
reset role;
select pg_temp.ok('referrer earns 1000 when the referred business first tops up',
  (select bonus_balance from dq_accounts where business_id = pg_temp.c('biz')::uuid) = pg_temp.c('demo_bonus_before')::numeric + 1000);
set local role authenticated;

-- announcements
select pg_temp.as_user(pg_temp.c('admin'));
select dq_admin_save_announcement('{"title":"Maintenance Sunday","body":"Short downtime 02:00","level":"warning"}');
select dq_admin_save_announcement(jsonb_build_object('title','Only for Metro','business_id', pg_temp.c('biz2')));
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.ok('business sees platform-wide announcements only', (select count(*) from announcements) = 1);

-- ============ scanning ============
reset role;
select pg_temp.put('dell1', (select qr_payload from product_items where generation_id = pg_temp.c('gen1')::uuid and serial_seq = 1));
select pg_temp.put('dell1_serial', (select serial from product_items where generation_id = pg_temp.c('gen1')::uuid and serial_seq = 1));
select pg_temp.put('dell2_serial', (select serial from product_items where generation_id = pg_temp.c('gen1')::uuid and serial_seq = 2));
select pg_temp.put('dell3_serial', (select serial from product_items where generation_id = pg_temp.c('gen1')::uuid and serial_seq = 3));
set local role authenticated;
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.ok('scan with normal separators', (dq_lookup_item(pg_temp.c('dell1'))->>'ok')::boolean);
select pg_temp.ok('scan where a keyboard turned | into ~', (dq_lookup_item(replace(pg_temp.c('dell1'), '|', '~'))->>'ok')::boolean);
select pg_temp.ok('scan where | became \ and text is lower-case', (dq_lookup_item(lower(replace(pg_temp.c('dell1'), '|', '\')))->>'ok')::boolean);
select pg_temp.ok('scan with trailing Enter/Tab characters', (dq_lookup_item(pg_temp.c('dell1') || E'\r\n')->>'ok')::boolean);
select pg_temp.ok('product barcode scan returns the product', dq_lookup_item('b-hp12')->>'kind' = 'product');
select pg_temp.ok('item history shows the batch', (dq_item_history(pg_temp.c('dell1_serial'))->'generation'->>'qty')::int = 3);

-- ============ transfers carry labels ============
do $$ declare t json; begin
  t := dq_send_transfer(jsonb_build_object('from_shop', pg_temp.c('store'), 'to_shop', pg_temp.c('shop'), 'product_id', pg_temp.c('dell'),
       'serials', json_build_array(pg_temp.c('dell1_serial'), pg_temp.c('dell2_serial')), 'note', 'to MZ1'));
  perform pg_temp.put('tr1', t->>'id');
  perform pg_temp.ok('transfer with 2 scanned labels sends qty 2', (t->>'qty')::numeric = 2, t::text);
end $$;
select pg_temp.ok('labels on a transfer are in transit', dq_lookup_item(pg_temp.c('dell1'))->>'reason' = 'IN_TRANSIT');
select pg_temp.err('unknown label on transfer is refused',
  format($$select dq_send_transfer(jsonb_build_object('from_shop',%L,'to_shop',%L,'product_id',%L,'serials',json_build_array('999999999')))$$,
         pg_temp.c('store'), pg_temp.c('shop'), pg_temp.c('dell')), 'TRANSFER_LABELS%');
select pg_temp.as_user(pg_temp.c('cashier'));
select dq_receive_transfer(jsonb_build_object('transfer_id', pg_temp.c('tr1')));
reset role;
select pg_temp.ok('received labels now belong to MZ1',
  (select count(*) from product_items where serial in (pg_temp.c('dell1_serial'), pg_temp.c('dell2_serial')) and shop_id = pg_temp.c('shop')::uuid and status = 'in_stock') = 2);
select pg_temp.ok('stock moved 20→18 and 16→18',
  (select qty from stock_levels where shop_id = pg_temp.c('store')::uuid and product_id = pg_temp.c('dell')::uuid) = 18
  and (select qty from stock_levels where shop_id = pg_temp.c('shop')::uuid and product_id = pg_temp.c('dell')::uuid) = 18);
set local role authenticated;
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare t json; begin
  t := dq_send_transfer(jsonb_build_object('from_shop', pg_temp.c('store'), 'to_shop', pg_temp.c('shop'), 'product_id', pg_temp.c('dell'), 'qty', 3));
  t := dq_receive_transfer(jsonb_build_object('transfer_id', t->>'id', 'received_qty', 2));
  perform pg_temp.ok('short delivery records received 2 of 3', (t->>'received_qty')::numeric = 2);
end $$;
select pg_temp.ok('shortage is logged as an adjustment', exists (select 1 from adjustments where reason like 'Transfer shortage%'));
do $$ declare t json; begin
  t := dq_send_transfer(jsonb_build_object('from_shop', pg_temp.c('store'), 'to_shop', pg_temp.c('shop'), 'product_id', pg_temp.c('dell'), 'qty', 1));
  t := dq_cancel_transfer((t->>'id')::uuid);
  perform pg_temp.ok('cancelled transfer returns stock', t->>'status' = 'cancelled'
     and (select qty from stock_levels where shop_id = pg_temp.c('store')::uuid and product_id = pg_temp.c('dell')::uuid) = 15);
end $$;

-- ============ till ============
select pg_temp.as_user(pg_temp.c('cashier'));
do $$ declare s json; begin
  s := dq_open_shift('{"opening_float": 10000}');
  perform pg_temp.put('shift', s->>'id');
  perform pg_temp.ok('cashier opens a shift on own shop', s->>'shop_id' = pg_temp.c('shop'));
end $$;
select pg_temp.err('only one open shift per cashier', $$select dq_open_shift('{}')$$, '%already have an open shift%');

-- cash sale: scanned item + quantity line, change given
do $$ declare r json; begin
  r := dq_checkout2(jsonb_build_object('shop_id', pg_temp.c('shop'),
        'lines', json_build_array(json_build_object('item_id', (select id from product_items where serial = pg_temp.c('dell1_serial'))),
                                  json_build_object('product_id', pg_temp.c('hp'), 'qty', 1)),
        'payments', json_build_array(json_build_object('method','Cash','amount', 1500000))));
  perform pg_temp.put('sale_cash', r->'sale'->>'id');
  perform pg_temp.ok('cash sale total 1,400,000 with 100,000 change',
     (r->'sale'->>'total')::numeric = 1400000 and (r->'sale'->>'change_due')::numeric = 100000, (r->'sale')::text);
  perform pg_temp.ok('cash ledger keeps only the net 1,400,000', (r->'payments'->0->>'amount')::numeric = 1400000);
  perform pg_temp.ok('sale is linked to the shift', r->'sale'->>'shift_id' = pg_temp.c('shift'));
  perform pg_temp.ok('line keeps cost for profit reports', (r->'lines'->0->>'cost')::numeric > 0);
end $$;
select pg_temp.err('mobile money needs a reference',
  format($$select dq_checkout2(jsonb_build_object('shop_id',%L,'lines',json_build_array(json_build_object('product_id',%L,'qty',1)),
         'payments',json_build_array(json_build_object('method','M-Pesa','amount',2500))))$$, pg_temp.c('shop'), pg_temp.c('milk')), 'PAYMENT_REF%');
select pg_temp.err('mobile money cannot exceed the total',
  format($$select dq_checkout2(jsonb_build_object('shop_id',%L,'lines',json_build_array(json_build_object('product_id',%L,'qty',1)),
         'payments',json_build_array(json_build_object('method','M-Pesa','amount',3000,'reference','X1'))))$$, pg_temp.c('shop'), pg_temp.c('milk')), 'Mobile money%');
do $$ declare r json; begin
  r := dq_checkout2(jsonb_build_object('shop_id', pg_temp.c('shop'),
        'lines', json_build_array(json_build_object('product_id', pg_temp.c('milk'), 'qty', 4)),
        'payments', json_build_array(json_build_object('method','M-Pesa','amount', 6000, 'reference','MP001'),
                                     json_build_object('method','Cash','amount', 5000))));
  perform pg_temp.ok('split payment: 6,000 M-Pesa + 4,000 cash (1,000 change)',
     r->'sale'->>'payment' = 'Split' and (r->'sale'->>'change_due')::numeric = 1000 and json_array_length(r->'payments') = 2, r::text);
end $$;
select pg_temp.err('credit sale needs a named customer',
  format($$select dq_checkout2(jsonb_build_object('shop_id',%L,'lines',json_build_array(json_build_object('product_id',%L,'qty',1)),'payments','[]'::json))$$,
         pg_temp.c('shop'), pg_temp.c('milk')), 'CREDIT_CUSTOMER%');
select pg_temp.err('cashier cannot change prices',
  format($$select dq_checkout2(jsonb_build_object('shop_id',%L,'lines',json_build_array(json_build_object('product_id',%L,'qty',1,'price',1)),
         'payments',json_build_array(json_build_object('method','Cash','amount',1))))$$, pg_temp.c('shop'), pg_temp.c('milk')), 'PRICE_LOCKED%');
select pg_temp.err('cashier discount is limited to 10%',
  format($$select dq_checkout2(jsonb_build_object('shop_id',%L,'lines',json_build_array(json_build_object('product_id',%L,'qty',4)),
         'discount',2000,'payments',json_build_array(json_build_object('method','Cash','amount',8000))))$$, pg_temp.c('shop'), pg_temp.c('milk')), 'DISCOUNT_LIMIT%');

-- loyalty + credit
select pg_temp.as_user(pg_temp.c('owner'));
update businesses set loyalty_enabled = true, points_per_amount = 1000, point_value = 10, min_redeem_points = 50 where id = my_business_id();
select pg_temp.as_user(pg_temp.c('cashier'));
do $$ declare r json; begin
  r := dq_checkout2(jsonb_build_object('shop_id', pg_temp.c('shop'), 'customer_name', 'Asha Juma', 'customer_phone', '0777 111 222',
        'lines', json_build_array(json_build_object('product_id', pg_temp.c('hp'), 'qty', 1)),
        'payments', json_build_array(json_build_object('method','Cash','amount', 150000))));
  perform pg_temp.put('cust', r->'customer'->>'id'); perform pg_temp.put('sale_credit', r->'sale'->>'id');
  perform pg_temp.ok('new customer created from phone', r->'customer'->>'phone' = '0777111222');
  perform pg_temp.ok('credit sale: 500,000 owed', (r->'sale'->>'balance_due')::numeric = 500000 and r->'sale'->>'payment_status' = 'partial', (r->'sale')::text);
  perform pg_temp.ok('points earned only on the paid part (150)', (r->'customer'->>'points')::int = 150);
end $$;
select pg_temp.err('customers cannot be edited to clear debts', format($$update customers set balance = 0 where id = %L$$, pg_temp.c('cust')), '%only through sales%');
select pg_temp.as_user(pg_temp.c('owner'));
update customers set credit_limit = 600000 where id = pg_temp.c('cust')::uuid;
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('credit limit is enforced',
  format($$select dq_checkout2(jsonb_build_object('shop_id',%L,'customer_id',%L,'lines',json_build_array(json_build_object('product_id',%L,'qty',1)),'payments','[]'::json))$$,
         pg_temp.c('shop'), pg_temp.c('cust'), pg_temp.c('hp')), 'CREDIT_LIMIT%');
do $$ declare r json; begin
  r := dq_checkout2(jsonb_build_object('shop_id', pg_temp.c('shop'), 'customer_id', pg_temp.c('cust'), 'points_redeem', 100,
        'lines', json_build_array(json_build_object('product_id', pg_temp.c('milk'), 'qty', 2)),
        'payments', json_build_array(json_build_object('method','Cash','amount', 4000))));
  perform pg_temp.ok('100 points take 1,000 off (5,000 → 4,000)', (r->'sale'->>'total')::numeric = 4000 and (r->'sale'->>'points_value')::numeric = 1000, (r->'sale')::text);
  perform pg_temp.ok('points balance 150 - 100 + 4 = 54', (r->'customer'->>'points')::int = 54, (r->'customer')::text);
end $$;
select pg_temp.err('overpaying a debt is refused', format($$select dq_customer_payment(jsonb_build_object('customer_id',%L,'amount',999999))$$, pg_temp.c('cust')), 'OVERPAY%');
do $$ declare r json; begin
  r := dq_customer_payment(jsonb_build_object('customer_id', pg_temp.c('cust'), 'amount', 200000, 'method', 'Cash'));
  perform pg_temp.ok('debt payment 200,000 leaves 300,000', (r->>'balance')::numeric = 300000);
end $$;
reset role;
select pg_temp.ok('debt payment is applied to the receipt', (select balance_due from sales where id = pg_temp.c('sale_credit')::uuid) = 300000);
set local role authenticated;

-- refunds
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('cashier cannot refund by default', format($$select dq_refund2(jsonb_build_object('sale_id',%L))$$, pg_temp.c('sale_cash')), '%not allowed to refund%');
select pg_temp.as_user(pg_temp.c('owner'));
update members set permissions = '{"can_refund":true}' where auth_user_id = pg_temp.c('cashier')::uuid;
select pg_temp.as_user(pg_temp.c('cashier'));
do $$ declare r json; l uuid; begin
  select id into l from sale_lines where sale_id = pg_temp.c('sale_credit')::uuid limit 1;
  r := dq_refund2(jsonb_build_object('sale_id', pg_temp.c('sale_credit'), 'reason', 'Faulty', 'lines', json_build_array(json_build_object('line_id', l, 'qty', 1))));
  perform pg_temp.ok('refund of a credit sale cancels the debt first (300,000) then pays back 350,000',
    (r->>'debt_cancelled')::numeric = 300000 and (r->>'cash_back')::numeric = 350000, r::text);
end $$;
reset role;
select pg_temp.ok('customer owes nothing after the refund', (select balance from customers where id = pg_temp.c('cust')::uuid) = 0);
set local role authenticated;
select pg_temp.as_user(pg_temp.c('cashier'));
do $$ declare r json; begin
  r := dq_refund2(jsonb_build_object('sale_id', pg_temp.c('sale_cash'), 'reason', 'Return'));
  perform pg_temp.ok('full refund of the cash sale pays back 1,400,000', (r->>'cash_back')::numeric = 1400000 and (r->>'full')::boolean);
end $$;
select pg_temp.ok('refunded scanned label is sellable again', (dq_lookup_item(pg_temp.c('dell1'))->>'ok')::boolean);
select pg_temp.err('cannot refund twice', format($$select dq_refund2(jsonb_build_object('sale_id',%L))$$, pg_temp.c('sale_cash')), '%already fully refunded%');

-- cash-up
select dq_cash_move(jsonb_build_object('shift_id', pg_temp.c('shift'), 'type', 'out', 'amount', 2000, 'reason', 'Bodaboda delivery'));
do $$ declare r json; begin
  -- float 10,000 + cash 1,400,000 + 4,000 + 150,000 + 4,000 + 200,000 − refunds 350,000 − 1,400,000 − payout 2,000 = 16,000
  r := dq_close_shift(jsonb_build_object('shift_id', pg_temp.c('shift'), 'counted_cash', 15500));
  perform pg_temp.ok('expected cash in drawer = 16,000', (r->>'expected_cash')::numeric = 16000, r->>'expected_cash');
  perform pg_temp.ok('shortage of 500 is recorded', (r->'shift'->>'difference')::numeric = -500, (r->'shift')::text);
end $$;
select pg_temp.as_user(pg_temp.c('owner'));
update businesses set require_shift = true where id = my_business_id();
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('selling without a shift is blocked when required',
  format($$select dq_checkout2(jsonb_build_object('shop_id',%L,'lines',json_build_array(json_build_object('product_id',%L,'qty',1)),
         'payments',json_build_array(json_build_object('method','Cash','amount',2500))))$$, pg_temp.c('shop'), pg_temp.c('milk')), 'SHIFT_REQUIRED%');
select pg_temp.as_user(pg_temp.c('owner'));
update businesses set require_shift = false where id = my_business_id();

-- platform blocks
select pg_temp.as_user(pg_temp.c('admin'));
select dq_admin_set_shop(pg_temp.c('shop')::uuid, true, 'Unpaid');
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('blocked shop cannot sell',
  format($$select dq_checkout2(jsonb_build_object('shop_id',%L,'lines',json_build_array(json_build_object('product_id',%L,'qty',1)),
         'payments',json_build_array(json_build_object('method','Cash','amount',2500))))$$, pg_temp.c('shop'), pg_temp.c('milk')), 'SHOP_DISABLED%');
select pg_temp.as_user(pg_temp.c('admin'));
select dq_admin_set_shop(pg_temp.c('shop')::uuid, false);
reset role; select pg_temp.put('cashier_member', (select id::text from members where auth_user_id = pg_temp.c('cashier')::uuid)); set local role authenticated;
select dq_admin_set_member(pg_temp.c('cashier_member')::uuid, true, 'Lost phone');
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.ok('blocked user sees no business data', my_business_id() is null and (select count(*) from products) = 0);
select pg_temp.ok('blocked user can read why', (dq_my_status()->'member'->>'blocked')::boolean and dq_my_status()->'member'->>'blocked_reason' = 'Lost phone');
select pg_temp.as_user(pg_temp.c('admin'));
select dq_admin_set_member(pg_temp.c('cashier_member')::uuid, false);
select pg_temp.ok('business detail lists users, shops and devices',
  json_array_length(dq_admin_business(pg_temp.c('biz')::uuid)->'members') = 3 and json_array_length(dq_admin_business(pg_temp.c('biz')::uuid)->'shops') = 2);
select pg_temp.ok('overview reports liability and pending top-ups', (dq_admin_overview()->'totals'->>'liability')::numeric > 0);
reset role; select pg_temp.ok('audit log records admin actions', (select count(*) from platform_audit) >= 8); set local role authenticated; select pg_temp.as_user(pg_temp.c('admin'));
do $$ declare r json; begin
  r := dq_admin_refund_generation(pg_temp.c('gen_milk')::uuid, 'Printer jam');
  perform pg_temp.ok('refunding a batch voids 2 unsold labels and credits 2 × 10', (r->>'labels')::int = 2 and (r->>'amount')::numeric = 20, r::text);
end $$;

-- ============ purchasing ============
select pg_temp.as_user(pg_temp.c('owner'));
select set_config('dq.trusted', 'off', true);
insert into suppliers(business_id, name, phone, balance) values (my_business_id(), 'Kariakoo Wholesale', '0713000000', 99999);
select pg_temp.put('sup', (select id::text from suppliers where name = 'Kariakoo Wholesale'));
select pg_temp.ok('supplier balance cannot be typed in', (select balance from suppliers where id = pg_temp.c('sup')::uuid) = 0);
select pg_temp.err('order needs a supplier', format($$select dq_save_order(jsonb_build_object('shop_id',%L,'items',json_build_array(json_build_object('product_id',%L,'qty_ordered',1,'unit_cost',1))))$$,
  pg_temp.c('store'), pg_temp.c('hp')), 'ORDER_SUPPLIER%');
select pg_temp.err('order needs unit costs', format($$select dq_save_order(jsonb_build_object('supplier_id',%L,'shop_id',%L,'items',json_build_array(json_build_object('product_id',%L,'qty_ordered',1))))$$,
  pg_temp.c('sup'), pg_temp.c('store'), pg_temp.c('hp')), 'ORDER_ITEMS%');
select pg_temp.err('expected date cannot be before order date', format($$select dq_save_order(jsonb_build_object('supplier_id',%L,'shop_id',%L,'order_date','2026-10-10','expected_date','2026-10-01',
  'items',json_build_array(json_build_object('product_id',%L,'qty_ordered',1,'unit_cost',1))))$$, pg_temp.c('sup'), pg_temp.c('store'), pg_temp.c('hp')), 'ORDER_DATES%');
do $$ declare o json; begin
  o := dq_save_order(jsonb_build_object('supplier_id', pg_temp.c('sup'), 'shop_id', pg_temp.c('store'), 'expected_date', current_date + 7,
        'invoice_no', 'INV-778', 'attachments', '[{"path":"x/orders/inv.pdf","name":"inv.pdf"}]'::jsonb,
        'items', json_build_array(json_build_object('product_id', pg_temp.c('hp'), 'qty_ordered', 10, 'unit_cost', 480000),
                                  json_build_object('product_id', pg_temp.c('milk'), 'qty_ordered', 100, 'unit_cost', 1700))));
  perform pg_temp.put('po', o->>'id');
  perform pg_temp.ok('order gets a PO number and total', o->>'order_no' like 'PO-%' and (o->>'total_cost')::numeric = 4970000, o::text);
end $$;
do $$ declare r json; a uuid; b uuid; begin
  select id into a from order_items where order_id = pg_temp.c('po')::uuid and product_id = pg_temp.c('hp')::uuid;
  select id into b from order_items where order_id = pg_temp.c('po')::uuid and product_id = pg_temp.c('milk')::uuid;
  perform pg_temp.put('oi_hp', a::text); perform pg_temp.put('oi_milk', b::text);
  r := dq_receive_order(jsonb_build_object('order_id', pg_temp.c('po'), 'delivery_note_no', 'DN-1',
        'lines', json_build_array(json_build_object('order_item_id', a, 'qty', 6, 'damaged', 1),
                                  json_build_object('order_item_id', b, 'qty', 100, 'expiry_date', current_date + 20))));
  perform pg_temp.ok('first delivery: GRN, status partial', r->'order'->>'status' = 'partial' and r->'receipt'->>'grn_no' like 'GRN-%', r::text);
  perform pg_temp.ok('received value excludes damaged goods (6×480,000 + 100×1,700)', (r->'receipt'->>'total_value')::numeric = 3050000);
end $$;
reset role;
select pg_temp.ok('only good units enter stock', (select qty from stock_levels where shop_id = pg_temp.c('store')::uuid and product_id = pg_temp.c('hp')::uuid) = 6);
select pg_temp.ok('outstanding on HP line is 3', (select qty_ordered - qty_received - qty_damaged from order_items where id = pg_temp.c('oi_hp')::uuid) = 3);
select pg_temp.ok('supplier balance = value received', (select balance from suppliers where id = pg_temp.c('sup')::uuid) = 3050000);
select pg_temp.ok('expiry from delivery flows to purchases', exists (select 1 from purchases where expiry_date = current_date + 20));
set local role authenticated;
select pg_temp.as_user(pg_temp.c('owner'));
select pg_temp.err('over-receipt is refused', format($$select dq_receive_order(jsonb_build_object('order_id',%L,'lines',json_build_array(json_build_object('order_item_id',%L,'qty',5))))$$,
  pg_temp.c('po'), pg_temp.c('oi_hp')), 'OVER_RECEIPT%');
select pg_temp.err('cannot cancel after receiving', format($$select dq_set_order_status(%L,'cancelled','x')$$, pg_temp.c('po')), '%close the order%');
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.err('cashier cannot receive into another shop', format($$select dq_receive_order(jsonb_build_object('order_id',%L,'lines',json_build_array(json_build_object('order_item_id',%L,'qty',1))))$$,
  pg_temp.c('po'), pg_temp.c('oi_hp')), '%own shop%');
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare r json; begin
  r := dq_receive_order(jsonb_build_object('order_id', pg_temp.c('po'), 'lines', json_build_array(json_build_object('order_item_id', pg_temp.c('oi_hp'), 'qty', 3))));
  perform pg_temp.ok('second delivery completes the order', r->'order'->>'status' = 'received', (r->'order')::text);
  r := dq_supplier_payment(jsonb_build_object('supplier_id', pg_temp.c('sup'), 'order_id', pg_temp.c('po'), 'amount', 2000000, 'method', 'Bank', 'reference', 'CRDB-1'));
end $$;
reset role;
select pg_temp.ok('part payment marks the order partly paid', (select payment_status from orders where id = pg_temp.c('po')::uuid) = 'partial');
set local role authenticated;
select pg_temp.as_user(pg_temp.c('owner'));
select dq_supplier_payment(jsonb_build_object('supplier_id', pg_temp.c('sup'), 'order_id', pg_temp.c('po'), 'amount', 2490000, 'method', 'M-Pesa'));
reset role;
select pg_temp.ok('full payment: order paid, supplier owed 0',
  (select payment_status from orders where id = pg_temp.c('po')::uuid) = 'paid' and (select balance from suppliers where id = pg_temp.c('sup')::uuid) = 0,
  (select payment_status || ' / ' || (select balance from suppliers where id = pg_temp.c('sup')::uuid) from orders where id = pg_temp.c('po')::uuid));
set local role authenticated;

-- ============ stock take ============
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare c json; r json; begin
  c := dq_start_count(jsonb_build_object('shop_id', pg_temp.c('shop'), 'name', 'October count'));
  perform pg_temp.put('count', c->>'id');
  r := dq_count_scan(jsonb_build_object('count_id', c->>'id', 'code', pg_temp.c('dell1')));
  perform pg_temp.ok('scanning a label counts 1', (r->>'counted')::numeric = 1, r::text);
  r := dq_count_scan(jsonb_build_object('count_id', c->>'id', 'code', pg_temp.c('dell1')));
  perform pg_temp.ok('same label is not counted twice', (r->>'duplicate')::boolean);
  r := dq_count_scan(jsonb_build_object('count_id', c->>'id', 'code', 'B-MLK', 'qty', 20));
  perform pg_temp.ok('barcode scan adds a quantity', (r->>'counted')::numeric = 20);
  perform dq_set_count(jsonb_build_object('count_id', c->>'id', 'product_id', pg_temp.c('hp'), 'counted', 7));
  r := dq_apply_count(jsonb_build_object('count_id', c->>'id'));
  perform pg_temp.ok('applying the count adjusts stock', (r->>'adjusted')::int >= 2, r::text);
end $$;
reset role;
select pg_temp.ok('Milk stock at MZ1 is now the counted 20', (select qty from stock_levels where shop_id = pg_temp.c('shop')::uuid and product_id = pg_temp.c('milk')::uuid) = 20);
set local role authenticated;

-- ============ reports ============
select pg_temp.as_user(pg_temp.c('owner'));
do $$ declare r json; begin
  r := dq_report(jsonb_build_object('from', current_date - 1, 'to', current_date));
  perform pg_temp.ok('report: receipts and payments by method', (r->'summary'->>'receipts')::int >= 4 and json_array_length(r->'by_method') >= 2, (r->'summary')::text);
  perform pg_temp.ok('report: refunds counted', (r->'summary'->>'refunds')::numeric >= 1750000);
  perform pg_temp.ok('report: stock valuation per shop', json_array_length(r->'valuation') = 2);
  perform pg_temp.ok('report: shifts listed', json_array_length(r->'shifts') = 1);
end $$;
select pg_temp.ok('stock card lists movements', json_array_length(dq_stock_card(pg_temp.c('dell')::uuid)) >= 5);
select pg_temp.as_user(pg_temp.c('cashier'));
select pg_temp.ok('cashier report is limited to own shop', json_array_length(dq_report('{}')->'valuation') = 1);
insert into held_carts(business_id, shop_id, label, cart, created_by) values (my_business_id(), pg_temp.c('shop')::uuid, 'Mama Neema', '[]', 'demo1');
select pg_temp.ok('cashier can hold a cart', (select count(*) from held_carts) = 1);

do $$ declare rep text; begin
  select format(E'%s/%s passed\n', count(*) filter (where ok), count(*)) ||
         string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || coalesce(' — ' || case when ok then null else info end, ''), E'\n' order by n)
    into rep from t_res;
  raise exception E'TEST REPORT (rolled back)\n%', rep;
end $$;
