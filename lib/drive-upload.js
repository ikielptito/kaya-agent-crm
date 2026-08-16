// ── WHATSAPP → GOOGLE DRIVE PHOTO PIPELINE ──────────────────────────
// Villa owners send photos in the WhatsApp chat; this uploads them into a
// per-owner Google Drive folder so the Samba portal (which reads galleries
// from public Drive folders) can use them directly as the listing gallery.
//
// Auth (Vercel env, same values as the sambarentals project) — two modes:
//
// PREFERRED — OAuth as the Drive owner (works on personal Gmail):
//   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN
//   Minted once with availability_checker's dev/get-drive-token.mjs
//   (drive.file scope). Uploads are owned by the user, on their quota.
//
// FALLBACK — service account RS256 JWT (GOOGLE_SA_EMAIL + GOOGLE_SA_KEY):
//   only viable into a Workspace Shared Drive — on a personal My Drive,
//   service accounts have ZERO storage quota, so folder creation works but
//   every file upload fails ("Service Accounts do not have storage quota").
//
//   DRIVE_PARENT_FOLDER_ID  parent for all villa folders. In OAuth mode this
//   MUST be the folder the token script created (drive.file scope only
//   reaches files/folders this app itself created).
//
// Villa folders get "anyone with link can view" — what the portal's
// API-key gallery reads require.

import crypto from 'crypto';

const b64url = (s) => Buffer.from(s).toString('base64url');

const oauthConfigured = () =>
  !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN);

export const driveConfigured = () =>
  !!process.env.DRIVE_PARENT_FOLDER_ID
  && (oauthConfigured() || !!(process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_KEY));

// Access token, cached for the lambda's lifetime (tokens live 1h).
let cached = null;
async function getAccessToken() {
  if (cached && cached.exp > Date.now()) return cached.token;
  let body;
  if (oauthConfigured()) {
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    }).toString();
  } else {
    const email = process.env.GOOGLE_SA_EMAIL;
    // Tolerate a paste that included the JSON's surrounding quotes or stray
    // whitespace — the value is a PEM block that never legitimately has either.
    const key = String(process.env.GOOGLE_SA_KEY || '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
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
    body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${signature}`;
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`Drive token exchange failed: ${d.error_description || d.error || 'unknown'}`);
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

// Find an existing villa folder by exact name under the shared parent, oldest
// first. Lets a retried or resumed job re-attach to the folder a previous run
// already created instead of leaving it orphaned and starting over.
export async function findOwnerFolderByName(folderName) {
  const token = await getAccessToken();
  const q = `name = '${String(folderName).replace(/'/g, "\\'")}'`
    + ` and '${process.env.DRIVE_PARENT_FOLDER_ID}' in parents`
    + ` and mimeType = 'application/vnd.google-apps.folder' and trashed=false`;
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
    + '&fields=files(id,createdTime)&orderBy=createdTime&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true',
    { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  if (!r.ok) throw new Error(`Drive folder lookup failed: ${d?.error?.message || r.status}`);
  return d.files?.[0]?.id || null;
}

export const folderLink = (folderId) => `https://drive.google.com/drive/folders/${folderId}`;

// List the image files already in a villa folder as { name → id }. Used to
// make uploads idempotent — see the naming note in uploadWaImageToDrive.
export async function listFolderImages(folderId) {
  const token = await getAccessToken();
  const q = `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`;
  const out = {};
  let pageToken = '';
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
      + `&fields=nextPageToken,files(id,name)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`
      + (pageToken ? `&pageToken=${pageToken}` : '');
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!r.ok) throw new Error(`Drive list failed: ${d?.error?.message || r.status}`);
    for (const f of d.files || []) out[f.name] = f.id;
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Pull the media bytes from WhatsApp (media id → temp URL → bytes) and upload
// into the villa folder. Returns { fileId, count, skipped } where count is the
// folder's photo total after upload (Maya tells the owner "that's N photos so
// far").
//
// Files are named after the WhatsApp media id, not the wall clock. The id is
// stable and unique per photo, so a retry — or the repair_owner_photos sweep —
// can tell what is already in the folder and skip it. The old wa-<timestamp>
// naming collided whenever two photos landed in the same second and told us
// nothing about which message a file came from.
export async function uploadWaImageToDrive({ mediaId, waToken, folderId, existing = null }) {
  // 1. WhatsApp media metadata (URL is short-lived, fetch right before use)
  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${waToken}` },
  });
  const meta = await metaRes.json();
  if (!metaRes.ok || !meta.url) throw new Error(`WA media meta failed: ${meta?.error?.message || metaRes.status}`);
  const mime0 = meta.mime_type || 'image/jpeg';
  const name = `wa-${mediaId}.${mime0.includes('png') ? 'png' : 'jpg'}`;
  if (existing && existing[name]) {
    return { fileId: existing[name], count: Object.keys(existing).length, skipped: true };
  }
  const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${waToken}` } });
  if (!binRes.ok) throw new Error(`WA media download failed: HTTP ${binRes.status}`);
  const bytes = Buffer.from(await binRes.arrayBuffer());
  const mime = mime0;

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
