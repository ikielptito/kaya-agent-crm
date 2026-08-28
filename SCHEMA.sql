-- Run this ENTIRE file in Supabase SQL Editor.
-- Safe to run multiple times — every statement is idempotent (IF NOT EXISTS).
-- Last updated: 2026-05-25

-- ── CORE TABLES ─────────────────────────────────────────────────────

create table if not exists wa_messages (
  id            uuid primary key default gen_random_uuid(),
  agent_id      bigint references agents(id),
  wa_num        text,
  direction     text,             -- 'inbound' | 'outbound'
  content       text,
  wa_message_id text,
  timestamp     timestamptz default now(),
  source        text,             -- 'api' | 'webhook' | 'cron' | 'relay'
  campaign_id   uuid
);
create index if not exists idx_wa_messages_agent_time on wa_messages (agent_id, timestamp desc);
create index if not exists idx_wa_messages_wa_num on wa_messages (wa_num);
-- Backstop for the webhook's redelivery guard: Meta delivers at-least-once,
-- and a redelivered wamid must never become a second row (applied 2 Aug 2026).
create unique index if not exists wa_messages_wamid_uniq on wa_messages (wa_message_id) where wa_message_id is not null;
-- Meta failure reason ("131026 — Message undeliverable", etc.), captured from
-- the status webhook so failed broadcasts are diagnosable (applied 2 Aug 2026).
alter table wa_messages add column if not exists error text;
-- Chronic-delivery-failure flag: set by the 131026 auto-marker (agent has zero
-- lifetime deliveries) or manual cleanup; excluded from every broadcast loop;
-- cleared automatically when the number ever messages in (applied 2 Aug 2026).
alter table agents add column if not exists dead_number boolean default false;

create table if not exists settings (
  key   text primary key,
  value jsonb
);
insert into settings (key, value) values ('automation', '{"mode":"draft"}')
on conflict (key) do nothing;

create table if not exists maya_updates (
  id          uuid primary key default gen_random_uuid(),
  agent_id    bigint references agents(id),
  field       text,
  new_value   text,
  reason      text,
  evidence    text,
  by_maya     boolean default true,
  created_at  timestamptz default now()
);
create index if not exists idx_maya_updates_agent on maya_updates (agent_id, created_at desc);

create table if not exists projects (
  id             bigserial primary key,
  slug           text unique not null,
  display_order  int default 99,
  active         boolean default true,
  brand          text,
  name           text not null,
  tagline        text,
  status         text,
  area           text,
  full_location  text,
  distances      text,
  property_type  text,
  tenure         text,
  tenure_details text,
  furnished      text,
  construction_status text,
  delivery_date  text,
  commission_pct numeric,
  payment_plan   text,
  description    text,
  features       text,
  roi_projections text,
  rental_performance text,
  maya_notes     text,
  brochure_url   text,
  brochure_filename text,
  units          jsonb default '[]',
  extended_info  text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- ── AGENT COLUMNS (added incrementally) ─────────────────────────────

alter table agents add column if not exists automation_override text;
alter table agents add column if not exists suggested_reply text;
alter table agents add column if not exists unread_count int default 0;
alter table agents add column if not exists last_inbound_at timestamptz;
alter table agents add column if not exists is_test boolean default false;
alter table agents add column if not exists campaign_engagement jsonb;

-- ── PROJECTS COLUMN (added incrementally — runs even if table existed) ─

alter table projects add column if not exists extended_info text;

-- ── RENTALS COLUMNS (added incrementally — runs even if table existed) ─

alter table rentals add column if not exists monthly_rate_idr numeric;
alter table rentals add column if not exists yearly_rate_idr numeric;
alter table rentals add column if not exists photos_url text;       -- Google Drive folder for listing photos
alter table rentals add column if not exists maps_url text;         -- Google Maps location link

-- ── WA_MESSAGES COLUMNS (added incrementally) ───────────────────────

alter table wa_messages add column if not exists edited_at  timestamptz;  -- set when message text was edited
alter table wa_messages add column if not exists deleted_at timestamptz;  -- set when message was recalled

-- ── CAMPAIGNS COLUMN (added incrementally) ──────────────────────────

alter table campaigns add column if not exists template_sequence jsonb default '[]';

-- ── SAMBA AVAILABILITY NOTIFICATIONS (added 2026-06-11) ─────────────
-- These power the daily availability digest pushed to rental agents by
-- the cron-followups runner. Stored on the existing agents row so the
-- runner doesn't need an extra table lookup per agent.

alter table agents add column if not exists samba_alerts_opt_out boolean default false;
alter table agents add column if not exists last_availability_alert_at timestamptz;

-- Distinguishes availability sends from listing-lifecycle follow-ups in the
-- wa_messages timeline (and in any future reporting).
alter table wa_messages add column if not exists category text;
  -- null (legacy) | 'availability_alert' | 'availability_digest' | 'followup' | 'sequence'

-- ── INBOUND MEDIA + REACTIONS (added 2026-06-14) ────────────────────
-- Before these columns, an inbound image/document/voice was logged as an
-- empty content row (the webhook only read text bodies). The inbox now
-- renders inline previews using media_type + media_id (the WhatsApp media
-- id, proxied through /api/whatsapp-send?fetch_media=ID).
alter table wa_messages add column if not exists media_type text;
  -- 'image' | 'document' | 'audio' | 'video' | 'sticker' | 'location' | null
alter table wa_messages add column if not exists media_id text;
  -- the WhatsApp media id, used to fetch the file via the proxy endpoint
alter table wa_messages add column if not exists reaction text;
  -- WhatsApp reactions arrive as separate webhook events targeting a prior
  -- message; we PATCH the original row's reaction column rather than
  -- create a noisy 'reacted 👍' line in the timeline.

-- ── DELIVERY STATUS + REPLY CONTEXT (added 2026-06-17) ──────────────
alter table wa_messages add column if not exists status text;
alter table wa_messages add column if not exists template_name text;  -- which template a send used (per-format read-rate analytics)
  -- outbound only: 'sent' | 'delivered' | 'read' | 'failed', advanced by the
  -- webhook's statuses handler. Drives ✓ / ✓✓ / blue ticks in the chat inbox.
alter table wa_messages add column if not exists reply_to text;
  -- wa_message_id of the message this one quotes (reply context), either
  -- direction. The inbox renders a quoted preview above the bubble.
alter table wa_messages add column if not exists model text;
  -- which Claude model generated an outbound Maya reply ('claude-haiku-4-5' |
  -- 'claude-sonnet-4-6'). Null for inbound, template, and manual sends. Feeds
  -- the weekly self-review's Haiku/Sonnet routing audit.

alter table agents add column if not exists engagement_tier text;
  -- hot | warm | cold — set by Maya via crm_updates based on conversation signals

alter table agents add column if not exists contact_frequency text;
  -- null/'normal' = full cadence | 'weekly' = Monday digest only |
  -- 'monthly' = one digest per month | 'paused' = no broadcasts.
  -- Set by Maya when an agent asks for fewer messages without unsubscribing;
  -- respected by cron-followups' availability send loop. (Added 2026-07-06)

-- ── PORTAL SYNC BADGE (added 2026-07-10) ────────────────────────────
-- Manual marketing badge set in the portal admin console ("Price drop",
-- "New", …). Synced from sambarentals.com via the listing-sync webhook;
-- shown on portal cards and used by Maya's outbound messages.
alter table rentals add column if not exists badge text;

-- ── RENTALS TABLE (Samba Realty portfolio — separate from KAYA sales) ─

create table if not exists rentals (
  id                bigserial primary key,
  slug              text unique not null,
  display_order     int default 99,
  active            boolean default true,
  name              text not null,                 -- e.g. "Tropicana Valley A5"
  area              text,                           -- e.g. "Buduk", "Berawa", "Canggu"
  full_location     text,
  property_type     text,                           -- Villa | Townhouse | Apartment | Studio | House
  beds              int,
  baths             numeric,
  max_guests        int,
  sqm               numeric,
  amenities         text,                           -- comma-sep: Pool, Wifi, Workspace, Kitchen, Parking
  features          text,                           -- free-form
  nightly_rate_usd  numeric,
  nightly_rate_idr  numeric,
  min_stay_nights   int default 1,
  occupancy_pct     int,                            -- recent occupancy rate
  monthly_revenue_idr numeric,                      -- typical revenue (actuals if known)
  monthly_rate_idr  numeric,                        -- asking monthly rent
  yearly_rate_idr   numeric,                        -- asking yearly rent
  airbnb_url        text,
  booking_url       text,
  portal_url        text,                           -- sambarentals.vercel.app/...
  hero_image_url    text,
  commission_pct    numeric default 10,
  maya_notes        text,
  extended_info     text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- ── OWNERS ──────────────────────────────────────────────────────────
-- Villa owners / managers Maya talks to (distinct from agents — they list
-- properties and receive weekly reports; they are NOT part of the agent
-- funnel, broadcasts, or self-review). Keyed by the WhatsApp number that
-- appears as the listing's booking contact. Populated by the portal owner-sync
-- (lib/rental-sync.js → syncOwners), which is the source of truth for identity
-- and listing links. One owner/number can be the contact for several listings.
create table if not exists owners (
  id             bigserial primary key,
  wa_num         text unique not null,        -- digits only, e.g. 6281246357778
  name           text,                        -- contact name from the listing
  email          text,                        -- portal Google email, if signed in
  portal_sub     text,                        -- portal owner:{sub}, if signed in
  listing_slugs  text[] default '{}',         -- portal slugs this number is contact for
  opt_in         boolean default false,       -- consented to WhatsApp reports
  report_enabled boolean default true,        -- master switch per owner
  active         boolean default true,
  notes          text,
  last_synced_at timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create index if not exists idx_owners_wa_num on owners (wa_num);
-- Conversation state for owner-mode (mirrors the agent columns): Maya's pending
-- draft, unread badge, last-inbound sort key, and a manual takeover switch.
alter table owners add column if not exists suggested_reply text;
alter table owners add column if not exists unread_count int default 0;
alter table owners add column if not exists last_inbound_at timestamptz;
alter table owners add column if not exists paused boolean default false;
-- Last weekly-report send (dedupe so the Monday cron sends at most once/week).
alter table owners add column if not exists last_report_sent_at timestamptz;

-- Tag inbound/outbound messages that belong to an owner conversation so the
-- (future) owner inbox can thread them. Nullable and additive — existing agent
-- threads are untouched, and messages keep their agent_id as today.
alter table wa_messages add column if not exists owner_id bigint references owners(id);
create index if not exists idx_wa_messages_owner on wa_messages (owner_id, timestamp desc);

-- ── OWNER ONBOARDING FUNNEL (added 2026-07-29) ──────────────────────
-- Prospective owners Ikiel has spoken to who verbally agreed to list but
-- haven't yet. Entered manually in the owner inbox; Maya works the lead in
-- onboarding mode (pitch → answer questions → list the villa in chat).
-- onboarding_status: null = regular synced owner (not in the funnel) |
--   'agreed'          — entered as a prospect, no outreach sent yet
--   'contacted'       — intro template sent, no reply yet
--   'in_conversation' — they replied, Maya is onboarding them
--   'listed'          — at least one listing created (funnel complete)
--   'declined'        — asked to stop / not interested (never re-contact)
alter table owners add column if not exists onboarding_status text;
alter table owners add column if not exists consent_note text;
  -- where/when they verbally agreed (paper trail for the outreach)
alter table owners add column if not exists promo_code text;
  -- launch promo Maya quotes them (e.g. PRELAUNCH90)
alter table owners add column if not exists lang text;
  -- 'en' | 'id' — which onboarding template variant to send
alter table owners add column if not exists drive_folder_id text;
  -- Google Drive folder auto-created for photos they send in chat
alter table owners add column if not exists last_onboarding_nudge_at timestamptz;
alter table owners add column if not exists onboarding_nudges int default 0;

-- ── QUESTION RELAYS ─────────────────────────────────────────────────
-- Maya brokering an agent's question to the person who actually knows the
-- answer (the listing's "enquire with" contact — Era for directly-managed
-- villas, the owner/manager otherwise) and carrying the answer back. Both
-- legs have to survive WhatsApp's 24h session window, so the status column
-- tracks where in the round trip each question is:
--   'queued'    — contact's window was shut; the maya_owner_question template
--                 went out and the question itself is waiting for them to reply
--   'asked'     — the question has been delivered; waiting on an answer
--   'answered'  — we have the answer; waiting to hand it to the agent (their
--                 window may be shut, in which case maya_answer_ready went out)
--   'delivered' — the agent has the answer; round trip complete
--   'expired'   — nobody answered inside RELAY_TTL_HOURS; the agent was told
--   'cancelled' — superseded or manually closed
-- The agent's client is NEVER part of a relay: questions are about the
-- property, and the contact is told "an agent asked", never who.
create table if not exists relays (
  id            bigserial primary key,
  agent_id      bigint references agents(id),
  agent_wa      text not null,
  agent_name    text,
  rental_slug   text,
  property_name text,
  question      text not null,
  contact_name  text,
  contact_wa    text not null,
  owner_id      bigint references owners(id),
  status        text not null default 'asked',
  answer        text,
  -- A durable fact worth keeping in the KB ("Unit 1 has a bathtub in the
  -- master ensuite"), staged for Ikiel's approval rather than written live:
  -- an owner's offhand reply should not become something Maya quotes to
  -- every agent until a human has seen it. kb_status: pending|approved|rejected.
  kb_fact       text,
  kb_status     text,
  asked_at      timestamptz default now(),
  answered_at   timestamptz,
  delivered_at  timestamptz,
  nudges        int default 0,
  last_nudge_at timestamptz,
  -- Two separate re-openers, one per leg: the contact's window and the
  -- agent's shut independently, so they must never share a timestamp.
  template_sent_at timestamptz,      -- maya_owner_question → the villa contact
  answer_template_at timestamptz,    -- maya_answer_ready   → the agent
  created_at    timestamptz default now()
);
create index if not exists idx_relays_contact on relays (contact_wa, status);
create index if not exists idx_relays_agent on relays (agent_wa, status);
create index if not exists idx_relays_kb on relays (kb_status) where kb_status is not null;

-- ── VIEWINGS ─────────────────────────────────────────────────────────
-- Structured viewing appointments (lib/viewings.js). The ask to the villa
-- contact rides the relays table (relay_id); this row carries the state
-- machine: requested → confirmed → completed | no_show, or declined /
-- expired / cancelled. Never any client PII — the agent's client is theirs.
create table if not exists viewings (
  id                bigserial primary key,
  agent_id          bigint,
  agent_wa          text,
  agent_name        text,
  rental_slug       text,
  property_name     text,
  contact_wa        text,
  contact_name      text,
  requested_window  text,          -- the agent's asked day/time, free text
  scheduled_at      timestamptz,   -- set when the contact confirms a slot
  status            text default 'requested',
  relay_id          bigint,        -- the relay carrying the ask to the contact
  outcome_note      text,
  reminded_at       timestamptz,   -- morning-of reminder sent
  outcome_asked_at  timestamptz,   -- day-after "how did it go?" sent
  confirmed_at      timestamptz,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create index if not exists viewings_status_idx on viewings (status);
create index if not exists viewings_agent_idx  on viewings (agent_id);

-- ── OWNER STATEMENTS (added 2026-08-27) ─────────────────────────────
-- Monthly payout statements for Samba Realty-MANAGED villas, parsed from
-- Era's per-property report spreadsheets in Google Drive. Full DDL + seed
-- data + the private payout-proofs storage bucket live in
-- migrations/2026-08-27-owner-statements.sql; the create-tables are
-- repeated here so this file stays the one-stop cumulative schema.
create table if not exists statement_groups (
  key            text primary key,
  name           text not null,
  sheet_file_id  text not null,
  listing_slugs  text[] not null default '{}',
  owner_wa_nums  text[] not null default '{}',
  owner_names    text,
  notify         boolean not null default true,
  active         boolean not null default true,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create table if not exists statements (
  id               bigserial primary key,
  group_key        text not null references statement_groups(key),
  period           text not null,
  status           text not null default 'draft',
  currency         text not null default 'IDR',
  gross_total      numeric not null default 0,
  commission_total numeric not null default 0,
  nett_total       numeric not null default 0,
  expenses_total   numeric not null default 0,
  adjustments_total numeric not null default 0,
  payout_total     numeric not null default 0,
  era_payout_total numeric,
  reconciliation   jsonb,
  needs_review     boolean not null default false,
  source_hash      text,
  source_tab       text,
  parsed_at        timestamptz,
  has_manual_edits boolean not null default false,
  source_changed   boolean not null default false,
  discrepancy      jsonb,
  hostex_snapshot  jsonb,
  published_at     timestamptz,
  published_by     text,
  notified_at      timestamptz,
  paid_at          timestamptz,
  proof_path       text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  unique (group_key, period)
);
create index if not exists idx_statements_status on statements (status, period desc);
create table if not exists statement_lines (
  id            bigserial primary key,
  statement_id  bigint not null references statements(id) on delete cascade,
  kind          text not null,
  unit_name     text,
  position      int not null default 0,
  guest_name    text,
  stay_dates    text,
  platform      text,
  nights        numeric,
  amount        numeric,
  commission    numeric,
  nett          numeric,
  expense_date  text,
  description   text,
  flags         text[] not null default '{}',
  edited        boolean not null default false,
  source_row    int,
  created_at    timestamptz default now()
);
create index if not exists idx_statement_lines_stmt on statement_lines (statement_id, position);
-- Partial payments (added 2026-08-27, migrations/2026-08-27-statement-payments.sql):
-- a payout can be settled in several transfers; balance = payout_total − Σ payments.
-- statements.status vocabulary: draft | published | partial | paid | void.
create table if not exists statement_payments (
  id            bigserial primary key,
  statement_id  bigint not null references statements(id) on delete cascade,
  amount        numeric not null,
  paid_at       timestamptz not null default now(),
  note          text,
  proof_path    text,
  created_at    timestamptz default now()
);
create index if not exists idx_statement_payments_stmt on statement_payments (statement_id, paid_at);
alter table statements add column if not exists paid_total numeric not null default 0;
alter table statement_groups add column if not exists payout_account jsonb;
-- Returned transfers + own-property flag (added 2026-08-28,
-- migrations/2026-08-28-returned-payments-commission.sql): a bounced bank
-- transfer stays in the ledger as status='returned' (audit trail) but stops
-- counting toward paid_total; charges_commission=false marks own units
-- (LaneHAUS) whose commission column is not management income.
alter table statement_payments add column if not exists status text not null default 'cleared';
alter table statement_payments add column if not exists returned_at timestamptz;
alter table statement_payments add column if not exists return_note text;
alter table statement_groups add column if not exists charges_commission boolean not null default true;
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
-- Maintenance items for Samba Realty-managed villas.
-- RUN IN THE SUPABASE SQL EDITOR BEFORE DEPLOYING.
--
-- Flow: Era or a cleaner sends Maya a photo + description on WhatsApp →
-- Maya files an item (status 'new') → Era reviews it in /payouts, adds a
-- cost estimate and decides whether the owner must approve → publish →
-- Maya notifies the owner → owner approves (or it's notify-only) → Era
-- does the work → marks it done → Maya tells the owner. While an approved
-- item sits undone, Maya nudges Era on next_followup_at; if Era replies
-- "next Tuesday", that date becomes the next nudge.

create table if not exists maintenance_items (
  id                bigint generated by default as identity primary key,
  group_key         text not null references statement_groups(key) on delete cascade,
  slug              text,                 -- specific unit, null = whole property
  unit_label        text,                 -- human label as reported ("Unit 1")
  title             text not null,
  description       text,
  photos            jsonb not null default '[]'::jsonb,   -- storage paths
  -- new → pending_approval | scheduled → approved | declined → done
  -- 'scheduled' = notify-only (routine, no approval needed)
  status            text not null default 'new',
  requires_approval boolean not null default true,
  estimated_cost    numeric,
  actual_cost       numeric,
  currency          text not null default 'IDR',
  urgency           text default 'normal',                -- low | normal | urgent
  reported_by_wa    text,
  reported_by_name  text,
  reported_at       timestamptz not null default now(),
  published_at      timestamptz,
  published_by      text,
  notified_at       timestamptz,          -- owner told (null = queued for Maya)
  approved_at       timestamptz,
  approved_by       text,
  declined_at       timestamptz,
  decline_note      text,
  staff_notified_at timestamptz,          -- Era told the owner approved
  completed_at      timestamptz,
  completed_by      text,
  completion_note   text,
  done_notified_at  timestamptz,          -- owner told it's finished
  -- Follow-up loop with Era
  next_followup_at  timestamptz,
  followup_count    integer not null default 0,
  promised_date     date,                 -- "it'll be ready next Tuesday"
  thread            jsonb not null default '[]'::jsonb,   -- {at, who, text} log
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists maintenance_group_idx  on maintenance_items(group_key, status);
create index if not exists maintenance_status_idx on maintenance_items(status);
create index if not exists maintenance_followup_idx on maintenance_items(next_followup_at)
  where next_followup_at is not null;

-- Private bucket for the photos Era and the cleaners send in.
insert into storage.buckets (id, name, public)
values ('maintenance-photos', 'maintenance-photos', false)
on conflict (id) do nothing;

-- Staff who may file maintenance items by messaging Maya (Era, cleaners).
-- Matching is on the digits of the WhatsApp number.
create table if not exists maintenance_reporters (
  wa_num     text primary key,
  name       text,
  role       text default 'staff',        -- staff | manager
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Campaign row so the sweep appears in the Campaign Command Center with a
-- daily cap and a pause switch. MUST stay in sync with CAMPAIGN_REGISTRY in
-- lib/campaigns.js. Paused until Ikiel arms it in the Command Center.
insert into campaigns (name, kind, key, pipeline, mode, status, goal, categories, context, schedule)
select 'Maintenance', 'always_on', 'maintenance', 'samba', 'broadcast', 'paused', 'click',
       array['maintenance'],
       'Owner approval requests, completion notices, and follow-up nudges to Era',
       '{"cron":"daily 09:00 WITA (wave 0), event-driven on publish/approve/complete","cap_setting":"maintenance.notify_daily_cap","env_gate":"OWNERS_ENABLED=1"}'::jsonb
where not exists (select 1 from campaigns c where c.key = 'maintenance');
