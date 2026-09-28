-- =====================================================================
--  0005 · Yeni hesap türü: fiziksel varlık (araç, gayrimenkul, altın …)
--  PostgreSQL'de yeni enum değeri, eklendiği transaction içinde
--  kullanılamaz; bu yüzden ayrı migration.
-- =====================================================================
alter type account_kind add value if not exists 'fixed_asset' after 'investment';
