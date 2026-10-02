# Bütçe Defteri — Sistem Referansı

> **Bu belge otomatik üretilir** (`scripts/gen_reference.py`) — tablolar, fonksiyonlar, yetkiler, rotalar, migration ve test sayıları koddan okunur; elle düzenlemeyin.  
> Üretim tarihi: 2026-10-02 · Migration: **17** · Test: **313** · Sayfa: **16**

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


## 3. Tablolar (0)

| Tablo | RLS | Sütunlar |
|---|---|---|

## 4. Görünümler (0)

Hepsi `security_invoker`; RLS çağıran kullanıcıya uygulanır.


## 5. Fonksiyonlar

### 5.1 Uygulama API'si (0) — çağıran: giriş yapmış kullanıcı (`authenticated`)

| Fonksiyon | Parametreler | Döner | Çalışma | Açıklama |
|---|---|---|---|---|

**Anonim erişim:** yok — hiçbir API fonksiyonu `anon` role açık değil.

### 5.2 İç yardımcılar (0)

| Fonksiyon | Açıklama |
|---|---|

### 5.3 Tetikleyici fonksiyonları (0)

| Fonksiyon | Görev |
|---|---|

### 5.4 Tetikleyiciler (0)


## 6. Satır güvenliği (RLS) politikaları (0)


Depolama (Storage) politikaları `0007_storage_attachments` ile ayrıca kurulur (Supabase panelinde çalıştırılır).

## 7. Uygulama sayfaları (16)

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
| `/aktar` | `Import.tsx` | Excel / toplu giriş |
| `/borc-plani` | `DebtPlan.tsx` | Borç planı ve otomatik ödeme |
| `/saglik` | `Health.tsx` | Sistem sağlığı |
| `/ayarlar` | `Settings.tsx` | Ayarlar |

## 8. Ekstre okuyucu (`web/src/lib/statements/`)

Tarayıcıda çalışır; PDF dışarı gönderilmez.

| Dosya | Görev |
|---|---|
| `types.ts` | Tipler: banka, satır türü, ayrıştırılmış ekstre, hata sınıfı |
| `text.ts` | PDF metin öğelerinden satır/hücre kurma, EBCDIC çözme (Akbank), tutar ve tarih ayrıştırma |
| `parsers.ts` | Sekiz banka ayrıştırıcısı (Akbank, Enpara, Garanti, İş Bankası, QNB, VakıfBank, Yapı Kredi, Ziraat), banka tespiti, ortak doğrulamalar (`checks`) |
| `match.ts` | Ekstre satırlarını defter kayıtlarıyla eşleştirir (tutar + tarih + açıklama puanı; ≥5 eşleşti, ≥3,5 olası, altı yeni); kategori önerisi |
| `import.ts` | Varsayılan kararlar, dosya SHA-256, `import_card_statement` yükü |
| `pdf.ts` | pdf.js ile tarayıcıda okuma (şifreli PDF desteği) |

## 9. Migration'lar (17)

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
| `20260928000013_statement_edit.sql` | 0013 · Ekstre düzenleme |
| `20260928000014_corrections.sql` | 0014 · Düzeltme araçları (tüm ekranlar için) |
| `20260928000015_automation.sql` | 0015 · Otomasyon: borç hesaplama · otomatik asgari ödeme · otomatik ödeme · toplu içe aktarma |
| `20260928000016_import_carry.sql` | 0016 · Toplu içe aktarmada "devreden borç" satırı (kind = 'carry') |
| `20260928000017_statement_state.sql` | 0017 · Ekstre durumu: ödeme yapıldı mı · ekstre kapandı mı |

Sıra önemlidir. `0005` (enum) ayrı işlem olarak uygulanmadan `0006` çalışmaz. `0007` Supabase Storage'a özeldir (yerel testte atlanır).

## 10. Testler (toplam 313)

| Dosya | Test |
|---|---|
| `automation_tests.sql` | 57 |
| `corrections_tests.sql` | 35 |
| `health_tests.sql` | 47 |
| `ledger_tests.sql` | 45 |
| `phases_tests.sql` | 55 |
| `statement_state_tests.sql` | 30 |
| `stmt_edit_tests.sql` | 44 |

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

