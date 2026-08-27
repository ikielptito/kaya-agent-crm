-- ═══════════════════════════════════════════════════════════════════════
-- STATEMENT PAYMENTS + PAYOUT ACCOUNTS migration — 27 Aug 2026
-- Follow-up to 2026-08-27-owner-statements.sql (run that one first).
-- Paste this whole file into the Supabase SQL editor and run it BEFORE
-- deploying the partial-payments code. Idempotent: safe to re-run.
--
-- What it does:
--   1. statement_payments: a payout can now be settled in several transfers;
--      each payment carries its own amount, date, note, and proof screenshot.
--      The statement's owed balance = payout_total − Σ payments.
--   2. statements.paid_total: denormalized Σ payments (recomputed by the API
--      on every payment change) so lists can show balances without joins.
--      Status vocabulary grows: draft | published | partial | paid | void.
--   3. statement_groups.payout_account: the owner's preferred bank account
--      (entered by the owner in their portal, or by Ikiel in the admin).
--   4. Backfill: any statement already marked 'paid' under the old
--      one-shot flow gets a single synthetic payment for the full amount.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) Payments ledger ──────────────────────────────────────────────────
create table if not exists statement_payments (
  id            bigserial primary key,
  statement_id  bigint not null references statements(id) on delete cascade,
  amount        numeric not null,             -- IDR, positive
  paid_at       timestamptz not null default now(),
  note          text,                         -- transfer reference / remark
  proof_path    text,                         -- payout-proofs bucket path
  created_at    timestamptz default now()
);
create index if not exists idx_statement_payments_stmt on statement_payments (statement_id, paid_at);

-- ── 2) Denormalized paid total on the statement ─────────────────────────
alter table statements add column if not exists paid_total numeric not null default 0;

-- ── 3) Owner's preferred payout account ─────────────────────────────────
-- Shape: {"bank":"BCA","account_name":"Romina …","account_number":"…","note":"…",
--         "updated_by":"owner|admin","updated_at":"ISO"}
alter table statement_groups add column if not exists payout_account jsonb;

-- ── 4) Backfill one-shot paid statements into the ledger ────────────────
insert into statement_payments (statement_id, amount, paid_at, note, proof_path)
select s.id, s.payout_total, coalesce(s.paid_at, now()),
       'Migrated: paid in full (pre-partial-payments)', s.proof_path
from statements s
where s.status = 'paid'
  and not exists (select 1 from statement_payments p where p.statement_id = s.id);

update statements s set paid_total = agg.total
from (select statement_id, sum(amount) as total from statement_payments group by statement_id) agg
where agg.statement_id = s.id and s.paid_total = 0;
