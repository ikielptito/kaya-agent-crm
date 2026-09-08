// The words, pinned. Every line here is something a housekeeper actually
// wrote in the first week and what it must mean.
import { isAck, isDone, isAllFine, isGreeting, isQuestion, isAvail, isRestock, realText, SCHEDULE_WORD_RE } from '../lib/staff-lang.js';
import { modeOf } from '../lib/staff-channel.js';
import { pickProperty } from '../lib/maintenance.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};

// Acknowledgements change nothing.
t('"siap" is an ack', isAck('siap'), true);
t('"Siap kak" is an ack', isAck('Siap kak'), true);
t('"Baik maya" is an ack', isAck('Baik maya'), true);
t('"terimakasi🙏🙏" is an ack', isAck('terimakasi🙏🙏'), true);
t('"🙏🙏" is an ack', isAck('🙏🙏'), true);
t('"Ok terimakasih" is an ack', isAck('Ok terimakasih'), true);
t('"siap" is NOT done', isDone('siap'), false);
t('"ya" is NOT done', isDone('ya'), false);

// Done, only when said.
t('"Sudah selesai" is done', isDone('Sudah selesai'), true);
t('"selesai" is done', isDone('selesai'), true);
t('"sudah" is done', isDone('sudah'), true);
t('"sudah selesai kak, tapi kran bocor" is not a bare done', isDone('sudah selesai kak, tapi kran bocor'), false);
t('"A4 sudah saya bersihkan hari ini" is not a bare done (classifier)', isDone('A4 sudah saya bersihkan hari ini'), false);
t('"semua bagus" closes a round', isAllFine('semua bagus'), true);
t('"aman" closes a round', isAllFine('aman'), true);

// Greetings, questions, availability, supplies.
t('"Hallo" greets', isGreeting('Hallo'), true);
t('"Hai maya" greets', isGreeting('Hai maya'), true);
t('"Selamat pagi" greets', isGreeting('Selamat pagi'), true);
t('"Bisakah besok?" is a question', isQuestion('Bisakah besok?'), true);
t('"Apakah ini hanya untuk pas villa ready" is a question', isQuestion('Apakah ini hanya untuk pas villa ready persiapan check in'), true);
t('"hari ini saya libur" is availability', isAvail('hari ini saya libur'), true);
t('"besok saja" is availability', isAvail('besok saja'), true);
t('"sabun tangan hampir habis" is restock', isRestock('sabun tangan hampir habis'), true);
t('"Ini A5 maya" is not restock', isRestock('Ini A5 maya'), false);

// The placeholder the webhook substitutes for a captionless image.
t('placeholder is stripped', realText('[Agent sent an image — say briefly that you could not open it and offer to have Ikiel review it.]'), '');
t('[Image] is stripped', realText('[Image]'), '');
t('a caption survives', realText('ada 1 piring yang pecah,,'), 'ada 1 piring yang pecah,,');

// Schedule words.
t('"jadwal saya Senin dan Jumat" has a schedule word', SCHEDULE_WORD_RE.test('jadwal saya Senin dan Jumat'), true);
t('"Kamis saya ke dokter" has none', SCHEDULE_WORD_RE.test('Kamis saya ke dokter'), false);

// Channel modes.
const now = new Date('2026-09-08T02:00:00Z');
t('nothing delivered for 4 days = dead', modeOf({ undeliveredSince: '2026-09-04T01:00:00Z', now }), 'dead');
t('nothing delivered for 1 day = ok (in flight)', modeOf({ undeliveredSince: '2026-09-07T10:00:00Z', now }), 'ok');
t('reads, ignores 5 of 6 asks = quiet', modeOf({ lastReadAt: '2026-09-07T01:10:00Z', asks7d: 6, ignoredAsks7d: 5, now }), 'quiet');
t('answers most asks = ok', modeOf({ lastReadAt: '2026-09-07T01:10:00Z', asks7d: 6, ignoredAsks7d: 1, now }), 'ok');

// Generic words are not a villa.
const GROUPS = [
  { key: 'villa-saturno', name: 'Villa Saturno', listing_slugs: ['villa-saturno'] },
  { key: 'haus-5', name: 'HAUS Canggu – Unit 5', listing_slugs: ['haus-5'] },
  { key: 'tropicana-b4', name: 'Tropicana Valley – Unit B4', listing_slugs: ['tropicana-b4'] },
];
t('"the villa is empty now" matches nothing', pickProperty(GROUPS, 'the villa is empty now, tukang can come Tuesday'), null);
t('"saturno pump" still matches', pickProperty(GROUPS, 'saturno pump replacement')?.group_key, 'villa-saturno');
t('"haus unit 5 chairs" matches the unit', pickProperty(GROUPS, 'haus unit 5 chairs broken')?.slug, 'haus-5');
t('"tropicana ac rusak" without a unit matches nothing (needs the unit)', pickProperty(GROUPS, 'tropicana ac rusak')?.slug || null, null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
