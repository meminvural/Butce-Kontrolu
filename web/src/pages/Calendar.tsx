import { useState } from 'react';
import { useEntries, useUpcoming } from '../lib/api';
import { fmtDay, fmtMonth, monthStartISO, todayISO } from '../lib/format';
import { SOURCE_LABEL } from '../lib/types';
import { shiftMonth } from './Budget';
import EntryList, { entryTone } from '../components/EntryList';
import { Money } from '../components/ui';

const WEEKDAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

export default function Calendar() {
  const [month, setMonth] = useState(monthStartISO());
  const [day, setDay] = useState<string>(todayISO());
  const today = todayISO();
  const end = shiftMonth(month, 1);
  const lastDay = new Date(new Date(end + 'T12:00:00').getTime() - 86400000).toISOString().slice(0, 10);
  const daysAhead = Math.max(0, Math.ceil((new Date(lastDay).getTime() - new Date(today).getTime()) / 86400000));

  const upcoming = (useUpcoming(Math.min(daysAhead, 400)).data ?? []).filter((u) => u.due_date >= month && u.due_date <= lastDay);
  const entries = (useEntries({ from: month, to: lastDay, limit: 1000 }).data?.rows ?? []);

  const first = new Date(month + 'T12:00:00');
  const offset = (first.getDay() + 6) % 7;
  const count = Number(lastDay.slice(8, 10));
  const cells: (string | null)[] = [...Array(offset).fill(null),
    ...Array.from({ length: count }, (_, i) => `${month.slice(0, 8)}${String(i + 1).padStart(2, '0')}`)];

  const dayUpcoming = upcoming.filter((u) => u.due_date === day);
  const dayEntries = entries.filter((e) => e.entry_date === day);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Takvim</h1>
        <div className="month-nav">
          <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Önceki ay">‹</button>
          <span>{fmtMonth(month)}</span>
          <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Sonraki ay">›</button>
        </div>
      </header>

      <div className="calendar">
        {WEEKDAYS.map((w) => <div key={w} className="cal-head">{w}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={'x' + i} />;
          const ups = upcoming.filter((u) => u.due_date === d);
          const ents = entries.filter((e) => e.entry_date === d && e.kind !== 'reversal' && e.status === 'posted');
          const out = ups.filter((u) => u.direction === 'out').length;
          const inn = ups.filter((u) => u.direction === 'in').length;
          return (
            <button key={d} className={`cal-day ${d === today ? 'is-today' : ''} ${d === day ? 'is-selected' : ''} ${d < today ? 'is-past' : ''}`}
              onClick={() => setDay(d)} aria-label={fmtDay(d)}>
              <span className="cal-num">{Number(d.slice(8))}</span>
              <span className="cal-dots">
                {out > 0 && <i className="cal-dot out" title={`${out} ödeme`} />}
                {inn > 0 && <i className="cal-dot in" title={`${inn} tahsilat`} />}
                {ents.length > 0 && <i className="cal-dot done" title={`${ents.length} işlem`} />}
              </span>
              {ups.slice(0, 2).map((u) => <span key={u.ref_id + u.due_date} className={`cal-item ${u.direction}`}>{u.description}</span>)}
            </button>
          );
        })}
      </div>
      <p className="muted small cal-legend"><i className="cal-dot out" /> ödeme <i className="cal-dot in" /> tahsilat <i className="cal-dot done" /> gerçekleşen işlem</p>

      <section className="panel">
        <h2>{fmtDay(day)}</h2>
        {dayUpcoming.length === 0 && dayEntries.length === 0 && <p className="muted">Bu gün için kayıt yok.</p>}
        {dayUpcoming.length > 0 && (
          <ul className="acc-list">
            {dayUpcoming.map((u) => (
              <li key={u.ref_id}>
                <span>{u.description} <span className="muted small">{SOURCE_LABEL[u.source_type]}{u.overdue ? ' · gecikmiş' : ''}</span></span>
                <Money value={u.direction === 'out' ? -u.amount : u.amount} currency={u.currency} signed tone={u.direction === 'in' ? 'in' : 'out'} />
              </li>
            ))}
          </ul>
        )}
        {dayEntries.length > 0 && <EntryList entries={dayEntries} groupByDay={false} />}
        {dayEntries.length > 0 && <p className="field-hint">Gün toplamı: {dayEntries.filter((e) => entryTone(e) !== 'muted').length} gelir/gider kaydı.</p>}
      </section>
    </div>
  );
}
