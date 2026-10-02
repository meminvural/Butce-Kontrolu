import type { LineKind, ParsedStatement, StatementLine } from './types';
import type { LineMatch } from './match';
import { addDaysIso, round2 } from './text';

export interface LineDecision {
  action: 'add' | 'skip';
  categoryId?: string | null;
  /** Ödeme satırı için kaynak banka hesabı (boşsa "kaynak belirsiz") */
  sourceAccountId?: string | null;
}

/** Borcu AZALTAN türler (ekstrede eksi işaretli) */
export const CREDIT_KINDS: LineKind[] = ['payment', 'refund'];
export const isCredit = (k: LineKind) => CREDIT_KINDS.includes(k);

/** Tutar işareti türden gelir: ödeme/iade eksi, diğerleri artı. Kullanıcı hep pozitif rakam yazar. */
export const signedAmount = (kind: LineKind, abs: number) => round2(isCredit(kind) ? -Math.abs(abs) : Math.abs(abs));

/**
 * Varsayılan: sistemde zaten olan (eşleşen / olası eşleşen) kalemler EKLENMEZ (çift kayıt olmasın), yeni olanlar eklenir.
 * Kullanıcı her satırı değiştirebilir.
 */
export function defaultDecision(m: LineMatch): LineDecision {
  return { action: m.status === 'new' ? 'add' : 'skip' };
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Satırın taksit durumu: bu ekstreden itibaren kaç taksit kaldı (bu ekstredeki dahil) */
export function remainingInstallments(l: StatementLine): number {
  const i = l.installment;
  return i && i.count > 1 && i.no >= 1 && i.no <= i.count ? i.count - i.no + 1 : 1;
}

/**
 * import_card_statement() RPC yükü.
 *
 * Taksitli kalem: ekstredeki dilim, "kalan taksitlerin ilki" olarak yazılır (kalan taksit sayısı × dilim tutarı, dönem içi bir tarihte).
 * Geçmiş dilimler zaten ekstrenin "önceki bakiyesi"nde olduğundan tam alışveriş tutarı yazılırsa çift sayılır.
 */
export function buildPayload(st: ParsedStatement, accountId: string, fileHash: string, matches: LineMatch[],
  decisions: (m: LineMatch) => LineDecision, opts: { updateProfile: boolean; reverseEntries: string[]; replace: boolean }) {
  const start = st.periodStart ?? addDaysIso(st.cutDate, -30);
  return {
    account_id: accountId, file_hash: fileHash, bank: st.bank, replace: opts.replace, update_profile: opts.updateProfile,
    cut_date: st.cutDate, period_start: st.periodStart, due_date: st.dueDate, next_cut_date: st.nextCutDate, next_due_date: st.nextDueDate,
    statement_debt: st.statementDebt, min_payment: st.minPayment, min_payment_pct: st.minPaymentPct, previous_balance: st.previousBalance,
    limit: st.limit, available_limit: st.availableLimit, cash_limit: st.cashLimit,
    purchase_rate: st.rates.purchase, cash_rate: st.rates.cash, late_rate: st.rates.late,
    reverse_entries: opts.reverseEntries,
    lines: matches.map((m) => {
      const l = m.line;
      const d = decisions(m);
      const rest = remainingInstallments(l);
      const abs = Math.abs(l.amount);
      const inDate = l.date >= start && l.date <= st.cutDate;
      return {
        idx: l.idx, kind: l.kind, status: m.status, entry_id: m.entryId, action: d.action,
        date: rest > 1 || (l.installment && l.installment.count > 1) ? (inDate ? l.date : start) : l.date,
        description: l.description.slice(0, 200),
        amount: signedAmount(l.kind, abs),
        category_id: isCredit(l.kind) ? null : d.categoryId ?? null,
        source_account_id: l.kind === 'payment' ? d.sourceAccountId ?? null : null,
        installments: rest,
        purchase_amount: rest > 1 ? round2(abs * rest) : null,
      };
    }),
  };
}
