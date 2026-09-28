import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { emailOTP } from "better-auth/plugins";
import type { Db, MongoClient } from "mongodb";
import type { Logger } from "pino";
import type { Env } from "../env.js";
import type { EmailSender } from "../services/email.js";

export const AUTH_BASE_PATH = "/v1/auth";

export interface AuthDeps {
  env: Env;
  db: Db;
  client: MongoClient;
  email: EmailSender;
  logger: Logger;
}

export function otpEmail(otp: string) {
  return {
    subject: `${otp} is your Townplay sign-in code`,
    text: `Your Townplay sign-in code is ${otp}. It expires in 5 minutes.\n\nआपका Townplay साइन-इन कोड ${otp} है। यह 5 मिनट में समाप्त हो जाएगा।`,
  };
}

export function createAuth({ env, db, client, email, logger }: AuthDeps) {
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : undefined;

  return betterAuth({
    appName: "Townplay",
    baseURL: env.AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.WEB_ORIGIN],
    database: mongodbAdapter(db, { client }),
    // Our own express-rate-limit guards OTP sends; better-auth's in-memory limiter is off in tests.
    rateLimit: { enabled: env.NODE_ENV === "production" },
    user: {
      modelName: "users",
      additionalFields: {
        roles: { type: "string[]", required: false, defaultValue: ["player"], input: false },
        lang: { type: "string", required: false, defaultValue: "en", input: false },
        phone: { type: "string", required: false, input: false },
        cityId: { type: "string", required: false, input: false },
      },
    },
    session: { modelName: "sessions", expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    account: {
      modelName: "accounts",
      accountLinking: { enabled: true, trustedProviders: ["google", "email-otp"] },
    },
    verification: { modelName: "verifications" },
    socialProviders: google ? { google } : {},
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email: to, otp }) => {
          try {
            await email.send({ to, ...otpEmail(otp) });
          } catch (err) {
            logger.error({ err, to }, "failed to send OTP email");
            throw err;
          }
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
