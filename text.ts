// PDF metin öğelerini satırlara ve hücrelere çeviren, banka bağımsız yardımcılar.

export interface RawItem { str: string; x: number; y: number; w: number }
export interface Cell { x: number; x2: number; s: string }
export interface Row { page: number; y: number; cells: Cell[]; text: string }

/** EBCDIC (cp037) → Unicode. Akbank PDF'inin yazı katmanı bu kodlamayla gelir. */
const EBCDIC: Record<number, string> = {
  0x40: ' ', 0x4b: '.', 0x4c: '<', 0x4d: '(', 0x4e: '+', 0x50: '&', 0x5a: '!', 0x5b: '$', 0x5c: '*', 0x5d: ')', 0x5e: ';',
  0x60: '-', 0x61: '/', 0x6b: ',', 0x6c: '%', 0x6d: '_', 0x6e: '>', 0x6f: '?', 0x7a: ':', 0x7b: '#', 0x7c: '@', 0x7d: "'", 0x7e: '=', 0x7f: '"',
};
const fill = (start: number, chars: string) => { for (let i = 0; i < chars.length; i++) EBCDIC[start + i] = chars[i]; };
fill(0x81, 'abcdefghi'); fill(0x91, 'jklmnopqr'); fill(0xa2, 'stuvwxyz');
fill(0xc1, 'ABCDEFGHI'); fill(0xd1, 'JKLMNOPQR'); fill(0xe2, 'STUVWXYZ'); fill(0xf0, '0123456789');

export function looksEbcdic(items: RawItem[]): boolean {
  let eb = 0, ascii = 0;
  for (const it of items) for (const ch of it.str) {
    if ('ðñòóôõö÷øù'.includes(ch)) eb++;
    else if (ch >= '0' && ch <= '9') ascii++;
  }
  return eb >= 20 && eb > ascii * 2;
}
export const decodeEbcdic = (s: string) => Array.from(s, (ch) => (ch.charCodeAt(0) < 256 ? EBCDIC[ch.charCodeAt(0)] ?? '' : ch)).join('');

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/g;
const PLACEHOLDER = '\u0001';

/** Öğeleri y konumuna göre satırlara, aralarındaki boşluğa göre hücrelere ayırır. */
export function buildRows(items: RawItem[], page: number, opts: { ebcdic?: boolean } = {}): Row[] {
  // Boşluk öğeleri (bazıları çok geniş) sütunları birbirine bağlar: at. Kontrol karakteri = eksik harf yer tutucusu.
  const clean: RawItem[] = [];
  for (const it of items) {
    const raw = opts.ebcdic ? decodeEbcdic(it.str) : it.str;
    const cleaned = raw.replace(CTRL, '');
    if (cleaned.trim() === 'bosluk') continue;   // Garanti PDF'inde boş hücre işareti
    if (cleaned.trim() !== '') clean.push({ ...it, str: cleaned.replace(/^\s+|\s+$/g, (m) => (m ? ' ' : '')) });
    else if (CTRL.test(raw)) clean.push({ ...it, str: PLACEHOLDER, w: it.w > 0 ? it.w : 4.4 });
  }
  clean.sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: typeof clean[] = [];
  for (const it of clean) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].y - it.y) <= 4) g.push(it); else groups.push([it]);
  }
  return groups.map((g) => {
    g.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    for (const it of g) {
      const last = cells[cells.length - 1];
      // Akbank'ta karakter genişliği bilinmez: yakın öğeleri birleştir
      const gap = it.x - (last?.x2 ?? -1e9);
      const join = last && (opts.ebcdic ? gap <= 9 : gap <= 4);
      const w = it.w > 0 ? it.w : 4.4 * it.str.length;
      if (join) { last.s += (gap > (opts.ebcdic ? 9 : 1.8) ? ' ' : '') + it.str; last.x2 = it.x + w; }
      else cells.push({ x: it.x, x2: it.x + w, s: it.str });
    }
    cells.forEach((c) => { c.s = c.s.split(PLACEHOLDER).join('').replace(/\s+/g, ' ').trim(); });
    const kept = cells.filter((c) => c.s !== '');
    return { page, y: g[0].y, cells: kept, text: kept.map((c) => c.s).join(' ').replace(/\s+/g, ' ').trim() };
  }).filter((r) => r.text !== '');
}

// ---------------------------------------------------------------------------
export const ascii = (s: string) =>
  s.replace(/İ/g, 'I').replace(/ı/g, 'i').replace(/Ş/g, 'S').replace(/ş/g, 's').replace(/Ğ/g, 'G').replace(/ğ/g, 'g')
    .replace(/Ü/g, 'U').replace(/ü/g, 'u').replace(/Ö/g, 'O').replace(/ö/g, 'o').replace(/Ç/g, 'C').replace(/ç/g, 'c');
export const norm = (s: string) => ascii(s).toLowerCase().replace(/\s+/g, ' ').trim();

/** "1.234,56", "1,234.56", "-32,25", "6.953,00+", "1,732.81(-)", "*6.694,69 TL" → sayı. İşaret: sonda/başta "-" = negatif. */
export function parseMoney(raw: string): { value: number; plus: boolean } | null {
  let s = raw.replace(/TL|TRY|₺/gi, '').replace(/\s+/g, '').replace(/^\*/, '');
  let neg = false, plus = false;
  if (s.endsWith('(-)')) { neg = true; s = s.slice(0, -3); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.endsWith('+')) { plus = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); } else if (s.startsWith('+')) { plus = true; s = s.slice(1); }
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const m = s.match(/^(.*?)[.,](\d{2})$/);
  const int = (m ? m[1] : s).replace(/[.,]/g, '');
  const v = Number(`${int || '0'}.${m ? m[2] : '00'}`);
  return Number.isFinite(v) ? { value: neg ? -v : v, plus } : null;
}
export const MONEY_RE = /(?:^|\s)([-+*]?\d{1,3}(?:[.,]\d{3})*[.,]\d{2}(?:\(-\)|[-+])?)(?=\s|$|TL)/g;
export const moneyIn = (s: string) => { const out: number[] = []; for (const m of s.matchAll(MONEY_RE)) { const p = parseMoney(m[1]); if (p) out.push(p.value); } return out; };

const MONTHS: [RegExp, number][] = [
  [/ocak|^cak/, 1], [/ubat/, 2], [/^mart/, 3], [/nisan/, 4], [/^may/, 5], [/hazi/, 6], [/temm/, 7], [/ustos|agus/, 8],
  [/eyl/, 9], [/ekim/, 10], [/kas.?m|kasm/, 11], [/aral/, 12],
];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** dd/mm/yyyy · dd.mm.yyyy · "09 Mart 2026" → YYYY-MM-DD */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/(\d{1,2})\s+([^\d\s,.]+)\s+(\d{4})/);
  if (m) {
    const w = ascii(m[2]).toLowerCase();
    const hit = MONTHS.find(([re]) => re.test(w));
    if (hit) return iso(Number(m[3]), hit[1], Number(m[1]));
  }
  return null;
}
export const DATE_ANY = /\d{1,2}[./]\d{1,2}[./]\d{4}|\d{1,2}\s+[^\d\s,.]{3,12}\s+\d{4}/;

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const addDaysIso = (s: string, n: number) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const addMonthsIso = (s: string, n: number) => {
  const d = new Date(s + 'T12:00:00Z'); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10);
};
