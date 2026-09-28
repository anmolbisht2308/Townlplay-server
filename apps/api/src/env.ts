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
    RESEND_API_KEY: optional,
    EMAIL_FROM: z.string().default("Townplay <no-reply@townplay.local>"),
    SENTRY_DSN: optional,
    /** Number of proxy hops in front of the api (Render + Vercel rewrite = 2). */
    TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),
    /** Requests per minute per IP across /v1. */
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    /** OTP sends per 15 minutes per IP. */
    OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    SEED_ADMIN_EMAIL: optional.pipe(z.email().optional()),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (!env.RESEND_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["RESEND_API_KEY"], message: "required in production" });
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

/** Parses and validates env; throws a readable error listing every bad variable. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return { ...result.data, AUTH_URL: result.data.AUTH_URL ?? result.data.WEB_ORIGIN };
}
