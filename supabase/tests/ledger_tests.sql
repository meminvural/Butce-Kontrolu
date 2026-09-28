-- =====================================================================
--  Defter testleri — dokümandaki Bölüm 56 senaryoları + Bölüm 37 hataları
--  Çalıştırma: psql -v ON_ERROR_STOP=1 -f ledger_tests.sql
--  (Supabase'de: SQL Editor'de BEGIN; ... ROLLBACK; içinde çalıştırılabilir)
-- =====================================================================
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on

-- Test yardımcıları -------------------------------------------------------
create or replace function pg_temp.eq(p_label text, p_actual numeric, p_expected numeric)
returns text language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'BAŞARISIZ: % → beklenen %, gelen %', p_label, p_expected, p_actual;
  end if;
  return '✓ ' || p_label;
end $$;

create or replace function pg_temp.must_fail(p_label text, p_sql text, p_pattern text)
returns text language plpgsql as $$
begin
  begin
    execute p_sql;
    set constraints all immediate;   -- ertelenmiş (commit) kontrollerini şimdi çalıştır
    set constraints all deferred;
  exception when others then
    set constraints all deferred;
    if sqlerrm ilike '%' || p_pattern || '%' then
      return '✓ ' || p_label || '  (engellendi: ' || sqlerrm || ')';
    end if;
    raise exception 'BAŞARISIZ: % → beklenmeyen hata: %', p_label, sqlerrm;
  end;
  raise exception 'BAŞARISIZ: % → hata bekleniyordu, işlem geçti', p_label;
end $$;

grant execute on all functions in schema pg_temp to authenticated;

-- İki kullanıcı (RLS izolasyonu için)
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'mehmet@test'),
  ('22222222-2222-2222-2222-222222222222', 'baska@test');

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

select pg_temp.eq('Varsayılan kategoriler oluştu (>20)', least((select count(*) from categories), 21), 21);

-- Kategori kimlikleri
select id as cat_maas   from categories where name = 'Maaş'   \gset
select id as cat_market from categories where name = 'Market' \gset
select id as cat_giyim  from categories where name = 'Giyim'  \gset
select id as cat_kira   from categories where name = 'Kira' and parent_id is not null \gset

-- Hesaplar
select create_account('Ziraat TL',  'bank', 'TRY', 0, current_date - 10, 'Ziraat Bankası') as ziraat \gset
select create_account('Garanti TL', 'bank', 'TRY', 20000, current_date - 10, 'Garanti BBVA') as garanti \gset
select create_account('CRDB USD',   'bank', 'USD', 1000, current_date - 10, 'CRDB') as crdb \gset
select create_account('Cüzdan',     'cash', 'TRY', 500, current_date - 10) as cuzdan \gset
select create_account('Bonus Kart', 'credit_card', 'TRY', 0, current_date - 10, 'Garanti BBVA',
                      null, 150000, 5, 15) as kart \gset
select create_account('Ali',        'receivable', 'TRY', 0, current_date - 10, null, 'Ali') as ali \gset

-- ---------- Test 1: Gelir ------------------------------------------------
select record_income(:'ziraat', :'cat_maas', 100000, current_date - 5, 'Eylül maaşı', 'maas-2026-09') as e_maas \gset
select pg_temp.eq('T1 Gelir → Ziraat +100.000', (select balance from v_account_balances where id = :'ziraat'), 100000);

-- Çift kayıt koruması: aynı idempotency key → aynı kayıt, bakiye değişmez
select pg_temp.eq('Çift kayıt: aynı anahtar aynı kaydı döndürür',
  (select case when record_income(:'ziraat', :'cat_maas', 100000, current_date - 5, 'Eylül maaşı', 'maas-2026-09') = :'e_maas'
          then 1 else 0 end), 1);
select pg_temp.eq('Çift kayıt: bakiye hâlâ 100.000', (select balance from v_account_balances where id = :'ziraat'), 100000);

-- ---------- Test 2: Gider ------------------------------------------------
select record_expense(:'ziraat', :'cat_kira', 5000, current_date - 4, 'Kira') as e_kira \gset
select pg_temp.eq('T2 Gider → Ziraat −5.000', (select balance from v_account_balances where id = :'ziraat'), 95000);

-- ---------- Test 3: Transfer ---------------------------------------------
select sum(net_worth) as nw_before from v_net_position where currency = 'TRY' \gset
select record_transfer(:'ziraat', :'garanti', 50000, null, current_date - 3, 'Hesaplar arası') \gset
select pg_temp.eq('T3 Transfer: Ziraat 45.000', (select balance from v_account_balances where id = :'ziraat'), 45000);
select pg_temp.eq('T3 Transfer: Garanti 70.000', (select balance from v_account_balances where id = :'garanti'), 70000);
select pg_temp.eq('T3 Transfer: toplam varlık DEĞİŞMEDİ',
  (select sum(net_worth) from v_net_position where currency = 'TRY'), :nw_before);
select pg_temp.eq('T3 Transfer gelir sayılmadı (ay geliri = 100.000)',
  (select coalesce(sum(income),0) from v_month_summary where currency = 'TRY'
     and month = date_trunc('month', current_date - 3)::date), 
  case when date_trunc('month', current_date - 5) = date_trunc('month', current_date - 3) then 100000 else 0 end);

-- ---------- Test 4: Kart harcaması --------------------------------------
select sum(expense) as exp_before from v_month_summary where currency = 'TRY' \gset
select record_expense(:'kart', :'cat_giyim', 5000, current_date - 2, 'Mont') as e_kart \gset
select pg_temp.eq('T4 Kart borcu +5.000',            (select balance from v_account_balances where id = :'kart'), 5000);
select pg_temp.eq('T4 Kullanılabilir limit −5.000',  (select available_limit from v_account_balances where id = :'kart'), 145000);
select pg_temp.eq('T4 Gider +5.000',                 (select sum(expense) from v_month_summary where currency = 'TRY'), :exp_before + 5000);
select pg_temp.eq('T4 Kayıt türü card_purchase',     (select case when kind = 'card_purchase' then 1 else 0 end from journal_entries where id = :'e_kart'), 1);

-- ---------- Test 5: Kart ödemesi -----------------------------------------
select sum(expense) as exp_before from v_month_summary where currency = 'TRY' \gset
select record_transfer(:'garanti', :'kart', 5000, null, current_date - 1, 'Kart ödemesi') as e_odeme \gset
select pg_temp.eq('T5 Banka −5.000',                 (select balance from v_account_balances where id = :'garanti'), 65000);
select pg_temp.eq('T5 Kart borcu −5.000',            (select balance from v_account_balances where id = :'kart'), 0);
select pg_temp.eq('T5 Kullanılabilir limit +5.000',  (select available_limit from v_account_balances where id = :'kart'), 150000);
select pg_temp.eq('T5 EK GİDER OLUŞMADI (Hata 1)',   (select sum(expense) from v_month_summary where currency = 'TRY'), :exp_before);
select pg_temp.eq('T5 Kayıt türü card_payment',      (select case when kind = 'card_payment' then 1 else 0 end from journal_entries where id = :'e_odeme'), 1);

-- ---------- Döviz: 500 USD → TL (kur 34,20) -------------------------------
select record_transfer(:'crdb', :'ziraat', 500, 17100, current_date, 'USD bozdurma') as e_fx \gset
select pg_temp.eq('FX: CRDB 500 USD kaldı', (select balance from v_account_balances where id = :'crdb'), 500);
select pg_temp.eq('FX: Ziraat +17.100 TL',  (select balance from v_account_balances where id = :'ziraat'), 62100);
select pg_temp.eq('FX: tür fx_exchange',    (select case when kind = 'fx_exchange' then 1 else 0 end from journal_entries where id = :'e_fx'), 1);

-- ---------- Alacak: Ali'ye 25.000 ver, 10.000 tahsil et ---------------------
select record_transfer(:'ziraat', :'ali', 25000, null, current_date, 'Ali''ye borç') \gset
select record_transfer(:'ali', :'ziraat', 10000, null, current_date, 'Ali ödedi') \gset
select pg_temp.eq('Alacak: Ali kalan 15.000', (select balance from v_account_balances where id = :'ali'), 15000);
select pg_temp.eq('Alacak tahsilatı gelir sayılmadı',
  (select coalesce(sum(income),0) from v_month_summary where currency = 'TRY' and month = date_trunc('month', current_date)::date),
  (select coalesce(sum(-p.amount),0) from postings p join journal_entries e on e.id = p.entry_id
    join categories c on c.id = p.category_id
   where c.kind = 'income' and p.currency = 'TRY' and date_trunc('month', e.entry_date) = date_trunc('month', current_date)));

-- ---------- İptal = ters kayıt (Hata 5) ------------------------------------
select reverse_entry(:'e_kira', 'Yanlış girildi') \gset
select pg_temp.eq('İptal: Ziraat bakiyesi kira kadar geri geldi', (select balance from v_account_balances where id = :'ziraat'), 52100);
select pg_temp.eq('İptal: orijinal kayıt "reversed"', (select case when status = 'reversed' then 1 else 0 end from journal_entries where id = :'e_kira'), 1);
select pg_temp.must_fail('İptal: ikinci kez iptal engellenir', format('select reverse_entry(%L)', :'e_kira'), 'zaten iptal');

-- ---------- Bütünlük kuralları -------------------------------------------
select pg_temp.must_fail('Negatif tutar',       format('select record_expense(%L, %L, -50)', :'ziraat', :'cat_market'), 'sıfırdan büyük');
select pg_temp.must_fail('Gelecek tarih',       format('select record_expense(%L, %L, 50, current_date + 5)', :'ziraat', :'cat_market'), 'Gelecek tarihli');
select pg_temp.must_fail('Nakit eksiye düşmez', format('select record_expense(%L, %L, 900)', :'cuzdan', :'cat_market'), 'eksiye');
select pg_temp.must_fail('Kart limiti aşılamaz',format('select record_expense(%L, %L, 150000.01)', :'kart', :'cat_giyim'), 'limiti');
select pg_temp.must_fail('Farklı birimde karşılık zorunlu', format('select record_transfer(%L, %L, 10)', :'crdb', :'ziraat'), 'hedef tutar');
select pg_temp.must_fail('Gelir kategorisine gider yazılamaz', format('select record_expense(%L, %L, 10)', :'ziraat', :'cat_maas'), 'gider kategorisi değil');
select pg_temp.must_fail('Defter doğrudan yazılamaz (RLS)',
  format('insert into journal_entries (user_id, entry_date, kind) values (%L, current_date, %L)', '11111111-1111-1111-1111-111111111111', 'income'), 'row-level security');
select count(*) as n_post from postings \gset
delete from postings;          -- RLS'te silme politikası yok → 0 satır etkilenir
update postings set amount = 1; -- aynı şekilde güncelleme de etkisiz
select pg_temp.eq('Defter satırı silinemez/değiştirilemez', (select count(*) from postings), :n_post);
reset role;
select pg_temp.must_fail('Yönetici bile defter satırını silemez (trigger)', 'delete from postings', 'değiştirilemez veya silinemez');
set role authenticated;
select pg_temp.must_fail('Hesap para birimi istemciden değişmez', format('update accounts set currency = %L where id = %L', 'USD', :'ziraat'), 'permission denied');

-- ---------- Mutabakat: bankada gerçekte 52.000 var --------------------------
select adjust_balance(:'ziraat', 52000, current_date, 'Ekstre mutabakatı') \gset
select pg_temp.eq('Düzeltme: Ziraat 52.000', (select balance from v_account_balances where id = :'ziraat'), 52000);

-- ---------- Bölünmüş gider --------------------------------------------------
select record_split_expense(:'kart', format('[{"category_id":"%s","amount":300},{"category_id":"%s","amount":1200}]', :'cat_market', :'cat_giyim')::jsonb, current_date, 'AVM') as e_split \gset
select pg_temp.eq('Bölünmüş gider: kart borcu 1.500', (select balance from v_account_balances where id = :'kart'), 1500);
select pg_temp.eq('Manşet tutar 1.500', (select amount from v_entries where id = :'e_split'), 1500);

-- ---------- Denge: her kayıt her birimde 0 ----------------------------------
select pg_temp.eq('Tüm kayıtlar dengeli', (select count(*) from (
  select entry_id, currency from postings group by 1,2 having sum(amount) <> 0) x), 0);

-- ---------- Net varlık geçmişi çalışıyor ------------------------------------
select pg_temp.eq('Net varlık geçmişi (TRY, bu ay) = anlık net varlık',
  (select net_worth from net_worth_history(1) where currency = 'TRY'),
  (select net_worth from v_net_position where currency = 'TRY'));

-- ---------- RLS: başka kullanıcı hiçbir şey görmez --------------------------
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select pg_temp.eq('RLS: 2. kullanıcı 1.nin hesaplarını görmez', (select count(*) from v_account_balances), 0);
select pg_temp.eq('RLS: 2. kullanıcı 1.nin kayıtlarını görmez', (select count(*) from v_entries), 0);
select pg_temp.must_fail('RLS: başkasının hesabına işlem yapılamaz',
  format('select record_expense(%L, (select id from categories where name = %L), 10)', :'ziraat', 'Market'), 'Hesap bulunamadı');
select pg_temp.must_fail('RLS: başkasının kaydı iptal edilemez', format('select reverse_entry(%L)', :'e_maas'), 'Kayıt bulunamadı');

select '— TÜM TESTLER GEÇTİ —';
