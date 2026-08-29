-- Regular housekeeping as a service, and tasks that can be moved.
-- RUN IN THE SUPABASE SQL EDITOR BEFORE DEPLOYING.
--
-- Two corrections to the schedule built on 29 Aug.
--
-- 1. WHAT THE REGULAR CLEAN ACTUALLY IS. It was modelled as a threshold:
--    stays over 14 nights get a clean every 7 days. It is not a threshold. It
--    is a service Samba sells — twice a week, every week, on fixed weekdays
--    the tenant and the cleaner can both rely on. The days differ per villa
--    so one housekeeper is not doing four properties on the same morning.
--
--    It also runs whether or not anyone is staying, which makes the old
--    "upkeep visit while empty" rule redundant. Four kinds now, not five:
--    regular, turnover, pre_arrival, inspection.
--
-- 2. TASKS HAVE TO BE MOVABLE. Cleaners ask to shift a day, and Era grants
--    it. The generator deduplicated on (slug, task_date, kind), so moving
--    Monday's clean to Tuesday left the Monday slot empty and the next hourly
--    run recreated it — the same clean, twice.
--
--    So the reason a task exists is now separate from when it happens:
--      origin_date  the date the RULE produced. Never moves. Owns uniqueness.
--      task_date    when it will actually happen. Free to be dragged.
--    Re-deriving a moved task matches its origin_date and changes nothing,
--    the same non-clobber contract the statement sync already uses.

-- ── Per-villa service level ─────────────────────────────────────────
-- clean_days uses PostgreSQL's day-of-week numbering (0 = Sunday).
create table if not exists property_care (
  slug        text primary key,
  clean_days  integer[] not null default '{1,4}',   -- Monday and Thursday
  active      boolean not null default true,
  notes       text,
  updated_at  timestamptz not null default now()
);

-- Seeded so each housekeeper's week is spread rather than stacked: Gede has
-- four Tropicanas and Putu four HAUS units, and putting them all on Monday
-- and Thursday would mean four cleans in a morning and nothing on Wednesday.
-- Era can change any of these; the generator reads the table, not this seed.
insert into property_care (slug, clean_days) values
  ('haus-1',         '{1,4}'),   -- Putu
  ('haus-2',         '{2,5}'),
  ('haus-4',         '{3,6}'),
  ('haus-5',         '{1,4}'),
  ('lanehaus-1',     '{1,4}'),   -- Ana
  ('lanehaus-3',     '{2,5}'),
  ('villa-saturno',  '{1,4}'),   -- Naomi
  ('tropicana-a4',   '{1,4}'),   -- Ita
  ('tropicana-a5',   '{2,5}'),
  ('tropicana-b4',   '{3,6}'),
  ('tropicana-b2',   '{1,4}'),   -- Gede
  ('tropicana-b3',   '{2,5}'),
  ('tropicana-b5',   '{3,6}'),
  ('tropicana-b6',   '{1,4}')
on conflict (slug) do nothing;

-- ── Movable tasks ───────────────────────────────────────────────────
alter table housekeeping_tasks
  add column if not exists origin_date date,
  add column if not exists moved_by    text,
  add column if not exists moved_at    timestamptz;

-- Existing rows have never been moved, so the two dates start equal.
update housekeeping_tasks set origin_date = task_date where origin_date is null;
alter table housekeeping_tasks alter column origin_date set not null;

-- Swap the uniqueness onto origin_date. The old constraint name is whatever
-- Postgres generated for the inline UNIQUE, so it is looked up rather than
-- guessed.
do $$
declare c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'housekeeping_tasks'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) like '%task_date%kind%';
  if c is not null then
    execute format('alter table housekeeping_tasks drop constraint %I', c);
  end if;
end $$;

alter table housekeeping_tasks
  drop constraint if exists housekeeping_tasks_slug_origin_date_kind_key;
alter table housekeeping_tasks
  add constraint housekeeping_tasks_slug_origin_date_kind_key
  unique (slug, origin_date, kind);

-- The vacant-upkeep rule is gone. Anything still planned for it would never
-- be regenerated, so clear the ones nobody has been told about and leave any
-- that were actually sent as the historical record they are.
delete from housekeeping_tasks
where kind = 'vacant_upkeep' and notified_at is null and status = 'planned';

-- Frequency lives here; the days live per villa in property_care.
update settings
set value = (value - 'during_stay_min_nights' - 'during_stay_every_days' - 'vacant_upkeep_days')
            || jsonb_build_object('cleans_per_week', 2, 'pre_arrival_vacant_days', 5)
where key = 'housekeeping';
