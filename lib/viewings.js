// ── VIEWINGS ────────────────────────────────────────────────────────────
// Structured viewing appointments — the conversion step that used to live
// only as free text in chat. A viewing rides the relay transport (the ask to
// the villa contact IS a relay, so window re-openers, nudges and answer
// delivery come free) plus its own state machine:
//
//   requested → confirmed → completed | no_show
//            ↘ declined | expired | cancelled
//
// Maya never confirms a slot herself: 'confirmed' is set only from the villa
// contact's own reply (captureRelayAnswer's viewing classification), from an
// update_viewing action grounded in the conversation, or manually from the
// console. No client PII is ever stored — the agent's client stays theirs.
//
// The table is created by a manual Supabase migration (SCHEMA.sql). Every
// helper here degrades to a no-op when the table doesn't exist yet, so the
// code can deploy ahead of the migration.

const iso = () => new Date().toISOString();

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  if (!r.ok) return null;                       // table missing → null, callers skip
  return r.json().catch(() => null);
}
async function sbPost(db, path, body) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) ? rows[0] : rows;
}
async function sbPatch(db, path, body) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body),
  });
  return r.ok;
}

// Open a viewing: one row, tied to the relay that carries the ask.
export async function createViewing(db, { agent, slug, propertyName, contactWa, contactName, requestedWindow, relayId }) {
  return sbPost(db, 'viewings', {
    agent_id: agent?.id ?? null,
    agent_wa: String(agent?.wa_num || '').replace(/\D/g, '') || null,
    agent_name: agent?.name || agent?.agency || null,
    rental_slug: slug || null,
    property_name: propertyName || slug || null,
    contact_wa: String(contactWa || '').replace(/\D/g, '') || null,
    contact_name: contactName || null,
    requested_window: String(requestedWindow || '').slice(0, 200) || null,
    status: 'requested',
    relay_id: relayId ?? null,
    created_at: iso(), updated_at: iso(),
  });
}

export async function updateViewing(db, id, patch) {
  return sbPatch(db, `viewings?id=eq.${id}`, { ...patch, updated_at: iso() });
}

export async function viewingByRelay(db, relayId) {
  if (relayId == null) return null;
  const rows = await sbGet(db, `viewings?relay_id=eq.${relayId}&select=*&limit=1`);
  return rows?.[0] || null;
}

// Live viewings for one agent — fed into Maya's context so she knows what's
// pending/confirmed and can record outcomes from the conversation.
export async function viewingsForAgent(db, agentId) {
  if (agentId == null) return [];
  const rows = await sbGet(db,
    `viewings?agent_id=eq.${agentId}&status=in.(requested,confirmed)&select=id,rental_slug,property_name,requested_window,scheduled_at,status,contact_name&order=created_at.desc&limit=5`);
  return rows || [];
}

// Same, plus recently-passed confirmed viewings awaiting an outcome.
export async function viewingsAwaitingOutcome(db, agentId) {
  if (agentId == null) return [];
  const rows = await sbGet(db,
    `viewings?agent_id=eq.${agentId}&status=eq.confirmed&scheduled_at=lt.${iso()}&select=id,property_name,scheduled_at&limit=3`);
  return rows || [];
}

// One compact prompt block, or '' when there is nothing to know.
export function viewingsPromptBlock(active, past) {
  if (!active?.length && !past?.length) return '';
  const line = (v) => `- viewing #${v.id}: ${v.property_name || v.rental_slug} — ${v.status}${v.scheduled_at ? ` for ${v.scheduled_at.slice(0, 16).replace('T', ' ')}` : v.requested_window ? ` (asked: ${v.requested_window})` : ''}${v.contact_name ? ` · contact ${v.contact_name}` : ''}`;
  const parts = [];
  if (active?.length) parts.push(`THIS AGENT'S VIEWINGS (live state — never contradict it):\n${active.map(line).join('\n')}`);
  if (past?.length) parts.push(`PAST CONFIRMED VIEWINGS AWAITING AN OUTCOME — if the moment is natural, ask how it went, then record it via crm_actions update_viewing (completed / no_show / cancelled + a short note):\n${past.map(v => `- viewing #${v.id}: ${v.property_name} on ${String(v.scheduled_at).slice(0, 10)}`).join('\n')}`);
  return parts.join('\n') + '\n';
}

// ── Daily cron pass ─────────────────────────────────────────────────────
// 1. requested viewings whose relay expired → expired (the relay machinery
//    already told the agent honestly).
// 2. confirmed viewings happening today (WITA) → one reminder to agent AND
//    contact (free text; a shut window just skips — the reminder is a nicety).
// 3. confirmed viewings >12h past with no outcome ask → one gentle ask to the
//    agent; the answer flows through Maya, who records it via update_viewing.
export async function runViewingsCron(db, wa, { now = new Date(), sendText } = {}) {
  const summary = { expired: 0, reminded: 0, outcome_asks: 0 };
  const rows = await sbGet(db, `viewings?status=in.(requested,confirmed)&select=*`);
  if (!rows) { summary.skipped = 'viewings table not migrated yet'; return summary; }

  const witaNow = new Date(now.getTime() + 8 * 3600e3);
  const witaDay = witaNow.toISOString().slice(0, 10);

  for (const v of rows) {
    try {
      if (v.status === 'requested' && v.relay_id != null) {
        const rel = await sbGet(db, `relays?id=eq.${v.relay_id}&select=status&limit=1`);
        const rs = rel?.[0]?.status;
        if (rs === 'expired' || rs === 'failed') {
          await updateViewing(db, v.id, { status: 'expired' });
          summary.expired++;
        }
        continue;
      }
      if (v.status !== 'confirmed' || !v.scheduled_at) continue;
      const schedWita = new Date(Date.parse(v.scheduled_at) + 8 * 3600e3);
      const schedDay = schedWita.toISOString().slice(0, 10);
      const timeLabel = `${schedWita.toISOString().slice(11, 16)} WITA`;

      if (!v.reminded_at && schedDay === witaDay && Date.parse(v.scheduled_at) > now.getTime()) {
        if (v.agent_wa) await sendText(v.agent_wa, `Reminder — your viewing at ${v.property_name} is today at ${timeLabel}. ${v.contact_name ? `${v.contact_name} is expecting you.` : ''}`.trim()).catch(() => {});
        if (v.contact_wa) await sendText(v.contact_wa, `Reminder — ${v.agent_name || 'the agent'} is viewing ${v.property_name} today at ${timeLabel}.`).catch(() => {});
        await updateViewing(db, v.id, { reminded_at: iso() });
        summary.reminded++;
        continue;
      }
      if (!v.outcome_asked_at && Date.parse(v.scheduled_at) < now.getTime() - 12 * 3600e3) {
        // One ask only; a shut agent window means the send silently fails and
        // Maya's prompt block picks it up in their next conversation instead.
        if (v.agent_wa) await sendText(v.agent_wa, `Quick one — how did the viewing at ${v.property_name} go? Even a one-liner helps me help you follow up.`).catch(() => {});
        await updateViewing(db, v.id, { outcome_asked_at: iso() });
        summary.outcome_asks++;
      }
    } catch { /* per-row best effort */ }
  }
  return summary;
}
