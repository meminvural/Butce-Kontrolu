-- =====================================================================
--  0002 · Defter bütünlük kuralları (veritabanı seviyesinde garanti)
--  Frontend ne gönderirse göndersin, bu kurallar delinemez.
-- =====================================================================

-- ---------- 1) Satır doğrulama: sahiplik + para birimi --------------------
create or replace function _validate_posting()
returns trigger language plpgsql as $$
declare
  v_entry  journal_entries;
  v_acc    accounts;
  v_cat    categories;
begin
  select * into v_entry from journal_entries where id = new.entry_id;
  new.user_id := v_entry.user_id;

  if new.account_id is not null then
    select * into v_acc from accounts where id = new.account_id;
    if v_acc.user_id <> new.user_id then
      raise exception 'Hesap bu kullanıcıya ait değil' using errcode = '42501';
    end if;
    if v_acc.currency <> new.currency then
      raise exception '"%" hesabı % biriminde; % ile işlem yapılamaz',
        v_acc.name, v_acc.currency, new.currency using errcode = '22023';
    end if;
    if v_acc.archived_at is not null and v_entry.kind <> 'reversal' then
      raise exception '"%" hesabı arşivlenmiş', v_acc.name using errcode = '22023';
    end if;
  else
    select * into v_cat from categories where id = new.category_id;
    if v_cat.user_id <> new.user_id then
      raise exception 'Kategori bu kullanıcıya ait değil' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger postings_validate
  before insert on postings
  for each row execute function _validate_posting();

-- ---------- 2) DENGE: her kayıt, her para biriminde 0'a kapanmalı ----------
--  Transaction sonunda (DEFERRED) kontrol edilir; tek satırlık "yarım"
--  kayıt veya dengesiz kayıt commit edilemez.
create or replace function _check_entry_balanced()
returns trigger language plpgsql as $$
declare
  v_id  uuid;
  v_n   int;
  v_bad record;
begin
  if tg_table_name = 'postings' then v_id := new.entry_id; else v_id := new.id; end if;
  select count(*) into v_n from postings where entry_id = v_id;
  if v_n < 2 then
    raise exception 'Kayıt % en az iki satır içermeli', v_id using errcode = '23514';
  end if;

  select currency, sum(amount) as diff into v_bad
  from postings where entry_id = v_id
  group by currency having sum(amount) <> 0
  limit 1;
  if found then
    raise exception 'Dengesiz kayıt %: % biriminde % fark', v_id, v_bad.currency, v_bad.diff
      using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger postings_balanced
  after insert on postings deferrable initially deferred
  for each row execute function _check_entry_balanced();

create constraint trigger entries_have_postings
  after insert on journal_entries deferrable initially deferred
  for each row execute function _check_entry_balanced();

-- ---------- 3) Limit ve fiziksel kısıtlar --------------------------------
--  * Kredi kartı / ek hesap: borç, limiti aşamaz
--  * Nakit: eksiye düşemez (cüzdanda eksi para olmaz)
--  Ters kayıt, açılış bakiyesi ve düzeltme kayıtları bu kontrolden muaf.
create or replace function _check_account_limits()
returns trigger language plpgsql as $$
declare
  v_kind entry_kind;
  v_acc  accounts;
  v_raw  numeric;
begin
  if new.account_id is null then return null; end if;
  select kind into v_kind from journal_entries where id = new.entry_id;
  if v_kind in ('reversal','opening_balance','adjustment') then return null; end if;

  select * into v_acc from accounts where id = new.account_id;
  if v_acc.kind not in ('credit_card','overdraft','cash') then return null; end if;

  select coalesce(sum(amount),0) into v_raw from postings where account_id = v_acc.id;

  if v_acc.kind = 'cash' and v_raw < 0 then
    raise exception '"%" nakit bakiyesi eksiye düşemez (sonuç: %)', v_acc.name, v_raw
      using errcode = '23514';
  end if;
  if v_acc.kind in ('credit_card','overdraft') and v_acc.credit_limit is not null
     and -v_raw > v_acc.credit_limit then
    raise exception '"%" limiti aşılıyor: limit %, işlem sonrası borç %',
      v_acc.name, v_acc.credit_limit, -v_raw using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger postings_limits
  after insert on postings deferrable initially deferred
  for each row execute function _check_account_limits();

-- ---------- 4) DEĞİŞMEZLİK: defter silinmez, düzeltilmez -------------------
--  Hata düzeltmek = ters kayıt (reverse_entry) + yeni doğru kayıt.
--  Tek istisna: hesabın tamamen silinmesi (app.purge = on).
create or replace function _forbid_posting_change()
returns trigger language plpgsql as $$
begin
  if current_setting('app.purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'Defter satırları değiştirilemez veya silinemez. İptal için reverse_entry kullanın.'
    using errcode = '42501';
end $$;

create trigger postings_immutable
  before update or delete on postings
  for each row execute function _forbid_posting_change();

create or replace function _guard_entry_change()
returns trigger language plpgsql as $$
begin
  if current_setting('app.purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Kayıtlar silinemez. İptal için reverse_entry kullanın.' using errcode = '42501';
  end if;
  -- Sadece açıklama düzeltmesi ve posted → reversed geçişi serbest
  if (new.user_id, new.entry_date, new.kind, new.counterparty_id, new.reverses_entry_id, new.idempotency_key, new.created_at)
     is distinct from
     (old.user_id, old.entry_date, old.kind, old.counterparty_id, old.reverses_entry_id, old.idempotency_key, old.created_at)
  then
    raise exception 'Kaydın tarihi/türü değiştirilemez. İptal edip yeniden girin.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'posted' and new.status = 'reversed') then
    raise exception 'Geçersiz durum değişikliği: % → %', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;

create trigger journal_entries_guard
  before update or delete on journal_entries
  for each row execute function _guard_entry_change();

-- ---------- 5) Hesap koruma: hareketi olan hesabın türü/birimi değişmez ------
create or replace function _guard_account_change()
returns trigger language plpgsql as $$
begin
  if (new.kind, new.currency, new.user_id) is distinct from (old.kind, old.currency, old.user_id)
     and exists (select 1 from postings where account_id = old.id) then
    raise exception 'Hareket görmüş hesabın türü veya para birimi değiştirilemez' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger accounts_guard
  before update on accounts
  for each row execute function _guard_account_change();

-- ---------- 6) Kategori: en fazla 2 seviye, alt kategori ana ile aynı tür ----
create or replace function _validate_category()
returns trigger language plpgsql as $$
declare v_parent categories;
begin
  if new.parent_id is null then return new; end if;
  select * into v_parent from categories where id = new.parent_id;
  if v_parent.user_id <> new.user_id then
    raise exception 'Ana kategori bu kullanıcıya ait değil' using errcode = '42501';
  end if;
  if v_parent.parent_id is not null then
    raise exception 'Kategoriler en fazla iki seviyeli olabilir' using errcode = '22023';
  end if;
  if v_parent.kind <> new.kind then
    raise exception 'Alt kategori, ana kategoriyle aynı türde olmalı' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger categories_validate
  before insert or update on categories
  for each row execute function _validate_category();

-- ---------- 7) Denetim kaydı ---------------------------------------------
create or replace function _audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
begin
  if tg_op = 'UPDATE' and v_old = v_new then return null; end if;
  insert into audit_log (user_id, table_name, record_id, action, old_data, new_data)
  values (
    coalesce(auth.uid(), (v_row->>'user_id')::uuid),
    tg_table_name,
    coalesce(v_row->>'id', v_row->>'account_id'),
    lower(tg_op), v_old, v_new
  );
  return null;
end $$;

create trigger audit_accounts            after insert or update or delete on accounts            for each row execute function _audit();
create trigger audit_credit_card_details after insert or update or delete on credit_card_details for each row execute function _audit();
create trigger audit_journal_entries     after update on journal_entries                          for each row execute function _audit();
create trigger audit_categories          after update or delete on categories                     for each row execute function _audit();
create trigger audit_budgets             after insert or update or delete on budgets              for each row execute function _audit();
create trigger audit_counterparties      after update or delete on counterparties                 for each row execute function _audit();
