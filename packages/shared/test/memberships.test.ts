import { describe, expect, it } from "vitest";
import {
  BATCH_LOCK_DAYS,
  batchDates,
  createBatchSchema,
  joinMembershipRequestSchema,
  memberPricePaise,
  membershipPeriod,
  planInputSchema,
} from "../src/memberships.js";
import { BOOKING_WINDOW_DAYS } from "../src/booking.js";
import { addMonths } from "../src/time.js";

describe("memberships", () => {
  it("adds months with the day clamped", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });

  it("membership periods are inclusive", () => {
    expect(membershipPeriod("2026-10-04", 1)).toEqual({
      startsOn: "2026-10-04",
      endsOn: "2026-11-03",
    });
    expect(membershipPeriod("2026-01-01", 12).endsOn).toBe("2026-12-31");
  });

  it("lists batch dates on its weekdays within its start/end", () => {
    // 2026-10-05 is a Monday
    const b = { days: [1, 3, 5], startDate: "2026-10-06", endDate: "2026-10-16" };
    expect(batchDates(b, "2026-10-01", "2026-10-31")).toEqual([
      "2026-10-07",
      "2026-10-09",
      "2026-10-12",
      "2026-10-14",
      "2026-10-16",
    ]);
    expect(batchDates({ ...b, endDate: null }, "2026-10-19", "2026-10-20")).toEqual(["2026-10-19"]);
  });

  it("locks batch slots beyond the online booking window", () => {
    expect(BATCH_LOCK_DAYS).toBeGreaterThan(BOOKING_WINDOW_DAYS);
  });

  it("member price takes the discount off", () => {
    expect(memberPricePaise(80000, 10)).toBe(72000);
    expect(memberPricePaise(99999, 15)).toBe(84999);
  });

  it("validates plans, batches and joins", () => {
    const plan = {
      name: "Monthly",
      description: "",
      durationMonths: 1,
      pricePaise: 99900,
      discountPercent: 10,
      bookingsPerMonth: 8,
      isActive: true,
    };
    expect(planInputSchema.safeParse(plan).success).toBe(true);
    expect(planInputSchema.safeParse({ ...plan, durationMonths: 2 }).success).toBe(false);
    const batch = {
      title: "Evening football",
      activity: "Football",
      coachName: "Coach Ravi",
      description: "",
      capacity: 20,
      monthlyFeePaise: 150000,
      resourceId: null,
      days: [1, 3, 5],
      startTime: "18:00",
      endTime: "19:00",
      startDate: "2026-10-05",
    };
    expect(createBatchSchema.safeParse(batch).success).toBe(true);
    expect(createBatchSchema.safeParse({ ...batch, endTime: "17:00" }).success).toBe(false);
    expect(createBatchSchema.safeParse({ ...batch, days: [1, 1] }).success).toBe(false);
    const member = { name: "Asha", phone: "9876543210" };
    expect(joinMembershipRequestSchema.safeParse({ member }).success).toBe(false);
    expect(joinMembershipRequestSchema.safeParse({ planId: "a".repeat(24), member }).success).toBe(
      true,
    );
  });
});
