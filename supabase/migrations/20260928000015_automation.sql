-- =====================================================================
--  0015 · Otomasyon: borç hesaplama · otomatik asgari ödeme · otomatik ödeme · toplu içe aktarma
--   • card_rate_tiers + _rate_tier():  dönem borcuna göre akdi/gecikme faiz oranı (kullanıcı düzenler)
--   • profiles.min_rule_*  +  credit_card_details.min_payment_auto:  limite göre otomatik asgari ödeme oranı
--   • card_debt_plan():    kart başına ekstre borcu, asgari, kalan, vade, tahmini faiz maliyeti
--   • autopay_pending / apply_autopay / process_autopay / run_autopay_all:  otomatik ödeme
--   • set_card_automation():  kart ayarları
--   • import_transactions():  Excel / yapıştırma / hızlı giriş ile toplu işlem (çift kayda karşı korumalı)
-- =====================================================================

-- ---------- Ayarlar -------------------------------------------------------
alter table profiles
  add column if not exists min_rule_limit numeric(14,2) not null default 50000 check (min_rule_limit > 0),
  add column if not exists min_rule_low   numeric(5,2)  not null default 20 check (min_rule_low between 0 and 100),
  add column if not exists min_rule_high  numeric(5,2)  not null default 40 check (min_rule_high between 0 and 100);

alter table credit_card_details
  add column if not exists min_payment_auto   boolean  not null default false,
  add column if not exists autopay_mode       text     not null default 'off' check (autopay_mode in ('off', 'min', 'full', 'fixed')),
  add column if not exists autopay_account_id uuid     references accounts(id) on delete set null,
  add column if not exists autopay_fixed      numeric(14,2) check (autopay_fixed is null or autopay_fixed > 0),
  add column if not exists autopay_days_before smallint not null default 0 check (autopay_days_before between 0 and 30),
  add column if not exists autopay_record     text     not null default 'confirm' check (autopay_record in ('confirm', 'auto'));

create table if not exists card_rate_tiers (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  upto          numeric(16,2) not null check (upto > 0),            -- dönem borcu üst sınırı (dahil)
  purchase_rate numeric(6,3) not null check (purchase_rate >= 0),   -- aylık akdi faiz %
  late_rate     numeric(6,3) not null check (late_rate >= 0),       -- aylık gecikme faizi %
  unique (user_id, upto)
);
alter table card_rate_tiers enable row level security;
create policy card_rate_tiers_own on card_rate_tiers for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on card_rate_tiers to authenticated;
create index if not exists card_rate_tiers_user_idx on card_rate_tiers (user_id);

-- Kullanıcının kademesi yoksa varsayılan (düzenlenebilir) oranlar
create or replace function _rate_tier(p_uid uuid, p_amount numeric)
returns table (purchase_rate numeric, late_rate numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from card_rate_tiers where user_id = p_uid) then
    return query
      select t.purchase_rate, t.late_rate from card_rate_tiers t
      where t.user_id = p_uid and t.upto >= coalesce(p_amount, 0)
      order by t.upto limit 1;
    if found then return; end if;
    return query select t.purchase_rate, t.late_rate from card_rate_tiers t where t.user_id = p_uid order by t.upto desc limit 1;
    return;
  end if;
  return query select x.a, x.b from (values
      (30000::numeric, 3.25::numeric, 3.55::numeric), (180000, 3.75, 4.05), (1e15, 4.25, 4.55)) as v(upto, a, b)
    cross join lateral (select v.a, v.b) x
    where v.upto >= coalesce(p_amount, 0) order by v.upto limit 1;
end $$;

-- Çağıranın kendi oranları (başka kullanıcının kademesi okunamaz)
create or replace function rate_tier_for(p_amount numeric)
returns table (purchase_rate numeric, late_rate numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select * from _rate_tier(_uid(), p_amount)
$$;

-- ---------- Otomatik asgari ödeme oranı ------------------------------------
create or replace function _min_pct_rule(p_uid uuid, p_limit numeric)
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select case when coalesce(p_limit, 0) <= coalesce(p.min_rule_limit, 50000)
              then coalesce(p.min_rule_low, 20) else coalesce(p.min_rule_high, 40) end
  from (select 1) d left join profiles p on p.id = p_uid
$$;

create or replace function _ccd_min_auto()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare a accounts;
begin
  if new.min_payment_auto then
    select * into a from accounts where id = new.account_id;
    new.min_payment_pct := _min_pct_rule(a.user_id, a.credit_limit);
  end if;
  return new;
end $$;
drop trigger if exists ccd_min_auto on credit_card_details;
create trigger ccd_min_auto before insert or update on credit_card_details
  for each row execute function _ccd_min_auto();

-- Limit değişince otomatik oranı yeniden hesapla
create or replace function _acc_limit_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update credit_card_details set min_payment_auto = true where account_id = new.id and min_payment_auto;
  return new;
end $$;
drop trigger if exists accounts_limit_min_auto on accounts;
create trigger accounts_limit_min_auto after update of credit_limit on accounts
  for each row when (old.credit_limit is distinct from new.credit_limit) execute function _acc_limit_changed();

-- Kural (eşik / oranlar) değiştiğinde otomatik kartları günceller
create or replace function apply_min_payment_rule()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update credit_card_details d set min_payment_auto = true
  from accounts a where a.id = d.account_id and a.user_id = _uid() and d.min_payment_auto;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- Otomatik borç hesaplama ----------------------------------------
-- Her kredi kartı için son kesilmiş ekstre ve tahmini faiz maliyeti.
-- Tahmin: asgariyi ödeyen kalan tutara akdi faiz, ödemeyen asgari kısmına gecikme faizi (aylık). Bankanın ekstresi esastır.
create or replace function card_debt_plan()
returns table (account_id uuid, name text, last4 text, currency char(3), credit_limit numeric, debt numeric,
               cut_date date, due_date date, statement_amount numeric, min_payment numeric, paid numeric,
               remaining numeric, min_remaining numeric, days_to_due int, status text,
               purchase_rate numeric, late_rate numeric, est_interest_min numeric, est_interest_none numeric)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := _today(auth.uid());
  c       record;
  s       record;
  t       record;
  v_minrem numeric;
begin
  for c in select b.id, b.name, b.iban_last4, b.currency, b.credit_limit, b.balance
           from v_account_balances b
           where b.kind = 'credit_card' and b.archived_at is null order by b.sort_order, b.name loop
    account_id := c.id; name := c.name; last4 := c.iban_last4; currency := c.currency;
    credit_limit := c.credit_limit; debt := c.balance;
    cut_date := null; due_date := null; statement_amount := null; min_payment := null; paid := null;
    remaining := null; min_remaining := null; days_to_due := null; status := null;
    purchase_rate := null; late_rate := null; est_interest_min := null; est_interest_none := null;

    select x.* into s from card_statements(c.id, 3) x where not x.is_current order by x.cut_date desc limit 1;
    if found then
      cut_date := s.cut_date; due_date := s.due_date; statement_amount := s.statement_amount;
      min_payment := s.min_payment; paid := s.paid; remaining := s.remaining; status := s.status;
      days_to_due := s.due_date - v_today;
      v_minrem := least(greatest(s.min_payment - s.paid, 0), s.remaining);
      min_remaining := v_minrem;
      select r.purchase_rate, r.late_rate into t from rate_tier_for(s.statement_amount) r;
      purchase_rate := t.purchase_rate; late_rate := t.late_rate;
      est_interest_min  := round((s.remaining - v_minrem) * t.purchase_rate / 100, 2);
      est_interest_none := round(v_minrem * t.late_rate / 100 + (s.remaining - v_minrem) * t.purchase_rate / 100, 2);
    end if;
    return next;
  end loop;
end $$;

-- ---------- Otomatik ödeme -------------------------------------------------
create or replace function autopay_pending(p_today date default null)
returns table (account_id uuid, name text, cut_date date, due_date date, pay_date date, amount numeric, what text,
               source_account_id uuid, source_name text, source_balance numeric, record_mode text, due_now boolean)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_today date := coalesce(p_today, _today(auth.uid()));
  c record; s record; v_amt numeric;
begin
  for c in select b.id, b.name, d.autopay_mode, d.autopay_account_id, d.autopay_fixed, d.autopay_days_before, d.autopay_record
           from v_account_balances b join credit_card_details d on d.account_id = b.id
           where b.kind = 'credit_card' and b.archived_at is null and d.autopay_mode <> 'off' and d.autopay_account_id is not null
           order by b.name loop
    select x.* into s from card_statements(c.id, 3) x where not x.is_current order by x.cut_date desc limit 1;
    continue when not found or s.remaining <= 0;
    v_amt := case c.autopay_mode
               when 'min'   then least(greatest(s.min_payment - s.paid, 0), s.remaining)
               when 'full'  then s.remaining
               when 'fixed' then least(coalesce(c.autopay_fixed, 0), s.remaining) end;
    continue when coalesce(v_amt, 0) <= 0;
    continue when exists (select 1 from journal_entries e where e.user_id = auth.uid()
                          and e.idempotency_key = 'autopay:' || c.id || ':' || s.cut_date || ':' || c.autopay_mode);
    account_id := c.id; name := c.name; cut_date := s.cut_date; due_date := s.due_date;
    pay_date := s.due_date - c.autopay_days_before; amount := round(v_amt, 2); what := c.autopay_mode;
    source_account_id := c.autopay_account_id;
    select b2.name, b2.balance into source_name, source_balance from v_account_balances b2 where b2.id = c.autopay_account_id;
    record_mode := c.autopay_record; due_now := pay_date <= v_today;
    return next;
  end loop;
end $$;

-- Tek ödemeyi uygular (onay veya otomatik). Aynı ekstre için ikinci kez kayıt oluşmaz.
create or replace function apply_autopay(p_account_id uuid, p_date date default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := _uid();
  v_today date := _today(v_uid);
  r       record;
  v_desc  text;
begin
  select * into r from autopay_pending() where account_id = p_account_id;
  if not found then raise exception 'Bu kart için bekleyen otomatik ödeme yok' using errcode = 'P0002'; end if;
  v_desc := 'Otomatik ödeme (' || case r.what when 'min' then 'asgari' when 'full' then 'ekstre tamamı' else 'sabit tutar' end || ')';
  return record_transfer(r.source_account_id, r.account_id, r.amount, null,
                         least(coalesce(p_date, r.pay_date), v_today), v_desc,
                         'autopay:' || r.account_id || ':' || r.cut_date || ':' || r.what);
end $$;

-- "Otomatik kaydet" seçili kartlar için vadesi gelenleri kaydeder. Uygulama açılışında ve zamanlanmış görevde çalışır.
create or replace function process_autopay()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record; n int := 0; v_skip jsonb := '[]'::jsonb;
begin
  for r in select * from autopay_pending() where record_mode = 'auto' and due_now loop
    begin
      perform apply_autopay(r.account_id);
      n := n + 1;
    exception when others then
      v_skip := v_skip || jsonb_build_object('card', r.name, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('recorded', n, 'skipped', v_skip);
end $$;

-- Zamanlanmış görev için (API'ye kapalı): her kullanıcı adına çalıştırır
create or replace function run_autopay_all()
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0; j jsonb;
begin
  for r in select distinct a.user_id from credit_card_details d join accounts a on a.id = d.account_id
           where d.autopay_mode <> 'off' and d.autopay_record = 'auto' loop
    perform set_config('request.jwt.claim.sub', r.user_id::text, true);
    j := process_autopay();
    n := n + coalesce((j->>'recorded')::int, 0);
  end loop;
  return n;
end $$;

-- ---------- Kart otomasyon ayarları -----------------------------------------
create or replace function set_card_automation(p_account_id uuid, p jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  a      accounts;
  d      credit_card_details;
  v_mode text; v_src uuid; v_fix numeric; v_srcacc accounts;
begin
  select * into a from accounts where id = p_account_id and user_id = v_uid and kind = 'credit_card';
  if not found then raise exception 'Kart bulunamadı' using errcode = 'P0002'; end if;
  select * into d from credit_card_details where account_id = a.id;

  v_mode := coalesce(nullif(p->>'autopay_mode', ''), d.autopay_mode);
  v_src  := case when p ? 'autopay_account_id' then nullif(p->>'autopay_account_id', '')::uuid else d.autopay_account_id end;
  v_fix  := case when p ? 'autopay_fixed' then nullif(p->>'autopay_fixed', '')::numeric else d.autopay_fixed end;

  if v_mode <> 'off' then
    if v_src is null then raise exception 'Otomatik ödeme için kaynak hesap seçin' using errcode = '22023'; end if;
    select * into v_srcacc from accounts where id = v_src and user_id = v_uid and not is_system and archived_at is null;
    if not found or v_srcacc.kind not in ('bank', 'cash', 'savings') then
      raise exception 'Kaynak hesap banka, nakit veya birikim hesabı olmalı' using errcode = '22023';
    end if;
    if v_srcacc.currency <> a.currency then
      raise exception 'Kaynak hesap ile kartın para birimi aynı olmalı' using errcode = '22023';
    end if;
    if v_mode = 'fixed' and coalesce(v_fix, 0) <= 0 then
      raise exception 'Sabit tutar girin' using errcode = '22023';
    end if;
  end if;

  update credit_card_details set
    min_payment_auto    = coalesce((p->>'min_payment_auto')::boolean, min_payment_auto),
    min_payment_pct     = case when p ? 'min_payment_pct' and nullif(p->>'min_payment_pct', '') is not null
                               then (p->>'min_payment_pct')::numeric else min_payment_pct end,
    autopay_mode        = v_mode,
    autopay_account_id  = v_src,
    autopay_fixed       = v_fix,
    autopay_days_before = coalesce(nullif(p->>'autopay_days_before', '')::smallint, autopay_days_before),
    autopay_record      = coalesce(nullif(p->>'autopay_record', ''), autopay_record)
  where account_id = a.id;
end $$;

-- ---------- Toplu içe aktarma (Excel / yapıştırma / hızlı giriş) -----------------
--  rows[]: {key, kind: expense|income|transfer|payment|refund, date, account_id, to_account_id, category_id,
--           amount, to_amount, description, source_account_id, installments, purchase_amount}
--  Satır başına ayrı denenir: hatalı satır diğerlerini engellemez, rapora yazılır. Aynı `key` ikinci kez eklenmez.
create or replace function import_transactions(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  l      jsonb;
  i      int := 0;
  n_add  int := 0;
  n_exist int := 0;
  v_fail jsonb := '[]'::jsonb;
  v_key  text;
  v_kind text;
  a      accounts;
  v_amt  numeric;
  v_inst int;
begin
  for l in select * from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) loop
    i := i + 1;
    begin
      v_kind := l->>'kind';
      v_key  := 'xl:' || coalesce(nullif(l->>'key', ''), gen_random_uuid()::text);
      if _existing_entry(v_uid, v_key) is not null then n_exist := n_exist + 1; continue; end if;
      a := _owned_account(v_uid, (l->>'account_id')::uuid);
      v_amt := (l->>'amount')::numeric;
      if v_amt is null or v_amt <= 0 then raise exception 'Tutar sıfırdan büyük olmalı'; end if;

      if v_kind = 'expense' then
        v_inst := greatest(coalesce(nullif(l->>'installments', '')::int, 1), 1);
        perform _statement_entry(v_uid, a, v_key, jsonb_build_object(
          'kind', case when v_inst > 1 then 'installment' else 'purchase' end,
          'amount', case when v_inst > 1 then coalesce(nullif(l->>'purchase_amount', '')::numeric, v_amt) / v_inst else v_amt end,
          'purchase_amount', case when v_inst > 1 then coalesce(nullif(l->>'purchase_amount', '')::numeric, v_amt) end,
          'installments', v_inst, 'date', l->>'date', 'description', l->>'description', 'category_id', l->>'category_id'));
      elsif v_kind in ('payment', 'refund') then
        if a.kind <> 'credit_card' then raise exception 'Ödeme/iade yalnızca kredi kartına yapılabilir'; end if;
        perform _statement_entry(v_uid, a, v_key, jsonb_build_object(
          'kind', v_kind, 'amount', v_amt, 'date', l->>'date', 'description', l->>'description',
          'source_account_id', l->>'source_account_id'));
      elsif v_kind = 'income' then
        perform record_income(a.id, (l->>'category_id')::uuid, v_amt, (l->>'date')::date, nullif(l->>'description', ''), v_key);
      elsif v_kind = 'transfer' then
        perform record_transfer(a.id, (l->>'to_account_id')::uuid, v_amt, nullif(l->>'to_amount', '')::numeric,
                                (l->>'date')::date, nullif(l->>'description', ''), v_key);
      else
        raise exception 'Bilinmeyen işlem türü: %', coalesce(v_kind, '(boş)');
      end if;
      n_add := n_add + 1;
    exception when others then
      v_fail := v_fail || jsonb_build_object('row', i, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('added', n_add, 'existing', n_exist, 'failed', v_fail);
end $$;

revoke execute on function _rate_tier(uuid, numeric), _min_pct_rule(uuid, numeric), _ccd_min_auto(), _acc_limit_changed(), run_autopay_all()
  from public, anon, authenticated;
revoke execute on function rate_tier_for(numeric), apply_min_payment_rule(), card_debt_plan(), autopay_pending(date), apply_autopay(uuid, date), process_autopay(),
  set_card_automation(uuid, jsonb), import_transactions(jsonb) from public, anon;
grant  execute on function rate_tier_for(numeric), apply_min_payment_rule(), card_debt_plan(), autopay_pending(date), apply_autopay(uuid, date), process_autopay(),
  set_card_automation(uuid, jsonb), import_transactions(jsonb) to authenticated;
