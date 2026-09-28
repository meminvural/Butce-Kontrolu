import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useEntries, type EntryFilter } from '../lib/api';
import type { Delta, Insight } from '../lib/analytics';
import type { HeatCell } from '../lib/analytics';
import { fmtDate, money } from '../lib/format';
import { PERIOD_CHIPS, WEEKDAYS_SHORT, monthShort, type Period, type PeriodKey } from '../lib/period';
import type { Currency } from '../lib/types';
import { GLOSSARY, type TermKey } from '../lib/glossary';
import EntryList from './EntryList';
import { Info, Lbl } from './Info';
import { Modal } from './ui';

// ---------------------------------------------------------------------------
//  Küçük parçalar
// ---------------------------------------------------------------------------
export const pctText = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined ? '—' : `%${n.toLocaleString('tr-TR', { maximumFractionDigits: digits })}`;

/** Önceki dönemle fark rozeti. good: artışın iyi mi kötü mü olduğu (gider için 'down') */
export function DeltaChip({ d, good, currency, label }: { d: Delta | null; good: 'up' | 'down'; currency: Currency; label?: string }) {
  if (!d || (d.abs === 0 && d.pct === null)) return null;
  const up = d.abs > 0;
  const tone = d.abs === 0 ? 'flat' : (up === (good === 'up') ? 'good' : 'bad');
  return (
    <span className={`delta delta-${tone}`} title={label ? `${label} ile fark: ${money(d.abs, currency, true)}` : undefined}>
      {up ? '▲' : d.abs < 0 ? '▼' : '■'} {d.pct === null ? money(Math.abs(d.abs), currency) : pctText(Math.abs(d.pct))}
    </span>
  );
}

export function Kpi({ term, label, value, sub, delta, onClick, hint, tone, children }: {
  term: TermKey; label: string; value: ReactNode; sub?: ReactNode; delta?: ReactNode; onClick?: () => void; hint?: string;
  tone?: 'good' | 'bad' | 'warn'; children?: ReactNode;
}) {
  const body = (
    <>
      <span className="kpi-label"><Lbl k={term}>{label}</Lbl></span>
      <span className={`kpi-value ${tone ? 'kpi-' + tone : ''}`}>{value}</span>
      {delta && <span className="kpi-delta">{delta}</span>}
      {children}
      {sub && <span className="kpi-sub">{sub}</span>}
    </>
  );
  return onClick
    ? <div className="kpi kpi-click" role="button" tabIndex={0} title={hint} onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>{body}</div>
    : <div className="kpi">{body}</div>;
}

export function Seg<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: { id: T; label: string }[]; label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} className={value === o.id ? 'active' : ''} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Grafik kartı: başlık, açıklama, (isteğe bağlı) Grafik/Tablo geçişi ve sağ üst eylemler */
export function ChartCard({ title, term, note, actions, table, children, className = '' }: {
  title: string; term?: TermKey; note?: ReactNode; actions?: ReactNode; table?: ReactNode; children: ReactNode; className?: string;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <section className={`panel chart-card ${className}`}>
      <header className="chart-head">
        <h2>{term ? <Lbl k={term}>{title}</Lbl> : title}</h2>
        <div className="chart-tools">
          {actions}
          {table && <Seg label="Görünüm" value={view} onChange={setView} options={[{ id: 'chart', label: 'Grafik' }, { id: 'table', label: 'Tablo' }]} />}
        </div>
      </header>
      {note && <p className="chart-note small muted">{note}</p>}
      {view === 'table' && table ? <div className="table-wrap">{table}</div> : children}
    </section>
  );
}

export function Insights({ items }: { items: Insight[] }) {
  if (items.length === 0) return <p className="muted">Bu dönem için öne çıkan bir bulgu yok.</p>;
  const icon = { crit: '●', warn: '▲', info: '◆', good: '✓' } as const;
  return (
    <ul className="insights">
      {items.map((i, n) => (
        <li key={n} className={`insight insight-${i.level}`}>
          <span className="insight-icon" aria-hidden>{icon[i.level]}</span>
          <span className="insight-text">
            {i.text}
            {i.term && <Info k={i.term as TermKey} />}
            {i.to && <Link to={i.to} className="insight-link small"> Ayrıntı →</Link>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
//  Dönem ve para birimi çubuğu
// ---------------------------------------------------------------------------
export function PeriodBar({ period, pkey, setPkey, custom, setCustom, currencies, currency, setCurrency }: {
  period: Period; pkey: PeriodKey; setPkey: (k: PeriodKey) => void;
  custom: { from: string; to: string }; setCustom: (c: { from: string; to: string }) => void;
  currencies: Currency[]; currency: Currency; setCurrency: (c: Currency) => void;
}) {
  return (
    <div className="period-bar no-print">
      <div className="chips" role="group" aria-label="Dönem">
        {PERIOD_CHIPS.map((c) => (
          <button key={c.key} type="button" aria-pressed={pkey === c.key} className={`chip ${pkey === c.key ? 'active' : ''}`} onClick={() => setPkey(c.key)}>{c.label}</button>
        ))}
      </div>
      {pkey === 'custom' && (
        <div className="custom-range">
          <input type="date" aria-label="Başlangıç" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
          <span>–</span>
          <input type="date" aria-label="Bitiş" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
        </div>
      )}
      {currencies.length > 1 && (
        <div className="chips" role="group" aria-label="Para birimi">
          {currencies.map((c) => (
            <button key={c} type="button" aria-pressed={currency === c} className={`chip chip-ccy ${currency === c ? 'active' : ''}`} onClick={() => setCurrency(c)}>{c}</button>
          ))}
        </div>
      )}
      <p className="period-text small muted">
        {fmtDate(period.from)} – {fmtDate(period.to)}
        {period.prevFrom && period.prevTo && <> · karşılaştırma: {period.prevLabel} ({fmtDate(period.prevFrom)} – {fmtDate(period.prevTo)}) <Info k="period_change" /></>}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Isı haritası
// ---------------------------------------------------------------------------
export function Heatmap({ cells, weeks, max, currency, onPick, selected }: {
  cells: HeatCell[]; weeks: number; max: number; currency: Currency; onPick: (date: string) => void; selected?: string | null;
}) {
  const [hover, setHover] = useState<HeatCell | null>(null);
  const level = (v: number) => (v <= 0 ? 0 : v <= max * 0.25 ? 1 : v <= max * 0.5 ? 2 : v <= max * 0.75 ? 3 : 4);
  // Ay etiketleri: ayın ilk günü hangi sütuna düşüyorsa orada göster
  const labels: { col: number; text: string }[] = [];
  let lastMonth = '';
  for (const c of cells) {
    if (c.value < 0) continue;
    const m = c.date.slice(0, 7);
    if (m !== lastMonth) { labels.push({ col: c.col, text: monthShort(c.date) }); lastMonth = m; }
  }
  return (
    <div className="heat">
      <div className="heat-scroll">
        <div className="heat-months" style={{ gridTemplateColumns: `repeat(${weeks}, 15px)` }}>
          {labels.map((l) => <span key={l.col + l.text} style={{ gridColumn: l.col + 1 }}>{l.text}</span>)}
        </div>
        <div className="heat-body">
          <div className="heat-days" aria-hidden>{WEEKDAYS_SHORT.map((d, i) => <span key={d} style={{ visibility: i % 2 === 0 ? 'visible' : 'hidden' }}>{d}</span>)}</div>
          <div className="heat-grid" style={{ gridTemplateColumns: `repeat(${weeks}, 15px)` }}>
            {cells.map((c) => c.value < 0 ? <span key={c.date} className="heat-cell heat-off" style={{ gridColumn: c.col + 1, gridRow: c.row + 1 }} /> : (
              <button key={c.date} type="button" className={`heat-cell heat-l${level(c.value)} ${selected === c.date ? 'is-selected' : ''} ${c.future ? 'is-future' : ''}`}
                style={{ gridColumn: c.col + 1, gridRow: c.row + 1 }}
                aria-label={`${fmtDate(c.date)}: ${money(c.value, currency)}`}
                onMouseEnter={() => setHover(c)} onFocus={() => setHover(c)} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}
                onClick={() => onPick(c.date)} />
            ))}
          </div>
        </div>
      </div>
      <p className="heat-readout small">
        {hover ? <><strong>{fmtDate(hover.date)}</strong> · {hover.value > 0 ? money(hover.value, currency) : 'harcama yok'}</> : <span className="muted">Bir kutunun üzerine gelin, ayrıntı için tıklayın.</span>}
        <span className="heat-legend" aria-hidden><i className="heat-cell heat-l0" /> az <i className="heat-cell heat-l1" /><i className="heat-cell heat-l2" /><i className="heat-cell heat-l3" /><i className="heat-cell heat-l4" /> çok</span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Ayrıntı penceresi: bir kategoriye / güne / kaleme tıklayınca o işlemleri listeler
// ---------------------------------------------------------------------------
export interface Drill { title: string; subtitle?: string; filter: Omit<EntryFilter, 'limit'>; total?: number; currency?: Currency }

export function DrillModal({ drill, onClose }: { drill: Drill; onClose: () => void }) {
  const [limit, setLimit] = useState(60);
  const { data, isFetching, error } = useEntries({ ...drill.filter, postedOnly: true, limit });
  const rows = data?.rows ?? [];
  return (
    <Modal title={drill.title} onClose={onClose} wide>
      <p className="muted small">
        {drill.subtitle}
        {data && <> {drill.subtitle ? '· ' : ''}{data.count} kayıt</>}
        {drill.total !== undefined && drill.currency && <> · toplam <strong>{money(drill.total, drill.currency)}</strong></>}
      </p>
      {error && <p className="error">{error instanceof Error ? error.message : String(error)}</p>}
      <div className={`drill-list ${isFetching ? 'is-loading' : ''}`}>
        {data && rows.length === 0 ? <p className="muted">Bu filtreyle kayıt bulunamadı.</p> : <EntryList entries={rows} />}
      </div>
      {data && rows.length < data.count && (
        <div className="center"><button className="btn" disabled={isFetching} onClick={() => setLimit((n) => n + 60)}>Daha fazla göster ({data.count - rows.length} kaldı)</button></div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
//  Basit veri tablosu (Grafik/Tablo geçişi için)
// ---------------------------------------------------------------------------
export function DataTable({ head, rows }: { head: string[]; rows: (string | number | ReactNode)[][] }) {
  return (
    <table className="sum-table">
      <thead><tr>{head.map((h, i) => <th key={h} className={i > 0 ? 'num' : ''}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j} className="num">{c}</td>))}</tr>)}</tbody>
    </table>
  );
}

export const TERM_TITLE = (k: TermKey) => GLOSSARY[k].title;
