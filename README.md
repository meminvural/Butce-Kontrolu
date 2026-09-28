# Bütçe Defteri — Kişisel Finans Yönetim Sistemi

React + TypeScript + Supabase. Çift taraflı defter mimarisi. Ayrıntı: `docs/ARCHITECTURE.md`.

## Klasörler
```
supabase/migrations/   9 migration — hepsi fxmkecavnmoftbbxiefo projesine uygulandı
supabase/tests/        104 test: ledger_tests.sql (45) + phases_tests.sql (59)
web/                   React uygulaması, 13 sayfa (Vercel'e hazır)
docs/                  Mimari
```

## Kurulum

### 1. Veritabanı
Supabase → **SQL Editor**: `supabase/migrations/` içindeki 9 dosyayı **ayrı ayrı ve sırayla** çalıştırın.
(0005 enum değişikliği ayrı transaction'da commit edilmeden 0006 çalışmaz; hepsini tek seferde yapıştırmayın.)
Supabase CLI ile: `supabase link --project-ref <ref> && supabase db push`.

### 2. Uygulama
```bash
cd web
cp .env.example .env.local      # Supabase → Project Settings → API
npm install
npm run dev                     # http://localhost:5173
```

### 3. Yayın (Vercel)
Root: `web` · Build: `npm run build` · Output: `dist` · Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
Supabase → Authentication → URL Configuration'a Vercel adresinizi ekleyin.

## Sayfalar
Özet · İşlemler · Hesaplar · Kredi kartları · Krediler · Planlı ve düzenli · Takvim · Bütçe · Nakit akışı · Raporlar · Kategoriler · Ayarlar

## İlk kullanım (önerilen sıra)
1. Kayıt olun → kategoriler otomatik gelir.
2. **Ayarlar**: baz para birimi, saat dilimi, USD/TRY ve USD/TZS kurları.
3. **Hesaplar**: banka, nakit, kart (kesim + son ödeme günü), ek hesap, borç, alacak, araç/altın → bugünkü bakiyelerle.
4. **Krediler**: devam eden kredileri "ödenen taksit sayısı" ile ekleyin.
5. **Kartlar**: devam eden taksitleri geçmiş tarihli taksitli harcama olarak girin (ekstreler doğru bölünsün).
6. **Planlı ve düzenli**: maaş, kira, faturalar.
7. **Bütçe**: bu ayın kategori limitleri.

## Günlük kullanım
| Ne oldu | Nasıl girilir |
|---|---|
| Kartla alışveriş | + İşlem → Gider → hesap: kart (taksit seçilebilir) |
| Kart borcunu ödedim | Kartlar → "Tamamını/Asgariyi öde" veya Transfer banka → kart |
| Kredi taksidi | Krediler → "Taksidi öde" (anapara/faiz otomatik ayrılır) |
| Ali'ye borç verdim / geri ödedi | Transfer banka → Ali / Ali → banka |
| Dolar bozdurdum | Transfer USD → TL, giren TL tutarı |
| Yanlış giriş | İşleme tıkla → İptal et (ters kayıt) |
| Banka bakiyesi tutmuyor | Hesaplar → Bakiye düzelt |

## Testler (yerel PostgreSQL)
```bash
createdb butce
psql -d butce -f supabase/tests/_supabase_shim.sql
for f in supabase/migrations/2026092700000[1-6]*.sql; do psql -d butce -f $f; done   # 0007 Storage'a özel
psql -d butce -f supabase/tests/ledger_tests.sql
psql -d butce -f supabase/tests/phases_tests.sql
```
