export type Currency = 'TRY' | 'USD' | 'EUR' | 'TZS';
export const CURRENCIES: Currency[] = ['TRY', 'USD', 'EUR', 'TZS'];

export type AccountKind =
  | 'bank' | 'cash' | 'savings' | 'investment' | 'fixed_asset' | 'receivable'
  | 'credit_card' | 'overdraft' | 'loan' | 'payable';

export type AccountClass = 'asset' | 'liability';

export type EntryKind =
  | 'income' | 'expense' | 'card_purchase' | 'transfer' | 'fx_exchange' | 'card_payment'
  | 'overdraft_draw' | 'overdraft_repay' | 'loan_disbursement' | 'loan_payment'
  | 'debt_open' | 'debt_payment' | 'receivable_open' | 'receivable_collection'
  | 'opening_balance' | 'adjustment' | 'reversal';

export interface AccountBalance {
  id: string;
  name: string;
  kind: AccountKind;
  class: AccountClass;
  currency: Currency;
  institution_name: string | null;
  counterparty_name: string | null;
  credit_limit: number | null;
  available_limit: number | null;
  iban_last4: string | null;
  statement_day: number | null;
  due_day: number | null;
  balance: number;
  raw_balance: number;
  archived_at: string | null;
  last_activity: string | null;
  sort_order: number;
  color: string | null;
}

export interface Category {
  id: string;
  parent_id: string | null;
  kind: 'income' | 'expense';
  name: string;
  sort_order: number;
  system_key: string | null;
  archived_at: string | null;
}

export interface EntryLine {
  account_id: string | null;
  account_name: string | null;
  account_kind: AccountKind | 'equity' | 'fx_clearing' | null;
  is_system: boolean;
  category_id: string | null;
  category_name: string | null;
  parent_category_name: string | null;
  amount: number;
  currency: Currency;
  memo: string | null;
}

export interface Entry {
  id: string;
  entry_date: string;
  kind: EntryKind;
  status: 'posted' | 'reversed';
  description: string | null;
  reverses_entry_id: string | null;
  reversed_by: string | null;
  currency: Currency | null;
  amount: number | null;
  lines: EntryLine[];
  created_at: string;
}

export interface NetPosition {
  currency: Currency;
  assets: number;
  receivables: number;
  liabilities: number;
  net_worth: number;
}

export interface MonthSummary {
  month: string;
  currency: Currency;
  income: number;
  expense: number;
  net: number;
}

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  bank: 'Banka hesabı',
  cash: 'Nakit',
  savings: 'Birikim / vadeli',
  investment: 'Yatırım hesabı',
  fixed_asset: 'Varlık (araç, ev, altın…)',
  receivable: 'Alacak (bana borçlu kişi)',
  credit_card: 'Kredi kartı',
  overdraft: 'Ek hesap / KMH',
  loan: 'Banka kredisi',
  payable: 'Kişisel borç (benim borcum)',
};

export const ACCOUNT_GROUPS: { title: string; kinds: AccountKind[] }[] = [
  { title: 'Banka ve nakit', kinds: ['bank', 'cash', 'savings'] },
  { title: 'Yatırım ve varlıklar', kinds: ['investment', 'fixed_asset'] },
  { title: 'Kredi kartları', kinds: ['credit_card'] },
  { title: 'Krediler ve ek hesaplar', kinds: ['loan', 'overdraft'] },
  { title: 'Alacaklarım', kinds: ['receivable'] },
  { title: 'Kişisel borçlarım', kinds: ['payable'] },
];

export const ENTRY_KIND_LABEL: Record<EntryKind, string> = {
  income: 'Gelir',
  expense: 'Gider',
  card_purchase: 'Kart harcaması',
  transfer: 'Transfer',
  fx_exchange: 'Döviz çevirme',
  card_payment: 'Kart ödemesi',
  overdraft_draw: 'Ek hesap kullanımı',
  overdraft_repay: 'Ek hesap ödemesi',
  loan_disbursement: 'Kredi kullanımı',
  loan_payment: 'Kredi ödemesi',
  debt_open: 'Borç alındı',
  debt_payment: 'Borç ödendi',
  receivable_open: 'Borç verildi',
  receivable_collection: 'Alacak tahsilatı',
  opening_balance: 'Açılış bakiyesi',
  adjustment: 'Bakiye düzeltme',
  reversal: 'İptal kaydı',
};

export const isLiability = (k: AccountKind) =>
  k === 'credit_card' || k === 'overdraft' || k === 'loan' || k === 'payable';

/** Sunucudaki _transfer_kind ile aynı mantık — yalnızca önizleme için. */
export function previewTransferKind(from: AccountKind, to: AccountKind, sameCcy: boolean): EntryKind {
  if (to === 'credit_card') return 'card_payment';
  if (from === 'overdraft') return 'overdraft_draw';
  if (to === 'overdraft') return 'overdraft_repay';
  if (from === 'loan') return 'loan_disbursement';
  if (to === 'loan') return 'loan_payment';
  if (to === 'receivable') return 'receivable_open';
  if (from === 'receivable') return 'receivable_collection';
  if (from === 'payable') return 'debt_open';
  if (to === 'payable') return 'debt_payment';
  if (!sameCcy) return 'fx_exchange';
  return 'transfer';
}

export const LIQUID_KINDS: AccountKind[] = ['bank', 'cash', 'savings'];

export interface Profile {
  id: string;
  full_name: string | null;
  base_currency: Currency;
  timezone: string;
  budget_warn_pct: number;
  budget_crit_pct: number;
}

export interface CardOverview {
  account_id: string; name: string; currency: Currency; credit_limit: number | null;
  owed: number; available: number | null; statement_day: number; due_day: number;
  last_cut: string | null; last_due: string | null; last_amount: number | null; last_min: number | null;
  last_paid: number | null; last_remaining: number | null; last_status: StatementStatus | null;
  next_cut: string | null; next_due: string | null; current_period_amount: number | null;
  unbilled_installments: number;
}

export type StatementStatus = 'open_period' | 'paid' | 'overdue' | 'partial' | 'awaiting';
export const STATEMENT_STATUS_LABEL: Record<StatementStatus, string> = {
  open_period: 'Dönem açık', paid: 'Ödendi', overdue: 'Gecikmiş', partial: 'Kısmi ödendi', awaiting: 'Ödeme bekliyor',
};

export interface CardStatement {
  cut_date: string; period_start: string; due_date: string; statement_amount: number;
  min_payment: number; paid: number; remaining: number; status: StatementStatus; is_current: boolean;
}

export interface InstallmentSlice {
  entry_id: string; entry_date: string; description: string | null; slice_no: number;
  slice_count: number; billing_date: string; amount: number;
}

export interface Loan {
  id: string; name: string; currency: Currency; institution_name: string | null; archived_at: string | null;
  principal: number; monthly_rate: number; tax_pct: number; term_months: number;
  first_payment_date: string; payment_amount: number; remaining_principal: number;
  paid_count: number; unpaid_count: number; remaining_payments: number; remaining_interest: number;
  next_id: string | null; next_no: number | null; next_due: string | null; next_payment: number | null;
}

export interface LoanInstallment {
  id: string; installment_no: number; due_date: string; payment: number; principal: number;
  interest: number; tax: number; remaining: number; settled_outside: boolean; paid_entry_id: string | null;
}

export type UpcomingSource = 'manual' | 'recurring' | 'loan_installment' | 'card_statement' | 'card_installment' | 'debt' | 'receivable';
export interface UpcomingItem {
  due_date: string; source_type: UpcomingSource; source_id: string | null; ref_id: string;
  description: string; direction: 'in' | 'out' | 'transfer'; amount: number; currency: Currency;
  account_id: string | null; account_name: string | null; category_id: string | null; overdue: boolean;
}
export const SOURCE_LABEL: Record<UpcomingSource, string> = {
  manual: 'Planlı', recurring: 'Düzenli', loan_installment: 'Kredi taksiti', card_statement: 'Kart ekstresi',
  card_installment: 'Kart taksiti', debt: 'Borç taksiti', receivable: 'Alacak tahsilatı',
};

export interface RecurringRule {
  id: string; name: string; direction: 'in' | 'out' | 'transfer'; amount: number; currency: Currency;
  account_id: string; to_account_id: string | null; category_id: string | null;
  frequency: 'weekly' | 'monthly' | 'yearly'; interval_n: number; day_of_month: number | null;
  start_date: string; end_date: string | null; is_active: boolean;
}

export interface BudgetRow {
  budget_id: string; category_id: string; category_name: string; parent_name: string | null;
  is_root: boolean; currency: Currency; budget: number; actual: number; remaining: number;
  pct: number; level: 'normal' | 'warning' | 'critical' | 'over';
}

export interface Notice {
  level: 'info' | 'warning' | 'critical'; kind: string; title: string;
  amount: number | null; currency: Currency | null; due_date: string | null; ref_id: string;
}

export interface NetWorthPoint {
  month_end: string; currency: Currency; assets: number; receivables: number; liabilities: number; net_worth: number;
}

export interface NetBase extends NetPosition { rate: number | null; base_currency: Currency; net_in_base: number | null }

export interface CategoryMonthly {
  month: string; kind: 'income' | 'expense'; category_id: string; category_name: string;
  root_category_id: string; root_category_name: string; currency: Currency; total: number;
}

export interface ExchangeRate { id: string; rate_date: string; base: Currency; quote: Currency; rate: number; source: string }

export interface Attachment { id: string; entry_id: string | null; storage_path: string; file_name: string; mime_type: string | null; size_bytes: number | null; created_at: string }
