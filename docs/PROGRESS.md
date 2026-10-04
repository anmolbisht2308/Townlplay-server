# Progress

- Done: Phases 0–6. Phase 6: membership plans (discount % + monthly cap on online holds), coaching batches (court slots reserved as `source: batch` bookings via insertWithLocks, 28 days ahead, hourly top-up), memberships (pay via `refType: membership`, atomic batch seats, 6-parallel test, renewals inherit the seat), attendance, expiry reminders, owner cancel = full refund, membership fees in earnings. shared 0.7.0.
- Next: Phase 7 (admin, reviews, analytics, launch readiness).
- Gotchas: DB tests for Phases 2–6 have never run (mongod blocked in cloud sessions) → run `pnpm test` / check CI first after committing and fix red.
