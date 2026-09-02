// The prompt Maya sees: short cards for the whole portfolio, full detail only
// for the villas in play, the agent's memory ahead of the thread, and the
// judgement model on the turns that need it.
import { relevantRentalSlugs, needsJudgement, buildRentalsContext, buildRentalDetails, pickReplyModel, setOpusSpentToday } from '../api/whatsapp-webhook.js';
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
