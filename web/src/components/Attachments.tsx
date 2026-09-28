import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { table, useAttachments } from '../lib/api';
import { ErrorText } from './ui';

/** Dekont / fatura / makbuz: dosya Storage'da, veritabanında yalnız referans */
export default function Attachments({ entryId }: { entryId: string }) {
  const { session } = useAuth();
  const qc = useQueryClient();
  const { data } = useAttachments(entryId);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const upload = async (file: File) => {
    if (!session) return;
    setBusy(true); setError(null);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Dosya 10 MB’tan büyük olamaz');
      const safe = file.name.normalize('NFKD').replace(/[^\w.-]+/g, '_');
      const path = `${session.user.id}/${entryId}/${Date.now()}-${safe}`;
      const up = await supabase.storage.from('attachments').upload(path, file, { contentType: file.type });
      if (up.error) throw new Error(up.error.message);
      await table(supabase.from('attachments').insert({
        entry_id: entryId, storage_path: path, file_name: file.name, mime_type: file.type, size_bytes: file.size,
      }));
      qc.invalidateQueries({ queryKey: ['attachments', entryId] });
    } catch (e) { setError(e); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };

  const open = async (path: string) => {
    const { data: signed, error: err } = await supabase.storage.from('attachments').createSignedUrl(path, 120);
    if (err) return setError(err);
    window.open(signed.signedUrl, '_blank', 'noopener');
  };

  const remove = async (id: string, path: string) => {
    setError(null);
    try {
      const rm = await supabase.storage.from('attachments').remove([path]);
      if (rm.error) throw new Error(rm.error.message);
      await table(supabase.from('attachments').delete().eq('id', id));
      qc.invalidateQueries({ queryKey: ['attachments', entryId] });
    } catch (e) { setError(e); }
  };

  return (
    <div className="attachments">
      <span className="field-label">Belgeler</span>
      {(data ?? []).map((a) => (
        <div key={a.id} className="attachment">
          <button className="link-btn" onClick={() => open(a.storage_path)}>{a.file_name}</button>
          <button className="link-btn small muted" onClick={() => remove(a.id, a.storage_path)}>Kaldır</button>
        </div>
      ))}
      <input ref={input} type="file" hidden accept="image/*,application/pdf"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
      <button className="btn btn-small" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Yükleniyor…' : 'Dekont / fatura ekle'}
      </button>
      <ErrorText error={error} />
    </div>
  );
}
