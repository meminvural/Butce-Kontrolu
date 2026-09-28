import { useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  finBreakdown, finByBucket, flattenSubs, heatmap, isFin, limitRows, topItems, trend, weekdayPattern,
  RISK_LABEL, type Bucket, type CategoryRow,
} from '../lib/analytics';
import { fmtDate, money } from '../lib/format';
import { monthShort } from '../lib/period';
import type { AccountBalance, Currency, DebtOutlookRow, LedgerLine } from '../lib/types';
import { ChartCard, DataTable, Heatmap, Seg, pctText, type Drill } from './ReportUI';
import { Money, UsageBar } from './ui';

const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];
const OTHER = 'var(--muted)';
const compact = (v: number) => new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
const round2 = (n: number) => Math.round(n * 100) / 100;

const TIP = { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 13 } as const;
const AXIS = { fontSize: 11, fill: 'var(--muted)' } as const;

export const EMPTY = <p className="muted empty-inline">Bu dönemde gösterilecek veri yok.</p>;

// ===========================================================================
//  Gelir / gider trendi
// ===========================================================================
export function TrendPanel({ lines, from, to, currency, selectedKey, onPick }: {
  lines: LedgerLine[]; from: string; to: string; currency: Currency; selectedKey: string | null; onPick: (b: Bucket | null) => void;
}) {
  const { bucket, rows } = useMemo(() => trend(lines, from, to), [lines, from, to]);
  const [mode, setMode] = useState<'flow' | 'cum'>('flow');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setHidden((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const has = rows.some((r) => r.income || r.expense);
  const dim = (r: Bucket) => (selectedKey && selectedKey !== r.key ? 0.35 : 1);
  const legendFmt = (v: string, e: { dataKey?: unknown }) => <span style={{ color: hidden.has(String(e.dataKey)) ? 'var(--muted)' : 'var(--ink)', textDecoration: hidden.has(String(e.dataKey)) ? 'line-through' : 'none', cursor: 'pointer' }}>{v}</span>;

  return (
    <ChartCard title={bucket === 'day' ? 'Günlük gelir ve gider' : 'Aylık gelir ve gider'}
      note={<>Çubuğa tıklayarak {bucket === 'day' ? 'günü' : 'ayı'} seçin; kategori ve kalem grafikleri o {bucket === 'day' ? 'güne' : 'aya'} göre süzülür. Alttaki adlara tıklayarak seriyi gizleyebilirsiniz.</>}
      actions={<Seg label="Grafik türü" value={mode} onChange={setMode} options={[{ id: 'flow', label: 'Dönemsel' }, { id: 'cum', label: 'Birikimli gider' }]} />}
      table={<DataTable head={['Dönem', 'Gelir', 'Harcama', 'Faiz ve masraf', 'Net']}
        rows={rows.map((r) => [r.label, money(r.income, currency), money(r.operating, currency), money(r.fin, currency), money(r.net, currency, true)])} />}>
      {!has ? EMPTY : (
        <div className="chart" role="img" aria-label="Gelir ve gider grafiği">
          <ResponsiveContainer width="100%" height={280}>
            {mode === 'flow' ? (
              <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} onClick={(s) => { if (!s) onPick(null); }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="label" tick={AXIS} interval="preserveStartEnd" minTickGap={14} />
                <YAxis tickFormatter={compact} tick={AXIS} width={52} />
                <Tooltip formatter={(v: number, n: string) => [money(v, currency), n]} contentStyle={TIP} cursor={{ fill: 'var(--paper)' }} />
                <Legend onClick={(o) => toggle(String(o.dataKey))} formatter={legendFmt} />
                <Bar dataKey="income" name="Gelir" stackId="g" fill="var(--asset)" hide={hidden.has('income')} cursor="pointer" radius={[3, 3, 0, 0]}
                  onClick={(d: unknown) => onPick((d as { payload: Bucket }).payload)}>
                  {rows.map((r) => <Cell key={r.key} fillOpacity={dim(r)} />)}
                </Bar>
                <Bar dataKey="operating" name="Harcama (faiz hariç)" stackId="e" fill="var(--debt)" hide={hidden.has('operating')} cursor="pointer"
                  onClick={(d: unknown) => onPick((d as { payload: Bucket }).payload)}>
                  {rows.map((r) => <Cell key={r.key} fillOpacity={dim(r)} />)}
                </Bar>
                <Bar dataKey="fin" name="Faiz ve masraf" stackId="e" fill="var(--warn)" hide={hidden.has('fin')} cursor="pointer" radius={[3, 3, 0, 0]}
                  onClick={(d: unknown) => onPick((d as { payload: Bucket }).payload)}>
                  {rows.map((r) => <Cell key={r.key} fillOpacity={dim(r)} />)}
                </Bar>
              </ComposedChart>
            ) : (
              <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="label" tick={AXIS} interval="preserveStartEnd" minTickGap={14} />
                <YAxis tickFormatter={compact} tick={AXIS} width={52} />
                <Tooltip formatter={(v: number) => [money(v, currency), 'Birikimli gider']} contentStyle={TIP} />
                <Area type="monotone" dataKey="cumExpense" name="Birikimli gider" stroke="var(--debt)" strokeWidth={2} fill="var(--debt)" fillOpacity={0.15} />
              </AreaChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

// ===========================================================================
//  Gider dağılımı (halka + liste)
// ===========================================================================
interface Slice { name: string; total: number; share: number; count: number; ids: string[]; isFin: boolean; other?: boolean }

export function CategoryPanel({ tree, currency, subtitle, onDrill }: {
  tree: CategoryRow[]; currency: Currency; subtitle?: string; onDrill: (d: Drill) => void;
}) {
  const [level, setLevel] = useState<'root' | 'sub'>('root');
  const total = useMemo(() => round2(tree.reduce((a, r) => a + r.total, 0)), [tree]);

  const slices: Slice[] = useMemo(() => {
    const src = level === 'root' ? tree : flattenSubs(tree);
    const rows: Slice[] = src.map((r) => ({
      name: r.name, total: r.total, share: r.share, count: r.count, isFin: r.isFin,
      ids: level === 'root' ? (r.children ?? []).map((c) => c.id) : [r.id],
    }));
    if (rows.length <= 9) return rows;
    const head = rows.slice(0, 8), rest = rows.slice(8);
    const t = round2(rest.reduce((a, r) => a + r.total, 0));
    return [...head, { name: `Diğer (${rest.length})`, total: t, share: total ? round2((t / total) * 100) : 0, count: rest.reduce((a, r) => a + r.count, 0),
      ids: rest.flatMap((r) => r.ids), isFin: false, other: true }];
  }, [tree, level, total]);

  const color = (s: Slice, i: number) => (s.other ? OTHER : PALETTE[i % PALETTE.length]);
  const pick = (s: Slice) => onDrill({ title: s.name, subtitle, filter: { categoryIds: s.ids }, total: s.total, currency });

  return (
    <ChartCard title="Gider dağılımı" term="category_share"
      note="Halkaya veya listedeki satıra tıklayınca o kategorideki tüm işlemler açılır."
      actions={<Seg label="Kategori düzeyi" value={level} onChange={setLevel} options={[{ id: 'root', label: 'Ana kategori' }, { id: 'sub', label: 'Alt kategori' }]} />}
      table={<DataTable head={['Kategori', 'Tutar', 'Pay', 'Kayıt']} rows={slices.map((s) => [s.name, money(s.total, currency), pctText(s.share), s.count])} />}>
      {slices.length === 0 ? EMPTY : (
        <div className="donut-layout">
          <div className="donut" role="img" aria-label="Gider dağılımı halka grafiği">
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie data={slices} dataKey="total" nameKey="name" innerRadius={66} outerRadius={104} paddingAngle={1} stroke="var(--surface)" cursor="pointer"
                  onClick={(_: unknown, i: number) => pick(slices[i])}>
                  {slices.map((s, i) => <Cell key={s.name} fill={color(s, i)} />)}
                </Pie>
                <Tooltip formatter={(v: number, n: string) => [money(v, currency), n]} contentStyle={TIP} />
              </PieChart>
            </ResponsiveContainer>
            <div className="donut-center" aria-hidden><span className="muted small">Toplam</span><strong>{money(total, currency)}</strong></div>
          </div>
          <ul className="legend-list">
            {slices.map((s, i) => (
              <li key={s.name}>
                <button type="button" className="legend-row" onClick={() => pick(s)}>
                  <i className="swatch" style={{ background: color(s, i) }} />
                  <span className="legend-name">{s.name}{s.isFin && <span className="tag tag-warn">faiz/masraf</span>}</span>
                  <span className="legend-val"><Money value={s.total} currency={currency} /></span>
                  <span className="legend-pct muted small">{pctText(s.share)}</span>
                  <span className="legend-bar" aria-hidden><span style={{ width: `${Math.max(2, s.share)}%`, background: color(s, i) }} /></span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  );
}

// ===========================================================================
//  En çok harcanan kalemler
// ===========================================================================
export function TopItemsPanel({ lines, currency, subtitle, onDrill }: { lines: LedgerLine[]; currency: Currency; subtitle?: string; onDrill: (d: Drill) => void }) {
  const [noFin, setNoFin] = useState(true);
  const items = useMemo(() => topItems(lines, { excludeFin: noFin, limit: 10 }), [lines, noFin]);
  const max = items[0]?.total ?? 1;
  return (
    <ChartCard title="En çok harcanan kalemler" term="top_items"
      note="Aynı açıklamayla yapılan harcamalar birleştirilir. Satıra tıklayınca tek tek işlemler görünür."
      actions={<label className="check small"><input type="checkbox" checked={noFin} onChange={(e) => setNoFin(e.target.checked)} /> Faiz ve masrafları hariç tut</label>}
      table={<DataTable head={['Kalem', 'Tutar', 'Kayıt', 'Kategori']} rows={items.map((i) => [i.label, money(i.total, currency), i.count, i.category])} />}>
      {items.length === 0 ? EMPTY : (
        <ol className="rank-list">
          {items.map((it, i) => (
            <li key={it.label}>
              <button type="button" className="rank-row" onClick={() => onDrill({ title: it.label, subtitle, filter: { descriptions: it.raws }, total: it.total, currency })}>
                <span className="rank-no muted small">{i + 1}</span>
                <span className="rank-name">{it.label}<span className="muted small"> · {it.category}{it.count > 1 ? ` · ${it.count} kez` : ''}</span></span>
                <span className="rank-val"><Money value={it.total} currency={currency} /></span>
                <span className="rank-bar" aria-hidden><span style={{ width: `${(it.total / max) * 100}%` }} /></span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </ChartCard>
  );
}

// ===========================================================================
//  Haftanın günlerine göre harcama
// ===========================================================================
export function WeekdayPanel({ lines, from, to, currency }: { lines: LedgerLine[]; from: string; to: string; currency: Currency }) {
  const [mode, setMode] = useState<'total' | 'avg'>('avg');
  const rows = useMemo(() => weekdayPattern(lines, from, to), [lines, from, to]);
  const key = mode === 'total' ? 'total' : 'avg';
  const max = Math.max(...rows.map((r) => r[key]), 0);
  const has = max > 0;
  return (
    <ChartCard title="Haftanın günlerine göre harcama" term="weekday_pattern" note="Faiz ve masraflar hariçtir."
      actions={<Seg label="Ölçü" value={mode} onChange={setMode} options={[{ id: 'avg', label: 'Günlük ortalama' }, { id: 'total', label: 'Toplam' }]} />}
      table={<DataTable head={['Gün', 'Toplam', 'Günlük ortalama', 'Gün sayısı']} rows={rows.map((r) => [r.name, money(r.total, currency), money(r.avg, currency), r.days])} />}>
      {!has ? EMPTY : (
        <div className="chart" role="img" aria-label="Haftanın günlerine göre harcama">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="name" tickFormatter={(n: string) => n.slice(0, 3)} tick={AXIS} />
              <YAxis tickFormatter={compact} tick={AXIS} width={52} />
              <Tooltip formatter={(v: number) => [money(v, currency), mode === 'avg' ? 'Günlük ortalama' : 'Toplam']} contentStyle={TIP} cursor={{ fill: 'var(--paper)' }} />
              <Bar dataKey={key} radius={[3, 3, 0, 0]}>
                {rows.map((r) => <Cell key={r.dow} fill={r[key] === max ? 'var(--debt)' : 'var(--recv)'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

// ===========================================================================
//  Isı haritası
// ===========================================================================
export function HeatPanel({ lines, from, to, today, currency, onDrill }: {
  lines: LedgerLine[]; from: string; to: string; today: string; currency: Currency; onDrill: (d: Drill) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const h = useMemo(() => heatmap(lines, from, to, today), [lines, from, to, today]);
  return (
    <ChartCard title="Günlük harcama ısı haritası" term="heatmap" note="Her kutu bir gündür; koyu renk yüksek harcama demektir. Faiz ve masraflar hariçtir.">
      {h.max <= 0 ? EMPTY : (
        <Heatmap cells={h.cells} weeks={h.weeks} max={h.max} currency={currency} selected={picked}
          onPick={(d) => { setPicked(d); onDrill({ title: fmtDate(d), filter: { from: d, to: d } }); }} />
      )}
    </ChartCard>
  );
}

// ===========================================================================
//  Faiz ve masraflar
// ===========================================================================
export function FinPanel({ lines, from, to, currency, expense, onDrill }: {
  lines: LedgerLine[]; from: string; to: string; currency: Currency; expense: number; onDrill: (d: Drill) => void;
}) {
  const fb = useMemo(() => finBreakdown(lines), [lines]);
  const { rows, names } = useMemo(() => finByBucket(lines, from, to), [lines, from, to]);
  const ids = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of lines) if (isFin(l) && l.category_name && l.category_id) m.set(l.category_name, l.category_id);
    return m;
  }, [lines]);
  const total = round2(fb.reduce((a, r) => a + r.total, 0));
  return (
    <ChartCard title="Faiz ve masraflar" term="financial_cost"
      note={total > 0 ? <>Bu dönemde toplam <strong>{money(total, currency)}</strong>; giderin {pctText(expense ? (total / expense) * 100 : 0)}’i.</> : undefined}
      table={<DataTable head={['Dönem', ...names, 'Toplam']} rows={rows.map((r) => [String(r.label), ...names.map((n) => money(Number(r[n]), currency)), money(names.reduce((a, n) => a + Number(r[n]), 0), currency)])} />}>
      {fb.length === 0 ? <p className="muted empty-inline">Bu dönemde faiz veya masraf kaydı yok.</p> : (
        <>
          <div className="chart" role="img" aria-label="Faiz ve masraf grafiği">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="label" tick={AXIS} interval="preserveStartEnd" minTickGap={14} />
                <YAxis tickFormatter={compact} tick={AXIS} width={52} />
                <Tooltip formatter={(v: number, n: string) => [money(v, currency), n]} contentStyle={TIP} cursor={{ fill: 'var(--paper)' }} />
                <Legend />
                {names.map((n, i) => <Bar key={n} dataKey={n} stackId="f" fill={PALETTE[(i + 3) % PALETTE.length]} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ul className="acc-list">
            {fb.map((f) => (
              <li key={f.name}>
                <button type="button" className="link-btn" onClick={() => ids.has(f.name) && onDrill({ title: f.name, filter: { categoryIds: [ids.get(f.name)!] }, total: f.total, currency })}>{f.name}</button>
                <span><Money value={f.total} currency={currency} /> <span className="muted small">{pctText(total ? (f.total / total) * 100 : 0)}</span></span>
              </li>
            ))}
          </ul>
        </>
      )}
    </ChartCard>
  );
}

// ===========================================================================
//  Borç dağılımı ve limit kullanımı
// ===========================================================================
const KIND_LABEL: Record<string, string> = { credit_card: 'Kredi kartı', overdraft: 'Ek hesap (Avans)', loan: 'Banka kredisi', payable: 'Kişisel borç' };
const KIND_LINK: Record<string, string> = { credit_card: '/kartlar', overdraft: '/hesaplar', loan: '/krediler', payable: '/hesaplar' };

export function DebtPanel({ accounts, currency, go }: { accounts: AccountBalance[]; currency: Currency; go: (path: string) => void }) {
  const debt = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of accounts) if (a.currency === currency && !a.archived_at && a.class === 'liability' && a.balance > 0) m.set(a.kind, (m.get(a.kind) ?? 0) + a.balance);
    return [...m.entries()].map(([kind, value]) => ({ kind, name: KIND_LABEL[kind] ?? kind, value: round2(value) })).sort((a, b) => b.value - a.value);
  }, [accounts, currency]);
  const total = round2(debt.reduce((a, d) => a + d.value, 0));
  const limits = useMemo(() => limitRows(accounts, currency), [accounts, currency]);
  const usedSum = limits.reduce((a, l) => a + l.used, 0), limitSum = limits.reduce((a, l) => a + l.limit, 0);

  return (
    <ChartCard title="Borç dağılımı ve limit kullanımı" term="card_utilization"
      note="Bir kalemin üzerine tıklayınca ilgili sayfaya gidersiniz. Renk: %70’e kadar normal, %70–90 dikkat, %90 üzeri kritik."
      table={<DataTable head={['Hesap', 'Borç', 'Limit', 'Kullanım', 'Kullanılabilir']} rows={limits.map((l) => [l.name, money(l.used, currency), money(l.limit, currency), pctText(l.pct), money(l.available, currency)])} />}>
      {total === 0 && limits.length === 0 ? <p className="muted empty-inline">Borç veya limitli hesap yok.</p> : (
        <div className="debt-layout">
          <div>
            <div className="donut donut-sm" role="img" aria-label="Borç dağılımı">
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={debt} dataKey="value" nameKey="name" innerRadius={52} outerRadius={82} paddingAngle={2} stroke="var(--surface)" cursor="pointer" onClick={(_: unknown, i: number) => go(KIND_LINK[debt[i].kind] ?? '/hesaplar')}>
                    {debt.map((d, i) => <Cell key={d.kind} fill={PALETTE[i % PALETTE.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number, n: string) => [money(v, currency), n]} contentStyle={TIP} />
                </PieChart>
              </ResponsiveContainer>
              <div className="donut-center" aria-hidden><span className="muted small">Borç</span><strong>{money(total, currency)}</strong></div>
            </div>
            <ul className="legend-list">
              {debt.map((d, i) => (
                <li key={d.kind}><button type="button" className="legend-row" onClick={() => go(KIND_LINK[d.kind] ?? '/hesaplar')}>
                  <i className="swatch" style={{ background: PALETTE[i % PALETTE.length] }} /><span className="legend-name">{d.name}</span>
                  <span className="legend-val"><Money value={d.value} currency={currency} /></span><span className="legend-pct muted small">{pctText(total ? (d.value / total) * 100 : 0)}</span>
                </button></li>
              ))}
            </ul>
          </div>
          <div>
            {limits.length > 0 && <p className="small muted limit-total">Toplam limit kullanımı: <strong>{pctText(limitSum ? (usedSum / limitSum) * 100 : 0)}</strong> ({money(usedSum, currency)} / {money(limitSum, currency)})</p>}
            <ul className="limit-list">
              {limits.map((l) => (
                <li key={l.id}>
                  <button type="button" className={`limit-row risk-${l.risk}`} onClick={() => go(KIND_LINK[l.kind] ?? '/hesaplar')}>
                    <span className="limit-name">{l.name}</span>
                    <span className="limit-pct">{pctText(l.pct, 0)} <span className={`tag tag-risk-${l.risk}`}>{RISK_LABEL[l.risk]}</span></span>
                    <UsageBar used={l.used} limit={l.limit} />
                    <span className="limit-sub muted small">Borç <Money value={l.used} currency={currency} /> · kullanılabilir <Money value={l.available} currency={currency} /></span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </ChartCard>
  );
}

// ===========================================================================
//  Gelecek taksit yükü
// ===========================================================================
export function OutlookPanel({ rows, currency }: { rows: DebtOutlookRow[]; currency: Currency }) {
  const data = useMemo(() => {
    const m = new Map<string, { key: string; label: string; card: number; loan: number }>();
    for (const r of rows.filter((x) => x.currency === currency)) {
      const g = m.get(r.month) ?? { key: r.month, label: `${monthShort(r.month)} ${r.month.slice(2, 4)}`, card: 0, loan: 0 };
      if (r.source === 'card_installment') g.card += r.amount; else g.loan += r.amount;
      m.set(r.month, g);
    }
    return [...m.values()].sort((a, b) => a.key.localeCompare(b.key)).map((g) => ({ ...g, card: round2(g.card), loan: round2(g.loan), total: round2(g.card + g.loan) }));
  }, [rows, currency]);
  return (
    <ChartCard title="Gelecek aylardaki taksit yükü" term="installment_load"
      note="Yeni harcama yapmasanız bile ödemeniz gereken kart taksitleri ve kredi taksitleri."
      table={<DataTable head={['Ay', 'Kart taksiti', 'Kredi taksiti', 'Toplam']} rows={data.map((d) => [d.label, money(d.card, currency), money(d.loan, currency), money(d.total, currency)])} />}>
      {data.length === 0 ? <p className="muted empty-inline">Önümüzdeki aylarda kesinleşmiş taksit yok.</p> : (
        <div className="chart" role="img" aria-label="Gelecek taksit yükü">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" tick={AXIS} />
              <YAxis tickFormatter={compact} tick={AXIS} width={52} />
              <Tooltip formatter={(v: number, n: string) => [money(v, currency), n]} contentStyle={TIP} cursor={{ fill: 'var(--paper)' }} />
              <Legend />
              <Bar dataKey="card" name="Kart taksiti" stackId="o" fill="var(--c2)" />
              <Bar dataKey="loan" name="Kredi taksiti" stackId="o" fill="var(--c4)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}
