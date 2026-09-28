import type { BankId, LineKind, ParsedStatement, StatementLine } from './types';
import { StatementError } from './types';
import { addDaysIso, addMonthsIso, ascii, buildRows, looksEbcdic, moneyIn, norm, parseDate, parseMoney, round2, type Cell, type RawItem, type Row } from './text';

export type PageItems = RawItem[];

// ---------------------------------------------------------------------------
//  Ortak yardımcılar
// ---------------------------------------------------------------------------
const num = (s: string | undefined | null) => { const p = s ? parseMoney(s) : null; return p ? p.value : null; };
const first = (t: string, re: RegExp) => { const m = t.match(re); return m ? m[1] : null; };
const inX = (r: Row, lo: number, hi: number) => r.cells.filter((c) => c.x >= lo && c.x <= hi);
const dateAtStart = (s: string) => {
  const m = s.match(/^(\d{1,2}[./]\d{1,2}[./]\d{4}|\d{1,2}\s+[^\d\s,.]{3,12}\s+\d{4})\s*(.*)$/);
  if (!m) return null;
  const d = parseDate(m[1]);
  return d ? { date: d, rest: m[2] } : null;
};
const last4 = (s: string) => first(s, /(\d{4})\s*$/) ?? first(s, /(\d{4})/);

export function classify(desc: string, amount: number, hasInstallment: boolean): LineKind {
  const d = norm(desc);
  if (amount < 0) return /deme|tahsilat|tesek+r|teekkr/.test(d) ? 'payment' : 'refund';
  if (hasInstallment) return /nakit (avans|cekim)|iscp tk|nakit tk/.test(d) ? 'cash_advance' : 'installment';
  if (/kkdf|bsmv/.test(d)) return 'tax';
  if (/faiz|vade fark/.test(d)) return 'interest';
  if (/aidat|uyelik ucret|kart ucret|masraf|komisyon|eft ucret/.test(d)) return 'fee';
  if (/nakit (avans|cekim)|iscp tk|nakit tk/.test(d)) return hasInstallment ? 'installment' : 'cash_advance';
  return hasInstallment ? 'installment' : 'purchase';
}

function line(idx: number, date: string, guessed: boolean, description: string, amount: number, suffix: string | null,
  inst: StatementLine['installment']): StatementLine {
  const desc = description.replace(/\s+/g, ' ').trim();
  return { idx, date, dateGuessed: guessed, description: desc, amount: round2(amount), kind: classify(desc, amount, !!inst), cardSuffix: suffix, installment: inst };
}

function empty(bank: BankId, product: string): ParsedStatement {
  return {
    bank, product, cardLast4: null, cutDate: '', dueDate: null, periodStart: null, nextCutDate: null, nextDueDate: null,
    statementDebt: 0, minPayment: null, minPaymentPct: null, previousBalance: null, limit: null, availableLimit: null, cashLimit: null,
    rates: { purchase: null, cash: null, late: null }, summary: { purchases: null, feesInterest: null, payments: null },
    lines: [], checks: [], warnings: [],
  };
}

/** Bütün bankalar için ortak doğrulamalar. Para verisi olduğu için okuma hatası sessiz kalmamalı. */
function finalize(st: ParsedStatement): ParsedStatement {
  if (!st.cutDate) throw new StatementError('PARSE', 'Hesap kesim tarihi okunamadı');
  if (!(st.statementDebt >= 0)) throw new StatementError('PARSE', 'Dönem borcu okunamadı');
  if (!st.periodStart) st.periodStart = addDaysIso(addMonthsIso(st.cutDate, -1), 1);
  st.lines.forEach((l, i) => { l.idx = i; });
  if (st.previousBalance !== null) {
    const sum = round2(st.previousBalance + st.lines.reduce((a, l) => a + l.amount, 0));
    const ok = Math.abs(sum - st.statementDebt) <= 0.02;
    st.checks.push({ id: 'sum', ok, label: 'Önceki bakiye + kalemler = dönem borcu',
      detail: ok ? undefined : `Kalemlerden hesaplanan ${sum.toFixed(2)}, ekstredeki ${st.statementDebt.toFixed(2)} (fark ${(sum - st.statementDebt).toFixed(2)})` });
  }
  if (st.summary.payments !== null) {
    const pay = round2(-st.lines.filter((l) => l.amount < 0).reduce((a, l) => a + l.amount, 0));
    const ok = Math.abs(pay - Math.abs(st.summary.payments)) <= 0.02;
    st.checks.push({ id: 'pay', ok, label: 'Ödemeler ekstre özetiyle uyumlu', detail: ok ? undefined : `Kalemlerde ${pay.toFixed(2)}, özette ${Math.abs(st.summary.payments).toFixed(2)}` });
  }
  if (st.minPayment !== null) st.checks.push({ id: 'min', ok: st.minPayment <= st.statementDebt + 0.01, label: 'Asgari ödeme ≤ dönem borcu' });
  if (st.dueDate) st.checks.push({ id: 'dates', ok: st.dueDate > st.cutDate, label: 'Son ödeme tarihi kesimden sonra' });
  if (st.limit !== null && st.availableLimit !== null) st.checks.push({ id: 'limit', ok: st.availableLimit <= st.limit + 0.01, label: 'Kullanılabilir limit ≤ limit' });
  for (const c of st.checks) if (!c.ok) st.warnings.push(`${c.label}: ${c.detail ?? 'tutmuyor'}`);
  if (st.lines.length === 0) st.warnings.push('Ekstrede işlem satırı bulunamadı.');
  return st;
}

const allText = (rows: Row[]) => rows.map((r) => r.text).join('\n');
const mrate = (s: string | null) => { const m = s?.match(/(\d+)[,.](\d+)/); return m ? Number(`${m[1]}.${m[2]}`) : null; };

// ---------------------------------------------------------------------------
//  QNB (GO, GSPara vb.)
// ---------------------------------------------------------------------------
function parseQnb(rows: Row[]): ParsedStatement {
  const t = rows.map((r) => norm(r.text)).join('\n');
  const st = empty('qnb', rows[0]?.text.replace(/\s+/g, ' ') ?? 'QNB');
  st.cardLast4 = first(t, /kredi karti numarasi\s*:\s*\d{4} \d{2}\*+ \*+ (\d{4})/);
  st.cutDate = parseDate(first(t, /hesap kesim tarihi\s*:\s*(\d\d\/\d\d\/\d{4})/) ?? '') ?? '';
  st.statementDebt = num(first(t, /d\w?nem borcu\s*:\s*([\d.,]+)/)) ?? NaN;
  st.minPayment = num(first(t, /asgari \w?deme tutari\s*:\s*([\d.,]+)/));
  st.minPaymentPct = num(first(t, /asgari \w?deme orani\s*:\s*tl %([\d.,]+)/));
  st.limit = num(first(t, /kredi karti limiti\s*:\s*([\d.,]+)/));
  st.cashLimit = num(first(t, /nakit avans limiti\s*:\s*([\d.,]+)/));
  st.availableLimit = num(first(t, /kullanilabilir limit\s*:\s*([\d.,]+)/));
  st.dueDate = parseDate(first(t, /son \w?deme tarihi:\s*(\d{1,2} \S+ \d{4})/) ?? '');
  st.nextCutDate = parseDate(first(t, /bir sonraki hesap kesim tarihiniz\s*(\d\d\/\d\d\/\d{4})/) ?? '');
  st.nextDueDate = parseDate(first(t, /bir sonraki son \w?deme tarihiniz\s*(\d\d\/\d\d\/\d{4})/) ?? '');
  const rate = t.match(/aylik tl\s*%([\d.]+)\s*%([\d.]+)\s*%([\d.]+)\s*%([\d.]+)/);
  if (rate) st.rates = { purchase: Number(rate[1]), cash: Number(rate[2]), late: Number(rate[3]) };

  // Özet tablosu: önceki, harcama+nakit avans, ücret, faiz, vergi, ödemeler, dönem borcu
  const sumRow = rows.find((r) => moneyIn(r.text).length >= 7 && /TL\s*$/.test(r.text));
  if (sumRow) {
    const v = moneyIn(sumRow.text);
    st.previousBalance = v[0]; st.summary = { purchases: v[1], feesInterest: round2(v[2] + v[3] + v[4]), payments: v[5] };
  }
  let suffix: string | null = null;
  for (const r of rows) {
    const s = norm(r.text);
    const sec = s.match(/^(asil|sanal|ek) kart\s*:\s*\d{4} \d{2}\*+ \*+ (\d{4})/);
    if (sec) { suffix = sec[2]; continue; }
    if (/^onceki d\w?nem bakiyeniz/.test(s)) { st.previousBalance ??= num(r.cells[r.cells.length - 1]?.s); continue; }
    const d = dateAtStart(r.cells[0]?.s ?? '');
    if (!d) continue;
    const amt = inX(r, 400, 470).map((c) => parseMoney(c.s)).find(Boolean);
    if (!amt) continue;               // ParaPuan satırları: tutar sütunu boş
    const desc = r.cells.filter((c) => c.x > 100 && c.x < 400).map((c) => c.s).join(' ');
    st.lines.push(line(0, d.date, false, desc, amt.value, suffix, null));
  }
  return finalize(st);
}

// ---------------------------------------------------------------------------
//  Garanti BBVA
// ---------------------------------------------------------------------------
function parseGaranti(rows: Row[]): ParsedStatement {
  const t = rows.map((r) => norm(r.text)).join('\n');
  const st = empty('garanti', first(norm(rows[0]?.text ?? ''), /^(.*?) bilgileriniz/) ? rows[0].text.replace(/\s*Bilgileriniz.*/i, '') : 'Garanti');
  st.cardLast4 = first(t, /kart numarasi\s+\d{4} \d{2}\*+ \*+ (\d{4})/);
  st.cutDate = parseDate(first(t, /hesap kesim tarihi\s+(\d{1,2} \S+ \d{4})/) ?? '') ?? '';
  st.dueDate = parseDate(first(t, /\nson odeme tarihi\s+(\d{1,2} \S+ \d{4})/) ?? '');
  st.statementDebt = num(first(t, /donem borcunuz\s+([\d.,]+)/)) ?? NaN;
  st.minPayment = num(first(t, /min\. odeme tutari\s+([\d.,]+)/));
  st.limit = num(first(t, /\nkart limiti\s+([\d.,]+)/));
  st.cashLimit = num(first(t, /nakit avans limiti\s+([\d.,]+)/));
  st.availableLimit = num(first(t, /kullanilabilir limitiniz\s+([\d.,]+)/));
  st.nextCutDate = parseDate(first(t, /bir sonraki hesap kesiminiz\s+(\d{1,2} \S+ \d{4})/) ?? '');
  st.nextDueDate = parseDate(first(t, /son odemeniz\s+(\d{1,2} \S+ \d{4})/) ?? '');
  const prevCut = parseDate(first(t, /bir onceki hesap kesim tarihiniz\s+(\d{1,2} \S+ \d{4})/) ?? '');
  if (prevCut) st.periodStart = addDaysIso(prevCut, 1);
  st.rates = { purchase: mrate(first(t, /aylik guncel faiz oranlari: akdi faiz: %([\d,]+)/)), late: mrate(first(t, /gecikme faizi: %([\d,]+)/)), cash: mrate(first(t, /nakit avans faizi: %([\d,]+)/)) };
  const box = rows.find((r) => /^\d[\d.,]* TL \+/.test(r.text));
  if (box) { const v = moneyIn(box.text); st.previousBalance = v[0]; st.summary = { purchases: v[1], feesInterest: v[2], payments: v[3] }; }

  let inTable = false; let suffix: string | null = null;
  for (const r of rows) {
    const s = norm(r.text);
    if (/islem tarihi.*donem ici islemler/.test(s) || /lem tarihi.*nem .i .lemler/.test(s)) { inTable = true; continue; }
    if (!inTable) continue;
    if (/^toplam\s+[\d.,]+$/.test(s)) { inTable = false; continue; }
    const sec = s.match(/sanal kart.*?(\d{4}) \d{2}\*+ \*+ (\d{4})/);
    if (sec) { suffix = sec[2]; continue; }
    const amtCell = r.cells[r.cells.length - 1];
    const money = parseMoney(amtCell?.s ?? '');
    if (!money || amtCell.x < 480) continue;
    if (/onceki donemden devir/.test(s)) { st.previousBalance ??= money.value; continue; }
    const d = dateAtStart(r.cells[0]?.s ?? '') ?? (r.cells[1] ? dateAtStart(r.cells[0].s) : null);
    const descCells = r.cells.filter((c) => c !== amtCell && c.x >= 160 && c.x < 480).map((c) => c.s);
    const desc = descCells.join(' ');
    const amount = money.plus ? -Math.abs(money.value) : money.value;      // "6.953,00+" = ödeme
    st.lines.push(line(0, d?.date ?? st.cutDate, !d, desc || r.text, amount, suffix, null));
  }
  return finalize(st);
}

// ---------------------------------------------------------------------------
//  İş Bankası (Maximum)
// ---------------------------------------------------------------------------
function parseIsbank(rows: Row[]): ParsedStatement {
  const t = rows.map((r) => norm(r.text)).join('\n');
  const st = empty('isbank', first(rows.map((r) => r.text).join('\n'), /(MAXIMUM[^\n]*?)\s+Hesap [ÖO]zetiniz/) ?? 'Maximum');
  st.cardLast4 = first(t, /kart numarasi:\s*\d{4}\*+(\d{4})/);
  st.cutDate = parseDate(first(t, /hesap kesim tarihi:\s*(\d\d\.\d\d\.\d{4})/) ?? '') ?? '';
  st.dueDate = parseDate(first(t, /\bson odeme tarihi:\s*(\d\d\.\d\d\.\d{4})/) ?? '');
  st.statementDebt = num(first(t, /hesap ozeti borcu:\s*([\d.,]+)/)) ?? NaN;
  st.minPayment = num(first(t, /asgari tutar:\s*\*?([\d.,]+)/));
  st.nextCutDate = parseDate(first(t, /bir sonraki hesap kesim tarihi:\s*(\d\d\.\d\d\.\d{4})/) ?? '');
  st.nextDueDate = parseDate(first(t, /bir sonraki son odeme tarihi:\s*(\d\d\.\d\d\.\d{4})/) ?? '');
  st.limit = num(first(t, /toplam kart limiti:\s*([\d.,]+)/));
  st.availableLimit = num(first(t, /toplam kullanilabilir kart limiti:\s*([\d.,]+)/));
  st.cashLimit = num(first(t, /nakit cekme limiti:\s*([\d.,]+)/));
  st.minPaymentPct = num(first(t, /asgari odeme orani:\s*%([\d.,]+)/));
  const rate = t.match(/aylik\s*%([\d,]+)\s*%([\d,]+)\s*%([\d,]+)\s*%([\d,]+)/);
  if (rate) st.rates = { purchase: mrate(rate[1]), cash: mrate(rate[2]), late: mrate(rate[3]) };

  let inTable = false; let suffix: string | null = null;
  for (const r of rows) {
    const s = norm(r.text);
    if (/^islem$|^tarihi\b.*aciklama|aciklama.*tutar/.test(s)) { inTable = true; continue; }
    if (!inTable) continue;
    if (/^toplam\b/.test(s)) { inTable = false; continue; }
    const sec = s.match(/sanal kart no:\s*\d{4} \*+ \*+ (\d{4})/);
    if (sec) { suffix = sec[1]; continue; }
    if (/bir onceki hesap ozeti bakiyeniz/.test(s)) { st.previousBalance ??= num(inX(r, 380, 440)[0]?.s); continue; }
    const d = dateAtStart(r.cells[0]?.s ?? '');
    if (!d) continue;
    const amtCell = r.cells.find((c) => c.x >= 380 && c.x <= 445 && parseMoney(c.s));
    if (!amtCell) continue;
    const money = parseMoney(amtCell.s)!;
    const instCell = r.cells.find((c) => /taksidi/i.test(c.s));
    const im = instCell?.s.match(/(\d+)\s*\/\s*(\d+)\s*taksidi\s*\(([\d.,]+)\)/i);
    const inst = im ? { no: Number(im[1]), count: Number(im[2]), total: num(im[3]), remaining: null } : null;
    const desc = [d.rest, ...r.cells.slice(1).filter((c) => c.x < 380 && c !== instCell).map((c) => c.s)].join(' ').trim();
    st.lines.push(line(0, d.date, false, desc, money.value, suffix, inst));
  }
  const remain = num(first(t, /kalan taksitli borc toplami:\s*([\d.,]+)/));
  if (remain !== null) st.warnings.push(`Kalan taksitli borç toplamı: ${remain.toFixed(2)} TL (bilgi)`);
  return finalize(st);
}

// ---------------------------------------------------------------------------
//  VakıfBank
// ---------------------------------------------------------------------------
function parseVakif(rows: Row[]): ParsedStatement {
  const t = rows.map((r) => norm(r.text)).join('\n');
  const st = empty('vakif', 'World');
  st.cardLast4 = first(t, /kart no\s*:\s*\d{4}\*+(\d{4})/);
  st.cutDate = parseDate(first(t, /\nhesap kesim tarihi\s*:\s*(\d\d\.\d\d\.\d{4})/) ?? '') ?? '';
  st.dueDate = parseDate(first(t, /\nson odeme tarihi\s*:\s*(\d\d\.\d\d\.\d{4})/) ?? '');
  st.statementDebt = num(first(t, /donem borcunuz\s*:\s*([\d.,]+)/)) ?? NaN;
  st.minPayment = num(first(t, /asgari odeme tutari\s*:\s*([\d.,]+)/));
  st.limit = num(first(t, /limitiniz\s*:\s*([\d.,]+)/));
  st.nextCutDate = parseDate(first(t, /bir sonraki hesap kesim tarihi\s*:\s*(\d\d\.\d\d\.\d{4})/) ?? '');
  st.nextDueDate = parseDate(first(t, /bir sonraki son odeme tarihi\s*:\s*(\d\d\.\d\d\.\d{4})/) ?? '');
  st.previousBalance = num(first(t, /onceki hesap bakiyesi\s+([\d.,]+)/));
  st.summary = { purchases: num(first(t, /donem ici islemler\s+([\d.,]+)/)), feesInterest: num(first(t, /toplam faiz ve ucretler\s+([\d.,]+)/)), payments: num(first(t, /\nodemeler\s+([\d.,]+)/)) };
  st.rates = { purchase: mrate(first(t, /alisveris faiz orani\s*%([\d.]+)/)), cash: mrate(first(t, /nakit cekim faiz orani\s*%([\d.]+)/)), late: mrate(first(t, /alisveris gecikme faiz orani\s*%([\d.]+)/)) };
  let inTable = false;
  for (const r of rows) {
    const s = norm(r.text);
    if (/islem tarihi.*aciklama.*tutar/.test(s)) { inTable = true; continue; }
    if (!inTable) continue;
    if (/^hesap ozeti$/.test(s)) break;
    const d = dateAtStart(r.cells[0]?.s ?? '');
    if (!d) continue;
    const amtCell = r.cells.find((c) => c.x >= 360 && c.x <= 435 && parseMoney(c.s));
    if (!amtCell) continue;
    const money = parseMoney(amtCell.s)!;
    const desc = r.cells.filter((c) => c.x >= 120 && c.x < 360).map((c) => c.s).join(' ');
    if (/onceki donem hesap ozeti bakiyeniz/.test(norm(desc))) { st.previousBalance ??= money.value; continue; }
    st.lines.push(line(0, d.date, false, desc, money.value, null, null));
  }
  return finalize(st);
}

// ---------------------------------------------------------------------------
//  Yapı Kredi (World)
// ---------------------------------------------------------------------------
function parseYapiKredi(rows: Row[]): ParsedStatement {
  const t = rows.map((r) => norm(r.text)).join('\n');
  const st = empty('yapikredi', 'World');
  st.cutDate = parseDate(first(t, /hesap kesim tarihi\s*:\s*(\d{1,2} \S+ \d{4})/) ?? '') ?? '';
  st.dueDate = parseDate(first(t, /\nson odeme tarihi\s*:\s*(\d{1,2} \S+ \d{4})/) ?? '');
  st.statementDebt = num(first(t, /\ndonem borcu\s*:\s*([\d.,]+)/)) ?? NaN;
  const min = t.match(/asgari tutar\/oran\s*:\s*([\d.,]+) tl \/ (\d+)%/);
  if (min) { st.minPayment = num(min[1]); st.minPaymentPct = Number(min[2]); }
  st.previousBalance = num(first(t, /onceki donem hesap ozeti borcu\s*:\s*([\d.,]+)/));
  const pay = first(t, /donem ici odemeler\s*:\s*([+\-]?[\d.,]+)/);
  st.summary = { purchases: num(first(t, /donem ici harcamalar\s*:\s*([\d.,]+)/)), feesInterest: null, payments: pay ? Math.abs(num(pay) ?? 0) : null };
  st.limit = num(first(t, /\nkart limiti\s*:\s*([\d.,]+)/));
  st.cashLimit = num(first(t, /nakit cekim limiti\s*:\s*([\d.,]+)/));
  st.nextCutDate = parseDate(first(t, /bir sonraki ay hesap kesim tarihi\s*:\s*(\d{1,2} \S+ \d{4})/) ?? '');
  st.nextDueDate = parseDate(first(t, /bir sonraki ay son odeme tarihi\s*:\s*(\d{1,2} \S+ \d{4})/) ?? '');
  st.cardLast4 = first(t, /\nkart numarasi\s*:\s*\d{4} \d{2}\*+ \*+ (\d{4})/);
  const ar = t.match(/akdi faiz orani\s*%([\d,]+) \/ %[\d,]+\s*%([\d,]+)/); const gr = t.match(/gecikme faiz orani\s*%([\d,]+)/);
  st.rates = { purchase: ar ? mrate(ar[1]) : null, cash: ar ? mrate(ar[2]) : null, late: gr ? mrate(gr[1]) : null };
  const remaining = num(first(t, /kalan toplam taksit tutari\s*:\s*([\d.,]+)/));

  let inTable = false; let suffix: string | null = null; let prevLine: StatementLine | null = null;
  for (const r of rows) {
    const s = norm(r.text);
    if (/islem tarihi.*islemler.*tutar/.test(s)) { inTable = true; continue; }
    if (!inTable) continue;
    if (/^puan ozeti/.test(s)) break;
    const sec = s.match(/^(?:dijital |sanal |ek )?kart numarasi\s*:\s*[\d*\s]*?(\d{4})\s/);
    if (sec) { suffix = sec[1]; prevLine = null; continue; }
    const ins = s.match(/([\d.,]+) tl'?lik islemin (\d+) \/ (\d+) taksidi/);
    if (ins && prevLine) { prevLine.installment = { no: Number(ins[2]), count: Number(ins[3]), total: num(ins[1]), remaining: prevLine.installment?.remaining ?? null }; prevLine.kind = 'installment'; continue; }
    if (/^onceki donem hesap ozeti borcu/.test(s)) { st.previousBalance ??= num(r.cells[r.cells.length - 1]?.s); continue; }
    const d = dateAtStart(r.cells[0]?.s ?? '');
    if (!d) continue;
    const amtCell = r.cells.find((c) => c.x >= 380 && c.x <= 430 && parseMoney(c.s));
    if (!amtCell) continue;
    const money = parseMoney(amtCell.s)!;
    const amount = money.plus ? -Math.abs(money.value) : money.value;      // "+23,99" = ödeme
    const rem = r.cells.find((c) => c.x > 430 && /\/\s*\d+/.test(c.s));
    const remM = rem?.s.match(/([\d.,]+)\s*\/\s*(\d+)/);
    const desc = r.cells.filter((c) => c.x >= 100 && c.x < 380).map((c) => c.s).join(' ');
    const l = line(0, d.date, false, desc, amount, suffix, remM ? { no: 0, count: 0, total: null, remaining: num(remM[1]) } : null);
    st.lines.push(l); prevLine = l;
  }
  if (remaining !== null && remaining > 0) st.warnings.push(`Kalan toplam taksit tutarı: ${remaining.toFixed(2)} TL (bilgi)`);
  return finalize(st);
}

// ---------------------------------------------------------------------------
//  Akbank (Axess) — PDF'in yazı katmanı EBCDIC kodlu; rakamlar ve büyük harfler güvenilir, küçük harfler eksik olabilir
// ---------------------------------------------------------------------------
function parseAkbank(rows: Row[]): ParsedStatement {
  const st = empty('akbank', 'Axess');
  // Sayfa 1'de ilk işlem satırına kadar olan bölge = başlık bilgileri (sağ sütun x≥200)
  const firstDated = rows.findIndex((r) => r.cells.length >= 3 && r.cells[0].x < 100 && dateAtStart(r.cells[0].s) && inX(r, 400, 470).length);
  const head = rows.slice(0, firstDated < 0 ? rows.length : firstDated);
  const vals = head.map((r) => inX(r, 170, 300).map((c) => c.s).join(' ').trim()).filter(Boolean);
  const amounts: number[] = []; const dates: string[] = [];
  for (const v of vals) {
    const range = v.match(/(\d\d\/\d\d\/\d{4})\s*-\s*(\d\d\/\d\d\/\d{4})/);
    if (range) { st.periodStart = parseDate(range[1]); continue; }
    if (/^\d{6}\*+(\d{4})$/.test(v.replace(/\s+/g, ''))) { st.cardLast4 = last4(v); continue; }
    if (/^\d\d\/\d\d\/\d{4}$/.test(v)) { dates.push(parseDate(v)!); continue; }
    const m = v.match(/^([\d.,]+)\s*TL$/i);
    if (m) { const n = num(m[1]); if (n !== null) amounts.push(n); }
  }
  [st.statementDebt, st.minPayment, st.limit, st.availableLimit, st.cashLimit] = [amounts[0] ?? NaN, amounts[1] ?? null, amounts[2] ?? null, amounts[3] ?? null, amounts[4] ?? null];
  [st.dueDate, st.cutDate, st.nextCutDate, st.nextDueDate] = [dates[0] ?? null, dates[1] ?? '', dates[2] ?? null, dates[3] ?? null];
  if (st.minPayment !== null && st.statementDebt > 0) st.minPaymentPct = round2((st.minPayment / st.statementDebt) * 100);
  const text = rows.map((r) => r.text).join('\n');
  const rt = text.match(/%\s*([\d,]+)\s+[^%\n]*Y.ll.k:\s*%\s*([\d,]+)/);
  if (rt) st.rates.purchase = mrate(rt[1]);

  let suffix: string | null = null; let sawFirst = false;
  const body = rows.slice(firstDated < 0 ? 0 : Math.max(0, firstDated - 3));
  for (const r of body) {
    const sec = r.text.match(/\*{4}\s*\*{4}\s*\*{4}\s*(\d{4})/);
    if (sec) { suffix = sec[1]; continue; }
    const d = r.cells[0] && r.cells[0].x < 100 ? dateAtStart(r.cells[0].s) : null;
    const amtCell = r.cells.find((c) => c.x >= 400 && c.x <= 470 && parseMoney(c.s));
    if (!d) {
      // İlk tarihsiz tutar satırı: önceki dönem bakiyesi
      if (!sawFirst && amtCell && r.cells[0].x < 150 && st.previousBalance === null) { st.previousBalance = parseMoney(amtCell.s)!.value; sawFirst = true; }
      continue;
    }
    sawFirst = true;
    if (!amtCell) continue;
    const money = parseMoney(amtCell.s)!;                      // "1,732.81(-)" = ödeme
    const desc = r.cells.filter((c) => c !== amtCell && c.x >= 100 && c.x < 400).map((c) => c.s).join(' ');
    const im = desc.match(/\(\s*([\d.,]+)\s*TL[^)]*\)\s*(\d+)\/(\d+)/);
    const remCell = r.cells.find((c) => c.x >= 470 && /x\d+/i.test(c.s));
    const rm = remCell?.s.match(/([\d.,]+)x(\d+)/i);
    const inst = im ? { no: Number(im[3]), count: Number(im[2]), total: num(im[1]), remaining: rm ? round2((num(rm[1]) ?? 0) * Number(rm[2])) : null } : null;
    st.lines.push(line(0, d.date, false, desc || 'Açıklama okunamadı', money.value, suffix, inst));
  }
  st.warnings.push('Akbank ekstresinin yazı katmanı bozuk: tutarlar ve tarihler güvenilir, açıklamalarda eksik harfler olabilir. Yeni kalemleri eklemeden önce açıklamayı düzeltin.');
  return finalize(st);
}

// ---------------------------------------------------------------------------
export function detectBank(rows: Row[], ebcdic: boolean): BankId | null {
  if (ebcdic) return 'akbank';
  const t = norm(allText(rows));
  if (/qnb/.test(t) && /(parapuan|asgari .?deme orani)/.test(t)) return 'qnb';
  if (/garanti/.test(t) && /(bonus|hesap kesim tarihi)/.test(t)) return 'garanti';
  if (/maximum|maxipuan/.test(t) && /isbank/.test(t)) return 'isbank';
  if (/vakifbank|vakiflar/.test(t)) return 'vakif';
  if (/yapi ?(ve)? ?kredi|worldcard\.com/.test(t)) return 'yapikredi';
  return null;
}

/** Sayfaların ham metin öğelerinden ekstreyi çıkarır. */
export function parseStatement(pages: PageItems[]): ParsedStatement {
  const flat = pages.flat();
  if (flat.length === 0) throw new StatementError('EMPTY', 'PDF içinde okunabilir metin yok (taranmış görüntü olabilir).');
  const ebcdic = looksEbcdic(flat);
  const rows = pages.flatMap((p, i) => buildRows(p, i + 1, { ebcdic }));
  const bank = detectBank(rows, ebcdic);
  if (!bank) throw new StatementError('UNKNOWN_BANK', 'Bu ekstrenin bankası tanınamadı. Desteklenenler: Akbank, Garanti, İş Bankası, QNB, VakıfBank, Yapı Kredi.');
  try {
    switch (bank) {
      case 'qnb': return parseQnb(rows);
      case 'garanti': return parseGaranti(rows);
      case 'isbank': return parseIsbank(rows);
      case 'vakif': return parseVakif(rows);
      case 'yapikredi': return parseYapiKredi(rows);
      case 'akbank': return parseAkbank(rows);
    }
  } catch (e) {
    if (e instanceof StatementError) throw e;
    throw new StatementError('PARSE', `Ekstre okunamadı: ${e instanceof Error ? e.message : String(e)}`);
  }
}
export type { Cell };
export const _internal = { ascii };
