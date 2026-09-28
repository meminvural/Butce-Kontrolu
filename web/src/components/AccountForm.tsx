import { useState, type FormEvent } from 'react';
import { rpc, useLedgerMutation } from '../lib/api';
import { parseAmount, todayISO } from '../lib/format';
import { ACCOUNT_KIND_LABEL, CURRENCIES, isLiability, type AccountKind, type Currency } from '../lib/types';
import { ErrorText, Field, Modal } from './ui';

// Banka kredisi amortisman planıyla birlikte Krediler sayfasından açılır
const KINDS = (Object.keys(ACCOUNT_KIND_LABEL) as AccountKind[]).filter((k) => k !== 'loan');

export default function AccountForm({ onClose, initialKind = 'bank' }: {
  onClose: () => void; initialKind?: AccountKind;
}) {
  const [kind, setKind] = useState<AccountKind>(initialKind);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('TRY');
  const [institution, setInstitution] = useState('');
  const [person, setPerson] = useState('');
  const [opening, setOpening] = useState('');
  const [openedOn, setOpenedOn] = useState(todayISO());
  const [limit, setLimit] = useState('');
  const [statementDay, setStatementDay] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [iban, setIban] = useState('');

  const isPerson = kind === 'receivable' || kind === 'payable';
  const hasLimit = kind === 'credit_card' || kind === 'overdraft';
  const isBanky = !isPerson && kind !== 'cash' && kind !== 'fixed_asset';

  const openingLabel = isLiability(kind)
    ? (kind === 'payable' ? 'Şu anki borcum' : 'Şu anki borç tutarı')
    : kind === 'receivable' ? 'Şu anki alacağım' : kind === 'fixed_asset' ? 'Güncel piyasa değeri' : 'Şu anki bakiye';

  const save = useLedgerMutation(() => rpc('create_account', {
    p_name: name,
    p_kind: kind,
    p_currency: currency,
    p_opening_balance: parseAmount(opening) ?? 0,
    p_opened_on: openedOn,
    p_institution_name: isBanky ? institution || null : null,
    p_counterparty_name: isPerson ? person || name : null,
    p_credit_limit: hasLimit ? parseAmount(limit) : null,
    p_statement_day: kind === 'credit_card' ? Number(statementDay) : null,
    p_due_day: kind === 'credit_card' ? Number(dueDay) : null,
    p_iban_last4: kind === 'bank' || kind === 'savings' ? iban || null : null,
  }));

  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); };

  return (
    <Modal title="Hesap aç" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Hesap türü" hint="Banka kredisini ödeme planıyla birlikte Krediler sayfasından ekleyin.">
          <select value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
            {KINDS.map((k) => <option key={k} value={k}>{ACCOUNT_KIND_LABEL[k]}</option>)}
          </select>
        </Field>

        <div className="row-2">
          <Field label={isPerson ? 'Kişi / kurum' : 'Hesap adı'}>
            <input required autoFocus value={name} onChange={(e) => { setName(e.target.value); if (isPerson) setPerson(e.target.value); }}
              placeholder={isPerson ? 'örn. Ali Yılmaz' : kind === 'credit_card' ? 'örn. Bonus Platinum' : 'örn. Ziraat TL'} />
          </Field>
          <Field label="Para birimi">
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>

        {isBanky && (
          <div className="row-2">
            <Field label="Banka">
              <input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="örn. Garanti BBVA" />
            </Field>
            {(kind === 'bank' || kind === 'savings') && (
              <Field label="IBAN son 4 hane" hint="Tam IBAN saklanmaz.">
                <input inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={iban} onChange={(e) => setIban(e.target.value)} />
              </Field>
            )}
          </div>
        )}

        {hasLimit && (
          <Field label="Limit">
            <input inputMode="decimal" required value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="150.000" />
          </Field>
        )}

        {kind === 'credit_card' && (
          <div className="row-2">
            <Field label="Hesap kesim günü">
              <input type="number" min={1} max={31} required value={statementDay} onChange={(e) => setStatementDay(e.target.value)} />
            </Field>
            <Field label="Son ödeme günü">
              <input type="number" min={1} max={31} required value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
            </Field>
          </div>
        )}

        <div className="row-2">
          <Field label={openingLabel} hint="Bugünkü gerçek tutarı girin; geçmiş hareketleri girmeniz gerekmez.">
            <input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0,00" />
          </Field>
          <Field label="Bu tarih itibarıyla">
            <input type="date" max={todayISO()} value={openedOn} onChange={(e) => setOpenedOn(e.target.value)} />
          </Field>
        </div>

        <ErrorText error={save.error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Açılıyor…' : 'Hesabı aç'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
