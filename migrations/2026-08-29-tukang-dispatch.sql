-- Tukang dispatch: turn an approved repair into a scheduled visit.
-- RUN IN THE SUPABASE SQL EDITOR BEFORE DEPLOYING.
--
-- Today the maintenance system stops at "the owner said yes". Era then finds
-- a tukang herself, agrees a time on WhatsApp, chases him, and confirms the
-- work, which is why approved tickets sit. This adds the missing half:
--
--   Era assigns    → Maya sends the job with photos and a link
--   tukang replies → Maya reads the day and time, confirms it
--   the day comes  → Maya reminds him, then asks whether it is done
--   throughout     → Era is told at each step, without having to ask
--
-- Modelled on the viewings state machine, which already schedules a visit
-- with a third party and survives the same failure modes.

alter table maintenance_items
  add column if not exists assigned_staff_id     bigint references staff(id),
  add column if not exists assigned_at           timestamptz,
  add column if not exists assigned_by           text,
  -- null = queued for the next sweep. Every transition re-arms the next
  -- latch by nulling it, the same contract as notified_at above.
  add column if not exists tukang_notified_at    timestamptz,
  add column if not exists tukang_replied_at     timestamptz,
  add column if not exists visit_at              timestamptz,
  -- offered → confirmed → arrived → done, or declined
  add column if not exists visit_status          text,
  add column if not exists visit_reminded_at     timestamptz,
  add column if not exists arrival_check_at      timestamptz,
  add column if not exists completion_check_at   timestamptz,
  -- Era's own clock. Nulled on every state change so she gets one update
  -- per development and never the same one twice.
  add column if not exists era_dispatch_update_at timestamptz,
  add column if not exists era_dispatch_state    text;

create index if not exists maintenance_dispatch_idx
  on maintenance_items(assigned_staff_id, visit_status)
  where assigned_staff_id is not null;

create index if not exists maintenance_visit_idx
  on maintenance_items(visit_at) where visit_at is not null;
