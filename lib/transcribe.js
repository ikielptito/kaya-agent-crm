// Voice-note transcription for the WhatsApp webhook. Agents (especially
// Indonesian ones) send voice notes constantly; transcribing them lets Maya
// answer the actual question instead of apologising that she can't listen.
//
// Providers are tried by env-key presence, cheapest/fastest first:
//   1. GROQ_API_KEY   — whisper-large-v3-turbo (OpenAI-compatible, generous free tier)
//   2. OPENAI_API_KEY — whisper-1
//   3. GEMINI_API_KEY — gemini-2.0-flash (audio understanding)
// No key configured → returns null and the webhook keeps today's graceful
// "could you send that as text?" behaviour. Voice notes are Indonesian or
// English; Whisper auto-detects, so no language hint is passed.

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;   // WhatsApp's own media ceiling

// OpenAI-compatible /audio/transcriptions (Groq + OpenAI share the shape).
async function whisperCompatible(baseUrl, apiKey, model, buffer, mime) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/ogg' }), 'voice-note.ogg');
  form.append('model', model);
  const r = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey },
    body: form,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
  return (d.text || '').trim() || null;
}

async function geminiTranscribe(apiKey, buffer, mime) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: (mime || 'audio/ogg').split(';')[0], data: buffer.toString('base64') } },
        { text: 'Transcribe this voice message verbatim, in its original language. Reply with ONLY the transcript, no commentary.' },
      ] }],
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
  return (d.candidates?.[0]?.content?.parts?.[0]?.text || '').trim() || null;
}

// buffer + mime → transcript string, or null (no provider / all failed).
export async function transcribeAudio(buffer, mime) {
  if (!buffer || buffer.length === 0 || buffer.length > MAX_AUDIO_BYTES) return null;
  const attempts = [];
  if (process.env.GROQ_API_KEY) {
    attempts.push(() => whisperCompatible('https://api.groq.com/openai/v1', process.env.GROQ_API_KEY, 'whisper-large-v3-turbo', buffer, mime));
  }
  if (process.env.OPENAI_API_KEY) {
    attempts.push(() => whisperCompatible('https://api.openai.com/v1', process.env.OPENAI_API_KEY, 'whisper-1', buffer, mime));
  }
  if (process.env.GEMINI_API_KEY) {
    attempts.push(() => geminiTranscribe(process.env.GEMINI_API_KEY, buffer, mime));
  }
  for (const attempt of attempts) {
    try {
      const text = await attempt();
      if (text) return text;
    } catch (e) { console.warn('transcription attempt failed:', e.message); }
  }
  return null;
}

// WhatsApp media id → transcript. Fetches the audio bytes from Meta (bearer
// auth, URL expires in ~5 min) then runs the provider chain.
export async function transcribeWaAudio(mediaId, waToken) {
  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${waToken}` },
  });
  if (!metaRes.ok) return null;
  const meta = await metaRes.json();
  if (!meta.url || !/^audio\//.test(meta.mime_type || '')) return null;
  if (meta.file_size && meta.file_size > MAX_AUDIO_BYTES) return null;
  const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${waToken}` } });
  if (!binRes.ok) return null;
  const buffer = Buffer.from(await binRes.arrayBuffer());
  return transcribeAudio(buffer, meta.mime_type);
}
