-- ═══════════════════════════════════════════════════════════════════════
-- EXPENSE SHEETS migration — 4 Sep 2026
-- Paste into the Supabase SQL editor and run BEFORE deploying the
-- expense-sheet sync. Idempotent.
--
-- A statement group may carry a second sheet: Era's running expense ledger
-- for the property (LaneHAUS: one tab per year with a block per month;
-- Tropicana B "DOUBLE EIGHT": one tab per month). On sync, a month whose
-- report tab has no expense block takes its expenses from here; a group
-- with no report sheet at all (expenses_only) gets a statement per month
-- whose bookings are only the direct rent Era collected ("Received payment
-- from …"), so payout = direct rent − expenses, Era's own "Total Balance".
-- ═══════════════════════════════════════════════════════════════════════
alter table statement_groups add column if not exists expense_sheet_file_id text;
alter table statement_groups add column if not exists expenses_only boolean not null default false;
-- The report sheet becomes optional for expenses-only groups.
alter table statement_groups alter column sheet_file_id drop not null;

notify pgrst, 'reload schema';
