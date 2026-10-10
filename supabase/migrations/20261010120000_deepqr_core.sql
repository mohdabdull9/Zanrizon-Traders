-- =============================================================================
-- DeepQr core migration
-- Additive only: no existing table, column or row is dropped.
--   * Business / shop / product identifiers used inside QR codes
--   * Per-item QR codes (product_items) with expiry tracking
--   * Prepaid QR wallet, top-up requests, platform fee settings
--   * Authorised scanning devices (scanner / smartphone lock)
--   * Platform owner portal (platform_admins)
--   * Server-side functions (RPCs) so billing, sales and stock cannot be faked
-- =============================================================================

-- ---------- 0. fix: the app creates 'inventory' staff but the check only allowed 'main_operator'
alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check
  check (role = any (array['owner','manager','main_operator','inventory','cashier']));

-- ---------- 1. identifiers ----------------------------------------------------
alter table public.businesses add column if not exists code text;
alter table public.businesses add column if not exists expiry_alert_days integer not null default 30;
alter table public.businesses add column if not exists block_expired_sales boolean not null default true;
alter table public.businesses add column if not exists device_lock boolean not null default false;
alter table public.businesses add column if not exists scan_mode text not null default 'both';
alter table public.businesses drop constraint if exists businesses_scan_mode_check;
alter table public.businesses add constraint businesses_scan_mode_check check (scan_mode in ('camera','hardware','both'));

alter table public.shops add column if not exists code text;
alter table public.products add column if not exists product_no integer;
alter table public.products add column if not exists expiry_tracking boolean not null default false;
alter table public.purchases add column if not exists expiry_date date;

alter table public.sales add column if not exists discount numeric not null default 0;
alter table public.sales add column if not exists amount_paid numeric;
alter table public.sales add column if not exists change_due numeric;
alter table public.sales add column if not exists customer_phone text;
alter table public.sales add column if not exists status text not null default 'completed';
alter table public.sales add column if not exists device_id uuid;
alter table public.sales add column if not exists refunded_by text;
alter table public.sales add column if not exists refunded_at timestamptz;
alter table public.sales add column if not exists refund_reason text;

alter table public.sale_lines add column if not exists item_id uuid;
alter table public.sale_lines add column if not exists serial text;

-- business code generator: initials (multi-word) or first 3 letters, made unique
create or replace function public.dq_make_business_code(p_name text)
returns text language plpgsql set search_path = public as $$
declare
  words text[] := regexp_split_to_array(upper(regexp_replace(coalesce(p_name,'BIZ'),'[^A-Za-z ]','','g')), '\s+');
  base text; cand text; n int := 1;
begin
  words := array_remove(words, '');
  if array_length(words,1) is null then base := 'BIZ';
  elsif array_length(words,1) = 1 then base := rpad(left(words[1],3),3,'X');
  else base := left(array_to_string(array(select left(w,1) from unnest(words) w),''),4);
       if length(base) < 3 then base := rpad(base,3,'X'); end if;
  end if;
  cand := base;
  while exists (select 1 from businesses where code = cand) loop
    n := n + 1; cand := base || n;
  end loop;
  return cand;
end $$;

do $$ declare r record; begin
  for r in select id, name from public.businesses where code is null order by created_at loop
    update public.businesses set code = public.dq_make_business_code(r.name) where id = r.id;
  end loop;
end $$;

update public.shops s set code = x.c from (
  select id, 'S' || lpad(row_number() over (partition by business_id order by created_at)::text, 2, '0') as c
  from public.shops where code is null) x
where s.id = x.id;

update public.products p set product_no = x.n from (
  select id, coalesce((select max(product_no) from public.products p2 where p2.business_id = p1.business_id),0)
            + row_number() over (partition by business_id order by created_at, name) as n
  from public.products p1 where product_no is null) x
where p.id = x.id;

create unique index if not exists businesses_code_key on public.businesses(code);
create unique index if not exists shops_business_code_key on public.shops(business_id, code);
create unique index if not exists products_business_no_key on public.products(business_id, product_no);

create or replace function public.dq_before_business_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.code is null or new.code = '' then new.code := dq_make_business_code(new.name); end if;
  new.code := upper(new.code);
  return new;
end $$;
drop trigger if exists dq_business_code on public.businesses;
create trigger dq_business_code before insert on public.businesses for each row execute function public.dq_before_business_insert();

-- codes are printed inside QR labels, so they may not be changed afterwards
create or replace function public.dq_protect_business_code() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.code is distinct from old.code then new.code := old.code; end if;
  return new;
end $$;
drop trigger if exists dq_business_code_lock on public.businesses;
create trigger dq_business_code_lock before update on public.businesses for each row execute function public.dq_protect_business_code();

create or replace function public.dq_before_shop_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if new.code is null or new.code = '' then
    perform pg_advisory_xact_lock(hashtext('dq_shop_' || new.business_id::text));
    select coalesce(max(nullif(regexp_replace(code,'\D','','g'),'')::int),0) + 1 into n
      from shops where business_id = new.business_id;
    new.code := 'S' || lpad(n::text, 2, '0');
  end if;
  return new;
end $$;
drop trigger if exists dq_shop_code on public.shops;
create trigger dq_shop_code before insert on public.shops for each row execute function public.dq_before_shop_insert();

create or replace function public.dq_before_product_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.product_no is null then
    perform pg_advisory_xact_lock(hashtext('dq_prod_' || new.business_id::text));
    select coalesce(max(product_no),0) + 1 into new.product_no from products where business_id = new.business_id;
  end if;
  return new;
end $$;
drop trigger if exists dq_product_no on public.products;
create trigger dq_product_no before insert on public.products for each row execute function public.dq_before_product_insert();

-- ---------- 2. platform tables ------------------------------------------------
create table if not exists public.platform_admins (
  email text primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  claim_code_hash text,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
-- the platform owner email is seeded here; the one-time claim code hash is set separately (never committed)
insert into public.platform_admins(email) values ('mohdabdull129@gmail.com') on conflict do nothing;

create table if not exists public.platform_settings (
  id int primary key default 1 check (id = 1),
  qr_fee numeric not null default 25 check (qr_fee >= 0),
  currency text not null default 'TZS',
  min_topup numeric not null default 1000,
  welcome_credit numeric not null default 0,
  allow_negative_balance boolean not null default false,
  payment_instructions text not null default 'Pay via M-Pesa / Tigo Pesa / Airtel Money, then submit the transaction reference here.',
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.platform_settings enable row level security;
insert into public.platform_settings(id) values (1) on conflict do nothing;
drop policy if exists platform_settings_read on public.platform_settings;
create policy platform_settings_read on public.platform_settings for select to authenticated using (true);

create table if not exists public.dq_accounts (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  status text not null default 'active' check (status in ('active','suspended')),
  balance numeric not null default 0,
  total_qr integer not null default 0,
  total_spent numeric not null default 0,
  status_note text,
  updated_at timestamptz not null default now()
);
alter table public.dq_accounts enable row level security;
drop policy if exists dq_accounts_read on public.dq_accounts;
create policy dq_accounts_read on public.dq_accounts for select to authenticated using (business_id = my_business_id());
insert into public.dq_accounts(business_id) select id from public.businesses on conflict do nothing;

create or replace function public.dq_after_business_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare credit numeric;
begin
  select welcome_credit into credit from platform_settings where id = 1;
  insert into dq_accounts(business_id, balance) values (new.id, coalesce(credit,0)) on conflict do nothing;
  if coalesce(credit,0) > 0 then
    insert into wallet_transactions(business_id, type, amount, balance_after, note, by_name)
    values (new.id, 'adjustment', credit, credit, 'Welcome credit', 'DeepQr');
  end if;
  return new;
end $$;

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  type text not null check (type in ('topup','qr_charge','adjustment','refund')),
  amount numeric not null,
  balance_after numeric not null,
  reference text,
  note text,
  by_name text,
  created_at timestamptz not null default now()
);
create index if not exists wallet_tx_business_idx on public.wallet_transactions(business_id, created_at desc);
alter table public.wallet_transactions enable row level security;
drop policy if exists wallet_tx_read on public.wallet_transactions;
create policy wallet_tx_read on public.wallet_transactions for select to authenticated using (business_id = my_business_id());

drop trigger if exists dq_business_account on public.businesses;
create trigger dq_business_account after insert on public.businesses for each row execute function public.dq_after_business_insert();

create table if not exists public.topup_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  amount numeric not null check (amount > 0),
  method text not null default 'Mobile Money',
  reference text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by text,
  review_note text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.topup_requests enable row level security;
drop policy if exists topup_read on public.topup_requests;
create policy topup_read on public.topup_requests for select to authenticated using (business_id = my_business_id());

-- ---------- 3. QR items --------------------------------------------------------
create table if not exists public.qr_generations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  shop_id uuid references public.shops(id) on delete set null,
  qty integer not null check (qty > 0),
  fee_per_qr numeric not null,
  total numeric not null,
  expiry_date date,
  batch_ref text,
  first_serial text,
  last_serial text,
  by_name text,
  created_at timestamptz not null default now()
);
alter table public.qr_generations enable row level security;
drop policy if exists qr_gen_read on public.qr_generations;
create policy qr_gen_read on public.qr_generations for select to authenticated using (business_id = my_business_id());

create table if not exists public.product_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  shop_id uuid references public.shops(id) on delete set null,
  generation_id uuid references public.qr_generations(id) on delete set null,
  serial text not null,
  serial_year integer not null,
  serial_seq integer not null,
  qr_payload text not null unique,
  status text not null default 'in_stock' check (status in ('in_stock','sold','void')),
  expiry_date date,
  batch_ref text,
  sale_id uuid references public.sales(id) on delete set null,
  sold_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, serial)
);
create index if not exists product_items_lookup on public.product_items(business_id, product_id, status);
create index if not exists product_items_expiry on public.product_items(business_id, expiry_date) where status = 'in_stock';
alter table public.product_items enable row level security;
drop policy if exists product_items_read on public.product_items;
create policy product_items_read on public.product_items for select to authenticated using (business_id = my_business_id());

-- ---------- 4. devices -----------------------------------------------------------
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  shop_id uuid references public.shops(id) on delete set null,
  key_hash text not null,
  name text not null,
  kind text not null default 'smartphone' check (kind in ('smartphone','scanner','both')),
  status text not null default 'pending' check (status in ('pending','approved','blocked')),
  user_agent text,
  registered_by text,
  last_seen timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, key_hash)
);
alter table public.devices enable row level security;
drop policy if exists devices_read on public.devices;
create policy devices_read on public.devices for select to authenticated using (business_id = my_business_id());

-- =============================================================================
-- 5. helper functions
-- =============================================================================
create or replace function public.dq_is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select 1 from platform_admins where auth_user_id = auth.uid())
$$;

-- binds the signed-in account to a platform_admins row. Requires the matching email AND the
-- one-time claim code, so nobody can become platform owner just by signing up with that email.
create or replace function public.dq_claim_platform_admin(p_code text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare em text; n int;
begin
  if auth.uid() is null then return false; end if;
  if dq_is_platform_admin() then return true; end if;
  select lower(email) into em from auth.users where id = auth.uid();
  update platform_admins set auth_user_id = auth.uid(), claim_code_hash = null
   where auth_user_id is null and lower(email) = em and claim_code_hash is not null
     and claim_code_hash = encode(extensions.digest(upper(trim(coalesce(p_code,''))), 'sha256'), 'hex');
  get diagnostics n = row_count;
  return n > 0;
end $$;

create or replace function public.dq_require_admin() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not dq_is_platform_admin() then raise exception 'Platform owner access only'; end if;
end $$;

create or replace function public.dq_me() returns public.members
language sql stable security definer set search_path = public as $$
  select * from members where auth_user_id = auth.uid() limit 1
$$;

create or replace function public.dq_key_hash(p_key text) returns text
language sql immutable set search_path = public, extensions as $$
  select encode(extensions.digest(coalesce(p_key,''), 'sha256'), 'hex')
$$;

create or replace function public.dq_check_device(p_business uuid, p_shop uuid, p_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_lock boolean; d devices;
begin
  select device_lock into v_lock from businesses where id = p_business;
  select * into d from devices where business_id = p_business and key_hash = dq_key_hash(p_key);
  if d.id is not null then update devices set last_seen = now() where id = d.id; end if;
  if not coalesce(v_lock,false) then return d.id; end if;
  if d.id is null then raise exception 'DEVICE_NOT_REGISTERED: this device is not registered for scanning'; end if;
  if d.status <> 'approved' then raise exception 'DEVICE_NOT_APPROVED: this device is % — ask the owner to approve it', d.status; end if;
  if d.shop_id is not null and p_shop is not null and d.shop_id <> p_shop then
    raise exception 'DEVICE_WRONG_SHOP: this device is authorised for another shop';
  end if;
  return d.id;
end $$;

create or replace function public.dq_require_active(p_business uuid) returns void
language plpgsql security definer set search_path = public as $$
declare st text;
begin
  select status into st from dq_accounts where business_id = p_business;
  if st = 'suspended' then raise exception 'ACCOUNT_SUSPENDED: this business account is suspended by DeepQr'; end if;
end $$;

-- =============================================================================
-- 6. business-side RPCs
-- =============================================================================
create or replace function public.dq_qr_recommendations() returns table (
  product_id uuid, shop_id uuid, stock_qty numeric, tagged integer, recommended integer, fee numeric, est_cost numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare b uuid := my_business_id(); f numeric;
begin
  if b is null then raise exception 'Not signed in to a business'; end if;
  select qr_fee into f from platform_settings where id = 1;
  return query
  select sl.product_id, sl.shop_id, sl.qty,
         coalesce(t.n,0)::int,
         greatest(ceil(sl.qty)::int - coalesce(t.n,0)::int, 0),
         f,
         greatest(ceil(sl.qty)::int - coalesce(t.n,0)::int, 0) * f
  from stock_levels sl
  left join (select pi.product_id, pi.shop_id, count(*) as n from product_items pi
              where pi.business_id = b and pi.status = 'in_stock' group by 1,2) t
         on t.product_id = sl.product_id and t.shop_id = sl.shop_id
  where sl.business_id = b;
end $$;

create or replace function public.dq_generate_items(
  p_product_id uuid, p_shop_id uuid, p_qty integer, p_expiry date default null, p_batch text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  m members := dq_me(); p products; s shops; bz businesses; acc dq_accounts; st platform_settings;
  yr int := extract(year from now())::int; start_seq int; v_total numeric; gen_id uuid;
  i int; ser text; first_ser text; last_ser text; new_bal numeric;
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  if m.role not in ('owner','manager','inventory','main_operator') then raise exception 'Your role cannot generate QR codes'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 5000 then raise exception 'Quantity must be between 1 and 5000'; end if;
  perform dq_require_active(m.business_id);
  select * into p from products where id = p_product_id and business_id = m.business_id;
  if p.id is null then raise exception 'Product not found'; end if;
  select * into s from shops where id = p_shop_id and business_id = m.business_id;
  if s.id is null then raise exception 'Shop not found'; end if;
  select * into bz from businesses where id = m.business_id;
  select * into st from platform_settings where id = 1;

  select * into acc from dq_accounts where business_id = m.business_id for update;
  v_total := p_qty * st.qr_fee;
  if not st.allow_negative_balance and acc.balance < v_total then
    raise exception 'INSUFFICIENT_BALANCE: % QR codes cost % %, wallet balance is % %. Please top up.',
      p_qty, v_total, st.currency, acc.balance, st.currency;
  end if;

  perform pg_advisory_xact_lock(hashtext('dq_items_' || p.id::text));
  select coalesce(max(serial_seq),0) into start_seq from product_items where product_id = p.id and serial_year = yr;

  insert into qr_generations(business_id, product_id, shop_id, qty, fee_per_qr, total, expiry_date, batch_ref, by_name)
  values (m.business_id, p.id, s.id, p_qty, st.qr_fee, v_total, p_expiry, nullif(p_batch,''), m.name) returning id into gen_id;

  for i in 1..p_qty loop
    ser := yr::text || lpad(p.product_no::text, 2, '0') || lpad((start_seq + i)::text, 3, '0');
    if i = 1 then first_ser := ser; end if; last_ser := ser;
    insert into product_items(business_id, product_id, shop_id, generation_id, serial, serial_year, serial_seq, qr_payload, expiry_date, batch_ref)
    values (m.business_id, p.id, s.id, gen_id, ser, yr, start_seq + i,
            'DQ1|' || bz.code || '|' || s.code || '|' || replace(p.code,'|','') || '|' || ser,
            p_expiry, nullif(p_batch,''));
  end loop;
  update qr_generations set first_serial = first_ser, last_serial = last_ser where id = gen_id;

  new_bal := acc.balance - v_total;
  update dq_accounts set balance = new_bal, total_qr = total_qr + p_qty, total_spent = total_spent + v_total, updated_at = now()
   where business_id = m.business_id;
  insert into wallet_transactions(business_id, type, amount, balance_after, reference, note, by_name)
  values (m.business_id, 'qr_charge', -v_total, new_bal, first_ser || '…' || last_ser,
          p_qty || ' QR code(s) for ' || p.name || ' @ ' || st.qr_fee, m.name);
  if p_expiry is not null then update products set expiry_tracking = true where id = p.id; end if;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'qr', p_qty || ' QR code(s) generated for ' || p.name || ' at ' || s.name || ' (' || v_total || ' ' || st.currency || ')', m.name);

  return json_build_object('generation_id', gen_id, 'qty', p_qty, 'first_serial', first_ser, 'last_serial', last_ser,
                           'total', v_total, 'balance', new_bal, 'currency', st.currency);
end $$;

create or replace function public.dq_lookup_item(p_code text, p_shop_id uuid default null, p_device_key text default null)
returns json language plpgsql security definer set search_path = public as $$
declare m members := dq_me(); it product_items; p products; parts text[]; v text := trim(coalesce(p_code,'')); bz businesses;
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  perform dq_check_device(m.business_id, p_shop_id, p_device_key);
  select * into bz from businesses where id = m.business_id;
  if v like 'DQ1|%' then
    parts := string_to_array(v, '|');
    if parts[2] <> bz.code then
      return json_build_object('ok', false, 'reason', 'OTHER_BUSINESS', 'message', 'This QR belongs to another business (' || coalesce(parts[2],'?') || ').');
    end if;
    select * into it from product_items where qr_payload = v;
  else
    select * into it from product_items where business_id = m.business_id and serial = regexp_replace(v, '^.*-', '');
  end if;
  if it.id is null then return json_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  select * into p from products where id = it.product_id;
  return json_build_object(
    'ok', it.status = 'in_stock' and not (bz.block_expired_sales and it.expiry_date is not null and it.expiry_date < current_date),
    'reason', case when it.status = 'sold' then 'SOLD' when it.status = 'void' then 'VOID'
                   when it.expiry_date is not null and it.expiry_date < current_date then 'EXPIRED' else null end,
    'item', row_to_json(it), 'product', row_to_json(p),
    'expired', it.expiry_date is not null and it.expiry_date < current_date,
    'other_shop', p_shop_id is not null and it.shop_id is distinct from p_shop_id);
end $$;

create or replace function public.dq_checkout(
  p_shop_id uuid, p_lines jsonb, p_customer text default 'Walk-in', p_phone text default null,
  p_payment text default 'Cash', p_discount numeric default 0, p_paid numeric default null,
  p_device_key text default null, p_date date default null, p_time text default null)
returns json language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  m members := dq_me(); bz businesses; dev uuid; ln jsonb; it product_items; p products;
  v_sale uuid; rcpt text; sub numeric := 0; tx numeric := 0; tot numeric; qty numeric; price numeric;
  have numeric; lines_out jsonb := '[]'::jsonb; d date := coalesce(p_date, current_date); n int;
  agg record;
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  if m.role = 'cashier' and m.shop_id is not null and m.shop_id <> p_shop_id then raise exception 'Cashiers can only sell at their own shop'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Cart is empty'; end if;
  perform dq_require_active(m.business_id);
  if not exists (select 1 from shops where id = p_shop_id and business_id = m.business_id) then raise exception 'Shop not found'; end if;
  dev := dq_check_device(m.business_id, p_shop_id, p_device_key);
  select * into bz from businesses where id = m.business_id;

  -- validate & price every line first
  for ln in select * from jsonb_array_elements(p_lines) loop
    if ln ? 'item_id' then
      select * into it from product_items where id = (ln->>'item_id')::uuid and business_id = m.business_id for update;
      if it.id is null then raise exception 'ITEM_NOT_FOUND'; end if;
      if it.status <> 'in_stock' then raise exception 'ITEM_ALREADY_SOLD: % is already %', it.serial, it.status; end if;
      if bz.block_expired_sales and it.expiry_date is not null and it.expiry_date < current_date then
        raise exception 'ITEM_EXPIRED: % expired on %', it.serial, it.expiry_date; end if;
      select * into p from products where id = it.product_id;
      qty := 1; price := p.price;
      lines_out := lines_out || jsonb_build_object('product_id', p.id, 'item_id', it.id, 'serial', it.serial,
                                                   'name', p.name, 'code', p.code, 'qty', 1, 'price', price, 'tax', coalesce(p.tax,0));
    else
      select * into p from products where id = (ln->>'product_id')::uuid and business_id = m.business_id;
      if p.id is null then raise exception 'PRODUCT_NOT_FOUND'; end if;
      qty := coalesce((ln->>'qty')::numeric, 0); price := coalesce((ln->>'price')::numeric, p.price);
      if qty <= 0 or price < 0 then raise exception 'Invalid quantity or price for %', p.name; end if;
      lines_out := lines_out || jsonb_build_object('product_id', p.id, 'item_id', null, 'serial', null,
                                                   'name', p.name, 'code', p.code, 'qty', qty, 'price', price, 'tax', coalesce(p.tax,0));
    end if;
    sub := sub + qty * price; tx := tx + qty * price * coalesce(p.tax,0) / 100;
  end loop;

  -- stock check per product (all lines, serial + plain)
  for agg in select (x->>'product_id')::uuid as pid, sum((x->>'qty')::numeric) as q, max(x->>'name') as nm
               from jsonb_array_elements(lines_out) x group by 1 loop
    select sl.qty into have from stock_levels sl where sl.shop_id = p_shop_id and sl.product_id = agg.pid for update;
    if coalesce(have,0) < agg.q then raise exception 'NOT_ENOUGH_STOCK: only % of % in stock at this shop', coalesce(have,0), agg.nm; end if;
  end loop;

  p_discount := greatest(coalesce(p_discount,0), 0);
  tot := round(sub + tx - p_discount, 2);
  if tot < 0 then raise exception 'Discount is larger than the total'; end if;
  if p_paid is not null and p_payment = 'Cash' and p_paid < tot then raise exception 'Amount paid is less than the total'; end if;

  select count(*) + 1 into n from sales where business_id = m.business_id and date = d;
  rcpt := bz.code || '-' || to_char(d, 'YYMMDD') || '-' || lpad(n::text, 4, '0');

  insert into sales(business_id, shop_id, receipt, date, time, subtotal, tax, total, payment, customer, customer_phone,
                    cashier_name, discount, amount_paid, change_due, device_id)
  values (m.business_id, p_shop_id, rcpt, d, coalesce(p_time, to_char(now(),'HH24:MI')), round(sub,2), round(tx,2), tot,
          coalesce(nullif(p_payment,''),'Cash'), coalesce(nullif(trim(p_customer),''),'Walk-in'), nullif(trim(p_phone),''),
          m.name, p_discount, p_paid, case when p_paid is null then null else p_paid - tot end, dev)
  returning id into v_sale;

  insert into sale_lines(sale_id, business_id, product_id, name, code, qty, price, tax, item_id, serial)
  select v_sale, m.business_id, (x->>'product_id')::uuid, x->>'name', x->>'code', (x->>'qty')::numeric,
         (x->>'price')::numeric, (x->>'tax')::numeric, nullif(x->>'item_id','')::uuid, x->>'serial'
  from jsonb_array_elements(lines_out) x;

  update product_items set status = 'sold', sale_id = v_sale, sold_at = now(), shop_id = p_shop_id
   where id in (select nullif(x->>'item_id','')::uuid from jsonb_array_elements(lines_out) x);

  update stock_levels sl set qty = sl.qty - a.q
    from (select (x->>'product_id')::uuid as pid, sum((x->>'qty')::numeric) as q from jsonb_array_elements(lines_out) x group by 1) a
   where sl.shop_id = p_shop_id and sl.product_id = a.pid;

  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'sale', 'Sale ' || rcpt || ': ' || tot || ' ' || coalesce(bz.currency,'') || ' at ' || (select name from shops where id = p_shop_id), m.name);

  return json_build_object('sale', (select row_to_json(s) from sales s where s.id = v_sale),
                           'lines', (select json_agg(row_to_json(l)) from sale_lines l where l.sale_id = v_sale));
end $$;

create or replace function public.dq_refund_sale(p_sale_id uuid, p_reason text default null)
returns json language plpgsql security definer set search_path = public as $$
declare m members := dq_me(); s sales;
begin
  if m.id is null or m.role not in ('owner','manager') then raise exception 'Only owners and managers can refund sales'; end if;
  select * into s from sales where id = p_sale_id and business_id = m.business_id for update;
  if s.id is null then raise exception 'Sale not found'; end if;
  if s.status = 'refunded' then raise exception 'Sale already refunded'; end if;
  update product_items set status = 'in_stock', sale_id = null, sold_at = null
   where id in (select item_id from sale_lines where sale_id = s.id and item_id is not null);
  insert into stock_levels(business_id, shop_id, product_id, qty)
  select m.business_id, s.shop_id, product_id, sum(qty) from sale_lines where sale_id = s.id and product_id is not null group by product_id
  on conflict (shop_id, product_id) do update set qty = stock_levels.qty + excluded.qty;
  update sales set status = 'refunded', refunded_by = m.name, refunded_at = now(), refund_reason = p_reason where id = s.id;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'refund', 'Sale ' || s.receipt || ' refunded' || coalesce(': ' || p_reason, ''), m.name);
  return json_build_object('ok', true);
end $$;

create or replace function public.dq_void_items(p_item_ids uuid[], p_reason text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare m members := dq_me(); n int;
begin
  if m.id is null or m.role not in ('owner','manager') then raise exception 'Only owners and managers can void QR labels'; end if;
  update product_items set status = 'void' where business_id = m.business_id and status = 'in_stock' and id = any(p_item_ids);
  get diagnostics n = row_count;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'qr', n || ' QR label(s) voided' || coalesce(': ' || p_reason, ''), m.name);
  return n;
end $$;

create or replace function public.dq_register_device(p_key text, p_name text, p_kind text, p_shop_id uuid default null, p_ua text default null)
returns json language plpgsql security definer set search_path = public as $$
declare m members := dq_me(); d devices; h text := dq_key_hash(p_key);
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  if length(coalesce(p_key,'')) < 20 then raise exception 'Invalid device key'; end if;
  if p_kind not in ('smartphone','scanner','both') then raise exception 'Invalid device type'; end if;
  select * into d from devices where business_id = m.business_id and key_hash = h;
  if d.id is null then
    insert into devices(business_id, shop_id, key_hash, name, kind, status, user_agent, registered_by, last_seen)
    values (m.business_id, coalesce(p_shop_id, m.shop_id), h, coalesce(nullif(trim(p_name),''),'Device'), p_kind,
            case when m.role = 'owner' then 'approved' else 'pending' end, left(p_ua,300), m.name, now())
    returning * into d;
    insert into activity_log(business_id, type, description, by_name)
    values (m.business_id, 'device', 'Device registered: ' || d.name || ' (' || d.kind || ', ' || d.status || ')', m.name);
  else
    update devices set last_seen = now(), user_agent = left(coalesce(p_ua, user_agent),300) where id = d.id returning * into d;
  end if;
  return json_build_object('id', d.id, 'name', d.name, 'kind', d.kind, 'status', d.status, 'shop_id', d.shop_id);
end $$;

create or replace function public.dq_device_status(p_key text)
returns json language plpgsql security definer set search_path = public as $$
declare m members := dq_me(); d devices;
begin
  if m.id is null then return null; end if;
  select * into d from devices where business_id = m.business_id and key_hash = dq_key_hash(p_key);
  if d.id is null then return null; end if;
  update devices set last_seen = now() where id = d.id;
  return json_build_object('id', d.id, 'name', d.name, 'kind', d.kind, 'status', d.status, 'shop_id', d.shop_id);
end $$;

create or replace function public.dq_update_device(p_id uuid, p_status text, p_kind text default null, p_shop_id uuid default null, p_name text default null, p_delete boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare m members := dq_me();
begin
  if m.id is null or m.role not in ('owner','manager') then raise exception 'Only owners and managers manage devices'; end if;
  if p_delete then delete from devices where id = p_id and business_id = m.business_id; return; end if;
  if p_status not in ('pending','approved','blocked') then raise exception 'Invalid status'; end if;
  update devices set status = p_status, kind = coalesce(p_kind, kind), shop_id = p_shop_id, name = coalesce(nullif(trim(p_name),''), name)
   where id = p_id and business_id = m.business_id;
end $$;

create or replace function public.dq_request_topup(p_amount numeric, p_method text, p_reference text)
returns json language plpgsql security definer set search_path = public as $$
declare m members := dq_me(); st platform_settings; r topup_requests;
begin
  if m.id is null or m.role not in ('owner','manager') then raise exception 'Only owners and managers can request top-ups'; end if;
  select * into st from platform_settings where id = 1;
  if p_amount is null or p_amount < st.min_topup then raise exception 'Minimum top-up is % %', st.min_topup, st.currency; end if;
  if length(trim(coalesce(p_reference,''))) < 4 then raise exception 'Enter the payment transaction reference'; end if;
  insert into topup_requests(business_id, amount, method, reference, requested_by)
  values (m.business_id, p_amount, coalesce(nullif(p_method,''),'Mobile Money'), trim(p_reference), m.name) returning * into r;
  return row_to_json(r);
end $$;

-- =============================================================================
-- 7. platform owner (portal) RPCs
-- =============================================================================
create or replace function public.dq_admin_overview() returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  return json_build_object(
    'settings', (select row_to_json(s) from platform_settings s where id = 1),
    'businesses', coalesce((select json_agg(x order by x.created_at desc) from (
        select b.id, b.name, b.code, b.currency, b.phone, b.email, b.address, b.created_at,
               (select email from auth.users u where u.id = b.owner_auth_id) as owner_email,
               (select name from members mm where mm.business_id = b.id and mm.role = 'owner' limit 1) as owner_name,
               a.status, a.balance, a.total_qr, a.total_spent, a.status_note,
               (select count(*) from shops where business_id = b.id) as shops,
               (select count(*) from members where business_id = b.id) as staff,
               (select count(*) from products where business_id = b.id) as products,
               (select count(*) from product_items where business_id = b.id and status = 'in_stock') as items_in_stock,
               (select count(*) from product_items where business_id = b.id and status = 'sold') as items_sold,
               (select count(*) from sales where business_id = b.id and status <> 'refunded') as sales_count,
               (select coalesce(sum(total),0) from sales where business_id = b.id and status <> 'refunded') as sales_total,
               (select coalesce(sum(total),0) from sales where business_id = b.id and status <> 'refunded' and date >= current_date - 30) as sales_30d,
               (select max(created_at) from activity_log where business_id = b.id) as last_active,
               (select count(*) from devices where business_id = b.id and status = 'approved') as devices
        from businesses b left join dq_accounts a on a.business_id = b.id) x), '[]'::json),
    'topups', coalesce((select json_agg(row_to_json(t) order by t.created_at desc) from (
        select r.*, b.name as business_name, b.code as business_code from topup_requests r join businesses b on b.id = r.business_id
        order by r.created_at desc limit 200) t), '[]'::json),
    'ledger', coalesce((select json_agg(row_to_json(t)) from (
        select w.*, b.name as business_name from wallet_transactions w join businesses b on b.id = w.business_id
        order by w.created_at desc limit 300) t), '[]'::json),
    'qr_by_month', coalesce((select json_agg(row_to_json(t) order by t.month) from (
        select to_char(date_trunc('month', created_at),'YYYY-MM') as month, sum(qty) as qrs, sum(total) as revenue
        from qr_generations where created_at > now() - interval '12 months' group by 1) t), '[]'::json)
  );
end $$;

create or replace function public.dq_admin_update_settings(p_fee numeric, p_currency text, p_min_topup numeric,
  p_welcome_credit numeric, p_allow_negative boolean, p_instructions text)
returns json language plpgsql security definer set search_path = public as $$
declare em text;
begin
  perform dq_require_admin();
  if p_fee is null or p_fee < 0 then raise exception 'Fee must be zero or more'; end if;
  select email into em from auth.users where id = auth.uid();
  update platform_settings set qr_fee = p_fee, currency = coalesce(nullif(trim(p_currency),''),'TZS'),
    min_topup = greatest(coalesce(p_min_topup,0),0), welcome_credit = greatest(coalesce(p_welcome_credit,0),0),
    allow_negative_balance = coalesce(p_allow_negative,false), payment_instructions = coalesce(p_instructions,''),
    updated_at = now(), updated_by = em where id = 1;
  return (select row_to_json(s) from platform_settings s where id = 1);
end $$;

create or replace function public.dq_admin_adjust_wallet(p_business uuid, p_amount numeric, p_note text, p_type text default 'adjustment')
returns numeric language plpgsql security definer set search_path = public as $$
declare nb numeric; em text;
begin
  perform dq_require_admin();
  if p_amount is null or p_amount = 0 then raise exception 'Amount cannot be zero'; end if;
  if p_type not in ('topup','adjustment','refund') then raise exception 'Invalid type'; end if;
  select email into em from auth.users where id = auth.uid();
  insert into dq_accounts(business_id) values (p_business) on conflict do nothing;
  update dq_accounts set balance = balance + p_amount, updated_at = now() where business_id = p_business returning balance into nb;
  if nb is null then raise exception 'Business not found'; end if;
  insert into wallet_transactions(business_id, type, amount, balance_after, note, by_name)
  values (p_business, p_type, p_amount, nb, p_note, 'DeepQr: ' || em);
  return nb;
end $$;

create or replace function public.dq_admin_review_topup(p_id uuid, p_approve boolean, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
declare r topup_requests; nb numeric; em text;
begin
  perform dq_require_admin();
  select email into em from auth.users where id = auth.uid();
  select * into r from topup_requests where id = p_id for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'pending' then raise exception 'Request already %', r.status; end if;
  if p_approve then
    insert into dq_accounts(business_id) values (r.business_id) on conflict do nothing;
    update dq_accounts set balance = balance + r.amount, updated_at = now() where business_id = r.business_id returning balance into nb;
    insert into wallet_transactions(business_id, type, amount, balance_after, reference, note, by_name)
    values (r.business_id, 'topup', r.amount, nb, r.reference, 'Top-up via ' || r.method, 'DeepQr: ' || em);
  end if;
  update topup_requests set status = case when p_approve then 'approved' else 'rejected' end,
    review_note = p_note, reviewed_by = em, reviewed_at = now() where id = p_id returning * into r;
  return row_to_json(r);
end $$;

create or replace function public.dq_admin_set_status(p_business uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  if p_status not in ('active','suspended') then raise exception 'Invalid status'; end if;
  insert into dq_accounts(business_id) values (p_business) on conflict do nothing;
  update dq_accounts set status = p_status, status_note = p_note, updated_at = now() where business_id = p_business;
end $$;

-- =============================================================================
-- 8. permissions: only signed-in users may call the RPCs; internal helpers are hidden
-- =============================================================================
revoke all on function public.dq_make_business_code(text) from public, anon, authenticated;
revoke all on function public.dq_before_business_insert() from public, anon, authenticated;
revoke all on function public.dq_protect_business_code() from public, anon, authenticated;
revoke all on function public.dq_before_shop_insert() from public, anon, authenticated;
revoke all on function public.dq_before_product_insert() from public, anon, authenticated;
revoke all on function public.dq_after_business_insert() from public, anon, authenticated;
revoke all on function public.dq_require_admin() from public, anon, authenticated;
revoke all on function public.dq_check_device(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.dq_require_active(uuid) from public, anon, authenticated;
revoke all on function public.dq_me() from public, anon, authenticated;
revoke all on function public.dq_key_hash(text) from public, anon, authenticated;

do $$ declare f text; begin
  foreach f in array array[
    'dq_is_platform_admin()','dq_claim_platform_admin(text)','dq_qr_recommendations()',
    'dq_generate_items(uuid,uuid,integer,date,text)','dq_lookup_item(text,uuid,text)',
    'dq_checkout(uuid,jsonb,text,text,text,numeric,numeric,text,date,text)',
    'dq_refund_sale(uuid,text)','dq_void_items(uuid[],text)',
    'dq_register_device(text,text,text,uuid,text)','dq_device_status(text)',
    'dq_update_device(uuid,text,text,uuid,text,boolean)','dq_request_topup(numeric,text,text)',
    'dq_admin_overview()','dq_admin_update_settings(numeric,text,numeric,numeric,boolean,text)',
    'dq_admin_adjust_wallet(uuid,numeric,text,text)','dq_admin_review_topup(uuid,boolean,text)',
    'dq_admin_set_status(uuid,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
