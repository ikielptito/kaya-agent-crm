import { PORTFOLIO_CONTEXT, BROCHURES, REPLY_TONE } from '../lib/kb.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_WA_VERIFY_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const WA_TOKEN = process.env.META_WA_TOKEN;
  const WA_PHONE_ID = process.env.META_WA_PHONE_ID;

  // GET — Meta webhook verification handshake
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Verification failed' });
  }

  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.status(200).end();

    const value = body.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.status(200).end(); // status update, not a message

    const fromNum = msg.from;
    const text = msg.text?.body || '';
    const waMessageId = msg.id;
    const timestamp = new Date(parseInt(msg.timestamp) * 1000).toISOString();

    if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(200).end();

    const sbHeaders = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    };

    // Find matching agent
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/agents?wa_num=eq.${fromNum}&select=*`,
      { headers: sbHeaders }
    );
    const agent = (await agentRes.json())?.[0];

    // Store inbound message
    await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({
        agent_id: agent?.id || null, wa_num: fromNum, direction: 'inbound',
        content: text, wa_message_id: waMessageId, timestamp, source: 'webhook'
      })
    });

    if (!agent) return res.status(200).end(); // unknown sender — logged, nothing else

    // Update conversation summary, history, inbox state
    const dateStr = new Date(timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const newLine = `\n[${dateStr}] ${agent.name || 'Agent'}: ${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`;
    const updatedSummary = ((agent.conversation_summary || '') + newLine).slice(-4000);
    const updatedHistory = {
      ...(agent.conversation_history || {}),
      last_contact: dateStr,
      total_messages: ((agent.conversation_history || {}).total_messages || 0) + 1,
      first_contact: (agent.conversation_history || {}).first_contact || dateStr
    };

    // Determine automation mode (per-agent override beats global)
    let globalMode = 'draft';
    try {
      const sRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.automation&select=value`, { headers: sbHeaders });
      const sRow = (await sRes.json())?.[0];
      if (sRow?.value?.mode) globalMode = sRow.value.mode;
    } catch (e) { /* default */ }
    const mode = agent.automation_override || globalMode;

    const patch = {
      conversation_summary: updatedSummary,
      conversation_history: updatedHistory,
      last_inbound_at: timestamp,
      unread_count: (agent.unread_count || 0) + 1
    };

    // OFF — log only
    if (mode === 'off' || !ANTHROPIC_KEY) {
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // Generate a reply with Claude
    const aiResult = await generateReply(ANTHROPIC_KEY, agent, text, mode);

    if (mode === 'draft') {
      // Store suggestion only — nothing sent
      patch.suggested_reply = aiResult.reply || '';
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // HYBRID — auto-send only confident FAQ answers, else escalate
    if (mode === 'hybrid' && aiResult.action === 'escalate') {
      patch.suggested_reply = aiResult.reply || '';
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // HYBRID(auto) or AUTOPILOT — send the reply
    if (aiResult.reply && WA_TOKEN && WA_PHONE_ID) {
      await sendText(WA_PHONE_ID, WA_TOKEN, fromNum, aiResult.reply);
      await logOutbound(SUPABASE_URL, sbHeaders, agent.id, fromNum, aiResult.reply);

      // Send brochure if Claude requested one
      const doc = aiResult.send_doc && BROCHURES[aiResult.send_doc];
      if (doc && doc.url) {
        await sendDocument(WA_PHONE_ID, WA_TOKEN, fromNum, doc.url, doc.filename);
        await logOutbound(SUPABASE_URL, sbHeaders, agent.id, fromNum, `[Document: ${doc.filename}]`);
      }
      // Auto-sent: clear suggestion, don't mark unread
      patch.suggested_reply = '';
      patch.unread_count = 0;
    } else {
      patch.suggested_reply = aiResult.reply || '';
    }

    await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
    return res.status(200).end();

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(200).end();
  }
}

// ── Helpers ──────────────────────────────────────────────

async function patchAgent(url, headers, id, fields) {
  await fetch(`${url}/rest/v1/agents?id=eq.${id}`, {
    method: 'PATCH', headers, body: JSON.stringify(fields)
  }).catch(e => console.warn('patchAgent failed:', e.message));
}

async function logOutbound(url, headers, agentId, waNum, content) {
  await fetch(`${url}/rest/v1/wa_messages`, {
    method: 'POST', headers,
    body: JSON.stringify({
      agent_id: agentId, wa_num: waNum, direction: 'outbound',
      content, timestamp: new Date().toISOString(), source: 'api'
    })
  }).catch(e => console.warn('logOutbound failed:', e.message));
}

async function sendText(phoneId, token, to, text) {
  return fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
}

async function sendDocument(phoneId, token, to, link, filename) {
  return fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'document', document: { link, filename } })
  });
}

async function generateReply(apiKey, agent, inbound, mode) {
  const brochureKeys = Object.keys(BROCHURES).join(', ');
  const isHybrid = mode === 'hybrid';

  const system = `You are replying to a real estate agent on WhatsApp on behalf of Ikiel from KAYA Developments in Bali.

${PORTFOLIO_CONTEXT}

${REPLY_TONE}

The agent's profile and history:
Name: ${agent.name || 'unknown'}
Agency: ${agent.agency || 'independent'}
Conversation so far:
${(agent.conversation_summary || '(no prior history)').slice(-2500)}

You can attach a project brochure PDF. Available brochure keys: ${brochureKeys}.

Respond with ONLY a JSON object (no markdown, no prose):
{
  "action": "auto" | "escalate",
  "reply": "the message to send to the agent",
  "send_doc": null | one of [${brochureKeys}]
}
${isHybrid
  ? `Set "action" to "auto" ONLY if the agent's message is a simple, factual question you can answer with full confidence from the portfolio info above (e.g. commission %, price, availability, sending a brochure). For anything involving negotiation, scheduling, complaints, commitments, or ambiguity, set "action" to "escalate" (Ikiel will review your draft before it sends).`
  : `Set "action" to "auto".`}
Set "send_doc" to a brochure key only if the agent is asking for information/materials about that specific project.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: `The agent just sent: "${inbound}"` }]
      })
    });
    const data = await res.json();
    const raw = data.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        action: parsed.action === 'auto' ? 'auto' : 'escalate',
        reply: parsed.reply || '',
        send_doc: parsed.send_doc || null
      };
    }
    return { action: 'escalate', reply: raw.trim(), send_doc: null };
  } catch (err) {
    console.warn('generateReply failed:', err.message);
    return { action: 'escalate', reply: '', send_doc: null };
  }
}
