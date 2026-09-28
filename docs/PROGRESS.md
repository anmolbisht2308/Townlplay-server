# Progress

- Done: Phase 0 (foundations) and Phase 1 (businesses, venues, courts, admin review, public listing + near me, venue by slug, sitemap entries, Cloudinary signed uploads). shared 0.2.0.
- Next: Phase 2: slot engine, holds with `slotLocks`, owner calendar.
- Gotchas: mongod download is blocked in cloud sessions, so DB tests run in CI. `mongodb` must match mongoose's (~7.6). Mongoose 9: use `QueryFilter<T>` and `InstanceType<typeof Model>` for doc types.
- Uploads need `CLOUDINARY_URL`; without it `/v1/uploads/sign` returns 503 UPLOADS_DISABLED.
