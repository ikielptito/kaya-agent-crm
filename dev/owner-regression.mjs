// Owner mode's regression set: what Maya answers villa owners.
// Runs the production dry run (preview_owner_reply — sends nothing).
//
//   MAYA_CONSOLE_KEY=… node dev/owner-regression.mjs [--only "payroll"]
import fs from 'node:fs';
const KEY = process.env.MAYA_CONSOLE_KEY;
const BASE = process.env.MAYA_BASE || 'https://kaya-agent-crm.vercel.app';
if (!KEY) { console.error('MAYA_CONSOLE_KEY is required'); process.exit(2); }
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const cases = JSON.parse(fs.readFileSync(new URL('./owner-cases.json', import.meta.url))).filter(c => !only || c.name.includes(only));

async function dryRun(ownerId, inbound) {
  const r = await fetch(`${BASE}/api/supabase`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-console-key': KEY },
    body: JSON.stringify({ action: 'preview_owner_reply', payload: { ownerId, inbound } }),
  });
  return r.json();
}
function check(c, out) {
  const e = c.expect, fails = [];
  const reply = String(out.reply || '');
  const tools = out.tools || [];
  if (e.action && !e.action.includes(out.action)) fails.push(`action ${out.action} not in ${e.action}`);
  for (const t of e.tools_include || []) if (!tools.includes(t)) fails.push(`tool ${t} not used (${tools.join(',') || 'none'})`);
  for (const s of e.reply_includes || []) if (!reply.includes(s)) fails.push(`reply lacks "${s}"`);
  if (e.reply_includes_any && !e.reply_includes_any.some(s => reply.includes(s))) fails.push(`reply lacks any of ${JSON.stringify(e.reply_includes_any)}`);
  for (const s of e.reply_excludes || []) if (reply.toLowerCase().includes(s.toLowerCase())) fails.push(`reply contains "${s}"`);
  const writes = (out.writes || []).map(w => `${w.tool}:${w.mode}`);
  for (const w of e.writes_include || []) if (!writes.includes(w)) fails.push(`write ${w} missing (${writes.join(',') || 'none'})`);
  return fails;
}
let pass = 0, fail = 0, cost = 0;
for (const c of cases) {
  process.stdout.write(`• ${c.name} … `);
  try {
    const out = await dryRun(c.ownerId, c.inbound);
    cost += Number(out.cost_usd || 0);
    const fails = check(c, out);
    if (fails.length) { fail++; console.log(`FAIL\n    ${fails.join('\n    ')}\n    reply: ${String(out.reply || '').slice(0, 300)}`); }
    else { pass++; console.log(`ok (${out.action}, ${out.llm_calls} calls, $${Number(out.cost_usd || 0).toFixed(3)}, ${out.ms}ms)\n    ${String(out.reply || '').slice(0, 200).replace(/\n/g, ' / ')}`); }
  } catch (e) { fail++; console.log(`ERROR ${e.message}`); }
}
console.log(`\n${pass} passed, ${fail} failed · $${cost.toFixed(2)} spent`);
process.exit(fail ? 1 : 0);
