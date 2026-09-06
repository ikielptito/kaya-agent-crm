// The four lines and the change detector, pinned on a made-up day.
import { briefHeadline, diffSnapshot } from '../lib/era-brief.js';
let pass = 0, fail = 0;
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`  FAIL ${n}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); } };
const stay = (villa, slug, guest, ci, co, same_day = false) => ({ villa, slug, guest, channel: 'airbnb', nights: 3, check_in: ci, check_out: co, same_day });
const b = {
  date: '2026-09-07', label: 'Mon 7 Sep', monday: true,
  guests: { departures: [stay('HAUS Canggu · Unit 2', 'haus-2', 'Hicham Ibourk', '2026-09-01', '2026-09-07')], arrivals: [stay('HAUS Canggu · Unit 2', 'haus-2', 'Anna Berg', '2026-09-07', '2026-09-12', true), stay('LaneHAUS · Unit 3', 'lanehaus-3', 'Lisa Haug', '2026-09-07', '2026-09-30')], tomorrow_arrivals: [stay('Villa Saturno', 'villa-saturno', 'Tom', '2026-09-08', '2026-09-20')], in_house: [], unavailable: false },
  cleaning: [{ who: 'Ana', visits: [{ kind: 'regular' }, { kind: 'turnover' }] }, { who: 'Ita', visits: [{ kind: 'regular' }, { kind: 'regular' }, { kind: 'inspection' }] }, { who: 'Unassigned', visits: [{ kind: 'regular' }] }],
  rounds: [{ villa: 'Tropicana Valley · B4', kind: 'inspection round', who: 'Ita' }],
  tukang: [{ ticket: 9, villa: 'HAUS 4', title: 'Stove regulator', who: 'Dian', at: '2026-09-07T02:00:00Z' }],
  backlog: [{ id: 3, age_days: 8 }, { id: 5, age_days: 7 }], relays: [{ id: 1 }], viewings: [],
  loose: { not_done: [{ villa: 'Tropicana Valley · B3', kind: 'inspection round', who: 'Gede Baglug' }], readiness: [{ villa: 'HAUS Canggu · Unit 1', status: 'unchecked', flags: [] }] },
  week: { days: [], statements_unpublished: [{ group: 'HAUS 5', period: '2026-08', status: 'draft' }], prev_period: '2026-08' },
};
const lines = briefHeadline(b).split('\n');
t('line 1 names the same-day turnover and the other arrival, and tomorrow', lines[0], 'Mon 7 Sep — HAUS Canggu · Unit 2: Hicham leaves, Anna arrives (same-day). arriving: LaneHAUS · Unit 3 (Lisa). tomorrow: Villa Saturno arriving.');
t('line 2 counts cleans per person, rounds, unassigned, tukang', lines[1], '5 cleans (Ana 2, Ita 3), 1 round — 1 unassigned; 1 tukang visit.');
t('line 3 is what waits on her, Monday adds statements', lines[2], '2 tickets waiting on you, oldest 8 days; 1 agent question open; 1 statement for 2026-08 not yet published.');
t('line 4 is yesterday', lines[3], 'Yesterday: Tropicana Valley · B3 inspection round (Gede) not marked done; HAUS Canggu · Unit 1 photo check missing.');
const quiet = briefHeadline({ ...b, guests: { departures: [], arrivals: [], tomorrow_arrivals: [], in_house: [], unavailable: false }, cleaning: [], rounds: [], tukang: [], backlog: [], relays: [], viewings: [], loose: { not_done: [], readiness: [] }, monday: false });
t('a quiet day is three short lines', quiet.split('\n'), ['Mon 7 Sep — no guest movements.', 'No cleans today.', 'Nothing waiting on you.']);
const prev = { today: '2026-09-07', tasks: { 1: { date: '2026-09-07', slug: 'haus-2', kind: 'turnover', who: 'Putu' }, 2: { date: '2026-09-08', slug: 'haus-4', kind: 'regular', who: 'Putu' } }, arrivals: ['haus-2|2026-09-07|Anna Berg'], departures: [] };
const cur = { today: '2026-09-07', tasks: { 1: { date: '2026-09-07', slug: 'haus-2', kind: 'turnover', who: 'Putu' }, 2: { date: '2026-09-09', slug: 'haus-4', kind: 'regular', who: 'Ita' }, 3: { date: '2026-09-08', slug: 'lanehaus-3', kind: 'pre_arrival', who: 'Ana' } }, arrivals: ['haus-2|2026-09-07|Anna Berg', 'lanehaus-3|2026-09-08|Tom'], departures: [] };
const names = { 'haus-2': 'HAUS 2', 'haus-4': 'HAUS 4', 'lanehaus-3': 'LaneHAUS 3' };
t('changes: a new task, a moved one, a new arrival', diffSnapshot(prev, cur, s => names[s] || s), ['Moved: regular clean at HAUS 4 → Wed 9 Sep, now Ita.', 'New: pre-arrival prep at LaneHAUS 3 tomorrow (Ana).', 'New arrival tomorrow: LaneHAUS 3 (Tom).']);
t('no change, no lines', diffSnapshot(cur, cur, s => s), []);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
