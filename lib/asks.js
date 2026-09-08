// Every question Maya puts to a staff member, as a record.
//
// The reply to a WhatsApp message carries the id of the message it quotes
// (context.id) and a tapped template button carries the same. Until 8 Sep
// 2026 that reference was used once, by reading the quoted outbound row's
// TEXT and matching villa names in it. Everything else was guessed from
// state: which check is open, which round, which task is oldest. This
// table makes the reference the primary key of meaning: an ask is written
// when the message goes out, and an answer is routed by the ask.
//
//   recordAsk(db, { waNum, staffId, kind, targetType, targetId, targetIds, wamid, payload, expiresAt })
//   askForWamid(db, wamid)           the ask a quoted message belongs to
//   openAsks(db, waNum)              unanswered, unexpired, newest first
//   answerAsk(db, id, answer)
//
// Tolerant: when the staff_asks table does not exist yet every function
// returns null / [] and callers fall back to the old heuristics.

const nowIso = () => new Date().toISOString();
const digits = (n) => String(n || '').replace(/\D/g, '');
let _missing = false;   // per warm instance: stop hitting a table that is not there

async function sb(db, path, init = {}) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders, ...init });
  if (r.status === 404 || r.status === 400) {
    const t = await r.text().catch(() => '');
    if (/staff_asks|relation|does not exist|PGRST205|42P01/i.test(t) || r.status === 404) { _missing = true; return null; }
    throw new Error(`asks → ${r.status}: ${t.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(`asks → ${r.status}`);
  return init.method === 'PATCH' && !init.headers ? true : r.json().catch(() => null);
}

export const asksAvailable = () => !_missing;

export async function recordAsk(db, { waNum, staffId = null, kind, targetType = null, targetId = null, targetIds = null, wamid = null, payload = {}, expiresAt = null, expiresInHours = null } = {}) {
  if (_missing || !kind) return null;
  const expires = expiresAt || (expiresInHours ? new Date(Date.now() + expiresInHours * 3600e3).toISOString() : null);
  try {
    const rows = await sb(db, 'staff_asks', {
      method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({
        wa_num: digits(waNum), staff_id: staffId ?? null, kind,
        target_type: targetType, target_id: targetId ?? null,
        target_ids: Array.isArray(targetIds) ? targetIds.map(Number).filter(Boolean) : (targetId ? [Number(targetId)] : []),
        wa_message_id: typeof wamid === 'string' ? wamid : null,
        payload: payload || {}, asked_at: nowIso(), expires_at: expires,
      }),
    });
    return Array.isArray(rows) ? rows[0] : null;
  } catch { return null; }
}

export async function askForWamid(db, wamid) {
  if (_missing || !wamid) return null;
  try {
    const rows = await sb(db, `staff_asks?wa_message_id=eq.${encodeURIComponent(wamid)}&select=*&limit=1`);
    return rows?.[0] || null;
  } catch { return null; }
}

export async function openAsks(db, waNum, { limit = 12 } = {}) {
  if (_missing) return [];
  try {
    const rows = await sb(db, `staff_asks?wa_num=eq.${digits(waNum)}&answered_at=is.null&or=(expires_at.is.null,expires_at.gte.${encodeURIComponent(nowIso())})&select=*&order=asked_at.desc&limit=${limit}`);
    return rows || [];
  } catch { return []; }
}

export async function answerAsk(db, id, answer = {}, { wamid = null } = {}) {
  if (_missing || !id) return false;
  try {
    await fetch(`${db.SUPABASE_URL}/rest/v1/staff_asks?id=eq.${id}`, {
      method: 'PATCH', headers: db.sbHeaders,
      body: JSON.stringify({ answered_at: nowIso(), answer: { ...(answer || {}), ...(wamid ? { wa_message_id: wamid } : {}) } }),
    });
    return true;
  } catch { return false; }
}

// Close every open ask about one target (a task that was done by tap
// closes the morning ask AND the chase ask about it).
export async function closeAsksFor(db, targetType, targetId, answer = {}) {
  if (_missing || !targetType || !targetId) return 0;
  try {
    const rows = await sb(db, `staff_asks?target_type=eq.${targetType}&answered_at=is.null&or=(target_id.eq.${targetId},target_ids.cs.{${targetId}})&select=id&limit=20`);
    for (const r of rows || []) await answerAsk(db, r.id, answer);
    return (rows || []).length;
  } catch { return 0; }
}

// How many asks in the last N days went unanswered past their expiry, per
// number — the raw material of the channel model.
export async function askStats(db, waNum, { days = 7 } = {}) {
  if (_missing) return null;
  try {
    const since = new Date(Date.now() - days * 86400e3).toISOString();
    const rows = await sb(db, `staff_asks?wa_num=eq.${digits(waNum)}&asked_at=gte.${encodeURIComponent(since)}&kind=in.(task,inspection,chase,readiness,photo)&select=id,answered_at,expires_at&limit=200`);
    const all = rows || [];
    const now = nowIso();
    const ignored = all.filter(a => !a.answered_at && a.expires_at && a.expires_at < now).length;
    return { asks: all.length, answered: all.filter(a => a.answered_at).length, ignored };
  } catch { return null; }
}
