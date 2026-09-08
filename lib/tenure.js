// Tenure, from the deeds, with the years left computed on the day.
//
// Until 9 Sep 2026 the portfolio text said "28-year leasehold" for
// Tropicana Valley and "30-year" for the Clay House — the original terms,
// which drift by a year every year and which Maya repeated as if the
// clock had not moved. Ikiel's rule: when an agent asks how long the
// lease is, Maya states the years REMAINING today and the end date. The
// end dates below come from the notarial deeds read on 9 Sep 2026 (see
// memory: leasehold-deeds); the extension wording is what Ikiel approved.
//
//   tenureBlock(now)   the prompt lines (byte-stable for weeks: years to
//                      one decimal, no date of today in the text)
//   yearsLeft(end, now)

export const TENURE = {
  tropicana_valley: {
    name: 'Tropicana Valley', end: '2053-04-21',
    note: 'head lease 30 years from 21 April 2023; every unit lease ends on the same date',
    extension: 'a priority right to extend, duration and price to be agreed at the market price at that time; no extension is agreed or priced',
  },
  lanehaus: {
    name: 'LaneHAUS Pererenan', end: '2052-11-22',
    note: 'head lease 30 years from 22 November 2022',
    extension: 'a 10-year extension agreed with the landowner at IDR 1.25 billion for all three units together',
  },
  clay_house: {
    name: 'The Clay House', end: null, term_years: 30,
    note: 'each buyer leases 30 years directly from the landowner, from that unit\'s own start date (the first signed unit runs 1 January 2025 to 1 January 2055)',
    extension: 'a priority option to extend, applied for within 12 months of expiry, term and price at the market rate then; no fixed extension',
  },
  palem_kembar: { name: 'Palem Kembar', end: null, hgb: '2054-05-16', note: 'HGB title (renewable, held through a PT), not a lease' },
};

export function yearsLeft(end, now = new Date()) {
  if (!end) return null;
  const y = (Date.parse(end + 'T00:00:00Z') - now.getTime()) / (365.25 * 86400e3);
  return Math.max(0, Math.round(y * 10) / 10);
}

const fmt = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function tenureBlock(now = new Date()) {
  const lines = [];
  for (const t of Object.values(TENURE)) {
    if (t.end) lines.push(`- ${t.name}: leasehold ends ${fmt(t.end)} — about ${yearsLeft(t.end, now)} years remaining today (${t.note}). Extension: ${t.extension}.`);
    else if (t.term_years) lines.push(`- ${t.name}: ${t.term_years}-year leasehold per unit (${t.note}). Extension: ${t.extension}.`);
    else if (t.hgb) lines.push(`- ${t.name}: ${t.note}; the HGB runs to ${fmt(t.hgb)} and is renewed with the land office, not with a landowner.`);
  }
  return `TENURE (from the signed deeds; this overrides any lease length written in the portfolio above):
${lines.join('\n')}
When an agent asks how long the lease is, give the years remaining today and the end date, never the original term. Say an extension is "agreed" only where this list says so; otherwise call it a priority right at market terms. Never quote a total like "70 years".`;
}
