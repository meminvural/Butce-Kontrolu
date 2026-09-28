import { useMemo, useState, type FormEvent } from 'react';
import { rpc, useAccounts, useCategories, useLedgerMutation } from '../lib/api';
import { money, parseAmount, todayISO } from '../lib/format';
import { ENTRY_KIND_LABEL, previewTransferKind, type AccountBalance, type Category } from '../lib/types';
import { ErrorText, Field, Modal } from './ui';

type Mode = 'expense' | 'income' | 'transfer';

export interface QuickAddPreset {
  mode?: Mode; accountId?: string; toAccountId?: string; amount?: number; description?: string;
}

const MODES: { id: Mode; label: string }[] = [
  { id: 'expense', label: 'Gider' },
  { id: 'income', label: 'Gelir' },
  { id: 'transfer', label: 'Transfer / Ödeme' },
];

/** Gider: kart, ek hesap ve "başkası ödedi" dahil; kredi ve alacak hesabından harcama olmaz */
const canSpendFrom = (a: AccountBalance) => !['loan', 'receivable', 'fixed_asset'].includes(a.kind);
const canEarnInto = (a: AccountBalance) => ['bank', 'cash', 'savings', 'investment'].includes(a.kind);

function CategorySelect({ categories, kind, value, onChange }: {
  categories: Category[]; kind: 'income' | 'expense'; value: string; onChange: (v: string) => void;
}) {
  const active = categories.filter((c) => c.kind === kind && !c.archived_at);
  const roots = active.filter((c) => !c.parent_id);
  return (
    <select required value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>Kategori seçin</option>
      {roots.map((r) => {
        const subs = active.filter((c) => c.parent_id === r.id);
        return subs.length === 0
          ? <option key={r.id} value={r.id}>{r.name}</option>
          : (
            <optgroup key={r.id} label={r.name}>
              <option value={r.id}>{r.name} (genel)</option>
              {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </optgroup>
          );
      })}
    </select>
  );
}

function AccountSelect({ accounts, value, onChange, placeholder }: {
  accounts: AccountBalance[]; value: string; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <select required value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>{placeholder}</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} · {money(a.kind === 'credit_card' || a.kind === 'overdraft' ? a.available_limit : a.balance, a.currency)}
          {a.kind === 'credit_card' || a.kind === 'overdraft' ? ' kullanılabilir' : ''}
        </option>
      ))}
    </select>
  );
}

export default function QuickAdd({ onClose, preset = {} }: { onClose: () => void; preset?: QuickAddPreset }) {
  const accounts = (useAccounts().data ?? []).filter((a) => !a.archived_at);
  const categories = useCategories().data ?? [];

  const [mode, setMode] = useState<Mode>(preset.mode ?? 'expense');
  const [accountId, setAccountId] = useState(preset.accountId ?? '');
  const [toAccountId, setToAccountId] = useState(preset.toAccountId ?? '');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState(preset.amount ? String(preset.amount).replace('.', ',') : '');
  const [installments, setInstallments] = useState('1');
  const [toAmount, setToAmount] = useState('');
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState(preset.description ?? '');
  // Form açıldığında üretilen anahtar: çift tıklama / ağ tekrarı çift kayıt açamaz
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [savedCount, setSavedCount] = useState(0);

  const from = accounts.find((a) => a.id === accountId);
  const to = accounts.find((a) => a.id === toAccountId);
  const crossCcy = mode === 'transfer' && from && to && from.currency !== to.currency;

  const pool = mode === 'expense' ? accounts.filter(canSpendFrom)
    : mode === 'income' ? accounts.filter(canEarnInto) : accounts;

  const preview = useMemo(() => {
    if (mode !== 'transfer' || !from || !to) return null;
    return previewTransferKind(from.kind, to.kind, from.currency === to.currency);
  }, [mode, from, to]);

  const save = useLedgerMutation(async (keepOpen: boolean) => {
    const amt = parseAmount(amount);
    if (!amt || amt <= 0) throw new Error('Geçerli bir tutar girin');
    const common = { p_date: date, p_description: description || null, p_idempotency_key: key };
    if (mode === 'transfer') {
      const toAmt = crossCcy ? parseAmount(toAmount) : null;
      if (crossCcy && !toAmt) throw new Error(`Hedef hesaba giren ${to!.currency} tutarını girin`);
      await rpc('record_transfer', { p_from_account_id: accountId, p_to_account_id: toAccountId,
        p_amount: amt, p_to_amount: toAmt, ...common });
    } else {
      const extra = mode === 'expense' && from?.kind === 'credit_card' ? { p_installments: Number(installments) || 1 } : {};
      await rpc(mode === 'income' ? 'record_income' : 'record_expense',
        { p_account_id: accountId, p_category_id: categoryId, p_amount: amt, ...common, ...extra });
    }
    return keepOpen;
  });

  const submit = (e: FormEvent, keepOpen = false) => {
    e.preventDefault();
    save.mutate(keepOpen, {
      onSuccess: (stay) => {
        if (!stay) return onClose();
        setAmount(''); setToAmount(''); setDescription(''); setInstallments('1');
        setKey(crypto.randomUUID()); setSavedCount((n) => n + 1);
      },
    });
  };

  const switchMode = (m: Mode) => { setMode(m); setCategoryId(''); setToAccountId(''); save.reset(); };
  const rate = crossCcy ? (parseAmount(toAmount) ?? 0) / (parseAmount(amount) || 1) : 0;

  return (
    <Modal title="İşlem ekle" onClose={onClose}>
      <div className="segmented" role="tablist">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={mode === m.id}
            className={mode === m.id ? 'active' : ''} onClick={() => switchMode(m.id)}>{m.label}</button>
        ))}
      </div>

      {accounts.length === 0 ? (
        <p className="muted">Önce Hesaplar sayfasından en az bir hesap açın.</p>
      ) : (
        <form className="form" onSubmit={(e) => submit(e)}>
          <Field label="Tutar">
            <input className="input-amount" inputMode="decimal" autoFocus required placeholder="0,00"
              value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>

          <Field label={mode === 'income' ? 'Hangi hesaba' : mode === 'transfer' ? 'Nereden' : 'Hangi hesaptan'}
            hint={mode === 'expense' && from?.kind === 'credit_card'
              ? 'Kart harcaması gider olarak yazılır. Kartın ödemesini “Transfer / Ödeme” ile yapın; tekrar gider sayılmaz.'
              : undefined}>
            <AccountSelect accounts={pool} value={accountId} onChange={setAccountId} placeholder="Hesap seçin" />
          </Field>

          {mode === 'transfer' ? (
            <>
              <Field label="Nereye"
                hint={preview && <>Bu kayıt: <strong>{ENTRY_KIND_LABEL[preview]}</strong> — gelir veya gider sayılmaz.</>}>
                <AccountSelect accounts={accounts.filter((a) => a.id !== accountId)} value={toAccountId}
                  onChange={setToAccountId} placeholder="Hesap seçin" />
              </Field>
              {crossCcy && (
                <Field label={`Giren tutar (${to!.currency})`}
                  hint={rate > 0 ? `Kur: 1 ${from!.currency} = ${rate.toLocaleString('tr-TR', { maximumFractionDigits: 4 })} ${to!.currency}` : undefined}>
                  <input inputMode="decimal" required placeholder="0,00" value={toAmount}
                    onChange={(e) => setToAmount(e.target.value)} />
                </Field>
              )}
            </>
          ) : (
            <Field label="Kategori">
              <CategorySelect categories={categories} kind={mode} value={categoryId} onChange={setCategoryId} />
            </Field>
          )}

          {mode === 'expense' && from?.kind === 'credit_card' && (
            <Field label="Taksit"
              hint={Number(installments) > 1 && parseAmount(amount)
                ? `${installments} × ${money((parseAmount(amount) ?? 0) / Number(installments), from.currency)} — limitten tamamı düşer, ekstreye ay ay yansır.`
                : 'Tek çekim için 1 bırakın.'}>
              <select value={installments} onChange={(e) => setInstallments(e.target.value)}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 18, 24, 36].map((n) =>
                  <option key={n} value={n}>{n === 1 ? 'Tek çekim' : `${n} taksit`}</option>)}
              </select>
            </Field>
          )}

          <div className="row-2">
            <Field label="Tarih">
              <input type="date" required max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Açıklama">
              <input placeholder="İsteğe bağlı" value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>

          <ErrorText error={save.error} />
          {savedCount > 0 && !save.error && <p className="ok small">{savedCount} işlem kaydedildi.</p>}

          <div className="actions">
            <button type="button" className="btn" disabled={save.isPending} onClick={(e) => { if (e.currentTarget.form?.reportValidity()) submit(e, true); }}>
              Kaydet ve yenisini ekle
            </button>
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              {save.isPending ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
