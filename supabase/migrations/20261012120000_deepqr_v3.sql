-- =============================================================================
-- DeepQr v3 — every kind of goods business
--   * 6 major business groups + 31 subcategories + one shared unit master
--   * a shared product catalogue (221 products sold in Tanzania) that new
--     businesses can adopt, edit and extend; businesses can propose products
--     and the platform owner approves them
--   * QR label print orders: businesses print their own labels or order
--     printed labels from DeepQr for a chosen date
--   * analysis-ready data export (one flat table for Excel pivot tables)
-- Safe to run more than once. Run AFTER 20261011120000_deepqr_v2.sql.
-- =============================================================================

create or replace function public.dq_version() returns integer language sql immutable as $$ select 3 $$;

-- -----------------------------------------------------------------------------
-- 1. reference data: groups, subcategories, units
-- -----------------------------------------------------------------------------
create table if not exists public.dq_groups (
  code text primary key,
  name text not null,
  covers text not null default '',
  icon text not null default 'box',
  sort integer not null default 0
);
create table if not exists public.dq_subcategories (
  code text primary key,
  group_code text not null references public.dq_groups(code) on delete cascade,
  name text not null,
  prefix text not null unique,
  sort integer not null default 0
);
create table if not exists public.dq_units (
  code text primary key,
  name text not null,
  used_for text not null default '',
  sort integer not null default 0
);
alter table public.dq_groups enable row level security;
alter table public.dq_subcategories enable row level security;
alter table public.dq_units enable row level security;
drop policy if exists dq_groups_read on public.dq_groups;
create policy dq_groups_read on public.dq_groups for select to anon, authenticated using (true);
drop policy if exists dq_subcategories_read on public.dq_subcategories;
create policy dq_subcategories_read on public.dq_subcategories for select to anon, authenticated using (true);
drop policy if exists dq_units_read on public.dq_units;
create policy dq_units_read on public.dq_units for select to anon, authenticated using (true);
grant select on public.dq_groups, public.dq_subcategories, public.dq_units to anon, authenticated;

insert into public.dq_groups(code, name, covers, icon, sort) values
 ('A','Food & Beverage','Groceries, fresh produce, meat, dairy, bakery, drinks, grains','cart',1),
 ('B','Health & Pharmacy','Drugs, medical consumables, supplements, baby care, equipment','shield',2),
 ('C','Household & General Merchandise','Cleaning, kitchenware, stationery, hardware, tools, electrical','store',3),
 ('D','Fashion & Personal Care','Clothing, footwear, bags, cosmetics, textiles','tag',4),
 ('E','Electronics & Technology','Phones, computers, appliances, gadgets','phone',5),
 ('F','Agro, Industrial & Bulk Commodities','Farm inputs, construction materials, fuel, raw/wholesale goods','truck',6)
on conflict (code) do update set name = excluded.name, covers = excluded.covers, icon = excluded.icon, sort = excluded.sort;

insert into public.dq_subcategories(code, group_code, name, prefix, sort) values
 ('A1','A','Fresh Produce','FRS',1),('A2','A','Meat, Poultry & Seafood','MEA',2),('A3','A','Dairy & Eggs','DAI',3),('A4','A','Bakery','BAK',4),
 ('A5','A','Packaged Foods','PKG',5),('A6','A','Beverages','BEV',6),('A7','A','Grains, Cereals & Pulses','GRN',7),
 ('B1','B','Prescription Drugs','RXD',1),('B2','B','OTC Drugs','OTC',2),('B3','B','Medical Consumables','MCN',3),('B4','B','Supplements & Vitamins','SUP',4),
 ('B5','B','Baby & Mother Care','BAB',5),('B6','B','Medical Equipment','MEQ',6),('B7','B','Pharmacy Skincare','PSK',7),
 ('C1','C','Cleaning & Hygiene','CLN',1),('C2','C','Kitchenware','KIT',2),('C3','C','Stationery & Office','STN',3),('C4','C','Hardware & Tools','HRD',4),('C5','C','Electrical Accessories','ELA',5),
 ('D1','D','Clothing & Footwear','CLO',1),('D2','D','Bags, Accessories & Jewelry','ACC',2),('D3','D','Cosmetics & Personal Care','COS',3),('D4','D','Textiles & Fabric','TEX',4),
 ('E1','E','Mobile & Accessories','MOB',1),('E2','E','Computers & Peripherals','CMP',2),('E3','E','Home Appliances','APL',3),('E4','E','Gadgets & Entertainment','GAD',4),
 ('F1','F','Agricultural Inputs','AGR',1),('F2','F','Construction Materials','CON',2),('F3','F','Fuel & Gas','FUE',3),('F4','F','Raw & Wholesale Materials','RAW',4)
on conflict (code) do update set group_code = excluded.group_code, name = excluded.name, prefix = excluded.prefix, sort = excluded.sort;

insert into public.dq_units(code, name, used_for, sort) values
 ('PCS','Piece','Most general goods',1),('DOZEN','12 pieces','Eggs, bottled drinks',2),('PACK','Fixed small pack','Snacks, sachets',3),
 ('BOX','Box/carton (small)','Stationery, medicine',4),('CARTON','Bulk carton','Beverages, wholesale',5),('SET','Grouped item','Tools, appliances',6),
 ('BAG','Sack/bag','Grains, cement, farm inputs',7),('KG','Kilogram','Produce, meat, bulk grains',8),('G','Gram','Spices, cosmetics',9),
 ('TON','Metric ton','Construction, wholesale',10),('LTR','Liter','Beverages, fuel, liquids',11),('ML','Milliliter','Cosmetics, syrups',12),
 ('MTR','Meter','Fabric, cables, pipes',13),('STRIP','Strip (pharma)','Tablets/capsules',14),('BOTTLE','Bottle','Syrups, supplements',15),
 ('VIAL/AMPOULE','Small sealed dose','Injectables',16)
on conflict (code) do update set name = excluded.name, used_for = excluded.used_for, sort = excluded.sort;

-- -----------------------------------------------------------------------------
-- 2. businesses choose their groups and units; products carry group/unit/catalogue link
-- -----------------------------------------------------------------------------
alter table public.businesses add column if not exists business_groups text[] not null default '{}';
alter table public.businesses add column if not exists units text[] not null default '{}';
alter table public.products add column if not exists group_code text;
alter table public.products add column if not exists catalog_id uuid;
alter table public.products add column if not exists brand text;
alter table public.products add column if not exists pack_size text;
-- old free-text units become master unit codes
update public.products set unit = 'PCS' where unit is null or lower(trim(unit)) in ('unit','units','pcs','pc','piece','pieces','');
update public.products set unit = upper(trim(unit)) where upper(trim(unit)) in (select code from public.dq_units) and unit <> upper(trim(unit));
alter table public.products alter column unit set default 'PCS';

-- -----------------------------------------------------------------------------
-- 3. shared product catalogue
-- -----------------------------------------------------------------------------
create table if not exists public.catalog_products (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  name text not null,
  brand text,
  subcategory_code text not null references public.dq_subcategories(code),
  group_code text not null references public.dq_groups(code),
  unit_code text not null references public.dq_units(code) default 'PCS',
  pack_size text,
  barcode text,
  suggested_price numeric not null default 0 check (suggested_price >= 0),
  description text,
  status text not null default 'approved' check (status in ('approved','pending','rejected')),
  active boolean not null default true,
  source text not null default 'platform' check (source in ('platform','business')),
  submitted_by_business uuid references public.businesses(id) on delete set null,
  submitted_by text,
  review_note text,
  adopted_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists catalog_products_sub_idx on public.catalog_products(subcategory_code, status);
alter table public.catalog_products enable row level security;
drop policy if exists catalog_read on public.catalog_products;
create policy catalog_read on public.catalog_products for select to authenticated
  using ((status = 'approved' and active) or submitted_by_business = public.my_business_id() or public.dq_is_platform_admin());

insert into public.catalog_products(code, name, brand, subcategory_code, group_code, unit_code, pack_size, suggested_price) values
('FRS001','Tomatoes',null,'A1','A','KG','per kg',2500),
('FRS002','Red onions',null,'A1','A','KG','per kg',3000),
('FRS003','Irish potatoes',null,'A1','A','KG','per kg',1800),
('FRS004','Ripe bananas (ndizi mbivu)',null,'A1','A','KG','per kg',1500),
('FRS005','Watermelon',null,'A1','A','PCS','1 piece',4000),
('FRS006','Carrots',null,'A1','A','KG','per kg',2500),
('FRS007','Cabbage',null,'A1','A','PCS','1 head',1500),
('FRS008','Oranges',null,'A1','A','DOZEN','12 pieces',3000),
('FRS009','Garlic',null,'A1','A','KG','per kg',8000),
('MEA001','Beef (steak)',null,'A2','A','KG','per kg',12000),
('MEA002','Goat meat',null,'A2','A','KG','per kg',14000),
('MEA003','Broiler chicken (whole)',null,'A2','A','PCS','1 bird ~1.5kg',13000),
('MEA004','Local chicken (kuku wa kienyeji)',null,'A2','A','PCS','1 bird',22000),
('MEA005','Nile perch fillet (sangara)',null,'A2','A','KG','per kg',15000),
('MEA006','Dried sardines (dagaa)',null,'A2','A','KG','per kg',9000),
('MEA007','Tilapia (sato)',null,'A2','A','KG','per kg',11000),
('DAI001','Fresh milk 500ml','Tanga Fresh','A3','A','PCS','500ml pouch',1500),
('DAI002','UHT milk 500ml','Asas','A3','A','PCS','500ml',1700),
('DAI003','Mtindi (sour milk) 500ml','Tanga Fresh','A3','A','PCS','500ml',1500),
('DAI004','Eggs tray of 30',null,'A3','A','PCS','tray of 30',12000),
('DAI005','Yoghurt 250ml','Asas','A3','A','PCS','250ml',1200),
('DAI006','Margarine 250g','Blue Band','A3','A','PCS','250g',3500),
('BAK001','White bread 600g','Azam','A4','A','PCS','600g loaf',2500),
('BAK002','Brown bread 600g',null,'A4','A','PCS','600g loaf',2800),
('BAK003','Mandazi',null,'A4','A','PCS','1 piece',200),
('BAK004','Chapati',null,'A4','A','PCS','1 piece',500),
('BAK005','Bread buns pack of 6',null,'A4','A','PACK','6 buns',2000),
('PKG001','Sugar 1kg','Kilombero','A5','A','KG','1kg',3500),
('PKG002','Sunflower cooking oil 1L','Mount Meru','A5','A','LTR','1 litre',6500),
('PKG003','Cooking fat 1kg','Kimbo','A5','A','KG','1kg',7500),
('PKG004','Iodized salt 1kg',null,'A5','A','KG','1kg',1000),
('PKG005','Mchuzi mix 75g','Royco','A5','A','PACK','75g',1000),
('PKG006','Spaghetti 500g','Azam','A5','A','PACK','500g',2200),
('PKG007','Biscuits 200g',null,'A5','A','PACK','200g',1000),
('PKG008','Tomato sauce 400g',null,'A5','A','BOTTLE','400g',3000),
('PKG009','Tea leaves 100g','Chai Bora','A5','A','PACK','100g',2000),
('PKG010','Instant coffee 50g','Africafe','A5','A','PACK','50g',5000),
('PKG011','Peanut butter 400g',null,'A5','A','PCS','400g jar',6000),
('BEV001','Coca-Cola 500ml','Coca-Cola','A6','A','BOTTLE','500ml PET',1000),
('BEV002','Pepsi 500ml','Pepsi','A6','A','BOTTLE','500ml PET',1000),
('BEV003','Drinking water 1.5L','Kilimanjaro','A6','A','BOTTLE','1.5 litres',1000),
('BEV004','Drinking water 500ml','Uhai','A6','A','BOTTLE','500ml',500),
('BEV005','Mango juice 250ml','Azam','A6','A','PCS','250ml',800),
('BEV006','Safari Lager 500ml','Safari','A6','A','BOTTLE','500ml',2500),
('BEV007','Kilimanjaro Lager 500ml','Kilimanjaro','A6','A','BOTTLE','500ml',2500),
('BEV008','Serengeti Premium Lager 500ml','Serengeti','A6','A','BOTTLE','500ml',2500),
('BEV009','Konyagi 750ml','Konyagi','A6','A','BOTTLE','750ml',14000),
('BEV010','Energy drink 250ml','Red Bull','A6','A','PCS','250ml can',3500),
('BEV011','Soda crate 24 x 350ml','Coca-Cola','A6','A','CARTON','24 bottles',14000),
('BEV012','Water carton 12 x 500ml','Kilimanjaro','A6','A','CARTON','12 bottles',6000),
('GRN001','Rice (Kyela) 1kg',null,'A7','A','KG','1kg',3200),
('GRN002','Maize flour (sembe) 1kg',null,'A7','A','KG','1kg',1800),
('GRN003','Wheat flour 2kg','Azam','A7','A','PACK','2kg',4800),
('GRN004','Red kidney beans',null,'A7','A','KG','per kg',3500),
('GRN005','Green grams (choroko)',null,'A7','A','KG','per kg',3500),
('GRN006','Rice 25kg bag',null,'A7','A','BAG','25kg',75000),
('GRN007','Maize grain 100kg bag',null,'A7','A','BAG','100kg',75000),
('GRN008','Groundnuts (karanga)',null,'A7','A','KG','per kg',5000),
('RXD001','Amoxicillin 500mg capsules',null,'B1','B','STRIP','10 capsules',1500),
('RXD002','Artemether/Lumefantrine 20/120mg (ALu)',null,'B1','B','BOX','24 tablets',3000),
('RXD003','Metformin 500mg',null,'B1','B','STRIP','10 tablets',1000),
('RXD004','Amlodipine 5mg',null,'B1','B','STRIP','10 tablets',1500),
('RXD005','Ciprofloxacin 500mg',null,'B1','B','STRIP','10 tablets',2000),
('RXD006','Ceftriaxone 1g injection',null,'B1','B','VIAL/AMPOULE','1 vial',3000),
('RXD007','Metronidazole 200mg',null,'B1','B','STRIP','10 tablets',500),
('OTC001','Paracetamol 500mg',null,'B2','B','STRIP','10 tablets',500),
('OTC002','Panadol Extra','Panadol','B2','B','STRIP','10 tablets',1500),
('OTC003','Ibuprofen 400mg',null,'B2','B','STRIP','10 tablets',800),
('OTC004','ORS sachet',null,'B2','B','PACK','1 sachet',500),
('OTC005','Cetirizine 10mg',null,'B2','B','STRIP','10 tablets',1000),
('OTC006','Cough syrup 100ml','Benylin','B2','B','BOTTLE','100ml',8000),
('OTC007','Pain relief tablets','Mara Moja','B2','B','STRIP','10 tablets',500),
('OTC008','Fruit salt sachet','Eno','B2','B','PACK','1 sachet',500),
('MCN001','Disposable syringe 5ml',null,'B3','B','PCS','1 piece',200),
('MCN002','Examination gloves',null,'B3','B','BOX','100 pieces',12000),
('MCN003','Cotton wool 100g',null,'B3','B','PACK','100g',2500),
('MCN004','Crepe bandage 10cm',null,'B3','B','PCS','1 roll',1500),
('MCN005','Face masks',null,'B3','B','BOX','50 pieces',5000),
('MCN006','Surgical spirit 500ml',null,'B3','B','BOTTLE','500ml',3500),
('SUP001','Vitamin C 500mg',null,'B4','B','BOTTLE','30 tablets',6000),
('SUP002','Multivitamin syrup 200ml',null,'B4','B','BOTTLE','200ml',7000),
('SUP003','Folic acid 5mg',null,'B4','B','STRIP','10 tablets',500),
('SUP004','Zinc 20mg dispersible',null,'B4','B','STRIP','10 tablets',1000),
('BAB001','Baby diapers size 4','Softcare','B5','B','PACK','40 pieces',18000),
('BAB002','Sanitary pads','Always','B5','B','PACK','8 pads',3000),
('BAB003','Infant cereal 400g','Cerelac','B5','B','PCS','400g',12000),
('BAB004','Baby wipes',null,'B5','B','PACK','80 wipes',4000),
('BAB005','Gripe water 150ml',null,'B5','B','BOTTLE','150ml',6000),
('MEQ001','Digital thermometer',null,'B6','B','PCS','1 piece',8000),
('MEQ002','Blood pressure monitor',null,'B6','B','SET','1 set',65000),
('MEQ003','Glucometer kit',null,'B6','B','SET','1 kit',55000),
('MEQ004','Glucose test strips',null,'B6','B','BOX','50 strips',35000),
('MEQ005','Wheelchair (standard)',null,'B6','B','PCS','1 piece',350000),
('PSK001','Calamine lotion 100ml',null,'B7','B','BOTTLE','100ml',3500),
('PSK002','Hydrocortisone cream 1%',null,'B7','B','PCS','15g tube',3000),
('PSK003','Sunscreen SPF50',null,'B7','B','PCS','100ml',25000),
('PSK004','Antifungal cream',null,'B7','B','PCS','15g tube',2500),
('CLN001','Washing powder 1kg','Omo','C1','C','PACK','1kg',6000),
('CLN002','Bar soap','Jamaa','C1','C','PCS','1 bar',2500),
('CLN003','Bleach 750ml','Jik','C1','C','BOTTLE','750ml',3500),
('CLN004','Toilet cleaner 500ml','Harpic','C1','C','BOTTLE','500ml',5500),
('CLN005','Dishwashing liquid 750ml','Sunlight','C1','C','BOTTLE','750ml',4500),
('CLN006','Toilet paper 10 rolls',null,'C1','C','PACK','10 rolls',7000),
('CLN007','Insect spray 300ml','Doom','C1','C','PCS','300ml',8500),
('CLN008','Antiseptic liquid 500ml','Dettol','C1','C','BOTTLE','500ml',12000),
('KIT001','Aluminium cooking pot (sufuria) no.10',null,'C2','C','PCS','1 piece',15000),
('KIT002','Plastic bucket 20L',null,'C2','C','PCS','20 litres',7000),
('KIT003','Jerrycan 20L',null,'C2','C','PCS','20 litres',6000),
('KIT004','Thermos flask 1.8L',null,'C2','C','PCS','1.8 litres',18000),
('KIT005','Dinner plates set of 6',null,'C2','C','SET','6 plates',12000),
('KIT006','Improved charcoal stove (jiko)',null,'C2','C','PCS','1 piece',20000),
('STN001','Counter book 2 quire',null,'C3','C','PCS','1 book',3000),
('STN002','Exercise books 48 pages',null,'C3','C','DOZEN','12 books',6000),
('STN003','Ballpoint pens blue','Bic','C3','C','BOX','50 pens',15000),
('STN004','A4 paper ream',null,'C3','C','PACK','500 sheets',13000),
('STN005','Pencils HB',null,'C3','C','DOZEN','12 pencils',2400),
('STN006','Brown envelopes A4',null,'C3','C','PACK','50 envelopes',6000),
('HRD001','Claw hammer',null,'C4','C','PCS','1 piece',12000),
('HRD002','Wire nails 3 inch',null,'C4','C','KG','per kg',4000),
('HRD003','Padlock 50mm',null,'C4','C','PCS','1 piece',8000),
('HRD004','Hand hoe (jembe)',null,'C4','C','PCS','1 piece',9000),
('HRD005','Machete (panga)',null,'C4','C','PCS','1 piece',7000),
('HRD006','Screwdriver set',null,'C4','C','SET','6 pieces',15000),
('HRD007','Wheelbarrow',null,'C4','C','PCS','1 piece',120000),
('ELA001','LED bulb 9W',null,'C5','C','PCS','1 bulb',3500),
('ELA002','Extension cable 4-way 3m',null,'C5','C','PCS','1 piece',20000),
('ELA003','Twin socket outlet 13A',null,'C5','C','PCS','1 piece',6000),
('ELA004','Electric cable 2.5mm',null,'C5','C','MTR','per metre',2000),
('ELA005','AA batteries',null,'C5','C','PACK','4 batteries',3000),
('ELA006','Circuit breaker 32A',null,'C5','C','PCS','1 piece',15000),
('CLO001','Men''s cotton shirt',null,'D1','D','PCS','1 piece',25000),
('CLO002','Ladies'' dress',null,'D1','D','PCS','1 piece',35000),
('CLO003','School uniform shirt',null,'D1','D','PCS','1 piece',12000),
('CLO004','Jeans trousers',null,'D1','D','PCS','1 piece',30000),
('CLO005','School shoes','Bata','D1','D','PCS','1 pair',35000),
('CLO006','Rubber sandals (patapata)',null,'D1','D','PCS','1 pair',3000),
('CLO007','Sports T-shirt',null,'D1','D','PCS','1 piece',15000),
('ACC001','School backpack',null,'D2','D','PCS','1 piece',25000),
('ACC002','Ladies handbag',null,'D2','D','PCS','1 piece',40000),
('ACC003','Leather wallet',null,'D2','D','PCS','1 piece',15000),
('ACC004','Wristwatch',null,'D2','D','PCS','1 piece',30000),
('ACC005','Maasai beaded bracelet',null,'D2','D','PCS','1 piece',5000),
('COS001','Toothpaste 140g','Colgate','D3','D','PCS','140g',3500),
('COS002','Toothpaste 70g','Whitedent','D3','D','PCS','70g',2000),
('COS003','Petroleum jelly 250ml','Vaseline','D3','D','PCS','250ml',6000),
('COS004','Body lotion 400ml','Nivea','D3','D','BOTTLE','400ml',14000),
('COS005','Herbal jelly 250g','Movit','D3','D','PCS','250g',4500),
('COS006','Braids hair extension','Darling','D3','D','PACK','1 pack',6000),
('COS007','Shea butter 200g',null,'D3','D','PCS','200g',8000),
('COS008','Roll-on deodorant 50ml','Rexona','D3','D','PCS','50ml',7000),
('COS009','Beauty soap 175g','Lux','D3','D','PCS','175g',2000),
('COS010','Disposable razors','Gillette','D3','D','PACK','5 razors',4000),
('TEX001','Khanga (pair)',null,'D4','D','SET','1 pair',15000),
('TEX002','Kitenge 6 yards',null,'D4','D','PCS','6 yards',25000),
('TEX003','Bedsheet set (double)',null,'D4','D','SET','4 pieces',35000),
('TEX004','Treated mosquito net',null,'D4','D','PCS','1 piece',15000),
('TEX005','Cotton fabric',null,'D4','D','MTR','per metre',5000),
('TEX006','Bath towel',null,'D4','D','PCS','1 piece',12000),
('MOB001','Tecno Spark 20','Tecno','E1','E','PCS','1 phone',380000),
('MOB002','itel A70','itel','E1','E','PCS','1 phone',230000),
('MOB003','Samsung Galaxy A15','Samsung','E1','E','PCS','1 phone',480000),
('MOB004','Infinix Hot 40i','Infinix','E1','E','PCS','1 phone',370000),
('MOB005','itel feature phone','itel','E1','E','PCS','1 phone',35000),
('MOB006','USB-C fast charger',null,'E1','E','PCS','1 piece',10000),
('MOB007','Wired earphones',null,'E1','E','PCS','1 piece',5000),
('MOB008','Power bank 10000mAh',null,'E1','E','PCS','1 piece',35000),
('MOB009','Memory card 32GB',null,'E1','E','PCS','1 piece',15000),
('MOB010','Phone case',null,'E1','E','PCS','1 piece',5000),
('CMP001','Laptop HP 250 G9 Core i5','HP','E2','E','PCS','1 laptop',1650000),
('CMP002','Laptop Dell Latitude Core i5','Dell','E2','E','PCS','1 laptop',1850000),
('CMP003','USB flash disk 32GB',null,'E2','E','PCS','1 piece',15000),
('CMP004','Wireless mouse',null,'E2','E','PCS','1 piece',15000),
('CMP005','USB keyboard',null,'E2','E','PCS','1 piece',20000),
('CMP006','Laser printer','HP','E2','E','PCS','1 printer',450000),
('CMP007','Toner cartridge 85A','HP','E2','E','PCS','1 cartridge',95000),
('APL001','Smart TV 43 inch','Hisense','E3','E','PCS','1 TV',850000),
('APL002','Refrigerator 200L','Hisense','E3','E','PCS','1 fridge',950000),
('APL003','Blender 1.5L',null,'E3','E','PCS','1 piece',75000),
('APL004','Electric kettle 1.7L',null,'E3','E','PCS','1 piece',45000),
('APL005','Gas cooker 2-burner',null,'E3','E','PCS','1 piece',85000),
('APL006','Standing fan',null,'E3','E','PCS','1 piece',70000),
('APL007','Electric iron',null,'E3','E','PCS','1 piece',30000),
('GAD001','Bluetooth speaker',null,'E4','E','PCS','1 piece',45000),
('GAD002','Solar lamp with phone charging','d.light','E4','E','PCS','1 piece',40000),
('GAD003','FM radio',null,'E4','E','PCS','1 piece',25000),
('GAD004','TV decoder','Azam TV','E4','E','PCS','1 piece',35000),
('GAD005','Smart watch',null,'E4','E','PCS','1 piece',60000),
('GAD006','Rechargeable torch',null,'E4','E','PCS','1 piece',12000),
('AGR001','Urea fertilizer 50kg',null,'F1','F','BAG','50kg',75000),
('AGR002','DAP fertilizer 50kg',null,'F1','F','BAG','50kg',85000),
('AGR003','CAN fertilizer 50kg',null,'F1','F','BAG','50kg',70000),
('AGR004','Hybrid maize seed 2kg',null,'F1','F','PACK','2kg',15000),
('AGR005','Knapsack sprayer 16L',null,'F1','F','PCS','1 piece',55000),
('AGR006','Pesticide 1L',null,'F1','F','LTR','1 litre',25000),
('AGR007','Dairy meal 70kg',null,'F1','F','BAG','70kg',55000),
('AGR008','Day-old chicks',null,'F1','F','PCS','1 chick',2500),
('CON001','Cement 50kg','Twiga','F2','F','BAG','50kg',17500),
('CON002','Cement 42.5 50kg','Dangote','F2','F','BAG','50kg',17000),
('CON003','Cement 50kg','Simba','F2','F','BAG','50kg',17000),
('CON004','Iron sheet gauge 30','ALAF','F2','F','PCS','1 sheet',28000),
('CON005','Steel bar Y12',null,'F2','F','PCS','12m bar',22000),
('CON006','Building sand',null,'F2','F','TON','per ton',35000),
('CON007','PVC pipe 4 inch',null,'F2','F','PCS','6m pipe',25000),
('CON008','Floor tiles 60x60',null,'F2','F','BOX','4 tiles',35000),
('CON009','Emulsion paint 20L',null,'F2','F','PCS','20 litres',95000),
('CON010','Binding wire',null,'F2','F','KG','per kg',5000),
('FUE001','LPG gas refill 15kg','Oryx','F3','F','PCS','15kg cylinder',58000),
('FUE002','LPG gas refill 6kg','Taifa Gas','F3','F','PCS','6kg cylinder',25000),
('FUE003','Kerosene',null,'F3','F','LTR','per litre',3200),
('FUE004','Diesel',null,'F3','F','LTR','per litre',3100),
('FUE005','Petrol',null,'F3','F','LTR','per litre',3200),
('FUE006','Charcoal sack',null,'F3','F','BAG','1 sack',60000),
('FUE007','Engine oil 4L',null,'F3','F','PCS','4 litres',45000),
('RAW001','Sugar 50kg bag',null,'F4','F','BAG','50kg',150000),
('RAW002','Wheat flour 50kg','Azam','F4','F','BAG','50kg',82000),
('RAW003','Cooking oil 20L',null,'F4','F','PCS','20 litre jerrycan',110000),
('RAW004','Rice 50kg bag',null,'F4','F','BAG','50kg',140000),
('RAW005','Salt 50kg bag',null,'F4','F','BAG','50kg',30000),
('RAW006','Raw cashew nuts',null,'F4','F','KG','per kg',3000),
('RAW007','Sunflower seeds',null,'F4','F','KG','per kg',1500),
('RAW008','Packaging cartons',null,'F4','F','PCS','1 carton',1500)

on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- 4. QR label print orders (printed by DeepQr and delivered / collected)
-- -----------------------------------------------------------------------------
alter table public.platform_settings add column if not exists print_fee_per_label numeric not null default 20;
alter table public.platform_settings add column if not exists print_delivery_fee numeric not null default 0;
alter table public.platform_settings add column if not exists print_lead_days integer not null default 2;
alter table public.platform_settings add column if not exists print_note text not null default 'Labels are printed on durable matte sticker paper. Collect from the DeepQr office or choose delivery.';

alter table public.wallet_transactions drop constraint if exists wallet_transactions_type_check;
alter table public.wallet_transactions add constraint wallet_transactions_type_check check (type in
  ('topup','qr_charge','adjustment','refund','bonus','promo','referral','welcome','bonus_expired','print_charge','print_refund'));

create table if not exists public.qr_print_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_no text not null unique,
  generation_ids uuid[] not null default '{}',
  item_ids uuid[] not null default '{}',
  label_count integer not null check (label_count > 0),
  copies integer not null default 1 check (copies between 1 and 5),
  label_size text not null default 'medium',
  delivery_method text not null default 'pickup' check (delivery_method in ('pickup','delivery')),
  delivery_address text,
  contact_name text,
  contact_phone text not null,
  requested_date date not null,
  promised_date date,
  note text,
  status text not null default 'requested' check (status in ('requested','accepted','printing','ready','delivered','cancelled','rejected')),
  fee_per_label numeric not null default 0,
  delivery_fee numeric not null default 0,
  total_fee numeric not null default 0,
  bonus_used numeric not null default 0,
  paid_amount numeric not null default 0,
  admin_note text,
  history jsonb not null default '[]'::jsonb,
  requested_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists qr_print_orders_biz_idx on public.qr_print_orders(business_id, created_at desc);
alter table public.qr_print_orders enable row level security;
drop policy if exists qr_print_orders_read on public.qr_print_orders;
create policy qr_print_orders_read on public.qr_print_orders for select to authenticated
  using (business_id = public.my_business_id() or public.dq_is_platform_admin());

-- -----------------------------------------------------------------------------
-- 5. helpers
-- -----------------------------------------------------------------------------
-- charge an amount (bonus first, then main balance, within the credit limit)
create or replace function public.dq_charge_amount(p_business uuid, p_amount numeric, p_type text, p_reference text, p_note text, p_by text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc dq_accounts; st platform_settings; v_bonus numeric; v_main numeric;
begin
  select * into st from platform_settings where id = 1;
  insert into dq_accounts(business_id) values (p_business) on conflict do nothing;
  select * into acc from dq_accounts where business_id = p_business for update;
  if acc.status = 'suspended' then raise exception 'ACCOUNT_SUSPENDED: this business account is suspended by DeepQr'; end if;
  if acc.bonus_expires_at is not null and acc.bonus_expires_at < now() then acc.bonus_balance := 0; end if;
  v_bonus := least(greatest(acc.bonus_balance, 0), p_amount);
  v_main := p_amount - v_bonus;
  if v_main > 0 and acc.balance - v_main < -coalesce(acc.credit_limit, 0) and not st.allow_negative_balance then
    raise exception 'INSUFFICIENT_BALANCE: this costs % % (% from bonus). Your balance is % %. Please top up.',
      p_amount, st.currency, v_bonus, acc.balance, st.currency;
  end if;
  update dq_accounts set balance = balance - v_main,
         bonus_balance = case when bonus_expires_at is not null and bonus_expires_at < now() then 0 else bonus_balance end - v_bonus,
         total_spent = total_spent + p_amount, updated_at = now()
   where business_id = p_business returning * into acc;
  insert into wallet_transactions(business_id, type, amount, bonus_amount, balance_after, bonus_balance_after, reference, note, by_name)
  values (p_business, p_type, -v_main, -v_bonus, acc.balance, acc.bonus_balance, p_reference, p_note, p_by);
  return jsonb_build_object('bonus_used', v_bonus, 'paid', v_main, 'balance', acc.balance, 'bonus_balance', acc.bonus_balance);
end $$;

create or replace function public.dq_random_barcode() returns text language sql volatile as $$
  select '2' || lpad((floor(random() * 100000000000))::bigint::text, 11, '0')
$$;

create or replace function public.dq_catalog_next_code(p_sub text) returns text
language plpgsql security definer set search_path = public as $$
declare pre text; n int;
begin
  select prefix into pre from dq_subcategories where code = p_sub;
  if pre is null then raise exception 'Unknown subcategory %', p_sub; end if;
  perform pg_advisory_xact_lock(hashtext('dq_catalog_' || pre));
  select coalesce(max(substring(code from '^' || pre || '([0-9]+)$')::int), 0) + 1 into n
    from catalog_products where code ~ ('^' || pre || '[0-9]+$');
  return pre || lpad(n::text, 3, '0');
end $$;

-- -----------------------------------------------------------------------------
-- 6. business type (groups) and units
-- -----------------------------------------------------------------------------
create or replace function public.dq_set_business_groups(p_groups text[], p_units text[] default null) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager']); v_groups text[]; n int;
begin
  select coalesce(array_agg(distinct g order by g), '{}') into v_groups
    from unnest(coalesce(p_groups, '{}')) g where g in (select code from dq_groups);
  if cardinality(v_groups) = 0 then raise exception 'Choose at least one business group'; end if;
  update businesses set business_groups = v_groups,
         units = case when p_units is null then units
                      else coalesce((select array_agg(distinct u) from unnest(p_units) u where u in (select code from dq_units)), '{}') end
   where id = m.business_id;
  insert into categories(business_id, name)
  select m.business_id, s.name from dq_subcategories s where s.group_code = any(v_groups)
  on conflict (business_id, name) do nothing;
  get diagnostics n = row_count;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'settings', 'Business groups set to ' || array_to_string(v_groups, ', '), m.name);
  return json_build_object('groups', v_groups, 'categories_added', n);
end $$;

-- -----------------------------------------------------------------------------
-- 7. catalogue: adopt into my products, propose new products, admin curation
-- -----------------------------------------------------------------------------
create or replace function public.dq_adopt_catalog(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager','inventory','main_operator']);
        it jsonb; c catalog_products; v_code text; v_added int := 0; v_skipped jsonb := '[]'::jsonb; pr products; sub dq_subcategories;
        v_ids uuid[] := '{}'; v_bar text;
begin
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'Choose at least one product from the catalogue';
  end if;
  if jsonb_array_length(p->'items') > 500 then raise exception 'Add at most 500 products at a time'; end if;
  for it in select * from jsonb_array_elements(p->'items') loop
    select * into c from catalog_products where id = nullif(it->>'catalog_id','')::uuid and status = 'approved' and active;
    if c.id is null then v_skipped := v_skipped || jsonb_build_object('catalog_id', it->>'catalog_id', 'reason', 'not available'); continue; end if;
    if exists (select 1 from products where business_id = m.business_id and catalog_id = c.id) then
      v_skipped := v_skipped || jsonb_build_object('code', c.code, 'name', c.name, 'reason', 'already in your products'); continue;
    end if;
    v_code := upper(regexp_replace(coalesce(nullif(trim(it->>'code'),''), c.code), '[^A-Za-z0-9]', '', 'g'));
    if v_code = '' then v_code := c.code; end if;
    if exists (select 1 from products where business_id = m.business_id and upper(code) = v_code) then
      v_skipped := v_skipped || jsonb_build_object('code', v_code, 'name', c.name, 'reason', 'code already used'); continue;
    end if;
    select * into sub from dq_subcategories where code = c.subcategory_code;
    v_bar := c.barcode;
    if v_bar is null or exists (select 1 from products where business_id = m.business_id and barcode = v_bar) then v_bar := dq_random_barcode(); end if;
    insert into categories(business_id, name) values (m.business_id, sub.name) on conflict (business_id, name) do nothing;
    insert into products(business_id, code, name, category, unit, cost, price, tax, barcode, active, group_code, catalog_id, brand, pack_size, description, low_stock)
    values (m.business_id, v_code,
            case when c.brand is not null and position(lower(c.brand) in lower(c.name)) = 0 then c.brand || ' ' || c.name else c.name end,
            sub.name, c.unit_code, greatest(coalesce((it->>'cost')::numeric, 0), 0),
            greatest(coalesce((it->>'price')::numeric, c.suggested_price), 0), 0, v_bar, true, c.group_code, c.id, c.brand, c.pack_size, c.description,
            nullif(it->>'low_stock','')::int)
    returning * into pr;
    v_ids := v_ids || pr.id;
    update catalog_products set adopted_count = adopted_count + 1 where id = c.id;
    v_added := v_added + 1;
  end loop;
  if v_added > 0 then
    insert into activity_log(business_id, type, description, by_name)
    values (m.business_id, 'product', v_added || ' product(s) added from the DeepQr catalogue', m.name);
  end if;
  return json_build_object('added', v_added, 'skipped', v_skipped,
    'products', coalesce((select json_agg(row_to_json(x)) from products x where x.id = any(v_ids)), '[]'::json));
end $$;

create or replace function public.dq_submit_catalog_product(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager','inventory','main_operator']); sub dq_subcategories; c catalog_products;
begin
  select * into sub from dq_subcategories where code = p->>'subcategory_code';
  if sub.code is null then raise exception 'Choose the subcategory'; end if;
  if nullif(trim(p->>'name'),'') is null then raise exception 'Enter the product name'; end if;
  if not exists (select 1 from dq_units where code = coalesce(p->>'unit_code','PCS')) then raise exception 'Choose a unit from the master list'; end if;
  if exists (select 1 from catalog_products where lower(name) = lower(trim(p->>'name')) and coalesce(lower(brand),'') = coalesce(lower(nullif(trim(p->>'brand'),'')),'')
             and subcategory_code = sub.code and status <> 'rejected') then
    raise exception 'CATALOG_DUPLICATE: this product is already in the catalogue (or waiting for approval)';
  end if;
  insert into catalog_products(name, brand, subcategory_code, group_code, unit_code, pack_size, barcode, suggested_price, description,
                               status, source, submitted_by_business, submitted_by)
  values (trim(p->>'name'), nullif(trim(p->>'brand'),''), sub.code, sub.group_code, coalesce(p->>'unit_code','PCS'),
          nullif(trim(p->>'pack_size'),''), nullif(trim(p->>'barcode'),''), greatest(coalesce((p->>'price')::numeric, 0), 0),
          nullif(trim(p->>'description'),''), 'pending', 'business', m.business_id, m.name)
  returning * into c;
  if nullif(p->>'product_id','') is not null then
    update products set catalog_id = c.id, group_code = sub.group_code where id = (p->>'product_id')::uuid and business_id = m.business_id;
  end if;
  return row_to_json(c);
end $$;

create or replace function public.dq_admin_save_catalog(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare c catalog_products; sub dq_subcategories; it jsonb; n int := 0; em text; v_action text := coalesce(p->>'action', 'save');
begin
  perform dq_require_admin();
  select email into em from auth.users where id = auth.uid();
  if v_action = 'import' then
    for it in select * from jsonb_array_elements(coalesce(p->'items','[]'::jsonb)) loop
      select * into sub from dq_subcategories where code = it->>'subcategory_code' or lower(name) = lower(it->>'subcategory');
      if sub.code is null or nullif(trim(it->>'name'),'') is null then continue; end if;
      if exists (select 1 from catalog_products where lower(name) = lower(trim(it->>'name')) and subcategory_code = sub.code
                 and coalesce(lower(brand),'') = coalesce(lower(nullif(trim(it->>'brand'),'')),'')) then continue; end if;
      insert into catalog_products(code, name, brand, subcategory_code, group_code, unit_code, pack_size, barcode, suggested_price, description)
      values (dq_catalog_next_code(sub.code), trim(it->>'name'), nullif(trim(it->>'brand'),''), sub.code, sub.group_code,
              case when upper(it->>'unit_code') in (select code from dq_units) then upper(it->>'unit_code') else 'PCS' end,
              nullif(trim(it->>'pack_size'),''), nullif(trim(it->>'barcode'),''), greatest(coalesce(nullif(it->>'price','')::numeric, 0), 0),
              nullif(trim(it->>'description'),''));
      n := n + 1;
    end loop;
    perform dq_audit('catalog.import', 'catalog', null, jsonb_build_object('added', n));
    return json_build_object('added', n);
  end if;
  if nullif(p->>'id','') is not null then
    select * into c from catalog_products where id = (p->>'id')::uuid for update;
    if c.id is null then raise exception 'Catalogue product not found'; end if;
  end if;
  if v_action = 'delete' then
    delete from catalog_products where id = c.id;
    perform dq_audit('catalog.delete', 'catalog', c.id::text, jsonb_build_object('name', c.name));
    return null;
  elsif v_action = 'reject' then
    update catalog_products set status = 'rejected', review_note = coalesce(nullif(p->>'note',''), 'Not accepted'), updated_at = now() where id = c.id returning * into c;
    perform dq_audit('catalog.reject', 'catalog', c.id::text, p);
    return row_to_json(c);
  end if;
  -- save (create, edit, or approve with edits)
  select * into sub from dq_subcategories where code = coalesce(p->>'subcategory_code', c.subcategory_code);
  if sub.code is null then raise exception 'Choose the subcategory'; end if;
  if nullif(trim(coalesce(p->>'name', c.name)),'') is null then raise exception 'Enter the product name'; end if;
  if c.id is null then
    insert into catalog_products(code, name, brand, subcategory_code, group_code, unit_code, pack_size, barcode, suggested_price, description, active)
    values (dq_catalog_next_code(sub.code), trim(p->>'name'), nullif(trim(p->>'brand'),''), sub.code, sub.group_code,
            coalesce(nullif(p->>'unit_code',''),'PCS'), nullif(trim(p->>'pack_size'),''), nullif(trim(p->>'barcode'),''),
            greatest(coalesce(nullif(p->>'price','')::numeric, 0), 0), nullif(trim(p->>'description'),''), coalesce((p->>'active')::boolean, true))
    returning * into c;
  else
    update catalog_products set
      name = coalesce(nullif(trim(p->>'name'),''), name),
      brand = case when p ? 'brand' then nullif(trim(p->>'brand'),'') else brand end,
      subcategory_code = sub.code, group_code = sub.group_code,
      code = case when code is null or subcategory_code <> sub.code then dq_catalog_next_code(sub.code) else code end,
      unit_code = coalesce(nullif(p->>'unit_code',''), unit_code),
      pack_size = case when p ? 'pack_size' then nullif(trim(p->>'pack_size'),'') else pack_size end,
      barcode = case when p ? 'barcode' then nullif(trim(p->>'barcode'),'') else barcode end,
      suggested_price = case when p ? 'price' then greatest(coalesce(nullif(p->>'price','')::numeric, 0), 0) else suggested_price end,
      description = case when p ? 'description' then nullif(trim(p->>'description'),'') else description end,
      active = coalesce((p->>'active')::boolean, active),
      status = case when v_action = 'approve' then 'approved' else status end,
      review_note = case when v_action = 'approve' then 'Approved by ' || em else review_note end,
      updated_at = now()
    where id = c.id returning * into c;
  end if;
  perform dq_audit('catalog.' || v_action, 'catalog', c.id::text, jsonb_build_object('code', c.code, 'name', c.name));
  return row_to_json(c);
end $$;

-- -----------------------------------------------------------------------------
-- 8. print orders
-- -----------------------------------------------------------------------------
create or replace function public.dq_request_print(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager','inventory','main_operator']); st platform_settings;
        v_gens uuid[]; v_items uuid[]; v_copies int := greatest(least(coalesce((p->>'copies')::int, 1), 5), 1);
        v_delivery text := coalesce(nullif(p->>'delivery_method',''), 'pickup'); v_date date := nullif(p->>'requested_date','')::date;
        v_fee numeric; v_dfee numeric; v_total numeric; ch jsonb; o qr_print_orders; n int; v_no text;
begin
  select * into st from platform_settings where id = 1;
  select coalesce(array_agg(x::uuid), '{}') into v_gens from jsonb_array_elements_text(coalesce(p->'generation_ids','[]'::jsonb)) x;
  if nullif(p->>'item_ids','') is not null and jsonb_typeof(p->'item_ids') = 'array' and jsonb_array_length(p->'item_ids') > 0 then
    select coalesce(array_agg(i.id order by i.serial), '{}') into v_items from product_items i
     where i.business_id = m.business_id and i.status in ('in_stock','transit')
       and i.id in (select x::uuid from jsonb_array_elements_text(p->'item_ids') x);
  else
    select coalesce(array_agg(i.id order by i.serial), '{}') into v_items from product_items i
     where i.business_id = m.business_id and i.status in ('in_stock','transit') and i.generation_id = any(v_gens);
  end if;
  if cardinality(v_items) = 0 then raise exception 'PRINT_EMPTY: choose QR batches that still have labels in stock'; end if;
  if v_date is null then raise exception 'Choose the date you need the labels'; end if;
  if v_date < current_date + st.print_lead_days then
    raise exception 'PRINT_DATE: printing needs at least % day(s). Choose % or later.', st.print_lead_days, to_char(current_date + st.print_lead_days, 'DD Mon YYYY');
  end if;
  if dq_phone(p->>'contact_phone') is null then raise exception 'Enter a phone number DeepQr can call about this order'; end if;
  if v_delivery = 'delivery' and nullif(trim(p->>'delivery_address'),'') is null then raise exception 'Enter the delivery address'; end if;
  select gen.ids into v_gens from (select coalesce(array_agg(distinct generation_id), '{}') as ids from product_items where id = any(v_items)) gen;
  v_fee := coalesce(st.print_fee_per_label, 0);
  v_dfee := case when v_delivery = 'delivery' then coalesce(st.print_delivery_fee, 0) else 0 end;
  v_total := round(cardinality(v_items) * v_copies * v_fee + v_dfee, 2);
  perform pg_advisory_xact_lock(hashtext('dq_print_orders'));
  select count(*) + 1 into n from qr_print_orders where created_at >= date_trunc('month', now());
  v_no := 'PR-' || to_char(now(), 'YYMM') || '-' || lpad(n::text, 4, '0');
  if v_total > 0 then
    ch := dq_charge_amount(m.business_id, v_total, 'print_charge', v_no, 'Printing ' || cardinality(v_items) * v_copies || ' QR label(s)', m.name);
  end if;
  insert into qr_print_orders(business_id, order_no, generation_ids, item_ids, label_count, copies, label_size, delivery_method, delivery_address,
                              contact_name, contact_phone, requested_date, note, fee_per_label, delivery_fee, total_fee, bonus_used, paid_amount,
                              requested_by, history)
  values (m.business_id, v_no, v_gens, v_items, cardinality(v_items), v_copies, coalesce(nullif(p->>'label_size',''), 'medium'), v_delivery,
          nullif(trim(p->>'delivery_address'),''), coalesce(nullif(trim(p->>'contact_name'),''), m.name), dq_phone(p->>'contact_phone'), v_date,
          nullif(trim(p->>'note'),''), v_fee, v_dfee, v_total, coalesce((ch->>'bonus_used')::numeric, 0), coalesce((ch->>'paid')::numeric, 0), m.name,
          jsonb_build_array(jsonb_build_object('status','requested','at',now(),'by',m.name)))
  returning * into o;
  insert into activity_log(business_id, type, description, by_name)
  values (m.business_id, 'qr', 'Print order ' || v_no || ': ' || cardinality(v_items) * v_copies || ' label(s) for ' || to_char(v_date, 'DD Mon'), m.name);
  return row_to_json(o);
end $$;

create or replace function public.dq_cancel_print(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare m members := dq_require_staff(array['owner','manager','inventory','main_operator']); o qr_print_orders;
begin
  select * into o from qr_print_orders where id = p_id and business_id = m.business_id for update;
  if o.id is null then raise exception 'Print order not found'; end if;
  if o.status <> 'requested' then raise exception 'DeepQr has already started this order (%). Contact support to change it.', o.status; end if;
  if o.total_fee > 0 then
    perform dq_credit(o.business_id, 'print_refund', o.paid_amount, o.bonus_used, o.order_no, 'Print order cancelled', m.name);
  end if;
  update qr_print_orders set status = 'cancelled', updated_at = now(),
         history = history || jsonb_build_object('status','cancelled','at',now(),'by',m.name)
   where id = o.id returning * into o;
  return row_to_json(o);
end $$;

create or replace function public.dq_admin_print_orders() returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  return coalesce((select json_agg(row_to_json(t) order by t.created_at desc) from (
    select o.*, b.name as business_name, b.code as business_code, b.phone as business_phone,
           (select string_agg(distinct pr.name, ', ') from product_items i join products pr on pr.id = i.product_id where i.id = any(o.item_ids)) as products
      from qr_print_orders o join businesses b on b.id = o.business_id
     order by o.created_at desc limit 500) t), '[]'::json);
end $$;

create or replace function public.dq_admin_print_update(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare o qr_print_orders; em text; v_status text := p->>'status';
begin
  perform dq_require_admin();
  select email into em from auth.users where id = auth.uid();
  select * into o from qr_print_orders where id = (p->>'id')::uuid for update;
  if o.id is null then raise exception 'Print order not found'; end if;
  if v_status is not null and v_status not in ('accepted','printing','ready','delivered','rejected','cancelled') then raise exception 'Invalid status'; end if;
  if v_status in ('rejected','cancelled') and o.status in ('delivered','rejected','cancelled') then raise exception 'Order is already %', o.status; end if;
  if v_status in ('rejected','cancelled') and nullif(trim(p->>'note'),'') is null then raise exception 'Give a reason'; end if;
  if v_status in ('rejected','cancelled') and o.total_fee > 0 then
    perform dq_credit(o.business_id, 'print_refund', o.paid_amount, o.bonus_used, o.order_no, 'Print order ' || v_status || ': ' || (p->>'note'), 'DeepQr: ' || em);
  end if;
  update qr_print_orders set
    status = coalesce(v_status, status),
    promised_date = case when p ? 'promised_date' then nullif(p->>'promised_date','')::date else promised_date end,
    admin_note = case when nullif(trim(p->>'note'),'') is not null then p->>'note' else admin_note end,
    updated_at = now(),
    history = case when v_status is not null then history || jsonb_build_object('status', v_status, 'at', now(), 'by', 'DeepQr', 'note', nullif(p->>'note',''))
                   else history end
  where id = o.id returning * into o;
  perform dq_audit('print.' || coalesce(v_status, 'update'), 'print_order', o.id::text, p);
  return row_to_json(o);
end $$;

create or replace function public.dq_admin_print_labels(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare o qr_print_orders; b businesses;
begin
  perform dq_require_admin();
  select * into o from qr_print_orders where id = p_id;
  if o.id is null then raise exception 'Print order not found'; end if;
  select * into b from businesses where id = o.business_id;
  return json_build_object('order', row_to_json(o), 'business', json_build_object('name', b.name, 'code', b.code, 'phone', b.phone),
    'labels', coalesce((select json_agg(json_build_object('serial', i.serial, 'payload', i.qr_payload, 'status', i.status,
              'product', pr.name, 'code', pr.code, 'price', pr.price, 'unit', pr.unit, 'shop', s.name, 'shop_code', s.code,
              'expiry', i.expiry_date, 'batch', i.batch_ref) order by i.serial)
       from product_items i join products pr on pr.id = i.product_id left join shops s on s.id = i.shop_id
      where i.id = any(o.item_ids)), '[]'::json));
end $$;

-- -----------------------------------------------------------------------------
-- 9. analysis-ready export: one flat table of every movement of goods and money
-- -----------------------------------------------------------------------------
create or replace function public.dq_export(p jsonb) returns json
language plpgsql stable security definer set search_path = public as $$
declare m members := dq_me(); bz businesses;
        v_from date := coalesce(nullif(p->>'from','')::date, current_date - 29);
        v_to date := coalesce(nullif(p->>'to','')::date, current_date);
        v_shop uuid := nullif(p->>'shop_id','')::uuid;
        v_types text[]; v_groups text[]; v_rows json; v_n int;
begin
  if m.id is null then raise exception 'Not signed in to a business'; end if;
  if not coalesce((dq_perms(m)->>'can_view_reports')::boolean, false) then raise exception 'You are not allowed to download business data'; end if;
  if m.role = 'cashier' then v_shop := m.shop_id; end if;
  if v_to < v_from then raise exception 'The end date is before the start date'; end if;
  if v_to - v_from > 731 then raise exception 'Choose a period of at most 2 years'; end if;
  select * into bz from businesses where id = m.business_id;
  select coalesce(array_agg(x), array['sale','payment','refund','purchase','damaged','supplier_payment','expense','adjustment','transfer','qr_fee','stock'])
    into v_types from jsonb_array_elements_text(case when jsonb_typeof(p->'types') = 'array' then p->'types' else '[]'::jsonb end) x;
  select array_agg(x) into v_groups from jsonb_array_elements_text(case when jsonb_typeof(p->'groups') = 'array' then p->'groups' else '[]'::jsonb end) x;

  with
  pr as (select p.*, coalesce(g.name, '') as group_name from products p left join dq_groups g on g.code = p.group_code where p.business_id = m.business_id),
  sh as (select id, name from shops where business_id = m.business_id),
  r as (
    -- sales (one row per receipt line, net of returns, discount spread over lines)
    select s.created_at as ts, 'Sale' as type, s.shop_id, l.product_id, l.name as pname, l.code as pcode,
           0::numeric as qty_in, (l.qty - l.refunded_qty) as qty_out, l.price as unit_price,
           round((l.qty - l.refunded_qty) * l.price * (1 + coalesce(l.tax,0)/100)
                 * case when s.subtotal + s.tax > 0 then s.total / (s.subtotal + s.tax) else 1 end, 2) as value,
           round((l.qty - l.refunded_qty) * coalesce(l.cost, pp.cost, 0), 2) as cost,
           0::numeric as money_in, 0::numeric as money_out, s.payment as method,
           coalesce(c.name, nullif(s.customer,''), 'Walk-in') as party, s.cashier_name as staff, s.receipt as reference,
           s.payment_status || case when l.refunded_qty > 0 then ' · ' || l.refunded_qty || ' returned' else '' end as status,
           coalesce(s.note,'') as notes, l.serial
      from sales s join sale_lines l on l.sale_id = s.id left join pr pp on pp.id = l.product_id left join customers c on c.id = s.customer_id
     where 'sale' = any(v_types) and s.business_id = m.business_id
       and (s.created_at at time zone bz.timezone)::date between v_from and v_to
    union all
    -- money received at the till and debt payments; refunds paid out
    select sp.created_at, case when sp.kind = 'refund' then 'Refund paid' when sp.kind = 'debt_payment' then 'Debt payment' else 'Payment received' end,
           sp.shop_id, null, null, null, 0, 0, null, 0, 0,
           case when sp.amount > 0 then sp.amount else 0 end, case when sp.amount < 0 then -sp.amount else 0 end,
           sp.method, coalesce(c.name, 'Walk-in'), sp.by_name, coalesce(s.receipt, sp.reference), '', coalesce(sp.reference,''), null
      from sale_payments sp left join customers c on c.id = sp.customer_id left join sales s on s.id = sp.sale_id
     where ((sp.kind <> 'refund' and 'payment' = any(v_types)) or (sp.kind = 'refund' and 'refund' = any(v_types)))
       and sp.business_id = m.business_id and (sp.created_at at time zone bz.timezone)::date between v_from and v_to
    union all
    -- goods received (purchase orders and quick stock-in)
    select pu.created_at, 'Stock received', pu.shop_id, pu.product_id, pp.name, pp.code, pu.qty, 0, pu.cost,
           round(pu.qty * pu.cost, 2), round(pu.qty * pu.cost, 2), 0, 0, null, nullif(pu.supplier,''), pu.by_name, pu.ref, '',
           case when pu.expiry_date is not null then 'expiry ' || pu.expiry_date else '' end, null
      from purchases pu left join pr pp on pp.id = pu.product_id
     where 'purchase' = any(v_types) and pu.business_id = m.business_id and coalesce(pu.date, (pu.created_at at time zone bz.timezone)::date) between v_from and v_to
    union all
    -- damaged / rejected on delivery
    select r.received_at, 'Damaged on delivery', r.shop_id, rl.product_id, pp.name, pp.code, 0, rl.qty_damaged, rl.unit_cost,
           round(rl.qty_damaged * rl.unit_cost, 2), round(rl.qty_damaged * rl.unit_cost, 2), 0, 0, null, o.supplier_name, r.received_by,
           r.grn_no || ' / ' || coalesce(o.order_no,''), 'not added to stock', coalesce(r.note,''), null
      from order_receipt_lines rl join order_receipts r on r.id = rl.receipt_id join orders o on o.id = r.order_id left join pr pp on pp.id = rl.product_id
     where 'damaged' = any(v_types) and rl.business_id = m.business_id and rl.qty_damaged > 0
       and (r.received_at at time zone bz.timezone)::date between v_from and v_to
    union all
    -- supplier payments
    select (spy.paid_on::timestamp at time zone bz.timezone), 'Supplier payment', null, null, null, null, 0, 0, null, 0, 0, 0, spy.amount,
           spy.method, su.name, spy.by_name, coalesce(o.order_no, spy.reference), '', coalesce(spy.reference,'') || coalesce(' ' || spy.note, ''), null
      from supplier_payments spy left join suppliers su on su.id = spy.supplier_id left join orders o on o.id = spy.order_id
     where 'supplier_payment' = any(v_types) and spy.business_id = m.business_id and spy.paid_on between v_from and v_to
    union all
    -- expenses
    select (e.date::timestamp at time zone bz.timezone), 'Expense', e.shop_id, null, e.category, null, 0, 0, null, 0, 0, 0, e.amount,
           null, null, e.by_name, null, '', coalesce(e.description,''), null
      from expenses e
     where 'expense' = any(v_types) and e.business_id = m.business_id and e.date between v_from and v_to
    union all
    -- stock corrections
    select a.created_at, 'Stock correction', a.shop_id, a.product_id, pp.name, pp.code,
           greatest(a.new_qty - a.old_qty, 0), greatest(a.old_qty - a.new_qty, 0), pp.cost,
           round((a.new_qty - a.old_qty) * coalesce(pp.cost, 0), 2), round(abs(a.new_qty - a.old_qty) * coalesce(pp.cost, 0), 2),
           0, 0, null, null, a.by_name, null, '', coalesce(a.reason,''), null
      from adjustments a left join pr pp on pp.id = a.product_id
     where 'adjustment' = any(v_types) and a.business_id = m.business_id and coalesce(a.date, (a.created_at at time zone bz.timezone)::date) between v_from and v_to
    union all
    -- transfers (out of the sender, into the receiver)
    select t.created_at, 'Transfer out', t.from_shop, t.product_id, pp.name, pp.code, 0, t.qty, pp.cost,
           round(t.qty * coalesce(pp.cost,0), 2), round(t.qty * coalesce(pp.cost,0), 2), 0, 0, null, (select name from sh where id = t.to_shop),
           t.by_name, null, t.status, coalesce(t.note,''), null
      from transfers t left join pr pp on pp.id = t.product_id
     where 'transfer' = any(v_types) and t.business_id = m.business_id and t.status <> 'cancelled'
       and (t.created_at at time zone bz.timezone)::date between v_from and v_to
    union all
    select coalesce(t.received_at, t.created_at), 'Transfer in', t.to_shop, t.product_id, pp.name, pp.code, coalesce(t.received_qty, t.qty), 0, pp.cost,
           round(coalesce(t.received_qty, t.qty) * coalesce(pp.cost,0), 2), round(coalesce(t.received_qty, t.qty) * coalesce(pp.cost,0), 2), 0, 0, null,
           (select name from sh where id = t.from_shop), coalesce(t.received_by, t.by_name), null, t.status, coalesce(t.note,''), null
      from transfers t left join pr pp on pp.id = t.product_id
     where 'transfer' = any(v_types) and t.business_id = m.business_id and t.status = 'completed'
       and (coalesce(t.received_at, t.created_at) at time zone bz.timezone)::date between v_from and v_to
    union all
    -- DeepQr label fees (money actually paid from the wallet; bonus and free labels noted)
    select w.created_at, 'DeepQr fee', null, null, case when w.type like 'print%' then 'Label printing' else 'QR labels' end, null, 0, 0, null, 0, 0,
           case when w.amount > 0 then w.amount else 0 end, case when w.amount < 0 then -w.amount else 0 end, 'QR wallet', 'DeepQr', w.by_name,
           w.reference, w.type, coalesce(w.note,'') || case when w.bonus_amount <> 0 then ' · bonus ' || -w.bonus_amount else '' end
                                || case when w.free_count > 0 then ' · ' || w.free_count || ' free' else '' end, null
      from wallet_transactions w
     where 'qr_fee' = any(v_types) and w.business_id = m.business_id and w.type in ('qr_charge','print_charge','print_refund')
       and (w.created_at at time zone bz.timezone)::date between v_from and v_to
    union all
    -- stock on hand today (snapshot)
    select now(), 'Stock on hand', sl.shop_id, sl.product_id, pp.name, pp.code, sl.qty, 0, pp.price,
           round(sl.qty * coalesce(pp.price,0), 2), round(sl.qty * coalesce(pp.cost,0), 2), 0, 0, null, null, null, null,
           case when sl.qty <= 0 then 'out' when sl.qty <= coalesce(pp.low_stock, bz.low_stock, 0) then 'low' else 'ok' end,
           'labelled ' || (select count(*) from product_items i where i.product_id = sl.product_id and i.shop_id = sl.shop_id and i.status = 'in_stock'), null
      from stock_levels sl join pr pp on pp.id = sl.product_id
     where 'stock' = any(v_types) and sl.business_id = m.business_id
  )
  select json_agg(json_build_object(
           'date', to_char(r.ts at time zone bz.timezone, 'YYYY-MM-DD'), 'time', to_char(r.ts at time zone bz.timezone, 'HH24:MI'),
           'type', r.type, 'location', coalesce(sh.name, ''), 'product', coalesce(r.pname, ''), 'code', coalesce(r.pcode, ''),
           'category', coalesce(pp.category, case when r.type = 'Expense' or r.type = 'DeepQr fee' then r.pname else '' end),
           'group', coalesce(pp.group_name, ''), 'unit', coalesce(pp.unit, ''),
           'qty_in', r.qty_in, 'qty_out', r.qty_out, 'unit_price', r.unit_price, 'value', r.value, 'cost', r.cost,
           'profit', case when r.type = 'Sale' then r.value - r.cost else null end,
           'money_in', r.money_in, 'money_out', r.money_out, 'method', coalesce(r.method, ''), 'party', coalesce(r.party, ''),
           'staff', coalesce(r.staff, ''), 'reference', coalesce(r.reference, ''), 'status', coalesce(r.status, ''),
           'notes', coalesce(r.notes, ''), 'serial', coalesce(r.serial, '')) order by r.ts, r.type), count(*)
    into v_rows, v_n
    from r left join pr pp on pp.id = r.product_id left join sh on sh.id = r.shop_id
   where (v_shop is null or r.shop_id = v_shop or r.shop_id is null and m.role <> 'cashier')
     and (v_groups is null or pp.group_code = any(v_groups) or (r.product_id is null and 'none' = any(v_groups)));
  if v_n > 100000 then raise exception 'EXPORT_TOO_BIG: % rows — choose a shorter period or fewer data types', v_n; end if;
  return json_build_object('business', bz.name, 'business_code', bz.code, 'currency', bz.currency, 'timezone', bz.timezone,
    'from', v_from, 'to', v_to, 'shop', (select name from shops where id = v_shop), 'generated_at', now(), 'generated_by', m.name,
    'rows', coalesce(v_rows, '[]'::json));
end $$;

-- platform settings now include label printing
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
    print_fee_per_label = greatest(coalesce((p->>'print_fee_per_label')::numeric, print_fee_per_label), 0),
    print_delivery_fee = greatest(coalesce((p->>'print_delivery_fee')::numeric, print_delivery_fee), 0),
    print_lead_days = greatest(coalesce((p->>'print_lead_days')::int, print_lead_days), 0),
    print_note = coalesce(p->>'print_note', print_note),
    updated_at = now(), updated_by = em
  where id = 1;
  perform dq_audit('settings.update', 'platform', '1', p);
  return (select row_to_json(s) from platform_settings s where id = 1);
end $$;


-- -----------------------------------------------------------------------------
-- 10. permissions
-- -----------------------------------------------------------------------------
revoke all on function public.dq_charge_amount(uuid, numeric, text, text, text, text) from public, anon, authenticated;
revoke all on function public.dq_catalog_next_code(text) from public, anon, authenticated;
revoke all on function public.dq_random_barcode() from public, anon;
do $$ declare f text; begin
  foreach f in array array[
    'dq_set_business_groups(text[],text[])','dq_adopt_catalog(jsonb)','dq_submit_catalog_product(jsonb)','dq_admin_save_catalog(jsonb)',
    'dq_request_print(jsonb)','dq_cancel_print(uuid)','dq_admin_print_orders()','dq_admin_print_update(jsonb)','dq_admin_print_labels(uuid)',
    'dq_export(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
grant select on public.catalog_products, public.qr_print_orders to authenticated;
