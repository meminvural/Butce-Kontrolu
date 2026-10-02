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

function EditAccountModal({ account: a, onClose }: { account: AccountBalance; onClose: () => void }) {
  const isCard = a.kind === 'credit_card';
  const hasLimit = isCard || a.kind === 'overdraft';
  const showLast4 = isCard || a.kind === 'bank' || a.kind === 'savings';
  const liab = isLiability(a.kind);
  const [name, setName] = useState(a.name);
  const [inst, setInst] = useState(a.institution_name ?? '');
  const [last4, setLast4] = useState(a.iban_last4 ?? '');
  const [limit, setLimit] = useState(a.credit_limit === null ? '' : String(a.credit_limit).replace('.', ','));
  const [cut, setCut] = useState(String(a.statement_day ?? ''));
  const [due, setDue] = useState(String(a.due_day ?? ''));
  const [pct, setPct] = useState('');
  const [opening, setOpening] = useState('');
  const [openDate, setOpenDate] = useState('');

  const save = useLedgerMutation(() => rpc('update_account', {
    p_id: a.id,
    p: {
      name, institution_name: inst, iban_last4: last4,
      ...(hasLimit ? { credit_limit: parseAmount(limit) } : {}),
      ...(isCard ? { statement_day: cut || null, due_day: due || null, min_payment_pct: pct ? parseAmount(pct) : null } : {}),
    },
  }));
  const open = useLedgerMutation(() => rpc('set_opening_balance', {
    p_account_id: a.id, p_amount: parseAmount(opening) ?? 0, p_date: openDate || null,
  }));
  const openVal = parseAmount(opening);

  return (
    <Modal title={`${a.name} · düzenle`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }}>
        <Field label="Hesap adı"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="row-2">
          <Field label="Banka / kurum"><input value={inst} onChange={(e) => setInst(e.target.value)} /></Field>
          {showLast4 && <Field label="Son 4 hane" hint={isCard ? 'Ekstreler kartla bu numaradan eşleşir' : undefined}>
            <input maxLength={4} inputMode="numeric" value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))} /></Field>}
        </div>
        {hasLimit && <Field label="Limit"><input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>}
        {isCard && (
          <div className="row-2">
            <Field label="Hesap kesim günü"><input type="number" min={1} max={31} value={cut} onChange={(e) => setCut(e.target.value)} /></Field>
            <Field label="Son ödeme günü"><input type="number" min={1} max={31} value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          </div>
        )}
        {isCard && <Field label="Asgari ödeme oranı (%)" hint="Boş bırakırsanız değişmez"><input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} /></Field>}
        <ErrorText error={save.error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn btn-primary" disabled={save.isPending}>Bilgileri kaydet</button>
        </div>
      </form>

      <form className="form danger-zone" onSubmit={(e) => { e.preventDefault(); open.mutate(undefined, { onSuccess: onClose }); }}>
        <h3>{liab ? 'Devreden / açılış borcunu düzelt' : 'Açılış bakiyesini düzelt'}</h3>
        <p className="small muted">{liab
          ? 'Hesabı açtığınız andaki borç tutarı. Ekstredeki “önceki bakiye” ile tutmuyorsa buradan düzeltin; 0 yazarsanız açılış kaydı kaldırılır.'
          : 'Hesabı açtığınız andaki bakiye. Eski açılış kaydı iptal edilir, yenisi yazılır; 0 yazarsanız kaldırılır.'}</p>
        <div className="row-2">
          <Field label="Tutar"><input inputMode="decimal" required value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" /></Field>
          <Field label="Tarih" hint="Boşsa hesabın açılış tarihi"><input type="date" value={openDate} onChange={(e) => setOpenDate(e.target.value)} /></Field>
        </div>
        <ErrorText error={open.error} />
        <div className="actions"><button className="btn" disabled={open.isPending || openVal === null || openVal < 0}>Açılış bakiyesini uygula</button></div>
      </form>
    </Modal>
  );
}

function AccountRow({ a, onAdjust, onPlan, onEdit }: { a: AccountBalance; onAdjust: () => void; onPlan: () => void; onEdit: () => void }) {
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
        <button className="link-btn" onClick={onEdit}>Düzenle</button>
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
  const [editing, setEditing] = useState<AccountBalance | null>(null);
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
              {items.map((a) => <AccountRow key={a.id} a={a} onAdjust={() => setAdjusting(a)} onPlan={() => setPlanning(a)} onEdit={() => setEditing(a)} />)}
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
      {editing && <EditAccountModal account={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
