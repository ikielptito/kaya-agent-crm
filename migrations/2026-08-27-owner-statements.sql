-- ═══════════════════════════════════════════════════════════════════════
-- OWNER STATEMENTS migration — 27 Aug 2026
-- Paste this whole file into the Supabase SQL editor and run it BEFORE
-- deploying the owner-statements code. Idempotent: safe to re-run.
--
-- What it does:
--   1. statement_groups: registry mapping Era's per-property report
--      spreadsheet ↔ portal listing slugs ↔ the owner numbers to notify.
--   2. statements: one row per (property group, month) — the reviewed,
--      publishable payout statement with lifecycle draft→published→paid.
--   3. statement_lines: the parsed booking/expense line items.
--   4. payout-proofs: a PRIVATE storage bucket for payment screenshots
--      (unlike villa photo folders, these must never be public).
--   5. Seeds the owner_statements campaign row (mirrors CAMPAIGN_REGISTRY
--      in lib/campaigns.js — keep them in sync).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) Property-group registry ──────────────────────────────────────────
-- One row per report spreadsheet in Era's "2026 Monthly Report" Drive folder.
-- A group may span several portal units (Units 2 & 4 share one sheet and one
-- payout). owner_wa_nums is who Maya notifies on publish — filled by Ikiel in
-- the admin Payouts tab (#/groups); empty means "nobody yet".
create table if not exists statement_groups (
  key            text primary key,             -- 'haus-2-4', 'villa-saturno', …
  name           text not null,                -- owner-facing: 'HAUS Canggu – Units 2 & 4'
  sheet_file_id  text not null,                -- Era's Google Sheets file id
  listing_slugs  text[] not null default '{}', -- portal catalog slugs (Hostex enrichment)
  owner_wa_nums  text[] not null default '{}', -- digits-only WhatsApp numbers to notify
  owner_names    text,                         -- 'Romina & Tim' (display + template param)
  notify         boolean not null default true,  -- false: never WhatsApp (Ikiel's own units)
  active         boolean not null default true,  -- false: stop syncing this sheet
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- Seed the eight managed properties (Villa Ajeg deliberately absent — no
-- longer managed, per Ikiel 27 Aug 2026). Sheet ids from Era's Drive folder
-- 1J-ZtGJZZ0d1FylUSOddZe9KOhAAVX4zB; slugs from the portal's lib/catalog.js.
insert into statement_groups (key, name, sheet_file_id, listing_slugs, owner_names, notify) values
  ('haus-1',        'HAUS Canggu – Unit 1',         '1YoARSUW2wIQLrmtMS6dkH5MGo4ObKBkFz8VlgnUhFUg', '{haus-1}',                'Tanique',        true),
  ('haus-2-4',      'HAUS Canggu – Units 2 & 4',    '1ExHdNyud637JbBPdslaRHp7BfDG0_yPTPFpop-q6_h0', '{haus-2,haus-4}',         'Romina & Tim',   true),
  ('haus-5',        'HAUS Canggu – Unit 5',         '1G3DGMTbyrJfGftSW2y0bUEC77XVzH1EaaUH6RbFP60c', '{haus-5}',                'Rushika',        true),
  ('lanehaus',      'LaneHAUS – Units 1 & 3',       '1JLv-wRpcGnQcObRReAhp-25_rPcV8i8XPgUWCGs9W1o', '{lanehaus-1,lanehaus-3}', 'Ikiel & Guy',    false),
  ('villa-saturno', 'Villa Saturno',                '14wDFkQCKgib0-PWTM3Mx9YEBIuozn-ZfWyLSxVXLDQc', '{villa-saturno}',         'Pedro',          true),
  ('tropicana-a4',  'Tropicana Valley – Unit A4',   '1Kc2wXKssyEo64quT-q1hICTEltct5KHO29fLjzzeJ7M', '{tropicana-a4}',          'Andrea',         true),
  ('tropicana-a5',  'Tropicana Valley – Unit A5',   '1nosdRA2-GUyBL13nBifW2NuLUW66NhJlbL25FXnHFdE', '{tropicana-a5}',          'Cielo',          true),
  ('tropicana-b4',  'Tropicana Valley – Unit B4',   '1U15mHa29d8ZKZkehIPYDNV2hJT3simtoh8nZXlCFsbQ', '{tropicana-b4}',          'Katie',          true)
on conflict (key) do nothing;

-- ── 2) Statements: one per (group, month) ───────────────────────────────
-- Lifecycle: draft (parsed from Era's sheet, editable) → published (frozen,
-- visible to the owner, queued for Maya's notification) → paid (proof
-- attached). 'void' hides a statement that should never have existed.
-- Published statements are IMMUTABLE snapshots: if Era later edits that
-- month's tab, the sync writes `discrepancy` and alerts — never the lines.
create table if not exists statements (
  id               bigserial primary key,
  group_key        text not null references statement_groups(key),
  period           text not null,             -- 'YYYY-MM'
  status           text not null default 'draft',  -- draft|published|paid|void
  currency         text not null default 'IDR',
  -- Totals recomputed from statement_lines on every parse/edit:
  gross_total      numeric not null default 0,   -- Σ booking amount
  commission_total numeric not null default 0,   -- Σ booking commission
  nett_total       numeric not null default 0,   -- Σ booking nett-to-owner
  expenses_total   numeric not null default 0,   -- Σ expense amount
  adjustments_total numeric not null default 0,  -- Σ adjustment amount (signed)
  payout_total     numeric not null default 0,   -- nett − expenses + adjustments
  era_payout_total numeric,                   -- the sheet's own TOTAL PAYOUT figure
  reconciliation   jsonb,                     -- {checks:[{name,ok,expected,actual}], unparsed_rows:[…]}
  needs_review     boolean not null default false,
  source_hash      text,                      -- sha256 of the tab's raw values
  source_tab       text,                      -- tab title the parse came from
  parsed_at        timestamptz,
  has_manual_edits boolean not null default false, -- Ikiel touched lines → sync won't clobber
  source_changed   boolean not null default false, -- Era edited after manual edits / publish
  discrepancy      jsonb,                     -- post-publish source change: {detected_at, note}
  hostex_snapshot  jsonb,                     -- occupancy/nights/channels frozen at publish
  published_at     timestamptz,
  published_by     text,
  notified_at      timestamptz,               -- Maya sweep dedupe: per statement, stamped once
  paid_at          timestamptz,
  proof_path       text,                      -- storage path in the payout-proofs bucket
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  unique (group_key, period)
);
create index if not exists idx_statements_status on statements (status, period desc);

-- ── 3) Line items ───────────────────────────────────────────────────────
-- Bookings, expenses, and manual adjustments in one table, discriminated by
-- `kind`. Expenses use `amount`; adjustments use signed `amount` (positive
-- increases the payout). `edited` marks lines Ikiel changed by hand.
create table if not exists statement_lines (
  id            bigserial primary key,
  statement_id  bigint not null references statements(id) on delete cascade,
  kind          text not null,                -- 'booking' | 'expense' | 'adjustment'
  unit_name     text,                         -- booking-block heading ('Unit 2 Haus Canggu')
  position      int not null default 0,
  guest_name    text,
  stay_dates    text,                         -- Era's free-text range ('1-18 July')
  platform      text,                         -- 'Airbnb', 'Direct Booking', …
  nights        numeric,
  amount        numeric,                      -- booking gross / expense amount / signed adjustment
  commission    numeric,
  nett          numeric,                      -- booking nett-to-owner
  expense_date  text,                         -- Era's free-text date ('01 Jul 2026')
  description   text,
  flags         text[] not null default '{}', -- 'zero_amount','missing_date','llm_classified','commission_mismatch',…
  edited        boolean not null default false,
  source_row    int,                          -- 0-based row index in the sheet tab
  created_at    timestamptz default now()
);
create index if not exists idx_statement_lines_stmt on statement_lines (statement_id, position);

-- ── 4) Private proof bucket ─────────────────────────────────────────────
-- public=false: objects are served ONLY via short-lived signed URLs minted
-- with the service key. Never flip this bucket public.
insert into storage.buckets (id, name, public)
values ('payout-proofs', 'payout-proofs', false)
on conflict (id) do nothing;

-- ── 5) Campaign row for the notify sweep ────────────────────────────────
-- MUST stay in sync with CAMPAIGN_REGISTRY in lib/campaigns.js. Paused until
-- Ikiel arms it in the Command Center (sets owner_statements.notify_daily_cap).
insert into campaigns (name, kind, key, pipeline, mode, status, goal, categories, context, schedule)
select 'Owner statements', 'always_on', 'owner_statements', 'samba', 'broadcast', 'paused', 'click',
       array['owner_statement'],
       'Monthly payout statement notification when Ikiel publishes',
       '{"cron":"daily 09:00 WITA (wave 0), event-driven on publish","cap_setting":"owner_statements.notify_daily_cap","env_gate":"OWNERS_ENABLED=1"}'::jsonb
where not exists (select 1 from campaigns c where c.key = 'owner_statements');
