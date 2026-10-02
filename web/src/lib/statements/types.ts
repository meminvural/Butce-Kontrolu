export type BankId = 'akbank' | 'garanti' | 'isbank' | 'qnb' | 'vakif' | 'yapikredi' | 'ziraat' | 'enpara';

export const BANK_LABEL: Record<BankId, string> = {
  akbank: 'Akbank', garanti: 'Garanti BBVA', isbank: 'İş Bankası', qnb: 'QNB', vakif: 'VakıfBank', yapikredi: 'Yapı Kredi', ziraat: 'Ziraat Bankası', enpara: 'Enpara',
};

export type LineKind = 'purchase' | 'installment' | 'cash_advance' | 'payment' | 'refund' | 'interest' | 'tax' | 'fee';

export interface StatementLine {
  idx: number;
  /** YYYY-MM-DD. Tarihsiz kalemlerde (faiz, vergi) hesap kesim tarihi */
  date: string;
  dateGuessed: boolean;
  description: string;
  /** Borcu artıran +, azaltan −  */
  amount: number;
  kind: LineKind;
  /** Kartın son 4 hanesi (sanal/dijital kart olabilir) */
  cardSuffix: string | null;
  installment: { no: number; count: number; total: number | null; remaining: number | null } | null;
}

export interface ParsedStatement {
  bank: BankId;
  product: string;
  /** Ana kartın son 4 hanesi */
  cardLast4: string | null;
  cutDate: string;
  dueDate: string | null;
  periodStart: string | null;
  nextCutDate: string | null;
  nextDueDate: string | null;
  /** Ekstre (dönem) borcu */
  statementDebt: number;
  minPayment: number | null;
  minPaymentPct: number | null;
  previousBalance: number | null;
  limit: number | null;
  availableLimit: number | null;
  cashLimit: number | null;
  rates: { purchase: number | null; cash: number | null; late: number | null };
  /** Ekstredeki özet tutarlar (varsa) */
  summary: { purchases: number | null; feesInterest: number | null; payments: number | null };
  lines: StatementLine[];
  /** Satırlarla ekstre toplamının uyumu vb. */
  checks: { id: string; ok: boolean; label: string; detail?: string }[];
  warnings: string[];
}

export class StatementError extends Error {
  constructor(public code: 'UNKNOWN_BANK' | 'PARSE' | 'PASSWORD' | 'EMPTY', message: string) { super(message); }
}
