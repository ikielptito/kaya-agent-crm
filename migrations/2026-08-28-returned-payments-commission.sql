-- ═══════════════════════════════════════════════════════════════════════
-- RETURNED PAYMENTS + COMMISSION FLAG migration — 28 Aug 2026
-- Follow-up to the two 2026-08-27 statement migrations (run those first).
-- Paste into the Supabase SQL editor BEFORE deploying. Idempotent.
--
-- What it does:
--   1. statement_payments.status: banks sometimes bounce a transfer
--      (Andrea's HK account, Aug 2026). A returned payment stays in the
--      ledger for the audit trail but stops counting toward paid_total,
--      so the owed balance springs back automatically.
--   2. statement_groups.charges_commission: LaneHAUS is Ikiel & Guy's own
--      property — the sheet's commission column is money moving between
--      their own pockets, not management income. The admin Earnings view
--      excludes such groups from commission revenue.
-- ═══════════════════════════════════════════════════════════════════════

alter table statement_payments add column if not exists status text not null default 'cleared';
-- status vocabulary (enforced in the API layer): 'cleared' | 'returned'
alter table statement_payments add column if not exists returned_at timestamptz;
alter table statement_payments add column if not exists return_note text;

alter table statement_groups add column if not exists charges_commission boolean not null default true;
update statement_groups set charges_commission = false where key = 'lanehaus';
