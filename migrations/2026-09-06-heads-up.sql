-- Heads-up to the owner before the cost is known.
-- RUN IN THE SUPABASE SQL EDITOR BEFORE DEPLOYING.
--
-- A leak at Tropicana A5 (5 Sep 2026) sat as "new" because publishing a
-- ticket meant either asking the owner to approve a cost Era did not have
-- yet, or marking the work as routine and authorised, which it was not.
-- The owner should hear about a leak the day it is found. So a ticket can
-- now be flagged for a heads-up: Maya tells the owner what was found and
-- that the cost follows; the ticket stays "new" until Era has the estimate
-- and publishes it for approval as usual.
alter table maintenance_items
  add column if not exists heads_up_at      timestamptz,   -- Era asked for it
  add column if not exists heads_up_sent_at timestamptz;   -- Maya sent it
