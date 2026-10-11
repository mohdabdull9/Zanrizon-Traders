-- =============================================================================
-- DeepQr v2
--   * Security hardening (staff accounts, business ownership, trusted money fields)
--   * Platform control: credits + bonus credits, packages, promo codes, referrals,
--     free monthly QR quota, per-business pricing, announcements, audit log,
--     platform blocks for users / shops / devices, QR batch refunds
--   * Till: customers, credit sales & debts, split payments, loyalty points,
--     held carts, shifts / cash-up, partial refunds, staff permissions
--   * Purchasing: suppliers, purchase orders with invoices, goods received notes,
--     damaged / outstanding quantities, supplier payments
--   * Stock: transfers that carry QR labels, stock takes, stock card, reorder data
--   * Reports computed on the server
-- Additive: existing tables keep their data; v1 functions keep working.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. version marker + trusted-write flag
-- ---------------------------------------------------------------------------
create or replace function public.dq_version() returns integer language sql immutable as $$ select 2 $$;

-- set inside DeepQr functions so guarded columns (balances, points, blocks) can change
create or replace function public.dq_trust() returns void language plpgsql set search_path = public as $$
begin perform set_config('dq.trusted', 'on', true); end $$;
create or replace function public.dq_is_trusted() returns boolean language sql stable as $$
  select coalesce(current_setting('dq.trusted', true), '') = 'on' $$;

-- ---------------------------------------------------------------------------
-- 1. members: status, platform block, permissions
-- ---------------------------------------------------------------------------
alter table public.members add column if not exists active boolean not null default true;
alter table public.members add column if not exists blocked_by_platform boolean not null default false;
alter table public.members add column if not exists blocked_reason text;
alter table public.members add column if not exists permissions jsonb not null default '{}'::jsonb;
alter table public.members add column if not exists phone text;
alter table public.members add column if not exists last_seen timestamptz;

create or replace function public.my_business_id() returns uuid
language sql stable security definer set search_path = public as $$
  select business_id from members where auth_user_id = auth.uid() and active and not blocked_by_platform limit 1
$$;
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from members where auth_user_id = auth.uid() and active and not blocked_by_platform limit 1
$$;
create or replace function public.dq_me() returns public.members
language sql stable security definer set search_path = public as $$
  select * from members where auth_user_id = auth.uid() and active and not blocked_by_platform limit 1
$$;

-- effective permissions: owners/managers can do everything; others get defaults + their overrides
create or replace function public.dq_perms(m public.members) returns jsonb
language sql stable set search_path = public as $$
  select case when m.role in ('owner','manager') then
    '{"can_edit_price":true,"max_discount_pct":100,"can_sell_credit":true,"can_refund":true,"can_view_reports":true,"can_receive_orders":true,"can_manage_stock":true}'::jsonb
  else
    '{"can_edit_price":false,"max_discount_pct":10,"can_sell_credit":true,"can_refund":false,"can_view_reports":false,"can_receive_orders":true,"can_manage_stock":false}'::jsonb
    || case when m.role in ('inventory','main_operator') then '{"can_manage_stock":true}'::jsonb else '{}'::jsonb end
    || coalesce(m.permissions, '{}'::jsonb)
  end
$$;

-- who am I (works even when blocked, so the app can explain why)
create or replace function public.dq_my_status() returns json
language plpgsql stable security definer set search_path = public as $$
declare m members; b businesses; a dq_accounts;
begin
  if auth.uid() is null then return null; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  if m.id is null then return json_build_object('member', null); end if;
  select * into b from businesses where id = m.business_id;
  select * into a from dq_accounts where business_id = m.business_id;
  return json_build_object(
    'member', json_build_object('id', m.id, 'name', m.name, 'role', m.role, 'active', m.active,
                                'blocked', m.blocked_by_platform, 'blocked_reason', m.blocked_reason),
    'business', json_build_object('id', b.id, 'name', b.name, 'code', b.code),
    'account_status', coalesce(a.status, 'active'), 'account_note', a.status_note,
    'permissions', dq_perms(m));
end $$;

-- staff-row guard: stops self-promotion, joining other businesses and editing platform blocks
create or replace function public.dq_guard_members() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text; b businesses;
begin
  if dq_is_trusted() or auth.uid() is null then return new; end if;
  select role into r from members where auth_user_id = auth.uid() and active and not blocked_by_platform limit 1;
  if tg_op = 'INSERT' then
    if new.blocked_by_platform then raise exception 'Not allowed'; end if;
    if new.auth_user_id = auth.uid() then
      select * into b from businesses where id = new.business_id;
      if b.owner_auth_id is distinct from auth.uid() or new.role <> 'owner'
         or exists (select 1 from members where business_id = new.business_id) then
        raise exception 'You can only create the owner account of a business you registered';
      end if;
    else
      if new.business_id is distinct from my_business_id() or r not in ('owner','manager') or r is null then
        raise exception 'Only owners and managers can add staff';
      end if;
      if new.role = 'owner' then raise exception 'A business has only one owner account'; end if;
      if r = 'manager' and new.role = 'manager' then raise exception 'Only the owner can add managers'; end if;
    end if;
    return new;
  end if;
  -- UPDATE
  if new.blocked_by_platform is distinct from old.blocked_by_platform or new.blocked_reason is distinct from old.blocked_reason then
    raise exception 'Only DeepQr can change platform blocks';
  end if;
  if new.business_id <> old.business_id or new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'Not allowed';
  end if;
  if r is null or r not in ('owner','manager') then
    if new.role <> old.role or new.permissions <> old.permissions or new.active <> old.active
       or new.shop_id is distinct from old.shop_id then
      raise exception 'Only owners and managers can change roles, permissions, shop or status';
    end if;
  end if;
  if old.role = 'owner' and (new.role <> 'owner' or not new.active) then
    raise exception 'The owner account cannot be demoted or disabled';
  end if;
  if new.role = 'owner' and old.role <> 'owner' then raise exception 'A business has only one owner account'; end if;
  if r = 'manager' and old.role = 'manager' and old.auth_user_id <> auth.uid()
     and (new.role <> old.role or new.active <> old.active or new.permissions <> old.permissions) then
    raise exception 'Only the owner can change another manager';
  end if;
  return new;
end $$;
drop trigger if exists dq_guard_members on public.members;
create trigger dq_guard_members before insert or update on public.members
  for each row execute function public.dq_guard_members();

-- a business can only be registered for yourself
create or replace function public.dq_guard_business_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if dq_is_trusted() or auth.uid() is null then return new; end if;
  if new.owner_auth_id is distinct from auth.uid() then raise exception 'You can only register a business for your own account'; end if;
  if exists (select 1 from members where auth_user_id = auth.uid()) then
    raise exception 'This account already belongs to a business';
  end if;
  return new;
end $$;
drop trigger if exists dq_guard_business_insert on public.businesses;
create trigger dq_guard_business_insert before insert on public.businesses
  for each row execute function public.dq_guard_business_insert();

-- username → login email without exposing the whole directory
create or replace function public.dq_login_email(p_username text) returns text
language sql stable security definer set search_path = public as $$
  select email from username_directory where username = lower(trim(p_username)) limit 1
$$;

-- ---------------------------------------------------------------------------
-- 2. business settings for the till
-- ---------------------------------------------------------------------------
alter table public.businesses add column if not exists timezone text not null default 'Africa/Dar_es_Salaam';
alter table public.businesses add column if not exists loyalty_enabled boolean not null default false;
alter table public.businesses add column if not exists points_per_amount numeric not null default 1000;
alter table public.businesses add column if not exists point_value numeric not null default 10;
alter table public.businesses add column if not exists min_redeem_points integer not null default 50;
alter table public.businesses add column if not exists allow_credit_sales boolean not null default true;
alter table public.businesses add column if not exists require_payment_ref boolean not null default true;
alter table public.businesses add column if not exists require_shift boolean not null default false;
alter table public.businesses add column if not exists receipt_header text not null default '';
alter table public.businesses add column if not exists receipt_show_qr boolean not null default true;
alter table public.businesses add column if not exists tin text not null default '';
alter table public.businesses add column if not exists payment_methods jsonb not null
  default '["Cash","M-Pesa","Tigo Pesa","Airtel Money","HaloPesa","Card","Bank"]'::jsonb;
alter table public.businesses add column if not exists label_size text not null default 'medium';

alter table public.shops add column if not exists active boolean not null default true;
alter table public.shops add column if not exists blocked_by_platform boolean not null default false;
alter table public.shops add column if not exists phone text;
alter table public.shops add column if not exists address text;

alter table public.products add column if not exists reorder_qty integer;
alter table public.products add column if not exists supplier_id uuid;
alter table public.products add column if not exists description text;

-- ---------------------------------------------------------------------------
-- 3. platform: credits, bonuses, packages, promos, referrals, announcements, audit
-- ---------------------------------------------------------------------------
alter table public.dq_accounts add column if not exists bonus_balance numeric not null default 0;
alter table public.dq_accounts add column if not exists bonus_expires_at timestamptz;
alter table public.dq_accounts add column if not exists fee_override numeric check (fee_override is null or fee_override >= 0);
alter table public.dq_accounts add column if not exists free_qr_monthly integer;
alter table public.dq_accounts add column if not exists free_qr_used integer not null default 0;
alter table public.dq_accounts add column if not exists free_qr_period text;
alter table public.dq_accounts add column if not exists plan text not null default 'standard';
alter table public.dq_accounts add column if not exists credit_limit numeric not null default 0;
alter table public.dq_accounts add column if not exists referral_code text;
alter table public.dq_accounts add column if not exists referred_by uuid references public.businesses(id) on delete set null;
alter table public.dq_accounts add column if not exists referral_paid boolean not null default false;
alter table public.dq_accounts add column if not exists admin_notes text;
create unique index if not exists dq_accounts_referral_key on public.dq_accounts(referral_code);
update public.dq_accounts a set referral_code = b.code || upper(substr(md5(b.id::text), 1, 4))
  from public.businesses b where b.id = a.business_id and a.referral_code is null;

alter table public.platform_settings add column if not exists free_qr_monthly integer not null default 0;
alter table public.platform_settings add column if not exists referral_bonus numeric not null default 0;
alter table public.platform_settings add column if not exists referee_bonus numeric not null default 0;
alter table public.platform_settings add column if not exists bonus_expiry_days integer not null default 90;
alter table public.platform_settings add column if not exists payment_accounts jsonb not null default '[]'::jsonb;
alter table public.platform_settings add column if not exists support_phone text not null default '';
alter table public.platform_settings add column if not exists support_email text not null default '';
alter table public.platform_settings add column if not exists low_balance_threshold numeric not null default 500;

alter table public.wallet_transactions drop constraint if exists wallet_transactions_type_check;
alter table public.wallet_transactions add constraint wallet_transactions_type_check check (type in
  ('topup','qr_charge','adjustment','refund','bonus','promo','referral','welcome','bonus_expired'));
alter table public.wallet_transactions add column if not exists bonus_amount numeric not null default 0;
alter table public.wallet_transactions add column if not exists bonus_balance_after numeric;
alter table public.wallet_transactions add column if not exists free_count integer not null default 0;

alter table public.qr_generations add column if not exists free_qty integer not null default 0;
alter table public.qr_generations add column if not exists bonus_used numeric not null default 0;
alter table public.qr_generations add column if not exists paid_amount numeric not null default 0;
alter table public.qr_generations add column if not exists refunded_qty integer not null default 0;

create table if not exists public.topup_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  amount numeric not null check (amount > 0),
  bonus numeric not null default 0 check (bonus >= 0),
  badge text,
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.topup_packages enable row level security;
drop policy if exists topup_packages_read on public.topup_packages;
create policy topup_packages_read on public.topup_packages for select to authenticated using (active);
insert into public.topup_packages(name, amount, bonus, badge, sort)
select * from (values ('Starter', 5000, 0, null, 1), ('Business', 20000, 2000, 'Popular', 2), ('Pro', 50000, 7500, 'Best value', 3)) v(n, a, b, g, s)
where not exists (select 1 from public.topup_packages);

alter table public.topup_requests add column if not exists package_id uuid references public.topup_packages(id) on delete set null;
alter table public.topup_requests add column if not exists bonus numeric not null default 0;
alter table public.topup_requests add column if not exists sender_phone text;
alter table public.topup_requests add column if not exists sender_name text;
alter table public.topup_requests add column if not exists credited numeric;
alter table public.topup_requests add column if not exists receipt_no text;
create unique index if not exists topup_requests_reference_key
  on public.topup_requests (upper(trim(reference))) where status <> 'rejected';

create table if not exists public.promo_codes (
  code text primary key,
  credits numeric not null check (credits > 0),
  max_uses integer,
  used_count integer not null default 0,
  expires_at timestamptz,
  active boolean not null default true,
  business_id uuid references public.businesses(id) on delete cascade,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.promo_codes enable row level security;
create table if not exists public.promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  code text not null references public.promo_codes(code) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  credits numeric not null,
  redeemed_by text,
  redeemed_at timestamptz not null default now(),
  unique (code, business_id)
);
alter table public.promo_redemptions enable row level security;
drop policy if exists promo_redemptions_read on public.promo_redemptions;
create policy promo_redemptions_read on public.promo_redemptions for select to authenticated using (business_id = my_business_id());

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  level text not null default 'info' check (level in ('info','success','warning','critical')),
  business_id uuid references public.businesses(id) on delete cascade,
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.announcements enable row level security;
drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements for select to authenticated
  using (active and starts_at <= now() and (ends_at is null or ends_at > now())
         and (business_id is null or business_id = my_business_id()));

create table if not exists public.platform_audit (
  id uuid primary key default gen_random_uuid(),
  actor text,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.platform_audit enable row level security;

-- ---------------------------------------------------------------------------
-- 4. customers, payments, shifts, held carts
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  phone text,
  email text,
  address text,
  notes text,
  points integer not null default 0,
  balance numeric not null default 0,
  credit_limit numeric not null default 0,
  total_spent numeric not null default 0,
  visits integer not null default 0,
  last_visit timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists customers_phone_key on public.customers(business_id, phone) where phone is not null and phone <> '';
alter table public.customers enable row level security;
drop policy if exists customers_all on public.customers;
create policy customers_all on public.customers for all to authenticated
  using (business_id = my_business_id()) with check (business_id = my_business_id());

create table if not exists public.customer_ledger (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  type text not null check (type in ('credit_sale','payment','refund','points_earned','points_redeemed','points_reversed','adjustment')),
  amount numeric not null default 0,
  points integer not null default 0,
  balance_after numeric,
  points_after integer,
  sale_id uuid references public.sales(id) on delete set null,
  method text,
  reference text,
  note text,
  by_name text,
  created_at timestamptz not null default now()
);
create index if not exists customer_ledger_idx on public.customer_ledger(customer_id, created_at desc);
alter table public.customer_ledger enable row level security;
drop policy if exists customer_ledger_read on public.customer_ledger;
create policy customer_ledger_read on public.customer_ledger for select to authenticated using (business_id = my_business_id());

create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  shop_id uuid references public.shops(id) on delete set null,
  member_id uuid references public.members(id) on delete set null,
  member_name text,
  status text not null default 'open' check (status in ('open','closed')),
  opened_at timestamptz not null default now(),
  opening_float numeric not null default 0,
  closed_at timestamptz,
  closed_by text,
  expected_cash numeric,
  counted_cash numeric,
  difference numeric,
  note text
);
create unique index if not exists shifts_one_open on public.shifts(member_id) where status = 'open';
alter table public.shifts enable row level security;
drop policy if exists shifts_read on public.shifts;
create policy shifts_read on public.shifts for select to authenticated using (business_id = my_business_id());

create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  type text not null check (type in ('in','out')),
  amount numeric not null check (amount > 0),
  reason text not null,
  by_name text,
  created_at timestamptz not null default now()
);
alter table public.cash_movements enable row level security;
drop policy if exists cash_movements_read on public.cash_movements;
create policy cash_movements_read on public.cash_movements for select to authenticated using (business_id = my_business_id());

alter table public.sales add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.sales add column if not exists paid_total numeric;
alter table public.sales add column if not exists balance_due numeric not null default 0;
alter table public.sales add column if not exists payment_status text not null default 'paid';
alter table public.sales add column if not exists points_earned integer not null default 0;
alter table public.sales add column if not exists points_redeemed integer not null default 0;
alter table public.sales add column if not exists points_value numeric not null default 0;
alter table public.sales add column if not exists shift_id uuid references public.shifts(id) on delete set null;
alter table public.sales add column if not exists refunded_amount numeric not null default 0;
alter table public.sales add column if not exists note text;
create index if not exists sales_business_date_idx on public.sales(business_id, date);
create index if not exists sales_customer_idx on public.sales(customer_id) where customer_id is not null;

alter table public.sale_lines add column if not exists refunded_qty numeric not null default 0;
alter table public.sale_lines add column if not exists cost numeric;
create index if not exists sale_lines_sale_idx on public.sale_lines(sale_id);

create table if not exists public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  sale_id uuid references public.sales(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  shift_id uuid references public.shifts(id) on delete set null,
  shop_id uuid references public.shops(id) on delete set null,
  kind text not null default 'sale' check (kind in ('sale','debt_payment','refund')),
  method text not null,
  amount numeric not null,
  reference text,
  by_name text,
  created_at timestamptz not null default now()
);
create index if not exists sale_payments_idx on public.sale_payments(business_id, created_at);
alter table public.sale_payments enable row level security;
drop policy if exists sale_payments_read on public.sale_payments;
create policy sale_payments_read on public.sale_payments for select to authenticated using (business_id = my_business_id());

create table if not exists public.held_carts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  shop_id uuid references public.shops(id) on delete cascade,
  label text not null default 'Held sale',
  cart jsonb not null,
  customer jsonb,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.held_carts enable row level security;
drop policy if exists held_carts_all on public.held_carts;
create policy held_carts_all on public.held_carts for all to authenticated
  using (business_id = my_business_id()) with check (business_id = my_business_id());

-- guard money fields that only DeepQr functions may change
create or replace function public.dq_guard_money() returns trigger
language plpgsql set search_path = public as $$
begin
  if dq_is_trusted() or auth.uid() is null then return new; end if;
  if tg_table_name = 'customers' then
    if tg_op = 'INSERT' then
      new.balance := 0; new.points := 0; new.total_spent := 0; new.visits := 0;
    elsif new.balance <> old.balance or new.points <> old.points or new.total_spent <> old.total_spent or new.visits <> old.visits then
      raise exception 'Customer balance and points change only through sales, payments and refunds';
    end if;
  elsif tg_table_name = 'sales' then
    if tg_op = 'UPDATE' and (new.total <> old.total or new.balance_due <> old.balance_due
       or new.paid_total is distinct from old.paid_total or new.status <> old.status
       or new.refunded_amount <> old.refunded_amount or new.payment_status <> old.payment_status
       or new.customer_id is distinct from old.customer_id) then
      raise exception 'Receipts cannot be edited. Use refunds instead.';
    end if;
  elsif tg_table_name = 'suppliers' then
    if tg_op = 'INSERT' then new.balance := 0;
    elsif new.balance <> old.balance then raise exception 'Supplier balance changes only through receipts and payments'; end if;
  elsif tg_table_name = 'shops' then
    if tg_op = 'INSERT' then new.blocked_by_platform := false;
    elsif new.blocked_by_platform <> old.blocked_by_platform then raise exception 'Only DeepQr can change platform blocks'; end if;
  end if;
  return new;
end $$;
drop trigger if exists dq_guard_money on public.customers;
create trigger dq_guard_money before insert or update on public.customers for each row execute function public.dq_guard_money();
drop trigger if exists dq_guard_money on public.sales;
create trigger dq_guard_money before update on public.sales for each row execute function public.dq_guard_money();
drop trigger if exists dq_guard_money on public.shops;
create trigger dq_guard_money before insert or update on public.shops for each row execute function public.dq_guard_money();

-- ---------------------------------------------------------------------------
-- 5. suppliers, purchase orders, goods received, supplier payments, documents
-- ---------------------------------------------------------------------------
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  contact_person text,
  phone text,
  email text,
  address text,
  tin text,
  payment_terms_days integer not null default 0,
  notes text,
  balance numeric not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (business_id, name)
);
alter table public.suppliers enable row level security;
drop policy if exists suppliers_all on public.suppliers;
create policy suppliers_all on public.suppliers for all to authenticated
  using (business_id = my_business_id()) with check (business_id = my_business_id());
drop trigger if exists dq_guard_money on public.suppliers;
create trigger dq_guard_money before insert or update on public.suppliers for each row execute function public.dq_guard_money();

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('draft','pending','ordered','partial','received','closed','cancelled'));
alter table public.orders add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;
alter table public.orders add column if not exists supplier_name text;
alter table public.orders add column if not exists order_no text;
alter table public.orders add column if not exists order_date date not null default current_date;
alter table public.orders add column if not exists expected_date date;
alter table public.orders add column if not exists total_cost numeric not null default 0;
alter table public.orders add column if not exists received_value numeric not null default 0;
alter table public.orders add column if not exists paid_amount numeric not null default 0;
alter table public.orders add column if not exists payment_status text not null default 'unpaid';
alter table public.orders add column if not exists invoice_no text;
alter table public.orders add column if not exists invoice_amount numeric;
alter table public.orders add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.orders add column if not exists cancelled_reason text;
alter table public.orders add column if not exists closed_at timestamptz;
alter table public.orders add column if not exists updated_at timestamptz not null default now();

alter table public.order_items drop constraint if exists order_items_status_check;
alter table public.order_items add constraint order_items_status_check check (status in ('pending','partial','received','cancelled'));
alter table public.order_items add column if not exists unit_cost numeric not null default 0;
alter table public.order_items add column if not exists qty_damaged numeric not null default 0;
alter table public.order_items add column if not exists product_name text;
alter table public.order_items add column if not exists note text;

create table if not exists public.order_receipts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  shop_id uuid references public.shops(id) on delete set null,
  grn_no text not null,
  delivery_note_no text,
  note text,
  attachments jsonb not null default '[]'::jsonb,
  total_value numeric not null default 0,
  received_by text,
  received_at timestamptz not null default now()
);
alter table public.order_receipts enable row level security;
drop policy if exists order_receipts_read on public.order_receipts;
create policy order_receipts_read on public.order_receipts for select to authenticated using (business_id = my_business_id());

create table if not exists public.order_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  receipt_id uuid not null references public.order_receipts(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  qty_received numeric not null default 0,
  qty_damaged numeric not null default 0,
  unit_cost numeric not null default 0,
  expiry_date date,
  batch_ref text
);
alter table public.order_receipt_lines enable row level security;
drop policy if exists order_receipt_lines_read on public.order_receipt_lines;
create policy order_receipt_lines_read on public.order_receipt_lines for select to authenticated using (business_id = my_business_id());

create table if not exists public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  amount numeric not null check (amount > 0),
  method text not null,
  reference text,
  paid_on date not null default current_date,
  note text,
  attachments jsonb not null default '[]'::jsonb,
  by_name text,
  created_at timestamptz not null default now()
);
alter table public.supplier_payments enable row level security;
drop policy if exists supplier_payments_read on public.supplier_payments;
create policy supplier_payments_read on public.supplier_payments for select to authenticated using (business_id = my_business_id());

-- private document storage: <business_id>/<folder>/<file>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dq-docs', 'dq-docs', false, 10485760,
        array['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;
drop policy if exists dq_docs_select on storage.objects;
create policy dq_docs_select on storage.objects for select to authenticated
  using (bucket_id = 'dq-docs' and (storage.foldername(name))[1] = public.my_business_id()::text);
drop policy if exists dq_docs_insert on storage.objects;
create policy dq_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'dq-docs' and (storage.foldername(name))[1] = public.my_business_id()::text);
drop policy if exists dq_docs_delete on storage.objects;
create policy dq_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'dq-docs' and (storage.foldername(name))[1] = public.my_business_id()::text
         and public.my_role() in ('owner','manager'));

-- ---------------------------------------------------------------------------
-- 6. stock: transfers carry labels, stock takes
-- ---------------------------------------------------------------------------
alter table public.product_items drop constraint if exists product_items_status_check;
alter table public.product_items add constraint product_items_status_check check (status in ('in_stock','sold','void','transit'));
alter table public.product_items add column if not exists transfer_id uuid;

alter table public.transfers add column if not exists item_ids uuid[] not null default '{}';
alter table public.transfers add column if not exists received_qty numeric;
alter table public.transfers drop constraint if exists transfers_status_check;
alter table public.transfers add constraint transfers_status_check check (status in ('pending','completed','cancelled'));

create table if not exists public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  category text,
  status text not null default 'open' check (status in ('open','applied','cancelled')),
  note text,
  started_by text,
  started_at timestamptz not null default now(),
  applied_by text,
  applied_at timestamptz
);
alter table public.stock_counts enable row level security;
drop policy if exists stock_counts_read on public.stock_counts;
create policy stock_counts_read on public.stock_counts for select to authenticated using (business_id = my_business_id());

create table if not exists public.stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  count_id uuid not null references public.stock_counts(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  expected numeric not null default 0,
  counted numeric,
  serials text[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (count_id, product_id)
);
alter table public.stock_count_lines enable row level security;
drop policy if exists stock_count_lines_read on public.stock_count_lines;
create policy stock_count_lines_read on public.stock_count_lines for select to authenticated using (business_id = my_business_id());

-- =============================================================================
-- 7. helpers
-- =============================================================================
create or replace function public.dq_phone(p text) returns text language sql immutable as $$
  select nullif(regexp_replace(coalesce(p,''), '[^0-9+]', '', 'g'), '')
$$;

create or replace function public.dq_audit(p_action text, p_type text, p_id text, p_details jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into platform_audit(actor, action, target_type, target_id, details)
  values ((select email from auth.users where id = auth.uid()), p_action, p_type, p_id, coalesce(p_details, '{}'::jsonb));
end $$;

create or replace function public.dq_require_staff(p_roles text[] default null) returns public.members
language plpgsql security definer set search_path = public as $$
declare m members := dq_me();
begin
  if m.id is null then raise exception 'Not signed in to a business (or your account is disabled)'; end if;
  if p_roles is not null and not (m.role = any(p_roles)) then raise exception 'Your role (%) cannot do this', m.role; end if;
  perform dq_trust();
  return m;
end $$;

create or replace function public.dq_effective_fee(p_business uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select fee_override from dq_accounts where business_id = p_business),
                  (select qr_fee from platform_settings where id = 1), 25)
$$;

-- charge for QR codes: free monthly quota first, then bonus credits, then main balance
create or replace function public.dq_charge_qr(p_business uuid, p_qty integer, p_note text, p_by text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc dq_accounts; st platform_settings; v_fee numeric; v_period text := to_char(now(), 'YYYY-MM');
        v_allow integer; v_free integer; v_cost numeric; v_bonus numeric; v_main numeric; v_tx uuid;
begin
  select * into st from platform_settings where id = 1;
  insert into dq_accounts(business_id) values (p_business) on conflict do nothing;
  select * into acc from dq_accounts where business_id = p_business for update;
  if acc.status = 'suspended' then raise exception 'ACCOUNT_SUSPENDED: this business account is suspended by DeepQr'; end if;
  v_fee := coalesce(acc.fee_override, st.qr_fee);
  if acc.free_qr_period is distinct from v_period then
    update dq_accounts set free_qr_used = 0, free_qr_period = v_period where business_id = p_business;
    acc.free_qr_used := 0;
  end if;
  v_allow := coalesce(acc.free_qr_monthly, st.free_qr_monthly, 0);
  v_free := least(p_qty, greatest(v_allow - acc.free_qr_used, 0));
  v_cost := (p_qty - v_free) * v_fee;
  if acc.bonus_balance > 0 and acc.bonus_expires_at is not null and acc.bonus_expires_at < now() then
    insert into wallet_transactions(business_id, type, amount, bonus_amount, balance_after, bonus_balance_after, note, by_name)
    values (p_business, 'bonus_expired', 0, -acc.bonus_balance, acc.balance, 0, 'Bonus credits expired', 'DeepQr');
    update dq_accounts set bonus_balance = 0 where business_id = p_business;
    acc.bonus_balance := 0;
  end if;
  v_bonus := least(acc.bonus_balance, v_cost);
  v_main := v_cost - v_bonus;
  if v_main > 0 and acc.balance - v_main < -coalesce(acc.credit_limit, 0) and not st.allow_negative_balance then
    raise exception 'INSUFFICIENT_BALANCE: % QR code(s) cost % % (% free, % from bonus). Your balance is % %. Please top up.',
      p_qty, v_cost, st.currency, v_free, v_bonus, acc.balance, st.currency;
  end if;
  update dq_accounts set balance = balance - v_main, bonus_balance = bonus_balance - v_bonus,
         free_qr_used = free_qr_used + v_free, total_qr = total_qr + p_qty,
         total_spent = total_spent + v_cost, updated_at = now()
   where business_id = p_business returning * into acc;
  insert into wallet_transactions(business_id, type, amount, bonus_amount, balance_after, bonus_balance_after, free_count, note, by_name)
  values (p_business, 'qr_charge', -v_main, -v_bonus, acc.balance, acc.bonus_balance, v_free, p_note, p_by)
  returning id into v_tx;
  return jsonb_build_object('fee', v_fee, 'free', v_free, 'bonus_used', v_bonus, 'paid', v_main, 'total', v_cost,
                            'balance', acc.balance, 'bonus_balance', acc.bonus_balance, 'tx_id', v_tx, 'currency', st.currency);
end $$;

-- credit main and/or bonus balance (top-ups, promos, bonuses, refunds)
create or replace function public.dq_credit(p_business uuid, p_type text, p_main numeric, p_bonus numeric,
                                            p_reference text, p_note text, p_by text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc dq_accounts; st platform_settings;
begin
  select * into st from platform_settings where id = 1;
  insert into dq_accounts(business_id) values (p_business) on conflict do nothing;
  update dq_accounts set balance = balance + coalesce(p_main, 0),
         bonus_balance = greatest(bonus_balance + coalesce(p_bonus, 0), 0),
         bonus_expires_at = case when coalesce(p_bonus, 0) > 0
                                 then greatest(coalesce(bonus_expires_at, now()), now() + make_interval(days => st.bonus_expiry_days))
                                 else bonus_expires_at end,
         updated_at = now()
   where business_id = p_business returning * into acc;
  if acc.business_id is null then raise exception 'Business not found'; end if;
  insert into wallet_transactions(business_id, type, amount, bonus_amount, balance_after, bonus_balance_after, reference, note, by_name)
  values (p_business, p_type, coalesce(p_main, 0), coalesce(p_bonus, 0), acc.balance, acc.bonus_balance, p_reference, p_note, p_by);
  return jsonb_build_object('balance', acc.balance, 'bonus_balance', acc.bonus_balance, 'bonus_expires_at', acc.bonus_expires_at);
end $$;

-- new businesses: account, referral code and welcome credit (replaces v1 trigger body)
create or replace function public.dq_after_business_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare st platform_settings;
begin
  select * into st from platform_settings where id = 1;
  insert into dq_accounts(business_id, referral_code)
  values (new.id, new.code || upper(substr(md5(new.id::text), 1, 4))) on conflict do nothing;
  if coalesce(st.welcome_credit, 0) > 0 then
    perform dq_credit(new.id, 'welcome', 0, st.welcome_credit, null, 'Welcome bonus', 'DeepQr');
  end if;
  return new;
end $$;

-- =============================================================================
-- 8. QR codes (v2): tolerant scanning, credits, history, batch voids
-- =============================================================================
create or replace function public.dq_generate_items(
  p_product_id uuid, p_shop_id uuid, p_qty integer, p_expiry date default null, p_batch text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  m members := dq_me(); p products; s shops; bz businesses; ch jsonb;
  yr int := extract(year from now())::int; start_seq int; gen_id uuid;
  i int; ser text; first_ser text; last_ser text;
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
            'DQ1|' || bz.code || '|' || s.code || '|' || replace(p.code, '|', '') || '|' || ser,
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

create or replace function public.dq_qr_recommendations() returns table (
  product_id uuid, shop_id uuid, stock_qty numeric, tagged integer, recommended integer, fee numeric, est_cost numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare b uuid := my_business_id(); f numeric;
begin
  if b is null then raise exception 'Not signed in to a business'; end if;
  f := dq_effective_fee(b);
  return query
  select sl.product_id, sl.shop_id, sl.qty, coalesce(t.n, 0)::int,
         greatest(ceil(sl.qty)::int - coalesce(t.n, 0)::int, 0), f,
         greatest(ceil(sl.qty)::int - coalesce(t.n, 0)::int, 0) * f
  from stock_levels sl
  left join (select pi.product_id, pi.shop_id, count(*) as n from product_items pi
              where pi.business_id = b and pi.status = 'in_stock' group by 1, 2) t
         on t.product_id = sl.product_id and t.shop_id = sl.shop_id
  where sl.business_id = b;
end $$;

-- accepts: full QR (any separator a keyboard layout produced), bare serial, product barcode or code
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

create or replace function public.dq_item_history(p_serial text) returns json
language plpgsql stable security definer set search_path = public as $$
declare m members := dq_me(); it product_items; v text := substring(upper(coalesce(p_serial,'')) from '([0-9]{9,})[^0-9]*$');
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  select * into it from product_items where business_id = m.business_id and serial = coalesce(v, trim(p_serial));
  if it.id is null then return null; end if;
  return json_build_object(
    'item', row_to_json(it),
    'product', (select row_to_json(p) from products p where p.id = it.product_id),
    'shop', (select name from shops where id = it.shop_id),
    'generation', (select row_to_json(g) from qr_generations g where g.id = it.generation_id),
    'sale', (select json_build_object('id', s.id, 'receipt', s.receipt, 'date', s.date, 'customer', s.customer, 'cashier', s.cashier_name, 'status', s.status)
               from sale_lines l join sales s on s.id = l.sale_id where l.item_id = it.id order by s.created_at desc limit 1),
    'transfers', (select coalesce(json_agg(json_build_object('date', t.date, 'from', (select name from shops where id = t.from_shop),
                     'to', (select name from shops where id = t.to_shop), 'status', t.status) order by t.created_at), '[]'::json)
                  from transfers t where it.id = any(t.item_ids)));
end $$;

create or replace function public.dq_void_generation(p_generation_id uuid, p_reason text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']); n integer;
begin
  update product_items set status = 'void'
   where generation_id = p_generation_id and business_id = m.business_id and status = 'in_stock';
  get diagnostics n = row_count;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'qr', n || ' unsold label(s) voided from a batch' || coalesce(': ' || p_reason, ''), m.name);
  return n;
end $$;

-- =============================================================================
-- 9. business wallet: summary, top-ups, promo codes, referrals
-- =============================================================================
create or replace function public.dq_wallet() returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_me(); acc dq_accounts; st platform_settings; v_allow int; v_used int;
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  select * into st from platform_settings where id = 1;
  insert into dq_accounts(business_id) values (m.business_id) on conflict do nothing;
  select * into acc from dq_accounts where business_id = m.business_id;
  v_allow := coalesce(acc.free_qr_monthly, st.free_qr_monthly, 0);
  v_used := case when acc.free_qr_period = to_char(now(), 'YYYY-MM') then acc.free_qr_used else 0 end;
  return json_build_object(
    'balance', acc.balance,
    'bonus_balance', case when acc.bonus_expires_at is not null and acc.bonus_expires_at < now() then 0 else acc.bonus_balance end,
    'bonus_expires_at', acc.bonus_expires_at,
    'fee', coalesce(acc.fee_override, st.qr_fee), 'standard_fee', st.qr_fee,
    'free_allowance', v_allow, 'free_remaining', greatest(v_allow - v_used, 0),
    'credit_limit', acc.credit_limit, 'status', acc.status, 'status_note', acc.status_note, 'plan', acc.plan,
    'total_qr', acc.total_qr, 'total_spent', acc.total_spent,
    'referral_code', acc.referral_code, 'referred', acc.referred_by is not null,
    'referral_bonus', st.referral_bonus, 'referee_bonus', st.referee_bonus,
    'currency', st.currency, 'min_topup', st.min_topup,
    'payment_instructions', st.payment_instructions, 'payment_accounts', st.payment_accounts,
    'support_phone', st.support_phone, 'support_email', st.support_email,
    'low_balance_threshold', st.low_balance_threshold, 'bonus_expiry_days', st.bonus_expiry_days,
    'packages', coalesce((select json_agg(row_to_json(k) order by k.sort, k.amount) from topup_packages k where k.active), '[]'::json));
end $$;

create or replace function public.dq_request_topup2(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']); st platform_settings; k topup_packages;
        v_amount numeric := (p->>'amount')::numeric; v_bonus numeric := 0; r topup_requests;
        v_ref text := upper(trim(coalesce(p->>'reference','')));
begin
  select * into st from platform_settings where id = 1;
  if nullif(p->>'package_id','') is not null then
    select * into k from topup_packages where id = (p->>'package_id')::uuid and active;
    if k.id is null then raise exception 'That package is no longer available'; end if;
    v_amount := k.amount; v_bonus := k.bonus;
  end if;
  if v_amount is null or v_amount < st.min_topup then raise exception 'Minimum top-up is % %', st.min_topup, st.currency; end if;
  if length(v_ref) < 4 then raise exception 'Enter the transaction reference from the payment message'; end if;
  if dq_phone(p->>'sender_phone') is null then raise exception 'Enter the phone number or account you paid from'; end if;
  if exists (select 1 from topup_requests where upper(trim(reference)) = v_ref and status <> 'rejected') then
    raise exception 'DUPLICATE_REFERENCE: reference % was already submitted', v_ref;
  end if;
  insert into topup_requests(business_id, amount, bonus, package_id, method, reference, sender_phone, sender_name, requested_by)
  values (m.business_id, v_amount, v_bonus, k.id, coalesce(nullif(p->>'method',''), 'M-Pesa'), v_ref,
          dq_phone(p->>'sender_phone'), nullif(trim(p->>'sender_name'), ''), m.name)
  returning * into r;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'wallet', 'Top-up request ' || v_amount || ' ' || st.currency || ' (' || r.method || ' ' || v_ref || ')', m.name);
  return row_to_json(r);
end $$;

-- v1 signature kept for older app versions
create or replace function public.dq_request_topup(p_amount numeric, p_method text, p_reference text) returns json
language sql security definer set search_path = public as $$
  select dq_request_topup2(jsonb_build_object('amount', p_amount, 'method', p_method, 'reference', p_reference, 'sender_phone', '0'))
$$;

create or replace function public.dq_cancel_topup(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']);
begin
  update topup_requests set status = 'rejected', review_note = 'Cancelled by ' || m.name, reviewed_at = now()
   where id = p_id and business_id = m.business_id and status = 'pending';
  if not found then raise exception 'Only pending requests can be cancelled'; end if;
end $$;

create or replace function public.dq_redeem_promo(p_code text) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']); c promo_codes; r jsonb;
begin
  select * into c from promo_codes where code = upper(trim(coalesce(p_code, ''))) for update;
  if c.code is null or not c.active then raise exception 'PROMO_INVALID: that promo code is not valid'; end if;
  if c.expires_at is not null and c.expires_at < now() then raise exception 'PROMO_EXPIRED: that promo code has expired'; end if;
  if exists (select 1 from promo_redemptions where code = c.code and business_id = m.business_id) then
    raise exception 'PROMO_ALREADY: your business already used this code';
  end if;
  if c.business_id is not null and c.business_id <> m.business_id then raise exception 'PROMO_INVALID: that promo code is not for your business'; end if;
  if c.max_uses is not null and c.used_count >= c.max_uses then raise exception 'PROMO_USED_UP: that promo code has been fully used'; end if;
  insert into promo_redemptions(code, business_id, credits, redeemed_by) values (c.code, m.business_id, c.credits, m.name);
  update promo_codes set used_count = used_count + 1 where code = c.code;
  r := dq_credit(m.business_id, 'promo', 0, c.credits, c.code, 'Promo code ' || c.code, m.name);
  return (json_build_object('credits', c.credits)::jsonb || r)::json;
end $$;

create or replace function public.dq_apply_referral(p_code text) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner']); acc dq_accounts; ref dq_accounts; st platform_settings; b businesses;
begin
  select * into st from platform_settings where id = 1;
  select * into acc from dq_accounts where business_id = m.business_id for update;
  select * into b from businesses where id = m.business_id;
  if acc.referred_by is not null then raise exception 'A referral code was already applied'; end if;
  if b.created_at < now() - interval '30 days' then raise exception 'Referral codes can only be used in the first 30 days'; end if;
  select * into ref from dq_accounts where referral_code = upper(trim(coalesce(p_code, '')));
  if ref.business_id is null or ref.business_id = m.business_id then raise exception 'That referral code is not valid'; end if;
  update dq_accounts set referred_by = ref.business_id where business_id = m.business_id;
  if st.referee_bonus > 0 then
    perform dq_credit(m.business_id, 'referral', 0, st.referee_bonus, upper(trim(p_code)), 'Referral welcome bonus', 'DeepQr');
  end if;
  return json_build_object('ok', true, 'bonus', st.referee_bonus);
end $$;

-- =============================================================================
-- 10. till: checkout v2 (customers, split payments, credit, loyalty, shifts, permissions)
-- =============================================================================
create or replace function public.dq_checkout2(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  m members := dq_me(); bz businesses; v_shop shops; dev uuid; ln jsonb; it product_items; pr products;
  v_sale uuid; rcpt text; sub numeric := 0; tx numeric := 0; tot numeric; q numeric; pz numeric;
  have numeric; lines_out jsonb := '[]'::jsonb; d date := coalesce(nullif(p->>'date','')::date, current_date); n int; agg record;
  v_disc numeric := round(greatest(coalesce((p->>'discount')::numeric, 0), 0), 2);
  v_pts int := greatest(coalesce((p->>'points_redeem')::int, 0), 0); v_pts_val numeric := 0;
  cu customers; pay jsonb; v_paid numeric := 0; v_cash numeric := 0; v_change numeric := 0; v_due numeric := 0;
  v_methods text[] := '{}'; v_method text; v_amt numeric; v_ref text;
  v_shift uuid := nullif(p->>'shift_id','')::uuid; v_earn int := 0; v_label text; v_perm jsonb; v_maxdisc numeric;
  v_name text := nullif(trim(p->>'customer_name'), ''); v_phone text := dq_phone(p->>'customer_phone');
begin
  if m.id is null then raise exception 'Not signed in to a business (or your account is disabled)'; end if;
  perform dq_trust();
  select * into v_shop from shops where id = nullif(p->>'shop_id','')::uuid and business_id = m.business_id;
  if v_shop.id is null then raise exception 'Shop not found'; end if;
  if not v_shop.active or v_shop.blocked_by_platform then raise exception 'SHOP_DISABLED: % cannot sell right now', v_shop.name; end if;
  if m.role = 'cashier' and m.shop_id is not null and m.shop_id <> v_shop.id then raise exception 'Cashiers can only sell at their own shop'; end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') = 0 then raise exception 'Cart is empty'; end if;
  perform dq_require_active(m.business_id);
  dev := dq_check_device(m.business_id, v_shop.id, p->>'device_key');
  select * into bz from businesses where id = m.business_id;
  v_perm := dq_perms(m);

  if v_shift is null then
    select id into v_shift from shifts where member_id = m.id and status = 'open' and shop_id = v_shop.id limit 1;
  else
    perform 1 from shifts where id = v_shift and business_id = m.business_id and status = 'open';
    if not found then v_shift := null; end if;
  end if;
  if v_shift is null and bz.require_shift then raise exception 'SHIFT_REQUIRED: open your till shift before selling'; end if;

  for ln in select * from jsonb_array_elements(p->'lines') loop
    if nullif(ln->>'item_id','') is not null then
      select * into it from product_items where id = (ln->>'item_id')::uuid and business_id = m.business_id for update;
      if it.id is null then raise exception 'ITEM_NOT_FOUND'; end if;
      if it.status = 'transit' then raise exception 'ITEM_IN_TRANSIT: % is on a transfer — confirm the transfer first', it.serial; end if;
      if it.status <> 'in_stock' then raise exception 'ITEM_ALREADY_SOLD: % is already %', it.serial, it.status; end if;
      if bz.block_expired_sales and it.expiry_date is not null and it.expiry_date < current_date then
        raise exception 'ITEM_EXPIRED: % expired on %', it.serial, it.expiry_date; end if;
      select * into pr from products where id = it.product_id;
      q := 1; pz := coalesce((ln->>'price')::numeric, pr.price);
    else
      select * into pr from products where id = nullif(ln->>'product_id','')::uuid and business_id = m.business_id;
      if pr.id is null then raise exception 'PRODUCT_NOT_FOUND'; end if;
      q := coalesce((ln->>'qty')::numeric, 0); pz := coalesce((ln->>'price')::numeric, pr.price);
      it := null;
    end if;
    if q <= 0 or pz < 0 then raise exception 'Invalid quantity or price for %', pr.name; end if;
    if pz <> pr.price and not coalesce((v_perm->>'can_edit_price')::boolean, false) then
      raise exception 'PRICE_LOCKED: you are not allowed to change the price of %', pr.name;
    end if;
    lines_out := lines_out || jsonb_build_object('product_id', pr.id, 'item_id', it.id, 'serial', it.serial,
      'name', pr.name, 'code', pr.code, 'qty', q, 'price', pz, 'tax', coalesce(pr.tax, 0), 'cost', coalesce(pr.cost, 0));
    sub := sub + q * pz; tx := tx + q * pz * coalesce(pr.tax, 0) / 100;
  end loop;
  sub := round(sub, 2); tx := round(tx, 2);

  for agg in select (x->>'product_id')::uuid as pid, sum((x->>'qty')::numeric) as q, max(x->>'name') as nm
               from jsonb_array_elements(lines_out) x group by 1 loop
    select sl.qty into have from stock_levels sl where sl.shop_id = v_shop.id and sl.product_id = agg.pid for update;
    if coalesce(have, 0) < agg.q then
      raise exception 'NOT_ENOUGH_STOCK: only % of % in stock at %', coalesce(have, 0), agg.nm, v_shop.name;
    end if;
  end loop;

  v_maxdisc := (v_perm->>'max_discount_pct')::numeric;
  if v_disc > 0 and v_maxdisc is not null and v_disc > round((sub + tx) * v_maxdisc / 100, 2) then
    raise exception 'DISCOUNT_LIMIT: your discount limit is % percent of the sale', v_maxdisc;
  end if;

  -- customer: pick by id, or find/create by phone
  if nullif(p->>'customer_id','') is not null then
    select * into cu from customers where id = (p->>'customer_id')::uuid and business_id = m.business_id for update;
    if cu.id is null then raise exception 'Customer not found'; end if;
  elsif v_phone is not null then
    select * into cu from customers where business_id = m.business_id and phone = v_phone for update;
    if cu.id is null then
      insert into customers(business_id, name, phone) values (m.business_id, coalesce(v_name, 'Customer ' || v_phone), v_phone)
      returning * into cu;
    end if;
  end if;

  if v_pts > 0 then
    if not bz.loyalty_enabled then raise exception 'Loyalty points are switched off'; end if;
    if cu.id is null then raise exception 'Choose a customer to redeem points'; end if;
    if v_pts > cu.points then raise exception 'POINTS: % has only % points', cu.name, cu.points; end if;
    if v_pts < bz.min_redeem_points then raise exception 'POINTS: redeem at least % points', bz.min_redeem_points; end if;
    v_pts_val := round(v_pts * bz.point_value, 2);
  end if;
  tot := round(sub + tx - v_disc - v_pts_val, 2);
  if tot < 0 then raise exception 'Discount and points are larger than the total'; end if;

  for pay in select * from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) loop
    v_method := coalesce(nullif(trim(pay->>'method'), ''), 'Cash');
    v_amt := round(coalesce((pay->>'amount')::numeric, 0), 2);
    v_ref := nullif(trim(pay->>'reference'), '');
    if v_amt < 0 then raise exception 'Payment amounts cannot be negative'; end if;
    if v_amt = 0 or v_method = 'Credit' then continue; end if;
    if v_method <> 'Cash' and bz.require_payment_ref and v_ref is null then
      raise exception 'PAYMENT_REF: enter the % transaction reference', v_method;
    end if;
    if v_method = 'Cash' then v_cash := v_cash + v_amt; end if;
    v_paid := v_paid + v_amt;
    v_methods := array_append(v_methods, v_method);
  end loop;
  if v_paid - v_cash > tot then raise exception 'Mobile money, card and bank payments cannot be more than the total'; end if;
  v_change := greatest(v_paid - tot, 0);
  v_due := greatest(tot - v_paid, 0);
  if v_due > 0 then
    if not bz.allow_credit_sales then raise exception 'CREDIT_OFF: collect the full amount (credit sales are switched off)'; end if;
    if cu.id is null then raise exception 'CREDIT_CUSTOMER: add the customer name and phone to sell on credit'; end if;
    if not coalesce((v_perm->>'can_sell_credit')::boolean, true) then raise exception 'You are not allowed to sell on credit'; end if;
    if cu.credit_limit > 0 and cu.balance + v_due > cu.credit_limit then
      raise exception 'CREDIT_LIMIT: % would owe %, above the credit limit of %', cu.name, cu.balance + v_due, cu.credit_limit;
    end if;
  end if;
  v_label := case when array_length(v_methods, 1) is null then 'Credit'
                  when (select count(distinct x) from unnest(v_methods) x) = 1 then v_methods[1] else 'Split' end;
  if v_due > 0 and v_paid > 0 then v_label := v_label || ' + Credit'; end if;
  if bz.loyalty_enabled and cu.id is not null and bz.points_per_amount > 0 then
    v_earn := floor((tot - v_due) / bz.points_per_amount);
  end if;

  perform pg_advisory_xact_lock(hashtext('dq_rcpt_' || m.business_id::text || d::text));
  select count(*) + 1 into n from sales where business_id = m.business_id and date = d;
  rcpt := bz.code || '-' || to_char(d, 'YYMMDD') || '-' || lpad(n::text, 4, '0');

  insert into sales(business_id, shop_id, receipt, date, time, subtotal, tax, total, payment, customer, customer_phone, customer_id,
                    cashier_name, discount, amount_paid, change_due, device_id, paid_total, balance_due, payment_status,
                    points_earned, points_redeemed, points_value, shift_id, note)
  values (m.business_id, v_shop.id, rcpt, d, coalesce(nullif(p->>'time',''), to_char(now() at time zone bz.timezone, 'HH24:MI')),
          sub, tx, tot, v_label, coalesce(cu.name, v_name, 'Walk-in'), coalesce(cu.phone, v_phone), cu.id,
          m.name, v_disc, v_paid, case when v_cash > 0 then v_change end, dev, tot - v_due, v_due,
          case when v_due = 0 then 'paid' when v_due < tot then 'partial' else 'unpaid' end,
          v_earn, v_pts, v_pts_val, v_shift, nullif(trim(p->>'note'), ''))
  returning id into v_sale;

  insert into sale_lines(sale_id, business_id, product_id, name, code, qty, price, tax, item_id, serial, cost)
  select v_sale, m.business_id, (x->>'product_id')::uuid, x->>'name', x->>'code', (x->>'qty')::numeric,
         (x->>'price')::numeric, (x->>'tax')::numeric, nullif(x->>'item_id','')::uuid, x->>'serial', (x->>'cost')::numeric
  from jsonb_array_elements(lines_out) x;

  -- payments ledger: one row per non-cash payment, one net cash row (cash received minus change)
  insert into sale_payments(business_id, sale_id, customer_id, shift_id, shop_id, kind, method, amount, reference, by_name)
  select m.business_id, v_sale, cu.id, v_shift, v_shop.id, 'sale', coalesce(nullif(trim(x->>'method'),''),'Cash'),
         round((x->>'amount')::numeric, 2), nullif(trim(x->>'reference'),''), m.name
  from jsonb_array_elements(coalesce(p->'payments','[]'::jsonb)) x
  where coalesce(nullif(trim(x->>'method'),''),'Cash') not in ('Cash','Credit') and coalesce((x->>'amount')::numeric,0) > 0;
  if v_cash - v_change > 0 then
    insert into sale_payments(business_id, sale_id, customer_id, shift_id, shop_id, kind, method, amount, by_name)
    values (m.business_id, v_sale, cu.id, v_shift, v_shop.id, 'sale', 'Cash', v_cash - v_change, m.name);
  end if;

  update product_items set status = 'sold', sale_id = v_sale, sold_at = now(), shop_id = v_shop.id
   where id in (select nullif(x->>'item_id','')::uuid from jsonb_array_elements(lines_out) x);
  update stock_levels sl set qty = sl.qty - a.q
    from (select (x->>'product_id')::uuid as pid, sum((x->>'qty')::numeric) as q from jsonb_array_elements(lines_out) x group by 1) a
   where sl.shop_id = v_shop.id and sl.product_id = a.pid;

  if cu.id is not null then
    update customers set balance = balance + v_due, points = points - v_pts + v_earn,
           total_spent = total_spent + tot, visits = visits + 1, last_visit = now()
     where id = cu.id returning * into cu;
    if v_due > 0 then
      insert into customer_ledger(business_id, customer_id, type, amount, balance_after, points_after, sale_id, note, by_name)
      values (m.business_id, cu.id, 'credit_sale', v_due, cu.balance, cu.points, v_sale, 'Receipt ' || rcpt, m.name);
    end if;
    if v_pts > 0 then
      insert into customer_ledger(business_id, customer_id, type, points, balance_after, points_after, sale_id, note, by_name)
      values (m.business_id, cu.id, 'points_redeemed', -v_pts, cu.balance, cu.points, v_sale, 'Worth ' || v_pts_val, m.name);
    end if;
    if v_earn > 0 then
      insert into customer_ledger(business_id, customer_id, type, points, balance_after, points_after, sale_id, note, by_name)
      values (m.business_id, cu.id, 'points_earned', v_earn, cu.balance, cu.points, v_sale, 'Receipt ' || rcpt, m.name);
    end if;
  end if;

  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'sale', 'Sale ' || rcpt || ': ' || tot || ' ' || coalesce(bz.currency,'') || ' at ' || v_shop.name
          || case when v_due > 0 then ' (' || v_due || ' on credit)' else '' end, m.name);

  return json_build_object(
    'sale', (select row_to_json(s) from sales s where s.id = v_sale),
    'lines', (select json_agg(row_to_json(l)) from sale_lines l where l.sale_id = v_sale),
    'payments', (select coalesce(json_agg(row_to_json(sp)), '[]'::json) from sale_payments sp where sp.sale_id = v_sale),
    'customer', case when cu.id is null then null else json_build_object('id', cu.id, 'name', cu.name, 'phone', cu.phone,
                     'points', cu.points, 'balance', cu.balance) end);
end $$;

-- refunds: full or selected lines; debt is cancelled first, the rest is paid back
create or replace function public.dq_refund2(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare m members := dq_me(); s sales; cu customers; l sale_lines; v_req numeric; v_gross numeric := 0;
        v_factor numeric; v_value numeric; v_debt numeric; v_cash numeric; v_full boolean; v_rev int := 0;
        v_shift uuid := nullif(p->>'shift_id','')::uuid; v_lines int := 0;
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  if not coalesce((dq_perms(m)->>'can_refund')::boolean, false) then raise exception 'You are not allowed to refund sales'; end if;
  perform dq_trust();
  select * into s from sales where id = nullif(p->>'sale_id','')::uuid and business_id = m.business_id for update;
  if s.id is null then raise exception 'Sale not found'; end if;
  if s.status = 'refunded' then raise exception 'This receipt is already fully refunded'; end if;
  if v_shift is null then select id into v_shift from shifts where member_id = m.id and status = 'open' limit 1; end if;

  for l in select * from sale_lines where sale_id = s.id for update loop
    if jsonb_typeof(p->'lines') = 'array' and jsonb_array_length(p->'lines') > 0 then
      select coalesce(sum((x->>'qty')::numeric), 0) into v_req from jsonb_array_elements(p->'lines') x where x->>'line_id' = l.id::text;
    else
      v_req := l.qty - l.refunded_qty;
    end if;
    if v_req <= 0 then continue; end if;
    if v_req > l.qty - l.refunded_qty then raise exception 'Cannot return more % than were sold', l.name; end if;
    update sale_lines set refunded_qty = refunded_qty + v_req where id = l.id;
    v_gross := v_gross + v_req * l.price * (1 + coalesce(l.tax, 0) / 100);
    v_lines := v_lines + 1;
    if l.item_id is not null then
      update product_items set status = 'in_stock', sale_id = null, sold_at = null where id = l.item_id;
    end if;
    if l.product_id is not null then
      insert into stock_levels(business_id, shop_id, product_id, qty) values (m.business_id, s.shop_id, l.product_id, v_req)
      on conflict (shop_id, product_id) do update set qty = stock_levels.qty + excluded.qty;
    end if;
  end loop;
  if v_lines = 0 then raise exception 'Nothing selected to refund'; end if;

  v_factor := case when s.subtotal + s.tax > 0 then s.total / (s.subtotal + s.tax) else 1 end;
  v_value := least(round(v_gross * v_factor, 2), s.total - s.refunded_amount);
  v_debt := least(v_value, s.balance_due);
  v_cash := v_value - v_debt;
  v_full := not exists (select 1 from sale_lines where sale_id = s.id and refunded_qty < qty);

  update sales set refunded_amount = refunded_amount + v_value, balance_due = balance_due - v_debt,
         paid_total = coalesce(paid_total, total) - v_cash,
         status = case when v_full then 'refunded' else 'partially_refunded' end,
         payment_status = case when balance_due - v_debt <= 0 then 'paid' else payment_status end,
         refunded_by = m.name, refunded_at = now(), refund_reason = coalesce(nullif(p->>'reason',''), refund_reason)
   where id = s.id;

  if s.customer_id is not null then
    select * into cu from customers where id = s.customer_id for update;
    v_rev := least(cu.points, case when v_full then s.points_earned else floor(s.points_earned * v_value / nullif(s.total, 0))::int end);
    update customers set balance = balance - v_debt, total_spent = greatest(total_spent - v_value, 0),
           points = points - coalesce(v_rev, 0) + case when v_full then s.points_redeemed else 0 end
     where id = cu.id returning * into cu;
    insert into customer_ledger(business_id, customer_id, type, amount, points, balance_after, points_after, sale_id, method, note, by_name)
    values (m.business_id, cu.id, 'refund', -v_debt, -coalesce(v_rev, 0) + case when v_full then s.points_redeemed else 0 end,
            cu.balance, cu.points, s.id, p->>'method', 'Refund on ' || s.receipt, m.name);
  end if;
  if v_cash > 0 then
    insert into sale_payments(business_id, sale_id, customer_id, shift_id, shop_id, kind, method, amount, reference, by_name)
    values (m.business_id, s.id, s.customer_id, v_shift, s.shop_id, 'refund', coalesce(nullif(p->>'method',''), 'Cash'), -v_cash,
            nullif(trim(p->>'reference'),''), m.name);
  end if;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'refund', 'Refund ' || v_value || ' on ' || s.receipt || coalesce(': ' || nullif(p->>'reason',''), ''), m.name);
  return json_build_object('ok', true, 'refund_value', v_value, 'debt_cancelled', v_debt, 'cash_back', v_cash, 'full', v_full);
end $$;

create or replace function public.dq_refund_sale(p_sale_id uuid, p_reason text default null) returns json
language sql security definer set search_path = public as $$
  select dq_refund2(jsonb_build_object('sale_id', p_sale_id, 'reason', p_reason))
$$;

-- customer pays (part of) their debt; oldest receipts are settled first
create or replace function public.dq_customer_payment(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); cu customers; s record; v_left numeric := round(coalesce((p->>'amount')::numeric, 0), 2);
        v_amt numeric := v_left; v_take numeric; v_method text := coalesce(nullif(p->>'method',''), 'Cash');
        v_shift uuid := nullif(p->>'shift_id','')::uuid; bz businesses;
begin
  select * into bz from businesses where id = m.business_id;
  select * into cu from customers where id = nullif(p->>'customer_id','')::uuid and business_id = m.business_id for update;
  if cu.id is null then raise exception 'Customer not found'; end if;
  if v_amt <= 0 then raise exception 'Enter the amount paid'; end if;
  if v_amt > cu.balance then raise exception 'OVERPAY: % owes only %', cu.name, cu.balance; end if;
  if v_method <> 'Cash' and bz.require_payment_ref and nullif(trim(p->>'reference'),'') is null then
    raise exception 'PAYMENT_REF: enter the % transaction reference', v_method;
  end if;
  if v_shift is null then select id into v_shift from shifts where member_id = m.id and status = 'open' limit 1; end if;
  for s in select id, balance_due, shop_id from sales where customer_id = cu.id and balance_due > 0 order by created_at for update loop
    exit when v_left <= 0;
    v_take := least(v_left, s.balance_due);
    update sales set balance_due = balance_due - v_take, paid_total = coalesce(paid_total, 0) + v_take,
           payment_status = case when balance_due - v_take <= 0 then 'paid' else 'partial' end
     where id = s.id;
    insert into sale_payments(business_id, sale_id, customer_id, shift_id, shop_id, kind, method, amount, reference, by_name)
    values (m.business_id, s.id, cu.id, v_shift, coalesce(s.shop_id, m.shop_id), 'debt_payment', v_method, v_take, nullif(trim(p->>'reference'),''), m.name);
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then  -- balance from older/manual adjustments
    insert into sale_payments(business_id, customer_id, shift_id, shop_id, kind, method, amount, reference, by_name)
    values (m.business_id, cu.id, v_shift, m.shop_id, 'debt_payment', v_method, v_left, nullif(trim(p->>'reference'),''), m.name);
  end if;
  update customers set balance = balance - v_amt where id = cu.id returning * into cu;
  insert into customer_ledger(business_id, customer_id, type, amount, balance_after, points_after, method, reference, note, by_name)
  values (m.business_id, cu.id, 'payment', -v_amt, cu.balance, cu.points, v_method, nullif(trim(p->>'reference'),''), nullif(p->>'note',''), m.name);
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'payment', cu.name || ' paid ' || v_amt || ' (' || v_method || ')', m.name);
  return json_build_object('ok', true, 'balance', cu.balance);
end $$;

create or replace function public.dq_adjust_customer(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']); cu customers;
        v_amt numeric := coalesce((p->>'amount')::numeric, 0); v_pts int := coalesce((p->>'points')::int, 0);
begin
  select * into cu from customers where id = nullif(p->>'customer_id','')::uuid and business_id = m.business_id for update;
  if cu.id is null then raise exception 'Customer not found'; end if;
  if nullif(trim(p->>'note'),'') is null then raise exception 'Give a reason for the adjustment'; end if;
  update customers set balance = balance + v_amt, points = greatest(points + v_pts, 0) where id = cu.id returning * into cu;
  insert into customer_ledger(business_id, customer_id, type, amount, points, balance_after, points_after, note, by_name)
  values (m.business_id, cu.id, 'adjustment', v_amt, v_pts, cu.balance, cu.points, p->>'note', m.name);
  return json_build_object('balance', cu.balance, 'points', cu.points);
end $$;

-- =============================================================================
-- 11. shifts / cash-up
-- =============================================================================
create or replace function public.dq_shift_report(p_shift_id uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare m members := dq_me(); sh shifts; v_cash numeric; v_in numeric; v_out numeric;
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  select * into sh from shifts where id = p_shift_id and business_id = m.business_id;
  if sh.id is null then raise exception 'Shift not found'; end if;
  select coalesce(sum(amount), 0) into v_cash from sale_payments where shift_id = sh.id and method = 'Cash';
  select coalesce(sum(amount) filter (where type = 'in'), 0), coalesce(sum(amount) filter (where type = 'out'), 0)
    into v_in, v_out from cash_movements where shift_id = sh.id;
  return json_build_object(
    'shift', row_to_json(sh), 'shop', (select name from shops where id = sh.shop_id),
    'expected_cash', sh.opening_float + v_cash + v_in - v_out,
    'cash_sales', v_cash, 'cash_in', v_in, 'cash_out', v_out,
    'receipts', (select count(*) from sales where shift_id = sh.id),
    'sales_total', (select coalesce(sum(total), 0) from sales where shift_id = sh.id),
    'credit_given', (select coalesce(sum(cl.amount), 0) from customer_ledger cl join sales s on s.id = cl.sale_id
                     where s.shift_id = sh.id and cl.type = 'credit_sale'),
    'by_method', (select coalesce(json_agg(json_build_object('method', method, 'kind', kind, 'amount', a, 'count', c)), '[]'::json)
                  from (select method, kind, sum(amount) as a, count(*) as c from sale_payments where shift_id = sh.id group by 1, 2) x),
    'movements', (select coalesce(json_agg(row_to_json(cm) order by cm.created_at), '[]'::json) from cash_movements cm where cm.shift_id = sh.id));
end $$;

create or replace function public.dq_open_shift(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); v_shop uuid := coalesce(nullif(p->>'shop_id','')::uuid, m.shop_id); sh shifts;
begin
  if v_shop is null or not exists (select 1 from shops where id = v_shop and business_id = m.business_id) then raise exception 'Choose the shop for this shift'; end if;
  if exists (select 1 from shifts where member_id = m.id and status = 'open') then raise exception 'You already have an open shift'; end if;
  insert into shifts(business_id, shop_id, member_id, member_name, opening_float)
  values (m.business_id, v_shop, m.id, m.name, greatest(coalesce((p->>'opening_float')::numeric, 0), 0)) returning * into sh;
  insert into activity_log(business_id, type, description, by_name) values (m.business_id, 'shift', 'Shift opened with float ' || sh.opening_float, m.name);
  return row_to_json(sh);
end $$;

create or replace function public.dq_cash_move(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); sh shifts; cm cash_movements;
begin
  select * into sh from shifts where id = nullif(p->>'shift_id','')::uuid and business_id = m.business_id and status = 'open';
  if sh.id is null then raise exception 'Open shift not found'; end if;
  if sh.member_id <> m.id and m.role not in ('owner','manager') then raise exception 'This is not your shift'; end if;
  if nullif(trim(p->>'reason'),'') is null then raise exception 'Give a reason (e.g. "fuel for delivery")'; end if;
  insert into cash_movements(business_id, shift_id, type, amount, reason, by_name)
  values (m.business_id, sh.id, case when p->>'type' = 'in' then 'in' else 'out' end, (p->>'amount')::numeric, trim(p->>'reason'), m.name)
  returning * into cm;
  return row_to_json(cm);
end $$;

create or replace function public.dq_close_shift(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); sh shifts; r json; v_exp numeric; v_counted numeric := (p->>'counted_cash')::numeric;
begin
  select * into sh from shifts where id = nullif(p->>'shift_id','')::uuid and business_id = m.business_id and status = 'open' for update;
  if sh.id is null then raise exception 'Open shift not found'; end if;
  if sh.member_id <> m.id and m.role not in ('owner','manager') then raise exception 'Only the cashier or a manager can close this shift'; end if;
  if v_counted is null or v_counted < 0 then raise exception 'Enter the cash you counted in the drawer'; end if;
  r := dq_shift_report(sh.id);
  v_exp := (r->>'expected_cash')::numeric;
  update shifts set status = 'closed', closed_at = now(), closed_by = m.name, expected_cash = v_exp,
         counted_cash = v_counted, difference = v_counted - v_exp, note = nullif(trim(p->>'note'), '')
   where id = sh.id;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'shift', 'Shift closed: expected ' || v_exp || ', counted ' || v_counted || ' (difference ' || (v_counted - v_exp) || ')', m.name);
  return dq_shift_report(sh.id);
end $$;

-- =============================================================================
-- 12. purchasing: orders, receiving, supplier payments
-- =============================================================================
create or replace function public.dq_save_order(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare m members := dq_require_staff(array['owner','manager','inventory','main_operator']); o orders; sp suppliers;
        v_status text := coalesce(nullif(p->>'status',''), 'ordered'); it jsonb; v_total numeric := 0; n int; v_keep uuid[] := '{}';
        oi order_items; pr products;
begin
  if v_status not in ('draft','ordered') then raise exception 'Save as draft or ordered'; end if;
  select * into sp from suppliers where id = nullif(p->>'supplier_id','')::uuid and business_id = m.business_id;
  if sp.id is null then raise exception 'ORDER_SUPPLIER: choose a supplier'; end if;
  if not exists (select 1 from shops where id = nullif(p->>'shop_id','')::uuid and business_id = m.business_id) then
    raise exception 'ORDER_SHOP: choose where the goods will be delivered'; end if;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'ORDER_ITEMS: add at least one product'; end if;
  if nullif(p->>'expected_date','') is not null and (p->>'expected_date')::date < coalesce(nullif(p->>'order_date','')::date, current_date) then
    raise exception 'ORDER_DATES: the expected delivery date is before the order date';
  end if;
  if nullif(p->>'id','') is not null then
    select * into o from orders where id = (p->>'id')::uuid and business_id = m.business_id for update;
    if o.id is null then raise exception 'Order not found'; end if;
    if o.status not in ('draft','pending','ordered','partial') then raise exception 'This order is % and cannot be edited', o.status; end if;
    if o.status = 'partial' and v_status = 'draft' then v_status := 'partial'; end if;
    if o.status = 'partial' then v_status := 'partial'; end if;
    update orders set supplier_id = sp.id, supplier_name = sp.name, shop_id = (p->>'shop_id')::uuid,
           order_date = coalesce(nullif(p->>'order_date','')::date, order_date), expected_date = nullif(p->>'expected_date','')::date,
           ref = coalesce(p->>'ref', ref), note = coalesce(p->>'note', note), invoice_no = nullif(trim(p->>'invoice_no'),''),
           invoice_amount = nullif(p->>'invoice_amount','')::numeric, status = v_status, updated_at = now()
     where id = o.id returning * into o;
  else
    perform pg_advisory_xact_lock(hashtext('dq_po_' || m.business_id::text));
    select count(*) + 1 into n from orders where business_id = m.business_id and created_at >= date_trunc('month', now());
    insert into orders(business_id, shop_id, supplier_id, supplier_name, order_no, order_date, expected_date, ref, note,
                       invoice_no, invoice_amount, status, created_by, attachments)
    values (m.business_id, (p->>'shop_id')::uuid, sp.id, sp.name,
            'PO-' || to_char(now(), 'YYMM') || '-' || lpad(n::text, 3, '0'),
            coalesce(nullif(p->>'order_date','')::date, current_date), nullif(p->>'expected_date','')::date,
            coalesce(p->>'ref',''), coalesce(p->>'note',''), nullif(trim(p->>'invoice_no'),''), nullif(p->>'invoice_amount','')::numeric,
            v_status, m.name, coalesce(p->'attachments', '[]'::jsonb))
    returning * into o;
  end if;
  for it in select * from jsonb_array_elements(p->'items') loop
    select * into pr from products where id = nullif(it->>'product_id','')::uuid and business_id = m.business_id;
    if pr.id is null then raise exception 'ORDER_ITEMS: product not found'; end if;
    if coalesce((it->>'qty_ordered')::numeric, 0) <= 0 then raise exception 'ORDER_ITEMS: enter a quantity for %', pr.name; end if;
    if coalesce((it->>'unit_cost')::numeric, -1) < 0 then raise exception 'ORDER_ITEMS: enter the unit cost for %', pr.name; end if;
    oi := null;
    if nullif(it->>'id','') is not null then
      select * into oi from order_items where id = (it->>'id')::uuid and order_id = o.id;
    end if;
    if oi.id is not null then
      if (it->>'qty_ordered')::numeric < oi.qty_received + oi.qty_damaged then
        raise exception 'ORDER_ITEMS: % already has % received', pr.name, oi.qty_received + oi.qty_damaged;
      end if;
      update order_items set product_id = pr.id, product_name = pr.name, qty_ordered = (it->>'qty_ordered')::numeric,
             unit_cost = (it->>'unit_cost')::numeric, note = nullif(it->>'note',''), shop_id = o.shop_id
       where id = oi.id;
    else
      insert into order_items(order_id, business_id, product_id, product_name, shop_id, qty_ordered, unit_cost, note)
      values (o.id, m.business_id, pr.id, pr.name, o.shop_id, (it->>'qty_ordered')::numeric, (it->>'unit_cost')::numeric, nullif(it->>'note',''))
      returning * into oi;
    end if;
    v_keep := array_append(v_keep, oi.id);
    v_total := v_total + (it->>'qty_ordered')::numeric * (it->>'unit_cost')::numeric;
  end loop;
  if exists (select 1 from order_items where order_id = o.id and not (id = any(v_keep)) and qty_received + qty_damaged > 0) then
    raise exception 'ORDER_ITEMS: lines that already received goods cannot be removed';
  end if;
  delete from order_items where order_id = o.id and not (id = any(v_keep));
  update orders set total_cost = round(v_total, 2) where id = o.id;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'order', 'Purchase order ' || o.order_no || ' saved (' || v_status || ') for ' || sp.name, m.name);
  return (select row_to_json(x) from orders x where x.id = o.id);
end $$;

create or replace function public.dq_set_order_status(p_order_id uuid, p_status text, p_reason text default null) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager','inventory','main_operator']); o orders;
begin
  select * into o from orders where id = p_order_id and business_id = m.business_id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if p_status = 'cancelled' then
    if exists (select 1 from order_items where order_id = o.id and qty_received + qty_damaged > 0) then
      raise exception 'Goods were already received — close the order instead of cancelling';
    end if;
    if nullif(trim(p_reason),'') is null then raise exception 'Give a reason for cancelling'; end if;
    update orders set status = 'cancelled', cancelled_reason = p_reason, updated_at = now() where id = o.id;
    update order_items set status = 'cancelled' where order_id = o.id;
  elsif p_status = 'closed' then
    update orders set status = 'closed', closed_at = now(), note = concat_ws(E'\n', nullif(note,''), nullif('Closed: ' || p_reason, 'Closed: ')), updated_at = now() where id = o.id;
  elsif p_status = 'ordered' and o.status in ('draft','closed','pending') then
    update orders set status = case when exists (select 1 from order_items where order_id = o.id and qty_received > 0) then 'partial' else 'ordered' end,
           closed_at = null, updated_at = now() where id = o.id;
  else
    raise exception 'Cannot change the order from % to %', o.status, p_status;
  end if;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'order', 'Order ' || coalesce(o.order_no, '') || ' ' || p_status || coalesce(': ' || p_reason, ''), m.name);
  return (select row_to_json(x) from orders x where x.id = o.id);
end $$;

create or replace function public.dq_receive_order(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); o orders; ln jsonb; oi order_items; r order_receipts; v_good numeric; v_bad numeric;
        v_cost numeric; v_val numeric := 0; v_shop uuid; n int; v_lines int := 0; v_open int;
begin
  if not coalesce((dq_perms(m)->>'can_receive_orders')::boolean, false) then raise exception 'You are not allowed to receive orders'; end if;
  select * into o from orders where id = nullif(p->>'order_id','')::uuid and business_id = m.business_id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status in ('draft','cancelled','closed','received') then raise exception 'This order is % and cannot receive goods', o.status; end if;
  v_shop := coalesce(nullif(p->>'shop_id','')::uuid, o.shop_id);
  if m.role = 'cashier' and v_shop is distinct from m.shop_id then raise exception 'You can only receive goods into your own shop'; end if;
  perform pg_advisory_xact_lock(hashtext('dq_grn_' || m.business_id::text));
  select count(*) + 1 into n from order_receipts where business_id = m.business_id;
  insert into order_receipts(business_id, order_id, shop_id, grn_no, delivery_note_no, note, attachments, received_by)
  values (m.business_id, o.id, v_shop, 'GRN-' || lpad(n::text, 5, '0'), nullif(trim(p->>'delivery_note_no'),''),
          nullif(trim(p->>'note'),''), coalesce(p->'attachments','[]'::jsonb), m.name)
  returning * into r;
  for ln in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
    select * into oi from order_items where id = nullif(ln->>'order_item_id','')::uuid and order_id = o.id for update;
    if oi.id is null then raise exception 'Order line not found'; end if;
    v_good := greatest(coalesce((ln->>'qty')::numeric, 0), 0);
    v_bad := greatest(coalesce((ln->>'damaged')::numeric, 0), 0);
    if v_good + v_bad = 0 then continue; end if;
    if v_good + v_bad > oi.qty_ordered - oi.qty_received - oi.qty_damaged and not coalesce((p->>'allow_over')::boolean, false) then
      raise exception 'OVER_RECEIPT: % — only % outstanding', oi.product_name, oi.qty_ordered - oi.qty_received - oi.qty_damaged;
    end if;
    v_cost := coalesce((ln->>'unit_cost')::numeric, oi.unit_cost);
    insert into order_receipt_lines(business_id, receipt_id, order_item_id, product_id, qty_received, qty_damaged, unit_cost, expiry_date, batch_ref)
    values (m.business_id, r.id, oi.id, oi.product_id, v_good, v_bad, v_cost, nullif(ln->>'expiry_date','')::date, nullif(ln->>'batch',''));
    update order_items set qty_received = qty_received + v_good, qty_damaged = qty_damaged + v_bad, unit_cost = v_cost,
           received_by = m.name, received_at = now(),
           status = case when qty_received + v_good + qty_damaged + v_bad >= qty_ordered then 'received' else 'partial' end
     where id = oi.id;
    if v_good > 0 then
      insert into stock_levels(business_id, shop_id, product_id, qty) values (m.business_id, v_shop, oi.product_id, v_good)
      on conflict (shop_id, product_id) do update set qty = stock_levels.qty + excluded.qty;
      insert into purchases(business_id, shop_id, product_id, qty, cost, supplier, ref, by_name, expiry_date)
      values (m.business_id, v_shop, oi.product_id, v_good, v_cost, coalesce(o.supplier_name, ''), r.grn_no || ' / ' || coalesce(o.order_no, ''),
              m.name, nullif(ln->>'expiry_date','')::date);
      if coalesce((p->>'update_cost')::boolean, true) then update products set cost = v_cost where id = oi.product_id; end if;
    end if;
    v_val := v_val + v_good * v_cost;
    v_lines := v_lines + 1;
  end loop;
  if v_lines = 0 then raise exception 'Enter the quantity received for at least one product'; end if;
  update order_receipts set total_value = round(v_val, 2) where id = r.id returning * into r;
  select count(*) into v_open from order_items where order_id = o.id and status not in ('received','cancelled');
  update orders set received_value = received_value + round(v_val, 2),
         status = case when v_open = 0 then 'received' else 'partial' end,
         payment_status = case when paid_amount <= 0 then 'unpaid'
                               when paid_amount >= coalesce(invoice_amount, received_value + round(v_val, 2)) then 'paid' else 'partial' end,
         updated_at = now()
   where id = o.id returning * into o;
  if o.supplier_id is not null then update suppliers set balance = balance + round(v_val, 2) where id = o.supplier_id; end if;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'purchase', r.grn_no || ': goods received on ' || coalesce(o.order_no, 'order') || ' worth ' || round(v_val, 2), m.name);
  return json_build_object('receipt', row_to_json(r), 'order', row_to_json(o));
end $$;

create or replace function public.dq_supplier_payment(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']); sp suppliers; o orders; v_amt numeric := round(coalesce((p->>'amount')::numeric, 0), 2); r supplier_payments;
begin
  select * into sp from suppliers where id = nullif(p->>'supplier_id','')::uuid and business_id = m.business_id for update;
  if sp.id is null then raise exception 'Supplier not found'; end if;
  if v_amt <= 0 then raise exception 'Enter the amount paid'; end if;
  if nullif(p->>'order_id','') is not null then
    select * into o from orders where id = (p->>'order_id')::uuid and business_id = m.business_id and supplier_id = sp.id for update;
    if o.id is null then raise exception 'That order is not from this supplier'; end if;
  end if;
  insert into supplier_payments(business_id, supplier_id, order_id, amount, method, reference, paid_on, note, attachments, by_name)
  values (m.business_id, sp.id, o.id, v_amt, coalesce(nullif(p->>'method',''), 'Bank'), nullif(trim(p->>'reference'),''),
          coalesce(nullif(p->>'paid_on','')::date, current_date), nullif(trim(p->>'note'),''), coalesce(p->'attachments','[]'::jsonb), m.name)
  returning * into r;
  update suppliers set balance = balance - v_amt where id = sp.id;
  if o.id is not null then
    update orders set paid_amount = paid_amount + v_amt,
           payment_status = case when paid_amount + v_amt >= coalesce(invoice_amount, nullif(received_value, 0), total_cost) then 'paid' else 'partial' end,
           updated_at = now()
     where id = o.id;
  end if;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'supplier', 'Paid ' || v_amt || ' to ' || sp.name || coalesce(' for ' || o.order_no, ''), m.name);
  return row_to_json(r);
end $$;

-- =============================================================================
-- 13. transfers carry QR labels
-- =============================================================================
create or replace function public.dq_send_transfer(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); v_from uuid := nullif(p->>'from_shop','')::uuid; v_to uuid := nullif(p->>'to_shop','')::uuid;
        pr products; v_qty numeric := coalesce((p->>'qty')::numeric, 0); have numeric; t transfers; v_ids uuid[] := '{}';
        v_serials text[]; v_bad text;
begin
  if m.role = 'cashier' and v_from is distinct from m.shop_id then raise exception 'You can only send stock from your own shop'; end if;
  if v_from is null or v_to is null or v_from = v_to then raise exception 'Choose two different locations'; end if;
  if (select count(*) from shops where id in (v_from, v_to) and business_id = m.business_id) <> 2 then raise exception 'Location not found'; end if;
  select * into pr from products where id = nullif(p->>'product_id','')::uuid and business_id = m.business_id;
  if pr.id is null then raise exception 'Product not found'; end if;
  select array_agg(distinct upper(trim(x))) into v_serials from jsonb_array_elements_text(coalesce(p->'serials','[]'::jsonb)) x where trim(x) <> '';
  if v_serials is not null then
    select array_agg(id) into v_ids from product_items
     where business_id = m.business_id and product_id = pr.id and serial = any(v_serials) and status = 'in_stock';
    if coalesce(array_length(v_ids, 1), 0) <> array_length(v_serials, 1) then
      select string_agg(s, ', ') into v_bad from unnest(v_serials) s
       where not exists (select 1 from product_items where business_id = m.business_id and product_id = pr.id and serial = s and status = 'in_stock');
      raise exception 'TRANSFER_LABELS: these labels are not in stock for %: %', pr.name, v_bad;
    end if;
    v_qty := greatest(v_qty, array_length(v_ids, 1));
  end if;
  if v_qty <= 0 then raise exception 'Enter a quantity'; end if;
  select qty into have from stock_levels where shop_id = v_from and product_id = pr.id for update;
  if coalesce(have, 0) < v_qty then raise exception 'NOT_ENOUGH_STOCK: only % of % at the sending location', coalesce(have, 0), pr.name; end if;
  update stock_levels set qty = qty - v_qty where shop_id = v_from and product_id = pr.id;
  insert into transfers(business_id, from_shop, to_shop, product_id, qty, note, by_name, status, item_ids)
  values (m.business_id, v_from, v_to, pr.id, v_qty, coalesce(p->>'note',''), m.name, 'pending', v_ids)
  returning * into t;
  if array_length(v_ids, 1) > 0 then
    update product_items set status = 'transit', transfer_id = t.id where id = any(v_ids);
  end if;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'transfer', v_qty || ' × ' || pr.name || ' sent from ' || (select name from shops where id = v_from) || ' to '
          || (select name from shops where id = v_to) || case when array_length(v_ids,1) > 0 then ' (' || array_length(v_ids,1) || ' labelled)' else '' end, m.name);
  return row_to_json(t);
end $$;

create or replace function public.dq_receive_transfer(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); t transfers; v_rec numeric; v_short numeric; v_move int; v_auto uuid[];
begin
  select * into t from transfers where id = nullif(p->>'transfer_id','')::uuid and business_id = m.business_id for update;
  if t.id is null or t.status <> 'pending' then raise exception 'Pending transfer not found'; end if;
  if m.role not in ('owner','manager') and t.to_shop is distinct from m.shop_id and not coalesce((dq_perms(m)->>'can_manage_stock')::boolean, false) then
    raise exception 'Only the receiving shop or a manager can confirm this transfer';
  end if;
  v_rec := least(coalesce(nullif(p->>'received_qty','')::numeric, t.qty), t.qty);
  if v_rec < 0 then raise exception 'Received quantity cannot be negative'; end if;
  v_short := t.qty - v_rec;
  insert into stock_levels(business_id, shop_id, product_id, qty) values (m.business_id, t.to_shop, t.product_id, v_rec)
  on conflict (shop_id, product_id) do update set qty = stock_levels.qty + excluded.qty;
  -- scanned labels arrive with the goods
  update product_items set status = 'in_stock', shop_id = t.to_shop, transfer_id = null where transfer_id = t.id and status = 'transit';
  -- unlabelled quantity: move the same number of tagged labels (earliest expiry first) so per-shop label counts stay right
  v_move := least(v_rec, t.qty) - coalesce(array_length(t.item_ids, 1), 0);
  if v_move > 0 then
    select array_agg(id) into v_auto from (
      select id from product_items where business_id = m.business_id and product_id = t.product_id and shop_id = t.from_shop and status = 'in_stock'
      order by expiry_date nulls last, serial_seq limit v_move) x;
    if v_auto is not null then update product_items set shop_id = t.to_shop where id = any(v_auto); end if;
  end if;
  if v_short > 0 then
    insert into adjustments(business_id, shop_id, product_id, old_qty, new_qty, reason, by_name)
    values (m.business_id, t.to_shop, t.product_id, t.qty, v_rec, 'Transfer shortage: ' || v_short || ' missing on arrival', m.name);
  end if;
  update transfers set status = 'completed', received_by = m.name, received_at = now(), received_qty = v_rec where id = t.id returning * into t;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'transfer', 'Transfer received: ' || v_rec || ' of ' || t.qty || ' × ' || (select name from products where id = t.product_id), m.name);
  return row_to_json(t);
end $$;

create or replace function public.dq_cancel_transfer(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); t transfers;
begin
  select * into t from transfers where id = p_id and business_id = m.business_id for update;
  if t.id is null or t.status <> 'pending' then raise exception 'Pending transfer not found'; end if;
  if m.role not in ('owner','manager') and t.from_shop is distinct from m.shop_id then raise exception 'Only the sender or a manager can cancel'; end if;
  insert into stock_levels(business_id, shop_id, product_id, qty) values (m.business_id, t.from_shop, t.product_id, t.qty)
  on conflict (shop_id, product_id) do update set qty = stock_levels.qty + excluded.qty;
  update product_items set status = 'in_stock', transfer_id = null where transfer_id = t.id and status = 'transit';
  update transfers set status = 'cancelled', received_by = m.name, received_at = now() where id = t.id returning * into t;
  return row_to_json(t);
end $$;

-- =============================================================================
-- 14. stock takes
-- =============================================================================
create or replace function public.dq_start_count(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); c stock_counts; v_shop uuid := nullif(p->>'shop_id','')::uuid;
begin
  if not coalesce((dq_perms(m)->>'can_manage_stock')::boolean, false) and m.role <> 'cashier' then raise exception 'You cannot run stock takes'; end if;
  if m.role = 'cashier' then v_shop := m.shop_id; end if;
  if not exists (select 1 from shops where id = v_shop and business_id = m.business_id) then raise exception 'Choose a location'; end if;
  if exists (select 1 from stock_counts where shop_id = v_shop and status = 'open') then raise exception 'A stock take is already open for this location'; end if;
  insert into stock_counts(business_id, shop_id, name, category, note, started_by)
  values (m.business_id, v_shop, coalesce(nullif(trim(p->>'name'),''), 'Stock take ' || to_char(now(), 'DD Mon YYYY')),
          nullif(p->>'category',''), nullif(p->>'note',''), m.name) returning * into c;
  insert into stock_count_lines(business_id, count_id, product_id, expected)
  select m.business_id, c.id, pr.id, coalesce(sl.qty, 0)
  from products pr left join stock_levels sl on sl.product_id = pr.id and sl.shop_id = v_shop
  where pr.business_id = m.business_id and pr.active is not false and (c.category is null or pr.category = c.category);
  return row_to_json(c);
end $$;

create or replace function public.dq_count_scan(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); c stock_counts; v text := upper(trim(coalesce(p->>'code',''))); v_serial text;
        it product_items; pr products; l stock_count_lines; v_add numeric := coalesce((p->>'qty')::numeric, 1);
begin
  select * into c from stock_counts where id = nullif(p->>'count_id','')::uuid and business_id = m.business_id and status = 'open';
  if c.id is null then raise exception 'Open stock take not found'; end if;
  v_serial := substring(v from '([0-9]{9,})[^0-9]*$');
  if v_serial is not null then select * into it from product_items where business_id = m.business_id and serial = v_serial; end if;
  if it.id is not null then
    if it.status <> 'in_stock' then
      return json_build_object('ok', false, 'reason', upper(it.status), 'serial', it.serial,
                               'product', (select name from products where id = it.product_id));
    end if;
    select * into l from stock_count_lines where count_id = c.id and product_id = it.product_id for update;
    if l.id is null then raise exception 'That product is not part of this stock take'; end if;
    if it.serial = any(l.serials) then
      return json_build_object('ok', false, 'duplicate', true, 'product', (select name from products where id = it.product_id), 'serial', it.serial,
                               'counted', l.counted);
    end if;
    update stock_count_lines set serials = array_append(serials, it.serial), counted = coalesce(counted, 0) + 1, updated_at = now()
     where id = l.id returning * into l;
    return json_build_object('ok', true, 'kind', 'item', 'serial', it.serial, 'status', it.status,
                             'product', (select name from products where id = it.product_id), 'counted', l.counted, 'expected', l.expected);
  end if;
  select * into pr from products where business_id = m.business_id and (upper(barcode) = v or upper(code) = v) limit 1;
  if pr.id is null then return json_build_object('ok', false, 'reason', 'NOT_FOUND', 'code', v); end if;
  update stock_count_lines set counted = coalesce(counted, 0) + v_add, updated_at = now()
   where count_id = c.id and product_id = pr.id returning * into l;
  if l.id is null then raise exception 'That product is not part of this stock take'; end if;
  return json_build_object('ok', true, 'kind', 'product', 'product', pr.name, 'counted', l.counted, 'expected', l.expected);
end $$;

create or replace function public.dq_set_count(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(); l stock_count_lines;
begin
  update stock_count_lines set counted = nullif(p->>'counted','')::numeric, updated_at = now()
   where count_id = nullif(p->>'count_id','')::uuid and product_id = nullif(p->>'product_id','')::uuid and business_id = m.business_id
     and exists (select 1 from stock_counts where id = count_id and status = 'open')
  returning * into l;
  if l.id is null then raise exception 'Line not found or stock take closed'; end if;
  return row_to_json(l);
end $$;

create or replace function public.dq_apply_count(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager','inventory','main_operator']); c stock_counts; l record; n int := 0; v_val numeric := 0;
begin
  select * into c from stock_counts where id = nullif(p->>'count_id','')::uuid and business_id = m.business_id and status = 'open' for update;
  if c.id is null then raise exception 'Open stock take not found'; end if;
  if coalesce((p->>'cancel')::boolean, false) then
    update stock_counts set status = 'cancelled', applied_by = m.name, applied_at = now() where id = c.id;
    return json_build_object('ok', true, 'cancelled', true);
  end if;
  for l in select scl.*, pr.cost, pr.name, coalesce(sl.qty, 0) as now_qty
             from stock_count_lines scl join products pr on pr.id = scl.product_id
             left join stock_levels sl on sl.shop_id = c.shop_id and sl.product_id = scl.product_id
            where scl.count_id = c.id and scl.counted is not null loop
    -- sales during the count are respected: adjust by (counted - expected) on top of today's quantity
    if l.counted <> l.expected then
      insert into stock_levels(business_id, shop_id, product_id, qty)
      values (m.business_id, c.shop_id, l.product_id, greatest(l.now_qty + (l.counted - l.expected), 0))
      on conflict (shop_id, product_id) do update set qty = excluded.qty;
      insert into adjustments(business_id, shop_id, product_id, old_qty, new_qty, reason, by_name)
      values (m.business_id, c.shop_id, l.product_id, l.now_qty, greatest(l.now_qty + (l.counted - l.expected), 0),
              'Stock take: ' || c.name, m.name);
      n := n + 1; v_val := v_val + (l.counted - l.expected) * coalesce(l.cost, 0);
    end if;
  end loop;
  update stock_counts set status = 'applied', applied_by = m.name, applied_at = now() where id = c.id;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'adjustment', c.name || ' applied: ' || n || ' product(s) adjusted, value change ' || round(v_val, 2), m.name);
  return json_build_object('ok', true, 'adjusted', n, 'value_change', round(v_val, 2));
end $$;

-- =============================================================================
-- 15. inventory & reports
-- =============================================================================
create or replace function public.dq_stock_card(p_product_id uuid, p_shop_id uuid default null, p_limit integer default 200) returns json
language plpgsql stable security definer set search_path = public as $$
declare m members := dq_me();
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  if m.role = 'cashier' then p_shop_id := m.shop_id; end if;
  return (select coalesce(json_agg(x order by x.ts desc), '[]'::json) from (
    select * from (
      select pu.created_at as ts, 'Purchase' as kind, pu.shop_id, pu.qty as qty, coalesce(pu.supplier,'') || ' ' || coalesce(pu.ref,'') as ref, pu.by_name as by_name
        from purchases pu where pu.business_id = m.business_id and pu.product_id = p_product_id
      union all
      select s.created_at, 'Sale', s.shop_id, -l.qty, s.receipt, s.cashier_name
        from sale_lines l join sales s on s.id = l.sale_id where l.business_id = m.business_id and l.product_id = p_product_id
      union all
      select coalesce(s.refunded_at, s.created_at), 'Refund', s.shop_id, l.refunded_qty, s.receipt, s.refunded_by
        from sale_lines l join sales s on s.id = l.sale_id where l.business_id = m.business_id and l.product_id = p_product_id and l.refunded_qty > 0
      union all
      select t.created_at, 'Transfer out', t.from_shop, -t.qty, (select name from shops where id = t.to_shop), t.by_name
        from transfers t where t.business_id = m.business_id and t.product_id = p_product_id
      union all
      select t.received_at, 'Transfer in', t.to_shop, coalesce(t.received_qty, t.qty), (select name from shops where id = t.from_shop), t.received_by
        from transfers t where t.business_id = m.business_id and t.product_id = p_product_id and t.status = 'completed'
      union all
      select t.received_at, 'Transfer cancelled', t.from_shop, t.qty, 'returned', t.received_by
        from transfers t where t.business_id = m.business_id and t.product_id = p_product_id and t.status = 'cancelled'
      union all
      select a.created_at, 'Adjustment', a.shop_id, a.new_qty - a.old_qty, a.reason, a.by_name
        from adjustments a where a.business_id = m.business_id and a.product_id = p_product_id
    ) u where p_shop_id is null or u.shop_id = p_shop_id
    order by ts desc limit p_limit) x);
end $$;

create or replace function public.dq_report(p jsonb) returns json
language plpgsql stable security definer set search_path = public as $$
declare m members := dq_me(); v_from date := coalesce(nullif(p->>'from','')::date, current_date - 29);
        v_to date := coalesce(nullif(p->>'to','')::date, current_date); v_shop uuid := nullif(p->>'shop_id','')::uuid; bz businesses;
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  if m.role = 'cashier' then v_shop := m.shop_id; end if;
  select * into bz from businesses where id = m.business_id;
  return (
  with s as (select * from sales where business_id = m.business_id and date between v_from and v_to and (v_shop is null or shop_id = v_shop)),
  l as (select l.*, s.date, s.shop_id, s.cashier_name, s.subtotal, s.tax as s_tax, s.total as s_total,
               coalesce(l.cost, pr.cost, 0) as unit_cost, coalesce(pr.category, 'General') as category,
               case when s.subtotal + s.tax > 0 then s.total / (s.subtotal + s.tax) else 1 end as factor
          from sale_lines l join s on s.id = l.sale_id left join products pr on pr.id = l.product_id),
  lv as (select *, (qty - refunded_qty) as net_qty,
                (qty - refunded_qty) * price * (1 + coalesce(tax,0)/100) * factor as net_rev,
                (qty - refunded_qty) * unit_cost as net_cost from l),
  pay as (select * from sale_payments where business_id = m.business_id
            and (created_at at time zone bz.timezone)::date between v_from and v_to and (v_shop is null or shop_id = v_shop))
  select json_build_object(
    'from', v_from, 'to', v_to, 'currency', bz.currency,
    'summary', (select json_build_object(
        'receipts', (select count(*) from s), 'gross', (select coalesce(sum(subtotal + tax), 0) from s),
        'discounts', (select coalesce(sum(discount), 0) from s), 'points_value', (select coalesce(sum(points_value), 0) from s),
        'net_sales', (select coalesce(sum(total - refunded_amount), 0) from s), 'refunds', (select coalesce(sum(refunded_amount), 0) from s),
        'cost', (select coalesce(sum(net_cost), 0) from lv), 'profit', (select coalesce(sum(net_rev - net_cost), 0) from lv),
        'items', (select coalesce(sum(net_qty), 0) from lv), 'qr_items', (select count(*) from lv where item_id is not null and net_qty > 0),
        'credit_issued', (select coalesce(sum(balance_due), 0) from s),
        'collected', (select coalesce(sum(amount), 0) from pay),
        'avg_receipt', (select coalesce(avg(total), 0) from s where status <> 'refunded'),
        'expenses', (select coalesce(sum(amount), 0) from expenses where business_id = m.business_id and date between v_from and v_to and (v_shop is null or shop_id = v_shop)))),
    'by_day', (select coalesce(json_agg(x order by x.d), '[]'::json) from (
        select gs::date as d, (select count(*) from s where s.date = gs::date) as receipts,
               (select coalesce(sum(total - refunded_amount), 0) from s where s.date = gs::date) as sales,
               (select coalesce(sum(net_rev - net_cost), 0) from lv where lv.date = gs::date) as profit
        from generate_series(v_from, v_to, interval '1 day') gs) x),
    'by_hour', (select coalesce(json_agg(x order by x.h), '[]'::json) from (
        select extract(hour from created_at at time zone bz.timezone)::int as h, count(*) as receipts, sum(total) as sales from s group by 1) x),
    'by_method', (select coalesce(json_agg(x order by x.amount desc), '[]'::json) from (
        select method, kind, sum(amount) as amount, count(*) as count from pay group by 1, 2) x),
    'by_cashier', (select coalesce(json_agg(x order by x.sales desc), '[]'::json) from (
        select cashier_name as name, count(*) as receipts, sum(total - refunded_amount) as sales, sum(discount) as discounts from s group by 1) x),
    'by_shop', (select coalesce(json_agg(x order by x.sales desc), '[]'::json) from (
        select (select name from shops where id = s.shop_id) as name, count(*) as receipts, sum(total - refunded_amount) as sales from s group by s.shop_id) x),
    'by_product', (select coalesce(json_agg(x order by x.revenue desc), '[]'::json) from (
        select name, code, sum(net_qty) as qty, round(sum(net_rev), 2) as revenue, round(sum(net_cost), 2) as cost,
               round(sum(net_rev - net_cost), 2) as profit from lv group by name, code having sum(net_qty) > 0 order by 4 desc limit 100) x),
    'by_category', (select coalesce(json_agg(x order by x.revenue desc), '[]'::json) from (
        select category, sum(net_qty) as qty, round(sum(net_rev), 2) as revenue, round(sum(net_rev - net_cost), 2) as profit from lv group by 1) x),
    'expenses', (select coalesce(json_agg(x order by x.amount desc), '[]'::json) from (
        select category, sum(amount) as amount from expenses where business_id = m.business_id and date between v_from and v_to
          and (v_shop is null or shop_id = v_shop) group by 1) x),
    'qr_spend', (select coalesce(sum(-(amount + bonus_amount)), 0) from wallet_transactions where business_id = m.business_id and type = 'qr_charge'
          and (created_at at time zone bz.timezone)::date between v_from and v_to),
    'debtors', (select coalesce(json_agg(x order by x.balance desc), '[]'::json) from (
        select c.id, c.name, c.phone, c.balance, c.credit_limit,
          (select coalesce(sum(balance_due) filter (where current_date - date <= 30), 0) from sales where customer_id = c.id and balance_due > 0) as d30,
          (select coalesce(sum(balance_due) filter (where current_date - date between 31 and 60), 0) from sales where customer_id = c.id and balance_due > 0) as d60,
          (select coalesce(sum(balance_due) filter (where current_date - date between 61 and 90), 0) from sales where customer_id = c.id and balance_due > 0) as d90,
          (select coalesce(sum(balance_due) filter (where current_date - date > 90), 0) from sales where customer_id = c.id and balance_due > 0) as d90plus,
          (select min(date) from sales where customer_id = c.id and balance_due > 0) as oldest
        from customers c where c.business_id = m.business_id and c.balance > 0 limit 200) x),
    'valuation', (select coalesce(json_agg(x order by x.retail desc), '[]'::json) from (
        select sh.name as shop, count(*) filter (where sl.qty > 0) as products, sum(sl.qty) as units,
               round(sum(sl.qty * coalesce(pr.cost, 0)), 2) as cost, round(sum(sl.qty * coalesce(pr.price, 0)), 2) as retail
        from stock_levels sl join shops sh on sh.id = sl.shop_id join products pr on pr.id = sl.product_id
        where sl.business_id = m.business_id and (v_shop is null or sl.shop_id = v_shop) group by sh.name) x),
    'valuation_by_category', (select coalesce(json_agg(x order by x.retail desc), '[]'::json) from (
        select coalesce(pr.category,'General') as category, sum(sl.qty) as units,
               round(sum(sl.qty * coalesce(pr.cost, 0)), 2) as cost, round(sum(sl.qty * coalesce(pr.price, 0)), 2) as retail
        from stock_levels sl join products pr on pr.id = sl.product_id
        where sl.business_id = m.business_id and (v_shop is null or sl.shop_id = v_shop) group by 1) x),
    'supplier_balances', (select coalesce(json_agg(x order by x.balance desc), '[]'::json) from (
        select name, balance from suppliers where business_id = m.business_id and balance <> 0) x),
    'shifts', (select coalesce(json_agg(x order by x.opened_at desc), '[]'::json) from (
        select id, member_name, (select name from shops where id = shop_id) as shop, opened_at, closed_at, status,
               opening_float, expected_cash, counted_cash, difference
        from shifts where business_id = m.business_id and (opened_at at time zone bz.timezone)::date between v_from and v_to
          and (v_shop is null or shop_id = v_shop) limit 100) x)
  ));
end $$;

-- =============================================================================
-- 16. platform owner portal (v2)
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
               a.status, a.balance, a.bonus_balance, a.bonus_expires_at, a.total_qr, a.total_spent, a.status_note,
               a.fee_override, a.free_qr_monthly, a.plan, a.credit_limit, a.referral_code, a.admin_notes,
               (select name from businesses r where r.id = a.referred_by) as referred_by,
               (select count(*) from shops where business_id = b.id) as shops,
               (select count(*) from members where business_id = b.id) as staff,
               (select count(*) from members where business_id = b.id and (blocked_by_platform or not active)) as staff_blocked,
               (select count(*) from products where business_id = b.id) as products,
               (select count(*) from product_items where business_id = b.id and status = 'in_stock') as items_in_stock,
               (select count(*) from product_items where business_id = b.id and status = 'sold') as items_sold,
               (select count(*) from sales where business_id = b.id and status <> 'refunded') as sales_count,
               (select coalesce(sum(total - refunded_amount), 0) from sales where business_id = b.id) as sales_total,
               (select coalesce(sum(total - refunded_amount), 0) from sales where business_id = b.id and date >= current_date - 30) as sales_30d,
               (select max(created_at) from activity_log where business_id = b.id) as last_active,
               (select count(*) from devices where business_id = b.id and status = 'approved') as devices,
               (select count(*) from topup_requests where business_id = b.id and status = 'pending') as pending_topups
        from businesses b left join dq_accounts a on a.business_id = b.id) x), '[]'::json),
    'topups', coalesce((select json_agg(row_to_json(t) order by t.created_at desc) from (
        select r.*, b.name as business_name, b.code as business_code, k.name as package_name
          from topup_requests r join businesses b on b.id = r.business_id left join topup_packages k on k.id = r.package_id
         order by r.created_at desc limit 300) t), '[]'::json),
    'ledger', coalesce((select json_agg(row_to_json(t)) from (
        select w.*, b.name as business_name from wallet_transactions w join businesses b on b.id = w.business_id
        order by w.created_at desc limit 400) t), '[]'::json),
    'qr_by_month', coalesce((select json_agg(row_to_json(t) order by t.month) from (
        select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, sum(qty) as qrs, sum(total) as revenue,
               sum(paid_amount) as paid, sum(bonus_used) as bonus, sum(free_qty) as free
        from qr_generations where created_at > now() - interval '12 months' group by 1) t), '[]'::json),
    'topups_by_month', coalesce((select json_agg(row_to_json(t) order by t.month) from (
        select to_char(date_trunc('month', reviewed_at), 'YYYY-MM') as month, sum(amount) as amount, count(*) as count
        from topup_requests where status = 'approved' and reviewed_at > now() - interval '12 months' group by 1) t), '[]'::json),
    'generations', coalesce((select json_agg(row_to_json(t)) from (
        select g.*, b.name as business_name, p.name as product_name, s.name as shop_name,
               (select count(*) from product_items i where i.generation_id = g.id and i.status = 'in_stock') as unsold,
               (select count(*) from product_items i where i.generation_id = g.id and i.status = 'sold') as sold
          from qr_generations g join businesses b on b.id = g.business_id left join products p on p.id = g.product_id
          left join shops s on s.id = g.shop_id order by g.created_at desc limit 300) t), '[]'::json),
    'packages', coalesce((select json_agg(row_to_json(k) order by k.sort, k.amount) from topup_packages k), '[]'::json),
    'promos', coalesce((select json_agg(row_to_json(t) order by t.created_at desc) from (
        select c.*, (select name from businesses where id = c.business_id) as business_name from promo_codes c) t), '[]'::json),
    'announcements', coalesce((select json_agg(row_to_json(t) order by t.created_at desc) from (
        select a.*, (select name from businesses where id = a.business_id) as business_name from announcements a) t), '[]'::json),
    'audit', coalesce((select json_agg(row_to_json(t)) from (select * from platform_audit order by created_at desc limit 300) t), '[]'::json),
    'totals', json_build_object(
        'liability', (select coalesce(sum(balance), 0) from dq_accounts),
        'bonus_outstanding', (select coalesce(sum(bonus_balance), 0) from dq_accounts where bonus_expires_at is null or bonus_expires_at > now()),
        'topups_approved', (select coalesce(sum(amount), 0) from topup_requests where status = 'approved'),
        'topups_pending', (select coalesce(sum(amount), 0) from topup_requests where status = 'pending'),
        'qr_total', (select coalesce(sum(qty), 0) from qr_generations),
        'users', (select count(*) from members), 'devices', (select count(*) from devices),
        'sales_30d', (select coalesce(sum(total - refunded_amount), 0) from sales where date >= current_date - 30))
  );
end $$;

create or replace function public.dq_admin_business(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  return json_build_object(
    'business', (select row_to_json(b) from businesses b where b.id = p_id),
    'account', (select row_to_json(a) from dq_accounts a where a.business_id = p_id),
    'owner_email', (select u.email from businesses b join auth.users u on u.id = b.owner_auth_id where b.id = p_id),
    'members', coalesce((select json_agg(json_build_object('id', m.id, 'name', m.name, 'username', m.username, 'role', m.role,
         'shop', (select name from shops where id = m.shop_id), 'active', m.active, 'blocked', m.blocked_by_platform,
         'blocked_reason', m.blocked_reason, 'created_at', m.created_at,
         'last_sale', (select max(created_at) from sales where business_id = p_id and cashier_name = m.name)) order by m.created_at)
       from members m where m.business_id = p_id), '[]'::json),
    'shops', coalesce((select json_agg(json_build_object('id', s.id, 'name', s.name, 'code', s.code, 'type', s.type,
         'active', s.active, 'blocked', s.blocked_by_platform,
         'sales_30d', (select coalesce(sum(total - refunded_amount), 0) from sales where shop_id = s.id and date >= current_date - 30),
         'receipts_30d', (select count(*) from sales where shop_id = s.id and date >= current_date - 30),
         'stock_units', (select coalesce(sum(qty), 0) from stock_levels where shop_id = s.id),
         'labels', (select count(*) from product_items where shop_id = s.id and status = 'in_stock')) order by s.created_at)
       from shops s where s.business_id = p_id), '[]'::json),
    'devices', coalesce((select json_agg(json_build_object('id', d.id, 'name', d.name, 'kind', d.kind, 'status', d.status,
         'shop', (select name from shops where id = d.shop_id), 'last_seen', d.last_seen, 'registered_by', d.registered_by,
         'user_agent', d.user_agent) order by d.created_at desc) from devices d where d.business_id = p_id), '[]'::json),
    'wallet', coalesce((select json_agg(row_to_json(w) order by w.created_at desc) from
         (select * from wallet_transactions where business_id = p_id order by created_at desc limit 100) w), '[]'::json),
    'generations', coalesce((select json_agg(row_to_json(g) order by g.created_at desc) from
         (select g.*, (select name from products where id = g.product_id) as product_name,
                 (select count(*) from product_items i where i.generation_id = g.id and i.status = 'in_stock') as unsold
            from qr_generations g where business_id = p_id order by created_at desc limit 100) g), '[]'::json),
    'sales_by_day', coalesce((select json_agg(x order by x.date) from (select date, count(*) as receipts, sum(total - refunded_amount) as total
         from sales where business_id = p_id and date >= current_date - 29 group by date) x), '[]'::json),
    'activity', coalesce((select json_agg(a order by a.created_at desc) from
         (select type, description, by_name, created_at from activity_log where business_id = p_id order by created_at desc limit 50) a), '[]'::json));
end $$;

create or replace function public.dq_admin_save_settings(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare em text;
begin
  perform dq_require_admin();
  select email into em from auth.users where id = auth.uid();
  if coalesce((p->>'qr_fee')::numeric, 0) < 0 then raise exception 'Fee must be zero or more'; end if;
  update platform_settings set
    qr_fee = coalesce((p->>'qr_fee')::numeric, qr_fee),
    currency = coalesce(nullif(trim(p->>'currency'),''), currency),
    min_topup = greatest(coalesce((p->>'min_topup')::numeric, min_topup), 0),
    welcome_credit = greatest(coalesce((p->>'welcome_credit')::numeric, welcome_credit), 0),
    allow_negative_balance = coalesce((p->>'allow_negative_balance')::boolean, allow_negative_balance),
    payment_instructions = coalesce(p->>'payment_instructions', payment_instructions),
    payment_accounts = coalesce(p->'payment_accounts', payment_accounts),
    free_qr_monthly = greatest(coalesce((p->>'free_qr_monthly')::int, free_qr_monthly), 0),
    referral_bonus = greatest(coalesce((p->>'referral_bonus')::numeric, referral_bonus), 0),
    referee_bonus = greatest(coalesce((p->>'referee_bonus')::numeric, referee_bonus), 0),
    bonus_expiry_days = greatest(coalesce((p->>'bonus_expiry_days')::int, bonus_expiry_days), 1),
    support_phone = coalesce(p->>'support_phone', support_phone),
    support_email = coalesce(p->>'support_email', support_email),
    low_balance_threshold = greatest(coalesce((p->>'low_balance_threshold')::numeric, low_balance_threshold), 0),
    updated_at = now(), updated_by = em
  where id = 1;
  perform dq_audit('settings.update', 'platform', '1', p);
  return (select row_to_json(s) from platform_settings s where id = 1);
end $$;

-- v1 signature kept
create or replace function public.dq_admin_update_settings(p_fee numeric, p_currency text, p_min_topup numeric,
  p_welcome_credit numeric, p_allow_negative boolean, p_instructions text) returns json
language sql security definer set search_path = public as $$
  select dq_admin_save_settings(jsonb_build_object('qr_fee', p_fee, 'currency', p_currency, 'min_topup', p_min_topup,
    'welcome_credit', p_welcome_credit, 'allow_negative_balance', p_allow_negative, 'payment_instructions', p_instructions))
$$;

create or replace function public.dq_admin_adjust_wallet(p_business uuid, p_amount numeric, p_note text, p_type text default 'adjustment')
returns numeric language plpgsql security definer set search_path = public as $$
declare r jsonb; em text;
begin
  perform dq_require_admin();
  if p_amount is null or p_amount = 0 then raise exception 'Amount cannot be zero'; end if;
  if p_type not in ('topup','adjustment','refund') then raise exception 'Invalid type'; end if;
  if nullif(trim(p_note),'') is null then raise exception 'Add a note explaining the adjustment'; end if;
  select email into em from auth.users where id = auth.uid();
  r := dq_credit(p_business, p_type, p_amount, 0, null, p_note, 'DeepQr: ' || em);
  perform dq_audit('wallet.adjust', 'business', p_business::text, jsonb_build_object('amount', p_amount, 'note', p_note, 'type', p_type));
  return (r->>'balance')::numeric;
end $$;

create or replace function public.dq_admin_grant_bonus(p_business uuid, p_amount numeric, p_note text) returns json
language plpgsql security definer set search_path = public as $$
declare r jsonb; em text;
begin
  perform dq_require_admin();
  if p_amount is null or p_amount = 0 then raise exception 'Enter the bonus credits'; end if;
  select email into em from auth.users where id = auth.uid();
  r := dq_credit(p_business, 'bonus', 0, p_amount, null, coalesce(nullif(trim(p_note),''), 'Bonus from DeepQr'), 'DeepQr: ' || em);
  perform dq_audit('wallet.bonus', 'business', p_business::text, jsonb_build_object('amount', p_amount, 'note', p_note));
  return r::json;
end $$;

create or replace function public.dq_admin_bulk_bonus(p_amount numeric, p_note text, p_only_active boolean default true) returns integer
language plpgsql security definer set search_path = public as $$
declare b record; n int := 0; em text;
begin
  perform dq_require_admin();
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the bonus credits'; end if;
  select email into em from auth.users where id = auth.uid();
  for b in select a.business_id from dq_accounts a where not p_only_active or a.status = 'active' loop
    perform dq_credit(b.business_id, 'bonus', 0, p_amount, null, coalesce(nullif(trim(p_note),''), 'Bonus from DeepQr'), 'DeepQr: ' || em);
    n := n + 1;
  end loop;
  perform dq_audit('wallet.bulk_bonus', 'platform', null, jsonb_build_object('amount', p_amount, 'note', p_note, 'businesses', n));
  return n;
end $$;

create or replace function public.dq_admin_review_topup(p_id uuid, p_approve boolean, p_note text default null) returns json
language plpgsql security definer set search_path = public as $$
declare r topup_requests; em text; st platform_settings; acc dq_accounts; n int;
begin
  perform dq_require_admin();
  select * into st from platform_settings where id = 1;
  select email into em from auth.users where id = auth.uid();
  select * into r from topup_requests where id = p_id for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'pending' then raise exception 'Request already %', r.status; end if;
  if not p_approve and nullif(trim(p_note),'') is null then raise exception 'Give a reason for rejecting'; end if;
  if p_approve then
    select count(*) + 1 into n from topup_requests where status = 'approved';
    perform dq_credit(r.business_id, 'topup', r.amount, r.bonus, r.reference,
                      'Top-up via ' || r.method || case when r.bonus > 0 then ' (+' || r.bonus || ' bonus)' else '' end, 'DeepQr: ' || em);
    update topup_requests set credited = amount + bonus, receipt_no = 'TU-' || to_char(now(), 'YYMMDD') || '-' || lpad(n::text, 4, '0')
     where id = r.id;
    -- referral reward on the referred business's first approved top-up
    select * into acc from dq_accounts where business_id = r.business_id for update;
    if acc.referred_by is not null and not acc.referral_paid and st.referral_bonus > 0 then
      perform dq_credit(acc.referred_by, 'referral', 0, st.referral_bonus, acc.referral_code,
                        'Referral reward: ' || (select name from businesses where id = r.business_id) || ' joined', 'DeepQr');
      update dq_accounts set referral_paid = true where business_id = r.business_id;
    end if;
  end if;
  update topup_requests set status = case when p_approve then 'approved' else 'rejected' end,
    review_note = p_note, reviewed_by = em, reviewed_at = now() where id = p_id returning * into r;
  perform dq_audit(case when p_approve then 'topup.approve' else 'topup.reject' end, 'topup', p_id::text,
                   jsonb_build_object('amount', r.amount, 'bonus', r.bonus, 'reference', r.reference, 'note', p_note));
  return row_to_json(r);
end $$;

create or replace function public.dq_admin_update_account(p_business uuid, p jsonb) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  insert into dq_accounts(business_id) values (p_business) on conflict do nothing;
  update dq_accounts set
    fee_override = case when p ? 'fee_override' then nullif(p->>'fee_override','')::numeric else fee_override end,
    free_qr_monthly = case when p ? 'free_qr_monthly' then nullif(p->>'free_qr_monthly','')::int else free_qr_monthly end,
    credit_limit = case when p ? 'credit_limit' then greatest(coalesce(nullif(p->>'credit_limit','')::numeric, 0), 0) else credit_limit end,
    plan = coalesce(nullif(p->>'plan',''), plan),
    admin_notes = case when p ? 'admin_notes' then p->>'admin_notes' else admin_notes end,
    updated_at = now()
  where business_id = p_business;
  perform dq_audit('account.update', 'business', p_business::text, p);
  return (select row_to_json(a) from dq_accounts a where a.business_id = p_business);
end $$;

create or replace function public.dq_admin_set_status(p_business uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  if p_status not in ('active','suspended') then raise exception 'Invalid status'; end if;
  insert into dq_accounts(business_id) values (p_business) on conflict do nothing;
  update dq_accounts set status = p_status, status_note = p_note, updated_at = now() where business_id = p_business;
  perform dq_audit('business.' || p_status, 'business', p_business::text, jsonb_build_object('note', p_note));
end $$;

create or replace function public.dq_admin_set_member(p_member_id uuid, p_blocked boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  perform dq_trust();
  update members set blocked_by_platform = p_blocked, blocked_reason = case when p_blocked then p_reason end where id = p_member_id;
  if not found then raise exception 'User not found'; end if;
  perform dq_audit(case when p_blocked then 'user.block' else 'user.unblock' end, 'member', p_member_id::text, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.dq_admin_set_shop(p_shop_id uuid, p_blocked boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  perform dq_trust();
  update shops set blocked_by_platform = p_blocked where id = p_shop_id;
  if not found then raise exception 'Shop not found'; end if;
  perform dq_audit(case when p_blocked then 'shop.block' else 'shop.unblock' end, 'shop', p_shop_id::text, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.dq_admin_set_device(p_device_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  if p_status not in ('pending','approved','blocked') then raise exception 'Invalid status'; end if;
  update devices set status = p_status where id = p_device_id;
  if not found then raise exception 'Device not found'; end if;
  perform dq_audit('device.' || p_status, 'device', p_device_id::text, '{}'::jsonb);
end $$;

create or replace function public.dq_admin_refund_generation(p_generation_id uuid, p_note text default null) returns json
language plpgsql security definer set search_path = public as $$
declare g qr_generations; n int; v_amt numeric; em text; r jsonb;
begin
  perform dq_require_admin();
  select email into em from auth.users where id = auth.uid();
  select * into g from qr_generations where id = p_generation_id for update;
  if g.id is null then raise exception 'Batch not found'; end if;
  update product_items set status = 'void' where generation_id = g.id and status = 'in_stock';
  select count(*) - g.refunded_qty into n from product_items where generation_id = g.id and status = 'void';
  if n <= 0 then raise exception 'Nothing left to refund in this batch (sold labels cannot be refunded)'; end if;
  v_amt := round(n * g.fee_per_qr, 2);
  update qr_generations set refunded_qty = refunded_qty + n where id = g.id;
  r := dq_credit(g.business_id, 'refund', v_amt, 0, g.first_serial || '…' || g.last_serial,
                 'Refund for ' || n || ' unused QR label(s)' || coalesce(': ' || p_note, ''), 'DeepQr: ' || em);
  perform dq_audit('qr.refund', 'generation', g.id::text, jsonb_build_object('labels', n, 'amount', v_amt, 'note', p_note));
  return (json_build_object('labels', n, 'amount', v_amt)::jsonb || r)::json;
end $$;

create or replace function public.dq_admin_save_package(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare k topup_packages;
begin
  perform dq_require_admin();
  if coalesce((p->>'delete')::boolean, false) then
    delete from topup_packages where id = (p->>'id')::uuid;
    perform dq_audit('package.delete', 'package', p->>'id', p);
    return null;
  end if;
  if nullif(trim(p->>'name'),'') is null or coalesce((p->>'amount')::numeric, 0) <= 0 then raise exception 'Enter a name and amount'; end if;
  if nullif(p->>'id','') is null then
    insert into topup_packages(name, amount, bonus, badge, active, sort)
    values (trim(p->>'name'), (p->>'amount')::numeric, coalesce((p->>'bonus')::numeric, 0), nullif(trim(p->>'badge'),''),
            coalesce((p->>'active')::boolean, true), coalesce((p->>'sort')::int, 0)) returning * into k;
  else
    update topup_packages set name = trim(p->>'name'), amount = (p->>'amount')::numeric, bonus = coalesce((p->>'bonus')::numeric, 0),
           badge = nullif(trim(p->>'badge'),''), active = coalesce((p->>'active')::boolean, true), sort = coalesce((p->>'sort')::int, sort)
     where id = (p->>'id')::uuid returning * into k;
  end if;
  perform dq_audit('package.save', 'package', k.id::text, p);
  return row_to_json(k);
end $$;

create or replace function public.dq_admin_save_promo(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare c promo_codes; v_code text := upper(regexp_replace(coalesce(p->>'code',''), '\s', '', 'g')); em text;
begin
  perform dq_require_admin();
  select email into em from auth.users where id = auth.uid();
  if length(v_code) < 4 then raise exception 'Promo code must have at least 4 characters'; end if;
  if coalesce((p->>'delete')::boolean, false) then
    delete from promo_codes where code = v_code; perform dq_audit('promo.delete', 'promo', v_code, p); return null;
  end if;
  if coalesce((p->>'credits')::numeric, 0) <= 0 then raise exception 'Enter the credits the code gives'; end if;
  insert into promo_codes(code, credits, max_uses, expires_at, active, business_id, note, created_by)
  values (v_code, (p->>'credits')::numeric, nullif(p->>'max_uses','')::int, nullif(p->>'expires_at','')::timestamptz,
          coalesce((p->>'active')::boolean, true), nullif(p->>'business_id','')::uuid, nullif(p->>'note',''), em)
  on conflict (code) do update set credits = excluded.credits, max_uses = excluded.max_uses, expires_at = excluded.expires_at,
     active = excluded.active, business_id = excluded.business_id, note = excluded.note
  returning * into c;
  perform dq_audit('promo.save', 'promo', v_code, p);
  return row_to_json(c);
end $$;

create or replace function public.dq_admin_save_announcement(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare a announcements; em text;
begin
  perform dq_require_admin();
  select email into em from auth.users where id = auth.uid();
  if coalesce((p->>'delete')::boolean, false) then
    delete from announcements where id = (p->>'id')::uuid; perform dq_audit('announcement.delete', 'announcement', p->>'id', p); return null;
  end if;
  if nullif(trim(p->>'title'),'') is null then raise exception 'Enter a title'; end if;
  if nullif(p->>'id','') is null then
    insert into announcements(title, body, level, business_id, active, starts_at, ends_at, created_by)
    values (trim(p->>'title'), coalesce(p->>'body',''), coalesce(nullif(p->>'level',''),'info'), nullif(p->>'business_id','')::uuid,
            coalesce((p->>'active')::boolean, true), coalesce(nullif(p->>'starts_at','')::timestamptz, now()),
            nullif(p->>'ends_at','')::timestamptz, em) returning * into a;
  else
    update announcements set title = trim(p->>'title'), body = coalesce(p->>'body',''), level = coalesce(nullif(p->>'level',''),'info'),
           business_id = nullif(p->>'business_id','')::uuid, active = coalesce((p->>'active')::boolean, true),
           starts_at = coalesce(nullif(p->>'starts_at','')::timestamptz, starts_at), ends_at = nullif(p->>'ends_at','')::timestamptz
     where id = (p->>'id')::uuid returning * into a;
  end if;
  perform dq_audit('announcement.save', 'announcement', a.id::text, p);
  return row_to_json(a);
end $$;

-- =============================================================================
-- 17. permissions
-- =============================================================================
revoke all on function public.dq_trust() from public, anon, authenticated;
revoke all on function public.dq_guard_members() from public, anon, authenticated;
revoke all on function public.dq_guard_business_insert() from public, anon, authenticated;
revoke all on function public.dq_guard_money() from public, anon, authenticated;
revoke all on function public.dq_audit(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.dq_require_staff(text[]) from public, anon, authenticated;
revoke all on function public.dq_charge_qr(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.dq_credit(uuid, text, numeric, numeric, text, text, text) from public, anon, authenticated;
revoke all on function public.dq_after_business_insert() from public, anon, authenticated;
revoke all on function public.dq_perms(public.members) from public, anon;
revoke all on function public.dq_effective_fee(uuid) from public, anon;
grant execute on function public.dq_login_email(text) to anon, authenticated;
grant execute on function public.dq_version() to anon, authenticated;

do $$ declare f text; begin
  foreach f in array array[
    'dq_my_status()','dq_is_trusted()','dq_phone(text)','dq_perms(public.members)','dq_effective_fee(uuid)',
    'dq_generate_items(uuid,uuid,integer,date,text)','dq_qr_recommendations()','dq_lookup_item(text,uuid,text)',
    'dq_item_history(text)','dq_void_generation(uuid,text)',
    'dq_wallet()','dq_request_topup2(jsonb)','dq_request_topup(numeric,text,text)','dq_cancel_topup(uuid)',
    'dq_redeem_promo(text)','dq_apply_referral(text)',
    'dq_checkout2(jsonb)','dq_refund2(jsonb)','dq_refund_sale(uuid,text)','dq_customer_payment(jsonb)','dq_adjust_customer(jsonb)',
    'dq_shift_report(uuid)','dq_open_shift(jsonb)','dq_cash_move(jsonb)','dq_close_shift(jsonb)',
    'dq_save_order(jsonb)','dq_set_order_status(uuid,text,text)','dq_receive_order(jsonb)','dq_supplier_payment(jsonb)',
    'dq_send_transfer(jsonb)','dq_receive_transfer(jsonb)','dq_cancel_transfer(uuid)',
    'dq_start_count(jsonb)','dq_count_scan(jsonb)','dq_set_count(jsonb)','dq_apply_count(jsonb)',
    'dq_stock_card(uuid,uuid,integer)','dq_report(jsonb)',
    'dq_admin_overview()','dq_admin_business(uuid)','dq_admin_save_settings(jsonb)',
    'dq_admin_update_settings(numeric,text,numeric,numeric,boolean,text)','dq_admin_adjust_wallet(uuid,numeric,text,text)',
    'dq_admin_grant_bonus(uuid,numeric,text)','dq_admin_bulk_bonus(numeric,text,boolean)','dq_admin_review_topup(uuid,boolean,text)',
    'dq_admin_update_account(uuid,jsonb)','dq_admin_set_status(uuid,text,text)','dq_admin_set_member(uuid,boolean,text)',
    'dq_admin_set_shop(uuid,boolean,text)','dq_admin_set_device(uuid,text)','dq_admin_refund_generation(uuid,text)',
    'dq_admin_save_package(jsonb)','dq_admin_save_promo(jsonb)','dq_admin_save_announcement(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
