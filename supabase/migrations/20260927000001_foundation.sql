-- =====================================================================
--  BÜTÇE TAKİP SİSTEMİ · 0001 · Temel şema
--  Çift taraflı defter (double-entry ledger) mimarisi:
--    * Bakiye saklanmaz, POSTING satırlarından hesaplanır.
--    * Her kaydın (journal_entry) satırları, para birimi bazında toplamda 0 olmalı.
--    * Gelir/gider kategorileri de defterin bir tarafıdır.
--  İşaret kuralı: + borç (debit) / − alacak (credit)
--    varlık hesabı bakiyesi  = Σ amount
--    borç hesabı bakiyesi    = −Σ amount   (ne kadar borçluyum)
--    gider kategorisi toplamı = Σ amount,  gelir kategorisi toplamı = −Σ amount
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------- Enum'lar ----------------------------------------------------
create type account_kind as enum (
  -- varlık
  'bank', 'cash', 'savings', 'investment', 'receivable',
  -- yükümlülük
  'credit_card', 'overdraft', 'loan', 'payable',
  -- sistem (kullanıcıya gösterilmez)
  'equity', 'fx_clearing'
);

create type account_class as enum ('asset', 'liability', 'system');
create type category_kind as enum ('income', 'expense');
create type entry_status  as enum ('posted', 'reversed');

create type entry_kind as enum (
  'income', 'expense', 'card_purchase',
  'transfer', 'fx_exchange',
  'card_payment',
  'overdraft_draw', 'overdraft_repay',
  'loan_disbursement', 'loan_payment',
  'debt_open', 'debt_payment',
  'receivable_open', 'receivable_collection',
  'opening_balance', 'adjustment', 'reversal'
);

create or replace function account_class_of(k account_kind)
returns account_class language sql immutable parallel safe as $$
  select case
    when k in ('bank','cash','savings','investment','receivable') then 'asset'::account_class
    when k in ('credit_card','overdraft','loan','payable')         then 'liability'::account_class
    else 'system'::account_class
  end
$$;

-- ---------- Referans ----------------------------------------------------
create table currencies (
  code     char(3) primary key,
  name     text not null,
  symbol   text not null,
  decimals smallint not null default 2
);
insert into currencies (code, name, symbol, decimals) values
  ('TRY', 'Türk Lirası',     '₺',   2),
  ('USD', 'ABD Doları',      '$',   2),
  ('EUR', 'Euro',            '€',   2),
  ('TZS', 'Tanzanya Şilini', 'TSh', 0);

-- ---------- Kullanıcı profili --------------------------------------------
create table profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  full_name       text,
  base_currency   char(3) not null default 'TRY' references currencies(code),
  timezone        text    not null default 'Europe/Istanbul',
  budget_warn_pct numeric(5,2) not null default 70,
  budget_crit_pct numeric(5,2) not null default 90,
  created_at      timestamptz not null default now(),
  check (budget_warn_pct > 0 and budget_warn_pct < budget_crit_pct and budget_crit_pct <= 100)
);

-- ---------- Kurumlar (bankalar) ve karşı taraflar (kişiler) --------------
create table institutions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  kind       text not null default 'bank' check (kind in ('bank','other')),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table counterparties (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  phone      text,
  note       text,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

-- ---------- Hesaplar ------------------------------------------------------
-- Banka, nakit, kart, kredi, ek hesap, kişisel borç, alacak: HEPSİ birer hesap.
create table accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  institution_id  uuid references institutions(id) on delete restrict,
  counterparty_id uuid references counterparties(id) on delete restrict,
  name            text not null check (length(trim(name)) > 0),
  kind            account_kind not null,
  currency        char(3) not null references currencies(code),
  credit_limit    numeric(20,2) check (credit_limit >= 0),
  iban_last4      text check (iban_last4 ~ '^[0-9]{4}$'),
  color           text,
  sort_order      int  not null default 0,
  is_system       boolean not null default false,
  opened_on       date not null default current_date,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  check (credit_limit is null or kind in ('credit_card','overdraft')),
  check (is_system = (kind in ('equity','fx_clearing')))
);
create unique index accounts_user_name_uq on accounts (user_id, lower(name)) where not is_system;
create unique index accounts_system_uq    on accounts (user_id, kind, currency) where is_system;
create index        accounts_user_idx     on accounts (user_id);

-- Kredi kartına özgü alanlar (ekstre motoru Faz 2'de bunları kullanır)
create table credit_card_details (
  account_id      uuid primary key references accounts(id) on delete cascade,
  statement_day   smallint not null check (statement_day between 1 and 31),
  due_day         smallint not null check (due_day between 1 and 31),
  min_payment_pct numeric(5,2) not null default 20 check (min_payment_pct between 0 and 100)
);

-- ---------- Kategoriler (2 seviye: ana / alt) -----------------------------
create table categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parent_id   uuid references categories(id) on delete restrict,
  kind        category_kind not null,
  name        text not null check (length(trim(name)) > 0),
  icon        text,
  sort_order  int not null default 0,
  system_key  text,            -- örn. 'loan_interest' → sistem fonksiyonları bulur
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);
create unique index categories_name_uq
  on categories (user_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create unique index categories_syskey_uq on categories (user_id, system_key) where system_key is not null;

-- ---------- DEFTER: kayıt başlığı + satırlar ------------------------------
create table journal_entries (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  entry_date        date not null,
  kind              entry_kind not null,
  status            entry_status not null default 'posted',
  description       text,
  counterparty_id   uuid references counterparties(id) on delete restrict,
  reverses_entry_id uuid unique references journal_entries(id),
  reversed_by       uuid references journal_entries(id),
  idempotency_key   text,
  created_at        timestamptz not null default now(),
  unique (user_id, idempotency_key),
  check ((kind = 'reversal') = (reverses_entry_id is not null)),
  check ((status = 'reversed') = (reversed_by is not null))
);
create index journal_entries_user_date_idx on journal_entries (user_id, entry_date desc, created_at desc);
create index journal_entries_kind_idx      on journal_entries (user_id, kind);

create table postings (
  id          bigint generated always as identity primary key,
  entry_id    uuid not null references journal_entries(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  account_id  uuid references accounts(id)   on delete restrict,
  category_id uuid references categories(id) on delete restrict,
  amount      numeric(20,2) not null check (amount <> 0),
  currency    char(3) not null references currencies(code),
  memo        text,
  check (num_nonnulls(account_id, category_id) = 1)
);
create index postings_entry_idx    on postings (entry_id);
create index postings_account_idx  on postings (account_id) where account_id is not null;
create index postings_category_idx on postings (category_id) where category_id is not null;
create index postings_user_idx     on postings (user_id, currency);

-- ---------- Belgeler (dosyalar Storage'da, burada sadece referans) --------
create table attachments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_id     uuid references journal_entries(id) on delete cascade,
  account_id   uuid references accounts(id) on delete cascade,
  storage_path text not null,
  file_name    text not null,
  mime_type    text,
  size_bytes   bigint,
  created_at   timestamptz not null default now(),
  check (num_nonnulls(entry_id, account_id) >= 1)
);

-- ---------- Bütçe (Faz 3) -------------------------------------------------
create table budgets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  period      date not null check (extract(day from period) = 1),
  category_id uuid not null references categories(id) on delete cascade,
  amount      numeric(20,2) not null check (amount > 0),
  currency    char(3) not null references currencies(code),
  unique (user_id, period, category_id, currency)
);

-- ---------- Planlı / düzenli işlemler (Faz 4-5) ---------------------------
-- Defter SADECE gerçekleşmiş işlemleri tutar. Beklenen gelir, gelecek taksit,
-- kira gibi kalemler burada durur; gerçekleşince deftere kayıt atılır.
create table recurring_rules (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name          text not null,
  direction     text not null check (direction in ('in','out','transfer')),
  amount        numeric(20,2) not null check (amount > 0),
  currency      char(3) not null references currencies(code),
  account_id    uuid references accounts(id) on delete cascade,
  to_account_id uuid references accounts(id) on delete cascade,
  category_id   uuid references categories(id) on delete set null,
  frequency     text not null check (frequency in ('weekly','monthly','yearly')),
  interval_n    int  not null default 1 check (interval_n >= 1),
  day_of_month  smallint check (day_of_month between 1 and 31),
  start_date    date not null,
  end_date      date,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table scheduled_items (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  due_date          date not null,
  direction         text not null check (direction in ('in','out','transfer')),
  amount            numeric(20,2) not null check (amount > 0),
  currency          char(3) not null references currencies(code),
  account_id        uuid references accounts(id) on delete cascade,
  category_id       uuid references categories(id) on delete set null,
  counterparty_id   uuid references counterparties(id) on delete set null,
  description       text,
  source_type       text not null default 'manual'
                    check (source_type in ('manual','recurring','loan_installment','card_statement',
                                           'card_installment','debt','receivable')),
  source_id         uuid,
  status            text not null default 'planned' check (status in ('planned','done','skipped')),
  realized_entry_id uuid references journal_entries(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index scheduled_items_due_idx on scheduled_items (user_id, status, due_date);

-- ---------- Döviz kurları -------------------------------------------------
create table exchange_rates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  rate_date  date not null,
  base       char(3) not null references currencies(code),
  quote      char(3) not null references currencies(code),
  rate       numeric(20,8) not null check (rate > 0),
  source     text not null default 'manual',
  created_at timestamptz not null default now(),
  check (base <> quote),
  unique (user_id, rate_date, base, quote)
);

-- ---------- Denetim kaydı -------------------------------------------------
create table audit_log (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  table_name text not null,
  record_id  text,
  action     text not null,
  old_data   jsonb,
  new_data   jsonb,
  at         timestamptz not null default now()
);
create index audit_log_user_idx on audit_log (user_id, at desc);
