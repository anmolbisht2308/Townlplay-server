# Implementation Plan — Local Booking Platform (Bareilly first)

Book sports arenas, clubs, seasonal events and cafe events in tier-2/3 Indian cities.
Businesses list; people discover and book; owners stop managing bookings over phone calls and bank transfers.

**How to use this file with Claude Code:** keep it at `docs/PLAN.md`. Work **one phase at a time** ("Implement Phase 2 from docs/PLAN.md"). Each phase ends with acceptance criteria — don't start the next phase until they pass. Update the checkboxes as you go.

---

## 0. Scope decisions (read first)

- **No WhatsApp Business API in this release.** Notifications go through email, in-app notifications, web push (PWA), and **click-to-chat links** (`https://wa.me/<phone>?text=<prefilled>`), which are free and user-initiated. WhatsApp API comes in Phase 8.
- **Login:** Google sign-in + email OTP. Phone number is collected at booking (unverified) so the venue can call. Phone OTP arrives with WhatsApp later.
- **Core vertical:** sports venues (turf, box cricket, badminton, pickleball, etc.) with slot booking.
- **Second vertical:** events with ticketing (seasonal events + cafe/restaurant events). Free events use RSVP (price 0) — this also covers run clubs and one-off club sessions.
- **Deferred:** memberships/coaching batches (Phase 6), tournaments, chat rooms, WhatsApp bot, Instagram/GBP services (Phase 8+).
- **No open chat rooms.** Group formation happens through **open games** and **split payments** (Phase 5).
- **Time zone:** the whole product runs in IST. Store booking dates as `YYYY-MM-DD` strings and times as `HH:mm` strings in IST for slots; store real timestamps (`createdAt`, `paidAt`) as UTC `Date`.
- **Money:** store all amounts as **integers in paise**. Never use floats for money.

---

## 1. Tech stack

| Area          | Choice                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo      | pnpm workspaces + Turborepo                                                                                                                        |
| Frontend      | Next.js (App Router) + TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, next-intl (English + Hindi), PWA (installable, web push)               |
| Backend       | Node.js + TypeScript, Express (or Fastify), Zod validation, Mongoose                                                                               |
| Database      | MongoDB (Atlas). Must run as a **replica set** (Atlas does; locally use Docker with `--replSet` or `mongodb-memory-server` replset)                |
| Auth          | better-auth on the API (Google + email OTP), session cookie shared with web app. Verify current better-auth docs for the Mongo adapter and plugins |
| Payments      | Razorpay (Orders, Checkout, Webhooks, Refunds; Route for payouts to venues)                                                                        |
| Email         | Resend (or AWS SES) + React Email templates                                                                                                        |
| Images        | Cloudinary (or S3 + CloudFront) with signed uploads                                                                                                |
| Real-time     | Socket.io — owner dashboard live updates                                                                                                           |
| Jobs          | Agenda (Mongo-backed) for scheduled jobs                                                                                                           |
| Testing       | Vitest, Supertest, mongodb-memory-server, Playwright (e2e)                                                                                         |
| Observability | Sentry, pino logs, PostHog analytics                                                                                                               |

### Repo layout

```
/apps
  /web        Next.js app (public site, player account, owner dashboard, admin)
  /api        Node API (REST + Socket.io + jobs)
/packages
  /shared     Zod schemas, TS types, constants (sports list, cities), money/time utils
  /config     eslint, tsconfig, prettier presets
/docs
  PLAN.md
```

Shared Zod schemas in `packages/shared` are the single source of truth for request/response shapes used by both apps.

---

## 2. Core data model (MongoDB collections)

Only the key fields are listed; add `createdAt/updatedAt` (timestamps) everywhere.

**users**
`name, email (unique), phone?, image?, roles: ('player'|'owner'|'admin')[], lang: 'en'|'hi', cityId?`

**cities**
`name, slug (unique), state, isActive` — seed Bareilly first.

**businesses** (the owner's organisation; one owner can have several venues/events)
`name, ownerUserIds[], type: 'sports'|'club'|'cafe'|'event_organizer', contactPhone, email, kyc { legalName, pan?, gstin? }, payout { razorpayLinkedAccountId?, status }, status: 'draft'|'pending_review'|'active'|'suspended'`

**venues**
`businessId, cityId, name, slug (unique per city), category: 'sports'|'club'|'cafe', sports[], amenities[], description, address, area, geo { type:'Point', coordinates:[lng,lat] }, photos[], openingHours: { [weekday]: { open:'06:00', close:'23:00', closed:boolean } }, bookingPolicy { advancePercent, cancellationCutoffHours, refundPercentBeforeCutoff }, status: 'draft'|'pending_review'|'live'|'hidden'`
Indexes: `2dsphere` on `geo`, text index on `name, area, sports`, `{cityId, status, category}`.

**resources** (a bookable unit: Court 1, Turf A, Badminton Court 2)
`venueId, name, sport, slotDurationMins (30|60|90), maxPlayers, pricingRules: [{ days:[0-6], start:'HH:mm', end:'HH:mm', pricePaise }], isActive`

**slotLocks** (the anti-double-booking mechanism — see §3)
`resourceId, date:'YYYY-MM-DD', startTime:'HH:mm', bookingId, expiresAt?: Date`
Indexes: **unique** `{resourceId, date, startTime}`; **TTL** on `expiresAt` (`expireAfterSeconds: 0`).

**bookings**
`code (short human code, unique), venueId, resourceId, userId?, customer { name, phone }, date, startTime, endTime, slots: string[] (each startTime), source: 'online'|'walkin'|'phone'|'block', status: 'pending_payment'|'confirmed'|'cancelled'|'completed'|'no_show'|'expired', amount { totalPaise, advancePaise, balancePaise, convenienceFeePaise }, balanceCollected: { method:'cash'|'upi'|'online'|null, at? }, openGameId?, groupBookingId?, holdExpiresAt?, cancellation { by, reason, refundPaise, at }?`
Indexes: `{venueId, date}`, `{userId, createdAt:-1}`, `{status, holdExpiresAt}`.

**payments**
`kind: 'booking_advance'|'booking_share'|'ticket'|'refund', refType: 'booking'|'ticketOrder'|'groupShare', refId, userId?, amountPaise, razorpayOrderId (unique), razorpayPaymentId?, status: 'created'|'paid'|'failed'|'refunded'|'partially_refunded', rawEvents[]`

**events**
`businessId, venueId?, cityId, title, slug, type: 'seasonal'|'cafe'|'club_session', description, photos[], startsAt, endsAt, address, geo, ageLimit?, tiers: [{ _id, name, pricePaise, capacity, remaining }], status: 'draft'|'pending_review'|'published'|'cancelled'|'completed'`

**ticketOrders**
`eventId, userId, items: [{ tierId, qty, pricePaise }], totalPaise, convenienceFeePaise, status: 'pending_payment'|'paid'|'cancelled'|'expired'|'refunded', holdExpiresAt`

**tickets**
`ticketOrderId, eventId, tierId, userId, holderName, qrToken (unique, random), checkedInAt?, checkedInBy?`

**openGames** (Phase 5)
`bookingId, hostUserId, sport, skillLevel: 'beginner'|'intermediate'|'advanced'|'any', totalSpots, filledSpots, pricePerHeadPaise, players: [{ userId, paymentId, joinedAt }], status: 'open'|'full'|'cancelled'|'completed'`

**groupBookings** (Phase 5)
`bookingId, organiserUserId, shares: [{ userId?, name, phone?, amountPaise, status:'pending'|'paid', paymentId? }], deadline, status`

**notifications**
`userId, type, title, body, link, readAt?`

**auditLogs**
`actorUserId, action, entityType, entityId, meta`

---

## 3. Critical design: slot booking without double-booking

1. **Availability** for a resource on a date = slots generated from `openingHours` + `slotDurationMins`, minus slots that have a `slotLocks` document, minus past slots (IST now + small buffer).
2. **Hold:** when a player picks slots, the API inserts one `slotLocks` doc per slot with `expiresAt = now + 10 min`, and creates a `bookings` doc with `status: 'pending_payment'`.
   - The **unique index** guarantees only one of two simultaneous requests succeeds (duplicate key error → return `409 SLOT_TAKEN`).
   - For multi-slot bookings, do it inside a **transaction**. As a safety net, if any insert fails, delete the locks already inserted for this booking.
3. **Confirm** (after payment success): set booking `confirmed`, and `$unset: { expiresAt }` on its locks so TTL never removes them.
4. **Expire:** the TTL index deletes stale locks automatically (runs about every 60s). A job also marks old `pending_payment` bookings as `expired`. Availability queries must also ignore locks whose `expiresAt < now`, since TTL deletion can lag.
5. **Late payment edge case:** if payment succeeds after the hold expired and the slot has been taken, mark the payment for **automatic full refund** and notify the user. If the slot is still free, re-create the locks and confirm.
6. **Cancel:** delete the booking's locks and apply the refund policy.
7. **Owner blocks / walk-ins / phone bookings:** create `bookings` with `source: 'walkin'|'phone'|'block'` and permanent locks (no `expiresAt`). Same unique index, so owners can never double-book either.

A concurrency test (many parallel hold requests for the same slot → exactly one succeeds) is **required** in Phase 2.

---

## 4. Payment flow (Razorpay)

1. `POST /bookings/hold` → booking `pending_payment` + locks.
2. `POST /payments/orders` → create Razorpay order for `advancePaise + convenienceFeePaise`; store `payments` doc.
3. Client opens Razorpay Checkout (UPI first).
4. `POST /payments/verify` → verify signature (fast path for UX).
5. `POST /webhooks/razorpay` → verify webhook signature, handle `payment.captured`, `payment.failed`, `refund.processed`. **Webhook is the source of truth**; handlers must be **idempotent** (keyed on `razorpayPaymentId`/event id).
6. Balance is collected at the venue; owner marks it collected (cash/UPI) in the dashboard.
7. **Payouts:** Razorpay Route — each active business gets a linked account; on capture, transfer the venue's share (advance) and keep the convenience fee. Route needs activation on the Razorpay account; build against test mode and keep a feature flag `PAYOUTS_MODE = 'route' | 'manual'`.

Convenience fee: global config (e.g. flat ₹X or Y%), charged to the player, shown clearly before payment.

---

## Phase 0 — Foundations

**Goal:** a running monorepo with auth, DB, shared types, CI and deploy-ready config.

- [x] pnpm + Turborepo monorepo with `apps/web`, `apps/api`, `packages/shared`, `packages/config`
- [x] TypeScript strict everywhere; ESLint + Prettier; Husky + lint-staged
- [x] API: Express app, pino logging, request ids, centralised error handler returning `{ error: { code, message, details? } }`, Zod request validation middleware, rate limiting, helmet, CORS for the web origin
- [x] Mongo connection (Mongoose) with replica-set local dev (docker-compose)
- [x] Env validation with Zod on boot for both apps (`.env.example` committed)
- [x] better-auth: Google sign-in + email OTP (Resend); session cookie readable by the API; `requireAuth` and `requireRole('owner'|'admin')` middleware
- [x] Web: Next.js App Router, Tailwind, shadcn/ui, TanStack Query, next-intl (`en`, `hi`) with a language switcher, base layout, mobile-first
- [x] `packages/shared`: money utils (paise ↔ ₹ formatting), IST date/time utils, sports and amenities constants
- [x] Seed script: city Bareilly, one admin user
- [x] GitHub Actions: lint, typecheck, test on PR
- [x] Sentry wired in both apps

**Acceptance:** sign in with Google and email OTP works; `/me` returns the user; Hindi/English toggle works; CI green.

---

## Phase 1 — Businesses, venues and public listing

**Goal:** owners can list venues; players can browse Bareilly venues.

Owner side:

- [ ] "List your business" onboarding: create business → add venue (details, address, map pin via lat/lng input, photos, sports, amenities, opening hours, booking policy) → submit for review
- [ ] Resources (courts) CRUD with slot duration and pricing rules (weekday/weekend, peak/off-peak bands)
- [ ] Signed image uploads (Cloudinary/S3), client-side compression before upload

Admin:

- [ ] Admin pages: review queue for businesses/venues (approve, reject with reason, suspend)

Public:

- [ ] City home `/[city]` (e.g. `/bareilly`): category tabs (Sports, Clubs, Events, Cafe events), sport filter, area filter, search
- [ ] "Near me" using browser geolocation + `$geoNear`
- [ ] Venue page `/[city]/venues/[slug]`: photos, sports, amenities, prices, hours, policies, **"Open in Google Maps"** link (no embedded map), call button
- [ ] SEO: server-rendered pages, metadata, OpenGraph images, `sitemap.xml`, JSON-LD (`SportsActivityLocation`/`LocalBusiness`)

API (examples): `POST /businesses`, `POST /venues`, `PATCH /venues/:id`, `POST /venues/:id/submit`, `CRUD /venues/:id/resources`, `GET /cities/:slug/venues?category=&sport=&area=&q=&near=`, `GET /venues/by-slug/:city/:slug`, `POST /admin/venues/:id/approve`.

**Acceptance:** an owner lists a turf with two courts and pricing; admin approves; it appears on `/bareilly`, searchable and filterable, and the page scores well on mobile Lighthouse.

---

## Phase 2 — Slot engine, booking and owner calendar

**Goal:** real bookings with zero double-booking, and a calendar owners actually trust.

- [ ] Availability API: `GET /resources/:id/availability?date=` (and a venue-level variant for all resources) with price per slot from pricing rules
- [ ] Player booking UI: date strip (next 14 days), resource tabs, slot grid (available / taken / past), multi-select consecutive slots, price summary, customer name + phone
- [ ] Hold → pending booking per §3 (payment is mocked in this phase: a dev-only "confirm" endpoint)
- [ ] Owner calendar: day view by resource (columns) × time (rows), colour by status/source; click a free slot to add walk-in/phone booking or block; click a booking for details
- [ ] Mark balance collected (cash/UPI), mark no-show, mark completed
- [ ] Live updates on the owner calendar via Socket.io (room per venue) when bookings are created/cancelled
- [ ] Player "My bookings" (upcoming/past), booking detail with code and venue contact
- [ ] Cancellation by player (policy-aware; refund calculated, executed in Phase 3) and by owner
- [ ] Jobs (Agenda): expire stale holds, auto-complete bookings after end time
- [ ] **Tests:** unit tests for slot generation and pricing (incl. slots crossing band boundaries, closed days); **concurrency test** for holds; API integration tests for hold/confirm/cancel

**Acceptance:** 50 parallel hold requests for the same slot → exactly 1 success; owner walk-in on a slot makes it unavailable online instantly; calendar updates live in a second browser tab.

---

## Phase 3 — Payments (Razorpay)

**Goal:** online advance payment, refunds, and money reaching venue owners.

- [ ] Razorpay integration per §4 (orders, checkout, verify, webhooks, idempotency)
- [ ] Replace the mocked confirm with real payment confirmation
- [ ] Late-payment edge case and auto-refund (§3.5)
- [ ] Refunds on cancellation per venue policy; owner-initiated cancellations always refund in full
- [ ] Convenience fee configuration (admin settings) and a transparent price breakdown in checkout
- [ ] Business payout setup: collect KYC/bank details → create Razorpay Route linked account (feature-flagged); `manual` mode shows an admin payouts report instead
- [ ] Owner earnings page: bookings, advance collected online, balance collected at venue, fees, payouts
- [ ] Transactional emails (React Email + Resend): booking confirmed, cancelled, refund processed; owner: new booking, cancellation
- [ ] **Click-to-chat buttons:** on the booking confirmation page ("Send details to venue on WhatsApp") and in the owner dashboard ("Send confirmation to customer") using `wa.me` links with prefilled text — no API
- [ ] Web push for owners (new booking / cancellation) via the PWA service worker
- [ ] **Tests:** webhook signature verification, idempotent replays, refund calculation, late-payment path

**Acceptance:** in Razorpay test mode, a player pays the advance via UPI and the booking confirms from the webhook even if the browser is closed; duplicate webhooks don't double-process; cancellation before cutoff triggers the right refund.

---

## Phase 4 — Events and ticketing

**Goal:** seasonal and cafe events with tiers, QR tickets and door check-in. (Aim to ship this before a festival.)

- [ ] Event creation for businesses (title, type, dates, venue or custom address, photos, description, age limit, tiers with capacity), admin review
- [ ] Public: `/[city]/events` listing (this week, this weekend, by type), event page with tiers and remaining count
- [ ] Checkout: reserve tickets by atomically decrementing `tiers.$.remaining` with a filter `remaining >= qty`; hold for 10 min; release on expiry (job); pay via Razorpay; issue `tickets` with random `qrToken`
- [ ] Free events: RSVP flow (price 0) with capacity
- [ ] Ticket page for the player with QR codes; add-to-calendar (.ics)
- [ ] Organiser check-in page (mobile): scan QR with camera, validate token, mark `checkedInAt`, show "already checked in" on reuse; manual search by name/phone as fallback
- [ ] Organiser dashboard: sales by tier, attendee list export (CSV), check-in count
- [ ] Event cancellation → refund all paid orders
- [ ] Emails: ticket confirmation (with ticket link), event reminder (day before)
- [ ] **Tests:** oversell protection under concurrency, QR reuse, hold expiry releases capacity

**Acceptance:** 100 parallel purchases for a tier with 20 tickets never sell more than 20; QR check-in works on a phone in poor network (validate quickly, show clear result).

---

## Phase 5 — Open games and group/split bookings

**Goal:** replace "chat rooms" with transactions that form groups.

Open games:

- [ ] When booking, host can mark it as an open game: sport, skill level, spots needed, price per head
- [ ] Public list `/[city]/games` (today/tomorrow, by sport) and game page showing host, venue, time, spots left
- [ ] Join = pay your share (Razorpay); atomic spot reservation like tickets; host sees players
- [ ] Rules: auto-close when full; if not full by cutoff, host chooses to keep or cancel (refund joiners)
- [ ] Share link + click-to-chat "share on WhatsApp" button

Group/split booking:

- [ ] Organiser books and chooses "split payment": adds N shares (names/phones), gets a share link
- [ ] Each friend opens the link and pays their share; organiser sees who has paid
- [ ] Deadline: if unpaid shares remain, organiser pays the rest or booking is released (policy decided in code, clearly shown in UI)

**Acceptance:** a host creates a 10-player game needing 4 more; 4 people join and pay; the game shows "full"; money and refunds reconcile correctly in owner earnings.

---

## Phase 6 — Memberships, coaching batches and clubs

**Goal:** recurring revenue for venues and clubs (pottery, painting, run clubs, coaching academies).

- [ ] Membership plans per venue/business: name, duration (monthly/quarterly), price, benefits (e.g. X bookings/month, discount %, reserved recurring slot)
- [ ] Coaching batches: sport/activity, coach name, schedule (days + time), capacity, monthly fee
- [ ] Purchase and renewal via Razorpay (one-time payments with renewal reminders first; Razorpay Subscriptions later if needed)
- [ ] Recurring reserved slots for batches create permanent locks on the calendar
- [ ] Member list, attendance marking, expiry reminders (email + in-app)
- [ ] Club pages with upcoming sessions (club sessions reuse the events model with `type: 'club_session'`)

**Acceptance:** a coaching batch at 6 pm Mon/Wed/Fri automatically blocks those slots; members renew and appear in the member list.

---

## Phase 7 — Admin, quality and launch readiness

- [ ] Admin: dashboards (GMV, bookings, active venues, events, refunds), manage users/businesses/venues/events, manual refunds, featured venues/events on city home
- [ ] Reviews & ratings (only for completed bookings / checked-in tickets)
- [ ] Owner analytics: occupancy by hour/day, top slots, repeat customers
- [ ] Performance: image optimisation, caching of public pages (ISR), API response caching for listing endpoints
- [ ] Accessibility and low-end Android testing; offline-friendly PWA shell
- [ ] Legal pages: terms, privacy, cancellation & refund policy, owner agreement
- [ ] Backups and restore drill; rate limits and abuse protection on OTP and holds
- [ ] Playwright e2e for: browse → book → pay → cancel/refund; buy ticket → check-in; join open game
- [ ] Production deploy: web + api + Atlas; env/secrets; Razorpay live keys; webhook URL; Sentry releases

**Acceptance:** all e2e tests green against staging; a full dry run with a real venue in Bareilly using live payments.

---

## Phase 8 — Later (not now)

- WhatsApp Business Cloud API: booking confirmations, reminders, owner alerts, ticket delivery, phone OTP (replace click-to-chat links; keep email as fallback)
- WhatsApp chatbot for checking slots and booking
- Tournaments (brackets, team registration, fees)
- Instagram promotion and Google Business Profile services for businesses
- Multi-city expansion (Moradabad, Rampur, Pilibhit…), city-level admins
- Native app wrappers if needed

---

## API conventions

- REST, JSON, base path `/v1`. Resource-oriented routes; actions as sub-resources (`POST /bookings/:id/cancel`).
- Every request body/query validated by a Zod schema from `packages/shared`.
- Errors: `{ error: { code: 'SLOT_TAKEN', message, details? } }` with proper HTTP status.
- Pagination: cursor-based (`?cursor=&limit=`).
- All money in paise; all slot dates/times in IST strings.
- Authorisation checks in services, not just routes (an owner can only touch their own business's data).
- Audit log every owner/admin mutation on bookings, payments and listings.

## Environment variables (initial)

```
# api
MONGODB_URI=
AUTH_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
RESEND_API_KEY=
EMAIL_FROM=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
PAYOUTS_MODE=manual
CONVENIENCE_FEE_CONFIG=
CLOUDINARY_URL=
WEB_ORIGIN=
SENTRY_DSN=
# web
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_RAZORPAY_KEY_ID=
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
NEXT_PUBLIC_POSTHOG_KEY=
```
