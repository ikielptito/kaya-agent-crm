// Tukang dispatch: the two things that decide whether a tradesman turns up
// at the right villa at the right hour.
//
// 1. The time label he reads. Everyone is in WITA, so the only question is
//    whether the conversion and the language are right — a job shown as
//    "09:00" when we meant 17:00 wastes his day and the tenant's.
// 2. His reply. The deterministic branches must hold without a model call,
//    because the LLM path is the one that fails when the API key is missing
//    and "sudah" must still close a job.
import { witaLabel, witaLabelId } from '../lib/maintenance-dispatch.js';
import { parseTukangReply } from '../lib/maintenance-intake.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};

// ── Time labels ──────────────────────────────────────────────────────
// 01:00Z is 09:00 in Bali. Getting the sign wrong here would be invisible
// in testing from Europe and obvious to everyone standing in Canggu.
t('English label for Era', witaLabel('2026-09-02T01:00:00.000Z'), 'Wednesday 2 September, 09:00 WITA');
t('Indonesian label for the tukang', witaLabelId('2026-09-02T01:00:00.000Z'), 'Rabu, 2 September, pukul 09:00 WITA');

// An evening slot that crosses midnight UTC must still read as the same
// Bali evening, not the next morning.
t('evening slot stays on its own day', witaLabelId('2026-09-02T11:00:00.000Z'), 'Rabu, 2 September, pukul 19:00 WITA');
t('late slot crossing UTC midnight', witaLabel('2026-09-02T16:30:00.000Z'), 'Thursday 3 September, 00:30 WITA');

t('no time yet', witaLabel(null), null);
t('no time yet, Indonesian', witaLabelId(null), null);

// ── His replies, without a model ─────────────────────────────────────
const intentOf = async (s) => (await parseTukangReply(s, { itemTitle: 'Pompa kolam' })).intent;

t('sudah closes the job', await intentOf('sudah'), 'done');
t('selesai closes the job', await intentOf('selesai'), 'done');
t('beres closes the job', await intentOf('beres'), 'done');
t('done in English', await intentOf('done'), 'done');
t('otw is an arrival', await intentOf('otw'), 'arrived');
t('sampai is an arrival', await intentOf('sampai'), 'arrived');
t('tidak bisa is a decline', await intentOf('tidak bisa'), 'decline');
t('gak bisa is a decline', await intentOf('gak bisa'), 'decline');
t('empty is a note', await intentOf(''), 'note');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
