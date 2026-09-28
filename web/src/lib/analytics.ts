import type { AccountBalance, Currency, LedgerLine } from './types';
import { addDays, addMonths, bucketFor, dayLabel, endOfMonth, inclusiveDays, monthShort, startOfMonth, weekdayMon0, WEEKDAYS } from './period';

// ---------------------------------------------------------------------------
//  Tanımlar
//   Gider  = "gider" kategorisine yazılan satırlar (tutar +)
//   Gelir  = "gelir" kategorisine yazılan satırlar (tutar −, işaret çevrilir)
//   Finansal maliyet = kök kategorisi "financial_costs" olan giderler (faiz, vergi, masraf)
//   Ödeme  = borç hesabına (kart, ek hesap, kredi, kişisel borç) giren para; açılış ve düzeltme kayıtları hariç
// ---------------------------------------------------------------------------
export const isExpense = (l: LedgerLine) => l.category_kind === 'expense';
export const isIncome = (l: LedgerLine) => l.category_kind === 'income';
export const isFin = (l: LedgerLine) => l.category_kind === 'expense' && l.root_key === 'financial_costs';
const FLOW_EXCLUDED = new Set(['opening_balance', 'adjustment']);

export const inRange = (l: LedgerLine, from: string, to: string) => l.entry_date >= from && l.entry_date <= to;
export const forCurrency = (lines: LedgerLine[], c: Currency) => lines.filter((l) => l.currency === c);
export const slice = (lines: LedgerLine[], from: string, to: string) => lines.filter((l) => inRange(l, from, to));

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));

export interface Summary {
  income: number; expense: number; net: number;
  fin: number; operating: number;
  /** Harcama (faiz hariç) kayıt sayısı */
  count: number; days: number; avgDaily: number; avgTicket: number;
  savingsRate: number | null; interestShare: number | null;
}

export function summarize(lines: LedgerLine[], from: string, to: string): Summary {
  const income = sum(lines.filter(isIncome).map((l) => -l.amount));
  const expLines = lines.filter(isExpense);
  const expense = sum(expLines.map((l) => l.amount));
  const fin = sum(expLines.filter(isFin).map((l) => l.amount));
  const operating = round2(expense - fin);
  const count = new Set(expLines.filter((l) => !isFin(l)).map((l) => l.entry_id)).size;
  const days = Math.max(1, inclusiveDays(from, to));
  return {
    income, expense, net: round2(income - expense), fin, operating, count, days,
    avgDaily: round2(operating / days), avgTicket: count ? round2(operating / count) : 0,
    savingsRate: income > 0 ? round2(((income - expense) / income) * 100) : null,
    interestShare: expense > 0 ? round2((fin / expense) * 100) : null,
  };
}

export interface Delta { abs: number; pct: number | null }
export const delta = (cur: number, prev: number): Delta => ({
  abs: round2(cur - prev), pct: prev !== 0 ? round2(((cur - prev) / Math.abs(prev)) * 100) : null,
});

// ---------------------------------------------------------------------------
//  Kategori kırılımı
// ---------------------------------------------------------------------------
export interface CategoryRow {
  id: string; name: string; parentId: string | null; parentName: string | null;
  total: number; count: number; share: number; isFin: boolean;
  /** Ana kategori satırı ise alt kategorileri */
  children?: CategoryRow[];
}

export function categoryTree(lines: LedgerLine[], kind: 'expense' | 'income' = 'expense'): CategoryRow[] {
  const sel = lines.filter((l) => l.category_kind === kind);
  const sign = kind === 'expense' ? 1 : -1;
  const total = sum(sel.map((l) => sign * l.amount));
  const roots = new Map<string, { row: CategoryRow; subs: Map<string, { row: CategoryRow; entries: Set<string> }>; entries: Set<string> }>();
  for (const l of sel) {
    const rid = l.root_category_id!, cid = l.category_id!;
    let r = roots.get(rid);
    if (!r) {
      r = { row: { id: rid, name: l.root_category_name ?? '—', parentId: null, parentName: null, total: 0, count: 0, share: 0, isFin: l.root_key === 'financial_costs' },
        subs: new Map(), entries: new Set() };
      roots.set(rid, r);
    }
    r.row.total += sign * l.amount; r.entries.add(l.entry_id);
    let s = r.subs.get(cid);
    if (!s) {
      s = { row: { id: cid, name: l.category_name ?? '—', parentId: cid === rid ? null : rid, parentName: r.row.name, total: 0, count: 0, share: 0, isFin: r.row.isFin }, entries: new Set() };
      r.subs.set(cid, s);
    }
    s.row.total += sign * l.amount; s.entries.add(l.entry_id);
  }
  const out = [...roots.values()].map((r) => {
    r.row.total = round2(r.row.total); r.row.count = r.entries.size;
    r.row.share = total ? round2((r.row.total / total) * 100) : 0;
    r.row.children = [...r.subs.values()].map((s) => {
      s.row.total = round2(s.row.total); s.row.count = s.entries.size;
      s.row.share = total ? round2((s.row.total / total) * 100) : 0;
      return s.row;
    }).sort((a, b) => b.total - a.total);
    return r.row;
  });
  return out.filter((r) => r.total !== 0).sort((a, b) => b.total - a.total);
}

export const flattenSubs = (tree: CategoryRow[]): CategoryRow[] =>
  tree.flatMap((r) => (r.children ?? []).map((c) => (c.id === r.id ? { ...c, name: `${r.name} (genel)` } : { ...c, name: `${r.name} › ${c.name}` })))
    .sort((a, b) => b.total - a.total);

export interface CatDelta { name: string; cur: number; prev: number; d: Delta }
export function compareCategories(cur: CategoryRow[], prev: CategoryRow[]): CatDelta[] {
  const names = new Set([...cur.map((c) => c.name), ...prev.map((c) => c.name)]);
  const get = (xs: CategoryRow[], n: string) => xs.find((x) => x.name === n)?.total ?? 0;
  return [...names].map((name) => ({ name, cur: get(cur, name), prev: get(prev, name), d: delta(get(cur, name), get(prev, name)) }))
    .sort((a, b) => Math.abs(b.d.abs) - Math.abs(a.d.abs));
}

// ---------------------------------------------------------------------------
//  Zaman serisi
// ---------------------------------------------------------------------------
export interface Bucket {
  key: string; label: string; from: string; to: string;
  income: number; expense: number; fin: number; operating: number; net: number; cumExpense: number;
}

export function trend(lines: LedgerLine[], from: string, to: string): { bucket: 'day' | 'month'; rows: Bucket[] } {
  const bucket = bucketFor(from, to);
  const rows: Bucket[] = [];
  if (bucket === 'day') {
    for (let d = from; d <= to; d = addDays(d, 1)) rows.push(mk(d, dayLabel(d), d, d));
  } else {
    for (let m = startOfMonth(from); m <= to; m = addMonths(m, 1)) {
      rows.push(mk(m, `${monthShort(m)}${m.slice(2, 4) !== to.slice(2, 4) || from.slice(0, 4) !== to.slice(0, 4) ? ' ' + m.slice(2, 4) : ''}`,
        m < from ? from : m, endOfMonth(m) > to ? to : endOfMonth(m)));
    }
  }
  function mk(key: string, label: string, f: string, t: string): Bucket {
    return { key, label, from: f, to: t, income: 0, expense: 0, fin: 0, operating: 0, net: 0, cumExpense: 0 };
  }
  const idx = new Map(rows.map((r) => [r.key, r]));
  for (const l of lines) {
    if (l.entry_date < from || l.entry_date > to) continue;
    const r = idx.get(bucket === 'day' ? l.entry_date : startOfMonth(l.entry_date));
    if (!r) continue;
    if (isIncome(l)) r.income += -l.amount;
    else if (isExpense(l)) { r.expense += l.amount; if (isFin(l)) r.fin += l.amount; }
  }
  let cum = 0;
  for (const r of rows) {
    r.income = round2(r.income); r.expense = round2(r.expense); r.fin = round2(r.fin);
    r.operating = round2(r.expense - r.fin); r.net = round2(r.income - r.expense);
    cum += r.expense; r.cumExpense = round2(cum);
  }
  return { bucket, rows };
}

// ---------------------------------------------------------------------------
//  Kalemler, haftanın günleri, ısı haritası
// ---------------------------------------------------------------------------
export interface TopItem { label: string; total: number; count: number; category: string; isFin: boolean; raws: string[] }

export function topItems(lines: LedgerLine[], opts: { excludeFin: boolean; limit: number }): TopItem[] {
  const m = new Map<string, { total: number; entries: Set<string>; cats: Map<string, number>; fin: boolean; raws: Set<string> }>();
  for (const l of lines.filter(isExpense)) {
    if (opts.excludeFin && isFin(l)) continue;
    const label = (l.description ?? l.category_name ?? '—').replace(/\s+/g, ' ').trim().toLocaleUpperCase('tr-TR');
    const g = m.get(label) ?? { total: 0, entries: new Set<string>(), cats: new Map<string, number>(), fin: isFin(l), raws: new Set<string>() };
    g.total += l.amount; g.entries.add(l.entry_id);
    if (l.description) g.raws.add(l.description);
    const cn = l.root_category_name ?? '—';
    g.cats.set(cn, (g.cats.get(cn) ?? 0) + l.amount);
    m.set(label, g);
  }
  return [...m.entries()].map(([label, g]) => ({
    label, total: round2(g.total), count: g.entries.size, isFin: g.fin, raws: [...g.raws],
    category: [...g.cats.entries()].sort((a, b) => b[1] - a[1])[0][0],
  })).sort((a, b) => b.total - a.total).slice(0, opts.limit);
}

/** Günlük gider toplamı (faiz hariç): { '2026-04-17': 4515 } */
export function dailyOperating(lines: LedgerLine[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) if (isExpense(l) && !isFin(l)) m.set(l.entry_date, round2((m.get(l.entry_date) ?? 0) + l.amount));
  return m;
}

export interface WeekdayRow { dow: number; name: string; total: number; days: number; avg: number }
export function weekdayPattern(lines: LedgerLine[], from: string, to: string): WeekdayRow[] {
  const daily = dailyOperating(lines);
  const rows: WeekdayRow[] = WEEKDAYS.map((name, dow) => ({ dow, name, total: 0, days: 0, avg: 0 }));
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = rows[weekdayMon0(d)];
    r.days += 1; r.total += daily.get(d) ?? 0;
  }
  return rows.map((r) => ({ ...r, total: round2(r.total), avg: r.days ? round2(r.total / r.days) : 0 }));
}

export interface HeatCell { date: string; value: number; col: number; row: number; future: boolean }
/** Pazartesi'den başlayan hafta sütunlarıyla ısı haritası kutuları */
export function heatmap(lines: LedgerLine[], from: string, to: string, today: string): { cells: HeatCell[]; weeks: number; max: number } {
  const daily = dailyOperating(lines);
  const start = addDays(from, -weekdayMon0(from));
  const cells: HeatCell[] = [];
  let max = 0;
  for (let d = start, i = 0; d <= to; d = addDays(d, 1), i++) {
    const value = d < from ? -1 : daily.get(d) ?? 0;
    if (value > max) max = value;
    cells.push({ date: d, value, col: Math.floor(i / 7), row: i % 7, future: d > today });
  }
  return { cells, weeks: cells.length ? cells[cells.length - 1].col + 1 : 0, max };
}

// ---------------------------------------------------------------------------
//  Finansal maliyet kırılımı
// ---------------------------------------------------------------------------
export interface FinBreakdown { name: string; total: number }
export function finBreakdown(lines: LedgerLine[]): FinBreakdown[] {
  const m = new Map<string, number>();
  for (const l of lines.filter(isFin)) m.set(l.category_name ?? '—', (m.get(l.category_name ?? '—') ?? 0) + l.amount);
  return [...m.entries()].map(([name, total]) => ({ name, total: round2(total) })).sort((a, b) => b.total - a.total);
}

export function finByBucket(lines: LedgerLine[], from: string, to: string): { rows: Record<string, number | string>[]; names: string[] } {
  const names = finBreakdown(lines).map((f) => f.name);
  const { rows: tr } = trend(lines, from, to);
  const rows = tr.map((b) => {
    const r: Record<string, number | string> = { label: b.label, key: b.key, from: b.from, to: b.to };
    for (const n of names) r[n] = 0;
    return r;
  });
  const idx = new Map(tr.map((b, i) => [b.key, i]));
  const bucket = bucketFor(from, to);
  for (const l of lines.filter(isFin)) {
    const i = idx.get(bucket === 'day' ? l.entry_date : startOfMonth(l.entry_date));
    if (i === undefined) continue;
    const n = l.category_name ?? '—';
    rows[i][n] = round2(Number(rows[i][n] ?? 0) + l.amount);
  }
  return { rows, names };
}

// ---------------------------------------------------------------------------
//  Hesap (kart / ek hesap / kredi) hareketleri
// ---------------------------------------------------------------------------
export interface AccountActivity {
  id: string; name: string; kind: string; currency: Currency;
  /** Dönemde borca eklenenler: alışveriş + faiz + masraf */
  charged: number; purchases: number; interest: number;
  /** Dönemde yapılan ödeme */
  paid: number; count: number;
}

export function accountActivity(lines: LedgerLine[]): AccountActivity[] {
  // Hangi kayıtlar finansal maliyet? (kart satırı ile aynı kayıttaki kategori satırından anlaşılır)
  const finEntries = new Set(lines.filter(isFin).map((l) => l.entry_id));
  const m = new Map<string, AccountActivity & { entries: Set<string> }>();
  for (const l of lines) {
    if (!l.account_id || l.account_class !== 'liability' || FLOW_EXCLUDED.has(l.entry_kind)) continue;
    const a = m.get(l.account_id) ?? { id: l.account_id, name: l.account_name ?? '—', kind: l.account_kind ?? '', currency: l.currency,
      charged: 0, purchases: 0, interest: 0, paid: 0, count: 0, entries: new Set<string>() };
    if (l.amount < 0) {
      const v = -l.amount; a.charged += v;
      if (finEntries.has(l.entry_id)) a.interest += v; else a.purchases += v;
      a.entries.add(l.entry_id);
    } else a.paid += l.amount;
    m.set(l.account_id, a);
  }
  return [...m.values()].map(({ entries, ...a }) => ({
    ...a, charged: round2(a.charged), purchases: round2(a.purchases), interest: round2(a.interest), paid: round2(a.paid), count: entries.size,
  })).sort((a, b) => b.charged - a.charged);
}

/** Dönemde borç hesaplarına yapılan toplam ödeme (kart, ek hesap, kredi, kişisel borç) */
export const totalDebtPayments = (lines: LedgerLine[]) =>
  round2(lines.filter((l) => l.account_class === 'liability' && l.amount > 0 && !FLOW_EXCLUDED.has(l.entry_kind)).reduce((s, l) => s + l.amount, 0));

// ---------------------------------------------------------------------------
//  Limit riski
// ---------------------------------------------------------------------------
export type RiskLevel = 'normal' | 'warn' | 'crit';
export const riskOf = (pct: number): RiskLevel => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'normal');
export const RISK_LABEL: Record<RiskLevel, string> = { normal: 'Normal', warn: 'Dikkat', crit: 'Kritik' };

export interface LimitRow { id: string; name: string; kind: string; used: number; limit: number; available: number; pct: number; risk: RiskLevel }
export function limitRows(accounts: AccountBalance[], currency: Currency): LimitRow[] {
  return accounts
    .filter((a) => a.currency === currency && !a.archived_at && (a.kind === 'credit_card' || a.kind === 'overdraft') && a.credit_limit)
    .map((a) => {
      const pct = a.credit_limit ? round2((a.balance / a.credit_limit) * 100) : 0;
      return { id: a.id, name: a.name, kind: a.kind, used: a.balance, limit: a.credit_limit!, available: a.available_limit ?? a.credit_limit! - a.balance, pct, risk: riskOf(pct) };
    })
    .sort((a, b) => b.pct - a.pct);
}

// ---------------------------------------------------------------------------
//  Otomatik bulgular
// ---------------------------------------------------------------------------
export interface Insight { level: 'good' | 'info' | 'warn' | 'crit'; text: string; to?: string; term?: string }

export interface InsightCtx {
  currency: Currency;
  cur: Summary; prev: Summary | null; prevLabel: string;
  categories: CategoryRow[];
  limits: LimitRow[];
  overdueCount: number; overdueAmount: number;
  nextInstallment: { month: string; amount: number } | null;
  debtPayments: number;
  topDay: { date: string; value: number } | null;
  fmt: (n: number) => string;
}

export function buildInsights(c: InsightCtx): Insight[] {
  const out: Insight[] = [];
  const { cur, prev, fmt } = c;
  const pctText = (d: Delta) => (d.pct === null ? '' : ` (%${Math.abs(d.pct).toLocaleString('tr-TR', { maximumFractionDigits: 1 })})`);

  if (c.overdueCount > 0)
    out.push({ level: 'crit', text: `${c.overdueCount} ödemenin vadesi geçmiş görünüyor, toplam ${fmt(c.overdueAmount)}. Ödemeyi yaptıysanız hesaba işleyin; yapmadıysanız gecikme faizi işler.`, to: '/planli', term: 'upcoming' });

  if (prev) {
    const d = delta(cur.operating, prev.operating);
    if (Math.abs(d.abs) > 0 && prev.operating > 0) {
      out.push({ level: d.abs > 0 ? 'warn' : 'good',
        text: `Harcamanız (faiz hariç), ${c.prevLabel} ile kıyaslandığında ${fmt(Math.abs(d.abs))}${pctText(d)} ${d.abs > 0 ? 'arttı' : 'azaldı'}: ${fmt(cur.operating)} (öncesi ${fmt(prev.operating)}).`, term: 'period_change' });
    }
  }

  const top = c.categories.filter((x) => !x.isFin)[0];
  if (top && cur.expense > 0)
    out.push({ level: 'info', text: `En büyük harcama kalemi “${top.name}”: ${fmt(top.total)}, toplam giderin %${top.share.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}’i.`, term: 'category_share' });

  if (cur.interestShare !== null && cur.fin > 0) {
    const lvl = cur.interestShare >= 20 ? 'crit' : cur.interestShare >= 10 ? 'warn' : 'info';
    out.push({ level: lvl, text: `Bu dönemde faiz ve masraflara ${fmt(cur.fin)} gitti; giderinizin %${cur.interestShare.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}’i karşılığında mal ya da hizmet almadığınız para.`, to: '/raporlar?tab=borc', term: 'interest_share' });
  }
  if (c.debtPayments > 0 && cur.fin > 0) {
    const r = (cur.fin / c.debtPayments) * 100;
    if (r >= 10) out.push({ level: r >= 25 ? 'warn' : 'info', text: `Borç ödemelerinizin (${fmt(c.debtPayments)}) %${r.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}’i faiz ve masrafı karşıladı; yalnızca kalanı borcu azalttı.`, term: 'interest_vs_payment' });
  }

  const crit = c.limits.filter((l) => l.risk === 'crit');
  const warn = c.limits.filter((l) => l.risk === 'warn');
  if (crit.length) out.push({ level: 'crit', text: `${crit.map((l) => `${l.name} (%${Math.round(l.pct)})`).join(', ')} limitinin %90’ından fazlası dolu. Yeni harcama için yer kalmadı.`, to: '/kartlar', term: 'card_utilization' });
  if (warn.length) out.push({ level: 'warn', text: `${warn.map((l) => `${l.name} (%${Math.round(l.pct)})`).join(', ')} limitinin %70–90’ı arasında dolu.`, to: '/kartlar', term: 'card_utilization' });

  if (c.nextInstallment && c.nextInstallment.amount > 0)
    out.push({ level: 'info', text: `${c.nextInstallment.month} ayında kesinleşmiş taksit ödemeniz ${fmt(c.nextInstallment.amount)}.`, to: '/raporlar?tab=borc', term: 'installment_load' });

  if (cur.income === 0 && cur.expense > 0)
    out.push({ level: 'info', text: 'Bu dönemde gelir kaydı yok; net nakit akışı ve tasarruf oranı eksik görünebilir. Maaşınızı Planlı ve düzenli bölümüne ekleyerek otomatik hale getirebilirsiniz.', to: '/planli' });
  else if (cur.savingsRate !== null)
    out.push({ level: cur.savingsRate >= 20 ? 'good' : cur.savingsRate < 0 ? 'warn' : 'info', text: cur.savingsRate < 0
      ? `Bu dönemde gelirinizden ${fmt(Math.abs(cur.net))} fazla harcadınız; fark borçla veya birikimle karşılanmış olmalı.`
      : `Gelirinizin %${cur.savingsRate.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}’i tasarruf edildi (${fmt(cur.net)}).`, term: 'savings_rate' });

  if (c.topDay && c.topDay.value > 0)
    out.push({ level: 'info', text: `En çok harcama yapılan gün ${c.topDay.date.split('-').reverse().join('.')}: ${fmt(c.topDay.value)}. Günlük ortalama ${fmt(cur.avgDaily)}.`, term: 'avg_daily' });

  const order = { crit: 0, warn: 1, info: 2, good: 3 } as const;
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
