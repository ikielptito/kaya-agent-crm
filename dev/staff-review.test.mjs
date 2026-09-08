// The staff lane of the weekly review, pinned: the funnel arithmetic, the
// per-person split, what counts as a correction, and that approved words
// reach the rule lists without a deploy.
import { funnel, perPerson, proposalInput, applyStaffDecisions } from '../lib/staff-review.js';
import { correctingChange } from '../lib/corrections.js';
import { isDone, isAck, isAllFine, isScheduleWord, applyStaffLangExtras } from '../lib/staff-lang.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};

// ── The funnel ──
const T = [
  { kind: 'tap', layer: 'tap', outcome: 'recorded', wa_num: '1', staff_id: 1, received_at: '2026-09-07T01:10:00Z' },            // 09:10 WITA
  { kind: 'text', layer: 'rule', outcome: 'ack', wa_num: '1', staff_id: 1, received_at: '2026-09-07T01:12:00Z' },
  { kind: 'photo', layer: 'photo', outcome: 'recorded', wa_num: '1', staff_id: 1, received_at: '2026-09-07T03:00:00Z', corrected_at: '2026-09-08T00:00:00Z' },
  { kind: 'text', layer: 'classifier', confidence: 'low', outcome: 'recorded', wa_num: '2', staff_id: 2, received_at: '2026-09-07T10:00:00Z' }, // 18:00 WITA
  { kind: 'text', layer: 'classifier', confidence: 'high', outcome: 'forwarded', wa_num: '2', staff_id: 2, received_at: '2026-09-07T10:30:00Z' },
  { kind: 'text', layer: 'none', outcome: 'forwarded', wa_num: '2', staff_id: 2, received_at: '2026-09-07T11:00:00Z' },
  { kind: 'text', layer: 'reference', outcome: 'asked', wa_num: '1', staff_id: 1, received_at: '2026-09-07T01:20:00Z' },
];
const f = funnel(T);
t('said counts every turn', f.said, 7);
t('understood excludes forwards', f.understood, 5);
t('recorded counts records only', f.recorded, 3);
t('right = recorded minus corrected', [f.right, f.corrected], [2, 1]);
t('forwarded', f.forwarded, 2);
t('rates', f.rates, { understood: 71, recorded: 43, right: 67 });
t('by layer: photo recorded and corrected', f.by_layer.photo, { said: 1, recorded: 1, corrected: 1, forwarded: 0 });
t('low-confidence classifier turns are counted', f.low_confidence, 1);
t('by kind', f.by_kind, { tap: 1, text: 5, photo: 1 });

const P = perPerson(T, { 1: { name: 'Ita' }, 2: { name: 'Putu' } });
t('people sorted by volume', P.map(p => p.name), ['Ita', 'Putu']);
t('Ita: 4 said, 4 understood (an ask back counts), 2 recorded, 1 corrected', [P[0].said, P[0].understood, P[0].recorded, P[0].corrected], [4, 4, 2, 1]);
t('Putu writes at 18:00 and 19:00 WITA', P[1].busiest_hours.map(h => h.hour).sort(), [18, 19]);

// ── What the critic sees ──
const m = { _turns: T.map(x => ({ ...x, text: x.outcome === 'forwarded' ? 'udah beres semua kak' : 'x' })), _staffByNum: { 2: { name: 'Putu' } }, coaching: { people: [{ name: 'Ita', key: 'ack_not_button', verdict: 'persisted' }, { name: 'Putu', key: 'early_done', verdict: 'worked' }] }, people: P };
const inp = proposalInput(m);
t('forwarded texts go to the critic, named', inp.forwarded.map(x => [x.who, x.text]), [['Putu', 'udah beres semua kak'], ['Putu', 'udah beres semua kak']]);
t('only non-working coaching goes to the critic', inp.coaching.map(c => c.key), ['ack_not_button']);
t('corrected turns are listed', inp.corrected.length, 1);

// ── Corrections: what counts ──
t('a note is not a correction', correctingChange('housekeeping_task', { notes: 'x' }, { notes: null }), null);
t('a status change is', correctingChange('housekeeping_task', { status: 'not_done', notes: 'x' }, { status: 'done' }), { status: { from: 'done', to: 'not_done' } });
t('same value is not a change', correctingChange('housekeeping_task', { status: 'done' }, { status: 'done' }), null);
t('a ticket moved villa is', correctingChange('maintenance_item', { slug: 'b3' }, { slug: 'b4' }), { slug: { from: 'b4', to: 'b3' } });
t('an estimate is not', correctingChange('maintenance_item', { estimated_cost: 250000 }, { estimated_cost: null }), null);
t('without the old row, the patch itself counts', correctingChange('housekeeping_inspection', { photos: [] }), { photos: { to: [] } });

// ── Approved words reach the rules ──
t('"udah beres semua" is not done by default', isDone('udah beres semua'), false);
applyStaffLangExtras({ done: ['udah beres semua'], ack: ['sip lah'], all_fine: ['aman terkendali'], schedule: ['rutin'] });
t('…and is after approval', isDone('udah beres semua'), true);
t('a trailing address is still not matched, same as the base rule', isDone('udah beres semua kak'), false);
t('the base list still works', isDone('sudah selesai'), true);
t('approved ack', isAck('Sip lah 🙏'), true);
t('an approved ack does not become done', isDone('sip lah'), false);
t('approved all-fine', isAllFine('aman terkendali'), true);
t('approved schedule word', isScheduleWord('B3 rutin Senin'), true);
t('a report is still not a done, extras or not', isDone('udah beres semua tapi kran bocor'), false);
applyStaffLangExtras({});
t('cleared extras', isDone('udah beres semua'), false);

// ── Applying decisions writes settings, nothing else ──
const settings = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const key = (u.match(/key=eq\.([^&]+)/) || [])[1];
  if (init.method === 'POST') { const b = JSON.parse(init.body); settings[b.key] = b.value; return { ok: true, json: async () => [] }; }
  return { ok: true, json: async () => (key && settings[decodeURIComponent(key)] != null ? [{ value: settings[decodeURIComponent(key)] }] : []) };
};
const staged = { proposals: [
  { id: 's_1', type: 'vocab', list: 'done', word: 'kelar semua' },
  { id: 's_2', type: 'example', text: 'B3 lampu teras mati', intent: 'finding' },
  { id: 's_3', type: 'coaching', person: 'Ita', wa_num: '6281', key: 'ack_not_button', verdict: 'escalate', note: 'still replies "siap" instead of the button' },
  { id: 's_4', type: 'coaching', person: 'Putu', wa_num: '6282', key: 'proof_missing', verdict: 'reword', text: 'Foto dapur dan kamar mandi ya 🙏' },
  { id: 's_5', type: 'timing', person: 'Putu', wa_num: '6282', nudge_hour: 18 },
  { id: 's_6', type: 'vocab', list: 'ack', word: 'not approved' },
] };
const out = await applyStaffDecisions({ SUPABASE_URL: 'http://x', sbHeaders: {} }, staged, { approve: ['s_1', 's_2', 's_3', 's_4', 's_5'] });
globalThis.fetch = realFetch;
t('counts', [out.vocab, out.examples, out.coaching, out.timing], [1, 1, 2, 1]);
t('words land in staff_lang_extra', settings.staff_lang_extra, { done: ['kelar semua'] });
t('the unapproved word is not written', (settings.staff_lang_extra.ack || []).length, 0);
t('example stored', settings.staff_classifier_examples.map(e => [e.text, e.intent]), [['B3 lampu teras mati', 'finding']]);
t('reworded tip stored', settings.staff_coaching_overrides, { proof_missing: 'Foto dapur dan kamar mandi ya 🙏' });
t('reminder hour stored per number', settings.staff_profiles['6282'].nudge_hour, 18);
t('the escalation is a line for Era', out.era_lines, ['Ita: still replies "siap" instead of the button']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
