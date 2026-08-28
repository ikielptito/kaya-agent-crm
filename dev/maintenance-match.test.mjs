// Property matching: the unit number decides which OWNER gets billed, so
// these cases are about not guessing wrong.
import { pickProperty } from '../lib/maintenance.js';

const GROUPS = [
  { key: 'haus-1', name: 'HAUS Canggu – Unit 1', listing_slugs: ['haus-1'] },
  { key: 'haus-2-4', name: 'HAUS Canggu – Units 2 & 4', listing_slugs: ['haus-2', 'haus-4'] },
  { key: 'haus-5', name: 'HAUS Canggu – Unit 5', listing_slugs: ['haus-5'] },
  { key: 'lanehaus', name: 'LaneHAUS – Units 1 & 3', listing_slugs: ['lanehaus-1', 'lanehaus-3'] },
  { key: 'villa-saturno', name: 'Villa Saturno', listing_slugs: ['villa-saturno'] },
  { key: 'tropicana-b4', name: 'Tropicana Valley – Unit B4', listing_slugs: ['tropicana-b4'] },
];

let pass = 0, fail = 0;
const t = (name, text, expect) => {
  const got = pickProperty(GROUPS, text);
  const key = got?.ambiguous ? 'AMBIGUOUS' : (got ? (got.slug || got.group_key) : null);
  if (key === expect) { pass++; console.log(`  ok  ${name} → ${key}`); }
  else { fail++; console.log(`  FAIL ${name} → got ${key}, want ${expect}`); }
};

// The bug that started this: a price must never be read as a unit number.
t('price does not become a unit', 'the wardrobe door and patio chairs in haus canggu unit 5 need to be repaired. similar patio chairs are 1.1jt each.', 'haus-5');
t('plain unit reference', 'haus canggu unit 2 bathroom wall needs paint touch up', 'haus-2');
t('name then number', 'haus 5 kursi dapur patah', 'haus-5');
t('alphanumeric unit', 'tropicana b4 ac tidak dingin', 'tropicana-b4');
t('no unit number needed', 'villa saturno pompa kolam bocor', 'villa-saturno');
t('lanehaus unit', 'lanehaus unit 3 door handle broken', 'lanehaus-3');
t('rupiah amount ignored', 'villa saturno pump replacement rp 2.500.000', 'villa-saturno');
t('500rb ignored', 'haus canggu unit 4 kran bocor, ganti 500rb', 'haus-4');
t('group fallback when no unit given', 'villa saturno needs a new pool pump', 'villa-saturno');
t('unknown property', 'the thing in the place is broken', null);
t('bare number with no cue is not a unit', 'we replaced 2 lightbulbs somewhere', null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
