import { describe, expect, it } from "vitest";
import { apiErrorSchema, dateStringSchema, phoneSchema, updateMeSchema } from "../src/schemas.js";

describe("schemas", () => {
  it("parses the error envelope", () => {
    expect(apiErrorSchema.safeParse({ error: { code: "X", message: "m" } }).success).toBe(true);
    expect(apiErrorSchema.safeParse({ error: "m" }).success).toBe(false);
  });

  it("validates dates and phones", () => {
    expect(dateStringSchema.safeParse("2026-02-30").success).toBe(false);
    expect(phoneSchema.safeParse("9876543210").success).toBe(true);
    expect(phoneSchema.safeParse("12345").success).toBe(false);
  });

  it("rejects unknown fields on updateMe and keeps partial bodies partial", () => {
    expect(updateMeSchema.safeParse({ roles: ["admin"] }).success).toBe(false);
    expect(updateMeSchema.parse({ lang: "hi" })).toEqual({ lang: "hi" });
  });
});
