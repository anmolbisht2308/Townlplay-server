import request from "supertest";
import { describe, expect, it } from "vitest";
import { setupApp } from "./helpers.js";

describe("health", () => {
  const ctx = setupApp();

  it("reports ok at /health and /v1/health with a request id", async () => {
    for (const path of ["/health", "/v1/health"]) {
      const res = await request(ctx.app).get(path).expect(200);
      expect(res.body).toEqual({ status: "ok", version: "test", db: "up" });
      expect(res.headers["x-request-id"]).toBeTruthy();
    }
  });

  it("echoes an incoming x-request-id", async () => {
    const res = await request(ctx.app).get("/health").set("x-request-id", "abc-123");
    expect(res.headers["x-request-id"]).toBe("abc-123");
  });
});
