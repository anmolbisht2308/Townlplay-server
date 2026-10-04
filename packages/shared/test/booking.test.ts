import { describe, expect, it } from "vitest";
import {
  areConsecutive,
  bookableDates,
  bookingAmount,
  generateSlots,
  ownerBookingRequestSchema,
  refundPaise,
  slotPrice,
} from "../src/booking.js";

const open = { open: "06:00", close: "23:00", closed: false };
const week = [open, open, open, open, open, open, open];
const weekdayRules = [
  { days: [1, 2, 3, 4, 5], start: "06:00", end: "17:00", pricePaise: 80000 },
  { days: [1, 2, 3, 4, 5], start: "17:00", end: "24:00", pricePaise: 120000 },
  { days: [0, 6], start: "06:00", end: "24:00", pricePaise: 150000 },
];
// 2026-09-28 is a Monday, 2026-09-27 a Sunday.
const MONDAY = "2026-09-28";
const SUNDAY = "2026-09-27";

describe("slot generation", () => {
  it("generates hourly slots from open to close with band prices", () => {
    const slots = generateSlots(week, 60, weekdayRules, MONDAY);
    expect(slots).toHaveLength(17);
    expect(slots[0]).toEqual({ startTime: "06:00", endTime: "07:00", pricePaise: 80000 });
    expect(slots.at(-1)).toEqual({ startTime: "22:00", endTime: "23:00", pricePaise: 120000 });
    expect(slots.find((s) => s.startTime === "17:00")?.pricePaise).toBe(120000);
  });

  it("uses weekend bands on weekends", () => {
    expect(generateSlots(week, 60, weekdayRules, SUNDAY)[0]?.pricePaise).toBe(150000);
  });

  it("prices slots that cross a band boundary pro rata", () => {
    // 90-min slots from 06:00: 15:00–16:30 is all off-peak, 16:30–18:00 is 30 off-peak + 60 peak.
    const slots = generateSlots(week, 90, weekdayRules, MONDAY);
    expect(slots.find((s) => s.startTime === "15:00")?.pricePaise).toBe(80000);
    expect(slots.find((s) => s.startTime === "16:30")?.pricePaise).toBe(106667);
    expect(slotPrice(weekdayRules, 1, 16 * 60 + 30, 60)).toBe(100000);
  });

  it("never runs past closing time", () => {
    const short = week.map(() => ({ open: "06:00", close: "07:30", closed: false }));
    expect(generateSlots(short, 60, weekdayRules, MONDAY).map((s) => s.startTime)).toEqual([
      "06:00",
    ]);
    const late = week.map(() => ({ open: "22:00", close: "24:00", closed: false }));
    expect(generateSlots(late, 60, weekdayRules, MONDAY).at(-1)?.endTime).toBe("24:00");
  });

  it("returns nothing on closed days and marks uncovered slots unpriced", () => {
    const closedMonday = week.map((d, i) => (i === 1 ? { ...d, closed: true } : d));
    expect(generateSlots(closedMonday, 60, weekdayRules, MONDAY)).toEqual([]);
    const morningOnly = [{ days: [1], start: "06:00", end: "12:00", pricePaise: 50000 }];
    const slots = generateSlots(week, 60, morningOnly, MONDAY);
    expect(slots.find((s) => s.startTime === "11:00")?.pricePaise).toBe(50000);
    expect(slots.find((s) => s.startTime === "12:00")?.pricePaise).toBeNull();
    expect(slotPrice(morningOnly, 1, 11 * 60 + 30, 60)).toBeNull();
  });
});

describe("booking helpers", () => {
  it("checks consecutive slots", () => {
    expect(areConsecutive(["07:00", "06:00", "08:00"], 60)).toBe(true);
    expect(areConsecutive(["06:00", "08:00"], 60)).toBe(false);
    expect(areConsecutive(["06:00", "07:30"], 90)).toBe(true);
  });

  it("lists 14 bookable IST dates from today", () => {
    const dates = bookableDates(new Date("2026-09-27T20:00:00Z")); // 01:30 IST on the 28th
    expect(dates[0]).toBe("2026-09-28");
    expect(dates).toHaveLength(14);
    expect(dates.at(-1)).toBe("2026-10-11");
  });

  it("splits totals into advance and balance in paise", () => {
    expect(bookingAmount([80000, 120000], 30)).toEqual({
      totalPaise: 200000,
      advancePaise: 60000,
      balancePaise: 140000,
      convenienceFeePaise: 0,
    });
    expect(bookingAmount([33333], 50).balancePaise).toBe(16666);
  });

  it("refunds per policy before the cutoff, nothing after, full for owners", () => {
    const policy = { cancellationCutoffHours: 6, refundPercentBeforeCutoff: 50 };
    const booking = {
      date: MONDAY,
      startTime: "18:00",
      amount: { advancePaise: 60000, convenienceFeePaise: 0 },
    };
    // 18:00 IST = 12:30 UTC; cutoff 06:30 UTC.
    expect(refundPaise(policy, booking, "player", new Date("2026-09-28T06:00:00Z"))).toBe(30000);
    expect(refundPaise(policy, booking, "player", new Date("2026-09-28T07:00:00Z"))).toBe(0);
    expect(refundPaise(policy, booking, "owner", new Date("2026-09-28T12:00:00Z"))).toBe(60000);
  });

  it("requires a customer for walk-ins but not blocks", () => {
    const base = { resourceId: "a".repeat(24), date: MONDAY, startTimes: ["06:00"] };
    expect(ownerBookingRequestSchema.safeParse({ ...base, source: "block" }).success).toBe(true);
    expect(ownerBookingRequestSchema.safeParse({ ...base, source: "walkin" }).success).toBe(false);
  });
});

describe("convenience fee and refunds with fees", () => {
  it("adds flat + percent of the advance, nothing when nothing is paid online", async () => {
    const { convenienceFeePaise, bookingAmount: amount } = await import("../src/booking.js");
    expect(convenienceFeePaise(60000, { flatPaise: 1000, percent: 2 })).toBe(2200);
    expect(convenienceFeePaise(0, { flatPaise: 1000, percent: 2 })).toBe(0);
    expect(amount([100000], 30, { flatPaise: 500, percent: 0 }).convenienceFeePaise).toBe(500);
  });

  it("player refunds exclude the fee; owner and system refunds include it", () => {
    const policy = { cancellationCutoffHours: 0, refundPercentBeforeCutoff: 100 };
    const booking = {
      date: "2099-01-01",
      startTime: "10:00",
      amount: { advancePaise: 30000, convenienceFeePaise: 1000 },
    };
    expect(refundPaise(policy, booking, "player")).toBe(30000);
    expect(refundPaise(policy, booking, "owner")).toBe(31000);
    expect(refundPaise(policy, booking, "system")).toBe(31000);
  });
});
