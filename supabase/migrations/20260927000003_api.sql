-- =====================================================================
--  0003 · İşlem API'si (Supabase RPC)
--  Frontend deftere DOĞRUDAN yazamaz; tüm yazma bu fonksiyonlardan geçer.
--  Hepsi SECURITY DEFINER + auth.uid() kontrolü ile çalışır.
-- =====================================================================

-- ---------- Yardımcılar ---------------------------------------------------
create or replace function _uid()
returns uuid language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null then
    raise exception 'Oturum açılmamış' using errcode = '28000';
  end if;
  return u;
end $$;

-- Kullanıcının kendi saat dilimindeki "bugün" (UTC değil!)
create or replace function _today(p_uid uuid)
returns date language sql stable as $$
  select (now() at time zone coalesce(
            (select timezone from profiles where id = p_uid), 'Europe/Istanbul'))::date
$$;

create or replace function _check_amount(p numeric)
returns numeric language plpgsql immutable as $$
begin
  if p is null or p <= 0 then
    raise exception 'Tutar sıfırdan büyük olmalı' using errcode = '22023';
  end if;
  if round(p, 2) <> p then
    raise exception 'Tutar en fazla 2 ondalık basamak içerebilir' using errcode = '22023';
  end if;
  return p;
end $$;

create or replace function _check_date(p_uid uuid, p date)
returns date language plpgsql stable as $$
declare v date := coalesce(p, _today(p_uid));
begin
  if v > _today(p_uid) then
    raise exception 'Gelecek tarihli işlem deftere yazılamaz; planlı işlem olarak ekleyin'
      using errcode = '22023';
  end if;
  if v < date '2000-01-01' then
    raise exception 'Geçersiz tarih: %', v using errcode = '22023';
  end if;
  return v;
end $$;

create or replace function _owned_account(p_uid uuid, p_id uuid)
returns accounts language plpgsql stable as $$
declare a accounts;
begin
  select * into a from accounts where id = p_id and user_id = p_uid and not is_system;
  if not found then raise exception 'Hesap bulunamadı' using errcode = 'P0002'; end if;
  if a.archived_at is not null then
    raise exception '"%" hesabı arşivlenmiş', a.name using errcode = '22023';
  end if;
  return a;
end $$;

create or replace function _owned_category(p_uid uuid, p_id uuid, p_kind category_kind)
returns categories language plpgsql stable as $$
declare c categories;
begin
  select * into c from categories where id = p_id and user_id = p_uid;
  if not found then raise exception 'Kategori bulunamadı' using errcode = 'P0002'; end if;
  if c.kind <> p_kind then
    raise exception '"%" bir % kategorisi değil', c.name,
      case p_kind when 'income' then 'gelir' else 'gider' end using errcode = '22023';
  end if;
  if c.archived_at is not null then
    raise exception '"%" kategorisi arşivlenmiş', c.name using errcode = '22023';
  end if;
  return c;
end $$;

-- Aynı idempotency_key ile ikinci kez gelen istek yeni kayıt açmaz (çift kayıt koruması)
create or replace function _existing_entry(p_uid uuid, p_key text)
returns uuid language sql stable as $$
  select id from journal_entries where user_id = p_uid and p_key is not null and idempotency_key = p_key
$$;

-- Sistem hesabı (açılış bakiyesi / kur çevrim) — para birimi başına bir tane, gerekince açılır
create or replace function _system_account(p_uid uuid, p_kind account_kind, p_currency char(3))
returns uuid language plpgsql as $$
declare v uuid;
begin
  select id into v from accounts where user_id = p_uid and kind = p_kind and currency = p_currency and is_system;
  if v is null then
    insert into accounts (user_id, name, kind, currency, is_system)
    values (p_uid,
            case p_kind when 'equity' then 'Açılış / Düzeltme' else 'Kur Çevrim' end || ' ' || p_currency,
            p_kind, p_currency, true)
    on conflict do nothing
    returning id into v;
    if v is null then
      select id into v from accounts where user_id = p_uid and kind = p_kind and currency = p_currency and is_system;
    end if;
  end if;
  return v;
end $$;

create or replace function _new_entry(p_uid uuid, p_date date, p_kind entry_kind, p_desc text,
                                      p_key text, p_counterparty uuid default null)
returns uuid language sql as $$
  insert into journal_entries (user_id, entry_date, kind, description, idempotency_key, counterparty_id)
  values (p_uid, p_date, p_kind, nullif(trim(p_desc), ''), p_key, p_counterparty)
  returning id
$$;

create or replace function _post(p_entry uuid, p_account uuid, p_category uuid, p_amount numeric,
                                 p_currency char(3), p_memo text default null)
returns void language sql as $$
  insert into postings (entry_id, user_id, account_id, category_id, amount, currency, memo)
  values (p_entry, auth.uid(), p_account, p_category, p_amount, p_currency, p_memo)
$$;

-- ---------- Profil + varsayılan kategoriler (yeni kullanıcı) --------------
create or replace function seed_default_categories(p_uid uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_parent uuid;
  r record;
  sub text;
begin
  -- Gelir (NOT: "Borç tahsilatı" gelir değildir → alacak hesabından transferdir)
  for r in select * from (values
      ('Maaş', 1, null::text), ('Prim & Bonus', 2, null), ('Kira Geliri', 3, null),
      ('Faiz Geliri', 4, 'interest_income'), ('Yatırım Geliri', 5, null), ('Ek İş', 6, null),
      ('Diğer Gelir', 9, null)) as t(name, ord, skey)
  loop
    insert into categories (user_id, kind, name, sort_order, system_key)
    values (p_uid, 'income', r.name, r.ord, r.skey) on conflict do nothing;
  end loop;

  -- Gider (ana → alt)
  for r in select * from (values
      ('Ev',          1, array['Kira','Elektrik','Su','Doğalgaz','İnternet','Aidat']),
      ('Gıda',        2, array['Market','Restoran','Yemek Siparişi']),
      ('Ulaşım',      3, array['Yakıt','Bakım','Sigorta','Otopark','Toplu Taşıma']),
      ('Alışveriş',   4, array['Giyim','Elektronik','Diğer']),
      ('Sağlık',      5, array['Doktor','İlaç']),
      ('Eğitim',      6, array['Kurs','Kitap']),
      ('Eğlence',     7, array['Abonelikler','Etkinlik','Seyahat']),
      ('Finansal Giderler', 8, array['Kredi Faizi','Kart Faizi','Banka Masrafı']),
      ('Diğer Gider', 9, array[]::text[])) as t(name, ord, subs)
  loop
    insert into categories (user_id, kind, name, sort_order)
    values (p_uid, 'expense', r.name, r.ord)
    returning id into v_parent;
    foreach sub in array r.subs loop
      insert into categories (user_id, kind, name, parent_id, system_key)
      values (p_uid, 'expense', sub, v_parent,
              case sub when 'Kredi Faizi' then 'loan_interest'
                       when 'Kart Faizi'  then 'card_interest'
                       when 'Banka Masrafı' then 'bank_fee' end);
    end loop;
  end loop;
end $$;

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  perform seed_default_categories(new.id);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- HESAP AÇMA ----------------------------------------------------
--  p_opening_balance: doğal işaretle.
--    Banka/nakit → elimdeki para.   Kart/kredi/borç → borçlu olduğum tutar.
create or replace function create_account(
  p_name              text,
  p_kind              account_kind,
  p_currency          char(3),
  p_opening_balance   numeric default 0,
  p_opened_on         date    default null,
  p_institution_name  text    default null,
  p_counterparty_name text    default null,
  p_credit_limit      numeric default null,
  p_statement_day     int     default null,
  p_due_day           int     default null,
  p_iban_last4        text    default null,
  p_color             text    default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := _uid();
  v_inst  uuid;
  v_cp    uuid;
  v_acc   uuid;
  v_entry uuid;
  v_date  date := _check_date(v_uid, p_opened_on);
  v_raw   numeric;
begin
  if account_class_of(p_kind) = 'system' then
    raise exception 'Sistem hesabı elle açılamaz' using errcode = '22023';
  end if;
  if p_kind = 'credit_card' and (p_statement_day is null or p_due_day is null) then
    raise exception 'Kredi kartı için hesap kesim ve son ödeme günü zorunlu' using errcode = '22023';
  end if;
  if p_kind in ('receivable','payable') and nullif(trim(p_counterparty_name),'') is null then
    raise exception 'Borç/alacak hesabı için kişi veya kurum adı zorunlu' using errcode = '22023';
  end if;

  if nullif(trim(p_institution_name), '') is not null then
    insert into institutions (user_id, name) values (v_uid, trim(p_institution_name))
    on conflict (user_id, name) do update set name = excluded.name
    returning id into v_inst;
  end if;
  if nullif(trim(p_counterparty_name), '') is not null then
    insert into counterparties (user_id, name) values (v_uid, trim(p_counterparty_name))
    on conflict (user_id, name) do update set name = excluded.name
    returning id into v_cp;
  end if;

  insert into accounts (user_id, institution_id, counterparty_id, name, kind, currency,
                        credit_limit, iban_last4, color, opened_on)
  values (v_uid, v_inst, v_cp, trim(p_name), p_kind, p_currency,
          case when p_kind in ('credit_card','overdraft') then p_credit_limit end,
          nullif(p_iban_last4, ''), p_color, v_date)
  returning id into v_acc;

  if p_kind = 'credit_card' then
    insert into credit_card_details (account_id, statement_day, due_day)
    values (v_acc, p_statement_day, p_due_day);
  end if;

  if coalesce(p_opening_balance, 0) <> 0 then
    v_raw := case when account_class_of(p_kind) = 'liability' then -p_opening_balance else p_opening_balance end;
    v_entry := _new_entry(v_uid, v_date, 'opening_balance', 'Açılış bakiyesi: ' || trim(p_name), null, v_cp);
    perform _post(v_entry, v_acc, null, v_raw, p_currency);
    perform _post(v_entry, _system_account(v_uid, 'equity', p_currency), null, -v_raw, p_currency);
  end if;
  return v_acc;
end $$;

-- ---------- GELİR ---------------------------------------------------------
create or replace function record_income(
  p_account_id  uuid,
  p_category_id uuid,
  p_amount      numeric,
  p_date        date default null,
  p_description text default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  v_id   uuid := _existing_entry(v_uid, p_idempotency_key);
  v_acc  accounts;
  v_cat  categories;
begin
  if v_id is not null then return v_id; end if;
  perform _check_amount(p_amount);
  v_acc := _owned_account(v_uid, p_account_id);
  v_cat := _owned_category(v_uid, p_category_id, 'income');
  if account_class_of(v_acc.kind) <> 'asset' then
    raise exception 'Gelir yalnızca varlık hesabına (banka, nakit…) girilebilir' using errcode = '22023';
  end if;

  v_id := _new_entry(v_uid, _check_date(v_uid, p_date), 'income', p_description, p_idempotency_key);
  perform _post(v_id, v_acc.id, null,  p_amount, v_acc.currency);
  perform _post(v_id, null, v_cat.id, -p_amount, v_acc.currency);
  return v_id;
end $$;

-- ---------- GİDER (banka, nakit, KART, ek hesap, "başkası ödedi") -----------
--  Kartla yapılan harcama burada GİDER olarak yazılır; kart ödemesi ise transferdir.
create or replace function record_expense(
  p_account_id  uuid,
  p_category_id uuid,
  p_amount      numeric,
  p_date        date default null,
  p_description text default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  v_id   uuid := _existing_entry(v_uid, p_idempotency_key);
  v_acc  accounts;
  v_cat  categories;
begin
  if v_id is not null then return v_id; end if;
  perform _check_amount(p_amount);
  v_acc := _owned_account(v_uid, p_account_id);
  v_cat := _owned_category(v_uid, p_category_id, 'expense');
  if v_acc.kind in ('loan','receivable') then
    raise exception '"%" hesabından doğrudan harcama yapılamaz', v_acc.name using errcode = '22023';
  end if;

  v_id := _new_entry(v_uid, _check_date(v_uid, p_date),
                     case when v_acc.kind = 'credit_card' then 'card_purchase' else 'expense' end::entry_kind,
                     p_description, p_idempotency_key, v_acc.counterparty_id);
  perform _post(v_id, v_acc.id, null, -p_amount, v_acc.currency);
  perform _post(v_id, null, v_cat.id,  p_amount, v_acc.currency);
  return v_id;
end $$;

-- ---------- TRANSFER (tek fonksiyon, tür otomatik belirlenir) ---------------
--  Banka→Banka, Banka→Kart (kart ödemesi), Kredi→Banka (kredi kullanımı),
--  Banka→Alacak (borç verme), Alacak→Banka (tahsilat), Borç→Banka (borç alma),
--  Banka→Borç (borç ödeme), TL→USD (döviz bozdurma) ...
--  Hiçbiri gelir/gider DEĞİLDİR → toplam gelir/gider değişmez.
create or replace function _transfer_kind(f account_kind, t account_kind, same_ccy boolean)
returns entry_kind language sql immutable as $$
  select case
    when t = 'credit_card'                         then 'card_payment'
    when f = 'overdraft'                           then 'overdraft_draw'
    when t = 'overdraft'                           then 'overdraft_repay'
    when f = 'loan'                                then 'loan_disbursement'
    when t = 'loan'                                then 'loan_payment'
    when t = 'receivable'                          then 'receivable_open'
    when f = 'receivable'                          then 'receivable_collection'
    when f = 'payable'                             then 'debt_open'
    when t = 'payable'                             then 'debt_payment'
    when not same_ccy                              then 'fx_exchange'
    else 'transfer'
  end::entry_kind
$$;

create or replace function record_transfer(
  p_from_account_id uuid,
  p_to_account_id   uuid,
  p_amount          numeric,              -- çıkan tutar (kaynak hesabın biriminde)
  p_to_amount       numeric default null, -- giren tutar (farklı birimde zorunlu)
  p_date            date default null,
  p_description     text default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  v_id   uuid := _existing_entry(v_uid, p_idempotency_key);
  v_from accounts;
  v_to   accounts;
  v_in   numeric;
begin
  if v_id is not null then return v_id; end if;
  perform _check_amount(p_amount);
  if p_from_account_id = p_to_account_id then
    raise exception 'Kaynak ve hedef hesap aynı olamaz' using errcode = '22023';
  end if;
  v_from := _owned_account(v_uid, p_from_account_id);
  v_to   := _owned_account(v_uid, p_to_account_id);

  if v_from.currency = v_to.currency then
    if p_to_amount is not null and p_to_amount <> p_amount then
      raise exception 'Aynı para biriminde giren ve çıkan tutar eşit olmalı' using errcode = '22023';
    end if;
    v_in := p_amount;
  else
    if p_to_amount is null then
      raise exception '% → % transferinde hedef tutar (kur karşılığı) zorunlu',
        v_from.currency, v_to.currency using errcode = '22023';
    end if;
    v_in := _check_amount(p_to_amount);
  end if;

  v_id := _new_entry(v_uid, _check_date(v_uid, p_date),
                     _transfer_kind(v_from.kind, v_to.kind, v_from.currency = v_to.currency),
                     p_description, p_idempotency_key,
                     coalesce(v_from.counterparty_id, v_to.counterparty_id));

  perform _post(v_id, v_from.id, null, -p_amount, v_from.currency);
  if v_from.currency <> v_to.currency then
    -- Kur çevrim hesapları: her para birimi kendi içinde 0'a kapanır
    perform _post(v_id, _system_account(v_uid, 'fx_clearing', v_from.currency), null,  p_amount, v_from.currency);
    perform _post(v_id, _system_account(v_uid, 'fx_clearing', v_to.currency),   null, -v_in,     v_to.currency);
  end if;
  perform _post(v_id, v_to.id, null, v_in, v_to.currency);
  return v_id;
end $$;

-- ---------- BÖLÜNMÜŞ GİDER (tek fiş, birden çok kategori) ------------------
--  p_lines: [{"category_id": "...", "amount": 450.00, "memo": "Market"}, ...]
create or replace function record_split_expense(
  p_account_id uuid,
  p_lines      jsonb,
  p_date       date default null,
  p_description text default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := _uid();
  v_id    uuid := _existing_entry(v_uid, p_idempotency_key);
  v_acc   accounts;
  v_total numeric := 0;
  l       jsonb;
  v_cat   categories;
begin
  if v_id is not null then return v_id; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'En az bir kalem gerekli' using errcode = '22023';
  end if;
  v_acc := _owned_account(v_uid, p_account_id);
  if v_acc.kind in ('loan','receivable') then
    raise exception '"%" hesabından doğrudan harcama yapılamaz', v_acc.name using errcode = '22023';
  end if;
  v_id := _new_entry(v_uid, _check_date(v_uid, p_date),
                     case when v_acc.kind = 'credit_card' then 'card_purchase' else 'expense' end::entry_kind,
                     p_description, p_idempotency_key, v_acc.counterparty_id);
  for l in select * from jsonb_array_elements(p_lines) loop
    v_cat := _owned_category(v_uid, (l->>'category_id')::uuid, 'expense');
    perform _post(v_id, null, v_cat.id, _check_amount((l->>'amount')::numeric), v_acc.currency, l->>'memo');
    v_total := v_total + (l->>'amount')::numeric;
  end loop;
  perform _post(v_id, v_acc.id, null, -v_total, v_acc.currency);
  return v_id;
end $$;

-- ---------- BAKİYE DÜZELTME (mutabakat) -----------------------------------
--  Bankadaki gerçek bakiyeyle sistem uyuşmuyorsa farkı kayıt altına alır.
create or replace function adjust_balance(
  p_account_id     uuid,
  p_actual_balance numeric,          -- doğal işaretle (kartta: borç tutarı)
  p_date           date default null,
  p_reason         text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  v_acc  accounts := _owned_account(v_uid, p_account_id);
  v_raw_now    numeric;
  v_raw_target numeric;
  v_diff numeric;
  v_id   uuid;
begin
  select coalesce(sum(amount), 0) into v_raw_now from postings where account_id = v_acc.id;
  v_raw_target := case when account_class_of(v_acc.kind) = 'liability' then -p_actual_balance else p_actual_balance end;
  v_diff := round(v_raw_target - v_raw_now, 2);
  if v_diff = 0 then return null; end if;

  v_id := _new_entry(v_uid, _check_date(v_uid, p_date), 'adjustment',
                     coalesce(nullif(trim(p_reason), ''), 'Bakiye düzeltme') || ': ' || v_acc.name, null);
  perform _post(v_id, v_acc.id, null, v_diff, v_acc.currency);
  perform _post(v_id, _system_account(v_uid, 'equity', v_acc.currency), null, -v_diff, v_acc.currency);
  return v_id;
end $$;

-- ---------- İPTAL = TERS KAYIT (silme yok) ---------------------------------
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
  return v_rid;
end $$;

-- ---------- Açıklama düzeltme (tutar/tarih değil) --------------------------
create or replace function update_entry_description(p_entry_id uuid, p_description text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update journal_entries set description = nullif(trim(p_description), '')
  where id = p_entry_id and user_id = _uid();
  if not found then raise exception 'Kayıt bulunamadı' using errcode = 'P0002'; end if;
end $$;
