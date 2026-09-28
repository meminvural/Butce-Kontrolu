import type { Currency } from './types';

const DECIMALS: Record<string, number> = { TZS: 0 };
const cache = new Map<string, Intl.NumberFormat>();

function fmt(currency: string, signed: boolean) {
  const k = currency + signed;
  if (!cache.has(k)) {
    const d = DECIMALS[currency] ?? 2;
    cache.set(k, new Intl.NumberFormat('tr-TR', {
      style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d,
      signDisplay: signed ? 'exceptZero' : 'auto',
    }));
  }
  return cache.get(k)!;
}

export const money = (v: number | null | undefined, currency: Currency | string, signed = false) =>
  fmt(currency, signed).format(Number(v ?? 0));

/** "1.250,50" | "1250.50" | "1250,5" → 1250.5  (Türkçe ve İngilizce girişi kabul eder) */
export function parseAmount(input: string): number | null {
  let s = input.trim().replace(/\s|₺|\$|€|TL/gi, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

const dateFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
const monthFmt = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' });

const asDate = (iso: string) => new Date(iso + (iso.length === 10 ? 'T12:00:00' : ''));
export const fmtDate = (iso: string) => dateFmt.format(asDate(iso));
export const fmtDay = (iso: string) => dayFmt.format(asDate(iso));
export const fmtMonth = (iso: string) => monthFmt.format(asDate(iso));

export function todayISO(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export const monthStartISO = (iso = todayISO()) => iso.slice(0, 8) + '01';
