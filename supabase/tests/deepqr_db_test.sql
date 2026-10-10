-- DeepQr database test-suite.
-- Runs AFTER the migration has been applied (or inside the same transaction as it).
-- Everything happens in one transaction that ends with a deliberate exception,
-- so no test data is ever kept. The exception message is the test report.
--
-- Usage: begin; <this file>   (the final DO block raises the report and rolls back)

create temp table t_res(n serial, name text, ok boolean, info text);
create temp table t_ctx(k text primary key, v text);
grant all on t_res, t_ctx to authenticated;
grant usage on sequence t_res_n_seq to authenticated;

create or replace function pg_temp.ok(p_name text, p_ok boolean, p_info text default null) returns void
language sql as $$ insert into t_res(name, ok, info) values (p_name, coalesce(p_ok,false), p_info) $$;
create or replace function pg_temp.ctx(p_k text) returns text language sql as $$ select v from t_ctx where k = p_k $$;
create or replace function pg_temp.as_user(p_uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true) $$;

-- ---------- fixture: pick the DEMO business, its owner, its cashier and a stocked product at the cashier's shop
insert into t_ctx
select 'biz', b.id::text from businesses b where b.name = 'DEMO'
union all select 'owner', m.auth_user_id::text from members m join businesses b on b.id=m.business_id where b.name='DEMO' and m.role='owner'
union all select 'cashier', m.auth_user_id::text from members m join businesses b on b.id=m.business_id where b.name='DEMO' and m.role='cashier'
union all select 'shop', m.shop_id::text from members m join businesses b on b.id=m.business_id where b.name='DEMO' and m.role='cashier'
union all select 'other_owner', m.auth_user_id::text from members m join businesses b on b.id=m.business_id where b.name<>'DEMO' and m.role='owner' limit 1;

-- give the test product plenty of stock at the cashier's shop
insert into t_ctx select 'prod', p.id::text from products p where p.business_id = pg_temp.ctx('biz')::uuid order by p.created_at limit 1;
insert into stock_levels(business_id, shop_id, product_id, qty)
values (pg_temp.ctx('biz')::uuid, pg_temp.ctx('shop')::uuid, pg_temp.ctx('prod')::uuid, 20)
on conflict (shop_id, product_id) do update set qty = 20;
update products set price = 1000, tax = 0 where id = pg_temp.ctx('prod')::uuid;
update dq_accounts set balance = 0, status = 'active' where business_id = pg_temp.ctx('biz')::uuid;
update businesses set device_lock = false, block_expired_sales = true where id = pg_temp.ctx('biz')::uuid;
update platform_settings set qr_fee = 25, allow_negative_balance = false, min_topup = 1000 where id = 1;

-- make the DEMO owner a (not yet claimed) platform admin for the admin tests
insert into platform_admins(email, claim_code_hash)
select lower(email), encode(extensions.digest('TESTCODE123', 'sha256'), 'hex') from auth.users where id = pg_temp.ctx('owner')::uuid;

-- ---------- 1. identifiers were back-filled
select pg_temp.ok('every business has a QR code prefix', not exists (select 1 from businesses where code is null));
select pg_temp.ok('every shop has a code', not exists (select 1 from shops where code is null));
select pg_temp.ok('every product has a product number', not exists (select 1 from products where product_no is null));
select pg_temp.ok('every business has a wallet account', not exists (select 1 from businesses b where not exists (select 1 from dq_accounts a where a.business_id=b.id)));

set local role authenticated;
select pg_temp.as_user(pg_temp.ctx('owner'));

-- ---------- 2. billing blocks generation without balance
do $$ begin
  perform dq_generate_items(pg_temp.ctx('prod')::uuid, pg_temp.ctx('shop')::uuid, 3);
  perform pg_temp.ok('generation blocked with empty wallet', false, 'no error raised');
exception when others then perform pg_temp.ok('generation blocked with empty wallet', sqlerrm like 'INSUFFICIENT_BALANCE%', sqlerrm); end $$;

-- ---------- 3. platform admin claim
select pg_temp.ok('not admin before claim', dq_is_platform_admin() = false);
select pg_temp.ok('wrong claim code rejected', dq_claim_platform_admin('WRONG') = false);
select pg_temp.ok('correct claim code accepted', dq_claim_platform_admin('testcode123') = true);
select pg_temp.ok('admin after claim', dq_is_platform_admin() = true);
select pg_temp.ok('admin credits wallet', dq_admin_adjust_wallet(pg_temp.ctx('biz')::uuid, 1000, 'test credit') = 1000);

-- ---------- 4. QR generation, serial format, charging
do $$ declare r json; yr text := extract(year from now())::text; pn int; begin
  select product_no into pn from products where id = pg_temp.ctx('prod')::uuid;
  r := dq_generate_items(pg_temp.ctx('prod')::uuid, pg_temp.ctx('shop')::uuid, 3, null, 'B1');
  perform pg_temp.ok('3 QR codes cost 75', (r->>'total')::numeric = 75, r::text);
  perform pg_temp.ok('wallet now 925', (r->>'balance')::numeric = 925);
  perform pg_temp.ok('first serial = year + product no + 001', r->>'first_serial' = yr || lpad(pn::text,2,'0') || '001', r->>'first_serial');
  perform pg_temp.ok('last serial ends 003', r->>'last_serial' like '%003');
  r := dq_generate_items(pg_temp.ctx('prod')::uuid, pg_temp.ctx('shop')::uuid, 2);
  perform pg_temp.ok('second batch continues numbering at 004', r->>'first_serial' like '%004', r->>'first_serial');
end $$;
select pg_temp.ok('QR payload carries business + shop + product + serial',
  (select bool_and(qr_payload ~ '^DQ1\|[A-Z0-9]+\|S[0-9]+\|[^|]+\|[0-9]{9,}$') from product_items where product_id = pg_temp.ctx('prod')::uuid),
  (select min(qr_payload) from product_items where product_id = pg_temp.ctx('prod')::uuid));
select pg_temp.ok('wallet ledger shows charge', exists (select 1 from wallet_transactions where business_id = pg_temp.ctx('biz')::uuid and type='qr_charge' and amount = -75));
select pg_temp.ok('recommendation = stock 20 - 5 tagged = 15',
  (select recommended from dq_qr_recommendations() where product_id = pg_temp.ctx('prod')::uuid and shop_id = pg_temp.ctx('shop')::uuid) = 15);
select pg_temp.ok('recommended cost = 15 x 25 = 375',
  (select est_cost from dq_qr_recommendations() where product_id = pg_temp.ctx('prod')::uuid and shop_id = pg_temp.ctx('shop')::uuid) = 375);

insert into t_ctx select 'item1', id::text from product_items where product_id = pg_temp.ctx('prod')::uuid and serial_seq = 1;
insert into t_ctx select 'item2', id::text from product_items where product_id = pg_temp.ctx('prod')::uuid and serial_seq = 2;
insert into t_ctx select 'payload1', qr_payload from product_items where product_id = pg_temp.ctx('prod')::uuid and serial_seq = 1;
insert into t_ctx select 'serial3', serial from product_items where product_id = pg_temp.ctx('prod')::uuid and serial_seq = 3;

-- ---------- 5. scanning
select pg_temp.ok('scan by full QR payload finds sellable item', (dq_lookup_item(pg_temp.ctx('payload1'), pg_temp.ctx('shop')::uuid)->>'ok')::boolean);
select pg_temp.ok('typing just the serial also works', (dq_lookup_item(pg_temp.ctx('serial3'), pg_temp.ctx('shop')::uuid)->>'ok')::boolean);
select pg_temp.ok('QR from another business is rejected', dq_lookup_item('DQ1|ZZZZ|S01|X|202601001')->>'reason' = 'OTHER_BUSINESS');
select pg_temp.ok('unknown code -> NOT_FOUND', dq_lookup_item('999999999')->>'reason' = 'NOT_FOUND');

-- ---------- 6. checkout: 2 QR items + 1 plain line in one receipt
reset role;
insert into t_ctx select 'stock_before', qty::text from stock_levels where shop_id = pg_temp.ctx('shop')::uuid and product_id = pg_temp.ctx('prod')::uuid;
set local role authenticated;
select pg_temp.as_user(pg_temp.ctx('cashier'));
do $$ declare r json; begin
  r := dq_checkout(pg_temp.ctx('shop')::uuid,
        json_build_array(json_build_object('item_id', pg_temp.ctx('item1')), json_build_object('item_id', pg_temp.ctx('item2')),
                         json_build_object('product_id', pg_temp.ctx('prod'), 'qty', 1, 'price', 1000))::jsonb,
        'Asha', '0777000000', 'Cash', 100, 5000);
  insert into t_ctx values ('sale', r->'sale'->>'id');
  perform pg_temp.ok('receipt total = 3000 - 100 discount = 2900', (r->'sale'->>'total')::numeric = 2900, r->'sale'->>'total');
  perform pg_temp.ok('change due = 2100', (r->'sale'->>'change_due')::numeric = 2100);
  perform pg_temp.ok('receipt has 3 lines', json_array_length(r->'lines') = 3);
  perform pg_temp.ok('receipt number uses business code', (r->'sale'->>'receipt') ~ '^[A-Z0-9]+-[0-9]{6}-[0-9]{4}$', r->'sale'->>'receipt');
end $$;
select pg_temp.ok('scanned items marked sold', (select count(*) from product_items where id in (pg_temp.ctx('item1')::uuid, pg_temp.ctx('item2')::uuid) and status='sold') = 2);
select pg_temp.ok('stock reduced by 3', (select qty from stock_levels where shop_id = pg_temp.ctx('shop')::uuid and product_id = pg_temp.ctx('prod')::uuid) = pg_temp.ctx('stock_before')::numeric - 3);
do $$ begin
  perform dq_checkout(pg_temp.ctx('shop')::uuid, json_build_array(json_build_object('item_id', pg_temp.ctx('item1')))::jsonb);
  perform pg_temp.ok('same QR cannot be sold twice', false);
exception when others then perform pg_temp.ok('same QR cannot be sold twice', sqlerrm like 'ITEM_ALREADY_SOLD%', sqlerrm); end $$;
select pg_temp.ok('scan of sold item says SOLD', dq_lookup_item(pg_temp.ctx('payload1'))->>'reason' = 'SOLD');
do $$ begin
  perform dq_generate_items(pg_temp.ctx('prod')::uuid, pg_temp.ctx('shop')::uuid, 1);
  perform pg_temp.ok('cashier cannot generate QR codes', false);
exception when others then perform pg_temp.ok('cashier cannot generate QR codes', true, sqlerrm); end $$;
do $$ begin
  perform dq_admin_overview();
  perform pg_temp.ok('cashier cannot open platform portal', false);
exception when others then perform pg_temp.ok('cashier cannot open platform portal', sqlerrm like 'Platform owner%', sqlerrm); end $$;
select pg_temp.ok('cashier sees own business QR items', (select count(*) from product_items) >= 5);

-- ---------- 7. expiry
select pg_temp.as_user(pg_temp.ctx('owner'));
do $$ declare r json; begin
  r := dq_generate_items(pg_temp.ctx('prod')::uuid, pg_temp.ctx('shop')::uuid, 1, current_date - 1, 'OLD');
  insert into t_ctx select 'expired_item', id::text from product_items where serial = r->>'first_serial';
  insert into t_ctx select 'expired_serial', r->>'first_serial';
end $$;
select pg_temp.ok('scan flags expired item', dq_lookup_item(pg_temp.ctx('expired_serial'))->>'reason' = 'EXPIRED');
select pg_temp.ok('expired item is not sellable', (dq_lookup_item(pg_temp.ctx('expired_serial'))->>'ok')::boolean = false);
do $$ begin
  perform dq_checkout(pg_temp.ctx('shop')::uuid, json_build_array(json_build_object('item_id', pg_temp.ctx('expired_item')))::jsonb);
  perform pg_temp.ok('checkout refuses expired item', false);
exception when others then perform pg_temp.ok('checkout refuses expired item', sqlerrm like 'ITEM_EXPIRED%', sqlerrm); end $$;

-- ---------- 8. refund puts items + stock back
select pg_temp.ok('refund succeeds', (dq_refund_sale(pg_temp.ctx('sale')::uuid, 'test')->>'ok')::boolean);
select pg_temp.ok('refunded items back in stock', (select count(*) from product_items where id in (pg_temp.ctx('item1')::uuid, pg_temp.ctx('item2')::uuid) and status='in_stock') = 2);
select pg_temp.ok('refund restores stock', (select qty from stock_levels where shop_id = pg_temp.ctx('shop')::uuid and product_id = pg_temp.ctx('prod')::uuid) = pg_temp.ctx('stock_before')::numeric);
do $$ begin
  perform dq_refund_sale(pg_temp.ctx('sale')::uuid);
  perform pg_temp.ok('cannot refund twice', false);
exception when others then perform pg_temp.ok('cannot refund twice', true, sqlerrm); end $$;

-- ---------- 9. device lock (scanner / smartphone authorisation)
reset role; update businesses set device_lock = true where id = pg_temp.ctx('biz')::uuid; set local role authenticated;
select pg_temp.as_user(pg_temp.ctx('cashier'));
do $$ begin
  perform dq_checkout(pg_temp.ctx('shop')::uuid, json_build_array(json_build_object('item_id', pg_temp.ctx('item1')))::jsonb, p_device_key => null);
  perform pg_temp.ok('unregistered device blocked', false);
exception when others then perform pg_temp.ok('unregistered device blocked', sqlerrm like 'DEVICE_NOT_REGISTERED%', sqlerrm); end $$;
select pg_temp.ok('cashier device registers as pending',
  dq_register_device('cashier-phone-key-0123456789abcdef', 'Cashier phone', 'smartphone', null, 'test')->>'status' = 'pending');
do $$ begin
  perform dq_checkout(pg_temp.ctx('shop')::uuid, json_build_array(json_build_object('item_id', pg_temp.ctx('item1')))::jsonb, p_device_key => 'cashier-phone-key-0123456789abcdef');
  perform pg_temp.ok('pending device blocked', false);
exception when others then perform pg_temp.ok('pending device blocked', sqlerrm like 'DEVICE_NOT_APPROVED%', sqlerrm); end $$;
select pg_temp.ok('device key is stored hashed, not in plain text', not exists (select 1 from devices where key_hash like 'cashier%'));
select pg_temp.as_user(pg_temp.ctx('owner'));
select dq_update_device((select id from devices where name='Cashier phone'), 'approved', 'smartphone', pg_temp.ctx('shop')::uuid);
select pg_temp.as_user(pg_temp.ctx('cashier'));
select pg_temp.ok('approved device can sell',
  (dq_checkout(pg_temp.ctx('shop')::uuid, json_build_array(json_build_object('item_id', pg_temp.ctx('item1')))::jsonb, p_device_key => 'cashier-phone-key-0123456789abcdef')->'sale'->>'total')::numeric = 1000);
reset role; update businesses set device_lock = false where id = pg_temp.ctx('biz')::uuid; set local role authenticated;

-- ---------- 10. top-up requests and approval
select pg_temp.as_user(pg_temp.ctx('owner'));
do $$ begin
  perform dq_request_topup(500, 'M-Pesa', 'ABC123');
  perform pg_temp.ok('top-up below minimum rejected', false);
exception when others then perform pg_temp.ok('top-up below minimum rejected', true, sqlerrm); end $$;
insert into t_ctx select 'topup', dq_request_topup(5000, 'M-Pesa', 'QWERTY12')->>'id';
select pg_temp.ok('top-up approved credits wallet',
  (dq_admin_review_topup(pg_temp.ctx('topup')::uuid, true, 'paid')->>'status') = 'approved'
  and (select balance from dq_accounts where business_id = pg_temp.ctx('biz')::uuid) = 925 - 25 + 5000);
select pg_temp.ok('portal overview lists businesses', json_array_length(dq_admin_overview()->'businesses') >= 2);
select pg_temp.ok('admin can change QR fee', (dq_admin_update_settings(30, 'TZS', 1000, 0, false, 'Pay to 0777')->>'qr_fee')::numeric = 30);
do $$ declare r json; begin
  r := dq_generate_items(pg_temp.ctx('prod')::uuid, pg_temp.ctx('shop')::uuid, 2);
  perform pg_temp.ok('new fee applies (2 x 30 = 60)', (r->>'total')::numeric = 60, r::text);
end $$;

-- ---------- 11. suspension
select dq_admin_set_status(pg_temp.ctx('biz')::uuid, 'suspended', 'test');
do $$ begin
  perform dq_generate_items(pg_temp.ctx('prod')::uuid, pg_temp.ctx('shop')::uuid, 1);
  perform pg_temp.ok('suspended business cannot generate', false);
exception when others then perform pg_temp.ok('suspended business cannot generate', sqlerrm like 'ACCOUNT_SUSPENDED%', sqlerrm); end $$;
select dq_admin_set_status(pg_temp.ctx('biz')::uuid, 'active');

-- ---------- 12. tamper protection / isolation
update businesses set code = 'HACK' where id = pg_temp.ctx('biz')::uuid;
select pg_temp.ok('business code cannot be changed', (select code from businesses where id = pg_temp.ctx('biz')::uuid) <> 'HACK');
update dq_accounts set balance = 999999 where business_id = pg_temp.ctx('biz')::uuid;
select pg_temp.ok('owner cannot edit own wallet balance', (select balance from dq_accounts where business_id = pg_temp.ctx('biz')::uuid) < 999999);
do $$ begin
  insert into product_items(business_id, product_id, serial, serial_year, serial_seq, qr_payload)
  values (pg_temp.ctx('biz')::uuid, pg_temp.ctx('prod')::uuid, 'FAKE', 2026, 999, 'DQ1|FAKE');
  perform pg_temp.ok('QR codes cannot be created without paying', false);
exception when others then perform pg_temp.ok('QR codes cannot be created without paying', true, sqlerrm); end $$;
select pg_temp.as_user(pg_temp.ctx('other_owner'));
select pg_temp.ok('other business sees none of these QR items', (select count(*) from product_items where business_id = pg_temp.ctx('biz')::uuid) = 0);
select pg_temp.ok('other business cannot read this wallet', (select count(*) from dq_accounts where business_id = pg_temp.ctx('biz')::uuid) = 0);

-- ---------- 13. staff role fix + new product numbering
reset role;
select pg_temp.ok('"inventory" staff role is now allowed',
  (select count(*) from (select 1 from pg_constraint where conname='members_role_check' and pg_get_constraintdef(oid) like '%inventory%') x) = 1);
insert into products(business_id, code, name, barcode) values (pg_temp.ctx('biz')::uuid, 'D12', 'Dell 12', 'TEST-D12-BARCODE');
select pg_temp.ok('new product gets next product number',
  (select product_no from products where code='D12' and business_id = pg_temp.ctx('biz')::uuid) = (select max(product_no) from products where business_id = pg_temp.ctx('biz')::uuid));
insert into shops(business_id, name) values (pg_temp.ctx('biz')::uuid, 'Test Branch');
select pg_temp.ok('new shop gets a code', (select code from shops where name='Test Branch' and business_id = pg_temp.ctx('biz')::uuid) ~ '^S[0-9]{2,}$');

-- ---------- report (raising rolls everything back)
do $$ declare rep text; begin
  select format(E'%s/%s passed\n', count(*) filter (where ok), count(*)) ||
         string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || coalesce(' — ' || case when ok then null else info end, ''), E'\n' order by n)
    into rep from t_res;
  raise exception E'TEST REPORT (rolled back)\n%', rep;
end $$;
