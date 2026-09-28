import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useCategories, useLedgerMutation } from '../lib/api';
import type { Category } from '../lib/types';
import { ErrorText } from '../components/ui';

async function run(p: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await p;
  if (error) throw new Error(error.message.includes('categories_name_uq') ? 'Bu isimde bir kategori zaten var' : error.message);
}

function AddInline({ kind, parentId, placeholder }: { kind: Category['kind']; parentId: string | null; placeholder: string }) {
  const [name, setName] = useState('');
  const add = useLedgerMutation(() => run(supabase.from('categories').insert({ kind, parent_id: parentId, name: name.trim() })));
  const submit = (e: FormEvent) => { e.preventDefault(); if (name.trim()) add.mutate(undefined, { onSuccess: () => setName('') }); };
  return (
    <form className="inline-input add-inline" onSubmit={submit}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} />
      <button className="btn" disabled={!name.trim() || add.isPending}>Ekle</button>
      <ErrorText error={add.error} />
    </form>
  );
}

function CatItem({ c }: { c: Category }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.name);
  const rename = useLedgerMutation(() => run(supabase.from('categories').update({ name: name.trim() }).eq('id', c.id)));
  const archive = useLedgerMutation(() =>
    run(supabase.from('categories').update({ archived_at: c.archived_at ? null : new Date().toISOString() }).eq('id', c.id)));

  return (
    <div className={`cat-item ${c.archived_at ? 'is-archived' : ''}`}>
      {editing ? (
        <form className="inline-input" onSubmit={(e) => { e.preventDefault(); rename.mutate(undefined, { onSuccess: () => setEditing(false) }); }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn">Kaydet</button>
        </form>
      ) : <span>{c.name}</span>}
      <span className="cat-actions small">
        {!c.system_key && <button className="link-btn" onClick={() => setEditing((v) => !v)}>{editing ? 'Vazgeç' : 'Adını değiştir'}</button>}
        {!c.system_key && <button className="link-btn" onClick={() => archive.mutate(undefined)}>{c.archived_at ? 'Geri al' : 'Arşivle'}</button>}
      </span>
      <ErrorText error={rename.error ?? archive.error} />
    </div>
  );
}

function Tree({ kind, all }: { kind: Category['kind']; all: Category[] }) {
  const cats = all.filter((c) => c.kind === kind);
  const roots = cats.filter((c) => !c.parent_id);
  return (
    <section className="panel">
      <h2>{kind === 'expense' ? 'Gider kategorileri' : 'Gelir kategorileri'}</h2>
      {roots.map((r) => (
        <details key={r.id} className="cat-group" open={false}>
          <summary><CatItem c={r} /></summary>
          <div className="cat-children">
            {cats.filter((c) => c.parent_id === r.id).map((c) => <CatItem key={c.id} c={c} />)}
            {!r.archived_at && <AddInline kind={kind} parentId={r.id} placeholder={`${r.name} altına ekle`} />}
          </div>
        </details>
      ))}
      <AddInline kind={kind} parentId={null} placeholder="Yeni ana kategori" />
    </section>
  );
}

export default function Categories() {
  const { data, error } = useCategories();
  return (
    <div className="page">
      <header className="page-head"><h1>Kategoriler</h1></header>
      <p className="muted lede">Kategoriler iki seviyelidir. Kullanılmış bir kategori silinmez, arşivlenir; geçmiş raporlar bozulmaz.
        Transferler, kart ödemeleri ve alacak tahsilatları kategori almaz, çünkü gelir ya da gider değildir.</p>
      <ErrorText error={error} />
      <div className="grid-2">
        <Tree kind="expense" all={data ?? []} />
        <Tree kind="income" all={data ?? []} />
      </div>
    </div>
  );
}
