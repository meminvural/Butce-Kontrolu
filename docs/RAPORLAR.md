# Raporlar ve Özet

## Nasıl çalışır
- **Veri kaynağı:** `v_ledger_lines` görünümü (iptal edilmiş ve ters kayıtlar hariç, sistem hesapları gizli). Tarayıcı seçili dönemin satırlarını bir kez çeker; bütün grafikler ve tablolar bu satırlardan hesaplanır. Böylece dönem, para birimi ve filtre değişiklikleri anında sonuç verir.
- **Hesaplamalar:** `web/src/lib/analytics.ts` (saf fonksiyonlar). Özet ve Raporlar sayfası aynı fonksiyonları kullanır, rakamlar iki yerde de aynıdır.
- **Tanımlar:** `web/src/lib/glossary.ts`. ⓘ balonları ve Raporlar > Sözlük sekmesi bu tek listeden beslenir. Bir tanımı değiştirmek her yerde günceller.
- **Gelecek taksit yükü:** `debt_service_outlook(ay)` fonksiyonu (kart taksit dilimleri + ödenmemiş kredi taksitleri).

## Tanımlar (özet)
- Gider: gider kategorisine yazılan satırlar. Gelir: gelir kategorisine yazılan satırlar.
- Finansal maliyet: kök kategorisi `financial_costs` ("Finansal Giderler") olan giderler (faiz, KKDF/BSMV, ücretler).
- Ödeme: borç hesabına (kart, ek hesap, kredi, kişisel borç) giren para; açılış ve düzeltme kayıtları hariç.
- Devreden (açılış) kayıtları gider sayılmaz.

## Ekranlar
- **Özet:** dönem/para birimi seçimi, güncel durum, dönem göstergeleri (önceki dönemle fark), otomatik bulgular, gelir-gider trendi (tıklayınca ay/gün seçilir), gider dağılımı, en çok harcanan kalemler, faiz ve masraflar, haftanın günleri, ısı haritası, borç ve limit kullanımı, gelecek taksit yükü.
- **Raporlar:** Genel özet (yazdırılabilir), Gider analizi, Gelir, Borç ve faiz, Dönem karşılaştırma, Sözlük, Dışa aktar.
- Her grafik kartında Grafik/Tablo geçişi vardır; tablo aynı rakamları listeler.
