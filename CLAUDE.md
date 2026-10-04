# CLAUDE.md

Local booking platform for tier-2/3 Indian cities (starting with Bareilly): sports venue slot booking, event ticketing, open games, memberships.

The full roadmap is in `docs/PLAN.md`. Work on **one phase at a time** and only on what that phase lists. Tick checkboxes in `docs/PLAN.md` when items are done.

## Stack

- pnpm + Turborepo monorepo: `apps/web` (Next.js App Router, TS, Tailwind, shadcn/ui, TanStack Query, next-intl en/hi), `apps/api` (Node, TS, Express, Mongoose, Zod), `packages/shared` (Zod schemas, types, utils).
- MongoDB (replica set required), Razorpay, Brevo (email), Cloudinary, Socket.io, Agenda.
- No WhatsApp Business API yet. Use `wa.me` click-to-chat links where WhatsApp is needed.

## Rules

- TypeScript strict. No `any` without a comment explaining why.
- Request/response shapes come from Zod schemas in `packages/shared`; don't duplicate types.
- Money is always an integer in **paise**. Never use floats for money.
- Slot dates are `YYYY-MM-DD` and times `HH:mm` strings in **IST**. Timestamps are UTC `Date`.
- Never bypass the `slotLocks` unique index for any booking path (online, walk-in, block, batch). See PLAN.md §3.
- Razorpay webhooks are the source of truth and must be idempotent. Always verify signatures.
- Owners may only access their own business data — enforce in the service layer.
- Error format: `{ error: { code, message, details? } }`.
- Mobile-first UI; test at 360px width. All user-facing strings go through next-intl (en + hi).
- Write tests with each feature (Vitest + Supertest + mongodb-memory-server). Concurrency-sensitive code (holds, tickets, open-game spots) needs a parallel-request test.

## Commands

- `pnpm dev` — run web + api
- `pnpm test` — all tests
- `pnpm lint` / `pnpm typecheck`
- `docker compose up -d` — local Mongo replica set

## Two repos

- **Townlplay-server** (this repo): `apps/api`, `packages/shared`, `packages/config`. Deploy: Render.
- **Townplay-client**: `apps/web` (Next.js). Deploy: Vercel.
- `packages/shared` is released as a tarball on GitHub Release `shared-v<version>` (workflow `release-shared.yml`, default branch only, when the version is new). The client pins that URL. Contract change: schema in shared → api → bump shared version → merge → update the URL in the client.
- Browsers reach the api through the web app's Next rewrite of `/v1/*`, so auth cookies are first-party. `AUTH_URL` = the web origin.

## API layout

`apps/api/src`: `env.ts` (Zod, fail fast) · `app.ts` `createApp(deps)` · `server.ts` · `auth/auth.ts` (better-auth: Google + email OTP, collections `users/sessions/accounts/verifications`, mounted at `/v1/auth/*`) · `middleware/` (errorHandler, validate, auth `requireAuth(auth)` / `requireRole`) · `models/` · `routes/` · `services/` (email: Brevo REST | log adapter; listings: owner businesses/venues/courts with ownership checks; review: admin; publicListing; uploads: Cloudinary signing without the SDK; audit) · `lib/dto.ts` (never send raw documents) · `scripts/seed.ts`.

- Public listing needs venue `status: live` and `businessActive: true` (denormalised; review.ts keeps it in sync). `minPricePaise` on venues is recomputed on every court change.
- Opening hours are an array of 7 (index = weekday, 0 = Sunday). Pricing bands may not overlap on a day (shared `findPricingOverlap`).
- Bookings: `services/bookings.ts` (`createBookingService({ events, now })`). Every booking path goes through `insertWithLocks` (transaction: delete expired locks for those slots, create booking, insert one `slotLocks` doc per slot; duplicate key → 409 SLOT_TAKEN). Holds: locks with `expiresAt` (10 min, TTL); confirmed/walk-in/phone/block locks have none. Slot generation + pro-rata pricing + refunds live in shared `booking.ts`.
- Realtime: `realtime.ts` (Socket.io at `/v1/socket.io`, cookie auth, `join` a venue you own → room `venue:<id>`), fed by `BookingEventBus`. Jobs: `jobs.ts` (Agenda + `@agendajs/mongo-backend`: expire holds every minute, complete finished bookings every 10 min). Both start only in `server.ts`, never in tests.
- Services are wired in `services/index.ts` `createServices()` (used by server.ts and tests). Payments (`services/payments.ts`): order → Checkout → `verify` (fast path) and `POST /v1/webhooks/razorpay` (raw body, signature-checked, event ids in `processedEvents`; source of truth). Both run `handleCaptured` (idempotent) → `bookings.confirmPaid` (re-locks a late payment if the slot is free, else system-cancel + full refund). Gateway (`paymentGateway.ts`): `RazorpayGateway` (REST, no SDK) or `FakeGateway` (`PAYMENTS_PROVIDER=fake`, `POST /v1/payments/fake-pay`).
- Refunds: player = policy % of the advance (fee kept); owner/system = everything paid online. Route mode (`PAYOUTS_MODE=route`) transfers the advance on capture and reverses it before refunds; manual mode = admin payouts report + recorded payouts. Bank account numbers are sealed with `lib/crypto.ts`.
- Notifications: `services/notify.ts` (emails from `emailTemplates.ts` + web push via `push.ts`); never throw.
- Events (`services/events.ts`, `routes/events.ts`): tiers are subdocs with `remaining`; tier edits move `remaining` by the capacity delta and never drop below sold/held. Tickets (`services/tickets.ts`): `take()` decrements `tiers.$.remaining` with a `remaining >= qty` filter (all-or-nothing, rolled back on a sold-out tier) — never write `remaining` any other way. Pending orders keep their stock until the expiry job flips them to `expired` (then stock is given back); a paid-after-expiry order re-takes stock or is refunded. Free tiers = RSVP (paid at once). QR = random `qrToken` per ticket; check-in is a conditional `checkedInAt: null` update. Payments use `refType` booking | ticketOrder.
- Open games + split payments (`services/shares.ts`, `routes/games.ts`): both are `bookingShares` (kind `game` | `split`); `activeKey` unique index stops double joins; spots are taken atomically on `openGames` (`$expr filledSpots < totalSpots`) — never write `filledSpots` any other way. Share payments (`refType: groupShare`) go towards the venue balance: `balanceDuePaise = balance − paid shares`, counted in owner earnings. Split links use a random token (`/v1/shares/:token`); unpaid shares expire at the start time (organiser pays at the venue). Booking cancellation → `shares.onBookingCancelled` refunds paid shares in full.
- Memberships (`services/memberships.ts`, `routes/memberships.ts`): plans (discount % on online holds via `bookings.memberDiscountFor`, optional monthly cap), coaching batches (court slots reserved as `source: batch` bookings through `insertWithLocks`, `BATCH_LOCK_DAYS` ahead > booking window; hourly `memberships:daily` job tops up, expires periods, sends reminders), memberships (one doc per period; renewal = new doc starting after the current one, unique open renewal per membership). Batch `seatsTaken` only via conditional `$expr seatsTaken < capacity` updates; a paid renewal inherits the seat. Payments `refType: membership`; owner cancel = full refund. Club sessions = events `type: club_session` shown in `GET /v1/venues/:id/offerings`.
  Tests: `apps/api/test` (supertest vs `createApp`, `helpers.ts` `setupApp()` + `signInWithOtp()`, `factories.ts` `agent()` / `adminAgent()` / `liveVenue()`; `ctx.clock.offsetMs` shifts the booking clock, `ctx.events` captures booking events). Express 5: async handlers may throw; no wrapper needed.

- `pnpm --filter @townplay/api seed` — idempotent: cities + `SEED_ADMIN_EMAIL` admin.
- `pnpm --filter @townplay/api seed:demo [-- --reset]` — demo owners/players, 3 live venues, bookings, open game, split, events, plan + batch (`scripts/seedDemo.ts`, through the real services; `DEMO_EMAIL=you@gmail.com` → plus-addressed accounts).
- `TEST_MONGODB_URI="mongodb://localhost:27017/townplay-test?replicaSet=rs0" pnpm test` — use docker Mongo instead of mongodb-memory-server.
- New env var = `env.ts` + `.env.example` + README/render config. Payments env: `PAYMENTS_PROVIDER`, `RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET`, `PAYOUTS_MODE`, `CONVENIENCE_FEE_CONFIG`, `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT` (`npx web-push generate-vapid-keys`).
