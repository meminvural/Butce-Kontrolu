-- =====================================================================
--  Ekstre içe aktarma + sonradan düzeltme testleri
--  Sıra: shim → migration'lar → ledger → phases → health → stmt_edit
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

insert into auth.users (id, email) values
  ('66666666-6666-6666-6666-666666666666', 'ekstre@test'),
  ('77777777-7777-7777-7777-777777777777', 'baska3@test');
set role authenticated;
select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', false);

select id as cat_market from categories where name = 'Market' \gset
select id as cat_diger  from categories where name = 'Diğer Gider' \gset

-- Önceki ayın 15'i = hesap kesim; dönem başı = ondan 1 ay önce + 1 gün; açılış = dönem başından 1 gün önce
select (date_trunc('month', current_date - interval '1 month') + interval '14 days')::date as cut \gset
select (:'cut'::date - interval '1 month' + interval '1 day')::date as pstart \gset
select (:'pstart'::date - 1) as opened \gset
select (:'cut'::date + 10) as due \gset

select create_account('Ziraat', 'bank', 'TRY', 20000, :'opened'::date, 'Ziraat') as bank \gset

-- =========== Ekstreden YENİ KART: devreden borç açılış bakiyesi olur ============
select create_account('Axess ···3661', 'credit_card', 'TRY', 1000, :'opened'::date, 'Akbank', null, 50000, 15, 25, '3661') as kart \gset
select pg_temp.eq('Yeni kart: devreden borç = açılış bakiyesi', (select balance from v_account_balances where id = :'kart'), 1000);
select pg_temp.eq('Yeni kart: ekstre kesim günü 15', (select statement_day from credit_card_details where account_id = :'kart'), 15);
select pg_temp.eq('Yeni kart: dönem başındaki borç = ekstrenin önceki bakiyesi',
  (select derived from statement_reconcile(:'kart', :'pstart'::date - 1)), 1000);

-- =========== İçe aktarma: harcama, TAKSİT (2/3), ödeme, iade, faiz ===============
-- 1000 + 200 + 300 − 500 − 50 + 40 = 990
select import_card_statement(jsonb_build_object(
  'account_id', :'kart', 'file_hash', repeat('b', 64), 'bank', 'akbank',
  'cut_date', :'cut', 'period_start', :'pstart', 'due_date', :'due', 'statement_debt', 990, 'min_payment', 198, 'previous_balance', 1000,
  'lines', jsonb_build_array(
    jsonb_build_object('idx', 0, 'kind', 'purchase',    'status', 'new', 'action', 'add', 'date', :'pstart'::date + 3, 'description', 'MARKET A',  'amount', 200, 'category_id', :'cat_market'),
    -- ekstrede 2/3. taksit 300: kalan 2 taksit = 600 (bu ekstrede 300 faturalanır, 300 sonraya kalır)
    jsonb_build_object('idx', 1, 'kind', 'installment', 'status', 'new', 'action', 'add', 'date', :'pstart', 'description', 'TELEFON 2/3', 'amount', 300, 'installments', 2, 'purchase_amount', 600, 'category_id', :'cat_diger'),
    jsonb_build_object('idx', 2, 'kind', 'payment',     'status', 'new', 'action', 'add', 'date', :'pstart'::date + 5, 'description', 'ÖDEME', 'amount', -500, 'source_account_id', :'bank'),
    jsonb_build_object('idx', 3, 'kind', 'refund',      'status', 'new', 'action', 'add', 'date', :'pstart'::date + 6, 'description', 'İADE X', 'amount', -50),
    jsonb_build_object('idx', 4, 'kind', 'interest',    'status', 'new', 'action', 'add', 'date', :'cut', 'description', 'DÖNEM FAİZİ', 'amount', 40)
  ))) as imp \gset
select id as imp_id from card_statement_imports where account_id = :'kart' \gset

select pg_temp.eq('İçe aktarma: defter ekstre ile BİREBİR tutuyor (fark 0)',
  (select round(ledger_debt_after - statement_debt, 2) from card_statement_imports where id = :'imp_id'), 0);
select pg_temp.eq('Kart borcu = 990 + gelecek taksit dilimi 300',
  (select balance from v_account_balances where id = :'kart'), 1290);
select pg_temp.eq('Ödeme kaynak hesaptan düştü (20.000 − 500)',
  (select balance from v_account_balances where id = :'bank'), 19500);
select pg_temp.eq('Taksit: 2 dilim, toplam 600',
  (select sum(amount) from card_installment_slices(:'kart')), 600);
select pg_temp.eq('İade borcu azalttı (kategori harcamasını değil)',
  (select count(*) from journal_entries where description like 'İADE X%' and kind = 'card_payment'), 1);
select pg_temp.eq('Saklanan ödeme tutarı eksi işaretli',
  (select (e->>'amount')::numeric from card_statement_imports i, jsonb_array_elements(i.lines) e where i.id = :'imp_id' and (e->>'idx')::int = 2), -500);

-- =========== DÜZELTME: satır tutarı değiştir (200 → 250) =========================
select amend_statement_line(:'imp_id', 0, jsonb_build_object('op', 'edit', 'amount', 250)) as r \gset
select pg_temp.eq('Düzenleme: fark artık +50 (defter fazla)', (:'r'::jsonb->>'difference')::numeric, 50);
select pg_temp.eq('Düzenleme: eski kayıt iptal edildi, yenisi yazıldı',
  (select count(*) from journal_entries e where e.user_id = '66666666-6666-6666-6666-666666666666' and e.description like '%MARKET A%' and e.status = 'reversed'), 1);
select pg_temp.eq('Düzenleme: aktif Market kaydı tek ve 250',
  (select -sum(p.amount) from postings p join journal_entries e on e.id = p.entry_id
   where e.description like 'MARKET A%' and e.status = 'posted' and p.account_id = :'kart'), 250);

-- Ekstre rakamı yanlış okunmuşsa BAŞLIK düzeltilir: dönem borcu 990 → 1040
select update_statement(:'imp_id', jsonb_build_object('statement_debt', 1040, 'min_payment', 208)) as r \gset
select pg_temp.eq('Başlık düzeltme: fark kapandı', (:'r'::jsonb->>'difference')::numeric, 0);
select pg_temp.eq('Başlık düzeltme: asgari kaydedildi', (select min_payment from card_statement_imports where id = :'imp_id'), 208);

-- =========== DÜZELTME: satır ÇIKAR (faiz yanlış okunmuş) ==========================
select amend_statement_line(:'imp_id', 4, jsonb_build_object('op', 'remove')) as r \gset
select pg_temp.eq('Çıkarma: fark = −40', (:'r'::jsonb->>'difference')::numeric, -40);
select pg_temp.eq('Çıkarma: satır listeden kalktı',
  (select jsonb_array_length(lines) from card_statement_imports where id = :'imp_id'), 4);

-- =========== DÜZELTME: MANUEL satır ekle ==========================================
select amend_statement_line(:'imp_id', null, jsonb_build_object('op', 'add', 'kind', 'fee', 'date', :'cut', 'description', 'KART AİDATI', 'amount', 40)) as r \gset
select pg_temp.eq('Manuel ekleme: fark tekrar 0', (:'r'::jsonb->>'difference')::numeric, 0);
select pg_temp.eqt('Manuel satır "manual" olarak işaretli',
  (select e->>'status' from card_statement_imports i, jsonb_array_elements(i.lines) e where i.id = :'imp_id' and e->>'description' = 'KART AİDATI'), 'manual');
select pg_temp.eq('Çıkarılan satırın numarası (4) yeniden kullanılmadı → manuel satır 5 aldı',
  (select (e->>'idx')::int from card_statement_imports i, jsonb_array_elements(i.lines) e where i.id = :'imp_id' and e->>'description' = 'KART AİDATI'), 5);

-- =========== DÜZELTME: ödeme kaynağını sonradan değiştir, tür değiştir ==========
select amend_statement_line(:'imp_id', 2, jsonb_build_object('op', 'edit', 'amount', 500, 'source_account_id', null)) as r \gset
select pg_temp.eq('Ödeme kaynağı kaldırıldı: banka bakiyesi 20.000’e döndü', (select balance from v_account_balances where id = :'bank'), 20000);
select pg_temp.eq('Kaynak değişince kart borcu aynı kaldı (ödeme hâlâ 500)', (select round(ledger_debt_after - statement_debt, 2) from card_statement_imports where id = :'imp_id'), 0);
select amend_statement_line(:'imp_id', 2, jsonb_build_object('op', 'edit', 'source_account_id', :'bank')) as r \gset
select pg_temp.eq('Kaynak tekrar seçildi: banka 19.500', (select balance from v_account_balances where id = :'bank'), 19500);

-- =========== Atla → Ekle, Ekle → Çıkar (include) ================================
select amend_statement_line(:'imp_id', 3, jsonb_build_object('op', 'edit', 'include', false)) as r \gset
select pg_temp.eq('Satır deftere alınmaktan çıkarıldı: fark +50 (iade yok)', (:'r'::jsonb->>'difference')::numeric, 50);
select pg_temp.eqt('Çıkarılan satır "skip"', (select e->>'action' from card_statement_imports i, jsonb_array_elements(i.lines) e where i.id = :'imp_id' and (e->>'idx')::int = 3), 'skip');
select amend_statement_line(:'imp_id', 3, jsonb_build_object('op', 'edit', 'include', true)) as r \gset
select pg_temp.eq('Satır tekrar eklendi: fark 0', (:'r'::jsonb->>'difference')::numeric, 0);

-- =========== Doğrulamalar ========================================================
select pg_temp.must_fail('Sıfır tutar reddedilir',
  format('select amend_statement_line(%L, 0, %L::jsonb)', :'imp_id', '{"op":"edit","amount":0}'), 'sıfırdan büyük');
select pg_temp.must_fail('Olmayan satır reddedilir',
  format('select amend_statement_line(%L, 99, %L::jsonb)', :'imp_id', '{"op":"remove"}'), 'bulunamadı');
select pg_temp.must_fail('Geçersiz işlem reddedilir',
  format('select amend_statement_line(%L, 0, %L::jsonb)', :'imp_id', '{"op":"sil"}'), 'Geçersiz işlem');
select pg_temp.must_fail('Aynı kesim tarihli ikinci ekstre yüklenemez',
  format('select import_card_statement(jsonb_build_object(''account_id'', %L, ''file_hash'', repeat(''c'', 64), ''cut_date'', %L, ''statement_debt'', 1, ''lines'', ''[]''::jsonb))', :'kart', :'cut'), 'zaten kayıtlı');

-- =========== İZOLASYON ===========================================================
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', false);
select pg_temp.must_fail('Başkasının ekstresi düzenlenemez',
  format('select amend_statement_line(%L, 0, %L::jsonb)', :'imp_id', '{"op":"edit","amount":1}'), 'bulunamadı');
select pg_temp.must_fail('Başkasının ekstre başlığı değiştirilemez',
  format('select update_statement(%L, %L::jsonb)', :'imp_id', '{"statement_debt":1}'), 'bulunamadı');
select pg_temp.must_fail('Başkasının ekstresi silinemez',
  format('select delete_statement(%L)', :'imp_id'), 'bulunamadı');
select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', false);

-- =========== EKSTRE SİL: eklenen kayıtlar iptal, kart açılış bakiyesine döner ====
select delete_statement(:'imp_id', true) as r \gset
select pg_temp.eq('Silme: ekstre kaydı kalktı', (select count(*) from card_statement_imports where id = :'imp_id'), 0);
select pg_temp.eq('Silme: kart borcu açılış bakiyesine döndü', (select balance from v_account_balances where id = :'kart'), 1000);
select pg_temp.eq('Silme: banka bakiyesi geri döndü', (select balance from v_account_balances where id = :'bank'), 20000);
select pg_temp.eq('Silme: taksit dilimleri de geri alındı', (select count(*) from card_installment_slices(:'kart')), 0);
select pg_temp.eq('Silmeden sonra tüm kayıtlar dengeli', (select count(*) from (
  select entry_id, currency from postings group by 1, 2 having sum(amount) <> 0) x), 0);
select pg_temp.eq('Silmeden sonra sağlık kontrolünde kritik sorun yok',
  (select count(*) from financial_health() where severity = 'crit'), 0);

-- Silinen ekstre aynı dosya ile yeniden yüklenebilir
select import_card_statement(jsonb_build_object(
  'account_id', :'kart', 'file_hash', repeat('b', 64), 'cut_date', :'cut', 'statement_debt', 1000, 'lines', '[]'::jsonb)) as r \gset
select pg_temp.eq('Silinen ekstre yeniden yüklenebilir', (select count(*) from card_statement_imports where account_id = :'kart'), 1);

-- =========== YETKİ ===============================================================
reset role;
select pg_temp.eqt('Anonim rol ekstre düzenleyemez', has_function_privilege('anon', 'amend_statement_line(uuid,int,jsonb)', 'execute')::text, 'false');
select pg_temp.eqt('Anonim rol ekstre başlığı değiştiremez', has_function_privilege('anon', 'update_statement(uuid,jsonb)', 'execute')::text, 'false');
select pg_temp.eqt('Anonim rol ekstre silemez', has_function_privilege('anon', 'delete_statement(uuid,boolean)', 'execute')::text, 'false');
select pg_temp.eqt('Kullanıcı iç yardımcıyı doğrudan çağıramaz',
  has_function_privilege('authenticated', '_statement_entry(uuid,accounts,text,jsonb)', 'execute')::text, 'false');
select pg_temp.eqt('Giriş yapmış kullanıcı düzeltme yapabilir', has_function_privilege('authenticated', 'amend_statement_line(uuid,int,jsonb)', 'execute')::text, 'true');

select '— EKSTRE DÜZENLEME TESTLERİ GEÇTİ —';
