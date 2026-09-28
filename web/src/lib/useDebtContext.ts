import { useMemo } from 'react';
import { useAccounts, useDebtOutlook, useUpcoming } from './api';
import { buildInsights, dailyOperating, limitRows, totalDebtPayments } from './analytics';
import { money } from './format';
import type { ReportData } from './useReport';

/**
 * Seçili para biriminde güncel borç durumu: limitler, yaklaşan ve gecikmiş ödemeler, taksit yükü ve otomatik bulgular.
 * Özet ve Raporlar sayfaları aynı rakamları kullanır.
 */
export function useDebtContext(R: ReportData) {
  const { currency, cur, prev, period } = R;
  const accountsQ = useAccounts();
  const accounts = useMemo(() => (accountsQ.data ?? []).filter((a) => !a.archived_at), [accountsQ.data]);
  const upcoming = useUpcoming(30).data;
  const outlookRows = useDebtOutlook(12).data;
  const outlook = useMemo(() => outlookRows ?? [], [outlookRows]);

  const limits = useMemo(() => limitRows(accounts, currency), [accounts, currency]);
  const usedSum = limits.reduce((a, l) => a + l.used, 0);
  const limitSum = limits.reduce((a, l) => a + l.limit, 0);
  const utilPct = limitSum ? (usedSum / limitSum) * 100 : 0;

  const due = useMemo(() => (upcoming ?? []).filter((u) => u.currency === currency && u.direction === 'out'), [upcoming, currency]);
  const overdue = useMemo(() => due.filter((u) => u.overdue), [due]);
  const dueTotal = due.reduce((a, u) => a + u.amount, 0);
  const overdueTotal = overdue.reduce((a, u) => a + u.amount, 0);

  const debtByKind = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of accounts) if (a.currency === currency && a.class === 'liability' && a.balance > 0) m.set(a.kind, (m.get(a.kind) ?? 0) + a.balance);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [accounts, currency]);

  const nextInstallment = useMemo(() => {
    const rows = outlook.filter((o) => o.currency === currency).sort((a, b) => a.month.localeCompare(b.month));
    if (!rows.length) return null;
    const month = rows[0].month;
    return {
      month: new Date(month + 'T12:00:00').toLocaleDateString('tr-TR', { month: 'long' }),
      amount: rows.filter((r) => r.month === month).reduce((a, r) => a + r.amount, 0),
    };
  }, [outlook, currency]);

  const debtPayments = useMemo(() => totalDebtPayments(R.lines), [R.lines]);
  const topDay = useMemo(() => {
    let best: { date: string; value: number } | null = null;
    for (const [date, value] of dailyOperating(R.lines)) if (!best || value > best.value) best = { date, value };
    return best;
  }, [R.lines]);

  const insights = useMemo(() => buildInsights({
    currency, cur, prev, prevLabel: period.prevLabel, categories: R.tree, limits,
    overdueCount: overdue.length, overdueAmount: overdueTotal, nextInstallment, debtPayments, topDay,
    fmt: (n) => money(n, currency),
  }), [currency, cur, prev, period.prevLabel, R.tree, limits, overdue.length, overdueTotal, nextInstallment, debtPayments, topDay]);

  return {
    accountsQ, accounts, upcoming: upcoming ?? [], outlook, limits, usedSum, limitSum, utilPct,
    due, overdue, dueTotal, overdueTotal, debtByKind, nextInstallment, debtPayments, topDay, insights,
  };
}

export type DebtContext = ReturnType<typeof useDebtContext>;
