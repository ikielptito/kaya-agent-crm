// The maintenance messaging loop — everything Maya says about repairs.
//
// Nine queues, all drained by the daily cron pass (and each safe to run
// again, because every send stamps a column):
//
//   OWNER AND ERA
//   1. published, not yet told to the owner   → ask for approval, or just
//                                               tell them (routine work)
//   2. approved, Era not told                 → "the owner said yes"
//   3. approved/scheduled, work not finished  → nudge Era on next_followup_at
//   4. done, owner not told                   → "it's finished"
//
//   TUKANG DISPATCH
//   5. assigned, tukang not told              → the job, with a link to the
//                                               photos and the budget
//   6. anything changed, Era not told         → asked / confirmed for Tuesday
//                                               9am / declined / he says done
//   7. visit is today                         → remind him this morning
//   8. the agreed time has passed             → did you come, and is it fixed
//   9. a job was reassigned                   → tell the tukang who had it
//
// The nudge is the part with manners: it fires on next_followup_at, and
// when Era answers "next Tuesday" the webhook pushes that date in, so Maya
// asks once and then waits rather than repeating every three days.

import { resolveCampaign, isCampaignPaused, getSettingValue, noteRun } from './campaigns.js';
import { maintenanceToken, tukangToken } from './tokens.js';
import { inDays } from './maintenance.js';
import { witaLabel, witaLabelId } from './maintenance-dispatch.js';
import { claimedGroupKeys } from './onboarded.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const nowIso = () => new Date().toISOString();

const T_APPROVAL = 'samba_owner_maintenance_approval';
const T_NOTICE   = 'samba_owner_maintenance_notice';
const T_DONE     = 'samba_owner_maintenance_done';
const T_REMIND   = 'samba_staff_maintenance_reminder';
const T_APPROVED = 'samba_staff_maintenance_approved';
// Dispatch. The three sent to the tukang are Indonesian: BTC Electric and
// Dian do not read English, and a work order nobody understands is worse
// than no work order.
const T_JOB      = 'samba_tukang_job';
const T_TK_REMIND = 'samba_tukang_reminder';
const T_TK_FOLLOW = 'samba_tukang_followup';
const T_TK_CANCEL = 'samba_tukang_cancel';
const T_DISPATCH = 'samba_staff_dispatch_update';
const ID_TEMPLATES = new Set([T_JOB, T_TK_REMIND, T_TK_FOLLOW, T_TK_CANCEL]);

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
// Meta rejects any template parameter containing a newline, a tab, or four
// consecutive spaces — the send fails, it does not degrade. Titles and notes
// here are free text typed by Era or written by a model, so every parameter
// is flattened rather than trusted.
const flatten = (s) => String(s == null ? '' : s)
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/ {4,}/g, '   ')
  .trim();

async function sendTemplate(phoneId, token, to, name, params, buttonSuffix, lang = 'en') {
  try {
    const components = [];
    if (params?.length) {
      components.push({ type: 'body', parameters: params.map(text => ({ type: 'text', text: flatten(text) })) });
    }
    if (buttonSuffix) {
      components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: buttonSuffix }] });
    }
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name, language: { code: lang }, components },
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
  const out = {
    asked: 0, told: 0, staff_told: 0, nudged: 0, completed_told: 0,
    jobs_sent: 0, era_updates: 0, visit_reminders: 0, visit_followups: 0, cancels_sent: 0,
    failed: 0, skipped: [], plan: [],
  };
  let budget = preview ? 999 : cap;

  const send = async (to, template, params, suffix, log) => {
    if (budget <= 0) return null;
    if (preview) { out.plan.push({ to, template, params, log }); budget--; return 'preview'; }
    const mid = await sendTemplate(WA_PHONE_ID, WA_TOKEN, to, template, params, suffix,
      ID_TEMPLATES.has(template) ? 'id' : 'en');
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

  // ── 5) Send the assigned tukang his job ───────────────────────────
  // The template carries a link to /j/<token>, the job sheet: photos, what is
  // broken, where, and the budget. A link rather than a burst of images keeps
  // the private photo bucket private and lets Era correct a detail without
  // re-sending anything.
  if (has(T_JOB)) {
    const queue = (await sbGet(db, `maintenance_items?assigned_staff_id=not.is.null&tukang_notified_at=is.null&visit_status=eq.offered&select=*,statement_groups(key,name),staff:assigned_staff_id(id,name,wa_num,active)&order=assigned_at.asc&limit=25`)) || [];
    for (const item of queue) {
      const to = String(item.staff?.wa_num || '').replace(/\D/g, '');
      if (!to || !item.staff?.active) { out.skipped.push({ id: item.id, why: 'assigned person has no number or is inactive' }); continue; }
      const tok = tukangToken(item.id);
      const mid = await send(to, T_JOB, [placeOf(item), item.title, money(item.estimated_cost, item.currency)], tok,
        `[Job sent to ${item.staff.name} — ${placeOf(item)}: ${item.title}]`);
      if (!mid) continue;
      if (!preview) {
        await logOut(db, { waNum: to, mid, template: T_JOB, campaignId: camp?.id, category: 'maintenance_tukang',
          content: `[Job sent — ${placeOf(item)}: ${item.title}]` });
        await sbPatch(db, `maintenance_items?id=eq.${item.id}`, { tukang_notified_at: nowIso(), updated_at: nowIso() });
      }
      out.jobs_sent++;
    }
  }

  // ── 6) Keep Era posted ────────────────────────────────────────────
  // One latch, re-armed by every transition, so she gets one message per
  // development: he has been asked, he confirmed Tuesday at 9, he declined,
  // he says it's done. era_dispatch_state records what she was last told, so
  // a re-run of the sweep cannot repeat it.
  if (has(T_DISPATCH) && eraNum) {
    const queue = (await sbGet(db, `maintenance_items?assigned_staff_id=not.is.null&era_dispatch_update_at=is.null&select=*,statement_groups(key,name),staff:assigned_staff_id(id,name)&order=updated_at.asc&limit=25`)) || [];
    for (const item of queue) {
      const who = item.staff?.name || 'the tukang';
      const update =
        item.visit_status === 'offered'   ? `${who} has the job and I am waiting for his reply.`
        : item.visit_status === 'confirmed' ? `${who} confirmed: ${witaLabel(item.visit_at) || 'time still to be agreed'}.`
        : item.visit_status === 'declined'  ? `${who} cannot take this one. It needs reassigning.`
        : item.visit_status === 'arrived'   ? `${who} is at the property now.`
        : item.visit_status === 'done'      ? `${who} says the work is finished. Please check, then mark it done.`
        : null;
      if (!update) { if (!preview) await sbPatch(db, `maintenance_items?id=eq.${item.id}`, { era_dispatch_update_at: nowIso() }); continue; }
      // Don't tell her he has the job until he actually has it. Queue 5 runs
      // first, but it can decline to send — no number, inactive, template
      // unapproved, daily cap reached — and "waiting for his reply" would
      // then leave Era waiting for a reply that can never come. Leaving the
      // latch null means she is told on the pass after the job goes out.
      if (item.visit_status === 'offered' && !item.tukang_notified_at) {
        out.skipped.push({ id: item.id, why: 'job not sent to the tukang yet' });
        continue;
      }
      // Already told her exactly this; close the latch without sending.
      if (item.era_dispatch_state === item.visit_status) {
        if (!preview) await sbPatch(db, `maintenance_items?id=eq.${item.id}`, { era_dispatch_update_at: nowIso() });
        continue;
      }
      const mid = await send(eraNum, T_DISPATCH, [placeOf(item), item.title, update], null,
        `[Dispatch — ${placeOf(item)}: ${update}]`);
      if (!mid) continue;
      if (!preview) {
        await logOut(db, { waNum: eraNum, mid, template: T_DISPATCH, campaignId: camp?.id, category: 'maintenance_staff',
          content: `[Dispatch — ${placeOf(item)}: ${update}]` });
        await sbPatch(db, `maintenance_items?id=eq.${item.id}`, {
          era_dispatch_update_at: nowIso(), era_dispatch_state: item.visit_status, updated_at: nowIso(),
        });
      }
      out.era_updates++;
    }
  }

  // ── 7) Remind the tukang on the morning of the visit ──────────────
  if (has(T_TK_REMIND)) {
    const queue = (await sbGet(db, `maintenance_items?visit_status=eq.confirmed&visit_at=not.is.null&visit_reminded_at=is.null&select=*,statement_groups(key,name),staff:assigned_staff_id(name,wa_num)&order=visit_at.asc&limit=25`)) || [];
    const todayWita = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    for (const item of queue) {
      const dayWita = new Date(Date.parse(item.visit_at) + 8 * 3600e3).toISOString().slice(0, 10);
      // Only on the day, and only while it is still ahead of him.
      if (dayWita !== todayWita || Date.parse(item.visit_at) < Date.now()) continue;
      const to = String(item.staff?.wa_num || '').replace(/\D/g, '');
      if (!to) continue;
      const mid = await send(to, T_TK_REMIND, [placeOf(item), witaLabelId(item.visit_at)], null,
        `[Reminder to ${item.staff?.name} — ${placeOf(item)} today]`);
      if (!mid) continue;
      if (!preview) {
        await logOut(db, { waNum: to, mid, template: T_TK_REMIND, campaignId: camp?.id, category: 'maintenance_tukang',
          content: `[Visit reminder — ${placeOf(item)}]` });
        await sbPatch(db, `maintenance_items?id=eq.${item.id}`, { visit_reminded_at: nowIso(), updated_at: nowIso() });
      }
      out.visit_reminders++;
    }
  }

  // ── 8) After the agreed time: did he come, and is it fixed? ───────
  // Two separate asks against two separate latches. The first runs an hour
  // after he was due, while a no-show can still be rescued; the second the
  // next day, when a real repair has had time to happen.
  if (has(T_TK_FOLLOW)) {
    const queue = (await sbGet(db, `maintenance_items?visit_status=in.(confirmed,arrived)&visit_at=not.is.null&select=*,statement_groups(key,name),staff:assigned_staff_id(name,wa_num)&order=visit_at.asc&limit=25`)) || [];
    for (const item of queue) {
      const to = String(item.staff?.wa_num || '').replace(/\D/g, '');
      if (!to) continue;
      const since = Date.now() - Date.parse(item.visit_at);
      const arrivalDue = item.visit_status === 'confirmed' && !item.arrival_check_at && since > 3600e3;
      const doneDue = !item.completion_check_at && since > 20 * 3600e3;
      if (!arrivalDue && !doneDue) continue;
      const stage = arrivalDue ? 'arrival' : 'completion';
      const mid = await send(to, T_TK_FOLLOW, [placeOf(item), item.title], null,
        `[Follow-up (${stage}) to ${item.staff?.name} — ${placeOf(item)}]`);
      if (!mid) continue;
      if (!preview) {
        await logOut(db, { waNum: to, mid, template: T_TK_FOLLOW, campaignId: camp?.id, category: 'maintenance_tukang',
          content: `[Follow-up ${stage} — ${placeOf(item)}: ${item.title}]` });
        await sbPatch(db, `maintenance_items?id=eq.${item.id}`, {
          ...(arrivalDue ? { arrival_check_at: nowIso() } : { completion_check_at: nowIso() }),
          updated_at: nowIso(),
        });
      }
      out.visit_followups++;

      // A tukang who was due an hour ago and has said nothing is exactly the
      // situation Era needs to hear about while she can still rescue the day.
      // Sent from here rather than by re-arming queue 6, which would repeat
      // the original "he confirmed Tuesday at 9" and read as good news.
      if (arrivalDue && has(T_DISPATCH) && eraNum) {
        const note = `${item.staff?.name || 'The tukang'} was due at ${witaLabel(item.visit_at)} and has not confirmed arriving. I have asked him.`;
        const eraMid = await send(eraNum, T_DISPATCH, [placeOf(item), item.title, note], null,
          `[Dispatch — ${placeOf(item)}: possible no-show]`);
        if (eraMid && !preview) {
          await logOut(db, { waNum: eraNum, mid: eraMid, template: T_DISPATCH, campaignId: camp?.id,
            category: 'maintenance_staff', content: `[Dispatch — ${placeOf(item)}: possible no-show]` });
          await sbPatch(db, `maintenance_items?id=eq.${item.id}`, {
            era_dispatch_update_at: nowIso(), era_dispatch_state: 'awaiting_arrival', updated_at: nowIso(),
          });
        }
        if (eraMid) out.era_updates++;
      }
    }
  }

  // ── 9) Tell a tukang his job was reassigned ───────────────────────
  // He has the job message and the link in his chat. Without this he has no
  // reason to think anything changed, and turns up at the villa.
  if (has(T_TK_CANCEL)) {
    const queue = (await sbGet(db, `maintenance_items?cancel_notice_for=not.is.null&cancel_notice_at=is.null&select=*,statement_groups(key,name),staff:cancel_notice_for(name,wa_num,active)&order=updated_at.asc&limit=25`)) || [];
    for (const item of queue) {
      const to = String(item.staff?.wa_num || '').replace(/\D/g, '');
      // Nobody to tell: close the latch so this never queues again.
      if (!to || !item.staff?.active) {
        if (!preview) await sbPatch(db, `maintenance_items?id=eq.${item.id}`, { cancel_notice_at: nowIso() });
        continue;
      }
      const mid = await send(to, T_TK_CANCEL, [placeOf(item), item.title], null,
        `[Cancelled to ${item.staff.name} — ${placeOf(item)}: ${item.title}]`);
      if (!mid) continue;
      if (!preview) {
        await logOut(db, { waNum: to, mid, template: T_TK_CANCEL, campaignId: camp?.id, category: 'maintenance_tukang',
          content: `[Job cancelled — ${placeOf(item)}: ${item.title}]` });
        await sbPatch(db, `maintenance_items?id=eq.${item.id}`, {
          cancel_notice_at: nowIso(), cancel_notice_for: null, updated_at: nowIso(),
        });
      }
      out.cancels_sent++;
    }
  }

  // Tidy the short-lived "already asked which villa" locks.
  if (!preview) {
    const cutoff = Date.now() - 3600e3;
    await fetch(`${db.SUPABASE_URL}/rest/v1/settings?key=like.maintask:*&value->>at=lt.${cutoff}`, {
      method: 'DELETE', headers: db.sbHeaders,
    }).catch(() => {});
  }

  const sent = out.asked + out.told + out.staff_told + out.nudged + out.completed_told
    + out.jobs_sent + out.era_updates + out.visit_reminders + out.visit_followups + out.cancels_sent;
  if (!preview && sent) await noteRun(db, camp, { sent, failed: out.failed, summary: out });
  return out;
}
