// The ticket guard's two pure layers: the words that say "already done",
// and the subject overlap that says "this fault has a ticket". Pinned with
// the messages that actually went wrong.
//
//   10 Sep 2026  "Tropicana-a4 sofa zipper has been repaired" → ticket #29,
//                a duplicate of #28 "Sofa zipper repair".
//   6 Sep 2026   "#4 patio chairs done… #A5 glass estimate 15,000/pcs" →
//                four new tickets under the wrong villa.
import { looksLikeCompletion, similarOpen, subjectTokens, describeActions } from '../lib/ticket-guard.js';
import { looksLikeStatusReply } from '../lib/maintenance-backlog-reply.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log('looksLikeCompletion — finished work, English');
for (const s of [
  'Tropicana-a4 sofa zipper has been repaired',
  'I meant to tell Maya that this has been followed up',
  'A4 sofa zipper is fixed',
  'The shower head at HAUS 5 was replaced yesterday',
  'Wallpaper above the stove installed already',
  'glassware bought and replaced',
  'Fixed: the A5 tap',
  'aircon in unit 2 is working again, serviced this morning',
  'pool pump done, all sorted now',
]) eq(`done: "${s}"`, looksLikeCompletion(s), true);

console.log('looksLikeCompletion — finished work, Indonesian');
for (const s of [
  'resleting sofa A4 sudah diperbaiki',
  'kran wastafel sudah diganti kemarin',
  'AC unit 2 sudah dingin lagi',
  'lampu teras sudah nyala',
  'pintu lemari selesai diperbaiki tadi',
  'atap yang bocor sudah ditambal',
]) eq(`done: "${s}"`, looksLikeCompletion(s), true);

console.log('looksLikeCompletion — reports and chatter are NOT completion');
for (const s of [
  'Maintenance Tropicana valley A4 - sofa zipper need to fix',
  'sofa zipper needs to be fixed',
  'kran kamar mandi bocor',
  'AC tidak dingin',
  'the tap is still not fixed',
  'has the sofa been repaired?',           // a question — handled as one, but not a claim
  'belum diperbaiki, tukang datang besok',
  'not yet done, waiting for the part',
  'sudah',                                  // visit reply, claimed by staff-lang
  'done',
  'ok siap',
  'A5 glass estimate 15,000/pcs x 4',
  'Please replace the two patio chairs, 1.1jt each',
  'Unit 2 haus canggu',
]) eq(`not done: "${s}"`, looksLikeCompletion(s), false);

console.log('looksLikeStatusReply — the status lane takes completions without a nudge');
eq('completion, no nudge', looksLikeStatusReply('Tropicana-a4 sofa zipper has been repaired', { nudgedRecently: false }), true);
eq('#n always', looksLikeStatusReply('#28 done', { nudgedRecently: false }), true);
eq('plain report, no nudge', looksLikeStatusReply('Maintenance Tropicana valley A4 - sofa zipper need to fix', { nudgedRecently: false }), false);
eq('progress words only count after a nudge', looksLikeStatusReply('waiting for the part for the pump', { nudgedRecently: false }), false);
eq('… and do count after one', looksLikeStatusReply('waiting for the part for the pump', { nudgedRecently: true }), true);

console.log('subjectTokens — the thing itself, not the villa or the verb');
eq('sofa zipper', [...subjectTokens('Tropicana-a4 sofa zipper has been repaired')].sort(), ['sofa', 'zipper']);
eq('title', [...subjectTokens('Sofa zipper repair')].sort(), ['sofa', 'zipper']);
eq('price stripped', [...subjectTokens('two patio chairs 1.1jt each')].sort(), ['chairs', 'each', 'patio', 'two']);

console.log('similarOpen — an open ticket for the same fault at the same villa');
const open = [
  { id: 28, slug: 'tropicana-a4', group_key: 'tropicana-a4', title: 'Sofa zipper repair', description: 'Sofa zipper needs to be fixed at Tropicana Valley A4.' },
  { id: 15, slug: 'tropicana-a4', group_key: 'tropicana-a4', title: 'Replace glassware - long glass and stemmed glasses and bowl', description: null },
  { id: 16, slug: 'tropicana-a4', group_key: 'tropicana-a4', title: 'Install wallpaper above stove', description: null },
  { id: 17, slug: 'tropicana-a5', group_key: 'tropicana-a5', title: 'Greasy handprints on the wall behind the front door', description: null },
];
eq('the incident', similarOpen(open, { title: 'Tropicana-A4 sofa zipper repair', text: 'Tropicana-a4 sofa zipper has been repaired', slug: 'tropicana-a4' })?.item.id, 28);
eq('re-report, same words', similarOpen(open, { title: 'Sofa zipper repair', text: 'A4 sofa zipper need to fix', slug: 'tropicana-a4' })?.item.id, 28);
eq('one word of overlap still asks', similarOpen(open, { title: 'Sofa cushion torn', text: '', slug: 'tropicana-a4' })?.item.id, 28);
// Across languages the words do not overlap; that is the model layer's
// job (resolveAgainstOpen), not this one's. Pinned so nobody loosens the
// threshold to chase it and starts asking Era about every "bowl".
eq('cross-language is the model layer\'s job → null', similarOpen(open, { title: 'Gelas pecah, perlu ganti', text: 'gelas wine pecah 2, bowl juga', slug: 'tropicana-a4' }), null);
eq('… but the same words in any language match', similarOpen(open, { title: 'Ganti glassware: long glass, stemmed glasses', text: '', slug: 'tropicana-a4' })?.item.id, 15);
eq('different fault, same villa → null', similarOpen(open, { title: 'Bathroom door lock broken', text: 'A4 bathroom door lock broken', slug: 'tropicana-a4' }), null);
eq('same fault, other villa → null', similarOpen(open, { title: 'Sofa zipper repair', text: 'A5 sofa zipper broken', slug: 'tropicana-a5' }), null);
eq('wall vs wallpaper are different words', similarOpen(open, { title: 'Wall paint touch up', text: 'A4 wall needs paint touch up', slug: 'tropicana-a4' }), null);
eq('empty subject → null', similarOpen(open, { title: 'Maintenance issue', text: 'unit A4', slug: 'tropicana-a4' }), null);

console.log('describeActions — the read-back Era confirms before anything changes');
const items = [
  { id: 28, status: 'new', title: 'Sofa zipper repair', unit_label: 'A4', group_key: 'tropicana-a4', statement_groups: { name: 'Tropicana Valley' }, estimated_cost: null },
  { id: 15, status: 'scheduled', title: 'Replace glassware', unit_label: 'A4', group_key: 'tropicana-a4', statement_groups: { name: 'Tropicana Valley' }, estimated_cost: 85000 },
  { id: 9, status: 'pending_approval', title: 'Pool pump', unit_label: null, group_key: 'villa-saturno', statement_groups: { name: 'Villa Saturno' }, estimated_cost: null },
];
const desc = describeActions([
  { id: 28, action: 'done', note: 'repaired' },
  { id: 15, action: 'note', note: 'tukang comes Friday', estimated_cost: 150000 },
  { id: 9, action: 'done', note: 'done' },
  { id: 999, action: 'done', note: 'ghost' },
], items);
eq('three lines, the ghost ticket dropped', desc.length, 3);
eq('a new ticket closing says the owner hears it', desc[0].startsWith('✅ #28 Sofa zipper repair — Tropicana Valley (A4) → *done* (the owner hears'), true);
eq('a note keeps its price only when the ticket has none', desc[1].includes('estimate'), false);
eq('pending approval cannot be closed from chat', desc[2].startsWith('⏳ #9'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
