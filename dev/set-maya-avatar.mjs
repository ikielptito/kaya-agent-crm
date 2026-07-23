#!/usr/bin/env node
// Set Maya's WhatsApp profile picture (the avatar agents see when Maya replies).
//
// META_WA_TOKEN is Vercel-sensitive (unreadable via env pull), so this posts the
// image to the deployed api/whatsapp-templates endpoint, which holds the token at
// runtime and does the resumable upload → profile_picture_handle on the number's
// whatsapp_business_profile. Image is sent inline as base64 (nothing is hosted).
//
// Run:
//   SYNC_SECRET=<TEMPLATE_ADMIN_SECRET> node dev/set-maya-avatar.mjs "/path/to/avatar.jpg"

import { readFile } from 'node:fs/promises';

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const SECRET = process.env.SYNC_SECRET;
const imgPath = process.argv[2];

if (!SECRET) { console.error('Set SYNC_SECRET (the CRM template-admin secret).'); process.exit(1); }
if (!imgPath) { console.error('Usage: SYNC_SECRET=xxx node dev/set-maya-avatar.mjs "/path/to/avatar.jpg"'); process.exit(1); }

const mimeFor = (p) => {
  const e = p.toLowerCase().split('.').pop();
  return e === 'png' ? 'image/png' : 'image/jpeg';
};

const buffer = await readFile(imgPath);
const mime = mimeFor(imgPath);
console.log(`Sending ${imgPath} (${(buffer.length / 1024).toFixed(1)} KB, ${mime}) → ${ENDPOINT}`);

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
  body: JSON.stringify({ action: 'set-profile-picture', imageBase64: buffer.toString('base64'), mime }),
});
const data = await res.json();
if (!res.ok || data.error) { console.error('Failed:', JSON.stringify(data)); process.exit(1); }
console.log('✓ Maya’s profile picture updated:', JSON.stringify(data));
