// Receives Telegram webhook events. Handles:
//   1. Replies to forwarded messages → sends via WhatsApp to the matched agent
//      + auto-pauses Maya for that thread (matches CRM inbox behavior).
//   2. Slash commands: /help, /resume <id>, /pause <id>, /stats
//
// Telegram setup (one-time): hit /api/telegram-setup with ?token=<bot_token>
// to register this URL as the bot's webhook.

import { postToTelegram, extractAgentIdFromReply, telegramEnabled } from '../lib/telegram.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).end();
  if (!telegramEnabled()) return res.status(200).end();

  try {
    const update = req.body;
    const msg = update?.message;
    if (!msg) return res.status(200).end();

    // Security: only act on messages from the configured chat ID
    const expectedChat = String(process.env.TELEGRAM_CHAT_ID);
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

// ── Command handlers ───────────────────────────────────────────────

async function handleCommand(cmd, argsStr) {
  if (cmd === '/help' || cmd === '/start') {
    await postToTelegram(
      `<b>KAYA Listings Inbox</b>\n\n` +
      `<b>Reply to any forwarded message</b> to send a message to that agent via WhatsApp. Your reply will pause Maya for that conversation.\n\n` +
      `<b>Slash commands:</b>\n` +
      `/help — this message\n` +
      `/resume &lt;agent_id&gt; — re-enable Maya for an agent\n` +
      `/pause &lt;agent_id&gt; — pause Maya for an agent\n` +
      `/stats — quick activity summary`
    );
    return;
  }
  if (cmd === '/resume' || cmd === '/pause') {
    const id = parseInt(argsStr, 10);
    if (!id) {
      await postToTelegram(`<i>Usage: ${cmd} &lt;agent_id&gt; (the number shown as "agent #N" in forwarded messages)</i>`);
      return;
    }
    const agent = await getAgent(id);
    if (!agent) {
      await postToTelegram(`<i>Agent #${id} not found.</i>`);
      return;
    }
    const override = cmd === '/pause' ? 'paused' : null;
    await patchAgent(id, { automation_override: override });
    const label = cmd === '/pause' ? '⏸ Maya paused' : '▶ Maya resumed';
    await postToTelegram(`${label} for <b>${escapeHtml(agent.name || ('agent #' + id))}</b>.`);
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
