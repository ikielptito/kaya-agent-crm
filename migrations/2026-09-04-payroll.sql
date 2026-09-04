-- ═══════════════════════════════════════════════════════════════════════
-- STAFF PAYROLL migration — 4 Sep 2026
-- Paste into the Supabase SQL editor and run BEFORE deploying the payroll
-- code. Idempotent: safe to re-run.
--
-- Mirrors the owner-statements tables (2026-08-27-owner-statements.sql)
-- minus the booking columns: Era's "Staff Salary and Expenses" sheet is
-- synced into one payroll_run per month, its rows become payroll_lines,
-- and settlement is a payments ledger keyed by payee (Dian is four lines
-- across four villas and one transfer).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) One run per month ────────────────────────────────────────────────
create table if not exists payroll_runs (
  id               bigserial primary key,
  period           text not null unique,        -- 'YYYY-MM'
  status           text not null default 'draft',   -- draft|published|partial|paid|void
  salary_total     numeric not null default 0,  -- Σ category = salary
  other_total      numeric not null default 0,  -- Σ everything else
  run_total        numeric not null default 0,  -- salary + other = what gets paid out
  memo_total       numeric not null default 0,  -- balance carried, receipts, petty-cash float: listed, not paid
  era_total        numeric,                     -- the sheet's own TOTAL
  paid_total       numeric not null default 0,  -- Σ cleared payments
  reconciliation   jsonb,                       -- {checks:[{name,ok,expected,actual}], unparsed_rows:[…]}
  needs_review     boolean not null default false,
  period_flags     text[] not null default '{}',   -- 'period_from_balance_hint','year_assumed','period_assumed'
  source_hash      text,
  source_tab       text,
  parsed_at        timestamptz,
  has_manual_edits boolean not null default false,
  source_changed   boolean not null default false,
  discrepancy      jsonb,
  published_at     timestamptz,
  published_by     text,
  paid_at          timestamptz,
  notes            text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists idx_payroll_runs_status on payroll_runs (status, period desc);

-- ── 2) Lines ────────────────────────────────────────────────────────────
-- category: salary | utility | laundry | advance | building_fee | other  (paid out)
--           balance | receipt | petty_cash                            (memo only)
-- payee: who gets the money — a person's name for salary lines, the sheet's
--        label ("Internet", "Laundry") for everything else. The payee view
--        and the payments ledger group on it.
-- slugs: the properties this line is for; empty = Samba overhead.
create table if not exists payroll_lines (
  id            bigserial primary key,
  run_id        bigint not null references payroll_runs(id) on delete cascade,
  category      text not null,
  payee         text not null,
  person_name   text,
  staff_id      bigint references staff(id) on delete set null,
  role          text,                          -- housekeeper|pool|gardener|manager for salary lines
  description   text,                          -- Era's free text ("Pool A5 & garden")
  slugs         text[] not null default '{}',
  amount        numeric not null default 0,
  flags         text[] not null default '{}',  -- roster_mismatch, vendor_on_payroll, not_in_registry, unclassified, no_property, manual, …
  edited        boolean not null default false,
  source_row    int,
  position      int not null default 0,
  created_at    timestamptz default now()
);
create index if not exists idx_payroll_lines_run on payroll_lines (run_id, position);

-- ── 3) Payments, per payee ──────────────────────────────────────────────
create table if not exists payroll_payments (
  id            bigserial primary key,
  run_id        bigint not null references payroll_runs(id) on delete cascade,
  payee         text not null,
  staff_id      bigint references staff(id) on delete set null,
  amount        numeric not null,
  paid_at       timestamptz not null default now(),
  note          text,
  proof_path    text,                          -- payout-proofs bucket, under payroll/
  status        text not null default 'cleared',   -- cleared | returned
  created_at    timestamptz default now()
);
create index if not exists idx_payroll_payments_run on payroll_payments (run_id, payee);

-- ── 4) Settings ─────────────────────────────────────────────────────────
-- sheet_file_id: Era's payroll sheet. unpaid_slugs: villas whose cleaning
-- is paid outside this sheet (Era, 3 Sep 2026: HAUS Canggu and Tropicana
-- B2/B3/B5/B6), so a missing housekeeping line there is not a finding.
insert into settings (key, value)
values ('payroll', jsonb_build_object(
  'sheet_file_id', '1QREAhDjQAWgYxSPWXgqqDZX8GRUJN6NCx6R8j5LJdIA',
  'unpaid_slugs', jsonb_build_array('haus-1', 'haus-2', 'haus-4', 'haus-5', 'tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6')
))
on conflict (key) do nothing;

notify pgrst, 'reload schema';
