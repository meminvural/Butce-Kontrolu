-- =====================================================================
--  0009 · Yabancı anahtar indeksleri (Supabase Performance Advisor)
-- =====================================================================
create index if not exists accounts_counterparty_idx      on accounts (counterparty_id) where counterparty_id is not null;
create index if not exists accounts_institution_idx       on accounts (institution_id)  where institution_id is not null;
create index if not exists attachments_entry_idx          on attachments (entry_id)     where entry_id is not null;
create index if not exists attachments_account_idx        on attachments (account_id)   where account_id is not null;
create index if not exists attachments_user_idx           on attachments (user_id);
create index if not exists budgets_category_idx           on budgets (category_id);
create index if not exists cip_user_idx                   on card_installment_plans (user_id);
create index if not exists categories_parent_idx          on categories (parent_id)     where parent_id is not null;
create index if not exists journal_entries_cp_idx         on journal_entries (counterparty_id) where counterparty_id is not null;
create index if not exists journal_entries_reversed_idx   on journal_entries (reversed_by) where reversed_by is not null;
create index if not exists loan_installments_paid_idx     on loan_installments (paid_entry_id) where paid_entry_id is not null;
create index if not exists recurring_rules_user_idx       on recurring_rules (user_id);
create index if not exists recurring_rules_account_idx    on recurring_rules (account_id);
create index if not exists recurring_rules_to_account_idx on recurring_rules (to_account_id) where to_account_id is not null;
create index if not exists recurring_rules_category_idx   on recurring_rules (category_id)   where category_id is not null;
create index if not exists scheduled_items_account_idx    on scheduled_items (account_id)    where account_id is not null;
create index if not exists scheduled_items_to_account_idx on scheduled_items (to_account_id) where to_account_id is not null;
create index if not exists scheduled_items_category_idx   on scheduled_items (category_id)   where category_id is not null;
create index if not exists scheduled_items_cp_idx         on scheduled_items (counterparty_id) where counterparty_id is not null;
create index if not exists scheduled_items_realized_idx   on scheduled_items (realized_entry_id) where realized_entry_id is not null;
