import { parseConvenienceFeeConfig } from "@townplay/shared";
import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    APP_VERSION: z.string().default("dev"),
    MONGODB_URI: z.string().min(1),
    /** Public origin of the web app; the only CORS / auth trusted origin. */
    WEB_ORIGIN: z.url(),
    /** Public base URL where `/v1/auth/*` is reachable (the web origin: Next rewrites /v1 here). */
    AUTH_URL: optional.pipe(z.url().optional()),
    AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    /** Brevo (SMTP & API → API keys). Without it emails go to the log. */
    BREVO_API_KEY: optional,
    EMAIL_FROM: z.string().default("Townplay <no-reply@townplay.local>"),
    SENTRY_DSN: optional,
    /** cloudinary://<api_key>:<api_secret>@<cloud_name>. Without it photo uploads are off. */
    CLOUDINARY_URL: optional.pipe(
      z
        .string()
        .regex(/^cloudinary:\/\/[^:]+:[^@]+@.+$/, "expected cloudinary://key:secret@cloud")
        .optional(),
    ),
    /** Number of proxy hops in front of the api (Render + Vercel rewrite = 2). */
    TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),
    /** Requests per minute per IP across /v1. */
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    /** OTP sends per 15 minutes per IP. */
    OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    SEED_ADMIN_EMAIL: optional.pipe(z.email().optional()),
    /** "fake" simulates payments (dev/test); production must use "razorpay". */
    PAYMENTS_PROVIDER: z.enum(["razorpay", "fake"]).default("fake"),
    RAZORPAY_KEY_ID: optional,
    RAZORPAY_KEY_SECRET: optional,
    RAZORPAY_WEBHOOK_SECRET: optional,
    /** "route" transfers advances to venues via Razorpay Route; "manual" shows an admin payouts report. */
    PAYOUTS_MODE: z.enum(["route", "manual"]).default("manual"),
    /** Default convenience fee until an admin saves one, e.g. "flat:1000" or "flat:500,percent:1.5". */
    CONVENIENCE_FEE_CONFIG: optional,
    VAPID_PUBLIC_KEY: optional,
    VAPID_PRIVATE_KEY: optional,
    VAPID_SUBJECT: z.string().default("mailto:support@townplay.local"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (!env.BREVO_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["BREVO_API_KEY"], message: "required in production" });
    }
    if (env.PAYMENTS_PROVIDER !== "razorpay") {
      ctx.addIssue({
        code: "custom",
        path: ["PAYMENTS_PROVIDER"],
        message: "must be razorpay in production",
      });
    }
    for (const key of [
      "RAZORPAY_KEY_ID",
      "RAZORPAY_KEY_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
    ] as const) {
      if (!env[key])
        ctx.addIssue({ code: "custom", path: [key], message: "required in production" });
    }
    if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_CLIENT_SECRET"],
        message: "set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither",
      });
    }
  });

export type Env = z.infer<typeof envSchema> & { AUTH_URL: string };

// Fails fast on a malformed fee config at boot.
const feeConfig = z
  .string()
  .optional()
  .superRefine((v, ctx) => {
    try {
      parseConvenienceFeeConfig(v);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
    }
  });

/** Parses and validates env; throws a readable error listing every bad variable. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  // `KEY=` (empty, as copied from .env.example) means "not set": the default applies.
  const source = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ""));
  const result = envSchema.safeParse(source);
  const fee = feeConfig.safeParse(source.CONVENIENCE_FEE_CONFIG || undefined);
  if (!fee.success) {
    throw new Error(
      `Invalid environment:\n  CONVENIENCE_FEE_CONFIG: ${fee.error.issues[0]?.message}`,
    );
  }
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return { ...result.data, AUTH_URL: result.data.AUTH_URL ?? result.data.WEB_ORIGIN };
}
