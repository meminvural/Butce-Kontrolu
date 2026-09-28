import type { ParsedStatement, StatementLine } from './types';
import { norm } from './text';

/** Defterdeki (v_ledger_lines) kart satırı */
export interface LedgerCardLine {
  entry_id: string;
  entry_date: string;
  entry_kind: string;
  description: string | null;
  /** Kart hesabındaki tutar: borcu artıran negatif */
  amount: number;
}

export type MatchStatus = 'matched' | 'maybe' | 'new';

export interface LineMatch {
  line: StatementLine;
  status: MatchStatus;
  entryId: string | null;
  ledgerDate: string | null;
  ledgerDesc: string | null;
  score: number;
}

export interface MatchResult {
  lines: LineMatch[];
  /** Defterde olup ekstrede görünmeyen (dönem içi) kayıtlar */
  ledgerOnly: LedgerCardLine[];
}

const STOP = new Set(['tr', 'trtr', 'istanbul', 'ankara', 'gaziantep', 'gazantep', 'com', 'www', 'the', 'ile', 'ltd', 'sti', 'as', 'a', 's', 'odeme', 'fatura', 'kart', 'aylik', 'tl', 'ie', 'bil', 'bill']);
const ALIAS: [RegExp, string][] = [[/sosyal ?g\w*k\w* ?kurumu|sosyal ?gvenlk/, ' sgk '], [/param ?(od|d)?\/?getir|getir/, ' getir ']];
const tokens = (s: string) => {
  let n = norm(s);
  for (const [re, to] of ALIAS) n = n.replace(re, to);
  return new Set(n.replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)));
};
const dayDiff = (a: string, b: string) => Math.abs(Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000));
const addMonths = (s: string, n: number) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

function descScore(line: StatementLine, led: LedgerCardLine): number {
  const isPay = line.kind === 'payment';
  const ledPay = led.entry_kind === 'card_payment' || led.amount > 0;
  if (isPay) return ledPay ? 1 : 0;
  const a = tokens(line.description), b = tokens(led.description ?? '');
  for (const t of a) if (b.has(t)) return 1.5;
  for (const t of a) for (const u of b) if (t.length >= 5 && u.length >= 5 && (t.includes(u) || u.includes(t))) return 1;
  return 0;
}

/**
 * Ekstre satırlarını defterdeki kart hareketleriyle eşler. Bire bir eşleştirir; en güçlü çift önce.
 *  • Tutar: birebir (3 puan) ya da ≤1 TL fark (1,5; Excel'de kuruşlar yuvarlanmıştı). Taksitli kalemde ayrıca
 *    taksitin toplamı ve kalan tutarı da aday sayılır (defterde taksitli alışveriş tek kayıt olabilir).
 *  • Tarih: ≤1 gün 3, ≤4 gün 2, sonrası yakınlığa göre ≤1 puan. Taksitte alışveriş tarihi ve ekstre dönemi de sayılır.
 *  • Açıklama: ortak anlamlı kelime +1,5
 * ≥5 "eşleşti", ≥3,5 "olası eşleşme", altı "yeni". Aynı gün birden çok ödeme tek defter kaydına denk gelebilir.
 */
export function matchStatement(st: ParsedStatement, ledger: LedgerCardLine[]): MatchResult {
  const cand = ledger.filter((l) => l.entry_kind !== 'opening_balance' && l.entry_kind !== 'adjustment');
  type Pair = { li: number; ci: number; score: number };
  const pairs: Pair[] = [];
  const from = st.periodStart ?? st.cutDate;
  st.lines.forEach((line, li) => {
    const inst = line.installment;
    const amounts = [{ v: line.amount, w: 1 }];
    if (inst?.total) amounts.push({ v: inst.total, w: 0.8 });
    if (inst?.remaining) amounts.push({ v: inst.remaining, w: 0.8 });
    if (inst?.total && line.amount) amounts.push({ v: Math.round((inst.total - line.amount) * 100) / 100, w: 0.8 });
    cand.forEach((led, ci) => {
      const charge = -led.amount;
      if (Math.sign(line.amount) !== Math.sign(charge)) return;
      let aScore = 0;
      for (const a of amounts) {
        const diff = Math.abs(a.v - charge);
        const sc = diff <= 0.01 ? 3 * a.w : diff <= 1.0 && Math.abs(a.v) >= 5 ? (line.kind === 'payment' ? 2 : 1.5) * a.w : 0;
        aScore = Math.max(aScore, sc);
      }
      if (!aScore) return;
      let dd = dayDiff(line.date, led.entry_date);
      if (inst) {
        if (inst.no > 1) dd = Math.min(dd, dayDiff(addMonths(line.date, -(inst.no - 1)), led.entry_date));
        if (led.entry_date >= from && led.entry_date <= st.cutDate) dd = Math.min(dd, 3);
      }
      const dScore = dd <= 1 ? 3 : dd <= 4 ? 2 : dd <= 45 ? Math.max(0.3, 1 - dd / 70) : 0;
      if (!dScore) return;
      const score = Math.round((aScore + dScore + descScore(line, led)) * 100) / 100;
      if (score >= 3.5) pairs.push({ li, ci, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const usedL = new Set<number>(), usedC = new Set<number>();
  const best = new Map<number, Pair>();
  for (const p of pairs) {
    if (usedL.has(p.li) || usedC.has(p.ci)) continue;
    usedL.add(p.li); usedC.add(p.ci); best.set(p.li, p);
  }
  // Ödemeler: aynı gün birden çok ekstre ödemesi, defterde tek (yuvarlanmış) kayıt olabilir
  const byDate = new Map<string, number[]>();
  st.lines.forEach((l, li) => { if (l.kind === 'payment' && !usedL.has(li)) byDate.set(l.date, [...(byDate.get(l.date) ?? []), li]); });
  const groupHit = new Map<number, number>();
  for (const [date, idxs] of byDate) {
    if (idxs.length < 2) continue;
    const sum = idxs.reduce((a, i) => a + st.lines[i].amount, 0);
    const ci = cand.findIndex((c, i) => !usedC.has(i) && c.amount > 0 && dayDiff(c.entry_date, date) <= 2 && Math.abs(-c.amount - sum) <= 3);
    if (ci >= 0) { usedC.add(ci); idxs.forEach((i) => groupHit.set(i, ci)); }
  }
  const lines: LineMatch[] = st.lines.map((line, li) => {
    const p = best.get(li);
    if (p) {
      const led = cand[p.ci];
      return { line, status: p.score >= 5 ? 'matched' : 'maybe', entryId: led.entry_id, ledgerDate: led.entry_date, ledgerDesc: led.description, score: p.score };
    }
    const g = groupHit.get(li);
    if (g !== undefined) return { line, status: 'maybe', entryId: cand[g].entry_id, ledgerDate: cand[g].entry_date, ledgerDesc: `${cand[g].description ?? ''} (birden çok ödeme tek kayıt)`, score: 3.5 };
    return { line, status: 'new', entryId: null, ledgerDate: null, ledgerDesc: null, score: 0 };
  });
  const ledgerOnly = cand.filter((l, ci) => !usedC.has(ci) && l.entry_date >= from && l.entry_date <= st.cutDate);
  return { lines, ledgerOnly };
}

// ---------------------------------------------------------------------------
//  Kategori önerisi (yalnızca öneri; kullanıcı değiştirir)
// ---------------------------------------------------------------------------
const RULES: [RegExp, string][] = [
  [/market|bim|a101|sok\b|migros|vinmar|cergi|carrefour|kuruyemis|unlu mam|damla|sembol|gida/, 'Market'],
  [/yemek|trendyol yemek|getir|yemeksepeti|restoran|cafe|kafe|lokanta|burger|pizza/, 'Restoran'],
  [/petrol|akaryakit|opet|shell|po\b|seva|kuranli|park hayat|total|aygaz/, 'Yakıt'],
  [/eczane|hastane|klinik|saglik|sgk|doktor|optik/, 'Sağlık'],
  [/apple\.com|netflix|spotify|youtube|hepsiburada.*uyelik|uyelik|abonel/, 'Abonelikler'],
  [/turkcell|vodafone|turk telekom|internet|elektrik|dogalgaz|dogal g|igdas|su fatur|enerjisa|aski/, 'Ev'],
  [/lcw|waikiki|giyim|zara|koton|defacto|mavi|beyaz|boyner|konfeksiyon|ayakkabi/, 'Giyim'],
  [/amazon|iyzico|hepsi|trendyol|n11|online|param/, 'Online Alışveriş'],
  [/sigorta|kasko/, 'Sigorta'],
  [/vergi|mtv|trafik cezas|belediye|harc|noter/, 'Vergi ve Resmi Ödemeler'],
];
export function suggestCategoryName(line: StatementLine): string | null {
  if (['interest', 'tax'].includes(line.kind)) return 'Kart Faizi';
  if (line.kind === 'fee') return 'Banka Masrafı';
  const d = norm(line.description);
  for (const [re, name] of RULES) if (re.test(d)) return name;
  return null;
}
