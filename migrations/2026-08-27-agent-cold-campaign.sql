-- ═══════════════════════════════════════════════════════════════════════
-- AGENT COLD OUTREACH campaign — 27 Aug 2026 (idempotent, safe to re-run)
--
-- Ikiel's screenshot workflow: agent-listing screenshots → Maya quick-adds
-- the agent → the welcome template IS the cold intro. This registers the
-- campaign and re-tags this morning's imports (notes 'from screenshot…')
-- so their sends and replies report under it instead of the generic
-- Welcome bucket. New imports are tagged automatically by the code.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) Register the campaign (the code also self-heals this if missing).
insert into campaigns (name, kind, key, pipeline, mode, status, goal, categories, context, schedule)
select 'Agent cold outreach', 'always_on', 'agent_cold', 'samba', 'broadcast', 'live', 'reply',
       array['agent_cold'],
       'Cold intros to agents found via listing screenshots (Maya quick-add)',
       '{"cron":"sends on import (9am WITA if added off-hours)","volume":"manual — you control it by how many screenshots you feed Maya"}'::jsonb
where not exists (select 1 from campaigns where key = 'agent_cold');

-- 2) Tag the screenshot-sourced agent rows (samba.source = 'cold_import').
update agents
   set campaign_engagement = jsonb_set(campaign_engagement, '{samba,source}', '"cold_import"')
 where notes ilike '%from screenshot%'
   and campaign_engagement ? 'samba';

-- 3) Re-file their welcome sends under the new campaign.
update wa_messages m
   set category = 'agent_cold',
       campaign_id = (select id from campaigns where key = 'agent_cold')
  from agents a
 where m.agent_id = a.id
   and a.notes ilike '%from screenshot%'
   and m.direction = 'outbound'
   and m.category = 'onboarding';

-- 4) Recompute lifetime counters for the two affected campaigns from the
--    surviving message rows (matches how the original migration seeded them).
with agg as (
  select campaign_id,
         count(*) filter (where direction = 'outbound')         as sent,
         count(*) filter (where status in ('delivered','read')) as delivered,
         count(*) filter (where status = 'read')                as read,
         count(*) filter (where status = 'failed')              as failed
    from wa_messages
   where campaign_id in (select id from campaigns where key in ('agent_cold','onboarding'))
   group by campaign_id
)
update campaigns c
   set sent_count      = coalesce(a.sent, 0),
       delivered_count = coalesce(a.delivered, 0),
       read_count      = coalesce(a.read, 0),
       fail_count      = coalesce(a.failed, 0),
       updated_at      = now()
  from (select id from campaigns where key in ('agent_cold','onboarding')) k
  left join agg a on a.campaign_id = k.id
 where c.id = k.id;
