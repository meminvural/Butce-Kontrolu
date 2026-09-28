-- =====================================================================
--  0007 · Belgeler (dekont, fatura, sözleşme, ekstre) — Supabase Storage
--  Dosya yolu: <kullanıcı-id>/<kayıt-id>/<dosya>  → kullanıcı sadece kendi klasörü
--  NOT: storage şeması yalnız Supabase'de var; yerel testte bu dosya atlanır.
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do nothing;

create policy "attachments_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "attachments_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "attachments_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Belge kaydı yalnızca kullanıcının KENDİ işlemine / hesabına bağlanabilir
drop policy if exists attachments_own on attachments;
create policy attachments_own on attachments for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and storage_path like (select auth.uid())::text || '/%'
    and (entry_id   is null or exists (select 1 from journal_entries e where e.id = entry_id and e.user_id = (select auth.uid())))
    and (account_id is null or exists (select 1 from accounts a where a.id = account_id and a.user_id = (select auth.uid())))
  );
