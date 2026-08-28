-- Amendments to published statements. RUN IN THE SUPABASE SQL EDITOR BEFORE
-- (or right after) DEPLOYING the CRM — the Amend button errors until this
-- column exists; everything else is unaffected.
--
-- revisions: jsonb array, one entry per amendment.
--   open entry  (amendment in progress): { open: true, started_at, by,
--       prev: {gross_total, commission_total, nett_total, expenses_total,
--              adjustments_total, payout_total, era_payout_total},
--       prev_lines: [full statement_lines rows] }   -- kept only while open,
--                                                   -- so Cancel can restore
--   closed entry (history):              { open: false, at, by, note,
--       prev: {totals...}, new: {totals...} }
alter table statements
  add column if not exists revisions jsonb not null default '[]'::jsonb;
