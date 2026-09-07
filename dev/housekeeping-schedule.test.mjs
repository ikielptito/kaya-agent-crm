// What the housekeepers actually wrote on 6–7 Sep 2026, and what it must
// mean. Every fixture here is a real message that Maya misread that day.
import { looksLikeSchedule, resolveUnits, parseScheduleBurst, isGreeting, normalise } from '../lib/housekeeping-schedule.js';
import { dropCollisions } from '../lib/housekeeping.js';
import { taskForQuoted, revertPlanFor } from '../lib/housekeeping-intake.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};
const TODAY = '2026-09-07';   // a Monday

const ANA = ['lanehaus-1', 'lanehaus-3'];
const GEDE = ['tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6'];
const ITA = ['tropicana-a4', 'tropicana-a5', 'tropicana-b4'];
const PUTU = ['haus-1', 'haus-2', 'haus-4', 'haus-5'];
const NAMES = {
  'lanehaus-1': 'LaneHAUS - Unit 1', 'lanehaus-3': 'LaneHAUS - Unit 3',
  'tropicana-a4': 'Tropicana Valley - Unit A4', 'tropicana-a5': 'Tropicana Valley - Unit A5', 'tropicana-b4': 'Tropicana Valley - Unit B4',
  'haus-1': 'HAUS Canggu - Unit 1', 'villa-saturno': 'Villa Saturno',
};

console.log('gate');
t('a day of the week', looksLikeSchedule('Senin & jumat'), true);
t('"jadwal"', looksLikeSchedule('Jadwal saya hanya 2x seminggu'), true);
t('"jadwalnya"', looksLikeSchedule('Untuk B4 jadwalnya hari senin🙏'), true);
t('a question is not a statement', looksLikeSchedule('Kapan jadwal untuk bersih-bersih lagi di A5?'), false);
t('"Bisakah besok?" is a reply about today', looksLikeSchedule('Bisakah besok? Karena besok tamu check out jadi bisa sekalian mengirimkan fotonya'), false);
t('a day off is not a pattern', looksLikeSchedule('hari ini saya libur'), false);
t('"saya libur hari senin" is a day off', looksLikeSchedule('saya libur hari senin'), false);
t('"besok saja" is a task reply', looksLikeSchedule('besok saja'), false);
t('a correction is not a schedule', looksLikeSchedule('Bukan A4\nTetapi B4'), false);
t('an ack is not a schedule', looksLikeSchedule('Baik maya'), false);
t('"Ya hari ini jam 11 kaka" (no day, no jadwal)', looksLikeSchedule('Ya hari ini jam 11 kaka'), false);

console.log('\nnormalise');
t("jum'at is Friday", normalise("Senin dan Jum'at"), 'senin dan jumat');
t('hari minggu is Sunday, seminggu is not', normalise('hari minggu, 2x seminggu'), 'hari sunday 2x seminggu');
t('b 3 is b3', normalise('unit B 3 dan B5'), 'unit b3 dan b5');

console.log('\nunits');
t('letter codes', resolveUnits('hari ini jadwal saya cleaning b3 dan b5,,', GEDE), ['tropicana-b3', 'tropicana-b5']);
t('"unit b2 dan b6"', resolveUnits('untuk unit b2 dan b6 hari rabu dan jumat,,', GEDE), ['tropicana-b2', 'tropicana-b6']);
t('property word alone = all of hers there', resolveUnits('Jadwal saya kerja ke laneHaus senin dan jumat', ANA), ANA);
t('"unit 3" for Ana', resolveUnits('Pembersihan rutin Lanehaus unit 3', ANA), ['lanehaus-3']);
t('"unit 1" for Putu', resolveUnits('unit 1 sudah', PUTU), ['haus-1']);
t('"unit A5"', resolveUnits('jadwal kebersihan saya unit A5 pada hari rabu', ITA), ['tropicana-a5']);
t('a unit she does not cover resolves to nothing', resolveUnits('b4 hari senin', GEDE), []);
t('bare digit without "unit" is not a villa', resolveUnits('jam 11 kaka', PUTU), []);
t('catalog name words', resolveUnits('di Saturno hari kamis', ['villa-saturno'], NAMES), ['villa-saturno']);

console.log('\nAna');
{
  const p = parseScheduleBurst(['Selamat pagi', 'Jadwal saya kerja ke laneHaus senin dan jumat \nJika ada perubahan waktu saya akan konfirmasi terimakasih'], { slugs: ANA, names: NAMES, today: '2026-09-06' });
  t('both units, Monday and Friday', p.weeklyBySlug, { 'lanehaus-1': { days: [1, 5], from: 1, all: false }, 'lanehaus-3': { days: [1, 5], from: 1, all: false } });
  t('nothing for today', p.today, []);
}
{
  const p = parseScheduleBurst(['Hallo', 'Jadwal saya hanya 2x seminggu', 'Senin & jumat', 'Kecuali ada tamu check in dan check out waktu akan di sesuaikan'], { slugs: ANA, names: NAMES, today: TODAY });
  t('twice a week', p.per_week, 2);
  t('"Senin & jumat" with no villa = all of hers', p.weeklyBySlug['lanehaus-3'], { days: [1, 5], from: 2, all: true });
  t('the guest exception is noted', [p.flex, p.flexFrom], [true, 3]);
}

console.log('\nGede');
{
  const burst = ['hari ini jadwal saya cleaning b3 dan b5,,', 'untuk jadwal cleaning hari senin dan kamis,,', 'untuk unit b2 dan b6 hari rabu dan jumat,,'];
  const p = parseScheduleBurst(burst, { slugs: GEDE, names: NAMES, today: TODAY });
  t('today: B3 and B5', p.today, [{ slugs: ['tropicana-b3', 'tropicana-b5'], from: 0 }]);
  t('the days line inherits the villas of the line before', p.weeklyBySlug['tropicana-b3'], { days: [1, 4], from: 1, all: false });
  t('… and B5', p.weeklyBySlug['tropicana-b5'].days, [1, 4]);
  t('B2 and B6 Wednesday and Friday', [p.weeklyBySlug['tropicana-b2'].days, p.weeklyBySlug['tropicana-b6'].days], [[3, 5], [3, 5]]);
  t('no one-offs', p.one_off, []);
  // The same burst, one message at a time: each message must add only its own facts.
  const first = parseScheduleBurst(burst.slice(0, 1), { slugs: GEDE, today: TODAY });
  t('first line alone sets nothing weekly', Object.keys(first.weeklyBySlug), []);
  const two = parseScheduleBurst(burst.slice(0, 2), { slugs: GEDE, today: TODAY });
  t('second line resolves to B3/B5 via the first', Object.keys(two.weeklyBySlug).sort(), ['tropicana-b3', 'tropicana-b5']);
}
{
  const p = parseScheduleBurst(['besok jadwal cleaning b3  dan b5', 'siap'], { slugs: GEDE, today: '2026-09-06' });
  t('"besok … b3 dan b5" is a one-off for tomorrow', p.one_off, [{ slugs: ['tropicana-b3', 'tropicana-b5'], date: '2026-09-07', from: 0 }]);
  t('and not a weekly pattern', Object.keys(p.weeklyBySlug), []);
}

console.log('\nIta');
{
  const p = parseScheduleBurst(['Untuk B4 jadwalnya hari senin🙏'], { slugs: ITA, names: NAMES, today: '2026-09-05' });
  t('B4 on Monday', p.weeklyBySlug, { 'tropicana-b4': { days: [1], from: 0, all: false } });
}
{
  const p = parseScheduleBurst(['Hai maya', 'Saya ingin memberitahukan jadwal kebersihan saya unit A5 pada hari rabu🙏'], { slugs: ITA, names: NAMES, today: TODAY });
  t('A5 on Wednesday', p.weeklyBySlug, { 'tropicana-a5': { days: [3], from: 1, all: false } });
}
{
  const p = parseScheduleBurst(['Besok adalah jadwal kebersihan saya di unit B4'], { slugs: ITA, today: '2026-09-06' });
  t('"besok … B4" is tomorrow, not weekly', [p.one_off, Object.keys(p.weeklyBySlug)], [[{ slugs: ['tropicana-b4'], date: '2026-09-07', from: 0 }], []]);
}
{
  const p = parseScheduleBurst(['Bisakah besok? Karena besok tamu check out jadi bisa sekalian mengirimkan fotonya', 'Bukan A4\nTetapi B4', 'A4 sudah saya bersihkan hari ini'], { slugs: ITA, today: TODAY });
  t('a question line is ignored', p.one_off, []);
  t('"A4 sudah saya bersihkan hari ini" is not a schedule statement', Object.keys(p.weeklyBySlug), []);
  t('… but is a today mention (harmless: the cleaning handler claims it first)', p.today, [{ slugs: ['tropicana-a4'], from: 2 }]);
}
{
  const p = parseScheduleBurst(['unit 7 hari senin'], { slugs: ITA, today: TODAY });
  t('a unit she does not cover is unresolved, and no pattern is set', [p.unresolved.length, Object.keys(p.weeklyBySlug)], [1, []]);
}

console.log('\ngreeting');
t('"Hallo"', isGreeting('Hallo'), true);
t('"Hai maya"', isGreeting('Hai maya'), true);
t('"Selamat pagi"', isGreeting('Selamat pagi'), true);
t('"Hello selamat pagi maya🙏" is more than a greeting', isGreeting('Hello selamat pagi maya🙏'), false);
t('a sentence is not a greeting', isGreeting('Halo, hari ini saya libur'), false);

console.log('\ngenerator collisions');
{
  const planned = [
    { slug: 'tropicana-b3', kind: 'regular', task_date: '2026-09-07' },
    { slug: 'tropicana-b3', kind: 'regular', task_date: '2026-09-10' },
    { slug: 'tropicana-b3', kind: 'inspection', task_date: '2026-09-07' },
  ];
  const existing = [
    { slug: 'tropicana-b3', kind: 'regular', task_date: '2026-09-07' },   // moved there by hand
  ];
  t('a moved task on the same day blocks the rule\'s copy', dropCollisions(planned, existing).map(x => `${x.kind}@${x.task_date}`), ['regular@2026-09-10', 'inspection@2026-09-07']);
  t('nothing existing, nothing dropped', dropCollisions(planned, []).length, 3);
}

console.log('\nwhich task a tap answers');
{
  const tasks = [
    { id: 233, slug: 'tropicana-a4', kind: 'regular', task_date: '2026-09-07' },
    { id: 262, slug: 'tropicana-b4', kind: 'regular', task_date: '2026-09-05' },
  ];
  const morning = 'Halo, ada jadwal untuk hari ini.\n\nVilla: Tropicana Valley - Unit A4\nTugas: bersih-bersih rutin';
  t('the morning message names A4 → A4', taskForQuoted(morning, tasks, NAMES)?.id, 233);
  const chase = '[Evening chase — Tropicana Valley - Unit A4: Regular clean, Tropicana Valley - Unit B4: Regular clean]';
  t('the chase names both → undecided (oldest wins)', taskForQuoted(chase, tasks, NAMES), null);
  t('no quoted message → undecided', taskForQuoted(null, tasks, NAMES), null);
}

console.log('\nundoing a move');
{
  const moved = { id: 230, task_date: '2026-09-08', status: 'planned', thread: [
    { at: 'x', who: 'Ita', text: 'Bisakah besok?', from_date: '2026-09-05', to_date: '2026-09-08', prev_status: 'notified', prev_notified_at: '2026-09-05T01:03:00Z' },
  ] };
  t('back to the day and state it had', revertPlanFor(moved), { task_date: '2026-09-05', status: 'notified', notified_at: '2026-09-05T01:03:00Z' });
  t('a task never moved has nothing to revert', revertPlanFor({ thread: [{ at: 'x', who: 'Maya', text: 'Evening chase sent' }] }), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
