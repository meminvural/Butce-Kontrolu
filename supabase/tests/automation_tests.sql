-- Otomasyon: faiz kademesi · otomatik asgari · borç planı · otomatik ödeme · toplu içe aktarma
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

insert into auth.users (id, email) values ('cccccccc-cccc-cccc-cccc-cccccccccccc','oto@test'), ('dddddddd-dddd-dddd-dddd-dddddddddddd','oto2@test');
set role authenticated;
select set_config('request.jwt.claim.sub','cccccccc-cccc-cccc-cccc-cccccccccccc',false);
select id as market from categories where name = 'Market' \gset
select id as maas from categories where kind = 'income' limit 1 \gset

select create_account('Banka','bank','TRY',50000,current_date - 120,'Ziraat') as banka \gset
select create_account('Banka USD','bank','USD',100,current_date - 120,'Ziraat') as bankausd \gset
select create_account('Kart','credit_card','TRY',0,current_date - 120,'Akbank',null,100000,15,25,'1111') as kart \gset

-- ============ Faiz kademeleri (varsayılan) ============
reset role;
select pg_temp.eq('Varsayılan kademe: 10.000 TL → akdi 3,25', (select purchase_rate from _rate_tier('cccccccc-cccc-cccc-cccc-cccccccccccc', 10000)), 3.25);
select pg_temp.eq('Varsayılan kademe: 10.000 TL → gecikme 3,55', (select late_rate from _rate_tier('cccccccc-cccc-cccc-cccc-cccccccccccc', 10000)), 3.55);
select pg_temp.eq('Varsayılan kademe: 100.000 TL → akdi 3,75', (select purchase_rate from _rate_tier('cccccccc-cccc-cccc-cccc-cccccccccccc', 100000)), 3.75);
select pg_temp.eq('Varsayılan kademe: 500.000 TL → akdi 4,25', (select purchase_rate from _rate_tier('cccccccc-cccc-cccc-cccc-cccccccccccc', 500000)), 4.25);
set role authenticated;
select set_config('request.jwt.claim.sub','cccccccc-cccc-cccc-cccc-cccccccccccc',false);
insert into card_rate_tiers (upto, purchase_rate, late_rate) values (5000, 2.00, 2.50), (1e9, 5.00, 6.00);
reset role;
select pg_temp.eq('Kullanıcı kademesi öncelikli: 4.000 TL → 2,00', (select purchase_rate from _rate_tier('cccccccc-cccc-cccc-cccc-cccccccccccc', 4000)), 2.00);
select pg_temp.eq('Kullanıcı kademesi: 9.000 TL → 5,00', (select purchase_rate from _rate_tier('cccccccc-cccc-cccc-cccc-cccccccccccc', 9000)), 5.00);
set role authenticated;
select set_config('request.jwt.claim.sub','cccccccc-cccc-cccc-cccc-cccccccccccc',false);
delete from card_rate_tiers;

-- ============ Otomatik asgari ödeme oranı ============
select set_card_automation(:'kart', '{"min_payment_auto": true}');
select pg_temp.eq('Limit 100.000 (> 50.000) → otomatik %40', (select min_payment_pct from credit_card_details where account_id = :'kart'), 40);
select update_account(:'kart', '{"credit_limit": 30000}');
select pg_temp.eq('Limit 30.000 düşünce oran otomatik %20', (select min_payment_pct from credit_card_details where account_id = :'kart'), 20);
update profiles set min_rule_limit = 20000, min_rule_low = 10, min_rule_high = 30 where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
select pg_temp.eq('Kural değişti: etkilenen kart sayısı', apply_min_payment_rule(), 1);
select pg_temp.eq('Yeni kural: 30.000 > 20.000 → %30', (select min_payment_pct from credit_card_details where account_id = :'kart'), 30);
select set_card_automation(:'kart', '{"min_payment_auto": false, "min_payment_pct": 25}');
select pg_temp.eq('Otomatik kapatılıp elle %25 girildi', (select min_payment_pct from credit_card_details where account_id = :'kart'), 25);
update profiles set min_rule_limit = 50000, min_rule_low = 20, min_rule_high = 40 where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
select update_account(:'kart', '{"credit_limit": 100000}');
select pg_temp.eq('Otomatik kapalıyken limit oranı değiştirmez', (select min_payment_pct from credit_card_details where account_id = :'kart'), 25);
select set_card_automation(:'kart', '{"min_payment_auto": false, "min_payment_pct": 20}');

-- ============ Borç planı ============
select cut_date as lastcut from card_statements(:'kart', 3) where not is_current order by cut_date desc limit 1 \gset
select record_expense(:'kart', :'market', 1000, :'lastcut'::date - 5, 'Geçen dönem alışverişi') \gset
select pg_temp.eq('Borç planı: ekstre tutarı 1.000', (select statement_amount from card_debt_plan() where account_id = :'kart'), 1000);
select pg_temp.eq('Borç planı: asgari %20 = 200', (select min_payment from card_debt_plan() where account_id = :'kart'), 200);
select pg_temp.eq('Borç planı: akdi oran 3,25 (30.000 altı)', (select purchase_rate from card_debt_plan() where account_id = :'kart'), 3.25);
select pg_temp.eq('Asgariyi ödersem tahmini faiz = 800 × %3,25 = 26,00', (select est_interest_min from card_debt_plan() where account_id = :'kart'), 26.00);
select pg_temp.eq('Hiç ödemezsem = 200 × %3,55 + 800 × %3,25 = 33,10', (select est_interest_none from card_debt_plan() where account_id = :'kart'), 33.10);
select pg_temp.eq('Güncel borç 1.000', (select debt from card_debt_plan() where account_id = :'kart'), 1000);

-- ============ Otomatik ödeme: onay modu ============
select pg_temp.must_fail('Kaynak hesap olmadan otomatik ödeme açılamaz', format('select set_card_automation(%L, ''{"autopay_mode":"min"}'')', :'kart'), 'kaynak hesap');
select pg_temp.must_fail('Farklı para birimli kaynak reddedilir', format('select set_card_automation(%L, jsonb_build_object(''autopay_mode'',''min'',''autopay_account_id'',%L))', :'kart', :'bankausd'), 'para birimi');
select pg_temp.must_fail('Sabit mod tutarsız olmaz', format('select set_card_automation(%L, jsonb_build_object(''autopay_mode'',''fixed'',''autopay_account_id'',%L))', :'kart', :'banka'), 'Sabit tutar');
select set_card_automation(:'kart', jsonb_build_object('autopay_mode','min','autopay_account_id', :'banka', 'autopay_record','confirm', 'autopay_days_before', 30));
select pg_temp.eq('Bekleyen otomatik ödeme: asgari 200', (select amount from autopay_pending() where account_id = :'kart'), 200);
select pg_temp.eqt('Onay modunda kendiliğinden kaydedilmez', (process_autopay())->>'recorded', '0');
select apply_autopay(:'kart') \gset
select pg_temp.eq('Onay sonrası banka 50.000 − 200', (select balance from v_account_balances where id = :'banka'), 49800);
select pg_temp.eq('Kart borcu 1.000 − 200', (select balance from v_account_balances where id = :'kart'), 800);
select pg_temp.eq('Aynı ekstre için ikinci bekleyen yok', (select count(*) from autopay_pending()), 0);
select pg_temp.must_fail('Bekleyen yokken uygulanamaz', format('select apply_autopay(%L)', :'kart'), 'bekleyen');

-- ============ Otomatik kaydet ============
select set_card_automation(:'kart', jsonb_build_object('autopay_mode','full','autopay_record','auto'));
select pg_temp.eq('Tamamı modu: kalan 800 bekliyor', (select amount from autopay_pending() where account_id = :'kart'), 800);
select pg_temp.eqt('Otomatik kayıt: 1 ödeme yapıldı', (process_autopay())->>'recorded', '1');
select pg_temp.eq('Otomatik kayıt sonrası kart borcu 0', (select balance from v_account_balances where id = :'kart'), 0);
select pg_temp.eqt('Tekrar çalıştırmak çift ödeme yapmaz', (process_autopay())->>'recorded', '0');
select pg_temp.eq('Banka 49.800 − 800', (select balance from v_account_balances where id = :'banka'), 49000);
select pg_temp.eqt('Kart ekstresi ödendi görünüyor', (select status from card_statements(:'kart', 3) where not is_current order by cut_date desc limit 1), 'paid');

-- sabit tutar
select record_expense(:'kart', :'market', 500, current_date - 1, 'Yeni') \gset
select pg_temp.eq('Yeni dönem harcaması ekstreye girmedi: bekleyen yok', (select count(*) from autopay_pending()), 0);

-- ============ Toplu içe aktarma ============
select create_account('Nakit','cash','TRY',0,current_date - 120) as nakit \gset
select import_transactions(jsonb_build_object('rows', jsonb_build_array(
  jsonb_build_object('key','k1','kind','expense','date',current_date-10,'account_id',:'banka','category_id',:'market','amount',120.50,'description','Market'),
  jsonb_build_object('key','k2','kind','income','date',current_date-9,'account_id',:'banka','category_id',:'maas','amount',3000,'description','Maaş'),
  jsonb_build_object('key','k3','kind','transfer','date',current_date-8,'account_id',:'banka','to_account_id',:'nakit','amount',500),
  jsonb_build_object('key','k4','kind','expense','date',current_date-60,'account_id',:'kart','category_id',:'market','amount',1200,'purchase_amount',1200,'installments',4,'description','Telefon'),
  jsonb_build_object('key','k5','kind','payment','date',current_date-5,'account_id',:'kart','source_account_id',:'banka','amount',100,'description','Kart ödemesi'),
  jsonb_build_object('key','k6','kind','payment','date',current_date-4,'account_id',:'kart','amount',50,'description','Kaynaksız ödeme'),
  jsonb_build_object('key','k7','kind','refund','date',current_date-3,'account_id',:'kart','amount',25,'description','İade'),
  jsonb_build_object('key','k8','kind','expense','date',current_date-3,'account_id',gen_random_uuid(),'category_id',:'market','amount',10),
  jsonb_build_object('key','k9','kind','expense','date',current_date-3,'account_id',:'banka','category_id',:'market','amount',0)
))) as r1 \gset
select pg_temp.eqt('İçe aktarma: 7 satır eklendi', (:'r1'::jsonb)->>'added', '7');
select pg_temp.eq('İçe aktarma: 2 satır hatalı raporlandı', jsonb_array_length((:'r1'::jsonb)->'failed'), 2);
select pg_temp.eqt('Hatalı satırlar 8. ve 9.', ((:'r1'::jsonb)->'failed'->0->>'row') || ',' || ((:'r1'::jsonb)->'failed'->1->>'row'), '8,9');
select pg_temp.eq('Nakit hesaba 500 aktarıldı', (select balance from v_account_balances where id = :'nakit'), 500);
select pg_temp.eq('Taksit planı: 4 dilim', (select count(*) from card_installment_slices(:'kart')), 4);
select pg_temp.eq('Kart: 500 + 1.200 taksit − 100 − 50 − 25 = 1.525', (select balance from v_account_balances where id = :'kart'), 1525);
-- aynı dosya tekrar yüklenirse çift kayıt olmaz
select import_transactions(jsonb_build_object('rows', jsonb_build_array(
  jsonb_build_object('key','k1','kind','expense','date',current_date-10,'account_id',:'banka','category_id',:'market','amount',120.50),
  jsonb_build_object('key','k2','kind','income','date',current_date-9,'account_id',:'banka','category_id',:'maas','amount',3000)))) as r2 \gset
select pg_temp.eqt('Tekrar yükleme: 0 yeni', (:'r2'::jsonb)->>'added', '0');
select pg_temp.eqt('Tekrar yükleme: 2 mevcut atlandı', (:'r2'::jsonb)->>'existing', '2');
select import_transactions(jsonb_build_object('rows', jsonb_build_array(
  jsonb_build_object('key','k10','kind','payment','date',current_date-3,'account_id',:'banka','amount',10)))) as r3 \gset
select pg_temp.eq('Banka hesabına kart ödemesi reddedilir', jsonb_array_length((:'r3'::jsonb)->'failed'), 1);
select pg_temp.eq('Tüm kayıtlar dengeli', (select count(*) from (select entry_id, currency from postings group by 1, 2 having sum(amount) <> 0) x), 0);


-- ============ Devreden borç (carry) ============
select create_account('Kart2','credit_card','TRY',0,current_date - 120,'Akbank',null,100000,15,25,'2222') as kart2 \gset
select balance as banka0 from v_account_balances where id = :'banka' \gset
select coalesce(sum(expense), 0) as exp0 from v_month_summary where currency = 'TRY' \gset
select import_transactions(jsonb_build_object('rows', jsonb_build_array(
  jsonb_build_object('key','c1','kind','carry','date',current_date-100,'account_id',:'kart2','amount',5000,'description','DEVREDEN'),
  jsonb_build_object('key','c2','kind','carry','date',current_date-40,'account_id',:'kart2','amount',700,'description','DEVREDEN 2'),
  jsonb_build_object('key','c3','kind','carry','date',current_date-40,'account_id',:'banka','amount',300,'description','Devreden bakiye')))) as rc \gset
select pg_temp.eqt('Devreden: 3 satır eklendi', (:'rc'::jsonb)->>'added', '3');
select pg_temp.eq('Kart borcu 5.000 + 700 (gider değil, devreden)', (select balance from v_account_balances where id = :'kart2'), 5700);
select pg_temp.eq('Banka devreden 300 bakiyeye eklendi', (select balance from v_account_balances where id = :'banka'), :banka0 + 300);
select pg_temp.eq('Devreden satırları gider toplamını DEĞİŞTİRMEDİ', (select coalesce(sum(expense), 0) from v_month_summary where currency = 'TRY'), :exp0);
select pg_temp.eqt('Devreden tekrar yüklenince çift kayıt olmaz', (import_transactions(jsonb_build_object('rows', jsonb_build_array(
  jsonb_build_object('key','c1','kind','carry','date',current_date-100,'account_id',:'kart2','amount',5000)))))->>'existing', '1');

-- ============ İZOLASYON ve YETKİ ============
select set_config('request.jwt.claim.sub','dddddddd-dddd-dddd-dddd-dddddddddddd',false);
select pg_temp.eq('Başkası borç planında bizim kartı görmez', (select count(*) from card_debt_plan()), 0);
select pg_temp.must_fail('Başkasının kartına otomasyon yazılamaz', format('select set_card_automation(%L, ''{"min_payment_auto": true}'')', :'kart'), 'bulunamadı');
select import_transactions(jsonb_build_object('rows', jsonb_build_array(
  jsonb_build_object('key','z1','kind','expense','date',current_date-3,'account_id',:'banka','category_id',:'market','amount',5)))) as r4 \gset
select pg_temp.eq('Başkasının hesabına içe aktarma reddedilir', jsonb_array_length((:'r4'::jsonb)->'failed'), 1);
reset role;
select pg_temp.eqt('Anonim import_transactions çağıramaz', has_function_privilege('anon', 'import_transactions(jsonb)', 'execute')::text, 'false');
select pg_temp.eqt('Anonim rate_tier_for çağıramaz', has_function_privilege('anon', 'rate_tier_for(numeric)', 'execute')::text, 'false');
select pg_temp.eqt('Anonim process_autopay çağıramaz', has_function_privilege('anon', 'process_autopay()', 'execute')::text, 'false');
select pg_temp.eqt('Kullanıcı run_autopay_all çağıramaz', has_function_privilege('authenticated', 'run_autopay_all()', 'execute')::text, 'false');
select pg_temp.eq('Zamanlanmış görev: kayıtlı olmayan kullanıcı için 0', run_autopay_all(), 0);
select '— OTOMASYON TESTLERİ GEÇTİ —';
