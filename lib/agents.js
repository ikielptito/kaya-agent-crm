// Reliable agent creation, shared by the webhook (referral/redirect auto-create)
// and the assistant console so the field set can never drift between them.
//
// The base `agents` table (defined directly in Supabase, not in SCHEMA.sql) has
// several NOT-NULL columns with no defaults — name, wa_num, unread_count,
// last_inbound_at, conversation_summary, conversation_history — which the proven
// "new agent's first message" insert always sets. baseAgentFields() sets that
// same baseline (plus referral extras). createAgentRow() then SELF-HEALS: if the
// insert still hits a NOT-NULL violation (Postgres 23502) on any column we
// didn't anticipate, it reads the column name from the error, fills a
// type-appropriate default, and retries — so creating a contact is reliable even
// if the schema drifts.

const GRAPH_DAY = () => new Date().toISOString().slice(0, 10);

// Build the full insert body for a Maya-created contact.
// opts: { name, waNum, agency?, notes?, referrerId?, referrerName?, source?, reason? }
export function baseAgentFields(opts) {
  const { name, waNum, agency = null, notes = null, referrerId = null, referrerName = null, source = 'referral', reason = '' } = opts;
  const day = GRAPH_DAY();
  const who = referrerName || (referrerId ? `agent #${referrerId}` : null);
  return {
    name,
    wa_num: waNum,
    wa_url: `https://wa.me/${waNum}`,
    agency,
    unread_count: 0,
    last_inbound_at: new Date().toISOString(),
    notes: notes || (who ? `Added by Maya — ${reason || 'referral'} (from ${who}) on ${day}.` : `Added by Maya on ${day}.`),
    conversation_summary: `[${day}] Added by Maya — ${reason || source}${who ? `. Number provided by ${who}` : ''}.`,
    conversation_history: { first_contact: day, last_contact: day, total_messages: 0 },
    // Enrolled so the new contact immediately starts receiving Maya's updates.
    campaign_engagement: { samba: { status: 'enrolled', source, ...(referrerId ? { referred_by: referrerId } : {}) } },
  };
}

// A safe default value for an unexpected NOT-NULL column, inferred from its name.
function defaultForColumn(col) {
  if (/_at$/.test(col)) return new Date().toISOString();
  if (/_count$/.test(col) || /^num_/.test(col)) return 0;
  if (/^(is_|has_)/.test(col) || /(_flag|_enabled|_opt_out|_active|_paused)$/.test(col)) return false;
  if (/(history|engagement|_json|_data|prefs|settings|metadata)/.test(col)) return {};
  return ''; // text-ish default
}

// Insert an agent row, self-healing NOT-NULL (23502) violations. Returns
// { ok: true, row } or { ok: false, error, column? }.
export async function createAgentRow(url, headers, fields) {
  const f = { ...fields };
  let lastErr = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(`${url}/rest/v1/agents`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify(f),
    });
    const txt = await r.text().catch(() => '');
    if (r.ok) {
      let row = null;
      try { row = JSON.parse(txt)?.[0] || null; } catch (_) { /* row stays null */ }
      return { ok: true, row };
    }
    lastErr = txt;
    // NOT-NULL violation? Pull the column name and fill a default, then retry.
    const isNull = /23502/.test(txt) || /not-null constraint/i.test(txt) || /null value in column/i.test(txt);
    const m = txt.match(/column\s+\\?"([^"\\]+)\\?"/i);
    const col = m && m[1];
    if (isNull && col && !(col in f)) {
      f[col] = defaultForColumn(col);
      continue;
    }
    break; // a different error (or same column already set) — stop retrying
  }
  return { ok: false, error: (lastErr || 'insert failed').slice(0, 300) };
}
