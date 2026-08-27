-- ═══════════════════════════════════════════════════════════════════════
-- CAMPAIGN COMMAND CENTER migration — 27 Aug 2026
-- Paste this whole file into the Supabase SQL editor and run it.
-- Idempotent: running it twice is a no-op (safe to re-run after edits).
--
-- What it does:
--   1. campaigns gains a real lifecycle + registry identity + durable
--      funnel counters that survive the 90-day wa_messages prune.
--   2. campaign_events: an audit/timeline table (launched, paused, …).
--   3. campaign_bump(): the ONE way counters change — an atomic UPDATE,
--      so concurrent webhook status events can't lose increments.
--   4. Backfills: repairs campaigns stranded at 'sending', registers the
--      automated sweeps as always-on campaign rows, links surviving
--      wa_messages to them, repairs the category-less sequence sends,
--      and seeds counters from what's still in wa_messages.
--
-- `agents` and `campaigns` predate SCHEMA.sql (no create-table exists),
-- so everything here is ALTER/INSERT/UPDATE against live tables.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) campaigns: lifecycle + registry + durable counters ───────────────
alter table campaigns
  add column if not exists key               text,          -- stable id for always-on rows ('availability_alert', …)
  add column if not exists kind              text not null default 'one_off',  -- 'one_off' | 'always_on' | 'sequence'
  add column if not exists goal              text,          -- 'reply' | 'signup' | 'click' | 'enquiry'
  add column if not exists categories        text[],        -- wa_messages.category values this campaign claims
  add column if not exists schedule          jsonb,         -- display metadata: {cron, gate, cap_setting}
  add column if not exists scheduled_at      timestamptz,   -- one-off: scheduled launch time
  add column if not exists caps              jsonb,         -- snapshot at launch: {daily_cap, quiet_hours, …}
  add column if not exists delivered_count   int  not null default 0,
  add column if not exists read_count        int  not null default 0,
  add column if not exists reply_count       int  not null default 0,
  add column if not exists conversion_count  int  not null default 0,
  add column if not exists last_run_at       timestamptz,   -- always-on: last cron pass that ran this campaign
  add column if not exists last_run_summary  jsonb,         -- e.g. {sent:4, skipped:12, reasons:{…}}
  add column if not exists status_changed_at timestamptz,
  add column if not exists archived_at       timestamptz;

-- Status vocabulary (enforced in the API layer, NOT as a DB constraint, so
-- the legacy console's 'sending'/'complete' writes keep working unchanged):
--   draft | scheduled | sending | live | paused | complete | cancelled | failed

create unique index if not exists campaigns_key_uniq
  on campaigns (key) where key is not null;
create index if not exists wa_messages_campaign_id_idx
  on wa_messages (campaign_id) where campaign_id is not null;
create index if not exists wa_messages_category_ts_idx
  on wa_messages (category, timestamp) where category is not null;

-- ── 2) campaign_events: audit / timeline ────────────────────────────────
create table if not exists campaign_events (
  id          bigint generated always as identity primary key,
  campaign_id uuid references campaigns(id) on delete cascade,
  type        text not null,   -- created|launched|paused|resumed|armed|cap_changed|cancelled
                               -- |completed|failed|auto_repaired|kill_switch|archived|conversion
  actor       text not null default 'system',  -- 'admin' | 'console' | 'cron' | 'system'
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists campaign_events_campaign_idx
  on campaign_events (campaign_id, created_at desc);

-- ── 3) Atomic counter bump ──────────────────────────────────────────────
-- The ONLY way counters change. Single UPDATE = no read-modify-write races
-- between the webhook (delivered/read/failed), the crons (sent/skipped),
-- and the broadcast engine.
create or replace function campaign_bump(
  p_id uuid, p_sent int default 0, p_delivered int default 0, p_read int default 0,
  p_replied int default 0, p_failed int default 0, p_skipped int default 0,
  p_converted int default 0
) returns void language sql security definer as $$
  update campaigns set
    sent_count       = coalesce(sent_count,0)  + p_sent,
    delivered_count  = delivered_count          + p_delivered,
    read_count       = read_count               + p_read,
    reply_count      = reply_count              + p_replied,
    fail_count       = coalesce(fail_count,0)   + p_failed,
    skip_count       = coalesce(skip_count,0)   + p_skipped,
    conversion_count = conversion_count         + p_converted,
    updated_at       = now()
  where id = p_id;
$$;

-- ── 4) Backfill (a): repair rows stranded at 'sending' ──────────────────
-- The console builder ran sends from the browser; a closed tab stranded the
-- row at 'sending' forever. Anything 'sending' for >6h is over.
with repaired as (
  update campaigns
     set status = case when coalesce(sent_count,0) > 0 then 'complete' else 'failed' end,
         status_changed_at = now(), updated_at = now()
   where status = 'sending' and updated_at < now() - interval '6 hours'
   returning id, sent_count
)
insert into campaign_events (campaign_id, type, actor, detail)
select id, 'auto_repaired', 'system',
       jsonb_build_object('reason','stranded_sending','sent_count',coalesce(sent_count,0))
from repaired;

-- ── 5) Backfill (b): register the automated sweeps as always-on rows ────
-- status 'live'   = runs today whenever samba_availability.enabled is true
-- status 'paused' = built but dormant (its daily cap is unset)
-- These MUST stay in sync with CAMPAIGN_REGISTRY in lib/campaigns.js.
insert into campaigns (name, kind, key, pipeline, mode, status, goal, categories, context, schedule)
select v.name, 'always_on', v.key, v.pipeline, 'broadcast', v.status, v.goal, v.categories, v.context, v.schedule
from (values
  ('Availability alerts',   'availability_alert',  'samba', 'live',   'reply',
     array['availability_alert'],  'High-signal availability changes to matched agents',
     '{"cron":"daily 09:00-09:40 WITA, 3 waves","gate":"HIGH_SIGNAL_MIN=3, 72h frequency, tier-muted"}'::jsonb),
  ('Weekly digest',         'availability_digest', 'samba', 'live',   'reply',
     array['availability_digest'], 'Monday availability digest — reaches every non-paused agent',
     '{"cron":"Mondays 09:00 WITA, 3 waves"}'::jsonb),
  ('First-touch intro',     'availability_intro',  'samba', 'paused', 'reply',
     array['availability_intro'],  'Carousel intro to agents the broadcast has never reached',
     '{"cron":"daily (not Mondays)","cap_setting":"samba_availability.intro_sweep_daily_cap"}'::jsonb),
  ('New arrivals',          'new_arrivals',        'samba', 'live',   'reply',
     array['new_arrivals'],        'Just-went-live listings announced as a NEW-badge carousel',
     '{"cron":"daily 09:00 WITA (wave 0), when listings went live"}'::jsonb),
  ('Account invites',       'account_invite',      'samba', 'paused', 'signup',
     array['account_invite','account_invite_nudge'], 'Portal-account invite for dormant agents + closing-window nudge',
     '{"cron":"daily (not Mondays)","cap_setting":"samba_availability.account_invite_daily_cap"}'::jsonb),
  ('Viewings announce',     'viewings_announce',   'samba', 'paused', 'reply',
     array['viewings_announce'],   'One-time "Maya books viewings now" note to engaged agents',
     '{"cron":"daily (not Mondays)","cap_setting":"samba_availability.viewings_announce_daily_cap"}'::jsonb),
  ('Welcome / onboarding',  'onboarding',          'samba', 'live',   'reply',
     array['onboarding'],          'Welcome template for newly added agents (deferred to 9am WITA)',
     '{"cron":"daily 09:00 WITA (wave 0)"}'::jsonb),
  ('Owner cold outreach',   'owner_cold',          'samba', 'paused', 'reply',
     array['owner_cold'],          'Cold intro drip to prospect villa owners (screenshot pipeline)',
     '{"cron":"daily 09:00 WITA","cap_setting":"owner_cold.intro_daily_cap","env_gate":"OWNERS_ENABLED=1"}'::jsonb)
) as v(name, key, pipeline, status, goal, categories, context, schedule)
where not exists (select 1 from campaigns c where c.key = v.key);

-- Console-created campaigns with a template sequence are 'sequence' kind.
update campaigns set kind = 'sequence'
 where kind = 'one_off'
   and template_sequence is not null
   and jsonb_typeof(template_sequence) = 'array'
   and jsonb_array_length(template_sequence) > 0;

-- ── 6) Backfill (c): link surviving wa_messages + repair sequence rows ──
update wa_messages m set campaign_id = c.id
  from campaigns c
 where m.campaign_id is null and m.category is not null
   and c.kind = 'always_on' and c.categories @> array[m.category];

-- Sequence sends were inserted with campaign_id but NO category/status
-- (the cron bug this migration's code change fixes) — repair the survivors.
update wa_messages set category = 'sequence', status = coalesce(status, 'sent')
 where campaign_id is not null and category is null
   and source = 'cron' and direction = 'outbound';

-- Seed counters from the surviving (≤90-day) message rows. greatest() keeps
-- re-runs safe: a second run can never shrink a counter the webhook has
-- since incremented past the historical aggregate.
with agg as (
  select campaign_id,
         count(*) filter (where direction = 'outbound')                 as sent,
         count(*) filter (where status in ('delivered','read'))         as delivered,
         count(*) filter (where status = 'read')                        as read,
         count(*) filter (where status = 'failed')                      as failed
    from wa_messages where campaign_id is not null group by campaign_id
)
update campaigns c set
    sent_count      = greatest(coalesce(c.sent_count,0), a.sent),
    delivered_count = greatest(c.delivered_count, a.delivered),
    read_count      = greatest(c.read_count, a.read),
    fail_count      = greatest(coalesce(c.fail_count,0), a.failed)
  from agg a where a.campaign_id = c.id and c.kind = 'always_on';

-- Seed account-invite conversions from the engagement stamps (agents holding
-- BOTH the invite stamp and a portal account). greatest() keeps re-runs safe.
update campaigns c set conversion_count = greatest(c.conversion_count, s.n)
  from (select count(*) as n from agents a
         where a.campaign_engagement ? 'account_invite'
           and a.campaign_engagement ? 'portal_account') s
 where c.key = 'account_invite';
