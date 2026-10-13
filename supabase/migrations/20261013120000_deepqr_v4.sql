-- =============================================================================
-- DeepQr v4 — suppliers, customers & online orders, verified payments,
-- platform staff, smart QR links and smart suggestions
-- Safe to run more than once. Run AFTER 20261012120000_deepqr_v3.sql.
-- =============================================================================
create or replace function public.dq_version() returns integer language sql immutable as $$ select 4 $$;

-- -----------------------------------------------------------------------------
-- 1. platform staff (assistants) with roles
-- -----------------------------------------------------------------------------
alter table public.platform_admins add column if not exists role text not null default 'owner';
alter table public.platform_admins add column if not exists name text;
alter table public.platform_admins add column if not exists active boolean not null default true;
alter table public.platform_admins add column if not exists invited_by text;
alter table public.platform_admins add column if not exists last_seen timestamptz;
alter table public.platform_admins drop constraint if exists platform_admins_role_check;
alter table public.platform_admins add constraint platform_admins_role_check check (role in ('owner','admin','finance','support','catalog'));

create or replace function public.dq_is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select 1 from platform_admins where auth_user_id = auth.uid() and active)
$$;
create or replace function public.dq_platform_role() returns text
language sql stable security definer set search_path = public as $$
  select role from platform_admins where auth_user_id = auth.uid() and active limit 1
$$;
-- owner: everything · admin: everything except staff · finance: money + prints · support: clients + prints · catalog: catalogue
create or replace function public.dq_admin_can(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select case dq_platform_role()
    when 'owner' then true
    when 'admin' then p_perm <> 'staff'
    when 'finance' then p_perm in ('finance','prints','view')
    when 'support' then p_perm in ('support','prints','view')
    when 'catalog' then p_perm in ('catalog','view')
    else false end
$$;
create or replace function public.dq_require_admin_perm(p_perm text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not dq_is_platform_admin() then raise exception 'Platform owner access only'; end if;
  if not dq_admin_can(p_perm) then
    raise exception 'ADMIN_ROLE: your DeepQr role (%) cannot do this — ask the platform owner', dq_platform_role();
  end if;
end $$;

-- wrap the sensitive portal functions with a role check (keeps their original code as *_impl)
do $$
declare r record; v_args text; v_call text; v_body text;
  pairs text[][] := array[
    ['dq_admin_save_settings','settings'],['dq_admin_update_settings','settings'],
    ['dq_admin_adjust_wallet','finance'],['dq_admin_grant_bonus','finance'],['dq_admin_bulk_bonus','finance'],
    ['dq_admin_review_topup','finance'],['dq_admin_refund_generation','finance'],['dq_admin_update_account','finance'],
    ['dq_admin_save_package','finance'],['dq_admin_save_promo','finance'],
    ['dq_admin_set_status','support'],['dq_admin_set_member','support'],['dq_admin_set_shop','support'],
    ['dq_admin_set_device','support'],['dq_admin_save_announcement','support'],
    ['dq_admin_save_catalog','catalog'],['dq_admin_print_update','prints']];
  i int;
begin
  for i in 1..array_length(pairs, 1) loop
    for r in select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as ident, pg_get_function_arguments(p.oid) as args,
                    pg_get_function_result(p.oid) as res, p.proargnames as names
               from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = pairs[i][1] loop
      -- a freshly (re)created original replaces the old implementation
      if r.oid is not null and not exists (select 1 from pg_proc x where x.pronamespace = 'public'::regnamespace and x.proname = r.proname || '_impl'
                                            and pg_get_function_identity_arguments(x.oid) = r.ident)
         or (select prosrc from pg_proc where oid = r.oid) not like '%dq_require_admin_perm%' then
        execute format('drop function if exists public.%I(%s)', r.proname || '_impl', r.ident);
        execute format('alter function public.%I(%s) rename to %I', r.proname, r.ident, r.proname || '_impl');
        execute format('revoke all on function public.%I(%s) from public, anon, authenticated', r.proname || '_impl', r.ident);
      end if;
      select string_agg(quote_ident(n), ', ') into v_call from unnest(r.names) n;
      v_body := case when r.res = 'void'
        then format('begin perform dq_require_admin_perm(%L); perform public.%I(%s); end', pairs[i][2], r.proname || '_impl', coalesce(v_call, ''))
        else format('begin perform dq_require_admin_perm(%L); return public.%I(%s); end', pairs[i][2], r.proname || '_impl', coalesce(v_call, '')) end;
      execute format('create or replace function public.%I(%s) returns %s language plpgsql security definer set search_path = public as %L',
                     r.proname, r.args, r.res, v_body);
      execute format('revoke all on function public.%I(%s) from public, anon', r.proname, r.ident);
      execute format('grant execute on function public.%I(%s) to authenticated', r.proname, r.ident);
    end loop;
  end loop;
end $$;

create or replace function public.dq_admin_staff() returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin_perm('view');
  return coalesce((select json_agg(json_build_object('email', a.email, 'name', a.name, 'role', a.role, 'active', a.active,
      'claimed', a.auth_user_id is not null, 'invited_by', a.invited_by, 'created_at', a.created_at, 'last_seen', a.last_seen,
      'me', a.auth_user_id = auth.uid()) order by a.created_at) from platform_admins a), '[]'::json);
end $$;
create or replace function public.dq_admin_invite_staff(p_email text, p_name text, p_role text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_code text; em text := lower(trim(coalesce(p_email, ''))); me_email text;
begin
  perform dq_require_admin_perm('staff');
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if p_role not in ('admin','finance','support','catalog') then raise exception 'Choose a role: admin, finance, support or catalog'; end if;
  if exists (select 1 from platform_admins where lower(email) = em and auth_user_id is not null) then raise exception 'This person is already on the DeepQr team'; end if;
  select email into me_email from auth.users where id = auth.uid();
  v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4) || '-' || substr(md5(random()::text), 1, 4) || '-' || substr(md5(clock_timestamp()::text || random()::text), 1, 4));
  insert into platform_admins(email, name, role, claim_code_hash, invited_by, active)
  values (em, nullif(trim(p_name), ''), p_role, encode(extensions.digest(v_code, 'sha256'), 'hex'), me_email, true)
  on conflict (email) do update set name = excluded.name, role = excluded.role, claim_code_hash = excluded.claim_code_hash,
         invited_by = excluded.invited_by, active = true;
  perform dq_audit('staff.invite', 'platform_admin', em, jsonb_build_object('role', p_role));
  return json_build_object('email', em, 'role', p_role, 'code', v_code);
end $$;
create or replace function public.dq_admin_update_staff(p_email text, p_role text, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare a platform_admins;
begin
  perform dq_require_admin_perm('staff');
  select * into a from platform_admins where lower(email) = lower(trim(p_email));
  if a.email is null then raise exception 'Team member not found'; end if;
  if a.auth_user_id = auth.uid() then raise exception 'You cannot change your own access'; end if;
  if a.role = 'owner' then raise exception 'The platform owner cannot be changed here'; end if;
  if p_role is not null and p_role not in ('admin','finance','support','catalog') then raise exception 'Invalid role'; end if;
  update platform_admins set role = coalesce(p_role, role), active = coalesce(p_active, active) where email = a.email;
  perform dq_audit('staff.update', 'platform_admin', a.email, jsonb_build_object('role', p_role, 'active', p_active));
end $$;
create or replace function public.dq_admin_remove_staff(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare a platform_admins;
begin
  perform dq_require_admin_perm('staff');
  select * into a from platform_admins where lower(email) = lower(trim(p_email));
  if a.email is null then raise exception 'Team member not found'; end if;
  if a.role = 'owner' or a.auth_user_id = auth.uid() then raise exception 'The platform owner cannot be removed'; end if;
  delete from platform_admins where email = a.email;
  perform dq_audit('staff.remove', 'platform_admin', a.email, '{}'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- 2. smart QR links + public label check
-- -----------------------------------------------------------------------------
alter table public.platform_settings add column if not exists public_url text default 'https://mohdabdull9.github.io/Zanrizon-Traders/';
alter table public.businesses add column if not exists qr_format text not null default 'link';
alter table public.businesses drop constraint if exists businesses_qr_format_check;
alter table public.businesses add constraint businesses_qr_format_check check (qr_format in ('dq1','link'));
create or replace function public.dq_generate_items(
  p_product_id uuid, p_shop_id uuid, p_qty integer, p_expiry date default null, p_batch text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  m members := dq_me(); p products; s shops; bz businesses; ch jsonb;
  yr int := extract(year from now())::int; start_seq int; gen_id uuid;
  i int; ser text; first_ser text; last_ser text; v_url text;
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  if m.role not in ('owner','manager','inventory','main_operator') then raise exception 'Your role cannot generate QR codes'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 5000 then raise exception 'Quantity must be between 1 and 5000'; end if;
  perform dq_trust();
  select * into p from products where id = p_product_id and business_id = m.business_id;
  if p.id is null then raise exception 'Product not found'; end if;
  select * into s from shops where id = p_shop_id and business_id = m.business_id;
  if s.id is null then raise exception 'Shop not found'; end if;
  if s.blocked_by_platform then raise exception 'SHOP_DISABLED: % is disabled by DeepQr', s.name; end if;
  select * into bz from businesses where id = m.business_id;
  select nullif(trim(public_url), '') into v_url from platform_settings where id = 1;
  ch := dq_charge_qr(m.business_id, p_qty, p_qty || ' QR code(s) for ' || p.name, m.name);

  perform pg_advisory_xact_lock(hashtext('dq_items_' || p.id::text));
  select coalesce(max(serial_seq), 0) into start_seq from product_items where product_id = p.id and serial_year = yr;
  insert into qr_generations(business_id, product_id, shop_id, qty, fee_per_qr, total, expiry_date, batch_ref, by_name,
                             free_qty, bonus_used, paid_amount)
  values (m.business_id, p.id, s.id, p_qty, (ch->>'fee')::numeric, (ch->>'total')::numeric, p_expiry, nullif(p_batch,''), m.name,
          (ch->>'free')::int, (ch->>'bonus_used')::numeric, (ch->>'paid')::numeric)
  returning id into gen_id;
  for i in 1..p_qty loop
    ser := yr::text || lpad(p.product_no::text, 2, '0') || lpad((start_seq + i)::text, 3, '0');
    if i = 1 then first_ser := ser; end if; last_ser := ser;
    insert into product_items(business_id, product_id, shop_id, generation_id, serial, serial_year, serial_seq, qr_payload, expiry_date, batch_ref)
    values (m.business_id, p.id, s.id, gen_id, ser, yr, start_seq + i,
            case when bz.qr_format = 'link' and v_url is not null
                 then v_url || case when position('?' in v_url) > 0 then '&' else '?' end || 'dq=1.' || bz.code || '.' || s.code || '.' || regexp_replace(p.code, '[^A-Za-z0-9-]', '', 'g') || '.' || ser
                 else 'DQ1|' || bz.code || '|' || s.code || '|' || replace(p.code, '|', '') || '|' || ser end,
            p_expiry, nullif(p_batch, ''));
  end loop;
  update qr_generations set first_serial = first_ser, last_serial = last_ser where id = gen_id;
  update wallet_transactions set reference = first_ser || '…' || last_ser where id = (ch->>'tx_id')::uuid;
  if p_expiry is not null then update products set expiry_tracking = true where id = p.id; end if;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'qr', p_qty || ' QR code(s) generated for ' || p.name || ' at ' || s.name, m.name);
  return json_build_object('generation_id', gen_id, 'qty', p_qty, 'first_serial', first_ser, 'last_serial', last_ser,
    'total', (ch->>'total')::numeric, 'free', (ch->>'free')::int, 'bonus_used', (ch->>'bonus_used')::numeric,
    'paid', (ch->>'paid')::numeric, 'balance', (ch->>'balance')::numeric, 'bonus_balance', (ch->>'bonus_balance')::numeric,
    'currency', ch->>'currency', 'fee', (ch->>'fee')::numeric);
end $$;

create or replace function public.dq_lookup_item(p_code text, p_shop_id uuid default null, p_device_key text default null)
returns json language plpgsql security definer set search_path = public as $$
declare m members := dq_me(); it product_items; p products; bz businesses;
        v text := upper(regexp_replace(trim(coalesce(p_code, '')), '[\r\n\t]', '', 'g'));
        v_biz text; v_serial text;
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  perform dq_check_device(m.business_id, p_shop_id, p_device_key);
  select * into bz from businesses where id = m.business_id;
  if v ~ '^DQ1[^A-Z0-9]' then
    v_biz := substring(v from '^DQ1[^A-Z0-9]+([A-Z0-9]+)');
    v_serial := substring(v from '([0-9]{9,})[^0-9]*$');
    if v_biz is distinct from upper(bz.code) then
      return json_build_object('ok', false, 'kind', 'item', 'reason', 'OTHER_BUSINESS',
        'message', 'This QR belongs to another business (' || coalesce(v_biz, '?') || ').');
    end if;
  elsif v ~ 'DQ[^A-Z0-9]1[^A-Z0-9][A-Z0-9]+' then
    -- smart link label: https://…?dq=1.BIZ.SHOP.CODE.SERIAL (any separator a keyboard produced)
    v_biz := substring(v from 'DQ[^A-Z0-9]1[^A-Z0-9]([A-Z0-9]+)');
    v_serial := substring(v from '([0-9]{9,})[^0-9]*$');
    if v_biz is distinct from upper(bz.code) then
      return json_build_object('ok', false, 'kind', 'item', 'reason', 'OTHER_BUSINESS',
        'message', 'This QR belongs to another business (' || coalesce(v_biz, '?') || ').');
    end if;
  elsif v ~ '^[0-9]{9,}$' then
    v_serial := v;
  elsif v ~ '-[0-9]{9,}$' then
    v_serial := substring(v from '([0-9]{9,})$');
  end if;
  if v_serial is not null then
    select * into it from product_items where business_id = m.business_id and serial = v_serial;
  end if;
  if it.id is null then
    select * into p from products where business_id = m.business_id and active is not false
       and (upper(barcode) = v or upper(code) = v) limit 1;
    if p.id is not null then
      return json_build_object('ok', true, 'kind', 'product', 'product', row_to_json(p));
    end if;
    return json_build_object('ok', false, 'kind', 'unknown', 'reason', 'NOT_FOUND', 'code', v);
  end if;
  select * into p from products where id = it.product_id;
  return json_build_object(
    'ok', it.status = 'in_stock' and not (bz.block_expired_sales and it.expiry_date is not null and it.expiry_date < current_date),
    'kind', 'item',
    'reason', case when it.status = 'sold' then 'SOLD' when it.status = 'void' then 'VOID' when it.status = 'transit' then 'IN_TRANSIT'
                   when it.expiry_date is not null and it.expiry_date < current_date then 'EXPIRED' else null end,
    'item', row_to_json(it), 'product', row_to_json(p),
    'expired', it.expiry_date is not null and it.expiry_date < current_date,
    'other_shop', p_shop_id is not null and it.shop_id is distinct from p_shop_id,
    'shop_name', (select name from shops where id = it.shop_id));
end $$;

create or replace function public.dq_admin_set_public_url(p_url text) returns text
language plpgsql security definer set search_path = public as $$
declare v text := nullif(trim(p_url), '');
begin
  perform dq_require_admin_perm('settings');
  if v is not null and v !~ '^https://[^\s?#]+$' then raise exception 'Use the full https:// address of the app, without ? or #'; end if;
  if v is not null and right(v, 1) <> '/' and v !~ '\.html?$' then v := v || '/'; end if;
  update platform_settings set public_url = v where id = 1;
  perform dq_audit('settings.public_url', 'platform', '1', jsonb_build_object('url', v));
  return v;
end $$;

-- anyone (even without an account) can check a label: genuine? sold? expired?
create or replace function public.dq_verify_label(p_code text) returns json
language plpgsql stable security definer set search_path = public as $$
declare v text := upper(regexp_replace(trim(coalesce(p_code, '')), '[\r\n\t]', '', 'g')); v_biz text; v_serial text;
        b businesses; it product_items; pr products; s shops;
begin
  if v ~ 'DQ[^A-Z0-9]1[^A-Z0-9][A-Z0-9]+' then
    v_biz := substring(v from 'DQ[^A-Z0-9]1[^A-Z0-9]([A-Z0-9]+)');
  elsif v ~ '^DQ1[^A-Z0-9]' then
    v_biz := substring(v from '^DQ1[^A-Z0-9]+([A-Z0-9]+)');
  end if;
  v_serial := substring(v from '([0-9]{9,})[^0-9]*$');
  if v_biz is null or v_serial is null then return json_build_object('found', false, 'reason', 'NOT_A_DEEPQR_LABEL'); end if;
  select * into b from businesses where upper(code) = v_biz;
  if b.id is null then return json_build_object('found', false, 'reason', 'UNKNOWN_BUSINESS'); end if;
  select * into it from product_items where business_id = b.id and serial = v_serial;
  if it.id is null then return json_build_object('found', false, 'reason', 'UNKNOWN_SERIAL', 'business', b.name); end if;
  select * into pr from products where id = it.product_id;
  select * into s from shops where id = it.shop_id;
  return json_build_object('found', true, 'business', b.name, 'business_code', b.code, 'business_phone', nullif(b.phone, ''),
    'store_slug', case when b.store_enabled then b.store_slug end,
    'product', pr.name, 'code', pr.code, 'brand', pr.brand, 'unit', pr.unit, 'pack_size', pr.pack_size,
    'price', case when b.store_enabled then pr.price end,
    'serial', it.serial, 'status', it.status, 'sold_on', case when it.status = 'sold' then to_char(it.sold_at at time zone b.timezone, 'YYYY-MM-DD') end,
    'expiry_date', it.expiry_date, 'expired', it.expiry_date is not null and it.expiry_date < current_date,
    'shop', s.name, 'printed', to_char(it.created_at at time zone b.timezone, 'YYYY-MM-DD'));
end $$;

-- -----------------------------------------------------------------------------
-- 3. supplier portal
-- -----------------------------------------------------------------------------
create table if not exists public.supplier_accounts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  code text unique,
  company_name text not null,
  contact_person text,
  phone text not null,
  email text,
  tin text,
  address text,
  region text,
  groups text[] not null default '{}',
  description text,
  delivery_areas text,
  payment_terms_days integer not null default 0,
  payment_details text,
  status text not null default 'active' check (status in ('active','suspended')),
  verified boolean not null default false,
  admin_note text,
  created_at timestamptz not null default now()
);
alter table public.supplier_accounts enable row level security;
drop policy if exists supplier_accounts_read on public.supplier_accounts;
create policy supplier_accounts_read on public.supplier_accounts for select to authenticated
  using (auth_user_id = auth.uid() or public.dq_is_platform_admin()
         or (status = 'active' and public.my_business_id() is not null));

create table if not exists public.supplier_products (
  id uuid primary key default gen_random_uuid(),
  supplier_account_id uuid not null references public.supplier_accounts(id) on delete cascade,
  catalog_id uuid references public.catalog_products(id) on delete set null,
  name text not null,
  sku text,
  unit_code text not null default 'PCS',
  pack_size text,
  price numeric not null default 0 check (price >= 0),
  min_order_qty numeric not null default 1,
  lead_days integer not null default 1,
  available boolean not null default true,
  updated_at timestamptz not null default now()
);
create index if not exists supplier_products_acc_idx on public.supplier_products(supplier_account_id);
alter table public.supplier_products enable row level security;
drop policy if exists supplier_products_read on public.supplier_products;
create policy supplier_products_read on public.supplier_products for select to authenticated
  using (exists (select 1 from public.supplier_accounts a where a.id = supplier_account_id
                  and (a.auth_user_id = auth.uid() or public.dq_is_platform_admin() or (a.status = 'active' and public.my_business_id() is not null))));

alter table public.suppliers add column if not exists supplier_account_id uuid references public.supplier_accounts(id) on delete set null;
create unique index if not exists suppliers_account_key on public.suppliers(business_id, supplier_account_id) where supplier_account_id is not null;

create table if not exists public.supplier_invites (
  code text primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  used_by uuid references public.supplier_accounts(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.supplier_invites enable row level security;
drop policy if exists supplier_invites_read on public.supplier_invites;
create policy supplier_invites_read on public.supplier_invites for select to authenticated using (business_id = public.my_business_id());

alter table public.orders add column if not exists supplier_status text;
alter table public.orders drop constraint if exists orders_supplier_status_check;
alter table public.orders add constraint orders_supplier_status_check check (supplier_status is null or supplier_status in ('sent','confirmed','rejected','dispatched','delivered'));
alter table public.orders add column if not exists supplier_note text;
alter table public.orders add column if not exists supplier_eta date;
alter table public.orders add column if not exists supplier_updated_at timestamptz;
alter table public.orders add column if not exists sent_at timestamptz;
alter table public.orders add column if not exists supplier_attachments jsonb not null default '[]'::jsonb;
alter table public.order_items add column if not exists supplier_qty numeric;
alter table public.order_items add column if not exists supplier_price numeric;

alter table public.supplier_payments add column if not exists verification text not null default 'unverified';
alter table public.supplier_payments drop constraint if exists supplier_payments_verification_check;
alter table public.supplier_payments add constraint supplier_payments_verification_check check (verification in ('unverified','confirmed','disputed'));
alter table public.supplier_payments add column if not exists verified_at timestamptz;
alter table public.supplier_payments add column if not exists verify_note text;

-- supplier documents (invoices, delivery notes) live under sup/<supplier_account_id>/…
drop policy if exists dq_docs_sup_insert on storage.objects;
create policy dq_docs_sup_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'dq-docs' and (storage.foldername(name))[1] = 'sup'
              and (storage.foldername(name))[2] = (select id::text from public.supplier_accounts where auth_user_id = auth.uid()));
drop policy if exists dq_docs_sup_select on storage.objects;
create policy dq_docs_sup_select on storage.objects for select to authenticated
  using (bucket_id = 'dq-docs' and (storage.foldername(name))[1] = 'sup'
         and ((storage.foldername(name))[2] = (select id::text from public.supplier_accounts where auth_user_id = auth.uid())
              or exists (select 1 from public.suppliers s where s.business_id = public.my_business_id()
                         and s.supplier_account_id::text = (storage.foldername(name))[2])));

create or replace function public.my_supplier() returns public.supplier_accounts
language sql stable security definer set search_path = public as $$
  select * from supplier_accounts where auth_user_id = auth.uid() limit 1
$$;
create or replace function public.dq_require_supplier() returns public.supplier_accounts
language plpgsql stable security definer set search_path = public as $$
declare a supplier_accounts := my_supplier();
begin
  if a.id is null then raise exception 'Supplier account not found — register as a supplier first'; end if;
  if a.status = 'suspended' then raise exception 'SUPPLIER_SUSPENDED: your supplier account is suspended by DeepQr'; end if;
  return a;
end $$;

-- orders sent to a linked supplier become visible to them
create or replace function public.dq_orders_supplier_flow() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_acc uuid;
begin
  select supplier_account_id into v_acc from suppliers where id = new.supplier_id;
  if v_acc is null then return new; end if;
  if new.status in ('ordered','pending') and new.supplier_status is null then
    new.supplier_status := 'sent'; new.sent_at := now();
  elsif new.status in ('partial','received') and coalesce(new.supplier_status, '') in ('sent','confirmed','dispatched') then
    new.supplier_status := 'delivered'; new.supplier_updated_at := now();
  elsif new.status = 'cancelled' and new.supplier_status is not null and new.supplier_status <> 'rejected' then
    new.supplier_note := coalesce(new.supplier_note || E'\n', '') || 'Cancelled by the business';
  end if;
  return new;
end $$;
drop trigger if exists dq_orders_supplier_flow on public.orders;
create trigger dq_orders_supplier_flow before insert or update of status on public.orders for each row execute function public.dq_orders_supplier_flow();

create or replace function public.dq_supplier_register(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare a supplier_accounts; inv supplier_invites; n int;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from members where auth_user_id = auth.uid()) then raise exception 'This login already belongs to a business. Use another email for the supplier account.'; end if;
  if exists (select 1 from supplier_accounts where auth_user_id = auth.uid()) then raise exception 'You already have a supplier account'; end if;
  if nullif(trim(p->>'company_name'), '') is null then raise exception 'Enter the company name'; end if;
  if dq_phone(p->>'phone') is null then raise exception 'Enter a phone number'; end if;
  perform pg_advisory_xact_lock(hashtext('dq_supplier_code'));
  select count(*) + 1 into n from supplier_accounts;
  insert into supplier_accounts(auth_user_id, code, company_name, contact_person, phone, email, tin, address, region, groups, description, delivery_areas, payment_terms_days, payment_details)
  values (auth.uid(), 'SUP' || lpad(n::text, 4, '0'), trim(p->>'company_name'), nullif(trim(p->>'contact_person'), ''), dq_phone(p->>'phone'),
          coalesce(nullif(trim(p->>'email'), ''), (select email from auth.users where id = auth.uid())), nullif(trim(p->>'tin'), ''),
          nullif(trim(p->>'address'), ''), nullif(trim(p->>'region'), ''),
          coalesce((select array_agg(g) from jsonb_array_elements_text(coalesce(p->'groups','[]'::jsonb)) g where g in (select code from dq_groups)), '{}'),
          nullif(trim(p->>'description'), ''), nullif(trim(p->>'delivery_areas'), ''), greatest(coalesce((p->>'payment_terms_days')::int, 0), 0),
          nullif(trim(p->>'payment_details'), ''))
  returning * into a;
  if nullif(trim(p->>'invite_code'), '') is not null then
    select * into inv from supplier_invites where code = upper(trim(p->>'invite_code')) and used_by is null for update;
    if inv.code is not null then
      perform dq_trust();
      update suppliers set supplier_account_id = a.id where id = inv.supplier_id and supplier_account_id is null;
      update supplier_invites set used_by = a.id, used_at = now() where code = inv.code;
      update orders set supplier_status = 'sent', sent_at = coalesce(sent_at, now())
       where supplier_id = inv.supplier_id and status in ('ordered','pending') and supplier_status is null;
    end if;
  end if;
  return row_to_json(a);
end $$;

create or replace function public.dq_supplier_update_profile(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare a supplier_accounts := dq_require_supplier();
begin
  update supplier_accounts set
    company_name = coalesce(nullif(trim(p->>'company_name'), ''), company_name),
    contact_person = case when p ? 'contact_person' then nullif(trim(p->>'contact_person'), '') else contact_person end,
    phone = coalesce(dq_phone(p->>'phone'), phone),
    tin = case when p ? 'tin' then nullif(trim(p->>'tin'), '') else tin end,
    address = case when p ? 'address' then nullif(trim(p->>'address'), '') else address end,
    region = case when p ? 'region' then nullif(trim(p->>'region'), '') else region end,
    groups = case when p ? 'groups' then coalesce((select array_agg(g) from jsonb_array_elements_text(p->'groups') g where g in (select code from dq_groups)), '{}') else groups end,
    description = case when p ? 'description' then nullif(trim(p->>'description'), '') else description end,
    delivery_areas = case when p ? 'delivery_areas' then nullif(trim(p->>'delivery_areas'), '') else delivery_areas end,
    payment_terms_days = coalesce((p->>'payment_terms_days')::int, payment_terms_days),
    payment_details = case when p ? 'payment_details' then nullif(trim(p->>'payment_details'), '') else payment_details end
  where id = a.id returning * into a;
  return row_to_json(a);
end $$;

create or replace function public.dq_supplier_save_product(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare a supplier_accounts := dq_require_supplier(); sp supplier_products; c catalog_products;
begin
  if coalesce((p->>'delete')::boolean, false) then
    delete from supplier_products where id = (p->>'id')::uuid and supplier_account_id = a.id; return null;
  end if;
  if nullif(p->>'catalog_id','') is not null then select * into c from catalog_products where id = (p->>'catalog_id')::uuid and status = 'approved'; end if;
  if coalesce(nullif(trim(p->>'name'), ''), c.name) is null then raise exception 'Enter the product name'; end if;
  if coalesce((p->>'price')::numeric, -1) < 0 then raise exception 'Enter your price'; end if;
  if nullif(p->>'id','') is not null then
    update supplier_products set name = coalesce(nullif(trim(p->>'name'), ''), name), sku = nullif(trim(p->>'sku'), ''),
           unit_code = coalesce(nullif(p->>'unit_code',''), unit_code), pack_size = nullif(trim(p->>'pack_size'), ''),
           price = (p->>'price')::numeric, min_order_qty = greatest(coalesce((p->>'min_order_qty')::numeric, 1), 0),
           lead_days = greatest(coalesce((p->>'lead_days')::int, 1), 0), available = coalesce((p->>'available')::boolean, true),
           catalog_id = coalesce(c.id, catalog_id), updated_at = now()
     where id = (p->>'id')::uuid and supplier_account_id = a.id returning * into sp;
    if sp.id is null then raise exception 'Product not found'; end if;
  else
    insert into supplier_products(supplier_account_id, catalog_id, name, sku, unit_code, pack_size, price, min_order_qty, lead_days, available)
    values (a.id, c.id, coalesce(nullif(trim(p->>'name'), ''), case when c.brand is not null and position(lower(c.brand) in lower(c.name)) = 0 then c.brand || ' ' || c.name else c.name end),
            nullif(trim(p->>'sku'), ''), coalesce(nullif(p->>'unit_code',''), c.unit_code, 'PCS'), coalesce(nullif(trim(p->>'pack_size'), ''), c.pack_size),
            (p->>'price')::numeric, greatest(coalesce((p->>'min_order_qty')::numeric, 1), 0), greatest(coalesce((p->>'lead_days')::int, 1), 0), true)
    returning * into sp;
  end if;
  return row_to_json(sp);
end $$;

-- businesses: browse registered suppliers
create or replace function public.dq_supplier_directory(p jsonb default '{}'::jsonb) returns json
language plpgsql stable security definer set search_path = public as $$
declare m members := dq_me(); q text := lower(coalesce(p->>'q', '')); g text := nullif(p->>'group', '');
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  return coalesce((select json_agg(x order by x.verified desc, x.products desc, x.company_name) from (
    select a.id, a.code, a.company_name, a.contact_person, a.phone, a.email, a.region, a.address, a.groups, a.description, a.delivery_areas,
           a.payment_terms_days, a.verified,
           (select count(*) from supplier_products sp where sp.supplier_account_id = a.id and sp.available) as products,
           (select count(distinct business_id) from suppliers s where s.supplier_account_id = a.id) as businesses,
           (select s.id from suppliers s where s.supplier_account_id = a.id and s.business_id = m.business_id) as my_supplier_id,
           (select count(*) from suppliers s join orders o on o.supplier_id = s.id where s.supplier_account_id = a.id and o.supplier_status in ('delivered')) as delivered_orders,
           (select count(*) from suppliers s join orders o on o.supplier_id = s.id where s.supplier_account_id = a.id and o.supplier_status in ('confirmed','dispatched','delivered','rejected')) as answered_orders,
           (select count(*) from suppliers s join orders o on o.supplier_id = s.id where s.supplier_account_id = a.id and o.supplier_status = 'rejected') as rejected_orders
      from supplier_accounts a
     where a.status = 'active'
       and (g is null or g = any(a.groups))
       and (q = '' or lower(a.company_name || ' ' || coalesce(a.region,'') || ' ' || coalesce(a.description,'')) like '%' || q || '%'
            or exists (select 1 from supplier_products sp where sp.supplier_account_id = a.id and lower(sp.name) like '%' || q || '%'))
     limit 200) x), '[]'::json);
end $$;

create or replace function public.dq_link_supplier(p_account uuid) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager','inventory','main_operator']); a supplier_accounts; s suppliers;
begin
  select * into a from supplier_accounts where id = p_account and status = 'active';
  if a.id is null then raise exception 'Supplier not found'; end if;
  select * into s from suppliers where business_id = m.business_id and supplier_account_id = a.id;
  if s.id is not null then return row_to_json(s); end if;
  select * into s from suppliers where business_id = m.business_id and lower(name) = lower(a.company_name) and supplier_account_id is null;
  if s.id is not null then
    update suppliers set supplier_account_id = a.id, phone = coalesce(phone, a.phone), email = coalesce(email, a.email), tin = coalesce(tin, a.tin)
     where id = s.id returning * into s;
  else
    insert into suppliers(business_id, name, contact_person, phone, email, address, tin, payment_terms_days, notes, supplier_account_id)
    values (m.business_id, a.company_name, a.contact_person, a.phone, a.email, a.address, a.tin, a.payment_terms_days, a.payment_details, a.id)
    returning * into s;
  end if;
  insert into activity_log(business_id, type, description, by_name) values (m.business_id, 'supplier', 'Added DeepQr supplier ' || a.company_name, m.name);
  return row_to_json(s);
end $$;

create or replace function public.dq_supplier_invite(p_supplier_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager','inventory','main_operator']); s suppliers; v_code text;
begin
  select * into s from suppliers where id = p_supplier_id and business_id = m.business_id;
  if s.id is null then raise exception 'Supplier not found'; end if;
  if s.supplier_account_id is not null then raise exception 'This supplier already uses DeepQr'; end if;
  select code into v_code from supplier_invites where supplier_id = s.id and used_by is null;
  if v_code is null then
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    insert into supplier_invites(code, business_id, supplier_id) values (v_code, m.business_id, s.id);
  end if;
  return json_build_object('code', v_code, 'supplier', s.name, 'phone', s.phone);
end $$;

-- supplier side: their orders, answers and payments
create or replace function public.dq_supplier_orders() returns json
language plpgsql stable security definer set search_path = public as $$
declare a supplier_accounts := my_supplier();
begin
  if a.id is null then raise exception 'Supplier account not found'; end if;
  return json_build_object('account', row_to_json(a),
    'orders', coalesce((select json_agg(x order by x.sent_at desc nulls last) from (
      select o.id, o.order_no, o.order_date, o.expected_date, o.status, o.supplier_status, o.supplier_note, o.supplier_eta, o.sent_at,
             o.total_cost, o.received_value, o.paid_amount, o.payment_status, o.invoice_no, o.invoice_amount, o.note, o.supplier_attachments,
             b.name as business_name, b.code as business_code, b.phone as business_phone,
             sh.name as deliver_to, sh.address as deliver_address, sh.phone as deliver_phone, s.id as supplier_id,
             (select json_agg(json_build_object('id', i.id, 'product', coalesce(i.product_name, pr.name), 'code', pr.code, 'unit', pr.unit,
                     'qty_ordered', i.qty_ordered, 'qty_received', i.qty_received, 'qty_damaged', i.qty_damaged, 'unit_cost', i.unit_cost,
                     'supplier_qty', i.supplier_qty, 'supplier_price', i.supplier_price) order by i.product_name)
                from order_items i left join products pr on pr.id = i.product_id where i.order_id = o.id) as items
        from orders o join suppliers s on s.id = o.supplier_id join businesses b on b.id = o.business_id left join shops sh on sh.id = o.shop_id
       where s.supplier_account_id = a.id and o.supplier_status is not null limit 500) x), '[]'::json),
    'payments', coalesce((select json_agg(x order by x.created_at desc) from (
      select sp.id, sp.amount, sp.method, sp.reference, sp.paid_on, sp.note, sp.verification, sp.verified_at, sp.verify_note, sp.created_at,
             sp.attachments, b.name as business_name, o.order_no
        from supplier_payments sp join suppliers s on s.id = sp.supplier_id join businesses b on b.id = sp.business_id left join orders o on o.id = sp.order_id
       where s.supplier_account_id = a.id limit 500) x), '[]'::json),
    'customers', coalesce((select json_agg(x) from (
      select b.name, b.code, b.phone, s.balance as owed_to_you,
             (select count(*) from orders o where o.supplier_id = s.id and o.supplier_status is not null) as orders,
             (select coalesce(sum(o.received_value), 0) from orders o where o.supplier_id = s.id) as bought
        from suppliers s join businesses b on b.id = s.business_id where s.supplier_account_id = a.id) x), '[]'::json),
    'products', coalesce((select json_agg(row_to_json(sp) order by sp.name) from supplier_products sp where sp.supplier_account_id = a.id), '[]'::json));
end $$;

create or replace function public.dq_supplier_respond(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare a supplier_accounts := dq_require_supplier(); o orders; s suppliers; v_action text := p->>'action'; ln jsonb;
begin
  select o2.* into o from orders o2 join suppliers s2 on s2.id = o2.supplier_id
   where o2.id = (p->>'order_id')::uuid and s2.supplier_account_id = a.id for update of o2;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status in ('cancelled','closed') then raise exception 'The business has % this order', o.status; end if;
  perform dq_trust();
  if v_action = 'confirm' then
    if o.supplier_status not in ('sent','confirmed') then raise exception 'This order is already %', o.supplier_status; end if;
    for ln in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
      update order_items set supplier_qty = greatest(coalesce((ln->>'qty')::numeric, qty_ordered), 0),
             supplier_price = greatest(coalesce((ln->>'price')::numeric, unit_cost), 0)
       where id = (ln->>'id')::uuid and order_id = o.id;
    end loop;
    update orders set supplier_status = 'confirmed', supplier_eta = coalesce(nullif(p->>'eta','')::date, supplier_eta, expected_date),
           supplier_note = nullif(trim(p->>'note'), ''), supplier_updated_at = now() where id = o.id returning * into o;
  elsif v_action = 'reject' then
    if o.supplier_status in ('dispatched','delivered') then raise exception 'The goods are already %', o.supplier_status; end if;
    if nullif(trim(p->>'note'), '') is null then raise exception 'Tell the business why you cannot supply this order'; end if;
    update orders set supplier_status = 'rejected', supplier_note = p->>'note', supplier_updated_at = now() where id = o.id returning * into o;
  elsif v_action = 'dispatch' then
    if o.supplier_status not in ('sent','confirmed') then raise exception 'Confirm the order first'; end if;
    update orders set supplier_status = 'dispatched', supplier_updated_at = now(),
           supplier_eta = coalesce(nullif(p->>'eta','')::date, supplier_eta),
           supplier_note = coalesce(nullif(trim(p->>'note'), ''), supplier_note),
           invoice_no = coalesce(nullif(trim(p->>'invoice_no'), ''), invoice_no),
           invoice_amount = coalesce(nullif(p->>'invoice_amount','')::numeric, invoice_amount),
           supplier_attachments = supplier_attachments || coalesce(p->'attachments', '[]'::jsonb)
     where id = o.id returning * into o;
  else raise exception 'Unknown action';
  end if;
  insert into activity_log(business_id, type, description, by_name)
  values (o.business_id, 'supplier', a.company_name || ' ' || o.supplier_status || ' order ' || coalesce(o.order_no, '') || coalesce(': ' || nullif(trim(p->>'note'), ''), ''), a.company_name);
  return row_to_json(o);
end $$;

create or replace function public.dq_supplier_verify_payment(p_id uuid, p_confirm boolean, p_note text default null) returns json
language plpgsql security definer set search_path = public as $$
declare a supplier_accounts := dq_require_supplier(); sp supplier_payments;
begin
  select x.* into sp from supplier_payments x join suppliers s on s.id = x.supplier_id where x.id = p_id and s.supplier_account_id = a.id for update of x;
  if sp.id is null then raise exception 'Payment not found'; end if;
  if not p_confirm and nullif(trim(p_note), '') is null then raise exception 'Explain what is wrong with this payment'; end if;
  update supplier_payments set verification = case when p_confirm then 'confirmed' else 'disputed' end, verified_at = now(), verify_note = nullif(trim(p_note), '')
   where id = sp.id returning * into sp;
  insert into activity_log(business_id, type, description, by_name)
  values (sp.business_id, 'supplier', a.company_name || case when p_confirm then ' confirmed receiving ' else ' DISPUTED payment of ' end || sp.amount || coalesce(' — ' || p_note, ''), a.company_name);
  return row_to_json(sp);
end $$;

create or replace function public.dq_admin_suppliers() returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin_perm('view');
  return coalesce((select json_agg(x order by x.created_at desc) from (
    select a.*, (select email from auth.users u where u.id = a.auth_user_id) as login_email,
           (select count(*) from supplier_products sp where sp.supplier_account_id = a.id) as products,
           (select count(*) from suppliers s where s.supplier_account_id = a.id) as businesses,
           (select count(*) from suppliers s join orders o on o.supplier_id = s.id where s.supplier_account_id = a.id and o.supplier_status is not null) as orders,
           (select coalesce(sum(o.received_value), 0) from suppliers s join orders o on o.supplier_id = s.id where s.supplier_account_id = a.id) as sales
      from supplier_accounts a) x), '[]'::json);
end $$;
create or replace function public.dq_admin_set_supplier(p_id uuid, p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare a supplier_accounts;
begin
  perform dq_require_admin_perm('support');
  update supplier_accounts set status = coalesce(nullif(p->>'status',''), status), verified = coalesce((p->>'verified')::boolean, verified),
         admin_note = case when p ? 'note' then p->>'note' else admin_note end
   where id = p_id returning * into a;
  if a.id is null then raise exception 'Supplier not found'; end if;
  perform dq_audit('supplier.update', 'supplier', p_id::text, p);
  return row_to_json(a);
end $$;

-- -----------------------------------------------------------------------------
-- 4. online store, customer accounts, online orders with points
-- -----------------------------------------------------------------------------
alter table public.businesses add column if not exists store_enabled boolean not null default false;
alter table public.businesses add column if not exists store_slug text;
create unique index if not exists businesses_store_slug_key on public.businesses(store_slug) where store_slug is not null;
alter table public.businesses add column if not exists store_tagline text;
alter table public.businesses add column if not exists store_shop_id uuid references public.shops(id) on delete set null;
alter table public.businesses add column if not exists store_area text;
alter table public.businesses add column if not exists store_hours text;
alter table public.businesses add column if not exists store_pickup boolean not null default true;
alter table public.businesses add column if not exists store_delivery boolean not null default false;
alter table public.businesses add column if not exists store_delivery_fee numeric not null default 0;
alter table public.businesses add column if not exists store_free_delivery_over numeric;
alter table public.businesses add column if not exists store_min_order numeric not null default 0;
alter table public.businesses add column if not exists store_pay_on_collection boolean not null default true;
alter table public.businesses add column if not exists store_payment_accounts jsonb not null default '[]'::jsonb;
alter table public.businesses add column if not exists first_order_points integer not null default 0;
alter table public.products add column if not exists online boolean not null default true;

create table if not exists public.customer_accounts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  name text not null,
  phone text not null unique,
  email text,
  address text,
  area text,
  created_at timestamptz not null default now()
);
alter table public.customer_accounts enable row level security;
drop policy if exists customer_accounts_self on public.customer_accounts;
create policy customer_accounts_self on public.customer_accounts for select to authenticated
  using (auth_user_id = auth.uid() or public.dq_is_platform_admin());
alter table public.customers add column if not exists account_id uuid references public.customer_accounts(id) on delete set null;
create unique index if not exists customers_account_key on public.customers(business_id, account_id) where account_id is not null;

create table if not exists public.online_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_no text not null unique,
  account_id uuid not null references public.customer_accounts(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  shop_id uuid references public.shops(id) on delete set null,
  customer_name text not null,
  customer_phone text not null,
  fulfilment text not null check (fulfilment in ('pickup','delivery')),
  delivery_address text,
  delivery_fee numeric not null default 0,
  subtotal numeric not null default 0,
  points_redeem integer not null default 0,
  points_value numeric not null default 0,
  total numeric not null default 0,
  payment_method text not null,
  payment_reference text,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','pending_verification','paid','rejected','refunded')),
  payment_verified_by text,
  payment_verified_at timestamptz,
  status text not null default 'placed' check (status in ('placed','accepted','preparing','ready','out_for_delivery','completed','cancelled','rejected')),
  wanted_at text,
  note text,
  staff_note text,
  sale_id uuid references public.sales(id) on delete set null,
  points_earned integer not null default 0,
  timeline jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists online_orders_biz_idx on public.online_orders(business_id, status, created_at desc);
create table if not exists public.online_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.online_orders(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  name text not null,
  code text,
  unit text,
  qty numeric not null check (qty > 0),
  price numeric not null
);
alter table public.online_orders enable row level security;
alter table public.online_order_items enable row level security;
drop policy if exists online_orders_read on public.online_orders;
create policy online_orders_read on public.online_orders for select to authenticated
  using (business_id = public.my_business_id() or account_id = (select id from public.customer_accounts where auth_user_id = auth.uid()) or public.dq_is_platform_admin());
drop policy if exists online_order_items_read on public.online_order_items;
create policy online_order_items_read on public.online_order_items for select to authenticated
  using (exists (select 1 from public.online_orders o where o.id = order_id));
grant select on public.online_orders, public.online_order_items, public.customer_accounts, public.supplier_accounts, public.supplier_products to authenticated;

create or replace function public.my_customer_account() returns public.customer_accounts
language sql stable security definer set search_path = public as $$
  select * from customer_accounts where auth_user_id = auth.uid() limit 1
$$;

create or replace function public.dq_store_settings(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']); b businesses; v_slug text;
begin
  select * into b from businesses where id = m.business_id;
  v_slug := lower(regexp_replace(regexp_replace(coalesce(nullif(trim(p->>'store_slug'), ''), b.store_slug, b.name), '[^A-Za-z0-9]+', '-', 'g'), '(^-|-$)', '', 'g'));
  if length(v_slug) < 3 then raise exception 'The shop link must have at least 3 letters'; end if;
  if exists (select 1 from businesses where store_slug = v_slug and id <> b.id) then raise exception 'STORE_SLUG: the link "%" is taken — try another', v_slug; end if;
  if coalesce((p->>'store_enabled')::boolean, false) and not coalesce((p->>'store_pickup')::boolean, b.store_pickup) and not coalesce((p->>'store_delivery')::boolean, b.store_delivery) then
    raise exception 'Offer pickup, delivery or both';
  end if;
  if nullif(p->>'store_shop_id','') is not null and not exists (select 1 from shops where id = (p->>'store_shop_id')::uuid and business_id = b.id) then
    raise exception 'Choose one of your shops'; end if;
  update businesses set store_enabled = coalesce((p->>'store_enabled')::boolean, store_enabled), store_slug = v_slug,
    store_tagline = case when p ? 'store_tagline' then nullif(trim(p->>'store_tagline'), '') else store_tagline end,
    store_shop_id = case when p ? 'store_shop_id' then nullif(p->>'store_shop_id','')::uuid else store_shop_id end,
    store_area = case when p ? 'store_area' then nullif(trim(p->>'store_area'), '') else store_area end,
    store_hours = case when p ? 'store_hours' then nullif(trim(p->>'store_hours'), '') else store_hours end,
    store_pickup = coalesce((p->>'store_pickup')::boolean, store_pickup), store_delivery = coalesce((p->>'store_delivery')::boolean, store_delivery),
    store_delivery_fee = greatest(coalesce((p->>'store_delivery_fee')::numeric, store_delivery_fee), 0),
    store_free_delivery_over = case when p ? 'store_free_delivery_over' then nullif(p->>'store_free_delivery_over','')::numeric else store_free_delivery_over end,
    store_min_order = greatest(coalesce((p->>'store_min_order')::numeric, store_min_order), 0),
    store_pay_on_collection = coalesce((p->>'store_pay_on_collection')::boolean, store_pay_on_collection),
    store_payment_accounts = coalesce(p->'store_payment_accounts', store_payment_accounts),
    first_order_points = greatest(coalesce((p->>'first_order_points')::int, first_order_points), 0)
  where id = b.id returning * into b;
  insert into activity_log(business_id, type, description, by_name)
  values (b.id, 'settings', 'Online shop ' || case when b.store_enabled then 'open at /' || b.store_slug else 'closed' end, m.name);
  return row_to_json(b);
end $$;

-- public: list of open online shops, and one shop's products (no login needed)
create or replace function public.dq_store_directory(p jsonb default '{}'::jsonb) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x order by x.products desc, x.name), '[]'::json) from (
    select b.name, b.store_slug as slug, b.store_tagline as tagline, b.store_area as area, b.business_groups as groups,
           b.store_pickup as pickup, b.store_delivery as delivery, b.store_delivery_fee as delivery_fee, b.store_min_order as min_order,
           b.loyalty_enabled as loyalty, b.currency,
           (select count(*) from products pr where pr.business_id = b.id and pr.active is not false and pr.online and pr.price > 0) as products
      from businesses b
     where b.store_enabled and b.store_slug is not null
       and not exists (select 1 from dq_accounts a where a.business_id = b.id and a.status = 'suspended')
       and (coalesce(p->>'q','') = '' or lower(b.name || ' ' || coalesce(b.store_area,'') || ' ' || coalesce(b.store_tagline,'')) like '%' || lower(p->>'q') || '%')
       and (nullif(p->>'group','') is null or (p->>'group') = any(b.business_groups))
     limit 300) x
$$;
create or replace function public.dq_store_catalog(p_slug text) returns json
language plpgsql stable security definer set search_path = public as $$
declare b businesses; ca customer_accounts := my_customer_account(); cu customers;
begin
  select * into b from businesses where store_slug = lower(trim(p_slug)) and store_enabled;
  if b.id is null then raise exception 'STORE_NOT_FOUND: this shop is not open online'; end if;
  if ca.id is not null then select * into cu from customers where business_id = b.id and account_id = ca.id; end if;
  return json_build_object(
    'store', json_build_object('name', b.name, 'slug', b.store_slug, 'tagline', b.store_tagline, 'area', b.store_area, 'hours', b.store_hours,
       'phone', nullif(b.phone, ''), 'address', nullif(b.address, ''), 'currency', b.currency, 'groups', b.business_groups,
       'pickup', b.store_pickup, 'delivery', b.store_delivery, 'delivery_fee', b.store_delivery_fee, 'free_delivery_over', b.store_free_delivery_over,
       'min_order', b.store_min_order, 'pay_on_collection', b.store_pay_on_collection, 'payment_accounts', b.store_payment_accounts,
       'loyalty', b.loyalty_enabled, 'points_per_amount', b.points_per_amount, 'point_value', b.point_value, 'min_redeem_points', b.min_redeem_points,
       'first_order_points', b.first_order_points,
       'pickup_shop', (select name from shops where id = b.store_shop_id)),
    'me', case when cu.id is null then null else json_build_object('points', cu.points, 'linked', true) end,
    'products', coalesce((select json_agg(x order by x.category, x.name) from (
      select pr.id, pr.name, pr.code, pr.brand, pr.category, pr.group_code, pr.unit, pr.pack_size, pr.price, pr.description,
             case when b.store_shop_id is not null then coalesce((select qty from stock_levels sl where sl.product_id = pr.id and sl.shop_id = b.store_shop_id), 0)
                  else coalesce((select sum(qty) from stock_levels sl join shops sh on sh.id = sl.shop_id where sl.product_id = pr.id and sh.type <> 'warehouse'), 0) end as stock
        from products pr where pr.business_id = b.id and pr.active is not false and pr.online and pr.price > 0) x), '[]'::json));
end $$;

create or replace function public.dq_customer_register(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare ca customer_accounts; v_phone text := dq_phone(p->>'phone');
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from members where auth_user_id = auth.uid()) or exists (select 1 from supplier_accounts where auth_user_id = auth.uid()) then
    raise exception 'This login is used by a business or supplier. Use another email to shop as a customer.';
  end if;
  if exists (select 1 from customer_accounts where auth_user_id = auth.uid()) then raise exception 'You already have a customer account'; end if;
  if nullif(trim(p->>'name'), '') is null then raise exception 'Enter your name'; end if;
  if v_phone is null or length(v_phone) < 9 then raise exception 'Enter your mobile number'; end if;
  if exists (select 1 from customer_accounts where phone = v_phone) then raise exception 'PHONE_TAKEN: this phone number already has a DeepQr customer account'; end if;
  insert into customer_accounts(auth_user_id, name, phone, email, address, area)
  values (auth.uid(), trim(p->>'name'), v_phone, coalesce(nullif(trim(p->>'email'),''), (select email from auth.users where id = auth.uid())),
          nullif(trim(p->>'address'), ''), nullif(trim(p->>'area'), ''))
  returning * into ca;
  return row_to_json(ca);
end $$;
create or replace function public.dq_customer_update(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare ca customer_accounts := my_customer_account();
begin
  if ca.id is null then raise exception 'Customer account not found'; end if;
  update customer_accounts set name = coalesce(nullif(trim(p->>'name'), ''), name),
         address = case when p ? 'address' then nullif(trim(p->>'address'), '') else address end,
         area = case when p ? 'area' then nullif(trim(p->>'area'), '') else area end
   where id = ca.id returning * into ca;
  return row_to_json(ca);
end $$;
create or replace function public.dq_customer_home() returns json
language plpgsql stable security definer set search_path = public as $$
declare ca customer_accounts := my_customer_account();
begin
  if ca.id is null then raise exception 'Customer account not found'; end if;
  return json_build_object('account', row_to_json(ca),
    'loyalty', coalesce((select json_agg(json_build_object('business', b.name, 'slug', case when b.store_enabled then b.store_slug end, 'points', c.points,
                 'worth', round(c.points * b.point_value, 2), 'currency', b.currency, 'min_redeem', b.min_redeem_points, 'owes', c.balance,
                 'visits', c.visits, 'last_visit', c.last_visit) order by c.points desc)
       from customers c join businesses b on b.id = c.business_id where c.account_id = ca.id), '[]'::json),
    'orders', coalesce((select json_agg(x order by x.created_at desc) from (
       select o.*, b.name as business_name, b.store_slug as slug, b.phone as business_phone, b.currency,
              (select json_agg(row_to_json(i)) from online_order_items i where i.order_id = o.id) as items
         from online_orders o join businesses b on b.id = o.business_id where o.account_id = ca.id limit 100) x), '[]'::json),
    'history', coalesce((select json_agg(x order by x.created_at desc) from (
       select l.created_at, l.type, l.points, l.amount, l.note, b.name as business
         from customer_ledger l join customers c on c.id = l.customer_id join businesses b on b.id = c.business_id
        where c.account_id = ca.id limit 100) x), '[]'::json));
end $$;

create or replace function public.dq_place_online_order(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare ca customer_accounts := my_customer_account(); b businesses; o online_orders; it jsonb; pr products; cu customers;
        v_sub numeric := 0; v_fee numeric := 0; v_pts int := greatest(coalesce((p->>'points_redeem')::int, 0), 0); v_pval numeric := 0;
        v_total numeric; v_avail numeric; v_method text := coalesce(nullif(trim(p->>'payment_method'), ''), 'Pay on collection');
        v_ref text := upper(nullif(trim(p->>'payment_reference'), '')); n int; v_ful text := coalesce(p->>'fulfilment', 'pickup'); v_reserved int;
begin
  if ca.id is null then raise exception 'CUSTOMER_ACCOUNT: sign in or create a customer account to order'; end if;
  select * into b from businesses where store_slug = lower(trim(p->>'slug')) and store_enabled;
  if b.id is null then raise exception 'STORE_NOT_FOUND: this shop is not taking online orders'; end if;
  if exists (select 1 from dq_accounts a where a.business_id = b.id and a.status = 'suspended') then raise exception 'This shop is not taking orders right now'; end if;
  if v_ful = 'pickup' and not b.store_pickup then raise exception 'This shop only delivers'; end if;
  if v_ful = 'delivery' and not b.store_delivery then raise exception 'This shop does not deliver — choose pickup'; end if;
  if v_ful = 'delivery' and nullif(trim(p->>'delivery_address'), '') is null then raise exception 'Enter the delivery address'; end if;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'Your basket is empty'; end if;
  if jsonb_array_length(p->'items') > 60 then raise exception 'At most 60 different products per order'; end if;
  perform pg_advisory_xact_lock(hashtext('dq_online_' || b.id::text));
  select count(*) + 1 into n from online_orders where business_id = b.id;
  insert into online_orders(business_id, order_no, account_id, shop_id, customer_name, customer_phone, fulfilment, delivery_address,
                            payment_method, payment_reference, note, wanted_at, timeline)
  values (b.id, b.code || '-W' || lpad(n::text, 5, '0'), ca.id, b.store_shop_id, ca.name, ca.phone, v_ful,
          case when v_ful = 'delivery' then trim(p->>'delivery_address') end, v_method, v_ref, nullif(trim(p->>'note'), ''),
          nullif(trim(p->>'wanted_at'), ''), jsonb_build_array(jsonb_build_object('status','placed','at',now(),'by',ca.name)))
  returning * into o;
  for it in select * from jsonb_array_elements(p->'items') loop
    select * into pr from products where id = nullif(it->>'product_id','')::uuid and business_id = b.id and active is not false and online and price > 0;
    if pr.id is null then raise exception 'ITEM_UNAVAILABLE: a product in your basket is no longer sold online'; end if;
    if coalesce((it->>'qty')::numeric, 0) <= 0 or (it->>'qty')::numeric > 1000 then raise exception 'Check the quantity of %', pr.name; end if;
    v_avail := case when b.store_shop_id is not null then coalesce((select qty from stock_levels where product_id = pr.id and shop_id = b.store_shop_id), 0)
                    else coalesce((select sum(qty) from stock_levels sl join shops sh on sh.id = sl.shop_id where sl.product_id = pr.id and sh.type <> 'warehouse'), 0) end;
    if (it->>'qty')::numeric > v_avail then raise exception 'OUT_OF_STOCK: only % % of % available', v_avail, lower(coalesce(pr.unit, 'pcs')), pr.name; end if;
    insert into online_order_items(order_id, business_id, product_id, name, code, unit, qty, price)
    values (o.id, b.id, pr.id, pr.name, pr.code, pr.unit, (it->>'qty')::numeric, pr.price);
    v_sub := v_sub + (it->>'qty')::numeric * pr.price;
  end loop;
  v_sub := round(v_sub, 2);
  if v_sub < b.store_min_order then raise exception 'MIN_ORDER: the minimum order at % is % %', b.name, b.store_min_order, b.currency; end if;
  if v_ful = 'delivery' then
    v_fee := case when b.store_free_delivery_over is not null and v_sub >= b.store_free_delivery_over then 0 else b.store_delivery_fee end;
  end if;
  if v_pts > 0 then
    if not b.loyalty_enabled then raise exception 'This shop does not use points'; end if;
    select * into cu from customers where business_id = b.id and account_id = ca.id;
    if cu.id is null then raise exception 'POINTS: you have no points at this shop yet'; end if;
    select coalesce(sum(points_redeem), 0) into v_reserved from online_orders
     where account_id = ca.id and business_id = b.id and status not in ('completed','cancelled','rejected') and id <> o.id;
    if v_pts > cu.points - v_reserved then raise exception 'POINTS: you can use up to % points', greatest(cu.points - v_reserved, 0); end if;
    if v_pts < b.min_redeem_points then raise exception 'POINTS: use at least % points', b.min_redeem_points; end if;
    v_pval := least(round(v_pts * b.point_value, 2), v_sub);
  end if;
  v_total := round(v_sub + v_fee - v_pval, 2);
  if v_method <> 'Pay on collection' and v_total > 0 and (v_ref is null or length(v_ref) < 4) then
    raise exception 'PAYMENT_REF: enter the transaction reference from your % message', v_method;
  end if;
  if v_method = 'Pay on collection' and not b.store_pay_on_collection then raise exception 'This shop needs payment before it prepares your order'; end if;
  if v_ref is not null and exists (select 1 from online_orders where business_id = b.id and upper(payment_reference) = v_ref and id <> o.id and payment_status <> 'rejected') then
    raise exception 'DUPLICATE_REFERENCE: reference % was already used', v_ref;
  end if;
  update online_orders set subtotal = v_sub, delivery_fee = v_fee, points_redeem = v_pts, points_value = v_pval, total = v_total,
         customer_id = cu.id,
         payment_status = case when v_method = 'Pay on collection' or v_total = 0 then 'unpaid' else 'pending_verification' end
   where id = o.id returning * into o;
  insert into activity_log(business_id, type, description, by_name)
  values (b.id, 'online', 'Online order ' || o.order_no || ' from ' || ca.name || ': ' || v_total || ' ' || b.currency || ' (' || v_ful || ')', ca.name);
  return row_to_json(o);
end $$;

create or replace function public.dq_customer_cancel_order(p_id uuid, p_reason text default null) returns json
language plpgsql security definer set search_path = public as $$
declare ca customer_accounts := my_customer_account(); o online_orders;
begin
  select * into o from online_orders where id = p_id and account_id = ca.id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status not in ('placed','accepted') then raise exception 'The shop is already preparing your order — call them to change it'; end if;
  update online_orders set status = 'cancelled', updated_at = now(),
         payment_status = case when payment_status = 'paid' then 'refunded' else payment_status end,
         timeline = timeline || jsonb_build_object('status','cancelled','at',now(),'by',ca.name,'note',nullif(trim(p_reason),''))
   where id = o.id returning * into o;
  return row_to_json(o);
end $$;

-- shop staff move an online order along
create or replace function public.dq_online_order_action(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); o online_orders; v_action text := p->>'action'; v_note text := nullif(trim(p->>'note'), '');
        cu customers; ca customer_accounts; v_next text;
begin
  select * into o from online_orders where id = (p->>'id')::uuid and business_id = m.business_id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if m.role = 'cashier' and o.shop_id is not null and m.shop_id is distinct from o.shop_id then raise exception 'This order is for another shop'; end if;
  if o.status in ('completed','cancelled','rejected') then raise exception 'This order is already %', o.status; end if;
  if v_action = 'verify_payment' then
    if o.payment_status <> 'pending_verification' then raise exception 'There is no payment waiting for verification'; end if;
    update online_orders set payment_status = 'paid', payment_verified_by = m.name, payment_verified_at = now(), updated_at = now(),
           timeline = timeline || jsonb_build_object('status','payment_verified','at',now(),'by',m.name,'note',v_note)
     where id = o.id returning * into o;
  elsif v_action = 'reject_payment' then
    if o.payment_status <> 'pending_verification' then raise exception 'There is no payment waiting for verification'; end if;
    if v_note is null then raise exception 'Tell the customer what is wrong with the payment'; end if;
    update online_orders set payment_status = 'rejected', updated_at = now(),
           timeline = timeline || jsonb_build_object('status','payment_rejected','at',now(),'by',m.name,'note',v_note)
     where id = o.id returning * into o;
  elsif v_action in ('reject','cancel') then
    if v_note is null then raise exception 'Give the customer a reason'; end if;
    update online_orders set status = case when v_action = 'reject' then 'rejected' else 'cancelled' end, staff_note = v_note, updated_at = now(),
           payment_status = case when payment_status = 'paid' then 'refunded' else payment_status end,
           timeline = timeline || jsonb_build_object('status', case when v_action = 'reject' then 'rejected' else 'cancelled' end,'at',now(),'by',m.name,'note',v_note)
     where id = o.id returning * into o;
  else
    v_next := case v_action when 'accept' then 'accepted' when 'preparing' then 'preparing' when 'ready' then 'ready' when 'out_for_delivery' then 'out_for_delivery' end;
    if v_next is null then raise exception 'Unknown action'; end if;
    if v_next = 'out_for_delivery' and o.fulfilment <> 'delivery' then raise exception 'This is a pickup order'; end if;
    if v_next <> 'accepted' and o.status = 'placed' then raise exception 'Accept the order first'; end if;
    -- link the shopper to the shop's customer list (points are earned at completion)
    if o.customer_id is null then
      select * into ca from customer_accounts where id = o.account_id;
      perform dq_trust();
      select * into cu from customers where business_id = m.business_id and (account_id = ca.id or phone = ca.phone) order by (account_id = ca.id) desc limit 1;
      if cu.id is null then
        insert into customers(business_id, name, phone, email, address, account_id) values (m.business_id, ca.name, ca.phone, ca.email, ca.address, ca.id) returning * into cu;
      elsif cu.account_id is null then
        update customers set account_id = ca.id where id = cu.id returning * into cu;
      end if;
    end if;
    update online_orders set status = v_next, customer_id = coalesce(customer_id, cu.id), staff_note = coalesce(v_note, staff_note),
           shop_id = coalesce(shop_id, nullif(p->>'shop_id','')::uuid, m.shop_id), updated_at = now(),
           timeline = timeline || jsonb_build_object('status', v_next, 'at', now(), 'by', m.name, 'note', v_note)
     where id = o.id returning * into o;
  end if;
  insert into activity_log(business_id, type, description, by_name) values (m.business_id, 'online', 'Online order ' || o.order_no || ': ' || v_action, m.name);
  return row_to_json(o);
end $$;

-- the till completes an online order: same checkout as a normal sale, linked to the order
alter table public.sales add column if not exists delivery_fee numeric not null default 0;
create or replace function public.dq_checkout3(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_me(); o online_orders; r json; v_bonus int := 0; cu customers; b businesses; v_sale uuid;
        v_fee numeric := 0; v_pays jsonb := '[]'::jsonb; pay jsonb; v_left numeric; v_method text; v_amt numeric; v_take numeric;
begin
  if nullif(p->>'online_order_id','') is not null then
    select * into o from online_orders where id = (p->>'online_order_id')::uuid and business_id = m.business_id for update;
    if o.id is null then raise exception 'Online order not found'; end if;
    if o.status not in ('accepted','preparing','ready','out_for_delivery') then raise exception 'ONLINE_STATUS: accept the order before completing it (it is %)', o.status; end if;
    if o.payment_status = 'pending_verification' then raise exception 'PAYMENT_UNVERIFIED: verify the customer''s % payment (%) before handing over the goods', o.payment_method, o.payment_reference; end if;
    p := p || jsonb_build_object('customer_id', o.customer_id);
    -- the delivery fee is not a product: take it out of the payments, add it to the receipt afterwards
    v_fee := coalesce(o.delivery_fee, 0); v_left := v_fee;
    for pay in select * from jsonb_array_elements(coalesce(p->'payments','[]'::jsonb)) loop
      v_amt := coalesce((pay->>'amount')::numeric, 0);
      if v_left > 0 and v_amt > 0 and coalesce(pay->>'method','') <> 'Credit' then
        if v_method is null then v_method := coalesce(nullif(trim(pay->>'method'),''), 'Cash'); end if;
        v_take := least(v_amt, v_left);
        pay := pay || jsonb_build_object('amount', v_amt - v_take);
        v_left := v_left - v_take;
      end if;
      v_pays := v_pays || pay;
    end loop;
    if v_left > 0 then raise exception 'DELIVERY_FEE: collect the delivery fee of % with the payment', v_fee; end if;
    p := p || jsonb_build_object('payments', v_pays);
  end if;
  r := dq_checkout2(p);
  if o.id is not null then
    v_sale := (r->'sale'->>'id')::uuid;
    select * into b from businesses where id = m.business_id;
    if v_fee > 0 then
      perform dq_trust();
      update sales set total = total + v_fee, paid_total = coalesce(paid_total, 0) + v_fee, delivery_fee = v_fee,
             amount_paid = coalesce(amount_paid, 0) + v_fee where id = v_sale;
      update sale_payments set amount = amount + v_fee
       where id = (select id from sale_payments where sale_id = v_sale and method = v_method order by created_at limit 1);
      if not found then
        insert into sale_payments(business_id, sale_id, customer_id, shop_id, kind, method, amount, reference, by_name)
        values (m.business_id, v_sale, o.customer_id, (r->'sale'->>'shop_id')::uuid, 'sale', v_method, v_fee, o.payment_reference, m.name);
      end if;
    end if;
    if b.loyalty_enabled and b.first_order_points > 0 and o.customer_id is not null
       and not exists (select 1 from online_orders x where x.account_id = o.account_id and x.business_id = o.business_id and x.status = 'completed') then
      perform dq_trust();
      update customers set points = points + b.first_order_points where id = o.customer_id returning * into cu;
      insert into customer_ledger(business_id, customer_id, type, points, balance_after, points_after, sale_id, note, by_name)
      values (m.business_id, cu.id, 'points_earned', b.first_order_points, cu.balance, cu.points, v_sale, 'First online order bonus', m.name);
      v_bonus := b.first_order_points;
    end if;
    update online_orders set status = 'completed', sale_id = v_sale, updated_at = now(),
           points_earned = coalesce((r->'sale'->>'points_earned')::int, 0) + v_bonus,
           payment_status = case when payment_status in ('unpaid','rejected') then 'paid' else payment_status end,
           timeline = timeline || jsonb_build_object('status','completed','at',now(),'by',m.name,'note','Receipt ' || (r->'sale'->>'receipt'))
     where id = o.id;
    r := (r::jsonb || jsonb_build_object('online_order', o.order_no, 'bonus_points', v_bonus, 'delivery_fee', v_fee,
           'sale', (select row_to_json(s) from sales s where s.id = v_sale),
           'payments', (select coalesce(json_agg(row_to_json(sp)), '[]'::json) from sale_payments sp where sp.sale_id = v_sale)))::json;
  end if;
  return r;
end $$;

-- -----------------------------------------------------------------------------
-- 5. smart suggestions: statistics learned from each business's own data
-- -----------------------------------------------------------------------------
create table if not exists public.insight_feedback (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  insight_key text not null,
  kind text not null,
  action text not null check (action in ('done','dismiss','useful')),
  by_name text,
  created_at timestamptz not null default now()
);
create index if not exists insight_feedback_idx on public.insight_feedback(business_id, created_at desc);
alter table public.insight_feedback enable row level security;
drop policy if exists insight_feedback_read on public.insight_feedback;
create policy insight_feedback_read on public.insight_feedback for select to authenticated using (business_id = public.my_business_id());

create or replace function public.dq_insight_feedback(p_key text, p_kind text, p_action text) returns void
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff();
begin
  if p_action not in ('done','dismiss','useful') then raise exception 'Invalid action'; end if;
  insert into insight_feedback(business_id, insight_key, kind, action, by_name) values (m.business_id, left(p_key, 200), left(p_kind, 40), p_action, m.name);
end $$;

create or replace function public.dq_insights() returns json
language plpgsql stable security definer set search_path = public as $$
declare m members := dq_me(); bz businesses; v_days int;
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  select * into bz from businesses where id = m.business_id;
  select greatest(least(current_date - min(date), 56), 1) into v_days from sales where business_id = m.business_id and date >= current_date - 56;
  return (
  with s56 as (select * from sales where business_id = m.business_id and date >= current_date - 56 and status <> 'refunded'
                 and (m.role <> 'cashier' or shop_id = m.shop_id)),
  l56 as (select l.*, s.date, s.created_at as ts from sale_lines l join s56 s on s.id = l.sale_id),
  daily as (select product_id, sum(qty - refunded_qty) filter (where date >= current_date - 6) as q7,
                   sum(qty - refunded_qty) filter (where date >= current_date - 27) as q28,
                   sum(qty - refunded_qty) as q56, max(date) as last_sold
              from l56 where product_id is not null group by product_id),
  stockp as (select pr.id, pr.name, pr.code, pr.cost, pr.price, pr.unit, coalesce(pr.low_stock, bz.low_stock, 0) as low, pr.reorder_qty, pr.supplier_id,
                    coalesce((select sum(qty) from stock_levels sl where sl.product_id = pr.id), 0) as stock, pr.created_at
               from products pr where pr.business_id = m.business_id and pr.active is not false),
  fc as (select sp.*, coalesce(d.q7, 0) as q7, coalesce(d.q28, 0) as q28, coalesce(d.q56, 0) as q56, d.last_sold,
                round((0.6 * coalesce(d.q7, 0) / 7.0 + 0.4 * coalesce(d.q28, 0) / least(28, v_days))::numeric, 3) as rate
           from stockp sp left join daily d on d.product_id = sp.id)
  select json_build_object(
    'generated_at', now(), 'days_of_data', coalesce(v_days, 0), 'currency', bz.currency,
    'forecast', coalesce((select json_agg(x order by x.days_left nulls last) from (
        select id, name, code, unit, stock, q7, q28, rate, round(rate * 7, 1) as next7, round(rate * 30, 1) as next30,
               case when rate > 0 then round(stock / rate, 1) end as days_left,
               greatest(ceil(rate * 21 - stock), coalesce(reorder_qty, 0)::numeric) as suggest_qty, supplier_id, cost,
               case when q28 > 0 and q7 / 7.0 > 1.3 * q28 / 28.0 then 'up' when q28 > 0 and q7 / 7.0 < 0.7 * q28 / 28.0 then 'down' else 'steady' end as trend
          from fc where rate > 0 and (stock / rate) < 14 limit 40) x), '[]'::json),
    'slow', coalesce((select json_agg(x order by x.value desc) from (
        select id, name, code, stock, round(stock * cost, 2) as value, last_sold
          from fc where stock > 0 and coalesce(q28, 0) = 0 and created_at < now() - interval '21 days' order by stock * cost desc limit 15) x), '[]'::json),
    'margins', coalesce((select json_agg(x) from (
        select id, name, code, cost, price, case when price > 0 then round((price - cost) / price * 100, 1) end as margin
          from fc where cost > 0 and (price <= cost or (price - cost) / nullif(price, 0) < 0.08) limit 15) x), '[]'::json),
    'top', coalesce((select json_agg(x order by x.revenue desc) from (
        select product_id as id, max(name) as name, sum(qty - refunded_qty) as qty, round(sum((qty - refunded_qty) * price), 2) as revenue,
               round(sum((qty - refunded_qty) * (price - coalesce(cost, 0))), 2) as profit
          from l56 where date >= current_date - 27 group by product_id order by 4 desc limit 8) x), '[]'::json),
    'pairs', coalesce((select json_agg(x order by x.times desc) from (
        select a.product_id as a_id, max(a.name) as a_name, b.product_id as b_id, max(b.name) as b_name, count(distinct a.sale_id) as times
          from l56 a join l56 b on b.sale_id = a.sale_id and a.product_id < b.product_id
         group by a.product_id, b.product_id having count(distinct a.sale_id) >= 2 order by 5 desc limit 8) x), '[]'::json),
    'hours', coalesce((select json_agg(x order by x.h) from (
        select extract(hour from created_at at time zone bz.timezone)::int as h, count(*) as receipts, round(sum(total), 2) as sales
          from s56 group by 1) x), '[]'::json),
    'weekdays', coalesce((select json_agg(x order by x.dow) from (
        select extract(isodow from date)::int as dow, count(*) as receipts, round(sum(total) / greatest(count(distinct date), 1), 2) as avg_day
          from s56 group by 1) x), '[]'::json),
    'week', json_build_object('this', (select coalesce(sum(total), 0) from s56 where date >= current_date - 6),
                              'last', (select coalesce(sum(total), 0) from s56 where date between current_date - 13 and current_date - 7)),
    'at_risk', coalesce((select json_agg(x order by x.spent desc) from (
        select c.id, c.name, c.phone, c.visits, round(c.total_spent, 2) as spent, c.points, c.last_visit,
               (current_date - (c.last_visit at time zone bz.timezone)::date) as days_away
          from customers c where c.business_id = m.business_id and c.visits >= 2 and c.last_visit is not null
           and now() - c.last_visit > greatest(interval '21 days', ((c.last_visit - c.created_at) / greatest(c.visits - 1, 1)) * 2)
         order by c.total_spent desc limit 10) x), '[]'::json),
    'debts', (select json_build_object('count', count(distinct customer_id), 'amount', coalesce(sum(balance_due), 0))
                from sales where business_id = m.business_id and balance_due > 0 and date < current_date - 30),
    'expiring', coalesce((select json_agg(x order by x.first_expiry) from (
        select i.product_id as id, pr.name, count(*) as items, min(i.expiry_date) as first_expiry, round(count(*) * pr.price, 2) as value,
               case when min(i.expiry_date) - current_date <= 3 then 30 when min(i.expiry_date) - current_date <= 7 then 20 else 10 end as discount_pct
          from product_items i join products pr on pr.id = i.product_id
         where i.business_id = m.business_id and i.status = 'in_stock' and i.expiry_date between current_date and current_date + 14
         group by i.product_id, pr.name, pr.price limit 10) x), '[]'::json),
    'feedback', json_build_object(
        'hidden', coalesce((select json_agg(distinct insight_key) from insight_feedback where business_id = m.business_id
                             and action in ('done','dismiss') and created_at > now() - interval '14 days'), '[]'::json),
        'by_kind', coalesce((select json_object_agg(kind, x) from (
             select kind, json_build_object('done', count(*) filter (where action in ('done','useful')), 'dismissed', count(*) filter (where action = 'dismiss')) as x
               from insight_feedback where business_id = m.business_id group by kind) y), '{}'::json))
  ));
end $$;

-- -----------------------------------------------------------------------------
-- 6. who am I (routes a login to the right portal)
-- -----------------------------------------------------------------------------
create or replace function public.dq_whoami() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then return null; end if;
  update platform_admins set last_seen = now() where auth_user_id = auth.uid() and active and (last_seen is null or last_seen < now() - interval '5 minutes');
  return json_build_object(
    'member', exists (select 1 from members where auth_user_id = auth.uid()),
    'admin', (select json_build_object('role', role, 'name', name) from platform_admins where auth_user_id = auth.uid() and active),
    'supplier', (select json_build_object('id', id, 'company_name', company_name, 'status', status, 'verified', verified) from supplier_accounts where auth_user_id = auth.uid()),
    'customer', (select json_build_object('id', id, 'name', name, 'phone', phone) from customer_accounts where auth_user_id = auth.uid()));
end $$;
-- whoami updates last_seen, so it cannot be STABLE
alter function public.dq_whoami() volatile;

create or replace function public.dq_admin_platform() returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin_perm('view');
  return json_build_object(
    'role', dq_platform_role(),
    'suppliers', (select json_build_object('total', count(*), 'verified', count(*) filter (where verified), 'suspended', count(*) filter (where status = 'suspended')) from supplier_accounts),
    'customers', (select count(*) from customer_accounts),
    'stores', (select count(*) from businesses where store_enabled),
    'online', (select json_build_object('total', count(*), 'open', count(*) filter (where status not in ('completed','cancelled','rejected')),
                 'completed', count(*) filter (where status = 'completed'), 'value', coalesce(sum(total) filter (where status = 'completed'), 0),
                 'unverified', count(*) filter (where payment_status = 'pending_verification')) from online_orders),
    'supplier_orders', (select json_build_object('sent', count(*) filter (where supplier_status = 'sent'), 'confirmed', count(*) filter (where supplier_status in ('confirmed','dispatched')),
                 'delivered', count(*) filter (where supplier_status = 'delivered'), 'rejected', count(*) filter (where supplier_status = 'rejected')) from orders where supplier_status is not null),
    'supplier_payments', (select json_build_object('unverified', count(*) filter (where verification = 'unverified'), 'confirmed', count(*) filter (where verification = 'confirmed'),
                 'disputed', count(*) filter (where verification = 'disputed')) from supplier_payments sp join suppliers s on s.id = sp.supplier_id where s.supplier_account_id is not null),
    'signups', coalesce((select json_agg(x order by x.month) from (
        select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*) as businesses from businesses
         where created_at > now() - interval '12 months' group by 1) x), '[]'::json),
    'online_list', coalesce((select json_agg(x order by x.created_at desc) from (
        select o.order_no, o.status, o.payment_status, o.payment_method, o.total, o.fulfilment, o.created_at, b.name as business, o.customer_name
          from online_orders o join businesses b on b.id = o.business_id order by o.created_at desc limit 100) x), '[]'::json),
    'disputes', coalesce((select json_agg(x order by x.verified_at desc) from (
        select sp.amount, sp.method, sp.reference, sp.verify_note, sp.verified_at, b.name as business, a.company_name as supplier
          from supplier_payments sp join suppliers s on s.id = sp.supplier_id join supplier_accounts a on a.id = s.supplier_account_id join businesses b on b.id = sp.business_id
         where sp.verification = 'disputed' limit 50) x), '[]'::json));
end $$;

-- -----------------------------------------------------------------------------
-- 7. permissions
-- -----------------------------------------------------------------------------
revoke all on function public.dq_require_admin_perm(text) from public, anon;
revoke all on function public.dq_orders_supplier_flow() from public, anon, authenticated;
revoke all on function public.my_supplier() from public, anon;
revoke all on function public.dq_require_supplier() from public, anon, authenticated;
revoke all on function public.my_customer_account() from public, anon;
grant execute on function public.dq_verify_label(text) to anon, authenticated;
grant execute on function public.dq_store_directory(jsonb) to anon, authenticated;
grant execute on function public.dq_store_catalog(text) to anon, authenticated;
do $$ declare f text; begin
  foreach f in array array[
    'dq_platform_role()','dq_admin_can(text)','dq_admin_staff()','dq_admin_invite_staff(text,text,text)','dq_admin_update_staff(text,text,boolean)',
    'dq_admin_remove_staff(text)','dq_supplier_register(jsonb)','dq_supplier_update_profile(jsonb)','dq_supplier_save_product(jsonb)',
    'dq_supplier_directory(jsonb)','dq_link_supplier(uuid)','dq_supplier_invite(uuid)','dq_supplier_orders()','dq_supplier_respond(jsonb)',
    'dq_supplier_verify_payment(uuid,boolean,text)','dq_admin_suppliers()','dq_admin_set_supplier(uuid,jsonb)','dq_store_settings(jsonb)',
    'dq_customer_register(jsonb)','dq_customer_update(jsonb)','dq_customer_home()','dq_place_online_order(jsonb)',
    'dq_customer_cancel_order(uuid,text)','dq_online_order_action(jsonb)','dq_checkout3(jsonb)','dq_insight_feedback(text,text,text)',
    'dq_insights()','dq_whoami()','dq_admin_platform()','dq_admin_set_public_url(text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
