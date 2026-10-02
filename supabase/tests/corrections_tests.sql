-- Düzeltme araçları: amend_entry · update_account · set_opening_balance
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.eq(l text, a numeric, x numeric) returns text language plpgsql as $$
begin if a is distinct from x then raise exception 'BAŞARISIZ: % → beklenen %, gelen %', l, x, a; end if; return '✓ ' || l; end $$;
create or replace function pg_temp.eqt(l text, a text, x text) returns text language plpgsql as $$
begin if a is distinct from x then raise exception 'BAŞARISIZ: % → beklenen %, gelen %', l, x, a; end if; return '✓ ' || l; end $$;
create or replace function pg_temp.must_fail(l text, q text, pat text) returns text language plpgsql as $$
begin
  begin execute q; exception when others then
    if sqlerrm ilike '%' || pat || '%' then return '✓ ' || l || '  (engellendi: ' || sqlerrm || ')'; end if;
    raise exception 'BAŞARISIZ: % → beklenmeyen hata: %', l, sqlerrm;
  end;
  raise exception 'BAŞARISIZ: % → hata bekleniyordu', l;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

insert into auth.users (id, email) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dz@test'), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','dz2@test');
set role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',false);
select id as market from categories where name = 'Market' \gset
select id as kira from categories where kind = 'expense' and name <> 'Market' and parent_id is null limit 1 \gset
select id as maas from categories where kind = 'income' limit 1 \gset

select create_account('Banka','bank','TRY',10000,current_date - 30,'Ziraat') as banka \gset
select create_account('Banka2','bank','TRY',0,current_date - 30,'Ziraat') as banka2 \gset
select create_account('Kart','credit_card','TRY',0,current_date - 30,'Akbank',null,50000,10,20,'1111') as kart \gset

-- ============ amend_entry: gider ============
select record_expense(:'banka', :'market', 100, current_date - 5, 'Migros') as e1 \gset
select amend_entry(:'e1', jsonb_build_object('amount', 150, 'date', current_date - 3, 'category_id', :'kira', 'description', 'Düzeltildi')) as e1n \gset
select pg_temp.eq('Gider tutarı düzeltildi: banka 10.000 − 150', (select balance from v_account_balances where id = :'banka'), 9850);
select pg_temp.eqt('Eski kayıt iptal edildi', (select status::text from journal_entries where id = :'e1'), 'reversed');
select pg_temp.eqt('Yeni kayıt geçerli, açıklama ve tarih yeni', (select status::text || '|' || description || '|' || (entry_date = current_date - 3)::text from journal_entries where id = :'e1n'), 'posted|Düzeltildi|true');
select pg_temp.eq('Kategori değişti', (select count(*) from postings where entry_id = :'e1n' and category_id = :'kira'), 1);
-- hesap değiştir
select amend_entry(:'e1n', jsonb_build_object('account_id', :'banka2')) as e1m \gset
select pg_temp.eq('Hesap değişti: Banka2 −150', (select balance from v_account_balances where id = :'banka2'), -150);
select pg_temp.eq('Hesap değişti: Banka eski haline', (select balance from v_account_balances where id = :'banka'), 10000);
select pg_temp.must_fail('İptal edilmiş kayıt düzenlenemez', format('select amend_entry(%L, ''{"amount":1}'')', :'e1'), 'geçerli');
select pg_temp.must_fail('Sıfır tutar reddedilir', format('select amend_entry(%L, ''{"amount":0}'')', :'e1m'), 'sıfırdan büyük');

-- ============ gelir ============
select record_income(:'banka', :'maas', 500, current_date - 2, 'Maaş') as g1 \gset
select amend_entry(:'g1', '{"amount": 800}') as g1n \gset
select pg_temp.eq('Gelir düzeltildi: banka 10.800', (select balance from v_account_balances where id = :'banka'), 10800);

-- ============ kart harcaması ============
select record_expense(:'kart', :'market', 200, current_date - 4, 'Kartla') as k1 \gset
select amend_entry(:'k1', '{"amount": 250}') as k1n \gset
select pg_temp.eq('Kart harcaması düzeltildi: borç 250', (select balance from v_account_balances where id = :'kart'), 250);

-- ============ transfer / kart ödemesi ============
select record_transfer(:'banka', :'banka2', 300, null, current_date - 1, 'Aktarım') as t1 \gset
select amend_entry(:'t1', '{"amount": 400}') as t1n \gset
select pg_temp.eq('Transfer düzeltildi: Banka 10.400', (select balance from v_account_balances where id = :'banka'), 10400);
select pg_temp.eq('Transfer düzeltildi: Banka2 −150 + 400', (select balance from v_account_balances where id = :'banka2'), 250);
select record_transfer(:'banka', :'kart', 100, null, current_date - 1, 'Kart ödemesi') as p1 \gset
select amend_entry(:'p1', '{"amount": 120}') as p1n \gset
select pg_temp.eq('Kart ödemesi düzeltildi: kart borcu 250 − 120', (select balance from v_account_balances where id = :'kart'), 130);

-- ============ reddedilenler ============
select record_expense(:'banka', :'market', 10, current_date - 1, 'Anahtarlı', 'st:abc:1') as s1 \gset
select pg_temp.must_fail('Ekstreden gelen kayıt bu yoldan düzenlenemez', format('select amend_entry(%L, ''{"amount":1}'')', :'s1'), 'ekstreden');
select record_expense(:'kart', :'market', 600, current_date - 20, 'Taksitli', null, 3) as ti \gset
select pg_temp.must_fail('Taksitli alışveriş düzenlenemez', format('select amend_entry(%L, ''{"amount":1}'')', :'ti'), 'Taksitli');
select pg_temp.must_fail('Açılış kaydı bu yoldan düzenlenemez', format('select amend_entry((select id from journal_entries where kind = ''opening_balance'' and status = ''posted'' limit 1), ''{"amount":1}'')'), 'düzenlenemez');

-- ============ update_account ============
select update_account(:'kart', '{"name":"Akbank Axess","institution_name":"Akbank Bankası","credit_limit":75000,"statement_day":7,"due_day":17,"min_payment_pct":40,"iban_last4":"3661"}');
select pg_temp.eqt('Kart adı/kurum/son4 düzeldi', (select name || '|' || institution_name || '|' || iban_last4 from v_account_balances where id = :'kart'), 'Akbank Axess|Akbank Bankası|3661');
select pg_temp.eq('Kart limiti düzeldi', (select credit_limit from v_account_balances where id = :'kart'), 75000);
select pg_temp.eqt('Kesim/son ödeme/asgari düzeldi', (select statement_day || '|' || due_day || '|' || min_payment_pct from credit_card_details where account_id = :'kart'), '7|17|40.00');
select update_account(:'banka', '{"credit_limit":999}');
select pg_temp.eq('Banka hesabına limit yazılmaz', (select count(*) from accounts where id = :'banka' and credit_limit is not null), 0);
select pg_temp.must_fail('Geçersiz kesim günü', format('select update_account(%L, ''{"statement_day":40}'')', :'kart'), 'check');
select pg_temp.must_fail('Aynı adlı ikinci hesap olamaz', format('select update_account(%L, ''{"name":"Banka"}'')', :'banka2'), 'duplicate');

-- ============ set_opening_balance ============
select set_opening_balance(:'kart', 1000, current_date - 40) as o1 \gset
select pg_temp.eq('Kart devreden borç 1000 eklendi: 730 + 1000', (select balance from v_account_balances where id = :'kart'), 1730);
select set_opening_balance(:'kart', 700) as o2 \gset
select pg_temp.eq('Devreden borç 700’e düzeltildi', (select balance from v_account_balances where id = :'kart'), 1430);
select pg_temp.eqt('Eski açılış kaydı iptal edildi', (select status::text from journal_entries where id = :'o1'), 'reversed');
select set_opening_balance(:'banka', 12000);
select pg_temp.eq('Banka açılışı 10.000 → 12.000', (select balance from v_account_balances where id = :'banka'), 12270);
select set_opening_balance(:'kart', 0);
select pg_temp.eq('Açılış 0: kart borcu yalnız hareketler', (select balance from v_account_balances where id = :'kart'), 730);
select pg_temp.must_fail('Eksi açılış reddedilir', format('select set_opening_balance(%L, -5)', :'kart'), 'eksi');
select pg_temp.eq('Tüm kayıtlar dengeli', (select count(*) from (select entry_id, currency from postings group by 1, 2 having sum(amount) <> 0) x), 0);

-- ============ İZOLASYON ve YETKİ ============
select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',false);
select pg_temp.must_fail('Başkasının kaydı düzenlenemez', format('select amend_entry(%L, ''{"amount":1}'')', :'g1n'), 'bulunamadı');
select pg_temp.must_fail('Başkasının hesabı düzenlenemez', format('select update_account(%L, ''{"name":"x"}'')', :'banka'), 'bulunamadı');
select pg_temp.must_fail('Başkasının açılışı düzenlenemez', format('select set_opening_balance(%L, 5)', :'banka'), 'bulunamadı');
reset role;
select pg_temp.eqt('Anonim amend_entry çağıramaz', has_function_privilege('anon', 'amend_entry(uuid,jsonb)', 'execute')::text, 'false');
select pg_temp.eqt('Anonim update_account çağıramaz', has_function_privilege('anon', 'update_account(uuid,jsonb)', 'execute')::text, 'false');
select pg_temp.eqt('Anonim set_opening_balance çağıramaz', has_function_privilege('anon', 'set_opening_balance(uuid,numeric,date)', 'execute')::text, 'false');
select '— DÜZELTME TESTLERİ GEÇTİ —';
