// The maintenance messaging loop — everything Maya says about repairs.
//
// Four queues, all drained by the daily cron pass (and each safe to run
// again, because every send stamps a column):
//
//   1. published, not yet told to the owner   → ask for approval, or just
//                                               tell them (routine work)
//   2. approved, Era not told                 → "the owner said yes"
//   3. approved/scheduled, work not finished  → nudge Era on next_followup_at
//   4. done, owner not told                   → "it's finished"
//
// The nudge is the part with manners: it fires on next_followup_at, and
// when Era answers "next Tuesday" the webhook pushes that date in, so Maya
// asks once and then waits rather than repeating every three days.

import { resolveCampaign, isCampaignPaused, getSettingValue, noteRun } from './campaigns.js';
import { maintenanceToken } from './tokens.js';
import { inDays } from './maintenance.js';
import { claimedGroupKeys } from './onboarded.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const nowIso = () => new Date().toISOString();

const T_APPROVAL = 'samba_owner_maintenance_approval';
const T_NOTICE   = 'samba_owner_maintenance_notice';
const T_DONE     = 'samba_owner_maintenance_done';
const T_REMIND   = 'samba_staff_maintenance_reminder';
const T_APPROVED = 'samba_staff_maintenance_approved';

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sbPatch(db, path, body) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body) });
}
async function sbPost(db, path, body, prefer = 'return=representation') {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: prefer }, body: JSON.stringify(body),
  });
  if (!r.ok) return null;
  return prefer.includes('representation') ? r.json().catch(() => null) : null;
}
async function ensureOwnerRow(db, waNum, name) {
  const existing = (await sbGet(db, `owners?wa_num=eq.${waNum}&select=id&limit=1`))?.[0];
  if (existing) return existing.id;
  const rows = await sbPost(db, 'owners', { wa_num: waNum, name: name || null, notes: 'Auto-created by maintenance notify' });
  return rows?.[0]?.id ?? null;
}

const money = (n, cur = 'IDR') =>
  n == null ? 'to be confirmed' : `${cur} ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const firstName = (s) => String(s || '').split(/[\s&,]+/)[0] || 'there';
const placeOf = (item) =>
  item.unit_label ? `${item.statement_groups?.name || item.group_key} (${item.unit_label})`
                  : (item.statement_groups?.name || item.group_key);

// Body params + optional URL-button suffix, the shape every Samba template
// send uses.
async function sendTemplate(phoneId, token, to, name, params, buttonSuffix) {
  try {
    const components = [];
    if (params?.length) {
      components.push({ type: 'body', parameters: params.map(text => ({ type: 'text', text: String(text) })) });
    }
    if (buttonSuffix) {
      components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: buttonSuffix }] });
    }
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name, language: { code: 'en' }, components },
      }),
    });
    if (!r.ok) return false;
    const d = await r.json().catch(() => ({}));
    return d.messages?.[0]?.id || true;
  } catch { return false; }
}

async function logOut(db, { waNum, ownerId, content, mid, template, campaignId, category = 'maintenance' }) {
  await sbPost(db, 'wa_messages', {
    owner_id: ownerId || null, wa_num: waNum, direction: 'outbound',
    content, wa_message_id: typeof mid === 'string' ? mid : null,
    timestamp: nowIso(), source: 'cron', category,
    campaign_id: campaignId || null, template_name: template, status: 'sent',
  }, 'return=minimal').catch(() => {});
}

export async function runMaintenanceSweep({
  SUPABASE_URL, sbHeaders, WA_TOKEN, WA_PHONE_ID, templatesMap = {}, preview = false,
} = {}) {
  const db = { SUPABASE_URL, sbHeaders };
  if (!preview && (!WA_TOKEN || !WA_PHONE_ID)) return { skipped: 'no WhatsApp credentials' };

  const camp = await resolveCampaign(db, 'maintenance');
  if (isCampaignPaused(camp)) return { skipped: 'campaign paused (command center)' };
  const cfg = (await getSettingValue(db, 'maintenance')) || {};
  const cap = parseInt(cfg.notify_daily_cap, 10) || 0;
  if (!preview && cap <= 0) return { skipped: 'notify_daily_cap unset (arm in command center)' };

  const eraNum = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
  // Owners who haven't claimed their portal account yet are skipped, not
  // dropped: their items keep notified_at null and go out once they onboard.
  const claimed = await claimedGroupKeys();
  const has = (t) => preview || !!templatesMap[t];
  const out = { asked: 0, told: 0, staff_told: 0, nudged: 0, completed_told: 0, failed: 0, skipped: [], plan: [] };
  let budget = preview ? 999 : cap;

  const send = async (to, template, params, suffix, log) => {
    if (budget <= 0) return null;
    if (preview) { out.plan.push({ to, template, params, log }); budget--; return 'preview'; }
    const mid = await sendTemplate(WA_PHONE_ID, WA_TOKEN, to, template, params, suffix);
    if (!mid) { out.failed++; return null; }
    budget--;
    await new Promise(r => setTimeout(r, 300));   // pacing
    return mid;
  };

  // ── 1) Tell the owner: approve this, or just so you know ──────────
  if (has(T_APPROVAL) || has(T_NOTICE)) {
    const queue = (await sbGet(db, `maintenance_items?status=in.(pending_approval,scheduled)&notified_at=is.null&select=*,statement_groups(key,name,owner_names,notify,owner_wa_nums)&order=created_at.asc&limit=50`)) || [];
    for (const item of queue) {
      const g = item.statement_groups || {};
      const nums = (g.owner_wa_nums || []).map(n => String(n).replace(/\D/g, '')).filter(Boolean);
      if (!g.notify || !nums.length) { out.skipped.push({ id: item.id, why: 'no owner number / notify off' }); continue; }
      if (!claimed.has(item.group_key)) { out.skipped.push({ id: item.id, why: 'owner has not claimed their portal account yet' }); continue; }
      const needsApproval = item.status === 'pending_approval';
      const tmpl = needsApproval ? T_APPROVAL : T_NOTICE;
      if (!has(tmpl)) { out.skipped.push({ id: item.id, why: `${tmpl} not approved yet` }); continue; }
      const tok = maintenanceToken(item.group_key, item.id);
      let any = false;
      for (const to of nums) {
        const params = needsApproval
          ? [firstName(g.owner_names), placeOf(item), item.title, money(item.estimated_cost, item.currency)]
          : [firstName(g.owner_names), placeOf(item), item.title];
        const mid = await send(to, tmpl, params, tok,
          `[Maintenance ${needsApproval ? 'approval request' : 'notice'} — ${placeOf(item)}: ${item.title}]`);
        if (!mid) continue;
        any = true;
        if (!preview) {
          const ownerId = await ensureOwnerRow(db, to, g.owner_names);
          await logOut(db, { waNum: to, ownerId, mid, template: tmpl, campaignId: camp?.id,
            content: `[Maintenance ${needsApproval ? 'approval request' : 'notice'} — ${placeOf(item)}: ${item.title}]` });
        }
      }
      if (any && !preview) {
        await sbPatch(db, `maintenance_items?id=eq.${item.id}`, { notified_at: nowIso(), updated_at: nowIso() });
      }
      if (any) needsApproval ? out.asked++ : out.told++;
    }
  }

  // ── 2) Tell Era the owner approved (or declined) ──────────────────
  if (has(T_APPROVED) && eraNum) {
    const queue = (await sbGet(db, `maintenance_items?status=in.(approved,declined)&staff_notified_at=is.null&select=*,statement_groups(key,name)&order=approved_at.asc&limit=30`)) || [];
    for (const item of queue) {
      // A decline is a conversation, not a work order — Maya reports it as
      // free text inside the reminder template's slot rather than pretending
      // it's a go-ahead.
      const title = item.status === 'approved' ? item.title : `${item.title} — OWNER DECLINED${item.decline_note ? `: ${item.decline_note}` : ''}`;
      const mid = await send(eraNum, T_APPROVED,
        [placeOf(item), title, money(item.estimated_cost, item.currency)], null,
        `[Owner ${item.status} — ${placeOf(item)}: ${item.title}]`);
      if (!mid) continue;
      if (!preview) {
        await logOut(db, { waNum: eraNum, mid, template: T_APPROVED, campaignId: camp?.id,
          content: `[Owner ${item.status} — ${placeOf(item)}: ${item.title}]`, category: 'maintenance_staff' });
        await sbPatch(db, `maintenance_items?id=eq.${item.id}`, { staff_notified_at: nowIso(), updated_at: nowIso() });
      }
      out.staff_told++;
    }
  }

  // ── 3) Nudge Era about work that is authorised but not finished ───
  if (has(T_REMIND) && eraNum) {
    const queue = (await sbGet(db, `maintenance_items?status=in.(approved,scheduled)&next_followup_at=lte.${encodeURIComponent(nowIso())}&select=*,statement_groups(key,name)&order=next_followup_at.asc&limit=25`)) || [];
    for (const item of queue) {
      const mid = await send(eraNum, T_REMIND, [placeOf(item), item.title], null,
        `[Maintenance reminder — ${placeOf(item)}: ${item.title}]`);
      if (!mid) continue;
      if (!preview) {
        await logOut(db, { waNum: eraNum, mid, template: T_REMIND, campaignId: camp?.id,
          content: `[Maintenance reminder — ${placeOf(item)}: ${item.title}]`, category: 'maintenance_staff' });
        // Push the next nudge out; Era's reply can override this with a real
        // date (see the webhook's staff-reply handling).
        await sbPatch(db, `maintenance_items?id=eq.${item.id}`, {
          next_followup_at: inDays(3),
          followup_count: (item.followup_count || 0) + 1,
          promised_date: null,          // the promise has come due
          updated_at: nowIso(),
        });
      }
      out.nudged++;
    }
  }

  // ── 4) Tell the owner it's finished ───────────────────────────────
  if (has(T_DONE)) {
    const queue = (await sbGet(db, `maintenance_items?status=eq.done&done_notified_at=is.null&select=*,statement_groups(key,name,owner_names,notify,owner_wa_nums)&order=completed_at.asc&limit=30`)) || [];
    for (const item of queue) {
      const g = item.statement_groups || {};
      const nums = (g.owner_wa_nums || []).map(n => String(n).replace(/\D/g, '')).filter(Boolean);
      // Nothing to announce if the owner was never told about it in the
      // first place (Era filed and finished it before it was published).
      if (!g.notify || !nums.length || !item.notified_at) {
        if (!preview) await sbPatch(db, `maintenance_items?id=eq.${item.id}`, { done_notified_at: nowIso() });
        continue;
      }
      // Still waiting to be onboarded — hold the "it's finished" note too.
      if (!claimed.has(item.group_key)) { out.skipped.push({ id: item.id, why: 'owner not onboarded yet' }); continue; }
      const tok = maintenanceToken(item.group_key, item.id);
      let any = false;
      for (const to of nums) {
        const mid = await send(to, T_DONE, [firstName(g.owner_names), placeOf(item), item.title], tok,
          `[Maintenance complete — ${placeOf(item)}: ${item.title}]`);
        if (!mid) continue;
        any = true;
        if (!preview) {
          const ownerId = await ensureOwnerRow(db, to, g.owner_names);
          await logOut(db, { waNum: to, ownerId, mid, template: T_DONE, campaignId: camp?.id,
            content: `[Maintenance complete — ${placeOf(item)}: ${item.title}]` });
        }
      }
      if (any && !preview) {
        await sbPatch(db, `maintenance_items?id=eq.${item.id}`, { done_notified_at: nowIso(), updated_at: nowIso() });
      }
      if (any) out.completed_told++;
    }
  }

  // Tidy the short-lived "already asked which villa" locks.
  if (!preview) {
    const cutoff = Date.now() - 3600e3;
    await fetch(`${db.SUPABASE_URL}/rest/v1/settings?key=like.maintask:*&value->>at=lt.${cutoff}`, {
      method: 'DELETE', headers: db.sbHeaders,
    }).catch(() => {});
  }

  const sent = out.asked + out.told + out.staff_told + out.nudged + out.completed_told;
  if (!preview && sent) await noteRun(db, camp, { sent, failed: out.failed, summary: out });
  return out;
}
