// One vocabulary for housekeeping, used by the cockpit, the owner portal,
// the PDFs, Maya's answers and the housekeepers' messages.
//
// Until 8 Sep 2026 the same things had different names in different
// places — handover, readiness, check, round, task, visit, clean — and an
// owner reading "Handover · turnover" had to guess. The nouns:
//
//   VISIT     one housekeeper at one villa on one day. The unit of record.
//   JOB       a piece of work inside a visit: routine clean, turnover
//             clean, arrival prep, deep clean, inspection. A visit usually
//             has one job; a turnover day can have a clean and an
//             inspection.
//   EVIDENCE  how we know a job was done: photos (with WhatsApp's own
//             timestamp), a same-day tap, or a report days later.
//   OUTCOME   what became of the visit: done, not done, not confirmed
//             (nobody answered), not covered (nobody to send it to),
//             removed from the schedule.
//   CHECK     the guest-ready photo check after a pre-guest job, and its
//             verdict.
//
// English for Era and owners, Indonesian for the housekeepers. Owners get
// the same facts in slightly plainer words (OWNER_*).

export const JOB = {
  regular:     { en: 'Routine clean',   id: 'bersih-bersih rutin',                 letter: 'R', owner: 'Routine clean' },
  turnover:    { en: 'Turnover clean',  id: 'bersih-bersih setelah tamu check out', letter: 'T', owner: 'Turnover clean' },
  pre_arrival: { en: 'Arrival prep',    id: 'persiapan sebelum tamu datang',        letter: 'A', owner: 'Preparation before arrival' },
  deep_clean:  { en: 'Deep clean',      id: 'pembersihan menyeluruh',               letter: 'D', owner: 'Deep clean' },
  inspection:  { en: 'Inspection',      id: 'pemeriksaan rutin dengan foto',        letter: 'I', owner: 'Inspection' },
};
export const jobEn = (k) => JOB[k]?.en || String(k || '').replace('_', ' ');
export const jobId = (k) => JOB[k]?.id || 'bersih-bersih';
export const jobOwner = (k) => JOB[k]?.owner || jobEn(k);
export const jobLetter = (k) => JOB[k]?.letter || 'V';

export const RECORD = { visit: 'Visit', handover: 'Guest-ready check', inspection: 'Inspection' };

export const OUTCOME = {
  done: 'Done', not_done: 'Not done', unconfirmed: 'Not confirmed', not_sent: 'Not covered', uncovered: 'Not covered',
  skipped: 'Removed from schedule', open: 'Today', upcoming: 'Upcoming',
};
export const OWNER_OUTCOME = {
  done: 'Cleaned', not_done: 'Not cleaned', unconfirmed: 'Not confirmed by the housekeeper', not_sent: 'Not covered', uncovered: 'Not covered',
  skipped: 'Removed from schedule', open: 'In progress today', upcoming: 'Upcoming',
};
export const EVIDENCE = { photos: 'With photos', reported: 'Reported on the day', reported_late: 'Reported later' };
export const OWNER_EVIDENCE = { photos: 'with photos', reported: 'reported by the housekeeper', reported_late: 'reported by the housekeeper afterwards' };

export const CHECK = {
  pass: 'Guest-ready, nothing to fix', flagged: 'Issues flagged', unchecked: 'No photos received', unverified: 'Photos received, not checked', awaiting: 'Photos pending',
};
export const OWNER_CHECK = {
  pass: 'Guest-ready, nothing to fix', flagged: 'Issues flagged and fixed before arrival', unchecked: 'No photos received', unverified: 'Photos received, being checked', awaiting: 'Photos pending',
};
export const ROUND = { clear: 'Nothing found', raised: 'Repairs raised' };

// A status from any of the three families, in one call.
export const statusEn = (s) => OUTCOME[s] || CHECK[s] || ROUND[s] || s;
export const statusOwner = (s) => OWNER_OUTCOME[s] || OWNER_CHECK[s] || ROUND[s] || s;

// What a routine visit must send to count as evidenced. Kept small on
// purpose: two photos take a minute and settle every "was it cleaned"
// question afterwards.
export const PROOF_SPOTS_ID = 'dapur dan kamar mandi';
export const PROOF_MIN_PHOTOS = 2;
