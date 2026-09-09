-- ═══════════════════════════════════════════════════════════════════════
-- PROJECT FINANCE migration — 9 Sep 2026
-- Paste into the Supabase SQL editor and run BEFORE deploying the finance
-- code (the cockpit's Finance page shows a "run the migration" banner until
-- these tables exist). Idempotent: safe to re-run; the seed rows are keyed
-- and never duplicate.
--
-- The Tropicana Valley development as a whole: the workbook "Tropicana
-- Construction & Payment Schedule" as tables. Its "2.) Accounting" sheet
-- (money in / money out, by account) is project_ledger; "4.) Finalization"
-- (what is still to pay) is project_commitments; "BUYERS" is
-- project_receivables; the loans that bought the land and bridged the build
-- are project_loans; the bank balances the sheet compared its running total
-- against are project_accounts. Rental income and villa expenses for the
-- four unsold B units are written into the ledger by the portal from Hostex
-- and Era's statements (source = 'rental'), so the ledger stays complete
-- without anyone typing them.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) Ledger: every rupiah in or out ───────────────────────────────────
-- category (out): land | architecture | construction | construction_addon |
--   doors_windows | kitchen_wardrobe | aircon | furniture | appliances |
--   fit_out | finishing | slf | landscaping | permits_fees | operating |
--   rental_expense | agent_commission | deposit_refund | partner_out |
--   loan_repayment | bank_charges | other
-- category (in): unit_sale | rental_income | deposit_in | loan_drawdown |
--   capital_in | bank_interest | other
-- counterparty: a buyer key (receivables.ledger_match), a loan key
--   (loans.key), 'ikiel' for capital, or free text.
create table if not exists project_ledger (
  id             bigserial primary key,
  project_key    text not null default 'tropicana',
  entry_date     date not null,
  direction      text not null check (direction in ('in', 'out')),
  amount         numeric not null,                 -- IDR, positive
  fx_amount      numeric,                          -- the original amount when it was not IDR
  fx_currency    text,
  category       text not null default 'other',
  description    text,
  account        text,                             -- OCBC | Oliver Permata | Oliver PayPal | Cash | HSBC | Ikiel Permata …
  counterparty   text,
  unit           text,                             -- 'A1' … 'B7' when it belongs to one unit
  commitment_id  bigint,                           -- pays down a project_commitments row
  source         text not null default 'manual',  -- manual | import | rental
  source_ref     text unique,                      -- dedupe key for imports and rental rows
  note           text,
  flags          text[] not null default '{}',     -- 'review' = imported, needs Ikiel's eye
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create index if not exists idx_project_ledger_date on project_ledger (project_key, entry_date);
create index if not exists idx_project_ledger_cp on project_ledger (project_key, counterparty);

-- ── 2) Commitments: what is still to pay ────────────────────────────────
-- Paid so far = Σ ledger 'out' rows carrying this commitment_id; remaining =
-- total − paid. status open | paid | dropped.
create table if not exists project_commitments (
  id           bigserial primary key,
  project_key  text not null default 'tropicana',
  name         text not null,
  category     text not null default 'other',
  total        numeric not null default 0,         -- IDR
  due_on       date,
  status       text not null default 'open',
  note         text,
  position     int not null default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique (project_key, name)
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'project_ledger_commitment_fk') then
    alter table project_ledger add constraint project_ledger_commitment_fk
      foreign key (commitment_id) references project_commitments(id) on delete set null;
  end if;
end $$;

-- ── 3) Receivables: the buyers ──────────────────────────────────────────
-- Received = Σ ledger 'in' rows whose counterparty = ledger_match. The
-- contract is usually in USD; fx_rate turns it into IDR for the balance.
-- balance_override (IDR) wins when the FX drift makes the computed balance
-- misleading. status open | settled.
create table if not exists project_receivables (
  id               bigserial primary key,
  project_key      text not null default 'tropicana',
  buyer            text not null,
  units            text[] not null default '{}',
  contract_amount  numeric not null default 0,
  currency         text not null default 'USD',
  fx_rate          numeric,                          -- IDR per unit of currency
  balance_override numeric,
  ledger_match     text not null,                    -- counterparty key on the ledger
  status           text not null default 'open',
  note             text,
  position         int not null default 0,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  unique (project_key, ledger_match)
);

-- ── 4) Loans ────────────────────────────────────────────────────────────
-- Drawn = Σ ledger 'in' loan_drawdown rows with counterparty = key; repaid =
-- Σ ledger 'out' loan_repayment rows. interest_rate is % per year, simple,
-- accrued on the outstanding balance from started_on (0 = interest-free).
create table if not exists project_loans (
  id             bigserial primary key,
  project_key    text not null default 'tropicana',
  key            text not null,
  lender         text not null,
  principal      numeric,                          -- as agreed, in currency
  currency       text not null default 'IDR',
  fx_rate        numeric,
  interest_rate  numeric not null default 0,
  started_on     date,
  headline       boolean not null default false,   -- the one the dashboard leads with
  note           text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  unique (project_key, key)
);

-- ── 5) Accounts: where the money sits ───────────────────────────────────
-- balance / balance_as_of is what the bank said on that day; the ledger rows
-- after that date roll it forward. counts_as_cash: part of "what is in the
-- company account" for the loan headline.
create table if not exists project_accounts (
  id              bigserial primary key,
  project_key     text not null default 'tropicana',
  name            text not null,
  kind            text not null default 'bank',    -- bank | partner | cash | wallet
  counts_as_cash  boolean not null default false,
  balance         numeric,
  balance_as_of   date,
  note            text,
  position        int not null default 0,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique (project_key, name)
);

-- ── 6) Settings ─────────────────────────────────────────────────────────
insert into settings (key, value) values ('project_finance', '{
  "fx_usd": 16300,
  "rental_group_key": "tropicana-b2356",
  "rental_from": "2025-08",
  "projection_months": 3,
  "units_total": 14,
  "units_unsold": ["B2", "B3", "B5", "B6"]
}'::jsonb)
on conflict (key) do nothing;

-- ═══════════════════════════════════════════════════════════════════════
-- SEED — from "Tropicana Construction & Payment Schedule 04Jan2026.xlsx"
-- (the ledger is that sheet's "2.) Accounting" as of January 2026; correct
-- and extend it on the Finance page). Keyed on source_ref / name / key, so
-- re-running never duplicates and never overwrites edits.
-- ═══════════════════════════════════════════════════════════════════════

insert into project_accounts (project_key, name, kind, counts_as_cash, position, note) values
  ('tropicana', 'OCBC',           'bank',    true,  1, 'PT Double 8 company account'),
  ('tropicana', 'Oliver Permata', 'partner', false, 2, 'Oli''s account; used for the land and most of the build'),
  ('tropicana', 'Oliver PayPal',  'wallet',  false, 3, null),
  ('tropicana', 'Cash',           'cash',    false, 4, null),
  ('tropicana', 'HSBC',           'partner', false, 5, 'Oli''s HSBC'),
  ('tropicana', 'Ikiel Permata',  'partner', false, 6, 'Ikiel''s account')
on conflict (project_key, name) do nothing;

insert into project_loans (project_key, key, lender, principal, currency, interest_rate, started_on, headline, note) values
  ('tropicana', 'mil',    'Oli''s mother-in-law', 2620800000, 'IDR', 0, '2023-04-23', true,
   'PLACEHOLDER from the sheet: the two "Investment Oliver" entries that paid 80% of the land lease. Confirm the principal, the currency it was lent in, any interest, and record every repayment made so far.'),
  ('tropicana', 'bridge', 'Oli (bridge loan)', 1821188763, 'IDR', 0, '2024-10-15', false,
   'IDR 150M in Oct 2024 plus USD 100,000 (IDR 1,671,188,763) in May 2025; the USD 100,000 was repaid on 30 Dec 2025. Confirm whether the 150M was repaid.')
on conflict (project_key, key) do nothing;

insert into project_receivables (project_key, buyer, units, contract_amount, currency, fx_rate, ledger_match, status, position, note) values
  ('tropicana', 'Will & Marie-Josée',   '{A1}',       107500, 'USD', 16300, 'will',          'open',    1, 'Paid partly in CAD via Ikiel; the sheet had USD 27,446 still due in Jan 2026 with payments continuing to May 2026.'),
  ('tropicana', 'Michael Hoffmann',     '{A2,A3,A6}', 240000, 'USD', 16300, 'micha',         'settled', 2, 'Balance (USD 71,525) settled through the A6 resale: the Singapore buyers'' installments from April 2026 go to Mr Hoffmann.'),
  ('tropicana', 'Andrea Sun Junli',     '{A4}',        99000, 'USD', 16300, 'andrea',        'settled', 3, null),
  ('tropicana', 'Cielo Fortin',         '{A5}',        90000, 'USD', 16300, 'cielo',         'settled', 4, null),
  ('tropicana', 'Margaux Gastine Muhr', '{A7}',        76000, 'USD', 16300, 'margaux',       'open',    5, 'USD 8,000 commission and USD 8,000 held in escrow until the SLF is finished.'),
  ('tropicana', 'Ryan Van Millingen',   '{B7}',       100000, 'USD', 16300, 'vanmillingen',  'open',    6, null),
  ('tropicana', 'Emily Hou',            '{B1}',        92500, 'USD', 16300, 'emily',         'settled', 7, 'Unit from the sheet''s income overview; confirm.'),
  ('tropicana', 'Kate Taylor',          '{B4}',       100000, 'USD', 16300, 'kate',          'settled', 8, null),
  ('tropicana', 'Singapore buyers (A6 resale)', '{A6}', 1290431436, 'IDR', null, 'singapore', 'open', 9, 'Double 8''s share of the A6 resale: the deposit, signing, balance and installments 4 to 7 (to March 2026). Later installments are paid to Mr Hoffmann and are not ours.')
on conflict (project_key, ledger_match) do nothing;

insert into project_commitments (project_key, name, category, total, status, position, note) values
  ('tropicana', 'SLF permit (agent)',        'slf',   574000000, 'open', 1, 'IDR 574M in total; the 20% deposit and the Sisi contribution are on the ledger against this row.'),
  ('tropicana', 'Perimeter wall & parking',  'construction', 200000000, 'open', 2, 'From the profit overview; no payment yet.')
on conflict (project_key, name) do nothing;

insert into project_ledger (project_key, entry_date, direction, amount, category, description, account, counterparty, unit, source, source_ref, note) values
  ('tropicana', '2023-04-23', 'in', 1965600000.0, 'loan_drawdown', 'Investment Oliver', 'Oliver Permata', 'mil', null, 'import', 'import:in:6', null),
  ('tropicana', '2023-04-23', 'out', 1965600000.0, 'land', '60% payment land lease', 'Oliver Permata', null, null, 'import', 'import:out:6', null),
  ('tropicana', '2023-09-13', 'in', 655200000.0, 'loan_drawdown', 'Investment Oliver', 'Oliver Permata', 'mil', null, 'import', 'import:in:7', null),
  ('tropicana', '2023-09-13', 'out', 655200000.0, 'land', '20% payment land lease', 'Oliver Permata', null, null, 'import', 'import:out:7', null),
  ('tropicana', '2023-12-28', 'in', 223076000.0, 'unit_sale', '3rd Payment Cielo', 'OCBC', 'cielo', null, 'import', 'import:in:36', null),
  ('tropicana', '2023-12-28', 'in', 122640000.0, 'unit_sale', 'Deposit Kibarer (French buyers)', 'Oliver Permata', 'margaux', null, 'import', 'import:in:8', null),
  ('tropicana', '2024-02-01', 'out', 67812625.0, 'architecture', '3D renderings Ngurah', 'Oliver Permata', null, null, 'import', 'import:out:8', null),
  ('tropicana', '2024-02-13', 'in', 495577798.0, 'unit_sale', 'Payment Kibarer (French buyers)', 'Oliver Permata', 'margaux', null, 'import', 'import:in:10', null),
  ('tropicana', '2024-02-13', 'in', 118487348.0, 'capital_in', 'Investment Ikiel', 'Oliver PayPal', 'ikiel', null, 'import', 'import:in:11', null),
  ('tropicana', '2024-02-13', 'in', 15000000.0, 'capital_in', 'Investment Ikiel', 'Oliver Permata', 'ikiel', null, 'import', 'import:in:9', null),
  ('tropicana', '2024-02-13', 'out', 655200000.0, 'land', '20% payment land lease', 'Oliver Permata', null, null, 'import', 'import:out:9', null),
  ('tropicana', '2024-02-15', 'in', 309512625.0, 'capital_in', 'Investment Ikiel', 'Oliver Permata', 'ikiel', null, 'import', 'import:in:12', null),
  ('tropicana', '2024-02-20', 'in', 212000000.0, 'capital_in', 'Investment Ikiel', 'Oliver Permata', 'ikiel', null, 'import', 'import:in:13', null),
  ('tropicana', '2024-02-20', 'in', 739711362.0, 'unit_sale', '1st Payment Michael', 'Oliver Permata', 'micha', null, 'import', 'import:in:14', null),
  ('tropicana', '2024-02-20', 'out', 500000000.0, 'construction', '15% DP Construction Ngurah 1', 'Oliver Permata', null, null, 'import', 'import:out:10', null),
  ('tropicana', '2024-02-20', 'out', 500000000.0, 'construction', '15% DP Construction Ngurah 2', 'Oliver Permata', null, null, 'import', 'import:out:11', null),
  ('tropicana', '2024-02-21', 'out', 246055400.0, 'construction', '15% DP Construction Ngurah 3', 'Oliver Permata', null, null, 'import', 'import:out:12', null),
  ('tropicana', '2024-05-24', 'out', 40687575.0, 'architecture', 'Basic Design Ngurah', 'Oliver Permata', null, null, 'import', 'import:out:13', null),
  ('tropicana', '2024-06-25', 'in', 130320000.0, 'unit_sale', '1st Payment Van Millingen 1', 'Oliver Permata', 'vanmillingen', null, 'import', 'import:in:15', null),
  ('tropicana', '2024-06-25', 'out', 300000000.0, 'construction', '15% 1 Construction Ngurah 1', 'Oliver Permata', null, null, 'import', 'import:out:14', null),
  ('tropicana', '2024-06-26', 'in', 324659881.0, 'unit_sale', '1st Payment Van Millingen 2', 'Oliver Permata', 'vanmillingen', null, 'import', 'import:in:16', null),
  ('tropicana', '2024-06-26', 'out', 300000000.0, 'construction', '15% 1 Construction Ngurah 2', 'Oliver Permata', null, null, 'import', 'import:out:15', null),
  ('tropicana', '2024-06-28', 'in', 49125000.0, 'unit_sale', '1st Payment Van Millingen 3', 'Oliver Permata', 'vanmillingen', null, 'import', 'import:in:17', null),
  ('tropicana', '2024-06-28', 'in', 193838733.0, 'unit_sale', '1st Payment Van Millingen 4', 'Oliver Permata', 'vanmillingen', null, 'import', 'import:in:18', null),
  ('tropicana', '2024-07-09', 'in', 323600000.0, 'unit_sale', '2nd Payment Michael 1', 'Oliver Permata', 'micha', null, 'import', 'import:in:19', null),
  ('tropicana', '2024-07-11', 'out', 320000000.0, 'construction', '15% 1 Construction Ngurah 3', 'Oliver Permata', null, null, 'import', 'import:out:16', null),
  ('tropicana', '2024-07-15', 'out', 100000000.0, 'construction', '15% 1 Construction Ngurah 4', 'Oliver Permata', null, null, 'import', 'import:out:17', null),
  ('tropicana', '2024-07-18', 'in', 288900000.0, 'unit_sale', '2nd Payment Michael 2', 'Oliver Permata', 'micha', null, 'import', 'import:in:20', null),
  ('tropicana', '2024-07-18', 'out', 290000000.0, 'construction', '15% 1 Construction Ngurah 5', 'Oliver Permata', null, null, 'import', 'import:out:18', null),
  ('tropicana', '2024-08-13', 'in', 539240000.0, 'unit_sale', '2nd Payment Michael 3', 'Oliver Permata', 'micha', null, 'import', 'import:in:21', null),
  ('tropicana', '2024-08-13', 'out', 143000000.0, 'construction', '15% 1 Construction Ngurah 6', 'Oliver Permata', null, null, 'import', 'import:out:19', null),
  ('tropicana', '2024-09-05', 'out', 400000000.0, 'construction', '20% 2 Construction Ngurah 1', 'Oliver Permata', null, null, 'import', 'import:out:20', null),
  ('tropicana', '2024-09-18', 'in', 429240000.0, 'unit_sale', '1st Payment Cielo', 'OCBC', 'cielo', null, 'import', 'import:in:22', null),
  ('tropicana', '2024-09-18', 'out', 400000000.0, 'construction', '20% 2 Construction Ngurah 2', 'OCBC', null, null, 'import', 'import:out:21', null),
  ('tropicana', '2024-09-23', 'in', 183660000.0, 'unit_sale', '2nd Payment Kibarer (French buyers)', 'OCBC', 'margaux', null, 'import', 'import:in:23', null),
  ('tropicana', '2024-09-23', 'out', 200000000.0, 'construction', '20% 2 Construction Ngurah 3', 'OCBC', null, null, 'import', 'import:out:22', null),
  ('tropicana', '2024-10-15', 'in', 150000000.0, 'loan_drawdown', 'Bridge loan Oliver', 'Oliver Permata', 'bridge', null, 'import', 'import:in:24', null),
  ('tropicana', '2024-10-15', 'in', 150000000.0, 'unit_sale', '1st Payment Will & Marie Josee', 'Oliver PayPal', 'will', null, 'import', 'import:in:25', 'Transferred from iki'),
  ('tropicana', '2024-10-15', 'out', 300000000.0, 'construction', '20% 2 Construction Ngurah 4', 'Oliver Permata', null, null, 'import', 'import:out:23', null),
  ('tropicana', '2024-10-16', 'in', 141426000.0, 'unit_sale', '2nd Payment Cielo', 'OCBC', 'cielo', null, 'import', 'import:in:29', null),
  ('tropicana', '2024-10-21', 'in', 263547247.0, 'unit_sale', '2nd Payment Van Millingen 1', 'Oliver Permata', 'vanmillingen', null, 'import', 'import:in:26', null),
  ('tropicana', '2024-10-21', 'in', 134970000.0, 'unit_sale', '2nd Payment Van Millingen 2', 'OCBC', 'vanmillingen', null, 'import', 'import:in:27', null),
  ('tropicana', '2024-10-21', 'in', 50386800.0, 'unit_sale', '2nd Payment Van Millingen 3', 'OCBC', 'vanmillingen', null, 'import', 'import:in:28', null),
  ('tropicana', '2024-10-28', 'in', 62400000.0, 'unit_sale', '2nd Payment Cielo', 'OCBC', 'cielo', null, 'import', 'import:in:30', null),
  ('tropicana', '2024-10-28', 'out', 263547247.0, 'construction', '20% 2 Construction Ngurah 5', 'Oliver Permata', null, null, 'import', 'import:out:24', null),
  ('tropicana', '2024-10-28', 'out', 235846353.0, 'construction', '20% 2 Construction Ngurah 6', 'OCBC', null, null, 'import', 'import:out:25', null),
  ('tropicana', '2024-10-31', 'out', 114800000.0, 'slf', '20% DP SLF', 'OCBC', null, null, 'import', 'import:out:26', null),
  ('tropicana', '2024-11-05', 'in', 32917500.0, 'unit_sale', '2nd Payment Cielo', 'OCBC', 'cielo', null, 'import', 'import:in:31', null),
  ('tropicana', '2024-11-05', 'in', 124722000.0, 'unit_sale', '2nd Payment Cielo', 'OCBC', 'cielo', null, 'import', 'import:in:32', null),
  ('tropicana', '2024-11-13', 'in', 188880000.0, 'unit_sale', '3rd Payment Kibarer (French buyers)', 'OCBC', 'margaux', null, 'import', 'import:in:33', null),
  ('tropicana', '2024-11-15', 'out', 211500000.0, 'doors_windows', 'DP Wildan Doors & Windows', 'OCBC', null, null, 'import', 'import:out:27', null),
  ('tropicana', '2024-11-22', 'out', 199000000.0, 'construction', '3 Construction Ngurah 1', 'OCBC', null, null, 'import', 'import:out:28', null),
  ('tropicana', '2024-12-03', 'out', 220000000.0, 'construction', '3 Construction Ngurah 2', 'OCBC', null, null, 'import', 'import:out:29', null),
  ('tropicana', '2024-12-04', 'in', 475650000.0, 'unit_sale', '3rd Payment Michael DP', 'Oliver Permata', 'micha', null, 'import', 'import:in:37', null),
  ('tropicana', '2024-12-04', 'out', 475650000.0, 'construction', '3 Construction Ngurah 3', 'Oliver Permata', null, null, 'import', 'import:out:30', null),
  ('tropicana', '2024-12-06', 'in', 20000000.0, 'unit_sale', '1st Payment Will / Marie-Josee 1', 'OCBC', 'will', null, 'import', 'import:in:34', null),
  ('tropicana', '2024-12-06', 'in', 20000000.0, 'capital_in', 'Money Ikiel???', 'OCBC', 'ikiel', null, 'import', 'import:in:39', null),
  ('tropicana', '2024-12-11', 'in', 7950000.0, 'other', 'Deposit Austin Aalborg', 'OCBC', 'austin', null, 'import', 'import:in:40', null),
  ('tropicana', '2024-12-11', 'out', 110000000.0, 'construction', '3 Construction Ngurah 4', 'Oliver Permata', null, null, 'import', 'import:out:31', null),
  ('tropicana', '2024-12-20', 'in', 750000000.0, 'unit_sale', '1st Payment Emily', 'OCBC', 'emily', null, 'import', 'import:in:41', null),
  ('tropicana', '2024-12-27', 'in', 113701000.0, 'unit_sale', '3rd Payment Cielo', 'OCBC', 'cielo', null, 'import', 'import:in:42', null),
  ('tropicana', '2024-12-27', 'out', 280000000.0, 'construction', '3 Construction Ngurah 5', 'OCBC', null, null, 'import', 'import:out:32', null),
  ('tropicana', '2024-12-27', 'out', 115000000.0, 'construction', '3 Construction Ngurah 6', 'OCBC', null, null, 'import', 'import:out:33', null),
  ('tropicana', '2025-01-09', 'in', 160290900.0, 'unit_sale', '1st Payment Will / Marie-Josee 2', 'OCBC', 'will', null, 'import', 'import:in:43', null),
  ('tropicana', '2025-01-09', 'out', 509743600.0, 'construction', '3 Construction Ngurah 7', 'OCBC', null, null, 'import', 'import:out:34', null),
  ('tropicana', '2025-01-14', 'out', 61440000.0, 'aircon', 'DP Airconditioning', 'OCBC', null, null, 'import', 'import:out:35', null),
  ('tropicana', '2025-01-30', 'in', 27344790.0, 'unit_sale', '4th Payment French Buyers', 'OCBC', 'margaux', null, 'import', 'import:in:45', null),
  ('tropicana', '2025-01-30', 'in', 65258325.0, 'unit_sale', '2nd Payment Cielo', 'OCBC', 'cielo', null, 'import', 'import:in:46', null),
  ('tropicana', '2025-02-10', 'in', 324400000.0, 'unit_sale', '1st Payment Andrea', 'Oliver Permata', 'andrea', null, 'import', 'import:in:44', null),
  ('tropicana', '2025-02-10', 'out', 324400000.0, 'construction', '4 Construction Ngurah 1', 'Oliver Permata', null, null, 'import', 'import:out:36', null),
  ('tropicana', '2025-02-11', 'out', 170000000.0, 'construction', '4 Construction Ngurah 2', 'OCBC', null, null, 'import', 'import:out:37', null),
  ('tropicana', '2025-02-21', 'in', 55287428.0, 'unit_sale', '1st Payment Will / Marie-Josee 2', 'OCBC', 'will', null, 'import', 'import:in:47', null),
  ('tropicana', '2025-02-21', 'out', 18000000.0, 'permits_fees', 'Banjar contribution', 'Oliver Permata', null, null, 'import', 'import:out:38', null),
  ('tropicana', '2025-03-03', 'in', 328500000.0, 'unit_sale', '3rd Payment Michael DP', 'Oliver Permata', 'micha', null, 'import', 'import:in:48', null),
  ('tropicana', '2025-03-03', 'out', 328500000.0, 'construction', '4 Construction Ngurah 3', 'Oliver Permata', null, null, 'import', 'import:out:39', null),
  ('tropicana', '2025-03-18', 'out', 44000000.0, 'construction', '4 Construction Ngurah 4', 'OCBC', null, null, 'import', 'import:out:40', null),
  ('tropicana', '2025-03-24', 'out', 150000000.0, 'construction', '4 Construction Ngurah 5', 'Oliver HSBC (reimbursed to Oliver)', null, null, 'import', 'import:out:41', null),
  ('tropicana', '2025-03-26', 'in', 766325895.0, 'unit_sale', 'Final Payment Emily', 'OCBC', 'emily', null, 'import', 'import:in:49', null),
  ('tropicana', '2025-03-27', 'out', 460000000.0, 'construction', '4 Construction Ngurah 6', 'OCBC', null, null, 'import', 'import:out:42', null),
  ('tropicana', '2025-04-08', 'in', 445151000.0, 'unit_sale', '2nd Payment Andrea', 'Oliver Permata', 'andrea', null, 'import', 'import:in:50', null),
  ('tropicana', '2025-04-08', 'out', 211500000.0, 'doors_windows', '50% Payment Windows', 'Oliver Permata', null, null, 'import', 'import:out:43', null),
  ('tropicana', '2025-04-09', 'out', 233651000.0, 'construction', '4 Construction Ngurah 7', 'Oliver Permata', null, null, 'import', 'import:out:44', null),
  ('tropicana', '2025-04-12', 'in', 32268110.0, 'unit_sale', '1st Payment Will / Marie-Josee 3', 'OCBC', 'will', null, 'import', 'import:in:51', null),
  ('tropicana', '2025-04-20', 'in', 24225465.0, 'unit_sale', '1st Payment Will / Marie-Josee 4', 'OCBC', 'will', null, 'import', 'import:in:52', null),
  ('tropicana', '2025-04-20', 'in', 24225465.0, 'unit_sale', '1st Payment Will / Marie-Josee 5', 'OCBC', 'will', null, 'import', 'import:in:53', null),
  ('tropicana', '2025-05-14', 'out', 120000000.0, 'construction', '4 Construction Ngurah 8', 'OCBC', null, null, 'import', 'import:out:45', null),
  ('tropicana', '2025-05-19', 'in', 1671188763.0, 'loan_drawdown', 'Bridge loan Oliver', 'Oliver Permata', 'bridge', null, 'import', 'import:in:54', null),
  ('tropicana', '2025-05-20', 'out', 269909040.0, 'construction', '4 Construction Ngurah 9', 'Oliver Permata', null, null, 'import', 'import:out:46', null),
  ('tropicana', '2025-05-20', 'out', 262500000.0, 'kitchen_wardrobe', 'DP Wildan Kitchen & Wardrobe', 'Oliver Permata', null, null, 'import', 'import:out:47', null),
  ('tropicana', '2025-05-21', 'out', 13300000.0, 'fit_out', 'WC Sets', 'Oliver Permata', null, null, 'import', 'import:out:48', null),
  ('tropicana', '2025-05-22', 'out', 336821542.0, 'construction', '4 Construction Ngurah 10', 'Oliver Permata', null, null, 'import', 'import:out:49', null),
  ('tropicana', '2025-05-22', 'out', 100000000.0, 'furniture', 'DP Dewi Furniture', 'Oliver Permata', null, null, 'import', 'import:out:50', null),
  ('tropicana', '2025-05-27', 'in', 29560090.0, 'unit_sale', '1st Payment Will / Marie-Josee 6', 'OCBC', 'will', null, 'import', 'import:in:55', null),
  ('tropicana', '2025-05-30', 'in', 29516932.0, 'unit_sale', '1st Payment Will / Marie-Josee 7', 'OCBC', 'will', null, 'import', 'import:in:56', null),
  ('tropicana', '2025-05-31', 'out', 8000000.0, 'furniture', 'Dewi Mattrasses (4x)', 'Oliver Permata', null, null, 'import', 'import:out:51', null),
  ('tropicana', '2025-06-01', 'in', 23825479.0, 'unit_sale', '1st Payment Will / Marie-Josee 8', 'OCBC', 'will', null, 'import', 'import:in:57', null),
  ('tropicana', '2025-06-01', 'in', 23825479.0, 'unit_sale', '1st Payment Will / Marie-Josee 9', 'OCBC', 'will', null, 'import', 'import:in:58', null),
  ('tropicana', '2025-06-02', 'in', 23806938.0, 'unit_sale', '1st Payment Will / Marie-Josee 10', 'OCBC', 'will', null, 'import', 'import:in:59', null),
  ('tropicana', '2025-06-11', 'out', 211500000.0, 'doors_windows', '75% Payment Windows', 'OCBC', null, null, 'import', 'import:out:52', null),
  ('tropicana', '2025-06-19', 'out', 131250000.0, 'kitchen_wardrobe', '75% Payment Kitchen/wardrobe', 'Oliver Permata', null, null, 'import', 'import:out:53', null),
  ('tropicana', '2025-06-19', 'out', 82562360.0, 'construction_addon', 'Add-On Ngurah: Tiles, Sanitary', 'Oliver Permata', null, null, 'import', 'import:out:54', null),
  ('tropicana', '2025-06-26', 'out', 20000000.0, 'furniture', 'DP Dewi Furniture', 'Oliver Permata', null, null, 'import', 'import:out:55', null),
  ('tropicana', '2025-06-26', 'out', 2716288.0, 'appliances', 'Sink 4', 'HSBC', null, null, 'import', 'import:out:56', null),
  ('tropicana', '2025-06-26', 'out', 4500000.0, 'fit_out', 'DP Pendant lights', 'Oliver Permata', null, null, 'import', 'import:out:57', null),
  ('tropicana', '2025-06-30', 'in', 321768205.0, 'unit_sale', '2nd payment Andrea 2', 'Oliver Permata', 'andrea', null, 'import', 'import:in:60', null),
  ('tropicana', '2025-07-01', 'in', 407520855.0, 'unit_sale', '3rd Payment Andrea 3', 'Oliver Permata', 'andrea', null, 'import', 'import:in:61', null),
  ('tropicana', '2025-07-02', 'out', 49952000.0, 'aircon', 'AC Units 8 (first 4 units)', 'Oliver Permata', null, null, 'import', 'import:out:58', null),
  ('tropicana', '2025-07-02', 'out', 2917900.0, 'appliances', '3 cooktops', 'Oliver Permata', null, null, 'import', 'import:out:59', null),
  ('tropicana', '2025-07-03', 'out', 50000000.0, 'furniture', 'Final paument Dewi Furniture', 'Oliver Permata', null, null, 'import', 'import:out:60', null),
  ('tropicana', '2025-07-05', 'out', 77600000.0, 'permits_fees', 'Payment 14 PLN Meters (4400)', 'Oliver Permata', null, null, 'import', 'import:out:61', null),
  ('tropicana', '2025-07-07', 'out', 17500000.0, 'appliances', '10 water heaters', 'Oliver Permata', null, null, 'import', 'import:out:63', null),
  ('tropicana', '2025-07-08', 'out', 27200000.0, 'appliances', '8 Fridges GEA', 'Oliver Permata', null, null, 'import', 'import:out:62', null),
  ('tropicana', '2025-07-13', 'out', 158240000.0, 'doors_windows', 'Balance Wildan door/window', 'Oliver Permata', null, null, 'import', 'import:out:64', null),
  ('tropicana', '2025-07-13', 'out', 74025000.0, 'kitchen_wardrobe', 'Balance wildan cabinets', 'Oliver Permata', null, null, 'import', 'import:out:69', null),
  ('tropicana', '2025-07-14', 'out', 2433300.0, 'appliances', 'Water dispenser A7', 'Oliver Permata', null, 'A7', 'import', 'import:out:70', null),
  ('tropicana', '2025-07-14', 'out', 3086500.0, 'appliances', 'TV A7', 'Oliver Permata', null, 'A7', 'import', 'import:out:71', null),
  ('tropicana', '2025-07-14', 'out', 1275000.0, 'fit_out', 'Upstairs planter A7', 'Oliver Permata', null, 'A7', 'import', 'import:out:72', null),
  ('tropicana', '2025-07-14', 'out', 900000.0, 'fit_out', '3 bathroom mirrors', 'Oliver Permata', null, null, 'import', 'import:out:73', null),
  ('tropicana', '2025-07-14', 'out', 350000.0, 'fit_out', 'Decorative pottery A7', 'Oliver Permata', null, 'A7', 'import', 'import:out:75', null),
  ('tropicana', '2025-07-15', 'out', 2140000.0, 'fit_out', 'Carpet and more deco A7', 'Oliver Permata', null, 'A7', 'import', 'import:out:65', null),
  ('tropicana', '2025-07-15', 'out', 3300000.0, 'fit_out', '11 bathroom mirrors', 'Oliver Permata', null, null, 'import', 'import:out:66', null),
  ('tropicana', '2025-07-15', 'out', 637000.0, 'fit_out', 'Kitchen items A7', 'Oliver Permata', null, 'A7', 'import', 'import:out:67', null),
  ('tropicana', '2025-07-15', 'out', 492400.0, 'fit_out', 'More kitchen items A7', 'Oliver Permata', null, 'A7', 'import', 'import:out:68', null),
  ('tropicana', '2025-07-15', 'out', 1000000.0, 'operating', 'Deep cleaning A7', 'Ikiel Permata', null, 'A7', 'import', 'import:out:76', null),
  ('tropicana', '2025-07-19', 'out', 4500000.0, 'fit_out', 'Rattan Lampshades', 'Oliver Permata', null, null, 'import', 'import:out:77', null),
  ('tropicana', '2025-07-21', 'out', 183528991.0, 'construction_addon', 'Balance Ngurah Kitchen / Outside', 'Oliver Permata', null, null, 'import', 'import:out:74', null),
  ('tropicana', '2025-07-22', 'in', 105735866.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:62', null),
  ('tropicana', '2025-07-22', 'in', 105760733.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:63', null),
  ('tropicana', '2025-07-28', 'in', 101334763.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:64', null),
  ('tropicana', '2025-07-31', 'out', 1998000.0, 'landscaping', 'Plants landscaping A5 & B7', 'Oliver Permata', null, null, 'import', 'import:out:78', null),
  ('tropicana', '2025-08-06', 'in', 95160930.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:65', null),
  ('tropicana', '2025-08-07', 'in', 95263090.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:66', null),
  ('tropicana', '2025-08-09', 'out', 6300000.0, 'fit_out', 'Deco items 3 units', 'Oliver Permata', null, null, 'import', 'import:out:79', null),
  ('tropicana', '2025-08-12', 'out', 2800000.0, 'furniture', 'Balance furniture Dewi', 'Oliver Permata', null, null, 'import', 'import:out:80', null),
  ('tropicana', '2025-08-12', 'out', 50000000.0, 'kitchen_wardrobe', 'Balance payment interior Wldan', 'Oliver Permata', null, null, 'import', 'import:out:93', null),
  ('tropicana', '2025-08-13', 'out', 9000000.0, 'appliances', 'TV and water dispenser A5 & B7', 'Oliver Permata', null, null, 'import', 'import:out:81', null),
  ('tropicana', '2025-08-18', 'in', 29392057.0, 'unit_sale', '1st Payment Will / Marie-Josee 11', 'OCBC', 'will', null, 'import', 'import:in:67', null),
  ('tropicana', '2025-08-19', 'out', 2059000.0, 'fit_out', 'Fit out kitchen IKEA A5 & B7', 'Oliver Permata', null, null, 'import', 'import:out:82', null),
  ('tropicana', '2025-08-19', 'out', 4002000.0, 'fit_out', 'Bed linens and towels A5 & B7', 'Oliver Permata', null, null, 'import', 'import:out:85', null),
  ('tropicana', '2025-08-21', 'out', 1670550.0, 'permits_fees', 'Internet installation A5', 'OCBC', null, 'A5', 'import', 'import:out:83', null),
  ('tropicana', '2025-08-22', 'in', 93659765.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:68', null),
  ('tropicana', '2025-08-22', 'out', 125880000.0, 'aircon', 'Balance AC installation all remaining', 'OCBC', null, null, 'import', 'import:out:84', null),
  ('tropicana', '2025-08-23', 'in', 94934547.0, 'unit_sale', 'UNCLEAR probably Kate', 'OCBC', 'kate', null, 'import', 'import:in:69', null),
  ('tropicana', '2025-08-23', 'out', 7174200.0, 'appliances', '8 kitchen sinks', 'Oliver Permata', null, null, 'import', 'import:out:94', null),
  ('tropicana', '2025-08-24', 'in', 199200000.0, 'unit_sale', 'Final Payment Cielo', 'Cash', 'cielo', null, 'import', 'import:in:70', null),
  ('tropicana', '2025-08-25', 'in', 94431807.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:71', null),
  ('tropicana', '2025-08-25', 'out', 500000.0, 'appliances', 'TV bracket installation A5 & B7', 'Oliver Permata', null, null, 'import', 'import:out:86', null),
  ('tropicana', '2025-08-25', 'out', 2200000.0, 'landscaping', 'Garden A5', 'Oliver Permata', null, 'A5', 'import', 'import:out:87', null),
  ('tropicana', '2025-08-25', 'out', 250000.0, 'operating', 'Fogging A5', 'Oliver Permata', null, 'A5', 'import', 'import:out:88', null),
  ('tropicana', '2025-08-25', 'out', 814700.0, 'operating', 'Cleaning products A5', 'Oliver Permata', null, 'A5', 'import', 'import:out:89', null),
  ('tropicana', '2025-08-25', 'out', 900000.0, 'operating', 'Cleaner A5', 'Oliver Permata', null, 'A5', 'import', 'import:out:90', null),
  ('tropicana', '2025-08-25', 'out', 750000.0, 'operating', 'Cleaner B7', 'Oliver Permata', null, 'B7', 'import', 'import:out:91', null),
  ('tropicana', '2025-08-25', 'out', 1086000.0, 'operating', 'Gas and water A5', 'Oliver Permata', null, 'A5', 'import', 'import:out:92', null),
  ('tropicana', '2025-08-27', 'in', 59061425.0, 'unit_sale', '1st Payment Will / Marie-Josee 11', 'OCBC', 'will', null, 'import', 'import:in:72', null),
  ('tropicana', '2025-08-27', 'out', 5500700.0, 'appliances', 'era Petty cash (bracket, TV, Garden A5, Fogging A5, Cleaning Products, Cleaner fee A5, B7, Gas and water Gallon', 'OCBC', null, null, 'import', 'import:out:95', null),
  ('tropicana', '2025-08-29', 'out', 22000000.0, 'furniture', 'Mattressses', 'OCBC', null, null, 'import', 'import:out:96', null),
  ('tropicana', '2025-09-04', 'out', 430000.0, 'fit_out', 'Additional linen', 'Oliver Permata', null, null, 'import', 'import:out:97', null),
  ('tropicana', '2025-09-06', 'out', 1800000.0, 'operating', 'Photographer', 'Oliver Permata', null, null, 'import', 'import:out:98', null),
  ('tropicana', '2025-09-09', 'out', 27625000.0, 'appliances', '3xdispenser, 4xTV, 10xstove', 'OCBC', null, null, 'import', 'import:out:99', null),
  ('tropicana', '2025-09-15', 'out', 1000000.0, 'operating', 'Test Transfer Oliver', 'OCBC', null, null, 'import', 'import:out:100', null),
  ('tropicana', '2025-09-16', 'out', 162917888.51, 'construction_addon', 'Final Ngurah Kitchen / Outside', 'OCBC', null, null, 'import', 'import:out:101', null),
  ('tropicana', '2025-09-17', 'out', 4000000.0, 'fit_out', 'Pottery Art A1,2,3,4,5,6,7 B1,6', 'OCBC', null, null, 'import', 'import:out:102', null),
  ('tropicana', '2025-09-18', 'in', 261790905.0, 'unit_sale', 'Balance payment VanMillingen', 'Oliver Permata', 'vanmillingen', null, 'import', 'import:in:73', null),
  ('tropicana', '2025-09-23', 'in', 103627216.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:74', null),
  ('tropicana', '2025-09-23', 'out', 8550000.0, 'fit_out', 'Deco A2, A6, B1', 'OCBC', null, null, 'import', 'import:out:103', null),
  ('tropicana', '2025-09-25', 'in', 109838873.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:75', null),
  ('tropicana', '2025-09-30', 'out', 105750000.0, 'doors_windows', 'Final payment Wildan Door&Window', 'OCBC', null, null, 'import', 'import:out:104', null),
  ('tropicana', '2025-10-01', 'in', 109484787.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:76', null),
  ('tropicana', '2025-10-06', 'out', 5170000.0, 'fit_out', 'Beding and Linen Unit A4', 'OCBC', null, 'A4', 'import', 'import:out:105', null),
  ('tropicana', '2025-10-07', 'in', 66132000.0, 'unit_sale', 'Overbooking USD (VanMillingen)', 'OCBC', 'vanmillingen', null, 'import', 'import:in:77', null),
  ('tropicana', '2025-10-07', 'in', 66132000.0, 'unit_sale', 'Overbooking USD Cielo', 'OCBC', 'cielo', null, 'import', 'import:in:78', null),
  ('tropicana', '2025-10-09', 'out', 35000000.0, 'slf', 'Sisi SLF contribution', 'OCBC', null, null, 'import', 'import:out:106', null),
  ('tropicana', '2025-10-10', 'in', 108508689.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:79', null),
  ('tropicana', '2025-10-13', 'in', 107819972.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:80', null),
  ('tropicana', '2025-10-13', 'out', 19425000.0, 'appliances', 'Appliances unit 1,2,3 (A)', 'OCBC', null, null, 'import', 'import:out:107', null),
  ('tropicana', '2025-10-15', 'in', 123712500.0, 'unit_sale', 'Final Balance Andrea', 'Oliver Permata', 'andrea', null, 'import', 'import:in:81', null),
  ('tropicana', '2025-10-21', 'out', 2500000.0, 'permits_fees', 'LKPM reporting', 'OCBC', null, null, 'import', 'import:out:108', null),
  ('tropicana', '2025-10-30', 'out', 18889200.0, 'operating', 'Era Refund (Fit-out items A1,2,3,6 / Deco B4,5,6)', 'OCBC', null, null, 'import', 'import:out:110', null),
  ('tropicana', '2025-11-01', 'out', 9750000.0, 'landscaping', 'Trees for unit gardens', 'OCBC', null, null, 'import', 'import:out:109', null),
  ('tropicana', '2025-11-03', 'in', 108967615.0, 'unit_sale', 'DP Singapore Buyers', 'OCBC', 'singapore', null, 'import', 'import:in:82', null),
  ('tropicana', '2025-11-07', 'out', 50000000.0, 'finishing', 'DP Wildan (Finish Project)', 'OCBC', null, null, 'import', 'import:out:111', null),
  ('tropicana', '2025-11-11', 'in', 397165481.0, 'unit_sale', '1st Installment Singapore buyers', 'OCBC', 'singapore', null, 'import', 'import:in:83', null),
  ('tropicana', '2025-11-11', 'out', 9151280.0, 'appliances', '4 Water Heaters', 'HSBC', null, null, 'import', 'import:out:112', null),
  ('tropicana', '2025-11-14', 'in', 140000000.0, 'unit_sale', '1st Installment Singapore buyers', 'OCBC', 'singapore', null, 'import', 'import:in:84', null),
  ('tropicana', '2025-11-14', 'out', 200000000.0, 'construction', 'Severnace Payment Ngurah', 'OCBC', null, null, 'import', 'import:out:113', null),
  ('tropicana', '2025-11-25', 'out', 50000000.0, 'finishing', 'Balance Wildan (Finish Project)', 'OCBC', null, null, 'import', 'import:out:114', null),
  ('tropicana', '2025-12-02', 'out', 44375000.0, 'fit_out', 'Fit-Out items B2356', 'OCBC', null, null, 'import', 'import:out:115', null),
  ('tropicana', '2025-12-09', 'in', 257165481.0, 'unit_sale', '1st Installment Singapore buyers', 'OCBC', 'singapore', null, 'import', 'import:in:85', null),
  ('tropicana', '2025-12-11', 'out', 30000000.0, 'finishing', 'Wildan Retainer Service', 'OCBC', null, null, 'import', 'import:out:116', null),
  ('tropicana', '2025-12-18', 'in', 109897554.0, 'unit_sale', '1st Payment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:86', null),
  ('tropicana', '2025-12-23', 'in', 69537644.0, 'unit_sale', '1st Installment Singapore buyers', 'OCBC', 'singapore', null, 'import', 'import:in:87', null),
  ('tropicana', '2025-12-30', 'out', 1671188763.0, 'loan_repayment', 'Bridge Loan Repayment', 'OCBC', 'bridge', null, 'import', 'import:out:117', null),
  ('tropicana', '2025-12-31', 'out', 20967263.0, 'operating', 'Petty cash refund Era', 'OCBC', null, null, 'import', 'import:out:118', null),
  ('tropicana', '2026-01-08', 'in', 112168209.0, 'unit_sale', 'Final Installment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:88', null),
  ('tropicana', '2026-01-08', 'out', 19528849.0, 'finishing', 'Wildan Retainer Service', 'OCBC', null, null, 'import', 'import:out:119', null),
  ('tropicana', '2026-01-08', 'out', 8400000.0, 'finishing', 'Wildan Balance interior work', 'OCBC', null, null, 'import', 'import:out:120', null),
  ('tropicana', '2026-01-09', 'in', 74600000.0, 'unit_sale', 'Final Installment Kate Taylor', 'OCBC', 'kate', null, 'import', 'import:in:89', null),
  ('tropicana', '2026-01-09', 'out', 2425000.0, 'landscaping', 'Landscaping pathway', 'OCBC', null, null, 'import', 'import:out:121', null),
  ('tropicana', '2026-01-13', 'out', 25500000.0, 'permits_fees', 'Lighting protection rod DP', 'OCBC', null, null, 'import', 'import:out:122', null),
  ('tropicana', '2026-01-13', 'out', 4150000.0, 'fit_out', 'Carpets B5&6', 'OCBC', null, 'B5', 'import', 'import:out:123', null)
on conflict (source_ref) do nothing;

-- Link the SLF payments already made to the SLF commitment.
update project_ledger l set commitment_id = c.id
  from project_commitments c
  where c.project_key = 'tropicana' and c.name = 'SLF permit (agent)'
    and l.project_key = 'tropicana' and l.category = 'slf' and l.direction = 'out' and l.commitment_id is null;

-- OCBC 167800012541 (PT Double Eight Realty) statements, January to July 2026.
-- Rows already on the sheet (8 to 13 Jan 2026) are skipped; 'review' flags mark the ones Ikiel should confirm.
insert into project_ledger (project_key, entry_date, direction, amount, category, description, account, counterparty, unit, source, source_ref, note, flags) values
  ('tropicana', '2026-01-21', 'out', 12750000.0, 'finishing', 'AHMAD WILDAN YAHYA 2', 'OCBC', 'wildan', null, 'import', 'bank:ocbc:2026-01-21:7', 'Wildan (contractor): retainer / finishing works', '{}'),
  ('tropicana', '2026-01-22', 'out', 12520000.0, 'construction', 'WIRA KUSUMA KARYA PT', 'OCBC', 'wira-kusuma', null, 'import', 'bank:ocbc:2026-01-22:8', 'Wira Kusuma Karya PT: what for?', '{review}'),
  ('tropicana', '2026-01-22', 'out', 2000000.0, 'operating', 'I KETUT GANGGAS RATM', 'OCBC', null, null, 'import', 'bank:ocbc:2026-01-22:9', 'paid to I KETUT GANGGAS RATM (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-01-23', 'out', 5000000.0, 'furniture', 'IBU NI MADE DEWI SUP', 'OCBC', 'dewi', null, 'import', 'bank:ocbc:2026-01-23:10', 'Dewi (furniture)', '{}'),
  ('tropicana', '2026-01-25', 'in', 411168.0, 'bank_interest', 'OCBC account interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-01-25:11', 'OCBC interest', '{}'),
  ('tropicana', '2026-01-25', 'out', 82234.0, 'bank_charges', 'Tax on interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-01-25:12', 'tax on interest', '{}'),
  ('tropicana', '2026-01-28', 'out', 1100000.0, 'operating', 'I MADE SUARJANA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-01-28:13', 'paid to I MADE SUARJANA (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-01-28', 'out', 1600000.0, 'operating', 'SARA ANNABEL THOM', 'OCBC', null, null, 'import', 'bank:ocbc:2026-01-28:14', 'paid to SARA ANNABEL THOM (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-01-29', 'out', 19854000.0, 'operating', 'DADAN SAEPULOH', 'OCBC', null, null, 'import', 'bank:ocbc:2026-01-29:15', 'paid to DADAN SAEPULOH (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-01-29', 'in', 69537645.0, 'unit_sale', 'AIRWALLEX HONGKONG LTD/-', 'OCBC', 'singapore', 'A6', 'import', 'bank:ocbc:2026-01-29:16', 'A6 resale installment (Airwallex)', '{}'),
  ('tropicana', '2026-01-31', 'in', 145000000.0, 'unit_sale', 'MWB KUPU KUPU COCOON/Payment Tropicana Valley A1', 'OCBC', 'will', 'A1', 'import', 'bank:ocbc:2026-01-31:17', 'A1 (Will & Marie-Josée), paid via MWB Kupu Kupu Cocoon', '{}'),
  ('tropicana', '2026-02-02', 'out', 2880000.0, 'operating', 'ARIF PANDU WINA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-02:18', 'paid to ARIF PANDU WINA (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-02-02', 'out', 2855000.0, 'fit_out', 'IBU NURUL MADJID', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-02:19', 'Nurul Madjid (carpets on the sheet)', '{}'),
  ('tropicana', '2026-02-03', 'out', 925000.0, 'fit_out', 'IBU NURUL MADJID', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-03:20', 'Nurul Madjid (carpets on the sheet)', '{}'),
  ('tropicana', '2026-02-04', 'out', 19854000.0, 'operating', 'DADAN SAEPULOH', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-04:21', 'paid to DADAN SAEPULOH (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-02-04', 'out', 7700000.0, 'operating', 'I MADE SUARJANA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-04:22', 'paid to I MADE SUARJANA (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-02-05', 'out', 2500000.0, 'operating', 'I PUTU EDI SEPTIAWAN', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-05:23', 'paid to I PUTU EDI SEPTIAWAN (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-02-05', 'out', 2370000.0, 'construction', 'WIRA KUSUMA KARYA PT', 'OCBC', 'wira-kusuma', null, 'import', 'bank:ocbc:2026-02-05:24', 'Wira Kusuma Karya PT: what for?', '{review}'),
  ('tropicana', '2026-02-07', 'out', 5527500.0, 'finishing', 'AHMAD WILDAN YAHYA 2', 'OCBC', 'wildan', null, 'import', 'bank:ocbc:2026-02-07:25', 'Wildan (contractor): retainer / finishing works', '{}'),
  ('tropicana', '2026-02-09', 'out', 3000000.0, 'operating', 'SDR I KETUT GANGGAS R', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-09:26', 'paid to SDR I KETUT GANGGAS R (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-02-09', 'out', 9175000.0, 'fit_out', 'IBU NURUL MADJID', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-09:27', 'Nurul Madjid (carpets on the sheet)', '{}'),
  ('tropicana', '2026-02-11', 'out', 1300000.0, 'operating', 'BPK HERU WARDOYO', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-11:28', 'paid to BPK HERU WARDOYO (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-02-11', 'out', 3953160.0, 'operating', 'PT DETAIL', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-11:29', 'paid to PT DETAIL (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-02-13', 'out', 2310000.0, 'operating', 'PRAJADITA SARI ARTA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-13:30', 'paid to PRAJADITA SARI ARTA (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-02-15', 'out', 5527500.0, 'finishing', 'AHMAD WILDAN YAHYA 2', 'OCBC', 'wildan', null, 'import', 'bank:ocbc:2026-02-15:31', 'Wildan (contractor): retainer / finishing works', '{}'),
  ('tropicana', '2026-02-15', 'out', 6000000.0, 'finishing', 'AHMAD WILDAN YAHYA 2', 'OCBC', 'wildan', null, 'import', 'bank:ocbc:2026-02-15:32', 'Wildan (contractor): retainer / finishing works', '{}'),
  ('tropicana', '2026-02-17', 'out', 1300000.0, 'operating', 'BPK HERU WARDOYO', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-17:33', 'paid to BPK HERU WARDOYO (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-02-17', 'out', 12520000.0, 'construction', 'WIRA KUSUMA KARYA PT', 'OCBC', 'wira-kusuma', null, 'import', 'bank:ocbc:2026-02-17:34', 'Wira Kusuma Karya PT: what for?', '{review}'),
  ('tropicana', '2026-02-17', 'out', 9224040.0, 'operating', 'I GEDE JABUNG ADINEG', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-17:35', 'paid to I GEDE JABUNG ADINEG (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-02-20', 'out', 15019496.0, 'partner_out', 'OLIVER HERRMANN', 'OCBC', 'oli', null, 'import', 'bank:ocbc:2026-02-20:36', 'to Oli: reimbursement, expense or repayment?', '{review}'),
  ('tropicana', '2026-02-20', 'in', 50000000.0, 'rental_income', 'MANON EILANDER/MANON EILANDER', 'OCBC', 'manon', 'B2', 'import', 'bank:ocbc:2026-02-20:37', 'Manon Eilander, B2 Mar to Jun 2026 (Hostex 60M; 50M banked)', '{review}'),
  ('tropicana', '2026-02-20', 'out', 5000000.0, 'agent_commission', 'SDR I MADE INDRA PRA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-20:38', '10% agent commission on a rental', '{}'),
  ('tropicana', '2026-02-25', 'in', 69537646.0, 'unit_sale', 'AIRWALLEX HONGKONG LTD/-', 'OCBC', 'singapore', 'A6', 'import', 'bank:ocbc:2026-02-25:39', 'A6 resale installment (Airwallex)', '{}'),
  ('tropicana', '2026-02-25', 'out', 12750000.0, 'finishing', 'AHMAD WILDAN YAHYA 2', 'OCBC', 'wildan', null, 'import', 'bank:ocbc:2026-02-25:40', 'Wildan (contractor): retainer / finishing works', '{}'),
  ('tropicana', '2026-02-25', 'in', 154580.0, 'bank_interest', 'OCBC account interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-25:41', 'OCBC interest', '{}'),
  ('tropicana', '2026-02-25', 'out', 30916.0, 'bank_charges', 'Tax on interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-25:42', 'tax on interest', '{}'),
  ('tropicana', '2026-02-28', 'out', 2428458.0, 'rental_expense', 'GLOBALXTREME DATA IN', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-28:43', 'internet, one unit', '{}'),
  ('tropicana', '2026-02-28', 'out', 2428458.0, 'rental_expense', 'GLOBALXTREME DATA IN', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-28:44', 'internet, one unit', '{}'),
  ('tropicana', '2026-02-28', 'out', 2428458.0, 'rental_expense', 'GLOBALXTREME DATA IN', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-28:45', 'internet, one unit', '{}'),
  ('tropicana', '2026-02-28', 'out', 2428458.0, 'rental_expense', 'GLOBALXTREME DATA IN', 'OCBC', null, null, 'import', 'bank:ocbc:2026-02-28:46', 'internet, one unit', '{}'),
  ('tropicana', '2026-03-01', 'in', 28000000.0, 'rental_income', 'VILLA RENTAL NIN/VILLA RENTAL NIN', 'OCBC', 'nina-oberoi', 'B5', 'import', 'bank:ocbc:2026-03-01:47', 'Nina Oberoi, B5 Mar to Apr 2026 (IDR 43,867,000 in two transfers = Hostex)', '{}'),
  ('tropicana', '2026-03-01', 'out', 2800000.0, 'agent_commission', 'Sdr I MADE INDRA PRA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-01:48', '10% agent commission on a rental', '{}'),
  ('tropicana', '2026-03-05', 'in', 32000000.0, 'rental_income', 'Villarent Tropic/Villarent Tropic', 'OCBC', 'desiree', 'B6', 'import', 'bank:ocbc:2026-03-05:49', 'Desiree, B6 Mar to Apr 2026 (Hostex 27M; 32M banked, 5M deposit?)', '{review}'),
  ('tropicana', '2026-03-07', 'out', 1600000.0, 'operating', 'I KOMANG SUJANA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-07:50', 'paid to I KOMANG SUJANA (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-03-11', 'out', 5643000.0, 'landscaping', 'NUR HIDAYATI', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-11:51', 'Nur Hidayati (landscaping pathway on the sheet)', '{}'),
  ('tropicana', '2026-03-11', 'out', 3000000.0, 'operating', 'TRI ANG BALI', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-11:52', 'paid to TRI ANG BALI (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-03-13', 'in', 10000000.0, 'rental_income', 'RAFAELA FERREIRA/RAFAELA FERREIRA', 'OCBC', 'rafaela', 'B3', 'import', 'bank:ocbc:2026-03-13:53', 'Rafaela, B3 Mar to Apr 2026: 33M banked, entered as 0 on the Hostex calendar', '{review}'),
  ('tropicana', '2026-03-15', 'in', 23000000.0, 'rental_income', 'RAFAELA FERREIRA/RAFAELA FERREIRA', 'OCBC', 'rafaela', 'B3', 'import', 'bank:ocbc:2026-03-15:54', 'Rafaela, B3 Mar to Apr 2026: 33M banked, entered as 0 on the Hostex calendar', '{review}'),
  ('tropicana', '2026-03-16', 'out', 2800000.0, 'operating', 'KADEK BAYU SISWINTAR', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-16:55', 'paid to KADEK BAYU SISWINTAR (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-03-17', 'out', 130000.0, 'operating', 'PRAJADITA SARI ARTA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-17:56', 'paid to PRAJADITA SARI ARTA (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-03-21', 'out', 10000000.0, 'operating', 'I KETUT GEDE BU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-21:57', 'paid to I KETUT GEDE BU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-03-21', 'in', 15867000.0, 'rental_income', 'VILLA RENTAL NIN/VILLA RENTAL NIN', 'OCBC', 'nina-oberoi', 'B5', 'import', 'bank:ocbc:2026-03-21:58', 'Nina Oberoi, B5 Mar to Apr 2026 (IDR 43,867,000 in two transfers = Hostex)', '{}'),
  ('tropicana', '2026-03-23', 'out', 1586700.0, 'agent_commission', 'Sdr I MADE INDRA PRA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-23:59', '10% agent commission on a rental', '{}'),
  ('tropicana', '2026-03-25', 'in', 217416.0, 'bank_interest', 'OCBC account interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-25:60', 'OCBC interest', '{}'),
  ('tropicana', '2026-03-25', 'out', 43483.0, 'bank_charges', 'Tax on interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-25:61', 'tax on interest', '{}'),
  ('tropicana', '2026-03-26', 'in', 69537646.0, 'unit_sale', 'AIRWALLEX HONGKONG LTD/-', 'OCBC', 'singapore', 'A6', 'import', 'bank:ocbc:2026-03-26:62', 'A6 resale installment (Airwallex)', '{}'),
  ('tropicana', '2026-03-27', 'in', 30000000.0, 'rental_income', 'Villa lease Trop/Villa lease Trop', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-27:63', '"Villa lease Trop" 30M on 27 Mar 2026: which tenant? (Desiree B3 Apr to May, or Manon B2?)', '{review}'),
  ('tropicana', '2026-03-28', 'out', 342000.0, 'operating', 'ARFINA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-28:64', 'paid to ARFINA (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-03-30', 'out', 250000.0, 'operating', 'MULIA TUJUH MAKMUR P', 'OCBC', null, null, 'import', 'bank:ocbc:2026-03-30:65', 'paid to MULIA TUJUH MAKMUR P (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-01', 'out', 495000.0, 'operating', 'Sdri NI KADEK AYU JU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-01:66', 'paid to Sdri NI KADEK AYU JU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-01', 'out', 2400000.0, 'operating', 'IMAM WAHYUDI', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-01:67', 'paid to IMAM WAHYUDI (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-01', 'out', 1000000.0, 'operating', 'IMAM WAHYUDI', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-01:68', 'paid to IMAM WAHYUDI (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-02', 'out', 6621000.0, 'rental_expense', 'ERA SUGIANTI', 'OCBC', 'era', null, 'import', 'bank:ocbc:2026-04-02:69', 'reimbursement to Era for the units expenses', '{}'),
  ('tropicana', '2026-04-06', 'out', 2400000.0, 'operating', 'IMAM WAHYUDI', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-06:70', 'paid to IMAM WAHYUDI (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-06', 'out', 7507000.0, 'rental_expense', 'ERA SUGIANTI', 'OCBC', 'era', null, 'import', 'bank:ocbc:2026-04-06:71', 'reimbursement to Era for the units expenses', '{}'),
  ('tropicana', '2026-04-06', 'out', 3700000.0, 'operating', 'NI PUTU ITA P 2', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-06:72', 'paid to NI PUTU ITA P 2 (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-07', 'out', 2500000.0, 'operating', 'Bpk RANDY ESA WIBOWO', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-07:73', 'paid to Bpk RANDY ESA WIBOWO (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-07', 'out', 5000000.0, 'operating', 'I KETUT GEDE BU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-07:74', 'paid to I KETUT GEDE BU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-08', 'out', 2300000.0, 'operating', 'I KETUT GEDE BU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-08:75', 'paid to I KETUT GEDE BU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-09', 'out', 3000000.0, 'operating', 'TRI ANG BALI', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-09:76', 'paid to TRI ANG BALI (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-10', 'in', 7730000.0, 'other', 'HOU SHIN LIEN ALIAS EMILY HOU/', 'OCBC', 'emily', 'B1', 'import', 'bank:ocbc:2026-04-10:77', 'Emily Hou (B1 owner); her contract is settled, so what is this for?', '{review}'),
  ('tropicana', '2026-04-14', 'in', 169300000.0, 'unit_sale', 'MWB KUPU KUPU COCOON/Payment for Tropicana Valley. 10 000 K USD, 169 300', 'OCBC', 'will', 'A1', 'import', 'bank:ocbc:2026-04-14:78', 'A1 (Will & Marie-Josée), paid via MWB Kupu Kupu Cocoon', '{}'),
  ('tropicana', '2026-04-15', 'out', 4924500.0, 'partner_out', 'OLIVER HERRMANN', 'OCBC', 'oli', null, 'import', 'bank:ocbc:2026-04-15:79', 'to Oli: reimbursement, expense or repayment?', '{review}'),
  ('tropicana', '2026-04-16', 'out', 7036300.0, 'rental_expense', 'ERA SUGIANTI', 'OCBC', 'era', null, 'import', 'bank:ocbc:2026-04-16:80', 'reimbursement to Era for the units expenses', '{}'),
  ('tropicana', '2026-04-16', 'out', 500000000.0, 'partner_out', 'iBank OLIVER HERRMANN/', 'OCBC', 'oli', null, 'import', 'bank:ocbc:2026-04-16:81', 'to Oli: reimbursement, expense or repayment?', '{review}'),
  ('tropicana', '2026-04-18', 'out', 7000000.0, 'operating', 'I NYOMAN MUDASTRA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-18:82', 'paid to I NYOMAN MUDASTRA (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-20', 'out', 1200000.0, 'operating', 'I NYOMAN MUDASTRA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-20:83', 'paid to I NYOMAN MUDASTRA (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-20', 'out', 1600000.0, 'operating', 'I KETUT GEDE BU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-20:84', 'paid to I KETUT GEDE BU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-23', 'out', 1000000.0, 'operating', 'I PUTU EDI SEPTIAWAN', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-23:85', 'paid to I PUTU EDI SEPTIAWAN (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-04-25', 'in', 255429.0, 'bank_interest', 'OCBC account interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-25:86', 'OCBC interest', '{}'),
  ('tropicana', '2026-04-25', 'out', 51086.0, 'bank_charges', 'Tax on interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-25:87', 'tax on interest', '{}'),
  ('tropicana', '2026-04-30', 'out', 900000.0, 'operating', 'HENDRA ANJASMARA', 'OCBC', null, null, 'import', 'bank:ocbc:2026-04-30:88', 'paid to HENDRA ANJASMARA (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-05-02', 'out', 3800000.0, 'operating', 'I GEDE ARWAN AD', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-02:89', 'paid to I GEDE ARWAN AD (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-05-02', 'out', 3475000.0, 'operating', 'IMAM WAHYUDI', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-02:90', 'paid to IMAM WAHYUDI (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-05-02', 'out', 876000.0, 'operating', 'SDRI NI KADEK AYU JU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-02:91', 'paid to SDRI NI KADEK AYU JU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-05-05', 'in', 50000.0, 'bank_interest', 'Berita : REWARD INC NYALA BISNIS JAN26', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-05:92', 'OCBC reward', '{}'),
  ('tropicana', '2026-05-06', 'in', 5000000.0, 'deposit_in', 'REBECCA WANJIRU/REBECCA WANJIRU', 'OCBC', 'rebecca', 'B5', 'import', 'bank:ocbc:2026-05-06:93', 'Rebecca Justus deposit (B5 May to Jun 2026)', '{}'),
  ('tropicana', '2026-05-07', 'out', 11700000.0, 'operating', 'I KETUT GEDE BU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-07:94', 'paid to I KETUT GEDE BU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-05-07', 'out', 1100000.0, 'operating', 'I KETUT GEDE BU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-07:95', 'paid to I KETUT GEDE BU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-05-09', 'in', 27000000.0, 'rental_income', 'Incoming transfer', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-09:96', '27M received 9 May 2026, payee not printed: Rebecca Justus B5 (checked in that day, Hostex 27M)?', '{review}'),
  ('tropicana', '2026-05-10', 'out', 2700000.0, 'agent_commission', 'ENDANG PURIYANTI', 'OCBC', 'endang', null, 'import', 'bank:ocbc:2026-05-10:97', 'Endang Puriyanti: agent commission? (25.39M on 15 Jul is 10% of the B3 lease)', '{review}'),
  ('tropicana', '2026-05-11', 'in', 33900000.0, 'rental_income', 'MEILANI ARIMAU/', 'OCBC', 'nafisa', 'B6', 'import', 'bank:ocbc:2026-05-11:98', 'Nafisa, B6 May to Jul 2026, paid by Meilani Arimau (33.9M + 16.1M = 50M = Hostex)', '{}'),
  ('tropicana', '2026-05-12', 'in', 86175000.0, 'unit_sale', 'MWB KUPU KUPU COCOON/Payment for Tropicana Valley A1, 5000 USD equivalent to 86 175 000 IDR', 'OCBC', 'will', 'A1', 'import', 'bank:ocbc:2026-05-12:99', 'A1 (Will & Marie-Josée), paid via MWB Kupu Kupu Cocoon', '{}'),
  ('tropicana', '2026-05-16', 'in', 3000316.0, 'deposit_in', 'PAGET BERRY/PAGET BERRY', 'OCBC', 'paget', 'B5', 'import', 'bank:ocbc:2026-05-16:100', 'Paget Berry deposit (B5 Aug 2026)', '{}'),
  ('tropicana', '2026-05-16', 'in', 16100000.0, 'rental_income', 'MEILANI ARIMAU/', 'OCBC', 'nafisa', 'B6', 'import', 'bank:ocbc:2026-05-16:101', 'Nafisa, B6 May to Jul 2026, paid by Meilani Arimau (33.9M + 16.1M = 50M = Hostex)', '{}'),
  ('tropicana', '2026-05-19', 'out', 7554164.0, 'rental_expense', 'ERA BALI VILLA', 'OCBC', 'era', null, 'import', 'bank:ocbc:2026-05-19:102', 'reimbursement to Era for the units expenses', '{}'),
  ('tropicana', '2026-05-19', 'out', 1538000.0, 'rental_expense', 'ERA BALI VILLA', 'OCBC', 'era', null, 'import', 'bank:ocbc:2026-05-19:103', 'reimbursement to Era for the units expenses', '{}'),
  ('tropicana', '2026-05-22', 'out', 3000000.0, 'operating', 'I PUTU EDI SEPTIAWAN', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-22:104', 'paid to I PUTU EDI SEPTIAWAN (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-05-25', 'out', 3000000.0, 'construction', 'KANAKA ENGINEERING K', 'OCBC', 'kanaka', null, 'import', 'bank:ocbc:2026-05-25:105', 'Kanaka Engineering: lightning protection?', '{review}'),
  ('tropicana', '2026-05-25', 'out', 1000000.0, 'construction', 'KANAKA ENGINEERING K', 'OCBC', 'kanaka', null, 'import', 'bank:ocbc:2026-05-25:106', 'Kanaka Engineering: lightning protection?', '{review}'),
  ('tropicana', '2026-05-25', 'out', 2300000.0, 'operating', 'I KETUT GEDE BU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-25:107', 'paid to I KETUT GEDE BU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-05-25', 'in', 90836.0, 'bank_interest', 'OCBC account interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-25:108', 'OCBC interest', '{}'),
  ('tropicana', '2026-05-25', 'out', 18167.0, 'bank_charges', 'Tax on interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-25:109', 'tax on interest', '{}'),
  ('tropicana', '2026-05-26', 'out', 7600000.0, 'operating', 'I KETUT GEDE BU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-05-26:110', 'paid to I KETUT GEDE BU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-06-01', 'out', 2000000.0, 'operating', 'I KETUT GEDE BU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-06-01:111', 'paid to I KETUT GEDE BU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-06-04', 'out', 500000.0, 'partner_out', 'OLIVER HERRMANN', 'OCBC', 'oli', null, 'import', 'bank:ocbc:2026-06-04:112', 'to Oli: reimbursement, expense or repayment?', '{review}'),
  ('tropicana', '2026-06-08', 'out', 7400000.0, 'rental_expense', 'ERA BALI VILLA', 'OCBC', 'era', null, 'import', 'bank:ocbc:2026-06-08:113', 'reimbursement to Era for the units expenses', '{}'),
  ('tropicana', '2026-06-08', 'out', 11536400.0, 'rental_expense', 'ERA BALI VILLA', 'OCBC', 'era', null, 'import', 'bank:ocbc:2026-06-08:114', 'reimbursement to Era for the units expenses', '{}'),
  ('tropicana', '2026-06-10', 'out', 4183768.0, 'rental_expense', 'ERA BALI VILLA', 'OCBC', 'era', null, 'import', 'bank:ocbc:2026-06-10:115', 'reimbursement to Era for the units expenses', '{}'),
  ('tropicana', '2026-06-16', 'in', 7730000.0, 'other', 'HOU SHIN LIEN ALIAS EMILY HOU/', 'OCBC', 'emily', 'B1', 'import', 'bank:ocbc:2026-06-16:116', 'Emily Hou (B1 owner); her contract is settled, so what is this for?', '{review}'),
  ('tropicana', '2026-06-16', 'out', 6400000.0, 'operating', 'I KETUT GEDE BU', 'OCBC', null, null, 'import', 'bank:ocbc:2026-06-16:117', 'paid to I KETUT GEDE BU (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-06-20', 'out', 5000000.0, 'partner_out', 'CHARLES IKIEL PTITO', 'OCBC', 'ikiel', null, 'import', 'bank:ocbc:2026-06-20:118', 'to Ikiel', '{review}'),
  ('tropicana', '2026-06-25', 'in', 120918.0, 'bank_interest', 'OCBC account interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-06-25:119', 'OCBC interest', '{}'),
  ('tropicana', '2026-06-25', 'out', 24184.0, 'bank_charges', 'Tax on interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-06-25:120', 'tax on interest', '{}'),
  ('tropicana', '2026-07-01', 'in', 15000000.0, 'rental_income', 'FLIPTECH LENTERA INSPIRASI PERTIWI/FL1209490387', 'OCBC', null, null, 'import', 'bank:ocbc:2026-07-01:121', 'two 15M transfers via Flip (1 and 16 Jul 2026): Anderson B5 (Hostex 10.5M)? deposits?', '{review}'),
  ('tropicana', '2026-07-02', 'in', 5000000.0, 'deposit_in', 'ARMAN MAHNAM/', 'OCBC', 'arman', null, 'import', 'bank:ocbc:2026-07-02:122', 'Arman Mahnam 5M: deposit?', '{review}'),
  ('tropicana', '2026-07-06', 'in', 27000000.0, 'rental_income', 'CHRISTIN SAMOAL/Full pyment David minus komisi', 'OCBC', 'david-noah', 'B2', 'import', 'bank:ocbc:2026-07-06:123', 'David Noah, B2 Jul to Aug 2026, paid by Christin Samoal (30M less 3M commission = Hostex net 27M)', '{}'),
  ('tropicana', '2026-07-08', 'in', 3900000.0, 'rental_income', 'ENDANG PURIYANTI', 'OCBC', 'endang', null, 'import', 'bank:ocbc:2026-07-08:124', 'from Endang Puriyanti (agent): rent passed on?', '{review}'),
  ('tropicana', '2026-07-09', 'out', 13112000.0, 'rental_expense', 'ERA BALI VILLA', 'OCBC', 'era', null, 'import', 'bank:ocbc:2026-07-09:125', 'reimbursement to Era for the units expenses', '{}'),
  ('tropicana', '2026-07-15', 'in', 50000000.0, 'rental_income', 'PT INTERNATIONA', 'OCBC', 'nagar-bani', 'B3', 'import', 'bank:ocbc:2026-07-15:126', 'Nagar Bani, B3 one-year lease Jul 2026 to Jul 2027 (IDR 250M gross, paid in three transfers)', '{}'),
  ('tropicana', '2026-07-15', 'in', 100000000.0, 'rental_income', 'PT INTERNATIONA', 'OCBC', 'nagar-bani', 'B3', 'import', 'bank:ocbc:2026-07-15:127', 'Nagar Bani, B3 one-year lease Jul 2026 to Jul 2027 (IDR 250M gross, paid in three transfers)', '{}'),
  ('tropicana', '2026-07-15', 'in', 100000000.0, 'rental_income', 'PT INTERNATIONA', 'OCBC', 'nagar-bani', 'B3', 'import', 'bank:ocbc:2026-07-15:128', 'Nagar Bani, B3 one-year lease Jul 2026 to Jul 2027 (IDR 250M gross, paid in three transfers)', '{}'),
  ('tropicana', '2026-07-15', 'out', 25390000.0, 'agent_commission', 'ENDANG PURIYANTI', 'OCBC', 'endang', null, 'import', 'bank:ocbc:2026-07-15:129', 'Endang Puriyanti: agent commission? (25.39M on 15 Jul is 10% of the B3 lease)', '{review}'),
  ('tropicana', '2026-07-16', 'in', 15000000.0, 'rental_income', 'FLIPTECH LENTERA INSPIRASI PERTIWI/FL1219474080', 'OCBC', null, null, 'import', 'bank:ocbc:2026-07-16:130', 'two 15M transfers via Flip (1 and 16 Jul 2026): Anderson B5 (Hostex 10.5M)? deposits?', '{review}'),
  ('tropicana', '2026-07-18', 'out', 5000000.0, 'deposit_refund', '- NAFISA ROZIKOVA 2', 'OCBC', 'nafisa', 'B6', 'import', 'bank:ocbc:2026-07-18:131', 'deposit returned to Nafisa (B6, May to Jul 2026)', '{}'),
  ('tropicana', '2026-07-22', 'out', 1000000.0, 'operating', 'I PUTU EDI SEPTIAWAN', 'OCBC', null, null, 'import', 'bank:ocbc:2026-07-22:132', 'paid to I PUTU EDI SEPTIAWAN (no expense sheet for this month): what was it for?', '{review}'),
  ('tropicana', '2026-07-23', 'out', 2028572.0, 'rental_expense', 'ERA BALI VILLA', 'OCBC', 'era', null, 'import', 'bank:ocbc:2026-07-23:133', 'reimbursement to Era for the units expenses', '{}'),
  ('tropicana', '2026-07-25', 'in', 195783.0, 'bank_interest', 'OCBC account interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-07-25:134', 'OCBC interest', '{}'),
  ('tropicana', '2026-07-25', 'out', 39157.0, 'bank_charges', 'Tax on interest', 'OCBC', null, null, 'import', 'bank:ocbc:2026-07-25:135', 'tax on interest', '{}'),
  ('tropicana', '2026-07-31', 'in', 4000000.0, 'capital_in', 'CHARLES IKIEL PT/CHARLES IKIEL PT', 'OCBC', 'ikiel', null, 'import', 'bank:ocbc:2026-07-31:136', null, '{}')
on conflict (source_ref) do nothing;

-- The bank balance at the end of the last statement: the dashboard rolls it
-- forward with every ledger row dated after it.
update project_accounts set balance = 466489108.49, balance_as_of = '2026-07-31', note = 'PT Double 8 company account (OCBC 167800012541). Balance from the July 2026 statement.'
  where project_key = 'tropicana' and name = 'OCBC' and balance is null;
