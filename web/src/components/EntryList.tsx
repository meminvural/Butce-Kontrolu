import { useState } from 'react';
import { rpc, useAccounts, useCategories, useLedgerMutation } from '../lib/api';
import { fmtDate, fmtDay, money, parseAmount } from '../lib/format';
import { ENTRY_KIND_LABEL, type Entry, type EntryLine } from '../lib/types';
import { ErrorText, Field, Modal, Money } from './ui';
import Attachments from './Attachments';

const catName = (l: EntryLine) =>
  l.parent_category_name ? `${l.parent_category_name} › ${l.category_name}` : l.category_name ?? '';

export function describe(e: Entry) {
  const acc = e.lines.filter((l) => l.account_id && !l.is_system);
  const cats = e.lines.filter((l) => l.category_id);
  if (cats.length) {
    const c = cats.length > 1 ? `${cats.length} kategori` : catName(cats[0]);
    return { title: e.description || c, meta: `${c} · ${acc.map((a) => a.account_name).join(', ')}` };
  }
  const from = acc.filter((l) => l.amount < 0).map((l) => l.account_name).join(', ');
  const to = acc.filter((l) => l.amount > 0).map((l) => l.account_name).join(', ');
  const route = from && to ? `${from} → ${to}` : from || to;
  return { title: e.description || ENTRY_KIND_LABEL[e.kind], meta: `${ENTRY_KIND_LABEL[e.kind]} · ${route}` };
}

export function entryTone(e: Entry): 'in' | 'out' | 'muted' {
  const base = e.kind === 'reversal' ? null : e.kind;
  if (base === 'income') return 'in';
  if (base === 'expense' || base === 'card_purchase') return 'out';
  return 'muted';
}

const EDITABLE: Entry['kind'][] = ['income', 'expense', 'card_purchase', 'transfer', 'card_payment'];

/** İşlemi düzeltir: eski kayıt iptal edilir, doğrusu aynı anda yazılır (iz kalır). */
function EntryEdit({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const accounts = (useAccounts().data ?? []).filter((a) => !a.archived_at);
  const categories = useCategories().data ?? [];
  const accLines = entry.lines.filter((l) => l.account_id && !l.is_system);
  const catLine = entry.lines.find((l) => l.category_id);
  const isTransfer = entry.kind === 'transfer' || entry.kind === 'card_payment';
  const fromLine = accLines.find((l) => l.amount < 0);
  const toLine = accLines.find((l) => l.amount > 0);

  const [date, setDate] = useState(entry.entry_date);
  const [desc, setDesc] = useState(entry.description ?? '');
  const [amount, setAmount] = useState(String(Math.abs(isTransfer ? fromLine?.amount ?? 0 : catLine?.amount ?? 0)).replace('.', ','));
  const [toAmount, setToAmount] = useState(String(Math.abs(toLine?.amount ?? 0)).replace('.', ','));
  const [account, setAccount] = useState(accLines[0]?.account_id ?? '');
  const [category, setCategory] = useState(catLine?.category_id ?? '');
  const [from, setFrom] = useState(fromLine?.account_id ?? '');
  const [to, setTo] = useState(toLine?.account_id ?? '');

  const catKind = entry.kind === 'income' ? 'income' : 'expense';
  const cats = categories.filter((c) => c.kind === catKind && (!c.archived_at || c.id === category));
  const catLabel = (c: { id: string; name: string; parent_id: string | null }) => {
    const parent = categories.find((x) => x.id === c.parent_id);
    return parent ? `${parent.name} › ${c.name}` : c.name;
  };
  const fromAcc = accounts.find((a) => a.id === from);
  const toAcc = accounts.find((a) => a.id === to);
  const crossCurrency = isTransfer && !!fromAcc && !!toAcc && fromAcc.currency !== toAcc.currency;
  const amt = parseAmount(amount);

  const save = useLedgerMutation(() => rpc('amend_entry', {
    p_entry_id: entry.id,
    p: {
      date, description: desc, amount: amt,
      ...(isTransfer ? { from_account_id: from, to_account_id: to, to_amount: crossCurrency ? parseAmount(toAmount) : null }
                     : { account_id: account, category_id: category }),
    },
  }));

  return (
    <form className="form edit-entry" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
      <p className="small muted">Kayıt silinmez: eskisi iptal edilir, aşağıdaki doğru bilgilerle yenisi yazılır.</p>
      <div className="row-2">
        <Field label="Tarih"><input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={`Tutar${isTransfer && fromAcc ? ` (${fromAcc.currency})` : ''}`}>
          <input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </div>
      {isTransfer ? (
        <>
          <div className="row-2">
            <Field label="Çıkan hesap">
              <select value={from} onChange={(e) => setFrom(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            </Field>
            <Field label="Giren hesap">
              <select value={to} onChange={(e) => setTo(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            </Field>
          </div>
          {crossCurrency && <Field label={`Giren tutar (${toAcc!.currency})`}><input inputMode="decimal" required value={toAmount} onChange={(e) => setToAmount(e.target.value)} /></Field>}
        </>
      ) : (
        <div className="row-2">
          <Field label="Hesap">
            <select value={account} onChange={(e) => setAccount(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          </Field>
          <Field label="Kategori">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>{cats.map((c) => <option key={c.id} value={c.id}>{catLabel(c)}</option>)}</select>
          </Field>
        </div>
      )}
      <Field label="Açıklama"><input value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      <ErrorText error={save.error} />
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
        <button className="btn btn-primary" disabled={save.isPending || !amt || amt <= 0}>{save.isPending ? 'Kaydediliyor…' : 'Düzeltmeyi kaydet'}</button>
      </div>
    </form>
  );
}

function EntryDetail({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(entry.description ?? '');

  const reverse = useLedgerMutation(() => rpc('reverse_entry', { p_entry_id: entry.id, p_reason: reason || null }));
  const rename = useLedgerMutation(() => rpc('update_entry_description', { p_entry_id: entry.id, p_description: desc }));
  const canReverse = entry.status === 'posted' && entry.kind !== 'reversal';

  return (
    <Modal title={ENTRY_KIND_LABEL[entry.kind]} onClose={onClose}>
      <p className="muted">{fmtDate(entry.entry_date)}{entry.status === 'reversed' && ' · iptal edildi'}</p>

      <table className="ledger-table">
        <thead><tr><th>Hesap / kategori</th><th className="num">Borç</th><th className="num">Alacak</th></tr></thead>
        <tbody>
          {entry.lines.map((l, i) => (
            <tr key={i} className={l.is_system ? 'muted' : ''}>
              <td>{l.account_name ?? catName(l)}{l.memo && <span className="muted small"> · {l.memo}</span>}</td>
              <td className="num">{l.amount > 0 ? money(l.amount, l.currency) : ''}</td>
              <td className="num">{l.amount < 0 ? money(-l.amount, l.currency) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="field-hint">Her kayıt çift taraflıdır: borç ve alacak sütunları her para biriminde eşittir.</p>

      {canReverse && EDITABLE.includes(entry.kind) && !editing && (
        <button className="btn" onClick={() => setEditing(true)}>Tutar, tarih, kategori veya hesabı düzelt</button>
      )}
      {canReverse && !EDITABLE.includes(entry.kind) && (
        <p className="field-hint">Bu kayıt türünde tutar düzeltmesi için kaydı iptal edip doğrusunu yeniden girin; açıklamayı aşağıdan değiştirebilirsiniz.</p>
      )}
      {editing && <EntryEdit entry={entry} onClose={() => { setEditing(false); onClose(); }} />}

      <form className="form" onSubmit={(e) => { e.preventDefault(); rename.mutate(undefined); }}>
        <Field label="Açıklama">
          <div className="inline-input">
            <input value={desc} onChange={(e) => setDesc(e.target.value)} />
            <button className="btn" disabled={rename.isPending || desc === (entry.description ?? '')}>Kaydet</button>
          </div>
        </Field>
      </form>
      <ErrorText error={rename.error} />

      {entry.kind !== 'reversal' && <Attachments entryId={entry.id} />}

      {canReverse && (
        <div className="danger-zone">
          {!confirming ? (
            <button className="btn btn-danger-ghost" onClick={() => setConfirming(true)}>İşlemi iptal et</button>
          ) : (
            <form className="form" onSubmit={(e) => { e.preventDefault(); reverse.mutate(undefined, { onSuccess: onClose }); }}>
              <p className="small">Kayıt silinmez; aynı tarihli ters bir kayıt oluşturulur ve bakiyeler eski haline döner. Tutarı yanlışsa iptal edip doğrusunu yeniden girin.</p>
              <Field label="İptal nedeni">
                <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="örn. Tutar yanlış girildi" />
              </Field>
              <ErrorText error={reverse.error} />
              <div className="actions">
                <button type="button" className="btn" onClick={() => setConfirming(false)}>Vazgeç</button>
                <button className="btn btn-danger" disabled={reverse.isPending}>İptal kaydını oluştur</button>
              </div>
            </form>
          )}
        </div>
      )}
    </Modal>
  );
}

export function EntryRow({ entry, onOpen }: { entry: Entry; onOpen: () => void }) {
  const d = describe(entry);
  const tone = entryTone(entry);
  const reversed = entry.status === 'reversed';
  return (
    <button className={`entry-row ${reversed ? 'is-reversed' : ''}`} onClick={onOpen}>
      <span className="entry-main">
        <span className="entry-title">{d.title}</span>
        <span className="entry-meta">{reversed ? 'İptal edildi · ' : ''}{d.meta}</span>
      </span>
      {entry.currency && (
        <Money value={tone === 'out' ? -(entry.amount ?? 0) : entry.amount} currency={entry.currency}
          signed={tone !== 'muted'} tone={reversed ? 'muted' : tone} />
      )}
    </button>
  );
}

export default function EntryList({ entries, groupByDay = true }: { entries: Entry[]; groupByDay?: boolean }) {
  const [open, setOpen] = useState<Entry | null>(null);
  const groups: [string, Entry[]][] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (groupByDay && last && last[0] === e.entry_date) last[1].push(e);
    else groups.push([e.entry_date, [e]]);
  }
  return (
    <>
      {groupByDay ? groups.map(([day, list]) => (
        <section key={day} className="day-group">
          <h3 className="day-head">{fmtDay(day)}</h3>
          {list.map((e) => <EntryRow key={e.id} entry={e} onOpen={() => setOpen(e)} />)}
        </section>
      )) : entries.map((e) => <EntryRow key={e.id} entry={e} onOpen={() => setOpen(e)} />)}
      {open && <EntryDetail entry={open} onClose={() => setOpen(null)} />}
    </>
  );
}
