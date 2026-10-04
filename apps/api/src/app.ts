import { randomUUID } from "node:crypto";
import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import { AUTH_BASE_PATH, type Auth } from "./auth/auth.js";
import type { Env } from "./env.js";
import { HttpError } from "./lib/httpError.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { adminRouter } from "./routes/admin.js";
import { bookingsRouter } from "./routes/bookings.js";
import { eventsRouter } from "./routes/events.js";
import { gamesRouter } from "./routes/games.js";
import { meRouter } from "./routes/me.js";
import { membershipsRouter } from "./routes/memberships.js";
import { paymentsRouter } from "./routes/payments.js";
import { pushRouter } from "./routes/push.js";
import { ownerRouter } from "./routes/owner.js";
import { publicRouter } from "./routes/public.js";
import type { Services } from "./services/index.js";
import { parseCloudinaryUrl } from "./services/uploads.js";

export interface AppDeps {
  env: Env;
  logger: Logger;
  auth: Auth;
  services: Services;
}

const rateLimited = () => new HttpError(429, "RATE_LIMITED", "Too many requests, try again later");

export function createApp({ env, logger, auth, services }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && incoming.length <= 128 ? incoming : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/v1/health" },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));

  const v1Limiter = rateLimit({
    windowMs: 60_000,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(rateLimited()),
  });
  const otpLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: env.OTP_RATE_LIMIT_MAX,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(rateLimited()),
  });

  const health = healthRouter(env.APP_VERSION);
  app.use(health); // also at /health for the platform health check
  app.use("/v1", v1Limiter);
  app.use(`${AUTH_BASE_PATH}/email-otp/send-verification-otp`, otpLimiter);

  // better-auth reads the raw body itself, so it is mounted before express.json().
  app.all(`${AUTH_BASE_PATH}/*splat`, toNodeHandler(auth));

  // Webhook signatures are over the exact bytes Razorpay sent: raw body, before express.json().
  app.post(
    "/v1/webhooks/razorpay",
    express.raw({ type: "*/*", limit: "1mb" }),
    async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const header = (name: string) => {
        const v = req.headers[name];
        return typeof v === "string" ? v : undefined;
      };
      const result = await services.payments.handleWebhook(
        body,
        header("x-razorpay-signature"),
        header("x-razorpay-event-id"),
      );
      res.json({ ok: true, duplicate: result.duplicate });
    },
  );

  app.use(express.json({ limit: "100kb" }));
  app.use("/v1", health);
  const cloudinary = env.CLOUDINARY_URL ? parseCloudinaryUrl(env.CLOUDINARY_URL) : undefined;
  app.use("/v1", meRouter(auth));
  app.use("/v1", publicRouter());
  app.use("/v1", adminRouter(auth, services.settings, services.payouts, services.tickets));
  app.use("/v1", bookingsRouter(auth, services.bookings));
  app.use("/v1", eventsRouter(auth, services.eventsService, services.tickets));
  app.use("/v1", gamesRouter(auth, services.shares, services.payments));
  app.use("/v1", membershipsRouter(auth, services.memberships));
  app.use("/v1", paymentsRouter(auth, services.payments, services.settings, services.gateway));
  app.use("/v1", pushRouter(auth, env.VAPID_PUBLIC_KEY));
  // Owner routes after public ones: `/venues/by-slug/...` must not hit `/venues/:id`.
  app.use("/v1", ownerRouter(auth, cloudinary, services.payouts));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
