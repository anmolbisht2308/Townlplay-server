import { describe, expect, it } from "vitest";
import {
  createBusinessSchema,
  findPricingOverlap,
  minPricePaise,
  openingHoursSchema,
  pricingRulesSchema,
  updateVenueSchema,
  venueListQuerySchema,
} from "../src/listing.js";

const rule = (days: number[], start: string, end: string, pricePaise = 100000) => ({
  days,
  start,
  end,
  pricePaise,
});

describe("pricing rules", () => {
  it("accepts weekday/weekend and peak/off-peak bands, up to 24:00", () => {
    const rules = [
      rule([1, 2, 3, 4, 5], "06:00", "17:00", 80000),
      rule([1, 2, 3, 4, 5], "17:00", "24:00", 120000),
      rule([0, 6], "06:00", "24:00", 150000),
    ];
    expect(pricingRulesSchema.safeParse(rules).success).toBe(true);
    expect(minPricePaise(rules)).toBe(80000);
  });

  it("rejects overlapping bands on a shared day", () => {
    const rules = [rule([1, 2], "06:00", "18:00"), rule([2, 3], "17:00", "22:00")];
    expect(findPricingOverlap(rules)).toEqual([0, 1]);
    expect(pricingRulesSchema.safeParse(rules).success).toBe(false);
  });

  it("allows the same times on different days and rejects bad bands", () => {
    expect(findPricingOverlap([rule([1], "06:00", "18:00"), rule([2], "06:00", "18:00")])).toBe(
      null,
    );
    expect(pricingRulesSchema.safeParse([rule([1], "18:00", "06:00")]).success).toBe(false);
    expect(pricingRulesSchema.safeParse([rule([1, 1], "06:00", "07:00")]).success).toBe(false);
    expect(pricingRulesSchema.safeParse([rule([1], "06:00", "07:00", 1.5)]).success).toBe(false);
  });
});

describe("venue schemas", () => {
  const day = { open: "06:00", close: "23:00", closed: false };

  it("requires seven valid days of opening hours", () => {
    expect(openingHoursSchema.safeParse(Array(7).fill(day)).success).toBe(true);
    expect(openingHoursSchema.safeParse(Array(6).fill(day)).success).toBe(false);
    const bad = [...Array(6).fill(day), { open: "23:00", close: "06:00", closed: false }];
    expect(openingHoursSchema.safeParse(bad).success).toBe(false);
    const closed = [...Array(6).fill(day), { open: "23:00", close: "06:00", closed: true }];
    expect(openingHoursSchema.safeParse(closed).success).toBe(true);
  });

  it("keeps partial updates partial and strict", () => {
    expect(updateVenueSchema.parse({ name: "Turf X" })).toEqual({ name: "Turf X" });
    expect(updateVenueSchema.safeParse({ status: "live" }).success).toBe(false);
  });

  it("validates business KYC", () => {
    const base = {
      name: "Green Turf",
      type: "sports",
      contactPhone: "9876543210",
      email: "a@b.com",
      kyc: { legalName: "Green Turf LLP", pan: "abcde1234f" },
    };
    expect(createBusinessSchema.parse(base).kyc.pan).toBe("ABCDE1234F");
    expect(
      createBusinessSchema.safeParse({ ...base, kyc: { legalName: "X Y", pan: "1" } }).success,
    ).toBe(false);
  });

  it("parses listing queries", () => {
    expect(venueListQuerySchema.parse({ near: "28.36,79.43" }).limit).toBe(20);
    expect(venueListQuerySchema.safeParse({ near: "north" }).success).toBe(false);
    expect(venueListQuerySchema.safeParse({ sport: "curling" }).success).toBe(false);
  });
});
