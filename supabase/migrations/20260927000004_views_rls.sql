-- =====================================================================
--  0004 · Okuma görünümleri + Row Level Security + yetkiler
-- =====================================================================

-- ---------- Hesap bakiyeleri (defterden hesaplanır) ------------------------
create or replace view v_account_balances with (security_invoker = true) as
select
  a.id, a.user_id, a.name, a.kind, account_class_of(a.kind) as class, a.currency,
  a.institution_id, i.name as institution_name,
  a.counterparty_id, cp.name as counterparty_name,
  a.credit_limit, a.iban_last4, a.color, a.sort_order, a.opened_on, a.archived_at,
  cc.statement_day, cc.due_day,
  coalesce(s.raw, 0) as raw_balance,
  case when account_class_of(a.kind) = 'liability' then -coalesce(s.raw, 0)
       else coalesce(s.raw, 0) end                                  as balance,
  case when a.kind in ('credit_card','overdraft') and a.credit_limit is not null
       then a.credit_limit + coalesce(s.raw, 0) end                 as available_limit,
  s.last_activity
from accounts a
left join institutions i         on i.id  = a.institution_id
left join counterparties cp      on cp.id = a.counterparty_id
left join credit_card_details cc on cc.account_id = a.id
left join lateral (
  select sum(p.amount) as raw, max(e.entry_date) as last_activity
  from postings p join journal_entries e on e.id = p.entry_id
  where p.account_id = a.id
) s on true
where not a.is_system;

-- ---------- Net durum (para birimi bazında) --------------------------------
--  Net Varlık = Varlık + Alacak − Borç
create or replace view v_net_position with (security_invoker = true) as
select
  user_id, currency,
  coalesce(sum(balance) filter (where class = 'asset' and kind <> 'receivable'), 0) as assets,
  coalesce(sum(balance) filter (where kind = 'receivable'), 0)                      as receivables,
  coalesce(sum(balance) filter (where class = 'liability'), 0)                      as liabilities,
  coalesce(sum(balance) filter (where class = 'asset'), 0)
    - coalesce(sum(balance) filter (where class = 'liability'), 0)                  as net_worth
from v_account_balances
group by user_id, currency;

-- ---------- İşlem listesi: kayıt başına bir satır, satırlar jsonb ----------
create or replace view v_entries with (security_invoker = true) as
select
  e.id, e.user_id, e.entry_date, e.kind, e.status, e.description,
  e.reverses_entry_id, e.reversed_by, e.counterparty_id, e.created_at,
  l.currency     as currency,          -- ilk hesap satırının birimi
  l.amount       as amount,            -- kaydın "manşet" tutarı (her zaman pozitif)
  l.lines,
  l.account_ids,
  l.category_ids
from journal_entries e
cross join lateral (
  select
    (array_agg(p.currency order by p.id) filter (where p.account_id is not null and not coalesce(a.is_system,false)))[1] as currency,
    jsonb_agg(jsonb_build_object(
      'account_id',   p.account_id,
      'account_name', a.name,
      'account_kind', a.kind,
      'is_system',    coalesce(a.is_system, false),
      'category_id',  p.category_id,
      'category_name', c.name,
      'parent_category_name', pc.name,
      'amount',       p.amount,
      'currency',     p.currency,
      'memo',         p.memo
    ) order by p.id) as lines,
    array_agg(p.account_id)  filter (where p.account_id  is not null) as account_ids,
    array_agg(p.category_id) filter (where p.category_id is not null) as category_ids
  from postings p
  left join accounts a    on a.id  = p.account_id
  left join categories c  on c.id  = p.category_id
  left join categories pc on pc.id = c.parent_id
  where p.entry_id = e.id
) l0
cross join lateral (
  select l0.currency, l0.lines, l0.account_ids, l0.category_ids,
         (select sum(abs((x->>'amount')::numeric)) / 2
            from jsonb_array_elements(l0.lines) x
           where x->>'currency' = l0.currency) as amount
) l;

-- ---------- Aylık kategori toplamları (iptal edilenler kendiliğinden 0) -----
create or replace view v_category_monthly with (security_invoker = true) as
select
  p.user_id,
  date_trunc('month', e.entry_date)::date as month,
  c.kind,
  p.category_id,
  c.name as category_name,
  coalesce(c.parent_id, c.id) as root_category_id,
  coalesce(pc.name, c.name)   as root_category_name,
  p.currency,
  sum(case when c.kind = 'expense' then p.amount else -p.amount end) as total
from postings p
join journal_entries e on e.id = p.entry_id
join categories c      on c.id = p.category_id
left join categories pc on pc.id = c.parent_id
group by 1, 2, 3, 4, 5, 6, 7, 8;

create or replace view v_month_summary with (security_invoker = true) as
select user_id, month, currency,
       coalesce(sum(total) filter (where kind = 'income'),  0) as income,
       coalesce(sum(total) filter (where kind = 'expense'), 0) as expense,
       coalesce(sum(total) filter (where kind = 'income'),  0)
     - coalesce(sum(total) filter (where kind = 'expense'), 0) as net
from v_category_monthly
group by user_id, month, currency;

-- ---------- Net varlık geçmişi: defter olduğu için HER TARİH yeniden kurulur ---
create or replace function net_worth_history(p_months int default 12)
returns table (month_end date, currency char(3), assets numeric, receivables numeric,
               liabilities numeric, net_worth numeric)
language sql stable security invoker set search_path = public, pg_temp as $$
  with months as (
    select (date_trunc('month', current_date) - make_interval(months => g)
            + interval '1 month - 1 day')::date as m
    from generate_series(0, greatest(least(p_months, 120), 1) - 1) g
  )
  select m, a.currency,
    coalesce(sum(p.amount)  filter (where account_class_of(a.kind) = 'asset' and a.kind <> 'receivable'), 0),
    coalesce(sum(p.amount)  filter (where a.kind = 'receivable'), 0),
    coalesce(-sum(p.amount) filter (where account_class_of(a.kind) = 'liability'), 0),
    coalesce(sum(p.amount)  filter (where account_class_of(a.kind) in ('asset','liability')), 0)
  from months
  join journal_entries e on e.entry_date <= months.m
  join postings p        on p.entry_id = e.id
  join accounts a        on a.id = p.account_id and not a.is_system
  group by m, a.currency
  order by m, a.currency
$$;

-- =====================================================================
--  ROW LEVEL SECURITY — kullanıcı SADECE kendi verisini görür
-- =====================================================================
alter table profiles            enable row level security;
alter table institutions        enable row level security;
alter table counterparties      enable row level security;
alter table accounts            enable row level security;
alter table credit_card_details enable row level security;
alter table categories          enable row level security;
alter table journal_entries     enable row level security;
alter table postings            enable row level security;
alter table attachments         enable row level security;
alter table budgets             enable row level security;
alter table recurring_rules     enable row level security;
alter table scheduled_items     enable row level security;
alter table exchange_rates      enable row level security;
alter table audit_log           enable row level security;
alter table currencies          enable row level security;

create policy currencies_read on currencies for select to authenticated using (true);

create policy profiles_own on profiles for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Serbest CRUD (sahibi olduğu kayıtlar)
do $$
declare t text;
begin
  foreach t in array array['institutions','counterparties','categories','attachments',
                           'budgets','recurring_rules','scheduled_items','exchange_rates']
  loop
    execute format(
      'create policy %1$s_own on %1$I for all to authenticated
         using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- Hesaplar: okuma + ad/renk/sıra/limit/arşiv güncelleme. Açma sadece create_account ile.
create policy accounts_read   on accounts for select to authenticated using (user_id = (select auth.uid()));
create policy accounts_update on accounts for update to authenticated
  using (user_id = (select auth.uid()) and not is_system)
  with check (user_id = (select auth.uid()) and not is_system);

create policy ccd_read on credit_card_details for select to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.user_id = (select auth.uid())));
create policy ccd_update on credit_card_details for update to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.user_id = (select auth.uid())));

-- Defter: SADECE OKUMA. Yazma RPC fonksiyonlarından.
create policy entries_read  on journal_entries for select to authenticated using (user_id = (select auth.uid()));
create policy postings_read on postings        for select to authenticated using (user_id = (select auth.uid()));
create policy audit_read    on audit_log       for select to authenticated using (user_id = (select auth.uid()));

-- Hesap sütun kısıtı: tür/para birimi/sistem bayrağı istemciden değiştirilemez
revoke update on accounts from authenticated;
grant  update (name, color, sort_order, credit_limit, iban_last4, archived_at, institution_id)
  on accounts to authenticated;

-- =====================================================================
--  FONKSİYON YETKİLERİ
-- =====================================================================
revoke execute on all functions in schema public from public, anon;

grant execute on function
  account_class_of(account_kind),
  create_account(text, account_kind, char, numeric, date, text, text, numeric, int, int, text, text),
  record_income(uuid, uuid, numeric, date, text, text),
  record_expense(uuid, uuid, numeric, date, text, text),
  record_transfer(uuid, uuid, numeric, numeric, date, text, text),
  record_split_expense(uuid, jsonb, date, text, text),
  adjust_balance(uuid, numeric, date, text),
  reverse_entry(uuid, text),
  update_entry_description(uuid, text),
  net_worth_history(int)
to authenticated;

-- İç yardımcılar istemciye kapalı
revoke execute on function
  _uid(), _today(uuid), _check_amount(numeric), _check_date(uuid, date),
  _owned_account(uuid, uuid), _owned_category(uuid, uuid, category_kind),
  _existing_entry(uuid, text), _system_account(uuid, account_kind, char),
  _new_entry(uuid, date, entry_kind, text, text, uuid),
  _post(uuid, uuid, uuid, numeric, char, text),
  seed_default_categories(uuid), handle_new_user(), _transfer_kind(account_kind, account_kind, boolean)
from authenticated;

alter default privileges in schema public revoke execute on functions from public, anon;
