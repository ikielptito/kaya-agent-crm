-- ═══════════════════════════════════════════════════════════════════════
-- PAYROLL ENTITIES migration — 4 Sep 2026
-- Run after 2026-09-04-payroll.sql. Idempotent.
--
-- Samba and Double 8 (Tropicana B2/B3/B5/B6, co-owned with Oli) are
-- financially separate but share the payroll engine. Every payroll run
-- and every team member belongs to one entity; a month exists once per
-- entity. Double 8's runs are derived from the salary rows on Era's
-- DOUBLE EIGHT ledger (the sheet Oli pays from), never from Samba's sheet.
-- ═══════════════════════════════════════════════════════════════════════
alter table payroll_runs add column if not exists entity text not null default 'samba';
alter table payroll_runs add column if not exists source_statement_id bigint references statements(id) on delete set null;
alter table payroll_runs drop constraint if exists payroll_runs_period_key;
create unique index if not exists payroll_runs_entity_period on payroll_runs (entity, period);
create index if not exists idx_payroll_runs_entity on payroll_runs (entity, period desc);

alter table staff add column if not exists entity text not null default 'samba';
-- The Double 8 housekeeper (B2/B3/B5/B6) moves under Double 8.
update staff set entity = 'double8' where name = 'Gede Baglug' and entity = 'samba';

notify pgrst, 'reload schema';
