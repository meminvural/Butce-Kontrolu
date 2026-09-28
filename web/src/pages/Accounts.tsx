import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { rpc, useAccounts, useLedgerMutation } from '../lib/api';
import { fmtDate, parseAmount, todayISO } from '../lib/format';
import { ACCOUNT_GROUPS, isLiability, type AccountBalance } from '../lib/types';
import AccountForm from '../components/AccountForm';
import { Empty, ErrorText, Field, Modal, Money, UsageBar } from '../components/ui';

function AdjustModal({ account, onClose }: { account: AccountBalance; onClose: () => void }) {
  const [actual, setActual] = useState('');
  const [reason, setReason] = useState('');
  const liab = isLiability(account.kind);
  const target = parseAmount(actual);
  const diff = target === null ? null : target - account.balance;

  const save = useLedgerMutation(() => rpc('adjust_balance', {
    p_account_id: account.id, p_actual_balance: target, p_date: todayISO(), p_reason: reason || null,
  }));
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); };

  return (
    <Modal title={`${account.name} · mutabakat`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted small">Sistemdeki {liab ? 'borç' : 'bakiye'}: <Money value={account.balance} currency={account.currency} />.
          Banka ekstrenizdeki gerçek tutarı girin; fark “Bakiye düzeltme” kaydı olarak deftere işlenir.</p>
        <Field label={liab ? 'Gerçek borç tutarı' : 'Gerçek bakiye'}
          hint={diff !== null && diff !== 0 ? <>Fark: <Money value={diff} currency={account.currency} signed /></> : undefined}>
          <input inputMode="decimal" required autoFocus value={actual} onChange={(e) => setActual(e.target.value)} />
        </Field>
        <Field label="Not">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="örn. Eylül ekstresi mutabakatı" />
        </Field>
        <ErrorText error={save.error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn btn-primary" disabled={save.isPending || !diff}>Düzeltmeyi kaydet</button>
        </div>
      </form>
    </Modal>
  );
}

function PlanModal({ account, onClose }: { account: AccountBalance; onClose: () => void }) {
  const [total, setTotal] = useState(String(account.balance || '').replace('.', ','));
  const [count, setCount] = useState('3');
  const [first, setFirst] = useState(todayISO());
  const save = useLedgerMutation(() => rpc('create_installment_plan', {
    p_account_id: account.id, p_total: parseAmount(total), p_count: Number(count), p_first_date: first,
  }));
  const t = parseAmount(total) ?? 0;
  return (
    <Modal title={`${account.name} · taksit planı`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
        <p className="muted small">{account.kind === 'payable' ? 'Ödeme' : 'Tahsilat'} tarihleri Planlı işlemler ve Takvim'e eklenir;
          her vadede tek tıkla deftere işlenir.</p>
        <Field label="Toplam tutar">
          <input inputMode="decimal" required value={total} onChange={(e) => setTotal(e.target.value)} />
        </Field>
        <div className="row-2">
          <Field label="Taksit sayısı" hint={t && Number(count) ? `Aylık ≈ ${(t / Number(count)).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} ${account.currency}` : undefined}>
            <input type="number" min={1} max={120} required value={count} onChange={(e) => setCount(e.target.value)} />
          </Field>
          <Field label="İlk vade">
            <input type="date" required value={first} onChange={(e) => setFirst(e.target.value)} />
          </Field>
        </div>
        <ErrorText error={save.error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn btn-primary" disabled={save.isPending}>Planı oluştur</button>
        </div>
      </form>
    </Modal>
  );
}

function AccountRow({ a, onAdjust, onPlan }: { a: AccountBalance; onAdjust: () => void; onPlan: () => void }) {
  const archive = useLedgerMutation(async () => {
    const { error } = await supabase.from('accounts')
      .update({ archived_at: a.archived_at ? null : new Date().toISOString() }).eq('id', a.id);
    if (error) throw new Error(error.message);
  });
  const hasLimit = a.credit_limit !== null;
  return (
    <li className={`acc-row ${a.archived_at ? 'is-archived' : ''}`}>
      <div className="acc-row-main">
        <div>
          <strong>{a.name}</strong>
          <span className="muted small">
            {' '}{[a.institution_name, a.iban_last4 && `•••• ${a.iban_last4}`, a.currency].filter(Boolean).join('  ')}
          </span>
        </div>
        <Money value={a.balance} currency={a.currency}
          tone={a.class === 'liability' ? (a.balance > 0 ? 'out' : 'muted') : a.balance < 0 ? 'out' : undefined} />
      </div>
      {hasLimit && (
        <>
          <UsageBar used={a.balance} limit={a.credit_limit!} />
          <div className="muted small acc-row-meta">
            <span>Limit <Money value={a.credit_limit} currency={a.currency} /></span>
            <span>Kullanılabilir <Money value={a.available_limit} currency={a.currency} /></span>
            {a.statement_day && <span>Kesim {a.statement_day} · Son ödeme {a.due_day}</span>}
          </div>
        </>
      )}
      <div className="acc-row-actions small">
        <span className="muted">{a.last_activity ? `Son hareket ${fmtDate(a.last_activity)}` : 'Hareket yok'}</span>
        {(a.kind === 'payable' || a.kind === 'receivable') && !a.archived_at &&
          <button className="link-btn" onClick={onPlan}>Taksit planı</button>}
        <button className="link-btn" onClick={onAdjust} disabled={!!a.archived_at}>
          {a.kind === 'fixed_asset' || a.kind === 'investment' ? 'Değer güncelle' : 'Bakiye düzelt'}
        </button>
        <button className="link-btn" onClick={() => archive.mutate(undefined)}>{a.archived_at ? 'Arşivden çıkar' : 'Arşivle'}</button>
      </div>
      <ErrorText error={archive.error} />
    </li>
  );
}

export default function Accounts() {
  const { data, isLoading, error } = useAccounts();
  const [creating, setCreating] = useState(false);
  const [adjusting, setAdjusting] = useState<AccountBalance | null>(null);
  const [planning, setPlanning] = useState<AccountBalance | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const list = (data ?? []).filter((a) => showArchived || !a.archived_at);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Hesaplar</h1>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>Hesap aç</button>
      </header>
      <ErrorText error={error} />

      {!isLoading && list.length === 0 && (
        <Empty title="Henüz hesap yok">
          <p className="muted">Banka, nakit, kredi kartı, kredi, ek hesap, borç ve alacaklarınızın her biri ayrı bir hesaptır.</p>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>İlk hesabı aç</button>
        </Empty>
      )}

      {ACCOUNT_GROUPS.map((g) => {
        const items = list.filter((a) => g.kinds.includes(a.kind));
        if (!items.length) return null;
        return (
          <section key={g.title} className="panel">
            <h2>{g.title}</h2>
            <ul className="acc-rows">
              {items.map((a) => <AccountRow key={a.id} a={a} onAdjust={() => setAdjusting(a)} onPlan={() => setPlanning(a)} />)}
            </ul>
          </section>
        );
      })}

      {(data ?? []).some((a) => a.archived_at) && (
        <label className="check small">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Arşivlenmiş hesapları göster
        </label>
      )}

      {creating && <AccountForm onClose={() => setCreating(false)} />}
      {adjusting && <AdjustModal account={adjusting} onClose={() => setAdjusting(null)} />}
      {planning && <PlanModal account={planning} onClose={() => setPlanning(null)} />}
    </div>
  );
}
