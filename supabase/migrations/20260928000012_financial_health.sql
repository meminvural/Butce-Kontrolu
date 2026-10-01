-- =====================================================================
--  0012 · Finansal sağlık denetimi
--   • financial_health(): defterin bütünlüğünü ve kart / kredi / ekstre tutarlılığını tek çağrıda denetler.
--     Salt okunur; hiçbir veriyi değiştirmez. Satır güvenliği (RLS) çağıran kullanıcıya uygulanır.
--   • Ayrıca 0010/0011'de açık kalan anonim (anon) çalıştırma yetkilerini kapatır.
-- =====================================================================

-- ---------------------------------------------------------------------
--  0011'deki üretim farkları depoya işleniyor (üretimde zaten uygulanmıştı):
--  anonim erişim kapalı + kart ekstre kaydı için yabancı anahtar indeksi
-- ---------------------------------------------------------------------
create index if not exists card_statement_imports_account_idx on card_statement_imports (account_id);
revoke all on card_statement_imports from anon;
revoke execute on function import_card_statement(jsonb), statement_status(), statement_reconcile(uuid, date),
  _card_derived_statement(uuid, date), debt_service_outlook(int) from public, anon;
grant execute on function import_card_statement(jsonb), statement_status(), statement_reconcile(uuid, date),
  _card_derived_statement(uuid, date), debt_service_outlook(int) to authenticated;

-- ---------------------------------------------------------------------
--  financial_health()
--   severity: ok (sorun yok) · info (bilgi) · warn (inceleyin) · crit (defter bütünlüğü bozuk)
--   issue_count: bulunan sorun sayısı · detail: ilk 5 örnek (jsonb)
-- ---------------------------------------------------------------------
create or replace function financial_health()
returns table (check_key text, title text, severity text, issue_count int, detail jsonb, hint text)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_today date := _today(auth.uid());
  v_n     int;
  v_d     jsonb;
begin
  -- 1 · Her kayıt, para birimi bazında dengeli olmalı (Σ = 0)
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select g.*, row_number() over (order by g.entry_date, g.entry_id) rn
        from (select e.id as entry_id, e.entry_date, e.description, p.currency, sum(p.amount) as fark
              from journal_entries e join postings p on p.entry_id = e.id
              group by e.id, e.entry_date, e.description, p.currency having sum(p.amount) <> 0) g) x;
  check_key := 'unbalanced_entries'; title := 'Dengesiz defter kaydı'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'crit' end;
  hint := 'Çift kayıt kuralı bozulmuş. Bu normalde veritabanı tarafından engellenir; kaydı ters çevirip yeniden girin.';
  return next;

  -- 2 · Satırı olmayan kayıt
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select e.id as entry_id, e.entry_date, e.description, row_number() over (order by e.entry_date) rn
        from journal_entries e where not exists (select 1 from postings p where p.entry_id = e.id)) x;
  check_key := 'empty_entries'; title := 'Satırsız defter kaydı'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'crit' end;
  hint := 'Hiçbir hesaba etki etmeyen boş kayıt. Ters kayıt ile iptal edin.';
  return next;

  -- 3 · İptal / ters kayıt bağları
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select e.id as entry_id, e.entry_date, e.description, e.kind::text as kind, row_number() over (order by e.entry_date) rn
        from journal_entries e
        where (e.status = 'reversed' and not exists (select 1 from journal_entries r where r.id = e.reversed_by and r.reverses_entry_id = e.id))
           or (e.kind = 'reversal' and not exists (select 1 from journal_entries o where o.id = e.reverses_entry_id and o.status = 'reversed' and o.reversed_by = e.id))) x;
  check_key := 'reversal_links'; title := 'İptal bağı tutarsız'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'crit' end;
  hint := 'İptal edilen kayıt ile ters kaydı birbirini göstermiyor.';
  return next;

  -- 4 · Satır para birimi hesabın para birimiyle aynı olmalı
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select p.entry_id, a.name as hesap, a.currency as hesap_para, p.currency as satir_para, row_number() over (order by p.id) rn
        from postings p join accounts a on a.id = p.account_id where p.currency <> a.currency) x;
  check_key := 'currency_mismatch'; title := 'Para birimi uyuşmuyor'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'crit' end;
  hint := 'Kayıttaki para birimi hesabınkiyle farklı.';
  return next;

  -- 5 · Kart / ek hesap limiti aşılmış
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select b.name as hesap, b.balance as borc, b.credit_limit as limit_tutari, b.available_limit as kullanilabilir,
               row_number() over (order by b.available_limit) rn
        from v_account_balances b
        where b.kind in ('credit_card', 'overdraft') and b.archived_at is null and b.available_limit < 0) x;
  check_key := 'over_limit'; title := 'Limit aşımı'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'warn' end;
  hint := 'Borç limitin üstünde. Limit bilgisi eski olabilir; ekstreden güncelleyin ya da borcu kontrol edin.';
  return next;

  -- 6 · Eksi bakiyeli nakit / banka hesabı
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select b.name as hesap, b.balance as bakiye, b.currency, row_number() over (order by b.balance) rn
        from v_account_balances b
        where b.kind in ('bank', 'cash', 'savings') and b.archived_at is null and b.balance < 0) x;
  check_key := 'negative_cash'; title := 'Eksi bakiyeli hesap'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'warn' end;
  hint := 'Para olması gereken hesap eksiye düşmüş. Kaynak belirsiz bir ödeme ya da eksik gelir kaydı olabilir.';
  return next;

  -- 7 · Kategorisiz gelir / harcama
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select e.id as entry_id, e.entry_date, e.description, e.kind::text as kind, row_number() over (order by e.entry_date desc) rn
        from journal_entries e
        where e.status = 'posted' and e.kind in ('income', 'expense', 'card_purchase')
          and not exists (select 1 from postings p where p.entry_id = e.id and p.category_id is not null)) x;
  check_key := 'uncategorized'; title := 'Kategorisiz gelir/gider'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'warn' end;
  hint := 'Raporlarda yer almaz. Kategori atayın.';
  return next;

  -- 8 · Ekstre ile defter farkı (yüklenmiş ekstresi olan kartlar)
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select s.name as kart, s.last_cut as kesim, s.statement_debt as ekstre_borcu, s.ledger_debt as defter, s.diff as fark,
               row_number() over (order by abs(s.diff) desc) rn
        from statement_status() s where s.diff is not null and abs(s.diff) > 1) x;
  check_key := 'statement_diff'; title := 'Ekstre ile defter farkı'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'warn' end;
  hint := 'Bankanın ekstre borcu defterle tutmuyor. Eksik/fazla kalem ya da yuvarlanmış tutar olabilir; Kredi kartları sayfasından dönemi inceleyin.';
  return next;

  -- 9 · Güncel ekstresi olmayan, borcu olan kartlar
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select s.name as kart, s.last_cut as son_ekstre, b.balance as defter_borcu, row_number() over (order by b.balance desc) rn
        from statement_status() s join v_account_balances b on b.id = s.account_id
        where s.is_stale and b.balance > 0) x;
  check_key := 'statement_stale'; title := 'Güncel ekstresi olmayan kart'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'info' end;
  hint := 'Bu kartların son ekstresi yüklenmemiş ya da yeni kesim geçmiş. Ekstre yükle sayfasından ekleyin.';
  return next;

  -- 10 · Kredi: taksit planı ana paraya, bakiye kalan ana paraya eşit olmalı
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select l.name as kredi, l.principal as ana_para,
               (select sum(i.principal) from loan_installments i where i.account_id = l.id) as plan_toplami,
               l.remaining_principal as kalan_ana_para, b.balance as hesap_bakiyesi,
               row_number() over (order by l.name) rn
        from v_loans l join v_account_balances b on b.id = l.id
        where l.archived_at is null
          and (abs(coalesce((select sum(i.principal) from loan_installments i where i.account_id = l.id), 0) - l.principal) > 1
               or abs(l.remaining_principal - b.balance) > 1)) x;
  check_key := 'loan_mismatch'; title := 'Kredi planı / bakiye uyuşmuyor'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'warn' end;
  hint := 'Taksit planının toplamı ana paradan ya da hesap bakiyesi kalan ana paradan farklı.';
  return next;

  -- 11 · Vadesi geçmiş, ödenmemiş kredi taksiti
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select a.name as kredi, i.installment_no as taksit_no, i.due_date as vade, i.payment as tutar,
               row_number() over (order by i.due_date) rn
        from loan_installments i join accounts a on a.id = i.account_id
        where i.paid_entry_id is null and not i.settled_outside and i.due_date < v_today and a.archived_at is null) x;
  check_key := 'loan_overdue'; title := 'Vadesi geçmiş kredi taksiti'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'warn' end;
  hint := 'Taksit ödenmiş ise Krediler sayfasından “ödendi” olarak işleyin; ödenmediyse gecikme faizi işleyebilir.';
  return next;

  -- 12 · Vadesi geçmiş planlı kalem
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select s.due_date as vade, s.description as aciklama, s.amount as tutar, s.source_type as kaynak,
               row_number() over (order by s.due_date) rn
        from scheduled_items s where s.status = 'planned' and s.due_date < v_today) x;
  check_key := 'scheduled_overdue'; title := 'Vadesi geçmiş planlı ödeme'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'warn' end;
  hint := 'Planlı ödeme gerçekleşmiş ise “gerçekleştir” deyin, iptalse atlayın.';
  return next;

  -- 13 · Arşivlenmiş hesapta bakiye
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select b.name as hesap, b.balance as bakiye, b.currency, row_number() over (order by b.name) rn
        from v_account_balances b where b.archived_at is not null and b.balance <> 0) x;
  check_key := 'archived_balance'; title := 'Arşivli hesapta bakiye'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'warn' end;
  hint := 'Arşivlenen hesap sıfırlanmadan kapatılmış; net varlığa hâlâ etki ediyor.';
  return next;

  -- 14 · Kartta alacak (fazla ödeme) bakiyesi
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select b.name as kart, -b.balance as alacak, row_number() over (order by b.balance) rn
        from v_account_balances b where b.kind = 'credit_card' and b.archived_at is null and b.balance < 0) x;
  check_key := 'card_credit'; title := 'Kartta fazla ödeme (alacak)'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'info' end;
  hint := 'Kartın borcundan fazla ödeme yapılmış ya da iade işlenmiş. Beklenmiyorsa kaynağını kontrol edin.';
  return next;

  -- 15 · Gelecek tarihli gerçekleşmiş kayıt
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select e.id as entry_id, e.entry_date, e.description, row_number() over (order by e.entry_date) rn
        from journal_entries e where e.status = 'posted' and e.entry_date > v_today) x;
  check_key := 'future_dated'; title := 'Gelecek tarihli kayıt'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'info' end;
  hint := 'Henüz gerçekleşmemiş bir işlem deftere yazılmış. Gelecek ödemeler “Planlı ve düzenli”de tutulmalı.';
  return next;

  -- 16 · Olası mükerrer kayıt (aynı hesap, tarih, tutar ve açıklama)
  select count(*), coalesce(jsonb_agg(to_jsonb(x)) filter (where x.rn <= 5), '[]'::jsonb) into v_n, v_d
  from (select g.hesap, g.entry_date as tarih, g.aciklama, g.tutar, g.adet, row_number() over (order by g.entry_date desc) rn
        from (select a.name as hesap, e.entry_date, lower(btrim(coalesce(e.description, ''))) as aciklama,
                     abs(p.amount) as tutar, count(*)::int as adet
              from journal_entries e
              join postings p on p.entry_id = e.id
              join accounts a on a.id = p.account_id and not a.is_system
              where e.status = 'posted' and e.kind in ('income', 'expense', 'card_purchase', 'card_payment')
              group by a.name, e.entry_date, lower(btrim(coalesce(e.description, ''))), abs(p.amount)
              having count(*) > 1) g) x;
  check_key := 'possible_duplicates'; title := 'Olası mükerrer kayıt'; issue_count := v_n; detail := v_d;
  severity := case when v_n = 0 then 'ok' else 'info' end;
  hint := 'Aynı hesapta aynı gün, aynı tutar ve açıklamayla birden çok kayıt var. Gerçekten iki ayrı harcama olabilir; değilse birini iptal edin.';
  return next;
end $$;

revoke execute on function financial_health() from public, anon;
grant  execute on function financial_health() to authenticated;
