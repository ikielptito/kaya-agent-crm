// Maya's regression set: real threads, synthetic last messages, expectations
// drawn from the weekly critic's own findings. Runs the production dry-run
// (preview_reply — saves and sends nothing) so a prompt or model change is
// scored on the same eight situations before it ships.
//
//   MAYA_CONSOLE_KEY=… node dev/maya-regression.mjs [--only "viewing"]
//
// Each case costs one real reply (~$0.05–0.25). Cases live in maya-cases.json.
import fs from 'node:fs';
const KEY = process.env.MAYA_CONSOLE_KEY;
const BASE = process.env.MAYA_BASE || 'https://kaya-agent-crm.vercel.app';
if (!KEY) { console.error('MAYA_CONSOLE_KEY is required'); process.exit(2); }
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const cases = JSON.parse(fs.readFileSync(new URL('./maya-cases.json', import.meta.url))).filter(c => !only || c.name.includes(only));

async function dryRun(agentId, inbound) {
  const r = await fetch(`${BASE}/api/supabase`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-console-key': KEY },
    body: JSON.stringify({ action: 'preview_reply', payload: { agentId, inbound, mode: 'hybrid', debug: true } }),
  });
  return r.json();
}
function check(c, out) {
  const e = c.expect, fails = [];
  const reply = String(out.reply || '');
  const cards = Array.isArray(out.send_cards) ? out.send_cards : [];
  if (e.action && !e.action.includes(out.action)) fails.push(`action ${out.action} not in ${e.action}`);
  if (e.model && out.model !== e.model) fails.push(`model ${out.model} ≠ ${e.model}`);
  if (e.empty_reply && reply.trim()) fails.push(`expected no reply, got "${reply.slice(0, 80)}"`);
  if (e.max_reply_chars && reply.length > e.max_reply_chars) fails.push(`reply ${reply.length} chars > ${e.max_reply_chars}`);
  if (e.max_cards != null && cards.length > e.max_cards) fails.push(`${cards.length} cards > ${e.max_cards}`);
  if (e.no_cards && cards.length) fails.push(`sent ${cards.length} cards`);
  for (const s of e.reply_includes || []) if (!reply.includes(s)) fails.push(`reply lacks "${s}"`);
  for (const s of e.reply_excludes || []) if (reply.toLowerCase().includes(s.toLowerCase())) fails.push(`reply contains "${s}"`);
  if (e.open_viewing_slug_includes && !String(out.open_viewing?.slug || '').toLowerCase().includes(e.open_viewing_slug_includes)) fails.push(`open_viewing.slug = ${out.open_viewing?.slug}`);
  if (e.ask_owner_slug_includes && !String(out.ask_owner?.slug || '').toLowerCase().includes(e.ask_owner_slug_includes)) fails.push(`ask_owner.slug = ${out.ask_owner?.slug}`);
  if (e.wants_out && !out.counterparty?.wants_out) fails.push(`wants_out = ${out.counterparty?.wants_out}`);
  if (e.no_fit_with_beds_over != null) {
    const bad = (out.match_scan || []).filter(m => m.verdict === 'fit' && /(\d)\s*br/i.test(m.why || '') && parseInt(m.why.match(/(\d)\s*br/i)[1], 10) > e.no_fit_with_beds_over);
    if (bad.length) fails.push(`fit with more beds than asked: ${bad.map(b => b.slug).join(', ')}`);
  }
  return fails;
}
let pass = 0, fail = 0, cost = 0;
for (const c of cases) {
  process.stdout.write(`• ${c.name} … `);
  try {
    const out = await dryRun(c.agentId, c.inbound);
    cost += Number(out.cost_usd || 0);
    const fails = check(c, out);
    if (fails.length) { fail++; console.log(`FAIL\n    ${fails.join('\n    ')}\n    reply: ${String(out.reply || '').slice(0, 200)}`); }
    else { pass++; console.log(`ok (${out.model}, $${Number(out.cost_usd || 0).toFixed(3)})`); }
  } catch (e) { fail++; console.log(`ERROR ${e.message}`); }
}
console.log(`\n${pass} passed, ${fail} failed · $${cost.toFixed(2)} spent`);
process.exit(fail ? 1 : 0);
