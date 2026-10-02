-- =====================================================================
--  0016 · Toplu içe aktarmada "devreden borç" satırı (kind = 'carry')
--   Eski Excel'lerdeki "DEVREDEN" satırları harcama değildir: borcu gider yazmadan, tarihli açılış kaydı olarak ekler.
-- =====================================================================

create or replace function import_transactions(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid := _uid();
  l      jsonb;
  i      int := 0;
  n_add  int := 0;
  n_exist int := 0;
  v_fail jsonb := '[]'::jsonb;
  v_key  text;
  v_kind text;
  a      accounts;
  v_amt  numeric;
  v_inst int;
begin
  for l in select * from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) loop
    i := i + 1;
    begin
      v_kind := l->>'kind';
      v_key  := 'xl:' || coalesce(nullif(l->>'key', ''), gen_random_uuid()::text);
      if _existing_entry(v_uid, v_key) is not null then n_exist := n_exist + 1; continue; end if;
      a := _owned_account(v_uid, (l->>'account_id')::uuid);
      v_amt := (l->>'amount')::numeric;
      if v_amt is null or v_amt <= 0 then raise exception 'Tutar sıfırdan büyük olmalı'; end if;

      if v_kind = 'expense' then
        v_inst := greatest(coalesce(nullif(l->>'installments', '')::int, 1), 1);
        perform _statement_entry(v_uid, a, v_key, jsonb_build_object(
          'kind', case when v_inst > 1 then 'installment' else 'purchase' end,
          'amount', case when v_inst > 1 then coalesce(nullif(l->>'purchase_amount', '')::numeric, v_amt) / v_inst else v_amt end,
          'purchase_amount', case when v_inst > 1 then coalesce(nullif(l->>'purchase_amount', '')::numeric, v_amt) end,
          'installments', v_inst, 'date', l->>'date', 'description', l->>'description', 'category_id', l->>'category_id'));
      elsif v_kind in ('payment', 'refund') then
        if a.kind <> 'credit_card' then raise exception 'Ödeme/iade yalnızca kredi kartına yapılabilir'; end if;
        perform _statement_entry(v_uid, a, v_key, jsonb_build_object(
          'kind', v_kind, 'amount', v_amt, 'date', l->>'date', 'description', l->>'description',
          'source_account_id', l->>'source_account_id'));
      elsif v_kind = 'carry' then
        -- Devreden borç / bakiye: gider ya da gelir DEĞİL; özkaynak karşılığı tarihli açılış kaydı (hesap başına birden çok olabilir)
        declare v_raw numeric; v_id uuid;
        begin
          v_raw := case when account_class_of(a.kind) = 'liability' then -v_amt else v_amt end;
          v_id := _new_entry(v_uid, _check_date(v_uid, (l->>'date')::date), 'opening_balance',
                             coalesce(nullif(trim(l->>'description'), ''), 'Devreden bakiye') || ' [devreden]', v_key);
          perform _post(v_id, a.id, null, v_raw, a.currency);
          perform _post(v_id, _system_account(v_uid, 'equity', a.currency), null, -v_raw, a.currency);
        end;
      elsif v_kind = 'income' then
        perform record_income(a.id, (l->>'category_id')::uuid, v_amt, (l->>'date')::date, nullif(l->>'description', ''), v_key);
      elsif v_kind = 'transfer' then
        perform record_transfer(a.id, (l->>'to_account_id')::uuid, v_amt, nullif(l->>'to_amount', '')::numeric,
                                (l->>'date')::date, nullif(l->>'description', ''), v_key);
      else
        raise exception 'Bilinmeyen işlem türü: %', coalesce(v_kind, '(boş)');
      end if;
      n_add := n_add + 1;
    exception when others then
      v_fail := v_fail || jsonb_build_object('row', i, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('added', n_add, 'existing', n_exist, 'failed', v_fail);
end $$;

revoke execute on function import_transactions(jsonb) from public, anon;
grant  execute on function import_transactions(jsonb) to authenticated;
