# Townplay server

API + shared package for Townplay (local sports venue booking, events, open games). See `CLAUDE.md` and `docs/PLAN.md`.

```
pnpm install
docker compose up -d                 # Mongo replica set rs0
cp apps/api/.env.example apps/api/.env   # fill AUTH_SECRET (openssl rand -base64 32)
pnpm --filter @townplay/api seed
pnpm dev                             # api on :4000
```

Without `BREVO_API_KEY` the OTP email is written to the api log. Google sign-in needs `GOOGLE_CLIENT_ID/SECRET` with redirect URI `<AUTH_URL>/v1/auth/callback/google`.
