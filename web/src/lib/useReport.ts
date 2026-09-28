import { useCallback, useMemo, useState } from 'react';
import { useEarliestDate, useLines, useProfile } from './api';
import { categoryTree, isExpense, isIncome, summarize } from './analytics';
import { monthStartISO, todayISO } from './format';
import { buildPeriod, type PeriodKey } from './period';
import type { Currency } from './types';

const KEYS = { period: 'butce.period', custom: 'butce.custom', currency: 'butce.currency' };

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* özel gezinme modunda yazılamayabilir */ }
}

/**
 * Özet ve Raporlar sayfalarının ortak veri kaynağı.
 * Seçili dönem ve para birimi tarayıcıda hatırlanır; iki sayfa birbiriyle tutarlı kalır.
 */
export function useReportData() {
  const today = todayISO();
  const earliest = useEarliestDate().data ?? undefined;
  const base = useProfile().data?.base_currency;

  const [pkey, setPkeyState] = useState<PeriodKey>(() => load(KEYS.period, 'last_6m' as PeriodKey));
  const [custom, setCustomState] = useState(() => load(KEYS.custom, { from: monthStartISO(), to: today }));
  const [ccy, setCcyState] = useState<Currency | null>(() => load<Currency | null>(KEYS.currency, null));

  const setPkey = useCallback((k: PeriodKey) => { setPkeyState(k); save(KEYS.period, k); }, []);
  const setCustom = useCallback((c: { from: string; to: string }) => { setCustomState(c); save(KEYS.custom, c); }, []);
  const setCurrency = useCallback((c: Currency) => { setCcyState(c); save(KEYS.currency, c); }, []);

  const period = useMemo(() => buildPeriod(pkey, custom, earliest, today), [pkey, custom, earliest, today]);
  const fetchFrom = period.prevFrom && period.prevFrom < period.from ? period.prevFrom : period.from;
  const q = useLines(fetchFrom, period.to);
  const all = useMemo(() => q.data ?? [], [q.data]);

  // Hareket gören para birimleri, işlem sayısına göre
  const currencies = useMemo(() => {
    const n = new Map<Currency, number>();
    for (const l of all) if (isExpense(l) || isIncome(l)) n.set(l.currency, (n.get(l.currency) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [all]);
  const currency: Currency = ccy && currencies.includes(ccy) ? ccy : currencies[0] ?? base ?? 'TRY';

  const lines = useMemo(() => all.filter((l) => l.currency === currency && l.entry_date >= period.from && l.entry_date <= period.to), [all, currency, period]);
  const prevLines = useMemo(
    () => (period.prevFrom && period.prevTo ? all.filter((l) => l.currency === currency && l.entry_date >= period.prevFrom! && l.entry_date <= period.prevTo!) : []),
    [all, currency, period]);

  const cur = useMemo(() => summarize(lines, period.from, period.to), [lines, period]);
  const prev = useMemo(() => (period.prevFrom && period.prevTo ? summarize(prevLines, period.prevFrom, period.prevTo) : null), [prevLines, period]);
  const tree = useMemo(() => categoryTree(lines), [lines]);
  const prevTree = useMemo(() => categoryTree(prevLines), [prevLines]);
  const incomeTree = useMemo(() => categoryTree(lines, 'income'), [lines]);

  return {
    today, pkey, setPkey, custom, setCustom, period, currency, setCurrency, currencies,
    lines, prevLines, cur, prev, tree, prevTree, incomeTree,
    isLoading: q.isLoading, isError: q.isError, error: q.error,
  };
}

export type ReportData = ReturnType<typeof useReportData>;
