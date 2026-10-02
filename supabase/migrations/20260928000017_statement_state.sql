-- =====================================================================
--  0017 · Ekstre durumu: ödeme yapıldı mı · ekstre kapandı mı
--   • card_statements(): kartın en yeni kesilmiş ekstresi = GÜNCEL ekstre (durumu ödemelere göre);
--                        ondan eski tüm ekstreler 'closed' (kapandı, ödenmiş sayılır)
--   • statement_status(): son yüklenen ekstre için ödenen, kalan, asgari karşılandı mı, ödeme durumu, kapandı mı
-- =====================================================================

create or replace function card_statements(p_account_id uuid, p_count int default 6)
returns table (cut_date date, period_start date, due_date date, statement_amount numeric,
               min_payment numeric, paid numeric, remaining numeric, status text, is_current boolean)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  cc      credit_card_details;
  v_open  date;
  v_today date := _today(auth.uid());
  v_next  date;
  v_snap  card_statement_imports;
  v_gen   date;
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
    v_gen        := cut_date;
    v_snap := null;
    if not is_current then
      select s.* into v_snap from card_statement_imports s
      where s.account_id = p_account_id and abs(s.cut_date - v_gen) <= 3
      order by abs(s.cut_date - v_gen), s.imported_at desc limit 1;
    end if;

    if v_snap.id is not null then
      cut_date         := v_snap.cut_date;
      due_date         := coalesce(v_snap.due_date, due_date);
      statement_amount := v_snap.statement_debt;
    else
      statement_amount := greatest(_card_owed_at(p_account_id, least(cut_date, v_today))
                                   - _card_unbilled_after(p_account_id, cut_date), 0);
    end if;

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
    min_payment := case when v_snap.id is not null and v_snap.min_payment is not null
                        then least(v_snap.min_payment, statement_amount)
                        else least(round(statement_amount * cc.min_payment_pct / 100, 2), statement_amount) end;
    status := case
      when is_current                                  then 'open_period'
      when statement_amount = 0 or remaining = 0       then 'paid'
      when v_today > due_date                          then 'overdue'
      when paid > 0                                    then 'partial'
      else 'awaiting' end;
    -- Kartın en yeni kesilmiş ekstresi (i = 1) GÜNCEL ekstredir; ondan eski her ekstre kapanmış, ödenmiş sayılır.
    -- (Yeni ekstre devreden borcu zaten içerir; eskilerin ödemesi ayrıca izlenirse borç iki kez sayılır.)
    if not is_current and i >= 2 then
      paid := statement_amount; remaining := 0; status := 'closed';
    end if;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------
--  Kart başına son ekstre + ödeme durumu
--   pay_status: paid (tamamı ödendi → ekstre kapandı) · partial · awaiting · overdue (vadesi geçti, kalan var)
-- ---------------------------------------------------------------------
drop function if exists statement_status();
create function statement_status()
returns table (account_id uuid, name text, last4 text, last_cut date, last_due date, statement_debt numeric,
               min_payment numeric, imported_at timestamptz, next_cut date, next_due date, days_since_cut int,
               is_stale boolean, ledger_debt numeric, diff numeric, stmt_limit numeric, sys_limit numeric, bank text,
               paid numeric, remaining numeric, min_met boolean, pay_status text, is_closed boolean)
language sql stable security invoker set search_path = public, pg_temp as $$
  select q.account_id, q.name, q.last4, q.last_cut, q.last_due, q.statement_debt, q.min_payment, q.imported_at,
         q.next_cut, q.next_due, q.days_since_cut, q.is_stale, q.ledger_debt, q.diff, q.stmt_limit, q.sys_limit, q.bank,
         q.paid, q.remaining,
         case when q.last_cut is not null then q.paid >= coalesce(q.min_payment, 0) end,
         case when q.last_cut is null then null
              when q.remaining <= 0 then 'paid'
              when _today(auth.uid()) > coalesce(q.last_due, q.last_cut + 10) then 'overdue'
              when q.paid > 0 then 'partial'
              else 'awaiting' end,
         case when q.last_cut is not null then q.remaining <= 0 end
  from (
    select a.id as account_id, a.name, a.iban_last4 as last4, s.cut_date as last_cut, s.due_date as last_due,
           s.statement_debt, s.min_payment, s.imported_at, s.next_cut_date as next_cut, s.next_due_date as next_due,
           case when s.id is not null then _today(auth.uid()) - s.cut_date end as days_since_cut,
           s.id is null or _today(auth.uid()) >= coalesce(s.next_cut_date, s.cut_date + 31) as is_stale,
           case when s.id is not null then _card_derived_statement(a.id, s.cut_date) end as ledger_debt,
           case when s.id is not null then round(_card_derived_statement(a.id, s.cut_date) - s.statement_debt, 2) end as diff,
           s.credit_limit as stmt_limit, a.credit_limit as sys_limit, s.bank,
           case when s.id is not null then x.paid end as paid,
           case when s.id is not null then greatest(s.statement_debt - x.paid, 0) end as remaining,
           a.sort_order
    from accounts a
    left join lateral (select y.* from card_statement_imports y where y.account_id = a.id order by y.cut_date desc limit 1) s on true
    left join lateral (
      select least(coalesce(sum(p.amount), 0), s.statement_debt) as paid
      from postings p join journal_entries e on e.id = p.entry_id
      where p.account_id = a.id and p.amount > 0 and e.entry_date > s.cut_date and e.entry_date <= _today(auth.uid())
    ) x on s.id is not null
    where a.kind = 'credit_card' and a.archived_at is null and not a.is_system
  ) q
  order by q.sort_order, q.name
$$;

revoke execute on function statement_status() from public, anon;
grant  execute on function statement_status() to authenticated;
