-- Ekstre durumu: en yeni ekstre güncel · eskiler kapandı (ödenmiş sayılır) · ödeme/kapanma bilgisi
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.eq(l text, a numeric, x numeric) returns text language plpgsql as $$
begin if a is distinct from x then raise exception 'BAŞARISIZ: % → beklenen %, gelen %', l, x, a; end if; return '✓ ' || l; end $$;
create or replace function pg_temp.eqt(l text, a text, x text) returns text language plpgsql as $$
begin if a is distinct from x then raise exception 'BAŞARISIZ: % → beklenen %, gelen %', l, x, a; end if; return '✓ ' || l; end $$;
grant execute on all functions in schema pg_temp to authenticated;

insert into auth.users (id, email) values ('99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa','durum@test'), ('88888888-bbbb-4bbb-8bbb-bbbbbbbbbbbb','durum2@test');
set role authenticated;
select set_config('request.jwt.claim.sub','99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
select id as market from categories where name = 'Market' \gset

select create_account('Banka','bank','TRY',100000,current_date - 200,'Ziraat') as banka \gset
select create_account('Kart','credit_card','TRY',0,current_date - 200,'Akbank',null,100000,10,20,'4444') as kart \gset

-- Dört kesilmiş dönem: her birine bir harcama
select cut_date as c1 from card_statements(:'kart', 6) where not is_current order by cut_date desc limit 1 offset 0 \gset
select cut_date as c2 from card_statements(:'kart', 6) where not is_current order by cut_date desc limit 1 offset 1 \gset
select cut_date as c3 from card_statements(:'kart', 6) where not is_current order by cut_date desc limit 1 offset 2 \gset
select cut_date as c4 from card_statements(:'kart', 6) where not is_current order by cut_date desc limit 1 offset 3 \gset
select record_expense(:'kart', :'market', 400, :'c4'::date - 3, 'D4') \gset
select record_expense(:'kart', :'market', 300, :'c3'::date - 3, 'D3') \gset
select record_expense(:'kart', :'market', 200, :'c2'::date - 3, 'D2') \gset
select record_expense(:'kart', :'market', 100, :'c1'::date - 3, 'D1') \gset

-- ============ Hiç ödeme yokken: yalnızca en yeni ekstre ödeme bekler, eskiler KAPANDI ============
select pg_temp.eqt('En yeni kesilmiş ekstre ödeme durumuna bakar',
  (select status from card_statements(:'kart', 6) where cut_date = :'c1'::date),
  (select case when current_date > due_date then 'overdue' else 'awaiting' end from card_statements(:'kart', 6) where cut_date = :'c1'::date));
select pg_temp.eqt('2. ekstre kapandı', (select status from card_statements(:'kart', 6) where cut_date = :'c2'::date), 'closed');
select pg_temp.eqt('3. ekstre kapandı', (select status from card_statements(:'kart', 6) where cut_date = :'c3'::date), 'closed');
select pg_temp.eqt('4. ekstre kapandı', (select status from card_statements(:'kart', 6) where cut_date = :'c4'::date), 'closed');
select pg_temp.eq('Kapanan ekstrede kalan 0', (select sum(remaining) from card_statements(:'kart', 6) where status = 'closed'), 0);
select pg_temp.eq('Kapanan ekstre ödenmiş sayılır: ödenen = ekstre tutarı', (select paid from card_statements(:'kart', 6) where cut_date = :'c3'::date), (select statement_amount from card_statements(:'kart', 6) where cut_date = :'c3'::date));
select pg_temp.eq('Gecikmiş ekstre yalnızca en yeni ekstre olabilir', (select count(*) from card_statements(:'kart', 6) where status in ('overdue', 'awaiting', 'partial')), 1);
select pg_temp.eq('Açık dönem etkilenmedi', (select count(*) from card_statements(:'kart', 6) where is_current and status = 'open_period'), 1);

-- ============ En yeni ekstrenin ödenmesi ============
select statement_amount as amt1, min_payment as min1 from card_statements(:'kart', 6) where cut_date = :'c1'::date \gset
select record_transfer(:'banka', :'kart', :amt1::numeric / 2, null, :'c1'::date + 1, 'Kısmi') \gset
select pg_temp.eq('Kısmi ödeme: kalan = yarısı', (select remaining from card_statements(:'kart', 6) where cut_date = :'c1'::date), :amt1::numeric - :amt1::numeric / 2);
select pg_temp.eqt('Kısmi ödeme durumu', (select status from card_statements(:'kart', 6) where cut_date = :'c1'::date),
  (select case when current_date > due_date then 'overdue' else 'partial' end from card_statements(:'kart', 6) where cut_date = :'c1'::date));
select record_transfer(:'banka', :'kart', :amt1::numeric / 2, null, :'c1'::date + 2, 'Kalan') \gset
select pg_temp.eqt('Tamamı ödenince ekstre kapandı (paid)', (select status from card_statements(:'kart', 6) where cut_date = :'c1'::date), 'paid');
select pg_temp.eq('Hiç bekleyen ekstre kalmadı', (select count(*) from card_statements(:'kart', 6) where status in ('overdue', 'awaiting', 'partial')), 0);

-- ============ statement_status: son yüklenen ekstre ve ödeme bilgisi ============
select due_date as due1 from card_statements(:'kart', 6) where cut_date = :'c1'::date \gset
select import_card_statement(jsonb_build_object('account_id', :'kart', 'file_hash', repeat('a', 64), 'cut_date', :'c2', 'due_date', :'c2'::date + 10,
  'statement_debt', 500, 'min_payment', 100, 'lines', '[]'::jsonb)) \gset
select import_card_statement(jsonb_build_object('account_id', :'kart', 'file_hash', repeat('b', 64), 'cut_date', :'c1', 'due_date', :'due1',
  'statement_debt', 1000, 'min_payment', 200, 'lines', '[]'::jsonb)) \gset
select pg_temp.eqt('Son ekstre = en yeni kesim (eskisi değil)', (select last_cut::text from statement_status()), :'c1');
select pg_temp.eq('Ödenen (kesimden sonra) ekstre tutarını aşamaz', (select paid from statement_status()), least(:amt1::numeric, 1000));
select pg_temp.eq('Kalan = ekstre − ödenen', (select remaining from statement_status()), greatest(1000 - least(:amt1::numeric, 1000), 0));
select pg_temp.eqt('Asgari karşılandı mı', (select min_met::text from statement_status()), (least(:amt1::numeric, 1000) >= 200)::text);

-- Başka kart: ödenmemiş yeni ekstre
select create_account('Kart2','credit_card','TRY',0,current_date - 200,'QNB',null,50000,10,20,'5555') as kart2 \gset
select import_card_statement(jsonb_build_object('account_id', :'kart2', 'file_hash', repeat('c', 64), 'cut_date', :'c1', 'due_date', current_date + 5,
  'statement_debt', 800, 'min_payment', 160, 'lines', '[]'::jsonb)) \gset
select pg_temp.eqt('Ödenmemiş yeni ekstre: bekliyor', (select pay_status from statement_status() where name = 'Kart2'), 'awaiting');
select pg_temp.eqt('Ödenmemiş: ekstre kapanmadı', (select is_closed::text from statement_status() where name = 'Kart2'), 'false');
select pg_temp.eq('Ödenmemiş: ödenen 0, kalan 800', (select paid * 1000 + remaining from statement_status() where name = 'Kart2'), 800);
select pg_temp.eqt('Ödenmemiş: asgari karşılanmadı', (select min_met::text from statement_status() where name = 'Kart2'), 'false');
-- Asgari kadar öde
select record_transfer(:'banka', :'kart2', 160, null, :'c1'::date + 1, 'Asgari') \gset
select pg_temp.eqt('Asgari ödenince durum kısmi', (select pay_status from statement_status() where name = 'Kart2'), 'partial');
select pg_temp.eqt('Asgari karşılandı', (select min_met::text from statement_status() where name = 'Kart2'), 'true');
-- Tamamını öde → kapandı
select record_transfer(:'banka', :'kart2', 640, null, :'c1'::date + 2, 'Tamamı') \gset
select pg_temp.eqt('Tamamı ödenince durum paid', (select pay_status from statement_status() where name = 'Kart2'), 'paid');
select pg_temp.eqt('Tamamı ödenince ekstre kapandı', (select is_closed::text from statement_status() where name = 'Kart2'), 'true');
-- Vadesi geçmiş, ödenmemiş
select create_account('Kart3','credit_card','TRY',0,current_date - 200,'Garanti',null,50000,10,20,'6666') as kart3 \gset
select import_card_statement(jsonb_build_object('account_id', :'kart3', 'file_hash', repeat('d', 64), 'cut_date', :'c1', 'due_date', current_date - 2,
  'statement_debt', 900, 'min_payment', 180, 'lines', '[]'::jsonb)) \gset
select pg_temp.eqt('Vadesi geçmiş ödenmemiş ekstre gecikmiş', (select pay_status from statement_status() where name = 'Kart3'), 'overdue');

-- ============ Eski ekstre eklemek güncel olanı değiştirmez ============
select import_card_statement(jsonb_build_object('account_id', :'kart3', 'file_hash', repeat('e', 64), 'cut_date', :'c3', 'due_date', :'c3'::date + 10,
  'statement_debt', 300, 'min_payment', 60, 'lines', '[]'::jsonb)) \gset
select pg_temp.eqt('Eski ekstre sonradan eklendi: güncel ekstre hâlâ en yenisi', (select last_cut::text from statement_status() where name = 'Kart3'), :'c1');
select pg_temp.eqt('Eski ekstre kapandı sayılır', (select status from card_statements(:'kart3', 6) where cut_date = :'c3'::date), 'closed');

-- ============ İZOLASYON ve YETKİ ============
select set_config('request.jwt.claim.sub','88888888-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false);
select pg_temp.eq('Başkası bu kartların durumunu görmez', (select count(*) from statement_status()), 0);
reset role;
select pg_temp.eqt('Anonim statement_status çağıramaz', has_function_privilege('anon', 'statement_status()', 'execute')::text, 'false');
select pg_temp.eqt('Giriş yapmış kullanıcı çağırabilir', has_function_privilege('authenticated', 'statement_status()', 'execute')::text, 'true');
select '— EKSTRE DURUMU TESTLERİ GEÇTİ —';
