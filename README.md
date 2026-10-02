# Bütçe Defteri — Kişisel Finans Yönetim Sistemi

React + TypeScript + Supabase. Çift taraflı defter mimarisi.
Ayrıntı: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Tam referans (otomatik üretilir): [`docs/SYSTEM_REFERENCE.md`](docs/SYSTEM_REFERENCE.md)

## Klasörler
```
supabase/migrations/   17 migration (0007 Storage'a özel)
supabase/tests/        313 test: ledger (45) + phases (55) + health (47) + ekstre düzenleme (44) + düzeltme (35) + otomasyon (57) + ekstre durumu (30)
web/                   React uygulaması, 14 sayfa
docs/                  Mimari + sistem referansı
scripts/               Referans belgesini şemadan üreten araçlar
.github/workflows/     GitHub Pages yayın akışı
```
> Sayılar `docs/SYSTEM_REFERENCE.md` başlığında koddan yeniden üretilir; burada elle güncellenirse kopma olur.

## Kurulum

### 1. Veritabanı
Supabase → **SQL Editor**: `supabase/migrations/` içindeki dosyaları **ayrı ayrı ve sırayla** çalıştırın (hepsini tek seferde yapıştırmayın;
`0005` enum değişikliği commit edilmeden `0006` çalışmaz). Supabase CLI ile: `supabase link --project-ref <ref> && supabase db push`.

### 2. Uygulama
```bash
cd web
cp .env.example .env.local      # Supabase → Project Settings → API
npm install
npm run dev                     # http://localhost:5173
```

### 3. Yayın (GitHub Pages)
`main` dalına her gönderimde `.github/workflows/pages.yml` siteyi derler ve yayınlar.
Bir kerelik ayar: repo → Settings → **Pages** → Source: **GitHub Actions**.
Supabase → Authentication → URL Configuration: Site URL ve Redirect URLs'e site adresini ekleyin
(`https://<kullanıcı>.github.io/Butce-Kontrolu/`). Herkese açık depo kullanıyorsanız **yeni kullanıcı kaydını kapatın**.

## Sayfalar
Özet · İşlemler · Hesaplar · Kategoriler · Kredi kartları · Krediler · Planlı ve düzenli · Takvim · Bütçe · Nakit akışı · Raporlar · **Ekstre yükle** · **Sistem sağlığı** · Ayarlar

## İlk kullanım (önerilen sıra)
1. Kayıt olun → kategoriler otomatik gelir.
2. **Ayarlar**: baz para birimi, saat dilimi, USD/TRY ve USD/TZS kurları.
3. **Hesaplar**: banka, nakit, kart (kesim + son ödeme günü), ek hesap, borç, alacak, araç/altın → bugünkü bakiyelerle.
4. **Krediler**: devam eden kredileri "ödenen taksit sayısı" ile ekleyin.
5. **Kartlar**: devam eden taksitleri geçmiş tarihli taksitli harcama olarak girin (ekstreler doğru bölünsün).
6. **Planlı ve düzenli**: maaş, kira, faturalar.
7. **Bütçe**: bu ayın kategori limitleri.
8. **Ekstre yükle**: kart ekstrelerini (PDF) yükleyip defterle eşleştirin; **Sistem sağlığı**nı düzenli kontrol edin.

## Günlük kullanım
| Ne oldu | Nasıl girilir |
|---|---|
| Kartla alışveriş | + İşlem → Gider → hesap: kart (taksit seçilebilir) |
| Kart borcunu ödedim | Kartlar → "Tamamını/Asgariyi öde" veya Transfer banka → kart |
| Kart ekstresi geldi | Ekstre yükle → PDF → önizlemeyi kontrol et → onayla |
| Kredi taksidi | Krediler → "Taksidi öde" (anapara/faiz otomatik ayrılır) |
| Ali'ye borç verdim / geri ödedi | Transfer banka → Ali / Ali → banka |
| Dolar bozdurdum | Transfer USD → TL, giren TL tutarı |
| Yanlış giriş | İşleme tıkla → İptal et (ters kayıt) |
| Banka bakiyesi tutmuyor | Hesaplar → Bakiye düzelt |
| Bir şey tutmuyor gibi | Sistem sağlığı → ilgili uyarıya git |

## Testler (yerel PostgreSQL)
```bash
createdb butce
psql -d butce -f supabase/tests/_supabase_shim.sql
for f in supabase/migrations/*.sql; do case $f in *0007*) continue;; esac; psql -v ON_ERROR_STOP=1 -d butce -f $f; done   # 0007 Storage'a özel
for t in ledger_tests phases_tests health_tests stmt_edit_tests corrections_tests automation_tests statement_state_tests; do psql -d butce -v ON_ERROR_STOP=1 -f supabase/tests/$t.sql; done
```

## Sistem referansını yenileme
```bash
psql -X -q -d butce -f scripts/schema_dump.sql > /tmp/schema.out
python3 scripts/gen_reference.py --dump /tmp/schema.out > docs/SYSTEM_REFERENCE.md
```
