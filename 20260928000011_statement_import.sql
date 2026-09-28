-- =====================================================================
--  0011 · Banka ekstresi içe aktarma
--   • card_statement_imports: bankanın kestiği gerçek ekstre özeti (adres/kimlik bilgisi SAKLANMAZ)
--   • import_card_statement(): yeni kalemleri, ödemeleri ve kart profilini TEK adımda işler (hepsi ya da hiçbiri)
--   • card_statements(): yüklenmiş gerçek ekstre varsa hesaplanan yerine onu kullanır (son ödeme, asgari, borç)
--   • statement_status(): kart başına ekstre güncelliği ve defterle fark
-- =====================================================================

create table card_statement_imports (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id         uuid not null references accounts(id) on delete cascade,
  bank               text not null,
  file_hash          text not null check (length(file_hash) >= 32),
  cut_date           date not null,
  period_start       date,
  due_date           date,
  next_cut_date      date,
  next_due_date      date,
  statement_debt     numeric(20,2) not null check (statement_debt >= 0),
  min_payment        numeric(20,2) check (min_payment >= 0),
  previous_balance   numeric(20,2),
  credit_limit       numeric(20,2),
  available_limit    numeric(20,2),
  cash_limit         numeric(20,2),
  purchase_rate      numeric(6,3),
  cash_rate          numeric(6,3),
  late_rate          numeric(6,3),
  ledger_debt_before numeric(20,2),
  ledger_debt_after  numeric(20,2),
  lines              jsonb not null default '[]'::jsonb,
  n_lines            int not null default 0,
  n_added            int not null default 0,
  n_matched          int not null default 0,
  imported_at        timestamptz not null default now(),
  unique (account_id, cut_date)
);
create unique index card_statement_imports_hash_uq on card_statement_imports (user_id, file_hash);
create index card_statement_imports_user_cut_idx on card_statement_imports (user_id, cut_date desc);

alter table card_statement_imports enable row level security;
create policy csi_read   on card_statement_imports for select to authenticated using (user_id = (select auth.uid()));
create policy csi_delete on card_statement_imports for delete to authenticated using (user_id = (select auth.uid()));
revoke insert, update on card_statement_imports from authenticated;

-- Ekstre kesimindeki tutar: kart borcu − o kesimden sonra faturalanacak taksitler (card_statements ile aynı formül)
create or replace function _card_derived_statement(p_account uuid, p_cut date)
returns numeric language sql stable as $$
  select greatest(_card_owed_at(p_account, p_cut) - _card_unbilled_after(p_account, p_cut), 0)
$$;

-- Önizleme için: defterin o kesimdeki durumu
create or replace function statement_reconcile(p_account_id uuid, p_cut date)
returns table (owed numeric, unbilled numeric, derived numeric)
language sql stable security invoker set search_path = public, pg_temp as $$
  select _card_owed_at(a.id, p_cut), _card_unbilled_after(a.id, p_cut), _card_derived_statement(a.id, p_cut)
  from accounts a where a.id = p_account_id and a.user_id = auth.uid()
$$;

-- ---------------------------------------------------------------------
--  İçe aktarma (atomik). Payload: bkz. web/src/lib/statements/import.ts
-- ---------------------------------------------------------------------
create or replace function import_card_statement(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := _uid();
  v_acc   accounts;
  v_cut   date    := (p->>'cut_date')::date;
  v_due   date    := nullif(p->>'due_date', '')::date;
  v_hash  text    := nullif(trim(p->>'file_hash'), '');
  v_debt  numeric := (p->>'statement_debt')::numeric;
  v_min   numeric := nullif(p->>'min_payment', '')::numeric;
  v_repl  boolean := coalesce((p->>'replace')::boolean, false);
  l       jsonb;
  rid     text;
  v_kind  text; v_amt numeric; v_date date; v_cat uuid; v_desc text; v_key text; v_inst int;
  v_id    uuid; v_eq uuid; v_src uuid; v_pct numeric;
  n_add int := 0; n_pay int := 0; n_skip int := 0; n_rev int := 0; n_match int := 0; n_total int := 0;
  v_before numeric; v_after numeric;
  v_lines jsonb := '[]'::jsonb;
  v_created jsonb := '[]'::jsonb;
begin
  if v_hash is null or v_cut is null or v_debt is null then
    raise exception 'Ekstre bilgisi eksik (hash, kesim tarihi, dönem borcu)' using errcode = '22023';
  end if;
  v_acc := _owned_account(v_uid, (p->>'account_id')::uuid);
  if v_acc.kind <> 'credit_card' then
    raise exception 'Ekstre yalnızca kredi kartına yüklenebilir' using errcode = '22023';
  end if;

  if not v_repl then
    if exists (select 1 from card_statement_imports where user_id = v_uid and file_hash = v_hash) then
      raise exception 'Bu ekstre dosyası daha önce yüklenmiş' using errcode = '23505';
    end if;
    if exists (select 1 from card_statement_imports where account_id = v_acc.id and cut_date = v_cut) then
      raise exception '% kesim tarihli ekstre bu kart için zaten kayıtlı', to_char(v_cut, 'DD.MM.YYYY') using errcode = '23505';
    end if;
  else
    delete from card_statement_imports where user_id = v_uid and (file_hash = v_hash or (account_id = v_acc.id and cut_date = v_cut));
  end if;

  v_before := _card_derived_statement(v_acc.id, v_cut);
  v_eq := _system_account(v_uid, 'equity', v_acc.currency);

  for l in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    n_total := n_total + 1;
    v_kind := l->>'kind';
    if l->>'status' in ('matched', 'maybe') then n_match := n_match + 1; end if;

    if coalesce(l->>'action', 'skip') <> 'add' then
      n_skip := n_skip + 1;
      v_lines := v_lines || jsonb_build_object('idx', l->'idx', 'date', l->>'date', 'description', l->>'description', 'amount', (l->>'amount')::numeric,
                                               'kind', v_kind, 'status', l->>'status', 'action', 'skip', 'entry_id', l->>'entry_id');
      continue;
    end if;

    v_amt  := (l->>'amount')::numeric;
    v_date := (l->>'date')::date;
    v_desc := nullif(trim(l->>'description'), '');
    v_key  := 'st:' || left(v_hash, 24) || ':' || (l->>'idx');
    v_id   := null;

    if v_kind = 'payment' then
      v_src := nullif(l->>'source_account_id', '')::uuid;
      if v_src is not null then
        v_id := record_transfer(v_src, v_acc.id, abs(v_amt), null, v_date, coalesce(v_desc, 'Kart ödemesi (ekstre)'), v_key);
      else
        v_id := _existing_entry(v_uid, v_key);
        if v_id is null then
          v_id := _new_entry(v_uid, _check_date(v_uid, v_date), 'card_payment',
                             coalesce(v_desc, 'Kart ödemesi') || ' [ekstre, kaynak belirsiz]', v_key);
          perform _post(v_id, v_acc.id, null,  abs(v_amt), v_acc.currency);
          perform _post(v_id, v_eq,     null, -abs(v_amt), v_acc.currency);
        end if;
      end if;
      n_pay := n_pay + 1;
    elsif v_kind = 'refund' or v_amt <= 0 then
      raise exception 'İade/negatif kalem (%) otomatik eklenemez; atlayın veya elle girin', coalesce(v_desc, 'satır ' || (l->>'idx')) using errcode = '22023';
    else
      v_cat := nullif(l->>'category_id', '')::uuid;
      if v_cat is null then
        select id into v_cat from categories
        where user_id = v_uid and kind = 'expense'
          and system_key = case when v_kind in ('interest', 'tax') then 'card_interest' when v_kind = 'fee' then 'bank_fee' end
        limit 1;
      end if;
      if v_cat is null then
        select id into v_cat from categories where user_id = v_uid and kind = 'expense' and parent_id is null and name = 'Diğer Gider' limit 1;
      end if;
      if v_cat is null then raise exception 'Kategori seçilmedi ve varsayılan kategori bulunamadı' using errcode = '22023'; end if;
      v_inst := coalesce(nullif(l->>'installments', '')::int, 1);
      -- Taksitli alışverişte tam tutar ve tahmini alışveriş tarihiyle plan açılır
      v_id := record_expense(v_acc.id, v_cat, coalesce(nullif(l->>'purchase_amount', '')::numeric, v_amt), v_date, v_desc, v_key, v_inst);
      n_add := n_add + 1;
    end if;

    v_created := v_created || to_jsonb(v_id);
    v_lines := v_lines || jsonb_build_object('idx', l->'idx', 'date', l->>'date', 'description', l->>'description', 'amount', v_amt,
                                             'kind', v_kind, 'status', l->>'status', 'action', 'add', 'entry_id', v_id);
  end loop;

  -- Tahmini (otomatik faiz tahakkuku gibi) kayıtların ekstredeki gerçekleriyle değiştirilmesi
  for rid in select * from jsonb_array_elements_text(coalesce(p->'reverse_entries', '[]'::jsonb)) loop
    if exists (select 1 from postings po where po.entry_id = rid::uuid and po.account_id = v_acc.id) then
      perform reverse_entry(rid::uuid, 'Ekstre ile değiştirildi');
      n_rev := n_rev + 1;
    end if;
  end loop;

  -- Kart profili: limit, kesim/son ödeme günü, asgari ödeme oranı
  if coalesce((p->>'update_profile')::boolean, false) then
    if nullif(p->>'limit', '') is not null then
      update accounts set credit_limit = (p->>'limit')::numeric where id = v_acc.id;
    end if;
    v_pct := nullif(p->>'min_payment_pct', '')::numeric;
    if v_pct is null and v_min is not null and v_debt > 0 then v_pct := round(v_min / v_debt * 100); end if;
    update credit_card_details
       set statement_day   = extract(day from v_cut)::smallint,
           due_day         = coalesce(extract(day from v_due)::smallint, due_day),
           min_payment_pct = coalesce(least(greatest(v_pct, 0), 100), min_payment_pct)
     where account_id = v_acc.id;
  end if;

  v_after := _card_derived_statement(v_acc.id, v_cut);

  insert into card_statement_imports (
    user_id, account_id, bank, file_hash, cut_date, period_start, due_date, next_cut_date, next_due_date,
    statement_debt, min_payment, previous_balance, credit_limit, available_limit, cash_limit,
    purchase_rate, cash_rate, late_rate, ledger_debt_before, ledger_debt_after, lines, n_lines, n_added, n_matched)
  values (
    v_uid, v_acc.id, coalesce(p->>'bank', '?'), v_hash, v_cut, nullif(p->>'period_start', '')::date, v_due,
    nullif(p->>'next_cut_date', '')::date, nullif(p->>'next_due_date', '')::date,
    v_debt, v_min, nullif(p->>'previous_balance', '')::numeric, nullif(p->>'limit', '')::numeric,
    nullif(p->>'available_limit', '')::numeric, nullif(p->>'cash_limit', '')::numeric,
    nullif(p->>'purchase_rate', '')::numeric, nullif(p->>'cash_rate', '')::numeric, nullif(p->>'late_rate', '')::numeric,
    v_before, v_after, v_lines, n_total, n_add + n_pay, n_match);

  return jsonb_build_object('added', n_add, 'payments', n_pay, 'skipped', n_skip, 'reversed', n_rev,
                            'ledger_before', v_before, 'ledger_after', v_after, 'statement_debt', v_debt,
                            'difference_after', round(v_after - v_debt, 2), 'entry_ids', v_created);
end $$;

-- ---------------------------------------------------------------------
--  Gerçek ekstre varsa kart ekstre hesabında onu kullan
-- ---------------------------------------------------------------------
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
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------
--  Kart başına ekstre güncelliği
-- ---------------------------------------------------------------------
create or replace function statement_status()
returns table (account_id uuid, name text, last4 text, last_cut date, last_due date, statement_debt numeric,
               min_payment numeric, imported_at timestamptz, next_cut date, next_due date, days_since_cut int,
               is_stale boolean, ledger_debt numeric, diff numeric, stmt_limit numeric, sys_limit numeric, bank text)
language sql stable security invoker set search_path = public, pg_temp as $$
  select a.id, a.name, a.iban_last4, s.cut_date, s.due_date, s.statement_debt, s.min_payment, s.imported_at,
         s.next_cut_date, s.next_due_date,
         case when s.id is not null then _today(auth.uid()) - s.cut_date end,
         s.id is null or _today(auth.uid()) >= coalesce(s.next_cut_date, s.cut_date + 31),
         case when s.id is not null then _card_derived_statement(a.id, s.cut_date) end,
         case when s.id is not null then round(_card_derived_statement(a.id, s.cut_date) - s.statement_debt, 2) end,
         s.credit_limit, a.credit_limit, s.bank
  from accounts a
  left join lateral (select x.* from card_statement_imports x where x.account_id = a.id order by x.cut_date desc limit 1) s on true
  where a.kind = 'credit_card' and a.archived_at is null and not a.is_system
  order by a.sort_order, a.name
$$;

grant execute on function import_card_statement(jsonb), statement_status(), statement_reconcile(uuid, date),
  _card_derived_statement(uuid, date) to authenticated;
