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

-- ── CAMPAIGNS COLUMN (added incrementally) ──────────────────────────

alter table campaigns add column if not exists template_sequence jsonb default '[]';

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
