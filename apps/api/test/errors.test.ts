import request from "supertest";
import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";
import { setupApp, signInWithOtp, WEB_ORIGIN } from "./helpers.js";

describe("error shape", () => {
  const ctx = setupApp();

  it("404s unknown routes as { error: { code, message } }", async () => {
    const res = await request(ctx.app).get("/v1/nope").expect(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found: GET /v1/nope" } });
  });

  it("400s invalid JSON", async () => {
    const cookies = await signInWithOtp(ctx, "json@example.com");
    const res = await request(ctx.app)
      .patch("/v1/me")
      .set("Cookie", cookies)
      .set("Origin", WEB_ORIGIN)
      .set("Content-Type", "application/json")
      .send("{bad")
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("env", () => {
  const base = {
    MONGODB_URI: "mongodb://x",
    WEB_ORIGIN: "http://localhost:3000",
    AUTH_SECRET: "x".repeat(32),
  };

  it("defaults AUTH_URL to WEB_ORIGIN", () => {
    expect(parseEnv(base).AUTH_URL).toBe("http://localhost:3000");
  });

  it("treats empty values (as copied from .env.example) as unset", () => {
    const env = parseEnv({
      ...base,
      RATE_LIMIT_MAX: "",
      OTP_RATE_LIMIT_MAX: "",
      EMAIL_FROM: "",
      VAPID_SUBJECT: "",
      AUTH_URL: "",
    });
    expect(env).toMatchObject({
      RATE_LIMIT_MAX: 300,
      OTP_RATE_LIMIT_MAX: 10,
      EMAIL_FROM: "Townplay <no-reply@townplay.local>",
      VAPID_SUBJECT: "mailto:support@townplay.local",
      AUTH_URL: "http://localhost:3000",
    });
  });

  it("fails fast listing bad variables", () => {
    expect(() => parseEnv({ ...base, AUTH_SECRET: "short" })).toThrow(/AUTH_SECRET/);
    expect(() => parseEnv({ ...base, NODE_ENV: "production" })).toThrow(/BREVO_API_KEY/);
  });
});
