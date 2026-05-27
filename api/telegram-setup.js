// One-shot endpoint to register the Telegram bot's webhook URL.
// After deploying with TELEGRAM_BOT_TOKEN set, hit:
//   https://kaya-agent-crm.vercel.app/api/telegram-setup
// And Telegram will start sending updates to /api/telegram-webhook.
//
// Optional query param ?force=1 to force re-registration even if already set.

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) {
    return res.status(500).json({
      ok: false,
      error: 'TELEGRAM_BOT_TOKEN not configured. Set it in Vercel env vars first.'
    });
  }

  // Derive the webhook URL from the request host
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const webhookUrl = `${protocol}://${host}/api/telegram-webhook`;

  try {
    // Step 1: check current webhook
    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const info = await infoRes.json();

    // Step 2: register webhook
    const setRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message', 'edited_message'],
        drop_pending_updates: false
      })
    });
    const setData = await setRes.json();

    // Step 3: send a confirmation message if chatId is configured
    let confirmSent = false;
    if (chatId && setData.ok) {
      const confirmRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '✓ <b>KAYA Listings Inbox is connected.</b>\n\nYou\'ll get push notifications for every inbound agent message. Reply to any forwarded message to send via WhatsApp. Try /help for commands.',
          parse_mode: 'HTML'
        })
      });
      confirmSent = (await confirmRes.json())?.ok || false;
    }

    return res.status(200).json({
      ok: setData.ok,
      webhook_url: webhookUrl,
      telegram_response: setData,
      previous_webhook: info?.result || null,
      confirmation_message_sent: confirmSent,
      next_step: confirmSent
        ? 'Check your Telegram — you should see a confirmation message from the bot.'
        : 'Webhook registered. If TELEGRAM_CHAT_ID is set, you would also have received a confirmation message.'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
