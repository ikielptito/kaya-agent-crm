// ── GOOGLE SHEETS / DRIVE READ ACCESS (Era's monthly report sheets) ──
// Read-only helpers over Era's per-property report spreadsheets. Same OAuth
// refresh-token flow as lib/drive-upload.js, but this needs the token to be
// minted with EXTRA scopes (the photo pipeline's drive.file scope cannot see
// files the app didn't create — Era owns these sheets and shared them with
// Ikiel's account):
//
//   https://www.googleapis.com/auth/spreadsheets.readonly   tab list + values
//   https://www.googleapis.com/auth/drive.metadata.readonly modifiedTime probe
//
// Re-mint with availability_checker's dev/get-drive-token.mjs (SCOPE edited to
// include all three), consenting as the account Era shared the folder with,
// then update GOOGLE_OAUTH_REFRESH_TOKEN on this Vercel project.

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

export const sheetsConfigured = () =>
  !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN);

// Access token, cached for the lambda's lifetime (tokens live 1h).
let cached = null;
async function getAccessToken() {
  if (cached && cached.exp > Date.now()) return cached.token;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  }).toString();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`Sheets token exchange failed: ${d.error_description || d.error || 'unknown'}`);
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 - 60000 };
  return cached.token;
}

async function gget(url) {
  const token = await getAccessToken();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Google API ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// Tab titles in sheet order: [{sheetId, title}]
export async function listTabs(fileId) {
  const d = await gget(`${SHEETS}/${fileId}?fields=sheets.properties(sheetId,title)`);
  return (d.sheets || []).map(s => s.properties).filter(Boolean);
}

// One tab's grid as an array of row arrays. UNFORMATTED_VALUE gives real
// numbers for numeric cells (Era's amounts are numeric with comma display
// formatting); text cells come through as strings. Merged cells surface
// their value only in the top-left cell — the parser accounts for that.
export async function getTabValues(fileId, tabTitle) {
  const range = encodeURIComponent(`'${String(tabTitle).replace(/'/g, "''")}'!A1:R500`);
  const d = await gget(`${SHEETS}/${fileId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
  return d.values || [];
}

// Cheap change probe: has Era touched this file since we last parsed it?
export async function getFileMeta(fileId) {
  return gget(`${DRIVE}/${fileId}?fields=id,name,modifiedTime`);
}
