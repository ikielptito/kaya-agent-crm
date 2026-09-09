// Per-villa photo folders for owners.
//
// An owner's Drive folder used to be the ONE place every photo they ever sent
// landed, and every listing of theirs pointed at it. Fine for one villa; with
// two, BAM's Berawa Loft listing showed Villa Hawk's photos and "use this as
// the cover" needed a human (10 Sep 2026). Now:
//
//   owner folder            = the INBOX: photos land here as they arrive
//   owner folder/<Villa>    = that villa's own gallery, the listing's `folder`
//
// Routing moves inbox photos into a villa's folder at two moments: when a NEW
// listing is submitted (the photos sent for it), and when Maya sets
// `photos_for` on a reply because the thread says which villa a batch is for.
// Which inbox photos belong to the batch is decided by ARRIVAL TIME: anything
// newer than the last routing for this owner. An owner with a single villa
// whose folder is a proper subfolder skips the inbox altogether — photos
// upload straight into it.
//
// State lives in `settings`, no migration:
//   owner_villa_folders:<ownerId>   { [portalSlug]: { id, name } }
//   owner_photos_routed_at:<ownerId> ISO of the last routing
import { createOwnerFolder, findOwnerFolderByName, listInboxImages, moveDriveFile } from './drive-upload.js';

const FOLDERS_KEY = (ownerId) => `owner_villa_folders:${ownerId}`;
const ROUTED_KEY = (ownerId) => `owner_photos_routed_at:${ownerId}`;

async function getSetting(db, key) {
  try {
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/settings?key=eq.${encodeURIComponent(key)}&select=value`, { headers: db.sbHeaders });
    return (await r.json().catch(() => []))?.[0]?.value ?? null;
  } catch { return null; }
}
async function setSetting(db, key, value) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/settings`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value }),
  });
}

export const portalSlug = (s) => String(s || '').trim().toLowerCase().replace(/_/g, '-');
const realFolder = (v) => v && !String(v).startsWith('pending:');

export async function villaFolders(db, ownerId) {
  const v = await getSetting(db, FOLDERS_KEY(ownerId));
  return v && typeof v === 'object' ? v : {};
}
export async function rememberVillaFolder(db, ownerId, slug, folder) {
  const cur = await villaFolders(db, ownerId);
  cur[portalSlug(slug)] = { id: folder.id, name: folder.name };
  await setSetting(db, FOLDERS_KEY(ownerId), cur);
  return cur;
}
export async function photosRoutedAt(db, ownerId) {
  const v = await getSetting(db, ROUTED_KEY(ownerId));
  return v && v.at ? v.at : null;
}

// Where a freshly arrived photo is uploaded. Pure.
//   one villa with its own folder → straight into it (no routing needed)
//   otherwise                     → the inbox (owner root)
export function uploadTargetFolder({ owner, folders }) {
  const slugs = (Array.isArray(owner.listing_slugs) ? owner.listing_slugs : []).map(portalSlug);
  const root = realFolder(owner.drive_folder_id) ? owner.drive_folder_id : null;
  if (slugs.length === 1 && folders[slugs[0]]?.id && folders[slugs[0]].id !== root) {
    return { folderId: folders[slugs[0]].id, villa: { slug: slugs[0], name: folders[slugs[0]].name }, inbox: false };
  }
  return { folderId: root, villa: null, inbox: true };
}

// Which inbox photos move into a villa's folder. Pure.
//   since set          → those that arrived after the last routing
//   no routing yet     → all of them when the owner has at most one listing
//                        (the inbox can only hold that villa's photos);
//                        none when they already have several — a legacy
//                        inbox with two villas' photos mixed cannot be split
//                        by time, that one stays for a human.
export function photosToRoute(images, { since, listingCount }) {
  const list = Array.isArray(images) ? images : [];
  if (since) return list.filter(i => String(i.createdTime || '') > since);
  return listingCount <= 1 ? list : [];
}

export const villaFolderName = (name) => String(name || '').replace(/[/\\]/g, '-').trim().slice(0, 80) || 'Villa';

const defaultDrive = {
  find: (name, parentId) => findOwnerFolderByName(name, parentId),
  create: (name, parentId) => createOwnerFolder(name, parentId),
  list: (folderId) => listInboxImages(folderId),
  move: (fileId, toFolderId) => moveDriveFile(fileId, toFolderId),
};

// The villa's own folder under the owner's root — remembered, found by name,
// or created (public-viewable like the root, so the portal gallery can read it).
export async function ensureVillaFolder(db, owner, { slug, name }, drive = defaultDrive) {
  const root = realFolder(owner.drive_folder_id) ? owner.drive_folder_id : null;
  if (!root) return null;
  const key = portalSlug(slug);
  const known = key ? (await villaFolders(db, owner.id))[key] : null;
  if (known?.id && known.id !== root) return known;
  const folderName = villaFolderName(name || key);
  let id = await drive.find(folderName, root);
  if (!id) id = await drive.create(folderName, root);
  const folder = { id, name: folderName };
  if (key) await rememberVillaFolder(db, owner.id, key, folder);
  return folder;
}

// Move the current batch of inbox photos into a villa's folder and stamp the
// routing clock. Returns the folder and the moved file ids. `listingCount` is
// how many listings the owner has (before a new one is counted).
export async function routeInboxPhotos(db, owner, { slug, name, listingCount, now = new Date() }, drive = defaultDrive) {
  const root = realFolder(owner.drive_folder_id) ? owner.drive_folder_id : null;
  if (!root) return { folder: null, moved: [] };
  const folder = await ensureVillaFolder(db, owner, { slug, name }, drive);
  if (!folder) return { folder: null, moved: [] };
  const since = await photosRoutedAt(db, owner.id);
  const inbox = await drive.list(root);
  const batch = photosToRoute(inbox, { since, listingCount });
  const moved = [];
  for (const f of batch) {
    try { await drive.move(f.id, folder.id); moved.push(f.id); } catch (e) { console.warn('photo move failed:', f.id, e.message); }
  }
  await setSetting(db, ROUTED_KEY(owner.id), { at: now.toISOString(), slug: portalSlug(slug), moved: moved.length });
  return { folder, moved };
}
