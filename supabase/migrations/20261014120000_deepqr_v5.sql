-- =============================================================================
-- DeepQr v5: online shop products with photos, every selling branch online,
-- delivery priced by distance (per km), product showcase for the sign-in page.
-- Run after 20261013120000_deepqr_v4.sql. Safe to run more than once.
-- =============================================================================

create or replace function public.dq_version() returns integer language sql immutable as $$ select 5 $$;

-- ---------------------------------------------------------------------------
-- 1. columns
-- ---------------------------------------------------------------------------
alter table public.products add column if not exists image_url text;
alter table public.products add column if not exists photos jsonb not null default '[]'::jsonb;
alter table public.products add column if not exists online_featured boolean not null default false;

-- every branch can take online orders (warehouses never do); each has its own map location
-- and may override the business's delivery prices
alter table public.shops add column if not exists online boolean not null default true;
alter table public.shops add column if not exists lat double precision;
alter table public.shops add column if not exists lng double precision;
alter table public.shops add column if not exists delivery_base_fee numeric;
alter table public.shops add column if not exists delivery_per_km numeric;
alter table public.shops add column if not exists delivery_max_km numeric;
alter table public.shops drop constraint if exists shops_latlng_check;
alter table public.shops add constraint shops_latlng_check check ((lat is null or lat between -90 and 90) and (lng is null or lng between -180 and 180));

alter table public.businesses add column if not exists store_delivery_mode text not null default 'flat';
alter table public.businesses drop constraint if exists businesses_store_delivery_mode_check;
alter table public.businesses add constraint businesses_store_delivery_mode_check check (store_delivery_mode in ('flat','distance'));
alter table public.businesses add column if not exists store_base_fee numeric not null default 0;     -- distance mode: fee that covers the first km
alter table public.businesses add column if not exists store_base_km numeric not null default 0;      -- km included in the base fee
alter table public.businesses add column if not exists store_per_km numeric not null default 0;       -- each extra km
alter table public.businesses add column if not exists store_max_km numeric not null default 20;      -- 0 = no limit
alter table public.businesses add column if not exists store_fee_round numeric not null default 100;  -- round the fee up to

alter table public.online_orders add column if not exists delivery_lat double precision;
alter table public.online_orders add column if not exists delivery_lng double precision;
alter table public.online_orders add column if not exists delivery_km numeric;

-- a warehouse cannot be the online branch (v4 allowed it, so the shop showed no stock)
update public.businesses set store_shop_id = null
 where store_shop_id in (select id from public.shops where type = 'warehouse');

-- ---------------------------------------------------------------------------
-- 2. product photos: public bucket, each business writes only its own folder p/<business_id>/
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dq-public', 'dq-public', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists dq_public_select on storage.objects;
create policy dq_public_select on storage.objects for select to authenticated
  using (bucket_id = 'dq-public' and (storage.foldername(name))[1] = 'p' and (storage.foldername(name))[2] = public.my_business_id()::text);
drop policy if exists dq_public_insert on storage.objects;
create policy dq_public_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'dq-public' and (storage.foldername(name))[1] = 'p' and (storage.foldername(name))[2] = public.my_business_id()::text
              and public.my_role() in ('owner','manager','inventory'));
drop policy if exists dq_public_update on storage.objects;
create policy dq_public_update on storage.objects for update to authenticated
  using (bucket_id = 'dq-public' and (storage.foldername(name))[1] = 'p' and (storage.foldername(name))[2] = public.my_business_id()::text
         and public.my_role() in ('owner','manager','inventory'));
drop policy if exists dq_public_delete on storage.objects;
create policy dq_public_delete on storage.objects for delete to authenticated
  using (bucket_id = 'dq-public' and (storage.foldername(name))[1] = 'p' and (storage.foldername(name))[2] = public.my_business_id()::text
         and public.my_role() in ('owner','manager','inventory'));

-- ---------------------------------------------------------------------------
-- 3. helpers: distance, branch, delivery fee
-- ---------------------------------------------------------------------------
create or replace function public.dq_km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns numeric language sql immutable as $$
  select (2 * 6371 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
          + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))::numeric
$$;

create or replace function public.dq_branch_online(s public.shops) returns boolean language sql immutable as $$
  select s.id is not null and s.type <> 'warehouse' and s.online and s.active is not false and not coalesce(s.blocked_by_platform, false)
$$;

-- the branch that serves an online order: the one the customer chose, else the default, else the first
create or replace function public.dq_store_branch(b public.businesses, p_shop uuid) returns public.shops
language plpgsql stable security definer set search_path = public as $$
declare s shops;
begin
  if p_shop is not null then
    select * into s from shops where id = p_shop and business_id = b.id;
    if s.id is null or not dq_branch_online(s) then raise exception 'BRANCH: this branch is not taking online orders'; end if;
    return s;
  end if;
  select * into s from shops where id = b.store_shop_id and business_id = b.id;
  if s.id is not null and dq_branch_online(s) then return s; end if;
  select * into s from shops sh where sh.business_id = b.id and dq_branch_online(sh)
   order by (select coalesce(sum(qty), 0) from stock_levels sl where sl.shop_id = sh.id) desc, sh.name limit 1;
  if s.id is null then raise exception 'BRANCH: this shop has no branch taking online orders'; end if;
  return s;
end $$;

-- delivery fee from a branch to a customer point. Road distance is estimated as 1.3 x straight line.
create or replace function public.dq_delivery_calc(b public.businesses, s public.shops, p_lat double precision, p_lng double precision, p_subtotal numeric)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_km numeric; v_fee numeric; v_base numeric; v_per numeric; v_max numeric; v_round numeric := greatest(coalesce(b.store_fee_round, 0), 0);
begin
  if not b.store_delivery then return jsonb_build_object('ok', false, 'reason', 'This shop does not deliver — choose pickup'); end if;
  if p_lat is not null and p_lng is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180) then
    return jsonb_build_object('ok', false, 'reason', 'That location is not valid');
  end if;
  if s.lat is not null and p_lat is not null then v_km := round(dq_km(s.lat, s.lng, p_lat, p_lng) * 1.3, 1); end if;
  if b.store_delivery_mode = 'distance' then
    if s.lat is null then return jsonb_build_object('ok', false, 'reason', s.name || ' has not set its map location yet. Choose pickup or call the shop.'); end if;
    if p_lat is null then return jsonb_build_object('ok', false, 'need_location', true, 'reason', 'Set your delivery location on the map'); end if;
    v_base := coalesce(s.delivery_base_fee, b.store_base_fee, 0);
    v_per := coalesce(s.delivery_per_km, b.store_per_km, 0);
    v_max := coalesce(s.delivery_max_km, b.store_max_km, 0);
    if v_max > 0 and v_km > v_max then
      return jsonb_build_object('ok', false, 'km', v_km, 'max_km', v_max, 'reason', 'You are about ' || v_km || ' km away. ' || s.name || ' delivers up to ' || v_max || ' km.');
    end if;
    v_fee := v_base + greatest(ceil(v_km - coalesce(b.store_base_km, 0)), 0) * v_per;
  else
    v_fee := coalesce(s.delivery_base_fee, b.store_delivery_fee, 0);
  end if;
  if v_round > 0 then v_fee := ceil(v_fee / v_round) * v_round; end if;
  if b.store_free_delivery_over is not null and coalesce(p_subtotal, 0) >= b.store_free_delivery_over then
    return jsonb_build_object('ok', true, 'km', v_km, 'fee', 0, 'free', true, 'full_fee', v_fee, 'mode', b.store_delivery_mode, 'branch', s.name);
  end if;
  return jsonb_build_object('ok', true, 'km', v_km, 'fee', greatest(v_fee, 0), 'free', false, 'mode', b.store_delivery_mode, 'branch', s.name);
end $$;

create or replace function public.dq_delivery_quote(p jsonb) returns json
language plpgsql stable security definer set search_path = public as $$
declare b businesses; s shops;
begin
  select * into b from businesses where store_slug = lower(trim(p->>'slug')) and store_enabled;
  if b.id is null then raise exception 'STORE_NOT_FOUND: this shop is not open online'; end if;
  s := dq_store_branch(b, nullif(p->>'shop_id', '')::uuid);
  return dq_delivery_calc(b, s, nullif(p->>'lat', '')::double precision, nullif(p->>'lng', '')::double precision, nullif(p->>'subtotal', '')::numeric);
end $$;

-- ---------------------------------------------------------------------------
-- 4. public shop pages
-- ---------------------------------------------------------------------------
create or replace function public.dq_store_directory(p jsonb default '{}'::jsonb) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x order by x.products desc, x.name), '[]'::json) from (
    select b.name, b.store_slug as slug, b.store_tagline as tagline, b.store_area as area, b.business_groups as groups,
           b.store_pickup as pickup, b.store_delivery as delivery, b.store_delivery_fee as delivery_fee, b.store_min_order as min_order,
           b.store_delivery_mode as delivery_mode, b.store_base_fee as base_fee, b.store_per_km as per_km,
           b.loyalty_enabled as loyalty, b.currency,
           (select count(*) from products pr where pr.business_id = b.id and pr.active is not false and pr.online and pr.price > 0) as products,
           (select count(*) from shops sh where sh.business_id = b.id and dq_branch_online(sh)) as branches,
           (select array_agg(img) from (select pr.image_url as img from products pr where pr.business_id = b.id and pr.active is not false and pr.online
                and pr.price > 0 and pr.image_url is not null order by pr.online_featured desc, pr.name limit 3) i) as images
      from businesses b
     where b.store_enabled and b.store_slug is not null
       and not exists (select 1 from dq_accounts a where a.business_id = b.id and a.status = 'suspended')
       and (coalesce(p->>'q','') = '' or lower(b.name || ' ' || coalesce(b.store_area,'') || ' ' || coalesce(b.store_tagline,'')
            || ' ' || coalesce((select string_agg(name, ' ') from shops sh where sh.business_id = b.id and dq_branch_online(sh)), '')) like '%' || lower(p->>'q') || '%')
       and (nullif(p->>'group','') is null or (p->>'group') = any(b.business_groups))
     limit 300) x
$$;

drop function if exists public.dq_store_catalog(text);
create or replace function public.dq_store_catalog(p_slug text, p_shop uuid default null) returns json
language plpgsql stable security definer set search_path = public as $$
declare b businesses; ca customer_accounts := my_customer_account(); cu customers; s shops;
begin
  select * into b from businesses where store_slug = lower(trim(p_slug)) and store_enabled;
  if b.id is null then raise exception 'STORE_NOT_FOUND: this shop is not open online'; end if;
  s := dq_store_branch(b, p_shop);
  if ca.id is not null then select * into cu from customers where business_id = b.id and account_id = ca.id; end if;
  return json_build_object(
    'store', json_build_object('name', b.name, 'slug', b.store_slug, 'tagline', b.store_tagline, 'area', b.store_area, 'hours', b.store_hours,
       'phone', nullif(b.phone, ''), 'address', nullif(b.address, ''), 'currency', b.currency, 'groups', b.business_groups,
       'pickup', b.store_pickup, 'delivery', b.store_delivery, 'delivery_fee', b.store_delivery_fee, 'free_delivery_over', b.store_free_delivery_over,
       'delivery_mode', b.store_delivery_mode, 'base_fee', b.store_base_fee, 'base_km', b.store_base_km, 'per_km', b.store_per_km,
       'max_km', b.store_max_km, 'fee_round', b.store_fee_round,
       'min_order', b.store_min_order, 'pay_on_collection', b.store_pay_on_collection, 'payment_accounts', b.store_payment_accounts,
       'loyalty', b.loyalty_enabled, 'points_per_amount', b.points_per_amount, 'point_value', b.point_value, 'min_redeem_points', b.min_redeem_points,
       'first_order_points', b.first_order_points, 'pickup_shop', s.name),
    'branch', s.id,
    'branches', coalesce((select json_agg(json_build_object('id', sh.id, 'name', sh.name, 'address', sh.address, 'phone', sh.phone,
                     'lat', sh.lat, 'lng', sh.lng, 'base_fee', sh.delivery_base_fee, 'per_km', sh.delivery_per_km, 'max_km', sh.delivery_max_km) order by sh.name)
                   from shops sh where sh.business_id = b.id and dq_branch_online(sh)), '[]'::json),
    'me', case when cu.id is null then null else json_build_object('points', cu.points, 'linked', true) end,
    'products', coalesce((select json_agg(x order by x.featured desc, x.category, x.name) from (
      select pr.id, pr.name, pr.code, pr.brand, pr.category, pr.group_code, pr.unit, pr.pack_size, pr.price, pr.description,
             pr.image_url, pr.photos, pr.online_featured as featured,
             coalesce((select qty from stock_levels sl where sl.product_id = pr.id and sl.shop_id = s.id), 0) as stock,
             coalesce((select json_object_agg(sl.shop_id, sl.qty) from stock_levels sl join shops sh on sh.id = sl.shop_id
                        where sl.product_id = pr.id and sl.qty > 0 and dq_branch_online(sh)), '{}'::json) as stock_by
        from products pr where pr.business_id = b.id and pr.active is not false and pr.online and pr.price > 0) x), '[]'::json));
end $$;

-- real products with photos from open shops (shown on the sign-in page)
create or replace function public.dq_store_showcase() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x), '[]'::json) from (
    select pr.name, pr.price, b.currency, pr.image_url, b.name as shop, b.store_slug as slug
      from products pr join businesses b on b.id = pr.business_id
     where b.store_enabled and b.store_slug is not null and pr.active is not false and pr.online and pr.price > 0 and pr.image_url is not null
       and not exists (select 1 from dq_accounts a where a.business_id = b.id and a.status = 'suspended')
     order by pr.online_featured desc, md5(pr.id::text || current_date::text)
     limit 16) x
$$;

-- ---------------------------------------------------------------------------
-- 5. placing an order: chosen branch, stock there, delivery priced by distance
-- ---------------------------------------------------------------------------
create or replace function public.dq_place_online_order(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare ca customer_accounts := my_customer_account(); b businesses; s shops; o online_orders; it jsonb; pr products; cu customers;
        v_sub numeric := 0; v_fee numeric := 0; v_pts int := greatest(coalesce((p->>'points_redeem')::int, 0), 0); v_pval numeric := 0;
        v_total numeric; v_avail numeric; v_method text := coalesce(nullif(trim(p->>'payment_method'), ''), 'Pay on collection');
        v_ref text := upper(nullif(trim(p->>'payment_reference'), '')); n int; v_ful text := coalesce(p->>'fulfilment', 'pickup'); v_reserved int;
        v_lat double precision := nullif(p->>'lat', '')::double precision; v_lng double precision := nullif(p->>'lng', '')::double precision; q jsonb;
begin
  if ca.id is null then raise exception 'CUSTOMER_ACCOUNT: sign in or create a customer account to order'; end if;
  select * into b from businesses where store_slug = lower(trim(p->>'slug')) and store_enabled;
  if b.id is null then raise exception 'STORE_NOT_FOUND: this shop is not taking online orders'; end if;
  if exists (select 1 from dq_accounts a where a.business_id = b.id and a.status = 'suspended') then raise exception 'This shop is not taking orders right now'; end if;
  s := dq_store_branch(b, nullif(p->>'shop_id', '')::uuid);
  if v_ful not in ('pickup','delivery') then raise exception 'Choose pickup or delivery'; end if;
  if v_ful = 'pickup' and not b.store_pickup then raise exception 'This shop only delivers'; end if;
  if v_ful = 'delivery' and not b.store_delivery then raise exception 'This shop does not deliver — choose pickup'; end if;
  if v_ful = 'delivery' and nullif(trim(p->>'delivery_address'), '') is null then raise exception 'Enter the delivery address'; end if;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'Your basket is empty'; end if;
  if jsonb_array_length(p->'items') > 60 then raise exception 'At most 60 different products per order'; end if;
  perform pg_advisory_xact_lock(hashtext('dq_online_' || b.id::text));
  select count(*) + 1 into n from online_orders where business_id = b.id;
  insert into online_orders(business_id, order_no, account_id, shop_id, customer_name, customer_phone, fulfilment, delivery_address,
                            delivery_lat, delivery_lng, payment_method, payment_reference, note, wanted_at, timeline)
  values (b.id, b.code || '-W' || lpad(n::text, 5, '0'), ca.id, s.id, ca.name, ca.phone, v_ful,
          case when v_ful = 'delivery' then trim(p->>'delivery_address') end,
          case when v_ful = 'delivery' then v_lat end, case when v_ful = 'delivery' then v_lng end,
          v_method, v_ref, nullif(trim(p->>'note'), ''),
          nullif(trim(p->>'wanted_at'), ''), jsonb_build_array(jsonb_build_object('status','placed','at',now(),'by',ca.name)))
  returning * into o;
  for it in select * from jsonb_array_elements(p->'items') loop
    select * into pr from products where id = nullif(it->>'product_id','')::uuid and business_id = b.id and active is not false and online and price > 0;
    if pr.id is null then raise exception 'ITEM_UNAVAILABLE: a product in your basket is no longer sold online'; end if;
    if coalesce((it->>'qty')::numeric, 0) <= 0 or (it->>'qty')::numeric > 1000 then raise exception 'Check the quantity of %', pr.name; end if;
    v_avail := coalesce((select qty from stock_levels where product_id = pr.id and shop_id = s.id), 0);
    if (it->>'qty')::numeric > v_avail then
      raise exception 'OUT_OF_STOCK: only % % of % available at %', v_avail, lower(coalesce(pr.unit, 'pcs')), pr.name, s.name;
    end if;
    insert into online_order_items(order_id, business_id, product_id, name, code, unit, qty, price)
    values (o.id, b.id, pr.id, pr.name, pr.code, pr.unit, (it->>'qty')::numeric, pr.price);
    v_sub := v_sub + (it->>'qty')::numeric * pr.price;
  end loop;
  v_sub := round(v_sub, 2);
  if v_sub < b.store_min_order then raise exception 'MIN_ORDER: the minimum order at % is % %', b.name, b.store_min_order, b.currency; end if;
  if v_ful = 'delivery' then
    q := dq_delivery_calc(b, s, v_lat, v_lng, v_sub);
    if not (q->>'ok')::boolean then raise exception 'DELIVERY: %', q->>'reason'; end if;
    v_fee := (q->>'fee')::numeric;
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
  else
    select * into cu from customers where business_id = b.id and account_id = ca.id;
  end if;
  v_total := round(v_sub + v_fee - v_pval, 2);
  if v_method <> 'Pay on collection' and v_total > 0 and (v_ref is null or length(v_ref) < 4) then
    raise exception 'PAYMENT_REF: enter the transaction reference from your % message', v_method;
  end if;
  if v_method = 'Pay on collection' and not b.store_pay_on_collection then raise exception 'This shop needs payment before it prepares your order'; end if;
  if v_ref is not null and exists (select 1 from online_orders where business_id = b.id and upper(payment_reference) = v_ref and id <> o.id and payment_status <> 'rejected') then
    raise exception 'DUPLICATE_REFERENCE: reference % was already used', v_ref;
  end if;
  update online_orders set subtotal = v_sub, delivery_fee = v_fee, delivery_km = case when v_ful = 'delivery' then (q->>'km')::numeric end,
         points_redeem = v_pts, points_value = v_pval, total = v_total, customer_id = cu.id,
         payment_status = case when v_method = 'Pay on collection' or v_total = 0 then 'unpaid' else 'pending_verification' end
   where id = o.id returning * into o;
  insert into activity_log(business_id, type, description, by_name)
  values (b.id, 'online', 'Online order ' || o.order_no || ' from ' || ca.name || ' at ' || s.name || ': ' || v_total || ' ' || b.currency || ' (' || v_ful
          || case when o.delivery_km is not null then ', ' || o.delivery_km || ' km' else '' end || ')', ca.name);
  return row_to_json(o);
end $$;

-- ---------------------------------------------------------------------------
-- 6. shop settings: delivery prices and branches
-- ---------------------------------------------------------------------------
create or replace function public.dq_store_settings(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']); b businesses; v_slug text; br jsonb; sh shops;
begin
  select * into b from businesses where id = m.business_id;
  v_slug := lower(regexp_replace(regexp_replace(coalesce(nullif(trim(p->>'store_slug'), ''), b.store_slug, b.name), '[^A-Za-z0-9]+', '-', 'g'), '(^-|-$)', '', 'g'));
  if length(v_slug) < 3 then raise exception 'The shop link must have at least 3 letters'; end if;
  if exists (select 1 from businesses where store_slug = v_slug and id <> b.id) then raise exception 'STORE_SLUG: the link "%" is taken — try another', v_slug; end if;
  if coalesce((p->>'store_enabled')::boolean, false) and not coalesce((p->>'store_pickup')::boolean, b.store_pickup) and not coalesce((p->>'store_delivery')::boolean, b.store_delivery) then
    raise exception 'Offer pickup, delivery or both';
  end if;
  if nullif(p->>'store_shop_id','') is not null and not exists (select 1 from shops where id = (p->>'store_shop_id')::uuid and business_id = b.id and type <> 'warehouse') then
    raise exception 'Choose one of your selling branches (not a warehouse)'; end if;
  if coalesce(p->>'store_delivery_mode', b.store_delivery_mode) not in ('flat','distance') then raise exception 'Choose a flat fee or a fee by distance'; end if;
  if coalesce(nullif(p->>'store_per_km','')::numeric, 0) < 0 or coalesce(nullif(p->>'store_base_fee','')::numeric, 0) < 0 or coalesce(nullif(p->>'store_max_km','')::numeric, 0) < 0 then
    raise exception 'Delivery prices cannot be negative'; end if;

  -- branches: online on/off, map location, own delivery prices
  if jsonb_typeof(p->'branches') = 'array' then
    for br in select * from jsonb_array_elements(p->'branches') loop
      select * into sh from shops where id = nullif(br->>'id','')::uuid and business_id = b.id;
      if sh.id is null then raise exception 'Unknown branch'; end if;
      if nullif(br->>'lat','') is not null and ((br->>'lat')::double precision not between -90 and 90 or (br->>'lng')::double precision not between -180 and 180) then
        raise exception 'The map location of % is not valid', sh.name; end if;
      if coalesce(nullif(br->>'per_km','')::numeric, 0) < 0 or coalesce(nullif(br->>'base_fee','')::numeric, 0) < 0 or coalesce(nullif(br->>'max_km','')::numeric, 0) < 0 then
        raise exception 'Delivery prices of % cannot be negative', sh.name; end if;
      update shops set online = case when sh.type = 'warehouse' then false else coalesce((br->>'online')::boolean, online) end,
             lat = case when br ? 'lat' then nullif(br->>'lat','')::double precision else lat end,
             lng = case when br ? 'lng' then nullif(br->>'lng','')::double precision else lng end,
             address = case when br ? 'address' then coalesce(nullif(trim(br->>'address'), ''), address) else address end,
             delivery_base_fee = case when br ? 'base_fee' then nullif(br->>'base_fee','')::numeric else delivery_base_fee end,
             delivery_per_km = case when br ? 'per_km' then nullif(br->>'per_km','')::numeric else delivery_per_km end,
             delivery_max_km = case when br ? 'max_km' then nullif(br->>'max_km','')::numeric else delivery_max_km end
       where id = sh.id;
    end loop;
  end if;

  update businesses set store_enabled = coalesce((p->>'store_enabled')::boolean, store_enabled), store_slug = v_slug,
    store_tagline = case when p ? 'store_tagline' then nullif(trim(p->>'store_tagline'), '') else store_tagline end,
    store_shop_id = case when p ? 'store_shop_id' then nullif(p->>'store_shop_id','')::uuid else store_shop_id end,
    store_area = case when p ? 'store_area' then nullif(trim(p->>'store_area'), '') else store_area end,
    store_hours = case when p ? 'store_hours' then nullif(trim(p->>'store_hours'), '') else store_hours end,
    store_pickup = coalesce((p->>'store_pickup')::boolean, store_pickup), store_delivery = coalesce((p->>'store_delivery')::boolean, store_delivery),
    store_delivery_fee = greatest(coalesce(nullif(p->>'store_delivery_fee','')::numeric, store_delivery_fee), 0),
    store_free_delivery_over = case when p ? 'store_free_delivery_over' then nullif(p->>'store_free_delivery_over','')::numeric else store_free_delivery_over end,
    store_min_order = greatest(coalesce(nullif(p->>'store_min_order','')::numeric, store_min_order), 0),
    store_pay_on_collection = coalesce((p->>'store_pay_on_collection')::boolean, store_pay_on_collection),
    store_payment_accounts = coalesce(p->'store_payment_accounts', store_payment_accounts),
    first_order_points = greatest(coalesce(nullif(p->>'first_order_points','')::int, first_order_points), 0),
    store_delivery_mode = coalesce(nullif(p->>'store_delivery_mode',''), store_delivery_mode),
    store_base_fee = coalesce(nullif(p->>'store_base_fee','')::numeric, store_base_fee),
    store_base_km = greatest(coalesce(nullif(p->>'store_base_km','')::numeric, store_base_km), 0),
    store_per_km = coalesce(nullif(p->>'store_per_km','')::numeric, store_per_km),
    store_max_km = coalesce(nullif(p->>'store_max_km','')::numeric, store_max_km),
    store_fee_round = greatest(coalesce(nullif(p->>'store_fee_round','')::numeric, store_fee_round), 0)
  where id = b.id returning * into b;

  if b.store_enabled and not exists (select 1 from shops sh2 where sh2.business_id = b.id and dq_branch_online(sh2)) then
    raise exception 'Turn on online orders for at least one selling branch';
  end if;
  if b.store_enabled and b.store_delivery and b.store_delivery_mode = 'distance'
     and not exists (select 1 from shops sh2 where sh2.business_id = b.id and dq_branch_online(sh2) and sh2.lat is not null) then
    raise exception 'LOCATION: set the map location of at least one branch so DeepQr can measure the delivery distance';
  end if;
  insert into activity_log(business_id, type, description, by_name)
  values (b.id, 'settings', 'Online shop ' || case when b.store_enabled then 'open at /' || b.store_slug else 'closed' end
          || ' · delivery ' || case when b.store_delivery_mode = 'distance' then b.store_base_fee || ' + ' || b.store_per_km || '/km' else 'flat ' || b.store_delivery_fee end, m.name);
  return json_build_object('business', row_to_json(b),
    'branches', (select json_agg(row_to_json(x) order by x.name) from shops x where x.business_id = b.id));
end $$;

-- ---------------------------------------------------------------------------
-- 7. shop products: price, visibility, photos, description in bulk
-- ---------------------------------------------------------------------------
create or replace function public.dq_store_products_save(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager','inventory']); it jsonb; pr products; v_photos jsonb; ph jsonb;
        v_can_price boolean; v_prefix text; n_price int := 0; n int := 0; v_out jsonb := '[]'::jsonb;
begin
  v_can_price := m.role in ('owner','manager') or coalesce((m.permissions->>'can_edit_price')::boolean, false);
  v_prefix := '/storage/v1/object/public/dq-public/p/' || m.business_id::text || '/';
  if jsonb_typeof(p->'items') is distinct from 'array' then raise exception 'Nothing to save'; end if;
  if jsonb_array_length(p->'items') > 500 then raise exception 'Save at most 500 products at once'; end if;
  for it in select * from jsonb_array_elements(p->'items') loop
    select * into pr from products where id = nullif(it->>'id','')::uuid and business_id = m.business_id for update;
    if pr.id is null then raise exception 'Product not found'; end if;
    if it ? 'price' and (it->>'price')::numeric is distinct from pr.price then
      if not v_can_price then raise exception 'PRICE_LOCKED: you are not allowed to change prices'; end if;
      if (it->>'price')::numeric < 0 then raise exception 'The price of % cannot be negative', pr.name; end if;
      n_price := n_price + 1;
    end if;
    v_photos := pr.photos;
    if it ? 'photos' then
      if jsonb_typeof(it->'photos') <> 'array' or jsonb_array_length(it->'photos') > 6 then raise exception 'Up to 6 photos per product'; end if;
      for ph in select * from jsonb_array_elements(it->'photos') loop
        if jsonb_typeof(ph) <> 'string' or position(v_prefix in (ph #>> '{}')) = 0 or (ph #>> '{}') !~ '^https?://' then
          raise exception 'PHOTO: upload photos through DeepQr'; end if;
      end loop;
      v_photos := it->'photos';
    end if;
    update products set
      price = case when it ? 'price' then nullif(it->>'price','')::numeric else price end,
      online = coalesce((it->>'online')::boolean, online),
      online_featured = coalesce((it->>'featured')::boolean, online_featured),
      description = case when it ? 'description' then nullif(left(trim(it->>'description'), 1000), '') else description end,
      photos = v_photos,
      image_url = v_photos->>0
     where id = pr.id returning * into pr;
    n := n + 1;
    v_out := v_out || jsonb_build_object('id', pr.id, 'price', pr.price, 'online', pr.online, 'online_featured', pr.online_featured,
                                         'description', pr.description, 'photos', pr.photos, 'image_url', pr.image_url);
  end loop;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'products', 'Online shop products updated: ' || n || ' product(s)' || case when n_price > 0 then ', ' || n_price || ' price change(s)' else '' end, m.name);
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 8. grants
-- ---------------------------------------------------------------------------
revoke all on function public.dq_store_branch(public.businesses, uuid) from public, anon, authenticated;
revoke all on function public.dq_delivery_calc(public.businesses, public.shops, double precision, double precision, numeric) from public, anon, authenticated;
grant execute on function public.dq_store_catalog(text, uuid) to anon, authenticated;
grant execute on function public.dq_store_directory(jsonb) to anon, authenticated;
grant execute on function public.dq_store_showcase() to anon, authenticated;
grant execute on function public.dq_delivery_quote(jsonb) to anon, authenticated;
do $$ declare f text; begin
  foreach f in array array['dq_place_online_order(jsonb)','dq_store_settings(jsonb)','dq_store_products_save(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
