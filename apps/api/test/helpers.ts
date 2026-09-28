import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, inject } from "vitest";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth/auth.js";
import { connectMongo, mongoDb } from "../src/db.js";
import { parseEnv } from "../src/env.js";
import { createLogger } from "../src/logger.js";
import type { EmailMessage, EmailSender } from "../src/services/email.js";

export const WEB_ORIGIN = "http://localhost:3000";

export const testEnv = parseEnv({
  NODE_ENV: "test",
  MONGODB_URI: "mongodb://localhost:27017/unused",
  WEB_ORIGIN,
  AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  APP_VERSION: "test",
  RATE_LIMIT_MAX: "10000",
  OTP_RATE_LIMIT_MAX: "10000",
});

/** Captures emails instead of sending them; `codes` maps address → last 6-digit code. */
export class RecordingEmailSender implements EmailSender {
  readonly name = "recording";
  readonly sent: EmailMessage[] = [];
  readonly codes = new Map<string, string>();
  send(message: EmailMessage) {
    this.sent.push(message);
    const code = /\b(\d{6})\b/.exec(message.text)?.[1];
    if (code) this.codes.set(message.to, code);
    return Promise.resolve();
  }
}

/** Connects to the test DB, builds the app, and wipes collections before each test. */
export function setupApp(overrides: Partial<typeof testEnv> = {}) {
  const env = { ...testEnv, ...overrides };
  const email = new RecordingEmailSender();
  const ctx = {
    env,
    email,
    app: undefined as unknown as ReturnType<typeof createApp>,
  };

  beforeAll(async () => {
    await connectMongo(inject("mongoUri"));
    const logger = createLogger(env);
    const auth = createAuth({
      env,
      db: mongoDb(),
      client: mongoose.connection.getClient(),
      email,
      logger,
    });
    ctx.app = createApp({ env, logger, auth });
  });

  beforeEach(async () => {
    email.sent.length = 0;
    email.codes.clear();
    const collections = await mongoDb().collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  return ctx;
}

/** Signs in through the email-OTP flow and returns the session cookie header. */
export async function signInWithOtp(
  ctx: ReturnType<typeof setupApp>,
  email: string,
): Promise<string[]> {
  await request(ctx.app)
    .post("/v1/auth/email-otp/send-verification-otp")
    .set("Origin", WEB_ORIGIN)
    .send({ email, type: "sign-in" })
    .expect(200);
  const otp = ctx.email.codes.get(email);
  if (!otp) throw new Error(`no OTP sent to ${email}`);
  const res = await request(ctx.app)
    .post("/v1/auth/sign-in/email-otp")
    .set("Origin", WEB_ORIGIN)
    .send({ email, otp })
    .expect(200);
  const cookies = res.headers["set-cookie"] as unknown as string[] | undefined;
  if (!cookies?.length) throw new Error("no session cookie");
  return cookies.map((c) => c.split(";")[0]!);
}
