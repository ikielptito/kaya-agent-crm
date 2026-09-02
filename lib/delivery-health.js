// The nightly physical of Maya's message delivery.
//
// Everything this reads already existed and nobody was looking at it: the
// status webhook has stamped every failed send with Meta's full reason since
// 2 Aug, and Meta itself publishes the early warnings that precede a
// throttling weekend — the phone number's quality rating and each template's
// quality score, which degrade BEFORE sends start failing. The 29–31 Aug
// incident (52 numbers capped, 18% of outbound failing) sat fully recorded in
// wa_messages while its discovery took a human noticing. This module is that
// human, on a cron.
//
// The division of labour is strict. DETECTION IS ARITHMETIC: counts, deltas
// against a stored baseline, threshold checks — code that cannot hallucinate
// and costs nothing. THE MODEL ONLY NARRATES: when a threshold trips, it is
// handed the actual failing rows and asked to say what broke, who it hit and
// when it started, and that diagnosis goes to Ikiel on Telegram. On a quiet
// day nothing is sent at all — a daily "all fine" message trains its reader
// to ignore the channel.

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { postToTelegram } from './telegram.js';
import { sbRows } from './sb-rows.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const MODEL = process.env.MAINTENANCE_LLM_MODEL || 'claude-haiku-4-5-20251001';
const LOG_KEY = 'delivery_health_log';
const LOG_CAP = 30;                        // a month of nightly snapshots
const FAIL_RATE_ALERT = 0.05;              // 5% of a day's outbound failing
const FAIL_MIN_COUNT = 10;                 // ...but never alert on 1-of-3

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}

const codeOf = (error) => {
  const m = String(error || '').match(/\b(\d{5,6})\b/);
  return m ? m[1] : (error ? 'unparsed' : 'none');
};

// ── The snapshot: pure arithmetic over the last 24h ─────────────────
export async function buildSnapshot(db, { waToken, wabaId, phoneId, now = new Date() } = {}) {
  const since = new Date(now.getTime() - 24 * 3600e3).toISOString();
  const rows = await sbRows(db.SUPABASE_URL, db.sbHeaders,
    `wa_messages?direction=eq.outbound&timestamp=gte.${encodeURIComponent(since)}`
    + `&select=status,error,template_name,category,wa_num&order=id.asc`);

  const out = {
    at: now.toISOString(), window_h: 24, sent: rows.length,
    by_status: {}, failed: 0, fail_rate: 0,
    by_error: {},                          // code → { count, templates{}, sample }
    failed_numbers: 0,
  };
  const failNums = new Set();
  for (const m of rows) {
    const st = m.status || 'untracked';
    out.by_status[st] = (out.by_status[st] || 0) + 1;
    if (st !== 'failed') continue;
    out.failed++;
    if (m.wa_num) failNums.add(m.wa_num);
    const code = codeOf(m.error);
    const e = out.by_error[code] || (out.by_error[code] = { count: 0, templates: {}, sample: null });
    e.count++;
    const t = m.template_name || m.category || 'free-text';
    e.templates[t] = (e.templates[t] || 0) + 1;
    if (!e.sample && m.error) e.sample = String(m.error).slice(0, 160);
  }
  out.failed_numbers = failNums.size;
  out.fail_rate = out.sent ? +(out.failed / out.sent).toFixed(4) : 0;

  // ── Meta's own instruments: the warnings that precede failures ────
  // Both reads are best-effort: a Graph hiccup must never fail the health
  // pass that exists to report failures.
  if (waToken && phoneId) {
    try {
      const r = await fetch(`${GRAPH}/${phoneId}?fields=display_phone_number,quality_rating,messaging_limit_tier`,
        { headers: { Authorization: 'Bearer ' + waToken } });
      if (r.ok) {
        const d = await r.json();
        out.phone = { quality: d.quality_rating || null, limit_tier: d.messaging_limit_tier || null };
      }
    } catch { /* best-effort */ }
  }
  if (waToken && wabaId) {
    try {
      const r = await fetch(`${GRAPH}/${wabaId}/message_templates?fields=name,status,quality_score&limit=200`,
        { headers: { Authorization: 'Bearer ' + waToken } });
      if (r.ok) {
        const d = await r.json();
        out.templates = {};
        for (const t of (d.data || [])) {
          out.templates[t.name] = {
            status: t.status,
            quality: t.quality_score?.score || 'UNKNOWN',
          };
        }
      }
    } catch { /* best-effort */ }
  }
  return out;
}

// ── What counts as "something is wrong" ─────────────────────────────
// Each alert names its evidence, so the diagnosis prompt — and Ikiel — see
// why the pass decided to speak at all.
export function findAlerts(snap, prev) {
  const alerts = [];
  if (snap.failed >= FAIL_MIN_COUNT && snap.fail_rate >= FAIL_RATE_ALERT) {
    alerts.push(`failure rate ${(snap.fail_rate * 100).toFixed(1)}% (${snap.failed}/${snap.sent} sends, ${snap.failed_numbers} numbers)`);
  }
  // A phone-level downgrade is the single strongest predictor of a bad week.
  if (prev?.phone && snap.phone) {
    if (snap.phone.quality !== prev.phone.quality) {
      alerts.push(`phone quality rating changed: ${prev.phone.quality} → ${snap.phone.quality}`);
    }
    if (snap.phone.limit_tier !== prev.phone.limit_tier) {
      alerts.push(`messaging limit tier changed: ${prev.phone.limit_tier} → ${snap.phone.limit_tier}`);
    }
  }
  // Meta pauses or disables a template on its own when recipients block or
  // report it — today that is only discovered when sends start failing.
  if (prev?.templates && snap.templates) {
    for (const [name, t] of Object.entries(snap.templates)) {
      const p = prev.templates[name];
      if (!p) continue;
      if (p.status !== t.status && ['PAUSED', 'DISABLED', 'REJECTED'].includes(t.status)) {
        alerts.push(`template ${name}: ${p.status} → ${t.status}`);
      }
      if (p.quality !== t.quality && ['YELLOW', 'RED'].includes(t.quality)) {
        alerts.push(`template ${name} quality: ${p.quality} → ${t.quality}`);
      }
    }
  }
  // 131053 is ours to fix, not Meta's: it means Meta could not pull a card
  // image from our host. Three in a night is a broken image path, not noise.
  const media = snap.by_error['131053'];
  if (media && media.count >= 3) {
    alerts.push(`${media.count} media upload failures (131053) — Meta could not fetch our card images: ${media.sample || ''}`);
  }
  // An error code we have not seen all month is worth a look regardless of
  // volume — new failure modes start small.
  if (prev) {
    const known = new Set(Object.keys(prev.recent_codes || {}));
    for (const code of Object.keys(snap.by_error)) {
      if (code !== 'none' && !known.has(code) && snap.by_error[code].count >= 3) {
        alerts.push(`new error code ${code} (${snap.by_error[code].count}×): ${snap.by_error[code].sample || ''}`);
      }
    }
  }
  return alerts;
}

// ── The narration, only when there is something to narrate ──────────
async function diagnose(snap, alerts, history, apiKey) {
  if (!apiKey) return null;
  const failLines = Object.entries(snap.by_error)
    .filter(([c]) => c !== 'none')
    .sort((a, b) => b[1].count - a[1].count).slice(0, 6)
    .map(([code, e]) => `  ${code}: ${e.count}× via ${Object.entries(e.templates).map(([t, n]) => `${t}(${n})`).join(', ')} — ${e.sample || ''}`);
  const baseline = history.slice(0, 7).map(h =>
    `  ${(h.at || '').slice(0, 10)}: ${h.sent} sent, ${h.failed} failed (${(h.fail_rate * 100).toFixed(1)}%)`);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 400,
        messages: [{ role: 'user', content:
`You monitor WhatsApp delivery health for Samba Realty's assistant Maya. Alerts tripped tonight:
${alerts.map(a => '- ' + a).join('\n')}

Last 24h failures by Meta error code:
${failLines.join('\n') || '  (none)'}

Daily baseline, most recent first:
${baseline.join('\n') || '  (no history yet)'}

Known context: 131049 is Meta's per-user marketing frequency cap; 131047 is a closed 24h customer window; 131026 is an undeliverable number; 131053 means Meta could not fetch a card image from our own host (our bug); 130472 is a recipient inside a Meta marketing experiment; 131050 is a recipient who blocked marketing from us on WhatsApp. A silence-based digest cadence deployed 31 Aug should reduce marketing volume from 7 Sep.

Write a 3–5 sentence diagnosis for the operator: what is failing, since when, which cohort or template it concentrates in, most likely root cause, and the one action you would take first. Plain text, no markdown, no preamble.` }],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim().slice(0, 900) || null;
  } catch { return null; }
}

// ── The nightly pass ────────────────────────────────────────────────
export async function runDeliveryHealth(db, { waToken, wabaId, phoneId, apiKey, preview = false, now = new Date() } = {}) {
  const history = (await getSettingValue(db, LOG_KEY)) || [];
  const prev = history[0] || null;
  const snap = await buildSnapshot(db, { waToken, wabaId, phoneId, now });

  // Every code seen in the last 30 snapshots, so "new code" means new this
  // month rather than new since yesterday.
  const recentCodes = { ...(prev?.recent_codes || {}) };
  for (const c of Object.keys(snap.by_error)) recentCodes[c] = (snap.at || '').slice(0, 10);
  snap.recent_codes = recentCodes;

  const alerts = findAlerts(snap, prev);
  // The weekly self-review is the only thing that changes how Maya replies.
  // If nothing has been staged or decided in nine days, the loop is broken.
  try {
    const [pending, playbook] = await Promise.all([getSettingValue(db, 'maya_review_pending'), getSettingValue(db, 'maya_playbook')]);
    const lastAt = Math.max(Date.parse(pending?.generated_at || 0) || 0, Date.parse(playbook?.updated_at || 0) || 0);
    if (lastAt && now.getTime() - lastAt > 9 * 86400e3) {
      alerts.push(`Maya's weekly self-review has not run since ${new Date(lastAt).toISOString().slice(0, 10)} — check the Sunday cron (?review=run)`);
    }
  } catch { /* best-effort */ }
  snap.alerts = alerts;

  let diagnosis = null;
  if (alerts.length && !preview) {
    diagnosis = await diagnose(snap, alerts, history, apiKey);
    await postToTelegram(
      `Maya delivery health — ${alerts.length} alert${alerts.length > 1 ? 's' : ''}\n`
      + alerts.map(a => '• ' + a).join('\n')
      + (diagnosis ? `\n\n${diagnosis}` : ''),
    ).catch(() => {});
  }

  if (!preview) {
    // Templates blob repeats mostly-static data; keep only the latest full
    // copy and store deltas-worth on history entries to hold the ring small.
    const slim = { ...snap };
    if (history[0]?.templates) delete history[0].templates;
    await saveSettingValue(db, LOG_KEY, [slim, ...history].slice(0, LOG_CAP));
  }
  return { snapshot: snap, alerts, diagnosis };
}

// ── The trend: the same arithmetic over N weeks ─────────────────────
// The nightly snapshot answers "did something break last night". It cannot
// answer "has delivery been sliding for a month" — a slow decline never trips
// a 24h threshold. This buckets outbound by ISO week (Monday start, WITA)
// and reports, per week: volume, status mix, failure codes, and which
// categories carry the failures, alongside inbound volume as the reply
// signal. Read-only; nothing here writes or narrates.
export async function buildTrend(db, { days = 70, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400e3).toISOString();
  const [outRows, inRows] = await Promise.all([
    sbRows(db.SUPABASE_URL, db.sbHeaders, `wa_messages?direction=eq.outbound&timestamp=gte.${encodeURIComponent(since)}`
      + `&select=status,error,template_name,category,wa_num,timestamp&order=timestamp.asc`),
    sbRows(db.SUPABASE_URL, db.sbHeaders, `wa_messages?direction=eq.inbound&timestamp=gte.${encodeURIComponent(since)}`
      + `&select=wa_num,timestamp&order=timestamp.asc`),
  ]);
  const WITA = 8 * 3600e3;
  const weekOf = (ts) => {
    const d = new Date(new Date(ts).getTime() + WITA);
    const day = (d.getUTCDay() + 6) % 7;             // Monday = 0
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  };
  const weeks = {};
  const wk = (ts) => {
    const k = weekOf(ts);
    return weeks[k] || (weeks[k] = {
      week: k, sent: 0, by_status: {}, failed: 0, fail_rate: 0,
      by_error: {}, by_category: {}, by_day: {}, failed_numbers: new Set(),
      recipients: new Set(), inbound: 0, inbound_numbers: new Set(),
    });
  };
  for (const m of (outRows || [])) {
    const w = wk(m.timestamp);
    w.sent++;
    if (m.wa_num) w.recipients.add(m.wa_num);
    const st = m.status || 'untracked';
    w.by_status[st] = (w.by_status[st] || 0) + 1;
    const cat = m.category || (m.template_name ? 'template' : 'free-text');
    const c = w.by_category[cat] || (w.by_category[cat] = { sent: 0, failed: 0, read: 0, delivered: 0, stuck: 0 });
    c.sent++;
    if (st === 'read') c.read++;
    if (st === 'delivered') c.delivered++;
    // Accepted by Meta, never delivered: phone off for days, or we are blocked.
    if (st === 'sent') c.stuck++;
    const day = new Date(new Date(m.timestamp).getTime() + WITA).toISOString().slice(0, 10);
    w.by_day[day] = (w.by_day[day] || 0) + 1;
    if (st !== 'failed') continue;
    w.failed++; c.failed++;
    if (m.wa_num) w.failed_numbers.add(m.wa_num);
    const code = codeOf(m.error);
    const e = w.by_error[code] || (w.by_error[code] = { count: 0, templates: {}, sample: null });
    e.count++;
    const t = m.template_name || m.category || 'free-text';
    e.templates[t] = (e.templates[t] || 0) + 1;
    if (!e.sample && m.error) e.sample = String(m.error).slice(0, 120);
  }
  for (const m of (inRows || [])) {
    const w = wk(m.timestamp);
    w.inbound++;
    if (m.wa_num) w.inbound_numbers.add(m.wa_num);
  }
  return Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week)).map(w => {
    const tracked = w.sent - (w.by_status.untracked || 0);
    return {
      ...w,
      fail_rate: w.sent ? +(w.failed / w.sent).toFixed(4) : 0,
      read_rate: tracked ? +(((w.by_status.read || 0) / tracked).toFixed(4)) : null,
      recipients: w.recipients.size,
      failed_numbers: w.failed_numbers.size,
      inbound_numbers: w.inbound_numbers.size,
    };
  });
}
