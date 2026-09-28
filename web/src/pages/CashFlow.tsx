import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAccounts, useNetWorthHistory, useUpcoming } from '../lib/api';
import { fmtDate, fmtMonth, money, todayISO } from '../lib/format';
import { LIQUID_KINDS, SOURCE_LABEL, type Currency, type UpcomingItem } from '../lib/types';
import { Empty, Money } from '../components/ui';

const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10);
};
const shortDate = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
const compact = (v: number) => new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 }).format(v);

const signed = (u: UpcomingItem) => (u.direction === 'in' ? u.amount : u.direction === 'out' ? -u.amount : 0);

interface Projection {
  currency: Currency; start: number;
  points: { date: string; balance: number }[];
  at: Record<30 | 60 | 90, number>;
  inflow: number; outflow: number; low: { date: string; balance: number };
  items: UpcomingItem[];
}

function project(currency: Currency, start: number, items: UpcomingItem[]): Projection {
  const today = todayISO();
  const byDay = new Map<string, number>();
  for (const u of items) {
    const d = u.due_date < today ? today : u.due_date;   // gecikmişler bugün ödenecekmiş gibi
    byDay.set(d, (byDay.get(d) ?? 0) + signed(u));
  }
  let bal = start;
  const points: Projection['points'] = [];
  const at = { 30: 0, 60: 0, 90: 0 } as Projection['at'];
  let low = { date: today, balance: start };
  for (let i = 0; i <= 90; i++) {
    const d = addDays(today, i);
    bal += byDay.get(d) ?? 0;
    points.push({ date: d, balance: Math.round(bal * 100) / 100 });
    if (bal < low.balance) low = { date: d, balance: bal };
    if (i === 30 || i === 60 || i === 90) at[i] = bal;
  }
  return {
    currency, start, points, at, low, items,
    inflow: items.filter((u) => u.direction === 'in').reduce((s, u) => s + u.amount, 0),
    outflow: items.filter((u) => u.direction === 'out').reduce((s, u) => s + u.amount, 0),
  };
}

export default function CashFlow() {
  const accounts = useAccounts().data ?? [];
  const upcoming = useUpcoming(90).data ?? [];
  const history = useNetWorthHistory(12).data ?? [];

  const projections = useMemo(() => {
    const ccys = new Set<Currency>([
      ...accounts.filter((a) => LIQUID_KINDS.includes(a.kind) && !a.archived_at).map((a) => a.currency),
      ...upcoming.map((u) => u.currency),
    ]);
    return [...ccys].map((c) => project(c,
      accounts.filter((a) => a.currency === c && LIQUID_KINDS.includes(a.kind)).reduce((s, a) => s + a.balance, 0),
      upcoming.filter((u) => u.currency === c)));
  }, [accounts, upcoming]);

  const historyByCcy = useMemo(() => {
    const m = new Map<string, { month: string; net: number; assets: number; debt: number }[]>();
    for (const h of history) {
      const arr = m.get(h.currency) ?? [];
      arr.push({ month: h.month_end, net: h.net_worth, assets: h.assets + h.receivables, debt: h.liabilities });
      m.set(h.currency, arr);
    }
    return m;
  }, [history]);

  return (
    <div className="page">
      <header className="page-head"><h1>Nakit akışı</h1></header>
      <p className="muted lede">Başlangıç: banka, nakit ve birikim hesaplarındaki bugünkü para. Üzerine planlı gelirler, düzenli işlemler, kredi taksitleri, kart ekstreleri ve borç/alacak vadeleri eklenir. Gecikmiş kalemler bugüne yazılır.</p>

      {projections.length === 0 && <Empty title="Hesap tanımlı değil" />}

      {projections.map((p) => (
        <section key={p.currency} className="panel">
          <div className="panel-head"><h2>{p.currency}</h2>
            {p.low.balance < 0 && <span className="tag tag-overdue">{fmtDate(p.low.date)} tarihinde eksiye düşüyor</span>}
          </div>
          <div className="horizon">
            <div><span className="muted small">Bugün</span><Money value={p.start} currency={p.currency} tone={p.start < 0 ? 'out' : undefined} /></div>
            {([30, 60, 90] as const).map((d) => (
              <div key={d}><span className="muted small">{d} gün sonra</span>
                <Money value={p.at[d]} currency={p.currency} tone={p.at[d] < 0 ? 'out' : undefined} />
                <span className="small"><Money value={p.at[d] - p.start} currency={p.currency} signed tone="auto" /></span>
              </div>
            ))}
            <div><span className="muted small">En düşük nokta</span><Money value={p.low.balance} currency={p.currency} tone={p.low.balance < 0 ? 'out' : undefined} /><span className="muted small">{fmtDate(p.low.date)}</span></div>
          </div>
          <div className="chart">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={p.points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: 'var(--muted)' }} interval={14} />
                <YAxis tickFormatter={compact} tick={{ fontSize: 11, fill: 'var(--muted)' }} width={52} />
                <ReferenceLine y={0} stroke="var(--debt)" strokeDasharray="4 4" />
                <Tooltip formatter={(v: number) => money(v, p.currency)} labelFormatter={(l: string) => fmtDate(l)}
                  contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8 }} />
                <Line type="stepAfter" dataKey="balance" name="Tahmini bakiye" stroke="var(--asset)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="small">90 gün: giriş <Money value={p.inflow} currency={p.currency} tone="in" /> · çıkış <Money value={p.outflow} currency={p.currency} tone="out" /></p>
          <details>
            <summary className="small">Kalemleri göster ({p.items.length})</summary>
            <ul className="acc-list small">
              {p.items.map((u) => (
                <li key={u.source_type + u.ref_id + u.due_date}>
                  <span>{fmtDate(u.due_date)} · {u.description} <span className="muted">{SOURCE_LABEL[u.source_type]}</span></span>
                  <Money value={signed(u)} currency={u.currency} signed tone="auto" />
                </li>
              ))}
            </ul>
          </details>
        </section>
      ))}

      <h2 className="section-title">Net varlık gelişimi (12 ay)</h2>
      {[...historyByCcy.entries()].map(([ccy, rows]) => (
        <section key={ccy} className="panel">
          <h2>{ccy}</h2>
          <div className="chart">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="month" tickFormatter={(m: string) => fmtMonth(m).split(' ')[0].slice(0, 3)} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
                <YAxis tickFormatter={compact} tick={{ fontSize: 11, fill: 'var(--muted)' }} width={52} />
                <Tooltip formatter={(v: number) => money(v, ccy)} labelFormatter={(l: string) => fmtMonth(l)}
                  contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8 }} />
                <Line dataKey="assets" name="Varlık + alacak" stroke="var(--asset)" strokeWidth={1.5} dot={false} strokeOpacity={0.5} />
                <Line dataKey="debt" name="Borç" stroke="var(--debt)" strokeWidth={1.5} dot={false} strokeOpacity={0.5} />
                <Line dataKey="net" name="Net varlık" stroke="var(--ink)" strokeWidth={2.5} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      ))}
    </div>
  );
}
