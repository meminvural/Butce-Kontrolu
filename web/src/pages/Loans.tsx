import { useMemo, useState, type FormEvent } from 'react';
import { rpc, useAccounts, useLedgerMutation, useLoanInstallments, useLoans } from '../lib/api';
import { fmtDate, money, parseAmount, todayISO } from '../lib/format';
import { CURRENCIES, type Currency, type Loan } from '../lib/types';
import { Empty, ErrorText, Field, Modal, Money } from '../components/ui';

function annuity(p: number, ratePct: number, taxPct: number, n: number) {
  const r = (ratePct / 100) * (1 + taxPct / 100);
  if (!p || !n) return 0;
  return r === 0 ? p / n : (p * r) / (1 - Math.pow(1 + r, -n));
}

function LoanForm({ onClose }: { onClose: () => void }) {
  const accounts = (useAccounts().data ?? []).filter((a) => a.kind === 'bank' && !a.archived_at);
  const [isNew, setIsNew] = useState(true);
  const [name, setName] = useState('');
  const [bank, setBank] = useState('');
  const [currency, setCurrency] = useState<Currency>('TRY');
  const [principal, setPrincipal] = useState('');
  const [rate, setRate] = useState('');
  const [tax, setTax] = useState('30');
  const [term, setTerm] = useState('12');
  const [first, setFirst] = useState('');
  const [start, setStart] = useState(todayISO());
  const [to, setTo] = useState('');
  const [paid, setPaid] = useState('0');

  const preview = annuity(parseAmount(principal) ?? 0, parseAmount(rate) ?? 0, parseAmount(tax) ?? 0, Number(term));
  const save = useLedgerMutation(() => rpc('create_loan', {
    p_name: name, p_institution_name: bank || null, p_currency: currency,
    p_principal: parseAmount(principal), p_monthly_rate: parseAmount(rate) ?? 0, p_term_months: Number(term),
    p_first_payment_date: first, p_tax_pct: parseAmount(tax) ?? 0,
    p_disburse_to_account_id: isNew ? to || null : null, p_start_date: isNew ? start : null,
    p_paid_installments: isNew ? 0 : Number(paid),
  }));
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); };

  return (
    <Modal title="Kredi ekle" onClose={onClose}>
      <div className="segmented">
        <button type="button" className={isNew ? 'active' : ''} onClick={() => setIsNew(true)}>Yeni çektiğim kredi</button>
        <button type="button" className={!isNew ? 'active' : ''} onClick={() => setIsNew(false)}>Ödemekte olduğum kredi</button>
      </div>
      <form className="form" onSubmit={submit}>
        <div className="row-2">
          <Field label="Kredi adı"><input required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="örn. İhtiyaç Kredisi" /></Field>
          <Field label="Banka"><input value={bank} onChange={(e) => setBank(e.target.value)} placeholder="örn. Ziraat Bankası" /></Field>
        </div>
        <div className="row-2">
          <Field label="Kredi tutarı (anapara)"><input inputMode="decimal" required value={principal} onChange={(e) => setPrincipal(e.target.value)} /></Field>
          <Field label="Para birimi">
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
          </Field>
        </div>
        <div className="row-2">
          <Field label="Aylık faiz (%)" hint="Sözleşmedeki aylık oran, örn. 3,29">
            <input inputMode="decimal" required value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Field label="Faize eklenen vergi (%)" hint="Türkiye ihtiyaç kredisi: KKDF 15 + BSMV 15 = 30. Konut: 0.">
            <input inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} />
          </Field>
        </div>
        <div className="row-2">
          <Field label="Vade (ay)"><input type="number" min={1} max={480} required value={term} onChange={(e) => setTerm(e.target.value)} /></Field>
          <Field label="İlk taksit tarihi"><input type="date" required value={first} onChange={(e) => setFirst(e.target.value)} /></Field>
        </div>
        {isNew ? (
          <div className="row-2">
            <Field label="Paranın yattığı hesap" hint="Boş bırakılırsa sadece borç kaydedilir.">
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Seçilmedi</option>
                {accounts.filter((a) => a.currency === currency).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Kullanım tarihi"><input type="date" max={todayISO()} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          </div>
        ) : (
          <Field label="Şimdiye kadar ödenen taksit sayısı" hint="Kalan anapara bu sayıya göre hesaplanır ve bugünkü borç olarak açılır.">
            <input type="number" min={0} max={Number(term) - 1} value={paid} onChange={(e) => setPaid(e.target.value)} />
          </Field>
        )}
        {preview > 0 && <p className="ok small">Hesaplanan aylık taksit: <strong>{money(preview, currency)}</strong> · Toplam geri ödeme ≈ {money(preview * Number(term), currency)}. Bankanın taksitinden birkaç kuruş farklıysa yuvarlamadandır.</p>}
        <ErrorText error={save.error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn btn-primary" disabled={save.isPending}>Krediyi ekle</button>
        </div>
      </form>
    </Modal>
  );
}

function PayModal({ loan, onClose }: { loan: Loan; onClose: () => void }) {
  const accounts = (useAccounts().data ?? []).filter((a) =>
    ['bank', 'cash', 'savings', 'overdraft'].includes(a.kind) && a.currency === loan.currency && !a.archived_at);
  const [from, setFrom] = useState(accounts[0]?.id ?? '');
  const [date, setDate] = useState(todayISO());
  const [key] = useState(() => crypto.randomUUID());
  const pay = useLedgerMutation(() => rpc('pay_loan_installment', {
    p_installment_id: loan.next_id, p_from_account_id: from, p_date: date, p_idempotency_key: key }));
  return (
    <Modal title={`${loan.name} · ${loan.next_no}. taksit`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); pay.mutate(undefined, { onSuccess: onClose }); }}>
        <p className="big-number"><Money value={loan.next_payment} currency={loan.currency} /></p>
        <p className="muted small">Vade {loan.next_due && fmtDate(loan.next_due)}. Anapara kısmı borçtan düşer; yalnızca faiz ve vergi “Kredi Faizi” gideri olarak yazılır.</p>
        <Field label="Ödeme hesabı">
          <select required value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="" disabled>Hesap seçin</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {money(a.balance, a.currency)}</option>)}
          </select>
        </Field>
        <Field label="Ödeme tarihi"><input type="date" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <ErrorText error={pay.error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn btn-primary" disabled={pay.isPending}>Taksidi öde</button>
        </div>
      </form>
    </Modal>
  );
}

function Schedule({ loan }: { loan: Loan }) {
  const rows = useLoanInstallments(loan.id).data ?? [];
  const totals = useMemo(() => rows.reduce((t, r) => ({ i: t.i + r.interest + r.tax, p: t.p + r.payment }), { i: 0, p: 0 }), [rows]);
  return (
    <div className="table-wrap">
      <table className="sum-table schedule">
        <thead><tr><th>#</th><th>Vade</th><th className="num">Taksit</th><th className="num">Anapara</th><th className="num">Faiz</th><th className="num">Vergi</th><th className="num">Kalan</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => {
            const done = r.settled_outside || !!r.paid_entry_id;
            return (
              <tr key={r.id} className={done ? 'muted' : r.id === loan.next_id ? 'row-current' : ''}>
                <td>{r.installment_no}</td>
                <td>{fmtDate(r.due_date)}</td>
                <td className="num">{money(r.payment, loan.currency)}</td>
                <td className="num">{money(r.principal, loan.currency)}</td>
                <td className="num">{money(r.interest, loan.currency)}</td>
                <td className="num">{money(r.tax, loan.currency)}</td>
                <td className="num">{money(r.remaining, loan.currency)}</td>
                <td>{done ? <span className="tag tag-paid">Ödendi</span> : ''}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr><th colSpan={2}>Toplam</th><th className="num">{money(totals.p, loan.currency)}</th><th className="num">{money(loan.principal, loan.currency)}</th><th className="num" colSpan={2}>{money(totals.i, loan.currency)}</th><th colSpan={2} /></tr></tfoot>
      </table>
    </div>
  );
}

export default function Loans() {
  const { data, isSuccess } = useLoans();
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<Loan | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const loans = (data ?? []).filter((l) => !l.archived_at);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Krediler</h1>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>Kredi ekle</button>
      </header>
      {isSuccess && loans.length === 0 && (
        <Empty title="Kredi yok"><p className="muted">Yeni çektiğiniz ya da ödemekte olduğunuz krediyi ekleyin; ödeme planı otomatik çıkar.</p></Empty>
      )}
      {loans.map((l) => (
        <section key={l.id} className="panel">
          <div className="loan-head">
            <div>
              <h2>{l.name}</h2>
              <p className="muted small">{l.institution_name} · %{l.monthly_rate} aylık{l.tax_pct ? ` + %${l.tax_pct} vergi` : ''} · {l.term_months} ay</p>
            </div>
            <div className="loan-kpis">
              <div><span className="muted small">Kalan anapara</span><Money value={l.remaining_principal} currency={l.currency} /></div>
              <div><span className="muted small">Kalan faiz</span><Money value={l.remaining_interest} currency={l.currency} tone="out" /></div>
              <div><span className="muted small">Ödenen</span><span className="money">{l.paid_count} / {l.term_months}</span></div>
            </div>
          </div>
          <div className="progress"><span style={{ width: `${(l.paid_count / l.term_months) * 100}%` }} /></div>
          <div className="loan-next">
            {l.next_id ? (
              <>
                <span>Sıradaki: <strong>{l.next_no}. taksit</strong> · {l.next_due && fmtDate(l.next_due)} · <Money value={l.next_payment} currency={l.currency} /></span>
                <button className="btn btn-primary" onClick={() => setPaying(l)}>Taksidi öde</button>
              </>
            ) : <span className="ok">Kredi kapandı.</span>}
            <button className="link-btn" onClick={() => setOpen(open === l.id ? null : l.id)}>{open === l.id ? 'Planı gizle' : 'Ödeme planı'}</button>
          </div>
          {open === l.id && <Schedule loan={l} />}
        </section>
      ))}
      <p className="field-hint">Erken/ara ödeme için bankadan krediye “Transfer / Ödeme” girin; anapara düşer, faiz gideri oluşmaz. Planı banka yeniden hesaplarsa krediyi arşivleyip yeni planla ekleyin.</p>
      {adding && <LoanForm onClose={() => setAdding(false)} />}
      {paying && <PayModal loan={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}
