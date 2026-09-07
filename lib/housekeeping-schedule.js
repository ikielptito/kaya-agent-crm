// What a housekeeper says about her week, understood as a schedule.
//
// On 7 Sep 2026 three housekeepers told Maya, in plain Indonesian, which
// days they actually work:
//
//   Ana   "Jadwal saya kerja ke laneHaus senin dan jumat"
//         "Jadwal saya hanya 2x seminggu" / "Senin & jumat"
//         "Kecuali ada tamu check in dan check out waktu akan di sesuaikan"
//   Gede  "hari ini jadwal saya cleaning b3 dan b5,,"
//         "untuk jadwal cleaning hari senin dan kamis,,"
//         "untuk unit b2 dan b6 hari rabu dan jumat,,"
//   Ita   "Untuk B4 jadwalnya hari senin"
//         "Saya ingin memberitahukan jadwal kebersihan saya unit A5 pada hari rabu"
//
// Maya had no idea of a weekly pattern, so every one of those was forced
// into the nearest thing she did understand: a finding on an open inspection
// round, or a request to move one task. Ana's week went onto a photo record,
// Gede's pattern moved two inspections to the wrong days, and nobody was
// answered. This module is the missing idea.
//
// The parser is deterministic and pure, so the real messages above are
// pinned in dev/housekeeping-schedule.test.mjs. A statement can arrive split
// across several WhatsApp messages seconds apart (Gede's three lines), so it
// reads the BURST — the person's recent inbound texts — with the villas of
// one clause carrying into the next when the next names only days.
//
// What it produces, and what is done with it:
//   weekly   {slugs, days}   → property_care.clean_days, then the regular
//                              cleans already planned on the old days are
//                              skipped and the new days generated
//   today    [slugs]         → the visit exists today and is confirmed, so
//                              the evening chase asks about the right villas
//   one_off  {slugs, date}   → the visit exists on that date
//   flex                     → "except when a guest checks in or out": an
//                              acknowledgement; stay-driven visits already
//                              land on their own day
//
// Nothing here guesses. A day named for a villa she does not cover is left
// unresolved and said back to her; a single day for a villa that is
// cleaned twice a week is recorded and the other day asked for.

import { getSettingValue } from './campaigns.js';
import { staffByWa } from './staff.js';
import { generateTasks, catalogNames, DEFAULTS } from './housekeeping.js';

const MS_DAY = 86400000;
const nowIso = () => new Date().toISOString();
const plusDays = (d, n) => new Date(Date.parse(d) + n * MS_DAY).toISOString().slice(0, 10);
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const witaToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const GRAPH = 'https://graph.facebook.com/v24.0';

export const DAY_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const DAY_WORDS = {
  senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6,
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
};

// ── Text ────────────────────────────────────────────────────────────
// "Jum'at" and "jum at" are Friday; "B 3" is B3; "laneHaus" is lanehaus.
export function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/jum'?\s?at/g, 'jumat')
    .replace(/\bhari\s+minggu\b/g, 'hari sundayx')       // Sunday, as opposed to "seminggu"
    .replace(/\b([ab])\s(\d{1,2})\b/g, '$1$2')             // "b 3" → "b3"
    .replace(/[^a-z0-9&?]+/g, ' ')
    .replace(/\bsundayx\b/g, 'sunday')
    .trim();
}
const tokens = (t) => normalise(t).split(' ').filter(Boolean);

const QUESTION_RE = /\?|^\s*(kapan|apakah|bisakah|bolehkah|boleh|gimana|bagaimana|kenapa|mengapa|berapa|apa\b)/i;
const ACK_RE = /^\s*(ok(e|ay)?|baik|siap|terima ?kasih|makasih|thanks?|noted|👍|🙏|ya|iya|yes)[\s.!🙏👍😊]*$/i;

// Cheap gate: a day of the week, the word "jadwal", or "per week". Questions
// and acknowledgements are never statements — "Kapan jadwal A5?" is for the
// Q&A path, "Bisakah besok?" is a reply about today's task.
export function looksLikeSchedule(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 600) return false;
  if (QUESTION_RE.test(t) || ACK_RE.test(t)) return false;
  const n = normalise(t);
  // "Saya libur hari Senin" is a day OFF, not a pattern: the task handlers
  // read those (they move or escalate the visit), never this.
  if (/\b(libur|cuti|sakit|izin|tidak bisa|gak bisa|ga bisa|nggak bisa|off)\b/.test(n)) return false;
  if (/\bjadwal/.test(n)) return true;
  if (/\b(seminggu|per minggu|setiap|tiap)\b/.test(n)) return true;
  return tokens(n).some(w => w in DAY_WORDS);
}

// ── Villas ──────────────────────────────────────────────────────────
// Which of HER villas a sentence names. Slugs look like tropicana-a4,
// lanehaus-1, haus-5, villa-saturno: a unit code ("a4", "1") and a property
// word ("tropicana", "lanehaus", "saturno"). "b3" is a unit code by itself;
// "unit 1" needs the property when she covers two properties with a unit 1;
// a property word alone means every unit of it she covers.
const parts = (slug) => String(slug).split('-').filter(Boolean);
const unitCode = (slug) => { const p = parts(slug); const last = p[p.length - 1]; return p.length > 1 && /^[a-z]?\d{1,2}$/.test(last) ? last : null; };
const propWord = (slug) => { const p = parts(slug).filter(x => x !== 'villa' && x !== 'unit'); return unitCode(slug) ? p[0] : p.join(''); };

export function resolveUnits(text, slugs = [], names = {}) {
  const toks = tokens(text);
  const set = new Set(toks);
  const hits = new Set();
  const mine = slugs.map(s => ({ slug: s, code: unitCode(s), prop: propWord(s) }));
  const propsNamed = new Set(mine.filter(m => set.has(m.prop)).map(m => m.prop));
  // Catalog names ("LaneHAUS - Unit 3") as another way to say the property.
  for (const m of mine) {
    const nm = normalise(names[m.slug] || '');
    if (nm && nm.split(' ').filter(w => w.length > 3 && !/^unit$/.test(w)).some(w => set.has(w))) propsNamed.add(m.prop);
  }
  // Letter+digit codes are unambiguous: "b3", "a4".
  for (const m of mine) if (m.code && /^[a-z]\d/.test(m.code) && set.has(m.code)) hits.add(m.slug);
  // Bare digits count only after "unit" (or the property word), and only
  // for one property at a time.
  toks.forEach((w, i) => {
    if (!/^\d{1,2}$/.test(w)) return;
    const prev = toks[i - 1];
    if (!(prev === 'unit' || prev === 'no' || mine.some(m => m.prop === prev))) return;
    const cands = mine.filter(m => m.code === w && (!propsNamed.size || propsNamed.has(m.prop) || m.prop === prev));
    const props = new Set(cands.map(c => c.prop));
    if (props.size === 1) cands.forEach(c => hits.add(c.slug));
  });
  // A property named with no unit: all of hers there.
  for (const p of propsNamed) {
    if (mine.some(m => m.prop === p && hits.has(m.slug))) continue;
    mine.filter(m => m.prop === p).forEach(m => hits.add(m.slug));
  }
  return [...hits];
}

// ── The burst ───────────────────────────────────────────────────────
// messages: her recent texts, oldest first, the current one last.
// Returns what she said, tagged with the index of the message it came from
// so the reply can speak only to what the latest message added.
export function parseScheduleBurst(messages, { slugs = [], names = {}, today = witaToday() } = {}) {
  const out = { weekly: [], today: [], one_off: [], flex: false, per_week: null, unresolved: [] };
  let carry = [];   // villas named by a clause with no days, for the next clause
  (messages || []).forEach((raw, idx) => {
    const text = String(raw || '');
    if (QUESTION_RE.test(text)) return;
    if (/kecuali|except|kalau ada tamu|jika ada tamu|check ?in|check ?out|disesuaikan|di sesuaikan/i.test(text) && !tokens(text).some(w => w in DAY_WORDS)) {
      out.flex = true; out.flexFrom = idx;
    }
    const perWeek = /\b(\d)\s*(x|kali)\s*(se|per\s*)minggu\b/.exec(normalise(text));
    if (perWeek) { out.per_week = parseInt(perWeek[1], 10); out.perWeekFrom = idx; }

    const clauses = text.split(/\n|,,|;|,|\.\s+|\s+(?=untuk\b)/i).map(c => c.trim()).filter(Boolean);
    for (const clause of clauses) {
      const toks = tokens(clause);
      const days = [...new Set(toks.filter(w => w in DAY_WORDS).map(w => DAY_WORDS[w]))];
      let units = resolveUnits(clause, slugs, names);
      const isToday = /\bhari ini\b/.test(normalise(clause));
      const isTomorrow = /\bbesok\b/.test(normalise(clause)) && !isToday;
      const unitWordButNone = !units.length && /\b(unit|villa)\s+[a-z]?\d/.test(normalise(clause));
      // "unit 7 hari senin" from someone who covers no unit 7: said back to
      // her, and never read as "all my villas on Monday".
      if (unitWordButNone) { out.unresolved.push({ from: idx, text: clause }); continue; }

      if (isToday && units.length) {
        out.today.push({ slugs: units, from: idx });
        carry = units;
      }
      if (isTomorrow && (units.length || carry.length)) {
        out.one_off.push({ slugs: units.length ? units : carry, date: plusDays(today, 1), from: idx });
        if (units.length) carry = units;
        continue;
      }
      if (days.length && !isToday) {
        const target = units.length ? units : carry.length ? carry : slugs;
        if (target.length) out.weekly.push({ slugs: target, days: days.sort(), from: idx, all: !units.length && !carry.length });
        if (units.length) carry = units;
        continue;
      }
      if (units.length && !days.length && !isToday) carry = units;
    }
  });
  // Later statements about a villa replace earlier ones in the same burst.
  const bySlug = new Map();
  for (const w of out.weekly) for (const s of w.slugs) bySlug.set(s, { days: w.days, from: w.from, all: w.all });
  out.weeklyBySlug = Object.fromEntries(bySlug);
  return out;
}

// ── Applying it ─────────────────────────────────────────────────────
async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sbPatch(db, path, body) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: { ...db.sbHeaders, Prefer: 'return=representation' }, body: JSON.stringify(body),
  });
  return r.ok ? r.json() : null;
}

// Set a villa's cleaning weekdays and make the schedule agree with it: the
// regular cleans already planned on the old days — never a visit anyone has
// been told about, never one moved by hand — are skipped, and the generator
// fills the new days. Returns what changed.
export async function applyCleanDays(db, { slug, days, actor = 'Maya', note = null, today = witaToday(), regenerate = true } = {}) {
  const clean = [...new Set((days || []).map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/property_care?on_conflict=slug`, {
    method: 'POST',
    headers: { ...db.sbHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ slug, clean_days: clean, updated_at: nowIso(), ...(note ? { notes: String(note).slice(0, 300) } : {}) }),
  });
  if (!r.ok) throw new Error(`property_care → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = (await sbGet(db,
    `housekeeping_tasks?slug=eq.${encodeURIComponent(slug)}&kind=eq.regular&status=eq.planned&notified_at=is.null&moved_by=is.null`
    + `&task_date=gte.${today}&select=id,task_date&limit=200`)) || [];
  const off = rows.filter(t => !clean.includes(weekday(t.task_date)));
  for (const t of off) {
    await sbPatch(db, `housekeeping_tasks?id=eq.${t.id}`, {
      status: 'skipped', notes: `Off the villa's cleaning days (set by ${actor})`, updated_at: nowIso(),
    });
  }
  let generated = null;
  if (regenerate) generated = await generateTasks(db).catch(e => ({ error: e.message }));
  return { slug, clean_days: clean, skipped: off.length, generated };
}

// Make sure a visit exists on `date` for the villa and is confirmed. An
// existing task on that day is confirmed; otherwise the nearest untold
// regular clean within a week is moved onto it; otherwise one is created.
export async function ensureVisit(db, { slug, date, person, kind = 'regular', actor = 'Maya', reason = '' } = {}) {
  const today = witaToday();
  const onDay = (await sbGet(db,
    `housekeeping_tasks?slug=eq.${encodeURIComponent(slug)}&task_date=eq.${date}&status=neq.skipped&select=*&order=kind.asc&limit=5`)) || [];
  const confirm = (t) => sbPatch(db, `housekeeping_tasks?id=eq.${t.id}`, {
    status: t.status === 'done' ? 'done' : 'confirmed', confirmed_at: t.confirmed_at || nowIso(), updated_at: nowIso(),
    thread: [...(t.thread || []), { at: nowIso(), who: person?.name || actor, text: reason || 'Confirmed the visit' }].slice(-50),
  });
  if (onDay.length) {
    for (const t of onDay) if (['planned', 'notified', 'confirmed'].includes(t.status)) await confirm(t);
    return { action: 'confirmed', ids: onDay.map(t => t.id) };
  }
  const near = (await sbGet(db,
    `housekeeping_tasks?slug=eq.${encodeURIComponent(slug)}&kind=eq.${kind}&status=eq.planned&notified_at=is.null`
    + `&task_date=gte.${plusDays(date, -7)}&task_date=lte.${plusDays(date, 7)}&select=*&order=task_date.asc&limit=10`)) || [];
  near.sort((a, b) => Math.abs(Date.parse(a.task_date) - Date.parse(date)) - Math.abs(Date.parse(b.task_date) - Date.parse(date)));
  if (near[0]) {
    const t = near[0];
    await sbPatch(db, `housekeeping_tasks?id=eq.${t.id}`, {
      task_date: date, status: 'confirmed', confirmed_at: nowIso(), moved_by: person?.name || actor, moved_at: nowIso(), updated_at: nowIso(),
      thread: [...(t.thread || []), { at: nowIso(), who: person?.name || actor, text: reason || `Moved to ${date}`, from_date: t.task_date, to_date: date, prev_status: t.status, prev_notified_at: t.notified_at }].slice(-50),
    });
    return { action: 'moved', ids: [t.id], from: t.task_date };
  }
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/housekeeping_tasks?on_conflict=slug,origin_date,kind`, {
    method: 'POST',
    headers: { ...db.sbHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      slug, task_date: date, origin_date: date, kind, status: 'confirmed', confirmed_at: nowIso(),
      assigned_staff_id: person?.id ?? null, same_day: false, guest_out_date: null, guest_in_date: null,
      moved_by: person?.name || actor, moved_at: nowIso(), notes: reason || null, updated_at: nowIso(),
      // She told us herself, so the morning message for it would be noise.
      ...(date <= today ? { notified_at: nowIso() } : {}),
    }),
  });
  const row = r.ok ? (await r.json().catch(() => []))[0] : null;
  return { action: 'created', ids: row ? [row.id] : [] };
}

// Stay-driven visits in the next week that fall outside the villa's days —
// said out loud, because "kecuali ada tamu" is exactly what she expects.
async function offDayGuestVisits(db, slugs, careDays, today) {
  const rows = (await sbGet(db,
    `housekeeping_tasks?slug=in.(${slugs.map(encodeURIComponent).join(',')})&kind=in.(turnover,pre_arrival,deep_clean)`
    + `&status=in.(planned,notified,confirmed)&task_date=gte.${today}&task_date=lte.${plusDays(today, 7)}&select=slug,task_date,kind&order=task_date.asc&limit=20`)) || [];
  return rows.filter(t => (careDays[t.slug] || []).length && !careDays[t.slug].includes(weekday(t.task_date)));
}

const dayList = (days) => {
  const n = [...days].sort().map(d => DAY_ID[d]);
  return n.length <= 1 ? n.join('') : n.slice(0, -1).join(', ') + ' dan ' + n[n.length - 1];
};
const dateId = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortName = (names, slug) => (names[slug] || slug).replace(/^Tropicana Valley - Unit /, '').replace(/^HAUS Canggu - Unit /, 'HAUS ').replace(/^LaneHAUS - Unit /, 'LaneHAUS ');
const listNames = (names, slugs) => {
  const n = slugs.map(s => shortName(names, s));
  return n.length <= 1 ? n.join('') : n.slice(0, -1).join(', ') + ' dan ' + n[n.length - 1];
};
const KIND_ID_SHORT = { turnover: 'tamu check-out', pre_arrival: 'tamu datang (persiapan)', deep_clean: 'pembersihan menyeluruh' };

async function sendText(wa, to, body) {
  if (!wa?.phoneId || !wa?.token) return null;
  const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  return (await r.json().catch(() => ({}))).messages?.[0]?.id || true;
}
async function logOut(db, { waNum, content, mid, category = 'housekeeping' }) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      wa_num: waNum, direction: 'outbound', content, wa_message_id: typeof mid === 'string' ? mid : null,
      timestamp: nowIso(), source: 'webhook', category, status: 'sent',
    }),
  }).catch(() => {});
}
async function say(db, wa, to, body, category = 'housekeeping') {
  const mid = await sendText(wa, to, body);
  await logOut(db, { waNum: to, content: body, mid, category });
  return mid;
}
async function notifyEra(db, wa, line) {
  const era = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
  if (!era) return;
  await say(db, wa, era, line, 'housekeeping').catch(() => {});
}

// Her recent messages, so a statement split over three lines is read whole.
async function recentBurst(db, waNum, { minutes = 20, limit = 6 } = {}) {
  const since = new Date(Date.now() - minutes * 60e3).toISOString();
  const rows = (await sbGet(db,
    `wa_messages?wa_num=eq.${waNum}&direction=eq.inbound&timestamp=gte.${encodeURIComponent(since)}`
    + `&select=content,media_type,timestamp&order=timestamp.desc&limit=${limit}`)) || [];
  return rows.reverse()
    .filter(r => !r.media_type && r.content && !/^\[/.test(r.content))
    .map(r => r.content);
}

// Dry run: what a text (or a burst) would mean for this person.
export async function previewSchedule(db, { person, texts }) {
  const names = await catalogNames(db).catch(() => ({}));
  const parsed = parseScheduleBurst(texts, { slugs: person.slugs || [], names });
  return { person: person.name, slugs: person.slugs, parsed };
}

// ── The handler ─────────────────────────────────────────────────────
// Claims a text that states her schedule. Applies everything the burst
// says (idempotent — every message of a burst re-applies the same facts)
// and replies only about what THIS message added, so three lines get three
// short answers rather than three copies of one long one.
export async function handleScheduleStatement({ db, wa, fromNum, text, mediaId = null, waMessageId = null }) {
  if (mediaId) return false;
  const body = String(text || '').trim();
  if (!looksLikeSchedule(body)) return false;
  const person = await staffByWa(db, fromNum);
  if (!person || !person.active || !(person.roles || []).includes('housekeeper')) return false;
  const slugs = person.slugs || [];
  if (!slugs.length) return false;

  const today = witaToday();
  const names = await catalogNames(db).catch(() => ({}));
  const earlier = await recentBurst(db, fromNum).catch(() => []);
  // The current message is not in the log yet (the webhook writes it after
  // the handler returns), so it is appended; if it somehow is, not twice.
  const burst = earlier[earlier.length - 1] === body ? earlier : [...earlier, body];
  const last = burst.length - 1;
  const parsed = parseScheduleBurst(burst, { slugs, names, today });

  const mine = (list) => list.filter(x => x.from === last);
  const weeklyNow = Object.entries(parsed.weeklyBySlug).filter(([, v]) => v.from === last);
  const todayNow = mine(parsed.today);
  const oneOffNow = mine(parsed.one_off);
  const flexNow = parsed.flex && parsed.flexFrom === last;
  const perWeekNow = parsed.per_week && parsed.perWeekFrom === last;
  const unresolvedNow = mine(parsed.unresolved);
  if (!weeklyNow.length && !todayNow.length && !oneOffNow.length && !flexNow && !perWeekNow && !unresolvedNow.length) return false;

  const cfg = (await getSettingValue(db, 'housekeeping')) || {};
  const perWeek = parseInt(cfg.cleans_per_week, 10) || DEFAULTS.cleans_per_week;
  const lines = [];
  const eraLines = [];
  const careDays = {};
  for (const r of (await sbGet(db, 'property_care?select=slug,clean_days')) || []) careDays[r.slug] = r.clean_days || [];

  // Weekly days, only for the villas this message spoke about (earlier lines
  // of the burst were applied when they arrived).
  const partial = [];
  if (weeklyNow.length) {
    const grouped = new Map();
    for (const [slug, v] of weeklyNow) {
      const key = v.days.join(',');
      if (!grouped.has(key)) grouped.set(key, { days: v.days, slugs: [] });
      grouped.get(key).slugs.push(slug);
    }
    for (const g of grouped.values()) {
      for (const slug of g.slugs) {
        const same = JSON.stringify(careDays[slug] || []) === JSON.stringify(g.days);
        if (!same) {
          await applyCleanDays(db, { slug, days: g.days, actor: person.name, note: `${person.name} on WhatsApp, ${today}: "${body.slice(0, 120)}"`, today, regenerate: false });
          careDays[slug] = g.days;
        }
        if (g.days.length < perWeek) partial.push(slug);
      }
      lines.push(`${listNames(names, g.slugs)}: ${dayList(g.days)}`);
      eraLines.push(`${listNames(names, g.slugs)} → ${g.days.map(d => DAY_ID[d]).join('/')}`);
    }
    await generateTasks(db).catch(() => null);
  }

  // Today: those villas are confirmed for today; other regular cleans of
  // hers today that are off the villa's days (as she has just told us) go.
  for (const t of todayNow) {
    for (const slug of t.slugs) await ensureVisit(db, { slug, date: today, person, reason: `"${body.slice(0, 120)}"` });
    const others = (await sbGet(db,
      `housekeeping_tasks?assigned_staff_id=eq.${person.id}&task_date=eq.${today}&kind=eq.regular&status=in.(planned,notified)`
      + `&select=id,slug&limit=20`)) || [];
    for (const o of others) {
      if (t.slugs.includes(o.slug)) continue;
      const days = careDays[o.slug];
      if (days && days.length && !days.includes(weekday(today))) {
        await sbPatch(db, `housekeeping_tasks?id=eq.${o.id}`, { status: 'skipped', notes: `${person.name} said today is ${listNames(names, t.slugs)}`, updated_at: nowIso() });
      }
    }
    lines.push(`Hari ini: ${listNames(names, t.slugs)} ✅`);
    eraLines.push(`today: ${listNames(names, t.slugs)}`);
  }

  for (const o of oneOffNow) {
    for (const slug of o.slugs) await ensureVisit(db, { slug, date: o.date, person, reason: `"${body.slice(0, 120)}"` });
    lines.push(`${dateId(o.date)}: ${listNames(names, o.slugs)} ✅`);
    eraLines.push(`${o.date}: ${listNames(names, o.slugs)}`);
  }

  for (const u of unresolvedNow) lines.push(`Yang ini belum saya paham villanya: "${u.text}". Villa Anda: ${listNames(names, slugs)}.`);

  let reply;
  if (lines.length) {
    reply = `Siap, sudah saya catat 🙏\n${lines.join('\n')}`;
    for (const slug of partial) {
      reply += `\n\n${shortName(names, slug)} hanya ${dayList(careDays[slug] || [])} saja, atau ada hari lain dalam seminggu?`;
    }
    const guest = await offDayGuestVisits(db, [...new Set([...weeklyNow.map(([s]) => s), ...todayNow.flatMap(t => t.slugs)])], careDays, today).catch(() => []);
    if (guest.length) {
      reply += '\n\nDi luar hari biasa karena ada tamu:\n' + guest.map(g => `• ${dateId(g.task_date)}: ${shortName(names, g.slug)} — ${KIND_ID_SHORT[g.kind] || g.kind}`).join('\n');
    }
  } else if (flexNow) {
    reply = 'Siap 🙏 Kalau ada tamu check-in atau check-out di hari lain, saya kabari khusus di pagi harinya.';
  } else if (perWeekNow) {
    reply = `Baik, ${parsed.per_week}x seminggu 🙏 Hari apa saja? Tulis saja, contoh: "Senin dan Kamis".`;
  } else {
    return false;
  }
  await say(db, wa, fromNum, reply, 'housekeeping');
  if (eraLines.length) await notifyEra(db, wa, `${person.name} set her schedule: ${eraLines.join('; ')}. Said: "${body.slice(0, 160)}"`);
  return true;
}

// A greeting on its own is not a finding and not a report: answer it, so
// "Hallo" does not go onto an inspection record as it did on 7 Sep 2026.
const GREETING_RE = /^\s*(halo+|hallo+|hai|hi|hello|hey|selamat\s+(pagi|siang|sore|malam))(\s+(maya|kak|kaka|bu|mbak))?[\s.!🙏😊☺️👋]*$/i;
export function isGreeting(text) { return GREETING_RE.test(String(text || '')); }
export async function handleGreeting({ db, wa, fromNum, text, mediaId = null }) {
  if (mediaId || !isGreeting(text)) return false;
  const person = await staffByWa(db, fromNum);
  if (!person || !person.active) return false;
  const first = String(person.name || '').split(' ')[0];
  await say(db, wa, fromNum, `Halo ${first} 🙏 Ada yang bisa saya bantu? Kalau soal jadwal, tulis saja harinya, contoh: "Senin dan Kamis".`, 'housekeeping');
  return true;
}
