// The prompt Maya sees: short cards for the whole portfolio, full detail only
// for the villas in play, the agent's memory ahead of the thread, and the
// judgement model on the turns that need it.
import { relevantRentalSlugs, needsJudgement, buildRentalsContext, buildRentalDetails, pickReplyModel, setOpusSpentToday, intakeSlugFor } from '../api/whatsapp-webhook.js';
import { memoryDue, memoryBlock } from '../lib/agent-memory.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};
const rentals = [
  { slug: 'villa_saturno', name: 'Villa Saturno', area: 'Canggu', beds: 3, monthly_rate_idr: 35e6, property_type: 'Villa', amenities: 'private pool, garden, enclosed living', extended_info: 'Long detail A', maya_notes: 'negotiation floor 30jt' },
  { slug: 'haus-1', name: 'HAUS Canggu – Unit 1', area: 'Canggu', beds: 1, monthly_rate_idr: 18e6, property_type: 'Apartment', amenities: 'shared pool', extended_info: 'Long detail B' },
  { slug: 'lanehaus-1', name: 'LaneHAUS – Unit 1', area: 'Pererenan', beds: 2, monthly_rate_idr: 24e6, property_type: 'Townhouse', amenities: 'pool', extended_info: 'Long detail C' },
];
// mentions
t('villa named in the thread is in play', relevantRentalSlugs(rentals, { thread: 'Agent: does villa saturno have an oven?' }), ['villa_saturno']);
t('slug form is recognised', relevantRentalSlugs(rentals, { inbound: 'is lanehaus 1 free?' }), ['lanehaus-1']);
// brief fit
t('brief pulls in fits under budget with enough beds', relevantRentalSlugs(rentals, { brief: { budget_max_month: '27jt', beds: '2', area: 'Pererenan' } }), ['lanehaus-1']);
t('budget in raw IDR works too', relevantRentalSlugs(rentals, { brief: { budget_max_month: '40000000', beds: '1' } }).sort(), ['haus-1', 'lanehaus-1', 'villa_saturno']);
t('nothing in play → nothing', relevantRentalSlugs(rentals, { thread: 'hi' }), []);
// The villa under discussion outranks the card burst (Villa Bissli, 9 Sep 2026)
const many = Array.from({ length: 8 }, (_, i) => ({ slug: `unit_${i}`, name: `Unit ${i}`, area: 'Canggu', beds: 1, monthly_rate_idr: 20e6, property_type: 'Apartment' }));
const bissli = { slug: 'villa_bissli', name: 'Villa Bissli', area: 'Umalas', beds: 3, yearly_rate_idr: 300e6, property_type: 'Villa', maps_url: 'https://maps.example/bissli' };
const burst = 'Maya: [Sent 8 listing cards: Unit 0, Unit 1, Unit 2, Unit 3, Unit 4, Unit 5, Unit 6, Unit 7]\nAgent: how much is villa bissli?\nMaya: Villa Bissli is 300M/year';
t('latest-mentioned villa survives the cap', relevantRentalSlugs([...many, bissli], { thread: burst, inbound: 'ada lokasinya kak?' })[0], 'villa_bissli');
t('a villa named in the inbound ranks first', relevantRentalSlugs([...many, bissli], { thread: burst, inbound: 'is unit 3 free?' })[0], 'unit_3');
t('cap still holds', relevantRentalSlugs([...many, bissli], { thread: burst }).length, 6);
// yearly-only rate is a rate, not a gap
const yo = buildRentalsContext([bissli]);
t('yearly-only short card quotes the yearly figure', yo.includes('IDR 300M/year') && yo.includes('YEARLY ONLY') && !yo.includes('rate TBC'), true);
t('yearly-only detail block carries the map link', buildRentalDetails([bissli], ['villa_bissli']).includes('map: https://maps.example/bissli'), true);
t('no rate at all still reads TBC', buildRentalsContext([{ slug: 'x', name: 'Villa X' }]).includes('rate TBC'), true);
// cards vs detail
const head = buildRentalsContext(rentals);
t('short cards carry the rate and beds', head.includes('3 bed') && head.includes('IDR 35M/month'), true);
t('short cards omit long detail', head.includes('Long detail A'), false);
t('short cards keep a negotiation note', head.includes('negotiation floor'), true);
const det = buildRentalDetails(rentals, ['villa_saturno']);
t('detail block carries the long detail for the villa in play', det.includes('Long detail A') && !det.includes('Long detail B'), true);
t('no slugs → no detail block', buildRentalDetails(rentals, []), '');
// judgement routing
const agentBrief = { conversation_history: { brief: { budget_max_month: '27jt', beds: '2' } } };
t('brief + numbers → judgement', needsJudgement('they can stretch to 30jt for the right one', agentBrief), true);
t('three criteria in one message → judgement', needsJudgement('2 bedroom villa with pool in Canggu, budget 30jt', {}), true);
t('negotiation → judgement', needsJudgement('can the owner go lower?', {}), true);
t('thanks → not judgement', needsJudgement('thank you!', {}), false);
t('default model is Sonnet 5', pickReplyModel('thanks', { agent: {} }), 'claude-sonnet-5');
t('judgement model is Opus 4.8', pickReplyModel('budget 30jt, 2 bedrooms, pool, Canggu', { agent: {} }), 'claude-opus-4-8');
setOpusSpentToday(99);
t('past the Opus ceiling, judgement turns fall back to Sonnet', pickReplyModel('budget 30jt, 2 bedrooms, pool, Canggu', { agent: {} }), 'claude-sonnet-5');
setOpusSpentToday(0);
// memory
t('short thread has no memory due', memoryDue({ conversation_history: { total_messages: 20 } }), false);
t('long thread without memory is due', memoryDue({ conversation_history: { total_messages: 60 } }), true);
t('fresh memory is not due', memoryDue({ conversation_history: { total_messages: 60, memory: { text: 'x', at_total: 50, at: new Date().toISOString() } } }), false);
t('month-old memory is due', memoryDue({ conversation_history: { total_messages: 60, memory: { text: 'x', at_total: 55, at: '2026-07-01T00:00:00Z' } } }), true);
t('stale memory is due', memoryDue({ conversation_history: { total_messages: 66, memory: { text: 'x', at_total: 50 } } }), true);
t('memory block renders', memoryBlock({ conversation_history: { memory: { text: 'Paul brings families.' } } }).includes('Paul brings families.'), true);
t('no memory → empty block', memoryBlock({}), '');
// owner intake: which slug a submission without one goes to (BAM, 9 Sep 2026)
t('a second villa with its own name gets no slug (new listing)', intakeSlugFor({ name: 'Berawa Loft' }, ['villa-hawk']), '');
t('the known villa resubmitted by name reuses its slug', intakeSlugFor({ name: 'Villa Hawk' }, ['villa-hawk']), 'villa-hawk');
t('a numbered slug still matches its base name', intakeSlugFor({ name: 'Casa Suhana' }, ['casa-suhana-2']), 'casa-suhana-2');
t('a nameless update (photos only) goes to the one known villa', intakeSlugFor({ photosLink: 'x' }, ['villa-hawk']), 'villa-hawk');
t('a slug Maya gives is kept', intakeSlugFor({ slug: 'villa-hawk', name: 'Berawa Loft' }, ['villa-hawk']), 'villa-hawk');
t('two known villas and no slug → new listing', intakeSlugFor({ name: 'Villa Hawk' }, ['villa-hawk', 'berawa-loft']), '');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
