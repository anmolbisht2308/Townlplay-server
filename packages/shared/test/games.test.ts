import { describe, expect, it } from "vitest";
import { openGameRequestSchema, splitPaise, splitRequestSchema } from "../src/games.js";
import { createOrderRequestSchema } from "../src/payments.js";

describe("games and splits", () => {
  it("splits paise exactly", () => {
    expect(splitPaise(100000, 3)).toEqual([33334, 33333, 33333]);
    expect(splitPaise(100000, 3).reduce((a, b) => a + b, 0)).toBe(100000);
    expect(splitPaise(5, 10)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    expect(() => splitPaise(10, 0)).toThrow();
  });

  it("validates game and split requests", () => {
    expect(
      openGameRequestSchema.safeParse({
        skillLevel: "any",
        spotsNeeded: 4,
        pricePerHeadPaise: 15000,
      }).success,
    ).toBe(true);
    expect(
      openGameRequestSchema.safeParse({ skillLevel: "pro", spotsNeeded: 4, pricePerHeadPaise: 0 })
        .success,
    ).toBe(false);
    expect(splitRequestSchema.safeParse({ shares: [{ name: "Amit" }] }).success).toBe(false);
    expect(
      splitRequestSchema.safeParse({
        shares: [{ name: "Amit" }, { name: "Ravi", phone: "9876543210" }],
      }).success,
    ).toBe(true);
  });

  it("orders pay for exactly one thing", () => {
    expect(createOrderRequestSchema.safeParse({ shareId: "a".repeat(24) }).success).toBe(true);
    expect(
      createOrderRequestSchema.safeParse({ shareId: "a".repeat(24), bookingId: "b".repeat(24) })
        .success,
    ).toBe(false);
    expect(createOrderRequestSchema.safeParse({}).success).toBe(false);
  });
});
