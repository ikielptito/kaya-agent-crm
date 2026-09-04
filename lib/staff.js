// The staff registry: who works on which villa, and how we reach them.
//
// One table behind three features. Maintenance asks "may this number file a
// ticket, and who fixes aircon?"; housekeeping asks "whose villa is this?";
// payroll asks "who is on a monthly salary?". Keeping that in one place means
// Era updates a person once instead of in three systems that drift apart.
//
// Matching on the phone number is always done on DIGITS. Era's contacts, the
// WhatsApp webhook and Ikiel's typing all disagree about +, spaces and
// dashes, and a number that fails to match silently means a real person's
// message is ignored.

// Canonical WhatsApp number. Same rules as the portal's normalizeWaNumber
// (lib/owner-listings.js): repair a stray 0 after the country code, expand
// the local "08…" form Era's phone shows her, and add the country code to a
// bare Indonesian mobile. Foreign numbers are left alone.
//
// This matters more than it looks. "0813 5555 1234" and "+62 813-5555-1234"
// are one person; storing both creates a second row Maya can never reach,
// because WhatsApp will not deliver to a number without its country code.
export function normalizeWa(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('620')) return '62' + d.slice(3);
  if (d.startsWith('0')) return '62' + d.slice(1);
  if (/^8(1|2|3|7|9)\d{8,10}$/.test(d)) return '62' + d;
  return d;
}
const digits = normalizeWa;
const arr = (v) => Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean) : [];

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  if (!r.ok) throw new Error(`staff read → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function listStaff(db, { active_only = false, role = null } = {}) {
  let q = 'staff?select=*&order=active.desc,name.asc';
  if (active_only) q += '&active=is.true';
  const rows = await sbGet(db, q);
  return role ? rows.filter(s => (s.roles || []).includes(role)) : rows;
}

export async function staffByWa(db, waNum) {
  const n = digits(waNum);
  if (!n) return null;
  const rows = await sbGet(db, `staff?wa_num=eq.${encodeURIComponent(n)}&select=*&limit=1`);
  return rows?.[0] || null;
}

// Who covers this villa. An empty `slugs` means island-wide (the tukang and
// the pool man), so they answer for every property rather than none — which
// is why this is not a plain `slugs=cs.{slug}` filter.
export async function staffForSlug(db, slug, { role = null, trade = null } = {}) {
  const rows = await listStaff(db, { active_only: true });
  const s = String(slug || '');
  return rows.filter(p => {
    if (role && !(p.roles || []).includes(role)) return false;
    if (trade && !(p.trades || []).includes(trade)) return false;
    const covers = p.slugs || [];
    return !covers.length || (s && covers.includes(s));
  });
}

// Insert or update. `id` updates that row; otherwise the WhatsApp number is
// the identity, so quick-adding someone who already exists corrects their
// record instead of creating a second one the webhook would never reach.
export async function upsertStaff(db, input = {}) {
  const id = input.id != null ? parseInt(input.id, 10) : null;
  const patch = {};
  if (input.name != null) patch.name = String(input.name).trim();
  if (input.wa_num != null) patch.wa_num = digits(input.wa_num);
  if (input.roles != null) patch.roles = arr(input.roles);
  if (input.trades != null) patch.trades = arr(input.trades);
  if (input.slugs != null) patch.slugs = arr(input.slugs);
  if (input.pay_type != null) patch.pay_type = input.pay_type === 'per_job' ? 'per_job' : 'salaried';
  if (input.monthly_rate !== undefined) {
    const n = Number(String(input.monthly_rate).replace(/[^\d.]/g, ''));
    patch.monthly_rate = Number.isFinite(n) && n > 0 ? n : null;
  }
  if (input.can_report != null) patch.can_report = !!input.can_report;
  if (input.active != null) patch.active = !!input.active;
  if (input.notes !== undefined) patch.notes = input.notes || null;
  if (input.entity != null) patch.entity = input.entity === 'double8' ? 'double8' : 'samba';
  patch.updated_at = new Date().toISOString();

  if (id) {
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/staff?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...db.sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`staff update → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return { ok: true, staff: (await r.json())[0] || null };
  }

  if (!patch.name) throw new Error('Name is required');
  if (!patch.wa_num) throw new Error('WhatsApp number is required');
  // An Indonesian mobile is 10-13 digits after the country code; anything
  // shorter is a mistyped local number that would never receive a message.
  if (patch.wa_num.length < 9) throw new Error('That WhatsApp number looks too short');

  // The number already belongs to someone: correct their record instead of
  // creating a second row the webhook would never match.
  //
  // This is an ADD, not an edit, so anything left blank means "I didn't say",
  // not "remove it" — clearing Kadek's four villas because a quick-add form
  // was submitted with none ticked would be silent data loss. Lists are
  // unioned; an explicit edit (which carries an id and never reaches here)
  // still sets them exactly.
  const existing = await staffByWa(db, patch.wa_num);
  if (existing) {
    const merged = { ...patch };
    for (const k of ['roles', 'trades', 'slugs']) {
      if (!merged[k]) continue;
      merged[k] = [...new Set([...(existing[k] || []), ...merged[k]])];
    }
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/staff?id=eq.${existing.id}`, {
      method: 'PATCH',
      headers: { ...db.sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify(merged),
    });
    if (!r.ok) throw new Error(`staff merge → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return { ok: true, merged: true, previous_name: existing.name, staff: (await r.json())[0] || null };
  }

  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/staff`, {
    method: 'POST',
    headers: { ...db.sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`staff insert → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { ok: true, created: true, staff: (await r.json())[0] || null };
}

// Deactivate rather than delete: a person who left still appears on old
// maintenance items and payroll runs, and a foreign key to a deleted row
// would take those records down with them.
export async function deactivateStaff(db, id) {
  return upsertStaff(db, { id, active: false });
}
