-- =====================================================================
--  0010 · Rapor altyapısı
--   1) "Finansal Giderler" (faiz, vergi, masraf) kategorisi sistem anahtarıyla işaretlenir
--   2) v_ledger_lines: raporlar için düz defter satırları (iptal edilenler hariç)
--   3) debt_service_outlook(): gelecek aylardaki kart taksiti ve kredi taksiti yükü
-- =====================================================================

-- 1) Mevcut kullanıcılar: kök kategori ve "Ek Hesap Faizi" alt kategorisi anahtarlanır
update categories set system_key = 'financial_costs'
where parent_id is null and kind = 'expense' and name = 'Finansal Giderler' and system_key is null;

update categories c set system_key = 'overdraft_interest'
from categories p
where c.parent_id = p.id and p.system_key = 'financial_costs' and c.name = 'Ek Hesap Faizi' and c.system_key is null;

-- Yeni kullanıcılar: varsayılan kategoriler aynı anahtarla açılır
create or replace function seed_default_categories(p_uid uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_parent uuid;
  r record;
  sub text;
begin
  for r in select * from (values
      ('Maaş', 1, null::text), ('Prim & Bonus', 2, null), ('Kira Geliri', 3, null),
      ('Faiz Geliri', 4, 'interest_income'), ('Yatırım Geliri', 5, null), ('Ek İş', 6, null),
      ('Diğer Gelir', 9, null)) as t(name, ord, skey)
  loop
    insert into categories (user_id, kind, name, sort_order, system_key)
    values (p_uid, 'income', r.name, r.ord, r.skey) on conflict do nothing;
  end loop;

  for r in select * from (values
      ('Ev',          1, array['Kira','Elektrik','Su','Doğalgaz','İnternet','Aidat']),
      ('Gıda',        2, array['Market','Restoran','Yemek Siparişi']),
      ('Ulaşım',      3, array['Yakıt','Bakım','Sigorta','Otopark','Toplu Taşıma']),
      ('Alışveriş',   4, array['Giyim','Elektronik','Diğer']),
      ('Sağlık',      5, array['Doktor','İlaç']),
      ('Eğitim',      6, array['Kurs','Kitap']),
      ('Eğlence',     7, array['Abonelikler','Etkinlik','Seyahat']),
      ('Finansal Giderler', 8, array['Kredi Faizi','Kart Faizi','Banka Masrafı']),
      ('Diğer Gider', 9, array[]::text[])) as t(name, ord, subs)
  loop
    insert into categories (user_id, kind, name, sort_order, system_key)
    values (p_uid, 'expense', r.name, r.ord, case when r.name = 'Finansal Giderler' then 'financial_costs' end)
    returning id into v_parent;
    foreach sub in array r.subs loop
      insert into categories (user_id, kind, name, parent_id, system_key)
      values (p_uid, 'expense', sub, v_parent,
              case sub when 'Kredi Faizi' then 'loan_interest'
                       when 'Kart Faizi'  then 'card_interest'
                       when 'Banka Masrafı' then 'bank_fee' end);
    end loop;
  end loop;
end $$;
alter function seed_default_categories(uuid) set search_path = public, pg_temp;
revoke execute on function seed_default_categories(uuid) from authenticated, anon, public;

-- 2) Düz defter satırları. İptal edilen kayıtlar ve ters kayıtlar birlikte dışarıda kalır (net etkileri zaten sıfır);
--    sistem hesapları (açılış/düzeltme, kur çevrim) görünmez.
create or replace view v_ledger_lines with (security_invoker = true) as
select
  p.id                              as line_id,
  e.id                              as entry_id,
  e.user_id,
  e.entry_date,
  e.kind                            as entry_kind,
  e.description,
  p.account_id,
  a.name                            as account_name,
  a.kind                            as account_kind,
  account_class_of(a.kind)          as account_class,
  p.category_id,
  c.name                            as category_name,
  c.kind                            as category_kind,
  c.system_key                      as category_key,
  coalesce(c.parent_id, c.id)       as root_category_id,
  coalesce(pc.name, c.name)         as root_category_name,
  coalesce(pc.system_key, c.system_key) as root_key,
  p.amount,
  p.currency,
  p.memo
from postings p
join journal_entries e on e.id = p.entry_id and e.status = 'posted' and e.kind <> 'reversal'
left join accounts a    on a.id = p.account_id
left join categories c  on c.id = p.category_id
left join categories pc on pc.id = c.parent_id
where p.account_id is null or not a.is_system;

-- 3) Gelecek taksit yükü (kart taksit dilimleri + ödenmemiş kredi taksitleri), ay bazında
create or replace function debt_service_outlook(p_months int default 12)
returns table (month date, source text, account_id uuid, account_name text, currency char(3), amount numeric, n bigint)
language sql stable security invoker set search_path = public, pg_temp as $$
  with lim as (
    select _today(auth.uid()) as d,
           (date_trunc('month', _today(auth.uid())) + make_interval(months => greatest(least(p_months, 60), 1)))::date as u
  )
  select date_trunc('month', s.billing_date)::date, 'card_installment'::text, a.id, a.name, a.currency,
         sum(s.amount), count(*)
  from accounts a cross join lim
  cross join lateral card_installment_slices(a.id) s
  where a.kind = 'credit_card' and a.archived_at is null and not a.is_system
    and s.billing_date >= lim.d and s.billing_date < lim.u
  group by 1, a.id, a.name, a.currency
  union all
  select date_trunc('month', li.due_date)::date, 'loan_installment'::text, a.id, a.name, a.currency,
         sum(li.payment), count(*)
  from loan_installments li
  join accounts a on a.id = li.account_id
  cross join lim
  where a.archived_at is null and not li.settled_outside and li.paid_entry_id is null and li.due_date < lim.u
  group by 1, a.id, a.name, a.currency
  order by 1, 2, 4
$$;

grant execute on function debt_service_outlook(int) to authenticated;
