// The staff console key: what it opens and, more importantly, what it does not.
//
// Era's Maya app authenticates with CONSOLE_SECRET_STAFF. Every router that
// only knows consoleAuthorized() must refuse it outright, and the two routers
// that admit it (supabase, whatsapp-send) must see scope 'staff' so they can
// filter to roster numbers. A regression here shows Era the agent inbox.
import { consoleScope, consoleAuthorized, staffActionAllowed } from '../lib/auth.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const req = (key, bearer) => ({ headers: { ...(key ? { 'x-console-key': key } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) } });

process.env.CONSOLE_SECRET = 'primary-key-000000000000';
process.env.CONSOLE_SECRET_2 = 'second-key-0000000000000';
process.env.CONSOLE_SECRET_STAFF = 'staff-key-00000000000000';
process.env.LISTING_SYNC_SECRET = 'sync-secret-000000000000';

t('primary key is full', consoleScope(req('primary-key-000000000000')), 'full');
t('second key is full', consoleScope(req('second-key-0000000000000')), 'full');
t('portal sync bearer is full', consoleScope(req(null, 'sync-secret-000000000000')), 'full');
t('staff key is staff', consoleScope(req('staff-key-00000000000000')), 'staff');
t('staff key as bearer is staff', consoleScope(req(null, 'staff-key-00000000000000')), 'staff');
t('wrong key is null', consoleScope(req('nope')), null);
t('no key is null', consoleScope(req()), null);

// The default gate: staff is NOT authorized. This is what keeps /api/claude,
// /api/campaigns, /api/statements, /api/payroll… closed to Era's key without
// each of them knowing the scope exists.
t('consoleAuthorized: full key', consoleAuthorized(req('primary-key-000000000000')), true);
t('consoleAuthorized: staff key refused', consoleAuthorized(req('staff-key-00000000000000')), false);

// Staff key unset → nobody gets staff scope by accident.
delete process.env.CONSOLE_SECRET_STAFF;
t('unset staff secret: staff key is null', consoleScope(req('staff-key-00000000000000')), null);
process.env.CONSOLE_SECRET_STAFF = 'staff-key-00000000000000';

// Legacy: no primary secret at all → open, full (local dev).
delete process.env.CONSOLE_SECRET;
t('no CONSOLE_SECRET: open, full', consoleScope(req()), 'full');
process.env.CONSOLE_SECRET = 'primary-key-000000000000';

// The staff allowlist on /api/supabase.
for (const a of ['console_scope', 'get_staff', 'get_messages', 'get_number_messages', 'upload_file', 'sign_upload']) t(`staff may: ${a}`, staffActionAllowed(a), true);
for (const a of ['get_agents', 'get_owners', 'get_owner_messages', 'owner_send', 'set_settings', 'get_settings', 'assistant', 'execute_broadcast', 'save_push_subscription', 'suggest_reply', 'translate', 'get_maya_review', 'patch_agent', '']) t(`staff may not: ${a || '(empty)'}`, staffActionAllowed(a), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
