-- Some properties aren't settled month-by-month at all. LaneHAUS 1 & 3 are
-- owned by Ikiel and Guy under a private arrangement, so "paid / unpaid" and
-- a running balance are meaningless there — the statements exist to record
-- what the villa earned and spent, nothing more.
--
-- RUN IN THE SUPABASE SQL EDITOR.

alter table statement_groups
  add column if not exists tracks_payments boolean not null default true;

-- LaneHAUS: record the numbers, don't track settlement.
update statement_groups set tracks_payments = false where key = 'lanehaus';
