import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { rpc, table, useAccounts, useCategories, useLedgerMutation, useRecurringRules, useUpcoming } from '../lib/api';
import { fmtDate, fmtDay, money, parseAmount, todayISO } from '../lib/format';
import { SOURCE_LABEL, type RecurringRule, type UpcomingItem } from '../lib/types';
import { Empty, ErrorText, Field, Modal, Money } from '../components/ui';

const DIR_LABEL = { in: 'Gelir', out: 'Gider', transfer: 'Transfer' } as const;
const FREQ_LABEL = { weekly: 'Haftalık', monthly: 'Aylık', yearly: 'Yıllık' } as const;

function RealizeModal({ item, onClose }: { item: UpcomingItem; onClose: () => void }) {
  const accounts = (useAccounts().data ?? []).filter((a) =>
    ['bank', 'cash', 'savings', 'credit_card', 'overdraft'].includes(a.kind) && a.currency === item.currency && !a.archived_at);
  const needsCash = item.source_type === 'debt' || item.source_type === 'receivable';
  const [cash, setCash] = useState(needsCash ? accounts.find((a) => a.kind === 'bank')?.id ?? '' : item.account_id ?? '');
  const [amount, setAmount] = useState(String(item.amount).replace('.', ','));
  const [date, setDate] = useState(item.due_date > todayISO() ? todayISO() : item.due_date);
  const go = useLedgerMutation(() => rpc('realize_scheduled_item', {
    p_item_id: item.ref_id, p_cash_account_id: cash || null, p_amount: parseAmount(amount), p_date: date }));
  return (
    <Modal title="Gerçekleşti olarak işle" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); go.mutate(undefined, { onSuccess: onClose }); }}>
        <p><strong>{item.description}</strong> <span className="muted small">· vade {fmtDate(item.due_date)}</span></p>
        <Field label={item.direction === 'in' ? 'Paranın girdiği hesap' : 'Ödemenin yapıldığı hesap'}>
          <select required value={cash} onChange={(e) => setCash(e.target.value)}>
            <option value="" disabled>Hesap seçin</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {money(a.balance, a.currency)}</option>)}
          </select>
        </Field>
        <div className="row-2">
          <Field label="Gerçekleşen tutar"><input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Tarih"><input type="date" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <ErrorText error={go.error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn btn-primary" disabled={go.isPending}>Deftere işle</button>
        </div>
      </form>
    </Modal>
  );
}

function RuleForm({ rule, oneOff, onClose }: { rule?: RecurringRule; oneOff?: boolean; onClose: () => void }) {
  const allAccounts = (useAccounts().data ?? []).filter((a) => !a.archived_at);
  const accounts = allAccounts.filter((a) => !['loan', 'receivable', 'payable', 'fixed_asset'].includes(a.kind));
  const categories = (useCategories().data ?? []).filter((c) => !c.archived_at);
  const [name, setName] = useState(rule?.name ?? '');
  const [direction, setDirection] = useState<RecurringRule['direction']>(rule?.direction ?? 'out');
  const [amount, setAmount] = useState(rule ? String(rule.amount).replace('.', ',') : '');
  const [account, setAccount] = useState(rule?.account_id ?? '');
  const [toAccount, setToAccount] = useState(rule?.to_account_id ?? '');
  const [category, setCategory] = useState(rule?.category_id ?? '');
  const [frequency, setFrequency] = useState<RecurringRule['frequency']>(rule?.frequency ?? 'monthly');
  const [day, setDay] = useState(String(rule?.day_of_month ?? ''));
  const [start, setStart] = useState(rule?.start_date ?? todayISO());
  const [end, setEnd] = useState(rule?.end_date ?? '');
  const cur = accounts.find((a) => a.id === account)?.currency ?? 'TRY';

  const save = useLedgerMutation(async () => {
    const amt = parseAmount(amount);
    if (!amt || amt <= 0) throw new Error('Geçerli bir tutar girin');
    if (oneOff) {
      await table(supabase.from('scheduled_items').insert({
        due_date: start, direction, amount: amt, currency: cur, account_id: account,
        to_account_id: direction === 'transfer' ? toAccount : null,
        category_id: direction === 'transfer' ? null : category || null, description: name, source_type: 'manual',
      }));
      return;
    }
    const row = {
      name, direction, amount: amt, currency: cur, account_id: account,
      to_account_id: direction === 'transfer' ? toAccount : null,
      category_id: direction === 'transfer' ? null : category || null,
      frequency, day_of_month: frequency === 'weekly' ? null : Number(day) || null,
      start_date: start, end_date: end || null,
    };
    if (rule) await table(supabase.from('recurring_rules').update(row).eq('id', rule.id));
    else await table(supabase.from('recurring_rules').insert(row));
    await rpc('materialize_recurring', { p_days: 120 });
  });

  const catKind = direction === 'in' ? 'income' : 'expense';
  const roots = categories.filter((c) => c.kind === catKind && !c.parent_id);
  return (
    <Modal title={oneOff ? 'Tek seferlik planlı kalem' : rule ? 'Düzenli işlemi düzenle' : 'Düzenli işlem ekle'} onClose={onClose}>
      <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
        <div className="segmented">
          {(['out', 'in', 'transfer'] as const).map((d) => (
            <button key={d} type="button" className={direction === d ? 'active' : ''} onClick={() => setDirection(d)}>{DIR_LABEL[d]}</button>
          ))}
        </div>
        <div className="row-2">
          <Field label="Ad"><input required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={direction === 'in' ? 'örn. Maaş' : 'örn. Kira'} /></Field>
          <Field label={`Tutar (${cur})`}><input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        </div>
        <div className="row-2">
          <Field label={direction === 'in' ? 'Hangi hesaba' : 'Hangi hesaptan'}>
            <select required value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="" disabled>Hesap seçin</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
            </select>
          </Field>
          {direction === 'transfer' ? (
            <Field label="Nereye">
              <select required value={toAccount} onChange={(e) => setToAccount(e.target.value)}>
                <option value="" disabled>Hesap seçin</option>
                {allAccounts.filter((a) => a.id !== account).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          ) : (
            <Field label="Kategori">
              <select required value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="" disabled>Kategori seçin</option>
                {roots.map((r) => (
                  <optgroup key={r.id} label={r.name}>
                    <option value={r.id}>{r.name} (genel)</option>
                    {categories.filter((c) => c.parent_id === r.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
          )}
        </div>
        {oneOff ? (
          <Field label="Beklenen tarih"><input type="date" required value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        ) : (
          <>
            <div className="row-2">
              <Field label="Sıklık">
                <select value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringRule['frequency'])}>
                  {(Object.keys(FREQ_LABEL) as RecurringRule['frequency'][]).map((f) => <option key={f} value={f}>{FREQ_LABEL[f]}</option>)}
                </select>
              </Field>
              {frequency !== 'weekly' && (
                <Field label="Ayın günü" hint="31 seçilirse kısa aylarda ayın son günü.">
                  <input type="number" min={1} max={31} value={day} onChange={(e) => setDay(e.target.value)} placeholder="Başlangıç günü" />
                </Field>
              )}
            </div>
            <div className="row-2">
              <Field label="Başlangıç"><input type="date" required value={start} onChange={(e) => setStart(e.target.value)} /></Field>
              <Field label="Bitiş (isteğe bağlı)"><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
            </div>
          </>
        )}
        <ErrorText error={save.error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn btn-primary" disabled={save.isPending}>Kaydet</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Planned() {
  const upcoming = useUpcoming(90).data ?? [];
  const rules = useRecurringRules().data ?? [];
  const accounts = useAccounts().data ?? [];
  const [realizing, setRealizing] = useState<UpcomingItem | null>(null);
  const [editing, setEditing] = useState<RecurringRule | 'new' | 'oneoff' | null>(null);

  const skip = useLedgerMutation((id: string) => table(supabase.from('scheduled_items').update({ status: 'skipped' }).eq('id', id)));
  const toggle = useLedgerMutation((r: RecurringRule) => table(supabase.from('recurring_rules').update({ is_active: !r.is_active }).eq('id', r.id)));
  const remove = useLedgerMutation((r: RecurringRule) => table(supabase.from('recurring_rules').delete().eq('id', r.id)));

  const days: [string, UpcomingItem[]][] = [];
  for (const u of upcoming) {
    const last = days[days.length - 1];
    if (last && last[0] === u.due_date) last[1].push(u); else days.push([u.due_date, [u]]);
  }
  const isScheduled = (u: UpcomingItem) => !['loan_installment', 'card_statement'].includes(u.source_type);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Planlı ve düzenli</h1>
        <div className="actions">
          <button className="btn" onClick={() => setEditing('oneoff')}>Tek seferlik</button>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>Düzenli işlem ekle</button>
        </div>
      </header>

      <section className="panel panel-flush">
        <h2 className="panel-pad">Önümüzdeki 90 gün</h2>
        {days.length === 0 ? <p className="muted panel-pad">Planlı bir kalem yok.</p> : days.map(([d, list]) => (
          <div key={d} className="day-group">
            <h3 className="day-head">{fmtDay(d)}</h3>
            {list.map((u) => (
              <div key={u.source_type + u.ref_id + u.due_date} className={`plan-row ${u.overdue ? 'is-overdue' : ''}`}>
                <span className="entry-main">
                  <span className="entry-title">{u.description}</span>
                  <span className="entry-meta">{u.overdue ? 'Gecikmiş · ' : ''}{SOURCE_LABEL[u.source_type]}{u.account_name ? ` · ${u.account_name}` : ''}</span>
                </span>
                <Money value={u.direction === 'out' ? -u.amount : u.amount} currency={u.currency}
                  signed={u.direction !== 'transfer'} tone={u.direction === 'in' ? 'in' : u.direction === 'out' ? 'out' : 'muted'} />
                <span className="plan-actions small">
                  {isScheduled(u) ? (
                    <>
                      <button className="link-btn" onClick={() => setRealizing(u)}>Gerçekleşti</button>
                      <button className="link-btn muted" onClick={() => skip.mutate(u.ref_id)}>Atla</button>
                    </>
                  ) : <Link to={u.source_type === 'loan_installment' ? '/krediler' : '/kartlar'}>Öde</Link>}
                </span>
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="panel">
        <h2>Düzenli işlemler</h2>
        {rules.length === 0 ? (
          <Empty title="Düzenli işlem yok"><p className="muted">Maaş, kira, internet gibi her ay tekrar eden kalemleri ekleyin; 120 gün ilerisi otomatik planlanır.</p></Empty>
        ) : (
          <ul className="acc-list">
            {rules.map((r) => (
              <li key={r.id} className={r.is_active ? '' : 'is-archived'}>
                <span>{r.name}
                  <span className="muted small"> {FREQ_LABEL[r.frequency]}{r.day_of_month ? `, ayın ${r.day_of_month}'i` : ''} · {accounts.find((a) => a.id === r.account_id)?.name}{!r.is_active && ' · durduruldu'}</span>
                </span>
                <span className="rule-right">
                  <Money value={r.direction === 'out' ? -r.amount : r.amount} currency={r.currency} signed={r.direction !== 'transfer'}
                    tone={r.direction === 'in' ? 'in' : r.direction === 'out' ? 'out' : 'muted'} />
                  <span className="plan-actions small">
                    <button className="link-btn" onClick={() => setEditing(r)}>Düzenle</button>
                    <button className="link-btn" onClick={() => toggle.mutate(r)}>{r.is_active ? 'Durdur' : 'Başlat'}</button>
                    <button className="link-btn muted" onClick={() => { if (confirm(`"${r.name}" silinsin mi? Gerçekleşmiş kayıtlar etkilenmez.`)) remove.mutate(r); }}>Sil</button>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <ErrorText error={skip.error ?? toggle.error ?? remove.error} />
      </section>

      {realizing && <RealizeModal item={realizing} onClose={() => setRealizing(null)} />}
      {editing && <RuleForm rule={typeof editing === 'object' ? editing : undefined} oneOff={editing === 'oneoff'} onClose={() => setEditing(null)} />}
    </div>
  );
}
