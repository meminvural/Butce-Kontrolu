-- =====================================================================
--  Faz 2–6 testleri: kart taksit/ekstre, kredi, borç planı, düzenli işlem,
--  bütçe, nakit akışı kaynağı, bildirim, kur. (ledger_tests.sql'den sonra)
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
create or replace function pg_temp.must_fail(p_label text, p_sql text, p_pattern text)
returns text language plpgsql as $$
begin
  begin
    execute p_sql;
    set constraints all immediate;
    set constraints all deferred;
  exception when others then
    set constraints all deferred;
    if sqlerrm ilike '%' || p_pattern || '%' then return '✓ ' || p_label || '  (engellendi: ' || sqlerrm || ')'; end if;
    raise exception 'BAŞARISIZ: % → beklenmeyen hata: %', p_label, sqlerrm;
  end;
  raise exception 'BAŞARISIZ: % → hata bekleniyordu', p_label;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'faz@test');
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

select id as cat_market from categories where name = 'Market' \gset
select id as cat_gida   from categories where name = 'Gıda'   \gset
select id as cat_elek   from categories where name = 'Elektronik' \gset
select id as cat_maas   from categories where name = 'Maaş'   \gset
select id as cat_faiz   from categories where system_key = 'loan_interest' \gset

select create_account('Banka', 'bank', 'TRY', 500000, current_date - 120, 'Ziraat') as bank \gset
select create_account('Kart',  'credit_card', 'TRY', 0, current_date - 120, 'Garanti', null, 100000, 5, 15) as kart \gset

-- =========== FAZ 2a: TAKSİTLİ KART HARCAMASI + EKSTRE =====================
select record_expense(:'kart', :'cat_elek', 6000, current_date - 40, 'Telefon', null, 3) as e_tel \gset
select record_expense(:'kart', :'cat_market', 1000, current_date - 40, 'Market') \gset
select pg_temp.eq('Taksitli: limit TAM tutar kadar bloke (100.000 − 7.000)',
  (select available_limit from v_account_balances where id = :'kart'), 93000);
select pg_temp.eq('Taksitli: gider alışveriş günü TAM tutar',
  (select sum(total) from v_category_monthly where category_id = :'cat_elek'), 6000);
select pg_temp.eq('Taksitli: 3 dilim, toplam 6.000',
  (select count(*) * 10000 + sum(amount) from card_installment_slices(:'kart')), 36000);
select _next_cut(current_date - 40, 5) as c1 \gset
select pg_temp.eq('İlk ekstre = tek çekim 1.000 + 1. taksit 2.000',
  (select statement_amount from card_statements(:'kart', 6) where cut_date = :'c1'), 3000);
select pg_temp.eq('İlk ekstre asgari (%20)',
  (select min_payment from card_statements(:'kart', 6) where cut_date = :'c1'), 600);
select pg_temp.must_fail('Banka hesabında taksit olmaz',
  format('select record_expense(%L, %L, 100, null, null, null, 3)', :'bank', :'cat_market'), 'yalnızca kredi kartı');

select pg_temp.eq('Yaklaşan kart ödemeleri toplamı = kart borcu (7.000)',
  (select sum(amount) from upcoming_items(150) where source_type = 'card_statement'), 7000);

select record_transfer(:'bank', :'kart', 3000, null, (:'c1'::date + 1), 'Ekstre ödemesi') \gset
select pg_temp.eq('Ekstre ödendi → kalan 0', (select remaining from card_statements(:'kart', 6) where cut_date = :'c1'), 0);
select pg_temp.eq('Ekstre durumu "paid"', (select case when status = 'paid' then 1 else 0 end from card_statements(:'kart', 6) where cut_date = :'c1'), 1);
select pg_temp.eq('Kart ödemesinden sonra yaklaşan kart ödemeleri = 4.000',
  (select sum(amount) from upcoming_items(150) where source_type = 'card_statement'), 4000);
select pg_temp.eq('card_overview çalışıyor, borç 4.000', (select owed from card_overview() where account_id = :'kart'), 4000);

-- İptal edilen taksitli alışveriş taksit planından da düşer
select reverse_entry(:'e_tel') \gset
select pg_temp.eq('İptal edilen taksitli alışveriş dilimleri kalktı', (select count(*) from card_installment_slices(:'kart')), 0);

-- =========== FAZ 2b: BANKA KREDİSİ (Test 6) ===============================
select create_loan('İhtiyaç Kredisi', 'Ziraat', 'TRY', 120000, 3, 12, current_date + 5, 0, :'bank', current_date - 1) as loan \gset
select pg_temp.eq('Kredi kullanımı: banka +120.000', (select balance from v_account_balances where id = :'bank'), 500000 - 3000 + 120000);
select pg_temp.eq('Kredi borcu 120.000', (select balance from v_account_balances where id = :'loan'), 120000);
select pg_temp.eq('Amortisman: 12 taksit', (select count(*) from loan_installments where account_id = :'loan'), 12);
select pg_temp.eq('Amortisman: anapara toplamı = 120.000', (select sum(principal) from loan_installments where account_id = :'loan'), 120000);
select pg_temp.eq('Amortisman: son taksit sonrası kalan 0', (select remaining from loan_installments where account_id = :'loan' and installment_no = 12), 0);
select pg_temp.eq('Annüite taksit (120.000, %3, 12 ay) = 12.055,45',
  (select payment_amount from loan_details where account_id = :'loan'), 12055.45);
select pg_temp.eq('1. taksit faizi = 3.600', (select interest from loan_installments where account_id = :'loan' and installment_no = 1), 3600);

select id as li1 from loan_installments where account_id = :'loan' and installment_no = 1 \gset
select id as li3 from loan_installments where account_id = :'loan' and installment_no = 3 \gset
select pg_temp.must_fail('Taksit sırası atlanamaz', format('select pay_loan_installment(%L, %L)', :'li3', :'bank'), 'Önce 1.');

select coalesce(sum(expense), 0) as exp0 from v_month_summary where currency = 'TRY' and month = date_trunc('month', current_date)::date \gset
select pay_loan_installment(:'li1', :'bank') as e_li1 \gset
select pg_temp.eq('T6 Kredi borcu anapara kadar azaldı (−8.455,45)', (select balance from v_account_balances where id = :'loan'), 120000 - 8455.45);
select pg_temp.eq('T6 Gidere SADECE faiz yazıldı (+3.600)',
  (select coalesce(sum(expense), 0) from v_month_summary where currency = 'TRY' and month = date_trunc('month', current_date)::date), :exp0 + 3600);
select pg_temp.eq('T6 Faiz "Kredi Faizi" kategorisinde',
  (select sum(total) from v_category_monthly where category_id = :'cat_faiz'), 3600);
select pg_temp.eq('v_loans: sonraki taksit no 2', (select next_no from v_loans where id = :'loan'), 2);
select pg_temp.must_fail('Aynı taksit iki kez ödenemez', format('select pay_loan_installment(%L, %L)', :'li1', :'bank'), 'zaten ödenmiş');
select reverse_entry(:'e_li1') \gset
select pg_temp.eq('Taksit ödemesi iptal → taksit yeniden ödenebilir', (select next_no from v_loans where id = :'loan'), 1);
select pg_temp.eq('Taksit ödemesi iptal → kredi borcu 120.000', (select balance from v_account_balances where id = :'loan'), 120000);

-- Mevcut (yarısı ödenmiş) kredi
select create_loan('Taşıt Kredisi', 'Garanti', 'TRY', 60000, 2, 12, current_date - 120, 0, null, null, 4) as loan2 \gset
select pg_temp.eq('Mevcut kredi: açılış borcu = 4. taksit sonrası kalan',
  (select balance from v_account_balances where id = :'loan2'),
  (select remaining from loan_installments where account_id = :'loan2' and installment_no = 4));
select pg_temp.eq('Mevcut kredi: 4 taksit ödenmiş sayıldı', (select paid_count from v_loans where id = :'loan2'), 4);
select pg_temp.eq('Mevcut kredi: sıradaki taksit 5.',
  (select next_no from v_loans where id = :'loan2'), 5);

-- =========== FAZ 2c: KİŞİSEL BORÇ TAKSİT PLANI =============================
select create_account('Veli', 'payable', 'TRY', 10000, current_date - 5, null, 'Veli') as veli \gset
select pg_temp.eq('Borç planı: 4 taksit', create_installment_plan(:'veli', 10000, 4, current_date + 10, 'Veli borcu'), 4);
select id as sch1 from scheduled_items where account_id = :'veli' order by due_date limit 1 \gset
select coalesce(sum(expense), 0) as exp1 from v_month_summary where currency = 'TRY' and month = date_trunc('month', current_date)::date \gset
select realize_scheduled_item(:'sch1', :'bank') \gset
select pg_temp.eq('Borç taksiti ödendi: kalan borç 7.500', (select balance from v_account_balances where id = :'veli'), 7500);
select pg_temp.eq('Borç ödemesi gider sayılmadı',
  (select coalesce(sum(expense), 0) from v_month_summary where currency = 'TRY' and month = date_trunc('month', current_date)::date), :exp1);
select pg_temp.must_fail('Planlı kalem iki kez işlenemez', format('select realize_scheduled_item(%L, %L)', :'sch1', :'bank'), 'zaten işlenmiş');

-- =========== FAZ 5: DÜZENLİ İŞLEMLER ======================================
insert into recurring_rules (name, direction, amount, currency, account_id, category_id, frequency, day_of_month, start_date)
values ('Maaş', 'in', 95000, 'TRY', :'bank', :'cat_maas', 'monthly', 1, current_date) returning id as rule \gset
select pg_temp.eq('Düzenli: 90 gün için 3 maaş planlandı', materialize_recurring(90), 3);
select pg_temp.eq('Düzenli: tekrar çalıştırmak çift kalem üretmez', materialize_recurring(90), 0);
update recurring_rules set amount = 100000 where id = :'rule';
select pg_temp.eq('Kural güncellenince bekleyenler temizlendi', (select count(*) from scheduled_items where source_id = :'rule'), 0);
select pg_temp.eq('Yeniden üretildi (yeni tutarla)', materialize_recurring(90), 3);
select pg_temp.eq('Yeni tutar 100.000', (select max(amount) from scheduled_items where source_id = :'rule'), 100000);
select pg_temp.must_fail('Kategorisiz gelir kuralı reddedilir',
  format('insert into recurring_rules (name, direction, amount, currency, account_id, frequency, start_date) values (%L, %L, 1, %L, %L, %L, current_date)',
         'x', 'in', 'TRY', :'bank', 'monthly'), 'kategori zorunlu');

-- =========== FAZ 3: BÜTÇE =================================================
insert into budgets (period, category_id, amount, currency) values (date_trunc('month', current_date), :'cat_gida', 1000, 'TRY');
select record_expense(:'bank', :'cat_market', 950, current_date, 'Market') \gset
select pg_temp.eq('Bütçe: ana kategori alt kategorileri kapsar (%95)',
  (select pct from budget_status(current_date) where category_id = :'cat_gida'), 95);
select pg_temp.eq('Bütçe seviyesi "critical"',
  (select case when level = 'critical' then 1 else 0 end from budget_status(current_date) where category_id = :'cat_gida'), 1);
select record_expense(:'bank', :'cat_market', 100, current_date, 'Market') \gset
select pg_temp.eq('Bütçe aşıldı → "over"',
  (select case when level = 'over' then 1 else 0 end from budget_status(current_date) where category_id = :'cat_gida'), 1);
select pg_temp.eq('Bildirim: bütçe aşımı listede', (select count(*) from notifications(7) where kind = 'budget'), 1);
select pg_temp.eq('Bütçe kopyalama', copy_budgets(current_date, (current_date + interval '1 month')::date), 1);

-- =========== FAZ 6: KUR + FİZİKSEL VARLIK ==================================
insert into exchange_rates (rate_date, base, quote, rate) values (current_date, 'USD', 'TRY', 34.2), (current_date, 'USD', 'TZS', 2700);
select pg_temp.eq('Kur: USD→TRY', fx_rate('USD', 'TRY'), 34.2);
select pg_temp.eq('Kur: ters kur TRY→USD', round(fx_rate('TRY', 'USD'), 6), round(1 / 34.2, 6));
select pg_temp.eq('Kur: çapraz TZS→TRY (USD üzerinden)', round(fx_rate('TZS', 'TRY'), 6), round(34.2 / 2700, 6));
select create_account('Araba', 'fixed_asset', 'TRY', 850000, current_date) as araba \gset
select pg_temp.eq('Fiziksel varlık net varlığa dahil', (select balance from v_account_balances where id = :'araba'), 850000);
select adjust_balance(:'araba', 800000, current_date, 'Değer güncelleme') \gset
select pg_temp.eq('Değer güncelleme (−50.000)', (select balance from v_account_balances where id = :'araba'), 800000);
select pg_temp.must_fail('Fiziksel varlıktan harcama yapılamaz',
  format('select record_expense(%L, %L, 10)', :'araba', :'cat_market'), 'doğrudan harcama');

-- =========== Genel denge ===================================================
select pg_temp.eq('Tüm kayıtlar dengeli', (select count(*) from (
  select entry_id, currency from postings group by 1, 2 having sum(amount) <> 0) x), 0);

-- RLS: yeni tablolar izole
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select pg_temp.eq('RLS: başkasının kredi taksitleri görünmez', (select count(*) from loan_installments), 0);
select pg_temp.eq('RLS: başkasının yaklaşan ödemeleri görünmez', (select count(*) from upcoming_items(365)), 0);
select pg_temp.eq('RLS: başkasının kart ekstresi görünmez', (select count(*) from card_statements(:'kart', 6)), 0);

select '— FAZ 2–6 TESTLERİ GEÇTİ —';
