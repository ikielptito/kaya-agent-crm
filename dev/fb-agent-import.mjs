#!/usr/bin/env node
// Facebook Messenger export → Kaya CRM agent import.
//
// Workflow (agent acquisition campaign — see README of the campaign in chat):
//   1. Request your Facebook data export: Accounts Center → Your information
//      and permissions → Download your information → select "Messages" only,
//      format JSON, low media quality, date range = campaign period.
//   2. Unzip it, then:
//        node dev/fb-agent-import.mjs extract ~/Downloads/facebook-export/
//      → writes fb-agent-candidates.json next to this script and prints a
//        review table. Edit the JSON to remove anything that isn't an agent.
//   3. Dry run (no writes, checks live CRM for duplicates):
//        node dev/fb-agent-import.mjs ingest --dry-run
//   4. Real run — creates each agent via the deployed quick_add_agent action,
//      which dedupes and fires the samba_agent_welcome_v1 template (Maya's
//      onboarding opener), one every ~2s:
//        node dev/fb-agent-import.mjs ingest
//
// Notes:
//   - Walks the export recursively for message_*.json, so it works with both
//     the classic messages/inbox/ layout and the newer e2ee_cutover folders.
//   - Facebook exports store UTF-8 text mis-encoded as latin-1; fixEncoding()
//     reverses that.
//   - Your own identity is auto-detected as the sender of the outreach message
//     ("looking for rental agents…"), falling back to the most frequent
//     sender across threads.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES_FILE = join(HERE, 'fb-agent-candidates.json');
const CRM_ENDPOINT = process.env.CRM_ENDPOINT || 'https://kaya-agent-crm.vercel.app/api/supabase';
const OUTREACH_SNIPPET = /looking for rental agents/i;

const fixEncoding = (s) => (s == null ? '' : Buffer.from(String(s), 'latin1').toString('utf8'));

// Same rules as normIndoMobile in api/supabase.js, but keeps valid foreign
// mobiles too (some Bali agents are expats): returns digits incl. country
// code, or null if it can't be a phone number.
function normalizeNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  else if (d.startsWith('620')) d = '62' + d.slice(3);
  if (d.length < 10 || d.length > 15) return null;
  if (d.startsWith('62') && !d.startsWith('628')) return null; // Indonesian landline/garbage
  return d;
}

function extractNumbers(text) {
  const out = new Set();
  for (const m of text.matchAll(/wa\.me\/(\d{9,15})/g)) {
    const n = normalizeNumber(m[1]);
    if (n) out.add(n);
  }
  for (const m of text.matchAll(/\+?\d[\d\s().-]{7,20}\d/g)) {
    const n = normalizeNumber(m[0]);
    if (n) out.add(n);
  }
  return [...out];
}

function* walkMessageFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkMessageFiles(p);
    else if (/^message_\d+\.json$/.test(entry)) yield p;
  }
}

function extract(exportDir) {
  if (!exportDir || !existsSync(exportDir)) {
    console.error('Usage: node dev/fb-agent-import.mjs extract <path-to-unzipped-export>');
    process.exit(1);
  }

  // Group files by thread folder (a thread can have message_1.json, message_2.json…)
  const threads = new Map();
  for (const f of walkMessageFiles(exportDir)) {
    const key = dirname(f);
    (threads.get(key) || threads.set(key, []).get(key)).push(f);
  }
  if (!threads.size) {
    console.error('No message_*.json files found under ' + exportDir);
    console.error('Make sure you unzipped the export and selected "Messages" when requesting it.');
    process.exit(1);
  }

  // Parse all threads first so we can detect "me".
  const parsed = [];
  const senderCount = new Map();
  let detectedMe = null;
  for (const [folder, files] of threads) {
    let title = '';
    const messages = [];
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        title = fixEncoding(j.title) || title;
        for (const m of j.messages || []) {
          const msg = {
            sender: fixEncoding(m.sender_name),
            text: fixEncoding(m.content),
            ts: m.timestamp_ms || 0,
          };
          messages.push(msg);
          senderCount.set(msg.sender, (senderCount.get(msg.sender) || 0) + 1);
          if (!detectedMe && OUTREACH_SNIPPET.test(msg.text)) detectedMe = msg.sender;
        }
      } catch (e) {
        console.error(`  ! could not parse ${f}: ${e.message}`);
      }
    }
    parsed.push({ folder, title, messages });
  }
  const me = detectedMe || [...senderCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  console.log(`Detected own identity: "${me}" (${detectedMe ? 'via outreach message' : 'most frequent sender'})`);
  console.log(`Threads found: ${parsed.length}\n`);

  const byNumber = new Map(); // dedupe across threads
  for (const t of parsed) {
    const theirs = t.messages.filter((m) => m.sender && m.sender !== me);
    // newest first, so the number they most recently sent wins
    theirs.sort((a, b) => b.ts - a.ts);
    for (const m of theirs) {
      for (const num of extractNumbers(m.text)) {
        if (byNumber.has(num)) continue;
        byNumber.set(num, {
          name: m.sender || t.title || '+' + num,
          wa_num: num,
          foreign: !num.startsWith('62'),
          snippet: m.text.slice(0, 100),
          thread: t.title || t.folder.split('/').pop(),
          date: m.ts ? new Date(m.ts).toISOString().slice(0, 10) : null,
        });
      }
    }
  }

  const candidates = [...byNumber.values()].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(CANDIDATES_FILE, JSON.stringify(candidates, null, 2));

  for (const c of candidates) {
    const flag = c.foreign ? '  [non-ID number]' : '';
    console.log(`  ${c.name.padEnd(28).slice(0, 28)} +${c.wa_num}${flag}   "${c.snippet.slice(0, 50)}"`);
  }
  console.log(`\n${candidates.length} candidate(s) → ${CANDIDATES_FILE}`);
  console.log('Review/edit that file (delete non-agents), then run: node dev/fb-agent-import.mjs ingest --dry-run');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ingest({ dryRun }) {
  if (!existsSync(CANDIDATES_FILE)) {
    console.error(`No ${CANDIDATES_FILE} — run the extract step first.`);
    process.exit(1);
  }
  const candidates = JSON.parse(readFileSync(CANDIDATES_FILE, 'utf8'));
  console.log(`${candidates.length} candidate(s) loaded. Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE — will create agents and send welcome messages'}\n`);

  // One upfront fetch of existing agents so the dry run can report duplicates
  // and the live run can skip them without burning a request each.
  const existing = new Set();
  try {
    const r = await fetch(CRM_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_agents' }),
    });
    for (const a of await r.json()) {
      const n = String(a.wa_num || '').replace(/\D/g, '');
      if (n) existing.add(n);
    }
    console.log(`CRM currently has ${existing.size} numbers on file.\n`);
  } catch (e) {
    console.error('Could not fetch existing agents (' + e.message + ') — continuing; per-call dedupe still applies.');
  }

  let created = 0, skipped = 0, failed = 0;
  for (const c of candidates) {
    const tag = `${c.name} (+${c.wa_num})`;
    if (existing.has(c.wa_num)) { skipped++; console.log(`  skip   ${tag} — already in CRM`); continue; }
    if (dryRun) { created++; console.log(`  would  ${tag}`); continue; }
    try {
      const r = await fetch(CRM_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'quick_add_agent',
          payload: {
            name: c.name, wa_num: c.wa_num, service_type: 'rental',
            notes: `Recruited via Facebook Messenger outreach campaign (thread: ${c.thread}, ${c.date || 'n/a'}).`,
          },
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 409) { skipped++; console.log(`  skip   ${tag} — ${body.error}`); }
      else if (r.ok) { created++; console.log(`  added  ${tag}${body.welcome_sent ? ' — welcome sent' : ' — created (welcome NOT sent)'}`); }
      else { failed++; console.log(`  FAIL   ${tag} — ${body.error || r.status}`); }
    } catch (e) {
      failed++; console.log(`  FAIL   ${tag} — ${e.message}`);
    }
    await sleep(2000); // pace the welcome-template sends
  }
  console.log(`\n${dryRun ? 'Would create' : 'Created'}: ${created}  skipped: ${skipped}  failed: ${failed}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'extract') extract(rest.filter((a) => !a.startsWith('--'))[0]);
else if (cmd === 'ingest') await ingest({ dryRun: rest.includes('--dry-run') });
else {
  console.log('Usage:\n  node dev/fb-agent-import.mjs extract <export-dir>\n  node dev/fb-agent-import.mjs ingest [--dry-run]');
  process.exit(1);
}
