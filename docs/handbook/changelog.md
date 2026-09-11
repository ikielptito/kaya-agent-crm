# What's new on Samba, by audience

The running record of features people were told about, newest first. Maya reads this to answer "what changed" and "since when"; the whats_new console action sends each entry to its audience and stamps it here by hand.

## 7 September 2026

**Housekeepers.** Maya now understands a message about the week — "B3 dan B5 hari Senin dan Kamis", "jadwal saya Senin & Jumat", "hari ini saya cleaning B3 dan B5", "besok B4" — and sets the villa's cleaning days from it, confirms today's visits, and says back what she recorded (in Indonesian). A greeting gets a greeting. Tapping a button on the morning message now answers exactly that villa's visit. A correction ("bukan A4, tetapi B4") undoes the previous change and applies it to the villa meant. A photo of a fault from a housekeeper who names only her unit ("b3") is filed against that unit. Told each of them directly by Maya.

**Era.** Every reply Maya sends to staff is now visible in the Staff tab (they were not before). Changing a villa's cleaning days on the Schedule page skips the regular cleans already planned on the old days and rebuilds the new ones; a rebuild never touches a visit someone moved by hand. Maya tells Era in one line whenever a housekeeper sets her days.

## 6 September 2026

**Owners (managed villas).** A Housekeeping tab in the owner portal: every cleaning visit, pre-guest photo check and inspection round, with photos and a PDF per record, and what is planned next at the top. Maya answers questions about bookings (who is staying, arrivals and departures, free dates) and sends a fresh portal sign-in link on request. The owner guide was updated (five tabs, records page). Told by WhatsApp template `samba_owner_update_hk_v1`.

**Era.** Ticket photos are never guessed any more: a photo sent with the words (caption) or quoted by them is attached at once; anything matched by sight goes back to the housekeeper who took it, with buttons to pick the report it belongs to (Era can also ✓/✕ on the Maintenance page); owners only ever see confirmed photos. A morning brief at 08:05 WITA: four lines (guests, cleaning by housekeeper, what is waiting on her, yesterday's loose ends) with an "Open today" button to a signed, phone-first page of the whole day and the week ahead (sambarentals.com/today/…); one line per schedule change during the day; the 09:00 backlog nudge folded into the brief. Expenses by chat: "laundry HAUS 5 250rb" with a photo of the receipt files the expense on the month's draft statement (or holds it until the draft is built from the sheet, then merges it without duplicates) and stores the receipt beside the statement; Undo for 30 minutes. The sheet stays the record: Era still writes the expense there at month end, and the duplicate is recognised. Maya is an assistant in her WhatsApp thread: answers about the schedule, bookings, tickets, statements, payroll, staff, viewings and the Payouts app; small changes applied at once with an Undo button (visit done, moved, reassigned, added; ticket estimate, note, move, waiting); anything that reaches another person staged behind Yes/No (publish or heads-up to an owner, dispatch a tukang, complete a ticket, message a housekeeper, a statement line); money and payroll stay on the Payouts page. Lists to tap when a target is ambiguous. "Maya, diam" pauses her for 12 hours. Told by two WhatsApp messages from Maya.

**Ikiel.** The same assistant on his WhatsApp number at admin scope, plus agent and owner lookups, campaign status, delivery health and the system map. The console assistant reads the handbook and the system map.

**Housekeepers.** A 17:00 reminder for a visit not yet marked done, and Era hears at 19:00 what is still open. Explained in the SOP; no separate message.

**Agents.** Maya answers how Samba works for agents (free, full 10% commission, portal features, viewings process) from the handbook. No announcement needed.

## 5 September 2026

**Owners.** The Samba Owner Guide (cleaning standard, repairs, statements, records) sent to every managed owner by template `samba_owner_guide_v1`; a welcome template for owners yet to claim their portal account. Heads-up repair notices: the owner hears about a problem before the cost is known.

**Housekeepers.** Onboarding in Indonesian with the housekeeper guide PDF; the seven-photo readiness check before every guest; the v2 inspection round with a functional walk-through.

**Era.** Maintenance backlog nudges through the day, answered in the chat ("#4 done, #15 estimate 85,000"); the Records library and shareable record PDFs; the villa standard sheet; the calendar feed.

## 11 Sep 2026 — every agent counted, every introduced agent followed up
- The morning briefing's audience line adds up to the enrolled total: one tier vocabulary (hot and cold fold into active and dormant), untagged agents counted, introduced-but-silent contacts shown as their own stage. Maya quotes the whole line or none of it.
- Agents Maya never tiered get a tier overnight from reply recency; her own tier choices are never overwritten. On 11 Sep that was 37 untagged rows and 36 alias rows.
- The introduction now has a ladder: cold carousel, then a question with three buttons ("are you a rental agent in Bali, can I send you what's open?"), then the Monday digest once, each a fortnight apart, then parked as stalled. Before this, 51 agents introduced on 19 Aug had heard nothing since. Yes sends three listing cards and the agent's personal link on the spot; Not an agent ends contact for good; Not now parks them. A written reply at any rung opts the agent in; the caps `intro_question_daily_cap` and `intro_follow_weekly_cap` set to 0 switch a rung off.

## 8 Sep 2026 — one door for staff messages
- Housekeeper replies are routed by the message they answer (tap or quoted reply → the recorded ask), then by deterministic word rules, then by one classifier that sees her open visits, round, check and asks. Acknowledgements ("siap", "ok") never change a record; "sudah selesai" closes exactly one thing or asks which.
- Photos have a fourth home: proof of the day's visit, on the visit itself. Readiness checks keep only photos, "selesai" and restock lines; inspection rounds keep photos and findings, never acknowledgements or day-off notes.
- A dead phone (nothing delivered for two days) is not chased: the visit is marked uncovered and Era hears once, then every third day. A reader who ignores asks gets daily tasks and the chase, not the week message or photo rounds.
- Tickets: moving a ticket resets the owner latches (the new owner is asked; the old owner's link says it was re-filed; an approval by the old owner is not carried over). Owners can approve or decline by typing when one ticket is waiting on them. Completion is refused while the owner has not answered. Reopen restores the prior state. The backlog nudge skips snoozed and dispatched tickets and does not repeat an unchanged list. The maintenance queues run hourly.
- Every inbound staff or team message is claimed by its WhatsApp id before handling, so Meta's redeliveries cannot create a second ticket or close a second task. New tables (staff_asks, staff_photos, maintenance_events, housekeeping_events, staff_channel) — migration 2026-09-08 — record asks, photos, history and reachability; the code runs without them.
