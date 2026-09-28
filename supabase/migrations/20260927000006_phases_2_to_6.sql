-- =====================================================================
--  0006 · Faz 2–6 backend
--    Faz 2: kart taksitleri + ekstre motoru, banka kredisi + amortisman,
--           borç/alacak taksit planı
--    Faz 3: bütçe durumu ve uyarı seviyeleri
--    Faz 4: yaklaşan ödemeler, nakit akışı kaynağı
--    Faz 5: düzenli işlemler, planlı kalemlerin gerçekleştirilmesi, bildirimler
--    Faz 6: fiziksel varlıklar, döviz çevirisi
-- =====================================================================

create or replace function account_class_of(k account_kind)
returns account_class language sql immutable parallel safe as $$
  select case
    when k in ('bank','cash','savings','investment','fixed_asset','receivable') then 'asset'::account_class
    when k in ('credit_card','overdraft','loan','payable')                       then 'liability'::account_class
    else 'system'::account_class
  end
$$;

-- ---------- Tarih yardımcıları -------------------------------------------
-- Ayın p_day'i; ay kısa ise son günü (31 → 30/28)
create or replace function _day_in_month(p_month date, p_day int)
returns date language sql immutable as $$
  select date_trunc('month', p_month)::date
       + (least(p_day, extract(day from date_trunc('month', p_month) + interval '1 month - 1 day')::int) - 1)
$$;

create or replace function _add_months(p_date date, p_months int, p_day int)
returns date language sql immutable as $$
  select _day_in_month((date_trunc('month', p_date) + make_interval(months => p_months))::date, p_day)
$$;

-- Bu tarihi kapsayan hesap kesim tarihi (kesim günü dahil)
create or replace function _next_cut(p_date date, p_statement_day int)
returns date language sql immutable as $$
  select case when _day_in_month(p_date, p_statement_day) >= p_date
              then _day_in_month(p_date, p_statement_day)
              else _add_months(p_date, 1, p_statement_day) end
$$;

-- Kesimden sonraki ilk son ödeme günü
create or replace function _due_after(p_cut date, p_due_day int)
returns date language sql immutable as $$
  select case when _day_in_month(p_cut, p_due_day) > p_cut
              then _day_in_month(p_cut, p_due_day)
              else _add_months(p_cut, 1, p_due_day) end
$$;

-- =====================================================================
--  FAZ 2a · KREDİ KARTI TAKSİTLERİ ve EKSTRE MOTORU
--  Taksitli alışveriş: gider ve limit blokajı alışveriş günü TAM tutardır,
--  ekstreye ise dilim dilim yansır. Ekstre hiçbir yerde saklanmaz,
--  defterden hesaplanır:
--     Ekstre(C) = Kesim C'deki kart borcu − C'den sonra faturalanacak taksitler
-- =====================================================================
create table card_installment_plans (
  entry_id           uuid primary key references journal_entries(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  account_id         uuid not null references accounts(id) on delete cascade,
  total              numeric(20,2) not null check (total > 0),
  installment_count  int not null check (installment_count between 2 and 36),
  first_billing_date date not null
);
create index card_installment_plans_acc_idx on card_installment_plans (account_id);

create or replace function _card_owed_at(p_account uuid, p_date date)
returns numeric language sql stable as $$
  select -coalesce(sum(p.amount), 0)
  from postings p join journal_entries e on e.id = p.entry_id
  where p.account_id = p_account and e.entry_date <= p_date
$$;

-- Her taksit dilimi ve hangi kesimde faturalanacağı
create or replace function card_installment_slices(p_account_id uuid)
returns table (entry_id uuid, entry_date date, description text, slice_no int, slice_count int,
               billing_date date, amount numeric)
language sql stable security invoker set search_path = public, pg_temp as $$
  select pl.entry_id, e.entry_date, e.description, g.i, pl.installment_count,
         _add_months(pl.first_billing_date, g.i - 1, cc.statement_day),
         case when g.i < pl.installment_count
              then round(pl.total / pl.installment_count, 2)
              else pl.total - round(pl.total / pl.installment_count, 2) * (pl.installment_count - 1) end
  from card_installment_plans pl
  join journal_entries e       on e.id = pl.entry_id and e.status = 'posted'
  join credit_card_details cc  on cc.account_id = pl.account_id
  cross join lateral generate_series(1, pl.installment_count) as g(i)
  where pl.account_id = p_account_id
$$;

create or replace function _card_unbilled_after(p_account uuid, p_cut date)
returns numeric language sql stable as $$
  select coalesce(sum(s.amount), 0) from card_installment_slices(p_account) s
  where s.entry_date <= p_cut and s.billing_date > p_cut
$$;

-- Ekstreler: satır 0 = içinde bulunulan (henüz kesilmemiş) dönem
create or replace function card_statements(p_account_id uuid, p_count int default 6)
returns table (cut_date date, period_start date, due_date date, statement_amount numeric,
               min_payment numeric, paid numeric, remaining numeric, status text, is_current boolean)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  cc      credit_card_details;
  v_open  date;
  v_today date := _today(auth.uid());
  v_next  date;
  i       int;
begin
  select d.* into cc from credit_card_details d join accounts a on a.id = d.account_id
  where d.account_id = p_account_id;
  if not found then return; end if;
  select opened_on into v_open from accounts where id = p_account_id;

  v_next := _next_cut(v_today, cc.statement_day);
  for i in 0 .. greatest(p_count, 0) loop
    cut_date     := _add_months(v_next, -i, cc.statement_day);
    period_start := _add_months(v_next, -i - 1, cc.statement_day) + 1;
    exit when cut_date < v_open;
    due_date     := _due_after(cut_date, cc.due_day);
    is_current   := (i = 0);
    statement_amount := greatest(_card_owed_at(p_account_id, least(cut_date, v_today))
                                 - _card_unbilled_after(p_account_id, cut_date), 0);
    if is_current then
      paid := 0;
    else
      select coalesce(sum(p.amount), 0) into paid
      from postings p join journal_entries e on e.id = p.entry_id
      where p.account_id = p_account_id and p.amount > 0
        and e.entry_date > cut_date and e.entry_date <= v_today;
      paid := least(paid, statement_amount);
    end if;
    remaining   := greatest(statement_amount - paid, 0);
    min_payment := least(round(statement_amount * cc.min_payment_pct / 100, 2), statement_amount);
    status := case
      when is_current                                  then 'open_period'
      when statement_amount = 0 or remaining = 0       then 'paid'
      when v_today > due_date                          then 'overdue'
      when paid > 0                                    then 'partial'
      else 'awaiting' end;
    return next;
  end loop;
end $$;

-- Kart başına özet: son kesilen ekstre + içinde bulunulan dönem
create or replace function card_overview()
returns table (account_id uuid, name text, currency char(3), credit_limit numeric, owed numeric,
               available numeric, statement_day smallint, due_day smallint,
               last_cut date, last_due date, last_amount numeric, last_min numeric,
               last_paid numeric, last_remaining numeric, last_status text,
               next_cut date, next_due date, current_period_amount numeric, unbilled_installments numeric)
language sql stable security invoker set search_path = public, pg_temp as $$
  select a.id, a.name, a.currency, a.credit_limit, a.balance, a.available_limit, a.statement_day, a.due_day,
         l.cut_date, l.due_date, l.statement_amount, l.min_payment, l.paid, l.remaining, l.status,
         c.cut_date, c.due_date, c.statement_amount,
         _card_unbilled_after(a.id, coalesce(c.cut_date, current_date))
  from v_account_balances a
  left join lateral (select * from card_statements(a.id, 1) s where not s.is_current limit 1) l on true
  left join lateral (select * from card_statements(a.id, 0) s where s.is_current limit 1) c on true
  where a.kind = 'credit_card' and a.archived_at is null
$$;

-- record_expense'e taksit parametresi ekleniyor (imza değiştiği için yeniden)
drop function if exists record_expense(uuid, uuid, numeric, date, text, text);
create or replace function record_expense(
  p_account_id      uuid,
  p_category_id     uuid,
  p_amount          numeric,
  p_date            date default null,
  p_description     text default null,
  p_idempotency_key text default null,
  p_installments    int  default 1
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  v_id   uuid := _existing_entry(v_uid, p_idempotency_key);
  v_acc  accounts;
  v_cat  categories;
  v_date date;
  v_sd   smallint;
begin
  if v_id is not null then return v_id; end if;
  perform _check_amount(p_amount);
  v_acc  := _owned_account(v_uid, p_account_id);
  v_cat  := _owned_category(v_uid, p_category_id, 'expense');
  v_date := _check_date(v_uid, p_date);
  if v_acc.kind in ('loan','receivable','fixed_asset') then
    raise exception '"%" hesabından doğrudan harcama yapılamaz', v_acc.name using errcode = '22023';
  end if;
  if coalesce(p_installments, 1) < 1 or p_installments > 36 then
    raise exception 'Taksit sayısı 1 ile 36 arasında olmalı' using errcode = '22023';
  end if;
  if p_installments > 1 and v_acc.kind <> 'credit_card' then
    raise exception 'Taksit yalnızca kredi kartı harcamalarında kullanılabilir' using errcode = '22023';
  end if;

  v_id := _new_entry(v_uid, v_date,
                     case when v_acc.kind = 'credit_card' then 'card_purchase' else 'expense' end::entry_kind,
                     p_description, p_idempotency_key, v_acc.counterparty_id);
  perform _post(v_id, v_acc.id, null, -p_amount, v_acc.currency);
  perform _post(v_id, null, v_cat.id,  p_amount, v_acc.currency);

  if p_installments > 1 then
    select statement_day into v_sd from credit_card_details where account_id = v_acc.id;
    insert into card_installment_plans (entry_id, user_id, account_id, total, installment_count, first_billing_date)
    values (v_id, v_uid, v_acc.id, p_amount, p_installments, _next_cut(v_date, v_sd));
  end if;
  return v_id;
end $$;

-- =====================================================================
--  FAZ 2b · BANKA KREDİSİ — amortisman planı ve taksit ödemesi
--  Taksit ödemesi: Kredi +anapara · Kredi Faizi gideri +faiz(+vergi) · Banka −taksit
--  → Anapara hiçbir zaman gider sayılmaz (doküman Hata 3).
-- =====================================================================
create table loan_details (
  account_id         uuid primary key references accounts(id) on delete cascade,
  principal          numeric(20,2) not null check (principal > 0),
  monthly_rate       numeric(9,5)  not null check (monthly_rate >= 0),   -- aylık % (örn. 3.29)
  tax_pct            numeric(6,2)  not null default 0 check (tax_pct >= 0), -- faize eklenen KKDF+BSMV %
  term_months        int  not null check (term_months between 1 and 480),
  first_payment_date date not null,
  payment_amount     numeric(20,2) not null
);

create table loan_installments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  account_id      uuid not null references accounts(id) on delete cascade,
  installment_no  int  not null,
  due_date        date not null,
  payment         numeric(20,2) not null,
  principal       numeric(20,2) not null,
  interest        numeric(20,2) not null,
  tax             numeric(20,2) not null default 0,
  remaining       numeric(20,2) not null,
  settled_outside boolean not null default false,  -- sisteme girmeden önce ödenmiş
  paid_entry_id   uuid references journal_entries(id) on delete set null,
  unique (account_id, installment_no)
);
create index loan_installments_due_idx on loan_installments (user_id, due_date);

create or replace function create_loan(
  p_name                   text,
  p_institution_name       text,
  p_currency               char(3),
  p_principal              numeric,
  p_monthly_rate           numeric,
  p_term_months            int,
  p_first_payment_date     date,
  p_tax_pct                numeric default 0,
  p_disburse_to_account_id uuid    default null,  -- yeni kredi: paranın yattığı hesap
  p_start_date             date    default null,
  p_paid_installments      int     default 0      -- mevcut kredi: kaç taksit ödendi
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := _uid();
  v_today date := _today(v_uid);
  v_acc   uuid;
  v_r     numeric;
  v_a     numeric;
  v_bal   numeric;
  v_open  numeric;
  v_int   numeric;
  v_tax   numeric;
  v_pr    numeric;
  v_day   int := extract(day from p_first_payment_date)::int;
  v_entry uuid;
  i       int;
begin
  perform _check_amount(p_principal);
  if p_term_months is null or p_term_months < 1 or p_term_months > 480 then
    raise exception 'Vade 1–480 ay arasında olmalı' using errcode = '22023';
  end if;
  if p_monthly_rate is null or p_monthly_rate < 0 or p_monthly_rate > 20 then
    raise exception 'Aylık faiz oranı 0–20 arasında olmalı (örn. 3,29)' using errcode = '22023';
  end if;
  if p_first_payment_date is null then
    raise exception 'İlk taksit tarihi zorunlu' using errcode = '22023';
  end if;
  if coalesce(p_paid_installments, 0) < 0 or p_paid_installments >= p_term_months then
    raise exception 'Ödenmiş taksit sayısı 0 ile vade−1 arasında olmalı' using errcode = '22023';
  end if;
  if p_disburse_to_account_id is not null and p_paid_installments > 0 then
    raise exception 'Yeni kullanılan kredide ödenmiş taksit olamaz' using errcode = '22023';
  end if;

  v_acc := create_account(p_name, 'loan', p_currency, 0,
                          least(coalesce(p_start_date, p_first_payment_date - 30), v_today),
                          p_institution_name);

  v_r := p_monthly_rate / 100 * (1 + coalesce(p_tax_pct, 0) / 100);
  v_a := case when v_r = 0 then round(p_principal / p_term_months, 2)
              else round(p_principal * v_r / (1 - power(1 + v_r, -p_term_months)), 2) end;

  insert into loan_details (account_id, principal, monthly_rate, tax_pct, term_months, first_payment_date, payment_amount)
  values (v_acc, p_principal, p_monthly_rate, coalesce(p_tax_pct, 0), p_term_months, p_first_payment_date, v_a);

  v_bal  := p_principal;
  v_open := p_principal;
  for i in 1 .. p_term_months loop
    v_int := round(v_bal * p_monthly_rate / 100, 2);
    v_tax := round(v_int * coalesce(p_tax_pct, 0) / 100, 2);
    v_pr  := case when i = p_term_months then v_bal else greatest(v_a - v_int - v_tax, 0) end;
    v_pr  := least(v_pr, v_bal);
    v_bal := v_bal - v_pr;
    insert into loan_installments (user_id, account_id, installment_no, due_date, payment, principal,
                                   interest, tax, remaining, settled_outside)
    values (v_uid, v_acc, i, _add_months(p_first_payment_date, i - 1, v_day),
            v_pr + v_int + v_tax, v_pr, v_int, v_tax, v_bal, i <= coalesce(p_paid_installments, 0));
    if i = p_paid_installments then v_open := v_bal; end if;
  end loop;

  if p_disburse_to_account_id is not null then
    perform record_transfer(v_acc, p_disburse_to_account_id, p_principal, null,
                            coalesce(p_start_date, v_today), 'Kredi kullanımı: ' || p_name);
  else
    v_entry := _new_entry(v_uid, v_today, 'opening_balance', 'Açılış bakiyesi: ' || p_name, null);
    perform _post(v_entry, v_acc, null, -v_open, p_currency);
    perform _post(v_entry, _system_account(v_uid, 'equity', p_currency), null, v_open, p_currency);
  end if;
  return v_acc;
end $$;

create or replace function pay_loan_installment(
  p_installment_id  uuid,
  p_from_account_id uuid,
  p_date            date default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  v_id   uuid := _existing_entry(v_uid, p_idempotency_key);
  v_li   loan_installments;
  v_loan accounts;
  v_from accounts;
  v_cat  uuid;
  v_prev int;
begin
  if v_id is not null then return v_id; end if;
  select * into v_li from loan_installments where id = p_installment_id and user_id = v_uid for update;
  if not found then raise exception 'Taksit bulunamadı' using errcode = 'P0002'; end if;
  if v_li.settled_outside or v_li.paid_entry_id is not null then
    raise exception 'Bu taksit zaten ödenmiş' using errcode = '22023';
  end if;
  select min(installment_no) into v_prev from loan_installments
  where account_id = v_li.account_id and installment_no < v_li.installment_no
    and not settled_outside and paid_entry_id is null;
  if v_prev is not null then
    raise exception 'Önce %. taksiti ödeyin', v_prev using errcode = '22023';
  end if;

  v_loan := _owned_account(v_uid, v_li.account_id);
  v_from := _owned_account(v_uid, p_from_account_id);
  if v_from.currency <> v_loan.currency then
    raise exception 'Taksit % biriminde; ödeme hesabı da % olmalı', v_loan.currency, v_loan.currency using errcode = '22023';
  end if;
  if account_class_of(v_from.kind) <> 'asset' and v_from.kind <> 'overdraft' then
    raise exception 'Taksit banka, nakit veya ek hesaptan ödenebilir' using errcode = '22023';
  end if;
  select id into v_cat from categories where user_id = v_uid and system_key = 'loan_interest';

  v_id := _new_entry(v_uid, _check_date(v_uid, p_date), 'loan_payment',
                     v_loan.name || ' ' || v_li.installment_no || '. taksit', p_idempotency_key);
  perform _post(v_id, v_from.id, null, -v_li.payment,  v_loan.currency);
  if v_li.principal > 0 then
    perform _post(v_id, v_loan.id, null, v_li.principal, v_loan.currency, 'Anapara');
  end if;
  if v_li.interest + v_li.tax > 0 then
    if v_cat is null then raise exception '"Kredi Faizi" kategorisi bulunamadı' using errcode = 'P0002'; end if;
    perform _post(v_id, null, v_cat, v_li.interest + v_li.tax, v_loan.currency,
                  case when v_li.tax > 0 then 'Faiz ' || v_li.interest || ' + vergi ' || v_li.tax else 'Faiz' end);
  end if;
  update loan_installments set paid_entry_id = v_id where id = v_li.id;
  return v_id;
end $$;

create or replace view v_loans with (security_invoker = true) as
select a.id, a.user_id, a.name, a.currency, a.institution_name, a.archived_at,
       d.principal, d.monthly_rate, d.tax_pct, d.term_months, d.first_payment_date, d.payment_amount,
       a.balance as remaining_principal,
       s.paid_count, s.unpaid_count, s.remaining_payments, s.remaining_interest,
       s.next_id, s.next_no, s.next_due, s.next_payment
from v_account_balances a
join loan_details d on d.account_id = a.id
left join lateral (
  select count(*) filter (where li.settled_outside or li.paid_entry_id is not null) as paid_count,
         count(*) filter (where not li.settled_outside and li.paid_entry_id is null) as unpaid_count,
         coalesce(sum(li.payment) filter (where not li.settled_outside and li.paid_entry_id is null), 0) as remaining_payments,
         coalesce(sum(li.interest + li.tax) filter (where not li.settled_outside and li.paid_entry_id is null), 0) as remaining_interest,
         (array_agg(li.id       order by li.installment_no) filter (where not li.settled_outside and li.paid_entry_id is null))[1] as next_id,
         (array_agg(li.installment_no order by li.installment_no) filter (where not li.settled_outside and li.paid_entry_id is null))[1] as next_no,
         (array_agg(li.due_date order by li.installment_no) filter (where not li.settled_outside and li.paid_entry_id is null))[1] as next_due,
         (array_agg(li.payment  order by li.installment_no) filter (where not li.settled_outside and li.paid_entry_id is null))[1] as next_payment
  from loan_installments li where li.account_id = a.id
) s on true;

-- =====================================================================
--  FAZ 2c · BORÇ / ALACAK TAKSİT PLANI  +  FAZ 5 · PLANLI KALEMLER
-- =====================================================================
alter table scheduled_items add column if not exists to_account_id uuid references accounts(id) on delete cascade;
create unique index if not exists scheduled_items_recurring_uq
  on scheduled_items (source_id, due_date) where source_type = 'recurring';

create or replace function create_installment_plan(
  p_account_id  uuid,     -- kişisel borç veya alacak hesabı
  p_total       numeric,
  p_count       int,
  p_first_date  date,
  p_description text default null
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := _uid();
  v_acc   accounts := _owned_account(v_uid, p_account_id);
  v_slice numeric;
  v_day   int := extract(day from p_first_date)::int;
  i       int;
begin
  perform _check_amount(p_total);
  if v_acc.kind not in ('payable','receivable') then
    raise exception 'Taksit planı yalnızca borç veya alacak hesabına kurulabilir' using errcode = '22023';
  end if;
  if p_count is null or p_count < 1 or p_count > 120 then
    raise exception 'Taksit sayısı 1–120 arasında olmalı' using errcode = '22023';
  end if;
  if p_first_date is null then raise exception 'İlk vade tarihi zorunlu' using errcode = '22023'; end if;
  v_slice := round(p_total / p_count, 2);
  for i in 1 .. p_count loop
    insert into scheduled_items (user_id, due_date, direction, amount, currency, account_id, counterparty_id,
                                 description, source_type, source_id)
    values (v_uid, _add_months(p_first_date, i - 1, v_day),
            case when v_acc.kind = 'payable' then 'out' else 'in' end,
            case when i < p_count then v_slice else p_total - v_slice * (p_count - 1) end,
            v_acc.currency, v_acc.id, v_acc.counterparty_id,
            coalesce(nullif(trim(p_description), ''), v_acc.name) || ' (' || i || '/' || p_count || ')',
            case when v_acc.kind = 'payable' then 'debt' else 'receivable' end, v_acc.id);
  end loop;
  return p_count;
end $$;

-- Planlı kalemi deftere işle
create or replace function realize_scheduled_item(
  p_item_id         uuid,
  p_cash_account_id uuid    default null,   -- ödemenin yapıldığı / paranın girdiği hesap
  p_amount          numeric default null,
  p_date            date    default null,
  p_to_amount       numeric default null    -- farklı para biriminde transfer için
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  v_it   scheduled_items;
  v_amt  numeric;
  v_cash uuid;
  v_key  text;
  v_id   uuid;
begin
  select * into v_it from scheduled_items where id = p_item_id and user_id = v_uid for update;
  if not found then raise exception 'Planlı kalem bulunamadı' using errcode = 'P0002'; end if;
  if v_it.status <> 'planned' then raise exception 'Bu kalem zaten işlenmiş' using errcode = '22023'; end if;
  v_amt  := coalesce(p_amount, v_it.amount);
  v_cash := coalesce(p_cash_account_id, v_it.account_id);
  v_key  := 'sched:' || v_it.id;

  if v_it.source_type = 'debt' then
    if p_cash_account_id is null then raise exception 'Ödemenin yapılacağı hesabı seçin' using errcode = '22023'; end if;
    v_id := record_transfer(p_cash_account_id, v_it.account_id, v_amt, p_to_amount, p_date, v_it.description, v_key);
  elsif v_it.source_type = 'receivable' then
    if p_cash_account_id is null then raise exception 'Tahsilatın gireceği hesabı seçin' using errcode = '22023'; end if;
    v_id := record_transfer(v_it.account_id, p_cash_account_id, v_amt, p_to_amount, p_date, v_it.description, v_key);
  elsif v_it.direction = 'transfer' then
    v_id := record_transfer(v_cash, v_it.to_account_id, v_amt, p_to_amount, p_date, v_it.description, v_key);
  else
    if v_it.category_id is null then
      raise exception 'Bu planlı kalemin kategorisi yok; önce kategori seçin' using errcode = '22023';
    end if;
    if v_it.direction = 'in' then
      v_id := record_income(v_cash, v_it.category_id, v_amt, p_date, v_it.description, v_key);
    else
      v_id := record_expense(v_cash, v_it.category_id, v_amt, p_date, v_it.description, v_key);
    end if;
  end if;

  update scheduled_items set status = 'done', realized_entry_id = v_id where id = v_it.id;
  return v_id;
end $$;

-- Düzenli kuralları önümüzdeki p_days gün için planlı kaleme dönüştür (tekrar çalıştırmak güvenli)
create or replace function materialize_recurring(p_days int default 90)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := _uid();
  v_today date := _today(v_uid);
  v_until date := v_today + least(greatest(p_days, 1), 400);
  r       recurring_rules;
  d       date;
  k       int;
  v_day   int;
  v_n     int := 0;
  v_rows  int;
begin
  for r in select * from recurring_rules where user_id = v_uid and is_active loop
    v_day := coalesce(r.day_of_month, extract(day from r.start_date)::int);
    k := 0;
    loop
      d := case r.frequency
             when 'monthly' then _add_months(r.start_date, k * r.interval_n, v_day)
             when 'yearly'  then _add_months(r.start_date, 12 * k * r.interval_n, v_day)
             else r.start_date + k * 7 * r.interval_n end;
      exit when d > v_until or (r.end_date is not null and d > r.end_date) or k > 5000;
      if d >= greatest(r.start_date, r.created_at::date) then
        insert into scheduled_items (user_id, due_date, direction, amount, currency, account_id, to_account_id,
                                     category_id, description, source_type, source_id)
        values (v_uid, d, r.direction, r.amount, r.currency, r.account_id, r.to_account_id,
                r.category_id, r.name, 'recurring', r.id)
        on conflict (source_id, due_date) where source_type = 'recurring' do nothing;
        get diagnostics v_rows = row_count;
        v_n := v_n + v_rows;
      end if;
      k := k + 1;
    end loop;
  end loop;
  return v_n;
end $$;

-- Kural değişince/silinince gelecekteki bekleyen kalemleri temizle
create or replace function _recurring_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from scheduled_items
  where source_type = 'recurring' and source_id = old.id and status = 'planned';
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger recurring_rules_changed
  after update or delete on recurring_rules
  for each row execute function _recurring_changed();

-- Kural doğrulama
create or replace function _validate_recurring()
returns trigger language plpgsql as $$
declare v_acc accounts;
begin
  select * into v_acc from accounts where id = new.account_id and user_id = new.user_id;
  if not found then raise exception 'Hesap bulunamadı' using errcode = 'P0002'; end if;
  new.currency := v_acc.currency;
  if new.direction in ('in','out') and new.category_id is null then
    raise exception 'Gelir/gider kuralı için kategori zorunlu' using errcode = '22023';
  end if;
  if new.direction = 'transfer' and new.to_account_id is null then
    raise exception 'Transfer kuralı için hedef hesap zorunlu' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger recurring_rules_validate
  before insert or update on recurring_rules
  for each row execute function _validate_recurring();

-- İptal: artık kredi taksiti ve planlı kalemleri de geri açar
create or replace function reverse_entry(p_entry_id uuid, p_reason text default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_e   journal_entries;
  v_rid uuid;
begin
  select * into v_e from journal_entries where id = p_entry_id and user_id = v_uid for update;
  if not found then raise exception 'Kayıt bulunamadı' using errcode = 'P0002'; end if;
  if v_e.status = 'reversed' then raise exception 'Bu kayıt zaten iptal edilmiş' using errcode = '22023'; end if;
  if v_e.kind = 'reversal'  then raise exception 'Ters kayıt iptal edilemez' using errcode = '22023'; end if;

  insert into journal_entries (user_id, entry_date, kind, description, reverses_entry_id, counterparty_id)
  values (v_uid, v_e.entry_date, 'reversal',
          'İptal: ' || coalesce(v_e.description, v_e.kind::text)
            || coalesce(' — ' || nullif(trim(p_reason), ''), ''),
          v_e.id, v_e.counterparty_id)
  returning id into v_rid;

  insert into postings (entry_id, user_id, account_id, category_id, amount, currency, memo)
  select v_rid, v_uid, account_id, category_id, -amount, currency, memo
  from postings where entry_id = v_e.id order by id;

  update journal_entries set status = 'reversed', reversed_by = v_rid where id = v_e.id;
  update loan_installments set paid_entry_id = null where paid_entry_id = v_e.id;
  update scheduled_items  set status = 'planned', realized_entry_id = null where realized_entry_id = v_e.id;
  return v_rid;
end $$;

-- =====================================================================
--  FAZ 4 · YAKLAŞAN ÖDEMELER / TAHSİLATLAR (nakit akışının kaynağı)
-- =====================================================================
-- Kartın önümüzdeki kesimlerden doğacak ödemeleri
create or replace function _card_dues(p_account uuid, p_until date)
returns table (cut_date date, due_date date, amount numeric)
language plpgsql stable set search_path = public, pg_temp as $$
declare
  cc     credit_card_details;
  v_next date;
  v_last numeric;
  c      date;
  i      int := 1;
  s      record;
begin
  select * into cc from credit_card_details where account_id = p_account;
  if not found then return; end if;
  -- Son kesilen ekstre (devreden bakiyeyi zaten içerir; eski ekstreler ayrıca sayılmaz)
  select * into s from card_statements(p_account, 1) x where not x.is_current;
  if found and s.remaining > 0 and s.due_date <= p_until then
    cut_date := s.cut_date; due_date := s.due_date; amount := s.remaining;
    return next;
  end if;
  v_last := coalesce(s.remaining, 0);
  -- İçinde bulunulan dönem: yalnızca son ekstreden SONRA eklenen kısım
  select * into s from card_statements(p_account, 0) x where x.is_current;
  if found and s.statement_amount - v_last > 0 and s.due_date <= p_until then
    cut_date := s.cut_date; due_date := s.due_date; amount := s.statement_amount - v_last;
    return next;
  end if;
  -- sonraki kesimlerde faturalanacak taksit dilimleri
  v_next := _next_cut(_today(auth.uid()), cc.statement_day);
  loop
    c := _add_months(v_next, i, cc.statement_day);
    exit when _due_after(c, cc.due_day) > p_until or i > 24;
    select coalesce(sum(sl.amount), 0) into amount from card_installment_slices(p_account) sl
    where sl.billing_date = c;
    if amount > 0 then
      cut_date := c; due_date := _due_after(c, cc.due_day);
      return next;
    end if;
    i := i + 1;
  end loop;
end $$;

create or replace function upcoming_items(p_days int default 90)
returns table (due_date date, source_type text, source_id uuid, ref_id uuid, description text,
               direction text, amount numeric, currency char(3), account_id uuid, account_name text,
               category_id uuid, overdue boolean)
language sql stable security invoker set search_path = public, pg_temp as $$
  with lim as (select _today(auth.uid()) as d, _today(auth.uid()) + least(greatest(p_days, 0), 400) as u)
  select s.due_date, s.source_type, s.source_id, s.id,
         coalesce(s.description, c.name, a.name), s.direction, s.amount, s.currency,
         s.account_id, a.name, s.category_id, s.due_date < lim.d
  from scheduled_items s cross join lim
  left join accounts a   on a.id = s.account_id
  left join categories c on c.id = s.category_id
  where s.status = 'planned' and s.due_date <= lim.u
  union all
  select li.due_date, 'loan_installment', li.account_id, li.id,
         a.name || ' · ' || li.installment_no || '. taksit', 'out', li.payment, a.currency,
         a.id, a.name, null::uuid, li.due_date < lim.d
  from loan_installments li cross join lim
  join accounts a on a.id = li.account_id and a.archived_at is null
  where not li.settled_outside and li.paid_entry_id is null and li.due_date <= lim.u
  union all
  select d.due_date, 'card_statement', a.id, a.id,
         a.name || ' · ekstre ' || to_char(d.cut_date, 'DD.MM'), 'out', d.amount, a.currency,
         a.id, a.name, null::uuid, d.due_date < lim.d
  from accounts a cross join lim
  cross join lateral _card_dues(a.id, lim.u) d
  where a.kind = 'credit_card' and a.archived_at is null
  order by 1, 5
$$;

-- =====================================================================
--  FAZ 3 · BÜTÇE
-- =====================================================================
create or replace function budget_status(p_month date)
returns table (budget_id uuid, category_id uuid, category_name text, parent_name text, is_root boolean,
               currency char(3), budget numeric, actual numeric, remaining numeric, pct numeric, level text)
language sql stable security invoker set search_path = public, pg_temp as $$
  select b.id, c.id, c.name, pc.name, c.parent_id is null, b.currency, b.amount,
         coalesce(act.total, 0),
         b.amount - coalesce(act.total, 0),
         round(coalesce(act.total, 0) / b.amount * 100, 1),
         case when coalesce(act.total, 0) > b.amount                         then 'over'
              when coalesce(act.total, 0) / b.amount * 100 >= coalesce(pr.cr, 90) then 'critical'
              when coalesce(act.total, 0) / b.amount * 100 >= coalesce(pr.w, 70)  then 'warning'
              else 'normal' end
  from budgets b
  join categories c        on c.id = b.category_id
  left join categories pc  on pc.id = c.parent_id
  left join lateral (select budget_warn_pct as w, budget_crit_pct as cr from profiles where id = auth.uid()) pr on true
  left join lateral (
    select sum(v.total) as total from v_category_monthly v
    where v.month = date_trunc('month', p_month)::date and v.currency = b.currency and v.kind = 'expense'
      and (case when c.parent_id is null then v.root_category_id = c.id else v.category_id = c.id end)
  ) act on true
  where b.period = date_trunc('month', p_month)::date
  order by c.parent_id nulls first, c.sort_order, c.name
$$;

create or replace function copy_budgets(p_from date, p_to date)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := _uid(); v_n int;
begin
  insert into budgets (user_id, period, category_id, amount, currency)
  select v_uid, date_trunc('month', p_to)::date, category_id, amount, currency
  from budgets where user_id = v_uid and period = date_trunc('month', p_from)::date
  on conflict (user_id, period, category_id, currency) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- =====================================================================
--  FAZ 5 · BİLDİRİMLER (anlık hesaplanır)
-- =====================================================================
create or replace function notifications(p_days int default 7)
returns table (level text, kind text, title text, amount numeric, currency char(3), due_date date, ref_id uuid)
language sql stable security invoker set search_path = public, pg_temp as $$
  with t as (select _today(auth.uid()) as d)
  select case when u.overdue then 'critical' when u.due_date <= t.d + 2 then 'warning' else 'info' end,
         u.source_type,
         case when u.overdue and u.direction = 'in' then 'Beklenen tahsilat gecikti: ' || u.description
              when u.overdue then 'Gecikmiş ödeme: ' || u.description
              when u.direction = 'in' then 'Yaklaşan tahsilat: ' || u.description
              else 'Yaklaşan ödeme: ' || u.description end,
         u.amount, u.currency, u.due_date, u.ref_id
  from upcoming_items(p_days) u cross join t
  union all
  select case when b.level = 'over' then 'critical' else 'warning' end, 'budget',
         case when b.level = 'over' then 'Bütçe aşıldı: ' else 'Bütçe %' || round(b.pct) || ': ' end || b.category_name,
         b.actual, b.currency, null::date, b.budget_id
  from budget_status((select d from t)) b where b.level in ('critical','over')
  union all
  select 'critical', 'low_balance', 'Hesap eksi bakiyede: ' || a.name, a.balance, a.currency, null, a.id
  from v_account_balances a
  where a.kind in ('bank','savings') and a.balance < 0 and a.archived_at is null
  union all
  select 'warning', 'card_limit', 'Kart limiti %' || round(a.balance / a.credit_limit * 100) || ' dolu: ' || a.name,
         a.available_limit, a.currency, null, a.id
  from v_account_balances a
  where a.kind in ('credit_card','overdraft') and a.credit_limit > 0 and a.archived_at is null
    and a.balance / a.credit_limit >= 0.9
  order by 1, 6 nulls last
$$;

-- =====================================================================
--  FAZ 6 · DÖVİZ ÇEVİRİSİ
--  Doğrudan kur → ters kur → USD üzerinden çapraz kur
-- =====================================================================
create or replace function _fx_direct(p_from char(3), p_to char(3), p_on date)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select rate from exchange_rates where base = p_from and quote = p_to and rate_date <= p_on
      and user_id = auth.uid() order by rate_date desc limit 1),
    (select 1 / rate from exchange_rates where base = p_to and quote = p_from and rate_date <= p_on
      and user_id = auth.uid() order by rate_date desc limit 1))
$$;

create or replace function fx_rate(p_from char(3), p_to char(3), p_on date default null)
returns numeric language sql stable security invoker set search_path = public, pg_temp as $$
  select case when p_from = p_to then 1::numeric else coalesce(
    _fx_direct(p_from, p_to, coalesce(p_on, current_date)),
    _fx_direct(p_from, 'USD', coalesce(p_on, current_date)) * _fx_direct('USD', p_to, coalesce(p_on, current_date))) end
$$;

create or replace function net_position_in_base()
returns table (currency char(3), assets numeric, receivables numeric, liabilities numeric, net_worth numeric,
               rate numeric, base_currency char(3), net_in_base numeric)
language sql stable security invoker set search_path = public, pg_temp as $$
  select n.currency, n.assets, n.receivables, n.liabilities, n.net_worth,
         fx_rate(n.currency, p.base_currency), p.base_currency,
         round(n.net_worth * fx_rate(n.currency, p.base_currency), 2)
  from v_net_position n
  cross join (select coalesce((select base_currency from profiles where id = auth.uid()), 'TRY') as base_currency) p
$$;

-- =====================================================================
--  RLS + yetkiler (yeni tablolar ve fonksiyonlar)
-- =====================================================================
alter table card_installment_plans enable row level security;
alter table loan_details           enable row level security;
alter table loan_installments      enable row level security;

create policy cip_read  on card_installment_plans for select to authenticated using (user_id = (select auth.uid()));
create policy li_read   on loan_installments      for select to authenticated using (user_id = (select auth.uid()));
create policy ld_read   on loan_details           for select to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.user_id = (select auth.uid())));

revoke execute on all functions in schema public from public, anon;
grant execute on function
  account_class_of(account_kind),
  record_expense(uuid, uuid, numeric, date, text, text, int),
  card_installment_slices(uuid), card_statements(uuid, int), card_overview(),
  create_loan(text, text, char, numeric, numeric, int, date, numeric, uuid, date, int),
  pay_loan_installment(uuid, uuid, date, text),
  create_installment_plan(uuid, numeric, int, date, text),
  realize_scheduled_item(uuid, uuid, numeric, date, numeric),
  materialize_recurring(int), upcoming_items(int),
  budget_status(date), copy_budgets(date, date), notifications(int),
  fx_rate(char, char, date), net_position_in_base(),
  reverse_entry(uuid, text)
to authenticated;

-- Salt okunur yardımcılar "security invoker" fonksiyonlarca çağrılır → çağıranda yetki gerekli.
-- Hepsi RLS altında çalışır; başka kullanıcının verisine erişemez.
grant execute on function
  _today(uuid), _day_in_month(date, int), _add_months(date, int, int), _next_cut(date, int), _due_after(date, int),
  _card_owed_at(uuid, date), _card_unbilled_after(uuid, date), _card_dues(uuid, date), _fx_direct(char, char, date)
to authenticated;

revoke execute on function _recurring_changed(), _validate_recurring() from authenticated;
