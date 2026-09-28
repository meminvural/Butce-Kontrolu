import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAuth } from '../lib/auth';
import {
  fetchAllEntries, useAccounts, useBudgetStatus, useCardOverview, useCategoryMonthly, useLoans,
  useMonthRange, useNetPosition, useUpcoming,
} from '../lib/api';
import { downloadCSV } from '../lib/export';
import { fmtDate, fmtMonth, money, monthStartISO } from '../lib/format';
import { ACCOUNT_KIND_LABEL, ENTRY_KIND_LABEL, SOURCE_LABEL, type Entry } from '../lib/types';
import { shiftMonth } from './Budget';
import { describe } from '../components/EntryList';
import { Money } from '../components/ui';

const pct = (a: number, b: number) => (b ? `%${(a / b * 100).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}` : '—');

function exportEntries(name: string, rows: Entry[]) {
  const flat = rows.flatMap((e) => e.lines.filter((l) => !l.is_system).map((l) => ({ e, l })));
  downloadCSV(name, flat, [
    { header: 'Tarih', value: ({ e }) => e.entry_date },
    { header: 'Tür', value: ({ e }) => ENTRY_KIND_LABEL[e.kind] },
    { header: 'Durum', value: ({ e }) => (e.status === 'reversed' ? 'İptal edildi' : 'Geçerli') },
    { header: 'Açıklama', value: ({ e }) => describe(e).title },
    { header: 'Hesap', value: ({ l }) => l.account_name },
    { header: 'Kategori', value: ({ l }) => (l.parent_category_name ? `${l.parent_category_name} › ${l.category_name}` : l.category_name) },
    { header: 'Borç', value: ({ l }) => (l.amount > 0 ? l.amount : null) },
    { header: 'Alacak', value: ({ l }) => (l.amount < 0 ? -l.amount : null) },
    { header: 'Para birimi', value: ({ l }) => l.currency },
    { header: 'Not', value: ({ l }) => l.memo },
    { header: 'Kayıt no', value: ({ e }) => e.id },
  ]);
}

export default function Reports() {
  const { session } = useAuth();
  const [month, setMonth] = useState(monthStartISO());
  const end = new Date(new Date(shiftMonth(month, 1) + 'T12:00:00').getTime() - 86400000).toISOString().slice(0, 10);
  const cats = useCategoryMonthly(month).data ?? [];
  const trend = useMonthRange(shiftMonth(month, -5), month).data ?? [];
  const net = useNetPosition().data ?? [];
  const accounts = useAccounts().data ?? [];
  const cards = useCardOverview().data ?? [];
  const loans = (useLoans().data ?? []).filter((l) => !l.archived_at);
  const budgets = useBudgetStatus(month).data ?? [];
  const upcoming = (useUpcoming(30).data ?? []);
  const [busy, setBusy] = useState(false);

  const currencies = useMemo(() => [...new Set([...cats.map((c) => c.currency), ...net.filter((n) => n.assets || n.liabilities).map((n) => n.currency)])], [cats, net]);

  const summary = (ccy: string) => {
    const inc = cats.filter((c) => c.currency === ccy && c.kind === 'income').reduce((s, c) => s + c.total, 0);
    const exp = cats.filter((c) => c.currency === ccy && c.kind === 'expense').reduce((s, c) => s + c.total, 0);
    const byRoot = new Map<string, number>();
    for (const c of cats.filter((c) => c.currency === ccy && c.kind === 'expense')) byRoot.set(c.root_category_name, (byRoot.get(c.root_category_name) ?? 0) + c.total);
    const incomeBy = new Map<string, number>();
    for (const c of cats.filter((c) => c.currency === ccy && c.kind === 'income')) incomeBy.set(c.category_name, (incomeBy.get(c.category_name) ?? 0) + c.total);
    const n = net.find((x) => x.currency === ccy);
    const cardsC = cards.filter((c) => c.currency === ccy);
    const limit = cardsC.reduce((s, c) => s + (c.credit_limit ?? 0), 0);
    const used = cardsC.reduce((s, c) => s + c.owed, 0);
    return { inc, exp, byRoot: [...byRoot.entries()].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]),
      incomeBy: [...incomeBy.entries()].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]), n, limit, used };
  };

  const doExport = async (kind: 'month' | 'all' | 'accounts') => {
    setBusy(true);
    try {
      if (kind === 'accounts') {
        downloadCSV('Hesaplar.csv', accounts, [
          { header: 'Hesap', value: (a) => a.name }, { header: 'Tür', value: (a) => ACCOUNT_KIND_LABEL[a.kind] },
          { header: 'Banka / kişi', value: (a) => a.institution_name ?? a.counterparty_name },
          { header: 'Para birimi', value: (a) => a.currency }, { header: 'Bakiye / borç', value: (a) => a.balance },
          { header: 'Limit', value: (a) => a.credit_limit }, { header: 'Kullanılabilir', value: (a) => a.available_limit },
          { header: 'Arşiv', value: (a) => (a.archived_at ? 'Evet' : '') },
        ]);
      } else {
        const rows = kind === 'month' ? await fetchAllEntries(month, end) : await fetchAllEntries();
        exportEntries(kind === 'month' ? `Islemler-${month.slice(0, 7)}.csv` : 'Islemler-tumu.csv', rows);
      }
    } finally { setBusy(false); }
  };

  const trendData = useMemo(() => {
    const m = new Map<string, Record<string, number | string>>();
    for (const t of trend) {
      const row = m.get(t.month) ?? { month: fmtMonth(t.month).split(' ')[0].slice(0, 3) };
      row[`${t.currency} gelir`] = t.income; row[`${t.currency} gider`] = t.expense;
      m.set(t.month, row);
    }
    return [...m.values()];
  }, [trend]);
  const mainCcy = currencies[0];

  return (
    <div className="page report">
      <header className="page-head no-print">
        <h1>Raporlar</h1>
        <div className="month-nav">
          <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Önceki ay">‹</button>
          <span>{fmtMonth(month)}</span>
          <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Sonraki ay">›</button>
        </div>
      </header>
      <div className="actions no-print report-actions">
        <button className="btn btn-primary" onClick={() => window.print()}>PDF olarak kaydet / yazdır</button>
        <button className="btn" disabled={busy} onClick={() => doExport('month')}>Bu ayın işlemleri (Excel/CSV)</button>
        <button className="btn" disabled={busy} onClick={() => doExport('all')}>Tüm işlemler (CSV)</button>
        <button className="btn" disabled={busy} onClick={() => doExport('accounts')}>Hesaplar (CSV)</button>
      </div>

      <div className="print-only report-title">
        <h1>Kişisel Finans Raporu · {fmtMonth(month)}</h1>
        <p className="muted small">{session?.user.email} · Oluşturma: {fmtDate(new Date().toISOString().slice(0, 10))}</p>
      </div>

      {currencies.map((ccy) => {
        const s = summary(ccy);
        return (
          <section key={ccy} className="panel">
            <h2>{ccy} · aylık özet</h2>
            <div className="kpis">
              <div><span className="muted small">Gelir</span><Money value={s.inc} currency={ccy} tone="in" /></div>
              <div><span className="muted small">Gider</span><Money value={s.exp} currency={ccy} tone="out" /></div>
              <div><span className="muted small">Net nakit akışı</span><Money value={s.inc - s.exp} currency={ccy} signed tone="auto" /></div>
              <div><span className="muted small">Tasarruf oranı</span><span className="money">{pct(s.inc - s.exp, s.inc)}</span></div>
              <div><span className="muted small">Borç / varlık</span><span className="money">{s.n ? pct(s.n.liabilities, s.n.assets + s.n.receivables) : '—'}</span></div>
              <div><span className="muted small">Kart kullanım oranı</span><span className="money">{pct(s.used, s.limit)}</span></div>
              {s.n && <>
                <div><span className="muted small">Toplam varlık</span><Money value={s.n.assets} currency={ccy} /></div>
                <div><span className="muted small">Toplam alacak</span><Money value={s.n.receivables} currency={ccy} /></div>
                <div><span className="muted small">Toplam borç</span><Money value={s.n.liabilities} currency={ccy} /></div>
                <div><span className="muted small">Net varlık</span><Money value={s.n.net_worth} currency={ccy} /></div>
              </>}
            </div>

            <div className="grid-2 report-grid">
              <div>
                <h3 className="sub-title">Kategori analizi (gider)</h3>
                {s.byRoot.length === 0 ? <p className="muted small">Gider yok.</p> : (
                  <ul className="bar-list">
                    {s.byRoot.map(([name, v]) => (
                      <li key={name}>
                        <span className="bar-label">{name}</span>
                        <span className="bar-track"><span style={{ width: `${(v / s.byRoot[0][1]) * 100}%` }} /></span>
                        <span className="bar-value"><Money value={v} currency={ccy} /> <span className="muted small">{pct(v, s.exp)}</span></span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="sub-title">Gelir kaynakları</h3>
                {s.incomeBy.length === 0 ? <p className="muted small">Gelir yok.</p> : (
                  <ul className="acc-list">
                    {s.incomeBy.map(([name, v]) => <li key={name}><span>{name}</span><Money value={v} currency={ccy} tone="in" /></li>)}
                  </ul>
                )}
              </div>
            </div>
          </section>
        );
      })}

      {mainCcy && trendData.length > 1 && (
        <section className="panel">
          <h2>Son 6 ay · {mainCcy}</h2>
          <div className="chart">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={trendData}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--muted)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--muted)' }} width={56}
                  tickFormatter={(v: number) => new Intl.NumberFormat('tr-TR', { notation: 'compact' }).format(v)} />
                <Tooltip formatter={(v: number) => money(v, mainCcy)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8 }} />
                <Legend />
                <Bar dataKey={`${mainCcy} gelir`} fill="var(--asset)" radius={[3, 3, 0, 0]} />
                <Bar dataKey={`${mainCcy} gider`} fill="var(--debt)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {budgets.length > 0 && (
        <section className="panel">
          <h2>Bütçe</h2>
          <table className="sum-table">
            <thead><tr><th>Kategori</th><th className="num">Bütçe</th><th className="num">Gerçekleşen</th><th className="num">Kalan</th><th className="num">Kullanım</th></tr></thead>
            <tbody>{budgets.map((b) => (
              <tr key={b.budget_id}><td>{b.parent_name ? `${b.parent_name} › ` : ''}{b.category_name}</td>
                <td className="num">{money(b.budget, b.currency)}</td><td className="num">{money(b.actual, b.currency)}</td>
                <td className="num"><Money value={b.remaining} currency={b.currency} tone={b.remaining < 0 ? 'out' : undefined} /></td>
                <td className={`num lvl-text-${b.level}`}>%{b.pct}</td></tr>
            ))}</tbody>
          </table>
        </section>
      )}

      <div className="grid-2">
        <section className="panel">
          <h2>Kredi kartları</h2>
          {cards.length === 0 ? <p className="muted small">Kart yok.</p> : (
            <table className="sum-table">
              <thead><tr><th>Kart</th><th className="num">Borç</th><th className="num">Son ekstre kalan</th><th>Son ödeme</th></tr></thead>
              <tbody>{cards.map((c) => (
                <tr key={c.account_id}><td>{c.name}</td><td className="num">{money(c.owed, c.currency)}</td>
                  <td className="num">{money(c.last_remaining ?? 0, c.currency)}</td><td>{c.last_due ? fmtDate(c.last_due) : '—'}</td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
        <section className="panel">
          <h2>Krediler</h2>
          {loans.length === 0 ? <p className="muted small">Kredi yok.</p> : (
            <table className="sum-table">
              <thead><tr><th>Kredi</th><th className="num">Kalan anapara</th><th className="num">Kalan faiz</th><th>Taksit</th></tr></thead>
              <tbody>{loans.map((l) => (
                <tr key={l.id}><td>{l.name}</td><td className="num">{money(l.remaining_principal, l.currency)}</td>
                  <td className="num">{money(l.remaining_interest, l.currency)}</td><td>{l.paid_count}/{l.term_months}</td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
      </div>

      <section className="panel">
        <h2>Önümüzdeki 30 gün</h2>
        {upcoming.length === 0 ? <p className="muted small">Planlı kalem yok.</p> : (
          <table className="sum-table">
            <thead><tr><th>Tarih</th><th>Kalem</th><th>Tür</th><th className="num">Tutar</th></tr></thead>
            <tbody>{upcoming.map((u) => (
              <tr key={u.source_type + u.ref_id + u.due_date}><td>{fmtDate(u.due_date)}{u.overdue ? ' (gecikmiş)' : ''}</td><td>{u.description}</td>
                <td>{SOURCE_LABEL[u.source_type]}</td>
                <td className="num"><Money value={u.direction === 'out' ? -u.amount : u.amount} currency={u.currency} signed tone={u.direction === 'in' ? 'in' : 'out'} /></td></tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}
