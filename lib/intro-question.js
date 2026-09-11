// The intro question — rung two of the introduction ladder.
//
// A carousel asks nothing, so nobody answers it. This rung asks one thing an
// agent can answer with a tap: are you a rental agent, and may I send what's
// open? Copy approved by Ikiel 11 Sep 2026 (template samba_intro_question_v1,
// bilingual, three quick replies). Each tap has one deterministic outcome:
//   Yes          → opted in, three listing cards + their personal link, then Maya
//   Not an agent → declined_not_agent + alerts opt-out; never messaged again
//   Not now      → intro_stalled; a later message from them still promotes
// The Monday digest (lib/intro-follow.js) becomes rung three, and only for
// contacts who have had the question.

import { sambaStatus, INTRO_SENT, INTRO_STALLED } from './tiers.js';

export const INTRO_QUESTION_TEMPLATE = 'samba_intro_question_v1';
export const INTRO_QUESTION_CATEGORY = 'availability_intro_question';
export const INTRO_QUESTION_BUTTONS = ['Yes, send them', 'Not an agent', 'Not now'];

export const INTRO_QUESTION_BODY = `Hi {{1}}, are you a rental agent in Bali? I'm Maya from Samba Realty. Our owners need tenants for their homes and we pay 10% commission to the agent who brings one. Can I send you what's open?

Halo {{1}}, apakah Anda agen sewa properti di Bali? Saya Maya dari Samba Realty. Pemilik kami butuh penyewa dan kami bayar komisi 10% ke agen yang membawa penyewa. Boleh saya kirim yang tersedia?`;

export const INTRO_QUESTION_DEFAULTS = {
  intro_question_daily_cap: 15,   // per non-Monday day; 0 switches the rung off
  intro_question_gap_days: 13,    // after the intro carousel
};

export function introQuestionConfig(config = {}) {
  const out = { ...INTRO_QUESTION_DEFAULTS };
  for (const k of Object.keys(out)) {
    const n = parseInt(config[k], 10);
    if (config[k] !== undefined && config[k] !== null && config[k] !== '' && !Number.isNaN(n) && n >= 0) out[k] = n;
  }
  return out;
}

const daysSince = (iso, now) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? Infinity : (now.getTime() - t) / 8.64e7;
};

/** Pure: introduced, silent, never asked, past the gap. */
export function introQuestionDue(agent, cfg, now = new Date()) {
  if (sambaStatus(agent) !== INTRO_SENT) return false;
  const samba = agent.campaign_engagement.samba;
  if (samba.intro_question_at) return false;
  return daysSince(samba.intro_at || agent.last_availability_alert_at, now) >= cfg.intro_question_gap_days;
}

/** Pure: today's batch, oldest intro first, capped. */
export function pickIntroQuestions(agents, config, now, gate = () => true) {
  const cfg = introQuestionConfig(config);
  if (cfg.intro_question_daily_cap <= 0) return [];
  return agents
    .filter(a => introQuestionDue(a, cfg, now) && gate(a))
    .sort((a, b) => Date.parse(a.campaign_engagement.samba.intro_at || 0) - Date.parse(b.campaign_engagement.samba.intro_at || 0) || a.id - b.id)
    .slice(0, cfg.intro_question_daily_cap);
}

export function stampIntroQuestion(agent, now = new Date()) {
  const samba = agent.campaign_engagement?.samba || {};
  return { ...(agent.campaign_engagement || {}), samba: { ...samba, intro_question_at: now.toISOString() } };
}

/**
 * Pure: which button did an introduced contact tap? Template quick replies
 * arrive with the button text as payload; match on wording, either language,
 * so a resubmitted template with the same labels keeps working.
 */
export function classifyIntroButton(payload, label) {
  const s = String(label || payload || '').toLowerCase().trim();
  if (!s) return null;
  if (/^(yes|ya|iya|boleh)\b/.test(s) || /send them|kirim/.test(s)) return 'yes';
  if (/not an agent|bukan agen/.test(s)) return 'not_agent';
  if (/not now|nanti|lain kali/.test(s)) return 'not_now';
  return null;
}

/** Only contacts on the ladder get the deterministic tap handling. */
export function onIntroLadder(agent) {
  const st = sambaStatus(agent);
  return st === INTRO_SENT || st === INTRO_STALLED;
}

/** The samba record after each tap. */
export function introTapPatch(agent, tap, now = new Date()) {
  const ce = agent.campaign_engagement || {};
  const samba = ce.samba || {};
  const ts = now.toISOString();
  if (tap === 'yes') return { campaign_engagement: { ...ce, samba: { ...samba, status: 'opted_in', opted_in_at: ts, opted_in_via: 'intro_question_yes' } } };
  if (tap === 'not_agent') return { samba_alerts_opt_out: true, campaign_engagement: { ...ce, samba: { ...samba, status: 'declined_not_agent', declined_at: ts } } };
  if (tap === 'not_now') return { campaign_engagement: { ...ce, samba: { ...samba, status: INTRO_STALLED, stalled_at: ts, stalled_via: 'intro_question_not_now' } } };
  return null;
}

const firstName = (name) => {
  const n = String(name || '').trim();
  if (!n || /^\+?\d/.test(n)) return '';
  return n.split(/\s+/)[0];
};

/** What Maya says after each tap. Cards go out separately after the 'yes' text. */
export function introTapReply(agent, tap) {
  const fn = firstName(agent.name);
  const hi = fn ? `${fn}, ` : '';
  if (tap === 'yes') {
    return `Great, ${hi}here are three you can offer today. 10% commission on the rent, paid by us. Your personal link: https://sambarentals.com/?aid=${agent.id} — every enquiry through it is credited to you. Tell me the area or budget your clients ask for and I'll send closer matches.`;
  }
  if (tap === 'not_agent') return `Understood, thank you for letting me know — I won't message you again. / Baik, terima kasih sudah memberi tahu — saya tidak akan mengirim pesan lagi.`;
  if (tap === 'not_now') return `No problem${fn ? `, ${fn}` : ''} — I'll leave it there. If a client ever needs a monthly rental in Bali, just message me. / Tidak masalah, kapan saja ada klien yang butuh sewa bulanan di Bali, cukup kirim pesan.`;
  return '';
}

/** Pure: the three opening cards — available now first, then the rest, spread across listings. */
export function pickOpeningCards(cards, max = 3) {
  const avail = cards.filter(c => /available now/i.test(c.subtitle || '') || /available/i.test(c.badge || ''));
  const rest = cards.filter(c => !avail.includes(c));
  return [...avail, ...rest].slice(0, max);
}
