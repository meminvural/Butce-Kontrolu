import type { ParsedStatement, StatementLine } from './types';
import type { LineMatch } from './match';
import { addMonthsIso } from './text';

export interface LineDecision {
  action: 'add' | 'skip';
  categoryId?: string | null;
  description?: string;
  /** Ödeme satırı için kaynak banka hesabı (boşsa "kaynak belirsiz") */
  sourceAccountId?: string | null;
}

/** Varsayılan: eşleşenleri ve olası eşleşenleri ATLA (çift kayıt olmasın); yeni kalemleri ekle. Taksitli/iade satırlar bilinçli seçim ister. */
export function defaultDecision(m: LineMatch): LineDecision {
  if (m.status !== 'new') return { action: 'skip' };
  if (m.line.kind === 'refund') return { action: 'skip' };
  if (m.line.installment && m.line.installment.count > 1) return { action: 'skip' };
  return { action: 'add' };
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** import_card_statement() RPC yükü */
export function buildPayload(st: ParsedStatement, accountId: string, fileHash: string, matches: LineMatch[],
  decisions: Map<number, LineDecision>, opts: { updateProfile: boolean; reverseEntries: string[]; replace: boolean }) {
  return {
    account_id: accountId, file_hash: fileHash, bank: st.bank, replace: opts.replace, update_profile: opts.updateProfile,
    cut_date: st.cutDate, period_start: st.periodStart, due_date: st.dueDate, next_cut_date: st.nextCutDate, next_due_date: st.nextDueDate,
    statement_debt: st.statementDebt, min_payment: st.minPayment, min_payment_pct: st.minPaymentPct, previous_balance: st.previousBalance,
    limit: st.limit, available_limit: st.availableLimit, cash_limit: st.cashLimit,
    purchase_rate: st.rates.purchase, cash_rate: st.rates.cash, late_rate: st.rates.late,
    reverse_entries: opts.reverseEntries,
    lines: matches.map((m) => {
      const l: StatementLine = m.line;
      const d = decisions.get(l.idx) ?? defaultDecision(m);
      const inst = l.installment && l.installment.count > 1 ? l.installment : null;
      return {
        idx: l.idx, kind: l.kind, status: m.status, entry_id: m.entryId, action: d.action,
        date: inst && inst.no > 1 ? addMonthsIso(l.date, -(inst.no - 1)) : l.date,
        description: (d.description ?? l.description).slice(0, 200),
        amount: l.amount,
        category_id: d.categoryId ?? null,
        source_account_id: d.sourceAccountId ?? null,
        installments: inst ? inst.count : 1,
        purchase_amount: inst ? inst.total ?? Math.round(l.amount * inst.count * 100) / 100 : null,
      };
    }),
  };
}
