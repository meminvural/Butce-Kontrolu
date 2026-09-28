import { useState } from 'react';
import { rpc, useLedgerMutation } from '../lib/api';
import { fmtDate, fmtDay, money } from '../lib/format';
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

function EntryDetail({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
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
