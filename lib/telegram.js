// Telegram bot integration — forwards inbound agent messages + Maya replies
// to Ikiel's Telegram, and processes his replies back into WhatsApp sends.
//
// Setup:
// 1. Create a bot via @BotFather → get TELEGRAM_BOT_TOKEN
// 2. Message the bot once → get TELEGRAM_CHAT_ID (visible at
//    https://api.telegram.org/bot<TOKEN>/getUpdates)
// 3. Set both as Vercel env vars
// 4. Hit /api/telegram-webhook (GET) once to register the webhook with Telegram

const TG_API = 'https://api.telegram.org';

export function telegramEnabled() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// Low-level: post a message to your private chat.
// Returns the Telegram message_id (used for reply mapping) or null on failure.
export async function postToTelegram(text, opts = {}) {
  if (!telegramEnabled()) return null;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...opts
    };
    const r = await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const err = await r.text();
      console.warn('Telegram send failed:', r.status, err.slice(0, 200));
      return null;
    }
    const data = await r.json();
    return data?.result?.message_id || null;
  } catch (e) {
    console.warn('Telegram send error:', e.message);
    return null;
  }
}

// Inline keyboard with one-tap Pause/Resume actions.
// Callback data format: "<action>:<agent_id>"
function actionButtons(agent) {
  const isPaused = agent.automation_override === 'paused';
  const toggleBtn = isPaused
    ? { text: '▶ Resume Maya', callback_data: `resume:${agent.id}` }
    : { text: '⏸ Pause Maya', callback_data: `pause:${agent.id}` };
  return {
    inline_keyboard: [[ toggleBtn ]]
  };
}

// Forward an INBOUND agent message to Telegram.
// Includes "— agent #N" footer for the reply-mapping logic + action buttons.
export async function forwardInbound(agent, text, mode) {
  const name = escapeHtml(agent.name || 'Unknown');
  const agency = agent.agency ? ` · ${escapeHtml(agent.agency)}` : '';
  const modeStr = mode ? ` · <i>mode: ${escapeHtml(mode)}</i>` : '';
  const body = `👤 <b>${name}</b>${agency}${modeStr}\n\n${escapeHtml(text)}\n\n<i>— agent #${agent.id}</i>`;
  return postToTelegram(body, { reply_markup: actionButtons(agent) });
}

// Forward MAYA's auto-reply to Telegram so you see what she said.
export async function forwardMayaReply(agent, text) {
  const name = escapeHtml(agent.name || 'Unknown');
  const body = `🤖 <b>Maya → ${name}</b>\n\n${escapeHtml(text)}\n\n<i>— agent #${agent.id}</i>`;
  return postToTelegram(body, { reply_markup: actionButtons(agent) });
}

// Confirm to Telegram that a manual reply was sent.
export async function confirmManualReply(agent, text) {
  const name = escapeHtml(agent.name || 'Unknown');
  const body = `✓ <b>Sent to ${name}</b>\n\n${escapeHtml(text)}\n\n<i>Maya is now paused for this conversation. Use /resume ${agent.id} to re-enable.</i>`;
  return postToTelegram(body);
}

// Parse "agent #N" footer out of a Telegram message that was being replied to.
// Returns the numeric agent ID or null.
export function extractAgentIdFromReply(replyToText) {
  if (!replyToText) return null;
  const m = replyToText.match(/agent\s*#(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
