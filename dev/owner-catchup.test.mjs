// Owner catch-up: who gets picked up, when a reply may be sent, and the
// dual-role prompt block for an owner who is also an agent.
import { isOwnerCatchupCandidate, windowOpen, catchupOutcome } from '../lib/owner-catchup.js';
import { dualRoleBlock } from '../lib/owner-dual-role.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const since = '2026-09-01T00:00:00Z';
const dony = { id: 148, paused: false, last_inbound_at: '2026-09-05T02:32:49+00:00', unread_count: 0,
  suggested_reply: '[Maya (owner) failed: You have reached your specified API usage limits — reply manually.]' };

t('failed marker is a candidate even with unread 0', isOwnerCatchupCandidate(dony, since), true);
t('unread owner is a candidate', isOwnerCatchupCandidate({ ...dony, suggested_reply: '', unread_count: 2 }, since), true);
t('answered owner (no unread, real draft) is not', isOwnerCatchupCandidate({ ...dony, suggested_reply: 'Hi Pak Dony…' }, since), false);
t('paused owner is never touched', isOwnerCatchupCandidate({ ...dony, paused: true }, since), false);
t('old inbound is out of range', isOwnerCatchupCandidate({ ...dony, last_inbound_at: '2026-08-20T00:00:00Z' }, since), false);
t('no inbound at all is not', isOwnerCatchupCandidate({ ...dony, last_inbound_at: null }, since), false);

const now = Date.parse('2026-09-05T04:00:00Z');
t('window open at 23h', windowOpen('2026-09-04T05:00:00Z', now), true);
t('window closed at 25h', windowOpen('2026-09-04T03:00:00Z', now), false);

t('outcome: sent', catchupOutcome({ suggested_reply: '', unread_count: 0 }), 'sent');
t('outcome: drafted', catchupOutcome({ suggested_reply: 'Hi Pak Dony', unread_count: 1 }), 'drafted');
t('outcome: failed again', catchupOutcome({ suggested_reply: '[Maya (owner) failed: overloaded — reply manually.]', unread_count: 1 }), 'failed_again');
t('outcome: unchanged', catchupOutcome({ suggested_reply: '', unread_count: 1 }), 'unchanged');

t('dual-role: nothing without an agent row', dualRoleBlock(null), '');
const block = dualRoleBlock({ id: 10061, name: 'Dony Bambang Bigwanto', agency: null });
t('dual-role: names the agent', block.includes('(Dony Bambang Bigwanto)'), true);
t('dual-role: both sides of the 10%', block.includes('OWNER side') && block.includes('AGENT side'), true);
t('dual-role: agency joins the name', dualRoleBlock({ id: 1, name: 'Bambang', agency: 'Brighton' }).includes('(Bambang · Brighton)'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
