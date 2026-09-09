#!/usr/bin/env node
// Build lib/handbook.js — the Samba Handbook Maya reads.
//
// One generated module, assembled from the places the platform already
// explains itself: the owner and housekeeper guides, the pitch and legal
// pages, the cockpit's "How to use" essays, the statement glossary, the unit
// catalog, the SOP, and two hand-written system documents. Each section is
// tagged with the audiences allowed to see it; each audience gets a small,
// byte-stable digest for its prompt and can ask for a full section by key.
//
//   node dev/build-handbook.mjs            (portal at ../Samba Rentals)
//   SAMBA_PORTAL_DIR=/path node dev/build-handbook.mjs
//
// dev/handbook.test.mjs fails when a source changed and this was not re-run.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRM = path.resolve(HERE, '..');
const PORTAL = process.env.SAMBA_PORTAL_DIR || path.resolve(CRM, '..', 'Samba Rentals');
const OUT = path.join(CRM, 'lib', 'handbook.js');

if (!fs.existsSync(PORTAL)) { console.error(`portal repo not found at ${PORTAL} — set SAMBA_PORTAL_DIR`); process.exit(1); }

const SOURCES = {};
function read(repo, rel) {
  const p = path.join(repo === 'crm' ? CRM : PORTAL, rel);
  const s = fs.readFileSync(p, 'utf8');
  SOURCES[`${repo}:${rel}`] = crypto.createHash('sha256').update(s).digest('hex');
  return s;
}

// ── HTML → readable text ────────────────────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×', rarr: '→', larr: '←', bull: '•', copy: '©' };
const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? m);
function htmlToText(html, { bodyOnly = true } = {}) {
  let s = String(html);
  if (bodyOnly) { const m = s.match(/<body[^>]*>([\s\S]*)<\/body>/i); if (m) s = m[1]; }
  s = s.replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(h1|h2)\b[^>]*>/gi, '\n\n## ').replace(/<(h3|h4|h5)\b[^>]*>/gi, '\n\n### ');
  s = s.replace(/<\/(h1|h2|h3|h4|h5)>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ').replace(/<(p|div|tr|section|article|dt|dd|blockquote|figcaption)\b[^>]*>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(td|th)>/gi, ' | ').replace(/<[^>]+>/g, ' ');
  s = decode(s);
  s = s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').replace(/ \| *$/, '').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
const cap = (s, n = 14000) => s.length > n ? s.slice(0, n - 1) + '…' : s;

// ── Sources ─────────────────────────────────────────────────────────
const sections = {};
const add = (key, title, audience, text) => { sections[key] = { title, audience, text: cap(String(text || '').trim()) }; };

// Hand-written and guide sources (Markdown, read as-is).
add('owner.guide', 'Samba Owner Guide (full text)', ['owner', 'era', 'system'], read('portal', 'docs/handbook/owner-guide.md'));
add('staff.guide', 'Panduan Housekeeper Samba (Indonesian, full text)', ['staff', 'era', 'system'], read('portal', 'docs/handbook/housekeeper-guide.id.md'));
add('era.guide', 'Panduan Kesiapan Villa — Era’s readiness guide (full text)', ['era', 'system'], read('portal', 'docs/handbook/era-readiness-guide.md'));
add('system.portal', 'How sambarentals.com is built and wired', ['system', 'era'], read('portal', 'docs/handbook/system-portal.md'));
add('system.crm', 'How Maya is built and wired', ['system', 'era'], read('crm', 'docs/handbook/system-crm.md'));
add('books.guide', 'The Tropicana Valley Books — how the page and the model work (Ikiel and Oli)', ['era', 'system'], read('crm', 'docs/handbook/books-guide.md'));
add('whatsnew', 'What is new on Samba, by audience and date (the changelog)', ['owner', 'agent', 'staff', 'era', 'system'], read('crm', 'docs/handbook/changelog.md'));

// Public pages, stripped to text.
add('owner.pitch', 'For owners: how Samba works, pricing, FAQ (sambarentals.com/home)', ['owner', 'agent', 'era', 'system'], htmlToText(read('portal', 'public/list-property.html')));
add('agent.pitch', 'For agents: what the portal gives you, commission (sambarentals.com/for-agents)', ['agent', 'owner', 'era', 'system'], htmlToText(read('portal', 'public/for-agents.html')));
add('viewings.process', 'How viewings work, for agents and villas (sambarentals.com/viewings)', ['agent', 'owner', 'era', 'system'], htmlToText(read('portal', 'public/viewings.html')));
add('legal.terms', 'Terms of service (sambarentals.com/terms)', ['owner', 'agent', 'system'], htmlToText(read('portal', 'public/terms.html')));
add('legal.refund', 'Refund and cancellation policy (sambarentals.com/refund)', ['owner', 'agent', 'system'], htmlToText(read('portal', 'public/refund.html')));
add('legal.privacy', 'Privacy policy (sambarentals.com/privacy)', ['owner', 'agent', 'system'], htmlToText(read('portal', 'public/privacy.html')));

// The cockpit's "How to use" essays, one section per page.
{
  const src = read('portal', 'public/payouts.html');
  const block = src.slice(src.indexOf('const HELP = {'), src.indexOf('\n};', src.indexOf('const HELP = {')));
  const re = /^  ([a-z]+): \{ title: '([^']+)', html: `([\s\S]*?)` \},?$/gm;
  let m, n = 0;
  while ((m = re.exec(block))) { add(`era.cockpit.${m[1]}`, `Cockpit page: ${m[2]} (sambarentals.com/payouts)`, ['era', 'system'], htmlToText(m[3], { bodyOnly: false })); n++; }
  if (n < 8) throw new Error(`HELP parse found only ${n} pages`);
}

// The statement glossary: every tooltip on the owner's statement page.
{
  const src = read('portal', 'public/statement.html');
  const re = /tip\('([a-z_]+)', '((?:[^'\\]|\\.)*)'\)/g;
  const seen = new Map(); let m;
  while ((m = re.exec(src))) if (!seen.has(m[1])) seen.set(m[1], m[2].replace(/\\'/g, "'"));
  const NAMES = { gross: 'Rental income (gross)', fee: 'Samba Realty management fee', nett: 'Nett rental income', exp: 'Villa expenses', adj: 'Adjustments', payout: 'Total payout', hero: 'The statement', net: 'Net profit (expenses-only groups)', paid: 'Paid so far' };
  add('statement.glossary', 'What each line of a monthly statement means', ['owner', 'era', 'system'], [...seen].map(([k, v]) => `${NAMES[k] || k}: ${v}`).join('\n'));
}

// The 14 managed units and their prices.
{
  read('portal', 'lib/catalog.js');
  const { UNITS } = await import(pathToFileURL(path.join(PORTAL, 'lib/catalog.js')).href);
  const idr = (n) => n ? `IDR ${Number(n).toLocaleString('en-US')}` : '—';
  add('catalog.units', 'The 14 Samba-managed units (slug, type, monthly, yearly)', ['agent', 'owner', 'era', 'system'],
    UNITS.map(u => `${u.name} (${u.slug}) — ${u.unitType || 'unit'}; monthly ${idr(u.monthly)}; yearly ${idr(u.yearly)}${u.yearly2 ? `; two-year ${idr(u.yearly2)}` : ''}`).join('\n'));
}

// The housekeeping SOP, straight from the module the staff Q&A uses.
{
  read('crm', 'lib/staff-help.js');
  const { SOP } = await import(pathToFileURL(path.join(CRM, 'lib/staff-help.js')).href);
  add('staff.sop', 'Housekeeping SOP (Indonesian) — the rules the housekeepers and Era work to', ['staff', 'era', 'system'], SOP);
}

// Who Maya is, from the persona spec (identity and voice only).
{
  const spec = read('crm', 'PERSONA_SPEC.md');
  const from = spec.indexOf('## 1. Identity'), to = spec.indexOf('## 4. Knowledge Boundaries');
  add('persona.identity', 'Who Maya is: identity, disclosure, voice', ['system'], spec.slice(from, to > from ? to : undefined));
}

// ── Generated system map (from code; not hashed — code changes daily) ─
function listJs(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort() : []; }
function headerOf(src) {
  const lines = src.split('\n');
  const out = [];
  for (const l of lines) { if (l.startsWith('//')) out.push(l.replace(/^\/\/ ?/, '')); else if (out.length) break; else if (l.trim() && !l.startsWith('#!')) break; }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}
function actionsOf(src) {
  const set = new Set();
  for (const m of src.matchAll(/action === '([a-z0-9_\/-]+)'/g)) set.add(m[1]);
  for (const m of src.matchAll(/case '([a-z0-9_\/-]+)':/g)) set.add(m[1]);
  return [...set].sort();
}
{
  const routes = [];
  for (const [label, repo] of [['CRM', CRM], ['portal', PORTAL]]) {
    for (const f of listJs(path.join(repo, 'api'))) {
      const src = fs.readFileSync(path.join(repo, 'api', f), 'utf8');
      const acts = actionsOf(src);
      routes.push(`${label} api/${f} — ${headerOf(src) || '(no header)'}${acts.length ? `\n  actions: ${acts.join(', ')}` : ''}`);
    }
  }
  add('system.routes', 'Every API file in both repos, its purpose and its actions (generated from code)', ['system'], routes.join('\n'));

  const crons = [];
  for (const [label, repo] of [['CRM', CRM], ['portal', PORTAL]]) {
    const vj = JSON.parse(fs.readFileSync(path.join(repo, 'vercel.json'), 'utf8'));
    for (const c of (vj.crons || [])) {
      const [min, hour] = c.schedule.split(' ');
      const wita = /^\d+$/.test(hour) ? `${String((Number(hour) + 8) % 24).padStart(2, '0')}:${String(min).padStart(2, '0')} WITA` : `every hour at :${String(min).padStart(2, '0')} WITA`;
      crons.push(`${label} ${c.path} — cron "${c.schedule}" (UTC) = ${wita}`);
    }
  }
  add('system.crons', 'Scheduled jobs in both repos, with Bali times (generated)', ['system'], crons.join('\n'));

  const keys = new Set();
  for (const dir of ['lib', 'api']) for (const f of listJs(path.join(CRM, dir))) {
    const src = fs.readFileSync(path.join(CRM, dir, f), 'utf8');
    for (const m of src.matchAll(/getSettingValue\(db, '([^']+)'\)/g)) keys.add(m[1]);
    for (const m of src.matchAll(/settings\?key=eq\.([a-zA-Z0-9_]+)/g)) keys.add(m[1]);
  }
  add('system.settings', 'Settings keys the CRM reads (generated): each is a row in the settings table', ['system'], [...keys].sort().join('\n'));

  const env = {};
  for (const [label, repo] of [['CRM', CRM], ['portal', PORTAL]]) {
    const set = new Set();
    for (const dir of ['lib', 'api']) for (const f of listJs(path.join(repo, dir))) {
      const src = fs.readFileSync(path.join(repo, dir, f), 'utf8');
      for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) set.add(m[1]);
    }
    env[label] = [...set].sort();
  }
  add('system.env', 'Environment variables each repo reads (generated; values never listed)', ['system'], Object.entries(env).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n\n'));

  const links = [];
  for (const [label, repo] of [['portal', PORTAL], ['CRM', CRM]]) {
    const pth = path.join(repo, 'lib', 'tokens.js');
    if (!fs.existsSync(pth)) continue;
    const src = fs.readFileSync(pth, 'utf8').split('\n');
    src.forEach((l, i) => { const m = l.match(/^export function (\w+)/); if (m) { let j = i - 1, c = []; while (j >= 0 && src[j].startsWith('//')) { c.unshift(src[j].replace(/^\/\/ ?/, '')); j--; } links.push(`${label} ${m[1]}() — ${c.join(' ').slice(0, 200)}`); } });
  }
  add('system.links', 'Signed-link helpers in both repos (generated)', ['system'], links.join('\n'));
}

// ── Digests: the facts each audience carries in its prompt ──────────
// Hand-curated, byte-stable, no dates. When a source page changes, the
// freshness test fails and these lines get re-checked by a person.
const FACTS = {
  agent: [
    'Samba Rentals (sambarentals.com) is free for agents: no card, no fee, and the agent keeps the full 10% commission, never split. Rent is quoted with the agent\'s 10% already inside it.',
    'The agent portal: live availability synced with owners, one clean listing link per villa, branded share pages that show only the agent\'s name, photo and WhatsApp (Samba\'s contact appears nowhere), one-tap 1080×1920 Instagram stories, favourites, client shortlists in one link, and the agent\'s own view and enquiry numbers. Sign in with Google at sambarentals.com; the account also works in the WhatsApp/Instagram in-app browsers after opening in the real browser.',
    'Viewings: the agent asks Maya, Maya asks the villa, nothing is confirmed until the villa taps Confirm; both sides get a calendar invite and a reminder on the day; the villa side only ever sees that "an agent" asked, never the client. Details: sambarentals.com/viewings.',
    'Owners list on Samba for IDR 150,000 per villa per month (billed as US$9.50); the first 25 villas list free with code FOUNDING25. Owners are never charged commission. Details: sambarentals.com/home.',
    'Samba-managed units (HAUS Canggu 1/2/4/5, LaneHAUS 1/3, Villa Saturno, Tropicana Valley A4/A5/B2/B3/B4/B5/B6) are handled by Era on the ground; everything else is listed by its owner or manager, who is the "enquire with" contact.',
  ],
  owner: [
    'Marketplace listing: IDR 150,000 per villa per month, billed as US$9.50 in advance by Creem (merchant of record), cancel anytime, the listing stays live to the end of the paid period; partial months are generally non-refundable. The first 25 villas list free with code FOUNDING25. No commission, no booking fees, ever. Listings are reviewed by Ikiel before they appear; owners can unpublish anytime from the portal.',
    'Owner portal at sambarentals.com/portal: sign in with Google, or type the WhatsApp number on file on the sign-in page and a one-tap link arrives on WhatsApp (valid 10 minutes); Maya can also send that link when asked (action "login_link"). The session lasts 30 days. Tabs: My properties, Weekly reports, Statements, Maintenance, Housekeeping, Viewings. Co-owners get their own sign-in on the same villa (ask Ikiel).',
    'Managed villas (Samba Realty full management, invite-only): Samba collects the bookings and pays a monthly payout; the management fee is a percentage of gross rental income (10% on most units, 15–20% on some, per the agreement) and nothing else; repair costs pass through at cost; a month in deficit is covered by Samba and carried into the next statement. Statements arrive on WhatsApp when published and can be downloaded as Excel.',
    'Managed housekeeping: cleaned twice a week on fixed days, a turnover clean the day a guest leaves and a preparation clean before arrival, a seven-spot photo check before every guest that Maya verifies, a photo inspection round every fortnight on the Monday report, a deep clean every three months and the day after any stay of three weeks or more, a stocked consumables box and spare sofa covers, a ten-item minimum kit. Every check and inspection is kept permanently with photos; owners download any record as a PDF for a damage claim.',
    'Repairs: every problem is a ticket with its own page (the "View details" link). Nothing is spent without the owner: an Approval asks them to approve a cost; a Notice is routine work already scheduled; a Heads-up is something our team found and is still pricing. Owners can decline and use their own contractor. Completed work appears as an expense on that month\'s statement.',
    'Weekly report every Monday on WhatsApp: views and enquiries, agents reached, occupancy and upcoming stays, how the villa compares, the fortnightly inspection with photos, suggested next steps. The report link always shows the latest week.',
    'People: Era is the villa manager on the ground (guests, housekeepers, repairs, supplies), +62 812 4635 7778. Ikiel handles pricing, agreements, statements and anything commercial. Maya is software run by the team and says so if asked; she never spends money, changes prices or messages guests.',
  ],
  staff: [
    'Panduan lengkap untuk housekeeper: sambarentals.com/guides/Panduan-Housekeeper-Samba.pdf. Pertanyaan tentang jadwal, gaji, atau siapa membeli apa: ke Era (+62 812 4635 7778).',
    'Pemilik villa bisa melihat setiap catatan kebersihan dan foto di portalnya, jadi setiap kunjungan harus ditandai selesai dan setiap foto harus dikirim.',
  ],
  era: [
    'Cockpit at sambarentals.com/payouts (sign in with your WhatsApp link, 30-day session): Payouts, one statement, Maintenance, Earnings, Payroll, Properties, Schedule, Records, Team. Each page has a "How to use" guide (handbook keys era.cockpit.*). Statements sync from your Google Sheets; publish sends the owner the statement on WhatsApp; mark Paid after the transfer.',
    'Maintenance flow: new ticket → add a cost and choose "Ask the owner to approve" or "Routine: just tell them" → Publish; or "Tell the owner now, cost to follow" (heads-up). Approved → assign a tukang (Maya sends the job sheet and tells you at every step) → Done with a photo. "Wrong villa" moves a ticket. Replying to Maya\'s backlog nudge with "#4 done", "#8 waiting until 12 Sep", "#15 estimate 85,000" updates tickets; Undo buttons reverse a mistake.',
    'Housekeeping: the schedule is derived hourly from the booking calendar (letters R regular, T turnover, P pre-arrival, I inspection, D deep clean). Housekeepers get their day at 09:00 with three buttons, a 17:00 chase if a visit is not marked done, and you hear at 19:00 what is still open. Pre-guest photo checks are verified by Maya; you hear only the exceptions ("Needs a look" / "Not checked"). Deep clean every 90 days and after a 21-night stay; inspection every 14 days. Records keep every check and inspection with photos; "Share as PDF" gives a no-login link.',
    'Owners see, in their portal: statements, weekly reports, repair tickets, and the housekeeping log with photos (never staff names). Owner-facing messages come from Maya; a human reply from the console is signed with your name.',
    'Money and payroll are cockpit actions, never WhatsApp: publishing a statement, recording a payment, publishing or paying a payroll run, bank details. Anything commercial or a dispute goes to Ikiel.',
    'Samba-managed units: HAUS Canggu 1/2/4/5 (Putu), LaneHAUS 1/3 (Ana), Villa Saturno (Naomi), Tropicana Valley A4/A5/B4 (Ita), Tropicana B2/B3/B5/B6 (Gede). HAUS Canggu and Tropicana B2/B3/B5/B6 cleaning is paid outside Samba. Tropicana B2/B3/B5/B6 are co-owned with Oli (Double 8), expenses-only statements.',
    'Every morning (08:05 by default; Era can say "kirim jam 7" and Maya changes it) Maya sends the day in four lines with an "Open today" button: the page shows guests by villa, cleaning by housekeeper (📷 marks a photo check), rounds, tukang visits, the tickets waiting (tap one to open the Maintenance page), yesterday\'s loose ends and the week ahead; ?d= in the link shows another day. During the day Maya sends one line per schedule change (new, moved, gone, new or cancelled arrival). The backlog nudge then comes at 12, 15 and 18.',
    'Expenses: tell Maya what you paid — "laundry HAUS 5 250rb", "beli galon 3x untuk Saturno 60rb" — and send the receipt photo right after. It lands on that month\'s draft statement (flagged "via Maya"), or waits and is added when the draft is built from your sheet, skipping anything the sheet already has; the receipt is filed under Invoices & receipts. The sheet stays the record: still write it there at month end; Maya spots the duplicate so nothing is counted twice. A month already published becomes a change request for Ikiel.',
    'What Maya can do for you in this chat: answer from the schedule, bookings, tickets, statements, payroll, staff list, viewings and the app guides; apply small changes at once with an Undo button (a visit done, moved, reassigned or added; a ticket estimate, note, move to another villa, or waiting-until); stage anything that reaches another person behind a Yes/No button (publish or heads-up to an owner, dispatch a tukang, complete a ticket, message a housekeeper, a statement line); offer a list to tap when a target is ambiguous. "Maya, diam" pauses her 12 hours, "Maya, lanjut" resumes. New features are announced here as they ship; ask "what\'s new" for the changelog.',
  ],
  system: [
    'Two repos: the CRM (Maya, Vercel + Supabase, WhatsApp Cloud API, Anthropic models) and the portal (sambarentals.com, Vercel + Upstash KV + Hostex + Google Drive, dependency-free). Push to main deploys either. Vercel Hobby caps the portal at 12 functions, hence ?action= routing.',
    'The portal signs every no-login link (report /r/, statement /st/, repair /m/, job /j/, invite, preview, record PDF, calendar feed) with the shared sync secret; links do not expire and each exposes exactly one thing. The same secret authenticates portal↔CRM calls. The console key authenticates the chat console and on-demand API; a staff-scoped key gives Era the Staff tab.',
    'Roles: Ikiel admin (everything), Era era (whole cockpit, no /admin), Oli double8 (payroll for Double 8 only), owners and agents share one portal account type (Google or WhatsApp sign-in, 30-day session).',
    'Maya routes each inbound message in order: duplicate guard → team numbers (relay answers, team questions, statement changes, backlog replies, fault reports, SOP questions) → staff roster (tukang, onboarding, photo checks, inspections, cleaning replies, fault reports, questions) → owners (owner mode with statements/housekeeping/maintenance/report/handbook/import/intake actions) → agents (sales mode with need_availability/handbook actions and send/relay/viewing side effects).',
    'Crons (UTC): 01:00/01:20/01:40 morning waves, hourly :05 relay sweep + housekeeping derivation + Era nudge (9/12/15/18 WITA) + evening chase (17/19 WITA), 00:30 statement sync, Sunday review; portal 00:50 digest warm-up. Dry runs: preview_reply, preview_owner_reply, preview_team_reply, hk_chase_preview, hk_sweep_preview, maint_sweep_preview.',
    'Spend and delivery: daily reply cap, Opus cap, console assistant cap, team assistant cap; every recurring send is a campaign with a daily cap and pause switch in the Campaign Command Center; Meta templates must be approved before a sweep uses them; the WhatsApp number is on Meta tier TIER_250 (250 business conversations a day).',
  ],
};

const AUDIENCES = ['agent', 'owner', 'staff', 'era', 'system'];
const digests = {};
for (const a of AUDIENCES) {
  const index = Object.keys(sections).sort().filter(k => sections[k].audience.includes(a)).map(k => `${k} — ${sections[k].title}`);
  digests[a] = `SAMBA HANDBOOK — facts you can state confidently:\n${(FACTS[a] || []).map(f => `• ${f}`).join('\n')}\n\nHANDBOOK SECTIONS available by key (ask for one, action "handbook" with handbook_key, when a question needs the exact wording, a policy, a price list or a how-to):\n${index.map(l => `• ${l}`).join('\n')}`;
}

// ── Emit ────────────────────────────────────────────────────────────
const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
const out = `// GENERATED by dev/build-handbook.mjs — do not edit by hand.
// The Samba Handbook: what Maya knows about the platform, by audience.
// Rebuild after changing any file listed in SOURCES; dev/handbook.test.mjs
// fails when a source moved without a rebuild.

export const SECTIONS = ${JSON.stringify(sorted(sections), null, 1)};

export const SOURCES = ${JSON.stringify(sorted(SOURCES), null, 1)};

export const DIGESTS = ${JSON.stringify(sorted(digests), null, 1)};

export const AUDIENCES = ${JSON.stringify(AUDIENCES)};

export function handbookIndex(audience) {
  return Object.keys(SECTIONS).filter(k => SECTIONS[k].audience.includes(audience)).map(k => ({ key: k, title: SECTIONS[k].title }));
}
export function handbookSection(key, audience = null) {
  const s = SECTIONS[String(key || '').trim()];
  if (!s) return null;
  if (audience && !s.audience.includes(audience)) return null;
  return { key: String(key).trim(), title: s.title, text: s.text };
}
export function handbookDigest(audience) {
  return DIGESTS[audience] || '';
}
`;
fs.writeFileSync(OUT, out);
const size = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.text.length]));
console.log(`wrote ${path.relative(CRM, OUT)}: ${Object.keys(sections).length} sections, ${Object.keys(SOURCES).length} sources`);
for (const a of AUDIENCES) console.log(`  digest ${a.padEnd(7)} ${digests[a].length} chars`);
console.log('  sections:', JSON.stringify(size));
