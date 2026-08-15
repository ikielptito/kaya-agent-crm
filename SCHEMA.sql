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
