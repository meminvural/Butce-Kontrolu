import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';
import type {
  AccountBalance, Attachment, BudgetRow, CardOverview, CardStatement, Category, CategoryMonthly, Entry, EntryKind,
  ExchangeRate, InstallmentSlice, Loan, LoanInstallment, MonthSummary, NetBase, NetPosition, NetWorthPoint, Notice,
  Profile, RecurringRule, UpcomingItem,
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
