/* In-memory stand-in for supabase-js used by the browser test-suite (tests/e2e_test.py).
   It mimics the tables and the DeepQr RPCs closely enough to drive every screen,
   without touching the real Supabase project. */
(function(){
  const uid=()=> 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16)});
  const now=()=>new Date().toISOString();
  const today=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
  const plus=n=>{const d=new Date();d.setDate(d.getDate()+n);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
  const BIZ='b0000000-0000-4000-8000-000000000001', SHOP='s0000000-0000-4000-8000-000000000001', STORE='s0000000-0000-4000-8000-000000000002';
  const OWNER='u0000000-0000-4000-8000-000000000001', CASHIER='u0000000-0000-4000-8000-000000000002', ADMIN='u0000000-0000-4000-8000-000000000009';
  const P1='p0000000-0000-4000-8000-000000000001', P2='p0000000-0000-4000-8000-000000000002', P3='p0000000-0000-4000-8000-000000000003';
  const db={
    users:[{id:OWNER,email:'owner@zanrizon.test',password:'secret1'},{id:CASHIER,email:'asha.b0000000@staff.local',password:'secret1'},{id:ADMIN,email:'mohdabdull129@gmail.com',password:'secret1'}],
    platform_admins:[{email:'mohdabdull129@gmail.com',auth_user_id:null,code:'ABCD-EFGH-JKLM'}],
    platform_settings:[{id:1,qr_fee:25,currency:'TZS',min_topup:1000,welcome_credit:0,allow_negative_balance:false,payment_instructions:'Pay to M-Pesa 0777 000 000 (DeepQr), then submit the reference.',updated_at:now()}],
    businesses:[{id:BIZ,name:'Zanrizon Traders',short:'ZAN',code:'ZT',currency:'TZS',tax:0,low_stock:5,receipt_footer:'Asante kwa kununua!',phone:'0777 123 456',email:'',address:'Darajani, Zanzibar',owner_auth_id:OWNER,expiry_alert_days:30,block_expired_sales:true,device_lock:false,scan_mode:'both',created_at:now()}],
    dq_accounts:[{business_id:BIZ,status:'active',balance:2000,total_qr:0,total_spent:0}],
    members:[{id:'m1',business_id:BIZ,auth_user_id:OWNER,name:'Mohammed Abdulla',role:'owner',shop_id:null,theme:'light'},{id:'m2',business_id:BIZ,auth_user_id:CASHIER,name:'Asha Juma',username:'asha',role:'cashier',shop_id:SHOP,theme:'light'}],
    username_directory:[{username:'asha',email:'asha.b0000000@staff.local',business_id:BIZ}],
    shops:[{id:SHOP,business_id:BIZ,name:'Darajani Shop',type:'shop',code:'S01',created_at:now()},{id:STORE,business_id:BIZ,name:'Main Store',type:'warehouse',code:'S02',created_at:now()}],
    categories:[{id:'c1',business_id:BIZ,name:'Electronics'},{id:'c2',business_id:BIZ,name:'Food & Beverage'}],
    products:[{id:P1,business_id:BIZ,code:'D12',name:'Dell 12',category:'Electronics',unit:'unit',cost:900000,price:1200000,tax:0,barcode:'2000000000012',active:true,product_no:12,expiry_tracking:false,created_at:now()},
              {id:P2,business_id:BIZ,code:'MLK',name:'Fresh Milk 1L',category:'Food & Beverage',unit:'bottle',cost:1800,price:2500,tax:0,barcode:'2000000000029',active:true,product_no:13,expiry_tracking:true,created_at:now()},
              {id:P3,business_id:BIZ,code:'SOAP',name:'Bar Soap',category:'Food & Beverage',unit:'bar',cost:500,price:800,tax:0,barcode:'2000000000036',active:true,product_no:14,expiry_tracking:false,created_at:now()}],
    stock_levels:[{business_id:BIZ,shop_id:SHOP,product_id:P1,qty:5},{business_id:BIZ,shop_id:SHOP,product_id:P2,qty:10},{business_id:BIZ,shop_id:SHOP,product_id:P3,qty:30},{business_id:BIZ,shop_id:STORE,product_id:P1,qty:20}],
    sales:[],sale_lines:[],purchases:[],transfers:[],adjustments:[],expenses:[],activity_log:[],orders:[],order_items:[],
    product_items:[],qr_generations:[],devices:[],topup_requests:[],wallet_transactions:[]
  };
  if(/legacy=1/.test(location.search)){ ['product_items','qr_generations','devices','topup_requests','wallet_transactions','dq_accounts','platform_settings','platform_admins'].forEach(t=>delete db[t]); }
  window.__db=db;
  const SS='mock_session';
  let session=null; try{ session=JSON.parse(sessionStorage.getItem(SS)||'null'); }catch(e){}
  const curUid=()=>session?.user?.id;
  const meRow=()=>db.members.find(m=>m.auth_user_id===curUid());
  const myBiz=()=>meRow()?.business_id;
  const scoped=new Set(['shops','categories','products','stock_levels','sales','sale_lines','purchases','transfers','adjustments','expenses','activity_log','members','orders','order_items','product_items','qr_generations','devices','topup_requests','wallet_transactions','dq_accounts']);
  const defaults={sales:{status:'completed',discount:0},purchases:{date:today()},transfers:{date:today()},adjustments:{date:today()},expenses:{},businesses:{currency:'USD',tax:0,low_stock:10,expiry_alert_days:30,block_expired_sales:true,device_lock:false,scan_mode:'both'}};
  const err=m=>({data:null,error:{message:m}});

  class Q{
    constructor(t){this.t=t;this.op='select';this.f=[];this.ord=null;this.lim=null;this.one=null;this.payload=null;this.ret=false}
    select(){ if(this.op!=='select') this.ret=true; return this }
    insert(p){this.op='insert';this.payload=p;return this}
    upsert(p){this.op='upsert';this.payload=p;return this}
    update(p){this.op='update';this.payload=p;return this}
    delete(){this.op='delete';return this}
    eq(k,v){this.f.push(r=>String(r[k])===String(v));return this}
    order(k,o){this.ord=[k,o?.ascending!==false];return this}
    limit(n){this.lim=n;return this}
    single(){this.one='single';return this}
    maybeSingle(){this.one='maybe';return this}
    then(res){ let out; try{ out=this.run(); }catch(e){ out=err(e.message); } res(out); }  // supabase-js never rejects: it returns {error}
    rows(){ let r=db[this.t]; if(!r) throw new Error('relation "'+this.t+'" does not exist');
      if(scoped.has(this.t)) r=r.filter(x=>x.business_id===myBiz());
      if(this.t==='businesses') r=r.filter(x=>x.id===myBiz()||x.owner_auth_id===curUid());
      if(this.t==='platform_settings'&&!curUid()) r=[];
      return r.filter(x=>this.f.every(fn=>fn(x))); }
    run(){
      if(!curUid()&&this.t!=='username_directory') return {data:this.one?null:[],error:null};
      if(this.op==='select'){ let r=this.rows().map(x=>({...x}));
        if(this.ord){const [k,a]=this.ord; r.sort((x,y)=>(x[k]>y[k]?1:x[k]<y[k]?-1:0)*(a?1:-1));}
        if(this.lim) r=r.slice(0,this.lim);
        if(this.t==='product_items') r=r.map(({code,...x})=>x);
        return this.fin(r); }
      if(this.op==='insert'||this.op==='upsert'){ const arr=(Array.isArray(this.payload)?this.payload:[this.payload]).map(p=>({id:uid(),created_at:now(),...(defaults[this.t]||{}),...p}));
        for(const r of arr){
          if(['product_items','dq_accounts','wallet_transactions','qr_generations','devices','topup_requests'].includes(this.t)) return err('new row violates row-level security policy for table "'+this.t+'"');
          if(scoped.has(this.t)&&r.business_id!==myBiz()&&!(this.t==='members'&&r.auth_user_id===curUid())) return err('new row violates row-level security policy');
          if(this.t==='businesses'){ r.code=r.code||(r.name.replace(/[^A-Za-z]/g,'').slice(0,3).toUpperCase()); db.dq_accounts.push({business_id:r.id,status:'active',balance:db.platform_settings[0].welcome_credit,total_qr:0,total_spent:0}); }
          if(this.t==='shops'&&!r.code){ const n=db.shops.filter(s=>s.business_id===r.business_id).length+1; r.code='S'+String(n).padStart(2,'0'); }
          if(this.t==='products'){ if(db.products.some(p=>p.business_id===r.business_id&&p.code===r.code)) return err('duplicate key value'); r.product_no=Math.max(0,...db.products.filter(p=>p.business_id===r.business_id).map(p=>p.product_no||0))+1; }
          if(this.op==='upsert'&&this.t==='stock_levels'){ const ex=db.stock_levels.find(s=>s.shop_id===r.shop_id&&s.product_id===r.product_id); if(ex){ Object.assign(ex,r); continue; } delete r.id; delete r.created_at; }
          db[this.t].push(r);
        }
        return this.fin(arr.map(x=>({...x}))); }
      if(this.op==='update'){ const r=this.rows(); let p={...this.payload}; if(this.t==='businesses') delete p.code; if(this.t==='dq_accounts') return {data:[],error:null}; r.forEach(x=>Object.assign(x,p)); return this.fin(r.map(x=>({...x}))); }
      if(this.op==='delete'){ const r=this.rows(); db[this.t]=db[this.t].filter(x=>!r.includes(x)); return {data:null,error:null}; }
    }
    fin(r){ if(this.one==='single') return r.length?{data:r[0],error:null}:err('no rows'); if(this.one==='maybe') return {data:r[0]||null,error:null}; return {data:r,error:null}; }
  }

  const H=k=>{let h=0;for(const c of String(k||''))h=(h*31+c.charCodeAt(0))|0;return 'h'+h};
  const raise=m=>{throw new Error(m)};
  const acct=()=>db.dq_accounts.find(a=>a.business_id===myBiz());
  const isAdm=()=>db.platform_admins.some(a=>a.auth_user_id&&a.auth_user_id===curUid());
  const biz=()=>db.businesses.find(b=>b.id===myBiz());
  const checkDevice=(shop,key)=>{const b=biz(); const d=db.devices.find(x=>x.business_id===b.id&&x.key_hash===H(key)); if(d) d.last_seen=now(); if(!b.device_lock) return d?.id||null;
    if(!d) raise('DEVICE_NOT_REGISTERED: this device is not registered for scanning'); if(d.status!=='approved') raise('DEVICE_NOT_APPROVED: this device is '+d.status); if(d.shop_id&&shop&&d.shop_id!==shop) raise('DEVICE_WRONG_SHOP: this device is authorised for another shop'); return d.id;};
  const active=()=>{ if(acct()?.status==='suspended') raise('ACCOUNT_SUSPENDED: this business account is suspended by DeepQr'); };
  const stockRow=(s,p)=>db.stock_levels.find(x=>x.shop_id===s&&x.product_id===p);
  const log=(type,d)=>db.activity_log.push({id:uid(),business_id:myBiz(),type,description:d,by_name:meRow()?.name,created_at:now()});

  const RPC={
    dq_is_platform_admin:()=>isAdm(),
    dq_claim_platform_admin:({p_code})=>{ if(isAdm()) return true; const u=db.users.find(x=>x.id===curUid()); const a=db.platform_admins.find(x=>!x.auth_user_id&&x.email===u.email&&x.code===String(p_code||'').trim().toUpperCase()); if(!a) return false; a.auth_user_id=u.id; return true; },
    dq_qr_recommendations:()=>{ const fee=db.platform_settings[0].qr_fee; return db.stock_levels.filter(s=>s.business_id===myBiz()).map(s=>{const t=db.product_items.filter(i=>i.product_id===s.product_id&&i.shop_id===s.shop_id&&i.status==='in_stock').length, r=Math.max(Math.ceil(s.qty)-t,0); return {product_id:s.product_id,shop_id:s.shop_id,stock_qty:s.qty,tagged:t,recommended:r,fee,est_cost:r*fee};}); },
    dq_generate_items:({p_product_id,p_shop_id,p_qty,p_expiry,p_batch})=>{
      const m=meRow(); if(!['owner','manager','inventory','main_operator'].includes(m.role)) raise('Your role cannot generate QR codes'); active();
      const p=db.products.find(x=>x.id===p_product_id&&x.business_id===m.business_id), s=db.shops.find(x=>x.id===p_shop_id); if(!p||!s) raise('Product not found');
      const st=db.platform_settings[0], a=acct(), total=p_qty*st.qr_fee;
      if(!st.allow_negative_balance&&a.balance<total) raise(`INSUFFICIENT_BALANCE: ${p_qty} QR codes cost ${total} ${st.currency}, wallet balance is ${a.balance} ${st.currency}. Please top up.`);
      const yr=new Date().getFullYear(), start=Math.max(0,...db.product_items.filter(i=>i.product_id===p.id&&i.serial_year===yr).map(i=>i.serial_seq));
      const g={id:uid(),business_id:m.business_id,product_id:p.id,shop_id:s.id,qty:p_qty,fee_per_qr:st.qr_fee,total,expiry_date:p_expiry,batch_ref:p_batch,by_name:m.name,created_at:now()};
      for(let i=1;i<=p_qty;i++){ const ser=`${yr}${String(p.product_no).padStart(2,'0')}${String(start+i).padStart(3,'0')}`; if(i===1) g.first_serial=ser; g.last_serial=ser;
        db.product_items.push({id:uid(),business_id:m.business_id,product_id:p.id,shop_id:s.id,generation_id:g.id,serial:ser,serial_year:yr,serial_seq:start+i,qr_payload:`DQ1|${biz().code}|${s.code}|${p.code}|${ser}`,status:'in_stock',expiry_date:p_expiry||null,batch_ref:p_batch||null,created_at:now()}); }
      db.qr_generations.push(g); a.balance-=total; a.total_qr+=p_qty; a.total_spent+=total;
      db.wallet_transactions.push({id:uid(),business_id:m.business_id,type:'qr_charge',amount:-total,balance_after:a.balance,reference:g.first_serial+'…'+g.last_serial,note:`${p_qty} QR code(s) for ${p.name} @ ${st.qr_fee}`,by_name:m.name,created_at:now()});
      if(p_expiry) p.expiry_tracking=true; log('qr',`${p_qty} QR code(s) generated for ${p.name}`);
      return {generation_id:g.id,qty:p_qty,first_serial:g.first_serial,last_serial:g.last_serial,total,balance:a.balance,currency:st.currency};
    },
    dq_lookup_item:({p_code,p_shop_id,p_device_key})=>{
      checkDevice(p_shop_id,p_device_key); const b=biz(), v=String(p_code||'').trim(); let it;
      if(v.startsWith('DQ1|')){ const parts=v.split('|'); if(parts[1]!==b.code) return {ok:false,reason:'OTHER_BUSINESS',message:'This QR belongs to another business ('+parts[1]+').'}; it=db.product_items.find(i=>i.qr_payload===v); }
      else it=db.product_items.find(i=>i.business_id===b.id&&i.serial===v.replace(/^.*-/,''));
      if(!it) return {ok:false,reason:'NOT_FOUND'};
      const exp=!!(it.expiry_date&&it.expiry_date<today());
      return {ok:it.status==='in_stock'&&!(b.block_expired_sales&&exp),reason:it.status==='sold'?'SOLD':it.status==='void'?'VOID':exp?'EXPIRED':null,item:{...it},product:{...db.products.find(p=>p.id===it.product_id)},expired:exp,other_shop:!!p_shop_id&&it.shop_id!==p_shop_id};
    },
    dq_checkout:({p_shop_id,p_lines,p_customer,p_phone,p_payment,p_discount,p_paid,p_device_key,p_date,p_time})=>{
      const m=meRow(), b=biz(); if(m.role==='cashier'&&m.shop_id&&m.shop_id!==p_shop_id) raise('Cashiers can only sell at their own shop'); if(!p_lines.length) raise('Cart is empty'); active();
      const dev=checkDevice(p_shop_id,p_device_key); const out=[]; let sub=0,tx=0;
      for(const ln of p_lines){ let p,qty,price,it=null;
        if(ln.item_id){ it=db.product_items.find(i=>i.id===ln.item_id&&i.business_id===b.id); if(!it) raise('ITEM_NOT_FOUND'); if(it.status!=='in_stock') raise('ITEM_ALREADY_SOLD: '+it.serial+' is already '+it.status);
          if(b.block_expired_sales&&it.expiry_date&&it.expiry_date<today()) raise('ITEM_EXPIRED: '+it.serial+' expired on '+it.expiry_date); p=db.products.find(x=>x.id===it.product_id); qty=1; price=Number(p.price); }
        else { p=db.products.find(x=>x.id===ln.product_id); if(!p) raise('PRODUCT_NOT_FOUND'); qty=Number(ln.qty); price=Number(ln.price??p.price); }
        out.push({product_id:p.id,item_id:it?.id||null,serial:it?.serial||null,name:p.name,code:p.code,qty,price,tax:Number(p.tax||0)}); sub+=qty*price; tx+=qty*price*(p.tax||0)/100; }
      const byP={}; out.forEach(l=>byP[l.product_id]=(byP[l.product_id]||0)+l.qty);
      for(const [pid,q] of Object.entries(byP)){ const have=Number(stockRow(p_shop_id,pid)?.qty||0); if(have<q) raise(`NOT_ENOUGH_STOCK: only ${have} of ${db.products.find(x=>x.id===pid).name} in stock at this shop`); }
      const disc=Math.max(0,Number(p_discount||0)), tot=Math.round((sub+tx-disc)*100)/100; if(tot<0) raise('Discount is larger than the total'); if(p_paid!=null&&p_payment==='Cash'&&p_paid<tot) raise('Amount paid is less than the total');
      const d=p_date||today(), n=db.sales.filter(s=>s.business_id===b.id&&s.date===d).length+1;
      const sale={id:uid(),business_id:b.id,shop_id:p_shop_id,receipt:`${b.code}-${d.slice(2).replace(/-/g,'')}-${String(n).padStart(4,'0')}`,date:d,time:p_time,subtotal:sub,tax:tx,total:tot,payment:p_payment,customer:p_customer||'Walk-in',customer_phone:p_phone,cashier_name:m.name,discount:disc,amount_paid:p_paid,change_due:p_paid==null?null:p_paid-tot,device_id:dev,status:'completed',created_at:now()};
      db.sales.push(sale); const lines=out.map(l=>({id:uid(),sale_id:sale.id,business_id:b.id,...l})); db.sale_lines.push(...lines);
      out.filter(l=>l.item_id).forEach(l=>{const it=db.product_items.find(i=>i.id===l.item_id); it.status='sold'; it.sale_id=sale.id; it.sold_at=now(); it.shop_id=p_shop_id;});
      Object.entries(byP).forEach(([pid,q])=>stockRow(p_shop_id,pid).qty-=q); log('sale','Sale '+sale.receipt);
      return {sale:{...sale},lines:lines.map(x=>({...x}))};
    },
    dq_refund_sale:({p_sale_id,p_reason})=>{ const m=meRow(); if(!['owner','manager'].includes(m.role)) raise('Only owners and managers can refund sales'); const s=db.sales.find(x=>x.id===p_sale_id); if(!s) raise('Sale not found'); if(s.status==='refunded') raise('Sale already refunded');
      db.sale_lines.filter(l=>l.sale_id===s.id).forEach(l=>{ if(l.item_id){const it=db.product_items.find(i=>i.id===l.item_id); it.status='in_stock'; it.sale_id=null;} const r=stockRow(s.shop_id,l.product_id); if(r) r.qty+=Number(l.qty); else db.stock_levels.push({business_id:s.business_id,shop_id:s.shop_id,product_id:l.product_id,qty:Number(l.qty)}); });
      s.status='refunded'; s.refund_reason=p_reason; return {ok:true}; },
    dq_void_items:({p_item_ids})=>{ let n=0; db.product_items.forEach(i=>{ if(p_item_ids.includes(i.id)&&i.status==='in_stock'){ i.status='void'; n++; } }); return n; },
    dq_register_device:({p_key,p_name,p_kind,p_shop_id,p_ua})=>{ const m=meRow(); let d=db.devices.find(x=>x.business_id===m.business_id&&x.key_hash===H(p_key));
      if(!d){ d={id:uid(),business_id:m.business_id,shop_id:p_shop_id||m.shop_id||null,key_hash:H(p_key),name:p_name,kind:p_kind,status:m.role==='owner'?'approved':'pending',user_agent:p_ua,registered_by:m.name,last_seen:now(),created_at:now()}; db.devices.push(d); }
      return {id:d.id,name:d.name,kind:d.kind,status:d.status,shop_id:d.shop_id}; },
    dq_device_status:({p_key})=>{ const m=meRow(); if(!m) return null; const d=db.devices.find(x=>x.business_id===m.business_id&&x.key_hash===H(p_key)); return d?{id:d.id,name:d.name,kind:d.kind,status:d.status,shop_id:d.shop_id}:null; },
    dq_update_device:({p_id,p_status,p_kind,p_shop_id,p_delete})=>{ if(!['owner','manager'].includes(meRow().role)) raise('Only owners and managers manage devices'); if(p_delete){ db.devices=db.devices.filter(d=>d.id!==p_id); return null; } const d=db.devices.find(x=>x.id===p_id); Object.assign(d,{status:p_status,kind:p_kind||d.kind,shop_id:p_shop_id}); return null; },
    dq_request_topup:({p_amount,p_method,p_reference})=>{ const st=db.platform_settings[0]; if(p_amount<st.min_topup) raise(`Minimum top-up is ${st.min_topup} ${st.currency}`); const r={id:uid(),business_id:myBiz(),amount:p_amount,method:p_method,reference:p_reference,status:'pending',requested_by:meRow().name,created_at:now()}; db.topup_requests.push(r); return {...r}; },
    dq_admin_overview:()=>{ if(!isAdm()) raise('Platform owner access only');
      return {settings:{...db.platform_settings[0]},
        businesses:db.businesses.map(b=>{const a=db.dq_accounts.find(x=>x.business_id===b.id)||{}; const s=db.sales.filter(x=>x.business_id===b.id&&x.status!=='refunded'); return {...b,owner_email:db.users.find(u=>u.id===b.owner_auth_id)?.email,owner_name:db.members.find(m=>m.business_id===b.id&&m.role==='owner')?.name,status:a.status,balance:a.balance,total_qr:a.total_qr,total_spent:a.total_spent,shops:db.shops.filter(x=>x.business_id===b.id).length,staff:db.members.filter(x=>x.business_id===b.id).length,products:db.products.filter(x=>x.business_id===b.id).length,items_in_stock:db.product_items.filter(i=>i.business_id===b.id&&i.status==='in_stock').length,items_sold:db.product_items.filter(i=>i.business_id===b.id&&i.status==='sold').length,sales_count:s.length,sales_total:s.reduce((x,y)=>x+y.total,0),sales_30d:s.reduce((x,y)=>x+y.total,0),last_active:now(),devices:0};}),
        topups:db.topup_requests.map(t=>({...t,business_name:db.businesses.find(b=>b.id===t.business_id)?.name,business_code:db.businesses.find(b=>b.id===t.business_id)?.code})).reverse(),
        ledger:db.wallet_transactions.map(w=>({...w,business_name:db.businesses.find(b=>b.id===w.business_id)?.name})).reverse(),
        qr_by_month:db.qr_generations.length?[{month:new Date().toISOString().slice(0,7),qrs:db.qr_generations.reduce((a,g)=>a+g.qty,0),revenue:db.qr_generations.reduce((a,g)=>a+g.total,0)}]:[]}; },
    dq_admin_update_settings:({p_fee,p_currency,p_min_topup,p_welcome_credit,p_allow_negative,p_instructions})=>{ if(!isAdm()) raise('Platform owner access only'); Object.assign(db.platform_settings[0],{qr_fee:p_fee,currency:p_currency,min_topup:p_min_topup,welcome_credit:p_welcome_credit,allow_negative_balance:p_allow_negative,payment_instructions:p_instructions,updated_at:now()}); return {...db.platform_settings[0]}; },
    dq_admin_adjust_wallet:({p_business,p_amount,p_note})=>{ if(!isAdm()) raise('Platform owner access only'); const a=db.dq_accounts.find(x=>x.business_id===p_business); a.balance+=p_amount; db.wallet_transactions.push({id:uid(),business_id:p_business,type:'adjustment',amount:p_amount,balance_after:a.balance,note:p_note,by_name:'DeepQr',created_at:now()}); return a.balance; },
    dq_admin_review_topup:({p_id,p_approve,p_note})=>{ if(!isAdm()) raise('Platform owner access only'); const r=db.topup_requests.find(x=>x.id===p_id); if(r.status!=='pending') raise('Request already '+r.status);
      if(p_approve){ const a=db.dq_accounts.find(x=>x.business_id===r.business_id); a.balance+=r.amount; db.wallet_transactions.push({id:uid(),business_id:r.business_id,type:'topup',amount:r.amount,balance_after:a.balance,reference:r.reference,note:'Top-up via '+r.method,by_name:'DeepQr',created_at:now()}); }
      r.status=p_approve?'approved':'rejected'; r.review_note=p_note; return {...r}; },
    dq_admin_set_status:({p_business,p_status,p_note})=>{ if(!isAdm()) raise('Platform owner access only'); Object.assign(db.dq_accounts.find(x=>x.business_id===p_business),{status:p_status,status_note:p_note}); return null; },
  };

  function client(){
    return {
      from:t=>new Q(t),
      rpc:async(name,args)=>{ if(!curUid()) return err('not authenticated'); const fn=/legacy=1/.test(location.search)?null:RPC[name]; if(!fn) return err('function '+name+' does not exist');
        try{ return {data:JSON.parse(JSON.stringify(fn(args||{})??null)),error:null}; }catch(e){ return err(e.message); } },
      auth:{
        getSession:async()=>({data:{session}}),
        signInWithPassword:async({email,password})=>{ const u=db.users.find(x=>x.email===email&&x.password===password); if(!u) return {data:{},error:{message:'Invalid login credentials'}}; session={user:{id:u.id,email:u.email}}; sessionStorage.setItem(SS,JSON.stringify(session)); return {data:{session},error:null}; },
        signUp:async({email,password})=>{ if(db.users.some(x=>x.email===email)) return {data:{},error:{message:'User already registered'}}; const u={id:uid(),email,password}; db.users.push(u); const s={user:{id:u.id,email}}; if(!email.endsWith('@staff.local')){ session=s; sessionStorage.setItem(SS,JSON.stringify(s)); } return {data:{session:s,user:{id:u.id}},error:null}; },
        signOut:async()=>{ session=null; sessionStorage.removeItem(SS); return {error:null}; }
      }
    };
  }
  window.supabase={createClient:client};
})();
