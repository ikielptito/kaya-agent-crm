// WhatsApp number normalisation for the staff registry.
//
// This is the difference between Maya reaching a housekeeper and silently
// never reaching her. Era reads numbers off her phone, where an Indonesian
// mobile is saved as "0813…"; Ikiel pastes "+62 813-…"; the webhook always
// reports "62813…". All three are one person, and a row stored in the local
// form matches no inbound message and receives no outbound one.
import { normalizeWa } from '../lib/staff.js';

let pass = 0, fail = 0;
const t = (name, input, expect) => {
  const got = normalizeWa(input);
  if (got === expect) { pass++; console.log(`  ok  ${name} → ${got}`); }
  else { fail++; console.log(`  FAIL ${name} → got ${got}, want ${expect}`); }
};

// The real roster, in the formats Ikiel actually sent them.
t('spaced international', '+62 858-4716-3053', '6285847163053');
t('already canonical', '6282341079324', '6282341079324');
t('parenthesised', '+62 (812) 3769-2282', '6281237692282');

// The duplicate that prompted this: same person, two formats.
t('local 0 form', '0813 5555 1234', '6281355551234');
t('local 0 form, no spaces', '081355551234', '6281355551234');
t('international form of the same', '+62 813-5555-1234', '6281355551234');

// Stray zero after the country code, the way Villa Tiga's contact was stored.
t('620 stray zero', '620812 3674 4565', '6281236744565');

// Bare mobile with no country code and no leading zero.
t('bare 8 mobile', '81236744565', '6281236744565');
t('bare 87 mobile', '87862135047', '6287862135047');

// Foreign numbers must survive untouched: Katie is Australian and an owner
// contact list is not all Indonesian.
t('australian', '+61 421 737 687', '61421737687');
t('hong kong', '+852 9123 4567', '85291234567');

// Junk in, empty out, so a blank field is rejected rather than stored.
t('empty', '', '');
t('no digits', '  -- ', '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
