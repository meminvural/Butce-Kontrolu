# Bütçe Defteri — Sistem Referansı

> **Bu belge otomatik üretilir** (`scripts/gen_reference.py`) — tablolar, fonksiyonlar, yetkiler, rotalar, migration ve test sayıları koddan okunur; elle düzenlemeyin.  
> Üretim tarihi: 2026-10-01 · Migration: **12** · Test: **147** · Sayfa: **14**

Üretmek için: `psql -X -q -d <db> -f scripts/schema_dump.sql > /tmp/schema.out && python3 scripts/gen_reference.py --dump /tmp/schema.out > docs/SYSTEM_REFERENCE.md`

## 1. Mimari özet

```
Tarayıcı (React + TypeScript, Vite)
  ├─ GitHub Pages  ← .github/workflows/pages.yml (main'e her push)
  └─ Supabase (PostgreSQL + Auth + Storage)
       ├─ Defter: journal_entries + postings (çift kayıt)
       ├─ Yazma: yalnızca RPC fonksiyonları (security definer); tablolara doğrudan yazma yok
       └─ Okuma: görünümler (security_invoker) + RLS
```
- **Bakiyeler saklanmaz, hesaplanır** (`v_account_balances`).
- **Her kayıt dengeli olmalı** (her para biriminde Σ = 0) — veritabanı tetikleyicisi zorlar.
- **Kayıt silinmez, iptal edilir** (`reverse_entry`); satırlar değiştirilemez.
- **Gelecek tarihli işlem deftere yazılamaz**; gelecek ödemeler `scheduled_items`/`recurring_rules`ta tutulur.
- **İdempotency:** yazan fonksiyonlar `p_idempotency_key` alır; `(user_id, idempotency_key)` tekil indeksi çift kaydı engeller.
- **Herkese açık değerler:** Supabase adresi ve `publishable` anahtar tarayıcıya zaten gider; veri güvenliği RLS ile sağlanır. Depo herkese açık olduğundan gizli anahtar asla depoya konmaz.

## 2. Enum türleri

- `account_class`: asset · liability · system
- `account_kind`: bank · cash · savings · investment · fixed_asset · receivable · credit_card · overdraft · loan · payable · equity · fx_clearing
- `category_kind`: income · expense
- `entry_kind`: income · expense · card_purchase · transfer · fx_exchange · card_payment · overdraft_draw · overdraft_repay · loan_disbursement · loan_payment · debt_open · debt_payment · receivable_open · receivable_collection · opening_balance · adjustment · reversal
- `entry_status`: posted · reversed

## 3. Tablolar (19)

| Tablo | RLS | Sütunlar |
|---|---|---|
| `accounts` | ✓ | `id`, `user_id`, `institution_id`, `counterparty_id`, `name`, `kind`, `currency`, `credit_limit`, `iban_last4`, `color`, `sort_order`, `is_system`, `opened_on`, `archived_at`, `created_at` |
| `attachments` | ✓ | `id`, `user_id`, `entry_id`, `account_id`, `storage_path`, `file_name`, `mime_type`, `size_bytes`, `created_at` |
| `audit_log` | ✓ | `id`, `user_id`, `table_name`, `record_id`, `action`, `old_data`, `new_data`, `at` |
| `budgets` | ✓ | `id`, `user_id`, `period`, `category_id`, `amount`, `currency` |
| `card_installment_plans` | ✓ | `entry_id`, `user_id`, `account_id`, `total`, `installment_count`, `first_billing_date` |
| `card_statement_imports` | ✓ | `id`, `user_id`, `account_id`, `bank`, `file_hash`, `cut_date`, `period_start`, `due_date`, `next_cut_date`, `next_due_date`, `statement_debt`, `min_payment`, `previous_balance`, `credit_limit`, `available_limit`, `cash_limit`, `purchase_rate`, `cash_rate`, `late_rate`, `ledger_debt_before`, `ledger_debt_after`, `lines`, `n_lines`, `n_added`, `n_matched`, `imported_at` |
| `categories` | ✓ | `id`, `user_id`, `parent_id`, `kind`, `name`, `icon`, `sort_order`, `system_key`, `archived_at`, `created_at` |
| `counterparties` | ✓ | `id`, `user_id`, `name`, `phone`, `note`, `created_at` |
| `credit_card_details` | ✓ | `account_id`, `statement_day`, `due_day`, `min_payment_pct` |
| `currencies` | ✓ | `code`, `name`, `symbol`, `decimals` |
| `exchange_rates` | ✓ | `id`, `user_id`, `rate_date`, `base`, `quote`, `rate`, `source`, `created_at` |
| `institutions` | ✓ | `id`, `user_id`, `name`, `kind`, `created_at` |
| `journal_entries` | ✓ | `id`, `user_id`, `entry_date`, `kind`, `status`, `description`, `counterparty_id`, `reverses_entry_id`, `reversed_by`, `idempotency_key`, `created_at` |
| `loan_details` | ✓ | `account_id`, `principal`, `monthly_rate`, `tax_pct`, `term_months`, `first_payment_date`, `payment_amount` |
| `loan_installments` | ✓ | `id`, `user_id`, `account_id`, `installment_no`, `due_date`, `payment`, `principal`, `interest`, `tax`, `remaining`, `settled_outside`, `paid_entry_id` |
| `postings` | ✓ | `id`, `entry_id`, `user_id`, `account_id`, `category_id`, `amount`, `currency`, `memo` |
| `profiles` | ✓ | `id`, `full_name`, `base_currency`, `timezone`, `budget_warn_pct`, `budget_crit_pct`, `created_at` |
| `recurring_rules` | ✓ | `id`, `user_id`, `name`, `direction`, `amount`, `currency`, `account_id`, `to_account_id`, `category_id`, `frequency`, `interval_n`, `day_of_month`, `start_date`, `end_date`, `is_active`, `created_at` |
| `scheduled_items` | ✓ | `id`, `user_id`, `due_date`, `direction`, `amount`, `currency`, `account_id`, `category_id`, `counterparty_id`, `description`, `source_type`, `source_id`, `status`, `realized_entry_id`, `created_at`, `to_account_id` |

## 4. Görünümler (7)

Hepsi `security_invoker`; RLS çağıran kullanıcıya uygulanır.

- **`v_account_balances`** — id, user_id, name, kind, class, currency, institution_id, institution_name, counterparty_id, counterparty_name, credit_limit, iban_last4, color, sort_order, opened_on, archived_at, statement_day, due_day, raw_balance, balance, available_limit, last_activity
- **`v_category_monthly`** — user_id, month, kind, category_id, category_name, root_category_id, root_category_name, currency, total
- **`v_entries`** — id, user_id, entry_date, kind, status, description, reverses_entry_id, reversed_by, counterparty_id, created_at, currency, amount, lines, account_ids, category_ids
- **`v_ledger_lines`** — line_id, entry_id, user_id, entry_date, entry_kind, description, account_id, account_name, account_kind, account_class, category_id, category_name, category_kind, category_key, root_category_id, root_category_name, root_key, amount, currency, memo
- **`v_loans`** — id, user_id, name, currency, institution_name, archived_at, principal, monthly_rate, tax_pct, term_months, first_payment_date, payment_amount, remaining_principal, paid_count, unpaid_count, remaining_payments, remaining_interest, next_id, next_no, next_due, next_payment
- **`v_month_summary`** — user_id, month, currency, income, expense, net
- **`v_net_position`** — user_id, currency, assets, receivables, liabilities, net_worth

## 5. Fonksiyonlar

### 5.1 Uygulama API'si (29) — çağıran: giriş yapmış kullanıcı (`authenticated`)

| Fonksiyon | Parametreler | Döner | Çalışma | Açıklama |
|---|---|---|---|---|
| `account_class_of` | `k` | `account_class` | invoker | Hesap türünden sınıfı (`asset/liability/system`) döndürür. |
| `adjust_balance` | `p_account_id, p_actual_balance, p_date, p_reason` | `uuid` | definer | Bakiye düzeltme (mutabakat): bankadaki gerçek bakiye ile sistem uyuşmuyorsa farkı kayıt altına alır. |
| `budget_status` | `p_month` | `TABLE(budget_id uuid, category_id uuid, category_name text, parent_nam…` | invoker | Ay için kategori bütçesi, gerçekleşen, kalan, yüzde ve seviye (`level`). |
| `card_installment_slices` | `p_account_id` | `TABLE(entry_id uuid, entry_date date, description text, slice_no integ…` | invoker | Kartın taksitli alışverişlerinin dilimleri (kaçıncı taksit, faturalama tarihi, tutar). |
| `card_overview` | `` | `TABLE(account_id uuid, name text, currency character, credit_limit num…` | invoker | Her kart için borç, kullanılabilir limit, son ekstre durumu, sonraki kesim ve faturalanmamış taksitler. |
| `card_statements` | `p_account_id, p_count` | `TABLE(cut_date date, period_start date, due_date date, statement_amoun…` | invoker | Kartın ekstreleri; ilk satır içinde bulunulan (henüz kesilmemiş) dönemdir. Geçmiş dönem için yüklenmiş gerçek ekstre varsa onun tutarını/asgarisini/son ödemesini, yoksa defterden hesaplananı kullanır. |
| `copy_budgets` | `p_from, p_to` | `integer` | definer | Bir ayın bütçelerini başka aya kopyalar; kopyalanan satır sayısını döner. |
| `create_account` | `p_name, p_kind, p_currency, p_opening_balance, p_opened_on, p_institution_name, p_counterparty_name, p_credit_limit, p_statement_day, p_due_day, p_iban_last4, p_color` | `uuid` | definer | Hesap açar. Kredi kartı için kesim ve son ödeme günü, borç/alacak hesabı için kişi/kurum adı zorunlu; sistem hesabı elle açılamaz. Açılış bakiyesi özkaynak hesabı karşısında kaydedilir. |
| `create_installment_plan` | `p_account_id, p_total, p_count, p_first_date, p_description` | `integer` | definer | Karta toplam tutar, taksit sayısı ve ilk faturalama tarihiyle taksit planı ekler. |
| `create_loan` | `p_name, p_institution_name, p_currency, p_principal, p_monthly_rate, p_term_months, p_first_payment_date, p_tax_pct, p_disburse_to_account_id, p_start_date, p_paid_installments` | `uuid` | definer | Kredi hesabını ve taksit planını (anapara/faiz/vergi) oluşturur. `p_paid_installments` kadar taksit "dışarıda ödenmiş" sayılır; `p_disburse_to_account_id` verilirse kullandırılan tutar o hesaba geçer. |
| `debt_service_outlook` | `p_months` | `TABLE(month date, source text, account_id uuid, account_name text, cur…` | invoker | Önümüzdeki aylar için kaynak bazında (kredi taksidi, kart…) borç servisi tahmini. |
| `financial_health` | `` | `TABLE(check_key text, title text, severity text, issue_count integer, …` | invoker | Defter bütünlüğü ve kart/kredi/ekstre tutarlılığı denetimi (16 kontrol). Salt okunur; her kontrol için ciddiyet (`ok/info/warn/crit`), sorun sayısı, ilk 5 örnek ve öneri döner. |
| `fx_rate` | `p_from, p_to, p_on` | `numeric` | invoker | İki para birimi arası kur: doğrudan, ters veya USD üzerinden çapraz. |
| `import_card_statement` | `p` | `jsonb` | definer | Ekstre içe aktarma (ATOMİK: hepsi ya da hiçbiri). `action=add` kalemleri gider/transfer olarak işler, ödemeleri kaynak hesaptan transfer (kaynak yoksa "kaynak belirsiz") yazar, `reverse_entries` ile tahmini kayıtları iptal eder, istenirse kart profilini günceller, ekstre özetini `card_statement_imports`a kaydeder. Aynı dosya ikinci kez yüklenemez; `replace=true` ile üzerine yazılır. Dönüş: eklenen/ödeme/atlanan/iptal sayıları ve kalan fark. |
| `materialize_recurring` | `p_days` | `integer` | definer | Düzenli kurallardan önümüzdeki `p_days` gün için planlı kalem üretir. Tekrar çalıştırmak güvenlidir. |
| `net_position_in_base` | `` | `TABLE(currency character, assets numeric, receivables numeric, liabili…` | invoker | Para birimi bazında net pozisyon ve baz para birimine çevrilmiş net değer. |
| `net_worth_history` | `p_months` | `TABLE(month_end date, currency character, assets numeric, receivables …` | invoker | Her ay sonu için varlık, alacak, borç ve net varlık. Defter olduğu için her tarih yeniden kurulur. |
| `notifications` | `p_days` | `TABLE(level text, kind text, title text, amount numeric, currency char…` | invoker | Bildirim listesi: vadesi geçmiş → `critical`, 2 gün içinde → `warning`. |
| `pay_loan_installment` | `p_installment_id, p_from_account_id, p_date, p_idempotency_key` | `uuid` | definer | Kredi taksidini seçilen hesaptan öder; anapara, faiz ve vergi ayrı satırlara yazılır. İdempotency anahtarı destekler. |
| `realize_scheduled_item` | `p_item_id, p_cash_account_id, p_amount, p_date, p_to_amount` | `uuid` | definer | Planlı kalemi gerçekleştirir (hesap, tutar ve tarih değiştirilebilir). Zaten işlenmiş kalem, hesapsız veya kategorisiz gerçekleştirme hata verir. |
| `record_expense` | `p_account_id, p_category_id, p_amount, p_date, p_description, p_idempotency_key, p_installments` | `uuid` | definer | Gider kaydı (banka, nakit, kart, ek hesap). Kartla harcama GİDER yazılır, kart ödemesi transferdir. `p_installments > 1` ise gider alışveriş gününde TAM tutarla yazılır, kart ekstrelerine dilimler halinde yansır. |
| `record_income` | `p_account_id, p_category_id, p_amount, p_date, p_description, p_idempotency_key` | `uuid` | definer | Gelir kaydı (hesap + gelir kategorisi). Aynı `p_idempotency_key` tekrar gelirse mevcut kaydı döndürür. |
| `record_split_expense` | `p_account_id, p_lines, p_date, p_description, p_idempotency_key` | `uuid` | definer | Tek harcamayı birden çok kategoriye böler (`p_lines` jsonb). |
| `record_transfer` | `p_from_account_id, p_to_account_id, p_amount, p_to_amount, p_date, p_description, p_idempotency_key` | `uuid` | definer | Hesaplar arası transfer (gelir/gider değildir). Kayıt türü hesap türlerinden otomatik belirlenir (kart ödemesi, borç ödeme, döviz bozdurma vb.). Farklı para biriminde `p_to_amount` girilir. |
| `reverse_entry` | `p_entry_id, p_reason` | `uuid` | definer | Kaydı iptal eder: ters kayıt oluşturur (kayıtlar silinemez). İlgili kredi taksiti ve planlı kalemleri de geri açar. |
| `statement_reconcile` | `p_account_id, p_cut` | `TABLE(owed numeric, unbilled numeric, derived numeric)` | invoker | Önizleme için defterin verilen kesimdeki durumu: kart borcu (`owed`), faturalanmamış taksit (`unbilled`), ekstreye karşılık gelen tutar (`derived`). |
| `statement_status` | `` | `TABLE(account_id uuid, name text, last4 text, last_cut date, last_due …` | invoker | Her kart için son ekstre durumu: kesim, borç, asgari, güncellik (`is_stale`), defterin hesapladığı borç ve fark. |
| `upcoming_items` | `p_days` | `TABLE(due_date date, source_type text, source_id uuid, ref_id uuid, de…` | invoker | Yaklaşan ödeme ve tahsilatlar (kart ekstresi, kredi taksidi, planlı kalemler…) vade sırasıyla; `overdue` bayrağıyla. |
| `update_entry_description` | `p_entry_id, p_description` | `void` | definer | Yalnızca kaydın açıklamasını günceller; tutar ve satırlar değişmez. |

**Anonim erişim:** yok — hiçbir API fonksiyonu `anon` role açık değil.

Kullanıcıya açık olmayan sistem fonksiyonları: `seed_default_categories`.

### 5.2 İç yardımcılar (20)

| Fonksiyon | Açıklama |
|---|---|
| `_add_months` | Ay ekler; kesim günü sabit kalır. |
| `_card_derived_statement` | Ekstreye karşılık gelen defter tutarı = kart borcu − kesim sonrası faturalanacak taksitler. |
| `_card_dues` | Karttaki ekstre vadeleri ve tutarları (yaklaşan ödemeler için). |
| `_card_owed_at` | Verilen tarihe kadar kart borcu. |
| `_card_unbilled_after` | Verilen kesimden sonra faturalanacak taksit dilimleri toplamı. |
| `_check_amount` | Tutar doğrulaması. |
| `_check_date` | Tarihi doğrular; gelecek tarihli işlemi reddeder ("planlı işlem olarak ekleyin"). |
| `_day_in_month` | Ayın son gününü aşmadan gün hesabı. |
| `_due_after` | Kesimden sonraki son ödeme tarihi. |
| `_existing_entry` | İdempotency anahtarıyla daha önce yazılmış kaydı bulur. |
| `_fx_direct` | İki para birimi arasında doğrudan kayıtlı kur. |
| `_new_entry` | Yeni defter kaydı başlığı açar. |
| `_next_cut` | Sonraki hesap kesim tarihi. |
| `_owned_account` | Hesabın bu kullanıcıya ait olduğunu doğrular. |
| `_owned_category` | Kategorinin bu kullanıcıya ait ve beklenen türde olduğunu doğrular. |
| `_post` | Kayda bir satır (posting) ekler. |
| `_system_account` | Özkaynak / kur çevrim gibi sistem hesabını bulur, yoksa oluşturur. |
| `_today` | Kullanıcının saat dilimine göre bugün (profil yoksa Europe/Istanbul). |
| `_transfer_kind` | Transferin kayıt türünü hesap türlerinden belirler. |
| `_uid` | Giriş yapmış kullanıcının kimliği. |

### 5.3 Tetikleyici fonksiyonları (11)

| Fonksiyon | Görev |
|---|---|
| `_audit` | Değişiklikleri `audit_log` tablosuna yazar. |
| `_check_account_limits` | Nakit bakiyesi eksiye düşemez; kart/ek hesap limiti aşılamaz. |
| `_check_entry_balanced` | Her kayıt, her para biriminde 0'a kapanmalı. İşlem sonunda (DEFERRED) kontrol edilir; yarım kayıt reddedilir. |
| `_forbid_posting_change` | Satırlar güncellenemez ve silinemez. |
| `_guard_account_change` | Hareket görmüş hesabın türü veya para birimi değiştirilemez. |
| `_guard_entry_change` | Kayıtlar silinemez (iptal için `reverse_entry`); tarih ve tür değiştirilemez; durum geçişlerini denetler. |
| `_recurring_changed` | Düzenli kural değişince/silinince ilgili planlanmış (`planned`) kalemleri temizler. |
| `_validate_category` | Kategoriler en fazla iki seviyeli; alt kategori ana kategoriyle aynı türde olmalı. |
| `_validate_posting` | Satırın kayda/hesaba/kullanıcıya uygunluğunu, para birimi uyumunu ve arşivli hesap kullanılmamasını doğrular. |
| `_validate_recurring` | Düzenli kural tutarlılığı: gelir/gider için kategori, transfer için hedef hesap zorunlu. |
| `handle_new_user` | Yeni kullanıcı için profil ve varsayılan kategoriler. |

### 5.4 Tetikleyiciler (29)

- `accounts` · `accounts_guard` · BEFORE UPDATE
- `accounts` · `audit_accounts` · AFTER DELETE
- `accounts` · `audit_accounts` · AFTER INSERT
- `accounts` · `audit_accounts` · AFTER UPDATE
- `budgets` · `audit_budgets` · AFTER DELETE
- `budgets` · `audit_budgets` · AFTER INSERT
- `budgets` · `audit_budgets` · AFTER UPDATE
- `categories` · `audit_categories` · AFTER DELETE
- `categories` · `audit_categories` · AFTER UPDATE
- `categories` · `categories_validate` · BEFORE INSERT
- `categories` · `categories_validate` · BEFORE UPDATE
- `counterparties` · `audit_counterparties` · AFTER DELETE
- `counterparties` · `audit_counterparties` · AFTER UPDATE
- `credit_card_details` · `audit_credit_card_details` · AFTER DELETE
- `credit_card_details` · `audit_credit_card_details` · AFTER INSERT
- `credit_card_details` · `audit_credit_card_details` · AFTER UPDATE
- `journal_entries` · `audit_journal_entries` · AFTER UPDATE
- `journal_entries` · `entries_have_postings` · AFTER INSERT
- `journal_entries` · `journal_entries_guard` · BEFORE DELETE
- `journal_entries` · `journal_entries_guard` · BEFORE UPDATE
- `postings` · `postings_balanced` · AFTER INSERT
- `postings` · `postings_immutable` · BEFORE DELETE
- `postings` · `postings_immutable` · BEFORE UPDATE
- `postings` · `postings_limits` · AFTER INSERT
- `postings` · `postings_validate` · BEFORE INSERT
- `recurring_rules` · `recurring_rules_changed` · AFTER DELETE
- `recurring_rules` · `recurring_rules_changed` · AFTER UPDATE
- `recurring_rules` · `recurring_rules_validate` · BEFORE INSERT
- `recurring_rules` · `recurring_rules_validate` · BEFORE UPDATE

## 6. Satır güvenliği (RLS) politikaları (22)

- `accounts` · `accounts_read` · SELECT
- `accounts` · `accounts_update` · UPDATE
- `attachments` · `attachments_own` · ALL
- `audit_log` · `audit_read` · SELECT
- `budgets` · `budgets_own` · ALL
- `card_installment_plans` · `cip_read` · SELECT
- `card_statement_imports` · `csi_delete` · DELETE
- `card_statement_imports` · `csi_read` · SELECT
- `categories` · `categories_own` · ALL
- `counterparties` · `counterparties_own` · ALL
- `credit_card_details` · `ccd_read` · SELECT
- `credit_card_details` · `ccd_update` · UPDATE
- `currencies` · `currencies_read` · SELECT
- `exchange_rates` · `exchange_rates_own` · ALL
- `institutions` · `institutions_own` · ALL
- `journal_entries` · `entries_read` · SELECT
- `loan_details` · `ld_read` · SELECT
- `loan_installments` · `li_read` · SELECT
- `postings` · `postings_read` · SELECT
- `profiles` · `profiles_own` · ALL
- `recurring_rules` · `recurring_rules_own` · ALL
- `scheduled_items` · `scheduled_items_own` · ALL

Depolama (Storage) politikaları `0007_storage_attachments` ile ayrıca kurulur (Supabase panelinde çalıştırılır).

## 7. Uygulama sayfaları (14)

| Rota | Bileşen | Menü adı |
|---|---|---|
| `/` | `Dashboard.tsx` | Özet |
| `/islemler` | `Transactions.tsx` | İşlemler |
| `/hesaplar` | `Accounts.tsx` | Hesaplar |
| `/kategoriler` | `Categories.tsx` | Kategoriler |
| `/kartlar` | `Cards.tsx` | Kredi kartları |
| `/krediler` | `Loans.tsx` | Krediler |
| `/planli` | `Planned.tsx` | Planlı ve düzenli |
| `/takvim` | `Calendar.tsx` | Takvim |
| `/butce` | `Budget.tsx` | Bütçe |
| `/nakit-akisi` | `CashFlow.tsx` | Nakit akışı |
| `/raporlar` | `Reports.tsx` | Raporlar |
| `/ekstre` | `Statements.tsx` | Ekstre yükle |
| `/saglik` | `Health.tsx` | Sistem sağlığı |
| `/ayarlar` | `Settings.tsx` | Ayarlar |

## 8. Ekstre okuyucu (`web/src/lib/statements/`)

Tarayıcıda çalışır; PDF dışarı gönderilmez.

| Dosya | Görev |
|---|---|
| `types.ts` | Tipler: banka, satır türü, ayrıştırılmış ekstre, hata sınıfı |
| `text.ts` | PDF metin öğelerinden satır/hücre kurma, EBCDIC çözme (Akbank), tutar ve tarih ayrıştırma |
| `parsers.ts` | Altı banka ayrıştırıcısı (Akbank, Garanti, İş Bankası, QNB, VakıfBank, Yapı Kredi), banka tespiti, ortak doğrulamalar (`checks`) |
| `match.ts` | Ekstre satırlarını defter kayıtlarıyla eşleştirir (tutar + tarih + açıklama puanı; ≥5 eşleşti, ≥3,5 olası, altı yeni); kategori önerisi |
| `import.ts` | Varsayılan kararlar, dosya SHA-256, `import_card_statement` yükü |
| `pdf.ts` | pdf.js ile tarayıcıda okuma (şifreli PDF desteği) |

## 9. Migration'lar (12)

| Dosya | Başlık |
|---|---|
| `20260927000001_foundation.sql` | BÜTÇE TAKİP SİSTEMİ · 0001 · Temel şema |
| `20260927000002_ledger_integrity.sql` | 0002 · Defter bütünlük kuralları (veritabanı seviyesinde garanti) |
| `20260927000003_api.sql` | 0003 · İşlem API'si (Supabase RPC) |
| `20260927000004_views_rls.sql` | 0004 · Okuma görünümleri + Row Level Security + yetkiler |
| `20260927000005_fixed_asset_enum.sql` | 0005 · Yeni hesap türü: fiziksel varlık (araç, gayrimenkul, altın …) |
| `20260927000006_phases_2_to_6.sql` | 0006 · Faz 2–6 backend |
| `20260927000007_storage_attachments.sql` | 0007 · Belgeler (dekont, fatura, sözleşme, ekstre) — Supabase Storage |
| `20260927000008_security_hardening.sql` | 0008 · Güvenlik sıkılaştırma (Supabase Security Advisor bulguları) |
| `20260927000009_fk_indexes.sql` | 0009 · Yabancı anahtar indeksleri (Supabase Performance Advisor) |
| `20260928000010_reports.sql` | 0010 · Rapor altyapısı |
| `20260928000011_statement_import.sql` | 0011 · Banka ekstresi içe aktarma |
| `20260928000012_financial_health.sql` | 0012 · Finansal sağlık denetimi |

Sıra önemlidir. `0005` (enum) ayrı işlem olarak uygulanmadan `0006` çalışmaz. `0007` Supabase Storage'a özeldir (yerel testte atlanır).

## 10. Testler (toplam 147)

| Dosya | Test |
|---|---|
| `health_tests.sql` | 47 |
| `ledger_tests.sql` | 45 |
| `phases_tests.sql` | 55 |

```bash
createdb butce
psql -d butce -f supabase/tests/_supabase_shim.sql
for f in supabase/migrations/*.sql; do case $f in *0007*) continue;; esac; psql -v ON_ERROR_STOP=1 -d butce -f $f; done
for t in ledger_tests phases_tests health_tests; do psql -d butce -v ON_ERROR_STOP=1 -f supabase/tests/$t.sql; done
```

## 11. Yayın

1. Değişiklikler GitHub `main` dalına gönderilir.
2. `.github/workflows/pages.yml` derler (`VITE_BASE=/Butce-Kontrolu/`) ve GitHub Pages'e yayınlar; `404.html`, `index.html`in kopyasıdır (sayfa yenileme için).
3. Veritabanı değişiklikleri Supabase'e migration olarak uygulanır; dosya ayrıca depoda tutulur.
4. `netlify.toml` eski Netlify yayını içindir; Pages kullanılırken devre dışı bırakılabilir.

