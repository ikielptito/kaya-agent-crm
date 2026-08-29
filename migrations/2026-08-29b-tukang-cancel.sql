-- Telling a tukang his job was reassigned.
-- RUN IN THE SUPABASE SQL EDITOR. Small follow-up to 2026-08-29-tukang-dispatch.sql,
-- which has already been applied — so it lives in its own file rather than
-- changing one that has run.
--
-- Era reassigns a repair; the tukang who already had it has a job message and
-- a link sitting in his WhatsApp and no reason to think anything changed. He
-- turns up at the villa. This pair is the queue that stops that:
--
--   cancel_notice_for  who is owed the message (null = nobody)
--   cancel_notice_at   null until the sweep has sent it
--
-- Same null-latch contract as every other queue here, so the send is capped,
-- gated on template approval, and safe to re-run.

alter table maintenance_items
  add column if not exists cancel_notice_for bigint references staff(id),
  add column if not exists cancel_notice_at  timestamptz;

create index if not exists maintenance_cancel_idx
  on maintenance_items(cancel_notice_for)
  where cancel_notice_for is not null and cancel_notice_at is null;
