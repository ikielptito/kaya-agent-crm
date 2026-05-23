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
      // Step 1: Upload image as media
      const boundary = '----FormBoundary' + Date.now();
      const imgBuffer = Buffer.from(imageBase64, 'base64');

      const bodyParts = [
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="messaging_product"\r\n\r\n`,
        `whatsapp\r\n`,
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="type"\r\n\r\n`,
        `image/png\r\n`,
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="file"; filename="profile.png"\r\n`,
        `Content-Type: image/png\r\n\r\n`,
      ];

      const header = Buffer.from(bodyParts.join(''));
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const fullBody = Buffer.concat([header, imgBuffer, footer]);

      const uploadRes = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/media`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TOKEN,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: fullBody,
      });
      const uploadData = await uploadRes.json();

      if (!uploadRes.ok || !uploadData.id) {
        return res.status(400).json({ error: 'Media upload failed', details: uploadData });
      }

      // Step 2: Set profile photo using the media handle
      const profileRes = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/whatsapp_business_profile`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          profile_picture_handle: uploadData.id,
        }),
      });
      const profileData = await profileRes.json();

      return res.status(profileRes.ok ? 200 : 400).json({
        mediaId: uploadData.id,
        profileUpdate: profileData,
      });

    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
