import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAuth } from '../lib/auth';
import { fetchAllEntries, useNetPosition } from '../lib/api';
import { accountActivity, compareCategories, delta, trend, type CategoryRow } from '../lib/analytics';
import { downloadCSV } from '../lib/export';
import { fmtDate, money } from '../lib/format';
import { GLOSSARY, type Term } from '../lib/glossary';
import { useDebtContext, type DebtContext } from '../lib/useDebtContext';
import { useReportData, type ReportData } from '../lib/useReport';
import { ACCOUNT_KIND_LABEL, ENTRY_KIND_LABEL, type Entry } from '../lib/types';
import { describe } from '../components/EntryList';
import { Lbl } from '../components/Info';
import { CategoryPanel, DebtPanel, FinPanel, HeatPanel, OutlookPanel, TopItemsPanel, TrendPanel, WeekdayPanel } from '../components/panels';
import { DataTable, DeltaChip, DrillModal, Insights, Kpi, PeriodBar, pctText, type Drill } from '../components/ReportUI';
import { Money } from '../components/ui';

const TABS = [
  { id: 'ozet', label: 'Genel özet' },
  { id: 'gider', label: 'Gider analizi' },
  { id: 'gelir', label: 'Gelir' },
  { id: 'borc', label: 'Borç ve faiz' },
  { id: 'karsilastirma', label: 'Dönem karşılaştırma' },
  { id: 'sozluk', label: 'Sözlük' },
  { id: 'disa', label: 'Dışa aktar' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const addDaysISO = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
//  Açılır kategori tablosu (ana → alt), önceki dönemle kıyas
// ---------------------------------------------------------------------------
function CategoryTable({ tree, prevTree, currency, sign = 1, onDrill, subtitle, title }: {
  tree: CategoryRow[]; prevTree?: CategoryRow[]; currency: ReportData['currency']; sign?: 1 | -1; title: string;
  onDrill: (d: Drill) => void; subtitle: string;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const prevRoot = useMemo(() => new Map((prevTree ?? []).map((r) => [r.name, r])), [prevTree]);
  const prevSub = useMemo(() => new Map((prevTree ?? []).flatMap((r) => (r.children ?? []).map((c) => [`${r.name}›${c.name}`, c] as const))), [prevTree]);
  const total = round2(tree.reduce((a, r) => a + r.total, 0));
  void sign;

  const drillRow = (r: CategoryRow, ids: string[]) => onDrill({ title: r.name, subtitle, filter: { categoryIds: ids }, total: r.total, currency });
  const cmp = (cur: number, p?: CategoryRow) => (prevTree ? <DeltaChip d={delta(cur, p?.total ?? 0)} good="down" currency={currency} /> : null);

  return (
    <section className="panel">
      <h2>{title}</h2>
      <p className="chart-note small muted">Satırdaki oka basarak alt kategorileri açın; ada tıklayınca işlemler listelenir.</p>
      {tree.length === 0 ? <p className="muted empty-inline">Bu dönemde kayıt yok.</p> : (
        <div className="table-wrap">
          <table className="sum-table cat-table">
            <thead><tr><th>Kategori</th><th className="num">Tutar</th><th className="num"><Lbl k="category_share">Pay</Lbl></th><th className="num">Kayıt</th>{prevTree && <><th className="num">Önceki</th><th className="num">Fark</th></>}</tr></thead>
            <tbody>
              {tree.map((r) => {
                const subs = (r.children ?? []).filter((c) => c.id !== r.id || (r.children ?? []).length > 1);
                const expandable = subs.length > 0 && !((r.children ?? []).length === 1 && r.children![0].id === r.id);
                const p = prevRoot.get(r.name);
                return [
                  <tr key={r.id} className="cat-root">
                    <th scope="row">
                      {expandable ? <button type="button" className="chev" aria-expanded={open.has(r.id)} aria-label={`${r.name} alt kategorileri`} onClick={() => toggle(r.id)}>{open.has(r.id) ? '▾' : '▸'}</button> : <span className="chev-space" />}
                      <button type="button" className="link-btn" onClick={() => drillRow(r, (r.children ?? []).map((c) => c.id))}>{r.name}</button>
                      {r.isFin && <span className="tag tag-warn">faiz/masraf</span>}
                    </th>
                    <td className="num"><Money value={r.total} currency={currency} /></td>
                    <td className="num muted">{pctText(r.share)}</td>
                    <td className="num muted">{r.count}</td>
                    {prevTree && <><td className="num muted">{money(p?.total ?? 0, currency)}</td><td className="num">{cmp(r.total, p)}</td></>}
                  </tr>,
                  ...(open.has(r.id) ? (r.children ?? []).map((c) => {
                    const pc = prevSub.get(`${r.name}›${c.name}`);
                    return (
                      <tr key={c.id} className="cat-sub">
                        <th scope="row"><span className="chev-space" /><button type="button" className="link-btn" onClick={() => drillRow(c, [c.id])}>{c.id === r.id ? `${c.name} (genel)` : c.name}</button></th>
                        <td className="num"><Money value={c.total} currency={currency} /></td>
                        <td className="num muted">{pctText(c.share)}</td>
                        <td className="num muted">{c.count}</td>
                        {prevTree && <><td className="num muted">{money(pc?.total ?? 0, currency)}</td><td className="num">{cmp(c.total, pc)}</td></>}
                      </tr>
                    );
                  }) : []),
                ];
              })}
            </tbody>
            <tfoot><tr><th>Toplam</th><td className="num">{money(total, currency)}</td><td className="num">%100</td><td className="num" />{prevTree && <><td className="num">{money(prevTree.reduce((a, r) => a + r.total, 0), currency)}</td><td className="num" /></>}</tr></tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
//  Hesap bazında borç tablosu (sıralanabilir)
// ---------------------------------------------------------------------------
type SortKey = 'name' | 'debt' | 'pct' | 'purchases' | 'interest' | 'paid' | 'net';

function AccountTable({ R, D, onDrill }: { R: ReportData; D: DebtContext; onDrill: (d: Drill) => void }) {
  const { currency, period } = R;
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'debt', dir: -1 });
  const act = useMemo(() => new Map(accountActivity(R.lines).map((a) => [a.id, a])), [R.lines]);

  const rows = useMemo(() => D.accounts.filter((a) => a.currency === currency && a.class === 'liability').map((a) => {
    const x = act.get(a.id);
    const purchases = x?.purchases ?? 0, interest = x?.interest ?? 0, paid = x?.paid ?? 0;
    return { id: a.id, name: a.name, kind: a.kind, debt: a.balance, limit: a.credit_limit, pct: a.credit_limit ? (a.balance / a.credit_limit) * 100 : null,
      available: a.available_limit, purchases, interest, paid, net: round2(purchases + interest - paid) };
  }), [D.accounts, currency, act]);

  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const av = a[sort.key] ?? -1, bv = b[sort.key] ?? -1;
    return typeof av === 'string' ? sort.dir * av.localeCompare(String(bv), 'tr') : sort.dir * ((av as number) - (bv as number));
  }), [rows, sort]);

  const tot = (k: 'debt' | 'purchases' | 'interest' | 'paid' | 'net') => round2(rows.reduce((a, r) => a + r[k], 0));
  const th = (k: SortKey, label: string, num = true) => (
    <th className={num ? 'num' : ''} aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-btn" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : -1 }))}>{label}{sort.key === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button>
    </th>
  );

  return (
    <section className="panel">
      <h2>Hesap bazında borç hareketleri <span className="muted small">· {period.label}</span></h2>
      <p className="chart-note small muted">Başlıklara tıklayarak sıralayabilirsiniz. “Net değişim” = alışveriş + faiz − ödeme; artıysa borç büyümüştür.</p>
      {rows.length === 0 ? <p className="muted empty-inline">Borçlu hesap yok.</p> : (
        <div className="table-wrap">
          <table className="sum-table acct-table">
            <thead><tr>{th('name', 'Hesap', false)}{th('debt', 'Güncel borç')}{th('pct', 'Limit kullanımı')}{th('purchases', 'Alışveriş')}{th('interest', 'Faiz ve masraf')}{th('paid', 'Ödeme')}{th('net', 'Net değişim')}</tr></thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  <th scope="row"><button type="button" className="link-btn" onClick={() => onDrill({ title: r.name, subtitle: `${ACCOUNT_KIND_LABEL[r.kind as keyof typeof ACCOUNT_KIND_LABEL] ?? ''} · ${fmtDate(period.from)} – ${fmtDate(period.to)}`, filter: { accountId: r.id, from: period.from, to: period.to } })}>{r.name}</button></th>
                  <td className="num"><Money value={r.debt} currency={currency} /></td>
                  <td className="num">{r.pct === null ? <span className="muted">—</span> : <span className={`pct-${r.pct >= 90 ? 'crit' : r.pct >= 70 ? 'warn' : 'ok'}`}>{pctText(r.pct, 0)}</span>}</td>
                  <td className="num">{money(r.purchases, currency)}</td>
                  <td className="num tone-out">{money(r.interest, currency)}</td>
                  <td className="num tone-in">{money(r.paid, currency)}</td>
                  <td className="num"><Money value={r.net} currency={currency} signed tone={r.net > 0 ? 'out' : r.net < 0 ? 'in' : 'muted'} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th>Toplam</th><td className="num">{money(tot('debt'), currency)}</td><td className="num" /><td className="num">{money(tot('purchases'), currency)}</td><td className="num">{money(tot('interest'), currency)}</td><td className="num">{money(tot('paid'), currency)}</td><td className="num">{money(tot('net'), currency, true)}</td></tr></tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
//  Sekmeler
// ---------------------------------------------------------------------------
function Overview({ R, D, onDrill }: { R: ReportData; D: DebtContext; onDrill: (d: Drill) => void }) {
  const { cur, prev, currency, period } = R;
  const pos = (useNetPosition().data ?? []).find((n) => n.currency === currency);
  const rows: [React.ReactNode, number | null, number | null, 'down' | 'up' | null][] = [
    [<Lbl k="income">Gelir</Lbl>, cur.income, prev?.income ?? null, 'up'],
    [<Lbl k="expense">Gider (toplam)</Lbl>, cur.expense, prev?.expense ?? null, 'down'],
    [<Lbl k="operating_expense">Harcama (faiz hariç)</Lbl>, cur.operating, prev?.operating ?? null, 'down'],
    [<Lbl k="financial_cost">Faiz ve masraflar</Lbl>, cur.fin, prev?.fin ?? null, 'down'],
    [<Lbl k="net_flow">Net nakit akışı</Lbl>, cur.net, prev?.net ?? null, 'up'],
    [<Lbl k="avg_daily">Günlük ortalama harcama</Lbl>, cur.avgDaily, prev?.avgDaily ?? null, 'down'],
    [<Lbl k="avg_ticket">Ortalama işlem tutarı</Lbl>, cur.avgTicket, prev?.avgTicket ?? null, null],
  ];
  const { rows: months } = useMemo(() => trend(R.lines, period.from, period.to), [R.lines, period]);
  const subtitle = `${fmtDate(period.from)} – ${fmtDate(period.to)}`;
  const debtRatio = pos && pos.assets + pos.receivables > 0 ? (pos.liabilities / (pos.assets + pos.receivables)) * 100 : null;

  return (
    <>
      <section className="panel">
        <h2>Dönem göstergeleri <span className="muted small">· {currency}</span></h2>
        <div className="table-wrap">
          <table className="sum-table">
            <thead><tr><th>Gösterge</th><th className="num">Bu dönem</th>{prev && <><th className="num">Önceki</th><th className="num">Fark</th></>}</tr></thead>
            <tbody>
              {rows.map(([label, c, p, good], i) => (
                <tr key={i}><th scope="row">{label}</th><td className="num"><Money value={c} currency={currency} /></td>
                  {prev && <><td className="num muted">{money(p ?? 0, currency)}</td><td className="num">{good && <DeltaChip d={delta(c ?? 0, p ?? 0)} good={good} currency={currency} />}</td></>}</tr>
              ))}
              <tr><th scope="row"><Lbl k="savings_rate">Tasarruf oranı</Lbl></th><td className="num">{cur.savingsRate === null ? '—' : pctText(cur.savingsRate)}</td>{prev && <><td className="num muted">{prev.savingsRate === null ? '—' : pctText(prev.savingsRate)}</td><td /></>}</tr>
              <tr><th scope="row"><Lbl k="interest_share">Faizin gider içindeki payı</Lbl></th><td className="num">{cur.interestShare === null ? '—' : pctText(cur.interestShare)}</td>{prev && <><td className="num muted">{prev.interestShare === null ? '—' : pctText(prev.interestShare)}</td><td /></>}</tr>
              <tr><th scope="row"><Lbl k="interest_vs_payment">Ödemenin faize giden kısmı</Lbl></th><td className="num">{D.debtPayments > 0 ? pctText((cur.fin / D.debtPayments) * 100) : '—'}</td>{prev && <><td /><td /></>}</tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Bugünkü finansal durum <span className="muted small">· {currency}</span></h2>
        <div className="kpi-grid kpi-grid-tight">
          <Kpi term="assets" label="Varlık" value={<Money value={pos?.assets ?? 0} currency={currency} />} />
          <Kpi term="receivables" label="Alacak" value={<Money value={pos?.receivables ?? 0} currency={currency} />} />
          <Kpi term="liabilities" label="Borç" value={<Money value={pos?.liabilities ?? 0} currency={currency} tone="out" />} sub={D.debtByKind.slice(0, 3).map(([k, v]) => `${k === 'credit_card' ? 'Kart' : k === 'overdraft' ? 'Avans' : k === 'loan' ? 'Kredi' : 'Kişisel'} ${money(v, currency)}`).join(' · ')} />
          <Kpi term="net_worth" label="Net varlık" value={<Money value={pos?.net_worth ?? 0} currency={currency} tone={(pos?.net_worth ?? 0) < 0 ? 'out' : undefined} />} />
          <Kpi term="debt_ratio" label="Borç / varlık" value={debtRatio === null ? '—' : pctText(debtRatio, 0)} sub={debtRatio === null ? 'Varlık kaydı yok' : undefined} />
          <Kpi term="card_utilization" label="Limit kullanımı" value={pctText(D.utilPct, 0)} sub={`Kullanılabilir ${money(D.limitSum - D.usedSum, currency)}`} />
        </div>
      </section>

      <section className="panel"><h2>Öne çıkanlar</h2><Insights items={D.insights} /></section>

      <section className="panel">
        <h2>{months.length > 0 && months[0].from === months[0].to ? 'Günlük' : 'Aylık'} döküm</h2>
        <div className="table-wrap">
          <DataTable head={['Dönem', 'Gelir', 'Harcama (faiz hariç)', 'Faiz ve masraf', 'Gider', 'Net']}
            rows={months.map((m) => [m.label, money(m.income, currency), money(m.operating, currency), money(m.fin, currency), money(m.expense, currency), money(m.net, currency, true)])} />
        </div>
      </section>

      <CategoryTable title="Gider kategorileri" tree={R.tree} prevTree={R.prev ? R.prevTree : undefined} currency={currency} onDrill={onDrill} subtitle={subtitle} />

      <section className="panel">
        <h2><Lbl k="upcoming">Önümüzdeki 30 gün</Lbl></h2>
        {D.due.length === 0 ? <p className="muted empty-inline">Planlı ödeme yok.</p> : (
          <ul className="acc-list">
            {D.due.map((u) => (
              <li key={u.source_type + u.ref_id + u.due_date} className={u.overdue ? 'is-overdue' : ''}>
                <span>{fmtDate(u.due_date)} · {u.description}{u.overdue && <span className="muted small"> gecikmiş</span>}</span>
                <Money value={-u.amount} currency={u.currency} signed tone="out" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ExpenseTab({ R, onDrill }: { R: ReportData; onDrill: (d: Drill) => void }) {
  const { period, currency } = R;
  const subtitle = `${fmtDate(period.from)} – ${fmtDate(period.to)}`;
  const heatFrom = period.from < addDaysISO(R.today, -371) ? addDaysISO(R.today, -371) : period.from;
  return (
    <>
      <CategoryTable title="Gider kategorileri (ana ve alt)" tree={R.tree} prevTree={R.prev ? R.prevTree : undefined} currency={currency} onDrill={onDrill} subtitle={subtitle} />
      <div className="grid-2 grid-charts">
        <CategoryPanel tree={R.tree} currency={currency} subtitle={subtitle} onDrill={onDrill} />
        <TopItemsPanel lines={R.lines} currency={currency} subtitle={subtitle} onDrill={onDrill} />
      </div>
      <div className="grid-2 grid-charts">
        <TrendPanel lines={R.lines} from={period.from} to={period.to} currency={currency} selectedKey={null} onPick={() => undefined} />
        <WeekdayPanel lines={R.lines} from={period.from} to={period.to} currency={currency} />
      </div>
      <HeatPanel lines={R.lines} from={heatFrom} to={period.to} today={R.today} currency={currency} onDrill={onDrill} />
    </>
  );
}

function IncomeTab({ R, onDrill }: { R: ReportData; onDrill: (d: Drill) => void }) {
  const { period, currency, cur, prev } = R;
  const subtitle = `${fmtDate(period.from)} – ${fmtDate(period.to)}`;
  return (
    <>
      <div className="kpi-grid">
        <Kpi term="income" label="Toplam gelir" value={<Money value={cur.income} currency={currency} tone="in" />} delta={prev ? <DeltaChip d={delta(cur.income, prev.income)} good="up" currency={currency} label={period.prevLabel} /> : undefined} sub={prev ? `Önceki: ${money(prev.income, currency)}` : undefined} />
        <Kpi term="net_flow" label="Net nakit akışı" value={<Money value={cur.net} currency={currency} signed tone="auto" />} />
        <Kpi term="savings_rate" label="Tasarruf oranı" value={cur.savingsRate === null ? '—' : pctText(cur.savingsRate)} sub={cur.savingsRate === null ? 'Gelir kaydı yok' : undefined} />
      </div>
      {cur.income === 0 && <p className="panel muted">Bu dönemde gelir kaydı yok. Maaş gibi düzenli gelirleri <strong>Planlı ve düzenli</strong> bölümüne eklerseniz gelir raporları ve nakit akışı tahmini otomatik dolar.</p>}
      <CategoryTableIncome R={R} onDrill={onDrill} subtitle={subtitle} />
      <TrendPanel lines={R.lines} from={period.from} to={period.to} currency={currency} selectedKey={null} onPick={() => undefined} />
    </>
  );
}

function CategoryTableIncome({ R, onDrill, subtitle }: { R: ReportData; onDrill: (d: Drill) => void; subtitle: string }) {
  const tree = R.incomeTree;
  const total = round2(tree.reduce((a, r) => a + r.total, 0));
  return (
    <section className="panel">
      <h2>Gelir kaynakları</h2>
      {tree.length === 0 ? <p className="muted empty-inline">Bu dönemde gelir yok.</p> : (
        <div className="table-wrap">
          <table className="sum-table">
            <thead><tr><th>Kaynak</th><th className="num">Tutar</th><th className="num">Pay</th><th className="num">Kayıt</th></tr></thead>
            <tbody>{tree.map((r) => (
              <tr key={r.id}><th scope="row"><button type="button" className="link-btn" onClick={() => onDrill({ title: r.name, subtitle, filter: { categoryIds: (r.children ?? []).map((c) => c.id) }, total: r.total, currency: R.currency })}>{r.name}</button></th>
                <td className="num"><Money value={r.total} currency={R.currency} tone="in" /></td><td className="num muted">{pctText(r.share)}</td><td className="num muted">{r.count}</td></tr>
            ))}</tbody>
            <tfoot><tr><th>Toplam</th><td className="num">{money(total, R.currency)}</td><td className="num">%100</td><td /></tr></tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function DebtTab({ R, D, onDrill, go }: { R: ReportData; D: DebtContext; onDrill: (d: Drill) => void; go: (p: string) => void }) {
  const { currency, cur, period } = R;
  const finPay = D.debtPayments > 0 ? (cur.fin / D.debtPayments) * 100 : null;
  return (
    <>
      <div className="kpi-grid">
        <Kpi term="financial_cost" label="Faiz ve masraflar" value={<Money value={cur.fin} currency={currency} tone={cur.fin > 0 ? 'out' : undefined} />} sub={cur.interestShare !== null ? `Giderin ${pctText(cur.interestShare)}’i` : undefined} />
        <Kpi term="interest_vs_payment" label="Ödemenin faize giden kısmı" value={finPay === null ? '—' : pctText(finPay)} sub={`Dönemdeki borç ödemesi: ${money(D.debtPayments, currency)}`} tone={finPay !== null && finPay >= 25 ? 'bad' : finPay !== null && finPay >= 10 ? 'warn' : undefined} />
        <Kpi term="card_utilization" label="Limit kullanımı" value={pctText(D.utilPct, 0)} sub={`Kullanılabilir ${money(D.limitSum - D.usedSum, currency)}`} tone={D.utilPct >= 90 ? 'bad' : D.utilPct >= 70 ? 'warn' : undefined} />
        <Kpi term="installment_load" label="Sıradaki taksit yükü" value={D.nextInstallment ? <Money value={D.nextInstallment.amount} currency={currency} /> : '—'} sub={D.nextInstallment ? `${D.nextInstallment.month} ayı` : 'Kesinleşmiş taksit yok'} />
        <Kpi term="upcoming" label="Gecikmiş ödeme" value={<Money value={D.overdueTotal} currency={currency} tone={D.overdue.length ? 'out' : undefined} />} sub={`${D.overdue.length} kalem`} tone={D.overdue.length ? 'bad' : undefined} />
      </div>
      <FinPanel lines={R.lines} from={period.from} to={period.to} currency={currency} expense={cur.expense} onDrill={onDrill} />
      <AccountTable R={R} D={D} onDrill={onDrill} />
      <div className="grid-2 grid-charts">
        <DebtPanel accounts={D.accounts} currency={currency} go={go} />
        <OutlookPanel rows={D.outlook} currency={currency} />
      </div>
    </>
  );
}

function CompareTab({ R }: { R: ReportData }) {
  const { period, currency, cur, prev } = R;
  const rows = useMemo(() => compareCategories(R.tree, R.prevTree), [R.tree, R.prevTree]);
  if (!prev || !period.prevFrom || !period.prevTo) return <p className="panel muted">“Tüm zamanlar” seçiliyken karşılaştırılacak bir önceki dönem yoktur. Yukarıdan başka bir dönem seçin.</p>;
  const chart = rows.filter((r) => r.d.abs !== 0).slice(0, 10).map((r) => ({ name: r.name, fark: r.d.abs }));
  return (
    <>
      <section className="panel">
        <h2>{period.label} ve {period.prevLabel}</h2>
        <p className="muted small">{fmtDate(period.from)} – {fmtDate(period.to)} ile {fmtDate(period.prevFrom)} – {fmtDate(period.prevTo)} karşılaştırılıyor. Karşılaştırma dönemi, yukarıda seçtiğiniz döneme göre otomatik belirlenir.</p>
        <div className="kpi-grid kpi-grid-tight">
          {([['Gelir', cur.income, prev.income, 'up'], ['Gider', cur.expense, prev.expense, 'down'], ['Faiz ve masraf', cur.fin, prev.fin, 'down'], ['Net akış', cur.net, prev.net, 'up']] as const).map(([label, c, p, good]) => (
            <div key={label} className="kpi"><span className="kpi-label">{label}</span><span className="kpi-value"><Money value={c} currency={currency} /></span><span className="kpi-delta"><DeltaChip d={delta(c, p)} good={good} currency={currency} /></span><span className="kpi-sub">Önceki: {money(p, currency)}</span></div>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>En büyük değişimler</h2>
        <p className="chart-note small muted">Kırmızı: harcama arttı, yeşil: azaldı (ana kategoriler).</p>
        {chart.length === 0 ? <p className="muted empty-inline">Fark yok.</p> : (
          <div className="chart" role="img" aria-label="Kategori değişimleri">
            <ResponsiveContainer width="100%" height={Math.max(180, chart.length * 32)}>
              <BarChart data={chart} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" horizontal={false} />
                <XAxis type="number" tickFormatter={(v: number) => new Intl.NumberFormat('tr-TR', { notation: 'compact' }).format(v)} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
                <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12, fill: 'var(--ink)' }} />
                <Tooltip formatter={(v: number) => [money(v, currency, true), 'Fark']} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8 }} cursor={{ fill: 'var(--paper)' }} />
                <Bar dataKey="fark" radius={3}>{chart.map((c) => <Cell key={c.name} fill={c.fark > 0 ? 'var(--debt)' : 'var(--asset)'} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Kategori kıyas tablosu</h2>
        <div className="table-wrap">
          <table className="sum-table">
            <thead><tr><th>Kategori</th><th className="num">Bu dönem</th><th className="num">Önceki</th><th className="num">Fark</th><th className="num">Değişim</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.name}><th scope="row">{r.name}</th><td className="num">{money(r.cur, currency)}</td><td className="num muted">{money(r.prev, currency)}</td>
                <td className="num"><Money value={r.d.abs} currency={currency} signed tone={r.d.abs > 0 ? 'out' : r.d.abs < 0 ? 'in' : 'muted'} /></td>
                <td className="num muted">{r.d.pct === null ? 'yeni' : pctText(r.d.pct)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function GlossaryTab() {
  const [q, setQ] = useState('');
  const items = useMemo(() => (Object.entries(GLOSSARY) as [string, Term][]).map(([, t]) => t).filter((t) => {
    const s = q.trim().toLocaleLowerCase('tr-TR');
    return !s || `${t.title} ${t.what} ${t.formula ?? ''} ${t.read ?? ''}`.toLocaleLowerCase('tr-TR').includes(s);
  }), [q]);
  const groups = ['Genel durum', 'Gelir ve gider', 'Borç ve kartlar', 'Analiz'] as const;
  return (
    <>
      <div className="panel">
        <p className="muted small">Ekrandaki her ⓘ simgesi buradaki tanımı gösterir.</p>
        <input type="search" placeholder="Terim ara (örn. faiz, limit, asgari)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Sözlükte ara" />
      </div>
      {groups.map((g) => {
        const list = items.filter((t) => t.group === g);
        if (!list.length) return null;
        return (
          <section key={g} className="panel">
            <h2>{g}</h2>
            <dl className="glossary">
              {list.map((t) => (
                <div key={t.title}>
                  <dt>{t.title}</dt>
                  <dd>{t.what}
                    {t.formula && <span className="gl-row"><em>Hesaplama:</em> <code>{t.formula}</code></span>}
                    {t.read && <span className="gl-row"><em>Nasıl okunur:</em> {t.read}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
      {items.length === 0 && <p className="panel muted">“{q}” için sonuç bulunamadı.</p>}
    </>
  );
}

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

function ExportTab({ R, D }: { R: ReportData; D: DebtContext }) {
  const [busy, setBusy] = useState(false);
  const { period, currency } = R;
  const run = async (fn: () => Promise<void> | void) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  const { rows: months } = useMemo(() => trend(R.lines, period.from, period.to), [R.lines, period]);
  return (
    <section className="panel">
      <h2>Dışa aktarma</h2>
      <p className="muted small">Dosyalar Türkçe Excel ile doğrudan açılır (noktalı virgül ayraçlı CSV).</p>
      <div className="export-grid">
        <div><strong>Seçili dönemin işlemleri</strong><p className="muted small">{fmtDate(period.from)} – {fmtDate(period.to)}</p>
          <button className="btn" disabled={busy} onClick={() => run(async () => exportEntries(`Islemler-${period.from}_${period.to}.csv`, await fetchAllEntries(period.from, period.to)))}>İşlemleri indir</button></div>
        <div><strong>Tüm işlemler</strong><p className="muted small">Yedek olarak</p>
          <button className="btn" disabled={busy} onClick={() => run(async () => exportEntries('Islemler-tumu.csv', await fetchAllEntries()))}>Tümünü indir</button></div>
        <div><strong>Kategori raporu</strong><p className="muted small">{currency} · ana ve alt kategoriler</p>
          <button className="btn" onClick={() => downloadCSV(`Kategoriler-${period.from}_${period.to}.csv`, R.tree.flatMap((r) => [r, ...((r.children ?? []).filter((c) => c.id !== r.id).map((c) => ({ ...c, name: `${r.name} › ${c.name}` })))]),
            [{ header: 'Kategori', value: (r) => r.name }, { header: 'Tutar', value: (r) => r.total }, { header: 'Pay %', value: (r) => r.share }, { header: 'Kayıt', value: (r) => r.count }])}>Kategorileri indir</button></div>
        <div><strong>Dönemsel özet</strong><p className="muted small">{currency} · gelir, gider, faiz</p>
          <button className="btn" onClick={() => downloadCSV(`Ozet-${period.from}_${period.to}.csv`, months,
            [{ header: 'Dönem', value: (m) => m.label }, { header: 'Gelir', value: (m) => m.income }, { header: 'Harcama (faiz hariç)', value: (m) => m.operating }, { header: 'Faiz ve masraf', value: (m) => m.fin }, { header: 'Gider', value: (m) => m.expense }, { header: 'Net', value: (m) => m.net }])}>Özeti indir</button></div>
        <div><strong>Hesaplar</strong><p className="muted small">Güncel bakiye ve limitler</p>
          <button className="btn" onClick={() => downloadCSV('Hesaplar.csv', D.accounts, [
            { header: 'Hesap', value: (a) => a.name }, { header: 'Tür', value: (a) => ACCOUNT_KIND_LABEL[a.kind] }, { header: 'Banka / kişi', value: (a) => a.institution_name ?? a.counterparty_name },
            { header: 'Para birimi', value: (a) => a.currency }, { header: 'Bakiye / borç', value: (a) => a.balance }, { header: 'Limit', value: (a) => a.credit_limit }, { header: 'Kullanılabilir', value: (a) => a.available_limit }])}>Hesapları indir</button></div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
export default function Reports() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: TabId = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as TabId) : 'ozet';
  const R = useReportData();
  const D = useDebtContext(R);
  const [drill, setDrill] = useState<Drill | null>(null);
  const tabLabel = TABS.find((t) => t.id === tab)!.label;

  return (
    <div className="page report">
      <header className="page-head no-print">
        <h1>Raporlar</h1>
        <button className="btn btn-primary" onClick={() => window.print()}>PDF olarak kaydet / yazdır</button>
      </header>

      <div className="print-only report-title">
        <h1>Kişisel Finans Raporu · {tabLabel}</h1>
        <p className="muted small">{R.period.label}: {fmtDate(R.period.from)} – {fmtDate(R.period.to)} · {R.currency} · {session?.user.email} · Oluşturma: {fmtDate(R.today)}</p>
      </div>

      <nav className="tabs no-print" role="tablist" aria-label="Rapor türleri">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setParams(t.id === 'ozet' ? {} : { tab: t.id })}>{t.label}</button>
        ))}
      </nav>

      {tab !== 'sozluk' && (
        <PeriodBar period={R.period} pkey={R.pkey} setPkey={R.setPkey} custom={R.custom} setCustom={R.setCustom}
          currencies={R.currencies} currency={R.currency} setCurrency={R.setCurrency} />
      )}
      {R.isError && <p className="error">Veriler yüklenemedi: {R.error instanceof Error ? R.error.message : String(R.error)}</p>}
      {R.isLoading && <p className="muted" aria-busy="true">Yükleniyor…</p>}

      {tab === 'ozet' && <Overview R={R} D={D} onDrill={setDrill} />}
      {tab === 'gider' && <ExpenseTab R={R} onDrill={setDrill} />}
      {tab === 'gelir' && <IncomeTab R={R} onDrill={setDrill} />}
      {tab === 'borc' && <DebtTab R={R} D={D} onDrill={setDrill} go={navigate} />}
      {tab === 'karsilastirma' && <CompareTab R={R} />}
      {tab === 'sozluk' && <GlossaryTab />}
      {tab === 'disa' && <ExportTab R={R} D={D} />}

      {drill && <DrillModal drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
