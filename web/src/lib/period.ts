import { todayISO } from './format';

/** Tüm tarihler 'YYYY-MM-DD' metni. Yerel saat dilimi kayması olmasın diye Date yalnızca öğle saatiyle kullanılır. */
const d = (iso: string) => new Date(iso + 'T12:00:00');
const iso = (x: Date) => x.toISOString().slice(0, 10);

export const addDays = (s: string, n: number) => { const x = d(s); x.setDate(x.getDate() + n); return iso(x); };
export const startOfMonth = (s: string) => s.slice(0, 8) + '01';
export const addMonths = (s: string, n: number) => { const x = d(startOfMonth(s)); x.setMonth(x.getMonth() + n, 1); return iso(x); };
export const endOfMonth = (s: string) => addDays(addMonths(s, 1), -1);
export const daysBetween = (a: string, b: string) => Math.round((d(b).getTime() - d(a).getTime()) / 86400000);
export const inclusiveDays = (a: string, b: string) => daysBetween(a, b) + 1;
export const weekdayMon0 = (s: string) => (d(s).getDay() + 6) % 7;   // Pzt=0 … Paz=6

export type PeriodKey = 'this_month' | 'last_month' | 'last_3m' | 'last_6m' | 'ytd' | 'last_12m' | 'all' | 'custom';

export interface Period {
  key: PeriodKey;
  label: string;
  from: string;
  to: string;
  /** Karşılaştırma dönemi; 'all' için yok */
  prevFrom: string | null;
  prevTo: string | null;
  prevLabel: string;
}

export const PERIOD_CHIPS: { key: PeriodKey; label: string }[] = [
  { key: 'this_month', label: 'Bu ay' },
  { key: 'last_month', label: 'Geçen ay' },
  { key: 'last_3m', label: 'Son 3 ay' },
  { key: 'last_6m', label: 'Son 6 ay' },
  { key: 'ytd', label: 'Bu yıl' },
  { key: 'last_12m', label: 'Son 12 ay' },
  { key: 'all', label: 'Tümü' },
  { key: 'custom', label: 'Özel' },
];

export function buildPeriod(key: PeriodKey, custom?: { from: string; to: string }, earliest?: string, today = todayISO()): Period {
  const m0 = startOfMonth(today);
  switch (key) {
    case 'this_month': {
      const pf = addMonths(m0, -1);
      const span = daysBetween(m0, today);
      return { key, label: 'Bu ay', from: m0, to: today, prevFrom: pf,
        prevTo: addDays(pf, Math.min(span, daysBetween(pf, endOfMonth(pf)))), prevLabel: 'geçen ayın aynı dönemi' };
    }
    case 'last_month': {
      const f = addMonths(m0, -1), pf = addMonths(m0, -2);
      return { key, label: 'Geçen ay', from: f, to: endOfMonth(f), prevFrom: pf, prevTo: endOfMonth(pf), prevLabel: 'bir önceki ay' };
    }
    case 'last_3m': case 'last_6m': case 'last_12m': {
      const n = key === 'last_3m' ? 3 : key === 'last_6m' ? 6 : 12;
      const f = addMonths(m0, -(n - 1)), pf = addMonths(f, -n);
      return { key, label: `Son ${n} ay`, from: f, to: today, prevFrom: pf, prevTo: addDays(f, -1), prevLabel: `önceki ${n} ay` };
    }
    case 'ytd': {
      const f = today.slice(0, 4) + '-01-01';
      const pf = (Number(today.slice(0, 4)) - 1) + '-01-01';
      return { key, label: 'Bu yıl', from: f, to: today, prevFrom: pf,
        prevTo: (Number(today.slice(0, 4)) - 1) + today.slice(4), prevLabel: 'geçen yılın aynı dönemi' };
    }
    case 'all':
      return { key, label: 'Tüm zamanlar', from: earliest ?? '2000-01-01', to: today, prevFrom: null, prevTo: null, prevLabel: '' };
    default: {
      const f = custom?.from ?? m0, t = custom?.to ?? today;
      const len = inclusiveDays(f, t);
      return { key: 'custom', label: 'Özel dönem', from: f, to: t, prevFrom: addDays(f, -len), prevTo: addDays(f, -1), prevLabel: 'önceki eş uzunluktaki dönem' };
    }
  }
}

/** Grafik kovası: kısa dönemlerde gün, uzun dönemlerde ay */
export const bucketFor = (from: string, to: string): 'day' | 'month' => (inclusiveDays(from, to) <= 62 ? 'day' : 'month');

const MONTHS_SHORT = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const MONTHS_LONG = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
export const monthShort = (s: string) => MONTHS_SHORT[Number(s.slice(5, 7)) - 1];
export const monthLong = (s: string) => `${MONTHS_LONG[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
export const dayLabel = (s: string) => `${Number(s.slice(8))} ${monthShort(s)}`;
export const WEEKDAYS = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
export const WEEKDAYS_SHORT = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
