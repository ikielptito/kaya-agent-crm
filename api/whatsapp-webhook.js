export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_WA_VERIFY_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  // GET — Meta webhook verification handshake
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified');
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Verification failed' });
  }

  // POST — incoming message from WhatsApp
  if (req.method === 'POST') {
    try {
      const body = req.body;

      // Confirm this is a WhatsApp message event
      if (body.object !== 'whatsapp_business_account') {
        return res.status(200).end(); // Always 200 to Meta
      }

      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const messages = value?.messages;

      if (!messages || messages.length === 0) {
        return res.status(200).end(); // Could be a status update, not a message
      }

      const msg = messages[0];
      const fromNum = msg.from; // e.g. "6281234567890"
      const text = msg.text?.body || '';
      const waMessageId = msg.id;
      const timestamp = new Date(parseInt(msg.timestamp) * 1000).toISOString();

      if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.warn('Supabase not configured, cannot store message');
        return res.status(200).end();
      }

      const sbHeaders = {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      };

      // Find matching agent by wa_num
      const agentRes = await fetch(
        `${SUPABASE_URL}/rest/v1/agents?wa_num=eq.${fromNum}&select=id,name,conversation_summary,conversation_history`,
        { headers: sbHeaders }
      );
      const agentData = await agentRes.json();
      const agent = agentData?.[0];

      // Store the inbound message
      await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({
          agent_id: agent?.id || null,
          wa_num: fromNum,
          direction: 'inbound',
          content: text,
          wa_message_id: waMessageId,
          timestamp,
          source: 'webhook'
        })
      });

      // Update agent's conversation_summary and history if matched
      if (agent) {
        const dateStr = new Date(timestamp).toLocaleDateString('en-GB', {
          day: '2-digit', month: '2-digit', year: '2-digit'
        });
        const agentName = agent.name || 'Agent';
        const newLine = `\n[${dateStr}] ${agentName}: ${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`;

        const currentSummary = agent.conversation_summary || '';
        const updatedSummary = (currentSummary + newLine).slice(-4000); // Keep last ~4000 chars

        const currentHistory = agent.conversation_history || {};
        const updatedHistory = {
          ...currentHistory,
          last_contact: dateStr,
          total_messages: (currentHistory.total_messages || 0) + 1,
          first_contact: currentHistory.first_contact || dateStr
        };

        await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${agent.id}`, {
          method: 'PATCH',
          headers: sbHeaders,
          body: JSON.stringify({
            conversation_summary: updatedSummary,
            conversation_history: updatedHistory
          })
        });
      }

      return res.status(200).end();

    } catch (err) {
      console.error('Webhook error:', err.message);
      return res.status(200).end(); // Always 200 to Meta even on error
    }
  }

  return res.status(405).end();
}
