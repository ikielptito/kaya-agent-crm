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
// opts: { name, waNum, agency?, notes?, referrerId?, referrerName?, source?, reason?, serviceType? }
// serviceType ∈ 'rental' | 'leasehold' | 'both' | null — what the contact deals in.
export function baseAgentFields(opts) {
  const { name, waNum, agency = null, notes = null, referrerId = null, referrerName = null, source = 'referral', reason = '', serviceType = null } = opts;
  const day = GRAPH_DAY();
  const who = referrerName || (referrerId ? `agent #${referrerId}` : null);
  const svc = ['rental', 'leasehold', 'both'].includes(serviceType) ? serviceType : null;
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
    // service_type gates which outreach they get (rentals vs leasehold sales).
    campaign_engagement: { samba: { status: 'enrolled', source, ...(referrerId ? { referred_by: referrerId } : {}) }, ...(svc ? { service_type: svc } : {}) },
  };
}

// A type-correct default for a Postgres column, from its OpenAPI type/format.
// This is the reliable path — no guessing from the column NAME.
function defaultForType(prop) {
  const t = String(prop?.type || '').toLowerCase();
  const f = String(prop?.format || '').toLowerCase();
  const s = f || t;
  if (/^(integer|bigint|smallint|serial|bigserial)$/.test(s) || (/int/.test(f) && !/point/.test(f))) return 0;
  if (/(numeric|decimal|double|real|float|money)/.test(s)) return 0;
  if (/bool/.test(s)) return false;
  if (t === 'array' || /\[\]$/.test(f) || /array/.test(f)) return [];
  if (/json/.test(s) || t === 'object') return {};
  if (/(timestamp|timestamptz|date|time)/.test(s)) return new Date().toISOString();
  if (/uuid/.test(s)) return null; // required uuid w/o default is unusual; don't fabricate one
  return ''; // text / varchar / char / bytea / everything else
}

// Fallback default when we have no schema — infer from the column NAME (last resort).
function defaultForColumn(col) {
  if (/_at$/.test(col)) return new Date().toISOString();
  if (/(_count|_id|_num|priority|order|rank|position|level)$/.test(col) || /^(num_|count_)/.test(col)) return 0;
  if (/^(is_|has_)/.test(col) || /(_flag|_enabled|_opt_out|_active|_paused)$/.test(col)) return false;
  if (/(history|engagement|_json|_data|prefs|settings|metadata)/.test(col)) return {};
  return ''; // text-ish default
}

// PostgREST publishes the table's columns, types and required (NOT-NULL, no
// default) list at the API root as an OpenAPI/Swagger doc. Cache it per process.
let _agentsSchema = undefined;
async function loadAgentsSchema(url, headers) {
  if (_agentsSchema !== undefined) return _agentsSchema;
  try {
    const r = await fetch(`${url}/rest/v1/`, { headers });
    if (!r.ok) { _agentsSchema = null; return null; }
    const spec = await r.json();
    const def = spec?.definitions?.agents || spec?.components?.schemas?.agents;
    if (!def) { _agentsSchema = null; return null; }
    _agentsSchema = { props: def.properties || {}, required: Array.isArray(def.required) ? def.required : [] };
  } catch (_) { _agentsSchema = null; }
  return _agentsSchema;
}

// Insert an agent row reliably. Reads the live schema and pre-fills EVERY
// required column we didn't provide with a type-correct default, so the insert
// can't fail on a NOT-NULL column or a wrong-type value. Falls back to a
// name-based heuristic + a 23502 retry loop if the schema can't be read.
// Returns { ok: true, row } or { ok: false, error }.
export async function createAgentRow(url, headers, fields) {
  const f = { ...fields };
  const schema = await loadAgentsSchema(url, headers);
  if (schema && schema.required.length) {
    for (const col of schema.required) {
      if (col in f) continue;                       // our real value wins
      f[col] = defaultForType(schema.props[col]);   // type-correct default
    }
  }
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
    const m = txt.match(/column\s+\\?"([^"\\]+)\\?"/i);
    const col = m && m[1];
    // Broken id sequence (23505 on the primary key): the agents.id sequence/
    // default is misconfigured in Supabase, so an insert that omits id lands on
    // id=0 (or a stale value) and collides. Assign the next free id ourselves —
    // max(id)+1, bumped on each retry — so contact creation no longer depends on
    // a working sequence. This is why new senders' first messages went missing.
    if (/23505|duplicate key|already exists/i.test(txt) && /pkey|\(id\)|"id"/i.test(txt)) {
      // Always jump to max(id)+1 — never walk up from a low pre-filled id (0),
      // which would collide with every existing row and exhaust the retries.
      // On a genuine race, the next call to nextAgentId reflects the winner's
      // row, so a second pass lands on the following free id.
      f.id = await nextAgentId(url, headers);
      continue;
    }
    // NOT-NULL (23502) on id with no usable default → same broken-sequence case.
    if (/23502|not-null constraint|null value in column/i.test(txt) && col === 'id') {
      f.id = await nextAgentId(url, headers);
      continue;
    }
    // NOT-NULL (23502): fill the named column — type from schema if known.
    if (/23502|not-null constraint|null value in column/i.test(txt) && col) {
      f[col] = schema?.props?.[col] ? defaultForType(schema.props[col]) : defaultForColumn(col);
      continue;
    }
    // Wrong-type input (22P02, e.g. "" sent to an integer column): coerce.
    if (/22P02|invalid input syntax/i.test(txt) && col) {
      f[col] = schema?.props?.[col] ? defaultForType(schema.props[col]) : 0;
      continue;
    }
    break; // an error we can't auto-correct
  }
  return { ok: false, error: (lastErr || 'insert failed').slice(0, 300) };
}

// Next free agent id = max(existing id) + 1. Fallback path for when the DB's
// id sequence/default is broken and won't auto-assign. Returns 1 on any error
// (the insert's 23505 retry loop then walks upward until it finds a free id).
async function nextAgentId(url, headers) {
  try {
    const r = await fetch(`${url}/rest/v1/agents?select=id&order=id.desc&limit=1`, { headers });
    const top = (await r.json())?.[0]?.id;
    return (typeof top === 'number' ? top : 0) + 1;
  } catch (_) { return 1; }
}
