// ── WHATSAPP → GOOGLE DRIVE PHOTO PIPELINE ──────────────────────────
// Villa owners send photos in the WhatsApp chat; this uploads them into a
// per-owner Google Drive folder so the Samba portal (which reads galleries
// from public Drive folders) can use them directly as the listing gallery.
//
// Auth: a Google service account, no SDK — the JWT is signed with node
// crypto and exchanged for an access token. Required env (Vercel):
//   GOOGLE_SA_EMAIL        service account email (…@…iam.gserviceaccount.com)
//   GOOGLE_SA_KEY          the private key from the SA JSON (\n-escaped ok)
//   DRIVE_PARENT_FOLDER_ID a Drive folder shared with the SA as Editor;
//                          all villa folders are created inside it
//
// The SA sets "anyone with link can view" on each villa folder it creates,
// which is exactly what the portal's API-key gallery reads require.

import crypto from 'crypto';

const b64url = (s) => Buffer.from(s).toString('base64url');

export const driveConfigured = () =>
  !!(process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_KEY && process.env.DRIVE_PARENT_FOLDER_ID);

// Access token, cached for the lambda's lifetime (tokens live 1h).
let cached = null;
async function getAccessToken() {
  if (cached && cached.exp > Date.now()) return cached.token;
  const email = process.env.GOOGLE_SA_EMAIL;
  const key = String(process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({
      iss: email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    }));
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${signature}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`SA token exchange failed: ${d.error_description || d.error || 'unknown'}`);
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 - 60000 };
  return cached.token;
}

// Create (once) the villa photo folder for an owner and make it publicly
// viewable. Returns the folder id. Callers persist it on owners.drive_folder_id
// so this runs once per owner.
export async function createOwnerFolder(folderName) {
  const token = await getAccessToken();
  const create = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.DRIVE_PARENT_FOLDER_ID],
    }),
  });
  const folder = await create.json();
  if (!create.ok) throw new Error(`Drive folder create failed: ${folder?.error?.message || create.status}`);
  // Anyone-with-link viewer — required for the portal's API-key gallery reads.
  const perm = await fetch(`https://www.googleapis.com/drive/v3/files/${folder.id}/permissions?supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!perm.ok) {
    const pd = await perm.json().catch(() => ({}));
    throw new Error(`Drive permission failed: ${pd?.error?.message || perm.status}`);
  }
  return folder.id;
}

export const folderLink = (folderId) => `https://drive.google.com/drive/folders/${folderId}`;

// Pull the media bytes from WhatsApp (media id → temp URL → bytes) and upload
// into the villa folder. Returns { fileId, count } where count is the folder's
// photo total after upload (Maya tells the owner "that's N photos so far").
export async function uploadWaImageToDrive({ mediaId, waToken, folderId }) {
  // 1. WhatsApp media metadata (URL is short-lived, fetch right before use)
  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${waToken}` },
  });
  const meta = await metaRes.json();
  if (!metaRes.ok || !meta.url) throw new Error(`WA media meta failed: ${meta?.error?.message || metaRes.status}`);
  const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${waToken}` } });
  if (!binRes.ok) throw new Error(`WA media download failed: HTTP ${binRes.status}`);
  const bytes = Buffer.from(await binRes.arrayBuffer());
  const mime = meta.mime_type || 'image/jpeg';
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const name = `wa-${stamp}.${ext}`;

  // 2. Multipart upload to Drive
  const token = await getAccessToken();
  const boundary = 'samba' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: [folderId] }) +
    `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([head, bytes, tail]),
  });
  const file = await up.json();
  if (!up.ok) throw new Error(`Drive upload failed: ${file?.error?.message || up.status}`);

  // 3. Count photos in the folder (for Maya's acknowledgement)
  let count = null;
  try {
    const list = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed=false`)}&fields=files(id)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const ld = await list.json();
    if (list.ok && Array.isArray(ld.files)) count = ld.files.length;
  } catch { /* count is cosmetic */ }
  return { fileId: file.id, count };
}
