# Progress

- Done: Phase 0 server: monorepo, shared (money/IST/constants/schemas), api (env, pino+req ids, errors, validate, helmet/cors/rate limit, better-auth Google + email OTP, /v1/me GET/PATCH, requireRole, seed, Sentry), CI, shared release workflow.
- Next: Phase 0 client wiring check (sign-in end-to-end on staging), then Phase 1.
- Gotchas: mongod download (fastdl.mongodb.org) is blocked in Claude cloud sessions → DB tests run in CI or with TEST_MONGODB_URI. `mongodb` dep must match mongoose's (~7.6) or Db types clash.
