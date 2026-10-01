-- Canlı şemanın makine okunur dökümü. Kullanım (migration'ları uygulanmış bir veritabanında):
--   psql -X -q -d butce -f scripts/schema_dump.sql > /tmp/schema.out
--   python3 scripts/gen_reference.py --dump /tmp/schema.out > docs/SYSTEM_REFERENCE.md
\pset format unaligned
\pset tuples_only on
\echo '##ENUMS'
select t.typname||': '||string_agg(e.enumlabel, ' | ' order by e.enumsortorder) from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' group by t.typname order by 1;
\echo '##TABLES'
select c.relname||' ('||case c.relrowsecurity when true then 'RLS' else 'RLS YOK' end||'): '||string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod), ', ' order by a.attnum)
from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
where n.nspname='public' and c.relkind='r' group by c.relname, c.relrowsecurity order by 1;
\echo '##VIEWS'
select c.relname||': '||string_agg(a.attname, ', ' order by a.attnum) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 where n.nspname='public' and c.relkind='v' group by c.relname order by 1;
\echo '##FUNCS'
select p.proname||'('||pg_get_function_arguments(p.oid)||') -> '||pg_get_function_result(p.oid)||' | '||case p.prosecdef when true then 'definer' else 'invoker' end||' | auth='||has_function_privilege('authenticated',p.oid,'execute')||' anon='||has_function_privilege('anon',p.oid,'execute')||' | '||case when p.prorettype='trigger'::regtype then 'trigger' else 'fn' end as x
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prokind='f' and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e') order by 1;
\echo '##POLICIES'
select tablename||' / '||policyname||' / '||cmd as x from pg_policies where schemaname='public' order by x;
\echo '##TRIGGERS'
select event_object_table||' / '||trigger_name||' / '||event_manipulation||' / '||action_timing as x from information_schema.triggers where trigger_schema='public' order by x;
