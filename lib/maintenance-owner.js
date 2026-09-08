// Maintenance as the OWNER may hear it from Maya: their tickets, what each
// one is waiting on, what it costs, and where the photos are. Cielo asked
// "do I need to go somewhere else to look at the images related to the
// claims?" (6 Sep 2026) and Maya had nothing to answer from.

import { ownerItems } from './maintenance.js';
import { maintenanceToken } from './tokens.js';

const sbGet = async (db, path) => {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : [];
};
const day = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Makassar' }) : '';
const idr = (n) => `IDR ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

const STATUS = {
  new: 'found by our team, being assessed — the cost follows for approval',
  pending_approval: 'waiting for the owner to approve',
  approved: 'approved, work being scheduled',
  scheduled: 'scheduled, no action needed',
  declined: 'declined by the owner',
  done: 'completed',
};

// The active statement groups behind one owner: by WhatsApp number, or by
// any slug their portal account holds.
export async function ownerGroupKeys(db, { waNum, slugs = [] } = {}) {
  const wa = String(waNum || '').replace(/\D/g, '');
  const mine = new Set((slugs || []).map(s => String(s).replace(/_/g, '-')));
  const groups = (await sbGet(db, 'statement_groups?select=key,listing_slugs,owner_wa_nums&active=is.true')) || [];
  return groups.filter(g =>
    (wa && (g.owner_wa_nums || []).some(n => String(n).replace(/\D/g, '') === wa))
    || (g.listing_slugs || []).some(s => mine.has(s))).map(g => g.key);
}

export async function ownerMaintenanceContext(db, { waNum, slugs = [] } = {}) {
  const keys = await ownerGroupKeys(db, { waNum, slugs });
  if (!keys.length) return { text: '(no managed villas on file for this owner)', items: [] };
  const items = await ownerItems(db, keys);
  const lines = [
    'Maintenance tickets on this owner\'s villas (newest first). Each ticket has its own page at the link; photos, when attached, are on that page under "Photos" and on the Maintenance tab of the portal (https://sambarentals.com/portal). Photos from an inspection round are ALSO on the Housekeeping tab of the portal, on the inspection record, with a PDF download. Nothing is anywhere else.',
  ];
  if (!items.length) lines.push('No tickets on file.');
  for (const i of items.slice(0, 25)) {
    const where = i.unit_label ? `${i.group_name} (${i.unit_label})` : i.group_name;
    let s = `#${i.id} ${i.title} — ${where} — ${STATUS[i.status] || i.status}`;
    if (i.status === 'new') s += ' (owner was told early; no link action needed yet)';
    if (i.actual_cost != null) s += `; final cost ${idr(i.actual_cost)}`;
    else if (i.estimated_cost != null) s += `; estimate ${idr(i.estimated_cost)}`;
    else s += '; no cost yet';
    s += `; ${(i.photo_urls || []).length ? `${i.photo_urls.length} photo${i.photo_urls.length > 1 ? 's' : ''} attached` : 'no photos attached yet'}`;
    s += `; reported ${day(i.reported_at)}`;
    if (i.completed_at) s += `; completed ${day(i.completed_at)}${i.completion_note ? ` (${i.completion_note})` : ''}`;
    s += `; link https://sambarentals.com${i.url}`;
    if (i.description) s += `\n   ${String(i.description).replace(/\s+/g, ' ').slice(0, 220)}`;
    lines.push(s);
  }
  return { text: lines.join('\n').slice(0, 7000), items };
}

// ── The owner's yes or no, typed ────────────────────────────────────
// The approval template says "approve or decline on the page or by
// replying", and until 8 Sep 2026 a typed "approved" was answered with
// chat and changed nothing (parseOwnerDecision had no caller). When exactly
// one ticket on this owner's villas is waiting for their answer, a clear
// yes or no applies to it; with several open the owner is pointed at the
// links, because "yes" could mean any of them.
export async function handleOwnerDecision({ db, wa, fromNum, text }) {
  const body = String(text || '').trim();
  if (!body || body.length > 300) return false;
  const keys = await ownerGroupKeys(db, { waNum: fromNum });
  if (!keys.length) return false;
  const list = keys.map(k => `"${k}"`).join(',');
  const rows = await sbGet(db, `maintenance_items?group_key=in.(${encodeURIComponent(list)})&status=eq.pending_approval&notified_at=not.is.null&select=id,title,group_key,estimated_cost,currency,statement_groups(name)&order=notified_at.desc&limit=5`);
  if (!rows?.length) return false;
  const { parseOwnerDecision } = await import('./maintenance-intake.js');
  const { decision } = await parseOwnerDecision(body);
  if (!decision) return false;
  const { sendText } = await import('./wa-interactive.js');
  if (rows.length > 1) {
    const lines = rows.map(i => `• #${i.id} ${i.title} — https://sambarentals.com/m/${maintenanceToken(i.group_key, i.id)}`);
    await sendText(wa, fromNum, `Thanks — there are ${rows.length} repairs waiting for your answer, so I don't want to guess which one you mean. Each has its own Approve / Not right now buttons:\n${lines.join('\n')}`);
    return true;
  }
  const it = rows[0];
  const { approveItem, declineItem } = await import('./maintenance.js');
  if (decision === 'approve') {
    await approveItem(db, it.id, { by: 'owner (WhatsApp reply)' });
    await sendText(wa, fromNum, `Approved — thank you. Era will arrange the work on "${it.title}"${it.estimated_cost ? ` (${idr(it.estimated_cost)})` : ''} and I'll tell you when it's done.`);
  } else {
    await declineItem(db, it.id, { note: body, by: 'owner (WhatsApp reply)' });
    await sendText(wa, fromNum, `Understood — "${it.title}" is on hold and Era has been told. If you change your mind, reply here or open the link.`);
  }
  return true;
}
