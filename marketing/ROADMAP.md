# TownPlay Instagram roadmap (@_town_play)

Goal: grow an India-wide audience of players and venue owners before launch, and collect venue-owner
leads ("DM LIST") for onboarding. One Reel every day at **11:00 IST**, made and posted automatically.

## Audiences and mix (per week)

| Audience | Share | What they get | Call to action |
| --- | --- | --- | --- |
| Players (football, box cricket, badminton, pickleball) | ~55% | Relatable Hinglish humour about squads, money, plans | Tag / send to your group |
| Venue owners (turfs, courts, box cricket, academies) | ~30% | Their daily pain (calls, no-shows, empty slots, hisaab) and the TownPlay fix | DM "LIST" to get listed early |
| Events (cafés, concerts, comedy, festivals) | ~15% | Group plans and ticket drama; owners: selling tickets | Tag your party group / DM "LIST" |

Owner Reels map to real product features only: live slot calendar, online advance, walk-ins and blocked
slots, open games, coaching batches and memberships, event tickets with QR check-in, earnings and payouts.

## Formats (rotate; never two of the same in a row)

| Format | Why | Length |
| --- | --- | --- |
| Group chat | Best hold so far (Reel 5: 36% past 3 s, 8 shares) | ~20 s, one message every 1.5–2.8 s |
| "Types of…" list | Comment bait ("which number are you?") | ~20 s, one card every 3–4 s |
| Before vs after | Shows the product without a sales pitch | ~21 s |
| Owner pitch | Problem → TownPlay fix → "DM LIST" | ~25 s |

Readability rules (from feedback): big text, each line on screen long enough to read twice, first line
visible on frame 1, short end card with one action.

## How it runs

1. `marketing/content/plan.json` holds every Reel: spec (script), caption, hashtags, first comment, status.
2. Every day at ~10:12 IST a scheduled task renders the next planned entry with
   `python3 marketing/reel-kit/make_reel.py <id>`, commits the MP4 + cover to `marketing/instagram/`,
   schedules it in Metricool for 11:00 IST and marks it `scheduled` in the plan.
3. Before rendering it checks Metricool numbers for recent Reels; the weekly review adjusts the next week.

## Weekly review (every Monday run)

- Rank last week's Reels by "watched past 3 s", average watch time and shares.
- Keep the top format/topic, drop the weakest, write the next 7 entries into `plan.json`.
- Owner metric: count of "LIST" DMs (checked by hand in the Instagram inbox).

## Weeks 1–4 (23 Oct – 19 Nov 2026)

| ID | Date | Audience | Format | Topic |
| --- | --- | --- | --- | --- |
| d01 | Fri 2026-10-23 | Players | Group chat | Open games: last-minute drop-outs |
| d02 | Sat 2026-10-24 | Players | “Types of…” list | Badminton doubles types |
| d03 | Sun 2026-10-25 | Venue owners | Owner pitch | Owners: booking calls all day |
| d04 | Mon 2026-10-26 | Players | Before vs after | Booking a turf: calls vs app |
| d05 | Tue 2026-10-27 | Events | Group chat | Comedy show tickets: the friend who pays |
| d06 | Wed 2026-10-28 | Venue owners | “Types of…” list | Owners: types of customers |
| d07 | Thu 2026-10-29 | Players | Group chat | Coaching: 6 AM batch motivation |
| d08 | Fri 2026-10-30 | Venue owners | Before vs after | Owners: before vs after |
| d09 | Sat 2026-10-31 | Players | Group chat | Box cricket: team selection |
| d10 | Sun 2026-11-01 | Players | “Types of…” list | Sunday football lines |
| d11 | Mon 2026-11-02 | Venue owners | Owner pitch | Owners: empty weekday slots |
| d12 | Tue 2026-11-03 | Players | Group chat | Pickleball: one game becomes a habit |
| d13 | Wed 2026-11-04 | Players | Before vs after | Split bill: old way vs split before |
| d14 | Thu 2026-11-05 | Events | “Types of…” list | Diwali party group chat types |
| d15 | Fri 2026-11-06 | Events | Group chat | Diwali night event tickets |
| d16 | Sat 2026-11-07 | Venue owners | Owner pitch | Cafés/venues: selling event tickets |
| d17 | Sun 2026-11-08 | Players | “Types of…” list | Diwali day: types in every group |
| d18 | Mon 2026-11-09 | Venue owners | Before vs after | Owners: Saturday no-shows |
| d19 | Tue 2026-11-10 | Players | Group chat | Rain on game day |
| d20 | Wed 2026-11-11 | Players | “Types of…” list | Sports WhatsApp group types |
| d21 | Thu 2026-11-12 | Venue owners | Owner pitch | Owners: payments and payouts |
| d22 | Fri 2026-11-13 | Players | Group chat | Group can't decide the sport |
| d23 | Sat 2026-11-14 | Players | Before vs after | Solo player: open games |
| d24 | Sun 2026-11-15 | Venue owners | “Types of…” list | Owners: things every turf owner says |
| d25 | Mon 2026-11-16 | Players | Group chat | Membership: 20 days, josh 3 days |
| d26 | Tue 2026-11-17 | Venue owners | Before vs after | Academies: batches and memberships |
| d27 | Wed 2026-11-18 | Players | “Types of…” list | Box cricket batsman types |
| d28 | Thu 2026-11-19 | Venue owners | Owner pitch | Owners: early access call |

## Things only the account owner can do

- Link @_town_play to a Facebook Page so trending Instagram audio can be attached automatically.
- Reply to comments and "LIST" DMs within a few hours.
- Share each Reel to your story in the first hour.
