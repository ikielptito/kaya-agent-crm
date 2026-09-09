// The Tropicana Valley books, as Maya sees them.
//
// The books live in the project_* tables here and are shown by their own
// app (tropicana-books.vercel.app, Ikiel and Oli). Maya reads them the way
// the app does — through the portal's finance feed, which adds the rent of
// the four unsold B units from the calendar and Era's statements and works
// out the loan headline — so she and the page always say the same number.
//
// Three jobs: who counts as a partner (the numbers that may ask), the live
// figures as a text block for the owner-mode prompt, and the onboarding
// brief Maya sends a partner the first time they reply to her ping.
import { getSettingValue, saveSettingValue } from './campaigns.js';

const BOOKS_URL = 'https://tropicana-books.vercel.app';
const GROUP_KEY = 'tropicana-b2356';
const digits = (n) => String(n || '').replace(/\D/g, '');
const fmt = (n) => 'IDR ' + Math.round(Number(n) || 0).toLocaleString('en-US');

// Partners: Oli's numbers on the Tropicana B group, Ikiel's own number, and
// anything added under settings.books_partners.numbers. Ikiel's number maps
// to 'ikiel'; every other partner number is Oli's.
export async function booksPartners(db) {
  const extra = (await getSettingValue(db, 'books_partners').catch(() => null)) || {};
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/statement_groups?key=eq.${GROUP_KEY}&select=owner_wa_nums&limit=1`, { headers: db.sbHeaders });
  const group = r.ok ? (await r.json())?.[0] : null;
  const oli = new Set([...(group?.owner_wa_nums || []), ...((extra.oli || []))].map(digits).filter(Boolean));
  const ikiel = new Set([digits(process.env.OWNER_WA_NUM), ...((extra.ikiel || []))].map(digits).filter(Boolean));
  return { oli, ikiel };
}
export async function partnerOf(db, num) {
  const n = digits(num);
  if (!n) return null;
  const p = await booksPartners(db);
  return p.ikiel.has(n) ? 'ikiel' : p.oli.has(n) ? 'oli' : null;
}

// The live pack from the portal (books + rent + headline).
export async function loadBooks({ as = 'Maya' } = {}) {
  const secret = process.env.FINANCE_SECRET;
  if (!secret) throw new Error('FINANCE_SECRET not configured');
  const base = process.env.PORTAL_BASE_URL || 'https://sambarentals.com';
  const r = await fetch(`${base}/api/statements?action=finance&as=${encodeURIComponent(as)}`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(25000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `portal HTTP ${r.status}`);
  if (d.migration) throw new Error(d.migration);
  return d;
}

const mlabel = (p) => { const [y, m] = String(p).split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const dlabel = (d) => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';

// The figures as text, for the prompt. `query` narrows the ledger rows shown
// (a word from the description/who/note/category, a year, or a unit).
export function booksContext(pack, { query = '', maxRows = 60 } = {}) {
  const p = pack.position, r = pack.rental, s = pack.data?.settings || {};
  const L = [];
  L.push(`TROPICANA VALLEY BOOKS · live at ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · page ${BOOKS_URL}`);
  L.push(`Loan headline: ${p.loan ? `${p.loan.lender} (key ${p.loan.key})` : 'no loan on file'} outstanding ${fmt(p.loan?.outstanding)} = received ${fmt(p.loan?.drawn)} − repaid ${fmt(p.loan?.repaid)}${p.loan?.interest ? ` + interest ${fmt(p.loan.interest)}` : ''}${/PLACEHOLDER/i.test(p.loan?.note || '') ? ' (PLACEHOLDER terms: ' + p.loan.note + ')' : ''}`);
  L.push(`Cash in the company account: ${fmt(p.cash)} (${p.accounts.filter(a => a.counts_as_cash).map(a => `${a.name}: ${a.has_snapshot ? `bank balance ${fmt(a.balance)} on ${dlabel(a.balance_as_of)} plus ${a.rows_after} ledger rows since` : 'ledger only, no bank balance on file'}`).join('; ')})`);
  L.push(`Costs still to pay: ${fmt(p.remaining_costs)} (${p.commitments.map(c => `${c.name}: total ${fmt(c.total)}, paid ${fmt(c.paid)}, remaining ${fmt(c.remaining)}, ${c.status}${c.due_on ? ', due ' + dlabel(c.due_on) : ''}`).join('; ') || 'none'})`);
  L.push(`Buyers still owe: ${fmt(p.receivables_due)} (${p.receivables.map(x => `${x.buyer} [key ${x.ledger_match}, ${(x.units || []).join('/')}]: contract ${x.currency === 'IDR' ? fmt(x.contract_amount) : `${x.currency} ${Number(x.contract_amount).toLocaleString('en-US')} = ${fmt(x.contract_idr)} at ${x.fx_rate || s.fx_usd}`}, received ${fmt(x.received)}, due ${fmt(x.due)}${x.balance_override != null ? ' (set by hand)' : ''}, ${x.status}${x.note ? ' — ' + x.note : ''}`).join('; ')})`);
  L.push(`Net position = cash − costs + buyers = ${fmt(p.net_position)}. LOAN LEFT TO PAY AFTER EVERYTHING ELSE = ${fmt(p.gap)}${p.covered ? ' (covered: the position exceeds the loan)' : ''}.`);
  L.push(`Rent, net, per month (average of the last ${r?.window || 0} closed months on the calendar, after Era's expenses): ${fmt(p.rental_avg_net)}. Months of rent to close the gap: ${p.months_to_close == null ? 'unknown (no rental average yet)' : p.months_to_close}${p.payoff_eta ? `, landing around ${mlabel(p.payoff_eta)}` : ''}.`);
  L.push(`Other loans: ${p.loans.filter(l => !l.headline).map(l => `${l.lender} [key ${l.key}]: received ${fmt(l.drawn)}, repaid ${fmt(l.repaid)}, outstanding ${fmt(l.outstanding)}${l.note ? ' — ' + l.note : ''}`).join('; ') || 'none'}`);
  L.push(`Accounts not counted as cash: ${p.accounts.filter(a => !a.counts_as_cash).map(a => `${a.name} (${a.kind}${a.has_snapshot ? `, bank balance ${fmt(a.balance)} on ${dlabel(a.balance_as_of)}` : ''}, ledger-only running total ${fmt(a.ledger_only)})`).join('; ') || 'none'}`);
  if (r) {
    L.push(`Rent of the unsold units (${r.group_name || r.group_key}), month by month — calendar rent / Era's expenses / net / rent banked / paid from the bank: ` + (r.months || []).map(m => `${mlabel(m.period)}${m.closed ? '' : ' (open month)'}: ${fmt(m.gross)}${m.nights != null ? ` (${m.nights} nights${m.units ? ', ' + Object.entries(m.units).filter(([, v]) => v).map(([k, v]) => `${k.slice(-2).toUpperCase()} ${fmt(v)}`).join(', ') : ''})` : ''} / ${fmt(m.expenses)} / ${fmt(m.net)} / ${fmt(m.banked_income)} / ${fmt(m.banked_expenses)}${m.status ? ` [statement ${m.status}]` : ''}`).join('; '));
    L.push(`Totals over the closed months since ${mlabel(r.from)}: calendar rent ${fmt(r.total_gross)}, expenses ${fmt(r.total_expenses)}, net ${fmt(r.total_net)}.`);
  }
  const pnl = p.pnl;
  L.push(`The project so far (cash rows only): built for ${fmt(pnl.build_cost)}; sold for ${fmt(pnl.sales)} (${(s.units_total || 14) - (s.units_unsold || []).length} of ${s.units_total || 14} units, cash received); sales less cost ${fmt(pnl.gross_profit)}; rent on a cash basis ${fmt(pnl.rental_income)} in, ${fmt(pnl.rental_expense)} out. Cost by category: ${Object.entries(pnl.by_category).filter(([k]) => k.startsWith('out:')).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.slice(4)} ${fmt(v)}`).join(', ')}. Money in by category: ${Object.entries(pnl.by_category).filter(([k]) => k.startsWith('in:')).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.slice(3)} ${fmt(v)}`).join(', ')}.`);
  const ledger = pack.data?.ledger || [];
  const review = ledger.filter(x => (x.flags || []).includes('review'));
  L.push(`Ledger: ${ledger.length} rows from ${ledger[0]?.entry_date || '?'} to ${ledger[ledger.length - 1]?.entry_date || '?'}; ${review.length} flagged "review" (imported from the bank statements without a description of what they were for).`);
  const q = String(query || '').trim().toLowerCase();
  let rows = ledger;
  if (q) rows = ledger.filter(x => [x.description, x.counterparty, x.note, x.category, x.unit, x.account, x.entry_date].join(' ').toLowerCase().includes(q));
  const shown = (q ? rows : ledger.slice().reverse()).slice(q ? 0 : 0, maxRows);
  L.push(`${q ? `Ledger rows matching "${query}" (${rows.length}${rows.length > maxRows ? `, first ${maxRows}` : ''})` : `The latest ${Math.min(maxRows, ledger.length)} ledger rows (newest first)`}:`);
  for (const x of shown) L.push(`- ${dlabel(x.entry_date)} ${x.direction === 'in' ? 'IN ' : 'OUT'} ${fmt(x.amount)} · ${x.category}${x.unit ? ' · ' + x.unit : ''} · ${x.description || ''}${x.counterparty ? ` · who: ${x.counterparty}` : ''}${x.account ? ` · ${x.account}` : ''}${x.source === 'rental' ? ' · (calendar row)' : ''}${(x.flags || []).includes('review') ? ' · NEEDS REVIEW' : ''}${x.note ? ` · note: ${x.note}` : ''}`);
  L.push(`Settings: IDR per USD fallback ${s.fx_usd}${pack.fx_live ? ` (today's rate ${pack.fx_live})` : ''}; rent counted from ${s.rental_from}; rent average over ${s.projection_months} months; unsold units ${(s.units_unsold || []).join(', ')}.`);
  return L.join('\n');
}

// ── Onboarding ───────────────────────────────────────────────────────
// Maya pings a partner with the team-alert template; the first time they
// reply, she sends the walkthrough (three messages) and remembers it.
export function booksBrief(name) {
  return [
`Hi ${name}, Maya here. The Tropicana Valley books are live: ${BOOKS_URL}

It replaces the spreadsheet. One page for the whole development: every rupiah in or out since the land lease, the costs still to pay, the buyers still paying, the loans, the bank balances, and the rent of B2, B3, B5 and B6, which comes in on its own from the booking calendar and Era's monthly statements.

To sign in, open the page, tap "Send me a WhatsApp link", enter this number, and tap the link I send you. Your password also works if Ikiel gave you one. You and Ikiel can both add, change and delete anything.`,
`The number at the top is the one that matters: the loan left to pay after everything else.

It is the loan outstanding, less what is in the company account, plus the costs still to pay, less what the buyers still owe. Under it: how many months of rent, at the current pace, would close that gap.

Tabs: Overview (that number and its parts, the rent month by month, the project so far), Ledger (every entry, tap one to fix it, "+ Add entry" for a new one), Costs to pay, Buyers, Loans, Accounts. Each month someone types the OCBC closing balance under Accounts and the ledger rolls it forward.`,
`Three things the page cannot know without you:

1. The loan from your mother-in-law is a placeholder built from the two "Investment Oliver" land entries (IDR 2,620,800,000, interest-free, nothing repaid). The real amount, currency, interest and every repayment already made go under Loans and as ledger entries with "mil" as Who.

2. IDR 500,000,000 went to you on 16 April 2026. If that went to the lender, open the row on the Ledger and set it to "Loan repayment" with "mil" as Who; the headline drops by that much.

3. 70 bank transfers from January to July 2026 are marked "review": the bank printed who was paid but not what for. Tick "needs review" on the Ledger to see them, open each, pick the category.

Ask me anything about the page or the numbers, any time, right here: what buyers still owe, what a row is, how the headline is worked out. And if something on the page should change, use "Send feedback to Maya" at the top of the page, or send me a screenshot here; it reaches Ikiel with the picture.`,
  ];
}

export async function booksOnboardIfDue({ db, fromNum, sendText }) {
  const who = await partnerOf(db, fromNum);
  if (!who) return false;
  const st = (await getSettingValue(db, 'books_onboarding').catch(() => null)) || {};
  if (!st.pending || !st.pending[digits(fromNum)]) return false;
  const name = who === 'ikiel' ? 'Ikiel' : 'Oli';
  for (const msg of booksBrief(name)) await sendText(fromNum, msg);
  const pending = { ...st.pending }; delete pending[digits(fromNum)];
  await saveSettingValue(db, 'books_onboarding', { ...st, pending, sent: { ...(st.sent || {}), [digits(fromNum)]: new Date().toISOString() } });
  return true;
}
export async function booksOnboardArm(db, num) {
  const st = (await getSettingValue(db, 'books_onboarding').catch(() => null)) || {};
  await saveSettingValue(db, 'books_onboarding', { ...st, pending: { ...(st.pending || {}), [digits(num)]: new Date().toISOString() } });
}
