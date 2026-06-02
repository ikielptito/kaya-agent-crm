// Per-pipeline campaign engagement helpers.
//
// An agent can be in one active campaign sequence PER PIPELINE (one KAYA
// sales sequence AND one Samba rental sequence simultaneously). We store this
// as a keyed object on agent.campaign_engagement:
//
//   { kaya:  { campaign_id, pipeline:'kaya',  sequence_index, status, ... },
//     samba: { campaign_id, pipeline:'samba', sequence_index, status, ... } }
//
// Backward compatibility: older records stored a single FLAT engagement
// ({ campaign_id, sequence_index, status, ... }) with no pipeline key. We
// normalise those into the kaya bucket (or whatever .pipeline says) so nothing
// crashes during the transition.

const PIPELINES = ['kaya', 'samba'];

// Returns a normalised { kaya?, samba? } object. Never returns null.
export function normalizeEngagement(ce) {
  if (!ce || typeof ce !== 'object') return {};
  // Already keyed by pipeline
  if ('kaya' in ce || 'samba' in ce) {
    const out = {};
    if (ce.kaya) out.kaya = ce.kaya;
    if (ce.samba) out.samba = ce.samba;
    return out;
  }
  // Legacy flat shape — bucket it by its embedded pipeline (default kaya)
  if (ce.campaign_id) {
    const pl = ce.pipeline === 'samba' ? 'samba' : 'kaya';
    return { [pl]: { ...ce, pipeline: pl } };
  }
  return {};
}

// All currently-pending engagements as [{ pipeline, eng }]
export function pendingEngagements(ce) {
  const norm = normalizeEngagement(ce);
  const out = [];
  for (const pl of PIPELINES) {
    if (norm[pl] && norm[pl].status === 'pending') out.push({ pipeline: pl, eng: norm[pl] });
  }
  return out;
}

// Most-recently-active engagement (by last_template_sent_at), pending or not.
// Used to pick which campaign's context Maya should reference after a reply.
export function mostRecentEngagement(ce) {
  const norm = normalizeEngagement(ce);
  let best = null;
  for (const pl of PIPELINES) {
    const e = norm[pl];
    if (!e) continue;
    const t = e.last_template_sent_at ? new Date(e.last_template_sent_at).getTime() : 0;
    if (!best || t > best.t) best = { pipeline: pl, eng: e, t };
  }
  return best ? { pipeline: best.pipeline, eng: best.eng } : null;
}

// Returns a new keyed object with one pipeline bucket replaced (or removed if
// newEng is null). Preserves the other pipeline's engagement untouched.
export function setEngagement(ce, pipeline, newEng) {
  const norm = normalizeEngagement(ce);
  if (newEng) norm[pipeline] = { ...newEng, pipeline };
  else delete norm[pipeline];
  return norm;
}

// Mark all pending engagements as responded (agent replied → conversation is
// live, stop all proactive sequences). Returns { changed, value }.
export function stopAllPending(ce, timestamp) {
  const norm = normalizeEngagement(ce);
  let changed = false;
  for (const pl of PIPELINES) {
    if (norm[pl] && norm[pl].status === 'pending') {
      norm[pl] = { ...norm[pl], status: 'responded', responded_at: timestamp, next_template_at: null };
      changed = true;
    }
  }
  return { changed, value: norm };
}

export { PIPELINES };
