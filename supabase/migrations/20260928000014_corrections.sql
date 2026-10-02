-- =====================================================================
--  0014 · Düzeltme araçları (tüm ekranlar için)
--   • amend_entry():        işlemin tarih/tutar/kategori/hesap/açıklamasını düzeltir (eski kayıt iptal, yenisi yazılır)
--   • update_account():     hesap adı, kurum, limit, kesim/son ödeme günü, asgari oranı, son 4 hane
--   • set_opening_balance(): açılış / devreden bakiyeyi düzeltir (eski açılış kaydı iptal, yenisi yazılır)
--  Defter kuralı: hiçbir kayıt silinmez; her düzeltme iz bırakır.
-- =====================================================================

create or replace function amend_entry(p_entry_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  e      journal_entries;
  v_date date;
  v_desc text;
  v_amt  numeric;
  v_acc  uuid;
  v_cat  uuid;
  v_from uuid;
  v_to   uuid;
  v_toamt numeric;
  v_key  text;
  v_new  uuid;
  n_cat  int;
  n_acc  int;
  r_from postings;
  r_to   postings;
begin
  select * into e from journal_entries where id = p_entry_id and user_id = v_uid for update;
  if not found then raise exception 'Kayıt bulunamadı' using errcode = 'P0002'; end if;
  if e.status <> 'posted' or e.kind = 'reversal' then
    raise exception 'Yalnızca geçerli kayıtlar düzenlenebilir' using errcode = '22023';
  end if;
  if e.idempotency_key like 'st:%' then
    raise exception 'Bu kayıt bir ekstreden geldi; Ekstre ekranındaki "Yüklenen ekstreler" bölümünden düzeltin' using errcode = '22023';
  end if;
  if exists (select 1 from card_installment_plans where entry_id = e.id) then
    raise exception 'Taksitli alışveriş düzenlenemez; iptal edip yeniden girin' using errcode = '22023';
  end if;
  if exists (select 1 from loan_installments where paid_entry_id = e.id)
     or exists (select 1 from scheduled_items where realized_entry_id = e.id) then
    raise exception 'Kredi taksidine veya planlı kaleme bağlı kayıt düzenlenemez; iptal edin' using errcode = '22023';
  end if;

  v_date := coalesce(nullif(p->>'date', '')::date, e.entry_date);
  v_desc := case when p ? 'description' then nullif(trim(p->>'description'), '') else e.description end;
  v_key  := 'amend:' || e.id::text;

  if e.kind in ('income', 'expense', 'card_purchase') then
    select count(*) into n_cat from postings where entry_id = e.id and category_id is not null;
    select count(*) into n_acc from postings po join accounts a on a.id = po.account_id
      where po.entry_id = e.id and not a.is_system;
    if n_cat <> 1 or n_acc <> 1 then
      raise exception 'Bölünmüş kayıt düzenlenemez; iptal edip yeniden girin' using errcode = '22023';
    end if;
    select po.account_id into v_acc from postings po join accounts a on a.id = po.account_id where po.entry_id = e.id and not a.is_system;
    select po.category_id, abs(po.amount) into v_cat, v_amt from postings po where po.entry_id = e.id and po.category_id is not null;
    v_acc := coalesce(nullif(p->>'account_id', '')::uuid, v_acc);
    v_cat := coalesce(nullif(p->>'category_id', '')::uuid, v_cat);
    v_amt := coalesce(nullif(p->>'amount', '')::numeric, v_amt);
    if v_amt is null or v_amt <= 0 then raise exception 'Tutar sıfırdan büyük olmalı' using errcode = '22023'; end if;
    perform reverse_entry(e.id, 'Düzeltme');
    if e.kind = 'income' then
      v_new := record_income(v_acc, v_cat, v_amt, v_date, v_desc, v_key);
    else
      v_new := record_expense(v_acc, v_cat, v_amt, v_date, v_desc, v_key);
    end if;

  elsif e.kind in ('transfer', 'card_payment') then
    select count(*) into n_acc from postings po join accounts a on a.id = po.account_id
      where po.entry_id = e.id and not a.is_system;
    if n_acc <> 2 then
      raise exception 'Bu kayıt türü düzenlenemez; iptal edip yeniden girin' using errcode = '22023';
    end if;
    select po.* into r_from from postings po join accounts a on a.id = po.account_id where po.entry_id = e.id and not a.is_system and po.amount < 0 limit 1;
    select po.* into r_to   from postings po join accounts a on a.id = po.account_id where po.entry_id = e.id and not a.is_system and po.amount > 0 limit 1;
    if r_from.id is null or r_to.id is null then
      raise exception 'Bu kayıt türü düzenlenemez; iptal edip yeniden girin' using errcode = '22023';
    end if;
    v_from := coalesce(nullif(p->>'from_account_id', '')::uuid, r_from.account_id);
    v_to   := coalesce(nullif(p->>'to_account_id', '')::uuid, r_to.account_id);
    v_amt  := coalesce(nullif(p->>'amount', '')::numeric, abs(r_from.amount));
    v_toamt := case when r_from.currency <> r_to.currency then coalesce(nullif(p->>'to_amount', '')::numeric, abs(r_to.amount)) end;
    if v_amt is null or v_amt <= 0 then raise exception 'Tutar sıfırdan büyük olmalı' using errcode = '22023'; end if;
    perform reverse_entry(e.id, 'Düzeltme');
    v_new := record_transfer(v_from, v_to, v_amt, v_toamt, v_date, v_desc, v_key);

  else
    raise exception 'Bu kayıt türü düzenlenemez; iptal edip yeniden girin' using errcode = '22023';
  end if;

  update attachments set entry_id = v_new where entry_id = e.id and user_id = v_uid;
  return v_new;
end $$;

-- ---------------------------------------------------------------------
create or replace function update_account(p_id uuid, p jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  a      accounts;
  v_inst uuid;
begin
  select * into a from accounts where id = p_id and user_id = v_uid and not is_system for update;
  if not found then raise exception 'Hesap bulunamadı' using errcode = 'P0002'; end if;

  v_inst := a.institution_id;
  if p ? 'institution_name' then
    if nullif(trim(p->>'institution_name'), '') is null then v_inst := null;
    else
      insert into institutions (user_id, name) values (v_uid, trim(p->>'institution_name'))
      on conflict (user_id, name) do update set name = excluded.name returning id into v_inst;
    end if;
  end if;

  update accounts set
    name           = coalesce(nullif(trim(p->>'name'), ''), name),
    institution_id = v_inst,
    color          = case when p ? 'color' then nullif(p->>'color', '') else color end,
    credit_limit   = case when p ? 'credit_limit' and kind in ('credit_card', 'overdraft') then nullif(p->>'credit_limit', '')::numeric else credit_limit end,
    iban_last4     = case when p ? 'iban_last4' then nullif(p->>'iban_last4', '') else iban_last4 end
  where id = a.id;

  if a.kind = 'credit_card' then
    update credit_card_details set
      statement_day   = coalesce(nullif(p->>'statement_day', '')::smallint, statement_day),
      due_day         = coalesce(nullif(p->>'due_day', '')::smallint, due_day),
      min_payment_pct = coalesce(nullif(p->>'min_payment_pct', '')::numeric, min_payment_pct)
    where account_id = a.id;
  end if;
end $$;

-- ---------------------------------------------------------------------
--  Açılış / devreden bakiyeyi düzelt. Borç hesaplarında tutar = borç (pozitif). 0 verilirse açılış kaydı kaldırılır (iptal edilir).
-- ---------------------------------------------------------------------
create or replace function set_opening_balance(p_account_id uuid, p_amount numeric, p_date date default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  a      accounts;
  v_date date;
  v_raw  numeric;
  v_id   uuid;
  r      record;
begin
  select * into a from accounts where id = p_account_id and user_id = v_uid and not is_system for update;
  if not found then raise exception 'Hesap bulunamadı' using errcode = 'P0002'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Açılış tutarı eksi olamaz' using errcode = '22023'; end if;

  for r in select distinct e.id from journal_entries e join postings po on po.entry_id = e.id
           where e.user_id = v_uid and e.kind = 'opening_balance' and e.status = 'posted' and po.account_id = a.id loop
    perform reverse_entry(r.id, 'Açılış bakiyesi düzeltildi');
  end loop;
  if p_amount = 0 then return null; end if;

  v_date := _check_date(v_uid, coalesce(p_date, a.opened_on));
  if v_date < a.opened_on then update accounts set opened_on = v_date where id = a.id; end if;
  v_raw := case when account_class_of(a.kind) = 'liability' then -p_amount else p_amount end;
  v_id := _new_entry(v_uid, v_date, 'opening_balance', 'Açılış bakiyesi: ' || a.name, null);
  perform _post(v_id, a.id, null, v_raw, a.currency);
  perform _post(v_id, _system_account(v_uid, 'equity', a.currency), null, -v_raw, a.currency);
  return v_id;
end $$;

revoke execute on function amend_entry(uuid, jsonb), update_account(uuid, jsonb), set_opening_balance(uuid, numeric, date) from public, anon;
grant  execute on function amend_entry(uuid, jsonb), update_account(uuid, jsonb), set_opening_balance(uuid, numeric, date) to authenticated;
