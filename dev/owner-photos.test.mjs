// Per-villa photo folders (BAM, 10 Sep 2026): the owner's root folder is the
// inbox, each villa has its own subfolder, and routing decides by arrival
// time which inbox photos belong to the batch Maya just attributed.
import { uploadTargetFolder, photosToRoute, villaFolderName, ensureVillaFolder, routeInboxPhotos, portalSlug } from '../lib/owner-photos.js';
import { applyPhotoDecisions } from '../api/whatsapp-webhook.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};

// settings stub: one JSON map behind /rest/v1/settings
let settings = {};
let calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  if (u.includes('/rest/v1/settings')) {
    if (opts.method === 'POST') { const b = JSON.parse(opts.body); settings[b.key] = b.value; return { ok: true, json: async () => [] }; }
    const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
    return { ok: true, json: async () => (key in settings ? [{ value: settings[key] }] : []) };
  }
  return { ok: true, json: async () => ({}), text: async () => '{}' };
};
const db = { SUPABASE_URL: 'http://x', sbHeaders: {} };

// ── pure: where an arriving photo goes ─────────────────────────────
const root = 'ROOT';
t('no listings → inbox', uploadTargetFolder({ owner: { drive_folder_id: root, listing_slugs: [] }, folders: {} }).inbox, true);
t('one villa without its own folder (legacy) → inbox', uploadTargetFolder({ owner: { drive_folder_id: root, listing_slugs: ['villa-a'] }, folders: {} }).inbox, true);
t('one villa with its own folder → straight in', uploadTargetFolder({ owner: { drive_folder_id: root, listing_slugs: ['villa_a'] }, folders: { 'villa-a': { id: 'FA', name: 'Villa A' } } }), { folderId: 'FA', villa: { slug: 'villa-a', name: 'Villa A' }, inbox: false });
t('two villas → inbox, Maya routes', uploadTargetFolder({ owner: { drive_folder_id: root, listing_slugs: ['villa-a', 'villa-b'] }, folders: { 'villa-a': { id: 'FA', name: 'Villa A' } } }).inbox, true);

// ── pure: which inbox photos belong to the batch ───────────────────
const imgs = [{ id: 'old', createdTime: '2026-09-09T14:29:00Z' }, { id: 'new1', createdTime: '2026-09-09T14:42:00Z' }, { id: 'new2', createdTime: '2026-09-09T14:42:30Z' }];
t('after a routing clock: only newer photos', photosToRoute(imgs, { since: '2026-09-09T14:30:00Z', listingCount: 1 }).map(i => i.id), ['new1', 'new2']);
t('no clock, first villa: everything in the inbox', photosToRoute(imgs, { since: null, listingCount: 0 }).map(i => i.id), ['old', 'new1', 'new2']);
t('no clock, one legacy villa: everything (it is all theirs)', photosToRoute(imgs, { since: null, listingCount: 1 }).length, 3);
t('no clock, several legacy villas: nothing — cannot split by time', photosToRoute(imgs, { since: null, listingCount: 2 }), []);
t('folder name is the villa name, filesystem-safe', villaFolderName('Villa Hawk / Berawa'), 'Villa Hawk - Berawa');
t('slugs normalise to portal form', portalSlug('villa_hawk'), 'villa-hawk');

// ── folder + routing with a fake Drive ─────────────────────────────
function fakeDrive(inbox) {
  const d = { created: [], moved: [], find: async () => null, create: async (name) => { d.created.push(name); return 'F_' + name.replace(/\s/g, ''); }, list: async () => inbox, move: async (id, to) => { d.moved.push([id, to]); } };
  return d;
}
{
  settings = {}; const drive = fakeDrive(imgs);
  const owner = { id: 7, drive_folder_id: root, listing_slugs: [] };
  const r = await routeInboxPhotos(db, owner, { slug: 'villa-hawk', name: 'Villa Hawk', listingCount: 0 }, drive);
  t('first villa: folder created under the root', drive.created, ['Villa Hawk']);
  t('…all inbox photos move into it', drive.moved.map(m => m[0]), ['old', 'new1', 'new2']);
  t('…the folder is remembered by slug', settings['owner_villa_folders:7'], { 'villa-hawk': { id: 'F_VillaHawk', name: 'Villa Hawk' } });
  t('…and the routing clock is stamped', typeof settings['owner_photos_routed_at:7']?.at, 'string');
  t('…returns folder + moved', [r.folder.id, r.moved.length], ['F_VillaHawk', 3]);
}
{
  // second villa a day later: only the photos that arrived since the last routing move
  const drive = fakeDrive([...imgs, { id: 'loft1', createdTime: '2026-09-10T06:00:00Z' }]);
  settings['owner_photos_routed_at:7'] = { at: '2026-09-09T15:00:00Z' };
  const owner = { id: 7, drive_folder_id: root, listing_slugs: ['villa-hawk'] };
  const r = await routeInboxPhotos(db, owner, { slug: 'berawa-loft', name: 'Berawa Loft', listingCount: 1 }, drive);
  t('second villa: its own folder', drive.created, ['Berawa Loft']);
  t('…only the new batch moves', drive.moved.map(m => m[0]), ['loft1']);
  t('…both folders remembered', Object.keys(settings['owner_villa_folders:7']).sort(), ['berawa-loft', 'villa-hawk']);
  void r;
}
{
  // a known villa folder is reused, not recreated
  const drive = fakeDrive([]);
  const owner = { id: 7, drive_folder_id: root, listing_slugs: ['villa-hawk', 'berawa-loft'] };
  const f = await ensureVillaFolder(db, owner, { slug: 'villa_hawk', name: 'Villa Hawk' }, drive);
  t('known folder reused (db slug form accepted)', [f.id, drive.created.length], ['F_VillaHawk', 0]);
}
{
  // legacy: the remembered folder IS the root → a real subfolder gets made
  settings['owner_villa_folders:9'] = { 'villa-old': { id: root, name: 'Villa Old' } };
  const drive = fakeDrive([]);
  const f = await ensureVillaFolder(db, { id: 9, drive_folder_id: root, listing_slugs: ['villa-old'] }, { slug: 'villa-old', name: 'Villa Old' }, drive);
  t('legacy root pointer replaced by a subfolder', [f.id !== root, drive.created], [true, ['Villa Old']]);
}

// ── Maya's decision → routing + listing update ─────────────────────
{
  settings['owner_villa_folders:7'] = { 'villa-hawk': { id: 'F_VillaHawk', name: 'Villa Hawk' }, 'berawa-loft': { id: 'F_BerawaLoft', name: 'Berawa Loft' } };
  const owner = { id: 7, drive_folder_id: root, listing_slugs: ['villa-hawk', 'berawa-loft'] };
  const seen = {};
  const deps = {
    route: async (_db, _o, { slug, name, listingCount }) => { seen.route = { slug, name, listingCount }; return { folder: { id: 'F_VillaHawk', name }, moved: ['p1', 'p2'] }; },
    submit: async (_o, listing) => { seen.listing = listing; return { ok: true, message: 'saved' }; },
    nameOf: async () => null,
  };
  const r = await applyPhotoDecisions(db, owner, { photos_for: 'villa_hawk', cover_photo_id: '1DZ6Sczj5GGHDbGY-Yl9vAIUj58te7StW' }, owner.listing_slugs, deps);
  t('photos_for routes the batch to that villa', seen.route, { slug: 'villa-hawk', name: 'Villa Hawk', listingCount: 2 });
  t('…and the listing is pointed at the folder with the cover set', seen.listing, { slug: 'villa-hawk', photosLink: 'https://drive.google.com/drive/folders/F_VillaHawk', coverPhotoId: '1DZ6Sczj5GGHDbGY-Yl9vAIUj58te7StW' });
  t('…result', [r.ok, r.moved, r.cover], [true, 2, '1DZ6Sczj5GGHDbGY-Yl9vAIUj58te7StW']);
  const bad = await applyPhotoDecisions(db, owner, { photos_for: 'villa-nope' }, owner.listing_slugs, deps);
  t('a slug that is not theirs is refused', bad.ok, false);
  const one = await applyPhotoDecisions(db, { ...owner, listing_slugs: ['villa-hawk'] }, { cover_photo_id: '1DZ6Sczj5GGHDbGY-Yl9vAIUj58te7StW' }, ['villa-hawk'], deps);
  t('cover alone with one villa → that villa', [one.ok, one.slug], [true, 'villa-hawk']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
