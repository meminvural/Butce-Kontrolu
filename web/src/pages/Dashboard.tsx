import { Link, useOutletContext } from 'react-router-dom';
import { useAccounts, useCardOverview, useEntries, useMonthSummary, useNetBase, useNetPosition, useUpcoming } from '../lib/api';
import { fmtDate, fmtMonth, monthStartISO } from '../lib/format';
import { SOURCE_LABEL, type NetPosition } from '../lib/types';
import type { LayoutCtx } from '../components/Layout';
import EntryList from '../components/EntryList';
import { Empty, Money, UsageBar } from '../components/ui';

/** Sayfanın imza öğesi: varlık ve borcu aynı terazide gösteren denge çubuğu */
function BalanceBeam({ p }: { p: NetPosition }) {
  const left = p.assets + p.receivables;
  const total = left + p.liabilities || 1;
  const assetPct = (p.assets / total) * 100;
  const recvPct = (p.receivables / total) * 100;
  const debtPct = (p.liabilities / total) * 100;
  return (
    <article className="beam">
      <header className="beam-head">
        <span className="beam-ccy">{p.currency}</span>
        <span className="beam-label">Net varlık</span>
      </header>
      <Money value={p.net_worth} currency={p.currency} className="beam-net" tone={p.net_worth < 0 ? 'out' : undefined} />
      <div className="beam-bar" aria-hidden>
        <span className="seg seg-asset" style={{ width: `${assetPct}%` }} />
        <span className="seg seg-recv" style={{ width: `${recvPct}%` }} />
        <span className="seg seg-debt" style={{ width: `${debtPct}%` }} />
      </div>
      <dl className="beam-legend">
        <div><dt><i className="dot dot-asset" />Varlık</dt><dd><Money value={p.assets} currency={p.currency} /></dd></div>
        {p.receivables > 0 && (
          <div><dt><i className="dot dot-recv" />Alacak</dt><dd><Money value={p.receivables} currency={p.currency} /></dd></div>
        )}
        <div><dt><i className="dot dot-debt" />Borç</dt><dd><Money value={p.liabilities} currency={p.currency} /></dd></div>
      </dl>
    </article>
  );
}

export default function Dashboard() {
  const { openAdd } = useOutletContext<LayoutCtx>();
  const month = monthStartISO();
  const net = useNetPosition();
  const accounts = useAccounts();
  const summary = useMonthSummary(month);
  const recent = useEntries({ limit: 8 });
  const cardInfo = useCardOverview().data ?? [];
  const upcoming = (useUpcoming(30).data ?? []).filter((u) => u.direction !== 'transfer');
  const base = useNetBase().data ?? [];

  const accs = (accounts.data ?? []).filter((a) => !a.archived_at);
  const liquid = accs.filter((a) => ['bank', 'cash', 'savings', 'investment'].includes(a.kind));
  const positions = (net.data ?? []).filter((p) => p.assets || p.liabilities || p.receivables);
  const baseRows = base.filter((b) => b.assets || b.liabilities || b.receivables);
  const baseCcy = baseRows[0]?.base_currency;
  const missingRate = baseRows.filter((b) => b.rate === null).map((b) => b.currency);
  const baseTotal = baseRows.reduce((s, b) => s + (b.net_in_base ?? 0), 0);

  if (accounts.isSuccess && accs.length === 0) {
    return (
      <div className="page">
        <h1>Hoş geldiniz</h1>
        <Empty title="Başlamak için hesaplarınızı tanımlayın">
          <p className="muted">Banka hesaplarınızı, nakdinizi ve kartlarınızı bugünkü bakiyeleriyle açın. Geçmiş hareketleri girmeniz gerekmez.</p>
          <Link className="btn btn-primary" to="/hesaplar">Hesapları aç</Link>
        </Empty>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Özet</h1>
        <button className="btn btn-primary only-desktop" onClick={() => openAdd()}>+ İşlem ekle</button>
      </header>

      {baseRows.length > 1 && baseCcy && (
        <p className="base-total">
          Toplam net varlık <Money value={baseTotal} currency={baseCcy} className="strong" />
          <span className="muted small">
            {missingRate.length ? ` · ${missingRate.join(', ')} için kur girilmedi (Ayarlar), toplama katılmadı` : ` · ${baseCcy} cinsinden, girilen son kurlarla`}
          </span>
        </p>
      )}

      <section className="beams">
        {positions.map((p) => <BalanceBeam key={p.currency} p={p} />)}
      </section>

      <div className="grid-2">
        <section className="panel">
          <h2>{fmtMonth(month)}</h2>
          {(summary.data ?? []).length === 0 ? <p className="muted">Bu ay henüz gelir veya gider yok.</p> : (
            <table className="sum-table">
              <thead><tr><th /><th className="num">Gelir</th><th className="num">Gider</th><th className="num">Net</th></tr></thead>
              <tbody>
                {summary.data!.map((s) => (
                  <tr key={s.currency}>
                    <th>{s.currency}</th>
                    <td className="num"><Money value={s.income} currency={s.currency} tone="in" /></td>
                    <td className="num"><Money value={s.expense} currency={s.currency} tone="out" /></td>
                    <td className="num"><Money value={s.net} currency={s.currency} signed tone="auto" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <header className="panel-head"><h2>Yaklaşan ödemeler · 30 gün</h2><Link to="/planli" className="small">Tümü</Link></header>
          {upcoming.length === 0 ? <p className="muted">Önümüzdeki 30 günde planlı kalem yok.</p> : (
            <ul className="acc-list">
              {upcoming.slice(0, 7).map((u) => (
                <li key={u.source_type + u.ref_id + u.due_date} className={u.overdue ? 'is-overdue' : ''}>
                  <span>{fmtDate(u.due_date).replace(/ \d{4}$/, '')} · {u.description}
                    <span className="muted small"> {u.overdue ? 'gecikmiş' : SOURCE_LABEL[u.source_type]}</span></span>
                  <Money value={u.direction === 'out' ? -u.amount : u.amount} currency={u.currency} signed tone={u.direction === 'in' ? 'in' : 'out'} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid-2">
        <section className="panel">
          <header className="panel-head"><h2>Kredi kartları</h2><Link to="/kartlar" className="small">Detay</Link></header>
          {cardInfo.length === 0 ? <p className="muted">Kart tanımlı değil.</p> : cardInfo.map((c) => (
            <div key={c.account_id} className="card-line">
              <div className="card-line-top">
                <span>{c.name}</span>
                <Money value={c.owed} currency={c.currency} />
              </div>
              {c.credit_limit ? <UsageBar used={c.owed} limit={c.credit_limit} /> : null}
              <div className="card-line-meta muted small">
                <span>Kullanılabilir <Money value={c.available} currency={c.currency} /></span>
                {c.last_remaining ? <span className={c.last_status === 'overdue' ? 'tone-out' : ''}>
                  Ekstre <Money value={c.last_remaining} currency={c.currency} /> · son ödeme {c.last_due && fmtDate(c.last_due)}</span>
                  : c.next_due && <span>Sonraki son ödeme {fmtDate(c.next_due)}</span>}
              </div>
            </div>
          ))}
        </section>

        <section className="panel">
          <h2>Banka ve nakit</h2>
          <ul className="acc-list">
            {liquid.map((a) => (
              <li key={a.id}>
                <span>{a.name}<span className="muted small"> {a.institution_name}</span></span>
                <Money value={a.balance} currency={a.currency} tone={a.balance < 0 ? 'out' : undefined} />
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="panel recent-panel">
          <header className="panel-head">
            <h2>Son işlemler</h2>
            <Link to="/islemler" className="small">Tümü</Link>
          </header>
          {(recent.data?.rows ?? []).length === 0
            ? <p className="muted">Henüz işlem yok.</p>
            : <EntryList entries={recent.data!.rows} groupByDay={false} />}
        </section>

    </div>
  );
}
