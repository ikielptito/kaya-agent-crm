// Receives Telegram webhook events. Handles:
//   1. Replies to forwarded messages → sends via WhatsApp to the matched agent
//      + auto-pauses Maya for that thread (matches CRM inbox behavior).
//   2. Slash commands: /help, /resume <id>, /pause <id>, /stats
//
// Telegram setup (one-time): hit this endpoint via GET (in a browser) to
// register the webhook URL with Telegram and send a confirmation message.

import { postToTelegram, extractAgentIdFromReply, telegramEnabled } from '../lib/telegram.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

export default async function handler(req, res) {
  // GET = one-time setup (registers this URL as the Telegram bot's webhook)
  if (req.method === 'GET') {
    return handleSetup(req, res);
  }
  if (req.method !== 'POST') return res.status(200).end();
  if (!telegramEnabled()) return res.status(200).end();

  try {
    const update = req.body;
    const expectedChat = String(process.env.TELEGRAM_CHAT_ID);

    // ── Button tap (inline keyboard callback) ─────────────────────
    if (update?.callback_query) {
      const cb = update.callback_query;
      if (String(cb.from?.id) !== expectedChat) return res.status(200).end();
      await handleCallback(cb);
      return res.status(200).end();
    }

    const msg = update?.message;
    if (!msg) return res.status(200).end();

    // Security: only act on messages from the configured chat ID
    if (String(msg.chat?.id) !== expectedChat) return res.status(200).end();

    const text = (msg.text || '').trim();

    // ── Slash commands ────────────────────────────────────────────
    if (text.startsWith('/')) {
      const [cmd, ...args] = text.split(/\s+/);
      await handleCommand(cmd.toLowerCase(), args.join(' ').trim());
      return res.status(200).end();
    }

    // ── Reply to a forwarded message ─────────────────────────────
    const replyTo = msg.reply_to_message;
    if (!replyTo) {
      await postToTelegram(`<i>Tip: to reply to an agent, use Telegram's "Reply" feature on one of my forwarded messages. Or use /help for commands.</i>`);
      return res.status(200).end();
    }

    const agentId = extractAgentIdFromReply(replyTo.text || replyTo.caption);
    if (!agentId) {
      await postToTelegram(`<i>Couldn't find an agent reference in the message you replied to. Try replying to a more recent forwarded message.</i>`);
      return res.status(200).end();
    }

    // Look up the agent
    const agent = await getAgent(agentId);
    if (!agent) {
      await postToTelegram(`<i>Agent #${agentId} not found.</i>`);
      return res.status(200).end();
    }

    // Send via WhatsApp + pause Maya
    const result = await sendWhatsAppReply(agent, text);
    if (result.ok) {
      await postToTelegram(`✓ <b>Sent to ${escapeHtml(agent.name || 'agent')}</b>\n\n${escapeHtml(text)}\n\n<i>Maya is now paused for this conversation. Use /resume ${agent.id} to re-enable.</i>`);
    } else {
      await postToTelegram(`❌ <b>Send failed for ${escapeHtml(agent.name || 'agent')}</b>\n\n${escapeHtml(result.error || 'unknown error')}`);
    }
    return res.status(200).end();

  } catch (err) {
    console.error('telegram-webhook error:', err);
    return res.status(200).end();
  }
}

// ── Setup handler (GET) ───────────────────────────────────────────
// Hit /api/telegram-webhook in a browser after deploying to register the
// webhook URL with Telegram. Sends a confirmation message if successful.
async function handleSetup(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not configured.' });
  }
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const webhookUrl = `${protocol}://${host}/api/telegram-webhook`;
  try {
    const setRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: false })
    });
    const setData = await setRes.json();
    let confirmSent = false;
    if (chatId && setData.ok) {
      const confirmRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '✓ <b>KAYA Listings Inbox is connected.</b>\n\nYou\'ll get push notifications for every inbound agent message. Reply to any forwarded message to send via WhatsApp. Try /help for commands.',
          parse_mode: 'HTML'
        })
      });
      confirmSent = (await confirmRes.json())?.ok || false;
    }
    return res.status(200).json({
      ok: setData.ok, webhook_url: webhookUrl,
      telegram_response: setData,
      confirmation_message_sent: confirmSent,
      next_step: confirmSent ? 'Check Telegram for the confirmation message.' : 'Webhook registered.'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ── Command handlers ───────────────────────────────────────────────

async function handleCommand(cmd, argsStr) {
  if (cmd === '/help' || cmd === '/start') {
    await postToTelegram(
      `<b>KAYA Listings Inbox</b>\n\n` +
      `<b>Tap the button</b> on any forwarded message to pause or resume Maya instantly.\n\n` +
      `<b>Reply to any forwarded message</b> (Telegram's "Reply" feature) to send a WhatsApp message to that agent. Your reply pauses Maya automatically.\n\n` +
      `<b>Slash commands</b> (accept name or ID):\n` +
      `/help — this message\n` +
      `/resume &lt;name or id&gt; — e.g. /resume ikiel or /resume 10000\n` +
      `/pause &lt;name or id&gt; — pause Maya for an agent\n` +
      `/stats — today's activity summary`
    );
    return;
  }
  if (cmd === '/resume' || cmd === '/pause') {
    if (!argsStr) {
      await postToTelegram(`<i>Usage: ${cmd} &lt;agent_name_or_id&gt; — e.g. ${cmd} ikiel or ${cmd} 10000</i>`);
      return;
    }
    // Look up by ID (if numeric) or by name (fuzzy match)
    const lookup = await resolveAgent(argsStr);
    if (lookup.error) {
      await postToTelegram(`<i>${lookup.error}</i>`);
      return;
    }
    const agent = lookup.agent;
    const override = cmd === '/pause' ? 'paused' : null;
    await patchAgent(agent.id, { automation_override: override });
    const label = cmd === '/pause' ? '⏸ Maya paused' : '▶ Maya resumed';
    await postToTelegram(`${label} for <b>${escapeHtml(agent.name || ('agent #' + agent.id))}</b>.`);
    return;
  }
  if (cmd === '/stats') {
    const stats = await getStats();
    await postToTelegram(
      `<b>Today's activity</b>\n\n` +
      `📥 Inbound today: ${stats.inboundToday}\n` +
      `📤 Outbound today: ${stats.outboundToday}\n` +
      `🔴 Unread agents: ${stats.unreadCount}\n` +
      `⏸ Paused conversations: ${stats.pausedCount}\n` +
      `💰 Claude spend today: $${stats.spendToday.toFixed(2)} of $2.00`
    );
    return;
  }
  await postToTelegram(`<i>Unknown command. Try /help.</i>`);
}

// ── Callback (inline button tap) handler ───────────────────────────
async function handleCallback(cb) {
  const data = cb.data || '';
  const [action, agentIdStr] = data.split(':');
  const agentId = parseInt(agentIdStr, 10);
  if (!agentId || !['pause', 'resume'].includes(action)) {
    await answerCallback(cb.id, 'Unknown action');
    return;
  }
  const agent = await getAgent(agentId);
  if (!agent) {
    await answerCallback(cb.id, `Agent #${agentId} not found`);
    return;
  }
  const override = action === 'pause' ? 'paused' : null;
  await patchAgent(agentId, { automation_override: override });
  const label = action === 'pause' ? '⏸ Maya paused' : '▶ Maya resumed';
  // Toast confirmation on the button press
  await answerCallback(cb.id, `${label} for ${agent.name || ('agent #' + agentId)}`);
  // Persistent confirmation in the chat
  await postToTelegram(`${label} for <b>${escapeHtml(agent.name || ('agent #' + agentId))}</b>.`);
}

async function answerCallback(callbackQueryId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
    });
  } catch (e) { /* non-fatal */ }
}

// Resolve an agent by ID (if numeric) or by name (fuzzy match).
// Returns { agent } on success or { error } on failure.
async function resolveAgent(input) {
  const trimmed = input.trim();
  // If purely numeric → treat as ID
  if (/^\d+$/.test(trimmed)) {
    const agent = await getAgent(parseInt(trimmed, 10));
    if (!agent) return { error: `Agent #${trimmed} not found.` };
    return { agent };
  }
  // Otherwise → search by name (case-insensitive, prefers prefix match)
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/agents?name=ilike.*${encodeURIComponent(trimmed)}*&select=id,name,agency&limit=10`;
    const r = await fetch(url, { headers: sbHeaders() });
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return { error: `No agent matching "${trimmed}".` };
    }
    if (rows.length === 1) return { agent: rows[0] };
    // Multiple matches → ask user to disambiguate
    const list = rows.slice(0, 5).map(a => `• ${escapeHtml(a.name)}${a.agency ? ' (' + escapeHtml(a.agency) + ')' : ''} — #${a.id}`).join('\n');
    return { error: `Multiple agents match "${trimmed}":\n\n${list}\n\nTry the agent ID instead.` };
  } catch (e) {
    return { error: `Lookup failed: ${e.message}` };
  }
}

// ── Supabase helpers ───────────────────────────────────────────────

async function getAgent(id) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/agents?id=eq.${id}&select=*`, {
    headers: sbHeaders()
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows?.[0] || null;
}

async function patchAgent(id, fields) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/agents?id=eq.${id}`, {
    method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(fields)
  }).catch(() => {});
}

async function getStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  try {
    const [inbound, outbound, unread, paused, settings] = await Promise.all([
      fetch(`${process.env.SUPABASE_URL}/rest/v1/wa_messages?direction=eq.inbound&timestamp=gte.${todayIso}&select=id`, { headers: sbHeaders() }).then(r => r.json()),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/wa_messages?direction=eq.outbound&timestamp=gte.${todayIso}&select=id`, { headers: sbHeaders() }).then(r => r.json()),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/agents?unread_count=gt.0&select=id`, { headers: sbHeaders() }).then(r => r.json()),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/agents?automation_override=eq.paused&select=id`, { headers: sbHeaders() }).then(r => r.json()),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/settings?key=eq.daily_usage&select=value`, { headers: sbHeaders() }).then(r => r.json())
    ]);
    const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const spendToday = settings?.[0]?.value?.[today] || 0;
    return {
      inboundToday: Array.isArray(inbound) ? inbound.length : 0,
      outboundToday: Array.isArray(outbound) ? outbound.length : 0,
      unreadCount: Array.isArray(unread) ? unread.length : 0,
      pausedCount: Array.isArray(paused) ? paused.length : 0,
      spendToday
    };
  } catch (e) {
    return { inboundToday: 0, outboundToday: 0, unreadCount: 0, pausedCount: 0, spendToday: 0 };
  }
}

function sbHeaders() {
  return {
    'apikey': process.env.SUPABASE_KEY,
    'Authorization': 'Bearer ' + process.env.SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
}

// ── WhatsApp send ──────────────────────────────────────────────────

async function sendWhatsAppReply(agent, text) {
  const phoneId = process.env.META_WA_PHONE_ID;
  const token = process.env.META_WA_TOKEN;
  if (!phoneId || !token || !agent.wa_num) {
    return { ok: false, error: 'Missing WhatsApp config or agent has no wa_num' };
  }
  try {
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: agent.wa_num,
        type: 'text',
        text: { body: text }
      })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return { ok: false, error: err.error?.message || `HTTP ${r.status}` };
    }
    // Log outbound + pause Maya
    const sbH = sbHeaders();
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/wa_messages`, {
      method: 'POST', headers: sbH,
      body: JSON.stringify({
        agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
        content: text, timestamp: new Date().toISOString(), source: 'telegram'
      })
    }).catch(() => {});
    await patchAgent(agent.id, {
      automation_override: 'paused',
      suggested_reply: '',
      unread_count: 0
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
