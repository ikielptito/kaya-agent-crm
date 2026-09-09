# The Tropicana Valley Books — how the page and the model work

For Ikiel and Oli, the partners in PT Double Eight Realty. Maya answers questions about this page from this guide and from the live figures she loads when asked.

## What it is

- One page for the whole Tropicana Valley development: fourteen units, ten sold, four (B2, B3, B5, B6) kept and rented out. It replaced the spreadsheet "Tropicana Construction & Payment Schedule".
- Address: https://tropicana-books.vercel.app. Sign in as yourself (Ikiel or Oli), either with your password or by tapping "Send me a WhatsApp link" and opening the link Maya sends. The page remembers you for 30 days. Both partners can add, change and delete anything.
- It is separate from the Samba cockpit and portal. Behind the scenes it pulls two things from Samba: the rent of the four units from the booking calendar (Hostex) and their expenses from Era's monthly statements. Everything else is typed into the page or was imported once.

## The number at the top

**Loan left to pay, after everything else** = loan outstanding − (cash in the company account − costs still to pay + what buyers still owe).

- Loan outstanding = what was received from the lender − what was repaid (+ simple interest if a rate is set on the loan).
- Cash = the last bank balance typed under Accounts, rolled forward by every ledger entry on that account dated after that balance. Only accounts marked "counts as company cash" (OCBC, the PT Double 8 account) are included; Oli's Permata and the other accounts are listed but not counted.
- Costs still to pay = every open item under Costs to pay, less what has already been paid against it.
- Buyers still owe = every open buyer's contract (USD converted at the buyer's own rate) less what the ledger shows received from them, or the balance set by hand.
- Under it: how many months of rent close that gap, at the average net rent of the last three closed months (calendar rent less Era's expenses), and the month that lands on. If the position exceeds the loan it says "Covered".

## The tabs

- **Overview**: the headline and its parts; the rent of the unsold units month by month (calendar rent, Era's expenses, net, what was banked); the project so far (built for, sold for, sales less cost, rent on a cash basis); the cost breakdown by category; settings.
- **Ledger**: every rupiah in or out since the land lease in April 2023. Each row has a date, direction (in/out), amount in IDR, category, description, account, "Who" (a key), unit, "Pays down" (a cost it pays), a note and flags. Filters by year, direction, category, source and "needs review". Tap a row to edit; "+ Add entry" for a new one.
- **Costs to pay**: what the project still has to pay (the SLF permit balance, the perimeter wall and parking, anything added). Paid = the ledger entries that point at the cost. Mark it paid or dropped to take it out of the headline.
- **Buyers**: each buyer with units, contract, received (ledger entries whose "Who" is the buyer's key), still due, status open or settled. A balance can be set by hand when the FX drift makes the computed one misleading.
- **Loans**: each loan with agreed amount, received, repaid, interest, outstanding, and the ledger rows behind it. The "headline" loan is the one the overview leads with. Money movements are ledger entries: "Loan received" and "Loan repayment" with the loan's key as "Who".
- **Accounts**: where the money sits. Type the balance the bank statement shows and its date; the ledger rolls it forward.

## Keys ("Who")

A short lowercase word on a ledger entry that ties it to a buyer, a loan or a person: will, micha, andrea, cielo, margaux, vanmillingen, emily, kate, singapore (the A6 resale buyers), mil (the loan from Oli's mother-in-law), bridge (Oli's bridge loan), ikiel, oli, era, wildan (the contractor), dewi (furniture), plus tenant keys such as nagar-bani, manon, nafisa. A buyer's key makes the entry count as received from them; a loan's key makes it count as drawn or repaid.

## Categories

Money out: land lease, architecture & engineering, construction, construction add-ons, doors & windows, kitchen & wardrobe, air conditioning, furniture, appliances, fit-out & deco, finishing works, SLF permit, landscaping, permits/utilities/fees, operating & unit prep, rental unit expenses, agent commission, tenant deposit returned, to a partner, loan repayment, bank charges & tax, other. Money in: unit sale, rental income, tenant deposit, loan received, partner capital, bank interest, other. The cost breakdown on the overview adds up the build categories; rental categories and partner/loan movements stay out of it.

## Where the rows came from

- The spreadsheet's accounting sheet, as of January 2026 (200 rows, source "import").
- The OCBC company account statements January to July 2026 (130 rows, source "import"). 70 of them are flagged "review": the bank printed who was paid but nothing says what for. They count in cash either way; they sit under "Operating & unit prep" or "To a partner" until someone opens the row and picks the right category.
- Calendar rows (source "rental"): written by the page itself for each closed month, one rent row per unit from the booking calendar and one expense row from Era's statement. They are reported apart from bank rows and never touch a bank balance. Change the calendar or the statement rather than the row.
- Rows typed on the page (source "manual").

## Calendar rent vs rent banked

The booking calendar spreads a stay over the nights it covers; the bank sees the money the day it lands. A tenant who pays in a different month than they stay shows as a gap between the two columns, not an error. A one-year lease (B3, Nagar Bani, July 2026 to July 2027, IDR 250,000,000 gross) is twelve months of calendar rent and one bank month.

## What is still to confirm (as of 9 September 2026)

- The loan from Oli's mother-in-law is a placeholder built from the two "Investment Oliver" land entries (IDR 2,620,800,000, interest-free, nothing repaid). The real amount, currency, interest and every repayment already made need to go in under Loans and as ledger entries with key "mil".
- IDR 500,000,000 to Oli on 16 April 2026 sits under "To a partner": if it went to the lender, recategorise it as "Loan repayment" with key "mil" and the headline drops by that much.
- The 70 review rows (see above), including three unit rentals that do not match the calendar: Rafaela's 33,000,000 for B3 (calendar says 0), "Villa lease Trop" 30,000,000 on 27 March (no stay pairs with it), Manon 50,000,000 banked against 60,000,000 on the calendar.
- Emily Hou's two transfers of 7,730,000 (her contract is settled, so what are they); Wira Kusuma Karya PT, Kanaka Engineering, Endang Puriyanti (an agent?), the 150,000,000 bridge loan of October 2024 (repaid?).
- Buyers still open: Will (A1), Margaux (A7, USD 8,000 in escrow until the SLF), Ryan Van Millingen (B7), the Singapore buyers (A6 resale, installments to March 2026 are Double 8's; later ones go to Mr Hoffmann).
- Costs still open: SLF permit balance IDR 424,200,000 of 574,000,000; perimeter wall and parking IDR 200,000,000.
- Bank statements after July 2026 have not been entered. Each month: type the new OCBC closing balance and date under Accounts, add the month's transfers to the ledger (or send Ikiel the statement PDF and it gets parsed).

## Feedback

"Send feedback to Maya" in the top bar: a few words and up to four screenshots. It reaches Ikiel with the pictures, and Ikiel has it implemented. Screenshots sent to Maya on WhatsApp work the same way.
