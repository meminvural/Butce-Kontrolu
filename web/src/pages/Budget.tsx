import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { rpc, table, useBudgetStatus, useCategories, useLedgerMutation, useProfile } from '../lib/api';
import { fmtMonth, monthStartISO, parseAmount } from '../lib/format';
import { CURRENCIES, type BudgetRow, type Currency } from '../lib/types';
import { Empty, ErrorText, Field, Modal, Money } from '../components/ui';

const LEVEL_LABEL = { normal: 'Normal', warning: 'Dikkat', critical: 'Kritik', over: 'Aşıldı' } as const;

export const shiftMonth = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00');
  d.setMonth(d.getMonth() + n, 1);
  return d.toISOString().slice(0, 8) + '01';
};

function BudgetForm({ month, row, onClose }: { month: string; row?: BudgetRow; onClose: () => void }) {
  const categories = (useCategories().data ?? []).filter((c) => c.kind === 'expense' && !c.archived_at);
  const base = useProfile().data?.base_currency ?? 'TRY';
  const [category, setCategory] = useState(row?.category_id ?? '');
  const [amount, setAmount] = useState(row ? String(row.budget).replace('.', ',') : '');
  const [currency, setCurrency] = useState<Currency>(row?.currency ?? base);
  const roots = categories.filter((c) => !c.parent_id);

  const save = useLedgerMutation(async () => {
    const amt = parseAmount(amount);
    if (!amt || amt <= 0) throw new Error('Geçerli bir tutar girin');
    if (row) await table(supabase.from('budgets').update({ amount: amt }).eq('id', row.budget_id));
    else await table(supabase.from('budgets').insert({ period: month, category_id: category, amount: amt, currency }));
  });
  const remove = useLedgerMutation(() => table(supabase.from('budgets').delete().eq('id', row!.budget_id)));

  return (
    <Modal title={row ? `${row.category_name} bütçesi` : 'Bütçe ekle'} onClose={onClose}>
      <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
        {!row && (
          <div className="row-2">
            <Field label="Kategori" hint="Ana kategori bütçesi alt kategorilerin toplamını izler.">
              <select required value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="" disabled>Kategori seçin</option>
                {roots.map((r) => (
                  <optgroup key={r.id} label={r.name}>
                    <option value={r.id}>{r.name} (tümü)</option>
                    {categories.filter((c) => c.parent_id === r.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field label="Para birimi">
              <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
            </Field>
          </div>
        )}
        <Field label={`${fmtMonth(month)} bütçesi`}>
          <input inputMode="decimal" required autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {row && <button type="button" className="btn btn-danger-ghost" onClick={() => remove.mutate(undefined, { onSuccess: onClose })}>Bütçeyi kaldır</button>}
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn btn-primary" disabled={save.isPending}>Kaydet</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Budget() {
  const [month, setMonth] = useState(monthStartISO());
  const { data, isSuccess } = useBudgetStatus(month);
  const profile = useProfile().data;
  const [editing, setEditing] = useState<BudgetRow | 'new' | null>(null);
  const copy = useLedgerMutation(() => rpc<number>('copy_budgets', { p_from: shiftMonth(month, -1), p_to: month }));
  const rows = data ?? [];

  const byCcy = new Map<string, { budget: number; actual: number }>();
  for (const r of rows.filter((r) => r.is_root || !rows.some((x) => x.is_root && x.category_name === r.parent_name))) {
    const t = byCcy.get(r.currency) ?? { budget: 0, actual: 0 };
    t.budget += r.budget; t.actual += r.actual; byCcy.set(r.currency, t);
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Bütçe</h1>
        <div className="month-nav">
          <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Önceki ay">‹</button>
          <span>{fmtMonth(month)}</span>
          <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Sonraki ay">›</button>
        </div>
      </header>

      {[...byCcy.entries()].map(([ccy, t]) => (
        <section key={ccy} className="panel budget-total">
          <div>
            <span className="muted small">Toplam harcama / bütçe · {ccy}</span>
            <p className="big-number"><Money value={t.actual} currency={ccy} /> <span className="muted">/ <Money value={t.budget} currency={ccy} tone="muted" /></span></p>
          </div>
          <div className="budget-bar"><span className={t.actual > t.budget ? 'over' : ''} style={{ width: `${Math.min(100, (t.actual / t.budget) * 100)}%` }} /></div>
        </section>
      ))}

      <section className="panel">
        <div className="panel-head">
          <h2>Kategori bütçeleri</h2>
          <div className="actions">
            {isSuccess && rows.length === 0 && <button className="btn" onClick={() => copy.mutate(undefined)} disabled={copy.isPending}>Geçen aydan kopyala</button>}
            <button className="btn btn-primary" onClick={() => setEditing('new')}>Bütçe ekle</button>
          </div>
        </div>
        <ErrorText error={copy.error} />
        {copy.data === 0 && <p className="muted small">Geçen ay tanımlı bütçe yok.</p>}
        {isSuccess && rows.length === 0 ? (
          <Empty title="Bu ay için bütçe yok"><p className="muted">Kategori bazında aylık limit belirleyin; %{profile?.budget_warn_pct ?? 70}’te dikkat, %{profile?.budget_crit_pct ?? 90}’da kritik uyarısı alırsınız.</p></Empty>
        ) : (
          <ul className="budget-list">
            {rows.map((r) => (
              <li key={r.budget_id}>
                <button className={`budget-row level-${r.level} ${r.is_root ? '' : 'is-sub'}`} onClick={() => setEditing(r)}>
                  <span className="budget-name">{r.parent_name ? <span className="muted">{r.parent_name} › </span> : null}{r.category_name}</span>
                  <span className="budget-nums small">
                    <Money value={r.actual} currency={r.currency} /> / <Money value={r.budget} currency={r.currency} tone="muted" />
                  </span>
                  <span className="budget-bar"><span className={`lvl-${r.level}`} style={{ width: `${Math.min(100, r.pct)}%` }} /></span>
                  <span className={`budget-level small lvl-text-${r.level}`}>
                    %{r.pct} · {LEVEL_LABEL[r.level]} · {r.remaining >= 0 ? 'kalan ' : 'aşım '}
                    <Money value={Math.abs(r.remaining)} currency={r.currency} tone={r.remaining < 0 ? 'out' : undefined} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {editing && <BudgetForm month={month} row={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
