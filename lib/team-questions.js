// A question Maya has been asked to put to the team, and the conversation
// that answers it.
//
// The team branch of the webhook deliberately never chats: everything Era
// sends that no handler claims is logged and left for a human, so a robot
// can never swallow her ordinary work talk. That rule has one blind spot —
// when WE open a conversation. The payroll questions of 1 Sep were queued,
// pinged and delivered, and then Era's answers would have arrived to dead
// silence: three questions asked, nobody home for the reply.
//
// So this is the bounded exception. A question OBJECT is opened explicitly
// (settings key team_question:<num>) carrying its own briefing — everything
// the model needs to hold the conversation: why we are asking, what we
// already believe, what each answer will be used for. While one is open and
// unexpired, the person's messages are read against it first. Anything
// unrelated falls straight through to the human path, exactly as before.
// When every question is answered, Ikiel gets the structured result on
// Telegram and the object closes. Nothing here runs for anyone else, or
// after expiry, or twice.

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { postToTelegram } from './telegram.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const nowIso = () => new Date().toISOString();
const MODEL = process.env.MAINTENANCE_LLM_MODEL || 'claude-haiku-4-5-20251001';
const EXPIRY_DAYS = 7;

const keyFor = (num) => `team_question:${String(num).replace(/\D/g, '')}`;

async function sendText(wa, to, body) {
  if (!wa?.phoneId || !wa?.token) return null;
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    if (!r.ok) return null;
    return (await r.json().catch(() => ({})))?.messages?.[0]?.id || true;
  } catch { return null; }
}

// Open (or replace) the question object for one number. Called from the
// console via set_settings just as easily; this exists for programmatic use.
export async function openTeamQuestion(db, { num, topic, briefing, questions }) {
  const n = String(num || '').replace(/\D/g, '');
  if (!n || !topic || !Array.isArray(questions) || !questions.length) {
    throw new Error('num, topic and questions[] required');
  }
  const obj = {
    topic,
    briefing: String(briefing || ''),
    questions: questions.map(q => ({ q: String(q), answer: null })),
    status: 'open',
    opened_at: nowIso(),
    expires_at: new Date(Date.now() + EXPIRY_DAYS * 86400e3).toISOString(),
    thread: [],
  };
  await saveSettingValue(db, keyFor(n), obj);
  return obj;
}

// Claim-or-fall-through, the same contract as every staff handler. True only
// when an open question exists AND the model judged this message to be about
// it. "Unrelated" is a first-class outcome: it returns false and the message
// continues to the human path untouched.
export async function handleTeamQuestionReply({ db, wa, fromNum, text, apiKey }) {
  const body = String(text || '').trim();
  if (!body) return false;

  const key = keyFor(fromNum);
  const tq = await getSettingValue(db, key);
  if (!tq || tq.status !== 'open') return false;
  if (tq.expires_at && Date.parse(tq.expires_at) < Date.now()) {
    await saveSettingValue(db, key, { ...tq, status: 'expired' });
    return false;
  }
  if (!apiKey) return false;   // no model, no conversation — leave it for a human

  const open = tq.questions.map((q, i) => ({ i, ...q })).filter(q => !q.answer);
  const answered = tq.questions.map((q, i) => ({ i, ...q })).filter(q => q.answer);
  const prompt =
`${tq.briefing}

QUESTIONS STILL OPEN:
${open.map(q => `${q.i + 1}. ${q.q}`).join('\n')}
${answered.length ? `\nALREADY ANSWERED (do not re-ask):\n${answered.map(q => `${q.i + 1}. ${q.q} → ${q.answer}`).join('\n')}` : ''}
${(tq.thread || []).length ? `\nCONVERSATION SO FAR:\n${tq.thread.slice(-8).map(t => `${t.who}: ${t.text}`).join('\n')}` : ''}

They just wrote: "${body}"

Reply with ONLY a JSON object:
{"related": true|false,
 "answers": [{"index": <1-based question number>, "answer": "<their answer, condensed, keep names and numbers exact>"}],
 "reply": "<a short WhatsApp reply: thank them, confirm what you understood, ask ONE clarifying question only if an answer is genuinely ambiguous. Mirror their language (English or Indonesian). No lists, no formality.>"}

"related" is false when the message has nothing to do with these questions —
then everything else is ignored and a human handles it. Never invent an
answer they did not give. A partial answer to one question is still an answer.`;

  let out = null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });
    if (r.ok) {
      const d = await r.json();
      const t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const m = t.match(/\{[\s\S]*\}/);
      out = m ? JSON.parse(m[0]) : null;
    }
  } catch { /* fall through to the human path */ }
  if (!out || out.related !== true) return false;

  // Merge what she answered, log the exchange, and see where we stand.
  const questions = tq.questions.map((q, i) => {
    const hit = (out.answers || []).find(a => Number(a.index) === i + 1 && a.answer);
    return hit ? { ...q, answer: String(hit.answer).slice(0, 300) } : q;
  });
  const thread = [...(tq.thread || []), { at: nowIso(), who: 'them', text: body.slice(0, 400) }];
  const reply = String(out.reply || '').trim().slice(0, 600);
  if (reply) {
    await sendText(wa, fromNum, reply);
    thread.push({ at: nowIso(), who: 'maya', text: reply.slice(0, 400) });
  }

  const done = questions.every(q => q.answer);
  await saveSettingValue(db, key, {
    ...tq, questions, thread: thread.slice(-20),
    ...(done ? { status: 'answered', answered_at: nowIso() } : {}),
  });

  // The whole point: the answers reach Ikiel as structure, not as a thread
  // he has to remember to go read.
  if (done) {
    await postToTelegram(
      `Team Q&A complete — ${tq.topic}\n` +
      questions.map((q, i) => `${i + 1}. ${q.q}\n   → ${q.answer}`).join('\n'),
    ).catch(() => {});
  }
  return true;
}
