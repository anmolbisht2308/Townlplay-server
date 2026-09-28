# CLAUDE.md

Local booking platform for tier-2/3 Indian cities (starting with Bareilly): sports venue slot booking, event ticketing, open games, memberships.

The full roadmap is in `docs/PLAN.md`. Work on **one phase at a time** and only on what that phase lists. Tick checkboxes in `docs/PLAN.md` when items are done.

## Stack

- pnpm + Turborepo monorepo: `apps/web` (Next.js App Router, TS, Tailwind, shadcn/ui, TanStack Query, next-intl en/hi), `apps/api` (Node, TS, Express, Mongoose, Zod), `packages/shared` (Zod schemas, types, utils).
- MongoDB (replica set required), Razorpay, Resend, Cloudinary, Socket.io, Agenda.
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

`apps/api/src`: `env.ts` (Zod, fail fast) · `app.ts` `createApp(deps)` · `server.ts` · `auth/auth.ts` (better-auth: Google + email OTP, collections `users/sessions/accounts/verifications`, mounted at `/v1/auth/*`) · `middleware/` (errorHandler, validate, auth `requireAuth(auth)` / `requireRole`) · `models/` · `routes/` · `services/` (email: Resend | log adapter; listings: owner businesses/venues/courts with ownership checks; review: admin; publicListing; uploads: Cloudinary signing without the SDK; audit) · `lib/dto.ts` (never send raw documents) · `scripts/seed.ts`.

- Public listing needs venue `status: live` and `businessActive: true` (denormalised; review.ts keeps it in sync). `minPricePaise` on venues is recomputed on every court change.
- Opening hours are an array of 7 (index = weekday, 0 = Sunday). Pricing bands may not overlap on a day (shared `findPricingOverlap`).
  Tests: `apps/api/test` (supertest vs `createApp`, `helpers.ts` `setupApp()` + `signInWithOtp()`, `factories.ts` `agent()` / `adminAgent()` / `liveVenue()`). Express 5: async handlers may throw; no wrapper needed.

- `pnpm --filter @townplay/api seed` — idempotent: cities + `SEED_ADMIN_EMAIL` admin.
- `TEST_MONGODB_URI="mongodb://localhost:27017/townplay-test?replicaSet=rs0" pnpm test` — use docker Mongo instead of mongodb-memory-server.
- New env var = `env.ts` + `.env.example` + README/render config.
