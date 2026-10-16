-- =============================================================================
-- DeepQr v6: offline sales that sync safely, digital receipts (public link on every
-- receipt), shop logo + cover photo, "was" prices, verified shop reviews,
-- richer customer home. Run after 20261014120000_deepqr_v5.sql. Safe to run twice.
-- =============================================================================

create or replace function public.dq_version() returns integer language sql immutable as $$ select 6 $$;

-- ---------------------------------------------------------------------------
-- 1. columns
-- ---------------------------------------------------------------------------
-- every sale gets a public reference: it is the receipt's link and makes offline uploads idempotent
alter table public.sales add column if not exists public_ref uuid;
update public.sales set public_ref = gen_random_uuid() where public_ref is null;
alter table public.sales alter column public_ref set default gen_random_uuid();
create unique index if not exists sales_public_ref_idx on public.sales(public_ref);
alter table public.sales add column if not exists offline boolean not null default false;
alter table public.sales add column if not exists sold_at timestamptz;    -- when the till recorded it (offline: before upload)
alter table public.sales add column if not exists synced_at timestamptz;  -- when an offline sale reached DeepQr

alter table public.businesses add column if not exists logo_url text;
alter table public.businesses add column if not exists store_cover_url text;
alter table public.products add column if not exists compare_at_price numeric;

-- ---------------------------------------------------------------------------
-- 2. offline sales: idempotent upload, conflicts kept for the manager
-- ---------------------------------------------------------------------------
create table if not exists public.offline_conflicts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  shop_id uuid references public.shops(id) on delete set null,
  member_id uuid references public.members(id) on delete set null,
  member_name text,
  client_ref uuid not null unique,
  payload jsonb not null,
  error text not null,
  total numeric,
  sold_at timestamptz,
  status text not null default 'open' check (status in ('open','resolved','discarded')),
  resolution text, resolved_by text, resolved_at timestamptz,
  sale_id uuid references public.sales(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists offline_conflicts_biz_idx on public.offline_conflicts(business_id, status, created_at desc);
alter table public.offline_conflicts enable row level security;
drop policy if exists offline_conflicts_read on public.offline_conflicts;
create policy offline_conflicts_read on public.offline_conflicts for select to authenticated using (business_id = public.my_business_id());
grant select on public.offline_conflicts to authenticated;

create or replace function public.dq_sale_bundle(p_sale uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('sale', (select to_jsonb(s) from sales s where s.id = p_sale),
    'lines', coalesce((select jsonb_agg(to_jsonb(l)) from sale_lines l where l.sale_id = p_sale), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(x)) from sale_payments x where x.sale_id = p_sale), '[]'::jsonb))
$$;

-- The till calls this for every sale. client_ref (a uuid made on the device) becomes the sale's
-- public_ref: sending the same sale twice returns the first one. With offline=true a failure
-- (label sold meanwhile, stock gone…) does not lose the sale: it is kept as a conflict.
create or replace function public.dq_checkout4(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_me(); v_ref uuid := coalesce(nullif(p->>'client_ref','')::uuid, gen_random_uuid());
        v_off boolean := coalesce((p->>'offline')::boolean, false); s sales; r json; v_err text; v_at timestamptz;
begin
  if m.id is null then raise exception 'Not signed in to a business (or your account is disabled)'; end if;
  begin v_at := nullif(p->>'sold_at','')::timestamptz; exception when others then v_at := null; end;
  if v_at is not null and (v_at > now() + interval '10 minutes' or v_at < now() - interval '60 days') then v_at := null; end if;
  select * into s from sales where public_ref = v_ref;
  if s.id is not null then
    if s.business_id <> m.business_id then raise exception 'This sale reference belongs to another business'; end if;
    return (dq_sale_bundle(s.id) || jsonb_build_object('duplicate', true))::json;
  end if;
  if exists (select 1 from offline_conflicts where client_ref = v_ref and business_id = m.business_id) then
    return json_build_object('conflict', true, 'error', (select error from offline_conflicts where client_ref = v_ref));
  end if;
  if v_off then
    if nullif(p->>'online_order_id','') is not null then raise exception 'Online orders are completed online only'; end if;
    begin
      r := dq_checkout2(p);
    exception when others then
      v_err := sqlerrm;
      insert into offline_conflicts(business_id, shop_id, member_id, member_name, client_ref, payload, error, total, sold_at)
      values (m.business_id, nullif(p->>'shop_id','')::uuid, m.id, m.name, v_ref, p, v_err, nullif(p->>'total','')::numeric, v_at)
      on conflict (client_ref) do nothing;
      insert into activity_log(business_id, type, description, by_name)
      values (m.business_id, 'offline', 'Offline sale could not be recorded: ' || regexp_replace(v_err, '^[A-Z_]+:\s*', ''), m.name);
      return json_build_object('conflict', true, 'error', v_err);
    end;
  else
    r := case when nullif(p->>'online_order_id','') is not null then dq_checkout3(p) else dq_checkout2(p) end;
  end if;
  perform dq_trust();
  update sales set public_ref = v_ref, offline = v_off, sold_at = coalesce(v_at, now()), synced_at = case when v_off then now() end
   where id = (r->'sale'->>'id')::uuid returning * into s;
  return (r::jsonb || jsonb_build_object('sale', to_jsonb(s)))::json;
end $$;

-- manager decides what to do with an offline sale that could not be recorded
create or replace function public.dq_resolve_offline_conflict(p_id uuid, p_action text, p_note text default null) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']); c offline_conflicts; v_p jsonb; ln jsonb; v_lines jsonb := '[]'::jsonb;
        it product_items; r json; v_sale uuid;
begin
  select * into c from offline_conflicts where id = p_id and business_id = m.business_id for update;
  if c.id is null then raise exception 'Not found'; end if;
  if c.status <> 'open' then raise exception 'This offline sale was already handled'; end if;
  if p_action = 'discard' then
    if nullif(trim(p_note), '') is null then raise exception 'Say why the sale is discarded (e.g. customer returned the goods)'; end if;
    update offline_conflicts set status = 'discarded', resolution = trim(p_note), resolved_by = m.name, resolved_at = now() where id = c.id returning * into c;
  elsif p_action = 'retry' then
    -- labels that are no longer in stock are sold as plain quantity from the shop's stock
    for ln in select * from jsonb_array_elements(c.payload->'lines') loop
      if nullif(ln->>'item_id','') is not null then
        select * into it from product_items where id = (ln->>'item_id')::uuid and business_id = m.business_id;
        if it.id is null or it.status <> 'in_stock' then
          ln := jsonb_build_object('product_id', it.product_id, 'qty', 1, 'price', ln->'price');
        end if;
      end if;
      v_lines := v_lines || ln;
    end loop;
    v_p := (c.payload - 'shift_id' - 'points_redeem' - 'offline') || jsonb_build_object('lines', v_lines);
    r := dq_checkout2(v_p);
    v_sale := (r->'sale'->>'id')::uuid;
    perform dq_trust();
    update sales set public_ref = c.client_ref, offline = true, sold_at = coalesce(c.sold_at, created_at), synced_at = now(),
           cashier_name = coalesce(c.member_name, cashier_name),
           note = concat_ws(' · ', nullif(note, ''), 'Offline sale recorded by ' || m.name || coalesce(': ' || nullif(trim(p_note), ''), ''))
     where id = v_sale;
    update offline_conflicts set status = 'resolved', sale_id = v_sale, resolution = coalesce(nullif(trim(p_note), ''), 'Recorded'), resolved_by = m.name, resolved_at = now()
     where id = c.id returning * into c;
  else
    raise exception 'Choose record or discard';
  end if;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'offline', 'Offline sale ' || case when c.status = 'resolved' then 'recorded' else 'discarded' end || ' (' || coalesce(c.total::text, '?') || ')', m.name);
  return row_to_json(c);
end $$;

-- ---------------------------------------------------------------------------
-- 3. digital receipt: anyone with the receipt link can see it (proof of purchase)
-- ---------------------------------------------------------------------------
create or replace function public.dq_public_receipt(p_ref uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare s sales; b businesses;
begin
  select * into s from sales where public_ref = p_ref;
  if s.id is null then return json_build_object('found', false); end if;
  select * into b from businesses where id = s.business_id;
  return json_build_object('found', true,
    'business', json_build_object('name', b.name, 'code', b.code, 'logo', b.logo_url, 'phone', nullif(b.phone, ''), 'address', nullif(b.address, ''),
                                  'tin', nullif(b.tin, ''), 'footer', b.receipt_footer, 'slug', case when b.store_enabled then b.store_slug end, 'currency', b.currency),
    'shop', (select name from shops where id = s.shop_id),
    'sale', json_build_object('receipt', s.receipt, 'date', s.date, 'time', s.time, 'subtotal', s.subtotal, 'tax', s.tax, 'discount', s.discount,
                              'points_value', s.points_value, 'points_earned', s.points_earned, 'delivery_fee', s.delivery_fee, 'total', s.total,
                              'paid', s.paid_total, 'balance_due', s.balance_due, 'refunded', s.refunded_amount, 'status', s.status,
                              'cashier', split_part(coalesce(s.cashier_name, ''), ' ', 1), 'customer', nullif(split_part(coalesce(s.customer, ''), ' ', 1), 'Walk-in'),
                              'offline', s.offline, 'sold_at', coalesce(s.sold_at, s.created_at)),
    'lines', coalesce((select json_agg(json_build_object('name', l.name, 'qty', l.qty, 'price', l.price, 'serial', l.serial, 'refunded', l.refunded_qty,
                        'image', (select image_url from products pr where pr.id = l.product_id)) order by l.name) from sale_lines l where l.sale_id = s.id), '[]'::json),
    'payments', coalesce((select json_agg(json_build_object('method', x.method, 'amount', x.amount, 'kind', x.kind)) from sale_payments x where x.sale_id = s.id), '[]'::json));
end $$;

-- ---------------------------------------------------------------------------
-- 4. shop logo and cover photo
-- ---------------------------------------------------------------------------
create or replace function public.dq_store_branding(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']); b businesses; v_prefix text; k text;
begin
  v_prefix := '/storage/v1/object/public/dq-public/p/' || m.business_id::text || '/';
  foreach k in array array['logo_url','store_cover_url'] loop
    if nullif(p->>k, '') is not null and (position(v_prefix in p->>k) = 0 or (p->>k) !~ '^https?://') then
      raise exception 'PHOTO: upload the picture through DeepQr'; end if;
  end loop;
  update businesses set logo_url = case when p ? 'logo_url' then nullif(p->>'logo_url', '') else logo_url end,
         store_cover_url = case when p ? 'store_cover_url' then nullif(p->>'store_cover_url', '') else store_cover_url end
   where id = m.business_id returning * into b;
  insert into activity_log(business_id, type, description, by_name) values (b.id, 'settings', 'Shop logo / cover photo updated', m.name);
  return json_build_object('logo_url', b.logo_url, 'store_cover_url', b.store_cover_url);
end $$;

-- ---------------------------------------------------------------------------
-- 5. reviews: only customers whose online order was completed can rate the shop
-- ---------------------------------------------------------------------------
create table if not exists public.store_reviews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_id uuid not null unique references public.online_orders(id) on delete cascade,
  account_id uuid not null references public.customer_accounts(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text,
  reply text, replied_by text, replied_at timestamptz,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists store_reviews_biz_idx on public.store_reviews(business_id, created_at desc);
alter table public.store_reviews enable row level security;
drop policy if exists store_reviews_read on public.store_reviews;
create policy store_reviews_read on public.store_reviews for select to authenticated
  using (business_id = public.my_business_id() or account_id = (select id from public.customer_accounts where auth_user_id = auth.uid()) or public.dq_is_platform_admin());
grant select on public.store_reviews to authenticated;

create or replace function public.dq_review_order(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare ca customer_accounts := my_customer_account(); o online_orders; r store_reviews; v_rating int := nullif(p->>'rating','')::int;
begin
  if ca.id is null then raise exception 'Sign in to review'; end if;
  select * into o from online_orders where id = nullif(p->>'order_id','')::uuid and account_id = ca.id;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status <> 'completed' then raise exception 'You can review the shop after your order is completed'; end if;
  if v_rating is null or v_rating not between 1 and 5 then raise exception 'Choose 1 to 5 stars'; end if;
  insert into store_reviews(business_id, order_id, account_id, rating, comment)
  values (o.business_id, o.id, ca.id, v_rating, nullif(left(trim(p->>'comment'), 600), ''))
  on conflict (order_id) do update set rating = excluded.rating, comment = excluded.comment, updated_at = now()
  returning * into r;
  return row_to_json(r);
end $$;

create or replace function public.dq_review_reply(p_id uuid, p_reply text, p_hidden boolean default null) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']); r store_reviews;
begin
  update store_reviews set reply = case when p_reply is null then reply else nullif(left(trim(p_reply), 600), '') end,
         replied_by = case when p_reply is null then replied_by else m.name end, replied_at = case when p_reply is null then replied_at else now() end,
         hidden = coalesce(p_hidden, hidden)
   where id = p_id and business_id = m.business_id returning * into r;
  if r.id is null then raise exception 'Review not found'; end if;
  return row_to_json(r);
end $$;

create or replace function public.dq_store_rating(p_business uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('avg', round(avg(rating)::numeric, 1), 'count', count(*),
         'stars', json_build_object('5', count(*) filter (where rating = 5), '4', count(*) filter (where rating = 4), '3', count(*) filter (where rating = 3),
                                    '2', count(*) filter (where rating = 2), '1', count(*) filter (where rating = 1)))
    from store_reviews where business_id = p_business and not hidden
$$;

-- ---------------------------------------------------------------------------
-- 6. public shop pages with logo, cover, rating, reviews and "was" prices
-- ---------------------------------------------------------------------------
create or replace function public.dq_store_directory(p jsonb default '{}'::jsonb) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x order by x.products desc, x.name), '[]'::json) from (
    select b.name, b.store_slug as slug, b.store_tagline as tagline, b.store_area as area, b.business_groups as groups,
           b.store_pickup as pickup, b.store_delivery as delivery, b.store_delivery_fee as delivery_fee, b.store_min_order as min_order,
           b.store_delivery_mode as delivery_mode, b.store_base_fee as base_fee, b.store_per_km as per_km,
           b.loyalty_enabled as loyalty, b.currency, b.logo_url as logo, b.store_cover_url as cover,
           (select count(*) from products pr where pr.business_id = b.id and pr.active is not false and pr.online and pr.price > 0) as products,
           (select count(*) from shops sh where sh.business_id = b.id and dq_branch_online(sh)) as branches,
           (select array_agg(img) from (select pr.image_url as img from products pr where pr.business_id = b.id and pr.active is not false and pr.online
                and pr.price > 0 and pr.image_url is not null order by pr.online_featured desc, pr.name limit 3) i) as images,
           dq_store_rating(b.id) as rating,
           (select count(*) from products pr where pr.business_id = b.id and pr.active is not false and pr.online and pr.price > 0 and pr.compare_at_price > pr.price) as deals
      from businesses b
     where b.store_enabled and b.store_slug is not null
       and not exists (select 1 from dq_accounts a where a.business_id = b.id and a.status = 'suspended')
       and (coalesce(p->>'q','') = '' or lower(b.name || ' ' || coalesce(b.store_area,'') || ' ' || coalesce(b.store_tagline,'')
            || ' ' || coalesce((select string_agg(name, ' ') from shops sh where sh.business_id = b.id and dq_branch_online(sh)), '')
            || ' ' || coalesce((select string_agg(pr.name, ' ') from products pr where pr.business_id = b.id and pr.active is not false and pr.online and pr.price > 0), ''))
            like '%' || lower(p->>'q') || '%')
       and (nullif(p->>'group','') is null or (p->>'group') = any(b.business_groups))
     limit 300) x
$$;

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
       'logo', b.logo_url, 'cover', b.store_cover_url,
       'pickup', b.store_pickup, 'delivery', b.store_delivery, 'delivery_fee', b.store_delivery_fee, 'free_delivery_over', b.store_free_delivery_over,
       'delivery_mode', b.store_delivery_mode, 'base_fee', b.store_base_fee, 'base_km', b.store_base_km, 'per_km', b.store_per_km,
       'max_km', b.store_max_km, 'fee_round', b.store_fee_round,
       'min_order', b.store_min_order, 'pay_on_collection', b.store_pay_on_collection, 'payment_accounts', b.store_payment_accounts,
       'loyalty', b.loyalty_enabled, 'points_per_amount', b.points_per_amount, 'point_value', b.point_value, 'min_redeem_points', b.min_redeem_points,
       'first_order_points', b.first_order_points, 'pickup_shop', s.name),
    'rating', dq_store_rating(b.id),
    'reviews', coalesce((select json_agg(json_build_object('rating', r.rating, 'comment', r.comment, 'reply', r.reply, 'created_at', r.created_at,
                    'name', split_part(a.name, ' ', 1)) order by r.created_at desc)
                  from (select * from store_reviews where business_id = b.id and not hidden order by created_at desc limit 12) r
                  join customer_accounts a on a.id = r.account_id), '[]'::json),
    'branch', s.id,
    'branches', coalesce((select json_agg(json_build_object('id', sh.id, 'name', sh.name, 'address', sh.address, 'phone', sh.phone,
                     'lat', sh.lat, 'lng', sh.lng, 'base_fee', sh.delivery_base_fee, 'per_km', sh.delivery_per_km, 'max_km', sh.delivery_max_km) order by sh.name)
                   from shops sh where sh.business_id = b.id and dq_branch_online(sh)), '[]'::json),
    'me', case when cu.id is null then null else json_build_object('points', cu.points, 'linked', true) end,
    'products', coalesce((select json_agg(x order by x.featured desc, x.category, x.name) from (
      select pr.id, pr.name, pr.code, pr.brand, pr.category, pr.group_code, pr.unit, pr.pack_size, pr.price, pr.description,
             pr.image_url, pr.photos, pr.online_featured as featured,
             case when pr.compare_at_price > pr.price then pr.compare_at_price end as was,
             coalesce((select qty from stock_levels sl where sl.product_id = pr.id and sl.shop_id = s.id), 0) as stock,
             coalesce((select json_object_agg(sl.shop_id, sl.qty) from stock_levels sl join shops sh on sh.id = sl.shop_id
                        where sl.product_id = pr.id and sl.qty > 0 and dq_branch_online(sh)), '{}'::json) as stock_by,
             (select coalesce(sum(i.qty), 0) from online_order_items i join online_orders o on o.id = i.order_id
               where i.product_id = pr.id and o.status = 'completed' and o.created_at > now() - interval '30 days') as sold_30d
        from products pr where pr.business_id = b.id and pr.active is not false and pr.online and pr.price > 0) x), '[]'::json));
end $$;

create or replace function public.dq_store_showcase() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x), '[]'::json) from (
    select pr.name, pr.price, case when pr.compare_at_price > pr.price then pr.compare_at_price end as was, b.currency, pr.image_url,
           b.name as shop, b.store_slug as slug, b.logo_url as logo
      from products pr join businesses b on b.id = pr.business_id
     where b.store_enabled and b.store_slug is not null and pr.active is not false and pr.online and pr.price > 0 and pr.image_url is not null
       and not exists (select 1 from dq_accounts a where a.business_id = b.id and a.status = 'suspended')
     order by pr.online_featured desc, md5(pr.id::text || current_date::text)
     limit 16) x
$$;

-- shop products: price, "was" price, visibility, photos, description
create or replace function public.dq_store_products_save(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager','inventory']); it jsonb; pr products; v_photos jsonb; ph jsonb;
        v_can_price boolean; v_prefix text; n_price int := 0; n int := 0; v_out jsonb := '[]'::jsonb; v_price numeric; v_was numeric;
begin
  v_can_price := m.role in ('owner','manager') or coalesce((m.permissions->>'can_edit_price')::boolean, false);
  v_prefix := '/storage/v1/object/public/dq-public/p/' || m.business_id::text || '/';
  if jsonb_typeof(p->'items') is distinct from 'array' then raise exception 'Nothing to save'; end if;
  if jsonb_array_length(p->'items') > 500 then raise exception 'Save at most 500 products at once'; end if;
  for it in select * from jsonb_array_elements(p->'items') loop
    select * into pr from products where id = nullif(it->>'id','')::uuid and business_id = m.business_id for update;
    if pr.id is null then raise exception 'Product not found'; end if;
    v_price := case when it ? 'price' then nullif(it->>'price','')::numeric else pr.price end;
    v_was := case when it ? 'compare_at' then nullif(it->>'compare_at','')::numeric else pr.compare_at_price end;
    if v_price is distinct from pr.price or v_was is distinct from pr.compare_at_price then
      if not v_can_price then raise exception 'PRICE_LOCKED: you are not allowed to change prices'; end if;
      if v_price < 0 then raise exception 'The price of % cannot be negative', pr.name; end if;
      if v_was is not null and v_was <= coalesce(v_price, 0) then raise exception 'WAS_PRICE: the "was" price of % must be higher than the price', pr.name; end if;
      if v_price is distinct from pr.price then n_price := n_price + 1; end if;
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
    update products set price = v_price, compare_at_price = v_was,
      online = coalesce((it->>'online')::boolean, online),
      online_featured = coalesce((it->>'featured')::boolean, online_featured),
      description = case when it ? 'description' then nullif(left(trim(it->>'description'), 1000), '') else description end,
      photos = v_photos, image_url = v_photos->>0
     where id = pr.id returning * into pr;
    n := n + 1;
    v_out := v_out || jsonb_build_object('id', pr.id, 'price', pr.price, 'compare_at_price', pr.compare_at_price, 'online', pr.online,
                                         'online_featured', pr.online_featured, 'description', pr.description, 'photos', pr.photos, 'image_url', pr.image_url);
  end loop;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'products', 'Online shop products updated: ' || n || ' product(s)' || case when n_price > 0 then ', ' || n_price || ' price change(s)' else '' end, m.name);
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 7. customer home: photos, receipt links, reviews, shop logos
-- ---------------------------------------------------------------------------
create or replace function public.dq_customer_home() returns json
language plpgsql stable security definer set search_path = public as $$
declare ca customer_accounts := my_customer_account();
begin
  if ca.id is null then raise exception 'Customer account not found'; end if;
  return json_build_object('account', row_to_json(ca),
    'loyalty', coalesce((select json_agg(json_build_object('business', b.name, 'slug', case when b.store_enabled then b.store_slug end, 'points', c.points,
                 'worth', round(c.points * b.point_value, 2), 'currency', b.currency, 'min_redeem', b.min_redeem_points, 'owes', c.balance,
                 'visits', c.visits, 'last_visit', c.last_visit, 'logo', b.logo_url) order by c.points desc)
       from customers c join businesses b on b.id = c.business_id where c.account_id = ca.id), '[]'::json),
    'orders', coalesce((select json_agg(x order by x.created_at desc) from (
       select o.*, b.name as business_name, b.store_slug as slug, b.phone as business_phone, b.currency, b.logo_url as business_logo,
              (select name from shops where id = o.shop_id) as branch_name,
              (select public_ref from sales where id = o.sale_id) as receipt_ref,
              (select json_build_object('rating', r.rating, 'comment', r.comment, 'reply', r.reply) from store_reviews r where r.order_id = o.id) as review,
              (select json_agg(json_build_object('product_id', i.product_id, 'name', i.name, 'qty', i.qty, 'price', i.price,
                        'image', (select image_url from products pr where pr.id = i.product_id))) from online_order_items i where i.order_id = o.id) as items
         from online_orders o join businesses b on b.id = o.business_id where o.account_id = ca.id order by o.created_at desc limit 100) x), '[]'::json),
    'receipts', coalesce((select json_agg(x order by x.created_at desc) from (
       select s.public_ref as ref, s.receipt, s.date, s.total, s.created_at, b.name as business, b.currency, b.logo_url as logo
         from sales s join customers c on c.id = s.customer_id join businesses b on b.id = s.business_id
        where c.account_id = ca.id order by s.created_at desc limit 60) x), '[]'::json),
    'history', coalesce((select json_agg(x order by x.created_at desc) from (
       select l.created_at, l.type, l.points, l.amount, l.note, b.name as business
         from customer_ledger l join customers c on c.id = l.customer_id join businesses b on b.id = c.business_id
        where c.account_id = ca.id order by l.created_at desc limit 100) x), '[]'::json));
end $$;

-- ---------------------------------------------------------------------------
-- 8. grants
-- ---------------------------------------------------------------------------
revoke all on function public.dq_sale_bundle(uuid) from public, anon, authenticated;
grant execute on function public.dq_public_receipt(uuid) to anon, authenticated;
grant execute on function public.dq_store_rating(uuid) to anon, authenticated;
grant execute on function public.dq_store_catalog(text, uuid) to anon, authenticated;
grant execute on function public.dq_store_directory(jsonb) to anon, authenticated;
grant execute on function public.dq_store_showcase() to anon, authenticated;
do $$ declare f text; begin
  foreach f in array array['dq_checkout4(jsonb)','dq_resolve_offline_conflict(uuid,text,text)','dq_store_branding(jsonb)','dq_review_order(jsonb)',
                           'dq_review_reply(uuid,text,boolean)','dq_store_products_save(jsonb)','dq_customer_home()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
