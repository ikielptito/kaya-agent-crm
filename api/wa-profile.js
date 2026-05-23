export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN = process.env.META_WA_TOKEN;
  const PHONE_ID = process.env.META_WA_PHONE_ID;

  if (!TOKEN || !PHONE_ID) {
    return res.status(500).json({ error: 'Meta WA env vars not configured' });
  }

  const { action, imageBase64 } = req.body || {};

  try {
    if (action === 'set_photo') {
      const imgBuffer = Buffer.from(imageBase64, 'base64');

      // Step 1: Get the app ID from the token (introspect)
      const debugRes = await fetch(
        `https://graph.facebook.com/v19.0/debug_token?input_token=${TOKEN}&access_token=${TOKEN}`
      );
      const debugData = await debugRes.json();
      const appId = debugData?.data?.app_id;

      if (!appId) {
        return res.status(400).json({ error: 'Could not determine app ID', details: debugData });
      }

      // Step 2: Create a resumable upload session
      const sessionRes = await fetch(
        `https://graph.facebook.com/v19.0/${appId}/uploads?file_length=${imgBuffer.length}&file_type=image/png&access_token=${TOKEN}`,
        { method: 'POST' }
      );
      const sessionData = await sessionRes.json();

      if (!sessionRes.ok || !sessionData.id) {
        return res.status(400).json({ error: 'Upload session failed', details: sessionData });
      }

      // Step 3: Upload the file bytes
      const uploadRes = await fetch(
        `https://graph.facebook.com/v19.0/${sessionData.id}`,
        {
          method: 'POST',
          headers: {
            'Authorization': 'OAuth ' + TOKEN,
            'file_offset': '0',
            'Content-Type': 'application/octet-stream',
          },
          body: imgBuffer,
        }
      );
      const uploadData = await uploadRes.json();

      if (!uploadRes.ok || !uploadData.h) {
        return res.status(400).json({ error: 'File upload failed', details: uploadData });
      }

      // Step 4: Set profile photo using the file handle
      const profileRes = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/whatsapp_business_profile`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          profile_picture_handle: uploadData.h,
        }),
      });
      const profileData = await profileRes.json();

      return res.status(profileRes.ok ? 200 : 400).json({
        handle: uploadData.h,
        profileUpdate: profileData,
      });

    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
