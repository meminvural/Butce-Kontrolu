import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAccounts, useCardOverview, useCardSlices, useCardStatements } from '../lib/api';
import { fmtDate } from '../lib/format';
import { STATEMENT_STATUS_LABEL, type CardOverview } from '../lib/types';
import type { LayoutCtx } from '../components/Layout';
import { Empty, Money, UsageBar } from '../components/ui';

function StatusTag({ s }: { s: keyof typeof STATEMENT_STATUS_LABEL | null }) {
  if (!s) return null;
  return <span className={`tag tag-${s}`}>{STATEMENT_STATUS_LABEL[s]}</span>;
}

function CardDetail({ card }: { card: CardOverview }) {
  const { openAdd } = useOutletContext<LayoutCtx>();
  const bank = (useAccounts().data ?? []).find((a) => a.kind === 'bank' && a.currency === card.currency && !a.archived_at);
  const statements = useCardStatements(card.account_id).data ?? [];
  const slices = useCardSlices(card.account_id).data ?? [];
  const today = new Date().toISOString().slice(0, 10);

  // Taksitli alışverişler: kalan dilimler
  const plans = new Map<string, { description: string | null; date: string; count: number; slice: number; left: number; leftAmount: number }>();
  for (const s of slices) {
    const p = plans.get(s.entry_id) ?? { description: s.description, date: s.entry_date, count: s.slice_count, slice: s.amount, left: 0, leftAmount: 0 };
    if (s.billing_date > (card.last_cut ?? today)) { p.left++; p.leftAmount += s.amount; }
    plans.set(s.entry_id, p);
  }
  const pay = (amount: number) => openAdd({ mode: 'transfer', accountId: bank?.id, toAccountId: card.account_id,
    amount, description: `${card.name} ekstre ödemesi` });

  return (
    <>
      {card.last_remaining ? (
        <section className="panel pay-panel">
          <div>
            <p className="muted small">Son ekstre · {card.last_due && `son ödeme ${fmtDate(card.last_due)}`}</p>
            <Money value={card.last_remaining} currency={card.currency} className="big-number" />
            <p className="small">Asgari <Money value={Math.max(0, (card.last_min ?? 0) - (card.last_paid ?? 0))} currency={card.currency} /></p>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => pay(Math.max(0, (card.last_min ?? 0) - (card.last_paid ?? 0)))}>Asgariyi öde</button>
            <button className="btn btn-primary" onClick={() => pay(card.last_remaining ?? 0)}>Tamamını öde</button>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <h2>Ekstreler</h2>
        <div className="table-wrap">
          <table className="sum-table">
            <thead><tr><th>Dönem</th><th>Son ödeme</th><th className="num">Ekstre</th><th className="num">Ödenen</th><th className="num">Kalan</th><th>Durum</th></tr></thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.cut_date} className={s.is_current ? 'row-current' : ''}>
                  <td>{fmtDate(s.period_start)} – {fmtDate(s.cut_date)}</td>
                  <td>{fmtDate(s.due_date)}</td>
                  <td className="num"><Money value={s.statement_amount} currency={card.currency} /></td>
                  <td className="num">{s.is_current ? '' : <Money value={s.paid} currency={card.currency} tone="muted" />}</td>
                  <td className="num">{s.is_current ? '' : <Money value={s.remaining} currency={card.currency} />}</td>
                  <td><StatusTag s={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="field-hint">Açık dönem tutarı, bugün kesilse gelecek ekstredir. Taksitlerin yalnızca o aya düşen dilimi ekstreye girer. Faiz ve gecikme ücretlerini bankanın ekstresine göre “Kart Faizi” gideri olarak bu karttan girin.</p>
      </section>

      <section className="panel">
        <h2>Taksitli alışverişler</h2>
        {plans.size === 0 ? <p className="muted">Devam eden taksit yok.</p> : (
          <ul className="acc-list">
            {[...plans.entries()].map(([id, p]) => (
              <li key={id}>
                <span>{p.description ?? 'Taksitli alışveriş'}
                  <span className="muted small"> {fmtDate(p.date)} · {p.count} × <Money value={p.slice} currency={card.currency} /> · {p.left} taksit kaldı</span>
                </span>
                <Money value={p.leftAmount} currency={card.currency} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function Cards() {
  const { data, isSuccess } = useCardOverview();
  const [selected, setSelected] = useState<string | null>(null);
  const cards = data ?? [];
  const current = cards.find((c) => c.account_id === selected) ?? cards[0];

  if (isSuccess && cards.length === 0) {
    return <div className="page"><h1>Kredi kartları</h1>
      <Empty title="Kart tanımlı değil"><p className="muted">Hesaplar sayfasından “Kredi kartı” türünde hesap açın.</p></Empty></div>;
  }

  return (
    <div className="page">
      <header className="page-head"><h1>Kredi kartları</h1></header>
      <div className="card-tabs" role="tablist">
        {cards.map((c) => (
          <button key={c.account_id} role="tab" aria-selected={current?.account_id === c.account_id}
            className={`card-tab ${current?.account_id === c.account_id ? 'active' : ''}`} onClick={() => setSelected(c.account_id)}>
            <span className="card-tab-name">{c.name}</span>
            <Money value={c.owed} currency={c.currency} />
            {c.credit_limit ? <UsageBar used={c.owed} limit={c.credit_limit} /> : null}
            <span className="muted small">Kullanılabilir <Money value={c.available} currency={c.currency} /></span>
          </button>
        ))}
      </div>
      {current && <CardDetail key={current.account_id} card={current} />}
    </div>
  );
}
