# How Maya is built and wired

Plain facts about the CRM (kaya-agent-crm) for anyone supporting it. Written for Maya's handbook; keep it current when branches, actions, crons or caps change.

## What Maya is

- Maya is software run by Samba Realty's team: a WhatsApp assistant on one business number, built as Vercel functions with a Supabase database, replying with Anthropic models. She says she is software when asked.
- She works for three groups on WhatsApp: rental agents (finding and sharing villas, viewings), villa owners (listings, statements, repairs, housekeeping), and the team on the ground (Era, the housekeepers, pool and garden staff, the tukang). Ikiel also has a console assistant in the chat console.
- Pushing to `main` deploys. Nothing is deployed from any other branch.

## How a message is routed

The webhook receives every inbound message and the first branch that claims it wins, in this order:

1. A message already seen (same WhatsApp id) is dropped.
2. The team numbers (Ikiel, Era): queued team alerts are delivered; an answer to a relayed agent question is captured; an open team question collects its answers; a statement change request ("forgot to deduct the curtains from A5 August") is staged and confirmed; a reply to the maintenance backlog nudge ("#4 done, #15 estimate 85,000") updates those tickets; a message that says work is finished ("A4 sofa zipper has been repaired") is read back as a proposal on the ticket it is about ("#28 → done. Apply?") and applied only on Yes (Other ticket re-targets it, Cancel drops it), never filed as a new one; a photo with a line files a maintenance ticket — but only after the ticket guard has checked the open tickets at that villa: the same fault reported again becomes a question (Update #n / New ticket / Ignore), not a second ticket; a question about the housekeeping system is answered from the SOP. Anything else is logged for a person.
3. Staff on the roster: a tukang answering a job; the onboarding buttons; the pre-guest photo check; an inspection round; "sudah selesai / besok saja / tidak bisa" on a cleaning visit; a fault report; a question about the system.
4. Owners (a number on an owners row, or on a managed villa's statement group): owner mode.
5. Everyone else: agent mode.

## Owner mode

- Answers from data, never memory: `statements` loads published statements (payouts, fee, expenses, bookings, revisions); `housekeeping` loads the cleaning log and what is planned next; `maintenance` loads their tickets with status, cost, photos and link; `report` loads the weekly listing report; `handbook` loads one handbook section; `import` reads an Airbnb or Booking page; `intake` submits a listing for Ikiel's review.
- Money beyond the fundamentals, disputes, complaints, contract terms and legal questions are escalated to Ikiel with a helpful reply. An escalation always leaves a marker in the console and pings Ikiel.
- A managed owner's photo is looked at, not filed as a listing photo.

## Agent mode

- Two lanes: Samba Realty monthly rentals, and KAYA Developments sales. One lane per reply.
- Engagement tiers, one vocabulary: champion, active, new, warm, dormant (hot and cold are read as active and dormant). Maya sets a tier from a conversation; an agent she never tiered gets one overnight from reply recency (a reply in the last 30 days is active, within 90 warm, otherwise dormant) and her own choice is never overwritten. Every audience count adds up: opted-in agents by tier plus untagged, then the introduced who have not replied, then the introduced who went quiet (stalled).
- The introduction ladder: one cold carousel (intro); 13 days later one question with three buttons, "are you a rental agent in Bali, can I send you what's open?" (template samba_intro_question_v1, capped per day, not Mondays); 13 days after that the Monday digest once, capped per Monday; then parked as stalled and left alone by every sweep. Taps are deterministic: Yes opts the agent in, tags them new, and sends three listing cards with their personal link; Not an agent declines the number for good and switches alerts off; Not now parks them as stalled. A written reply at any rung opts the agent in. While the question template waits at Meta the digest follows the intro directly.
- Knows the live rentals with prices, the availability digest, villas in play this turn, the learned playbook and confirmed facts, the agent's memory and viewings. Checks a specific date range with `need_availability`. Can send a brochure, up to four listing cards, a contact card, quick-reply buttons, a relayed question to the villa's contact, or a viewing request. Hard limits: never quote a price that is not in the data, never promise a hold, never go around the agent, never confirm a viewing before the villa does, never state anything about a property's physical condition.

## Staff

- Housekeepers get their day at 09:00 WITA with three buttons, the week ahead on Mondays, the seven-photo check after a pre-guest clean, the fortnightly inspection round, a 17:00 chase for a visit not marked done, and answers to questions from the SOP. Era hears exceptions only.
- Tukang get a job sheet link and answer accept, arrived, done; Era is told at every transition.

## Project finance

- The Tropicana Valley development as a whole lives in five tables (`project_ledger`, `project_commitments`, `project_receivables`, `project_loans`, `project_accounts`; migration 2026-09-09) behind the `finance_*` actions on `/api/statements`. The Tropicana Valley Books app (its own Vercel project for Ikiel and Oli, holding FINANCE_SECRET, which opens these actions and nothing else) reads and edits them; the portal adds the rent and expenses of the four unsold B units from the Hostex calendar and Era's statements and writes each closed month into the ledger as calendar rows (source `rental`). The headline is the loan that bought the land: loan outstanding, less the company account, plus the costs still to pay, less what the buyers still owe, and how many months of rent close the gap. Settings key `project_finance` (fx_usd, rental_group_key, rental_from, projection_months, units_unsold).

## Crons (all times UTC; Bali is UTC+8)

- 01:00, 01:20, 01:40: the three morning waves (broadcasts, follow-ups, owner sweeps, maintenance and housekeeping notifications, delivery health).
- Every hour at :05: the relay sweep, the hourly housekeeping task derivation, Era's backlog nudge at 9, 12, 15 and 18 WITA, the evening chase at 17 and 19 WITA.
- 00:30: statements (sheet sync). Sunday: the weekly Maya review.

## Settings that steer her

- `automation` mode: off, paused, draft, hybrid, autopilot; a per-agent override exists.
- Spend caps per day: the reply cap, an Opus cap, the console assistant cap, the team assistant cap. When a cap is hit she stops sending and Ikiel is told.
- Campaign command center: every recurring send is a campaign with a daily cap and a pause switch. The introduction ladder is two campaigns, `intro_question` and `intro_follow`; their knobs live in `samba_availability`: `intro_question_daily_cap` (15; 0 switches it off), `intro_question_gap_days` (13), `intro_follow_weekly_cap` (25; 0 switches it off), `intro_follow_max` (1 digest), `intro_follow_gap_days` (13).
- Housekeeping thresholds: deep clean every 90 days and after 21 nights, inspection every 14 days, minimum photos per check, chase hours.

## Trust boundaries

- The console key authenticates the chat console and the on-demand API. A staff-scoped key gives Era the Staff tab only.
- The shared sync secret authenticates calls between the portal and the CRM and signs every no-login link. It is never rotated casually.
- Meta templates must be approved before a sweep can use them; an unapproved template skips its queue.

## Dry runs

- `preview_reply` (agent), `preview_owner_reply` (owner), `preview_team_reply` (team) run the real pipeline and send nothing. `hk_chase_preview`, `hk_sweep_preview`, `maint_sweep_preview`, `maint_nudge_era {preview}` show what a cron would send. `tier_backfill {dry_run}` shows or applies the overnight tier fill; `intro_follow_preview` lists who gets the question next, who the next Monday digest carries, and who is parked tonight.
