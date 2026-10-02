import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';
import type { LineKind } from './statements/types';
import type {
  AccountBalance, Attachment, BudgetRow, CardOverview, CardStatement, Category, CategoryMonthly, Entry, EntryKind,
  ExchangeRate, InstallmentSlice, Loan, LoanInstallment, MonthSummary, NetBase, NetPosition, NetWorthPoint, Notice,
  Profile, RecurringRule, UpcomingItem, LedgerLine, DebtOutlookRow,
} from './types';

async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

/** Tüm yazma işlemleri RPC üzerinden: kurallar veritabanında uygulanır. */
export const rpc = <T = string>(fn: string, args: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(fn, args));

// ---------- Okuma --------------------------------------------------------
export const useAccounts = () =>
  useQuery({
    queryKey: ['accounts'],
    queryFn: () => unwrap<AccountBalance[]>(
      supabase.from('v_account_balances').select('*').order('sort_order').order('name')),
  });

export const useCategories = () =>
  useQuery({
    queryKey: ['categories'],
    queryFn: () => unwrap<Category[]>(
      supabase.from('categories').select('id,parent_id,kind,name,sort_order,system_key,archived_at')
        .order('sort_order').order('name')),
  });

export const useNetPosition = () =>
  useQuery({
    queryKey: ['net'],
    queryFn: () => unwrap<NetPosition[]>(supabase.from('v_net_position').select('*')),
  });

export const useMonthSummary = (month: string) =>
  useQuery({
    queryKey: ['month', month],
    queryFn: () => unwrap<MonthSummary[]>(supabase.from('v_month_summary').select('*').eq('month', month)),
  });

export interface EntryFilter {
  from?: string;
  to?: string;
  accountId?: string;
  kind?: EntryKind | '';
  q?: string;
  showReversals?: boolean;
  /** Yalnızca geçerli kayıtlar (iptal edilmişler hariç) — raporlardaki toplamlarla birebir uyum için */
  postedOnly?: boolean;
  /** Bu kategorilerden en az birini içeren kayıtlar */
  categoryIds?: string[];
  /** Bu açıklamalardan biriyle birebir eşleşen kayıtlar */
  descriptions?: string[];
  limit: number;
}

export const useEntries = (f: EntryFilter) =>
  useQuery({
    queryKey: ['entries', f],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase.from('v_entries').select('*', { count: 'exact' })
        .order('entry_date', { ascending: false })
        .order('created_at', { ascending: false })
        .range(0, f.limit - 1);
      if (f.from) q = q.gte('entry_date', f.from);
      if (f.to) q = q.lte('entry_date', f.to);
      if (f.accountId) q = q.contains('account_ids', [f.accountId]);
      if (f.kind) q = q.eq('kind', f.kind);
      if (!f.showReversals) q = q.neq('kind', 'reversal');
      if (f.q?.trim()) q = q.ilike('description', `%${f.q.trim()}%`);
      if (f.postedOnly) q = q.eq('status', 'posted');
      if (f.categoryIds?.length) q = q.overlaps('category_ids', f.categoryIds);
      if (f.descriptions?.length) q = q.in('description', f.descriptions);
      const { data, error, count } = await q;
      if (error) throw new Error(error.message);
      return { rows: (data ?? []) as Entry[], count: count ?? 0 };
    },
  });

// ---------- Yazma --------------------------------------------------------
/** Finansal bir yazma sonrası tüm özetler yeniden hesaplanır. */
export function useLedgerMutation<A>(fn: (args: A) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries(),
  });
}

// ---------- Faz 2–6 okuma kancaları ----------------------------------------
const q = <T,>(key: unknown[], fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>, enabled = true) =>
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useQuery({ queryKey: key, enabled, queryFn: () => unwrap<T>(fn() as never) });

export const useProfile = () => q<Profile>(['profile'], () => supabase.from('profiles').select('*').single());
export const useCardOverview = () => q<CardOverview[]>(['cards'], () => supabase.rpc('card_overview'));
export const useCardStatements = (id?: string) =>
  q<CardStatement[]>(['statements', id], () => supabase.rpc('card_statements', { p_account_id: id, p_count: 12 }), !!id);
export const useCardSlices = (id?: string) =>
  q<InstallmentSlice[]>(['slices', id], () => supabase.rpc('card_installment_slices', { p_account_id: id }), !!id);
export const useLoans = () => q<Loan[]>(['loans'], () => supabase.from('v_loans').select('*').order('name'));
export const useLoanInstallments = (id?: string) =>
  q<LoanInstallment[]>(['loan-inst', id], () => supabase.from('loan_installments').select('*')
    .eq('account_id', id!).order('installment_no'), !!id);
export const useUpcoming = (days = 90) =>
  q<UpcomingItem[]>(['upcoming', days], () => supabase.rpc('upcoming_items', { p_days: days }));
export const useBudgetStatus = (month: string) =>
  q<BudgetRow[]>(['budget', month], () => supabase.rpc('budget_status', { p_month: month }));
export const useNotifications = () => q<Notice[]>(['notices'], () => supabase.rpc('notifications', { p_days: 7 }));
export const useRecurringRules = () =>
  q<RecurringRule[]>(['rules'], () => supabase.from('recurring_rules').select('*').order('name'));
export const useNetWorthHistory = (months = 12) =>
  q<NetWorthPoint[]>(['nw-history', months], () => supabase.rpc('net_worth_history', { p_months: months }));
export const useNetBase = () => q<NetBase[]>(['net-base'], () => supabase.rpc('net_position_in_base'));
export const useCategoryMonthly = (month: string) =>
  q<CategoryMonthly[]>(['cat-month', month], () => supabase.from('v_category_monthly').select('*').eq('month', month));
export const useMonthRange = (from: string, to: string) =>
  q<MonthSummary[]>(['month-range', from, to], () => supabase.from('v_month_summary').select('*')
    .gte('month', from).lte('month', to).order('month'));
export const useExchangeRates = () =>
  q<ExchangeRate[]>(['rates'], () => supabase.from('exchange_rates').select('*').order('rate_date', { ascending: false }).limit(50));
export const useAttachments = (entryId?: string) =>
  q<Attachment[]>(['attachments', entryId], () => supabase.from('attachments').select('*').eq('entry_id', entryId!)
    .order('created_at'), !!entryId);

/** Tablo işlemi (RLS altında) → hata fırlatır */
export async function table<T = unknown>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  return unwrap<T>(p);
}

/** Bir tarih aralığındaki tüm işlemleri sayfalayarak çeker (dışa aktarma için) */
export async function fetchAllEntries(from?: string, to?: string): Promise<Entry[]> {
  const out: Entry[] = [];
  for (let page = 0; page < 200; page++) {
    let r = supabase.from('v_entries').select('*').order('entry_date').order('created_at')
      .range(page * 1000, page * 1000 + 999);
    if (from) r = r.gte('entry_date', from);
    if (to) r = r.lte('entry_date', to);
    const rows = await unwrap<Entry[]>(r);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// ---------- Rapor verisi -----------------------------------------------------
/** Tarih aralığındaki tüm defter satırları (1000'lik sayfalarla); analizler tarayıcıda hızlıca yapılır. */
export const useLines = (from: string, to: string) =>
  useQuery({
    queryKey: ['lines', from, to],
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const out: LedgerLine[] = [];
      for (let page = 0; page < 100; page++) {
        const rows = await unwrap<LedgerLine[]>(
          supabase.from('v_ledger_lines').select('*').gte('entry_date', from).lte('entry_date', to)
            .order('entry_date').order('line_id').range(page * 1000, page * 1000 + 999));
        out.push(...rows);
        if (rows.length < 1000) break;
      }
      return out;
    },
  });

export const useEarliestDate = () =>
  useQuery({
    queryKey: ['earliest'],
    queryFn: async () => {
      const rows = await unwrap<{ entry_date: string }[]>(
        supabase.from('journal_entries').select('entry_date').neq('kind', 'opening_balance').order('entry_date').limit(1));
      return rows[0]?.entry_date ?? null;
    },
  });

export const useDebtOutlook = (months = 12) =>
  useQuery({
    queryKey: ['debt-outlook', months],
    queryFn: () => unwrap<DebtOutlookRow[]>(supabase.rpc('debt_service_outlook', { p_months: months }) as never),
  });

// ---------- Banka ekstresi -----------------------------------------------------
export interface StatementStatusRow {
  account_id: string; name: string; last4: string | null; last_cut: string | null; last_due: string | null;
  statement_debt: number | null; min_payment: number | null; imported_at: string | null;
  next_cut: string | null; next_due: string | null; days_since_cut: number | null; is_stale: boolean;
  ledger_debt: number | null; diff: number | null; stmt_limit: number | null; sys_limit: number | null; bank: string | null;
  /** Son ekstrenin ödeme durumu: kesimden sonra yapılan ödemeler */
  paid: number | null; remaining: number | null; min_met: boolean | null;
  pay_status: 'paid' | 'partial' | 'awaiting' | 'overdue' | null; is_closed: boolean | null;
}

export const useStatementStatus = () =>
  useQuery({
    queryKey: ['stmt-status'],
    queryFn: () => unwrap<StatementStatusRow[]>(supabase.rpc('statement_status') as never),
  });

/** Bir kartın defterdeki hareketleri (ekstre eşleştirmesi için) */
export const useCardLedger = (accountId: string | null, from: string, to: string) =>
  useQuery({
    enabled: !!accountId,
    queryKey: ['card-ledger', accountId, from, to],
    queryFn: async () => {
      const rows = await unwrap<{ entry_id: string; entry_date: string; entry_kind: string; description: string | null; amount: number }[]>(
        supabase.from('v_ledger_lines').select('entry_id,entry_date,entry_kind,description,amount')
          .eq('account_id', accountId!).gte('entry_date', from).lte('entry_date', to).order('entry_date').limit(2000));
      return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
    },
  });

export const useStatementReconcile = (accountId: string | null, cut: string | null) =>
  useQuery({
    enabled: !!accountId && !!cut,
    queryKey: ['stmt-reconcile', accountId, cut],
    queryFn: async () => {
      const rows = await unwrap<{ owed: number; unbilled: number; derived: number }[]>(
        supabase.rpc('statement_reconcile', { p_account_id: accountId, p_cut: cut }) as never);
      return rows[0] ? { owed: Number(rows[0].owed), unbilled: Number(rows[0].unbilled), derived: Number(rows[0].derived) } : null;
    },
  });

export interface ImportResult {
  added: number; payments: number; skipped: number; reversed: number;
  ledger_before: number; ledger_after: number; statement_debt: number; difference_after: number;
}
export const importStatement = (payload: unknown) => rpc<ImportResult>('import_card_statement', { p: payload });

// ---------- Finansal sağlık ---------------------------------------------------------
export type HealthSeverity = 'ok' | 'info' | 'warn' | 'crit';
export interface HealthCheck {
  check_key: string; title: string; severity: HealthSeverity; issue_count: number;
  detail: Record<string, unknown>[]; hint: string;
}
export const useFinancialHealth = () =>
  useQuery({
    queryKey: ['health'],
    staleTime: 5 * 60_000,
    queryFn: () => unwrap<HealthCheck[]>(supabase.rpc('financial_health') as never),
  });

// ---------- Yüklenmiş ekstreleri düzeltme ----------------------------------------------------
export interface ImportedLine {
  idx: number; date: string; description: string; amount: number; kind: LineKind;
  status: string; action: 'add' | 'skip'; entry_id: string | null;
  category_id?: string | null; source_account_id?: string | null; installments?: number; purchase_amount?: number | null; ver?: number;
}
export interface StatementImport {
  id: string; account_id: string; bank: string; file_hash: string; cut_date: string; period_start: string | null; due_date: string | null;
  statement_debt: number; min_payment: number | null; previous_balance: number | null; credit_limit: number | null; available_limit: number | null;
  ledger_debt_after: number | null; lines: ImportedLine[]; n_lines: number; n_added: number; imported_at: string;
}
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
export const useStatementImports = () =>
  useQuery({
    queryKey: ['stmt-imports'],
    queryFn: async () => {
      const rows = await unwrap<Record<string, unknown>[]>(
        supabase.from('card_statement_imports').select('*').order('cut_date', { ascending: false }));
      return rows.map((r) => ({
        ...r,
        statement_debt: Number(r.statement_debt), min_payment: num(r.min_payment), previous_balance: num(r.previous_balance),
        credit_limit: num(r.credit_limit), available_limit: num(r.available_limit), ledger_debt_after: num(r.ledger_debt_after),
        lines: ((r.lines as ImportedLine[]) ?? []).map((l) => ({ ...l, amount: Number(l.amount) })),
      })) as unknown as StatementImport[];
    },
  });

export interface AmendResult { ledger_after: number; statement_debt: number; difference: number }
export const amendStatementLine = (importId: string, idx: number | null, p: Record<string, unknown>) =>
  rpc<AmendResult>('amend_statement_line', { p_import_id: importId, p_idx: idx, p });
export const updateStatement = (importId: string, p: Record<string, unknown>) =>
  rpc<AmendResult>('update_statement', { p_import_id: importId, p });
export const deleteStatement = (importId: string, reverse: boolean) =>
  rpc<{ reversed: number }>('delete_statement', { p_import_id: importId, p_reverse: reverse });

// ---------- Otomasyon: borç planı, otomatik ödeme, faiz kademeleri ------------------------------
const n0 = (v: unknown) => (v === null || v === undefined ? null : Number(v));
export interface DebtPlanRow {
  account_id: string; name: string; last4: string | null; currency: string; credit_limit: number | null; debt: number;
  cut_date: string | null; due_date: string | null; statement_amount: number | null; min_payment: number | null; paid: number | null;
  remaining: number | null; min_remaining: number | null; days_to_due: number | null; status: string | null;
  purchase_rate: number | null; late_rate: number | null; est_interest_min: number | null; est_interest_none: number | null;
}
export const useDebtPlan = () =>
  useQuery({
    queryKey: ['debt-plan'],
    queryFn: async () => (await unwrap<Record<string, unknown>[]>(supabase.rpc('card_debt_plan'))).map((r) => ({
      ...r, credit_limit: n0(r.credit_limit), debt: Number(r.debt), statement_amount: n0(r.statement_amount), min_payment: n0(r.min_payment),
      paid: n0(r.paid), remaining: n0(r.remaining), min_remaining: n0(r.min_remaining), days_to_due: n0(r.days_to_due),
      purchase_rate: n0(r.purchase_rate), late_rate: n0(r.late_rate), est_interest_min: n0(r.est_interest_min), est_interest_none: n0(r.est_interest_none),
    })) as unknown as DebtPlanRow[],
  });

export interface AutopayRow {
  account_id: string; name: string; cut_date: string; due_date: string; pay_date: string; amount: number; what: 'min' | 'full' | 'fixed';
  source_account_id: string; source_name: string; source_balance: number; record_mode: 'confirm' | 'auto'; due_now: boolean;
}
export const useAutopayPending = () =>
  useQuery({
    queryKey: ['autopay-pending'],
    queryFn: async () => (await unwrap<Record<string, unknown>[]>(supabase.rpc('autopay_pending'))).map((r) => ({
      ...r, amount: Number(r.amount), source_balance: Number(r.source_balance),
    })) as unknown as AutopayRow[],
  });

export interface CardAutomation {
  account_id: string; statement_day: number; due_day: number; min_payment_pct: number; min_payment_auto: boolean;
  autopay_mode: 'off' | 'min' | 'full' | 'fixed'; autopay_account_id: string | null; autopay_fixed: number | null;
  autopay_days_before: number; autopay_record: 'confirm' | 'auto';
}
export const useCardAutomation = () =>
  useQuery({
    queryKey: ['card-automation'],
    queryFn: async () => (await unwrap<Record<string, unknown>[]>(supabase.from('credit_card_details').select('*'))).map((r) => ({
      ...r, min_payment_pct: Number(r.min_payment_pct), autopay_fixed: n0(r.autopay_fixed),
    })) as unknown as CardAutomation[],
  });

export interface RateTier { id: string; upto: number; purchase_rate: number; late_rate: number }
export const useRateTiers = () =>
  useQuery({
    queryKey: ['rate-tiers'],
    queryFn: async () => (await unwrap<Record<string, unknown>[]>(supabase.from('card_rate_tiers').select('*').order('upto'))).map((r) => ({
      id: r.id, upto: Number(r.upto), purchase_rate: Number(r.purchase_rate), late_rate: Number(r.late_rate),
    })) as RateTier[],
  });

export interface ImportOutcome { added: number; existing: number; failed: { row: number; error: string }[] }
export const importTransactions = (rows: unknown[]) => rpc<ImportOutcome>('import_transactions', { p: { rows } });
