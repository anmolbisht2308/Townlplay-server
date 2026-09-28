import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { UserModel } from "../src/models/user.js";
import { seed } from "../src/scripts/seed.js";
import { CityModel } from "../src/models/city.js";
import { setupApp, signInWithOtp, WEB_ORIGIN } from "./helpers.js";

describe("auth + /v1/me", () => {
  const ctx = setupApp();

  it("401s /v1/me without a session", async () => {
    const res = await request(ctx.app).get("/v1/me").expect(401);
    expect(res.body).toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in required" } });
  });

  it("signs up via email OTP and returns the user as a player", async () => {
    const cookies = await signInWithOtp(ctx, "asha@example.com");
    expect(ctx.email.sent[0]?.subject).toMatch(/sign-in code/);

    const res = await request(ctx.app).get("/v1/me").set("Cookie", cookies).expect(200);
    expect(res.body).toMatchObject({
      email: "asha@example.com",
      roles: ["player"],
      lang: "en",
      phone: null,
      cityId: null,
    });
    expect(typeof res.body.id).toBe("string");
  });

  it("rejects a wrong OTP", async () => {
    await request(ctx.app)
      .post("/v1/auth/email-otp/send-verification-otp")
      .set("Origin", WEB_ORIGIN)
      .send({ email: "x@example.com", type: "sign-in" })
      .expect(200);
    const wrong = ctx.email.codes.get("x@example.com") === "000000" ? "111111" : "000000";
    await request(ctx.app)
      .post("/v1/auth/sign-in/email-otp")
      .set("Origin", WEB_ORIGIN)
      .send({ email: "x@example.com", otp: wrong })
      .expect(400);
  });

  it("updates profile fields and refuses roles", async () => {
    const cookies = await signInWithOtp(ctx, "ravi@example.com");
    const res = await request(ctx.app)
      .patch("/v1/me")
      .set("Cookie", cookies)
      .set("Origin", WEB_ORIGIN)
      .send({ name: "Ravi", phone: "9876543210", lang: "hi" })
      .expect(200);
    expect(res.body).toMatchObject({ name: "Ravi", phone: "9876543210", lang: "hi" });

    const me = await request(ctx.app).get("/v1/me").set("Cookie", cookies).expect(200);
    expect(me.body).toMatchObject({ name: "Ravi", lang: "hi" });

    const bad = await request(ctx.app)
      .patch("/v1/me")
      .set("Cookie", cookies)
      .set("Origin", WEB_ORIGIN)
      .send({ roles: ["admin"] })
      .expect(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("seed is idempotent and the seeded admin signs in with the admin role", async () => {
    await seed("Admin@Example.com");
    await seed("admin@example.com");
    expect(await CityModel.countDocuments({ slug: "bareilly" })).toBe(1);
    expect(await UserModel.countDocuments({ email: "admin@example.com" })).toBe(1);

    const cookies = await signInWithOtp(ctx, "admin@example.com");
    const res = await request(ctx.app).get("/v1/me").set("Cookie", cookies).expect(200);
    expect(res.body.roles).toEqual(["player", "admin"]);
  });
});

describe("requireRole", () => {
  it("403s users without the role and passes those with it", async () => {
    const { requireAuth, requireRole } = await import("../src/middleware/auth.js");
    expect(typeof requireAuth).toBe("function");
    const router = Router();
    router.get("/x", requireRole("admin"), (_req, res) => res.json({ ok: true }));
    const express = (await import("express")).default;
    const { errorHandler } = await import("../src/middleware/errorHandler.js");
    const { pino } = await import("pino");
    const { pinoHttp } = await import("pino-http");
    const make = (roles: string[]) => {
      const app = express();
      app.use(pinoHttp({ logger: pino({ level: "silent" }) }));
      app.use((req, _res, next) => {
        req.user = {
          id: "1",
          name: "n",
          email: "e@x.com",
          image: null,
          phone: null,
          roles: roles as ("player" | "owner" | "admin")[],
          lang: "en",
          cityId: null,
        };
        next();
      });
      app.use(router);
      app.use(errorHandler);
      return app;
    };
    const denied = await request(make(["player"]))
      .get("/x")
      .expect(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");
    await request(make(["player", "admin"]))
      .get("/x")
      .expect(200);
  });
});
