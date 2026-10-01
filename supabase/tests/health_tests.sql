-- =====================================================================
--  Finansal sağlık testleri (financial_health + yetki kapatma).
--  Sıra: shim → migration'lar → ledger_tests → phases_tests → health_tests
--  Her kontrolün sorunu GERÇEKTEN yakaladığı, temiz veride ise sessiz kaldığı doğrulanır.
-- =====================================================================
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on

create or replace function pg_temp.eq(p_label text, p_actual numeric, p_expected numeric)
returns text language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'BAŞARISIZ: % → beklenen %, gelen %', p_label, p_expected, p_actual;
  end if;
  return '✓ ' || p_label;
end $$;
create or replace function pg_temp.eqt(p_label text, p_actual text, p_expected text)
returns text language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'BAŞARISIZ: % → beklenen %, gelen %', p_label, p_expected, p_actual;
  end if;
  return '✓ ' || p_label;
end $$;
-- Tek kontrolün ciddiyeti / sorun sayısı
create or replace function pg_temp.sev(p_key text) returns text language sql as
  $$ select severity from financial_health() where check_key = p_key $$;
create or replace function pg_temp.cnt(p_key text) returns numeric language sql as
  $$ select issue_count from financial_health() where check_key = p_key $$;
-- Süper kullanıcı olarak, tetikleyicileri atlayıp ham kayıt yazar (API'nin engellediği bozuk durumları kurmak için)
create or replace function pg_temp.raw_entry(p_uid uuid, p_kind entry_kind, p_date date, p_desc text,
  p_acc uuid, p_amount numeric, p_ccy char(3) default 'TRY', p_balanced boolean default true)
returns uuid language plpgsql as $$
declare v_e uuid := gen_random_uuid(); v_eq uuid;
begin
  select id into v_eq from accounts where user_id = p_uid and kind = 'equity' and currency = p_ccy limit 1;
  if v_eq is null then v_eq := _system_account(p_uid, 'equity', p_ccy); end if;
  insert into journal_entries (id, user_id, entry_date, kind, description) values (v_e, p_uid, p_date, p_kind, p_desc);
  insert into postings (entry_id, user_id, account_id, amount, currency) values (v_e, p_uid, p_acc, p_amount, p_ccy);
  if p_balanced then
    insert into postings (entry_id, user_id, account_id, amount, currency) values (v_e, p_uid, v_eq, -p_amount, p_ccy);
  end if;
  return v_e;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444', 'saglik@test'),
  ('55555555-5555-5555-5555-555555555555', 'baska2@test');
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);

select id as cat_market from categories where name = 'Market' \gset

select create_account('Banka',  'bank', 'TRY', 50000, current_date - 120, 'Ziraat') as bank \gset
select create_account('Banka2', 'bank', 'TRY', 100,   current_date - 120, 'Ziraat') as bank2 \gset
select create_account('Banka3', 'bank', 'TRY', 300,   current_date - 120, 'Ziraat') as bank3 \gset
select create_account('Kart1',  'credit_card', 'TRY', 0, current_date - 120, 'Garanti', null, 100000, 5, 15) as kart1 \gset
select create_account('Kart2',  'credit_card', 'TRY', 0, current_date - 120, 'Akbank',  null, 100000, 7, 17) as kart2 \gset

-- =========== TEMİZ VERİ: hiçbir uyarı olmamalı ==============================
select record_expense(:'kart1', :'cat_market', 1000, current_date - 20, 'Market A') \gset
select record_expense(:'kart2', :'cat_market', 500,  current_date - 15, 'Market B') \gset
select pg_temp.eq('16 kontrol çalışıyor', (select count(*) from financial_health()), 16);
select pg_temp.eq('Temiz veride uyarı/kritik yok',
  (select count(*) from financial_health() where severity in ('warn', 'crit')), 0);
select pg_temp.eqt('Ekstresiz borçlu kartlar bilgi olarak çıkar', pg_temp.sev('statement_stale'), 'info');
select pg_temp.eq('İki kartın da ekstresi yok', pg_temp.cnt('statement_stale'), 2);

-- =========== Mükerrer şüphesi ================================================
select record_expense(:'kart1', :'cat_market', 250, current_date - 3, 'Kahve') \gset
select record_expense(:'kart1', :'cat_market', 250, current_date - 3, 'Kahve') \gset
select pg_temp.eqt('Aynı gün/tutar/açıklama → olası mükerrer', pg_temp.sev('possible_duplicates'), 'info');
select pg_temp.eq('Tek grup bulunur', pg_temp.cnt('possible_duplicates'), 1);
select record_expense(:'kart1', :'cat_market', 250, current_date - 3, 'Başka yer') \gset
select pg_temp.eq('Farklı açıklama mükerrer sayılmaz', pg_temp.cnt('possible_duplicates'), 1);

-- =========== Ekstre farkı + güncellik ========================================
select import_card_statement(jsonb_build_object(
  'account_id', :'kart2', 'file_hash', repeat('a', 64), 'bank', 'test',
  'cut_date', (current_date - 5)::text, 'statement_debt', 777.77, 'lines', '[]'::jsonb)) \gset
select pg_temp.eqt('Ekstre ile defter farklı → uyarı', pg_temp.sev('statement_diff'), 'warn');
select pg_temp.eq('Bir kart farklı', pg_temp.cnt('statement_diff'), 1);
select pg_temp.eq('Ekstresi yüklenen kart artık "ekstresiz" değil', pg_temp.cnt('statement_stale'), 1);
select pg_temp.eq('Fark ekstre − defter doğru hesaplanır',
  (select (detail->0->>'fark')::numeric from financial_health() where check_key = 'statement_diff'), -277.77);

-- =========== Kredi: vadesi geçmiş taksit + plan tutarsızlığı =================
select create_loan('Taşıt', 'Garanti', 'TRY', 12000, 2, 12, current_date - 65, 0, null, null, 1) as loan \gset
select pg_temp.eqt('Vadesi geçmiş ödenmemiş taksit → uyarı', pg_temp.sev('loan_overdue'), 'warn');
select pg_temp.eq('Vadesi geçmiş taksit sayısı doğru', pg_temp.cnt('loan_overdue'),
  (select count(*) from loan_installments where paid_entry_id is null and not settled_outside and due_date < current_date));
select pg_temp.eq('En az bir geciken taksit var', (pg_temp.cnt('loan_overdue') > 0)::int, 1);
select pg_temp.eqt('Sağlam kredi planı tutarlı', pg_temp.sev('loan_mismatch'), 'ok');

-- =========== Süper kullanıcı: API'nin engellediği bozuk durumlar =============
reset role;
set session_replication_role = replica;

-- plan toplamı ana paradan farklı
update loan_installments set principal = principal + 100 where account_id = :'loan' and installment_no = 1;

-- satırsız kayıt
insert into journal_entries (user_id, entry_date, kind, description)
  values ('44444444-4444-4444-4444-444444444444', current_date - 2, 'adjustment', 'BOŞ');

-- dengesiz kayıt (tek bacak)
select pg_temp.raw_entry('44444444-4444-4444-4444-444444444444', 'adjustment', current_date - 2, 'DENGESİZ', :'bank', 10, 'TRY', false) \gset

-- para birimi uyuşmazlığı (TRY hesaba USD satırı, kendi içinde dengeli)
select pg_temp.raw_entry('44444444-4444-4444-4444-444444444444', 'adjustment', current_date - 2, 'KUR HATASI', :'bank', 5, 'USD', true) \gset

-- kopuk iptal bağı
select pg_temp.raw_entry('44444444-4444-4444-4444-444444444444', 'adjustment', current_date - 9, 'A', :'bank', 1) as ea \gset
select pg_temp.raw_entry('44444444-4444-4444-4444-444444444444', 'adjustment', current_date - 9, 'B', :'bank', -1) as eb \gset
update journal_entries set status = 'reversed', reversed_by = :'eb' where id = :'ea';

-- kategorisiz harcama
select pg_temp.raw_entry('44444444-4444-4444-4444-444444444444', 'expense', current_date - 1, 'KATEGORİSİZ', :'bank', -20) \gset

-- eksi bakiyeli banka hesabı
select pg_temp.raw_entry('44444444-4444-4444-4444-444444444444', 'adjustment', current_date - 1, 'EKSİ', :'bank2', -999) \gset

-- kartta fazla ödeme (alacak): Kart2 borcu 500, 2000 TL fazla ödeme
select pg_temp.raw_entry('44444444-4444-4444-4444-444444444444', 'card_payment', current_date - 1, 'FAZLA ÖDEME', :'kart2', 2000) \gset

-- gelecek tarihli kayıt
select pg_temp.raw_entry('44444444-4444-4444-4444-444444444444', 'adjustment', current_date + 6, 'GELECEK', :'bank', 1) \gset

-- limit aşımı: Kart1 limitini borcun altına çek
update accounts set credit_limit = 500 where id = :'kart1';

-- arşivlenmiş ama bakiyeli hesap
update accounts set archived_at = now() where id = :'bank3';

-- vadesi geçmiş planlı ödeme
insert into scheduled_items (user_id, due_date, direction, amount, currency, account_id, description, source_type, status)
  values ('44444444-4444-4444-4444-444444444444', current_date - 4, 'out', 300, 'TRY', :'bank', 'Kira', 'manual', 'planned');

set session_replication_role = origin;
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);

select pg_temp.eqt('Dengesiz kayıt → KRİTİK', pg_temp.sev('unbalanced_entries'), 'crit');
select pg_temp.eq('Yalnız tek bacaklı kayıt dengesiz sayılır', pg_temp.cnt('unbalanced_entries'), 1);
select pg_temp.eqt('Satırsız kayıt → KRİTİK', pg_temp.sev('empty_entries'), 'crit');
select pg_temp.eq('Tek boş kayıt', pg_temp.cnt('empty_entries'), 1);
select pg_temp.eqt('Kopuk iptal bağı → KRİTİK', pg_temp.sev('reversal_links'), 'crit');
select pg_temp.eq('Kopuk bağ: tek kayıt', pg_temp.cnt('reversal_links'), 1);
select pg_temp.eqt('Para birimi uyuşmazlığı → KRİTİK', pg_temp.sev('currency_mismatch'), 'crit');
select pg_temp.eq('Tek uyuşmayan satır', pg_temp.cnt('currency_mismatch'), 1);
select pg_temp.eqt('Kategorisiz harcama → uyarı', pg_temp.sev('uncategorized'), 'warn');
select pg_temp.eq('Tek kategorisiz kayıt', pg_temp.cnt('uncategorized'), 1);
select pg_temp.eqt('Eksi bakiyeli banka → uyarı', pg_temp.sev('negative_cash'), 'warn');
select pg_temp.eq('Yalnız Banka2 eksi', pg_temp.cnt('negative_cash'), 1);
select pg_temp.eqt('Limit aşımı → uyarı', pg_temp.sev('over_limit'), 'warn');
select pg_temp.eq('Yalnız Kart1 limiti aştı', pg_temp.cnt('over_limit'), 1);
select pg_temp.eqt('Kartta alacak → bilgi', pg_temp.sev('card_credit'), 'info');
select pg_temp.eq('Yalnız Kart2 alacaklı', pg_temp.cnt('card_credit'), 1);
select pg_temp.eqt('Gelecek tarihli kayıt → bilgi', pg_temp.sev('future_dated'), 'info');
select pg_temp.eq('Tek gelecek tarihli kayıt', pg_temp.cnt('future_dated'), 1);
select pg_temp.eqt('Arşivli hesapta bakiye → uyarı', pg_temp.sev('archived_balance'), 'warn');
select pg_temp.eq('Yalnız Banka3', pg_temp.cnt('archived_balance'), 1);
select pg_temp.eqt('Vadesi geçmiş planlı ödeme → uyarı', pg_temp.sev('scheduled_overdue'), 'warn');
select pg_temp.eq('Tek geciken planlı ödeme', pg_temp.cnt('scheduled_overdue'), 1);
select pg_temp.eqt('Kredi planı toplamı bozuk → uyarı', pg_temp.sev('loan_mismatch'), 'warn');
select pg_temp.eq('Tek kredi tutarsız', pg_temp.cnt('loan_mismatch'), 1);

-- Arşivli hesap "eksi/limit" kontrollerine karışmaz (Banka3 arşivli, bakiye pozitif ama zaten dışarıda)
select pg_temp.eq('Arşivli hesap eksi-bakiye listesine girmez',
  (select count(*) from financial_health(), jsonb_array_elements(detail) d
   where check_key = 'negative_cash' and d->>'hesap' = 'Banka3'), 0);

-- =========== İZOLASYON ve YETKİ =============================================
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', false);
select pg_temp.eq('RLS: başka kullanıcıda hiçbir sorun görünmez',
  (select coalesce(sum(issue_count), 0) from financial_health()), 0);

reset role;
select pg_temp.eqt('Anonim rol financial_health çalıştıramaz',
  has_function_privilege('anon', 'financial_health()', 'execute')::text, 'false');
select pg_temp.eqt('Anonim rol ekstre içe aktaramaz',
  has_function_privilege('anon', 'import_card_statement(jsonb)', 'execute')::text, 'false');
select pg_temp.eqt('Anonim rol ekstre durumunu okuyamaz',
  has_function_privilege('anon', 'statement_status()', 'execute')::text, 'false');
select pg_temp.eqt('Anonim rol borç servis tahminini okuyamaz',
  has_function_privilege('anon', 'debt_service_outlook(int)', 'execute')::text, 'false');
select pg_temp.eqt('Giriş yapmış kullanıcı çalıştırabilir',
  has_function_privilege('authenticated', 'financial_health()', 'execute')::text, 'true');
select pg_temp.eqt('Anonim rol ekstre kayıtlarına erişemez',
  has_table_privilege('anon', 'card_statement_imports', 'select')::text, 'false');

select '— SAĞLIK TESTLERİ GEÇTİ —';
