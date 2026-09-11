// "Tugas bersihkan kamar B3 dan B5 sudah selesai": a done that names its
// villas closes those visits, whatever else the sentence contains.
//
// On 10 Sep 2026 Gede tapped "Sudah selesai", was asked which of B3/B5,
// and answered with both names in one sentence. The which-ask only took
// a single hit, the done rule only takes a bare "sudah selesai", and the
// completion guard then read "sudah selesai" against the open tickets
// and filed his answer on "Clean and restore stained countertop in B5".
// Both cleans stayed unconfirmed and he was told off for it (11 Sep).
//
//   namedDone(text, cleans, slugs, names) → the open visits named, or []
//
// Conservative: a done word, at least one villa she covers that has an
// open visit, and no repair vocabulary (a fixed zipper at B3 is about the
// zipper, not the clean).

import { resolveUnits } from './housekeeping-schedule.js';

const DONE = /\b(sudah|selesai|udah|beres|kelar|done|finished|siap semua)\b/i;
const NOT_DONE = /\b(belum|tidak|gak|nggak|ga|not yet|belom)\b/i;
const REPAIR = /\b(diperbaiki|perbaik|dibetulkan|betulkan|tukang|diganti|ganti|rusak|bocor|pecah|macet|mati|fixed|repair(ed)?|replaced|leak)/i;

export function namedDone(text, cleans = [], slugs = [], names = {}) {
  const t = String(text || '').trim();
  if (!t || !DONE.test(t) || NOT_DONE.test(t) || REPAIR.test(t) || /\?\s*$/.test(t)) return [];
  const hits = new Set(resolveUnits(t, slugs, names));
  if (!hits.size) return [];
  return (cleans || []).filter(c => hits.has(c.slug) && ['notified', 'confirmed'].includes(c.status));
}
