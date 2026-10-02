// Excel / yapıştırma → işlem satırları. Saf mantık: dosya okuma xlsx.ts'te.
import { norm } from '../statements/text';
import { parseAmount } from '../format';
import type { AccountBalance, Category } from '../types';

export type RowKind = 'expense' | 'income' | 'transfer' | 'payment' | 'refund' | 'carry';

export interface ImportRow {
  id: number;
  include: boolean;
  date: string;               // YYYY-MM-DD ("" = okunamadı)
  kind: RowKind;
  account: string;            // dosyadaki hesap / kart adı
  toAccount: string;
  category: string;
  amount: number;             // her zaman pozitif; yönü tür belirler
  description: string;
  installments: number;
  note: string;               // ayrıştırma notu (atlanma nedeni vb.)
  keyBase: string;            // içerik anahtarı: aynı dosya tekrar yüklenirse çift kayıt olmaz
  /** Elle seçilenler eşlemeyi ezer */
  accountId?: string; toAccountId?: string; categoryId?: string; sourceId?: string;
}

export interface SheetData { name: string; rows: unknown[][] }
export interface ParseResult { rows: ImportRow[]; formats: string[]; ignoredSheets: string[]; warnings: string[] }

export const KIND_LABEL: Record<RowKind, string> = {
  expense: 'Gider', income: 'Gelir', transfer: 'Transfer', payment: 'Kart ödemesi', refund: 'Kart iadesi', carry: 'Devreden borç',
};

// ---------------------------------------------------------------------------
//  Hücre dönüştürücüler
// ---------------------------------------------------------------------------
const str = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v === 'string' && v.trim() !== '') return parseAmount(v);
  return null;
}

const isoOf = (y: number, m: number, d: number) => {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';   // 31 Nisan gibi günleri reddet
};

export function toDate(v: unknown): string {
  if (v instanceof Date && !isNaN(v.getTime())) return isoOf(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'number' && v > 20000 && v < 80000) {            // Excel seri günü
    const d = new Date(Math.round((v - 25569) * 86400000));
    return isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = str(v);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return isoOf(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) return isoOf(+m[3], +m[2], +m[1]);
  return '';
}

// ---------------------------------------------------------------------------
//  Başlık tanıma
// ---------------------------------------------------------------------------
const KNOWN = ['tarih', 'tur', 'hesap', 'hedef hesap', 'kategori', 'tutar', 'aciklama', 'kart adi', 'banka', 'odeme turu',
  'kaynak', 'taksit sayisi', 'taksitli mi?', 'taksit', 'para birimi', 'not', 'notlar'];

function findHeader(rows: unknown[][]): { at: number; col: Map<string, number> } | null {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const cells = rows[i].map((c) => norm(str(c)));
    if (cells.filter((c) => KNOWN.includes(c)).length >= 2) {
      const col = new Map<string, number>();
      cells.forEach((c, j) => { if (c && !col.has(c)) col.set(c, j); });
      return { at: i, col };
    }
  }
  return null;
}

type Getter = (row: unknown[], ...names: string[]) => unknown;
const getter = (col: Map<string, number>): Getter => (row, ...names) => {
  for (const n of names) { const j = col.get(n); if (j !== undefined && row[j] !== null && row[j] !== undefined && str(row[j]) !== '') return row[j]; }
  return undefined;
};

const blank = (row: unknown[]) => row.every((c) => c === null || c === undefined || str(c) === '');

function kindOf(raw: string): RowKind | null {
  const k = norm(raw);
  if (!k) return null;
  if (/^(gider|harcama|masraf|expense)/.test(k)) return 'expense';
  if (/^(gelir|income|maas)/.test(k)) return 'income';
  if (/^(transfer|havale|eft)/.test(k)) return 'transfer';
  if (/iade|refund/.test(k)) return 'refund';
  if (/odeme|payment|kart odemesi/.test(k)) return 'payment';
  return null;
}

const baseRow = (id: number): ImportRow => ({
  id, include: true, date: '', kind: 'expense', account: '', toAccount: '', category: '', amount: 0,
  description: '', installments: 1, note: '', keyBase: '',
});

// ---------------------------------------------------------------------------
//  Sayfa türleri
// ---------------------------------------------------------------------------
type SheetKind = 'generic' | 'legacyExpense' | 'legacyPayment' | 'legacyIncome';

function sheetKind(col: Map<string, number>): SheetKind | null {
  const has = (...n: string[]) => n.every((x) => col.has(x));
  if (has('kart adi', 'odeme turu')) return 'legacyPayment';
  if (has('kart adi', 'tutar') && (col.has('taksitli mi?') || col.has('kategori'))) return 'legacyExpense';
  if (has('tarih', 'kaynak', 'tutar') && !col.has('kart adi')) return 'legacyIncome';
  if (has('tarih', 'tutar') && (col.has('hesap') || col.has('tur'))) return 'generic';
  return null;
}

const FORMAT_LABEL: Record<SheetKind, string> = {
  generic: 'Genel şablon', legacyExpense: 'Eski Excel · Kart harcamaları', legacyPayment: 'Eski Excel · Kart ödemeleri', legacyIncome: 'Eski Excel · Gelirler',
};

function parseSheet(sheet: SheetData, nextId: () => number): { kind: SheetKind; rows: ImportRow[] } | null {
  const h = findHeader(sheet.rows);
  if (!h) return null;
  const kind = sheetKind(h.col);
  if (!kind) return null;
  const g = getter(h.col);
  const out: ImportRow[] = [];

  for (const raw of sheet.rows.slice(h.at + 1)) {
    if (blank(raw)) continue;
    const r = baseRow(nextId());
    r.date = toDate(g(raw, 'tarih'));
    const amtRaw = toNum(g(raw, 'tutar'));
    if (amtRaw === null && r.date === '') continue;                 // anlamsız satır
    const desc = str(g(raw, 'aciklama'));
    const note = str(g(raw, 'notlar', 'not'));
    r.description = [desc, note].filter(Boolean).join(' · ');

    if (kind === 'legacyExpense') {
      r.account = str(g(raw, 'kart adi'));
      r.category = str(g(raw, 'kategori'));
      const taksitli = norm(str(g(raw, 'taksitli mi?'))) === 'evet';
      const n = Math.round(toNum(g(raw, 'taksit sayisi')) ?? 1);
      r.installments = taksitli && n > 1 ? Math.min(n, 36) : 1;
      r.kind = (amtRaw ?? 0) < 0 ? 'refund' : 'expense';
      if (norm(r.category) === 'devreden' && r.kind === 'expense') {
        r.kind = 'carry';                  // harcama değil: tarihli devreden borç kaydı
        r.installments = 1;
        r.note = 'Devreden borç: gider sayılmaz, kartın borcuna tarihli açılış kaydı olarak eklenir.';
      }
    } else if (kind === 'legacyPayment') {
      r.kind = 'payment';
      r.account = str(g(raw, 'kart adi'));
      r.description = [str(g(raw, 'odeme turu')), note].filter(Boolean).join(' · ');
    } else if (kind === 'legacyIncome') {
      r.kind = 'income';
      r.category = str(g(raw, 'kaynak'));
      r.description = [str(g(raw, 'kaynak')), note].filter(Boolean).join(' · ');
    } else {
      r.account = str(g(raw, 'hesap', 'kart adi'));
      r.toAccount = str(g(raw, 'hedef hesap'));
      r.category = str(g(raw, 'kategori'));
      const t = str(g(raw, 'tur'));
      const k = kindOf(t);
      if (t && !k) { r.include = false; r.note = `Bilinmeyen tür: “${t}”`; }
      r.kind = k ?? ((amtRaw ?? 0) > 0 && !t && !r.category ? 'expense' : (amtRaw ?? 0) < 0 && !t ? 'expense' : 'expense');
      if (!k && !t && (amtRaw ?? 0) > 0 && !r.category && !r.account) r.kind = 'expense';
      const inst = Math.round(toNum(g(raw, 'taksit')) ?? 1);
      r.installments = r.kind === 'expense' && inst > 1 ? Math.min(inst, 36) : 1;
    }
    r.amount = Math.abs(amtRaw ?? 0);
    if (kind === 'legacyIncome' && (amtRaw ?? 0) < 0) { r.include = false; r.note = 'Eksi tutarlı gelir satırı'; }
    r.keyBase = [sheet.name, r.date, r.kind, r.account, r.toAccount, r.category, r.amount.toFixed(2), r.description, r.installments].join('|');
    out.push(r);
  }
  return { kind, rows: out };
}

/** Aynı içerikli satırlara sıra numarası ekler: ayrı ama özdeş iki harcama birbirini "çift kayıt" saymaz */
function stampKeys(rows: ImportRow[]) {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const n = (seen.get(r.keyBase) ?? 0) + 1;
    seen.set(r.keyBase, n);
    r.keyBase = `${r.keyBase}#${n}`;
  }
}

export function parseSheets(sheets: SheetData[]): ParseResult {
  let id = 0;
  const nextId = () => ++id;
  const rows: ImportRow[] = [];
  const formats: string[] = [];
  const ignored: string[] = [];
  for (const s of sheets) {
    const p = parseSheet(s, nextId);
    if (!p) { ignored.push(s.name); continue; }
    formats.push(`${s.name} (${FORMAT_LABEL[p.kind]}, ${p.rows.length} satır)`);
    rows.push(...p.rows);
  }
  stampKeys(rows);
  const warnings: string[] = [];
  if (rows.length === 0) warnings.push('Tanınan bir işlem sayfası bulunamadı. Başlıklar şöyle olmalı: Tarih, Tür, Hesap, Kategori, Tutar, Açıklama (şablonu indirebilirsiniz).');
  return { rows, formats, ignoredSheets: ignored, warnings };
}

// ---------------------------------------------------------------------------
//  Yapıştırılan metin (Excel'den kopyala → yapıştır) ve CSV
// ---------------------------------------------------------------------------
export function parseDelimited(text: string): unknown[][] {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const delim = lines[0].includes('\t') ? '\t' : (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) && lines[0].includes(';') ? ';' : ',';
  return lines.map((l) => {
    const cells: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === delim && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  });
}

/** Başlıksız yapıştırma: sütun sırası Tarih · Tür · Hesap · Kategori · Tutar · Açıklama */
export function parsePasted(text: string): ParseResult {
  const grid = parseDelimited(text);
  if (!grid.length) return { rows: [], formats: [], ignoredSheets: [], warnings: ['Yapıştırılan metin boş.'] };
  const withHeader = findHeader(grid) ? grid : [['Tarih', 'Tür', 'Hesap', 'Kategori', 'Tutar', 'Açıklama'], ...grid];
  return parseSheets([{ name: 'Yapıştırılan', rows: withHeader }]);
}

export function emptyRow(id: number, date: string): ImportRow {
  const r = baseRow(id);
  r.date = date;
  r.keyBase = `manual:${id}:${Math.random().toString(36).slice(2)}`;
  return r;
}

// ---------------------------------------------------------------------------
//  Eşleştirme: dosyadaki adlar → sistemdeki hesap / kategori
// ---------------------------------------------------------------------------
export interface Mapping {
  accounts: Record<string, string>;      // dosyadaki ad → hesap id ("" = eşleşmedi)
  categories: Record<string, string>;    // "e:Market" / "i:Maaş" → kategori id
  defaultAccountId: string;              // hesabı olmayan satırlar (ör. eski Excel gelirleri)
  defaultSourceId: string;               // kaynağı olmayan kart ödemeleri için ("" = kaynak belirsiz)
}

export function autoMapAccount(name: string, accounts: AccountBalance[]): string {
  const n = norm(name);
  if (!n) return '';
  const act = accounts.filter((a) => !a.archived_at);
  return (act.find((a) => norm(a.name) === n)
    ?? act.find((a) => a.iban_last4 && new RegExp(`\\b${a.iban_last4}\\b`).test(name))
    ?? act.find((a) => norm(a.name).startsWith(n) || n.startsWith(norm(a.name))))?.id ?? '';
}

export function autoMapCategory(name: string, kind: 'income' | 'expense', categories: Category[]): string {
  const act = categories.filter((c) => c.kind === kind && !c.archived_at);
  const n = norm(name);
  const hit = n ? (act.find((c) => c.parent_id && norm(c.name) === n) ?? act.find((c) => norm(c.name) === n)) : undefined;
  if (hit) return hit.id;
  const other = act.find((c) => !c.parent_id && /^diger/.test(norm(c.name)));
  return other?.id ?? '';
}

export const catKey = (kind: RowKind, name: string) => `${kind === 'income' ? 'i' : 'e'}:${name}`;
const needsCategory = (k: RowKind) => k === 'expense' || k === 'income';

export function buildMapping(rows: ImportRow[], accounts: AccountBalance[], categories: Category[], prev?: Mapping): Mapping {
  const m: Mapping = { accounts: { ...(prev?.accounts ?? {}) }, categories: { ...(prev?.categories ?? {}) },
    defaultAccountId: prev?.defaultAccountId ?? '', defaultSourceId: prev?.defaultSourceId ?? '' };
  for (const r of rows) {
    for (const n of [r.account, r.toAccount]) if (n && !(n in m.accounts)) m.accounts[n] = autoMapAccount(n, accounts);
    if (needsCategory(r.kind)) {
      const k = catKey(r.kind, r.category);
      if (!(k in m.categories)) m.categories[k] = autoMapCategory(r.category, r.kind === 'income' ? 'income' : 'expense', categories);
    }
  }
  return m;
}

export interface Resolved { accountId: string; toAccountId: string; categoryId: string; sourceId: string }

export function resolveRow(r: ImportRow, m: Mapping): Resolved {
  const acc = r.accountId ?? (r.account ? m.accounts[r.account] : m.defaultAccountId) ?? '';
  return {
    accountId: acc,
    toAccountId: r.toAccountId ?? (r.toAccount ? m.accounts[r.toAccount] : '') ?? '',
    categoryId: r.categoryId ?? (needsCategory(r.kind) ? m.categories[catKey(r.kind, r.category)] ?? '' : ''),
    sourceId: r.sourceId ?? (r.kind === 'payment' ? m.defaultSourceId : ''),
  };
}

/** Satırın sorunları (boşsa içe aktarılabilir) */
export function problemsOf(r: ImportRow, res: Resolved, accounts: AccountBalance[], today: string): string[] {
  const out: string[] = [];
  const acc = accounts.find((a) => a.id === res.accountId);
  if (!r.date) out.push('Tarih okunamadı'); else if (r.date > today) out.push('Tarih gelecekte');
  if (!(r.amount > 0)) out.push('Tutar yok');
  if (!acc) out.push(r.kind === 'income' && !r.account ? 'Gelirin gireceği hesabı seçin' : 'Hesap eşleşmedi');
  if (needsCategory(r.kind) && !res.categoryId) out.push('Kategori seçin');
  if (r.kind === 'transfer') {
    const to = accounts.find((a) => a.id === res.toAccountId);
    if (!to) out.push('Hedef hesap seçin'); else if (to.id === res.accountId) out.push('Aynı hesaba transfer');
    else if (acc && to.currency !== acc.currency) out.push('Farklı para birimi: Hızlı ekle ile girin');
  }
  if (r.kind === 'carry' && acc && ['fixed_asset', 'investment', 'receivable'].includes(acc.kind)) out.push('Bu hesaba devreden borç girilemez');
  if ((r.kind === 'payment' || r.kind === 'refund') && acc && acc.kind !== 'credit_card') out.push('Ödeme/iade kredi kartı hesabına olmalı');
  if (r.installments > 1 && acc && acc.kind !== 'credit_card') out.push('Taksit yalnızca kredi kartında');
  if (acc && (r.kind === 'expense') && ['loan', 'receivable', 'fixed_asset'].includes(acc.kind)) out.push('Bu hesaptan gider girilemez');
  return out;
}

export async function rowKey(r: ImportRow): Promise<string> {
  const data = new TextEncoder().encode(r.keyBase);
  const d = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(d).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function toPayload(rows: ImportRow[], m: Mapping) {
  const out = [];
  for (const r of rows) {
    const res = resolveRow(r, m);
    out.push({
      key: await rowKey(r), kind: r.kind, date: r.date, account_id: res.accountId,
      to_account_id: res.toAccountId || null, category_id: res.categoryId || null, source_account_id: res.sourceId || null,
      amount: r.amount, description: r.description.slice(0, 200), installments: r.installments,
      purchase_amount: r.installments > 1 ? r.amount : null,
    });
  }
  return out;
}
