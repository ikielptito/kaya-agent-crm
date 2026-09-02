// What Maya remembers about an agent beyond the last 45 messages.
//
// Her working memory is the recent thread — 45 messages, and wa_messages is
// pruned at 90 days — so an agent she has talked to 170 times is met each
// morning with the last two weeks and nothing before. This keeps a short
// synthesis per agent: who they are, the clients they have brought and what
// those clients wanted, what was shown or viewed and how it went, how they
// like to be spoken to, and any open loop. It is rebuilt by Haiku from the
// messages BEHIND the window (plus the previous memory) every ~15 messages,
// so it costs a fraction of a cent per refresh and is never stale by more
// than a fortnight of conversation. It lives in conversation_history.memory.
import { sbRows } from './sb-rows.js';

const MODEL = 'claude-haiku-4-5';
const WINDOW = 45;                 // matches fetchRecentThread
const MIN_TOTAL = 24;              // shorter threads fit in the window anyway
const REFRESH_EVERY = 15;          // inbound+outbound messages between rebuilds
const REFRESH_DAYS = 30;           // ...or a month, for slow threads
const OLDER_LIMIT = 220;           // messages behind the window to read
// wa_messages is pruned at 90 days. A slow thread (one message a week) never
// pushes anything out of the 45-message window before it is pruned, so the
// memory also folds in whatever is older than this, window or not.
const AGE_DAYS = 60;

export function memoryDue(agent, { force = false } = {}) {
  const h = agent?.conversation_history || {};
  const total = Number(h.total_messages || 0);
  if (force) return true;
  if (total < MIN_TOTAL) return false;
  const m = h.memory;
  // A memory record with empty text is a deliberate "nothing behind the
  // window yet" stamp, so the same thread is not re-read every turn.
  if (!m || typeof m !== 'object') return true;
  if (total - Number(m.at_total || 0) >= REFRESH_EVERY) return true;
  return Date.now() - (Date.parse(m.at || 0) || 0) > REFRESH_DAYS * 86400e3;
}

export function memoryBlock(agent) {
  const m = agent?.conversation_history?.memory;
  if (!m?.text) return '';
  return `\nWHAT YOU KNOW ABOUT THIS AGENT (memory from earlier conversations, before the thread below — trust it, and update it silently through client_brief/counterparty rather than re-asking what it already answers):\n${m.text}\n`;
}

async function olderMessages(db, agentId) {
  // Everything behind the window, oldest first, whole text (a client brief
  // is often 400–800 characters and the thread view truncates it).
  const rows = await sbRows(db.SUPABASE_URL, db.sbHeaders,
    `wa_messages?agent_id=eq.${agentId}&select=direction,content,timestamp&order=timestamp.desc`, { page: OLDER_LIMIT + WINDOW, max: OLDER_LIMIT + WINDOW });
  const cutoff = Date.now() - AGE_DAYS * 86400e3;
  const older = [...rows.slice(0, WINDOW).filter(m => Date.parse(m.timestamp) < cutoff), ...rows.slice(WINDOW)].reverse();
  return older.map(m => {
    const d = new Date(m.timestamp).toISOString().slice(0, 10);
    const who = m.direction === 'outbound' ? 'Maya' : 'Agent';
    return `[${d}] ${who}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 600)}`;
  });
}

export async function refreshAgentMemory(db, apiKey, agent, { force = false } = {}) {
  if (!apiKey || !agent?.id) return null;
  if (!memoryDue(agent, { force })) return null;
  const lines = await olderMessages(db, agent.id);
  const prev = agent.conversation_history?.memory?.text || '';
  if (!lines.length && !prev) {
    // Nothing behind the window yet: stamp it so the check is not repeated
    // on every reply until the thread has actually moved on.
    const stamp = { text: '', at: new Date().toISOString(), at_total: Number(agent.conversation_history?.total_messages || 0), from_messages: 0 };
    const history = { ...(agent.conversation_history || {}), memory: stamp };
    await fetch(`${db.SUPABASE_URL}/rest/v1/agents?id=eq.${agent.id}`, {
      method: 'PATCH', headers: { ...db.sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ conversation_history: history }),
    }).catch(() => {});
    agent.conversation_history = history;
    return null;
  }
  const prompt = `You maintain Maya's memory of one real-estate agent she talks to on WhatsApp. Maya is the listings coordinator at Samba Realty (monthly villa rentals in Bali) and KAYA Developments (sales). Agents bring clients; Maya answers, matches villas, arranges viewings, relays questions to villa owners.

Write the memory Maya should carry into her next reply to this agent. 120–200 words, plain prose or short dashes, no headings, no dates unless they matter, no speculation. Cover only what is supported by the messages:
- who they are (name, agency, languages, tone they use, how they like to be answered)
- each client they have brought and what that client wanted (budget, beds, area, dates, pets) and where it ended (viewed, rented elsewhere, went quiet, closed)
- villas shown, viewed or negotiated, and any objection or complaint
- promises made to them and anything still open
- things NOT to repeat (already declined, already told, already asked)

PREVIOUS MEMORY (may be partly stale; fold it in):
${prev || '(none)'}

MESSAGES BEFORE THE RECENT THREAD (oldest first):
${lines.join('\n') || '(none)'}

Reply with the memory text only.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim().slice(0, 2000);
  if (!text) return null;
  const memory = { text, at: new Date().toISOString(), at_total: Number(agent.conversation_history?.total_messages || 0), from_messages: lines.length };
  const history = { ...(agent.conversation_history || {}), memory };
  await fetch(`${db.SUPABASE_URL}/rest/v1/agents?id=eq.${agent.id}`, {
    method: 'PATCH', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ conversation_history: history }),
  }).catch(() => {});
  // Mutate in place so the caller's reply, built from this same object a
  // moment later, already carries the fresh memory.
  agent.conversation_history = history;
  return memory;
}
