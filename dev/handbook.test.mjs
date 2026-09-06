// The handbook is generated; this pins that it is current and small.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SECTIONS, SOURCES, DIGESTS, AUDIENCES, handbookSection, handbookIndex } from '../lib/handbook.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRM = path.resolve(HERE, '..');
const PORTAL = process.env.SAMBA_PORTAL_DIR || path.resolve(CRM, '..', 'Samba Rentals');

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); } };

// Freshness: every source hashes to what the build saw.
if (!fs.existsSync(PORTAL)) {
  console.log(`  SKIP freshness — portal repo not at ${PORTAL} (set SAMBA_PORTAL_DIR)`);
} else {
  let stale = [];
  for (const [id, hash] of Object.entries(SOURCES)) {
    const [repo, rel] = id.split(/:(.+)/);
    const p = path.join(repo === 'crm' ? CRM : PORTAL, rel);
    const now = fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8')).digest('hex') : 'missing';
    if (now !== hash) stale.push(id);
  }
  t('every handbook source is unchanged since the build (else: node dev/build-handbook.mjs)', !stale.length, stale.join(', '));
}

// Size: the digests ride in prompts.
const CEIL = { agent: 3600, owner: 4000, staff: 3000, era: 4000, system: 6000 };
for (const a of AUDIENCES) t(`${a} digest ≤ ${CEIL[a]} chars`, DIGESTS[a].length <= CEIL[a], `(${DIGESTS[a].length})`);
t('no digest carries a date', !AUDIENCES.some(a => /\b20\d\d-\d\d-\d\d\b/.test(DIGESTS[a])));

// Required keys and audience scoping.
for (const k of ['owner.pitch', 'legal.refund', 'agent.pitch', 'viewings.process', 'era.cockpit.cleaning', 'statement.glossary', 'catalog.units', 'system.crm', 'system.portal', 'owner.guide', 'staff.guide', 'staff.sop']) t(`section ${k} exists`, !!SECTIONS[k]);
t('owners cannot read the cockpit essays', handbookSection('era.cockpit.list', 'owner') === null);
t('era can', !!handbookSection('era.cockpit.list', 'era'));
t('agents do not see the SOP', !handbookIndex('agent').some(x => x.key === 'staff.sop'));
t('every section is under 14,001 chars', Object.values(SECTIONS).every(s => s.text.length <= 14001));
t('the catalog names all 14 units', (SECTIONS['catalog.units'].text.match(/\n/g) || []).length === 13);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
