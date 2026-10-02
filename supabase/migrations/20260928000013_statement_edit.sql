-- =====================================================================
--  0013 · Ekstre düzenleme
--   • _statement_entry(): ekstre satırından defter kaydı üretir (içe aktarma ve düzeltme AYNI kodu kullanır)
--   • import_card_statement(): iade satırlarını da işler; satırların kategori/kaynak/taksit bilgisini saklar
--   • amend_statement_line(): yüklenmiş ekstrede satır DÜZENLE / EKLE / ÇIKAR (kayıt silinmez: eskisi iptal, yenisi yazılır)
--   • update_statement(): ekstre başlığını (kesim, son ödeme, borç, asgari, limit…) düzeltir
--   • delete_statement(): ekstreyi siler, istenirse eklediği kayıtları da iptal eder
--  Defter kuralı korunur: hiçbir kayıt silinmez; her düzeltme ters kayıt + yeni kayıt olarak iz bırakır.
-- =====================================================================

-- ---------------------------------------------------------------------
--  Tek satır → defter kaydı
--   kind: payment · refund (borcu AZALTIR) · purchase · installment · cash_advance · interest · tax · fee (borcu ARTIRIR)
--   Tutar işareti önemsizdir; yönü `kind` belirler.
-- ---------------------------------------------------------------------
create or replace function _statement_entry(p_uid uuid, p_acc accounts, p_key text, l jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text    := coalesce(nullif(l->>'kind', ''), 'purchase');
  v_amt  numeric := abs((l->>'amount')::numeric);
  v_date date    := (l->>'date')::date;
  v_desc text    := nullif(trim(l->>'description'), '');
  v_src  uuid    := nullif(l->>'source_account_id', '')::uuid;
  v_cat  uuid    := nullif(l->>'category_id', '')::uuid;
  v_inst int     := greatest(coalesce(nullif(l->>'installments', '')::int, 1), 1);
  v_id   uuid;
  v_eq   uuid;
begin
  if v_amt is null or v_amt = 0 then
    raise exception 'Tutar sıfırdan büyük olmalı' using errcode = '22023';
  end if;
  if v_date is null then
    raise exception 'Tarih zorunlu' using errcode = '22023';
  end if;

  -- Borcu azaltanlar
  if v_kind in ('payment', 'refund') then
    if v_kind = 'payment' and v_src is not null then
      return record_transfer(v_src, p_acc.id, v_amt, null, v_date, coalesce(v_desc, 'Kart ödemesi (ekstre)'), p_key);
    end if;
    v_id := _existing_entry(p_uid, p_key);
    if v_id is null then
      v_eq := _system_account(p_uid, 'equity', p_acc.currency);
      v_id := _new_entry(p_uid, _check_date(p_uid, v_date), 'card_payment',
                         case when v_kind = 'refund' then coalesce(v_desc, 'İade') || ' [iade, ekstre]'
                              else coalesce(v_desc, 'Kart ödemesi') || ' [ekstre, kaynak belirsiz]' end, p_key);
      perform _post(v_id, p_acc.id, null,  v_amt, p_acc.currency);
      perform _post(v_id, v_eq,     null, -v_amt, p_acc.currency);
    end if;
    return v_id;
  end if;

  -- Borcu artıranlar
  if v_cat is null then
    select id into v_cat from categories
    where user_id = p_uid and kind = 'expense'
      and system_key = case when v_kind in ('interest', 'tax') then 'card_interest' when v_kind = 'fee' then 'bank_fee' end
    limit 1;
  end if;
  if v_cat is null then
    select id into v_cat from categories where user_id = p_uid and kind = 'expense' and parent_id is null and name = 'Diğer Gider' limit 1;
  end if;
  if v_cat is null then
    raise exception 'Kategori seçilmedi ve varsayılan kategori bulunamadı' using errcode = '22023';
  end if;
  -- Taksitli kalemde plan: kalan taksitlerin toplamı (purchase_amount) ve kalan taksit sayısı (installments)
  return record_expense(p_acc.id, v_cat,
                        case when v_inst > 1 then coalesce(nullif(l->>'purchase_amount', '')::numeric, round(v_amt * v_inst, 2)) else v_amt end,
                        v_date, v_desc, p_key, v_inst);
end $$;

-- Kaydın İPTAL edilebilir durumda olup olmadığı
create or replace function _entry_open(p_uid uuid, p_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from journal_entries where id = p_id and user_id = p_uid and status = 'posted' and kind <> 'reversal')
$$;

-- Satırı saklanacak biçime getirir: yön `kind`den, işaret buna göre
create or replace function _statement_line_json(l jsonb)
returns jsonb language sql immutable as $$
  select l || jsonb_build_object('amount',
    case when coalesce(l->>'kind', 'purchase') in ('payment', 'refund') then -abs((l->>'amount')::numeric) else abs((l->>'amount')::numeric) end)
$$;

-- ---------------------------------------------------------------------
--  İçe aktarma (0011'deki ile aynı sözleşme; ortak koda geçti, iade desteği eklendi)
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
  v_kind  text; v_key text; v_id uuid; v_pct numeric;
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

  for l in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    n_total := n_total + 1;
    v_kind := coalesce(nullif(l->>'kind', ''), 'purchase');
    if l->>'status' in ('matched', 'maybe') then n_match := n_match + 1; end if;

    if coalesce(l->>'action', 'skip') <> 'add' then
      n_skip := n_skip + 1;
      v_lines := v_lines || _statement_line_json(l || jsonb_build_object('action', 'skip'));
      continue;
    end if;

    v_key := 'st:' || left(v_hash, 24) || ':' || (l->>'idx');
    v_id  := _statement_entry(v_uid, v_acc, v_key, l);
    if v_kind in ('payment', 'refund') then n_pay := n_pay + 1; else n_add := n_add + 1; end if;
    v_created := v_created || to_jsonb(v_id);
    v_lines := v_lines || _statement_line_json(l || jsonb_build_object('action', 'add', 'entry_id', v_id, 'ver', 0));
  end loop;

  for rid in select * from jsonb_array_elements_text(coalesce(p->'reverse_entries', '[]'::jsonb)) loop
    if exists (select 1 from postings po where po.entry_id = rid::uuid and po.account_id = v_acc.id)
       and _entry_open(v_uid, rid::uuid) then
      perform reverse_entry(rid::uuid, 'Ekstre ile değiştirildi');
      n_rev := n_rev + 1;
    end if;
  end loop;

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
--  Yüklenmiş ekstrede satır düzenleme
--   op = 'edit'   : alanları değiştirir (date, description, kind, amount, category_id, source_account_id, installments,
--                   purchase_amount). `include` true/false: atlanmış satırı deftere ekle / eklenmiş satırı defterden çıkar
--       'add'     : yeni (manuel) satır ekler ve deftere yazar
--       'remove'  : satırı ekstreden çıkarır (defterdeki kaydı iptal eder)
--   Eklenmiş bir satır değişince eski kayıt İPTAL edilir, yenisi yazılır.
--   Ekstre yüklenirken "mevcut kayıtla eşleşti" diye ATLANAN satırların defter kaydına dokunulmaz.
-- ---------------------------------------------------------------------
create or replace function amend_statement_line(p_import_id uuid, p_idx int, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := _uid();
  i       card_statement_imports;
  a       accounts;
  op      text := coalesce(p->>'op', 'edit');
  v_lines jsonb;
  v_pos   int;
  l       jsonb;
  m       jsonb;
  v_idx   int;
  v_ver   int;
  v_old   uuid;
  v_new   uuid;
  v_want  boolean;
  v_after numeric;
begin
  select * into i from card_statement_imports where id = p_import_id and user_id = v_uid for update;
  if not found then raise exception 'Ekstre bulunamadı' using errcode = 'P0002'; end if;
  a := _owned_account(v_uid, i.account_id);
  v_lines := i.lines;

  if op = 'add' then
    -- Satır numarası ASLA yeniden kullanılmaz: çıkarılmış satırların kayıt anahtarları da hesaba katılır
    v_idx := greatest(
      coalesce((select max((e->>'idx')::int) from jsonb_array_elements(v_lines) e), -1),
      coalesce((select max(split_part(j.idempotency_key, ':', 3)::int) from journal_entries j
                where j.user_id = v_uid and j.idempotency_key like 'st:' || left(i.file_hash, 24) || ':%'), -1)) + 1;
    l := (p - 'op') || jsonb_build_object('idx', v_idx, 'status', 'manual', 'action', 'add');
    v_new := _statement_entry(v_uid, a, 'st:' || left(i.file_hash, 24) || ':' || v_idx, l);
    v_lines := v_lines || _statement_line_json(l || jsonb_build_object('entry_id', v_new, 'ver', 0));

  elsif op in ('edit', 'remove') then
    select (n - 1)::int into v_pos from jsonb_array_elements(v_lines) with ordinality t(e, n) where (e->>'idx')::int = p_idx;
    if v_pos is null then raise exception 'Satır bulunamadı' using errcode = 'P0002'; end if;
    l := v_lines -> v_pos;
    v_old := nullif(l->>'entry_id', '')::uuid;

    if op = 'remove' then
      if l->>'action' = 'add' and v_old is not null and _entry_open(v_uid, v_old) then
        perform reverse_entry(v_old, 'Ekstre düzeltmesi: satır çıkarıldı');
      end if;
      v_lines := v_lines - v_pos;
    else
      m := l || ((p - 'op') - 'include');
      v_want := coalesce((p->>'include')::boolean, l->>'action' = 'add');
      if l->>'action' = 'add' and v_old is not null and _entry_open(v_uid, v_old) then
        perform reverse_entry(v_old, 'Ekstre düzeltmesi');
      end if;
      if v_want then
        v_ver := coalesce(nullif(l->>'ver', '')::int, 0) + 1;
        v_new := _statement_entry(v_uid, a, 'st:' || left(i.file_hash, 24) || ':' || p_idx || ':v' || v_ver, m);
        m := m || jsonb_build_object('action', 'add', 'entry_id', v_new, 'ver', v_ver);
      elsif l->>'action' = 'add' then
        m := m || jsonb_build_object('action', 'skip', 'entry_id', null);   -- defterden çıkarıldı
      else
        m := m || jsonb_build_object('action', 'skip');                      -- mevcut kayıtla eşleşen satır: bağ korunur
      end if;
      v_lines := jsonb_set(v_lines, array[v_pos::text], _statement_line_json(m));
    end if;
  else
    raise exception 'Geçersiz işlem: %', op using errcode = '22023';
  end if;

  v_after := _card_derived_statement(a.id, i.cut_date);
  update card_statement_imports
     set lines = v_lines, ledger_debt_after = v_after, n_lines = jsonb_array_length(v_lines),
         n_added = (select count(*) from jsonb_array_elements(v_lines) e where e->>'action' = 'add')
   where id = i.id;
  return jsonb_build_object('ledger_after', v_after, 'statement_debt', i.statement_debt, 'difference', round(v_after - i.statement_debt, 2));
end $$;

-- ---------------------------------------------------------------------
--  Ekstre başlığını düzelt (yalnızca gönderilen alanlar değişir; null göndermek alanı boşaltır)
-- ---------------------------------------------------------------------
create or replace function update_statement(p_import_id uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := _uid();
  i       card_statement_imports;
  n       card_statement_imports;
  v_after numeric;
  v_pct   numeric;
begin
  select * into i from card_statement_imports where id = p_import_id and user_id = v_uid for update;
  if not found then raise exception 'Ekstre bulunamadı' using errcode = 'P0002'; end if;
  perform _owned_account(v_uid, i.account_id);

  update card_statement_imports set
    cut_date         = case when p ? 'cut_date'         then (p->>'cut_date')::date                   else cut_date end,
    period_start     = case when p ? 'period_start'     then nullif(p->>'period_start', '')::date     else period_start end,
    due_date         = case when p ? 'due_date'         then nullif(p->>'due_date', '')::date         else due_date end,
    statement_debt   = case when p ? 'statement_debt'   then (p->>'statement_debt')::numeric          else statement_debt end,
    min_payment      = case when p ? 'min_payment'      then nullif(p->>'min_payment', '')::numeric   else min_payment end,
    previous_balance = case when p ? 'previous_balance' then nullif(p->>'previous_balance', '')::numeric else previous_balance end,
    credit_limit     = case when p ? 'limit'            then nullif(p->>'limit', '')::numeric         else credit_limit end,
    available_limit  = case when p ? 'available_limit'  then nullif(p->>'available_limit', '')::numeric else available_limit end
  where id = i.id
  returning * into n;

  if coalesce((p->>'update_profile')::boolean, false) then
    if n.credit_limit is not null then update accounts set credit_limit = n.credit_limit where id = n.account_id; end if;
    v_pct := case when n.min_payment is not null and n.statement_debt > 0 then round(n.min_payment / n.statement_debt * 100) end;
    update credit_card_details
       set statement_day   = extract(day from n.cut_date)::smallint,
           due_day         = coalesce(extract(day from n.due_date)::smallint, due_day),
           min_payment_pct = coalesce(least(greatest(v_pct, 0), 100), min_payment_pct)
     where account_id = n.account_id;
  end if;

  v_after := _card_derived_statement(n.account_id, n.cut_date);
  update card_statement_imports set ledger_debt_after = v_after where id = n.id;
  return jsonb_build_object('ledger_after', v_after, 'statement_debt', n.statement_debt, 'difference', round(v_after - n.statement_debt, 2));
end $$;

-- ---------------------------------------------------------------------
--  Ekstreyi sil (p_reverse: ekstrenin deftere eklediği kayıtlar da iptal edilir)
-- ---------------------------------------------------------------------
create or replace function delete_statement(p_import_id uuid, p_reverse boolean default true)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  i     card_statement_imports;
  e     jsonb;
  v_id  uuid;
  n_rev int := 0;
begin
  select * into i from card_statement_imports where id = p_import_id and user_id = v_uid for update;
  if not found then raise exception 'Ekstre bulunamadı' using errcode = 'P0002'; end if;
  if p_reverse then
    for e in select * from jsonb_array_elements(i.lines) loop
      v_id := nullif(e->>'entry_id', '')::uuid;
      if e->>'action' = 'add' and v_id is not null and _entry_open(v_uid, v_id) then
        perform reverse_entry(v_id, 'Ekstre silindi');
        n_rev := n_rev + 1;
      end if;
    end loop;
  end if;
  delete from card_statement_imports where id = i.id;
  return jsonb_build_object('reversed', n_rev);
end $$;

revoke execute on function _statement_entry(uuid, accounts, text, jsonb), _entry_open(uuid, uuid), _statement_line_json(jsonb) from public, anon, authenticated;
revoke execute on function import_card_statement(jsonb), amend_statement_line(uuid, int, jsonb), update_statement(uuid, jsonb),
  delete_statement(uuid, boolean) from public, anon;
grant  execute on function import_card_statement(jsonb), amend_statement_line(uuid, int, jsonb), update_statement(uuid, jsonb),
  delete_statement(uuid, boolean) to authenticated;
