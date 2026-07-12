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
  source        text,             -- 'api' | 'webhook' | 'cron'
  campaign_id   uuid
);
create index if not exists idx_wa_messages_agent_time on wa_messages (agent_id, timestamp desc);
create index if not exists idx_wa_messages_wa_num on wa_messages (wa_num);

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
